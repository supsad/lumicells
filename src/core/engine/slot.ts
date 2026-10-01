/**
 * RenderSlot: one instance's GPU state on a GpuDevice, and the frame it draws from FrameInputs.
 *
 * A slot owns everything that differs between instances: the cell targets (with their headroom
 * buckets), the life ping-pong, the glow targets, the params and frame uniform buffers, the
 * palette LUT, the baked cell stamp and the lift instance buffer, plus what it last uploaded into
 * them. The device's programs read these through fixed texture units and uniform block bindings;
 * draw() binds the slot's own ones first whenever another slot was bound since, so slots sharing
 * a device never see each other's state (and a lone slot binds them once).
 *
 * The composite and lift passes draw into the region a Surface assigns (surface.ts).
 */

import { createTexture } from '../gl/target';
import type { DevicePasses, GpuDevice } from './device';
import { FRAME_BYTES, frameUploadRanges, OFF_GRID } from './frame-block';
import type { GpuTimer } from './gpu-timer';
import { LIFE_MODE_REMAP, LIFE_MODE_RESET, LIFE_MODE_STEP } from './passes/life';
import { createLiftBuffer } from './passes/lift';
import {
  BIND_FRAME,
  BIND_PARAMS,
  bindTexture,
  UNIT_FIELD_A,
  UNIT_FIELD_B,
  UNIT_GLOW,
  UNIT_HAZE,
  UNIT_LUT,
  UNIT_SRC,
  UNIT_STAMP_A,
  UNIT_STAMP_B,
} from './passes/shared';
import { StampTarget } from './passes/stamp';
import { coversFramebuffer, createRegion, scissorRegion } from './region';
import { CellTargets, paramsFloatCount } from './resources';
import { createSurfaceFrame, type Surface } from './surface';
import { type FrameInputs, MAX_LIFE_STEPS, type RenderQuality } from './types';

const LUT_WIDTH = 256;
const LUT_ROWS = 2;
const LUT_BYTES = LUT_WIDTH * LUT_ROWS * 4;

const QUALITY_INDEX: Record<RenderQuality, number> = { high: 0, medium: 1, low: 2 };

export interface RenderSlotOptions {
  /** GLSL from createParamLayout(); must be the device's prelude (see GpuDevice.createSlot). */
  paramsPrelude: string;
  /** Number of vec4 in the ParamsBlock (layout.floatCount / 4). */
  paramsVec4Count: number;
}

export class RenderSlot {
  readonly device: GpuDevice;
  private readonly gl: WebGL2RenderingContext;
  private readonly res: CellTargets;
  private readonly stamp: StampTarget;
  private paramsUbo: WebGLBuffer | null = null;
  private frameUbo: WebGLBuffer | null = null;
  private lutTex: WebGLTexture | null = null;
  private liftBuffer: WebGLBuffer | null = null;
  private readonly paramsFloats: number;
  /** FrameBlock upload ranges ([start, end) float pairs), reused every frame. */
  private readonly ranges = new Int32Array(6);
  /** Filled by the surface every frame. */
  private readonly target = createSurfaceFrame();
  private readonly scissor = createRegion();
  private paramsUploaded = false;
  private lutUploaded = false;
  /** Automaton runs so far (mixed into every run's seed, see lifeRunSeed). */
  private lifeRuns = 0;
  private disposed = false;

  /** Use GpuDevice.createSlot(), which checks the params prelude. */
  constructor(device: GpuDevice, opts: RenderSlotOptions) {
    this.device = device;
    const gl = device.gl;
    this.gl = gl;
    this.paramsFloats = paramsFloatCount(device.declaredParamVec4, opts.paramsVec4Count);
    this.res = new CellTargets(gl, device.caps);
    this.stamp = new StampTarget(gl, device.caps.hdrFormat);
    try {
      this.paramsUbo = gl.createBuffer();
      this.frameUbo = gl.createBuffer();
      if (!this.paramsUbo || !this.frameUbo) {
        throw new Error('[lumicells] cannot create uniform buffers');
      }
      // Generic binding points only: the indexed ones belong to the bound slot (see bind()).
      gl.bindBuffer(gl.UNIFORM_BUFFER, this.paramsUbo);
      gl.bufferData(gl.UNIFORM_BUFFER, this.paramsFloats * 4, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.UNIFORM_BUFFER, this.frameUbo);
      gl.bufferData(gl.UNIFORM_BUFFER, FRAME_BYTES, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.UNIFORM_BUFFER, null);
      // A new texture binds to the active unit: the scratch one, never a unit another slot uses.
      gl.activeTexture(gl.TEXTURE0 + UNIT_SRC);
      // sRGB texture: hardware decodes to linear and filters in linear light.
      this.lutTex = createTexture(gl, LUT_WIDTH, LUT_ROWS, {
        filter: gl.LINEAR,
        format: { internalFormat: gl.SRGB8_ALPHA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE },
      });
      gl.bindTexture(gl.TEXTURE_2D, null);
      this.liftBuffer = createLiftBuffer(gl);
    } catch (err) {
      this.dispose();
      throw err;
    }
    // Whatever was bound may have been disturbed: the next slot to draw binds its own.
    device.boundSlot = null;
  }

  /** Binds this slot's uniform buffers and textures to the device's fixed bindings. */
  private bind(): void {
    const d = this.device;
    if (d.boundSlot === this) return;
    d.boundSlot = this;
    const gl = this.gl;
    gl.bindBufferBase(gl.UNIFORM_BUFFER, BIND_PARAMS, this.paramsUbo);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, BIND_FRAME, this.frameUbo);
    bindTexture(gl, UNIT_LUT, this.lutTex);
    this.bindCellTargets();
    bindTexture(gl, UNIT_STAMP_A, this.stamp.texA);
    bindTexture(gl, UNIT_STAMP_B, this.stamp.texB);
  }

  private bindCellTargets(): void {
    const gl = this.gl;
    const res = this.res;
    bindTexture(gl, UNIT_FIELD_A, res.fieldA);
    bindTexture(gl, UNIT_FIELD_B, res.fieldB);
    bindTexture(gl, UNIT_GLOW, res.glow?.tex ?? null);
    bindTexture(gl, UNIT_HAZE, res.haze?.tex ?? null);
  }

  /**
   * Draws one frame into `surface`. The device must be linked (GpuDevice.poll()) and alive; GL
   * failures throw. Returns false when the surface has no visible region for the frame, and on
   * a lost context (nothing reaches the GPU, so the caller must not commit the frame).
   * `timer`, when given, measures the GPU time of the passes (not of the uploads).
   */
  draw(f: FrameInputs, surface: Surface, timer: GpuTimer | null = null): boolean {
    const p = this.device.passes;
    if (this.disposed || !p || this.device.isContextLost()) return false;
    const target = this.target;
    if (!surface.begin(f.canvasWidth, f.canvasHeight, target)) return false;
    const gl = this.gl;
    const res = this.res;
    this.bind();

    // Cell textures: the visible grid plus the pad on every side.
    const W = Math.max(1, f.cols + 2 * f.pad);
    const H = Math.max(1, f.rows + 2 * f.pad);
    // New textures bind to the active unit while they are created: make that the scratch unit.
    gl.activeTexture(gl.TEXTURE0 + UNIT_SRC);
    const change = res.ensure(W, H);
    if (change !== 0) this.bindCellTargets();
    p.bloom.setSizes(W, H, res.aw, res.ah, res.qw, res.qh, res.aqw, res.aqh);

    this.upload(f);
    timer?.begin();

    // Life: keep the automaton across grid changes (center-aligned remap), then step/reset.
    const life0 = res.life[0];
    const life1 = res.life[1];
    if (!life0 || !life1) throw new Error('[lumicells] life targets missing');
    if (change === 2) {
      this.lifeRuns = (this.lifeRuns + 1) >>> 0;
      if (res.orphanLife && res.prevW > 0) {
        p.life.run(
          LIFE_MODE_REMAP,
          res.orphanLife.tex,
          life0.fb,
          W,
          H,
          res.prevW,
          res.prevH,
          f,
          this.lifeRuns,
        );
      } else {
        p.life.run(LIFE_MODE_RESET, life1.tex, life0.fb, W, H, W, H, f, this.lifeRuns);
      }
      res.lifeCur = 0;
      res.releaseOrphanLife();
    } else if (change === 1) {
      this.lifeRun(p, LIFE_MODE_REMAP, f);
    }
    if (f.lifeReset) this.lifeRun(p, LIFE_MODE_RESET, f);
    else {
      // Each step gets its own seed (the run counter is mixed in), so fresh births every step.
      const steps = Math.min(Math.max(f.lifeSteps | 0, 0), MAX_LIFE_STEPS);
      for (let i = 0; i < steps; i++) this.lifeRun(p, LIFE_MODE_STEP, f);
    }

    const lifeCur = res.life[res.lifeCur];
    const { fieldFb, bloom, bloomTmp, haze, hazeTmp, glow } = res;
    if (!fieldFb || !lifeCur || !bloom || !bloomTmp || !haze || !hazeTmp || !glow) {
      throw new Error('[lumicells] cell targets missing');
    }
    p.field.run(fieldFb, W, H, lifeCur.tex);
    // The glow passes run only when the composite shows their result: not with both strengths
    // at 0, and not in the field / halo / cells debug views. `f.lite`: the lite pipeline (2 glow
    // passes instead of 5, see BloomPass), chosen by the slot's owner.
    const dbg = f.debugView | 0;
    const glowOn =
      (dbg === 0 || dbg === 3 || dbg === 4) && (f.bloomStrength !== 0 || f.hazeStrength !== 0);
    if (glowOn) {
      p.bloom.setSigmas(f.bloomSigma, f.hazeSigma);
      p.bloom.run(W, H, res.qw, res.qh, bloom, bloomTmp, haze, hazeTmp, glow, dbg, f.lite === true);
    }
    p.stamp.update(this.stamp, f.frame[OFF_GRID + 2] ?? f.pitchPx);

    // Full resolution: composite and lifts inside the surface's region (scissored when the
    // region is only part of its framebuffer; the own canvas needs no scissor).
    const region = target.region;
    const clip = !coversFramebuffer(region, target.fbWidth, target.fbHeight);
    if (clip) {
      const s = this.scissor;
      scissorRegion(region, target.fbWidth, target.fbHeight, s);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(s.x, s.y, s.width, s.height);
    }
    p.composite.run(
      surface.framebuffer,
      region,
      W,
      H,
      res.aw,
      res.ah,
      QUALITY_INDEX[f.quality] ?? 0,
      dbg,
      f.opaque,
      glowOn,
    );
    if (f.liftCount > 0 && dbg === 0 && this.liftBuffer) {
      p.lift.run(this.liftBuffer, f.lifts, f.liftCount, region, W, H, res.aw, res.ah, f.opaque);
    }
    if (clip) gl.disable(gl.SCISSOR_TEST);
    timer?.end();
    return true;
  }

  private lifeRun(p: DevicePasses, mode: number, f: FrameInputs): void {
    const res = this.res;
    const src = res.life[res.lifeCur];
    const dst = res.life[1 - res.lifeCur];
    if (!src || !dst) return;
    this.lifeRuns = (this.lifeRuns + 1) >>> 0;
    p.life.run(
      mode,
      src.tex,
      dst.fb,
      res.w,
      res.h,
      res.prevW || res.w,
      res.prevH || res.h,
      f,
      this.lifeRuns,
    );
    res.lifeCur = 1 - res.lifeCur;
  }

  private upload(f: FrameInputs): void {
    const gl = this.gl;
    if ((f.paramsDirty || !this.paramsUploaded) && this.paramsUbo) {
      gl.bindBuffer(gl.UNIFORM_BUFFER, this.paramsUbo);
      gl.bufferSubData(
        gl.UNIFORM_BUFFER,
        0,
        f.params,
        0,
        Math.min(f.params.length, this.paramsFloats),
      );
      this.paramsUploaded = true;
      // The cell stamp bakes grid / glow params: re-bake it with the new values.
      this.stamp.dirty = true;
    }
    if (this.frameUbo) {
      // Only the header and the records the shaders read this frame (up to three ranges).
      const fr = f.frame;
      const r = this.ranges;
      const n = frameUploadRanges(fr, r);
      gl.bindBuffer(gl.UNIFORM_BUFFER, this.frameUbo);
      for (let i = 0; i < n; i++) {
        const start = r[i * 2] as number;
        const end = Math.min(fr.length, r[i * 2 + 1] as number);
        if (end > start) gl.bufferSubData(gl.UNIFORM_BUFFER, start * 4, fr, start, end - start);
      }
    }
    gl.bindBuffer(gl.UNIFORM_BUFFER, null);
    if ((f.lutDirty || !this.lutUploaded) && this.lutTex && f.lut.length >= LUT_BYTES) {
      gl.activeTexture(gl.TEXTURE0 + UNIT_LUT);
      gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        LUT_WIDTH,
        LUT_ROWS,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        f.lut,
      );
      this.lutUploaded = true;
    }
  }

  /**
   * Reads back the last field pass (tests and debugging only; stalls the GPU).
   * a: fieldA decoded (rgb color, intensity) as floats; b: fieldB bytes. Row 0 = texel row 0.
   */
  readField(): { w: number; h: number; a: Float32Array; b: Uint8Array } | null {
    const gl = this.gl;
    const res = this.res;
    if (this.disposed || !res.fieldFb || this.device.isContextLost()) return null;
    const { w, h } = res;
    const a = new Float32Array(w * h * 4);
    const b = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, res.fieldFb);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    if (this.device.caps.hdr) {
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, a);
    } else {
      const raw = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
      for (let i = 0; i < raw.length; i++) {
        const v = (raw[i] ?? 0) / 255;
        a[i] = v * v * 4;
      }
    }
    gl.readBuffer(gl.COLOR_ATTACHMENT1);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    return { w, h, a, b };
  }

  /** Frees the slot's GL objects (skipped on a lost context, where they are already gone). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const d = this.device;
    d.releaseSlot(this, this.liftBuffer);
    if (!d.isContextLost()) {
      const gl = this.gl;
      try {
        this.res.dispose();
        this.stamp.free();
        gl.deleteBuffer(this.paramsUbo);
        gl.deleteBuffer(this.frameUbo);
        gl.deleteBuffer(this.liftBuffer);
        gl.deleteTexture(this.lutTex);
      } catch (err) {
        console.warn('[lumicells] render slot dispose failed', err);
      }
    }
    this.paramsUbo = null;
    this.frameUbo = null;
    this.liftBuffer = null;
    this.lutTex = null;
  }
}
