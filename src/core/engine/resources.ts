/**
 * Cell-resolution render targets with headroom buckets.
 *
 * Grid size changes (continuous pitch tweens, window resizes) usually stay inside the current
 * allocation: only the logical size changes, passes set their viewport to it and clamp every
 * sample to it. Textures are reallocated only when a bucket overflows, or when the needed bucket
 * drops below half of the allocation (see needsRealloc: no churn across a bucket boundary).
 */

import type { GLCaps, TextureFormat } from '../gl/caps';
import { bucketSize, createMrtFramebuffer, createTexture, needsRealloc } from '../gl/target';

export interface Target {
  readonly tex: WebGLTexture;
  readonly fb: WebGLFramebuffer;
}

const CELL_STEP = 32;
const QUARTER_STEP = 8;

/** vec4 count the prelude declares for the ParamsBlock (`u_p[N]`), 0 when it declares none. */
export function declaredParamVec4(prelude: string): number {
  const m = /u_p\s*\[\s*(\d+)\s*\]/.exec(prelude);
  return Number(m?.[1] ?? 0);
}

/**
 * Floats a slot's params buffer holds: at least the block the prelude declares (or draws fail)
 * and at least what the producer uploads, never less than one vec4.
 */
export function paramsFloatCount(declaredVec4: number, vec4Count: number): number {
  return Math.max(1, Math.floor(vec4Count) || 0, declaredVec4) * 4;
}

export class CellTargets {
  /** Logical sizes (cells incl. pad; quarter-res haze). */
  w = 0;
  h = 0;
  qw = 0;
  qh = 0;
  /** Allocated sizes. */
  aw = 0;
  ah = 0;
  aqw = 0;
  aqh = 0;
  /** Logical size before the last change (for the life remap). */
  prevW = 0;
  prevH = 0;

  fieldA: WebGLTexture | null = null;
  fieldB: WebGLTexture | null = null;
  /** fieldA, fieldB and the bloom source (bloom.tex) as one MRT framebuffer. */
  fieldFb: WebGLFramebuffer | null = null;
  bloom: Target | null = null;
  bloomTmp: Target | null = null;
  /** Combined bloom + haze, the composite's only glow input (caps.glowFormat). */
  glow: Target | null = null;
  haze: Target | null = null;
  hazeTmp: Target | null = null;
  /** Life ping-pong; `life[lifeCur]` holds the current state. */
  life: Target[] = [];
  lifeCur = 0;
  /** Previous current-life texture kept alive across a reallocation until remapped. */
  orphanLife: Target | null = null;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly caps: GLCaps,
  ) {}

  private target(
    w: number,
    h: number,
    hdr: boolean,
    filter: GLenum,
    format?: TextureFormat,
  ): Target {
    const gl = this.gl;
    const tex = createTexture(gl, w, h, {
      filter,
      format: format ?? (hdr ? this.caps.hdrFormat : this.caps.rgba8),
    });
    const fb = createMrtFramebuffer(gl, [tex]);
    return { tex, fb };
  }

  private free(t: Target | null): void {
    if (!t) return;
    this.gl.deleteFramebuffer(t.fb);
    this.gl.deleteTexture(t.tex);
  }

  /**
   * Makes the targets fit `w x h` cells. Returns 0 when nothing changed, 1 when only the logical
   * size changed, 2 when textures were reallocated (life state then sits in `orphanLife`).
   */
  ensure(w: number, h: number): 0 | 1 | 2 {
    if (w === this.w && h === this.h && this.fieldFb) return 0;
    const gl = this.gl;
    this.prevW = this.w;
    this.prevH = this.h;
    const qw = Math.ceil(w / 4);
    const qh = Math.ceil(h / 4);
    let result: 1 | 2 = 1;

    if (
      !this.fieldFb ||
      needsRealloc(this.aw, w, CELL_STEP) ||
      needsRealloc(this.ah, h, CELL_STEP)
    ) {
      result = 2;
      const aw = bucketSize(w, CELL_STEP);
      const ah = bucketSize(h, CELL_STEP);
      // Keep the current life state for remapping; free everything else.
      this.free(this.orphanLife);
      this.orphanLife = this.life[this.lifeCur] ?? null;
      this.free(this.life[1 - this.lifeCur] ?? null);
      this.freeCellTargets();
      this.fieldA = createTexture(gl, aw, ah, { format: this.caps.hdrFormat });
      this.fieldB = createTexture(gl, aw, ah, { format: this.caps.rgba8 });
      this.bloom = this.target(aw, ah, true, gl.LINEAR);
      this.fieldFb = createMrtFramebuffer(gl, [this.fieldA, this.fieldB, this.bloom.tex]);
      this.bloomTmp = this.target(aw, ah, true, gl.LINEAR);
      this.glow = this.target(aw, ah, true, gl.LINEAR, this.caps.glowFormat);
      this.life = [this.target(aw, ah, false, gl.NEAREST), this.target(aw, ah, false, gl.NEAREST)];
      this.lifeCur = 0;
      this.aw = aw;
      this.ah = ah;
    }
    if (
      !this.haze ||
      needsRealloc(this.aqw, qw, QUARTER_STEP) ||
      needsRealloc(this.aqh, qh, QUARTER_STEP)
    ) {
      const aqw = bucketSize(qw, QUARTER_STEP);
      const aqh = bucketSize(qh, QUARTER_STEP);
      this.free(this.haze);
      this.free(this.hazeTmp);
      this.haze = this.target(aqw, aqh, true, gl.LINEAR);
      this.hazeTmp = this.target(aqw, aqh, true, gl.LINEAR);
      this.aqw = aqw;
      this.aqh = aqh;
    }
    this.w = w;
    this.h = h;
    this.qw = qw;
    this.qh = qh;
    return result;
  }

  releaseOrphanLife(): void {
    this.free(this.orphanLife);
    this.orphanLife = null;
  }

  private freeCellTargets(): void {
    const gl = this.gl;
    gl.deleteFramebuffer(this.fieldFb);
    gl.deleteTexture(this.fieldA);
    gl.deleteTexture(this.fieldB);
    this.fieldFb = null;
    this.fieldA = null;
    this.fieldB = null;
    this.free(this.bloom);
    this.free(this.bloomTmp);
    this.free(this.glow);
    this.bloom = null;
    this.bloomTmp = null;
    this.glow = null;
  }

  dispose(): void {
    this.freeCellTargets();
    for (const t of this.life) this.free(t);
    this.life = [];
    this.releaseOrphanLife();
    this.free(this.haze);
    this.free(this.hazeTmp);
    this.haze = null;
    this.hazeTmp = null;
    this.w = this.h = this.aw = this.ah = 0;
  }
}
