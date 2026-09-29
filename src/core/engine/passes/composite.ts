/**
 * Composite (the only full-resolution pass): rounded LED bodies on a pixel-snapped grid, a tight
 * two-lobe halo from the fragment's 2x2 quadrant neighbourhood (compact support of half a pitch,
 * so the 2x2 result equals a full 3x3 sum with no seams), B-spline upsampled bloom + haze, a
 * palette-tinted background, hue-preserving tonemap, sRGB encode and TPDF dither.
 *
 * Kept lean on purpose: 4 texelFetch for the halo, one for fieldB, one LUT lookup, and an
 * early-out that skips all cell math where nothing is lit.
 */

import { FULLSCREEN_VS } from '../glsl/common';
import {
  LazyProgram,
  type PassContext,
  setSampler,
  UNIT_BLOOM,
  UNIT_FIELD_A,
  UNIT_FIELD_B,
  UNIT_HAZE,
  UNIT_LUT,
} from './shared';

function compositeFs(header: string): string {
  return `${header}
uniform sampler2D u_fieldA;
uniform sampler2D u_fieldB;
uniform sampler2D u_bloom;
uniform sampler2D u_haze;
uniform sampler2D u_lut;
uniform vec4 u_cellTex;  // xy logical cell texture size, zw 1 / allocation
uniform vec4 u_hazeTex;  // same for the quarter-res haze
uniform vec4 u_view;     // xy drawing buffer px, z quality (0 high, 1 medium, 2 low), w debug view
uniform float u_opaque;
out vec4 o_color;

// d: distance from a body edge in pitch units (>= 0). Tight rim lobe + soft lobe; the window is
// flat across the gap and reaches exactly 0 at half a pitch (what makes the 2x2 quadrant exact).
float haloKernel(float d, float invR2) {
  return (0.6 * exp2(-d * 28.8539) + 0.35 * exp2(-d * invR2)) * (1.0 - smoothstep(0.2, 0.5, d));
}

vec3 spot(vec2 bp, vec2 pos, vec3 color, float radius, float strength) {
  vec2 d = bp - pos;
  return color * (strength * exp2(-2.885 * dot(d, d) / sq(max(radius, 1e-3))));
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, u_view.y - gl_FragCoord.y);
  float pitch = f_grid.z;
  vec2 gp = (px - f_origin.xy) / pitch;
  ivec2 lim = ivec2(u_cellTex.xy) - 1;
  ivec2 c = clamp(ivec2(floor(gp)), ivec2(0), lim);
  vec2 hp = px - f_host.xy;
  float inHost = sat(min(hp.x, f_host.z - hp.x) + 0.5) * sat(min(hp.y, f_host.w - hp.y) + 0.5);
  int dbg = int(u_view.w + 0.5);
  bool lowQ = u_view.z > 1.5;

  // Background in host-centered mode units; the vignette touches background and haze only.
  vec2 bp = (px - f_space.xy) * f_space.z;
  vec2 nuv = (px - f_space.xy) / max(0.5 * f_host.zw, vec2(1.0));
  float vig = 1.0 - P_background_vignette * smoothstep(0.5, 1.45, length(nuv));
  vec3 bg = P_background_color
    + spot(bp, P_background_spotA_position, P_background_spotA_color, P_background_spotA_radius, P_background_spotA_strength)
    + spot(bp, P_background_spotB_position, P_background_spotB_color, P_background_spotB_radius, P_background_spotB_strength);

  vec3 bloom;
  vec3 haze;
  if (lowQ) {
    bloom = dec4(texBilinear(u_bloom, gp, u_cellTex.xy, u_cellTex.zw)).rgb;
    haze = dec4(texBilinear(u_haze, gp * 0.25, u_hazeTex.xy, u_hazeTex.zw)).rgb;
  } else {
    bloom = dec4(texBicubic(u_bloom, gp, u_cellTex.xy, u_cellTex.zw)).rgb;
    haze = dec4(texBicubic(u_haze, gp * 0.25, u_hazeTex.xy, u_hazeTex.zw)).rgb;
  }

  vec3 cellC = vec3(0.0);
  vec3 halo = vec3(0.0);
  vec4 f0 = vec4(0.0);
  if (inHost > 0.0 || dbg == 1) {
    vec2 l = gp - vec2(c);
    f0 = dec4(texelFetch(u_fieldA, c, 0));
    vec4 b0 = texelFetch(u_fieldB, c, 0);
    ivec2 q = ivec2(l.x < 0.5 ? -1 : 1, l.y < 0.5 ? -1 : 1);
    vec4 fx = dec4(texelFetch(u_fieldA, clamp(c + ivec2(q.x, 0), ivec2(0), lim), 0));
    vec4 fy = dec4(texelFetch(u_fieldA, clamp(c + ivec2(0, q.y), ivec2(0), lim), 0));
    vec4 fd = dec4(texelFetch(u_fieldA, clamp(c + q, ivec2(0), lim), 0));
    float lit = max(max(f0.a, fx.a), max(fy.a, fd.a));
    if (lit > 0.002 || b0.b > 0.002) {
      mediump vec2 lc = (l - 0.5) * pitch;
      mediump float hb = (1.0 - P_grid_gap) * 0.5 * pitch;
      mediump float rad = sat(P_grid_roundness) * hb;
      mediump float d0 = sdRoundBox(lc, vec2(hb), rad);
      mediump float aw = P_grid_softness + 0.5;
      mediump float body = 1.0 - smoothstep(-aw, aw, d0);
      mediump float dc = length(lc) / hb;
      mediump float emit = 1.0 - P_grid_emitter * min(dc * dc, 1.0);
      // Pastel only in the core of hot cells: a soft rounded square (L4 norm, no diagonal creases
      // unlike the box SDF) following the body; the rim and the halo stay saturated.
      mediump vec2 q2 = lc / hb;
      q2 *= q2;
      mediump float dq = sqrt(sqrt(dot(q2, q2)));
      mediump float core = 1.0 - smoothstep(0.45 * P_color_hot_core, 1.45 * P_color_hot_core, dq);
      mediump float hk = b0.g * core;
      vec3 hotC = texture(u_lut, vec2(b0.r * (255.0 / 256.0) + 0.5 / 256.0, 0.75)).rgb;
      // Keep the tint near the base's brightness: whitening a dark navy cell must not paint a grey dot.
      hotC *= min(1.0, 1.6 * max3(f0.rgb) / max(max3(hotC), 1e-4));
      vec3 cc = mix(f0.rgb, hotC, hk) * (f0.a * (1.0 + 0.5 * hk)) + f0.rgb * b0.b;
      if (P_grid_bevel > 0.0 && !lowQ) {
        mediump float rim = 1.0 - smoothstep(0.0, 0.3 * hb, -d0);
        cc *= max(0.0, 1.0 + 4.0 * P_grid_bevel * rim * clamp(-(lc.x + lc.y) / hb, -1.0, 1.0));
      }
      cellC = cc * (emit * body);
      if (!lowQ && lit > 0.002) {
        mediump float invR2 = 1.4427 / max(P_glow_halo_radius, 0.01);
        mediump float ip = 1.0 / pitch;
        mediump vec2 o = vec2(q) * pitch;
        mediump float k0 = haloKernel(max(d0, 0.0) * ip, invR2);
        mediump float kx = haloKernel(max(sdRoundBox(lc - vec2(o.x, 0.0), vec2(hb), rad), 0.0) * ip, invR2);
        mediump float ky = haloKernel(max(sdRoundBox(lc - vec2(0.0, o.y), vec2(hb), rad), 0.0) * ip, invR2);
        mediump float kd = haloKernel(max(sdRoundBox(lc - o, vec2(hb), rad), 0.0) * ip, invR2);
        halo = (f0.rgb * (f0.a * k0) + fx.rgb * (fx.a * kx) + fy.rgb * (fy.a * ky) + fd.rgb * (fd.a * kd))
             * (P_glow_halo_strength * (1.0 - body));
      }
    }
  }

  float gs = P_glow_saturation;
  bloom = saturateColor(bloom, gs) * P_glow_bloom_strength;
  haze = saturateColor(haze, gs) * P_glow_haze_strength;
  halo = saturateColor(halo, gs);

  vec3 col;
  if (dbg == 0) col = (bg * inHost + haze) * vig + bloom + (cellC + halo) * inHost;
  else if (dbg == 1) col = f0.rgb * f0.a;
  else if (dbg == 2) col = halo * inHost;
  else if (dbg == 3) col = bloom;
  else if (dbg == 4) col = haze;
  else col = bg * vig * inHost + cellC * inHost;

  vec3 tm = tonemapMax(col * P_glow_exposure, P_glow_whitePoint);
  vec3 srgb = sat3(lin2srgb(tm) + ditherTPDF(gl_FragCoord.xy));
  float a = 1.0;
  if (u_opaque < 0.5 && inHost < 1.0) {
    // Glow-only margin: keep valid premultiplied alpha (rgb <= a) for every compositor.
    a = max(inHost, max3(srgb));
    srgb = min(srgb, vec3(a));
  }
  o_color = vec4(srgb, a);
}
`;
}

export class CompositePass {
  private readonly prog: LazyProgram;
  private readonly last = new Float32Array(13).fill(Number.NaN);

  constructor(private readonly ctx: PassContext) {
    const gl = ctx.gl;
    this.prog = new LazyProgram(ctx, FULLSCREEN_VS, compositeFs(ctx.header), 'composite', (p) => {
      setSampler(gl, p, 'u_fieldA', UNIT_FIELD_A);
      setSampler(gl, p, 'u_fieldB', UNIT_FIELD_B);
      setSampler(gl, p, 'u_bloom', UNIT_BLOOM);
      setSampler(gl, p, 'u_haze', UNIT_HAZE);
      setSampler(gl, p, 'u_lut', UNIT_LUT);
    });
  }

  poll(): boolean {
    return this.prog.poll();
  }

  /** Sizes are uploaded only when they change. */
  run(
    viewW: number,
    viewH: number,
    w: number,
    h: number,
    allocW: number,
    allocH: number,
    qw: number,
    qh: number,
    allocQW: number,
    allocQH: number,
    quality: number,
    debugView: number,
    opaque: boolean,
  ): void {
    const gl = this.ctx.gl;
    const p = this.prog.use();
    const l = this.last;
    if (l[0] !== w || l[1] !== h || l[2] !== allocW || l[3] !== allocH) {
      l[0] = w;
      l[1] = h;
      l[2] = allocW;
      l[3] = allocH;
      gl.uniform4f(p.uniform('u_cellTex'), w, h, 1 / allocW, 1 / allocH);
    }
    if (l[4] !== qw || l[5] !== qh || l[6] !== allocQW || l[7] !== allocQH) {
      l[4] = qw;
      l[5] = qh;
      l[6] = allocQW;
      l[7] = allocQH;
      gl.uniform4f(p.uniform('u_hazeTex'), qw, qh, 1 / allocQW, 1 / allocQH);
    }
    if (l[8] !== viewW || l[9] !== viewH || l[10] !== quality || l[11] !== debugView) {
      l[8] = viewW;
      l[9] = viewH;
      l[10] = quality;
      l[11] = debugView;
      gl.uniform4f(p.uniform('u_view'), viewW, viewH, quality, debugView);
    }
    const op = opaque ? 1 : 0;
    if (l[12] !== op) {
      l[12] = op;
      gl.uniform1f(p.uniform('u_opaque'), op);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, viewW, viewH);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose(): void {
    this.prog.dispose();
  }
}
