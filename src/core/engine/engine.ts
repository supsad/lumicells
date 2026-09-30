/**
 * Engine: owns the WebGL2 context state for one canvas and turns FrameInputs into pixels.
 *
 * It knows nothing about the schema or the DOM beyond its canvas: parameters arrive as an opaque
 * std140 block plus the GLSL prelude that names its slots. Everything is created up front,
 * programs link in the background (KHR_parallel_shader_compile) and `ready` flips once they are
 * usable. Every entry point is a no-op on a lost context; recovery = dispose + new Engine.
 */

import { type GLCaps, probeCaps } from '../gl/caps';
import { ShaderError } from '../gl/program';
import { createTexture } from '../gl/target';
import { FRAME_BYTES, frameUploadRanges, OFF_GRID } from './frame-block';
import { missingParamMacros } from './glsl/params';
import { GpuTimer } from './gpu-timer';
import { BloomPass } from './passes/bloom';
import { CompositePass } from './passes/composite';
import { FieldPass } from './passes/field';
import { LIFE_MODE_REMAP, LIFE_MODE_RESET, LIFE_MODE_STEP, LifePass } from './passes/life';
import { LiftPass } from './passes/lift';
import {
  BIND_FRAME,
  BIND_PARAMS,
  bindTexture,
  buildHeader,
  type PassContext,
  UNIT_FIELD_A,
  UNIT_FIELD_B,
  UNIT_GLOW,
  UNIT_HAZE,
  UNIT_LUT,
  UNIT_SRC,
} from './passes/shared';
import { StampPass } from './passes/stamp';
import { CellTargets } from './resources';
import { EngineError, type EngineOptions, type FrameInputs, type RenderQuality } from './types';

const LUT_WIDTH = 256;
const LUT_ROWS = 2;
const LUT_BYTES = LUT_WIDTH * LUT_ROWS * 4;

const QUALITY_INDEX: Record<RenderQuality, number> = { high: 0, medium: 1, low: 2 };

interface Passes {
  life: LifePass;
  field: FieldPass;
  bloom: BloomPass;
  composite: CompositePass;
  lift: LiftPass;
  stamp: StampPass;
}

export class Engine {
  readonly canvas: HTMLCanvasElement;
  readonly caps: GLCaps;
  /** True when the context only exists without failIfMajorPerformanceCaveat or on a CPU rasterizer. */
  readonly softwareFallback: boolean;
  private readonly gl: WebGL2RenderingContext;
  private readonly opts: EngineOptions;
  private passes: Passes | null = null;
  private res: CellTargets | null = null;
  private paramsUbo: WebGLBuffer | null = null;
  private frameUbo: WebGLBuffer | null = null;
  private lutTex: WebGLTexture | null = null;
  private timer: GpuTimer | null = null;
  private readonly paramsFloats: number;
  /** FrameBlock upload ranges ([start, end) float pairs), reused every frame. */
  private readonly ranges = new Int32Array(6);
  private linked = false;
  private failure: Error | null = null;
  private disposed = false;
  private paramsUploaded = false;
  private lutUploaded = false;
  /** Set once the context has been lost: every GL object of this engine is dead for good. */
  private wasLost = false;
  private readonly onContextLost = () => {
    this.wasLost = true;
  };

  constructor(canvas: HTMLCanvasElement, opts: EngineOptions) {
    this.canvas = canvas;
    this.opts = opts;
    const attrs: WebGLContextAttributes = {
      alpha: !opts.opaque,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'default',
      failIfMajorPerformanceCaveat: true,
    };
    let gl = canvas.getContext('webgl2', attrs);
    let caveat = false;
    if (!gl) {
      gl = canvas.getContext('webgl2', { ...attrs, failIfMajorPerformanceCaveat: false });
      caveat = !!gl;
    }
    if (!gl) throw new EngineError('no-webgl2', '[pixel-life] WebGL2 is not available');
    this.gl = gl;
    this.caps = probeCaps(gl, opts.forceRgba8 ?? false);
    this.softwareFallback = caveat || this.caps.software;
    // The buffer must be at least as large as the block the prelude declares, or draws fail.
    const declared = /u_p\s*\[\s*(\d+)\s*\]/.exec(opts.paramsPrelude);
    const vec4s = Math.max(1, Math.floor(opts.paramsVec4Count) || 0, Number(declared?.[1] ?? 0));
    this.paramsFloats = vec4s * 4;
    canvas.addEventListener('webglcontextlost', this.onContextLost);

    if (opts.warnMissingParams ?? true) {
      const missing = missingParamMacros(opts.paramsPrelude);
      if (missing.length > 0) {
        console.warn(
          `[pixel-life] params prelude lacks ${missing.length} macro(s), using defaults: ${missing.join(', ')}`,
        );
      }
    }
    if (gl.isContextLost()) return;
    try {
      this.createResources();
    } catch (err) {
      this.fail(err, 'resource');
    }
  }

  private createResources(): void {
    const gl = this.gl;
    const ctx: PassContext = {
      gl,
      caps: this.caps,
      header: buildHeader(this.caps.hdr, this.opts.paramsPrelude),
    };
    this.passes = {
      life: new LifePass(ctx),
      field: new FieldPass(ctx),
      bloom: new BloomPass(ctx),
      composite: new CompositePass(ctx),
      lift: new LiftPass(ctx),
      stamp: new StampPass(ctx),
    };
    this.res = new CellTargets(gl, this.caps);

    this.paramsUbo = gl.createBuffer();
    this.frameUbo = gl.createBuffer();
    if (!this.paramsUbo || !this.frameUbo)
      throw new Error('[pixel-life] cannot create uniform buffers');
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.paramsUbo);
    gl.bufferData(gl.UNIFORM_BUFFER, this.paramsFloats * 4, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.frameUbo);
    gl.bufferData(gl.UNIFORM_BUFFER, FRAME_BYTES, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.UNIFORM_BUFFER, null);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, BIND_PARAMS, this.paramsUbo);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, BIND_FRAME, this.frameUbo);

    // sRGB texture: hardware decodes to linear and filters in linear light.
    gl.activeTexture(gl.TEXTURE0 + UNIT_LUT);
    this.lutTex = createTexture(gl, LUT_WIDTH, LUT_ROWS, {
      filter: gl.LINEAR,
      format: { internalFormat: gl.SRGB8_ALPHA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE },
    });

    if (this.caps.timerQuery) this.timer = new GpuTimer(gl, this.caps.timerQuery);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.disable(gl.DITHER);
  }

  /** Programs linked and the context alive. */
  get ready(): boolean {
    return this.linked && !this.failure && !this.disposed && !this.isContextLost();
  }

  /** The error that stopped the engine (compile/link or resource creation), if any. */
  get error(): Error | null {
    return this.failure;
  }

  /** Last measured GPU time for a frame (EXT_disjoint_timer_query_webgl2), or null. */
  get gpuTimeMs(): number | null {
    return this.timer?.ms ?? null;
  }

  /**
   * True once the context was lost, even after the browser restored it: this engine's objects
   * belong to the dead context, so recovery is dispose() + a new Engine on the same canvas.
   */
  isContextLost(): boolean {
    return this.wasLost || this.gl.isContextLost();
  }

  /** Simulates a context loss (WEBGL_lose_context), for testing the recovery path. */
  loseContextForTesting(): void {
    if (!this.gl.isContextLost()) this.caps.loseContext?.loseContext();
  }

  restoreContextForTesting(): void {
    if (this.gl.isContextLost()) this.caps.loseContext?.restoreContext();
  }

  private fail(err: unknown, code: 'compile' | 'resource'): void {
    if (this.failure) return;
    const error =
      err instanceof ShaderError
        ? new EngineError('compile', err.message, { cause: err })
        : err instanceof EngineError
          ? err
          : new EngineError(code, err instanceof Error ? err.message : String(err), { cause: err });
    this.failure = error;
    console.error(error);
    if (error.cause instanceof ShaderError && error.cause.source) console.debug(error.cause.source);
    this.opts.onError?.(error);
  }

  private pollLinked(): boolean {
    const p = this.passes;
    if (!p) return false;
    try {
      let ok = p.life.poll();
      ok = p.field.poll() && ok;
      ok = p.bloom.poll() && ok;
      ok = p.composite.poll() && ok;
      ok = p.lift.poll() && ok;
      ok = p.stamp.poll() && ok;
      if (ok) {
        this.linked = true;
        p.bloom.invalidate();
      }
      return ok;
    } catch (err) {
      this.fail(err, 'compile');
      return false;
    }
  }

  /**
   * Draws one frame. Returns false when nothing was drawn (not linked yet, context lost,
   * disposed or failed); the caller should keep showing its poster in that case.
   */
  render(f: FrameInputs): boolean {
    if (this.disposed || this.failure || !this.passes || !this.res) return false;
    if (this.isContextLost()) return false;
    if (!this.linked && !this.pollLinked()) return false;
    try {
      this.draw(f, this.passes, this.res);
      return true;
    } catch (err) {
      if (this.isContextLost()) return false;
      this.fail(err, 'resource');
      return false;
    }
  }

  private draw(f: FrameInputs, p: Passes, res: CellTargets): void {
    const gl = this.gl;
    const canvas = this.canvas;
    const cw = Math.max(1, Math.floor(f.canvasWidth));
    const ch = Math.max(1, Math.floor(f.canvasHeight));
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
    // The browser may clamp the drawing buffer below the requested size; trust what we got.
    const vw = gl.drawingBufferWidth;
    const vh = gl.drawingBufferHeight;

    const W = Math.max(1, f.cols + 2 * f.pad);
    const H = Math.max(1, f.rows + 2 * f.pad);
    // New textures bind to the active unit while they are created: make that the scratch unit.
    gl.activeTexture(gl.TEXTURE0 + UNIT_SRC);
    const change = res.ensure(W, H);
    if (change !== 0) {
      p.bloom.setSizes(W, H, res.aw, res.ah, res.qw, res.qh, res.aqw, res.aqh);
      bindTexture(gl, UNIT_FIELD_A, res.fieldA);
      bindTexture(gl, UNIT_FIELD_B, res.fieldB);
      bindTexture(gl, UNIT_GLOW, res.glow?.tex ?? null);
      bindTexture(gl, UNIT_HAZE, res.haze?.tex ?? null);
    }

    this.upload(f);
    this.timer?.begin();

    // Life: keep the automaton across grid changes (center-aligned remap), then step/reset.
    const life0 = res.life[0];
    const life1 = res.life[1];
    if (!life0 || !life1) throw new Error('[pixel-life] life targets missing');
    if (change === 2) {
      if (res.orphanLife && res.prevW > 0) {
        p.life.run(LIFE_MODE_REMAP, res.orphanLife.tex, life0.fb, W, H, res.prevW, res.prevH, f);
      } else {
        p.life.run(LIFE_MODE_RESET, life1.tex, life0.fb, W, H, W, H, f);
      }
      res.lifeCur = 0;
      res.releaseOrphanLife();
    } else if (change === 1) {
      this.lifeRun(LIFE_MODE_REMAP, f, res);
    }
    if (f.lifeReset) this.lifeRun(LIFE_MODE_RESET, f, res);
    else {
      // LifePass mixes its run counter into the seed, so each step gets fresh births.
      const steps = Math.min(Math.max(f.lifeSteps | 0, 0), 2);
      for (let i = 0; i < steps; i++) this.lifeRun(LIFE_MODE_STEP, f, res);
    }

    const lifeCur = res.life[res.lifeCur];
    const { fieldFb, bloom, bloomTmp, haze, hazeTmp, glow } = res;
    if (!fieldFb || !lifeCur || !bloom || !bloomTmp || !haze || !hazeTmp || !glow) {
      throw new Error('[pixel-life] cell targets missing');
    }
    p.field.run(fieldFb, W, H, lifeCur.tex);
    // The glow passes run only when the composite shows their result: not with both strengths
    // at 0, and not in the field / halo / cells debug views.
    const dbg = f.debugView | 0;
    const glowOn =
      (dbg === 0 || dbg === 3 || dbg === 4) && (f.bloomStrength !== 0 || f.hazeStrength !== 0);
    if (glowOn) {
      p.bloom.setSigmas(f.bloomSigma, f.hazeSigma);
      p.bloom.run(W, H, res.qw, res.qh, bloom, bloomTmp, haze, hazeTmp, glow, dbg);
    }
    p.stamp.update(f.frame[OFF_GRID + 2] ?? f.pitchPx);
    p.composite.run(
      vw,
      vh,
      W,
      H,
      res.aw,
      res.ah,
      QUALITY_INDEX[f.quality] ?? 0,
      dbg,
      f.opaque,
      glowOn,
    );
    if (f.liftCount > 0 && dbg === 0) {
      p.lift.run(f.lifts, f.liftCount, vw, vh, W, H, res.aw, res.ah, f.opaque);
    }
    this.timer?.end();
  }

  private lifeRun(mode: number, f: FrameInputs, res: CellTargets): void {
    const src = res.life[res.lifeCur];
    const dst = res.life[1 - res.lifeCur];
    if (!src || !dst || !this.passes) return;
    this.passes.life.run(
      mode,
      src.tex,
      dst.fb,
      res.w,
      res.h,
      res.prevW || res.w,
      res.prevH || res.h,
      f,
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
      if (this.passes) this.passes.stamp.dirty = true;
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
  readFieldForTesting(): { w: number; h: number; a: Float32Array; b: Uint8Array } | null {
    const gl = this.gl;
    const res = this.res;
    if (!res?.fieldFb || this.isContextLost()) return null;
    const { w, h } = res;
    const a = new Float32Array(w * h * 4);
    const b = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, res.fieldFb);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    if (this.caps.hdr) {
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

  /** Frees every GL object (skipped on a lost context, where they are already gone). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    const gl = this.gl;
    if (this.isContextLost()) {
      this.passes = null;
      this.res = null;
      this.timer = null;
      return;
    }
    try {
      this.timer?.dispose();
      if (this.passes) {
        this.passes.life.dispose();
        this.passes.field.dispose();
        this.passes.bloom.dispose();
        this.passes.composite.dispose();
        this.passes.lift.dispose();
        this.passes.stamp.dispose();
      }
      this.res?.dispose();
      gl.deleteBuffer(this.paramsUbo);
      gl.deleteBuffer(this.frameUbo);
      gl.deleteTexture(this.lutTex);
    } catch (err) {
      console.warn('[pixel-life] engine dispose failed', err);
    }
    this.passes = null;
    this.res = null;
    this.timer = null;
  }
}
