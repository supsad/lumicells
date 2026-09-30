/**
 * GpuDevice: one WebGL2 context and everything in it that does not belong to a single instance:
 * the capability probe, the programs of every pass (compiled once and shared by all slots), the
 * lift vertex array, the GPU timer, the context-loss state and parallel-compile readiness.
 *
 * Instances render through RenderSlots (slot.ts) created on the device. A slot owns its
 * resources and binds them before its passes, so any number of slots can share one device.
 *
 * The programs are specialised by the params prelude (the ParamsBlock declaration and its P_*
 * macros). The controller builds its ParamLayout once per page (getSharedLayout), so every
 * instance hands the engine the very same prelude and one set of programs serves them all;
 * createSlot() refuses a slot with a different prelude instead of drawing it with the wrong
 * parameter layout.
 */

import { type GLCaps, probeCaps } from '../gl/caps';
import { ShaderError } from '../gl/program';
import { missingParamMacros } from './glsl/params';
import { GpuTimer } from './gpu-timer';
import { BloomPass } from './passes/bloom';
import { CompositePass } from './passes/composite';
import { FieldPass } from './passes/field';
import { LifePass } from './passes/life';
import { LiftPass } from './passes/lift';
import { buildHeader, type PassContext } from './passes/shared';
import { StampPass } from './passes/stamp';
import { declaredParamVec4 } from './resources';
import { RenderSlot, type RenderSlotOptions } from './slot';
import { EngineError, type EngineErrorCode } from './types';

export interface GpuDeviceOptions {
  /** Opaque output (no transparent overflow margin): the context is created with alpha:false. */
  opaque: boolean;
  /** GLSL from createParamLayout(): the programs are built with it, every slot must match it. */
  paramsPrelude: string;
  /**
   * Called once with the first failure: a shader that does not compile/link, or programs that
   * cannot be created. The device reports it only (no logging); slots draw nothing afterwards.
   */
  onError?: (error: EngineError) => void;
  /** Log params the engine expects but the prelude does not define (default true). */
  warnMissingParams?: boolean;
  /** Testing: use the RGBA8 (sqrt-encoded) targets even when float targets are available. */
  forceRgba8?: boolean;
}

/** The programs of every pass (plus the lift vertex array), shared by all slots of a device. */
export interface DevicePasses {
  readonly life: LifePass;
  readonly field: FieldPass;
  readonly bloom: BloomPass;
  readonly composite: CompositePass;
  readonly lift: LiftPass;
  readonly stamp: StampPass;
}

/** An error as the engine reports it (ShaderError -> 'compile', anything else -> `code`). */
export function toEngineError(err: unknown, code: EngineErrorCode): EngineError {
  if (err instanceof EngineError) return err;
  if (err instanceof ShaderError) return new EngineError('compile', err.message, { cause: err });
  return new EngineError(code, err instanceof Error ? err.message : String(err), { cause: err });
}

export class GpuDevice {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  readonly caps: GLCaps;
  /** True when the context only exists without failIfMajorPerformanceCaveat or on a CPU rasterizer. */
  readonly softwareFallback: boolean;
  readonly paramsPrelude: string;
  /** See declaredParamVec4. */
  readonly declaredParamVec4: number;
  /**
   * The slot whose buffers and textures are bound to the context (RenderSlot binds its own
   * before drawing when another one was bound since). Null forces the next slot to bind.
   */
  boundSlot: RenderSlot | null = null;
  private readonly slots = new Set<RenderSlot>();
  private programs: DevicePasses | null = null;
  private gpuTimer: GpuTimer | null = null;
  private readonly onError: ((error: EngineError) => void) | undefined;
  private linked = false;
  private failure: EngineError | null = null;
  private disposed = false;
  /** Set once the context has been lost: every GL object of this device is dead for good. */
  private wasLost = false;
  private readonly onContextLost = () => {
    this.wasLost = true;
  };

  constructor(canvas: HTMLCanvasElement, opts: GpuDeviceOptions) {
    this.canvas = canvas;
    this.onError = opts.onError;
    this.paramsPrelude = opts.paramsPrelude;
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
    if (!gl) throw new EngineError('no-webgl2', '[lumicells] WebGL2 is not available');
    this.gl = gl;
    this.caps = probeCaps(gl, opts.forceRgba8 ?? false);
    this.softwareFallback = caveat || this.caps.software;
    this.declaredParamVec4 = declaredParamVec4(opts.paramsPrelude);
    canvas.addEventListener('webglcontextlost', this.onContextLost);

    if (opts.warnMissingParams ?? true) {
      const missing = missingParamMacros(opts.paramsPrelude);
      if (missing.length > 0) {
        console.warn(
          `[lumicells] params prelude lacks ${missing.length} macro(s), using defaults: ${missing.join(', ')}`,
        );
      }
    }
    if (gl.isContextLost()) return;
    try {
      this.createPasses();
    } catch (err) {
      this.fail(err, 'resource');
    }
  }

  private createPasses(): void {
    const gl = this.gl;
    const ctx: PassContext = {
      gl,
      caps: this.caps,
      header: buildHeader(this.caps.hdr, this.paramsPrelude),
    };
    // Compiles are submitted here and link in the background (KHR_parallel_shader_compile).
    this.programs = {
      life: new LifePass(ctx),
      field: new FieldPass(ctx),
      bloom: new BloomPass(ctx),
      composite: new CompositePass(ctx),
      lift: new LiftPass(ctx),
      stamp: new StampPass(ctx),
    };
    if (this.caps.timerQuery) this.gpuTimer = new GpuTimer(gl, this.caps.timerQuery);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.disable(gl.DITHER);
    gl.disable(gl.SCISSOR_TEST);
  }

  /** The shared programs: null on a context lost at creation and after dispose(). */
  get passes(): DevicePasses | null {
    return this.programs;
  }

  /** GPU frame timer (EXT_disjoint_timer_query_webgl2), null when unsupported. */
  get timer(): GpuTimer | null {
    return this.gpuTimer;
  }

  /** Every program linked (it stays true after a context loss: check isContextLost too). */
  get isLinked(): boolean {
    return this.linked;
  }

  /** The failure that stopped the device (compile/link or program creation), if any. */
  get error(): EngineError | null {
    return this.failure;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Live slots on this device. */
  get slotCount(): number {
    return this.slots.size;
  }

  /**
   * True once the context was lost, even after the browser restored it: the device's objects
   * belong to the dead context, so recovery is dispose() + a new device (and new slots).
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

  /**
   * Polls the background compile. True once every program is linked; false while they are
   * still compiling, after a failure (reported through onError), on a lost context (for good,
   * even once linked) and after dispose().
   */
  poll(): boolean {
    if (this.disposed || this.failure || this.isContextLost()) return false;
    if (this.linked) return true;
    const p = this.programs;
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
   * A new slot with its own resources. `opts.paramsPrelude` must be the device's: the programs
   * are shared, and a slot with another parameter layout would read the wrong uniforms.
   */
  createSlot(opts: RenderSlotOptions): RenderSlot {
    if (this.disposed) throw new EngineError('resource', '[lumicells] the GPU device is disposed');
    if (this.isContextLost()) {
      throw new EngineError('resource', '[lumicells] the GPU device lost its context');
    }
    if (opts.paramsPrelude !== this.paramsPrelude) {
      throw new EngineError(
        'resource',
        '[lumicells] a render slot must use its device params prelude (one ParamLayout per page)',
      );
    }
    const slot = new RenderSlot(this, opts);
    this.slots.add(slot);
    return slot;
  }

  /** Called by RenderSlot.dispose(): forget everything that refers to the slot. */
  releaseSlot(slot: RenderSlot, liftBuffer: WebGLBuffer | null): void {
    this.slots.delete(slot);
    if (this.boundSlot === slot) this.boundSlot = null;
    if (liftBuffer) this.programs?.lift.release(liftBuffer);
  }

  private fail(err: unknown, code: EngineErrorCode): void {
    if (this.failure) return;
    this.failure = toEngineError(err, code);
    this.onError?.(this.failure);
  }

  /** Disposes the remaining slots, then frees every GL object (skipped on a lost context). */
  dispose(): void {
    if (this.disposed) return;
    for (const slot of [...this.slots]) slot.dispose();
    this.disposed = true;
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    const passes = this.programs;
    const timer = this.gpuTimer;
    this.programs = null;
    this.gpuTimer = null;
    this.boundSlot = null;
    if (this.isContextLost()) return;
    try {
      timer?.dispose();
      if (passes) {
        passes.life.dispose();
        passes.field.dispose();
        passes.bloom.dispose();
        passes.composite.dispose();
        passes.lift.dispose();
        passes.stamp.dispose();
      }
    } catch (err) {
      console.warn('[lumicells] GPU device dispose failed', err);
    }
  }
}
