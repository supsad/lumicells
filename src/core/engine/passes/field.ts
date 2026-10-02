/**
 * Field pass (MRT, one fragment per cell incl. pad): evaluates the weighted modes, shapes the
 * intensity (gamma, flicker, sparsity, sparkles), applies influences, pulses and lift sockets,
 * and maps the result to a palette position.
 *
 * fieldA (HDR): rgb = linear base color, a = intensity (socket-dimmed).
 * fieldB (RGBA8): r = palette t, g = hot amount, b = dead-cell visibility,
 *                 a = intensity before socket dimming / 2 (read by the lift pass for gating).
 * bloom (third attachment, HDR): the bloom source (thresholded, fill-scaled emission), computed
 *                 here from the unencoded values instead of in a prefilter pass of its own.
 *
 * Compile cost. This is by far the largest shader of the engine, and on Windows it is compiled by
 * FXC (ANGLE's Direct3D backend), whose compile time grows much faster than the code: with eleven
 * inlined copies of the gradient noise it took ~2.3 s per compile on a fast desktop CPU, paid
 * twice before the first frame (see MRT_PAD in shared.ts). So:
 * - the pass compiles variants holding only the modes and color features a look uses
 *   (field-variants.ts), lazily, when a slot first needs one;
 * - every function holds one call of the noise, in a loop where it needs several (RUNTIME_COUNT
 *   keeps FXC from unrolling it), and mapT is inlined once (the crossfade's previous mapping is
 *   a second loop iteration). Both give the very same values as the straight-line code;
 * - on Direct3D the pass runs in stages whose heavy programs have a single output (see
 *   FieldPass): those compile in the background, never on the thread that presents the page.
 */

import type { TextureFormat } from '../../gl/caps';
import {
  ALL_FEATURES,
  FEATURE_NOISE_MAP,
  FEATURE_WARP,
  pickVariant,
  type VariantState,
  variantToEvict,
  variantToRequest,
} from '../field-variants';
import { FULLSCREEN_VS } from '../glsl/common';
import { INFLUENCE_GLSL } from '../glsl/influence';
import { MODE_STRUCT_GLSL, modesEvalGlsl, modesGlsl } from '../glsl/modes/index';
import { NOISE_GLSL } from '../glsl/noise';
import type { Target } from '../resources';
import { BLOOM_SOURCE_GLSL } from './bloom';
import {
  bindTexture,
  discardTargets,
  LazyProgram,
  MRT_PAD_WRITE,
  mrtFirst,
  mrtOutputs,
  type PassContext,
  setSampler,
  UNIT_LIFE,
  UNIT_LUT,
  UNIT_REST_COLOR,
  UNIT_REST_SCALAR,
  UNIT_STAGE,
  type WarmTargets,
  warmDraw,
} from './shared';

/** Field variants a device keeps compiled (more only while all of them are in use). */
export const MAX_FIELD_VARIANTS = 6;

/**
 * GLSL of the field pass, in parts: the programs of the staged pass share most of them (see
 * FieldPass).
 */
const MIX_GLSL = /* glsl */ `
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
`;

/** Intensity shaping and the palette mapping (flicker, sparsity, sparkles, mapT). */
const SHAPE_GLSL = /* glsl */ `
// Per-cell value noise in time: aperiodic, smooth, identical at any frame rate. It doubles as the
// per-cell brightness variety: calm on the dense structure, twice as wide where the envelope
// thins out (the reference's outer band mixes bright and dim cells side by side).
float flickerF(uvec2 key, float h, float env) {
  float amt = P_animation_flicker_amount * (1.0 - 0.8 * f_clock.w)
            * (1.0 + 1.2 * (1.0 - smoothstep(0.3, 0.9, env)));
  amt = min(amt, 0.9);
  if (amt <= 0.001) return 1.0;
  // Each cell runs at k / FLICKER_RATE_STEPS (0.6..1.4) of the base phase. The whole part is
  // multiplied in integers: an EPOCH_WRAP jump of the base phase moves every cell by k whole
  // multiples of the cell's index period (EPOCH_WRAP / FLICKER_RATE_STEPS), so the wrap is
  // seamless, and the fraction keeps full precision.
  float q = float(FLICKER_RATE_STEPS);
  float k = floor((0.6 + 0.8 * h) * q + 0.5);
  uint pk = uint(f_epochB.x) * uint(k);
  float tt = (float(pk % FLICKER_RATE_STEPS) + f_epochB.y * k) / q + h * 7.0;
  float e = floor(tt);
  float f = tt - e;
  uint mask = EPOCH_MASK / FLICKER_RATE_STEPS;
  uint ue = (pk / FLICKER_RATE_STEPS + uint(e)) & mask;
  uint ue1 = (ue + 1u) & mask;
  float a = u01(hash3(uvec3(key.x ^ 0x68bc21ebu, key.y, ue)));
  float b = u01(hash3(uvec3(key.x ^ 0x68bc21ebu, key.y, ue1)));
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
  uint ue;
  float fr = epochAt(f_epochA.xy, h, ue);
  float x = smoothstep(period - 0.4, period, fr * period);
  uint ka = hash3(uvec3(key.x ^ 0x02e5be93u, key.y, ue));
  uint kb = hash3(uvec3(key.x ^ 0x02e5be93u, key.y, (ue + 1u) & EPOCH_MASK));
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
  uint ue;
  float x = epochAt(f_epochA.zw, h, ue);
  float fire = step(u01(hash3(uvec3(key.x ^ 0x2c1b3c6du, key.y, ue))), rate * D);
  float env = x < 0.3 ? smoothstep(0.0, 0.3, x) : sq((1.0 - x) / 0.7);
  return fire * env * smoothstep(0.2, 0.45, I) * (1.0 - f_clock.w);
}

// Spatial ramp calibration: at scale 1 / offset 0 the default ring runs from red (left) through
// violet to azure (right), with the far right fading into the palette's navy end.
#define SPATIAL_T0 0.45
#define SPATIAL_K 1.2
float mapT(float mode, vec2 p, float I, float cs) {
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
#if FIELD_NOISE_MAP
  float fq = P_color_warpScale * 0.8;
  return 0.5 + 0.9 * sc * fbm3(vec3(p * fq + 13.0, f_clock.x * 0.0625), 3, fq * cs);
#else
  // A variant without the noise mapping draws only while the one with it compiles (a mapping
  // just switched to noise): the intensity mapping stands in for that moment.
  return 0.5 + (I - 0.5) * sc;
#endif
}
`;

/** main() head: the cell, its hash keys and its sampling position (repel influences applied). */
const PRELUDE_GLSL = /* glsl */ `
  ivec2 cell = ivec2(gl_FragCoord.xy);
  float pitch = f_grid.z;
  vec2 cpx = f_origin.xy + (vec2(cell) + 0.5) * pitch;
  // Hash key relative to the center cell (cols and rows are odd): neither a pad change nor
  // symmetric grid growth (cols/rows change in steps of 2 around a fixed center) re-rolls the
  // cells that stay in place.
  ivec2 ctr = ivec2(int(f_grid.w + 0.5)) + (ivec2(f_grid.xy + 0.5) - 1) / 2;
  uvec2 key = uvec2(cell - ctr + 4096);
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
`;

/** The weighted modes: blended intensity I, envelope env and accent. */
function modesMainGlsl(features: number): string {
  return `
  ModeIn m = ModeIn(p, length(p), cs, cell, h);
  Mix x = Mix(1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
${modesEvalGlsl(features)}
  float blend = P_animation_blend;
  float I = blend < 0.5 ? 1.0 - x.scr + x.over : (blend < 1.5 ? x.sum / max(1.0, x.w) : x.mx);
  float env = sat(x.env);
  float accent = x.accent;
`;
}

/** The palette warp (an fbm per cell, FEATURE_WARP): warpN. */
const WARP_GLSL = /* glsl */ `
#if FIELD_WARP
  float warpN = P_color_warp > 0.0
    ? fbm3(vec3(p * P_color_warpScale, f_clock.x * 0.0625), 2, P_color_warpScale * cs)
    : 0.0;
#else
  float warpN = 0.0;
#endif
`;

/**
 * From I, env, accent and warpN to the three outputs. FIELD_SCALAR_IN (the staged pass's color
 * program): Ipre, hot and t come from the scalar program's texel (`scalarIn`, the very values),
 * so neither the intensity shaping nor the palette mapping runs twice.
 */
const REST_GLSL = /* glsl */ `
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
#if FIELD_SCALAR_IN
  float Ipre = scalarIn.w;
#else
  float Ipre = I * shade;
#endif

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

#if FIELD_SCALAR_IN
  float hot = scalarIn.y;
#else
  float hot = (smoothstep(P_color_hot_threshold, 1.0, Iheat) * P_color_hot_amount + hotAdd) * shade;
#endif

  // Palette position: mapping (+ crossfade from the previous mapping), warp, jitter, drift.
  // While a mapping change crossfades, the previous mapping is a second iteration: one inlined
  // copy of mapT (and of its noise) instead of two.
#if FIELD_SCALAR_IN
  float t = scalarIn.x;
#else
  float t = 0.0;
  float tPrev = 0.0;
  int maps = f_misc.y < 0.999 ? 2 : 1;
  for (int k = 0; k < RUNTIME_COUNT(maps); k++) {
    float v = mapT(k == 0 ? P_color_mapping : f_misc.x, p, Ipre, cs);
    if (k == 0) t = v;
    else tPrev = v;
  }
  if (maps == 2) t = mix(tPrev, t, sat(f_misc.y));
  t += P_color_offset + P_color_warp * warpN + P_color_jitter * (h2 - 0.5)
     + P_color_intensityShift * (Ipre - 0.5);
  // Drift: tri() folds the palette (period 2, the drift phase wraps at 2 as well). The switch is a
  // per-frame flag (rate or phase nonzero), never the phase value itself.
  t = f_misc.w > 0.5 ? tri(t + f_phaseB.w) : sat(t);
#endif

  vec3 base = texture(u_lut, vec2(t * (255.0 / 256.0) + 0.5 / 256.0, 0.25)).rgb;
  // Hue cues from the reference: organic inner-edge patches take the accent color on the cool
  // half of the palette (cyan in the blue), hot cells lean red on the warm side. Both in OKLab.
  // Sharpened so patch cores take the accent fully (distinct teal cells, not a tinted azure).
  float acc = sat(1.6 * accent * P_color_accent_amount - 0.3) * smoothstep(0.42, 0.58, t);
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
`;

/** The three outputs (after the MRT pad output). */
const OUTPUTS_GLSL = `${MRT_PAD_WRITE}
  o_fieldA = enc4(vec4(base, I));
  o_fieldB = vec4(t, sat(hot), sat(dead), sat(Ipre * 0.5));
  o_bloom = enc4(vec4(bloomSource(base * I), 1.0));`;

/**
 * Feature switches of a program (see field-variants.ts); `scalarIn`: the staged pass's color
 * program (see REST_GLSL).
 */
function featureDefines(features: number, scalarIn = false): string {
  return `#define FIELD_NOISE_MAP ${features & FEATURE_NOISE_MAP ? 1 : 0}
#define FIELD_WARP ${features & FEATURE_WARP ? 1 : 0}
#define FIELD_SCALAR_IN ${scalarIn ? 1 : 0}`;
}

/** The whole field in one program (the fused pass) for a feature mask. */
export function fieldFs(header: string, features = ALL_FEATURES): string {
  return `${header}
${featureDefines(features)}
${NOISE_GLSL}
uniform sampler2D u_life;
uniform sampler2D u_lut;
${mrtOutputs(['o_fieldA', 'o_fieldB', 'o_bloom'])}
${INFLUENCE_GLSL}
${BLOOM_SOURCE_GLSL}
${MODE_STRUCT_GLSL}
${modesGlsl(features)}
${MIX_GLSL}
${SHAPE_GLSL}
void main() {
${PRELUDE_GLSL}
${modesMainGlsl(features)}
${WARP_GLSL}
${REST_GLSL}
${OUTPUTS_GLSL}
}
`;
}

/** First stage of the staged pass: the modes and the warp into one RGBA32F texel. */
export function fieldModesFs(header: string, features: number): string {
  return `${header}
${featureDefines(features)}
${NOISE_GLSL}
uniform sampler2D u_life;
out vec4 o_stage;
${INFLUENCE_GLSL}
${MODE_STRUCT_GLSL}
${modesGlsl(features)}
${MIX_GLSL}
void main() {
${PRELUDE_GLSL}
${modesMainGlsl(features)}
${WARP_GLSL}
  o_stage = vec4(I, env, accent, warpN);
}
`;
}

/** What a second-stage program of the staged pass writes (see FieldPass). */
export type RestOutput = 'color' | 'scalar';

/**
 * Second stage: the rest of the field from the first stage's texel (exact: RGBA32F holds the
 * values as computed), into one RGBA32F texel, the values the outputs are made of: `scalar` =
 * (t, hot, dead, Ipre), then `color` = (base, I), which reads Ipre, hot and t from the scalar
 * texel. Each program evaluates only what its output needs (the compiler drops the rest). Its
 * only feature switch is the noise mapping.
 */
export function fieldRestFs(header: string, features: number, out: RestOutput): string {
  const color = out === 'color';
  return `${header}
${featureDefines(features & FEATURE_NOISE_MAP, color)}
${NOISE_GLSL}
uniform highp sampler2D u_stage;
${color ? 'uniform highp sampler2D u_restScalar;' : ''}
uniform sampler2D u_lut;
out vec4 o_rest;
${INFLUENCE_GLSL}
${SHAPE_GLSL}
void main() {
${PRELUDE_GLSL}
  vec4 stage = texelFetch(u_stage, cell, 0);
  float I = stage.x;
  float env = stage.y;
  float accent = stage.z;
  float warpN = stage.w;
${color ? '  vec4 scalarIn = texelFetch(u_restScalar, cell, 0);' : ''}
${REST_GLSL}
  o_rest = ${color ? 'vec4(base, I)' : 'vec4(t, hot, dead, Ipre)'};
}
`;
}

/**
 * Last stage: the three field targets from the two second-stage texels, exactly as the fused
 * pass writes them. The only program of the staged pass with several outputs, kept tiny.
 */
export function fieldPackFs(header: string): string {
  return `${header}
uniform highp sampler2D u_restColor;
uniform highp sampler2D u_restScalar;
${mrtOutputs(['o_fieldA', 'o_fieldB', 'o_bloom'])}
${BLOOM_SOURCE_GLSL}
void main() {
  ivec2 cell = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(u_restColor, cell, 0);
  vec4 s = texelFetch(u_restScalar, cell, 0);
  vec3 base = c.rgb;
  float I = c.a;
  float t = s.x;
  float hot = s.y;
  float dead = s.z;
  float Ipre = s.w;
${OUTPUTS_GLSL}
}
`;
}

/** One program of the field pass, compiled, linked and warmed up on its own. */
export class FieldProgram {
  /** Linked: its warm-up draw is issued (or due). */
  linked = false;
  /** Warmed up (see GpuDevice): usable for a draw. */
  warmed = false;

  constructor(
    readonly prog: LazyProgram,
    /** Its outputs: the three field targets, or one RGBA32F texel (staged pass). */
    readonly outputs: 'field' | 'stage',
  ) {}
}

/** The second stage of the staged pass for one noise mapping (shared by its variants). */
export interface RestStage {
  /** Writes (t, hot, dead, Ipre). */
  readonly scalar: FieldProgram;
  /** Writes (base, I), from the scalar texel. */
  readonly color: FieldProgram;
}

/**
 * The field pass for a feature mask: one program, or on the staged pass its first-stage program
 * plus the second-stage and pack programs it shares with other variants.
 */
export class FieldVariant implements VariantState {
  lastUsed = -1;

  constructor(
    readonly mask: number,
    readonly main: FieldProgram,
    readonly rest: RestStage | null,
    readonly pack: FieldProgram | null,
  ) {}

  get ready(): boolean {
    if (!this.main.warmed) return false;
    const rest = this.rest;
    return !rest || (rest.color.warmed && rest.scalar.warmed && (this.pack?.warmed ?? false));
  }
}

/** The staged pass's intermediate targets (a slot's CellTargets; null on the fused pass). */
export interface StageTargets {
  /** First stage: (I, env, accent, warpN). */
  readonly stage: Target | null;
  readonly restColor: Target | null;
  readonly restScalar: Target | null;
}

/**
 * Field pass. Fused: one MRT program per variant. Staged (GLCaps.stageFormat, ANGLE on
 * Direct3D): the first stage evaluates the modes and the warp into an RGBA32F texel; two
 * programs compute the rest from it, one RGBA32F texel each: (t, hot, dead, Ipre), then from
 * that (base, I); a tiny MRT program packs them into the three field targets.
 *
 * Why stages there: ANGLE's D3D11 backend compiles an MRT program's real pixel shader on its
 * first draw, on the GPU process's main thread, which also composites and rasterizes the page:
 * nothing on it repaints until that compile ends (~0.3 s for the rest of the field on a fast
 * desktop CPU, around a second for the fused shader, more on a laptop). A program with a single
 * output is compiled at link time, on a worker thread, in the background. So every costly part
 * has a single output, and the draw-time compile only covers the pack. It costs three more
 * cell-resolution draws and three RGBA32F targets per slot, and gives the very same values.
 */
export class FieldPass {
  readonly #variants: FieldVariant[] = [];
  /** Second-stage programs by noise mapping (staged pass only). */
  readonly #rests: (RestStage | null)[] = [null, null];
  /** The pack program (staged pass only, one for every variant). */
  #pack: FieldProgram | null = null;
  /** Target formats of the field framebuffer (fieldA, fieldB, bloom source). */
  readonly #formats: readonly TextureFormat[];
  readonly #stageFormat: TextureFormat | null;

  readonly #ctx: PassContext;

  constructor(ctx: PassContext) {
    this.#ctx = ctx;
    const caps = ctx.caps;
    this.#formats = [caps.hdrFormat, caps.rgba8, caps.hdrFormat];
    this.#stageFormat = caps.stageFormat;
  }

  /** Runs in stages (see the class header). */
  get staged(): boolean {
    return this.#stageFormat !== null;
  }

  #program(fs: string, label: string, outputs: 'field' | 'stage'): FieldProgram {
    const gl = this.#ctx.gl;
    const prog = new LazyProgram(this.#ctx, FULLSCREEN_VS, fs, label, (p) => {
      setSampler(gl, p, 'u_life', UNIT_LIFE);
      setSampler(gl, p, 'u_lut', UNIT_LUT);
      setSampler(gl, p, 'u_stage', UNIT_STAGE);
      setSampler(gl, p, 'u_restColor', UNIT_REST_COLOR);
      setSampler(gl, p, 'u_restScalar', UNIT_REST_SCALAR);
    });
    return new FieldProgram(prog, outputs);
  }

  /**
   * Starts compiling a variant for `wanted` unless one (ready or compiling) covers it. Past
   * MAX_FIELD_VARIANTS the one used longest ago (and not since `keepAfter`) goes first. The
   * costliest program is submitted first: compiles run on a few worker threads.
   */
  request(wanted: number, keepAfter: number): void {
    if (variantToRequest(this.#variants, wanted) < 0) return;
    const evict = variantToEvict(this.#variants, MAX_FIELD_VARIANTS, keepAfter);
    if (evict >= 0) {
      const old = this.#variants[evict] as FieldVariant;
      old.main.warmed = false;
      old.main.prog.dispose();
      this.#variants.splice(evict, 1);
    }
    const header = this.#ctx.header;
    const tag = wanted.toString(16);
    if (!this.staged) {
      const main = this.#program(fieldFs(header, wanted), `field-${tag}`, 'field');
      this.#variants.push(new FieldVariant(wanted, main, null, null));
      return;
    }
    const main = this.#program(fieldModesFs(header, wanted), `field-modes-${tag}`, 'stage');
    const noise = (wanted & FEATURE_NOISE_MAP) !== 0 ? 1 : 0;
    let rest = this.#rests[noise] ?? null;
    if (!rest) {
      const scalar = fieldRestFs(header, wanted, 'scalar');
      const color = fieldRestFs(header, wanted, 'color');
      rest = {
        scalar: this.#program(scalar, `field-rest-scalar-${noise}`, 'stage'),
        color: this.#program(color, `field-rest-color-${noise}`, 'stage'),
      };
      this.#rests[noise] = rest;
    }
    this.#pack ??= this.#program(fieldPackFs(header), 'field-pack', 'field');
    this.#variants.push(new FieldVariant(wanted, main, rest, this.#pack));
  }

  /** A ready variant covers `needed`. */
  covers(needed: number): boolean {
    for (const v of this.#variants) if (v.ready && (v.mask & needed) === needed) return true;
    return false;
  }

  /** A program of a variant is still compiling (not linked yet). */
  get linking(): boolean {
    for (const v of this.#variants) {
      if (!v.main.linked || (v.pack && !v.pack.linked)) return true;
      if (v.rest && (!v.rest.scalar.linked || !v.rest.color.linked)) return true;
    }
    return false;
  }

  /**
   * Polls the compiling programs (throws ShaderError on a failure) and appends the ones that
   * just linked to `out`: they need their warm-up. Returns how many.
   */
  pollLinks(out: FieldProgram[]): number {
    let n = 0;
    const poll = (fp: FieldProgram | null | undefined) => {
      if (!fp || fp.linked || !fp.prog.poll()) return;
      fp.linked = true;
      out.push(fp);
      n++;
    };
    for (const v of this.#variants) poll(v.main);
    for (const r of this.#rests) {
      poll(r?.scalar);
      poll(r?.color);
    }
    poll(this.#pack);
    return n;
  }

  /** The warm-up draw of a linked program, into scratch targets of its real layout. */
  warm(fp: FieldProgram, targets: WarmTargets): void {
    const fb =
      fp.outputs === 'stage' && this.#stageFormat
        ? targets.framebuffer([this.#stageFormat])
        : targets.framebuffer(this.#formats, mrtFirst(this.#ctx));
    warmDraw(this.#ctx, fp.prog, fb);
  }

  /**
   * The variant to draw with (see pickVariant), null when none is usable yet. `frame` is the
   * device frame counter (recency, for eviction and ties).
   */
  select(needed: number, previous: FieldVariant | null, frame: number): FieldVariant | null {
    const prev = previous ? this.#variants.indexOf(previous) : -1;
    const v = this.#variants[pickVariant(this.#variants, needed, prev)];
    if (!v) return null;
    v.lastUsed = frame;
    return v;
  }

  /**
   * `fb` has three attachments: fieldA, fieldB and the bloom source (after the pad). `stages`:
   * the slot's intermediate targets (staged pass), which the slot keeps bound to UNIT_STAGE,
   * UNIT_REST_SCALAR and UNIT_REST_COLOR (see RenderSlot.bindCellTargets).
   */
  run(
    fb: WebGLFramebuffer,
    stages: StageTargets,
    w: number,
    h: number,
    life: WebGLTexture,
    v: FieldVariant,
  ): void {
    const gl = this.#ctx.gl;
    v.main.prog.use();
    bindTexture(gl, UNIT_LIFE, life);
    gl.viewport(0, 0, w, h);
    const { stage, restColor, restScalar } = stages;
    if (v.rest && v.pack && stage && restColor && restScalar) {
      this.#draw(stage.fb, 1);
      v.rest.scalar.prog.use();
      this.#draw(restScalar.fb, 1);
      v.rest.color.prog.use();
      this.#draw(restColor.fb, 1);
      v.pack.prog.use();
    }
    this.#draw(fb, 3, mrtFirst(this.#ctx));
  }

  /** One fullscreen draw into `count` attachments of `fb` (from `first`), viewport set. */
  #draw(fb: WebGLFramebuffer, count: number, first = 0): void {
    const gl = this.#ctx.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    discardTargets(this.#ctx, count, first);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose(): void {
    const drop = (fp: FieldProgram | null | undefined) => {
      if (!fp) return;
      fp.warmed = false;
      fp.prog.dispose();
    };
    for (const v of this.#variants) drop(v.main);
    this.#variants.length = 0;
    for (const r of this.#rests) {
      drop(r?.color);
      drop(r?.scalar);
    }
    this.#rests[0] = null;
    this.#rests[1] = null;
    drop(this.#pack);
    this.#pack = null;
  }
}
