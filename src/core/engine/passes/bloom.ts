/**
 * Glow pyramid at cell resolution (tiny: a 1080p host is ~40 x 25 cells):
 *   prefilter: soft-knee threshold on the max channel, scaled by the cell fill factor so the
 *              blurred light matches what the rounded bodies actually emit;
 *   bloom:     separable gaussian (sigma = bloom radius in cells) -> "glow";
 *   haze:      quarter-res tent downsample of the prefiltered emission, then gaussian
 *              (sigma = haze radius / 4) -> wide palette-tinted atmosphere.
 * Gaussians use the linear-sampling trick: up to 8 bilinear taps per side.
 */

import { FULLSCREEN_VS } from '../glsl/common';
import {
  bindTexture,
  LazyProgram,
  type PassContext,
  setSampler,
  UNIT_FIELD_A,
  UNIT_SRC,
} from './shared';

export const MAX_TAPS = 9;

const FILL_GLSL = /* glsl */ `
// Calibrates bloom.strength = 1 to "the glow of a lit cluster matches its cells" on the default look.
#define BLOOM_GAIN 3.0
float fillFactor() {
  float r = sat(P_grid_roundness);
  return sq(1.0 - P_grid_gap) * (1.0 - 0.43 * r * r);
}
`;

function prefilterFs(header: string): string {
  return `${header}
${FILL_GLSL}
uniform sampler2D u_fieldA;
out vec4 o_color;
void main() {
  vec4 f = dec4(texelFetch(u_fieldA, ivec2(gl_FragCoord.xy), 0));
  vec3 e = f.rgb * f.a;
  float m = max3(e);
  float th = P_glow_bloom_threshold;
  float knee = th * P_glow_bloom_knee + 1e-4;
  float s = clamp(m - th + knee, 0.0, 2.0 * knee);
  s = s * s / (4.0 * knee);
  float w = max(s, m - th) / max(m, 1e-4);
  o_color = enc4(vec4(e * (w * fillFactor() * BLOOM_GAIN), 1.0));
}
`;
}

function downsampleFs(header: string): string {
  return `${header}
uniform sampler2D u_src;   // bloom prefilter output (thresholded, fill-scaled emission)
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

function blurFs(header: string, dir: 'x' | 'y'): string {
  return `${header}
#define BLUR_DIR ${dir === 'x' ? 'vec2(1.0, 0.0)' : 'vec2(0.0, 1.0)'}
uniform sampler2D u_src;
uniform vec4 u_tex;              // xy logical size, zw 1 / allocation
uniform vec2 u_taps[${MAX_TAPS}]; // (offset texels, weight); [0] is the center
uniform int u_count;
out vec4 o_color;
void main() {
  vec2 pos = gl_FragCoord.xy;
  vec3 acc = dec4(texBilinear(u_src, pos, u_tex.xy, u_tex.zw)).rgb * u_taps[0].y;
  for (int i = 1; i < ${MAX_TAPS}; i++) {
    if (i >= u_count) break;
    vec2 o = BLUR_DIR * u_taps[i].x;
    acc += (dec4(texBilinear(u_src, pos + o, u_tex.xy, u_tex.zw)).rgb
          + dec4(texBilinear(u_src, pos - o, u_tex.xy, u_tex.zw)).rgb) * u_taps[i].y;
  }
  o_color = enc4(vec4(acc, 1.0));
}
`;
}

/**
 * Fills `out` with (offset, weight) pairs of a normalized gaussian folded into bilinear taps.
 * Returns the tap count (center included). Allocation-free.
 */
export function gaussianTaps(sigma: number, out: Float32Array): number {
  const s = Math.max(0.05, sigma);
  const radius = Math.min(2 * (MAX_TAPS - 1), Math.max(1, Math.ceil(s * 3)));
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

export class BloomPass {
  private readonly prefilter: LazyProgram;
  private readonly downsample: LazyProgram;
  private readonly blurs: LazyProgram[];
  private readonly taps = new Float32Array(MAX_TAPS * 2);
  private bloomSigma = -1;
  private hazeSigma = -1;

  constructor(private readonly ctx: PassContext) {
    const gl = ctx.gl;
    this.prefilter = new LazyProgram(
      ctx,
      FULLSCREEN_VS,
      prefilterFs(ctx.header),
      'bloom-prefilter',
      (p) => setSampler(gl, p, 'u_fieldA', UNIT_FIELD_A),
    );
    this.downsample = new LazyProgram(
      ctx,
      FULLSCREEN_VS,
      downsampleFs(ctx.header),
      'haze-downsample',
      (p) => setSampler(gl, p, 'u_src', UNIT_SRC),
    );
    const blur = (dir: 'x' | 'y', label: string) =>
      new LazyProgram(ctx, FULLSCREEN_VS, blurFs(ctx.header, dir), label, (p) =>
        setSampler(gl, p, 'u_src', UNIT_SRC),
      );
    // Separate programs per layer and direction: each keeps its own kernel uniforms, so kernels
    // are uploaded only when a sigma changes.
    this.blurs = [
      blur('x', 'bloom-x'),
      blur('y', 'bloom-y'),
      blur('x', 'haze-x'),
      blur('y', 'haze-y'),
    ];
  }

  poll(): boolean {
    let ok = this.prefilter.poll();
    ok = this.downsample.poll() && ok;
    for (const b of this.blurs) ok = b.poll() && ok;
    return ok;
  }

  /** Forces kernel re-upload (after programs are (re)linked). */
  invalidate(): void {
    this.bloomSigma = -1;
    this.hazeSigma = -1;
  }

  private uploadKernel(first: number, sigma: number): void {
    const gl = this.ctx.gl;
    const count = gaussianTaps(sigma, this.taps);
    for (let i = first; i < first + 2; i++) {
      const p = this.blurs[i]?.use();
      if (!p) continue;
      gl.uniform2fv(p.uniform('u_taps'), this.taps);
      gl.uniform1i(p.uniform('u_count'), count);
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
    }
  }

  run(
    w: number,
    h: number,
    qw: number,
    qh: number,
    bloom: BlurTarget,
    bloomTmp: BlurTarget,
    haze: BlurTarget,
    hazeTmp: BlurTarget,
  ): void {
    const gl = this.ctx.gl;
    // prefilter -> bloom; haze source is downsampled from it before the bloom blur overwrites it.
    this.prefilter.use();
    gl.bindFramebuffer(gl.FRAMEBUFFER, bloom.fb);
    gl.viewport(0, 0, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    bindTexture(gl, UNIT_SRC, bloom.tex);
    this.downsample.use();
    gl.bindFramebuffer(gl.FRAMEBUFFER, haze.fb);
    gl.viewport(0, 0, qw, qh);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // Bloom blur: x -> tmp, y -> bloom.
    gl.viewport(0, 0, w, h);
    this.blurs[0]?.use();
    gl.bindFramebuffer(gl.FRAMEBUFFER, bloomTmp.fb);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.blurs[1]?.use();
    bindTexture(gl, UNIT_SRC, bloomTmp.tex);
    gl.bindFramebuffer(gl.FRAMEBUFFER, bloom.fb);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // Haze blur: x -> tmp, y -> haze.
    gl.viewport(0, 0, qw, qh);
    this.blurs[2]?.use();
    bindTexture(gl, UNIT_SRC, haze.tex);
    gl.bindFramebuffer(gl.FRAMEBUFFER, hazeTmp.fb);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.blurs[3]?.use();
    bindTexture(gl, UNIT_SRC, hazeTmp.tex);
    gl.bindFramebuffer(gl.FRAMEBUFFER, haze.fb);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // Unbind the scratch unit so no later pass sees a feedback loop on it.
    bindTexture(gl, UNIT_SRC, null);
  }

  dispose(): void {
    this.prefilter.dispose();
    this.downsample.dispose();
    for (const b of this.blurs) b.dispose();
  }
}
