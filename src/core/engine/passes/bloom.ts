/**
 * Glow pyramid at cell resolution (tiny: a 1080p host is ~40 x 25 cells):
 *   source:    the field pass writes the bloom source as its third MRT output (soft-knee
 *              threshold on the max channel, scaled by the cell fill factor so the blurred light
 *              matches what the rounded bodies actually emit): there is no prefilter pass;
 *   haze:      quarter-res tent downsample of the source, then gaussian (sigma = haze radius / 4);
 *   bloom:     separable gaussian (sigma = bloom radius in cells); its second (y) pass also
 *              combines: glow = saturated bloom * strength + saturated haze (B-spline sampled at
 *              the cell center) * strength * vignette, so the composite does one glow lookup.
 * Gaussians use the linear-sampling trick on float targets: up to 8 bilinear taps per side. The
 * RGBA8 fallback stores sqrt-encoded values, which must never be filtered by the hardware
 * (interpolating the encoding loses energy): there every texel is fetched, decoded and weighted
 * with the unfolded kernel (up to 16 per side, cheap at cell resolution).
 * Every pass rewrites its target's whole logical rect, so the old contents are discarded first
 * (tiled GPUs then skip loading them).
 */

import { FULLSCREEN_VS } from '../glsl/common';
import {
  bindTexture,
  discardTargets,
  LazyProgram,
  type PassContext,
  setSampler,
  UNIT_HAZE,
  UNIT_SRC,
} from './shared';

export const MAX_TAPS = 9;
/** Largest kernel radius in texels (the folded kernel covers two texels per tap). */
export const MAX_RADIUS = 2 * (MAX_TAPS - 1);

/**
 * Bloom source of one cell from its linear emission (base color * intensity), written by the
 * field pass as its third MRT output.
 */
export const BLOOM_SOURCE_GLSL = /* glsl */ `
// Calibrates bloom.strength = 1 to "the glow of a lit cluster matches its cells" on the default look.
#define BLOOM_GAIN 3.0
float fillFactor() {
  float r = sat(P_grid_roundness);
  return sq(1.0 - P_grid_gap) * (1.0 - 0.43 * r * r);
}
vec3 bloomSource(vec3 e) {
  float m = max3(e);
  float th = P_glow_bloom_threshold;
  float knee = th * P_glow_bloom_knee + 1e-4;
  float s = clamp(m - th + knee, 0.0, 2.0 * knee);
  s = s * s / (4.0 * knee);
  float w = max(s, m - th) / max(m, 1e-4);
  return e * (w * fillFactor() * BLOOM_GAIN);
}
`;

function downsampleFs(header: string): string {
  return `${header}
uniform sampler2D u_src;   // bloom source (thresholded, fill-scaled emission)
uniform vec4 u_cellTex;
out vec4 o_color;
// Quarter texel j is centered on cell coordinate 4j + 2; an 8-wide tent (1,2,3,4,4,3,2,1)
// around it is alias-free and exact (texelFetch, no filtering of encoded values).
void main() {
  ivec2 base = ivec2(gl_FragCoord.xy) * 4 - 2;
  ivec2 lim = ivec2(u_cellTex.xy) - 1;
  vec3 acc = vec3(0.0);
  for (int y = 0; y < 8; y++) {
    float wy = 4.5 - abs(float(y) - 3.5);
    for (int x = 0; x < 8; x++) {
      float wx = 4.5 - abs(float(x) - 3.5);
      acc += dec4(texelFetch(u_src, clamp(base + ivec2(x, y), ivec2(0), lim), 0)).rgb * (wx * wy);
    }
  }
  o_color = enc4(vec4(acc * (1.0 / 400.0), 1.0));
}
`;
}

function blurFs(header: string, dir: 'x' | 'y', combine = false): string {
  return `${header}
#define BLUR_DIR ${dir === 'x' ? 'vec2(1.0, 0.0)' : 'vec2(0.0, 1.0)'}
#define BLUR_STEP ${dir === 'x' ? 'ivec2(1, 0)' : 'ivec2(0, 1)'}
#define COMBINE ${combine ? 1 : 0}
uniform sampler2D u_src;
uniform vec4 u_tex;              // xy logical size, zw 1 / allocation
#if HDR_RT
uniform vec2 u_taps[${MAX_TAPS}]; // (offset texels, weight); [0] is the center
uniform int u_count;
#else
uniform float u_w[${MAX_RADIUS + 1}]; // per-texel weights, [0] is the center
uniform int u_radius;
#endif
#if COMBINE
uniform sampler2D u_haze;
uniform vec4 u_hazeTex;          // same for the quarter-res haze
uniform vec3 u_mix;              // x bloom on, y haze on, z vignette on (debug views isolate one)
#endif
out vec4 o_color;
void main() {
#if HDR_RT
  vec2 pos = gl_FragCoord.xy;
  vec3 acc = texBilinear(u_src, pos, u_tex.xy, u_tex.zw).rgb * u_taps[0].y;
  for (int i = 1; i < ${MAX_TAPS}; i++) {
    if (i >= u_count) break;
    vec2 o = BLUR_DIR * u_taps[i].x;
    acc += (texBilinear(u_src, pos + o, u_tex.xy, u_tex.zw).rgb
          + texBilinear(u_src, pos - o, u_tex.xy, u_tex.zw).rgb) * u_taps[i].y;
  }
#else
  // Decode before filtering: every texel is fetched exactly (clamped to the logical rect).
  ivec2 c = ivec2(gl_FragCoord.xy);
  ivec2 lim = ivec2(u_tex.xy) - 1;
  vec3 acc = dec4(texelFetch(u_src, c, 0)).rgb * u_w[0];
  for (int i = 1; i <= ${MAX_RADIUS}; i++) {
    if (i > u_radius) break;
    ivec2 o = BLUR_STEP * i;
    acc += (dec4(texelFetch(u_src, clamp(c + o, ivec2(0), lim), 0)).rgb
          + dec4(texelFetch(u_src, clamp(c - o, ivec2(0), lim), 0)).rgb) * u_w[i];
  }
#endif
#if COMBINE
  // The composite used to B-spline sample bloom (at the pixel) and haze (at pixel / 4) and add
  // them. Haze is wide enough that sampling it at the cell center and letting the composite's
  // single B-spline lookup carry it the rest of the way is indistinguishable; so is the vignette
  // taken per cell (it varies over the whole host).
  vec3 haze = texBicubicDec(u_haze, gl_FragCoord.xy * 0.25, u_hazeTex.xy, u_hazeTex.zw).rgb;
  vec2 cpx = f_origin.xy + gl_FragCoord.xy * f_grid.z;
  vec2 nuv = (cpx - f_space.xy) / max(0.5 * f_host.zw, vec2(1.0));
  float vig = 1.0 - P_background_vignette * smoothstep(0.5, 1.45, length(nuv));
  // Each layer is saturated on its own, as before (the saturation clamps at 0, so clamping the
  // sum instead would let a layer's negative channel eat into the other).
  float gs = P_glow_saturation;
  acc = saturateColor(acc, gs) * (P_glow_bloom_strength * u_mix.x)
      + saturateColor(haze, gs) * (P_glow_haze_strength * u_mix.y * mix(1.0, vig, u_mix.z));
  acc *= 1.0 / GLOW_SCALE;
#endif
  o_color = enc4(vec4(acc, 1.0));
}
`;
}

/** Kernel radius in texels for a sigma (shared by the folded and the per-texel kernels). */
function kernelRadius(sigma: number): number {
  return Math.min(MAX_RADIUS, Math.max(1, Math.ceil(Math.max(0.05, sigma) * 3)));
}

/**
 * Fills `out` (MAX_RADIUS + 1 floats) with the per-texel weights of the same normalized gaussian
 * that gaussianTaps() folds: out[0] is the center, out[i] the weight of each texel at +-i.
 * Returns the radius. Allocation-free.
 */
export function gaussianWeights(sigma: number, out: Float32Array): number {
  const s = Math.max(0.05, sigma);
  const radius = kernelRadius(sigma);
  const inv = 1 / (2 * s * s);
  let total = 1;
  for (let i = 1; i <= radius; i++) total += 2 * Math.exp(-i * i * inv);
  for (let i = 0; i <= MAX_RADIUS; i++) out[i] = i <= radius ? Math.exp(-i * i * inv) / total : 0;
  return radius;
}

/**
 * Fills `out` with (offset, weight) pairs of a normalized gaussian folded into bilinear taps.
 * Returns the tap count (center included). Allocation-free.
 */
export function gaussianTaps(sigma: number, out: Float32Array): number {
  const s = Math.max(0.05, sigma);
  const radius = kernelRadius(sigma);
  const inv = 1 / (2 * s * s);
  let total = 1;
  for (let i = 1; i <= radius; i++) total += 2 * Math.exp(-i * i * inv);
  out[0] = 0;
  out[1] = 1 / total;
  let n = 1;
  for (let i = 1; i <= radius; i += 2) {
    const wa = Math.exp(-i * i * inv) / total;
    const wb = i + 1 <= radius ? Math.exp(-(i + 1) * (i + 1) * inv) / total : 0;
    const w = wa + wb;
    out[n * 2] = w > 0 ? (i * wa + (i + 1) * wb) / w : i;
    out[n * 2 + 1] = w;
    n++;
  }
  for (let k = n; k < MAX_TAPS; k++) {
    out[k * 2] = 0;
    out[k * 2 + 1] = 0;
  }
  return n;
}

interface BlurTarget {
  readonly tex: WebGLTexture;
  readonly fb: WebGLFramebuffer;
}

/** Which layers the glow target holds per debug view: [bloom, haze, vignette] on/off. */
export function glowMix(debugView: number): readonly [number, number, number] {
  if (debugView === 3) return [1, 0, 0];
  if (debugView === 4) return [0, 1, 0];
  return [1, 1, 1];
}

export class BloomPass {
  private readonly downsample: LazyProgram;
  private readonly blurs: LazyProgram[];
  private readonly taps = new Float32Array(MAX_TAPS * 2);
  private readonly weights = new Float32Array(MAX_RADIUS + 1);
  private bloomSigma = -1;
  private hazeSigma = -1;
  private mixView = -1;

  constructor(private readonly ctx: PassContext) {
    const gl = ctx.gl;
    this.downsample = new LazyProgram(
      ctx,
      FULLSCREEN_VS,
      downsampleFs(ctx.header),
      'haze-downsample',
      (p) => setSampler(gl, p, 'u_src', UNIT_SRC),
    );
    const blur = (dir: 'x' | 'y', label: string, combine = false) =>
      new LazyProgram(ctx, FULLSCREEN_VS, blurFs(ctx.header, dir, combine), label, (p) => {
        setSampler(gl, p, 'u_src', UNIT_SRC);
        if (combine) setSampler(gl, p, 'u_haze', UNIT_HAZE);
      });
    // Separate programs per layer and direction: each keeps its own kernel uniforms, so kernels
    // are uploaded only when a sigma changes. bloom-y also combines bloom and haze into the glow.
    this.blurs = [
      blur('x', 'bloom-x'),
      blur('y', 'bloom-y-combine', true),
      blur('x', 'haze-x'),
      blur('y', 'haze-y'),
    ];
  }

  poll(): boolean {
    let ok = this.downsample.poll();
    for (const b of this.blurs) ok = b.poll() && ok;
    return ok;
  }

  /** Forces kernel re-upload (after programs are (re)linked). */
  invalidate(): void {
    this.bloomSigma = -1;
    this.hazeSigma = -1;
    this.mixView = -1;
  }

  private uploadKernel(first: number, sigma: number): void {
    const gl = this.ctx.gl;
    const hdr = this.ctx.caps.hdr;
    const count = hdr ? gaussianTaps(sigma, this.taps) : gaussianWeights(sigma, this.weights);
    for (let i = first; i < first + 2; i++) {
      const p = this.blurs[i]?.use();
      if (!p) continue;
      if (hdr) {
        gl.uniform2fv(p.uniform('u_taps'), this.taps);
        gl.uniform1i(p.uniform('u_count'), count);
      } else {
        gl.uniform1fv(p.uniform('u_w'), this.weights);
        gl.uniform1i(p.uniform('u_radius'), count);
      }
    }
  }

  /** Updates kernels when sigmas change (cells for bloom, cells for haze; haze runs at 1/4). */
  setSigmas(bloomSigma: number, hazeSigma: number): void {
    if (bloomSigma !== this.bloomSigma) {
      this.bloomSigma = bloomSigma;
      this.uploadKernel(0, bloomSigma);
    }
    if (hazeSigma !== this.hazeSigma) {
      this.hazeSigma = hazeSigma;
      this.uploadKernel(2, hazeSigma / 4);
    }
  }

  /** Updates per-target size uniforms (call after (re)allocation or logical size change). */
  setSizes(
    w: number,
    h: number,
    allocW: number,
    allocH: number,
    qw: number,
    qh: number,
    allocQW: number,
    allocQH: number,
  ): void {
    const gl = this.ctx.gl;
    const dp = this.downsample.use();
    gl.uniform4f(dp.uniform('u_cellTex'), w, h, 1 / allocW, 1 / allocH);
    for (let i = 0; i < 4; i++) {
      const p = this.blurs[i]?.use();
      if (!p) continue;
      if (i < 2) gl.uniform4f(p.uniform('u_tex'), w, h, 1 / allocW, 1 / allocH);
      else gl.uniform4f(p.uniform('u_tex'), qw, qh, 1 / allocQW, 1 / allocQH);
      if (i === 1) gl.uniform4f(p.uniform('u_hazeTex'), qw, qh, 1 / allocQW, 1 / allocQH);
    }
  }

  /**
   * `bloom` already holds the bloom source (written by the field pass). Leaves the combined glow
   * in `glow` (bloom only / haze only for those debug views); `bloom` is scratch afterwards.
   */
  run(
    w: number,
    h: number,
    qw: number,
    qh: number,
    bloom: BlurTarget,
    bloomTmp: BlurTarget,
    haze: BlurTarget,
    hazeTmp: BlurTarget,
    glow: BlurTarget,
    debugView: number,
  ): void {
    const gl = this.ctx.gl;
    // Haze first (the combine step reads it): source -> quarter res, x -> tmp, y -> haze.
    bindTexture(gl, UNIT_SRC, bloom.tex);
    this.downsample.use();
    gl.bindFramebuffer(gl.FRAMEBUFFER, haze.fb);
    discardTargets(this.ctx);
    gl.viewport(0, 0, qw, qh);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.blurs[2]?.use();
    bindTexture(gl, UNIT_SRC, haze.tex);
    gl.bindFramebuffer(gl.FRAMEBUFFER, hazeTmp.fb);
    discardTargets(this.ctx);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.blurs[3]?.use();
    bindTexture(gl, UNIT_SRC, hazeTmp.tex);
    gl.bindFramebuffer(gl.FRAMEBUFFER, haze.fb);
    discardTargets(this.ctx);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // Bloom: x -> tmp, then y + combine with the haze -> glow.
    gl.viewport(0, 0, w, h);
    this.blurs[0]?.use();
    bindTexture(gl, UNIT_SRC, bloom.tex);
    gl.bindFramebuffer(gl.FRAMEBUFFER, bloomTmp.fb);
    discardTargets(this.ctx);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const p = this.blurs[1]?.use();
    if (p && this.mixView !== debugView) {
      this.mixView = debugView;
      const m = glowMix(debugView);
      gl.uniform3f(p.uniform('u_mix'), m[0], m[1], m[2]);
    }
    bindTexture(gl, UNIT_SRC, bloomTmp.tex);
    gl.bindFramebuffer(gl.FRAMEBUFFER, glow.fb);
    discardTargets(this.ctx);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // Unbind the scratch unit so no later pass sees a feedback loop on it.
    bindTexture(gl, UNIT_SRC, null);
  }

  dispose(): void {
    this.downsample.dispose();
    for (const b of this.blurs) b.dispose();
  }
}
