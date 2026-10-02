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
 * parameter layout. The field program comes in variants (field-variants.ts), compiled when a
 * slot first needs one (requestField).
 *
 * Start-up (see warmup.ts): the programs are submitted at once, on the first field request (the
 * field variant first), and link in the background (KHR_parallel_shader_compile; while another
 * device of the page compiles the same programs, this one waits for them to link and then gets
 * them from the browser's program cache). Once linked, each program is drawn once into 1x1
 * scratch targets of its real layout (the warm-up), and a fence follows. poll() reports the
 * device linked only when that fence has passed: whatever a driver compiles on a program's first
 * draw (ANGLE on Direct3D 11 compiles MRT pixel shaders then, which is why the costly programs
 * have a single output there: see passes/field.ts) is done before the first frame, without the
 * page waiting on it. While any warm-up of the page runs, the device makes no synchronous GL
 * call.
 */

import { type GLCaps, probeCaps, type TextureFormat } from '../gl/caps';
import { ShaderError } from '../gl/program';
import { createMrtFramebuffer, createTargetTexture } from '../gl/target';
import { type FeatureSource, parseFeatureSource } from './field-variants';
import { FRAME_BYTES } from './frame-block';
import { missingParamMacros } from './glsl/params';
import { GpuTimer } from './gpu-timer';
import { BloomPass } from './passes/bloom';
import { CompositePass } from './passes/composite';
import { FieldPass, type FieldProgram } from './passes/field';
import { LifePass } from './passes/life';
import { createLiftBuffer, LiftPass } from './passes/lift';
import {
  BIND_FRAME,
  BIND_PARAMS,
  bindTexture,
  buildHeader,
  type LazyProgram,
  type PassContext,
  UNIT_SRC,
  type WarmTargets,
} from './passes/shared';
import { StampPass } from './passes/stamp';
import { declaredParamVec4 } from './resources';
import { RenderSlot, type RenderSlotOptions } from './slot';
import { EngineError, type EngineErrorCode } from './types';
import {
  CACHED_LINK_MS,
  claimCompile,
  forgetWarmups,
  gpuBusy,
  releaseCompile,
  trackWarmup,
} from './warmup';

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

const NO_PROGRAMS: readonly LazyProgram[] = [];

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
  /** Where the params block keeps what the field variants depend on (see field-variants.ts). */
  readonly features: FeatureSource;
  /** Polls so far: the frame counter of field-variant recency. */
  frameCount = 0;
  readonly #slots = new Set<RenderSlot>();
  #programs: DevicePasses | null = null;
  #gpuTimer: GpuTimer | null = null;
  readonly #onError: ((error: EngineError) => void) | undefined;
  /** Every program but the field variants is linked (their warm-up issued). */
  #baseLinked = false;
  /** Every program created on the device (see PassContext.programs). */
  readonly #created: LazyProgram[] = [];
  /** When the programs were submitted, ms. */
  #submittedAt = 0;
  /**
   * Whether every program submitted at start-up was linked CACHED_LINK_MS later (from the
   * browser's program cache: no warm-up needed), as checked then by a timer; null before.
   */
  #cacheHit: boolean | null = null;
  #cacheTimer: ReturnType<typeof setTimeout> | undefined;
  /** ...and warmed up (or from the program cache): the device can draw. */
  #linked = false;
  /** Field variants asked for before the programs were submitted (see startPasses). */
  readonly #requested: number[] = [];
  /** Field programs linked and not warmed up yet (reused). */
  readonly #linkedNow: FieldProgram[] = [];
  /** Their programs, for fromCache (reused). */
  readonly #linkedProgs: LazyProgram[] = [];
  /** Scratch objects of the warm-up draws (created on the first one). */
  #warmFbs: Map<string, WebGLFramebuffer> | null = null;
  #warmTextures: WebGLTexture[] = [];
  #warmBuffers: WebGLBuffer[] = [];
  #failure: EngineError | null = null;
  #disposed = false;
  /** Set once the context has been lost: every GL object of this device is dead for good. */
  #wasLost = false;
  /**
   * A lost context ends this device's compile at once: devices waiting for it (claimCompile)
   * must not wait for a poll that never comes (nothing polls a lost device). Both calls skip GL
   * calls on a lost context.
   */
  readonly #onContextLost = () => {
    this.#wasLost = true;
    forgetWarmups(this.gl);
    releaseCompile(this, false);
  };

  constructor(canvas: HTMLCanvasElement, opts: GpuDeviceOptions) {
    this.canvas = canvas;
    this.#onError = opts.onError;
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
    canvas.addEventListener('webglcontextlost', this.#onContextLost);

    if (opts.warnMissingParams ?? true) {
      const missing = missingParamMacros(opts.paramsPrelude);
      if (missing.length > 0) {
        console.warn(
          `[lumicells] params prelude lacks ${missing.length} macro(s), using defaults: ${missing.join(', ')}`,
        );
      }
    }
    this.features = parseFeatureSource(opts.paramsPrelude);
    this.#header = buildHeader(this.caps.hdr, opts.paramsPrelude, this.caps.d3d);
    // The programs are submitted on the first field request (or poll): see createPasses.
  }

  readonly #header: string;
  /** progress(), for a device that waits for this one's compile (see claimCompile). */
  readonly #step = (): void => this.progress();

  /** CACHED_LINK_MS after submission: were the start-up programs all linked by then? */
  readonly #checkCache = (): void => {
    this.#cacheTimer = undefined;
    if (this.#disposed || this.isContextLost()) return;
    this.#cacheHit = this.#created.every((p) => p.completed());
  };

  /**
   * Whether `progs`, just found linked, came from the browser's program cache (no warm-up
   * needed): found before the cache check, they linked within CACHED_LINK_MS; start-up programs
   * found after it go by its verdict; programs created after it need the verdict and a link
   * that fast of their own.
   */
  #fromCache(progs: readonly LazyProgram[]): boolean {
    const hit = this.#cacheHit;
    if (hit === null) return performance.now() - this.#submittedAt < CACHED_LINK_MS;
    if (!hit) return false;
    for (const p of progs) {
      if (p.submitted > this.#submittedAt + CACHED_LINK_MS && p.linkMs >= CACHED_LINK_MS) {
        return false;
      }
    }
    return true;
  }

  /**
   * Submits the programs unless another device of the page compiles the same ones (then they
   * come from the program cache once it is done: see warmup.ts). True once submitted.
   */
  #startPasses(): boolean {
    if (this.#programs) return true;
    if (!claimCompile(this, this.#header, this.#step)) return false;
    try {
      this.#createPasses();
    } catch (err) {
      this.#fail(err, 'resource');
      return false;
    }
    return true;
  }

  #createPasses(): void {
    const gl = this.gl;
    const ctx: PassContext = {
      gl,
      caps: this.caps,
      header: this.#header,
      mrtPad: this.caps.d3d,
      programs: this.#created,
    };
    // Compiles are submitted here and link in the background (KHR_parallel_shader_compile), on a
    // few worker threads: the field variants asked for so far go first, being the costliest. The
    // field program is compiled per variant (requestField).
    this.#submittedAt = performance.now();
    if (typeof setTimeout === 'function') {
      this.#cacheTimer = setTimeout(this.#checkCache, CACHED_LINK_MS);
    }
    const field = new FieldPass(ctx);
    for (const mask of this.#requested) field.request(mask, this.frameCount - 1);
    this.#requested.length = 0;
    this.#programs = {
      life: new LifePass(ctx),
      field,
      bloom: new BloomPass(ctx),
      composite: new CompositePass(ctx),
      lift: new LiftPass(ctx),
      stamp: new StampPass(ctx),
    };
    if (this.caps.timerQuery) this.#gpuTimer = new GpuTimer(gl, this.caps.timerQuery);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.disable(gl.DITHER);
    gl.disable(gl.SCISSOR_TEST);
  }

  /** The shared programs: null on a context lost at creation and after dispose(). */
  get passes(): DevicePasses | null {
    return this.#programs;
  }

  /** GPU frame timer (EXT_disjoint_timer_query_webgl2), null when unsupported. */
  get timer(): GpuTimer | null {
    return this.#gpuTimer;
  }

  /**
   * Every program linked and warmed up (field variants aside: see RenderSlot.draw). It stays
   * true after a context loss: check isContextLost too.
   */
  get isLinked(): boolean {
    return this.#linked;
  }

  /**
   * Asks for a field variant covering `wanted` (a feature mask, see field-variants.ts): compiled
   * in the background unless one (ready or compiling) covers it already.
   */
  requestField(wanted: number): void {
    if (this.#disposed || this.#failure) return;
    const p = this.#programs;
    if (p) {
      p.field.request(wanted, this.frameCount - 1);
      return;
    }
    if (!this.#requested.includes(wanted)) this.#requested.push(wanted);
    // The first request submits every program, this variant first (submitting makes no
    // synchronous call, so it may happen during another device's warm-up).
    if (!this.isContextLost()) this.#startPasses();
  }

  /** The failure that stopped the device (compile/link or program creation), if any. */
  get error(): EngineError | null {
    return this.#failure;
  }

  /** Live slots on this device. */
  get slotCount(): number {
    return this.#slots.size;
  }

  /**
   * True once the context was lost, even after the browser restored it: the device's objects
   * belong to the dead context, so recovery is dispose() + a new device (and new slots).
   */
  isContextLost(): boolean {
    return this.#wasLost || this.gl.isContextLost();
  }

  /** Simulates a context loss (WEBGL_lose_context), for testing the recovery path. */
  loseContextForTesting(): void {
    if (!this.gl.isContextLost()) this.caps.loseContext?.loseContext();
  }

  restoreContextForTesting(): void {
    if (this.gl.isContextLost()) this.caps.loseContext?.restoreContext();
  }

  /**
   * Polls the background compile and the warm-ups (once per frame: it also counts frames). True
   * once every program is linked and warmed up; false while they are still compiling, after a
   * failure (reported through onError), on a lost context (for good, even once linked) and
   * after dispose(). Field variants progress here too (see requestField).
   */
  poll(): boolean {
    if (this.#disposed || this.#failure) return false;
    if (this.isContextLost()) {
      forgetWarmups(this.gl);
      releaseCompile(this, false);
      return false;
    }
    this.frameCount++;
    this.progress();
    return this.#linked && !this.#failure;
  }

  /**
   * One step of the background work: finished warm-ups, programs that linked (set up, then
   * warmed), field variants likewise. Non-blocking, and a no-op while any warm-up of the page
   * runs (program set-up makes synchronous calls). poll() runs it once per frame; a slot that
   * has no field variant to draw with yet runs it again (a variant may have linked since).
   */
  progress(): void {
    if (this.#disposed || this.#failure) return;
    if (this.isContextLost()) {
      // Lost before its event was dispatched (a waiting device calls this through its claim):
      // the claim must not hold that device back.
      forgetWarmups(this.gl);
      releaseCompile(this, false);
      return;
    }
    // gpuBusy() also settles the warm-ups the GPU is past (this device's among them).
    if (gpuBusy() || !this.#startPasses()) return;
    const p = this.#programs;
    if (!p) return;
    try {
      if (!this.#baseLinked) {
        let ok = p.life.poll();
        ok = p.bloom.poll() && ok;
        ok = p.composite.poll() && ok;
        ok = p.lift.poll() && ok;
        ok = p.stamp.poll() && ok;
        if (ok) {
          this.#baseLinked = true;
          p.bloom.invalidate();
          // From the program cache (see CACHED_LINK_MS): nothing left to compile on a draw.
          if (this.#fromCache(NO_PROGRAMS)) {
            this.#linked = true;
          } else {
            this.#warm(
              (t) => {
                p.life.warm(t);
                p.bloom.warm(t);
                p.composite.warm(t);
                p.stamp.warm(t);
                p.lift.warm(t, this.#warmBuffer());
              },
              () => {
                this.#linked = true;
              },
            );
          }
        }
      }
      // Field programs wait for the base ones: whether those came from the program cache says
      // whether these did too (the pack links fast either way, its draw-time code is what its
      // warm-up compiles: see passes/field.ts). A later variant also needs to link fast.
      const linked = this.#linkedNow;
      p.field.pollLinks(linked);
      if (this.#baseLinked && linked.length > 0) {
        const progs = this.#linkedProgs;
        for (const fp of linked) progs.push(fp.prog);
        const cached = this.#fromCache(progs);
        progs.length = 0;
        if (cached) {
          for (const fp of linked) fp.warmed = true;
          linked.length = 0;
        } else {
          // A copy for `done`: the reused list is emptied before the fence passes.
          const programs = linked.slice();
          linked.length = 0;
          this.#warm(
            (t) => {
              for (const fp of programs) p.field.warm(fp, t);
            },
            () => {
              for (const fp of programs) fp.warmed = true;
            },
          );
        }
      }
    } catch (err) {
      this.#fail(err, 'compile');
      return;
    }
    // Linked (field variants included): the browser's program cache holds them, another device
    // may link them from there now (their warm-up draws are cheap: see passes/field.ts).
    if (this.#baseLinked && !p.field.linking) releaseCompile(this, true);
  }

  /**
   * Issues warm-up draws (`draw` gets the scratch targets) and a fence behind them; `done` runs
   * once the GPU is past them (at once when fences are unavailable).
   */
  #warm(draw: (targets: WarmTargets) => void, done: () => void): void {
    const gl = this.gl;
    // The programs' uniform blocks must be backed by large enough buffers, or WebGL skips the
    // draw: bind zeroed scratch ones (every slot binds its own again before drawing).
    if (this.#warmBuffers.length === 0) {
      const params = this.#scratchBuffer(Math.max(1, this.declaredParamVec4) * 16);
      const frame = this.#scratchBuffer(FRAME_BYTES);
      this.#warmBuffers.push(params, frame);
    }
    gl.bindBufferBase(gl.UNIFORM_BUFFER, BIND_PARAMS, this.#warmBuffers[0] as WebGLBuffer);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, BIND_FRAME, this.#warmBuffers[1] as WebGLBuffer);
    this.boundSlot = null;
    draw(this.#warmTargets);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!sync) {
      done();
      return;
    }
    gl.flush();
    trackWarmup(gl, sync, done);
  }

  #scratchBuffer(bytes: number): WebGLBuffer {
    const gl = this.gl;
    const b = gl.createBuffer();
    if (!b) throw new Error('[lumicells] cannot create a warm-up buffer');
    gl.bindBuffer(gl.UNIFORM_BUFFER, b);
    gl.bufferData(gl.UNIFORM_BUFFER, bytes, gl.STATIC_DRAW);
    gl.bindBuffer(gl.UNIFORM_BUFFER, null);
    return b;
  }

  /** The lift program's warm-up instance (zeros, see LiftPass.warm). */
  #warmBuffer(): WebGLBuffer {
    const b = createLiftBuffer(this.gl);
    this.#warmBuffers.push(b);
    return b;
  }

  /** 1x1 scratch framebuffers by layout (no completeness check: that call is synchronous). */
  readonly #warmTargets: WarmTargets = {
    framebuffer: (formats: readonly TextureFormat[], first = 0): WebGLFramebuffer => {
      const key = `${first}:${formats.map((f) => f.internalFormat).join(',')}`;
      const fbs = this.#warmFbs ?? new Map<string, WebGLFramebuffer>();
      this.#warmFbs = fbs;
      let fb = fbs.get(key);
      if (fb) return fb;
      const gl = this.gl;
      // New textures bind to the active unit: the scratch one, emptied again right after (a
      // scratch texture left on a unit a program samples would be a feedback loop).
      gl.activeTexture(gl.TEXTURE0 + UNIT_SRC);
      const textures = formats.map((format) => createTargetTexture(gl, 1, 1, { format }));
      bindTexture(gl, UNIT_SRC, null);
      this.#warmTextures.push(...textures);
      fb = createMrtFramebuffer(gl, textures, first, false);
      fbs.set(key, fb);
      return fb;
    },
  };

  /**
   * A new slot with its own resources. `opts.paramsPrelude` must be the device's: the programs
   * are shared, and a slot with another parameter layout would read the wrong uniforms.
   */
  createSlot(opts: RenderSlotOptions): RenderSlot {
    if (this.#disposed) throw new EngineError('resource', '[lumicells] the GPU device is disposed');
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
    this.#slots.add(slot);
    return slot;
  }

  /** Called by RenderSlot.dispose(): forget everything that refers to the slot. */
  releaseSlot(slot: RenderSlot, liftBuffer: WebGLBuffer | null): void {
    this.#slots.delete(slot);
    if (this.boundSlot === slot) this.boundSlot = null;
    if (liftBuffer) this.#programs?.lift.release(liftBuffer);
  }

  #fail(err: unknown, code: EngineErrorCode): void {
    if (this.#failure) return;
    this.#failure = toEngineError(err, code);
    forgetWarmups(this.gl);
    releaseCompile(this, false);
    this.#onError?.(this.#failure);
  }

  /** Disposes the remaining slots, then frees every GL object (skipped on a lost context). */
  dispose(): void {
    if (this.#disposed) return;
    for (const slot of [...this.#slots]) slot.dispose();
    this.#disposed = true;
    if (this.#cacheTimer !== undefined) clearTimeout(this.#cacheTimer);
    this.#cacheTimer = undefined;
    this.canvas.removeEventListener('webglcontextlost', this.#onContextLost);
    forgetWarmups(this.gl);
    releaseCompile(this, false);
    const passes = this.#programs;
    const timer = this.#gpuTimer;
    const fbs = this.#warmFbs;
    this.#programs = null;
    this.#gpuTimer = null;
    this.boundSlot = null;
    this.#warmFbs = null;
    if (this.isContextLost()) return;
    try {
      const gl = this.gl;
      for (const fb of fbs?.values() ?? []) gl.deleteFramebuffer(fb);
      for (const t of this.#warmTextures) gl.deleteTexture(t);
      for (const b of this.#warmBuffers) gl.deleteBuffer(b);
      this.#warmTextures = [];
      this.#warmBuffers = [];
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
