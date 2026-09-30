/**
 * Field pass (MRT, one fragment per cell incl. pad): evaluates the weighted modes, shapes the
 * intensity (gamma, flicker, sparsity, sparkles), applies influences, pulses and lift sockets,
 * and maps the result to a palette position.
 *
 * fieldA (HDR): rgb = linear base color, a = intensity (socket-dimmed).
 * fieldB (RGBA8): r = palette t, g = hot amount, b = dead-cell visibility,
 *                 a = intensity before socket dimming / 2 (read by the lift pass for gating).
 */

import { FULLSCREEN_VS } from '../glsl/common';
import { INFLUENCE_GLSL } from '../glsl/influence';
import { MODE_STRUCT_GLSL, MODES_EVAL_GLSL, MODES_GLSL } from '../glsl/modes/index';
import { NOISE_GLSL } from '../glsl/noise';
import {
  bindTexture,
  LazyProgram,
  type PassContext,
  setSampler,
  UNIT_LIFE,
  UNIT_LUT,
} from './shared';

function fieldFs(header: string): string {
  return `${header}
${NOISE_GLSL}
uniform sampler2D u_life;
uniform sampler2D u_lut;
layout(location = 0) out vec4 o_fieldA;
layout(location = 1) out vec4 o_fieldB;
${INFLUENCE_GLSL}
${MODE_STRUCT_GLSL}
${MODES_GLSL}

struct Mix { float scr; float over; float sum; float mx; float w; float env; float accent; };

void addMode(inout Mix x, float w, vec3 v) {
  float wi = w * max(v.x, 0.0);
  x.scr *= 1.0 - min(wi, 1.0);
  x.over += max(wi - 1.0, 0.0);
  x.sum += wi;
  x.mx = max(x.mx, wi);
  x.w += w;
  x.env = 1.0 - (1.0 - x.env) * (1.0 - sat(w * v.y));
  x.accent = max(x.accent, w * v.z);
}

// Per-cell value noise in time: aperiodic, smooth, identical at any frame rate. It doubles as the
// per-cell brightness variety: calm on the dense structure, twice as wide where the envelope
// thins out (the reference's outer band mixes bright and dim cells side by side).
float flickerF(uvec2 key, float h, float env) {
  float amt = P_animation_flicker_amount * (1.0 - 0.8 * f_clock.w)
            * (1.0 + 1.2 * (1.0 - smoothstep(0.3, 0.9, env)));
  amt = min(amt, 0.9);
  if (amt <= 0.001) return 1.0;
  float tt = f_clock.x * P_animation_flicker_rate * (0.6 + 0.8 * h) + h * 7.0;
  float e = floor(tt);
  float f = tt - e;
  uint ue = uint(e);
  float a = u01(hash3(uvec3(key.x ^ 0x68bc21ebu, key.y, ue)));
  float b = u01(hash3(uvec3(key.x ^ 0x68bc21ebu, key.y, ue + 1u)));
  return 1.0 - amt * (1.0 - mix(a, b, f * f * (3.0 - 2.0 * f)));
}

// Sparsity: where the envelope is low, cells drop out (re-rolled every period, crossfaded over
// 0.4 s) instead of all dimming, and survivors get brighter and more varied: sparse, crisp
// outskirts. "vary" is the survivor's brightness factor (1 where nothing is killed).
float presenceF(uvec2 key, float h, float env, out float killP, out float vary) {
  // Calibrated on the reference: ~5% / 30% / 75% of cells out where the envelope is ~0.7 /
  // 0.45 / 0.1 at the default amount.
  killP = min(1.0, 1.45 * P_animation_sparsity_amount) * pow(1.0 - smoothstep(0.08, 0.9, env), 1.5);
  // Where the envelope is ~0 (far outskirts of a wide host) the survivors thin out to nothing, so
  // the edges read as clean navy instead of a uniform sprinkle of boosted cells.
  killP = mix(killP, sat(2.0 * P_animation_sparsity_amount), 1.0 - smoothstep(0.01, 0.1, env));
  vary = 1.0;
  if (killP <= 0.001) return 1.0;
  float period = max(P_animation_sparsity_period, 0.1);
  float tt = f_clock.x / period + h;
  float e = floor(tt);
  float x = smoothstep(period - 0.4, period, (tt - e) * period);
  uint ue = uint(e);
  uint ka = hash3(uvec3(key.x ^ 0x02e5be93u, key.y, ue));
  uint kb = hash3(uvec3(key.x ^ 0x02e5be93u, key.y, ue + 1u));
  float a = smoothstep(killP - 0.04, killP + 0.04, u01(ka));
  float b = smoothstep(killP - 0.04, killP + 0.04, u01(kb));
  vary = mix(1.0, mix(0.45 + 1.1 * u01(pcg(ka)), 0.45 + 1.1 * u01(pcg(kb)), x), sat(1.6 * killP));
  return mix(a, b, x);
}

// Event sparkles only inside the lit structure: fast attack, smooth release, never pure white.
float sparkleF(uvec2 key, float h, float I) {
  float rate = P_animation_sparkle_rate;
  if (rate <= 0.0 || P_animation_sparkle_amount <= 0.0) return 0.0;
  float D = max(P_animation_sparkle_duration, 0.05);
  float tt = f_clock.x / D + h;
  float e = floor(tt);
  float x = tt - e;
  float fire = step(u01(hash3(uvec3(key.x ^ 0x2c1b3c6du, key.y, uint(e)))), rate * D);
  float env = x < 0.3 ? smoothstep(0.0, 0.3, x) : sq((1.0 - x) / 0.7);
  return fire * env * smoothstep(0.2, 0.45, I) * (1.0 - f_clock.w);
}

// Spatial ramp calibration: at scale 1 / offset 0 the default ring runs from red (left) through
// violet to azure (right), with the far right fading into the palette's navy end.
#define SPATIAL_T0 0.45
#define SPATIAL_K 1.2
float mapT(float mode, vec2 p, float I) {
  float sc = P_color_scale;
  if (mode < 0.5) {
    // bend > 0 curves the color boundaries into arcs around the center: the ends of a boundary
    // drift toward the palette end, so the start color stays a crescent on one side.
    vec2 d = vec2(cos(P_color_angle), sin(P_color_angle));
    float across = dot(p, vec2(-d.y, d.x));
    return SPATIAL_T0 + 0.5 * SPATIAL_K * sc * (dot(p, d) + P_color_bend * across * across);
  }
  if (mode < 1.5) return length(p) * sc * 0.75;
  if (mode < 2.5) {
    // Mirrored so a non-cyclic palette has no seam; t = 0 toward color.angle.
    float u = fract((atan(p.y, p.x) - P_color_angle) / TAU + 1.0);
    return 0.5 + (0.5 - abs(2.0 * u - 1.0)) * sc;
  }
  if (mode < 3.5) return 0.5 + (I - 0.5) * sc;
  return 0.5 + 0.9 * sc * fbm3(vec3(p * P_color_warpScale * 0.8 + 13.0, f_clock.x * 0.0625), 3);
}

void main() {
  ivec2 cell = ivec2(gl_FragCoord.xy);
  float pitch = f_grid.z;
  vec2 cpx = f_origin.xy + (vec2(cell) + 0.5) * pitch;
  // Hash key relative to the first visible cell, so changing the pad does not re-roll cells.
  uvec2 key = uvec2(cell - ivec2(int(f_grid.w + 0.5)) + 4096);
  uint hk = hash2(key);
  float h = u01(hk);
  float h2 = u01(pcg(hk ^ 0x9e3779b9u));
  float zoom = max(P_scene_zoom, 0.05);
  vec2 p = ((cpx - f_space.xy) * f_space.z - P_scene_center) / zoom;
  float cs = f_space.w / zoom;
  int nInf = int(f_counts.x + 0.5);

  // Repel influences push the sampling position outward before any mode sees it.
  for (int i = 0; i < MAX_INFLUENCES; i++) {
    if (i >= nInf) break;
    vec4 b = f_inf[i * 3 + 1];
    if (b.w > 3.5) {
      vec2 dv = cpx - f_inf[i * 3].xy;
      float len = length(dv);
      if (len > 1e-3) p += (dv / len) * (influenceK(i, cpx, pitch) * b.z * 0.25 / zoom);
    }
  }

  ModeIn m = ModeIn(p, length(p), cs, cell, h);
  Mix x = Mix(1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
${MODES_EVAL_GLSL}
  float blend = P_animation_blend;
  float I = blend < 0.5 ? 1.0 - x.scr + x.over : (blend < 1.5 ? x.sum / max(1.0, x.w) : x.mx);
  float env = sat(x.env);

  I = pow(max(I, 0.0), max(P_animation_gamma, 0.05)) * P_animation_brightness * P_animation_energy;
  I *= flickerF(key, h, env);
  // Heat is judged before the sparsity boost: a lone bright survivor in the outskirts must stay
  // saturated, only the genuinely hottest cells of the structure get pastel cores.
  float Iheat = I;
  float killP;
  float vary;
  float pres = presenceF(key, h2, env, killP, vary);
  // Dropped cells linger as dim squares next to the structure (the reference's outer band mixes
  // dim and bright cells) and vanish completely far out.
  I *= vary * mix(0.25 * smoothstep(0.2, 0.7, env), 1.0 + 2.5 * killP, pres);
  // Soft gate on near-black cells: against navy even I = 0.05 reads as a dim grid, while the
  // look wants the outskirts either empty or holding a few crisp survivors.
  I *= smoothstep(0.015, 0.09, I);
  float spk = sparkleF(key, h, I);
  I += P_animation_sparkle_amount * spk;
  // Sparkles are brightness peaks with only a hint of the hot tint, never white flashes.
  float hotAdd = 0.3 * spk * min(P_animation_sparkle_amount * 2.5, 1.0);

  // Influences (device px): light adds and tints, shadow multiplies down, lift heats up.
  vec3 tint = vec3(0.0);
  float tintW = 0.0;
  float shade = 1.0;
  for (int i = 0; i < MAX_INFLUENCES; i++) {
    if (i >= nInf) break;
    vec4 b = f_inf[i * 3 + 1];
    if (b.w > 2.5) continue;
    float k = influenceK(i, cpx, pitch) * b.z;
    if (k <= 0.0) continue;
    if (b.w < 0.5) {
      // Light lifts dim cells more than bright ones and never bleaches them: a lit neighbourhood
      // stays saturated neon instead of turning pastel.
      I += k * (1.0 - 0.5 * sat(I));
      vec4 c = f_inf[i * 3 + 2];
      tint += c.rgb * (k * c.a);
      tintW += k * c.a;
    } else if (b.w < 1.5) {
      shade *= 1.0 - sat(k);
    } else {
      I += 0.3 * k;
      hotAdd += 0.6 * k;
    }
  }
  // Pulses: gaussian rings in device px, widened to the cell footprint.
  int nPulse = int(f_counts.y + 0.5);
  for (int i = 0; i < MAX_PULSES; i++) {
    if (i >= nPulse) break;
    vec4 a = f_pulse[i * 3];
    vec4 b = f_pulse[i * 3 + 1];
    float w = sqrt(sq(0.5 * a.w) + sq(0.7 * pitch));
    float band = b.x * exp(-sq(length(cpx - a.xy) - a.z) / (2.0 * w * w));
    I += band;
    hotAdd += 0.1 * band;
    tint += f_pulse[i * 3 + 2].rgb * (band * b.y);
    tintW += band * b.y;
  }
  float Ipre = I * shade;

  // Lift sockets: the source cell dims while its copy floats above.
  float sock = 0.0;
  int nSock = int(f_counts.z + 0.5);
  for (int i = 0; i < MAX_LIFTS; i++) {
    if (i >= nSock) break;
    vec4 s = f_socket[i];
    if (ivec2(floor(s.xy + 0.5)) == cell) sock = max(sock, s.z);
  }
  // Same gate as the lift pass: a copy faded out over a dark cell leaves no dimmed socket behind.
#ifdef P_lift_threshold
  float gateHi = P_lift_threshold;
#else
  float gateHi = 0.2;
#endif
  I = Ipre * (1.0 - sat(sock) * smoothstep(0.5 * gateHi, gateHi, Ipre));

  float hot = (smoothstep(P_color_hot_threshold, 1.0, Iheat) * P_color_hot_amount + hotAdd) * shade;

  // Palette position: mapping (+ crossfade from the previous mapping), warp, jitter, drift.
  float t = mapT(P_color_mapping, p, Ipre);
  if (f_misc.y < 0.999) t = mix(mapT(f_misc.x, p, Ipre), t, sat(f_misc.y));
  float warpN = P_color_warp > 0.0 ? fbm3(vec3(p * P_color_warpScale, f_clock.x * 0.0625), 2) : 0.0;
  t += P_color_offset + P_color_warp * warpN + P_color_jitter * (h2 - 0.5)
     + P_color_intensityShift * (Ipre - 0.5);
  t = f_phaseB.w != 0.0 ? tri(t + f_phaseB.w) : sat(t);

  vec3 base = texture(u_lut, vec2(t * (255.0 / 256.0) + 0.5 / 256.0, 0.25)).rgb;
  // Hue cues from the reference: organic inner-edge patches take the accent color on the cool
  // half of the palette (cyan in the blue), hot cells lean red on the warm side. Both in OKLab.
  // Sharpened so patch cores take the accent fully (distinct teal cells, not a tinted azure).
  float acc = sat(1.6 * x.accent * P_color_accent_amount - 0.3) * smoothstep(0.42, 0.58, t);
  float rot = 0.35 * sat(hot) * (1.0 - smoothstep(0.2, 0.35, t));
  if (acc > 1e-3 || rot > 1e-3) {
    vec3 lab = lin2oklab(base);
    float cr = cos(rot);
    float sr = sin(rot);
    lab.yz = vec2(lab.y * cr - lab.z * sr, lab.y * sr + lab.z * cr);
    lab = mix(lab, lin2oklab(P_color_accent_color), acc);
    base = max(oklab2lin(lab), vec3(0.0));
  }
  base = saturateColor(base, P_color_saturation);
  if (tintW > 0.0) base = mix(base, tint / tintW, sat(tintW));

  float dead = P_animation_floor * (0.25 + 0.75 * env) * pres * mix(1.0, shade, 0.7);
  // Quadratic visibility: unlit cells read faintly next to the structure and vanish in the hole
  // and the far outskirts (clean navy there, as in the reference).
  dead *= min(dead * 4.0, 1.0);
  o_fieldA = enc4(vec4(base, I));
  o_fieldB = vec4(t, sat(hot), sat(dead), sat(Ipre * 0.5));
}
`;
}

export class FieldPass {
  private readonly prog: LazyProgram;

  constructor(private readonly ctx: PassContext) {
    this.prog = new LazyProgram(ctx, FULLSCREEN_VS, fieldFs(ctx.header), 'field', (p) => {
      setSampler(ctx.gl, p, 'u_life', UNIT_LIFE);
      setSampler(ctx.gl, p, 'u_lut', UNIT_LUT);
    });
  }

  poll(): boolean {
    return this.prog.poll();
  }

  run(fb: WebGLFramebuffer, w: number, h: number, life: WebGLTexture): void {
    const gl = this.ctx.gl;
    this.prog.use();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.viewport(0, 0, w, h);
    bindTexture(gl, UNIT_LIFE, life);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose(): void {
    this.prog.dispose();
  }
}
