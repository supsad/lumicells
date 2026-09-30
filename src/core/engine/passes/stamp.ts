/**
 * Cell stamp: the per-pixel cell shape, baked once per pitch.
 *
 * Every lit pixel of the composite used to evaluate the same shape math: the body SDF and its
 * anti-aliased edge, the emitter falloff, the hot-core mask, the bevel rim and four halo kernels
 * (four SDFs, eight exp2). All of it depends only on the pixel's position inside its cell and on
 * a few grid / glow parameters. The pitch is a whole number of device pixels and the grid origin
 * is pixel-snapped (see controller/geometry.ts), so that position is one of pitch x pitch values:
 * this pass evaluates them once into a pitch x pitch MRT pair and the composite fetches them.
 *
 * Re-baked only when the pitch changes or the params block was uploaded (a pitch^2 draw, at most
 * a few thousand texels). Texel (x, y) holds the pixel at offset (x, y) from the cell's top-left
 * corner, canvas orientation (y down), exactly the composite's in-cell offset.
 *
 * stampA: r = body * emitter falloff, g = hot-core mask, b = bevel term * 0.5 + 0.5, a = 1.
 * stampB: halo kernel weights times (1 - body) for the cell itself (x), its horizontal (y),
 *         vertical (z) and diagonal (w) neighbours in the pixel's quadrant (the composite picks
 *         the same neighbours from the same offset).
 * Both are RGBA16F when float targets render (the values are then exact to ~1e-3), else RGBA8.
 *
 * The program belongs to the device (StampPass); the baked textures depend on the slot's params
 * and pitch, so every slot owns a StampTarget.
 */

import type { TextureFormat } from '../../gl/caps';
import { bucketSize, createMrtFramebuffer, createTexture, needsRealloc } from '../../gl/target';
import { FULLSCREEN_VS } from '../glsl/common';
import {
  bindTexture,
  discardTargets,
  LazyProgram,
  type PassContext,
  UNIT_SRC,
  UNIT_STAMP_A,
  UNIT_STAMP_B,
} from './shared';

const STAMP_STEP = 16;

function stampFs(header: string): string {
  return `${header}
layout(location = 0) out vec4 o_a;
layout(location = 1) out vec4 o_b;

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
  o_a = vec4(emit * body, core, 0.5 + 0.5 * bevel, 1.0);
  o_b = vec4(k0, kx, ky, kd) * (1.0 - body);
}
`;
}

/** A slot's baked stamp: the MRT pair, its bucketed allocation and what it was baked for. */
export class StampTarget {
  texA: WebGLTexture | null = null;
  texB: WebGLTexture | null = null;
  fb: WebGLFramebuffer | null = null;
  alloc = 0;
  /** Pitch the stamp was baked for (0 = nothing baked yet). */
  pitch = 0;
  /** Set when the slot's params block changed: the next bake re-renders it. */
  dirty = true;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly format: TextureFormat,
  ) {}

  /**
   * (Re)allocates the pair at `size` and binds it to its texture units: only ever called while
   * the owning slot is the one bound on the device.
   */
  allocate(size: number): void {
    const gl = this.gl;
    this.free();
    // New textures bind to the active unit: use the scratch one, then bind them to their own.
    gl.activeTexture(gl.TEXTURE0 + UNIT_SRC);
    this.texA = createTexture(gl, size, size, { format: this.format });
    this.texB = createTexture(gl, size, size, { format: this.format });
    this.fb = createMrtFramebuffer(gl, [this.texA, this.texB]);
    bindTexture(gl, UNIT_SRC, null);
    bindTexture(gl, UNIT_STAMP_A, this.texA);
    bindTexture(gl, UNIT_STAMP_B, this.texB);
    this.alloc = size;
  }

  free(): void {
    const gl = this.gl;
    gl.deleteFramebuffer(this.fb);
    gl.deleteTexture(this.texA);
    gl.deleteTexture(this.texB);
    this.fb = null;
    this.texA = null;
    this.texB = null;
    this.alloc = 0;
    this.pitch = 0;
  }
}

export class StampPass {
  private readonly prog: LazyProgram;

  constructor(private readonly ctx: PassContext) {
    this.prog = new LazyProgram(ctx, FULLSCREEN_VS, stampFs(ctx.header), 'cell-stamp', () => {});
  }

  poll(): boolean {
    return this.prog.poll();
  }

  /**
   * Bakes `t` for `pitch` (device px) when the pitch changed or `t.dirty` is set. Reads the
   * params block bound on the device, so the owning slot must be the bound one.
   */
  update(t: StampTarget, pitch: number): void {
    const p = Math.max(1, Math.round(pitch));
    if (!t.dirty && p === t.pitch && t.fb) return;
    const gl = this.ctx.gl;
    if (!t.fb || needsRealloc(t.alloc, p, STAMP_STEP)) t.allocate(bucketSize(p, STAMP_STEP));
    this.prog.use();
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    discardTargets(this.ctx, 2);
    gl.viewport(0, 0, p, p);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    t.pitch = p;
    t.dirty = false;
  }

  dispose(): void {
    this.prog.dispose();
  }
}
