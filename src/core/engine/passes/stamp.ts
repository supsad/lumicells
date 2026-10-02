/**
 * Cell stamp: the per-pixel cell shape, baked once per pitch.
 *
 * Every lit pixel of the composite used to evaluate the same shape math: the body SDF and its
 * anti-aliased edge, the emitter falloff, the hot-core mask, the bevel rim and four halo kernels
 * (four SDFs, eight exp2). All of it depends only on the pixel's position inside its cell and on
 * a few grid / glow parameters. The pitch is a whole number of device pixels and the grid origin
 * is pixel-snapped (see controller/geometry.ts), so that position is one of pitch x pitch values:
 * this pass evaluates them once into a pitch x pitch texture pair and the composite fetches them.
 *
 * Re-baked only when the pitch changes or the params block was uploaded (pitch^2 draws, at most
 * a few thousand texels). Texel (x, y) holds the pixel at offset (x, y) from the cell's top-left
 * corner, canvas orientation (y down), exactly the composite's in-cell offset.
 *
 * stampA: r = body * emitter falloff, g = hot-core mask, b = bevel term * 0.5 + 0.5, a = 1.
 * stampB: halo kernel weights times (1 - body) for the cell itself (x), its horizontal (y),
 *         vertical (z) and diagonal (w) neighbours in the pixel's quadrant (the composite picks
 *         the same neighbours from the same offset).
 * Both are RGBA16F when float targets render (the values are then exact to ~1e-3), else RGBA8.
 *
 * Each texture has a program of its own (one output each), not one program with two outputs:
 * on Direct3D, ANGLE compiles a program with several outputs again on its first draw, on the GPU
 * process's main thread (see MRT_PAD in shared.ts), while a single-output program is compiled at
 * link time, in the background. A bake is rare, so the second draw costs nothing that matters.
 *
 * The programs belong to the device (StampPass); the baked textures depend on the slot's params
 * and pitch, so every slot owns a StampTarget.
 */

import type { TextureFormat } from '../../gl/caps';
import {
  bucketSize,
  createMrtFramebuffer,
  createTargetTexture,
  needsRealloc,
} from '../../gl/target';
import { FULLSCREEN_VS } from '../glsl/common';
import {
  bindTexture,
  discardTargets,
  LazyProgram,
  type PassContext,
  UNIT_SRC,
  UNIT_STAMP_A,
  UNIT_STAMP_B,
  type WarmTargets,
  warmDraw,
} from './shared';

const STAMP_STEP = 16;

/** The stamp program writing stampA (`a`) or stampB (`b`): the same code, one output. */
function stampFs(header: string, out: 'a' | 'b'): string {
  const value =
    out === 'a'
      ? 'vec4(emit * body, core, 0.5 + 0.5 * bevel, 1.0)'
      : 'vec4(k0, kx, ky, kd) * (1.0 - body)';
  return `${header}
out vec4 o_stamp;

// d: distance from a body edge in pitch units (>= 0). Tight rim lobe + soft lobe; the window is
// flat across the gap and reaches exactly 0 at half a pitch (what makes the 2x2 quadrant exact).
float haloKernel(float d, float invR2) {
  return (0.6 * exp2(-d * 28.8539) + 0.35 * exp2(-d * invR2)) * (1.0 - smoothstep(0.2, 0.5, d));
}

void main() {
  float pitch = f_grid.z;
  // Pixel center relative to the cell center, device px (y down, like the composite).
  vec2 lc = gl_FragCoord.xy - 0.5 * pitch;
  float hb = (1.0 - P_grid_gap) * 0.5 * pitch;
  float rad = sat(P_grid_roundness) * hb;
  float d0 = sdRoundBox(lc, vec2(hb), rad);
  float aw = P_grid_softness + 0.5;
  float body = 1.0 - smoothstep(-aw, aw, d0);
  float dc = length(lc) / hb;
  float emit = 1.0 - P_grid_emitter * min(dc * dc, 1.0);
  // Pastel only in the core of hot cells: a soft rounded square (L4 norm, no diagonal creases
  // unlike the box SDF) following the body; the rim and the halo stay saturated.
  vec2 q2 = lc / hb;
  q2 *= q2;
  float dq = sqrt(sqrt(dot(q2, q2)));
  float core = 1.0 - smoothstep(0.45 * P_color_hot_core, 1.45 * P_color_hot_core, dq);
  float rim = 1.0 - smoothstep(0.0, 0.3 * hb, -d0);
  float bevel = rim * clamp(-(lc.x + lc.y) / hb, -1.0, 1.0);
  // Halo from the 2x2 quadrant neighbourhood (the quadrant the pixel sits in).
  float invR2 = 1.4427 / max(P_glow_halo_radius, 0.01);
  float ip = 1.0 / pitch;
  vec2 o = vec2(lc.x < 0.0 ? -pitch : pitch, lc.y < 0.0 ? -pitch : pitch);
  float k0 = haloKernel(max(d0, 0.0) * ip, invR2);
  float kx = haloKernel(max(sdRoundBox(lc - vec2(o.x, 0.0), vec2(hb), rad), 0.0) * ip, invR2);
  float ky = haloKernel(max(sdRoundBox(lc - vec2(0.0, o.y), vec2(hb), rad), 0.0) * ip, invR2);
  float kd = haloKernel(max(sdRoundBox(lc - o, vec2(hb), rad), 0.0) * ip, invR2);
  o_stamp = ${value};
}
`;
}

/** A slot's baked stamp: the texture pair, its bucketed allocation and what it was baked for. */
export class StampTarget {
  texA: WebGLTexture | null = null;
  texB: WebGLTexture | null = null;
  fbA: WebGLFramebuffer | null = null;
  fbB: WebGLFramebuffer | null = null;
  alloc = 0;
  /** Pitch the stamp was baked for (0 = nothing baked yet). */
  pitch = 0;
  /** Set when the slot's params block changed: the next bake re-renders it. */
  dirty = true;

  readonly #gl: WebGL2RenderingContext;
  readonly #format: TextureFormat;

  constructor(gl: WebGL2RenderingContext, format: TextureFormat) {
    this.#gl = gl;
    this.#format = format;
  }

  /**
   * (Re)allocates the pair at `size` and binds it to its texture units: only ever called while
   * the owning slot is the one bound on the device.
   */
  allocate(size: number): void {
    const gl = this.#gl;
    this.free();
    // New textures bind to the active unit: use the scratch one, then bind them to their own.
    gl.activeTexture(gl.TEXTURE0 + UNIT_SRC);
    this.texA = createTargetTexture(gl, size, size, { format: this.#format });
    this.texB = createTargetTexture(gl, size, size, { format: this.#format });
    this.fbA = createMrtFramebuffer(gl, [this.texA]);
    this.fbB = createMrtFramebuffer(gl, [this.texB]);
    bindTexture(gl, UNIT_SRC, null);
    bindTexture(gl, UNIT_STAMP_A, this.texA);
    bindTexture(gl, UNIT_STAMP_B, this.texB);
    this.alloc = size;
  }

  free(): void {
    const gl = this.#gl;
    gl.deleteFramebuffer(this.fbA);
    gl.deleteFramebuffer(this.fbB);
    gl.deleteTexture(this.texA);
    gl.deleteTexture(this.texB);
    this.fbA = null;
    this.fbB = null;
    this.texA = null;
    this.texB = null;
    this.alloc = 0;
    this.pitch = 0;
  }
}

export class StampPass {
  readonly #progA: LazyProgram;
  readonly #progB: LazyProgram;

  readonly #ctx: PassContext;

  constructor(ctx: PassContext) {
    this.#ctx = ctx;
    const vs = FULLSCREEN_VS;
    this.#progA = new LazyProgram(ctx, vs, stampFs(ctx.header, 'a'), 'cell-stamp-a', () => {});
    this.#progB = new LazyProgram(ctx, vs, stampFs(ctx.header, 'b'), 'cell-stamp-b', () => {});
  }

  poll(): boolean {
    const a = this.#progA.poll();
    return this.#progB.poll() && a;
  }

  /** The warm-up draws (see GpuDevice), into a scratch target of the real format. */
  warm(targets: WarmTargets): void {
    const fb = targets.framebuffer([this.#ctx.caps.hdrFormat]);
    warmDraw(this.#ctx, this.#progA, fb);
    warmDraw(this.#ctx, this.#progB, fb);
  }

  /** Whether update() would (re)allocate `t` (a synchronous framebuffer check). */
  needsAllocation(t: StampTarget, pitch: number): boolean {
    return !t.fbA || needsRealloc(t.alloc, Math.max(1, Math.round(pitch)), STAMP_STEP);
  }

  /**
   * Bakes `t` for `pitch` (device px) when the pitch changed or `t.dirty` is set. Reads the
   * params block bound on the device, so the owning slot must be the bound one.
   */
  update(t: StampTarget, pitch: number): void {
    const p = Math.max(1, Math.round(pitch));
    if (!t.dirty && p === t.pitch && t.fbA) return;
    if (!t.fbA || needsRealloc(t.alloc, p, STAMP_STEP)) t.allocate(bucketSize(p, STAMP_STEP));
    this.#bake(this.#progA, t.fbA as WebGLFramebuffer, p);
    this.#bake(this.#progB, t.fbB as WebGLFramebuffer, p);
    t.pitch = p;
    t.dirty = false;
  }

  #bake(prog: LazyProgram, fb: WebGLFramebuffer, p: number): void {
    const gl = this.#ctx.gl;
    prog.use();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    discardTargets(this.#ctx);
    gl.viewport(0, 0, p, p);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose(): void {
    this.#progA.dispose();
    this.#progB.dispose();
  }
}
