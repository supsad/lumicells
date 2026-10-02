/**
 * Engine: one canvas with a WebGL2 context of its own that turns FrameInputs into pixels.
 *
 * A thin facade over the engine's three parts: a GpuDevice (the context, its caps and the
 * programs of every pass), one RenderSlot on it (this instance's textures and buffers) and an
 * OwnSurface (the canvas's default framebuffer, sized to every frame: no copies). Several slots
 * can share one device (see device.ts); this class keeps the one-canvas-one-context path that
 * the LumiCells facade uses.
 *
 * It knows nothing about the schema or the DOM beyond its canvas: parameters arrive as an opaque
 * std140 block plus the GLSL prelude that names its slots. Everything is created up front,
 * programs link in the background (KHR_parallel_shader_compile) and `ready` flips once they are
 * usable. Every entry point is a no-op on a lost context; recovery = dispose + new Engine.
 */

import type { GLCaps } from '../gl/caps';
import { ShaderError } from '../gl/program';
import { GpuDevice, toEngineError } from './device';
import type { RenderSlot } from './slot';
import { OwnSurface } from './surface';
import type { EngineError, EngineErrorCode, EngineOptions, FrameInputs } from './types';

export class Engine {
  readonly canvas: HTMLCanvasElement;
  readonly caps: GLCaps;
  /** True when the context only exists without failIfMajorPerformanceCaveat or on a CPU rasterizer. */
  readonly softwareFallback: boolean;
  readonly #opts: EngineOptions;
  readonly #device: GpuDevice;
  readonly #surface: OwnSurface;
  #slot: RenderSlot | null = null;
  #failure: EngineError | null = null;
  #disposed = false;

  constructor(canvas: HTMLCanvasElement, opts: EngineOptions) {
    this.canvas = canvas;
    this.#opts = opts;
    // Throws EngineError('no-webgl2') without a context; program creation failures are
    // reported through onError (synchronously, before the constructor returns).
    const device = new GpuDevice(canvas, {
      opaque: opts.opaque,
      paramsPrelude: opts.paramsPrelude,
      warnMissingParams: opts.warnMissingParams ?? true,
      forceRgba8: opts.forceRgba8 ?? false,
      onError: (err) => this.#fail(err, err.code),
    });
    this.#device = device;
    this.caps = device.caps;
    this.softwareFallback = device.softwareFallback;
    this.#surface = new OwnSurface(device);
    if (device.isContextLost() || this.#failure) return;
    try {
      this.#slot = device.createSlot({
        paramsPrelude: opts.paramsPrelude,
        paramsVec4Count: opts.paramsVec4Count,
      });
    } catch (err) {
      this.#fail(err, 'resource');
    }
  }

  /** Programs linked and the context alive. */
  get ready(): boolean {
    return (
      this.#device.isLinked &&
      !!this.#slot &&
      !this.#failure &&
      !this.#disposed &&
      !this.isContextLost()
    );
  }

  /** The error that stopped the engine (compile/link or resource creation), if any. */
  get error(): Error | null {
    return this.#failure;
  }

  /** Last measured GPU time for a frame (EXT_disjoint_timer_query_webgl2), or null. */
  get gpuTimeMs(): number | null {
    return this.#device.timer?.ms ?? null;
  }

  /**
   * True once the context was lost, even after the browser restored it: this engine's objects
   * belong to the dead context, so recovery is dispose() + a new Engine on the same canvas.
   */
  isContextLost(): boolean {
    return this.#device.isContextLost();
  }

  /** Simulates a context loss (WEBGL_lose_context), for testing the recovery path. */
  loseContextForTesting(): void {
    this.#device.loseContextForTesting();
  }

  restoreContextForTesting(): void {
    this.#device.restoreContextForTesting();
  }

  /**
   * Polls the background compile without drawing: true once the programs are linked (and the
   * engine can draw). render() polls too; this is for callers that must not draw before.
   */
  poll(): boolean {
    if (this.#disposed || this.#failure || !this.#slot || this.isContextLost()) return false;
    return this.#device.poll();
  }

  #fail(err: unknown, code: EngineErrorCode): void {
    if (this.#failure) return;
    const error = toEngineError(err, code);
    this.#failure = error;
    console.error(error);
    if (error.cause instanceof ShaderError && error.cause.source) console.debug(error.cause.source);
    this.#opts.onError?.(error);
  }

  /**
   * Gets everything `f` needs ready (the field variant of its look) without drawing: true once
   * it is (a frame of `f` then draws exactly). For tests that compare pixels.
   */
  prepare(f: FrameInputs): boolean {
    const slot = this.#slot;
    if (this.#disposed || this.#failure || !slot || this.isContextLost()) return false;
    slot.prepare(f);
    return this.#device.poll() && slot.prepare(f);
  }

  /** See RenderSlot.fieldReady (true without a slot: nothing to hold back for). */
  fieldReady(pending: number): boolean {
    const slot = this.#slot;
    return this.#disposed || this.#failure !== null || !slot || slot.fieldReady(pending);
  }

  /**
   * Draws one frame. Returns false when nothing was drawn (not linked yet, context lost,
   * disposed or failed); the caller should keep showing its poster in that case.
   */
  render(f: FrameInputs): boolean {
    const slot = this.#slot;
    if (this.#disposed || this.#failure || !slot) return false;
    const device = this.#device;
    if (device.isContextLost()) return false;
    // The field variant this frame needs compiles alongside the other programs.
    slot.prepare(f);
    if (!device.poll()) return false;
    try {
      return slot.draw(f, this.#surface, device.timer);
    } catch (err) {
      if (device.isContextLost()) return false;
      this.#fail(err, 'resource');
      return false;
    }
  }

  /**
   * Reads back the last field pass (tests and debugging only; stalls the GPU).
   * a: fieldA decoded (rgb color, intensity) as floats; b: fieldB bytes. Row 0 = texel row 0.
   */
  readFieldForTesting(): { w: number; h: number; a: Float32Array; b: Uint8Array } | null {
    return this.#slot?.readField() ?? null;
  }

  /** Frees every GL object (skipped on a lost context, where they are already gone). */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#slot?.dispose();
    this.#slot = null;
    this.#device.dispose();
  }
}
