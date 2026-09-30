/**
 * Composite (the only full-resolution pass): rounded LED bodies on a pixel-snapped grid, a tight
 * two-lobe halo from the fragment's 2x2 quadrant neighbourhood (compact support of half a pitch,
 * so the 2x2 result equals a full 3x3 sum with no seams), the combined bloom + haze glow, a
 * palette-tinted background, hue-preserving tonemap, sRGB encode and TPDF dither.
 *
 * Kept lean on purpose. Per pixel at 'high': one glow lookup (B-spline, 4 bilinear taps; skipped
 * when both glow strengths are 0); inside the host 4 texelFetch of fieldA (the cell and its
 * quadrant neighbours) and one of fieldB; lit cells add 2 fetches of the baked cell stamp (the
 * cell shape and halo weights, see stamp.ts) and hot cells one LUT lookup.
 * 'medium' samples the glow bilinearly (1 tap). 'low' also drops the halo and the bevel, and with
 * them the neighbour and halo-stamp fetches.
 * Color math runs in mediump (FP16 on mobile GPUs); positions, texture coordinates and the dither
 * hash stay highp.
 */

import { FULLSCREEN_VS } from '../glsl/common';
import {
  LazyProgram,
  type PassContext,
  setSampler,
  UNIT_FIELD_A,
  UNIT_FIELD_B,
  UNIT_GLOW,
  UNIT_LUT,
  UNIT_STAMP_A,
  UNIT_STAMP_B,
} from './shared';

function compositeFs(header: string): string {
  return `${header}
uniform sampler2D u_fieldA;
uniform sampler2D u_fieldB;
uniform sampler2D u_glow;
uniform sampler2D u_lut;
uniform sampler2D u_stampA;
uniform sampler2D u_stampB;
uniform vec4 u_cellTex;  // xy logical cell texture size, zw 1 / allocation
uniform vec4 u_view;     // xy drawing buffer px, z quality (0 high, 1 medium, 2 low), w debug view
uniform vec2 u_flags;    // x opaque output, y glow on (the glow passes ran this frame)
out vec4 o_color;

mediump vec3 spot(mediump vec2 bp, mediump vec2 pos, mediump vec3 color, mediump float radius,
                  mediump float strength) {
  mediump vec2 d = bp - pos;
  mediump float r = max(radius, 1e-3);
  return color * (strength * exp2(-2.885 * dot(d, d) / (r * r)));
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, u_view.y - gl_FragCoord.y);
  float pitch = f_grid.z;
  vec2 gp = (px - f_origin.xy) / pitch;
  ivec2 lim = ivec2(u_cellTex.xy) - 1;
  ivec2 c = clamp(ivec2(floor(gp)), ivec2(0), lim);
  vec2 hp = px - f_host.xy;
  mediump float inHost = sat(min(hp.x, f_host.z - hp.x) + 0.5) * sat(min(hp.y, f_host.w - hp.y) + 0.5);
  int dbg = int(u_view.w + 0.5);
  bool cubic = u_view.z < 0.5;
  bool lowQ = u_view.z > 1.5;

  // Background in host-centered mode units; the vignette touches background and haze only (the
  // glow's haze share carries it already).
  mediump vec2 bp = (px - f_space.xy) * f_space.z;
  mediump vec2 nuv = (px - f_space.xy) / max(0.5 * f_host.zw, vec2(1.0));
  mediump float vigAmount = P_background_vignette;
  mediump float vig = 1.0 - vigAmount * smoothstep(0.5, 1.45, length(nuv));
  mediump vec3 bg = P_background_color;
  bg += spot(bp, P_background_spotA_position, P_background_spotA_color, P_background_spotA_radius, P_background_spotA_strength)
      + spot(bp, P_background_spotB_position, P_background_spotB_color, P_background_spotB_radius, P_background_spotB_strength);

  // Combined bloom + haze (saturated and weighted per cell by the bloom pass). Decoded sampling:
  // hardware filtering on float targets, decode-then-filter on RGBA8.
  mediump vec3 glow = vec3(0.0);
  if (u_flags.y > 0.5) {
    if (cubic) glow = texBicubicDec(u_glow, gp, u_cellTex.xy, u_cellTex.zw).rgb;
    else glow = texBilinearDec(u_glow, gp, u_cellTex.xy, u_cellTex.zw).rgb;
    glow *= GLOW_SCALE;
    // Glow exists only on the padded cell grid. The pad is capped, so a wide overflow margin can
    // reach past it: fade the glow out over the outermost two cells instead of smearing the
    // clamped edge texels into bands out to the canvas edge. (The canvas normally ends at least
    // 2.5 cells inside the grid, where this is 1.)
    vec2 ge = min(gp, u_cellTex.xy - gp);
    glow *= smoothstep(0.0, 2.0, min(ge.x, ge.y));
  }

  mediump vec3 cellC = vec3(0.0);
  mediump vec3 halo = vec3(0.0);
  mediump vec4 f0 = vec4(0.0);
  if (inHost > 0.0 || dbg == 1) {
    f0 = dec4(texelFetch(u_fieldA, c, 0));
    mediump vec4 b0 = texelFetch(u_fieldB, c, 0);
    // The pixel's offset inside its cell: pitch and origin are whole pixels, so this indexes the
    // baked cell stamp exactly. Its quadrant picks the neighbours the halo stamp was baked for.
    int ip = int(pitch + 0.5);
    ivec2 m = clamp(ivec2(floor(px - f_origin.xy)) - c * ip, ivec2(0), ivec2(ip - 1));
    ivec2 q = ivec2(2 * m.x + 1 < ip ? -1 : 1, 2 * m.y + 1 < ip ? -1 : 1);
    mediump vec4 fx = vec4(0.0);
    mediump vec4 fy = vec4(0.0);
    mediump vec4 fd = vec4(0.0);
    mediump float lit = f0.a;
    if (!lowQ) {
      fx = dec4(texelFetch(u_fieldA, clamp(c + ivec2(q.x, 0), ivec2(0), lim), 0));
      fy = dec4(texelFetch(u_fieldA, clamp(c + ivec2(0, q.y), ivec2(0), lim), 0));
      fd = dec4(texelFetch(u_fieldA, clamp(c + q, ivec2(0), lim), 0));
      lit = max(max(f0.a, fx.a), max(fy.a, fd.a));
    }
    if (lit > 0.002 || b0.b > 0.002) {
      mediump vec4 sa = texelFetch(u_stampA, m, 0);
      mediump float hk = b0.g * sa.g;
      mediump vec3 cc = f0.rgb;
      if (hk > 0.002) {
        float lutX = b0.r;
        mediump vec3 hotC = texture(u_lut, vec2(lutX * (255.0 / 256.0) + 0.5 / 256.0, 0.75)).rgb;
        // Keep the tint near the base's brightness: whitening a dark navy cell must not paint a
        // grey dot. The mix runs in a gamma-2 space: linear mixing of a little near-white into
        // saturated neon already reads pastel after the sRGB encode.
        hotC *= min(1.0, 1.6 * max3M(f0.rgb) / max(max3M(hotC), 1e-4));
        cc = sq3M(mix(sqrt(f0.rgb), sqrt(hotC), hk));
      }
      cc = cc * (f0.a * (1.0 + 0.5 * hk)) + f0.rgb * b0.b;
      mediump float bevel = P_grid_bevel;
      if (bevel > 0.0 && !lowQ) cc *= max(0.0, 1.0 + 4.0 * bevel * (2.0 * sa.b - 1.0));
      cellC = cc * sa.r;
      if (!lowQ && lit > 0.002) {
        mediump vec4 sb = texelFetch(u_stampB, m, 0);
        mediump float haloStrength = P_glow_halo_strength;
        halo = (f0.rgb * (f0.a * sb.x) + fx.rgb * (fx.a * sb.y) + fy.rgb * (fy.a * sb.z)
             + fd.rgb * (fd.a * sb.w)) * haloStrength;
      }
    }
  }

  mediump float gs = P_glow_saturation;
  halo = saturateColorM(halo, gs);

  mediump vec3 col;
  if (dbg == 0) col = bg * (inHost * vig) + glow + (cellC + halo) * inHost;
  else if (dbg == 1) col = f0.rgb * f0.a;
  else if (dbg == 2) col = halo * inHost;
  else if (dbg == 3 || dbg == 4) col = glow;  // the bloom pass isolated that layer
  else col = bg * vig * inHost + cellC * inHost;

  mediump float exposure = P_glow_exposure;
  mediump float whitePoint = P_glow_whitePoint;
  mediump vec3 tm = tonemapMaxM(col * exposure, whitePoint);
  mediump vec3 srgb = sat3M(lin2srgbM(tm) + ditherTPDF(gl_FragCoord.xy));
  mediump float a = 1.0;
  if (u_flags.x < 0.5 && inHost < 1.0) {
    // Glow-only margin: keep valid premultiplied alpha (rgb <= a) for every compositor.
    a = max(inHost, max3M(srgb));
    srgb = min(srgb, vec3(a));
  }
  o_color = vec4(srgb, a);
}
`;
}

export class CompositePass {
  private readonly prog: LazyProgram;
  private readonly last = new Float32Array(12).fill(Number.NaN);

  constructor(private readonly ctx: PassContext) {
    const gl = ctx.gl;
    this.prog = new LazyProgram(ctx, FULLSCREEN_VS, compositeFs(ctx.header), 'composite', (p) => {
      setSampler(gl, p, 'u_fieldA', UNIT_FIELD_A);
      setSampler(gl, p, 'u_fieldB', UNIT_FIELD_B);
      setSampler(gl, p, 'u_glow', UNIT_GLOW);
      setSampler(gl, p, 'u_lut', UNIT_LUT);
      setSampler(gl, p, 'u_stampA', UNIT_STAMP_A);
      setSampler(gl, p, 'u_stampB', UNIT_STAMP_B);
    });
  }

  poll(): boolean {
    return this.prog.poll();
  }

  /** Sizes are uploaded only when they change. `glow`: the glow target was rendered this frame. */
  run(
    viewW: number,
    viewH: number,
    w: number,
    h: number,
    allocW: number,
    allocH: number,
    quality: number,
    debugView: number,
    opaque: boolean,
    glow: boolean,
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
    if (l[4] !== viewW || l[5] !== viewH || l[6] !== quality || l[7] !== debugView) {
      l[4] = viewW;
      l[5] = viewH;
      l[6] = quality;
      l[7] = debugView;
      gl.uniform4f(p.uniform('u_view'), viewW, viewH, quality, debugView);
    }
    const op = opaque ? 1 : 0;
    const gw = glow ? 1 : 0;
    if (l[8] !== op || l[9] !== gw) {
      l[8] = op;
      l[9] = gw;
      gl.uniform2f(p.uniform('u_flags'), op, gw);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, viewW, viewH);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose(): void {
    this.prog.dispose();
  }
}
