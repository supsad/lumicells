/**
 * PixelLife facade: the only class consumers construct.
 *
 * Wires the pure Controller (config layers, tweens, influences, lifts, adaptive quality) to the
 * DOM (host sizing, element tracking, pointer, visibility) and to the GL Engine, all driven by
 * the shared ticker: DOM reads in the measure phase, GPU work in the render phase.
 *
 * Lifecycle: the engine is created lazily in start() when WebGL2 is available; programs compile
 * in parallel and 'ready' fires after the first drawn frame (a CSS poster covers the gap). A lost
 * context shows the poster and is rebuilt on restore with a new Engine on the same canvas. An
 * engine that fails (compile/link or resource error) is disposed and its context released at
 * once: browsers cap live contexts at ~16, so a failed instance must not hold one.
 * destroy() is synchronous, idempotent and total.
 */

import {
  deepMerge,
  type ParamPath,
  type ParamValue,
  type PixelLifeConfig,
  type PixelLifeConfigFile,
  type PixelLifeConfigInput,
  type PresetId,
  posterCss,
  setPath,
  toConfigFile,
} from '../schema';
import {
  Controller,
  type ControllerInfluenceHandle,
  type ControllerModulator,
} from './controller/controller';
import type { InfluenceInit } from './controller/influences';
import { HostView } from './dom/host';
import { PointerInteraction } from './dom/pointer';
import { ElementTracker } from './dom/tracking';
import { Engine } from './engine/engine';
import { DEBUG_VIEW, EngineError } from './engine/types';
import { subscribeTicker } from './ticker';
import type {
  BindElementOptions,
  ConfigSource,
  ConfigUpdateOptions,
  DebugView,
  InfluenceHandle,
  InfluenceOptions,
  InfluenceUpdate,
  LiftOptions,
  ModulatablePath,
  ModulateOptions,
  ModulationSource,
  ModulatorHandle,
  PixelLifeEvents,
  PixelLifeOptions,
  PulseOptions,
  Stats,
} from './types';

type Listener<K extends keyof PixelLifeEvents> = (event: PixelLifeEvents[K]) => void;

let supportedMemo: boolean | undefined;
let liveInstances = 0;
let manyWarned = false;
/** More live instances than this is almost always a leak (strict-mode double mounts, lists). */
const INSTANCE_WARN = 8;
const COARSE_MAX_PIXELS = 2.4;
const SOFTWARE_MAX_PIXELS = 0.5;
const STATS_INTERVAL = 250;
const RESIZE_THROTTLE = 100;
/** IntersectionObserver margin around the canvas (host + overflow), CSS px. */
const IO_MARGIN = 64;

/** Config changes of one source, coalesced until the next flush (frame or microtask). */
interface ConfigBatch {
  source: ConfigSource;
  paths: Set<ParamPath>;
}

export class PixelLife {
  /** Whether WebGL2 is available. Memoized; always false on the server. */
  static isSupported(): boolean {
    if (supportedMemo !== undefined) return supportedMemo;
    if (typeof document === 'undefined') return false;
    try {
      const probe = document.createElement('canvas');
      const gl = probe.getContext('webgl2');
      supportedMemo = !!gl;
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      supportedMemo = false;
    }
    return supportedMemo;
  }

  readonly host: HTMLElement;
  readonly #controller: Controller;
  readonly #ctl = new AbortController();
  readonly #view: HostView;
  readonly #tracker: ElementTracker;
  readonly #pointer: PointerInteraction;
  #engine: Engine | null = null;
  /** Context alpha attribute of the current canvas (null before the first engine). */
  #engineOpaque: boolean | null = null;
  #hookedCanvas: HTMLCanvasElement | null = null;
  /** Lifetime of the context listeners of #hookedCanvas (aborted when that canvas is dropped). */
  #canvasCtl: AbortController | null = null;
  #io: IntersectionObserver | null = null;
  #ioMargin = -1;
  #destroyed = false;
  #running = false;
  #unsub: (() => void) | null = null;
  #inView = true;
  #hidden = false;
  #lost = false;
  #failed = false;
  #fallbackSent = false;
  #readyEmitted = false;
  #drawnSinceMount = false;
  #listeners = new Map<keyof PixelLifeEvents, Set<Listener<never>>>();
  /** Ordered per-source batches: consecutive calls of one source merge, another starts anew. */
  #pending: ConfigBatch[] = [];
  #flushQueued = false;
  #lastNow = -1;
  #skip = 0;
  #accMs = 0;
  #time = 0;
  #lastCpu = 0;
  #cpuEma = 0;
  #statsAt = 0;
  #statsFrames = 0;
  #renderFps = 0;
  #software = false;
  #coarse = false;
  #restoreTimer: ReturnType<typeof setTimeout> | 0 = 0;
  #energy: ControllerModulator | null = null;
  #reducedMql: MediaQueryList | null = null;
  readonly #origin = [Number.NaN, Number.NaN];
  readonly #frameEvent = { time: 0, dt: 0 };
  readonly #tick = {
    measure: (now: number) => this.#measure(now),
    render: (now: number) => this.#render(now),
  };
  #stats: Stats = {
    fps: 0,
    frameMs: 0,
    cpuMs: 0,
    gpuMs: null,
    vsyncMs: 16.67,
    missRatio: 0,
    scale: 1,
    quality: 'high',
    dpr: 1,
    pixels: 0,
    cols: 0,
    rows: 0,
    lifts: 0,
    influences: 0,
    softwareFallback: false,
  };

  constructor(host: HTMLElement, options: PixelLifeOptions = {}) {
    this.host = host;
    // Merge order: defaults < preset < config (< the `interactive` shortcut).
    const base: PixelLifeConfigInput = options.preset ? { extends: options.preset } : {};
    let input = options.config ? deepMerge(base, options.config) : base;
    if (options.interactive !== undefined) {
      input = deepMerge(input, {
        interaction: { pointer: options.interactive, click: options.interactive },
      });
    }
    this.#controller = new Controller({
      config: input,
      onWarn: (code, message) => this.#emit('warn', { code, message }),
    });
    const signal = this.#ctl.signal;
    this.#view = new HostView(host, signal);
    this.#view.onChange = () => this.#tracker.markAllDirty();
    // Another display may have another refresh rate: re-learn it.
    this.#view.onDprChange = () => this.#controller.perf.resetVsync();
    this.#view.showPoster(posterCss(this.#controller.getConfig()));
    this.#tracker = new ElementTracker(this.#controller.influences, signal);
    this.#pointer = new PointerInteraction(host, this.#controller, signal);
    this.#pointer.configure(this.#controller.getConfig().interaction);
    this.#coarse = this.#view.coarsePointer;
    this.#applyPixelCap();
    this.#watchEnvironment();

    liveInstances++;
    if (liveInstances > INSTANCE_WARN && !manyWarned) {
      manyWarned = true;
      const message = `[pixel-life] ${liveInstances} live instances: each owns a WebGL context (browsers keep ~16). Destroy unused ones.`;
      console.warn(message);
      queueMicrotask(() => this.#emit('warn', { code: 'too-many-instances', message }));
    }
    if (options.autoStart !== false) this.start();
  }

  get destroyed(): boolean {
    return this.#destroyed;
  }

  get supported(): boolean {
    return PixelLife.isSupported();
  }

  /** The canvas of this instance (a new element per instance), null before start / after destroy. */
  get canvas(): HTMLCanvasElement | null {
    return this.#view.canvas;
  }

  // -------------------------------------------------------------------------------------------
  // Config

  getConfig(): Readonly<PixelLifeConfig> {
    return this.#controller.getConfig();
  }

  setConfig(patch: PixelLifeConfigInput, opts: ConfigUpdateOptions = {}): void {
    if (this.#destroyed) return;
    this.#afterConfig(this.#controller.setConfig(patch, opts), opts.source);
  }

  replaceConfig(config: PixelLifeConfigInput, opts: ConfigUpdateOptions = {}): void {
    if (this.#destroyed) return;
    this.#afterConfig(this.#controller.replaceConfig(config, opts), opts.source);
  }

  set<P extends ParamPath>(path: P, value: ParamValue<P>, opts: ConfigUpdateOptions = {}): void {
    if (this.#destroyed) return;
    this.setConfig(setPath({}, path, value) as PixelLifeConfigInput, opts);
  }

  get<P extends ParamPath>(path: P): ParamValue<P> {
    let cur: unknown = this.#controller.getConfig();
    for (const key of path.split('.')) cur = (cur as Record<string, unknown>)[key];
    return cur as ParamValue<P>;
  }

  /** Current value after tweening and modulation. */
  getEffective(path: ModulatablePath): number {
    return this.#controller.getEffective(path);
  }

  exportConfig(
    opts: { mode?: 'full' | 'diff'; base?: 'defaults' | PresetId } = {},
  ): PixelLifeConfigFile {
    return toConfigFile(this.#controller.getConfig(), opts);
  }

  // -------------------------------------------------------------------------------------------
  // Runtime layers

  modulate(
    path: ModulatablePath,
    source: ModulationSource,
    opts: ModulateOptions = {},
  ): ModulatorHandle {
    if (this.#destroyed) return deadModulator();
    return this.#controller.modulate(path, source, opts);
  }

  addInfluence(opts: InfluenceOptions): InfluenceHandle {
    if (this.#destroyed) return deadInfluence();
    const { signal, ...init } = opts;
    return this.#controller.addInfluence(init as InfluenceInit, signal);
  }

  bindElement(el: Element, opts: BindElementOptions = {}): InfluenceHandle {
    if (this.#destroyed) return deadInfluence();
    const { track = 'auto', padding = 0, signal, ...rest } = opts;
    const c = this.#controller;
    const entry = c.createInfluence({ ...(rest as InfluenceInit), space: 'host', x: 0, y: 0 });
    // Invisible until the first measurement (or the first manual update) places it.
    entry.hidden = true;
    const tracker = this.#tracker;
    let handle: ControllerInfluenceHandle | null = null;
    const binding = tracker.add(
      el,
      entry,
      track,
      Math.max(0, padding),
      rest.cornerRadius === undefined,
      () => handle?.dispose(),
    );
    handle = c.influenceHandle(entry, signal, () => tracker.remove(binding));
    const inner = handle;
    return {
      id: inner.id,
      get active() {
        return inner.active;
      },
      update(patch: InfluenceUpdate) {
        if (entry.removed) return;
        const { signal: _s, cornerRadius, ...p } = patch;
        inner.update(p as InfluenceInit);
        if (cornerRadius === null) {
          // Follow the element's border-radius again (re-read on the next measure).
          binding.autoCorner = true;
          binding.radiusDirty = true;
          binding.dirty = true;
        } else if (cornerRadius !== undefined) {
          // An explicit radius sticks: auto tracking must not overwrite it on the next read.
          binding.autoCorner = false;
          inner.update({ cornerRadius });
        }
        if (p.x !== undefined || p.y !== undefined) entry.hidden = false;
      },
      dispose: inner.dispose,
      [Symbol.dispose]: inner.dispose,
    };
  }

  pulse(opts: PulseOptions): void {
    if (this.#destroyed) return;
    this.#controller.pulse(opts);
  }

  /**
   * Lifts cells around a point. Respects the user's accessibility preference: with
   * `render.reducedMotion: 'respect'` and the OS "reduce motion" setting on, every lift is off
   * (random ones, pointer hover and explicit lift() calls alike), so this is a no-op then.
   */
  lift(opts: LiftOptions): void {
    if (this.#destroyed) return;
    this.#controller.lift(opts);
  }

  /** External drive of the whole field (0..3): sugar for an override modulator on animation.energy. */
  setEnergy(value: number): void {
    if (this.#destroyed) return;
    if (!this.#energy) {
      this.#energy = this.#controller.modulate('animation.energy', value, { blend: 'override' });
    } else {
      this.#energy.set(value);
    }
  }

  setDebugView(view: DebugView): void {
    if (this.#destroyed) return;
    this.#controller.setDebugView(DEBUG_VIEW[view] ?? 0);
  }

  // -------------------------------------------------------------------------------------------
  // Events

  on<K extends keyof PixelLifeEvents>(type: K, fn: Listener<K>): () => void {
    if (this.#destroyed) return () => {};
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(fn as Listener<never>);
    return () => {
      set?.delete(fn as Listener<never>);
    };
  }

  getStats(): Stats {
    return { ...this.#stats };
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle

  start(): void {
    if (this.#destroyed || this.#running) return;
    this.#running = true;
    if (!this.supported) {
      this.#sendFallback('no-webgl2');
      return;
    }
    this.#ensureEngine();
    this.#updateSubscription();
  }

  stop(): void {
    this.#running = false;
    this.#updateSubscription();
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#running = false;
    this.#unsub?.();
    this.#unsub = null;
    if (this.#restoreTimer) clearTimeout(this.#restoreTimer);
    this.#restoreTimer = 0;
    // Every listener and observer was registered with this signal (or a per-canvas one).
    this.#ctl.abort();
    this.#releaseCanvas();
    this.#io = null;
    this.#tracker.clear();
    this.#pointer.dispose();
    this.#controller.destroy();
    this.#energy = null;
    this.#disposeEngine();
    this.#view.restore();
    liveInstances = Math.max(0, liveInstances - 1);
    this.#emit('destroy', undefined);
    this.#listeners.clear();
    this.#pending.length = 0;
  }

  /** Simulates a context loss (and the browser's restore ~0.5 s later) to test recovery. */
  loseContextForTesting(): void {
    const e = this.#engine;
    if (this.#destroyed || !e || this.#lost) return;
    e.loseContextForTesting();
    if (this.#restoreTimer) clearTimeout(this.#restoreTimer);
    this.#restoreTimer = setTimeout(() => {
      this.#restoreTimer = 0;
      if (!this.#destroyed && this.#engine === e) e.restoreContextForTesting();
    }, 500);
  }

  // -------------------------------------------------------------------------------------------
  // Internals

  #ensureEngine(): void {
    if (this.#engine || this.#failed || this.#lost || this.#destroyed) return;
    const cfg = this.#controller.getConfig();
    const canvas = this.#view.canvas ?? this.#view.mount(cfg.render.overflow);
    const layout = this.#controller.layout;
    let engine: Engine;
    try {
      engine = new Engine(canvas, {
        opaque: cfg.render.overflow <= 0,
        paramsPrelude: layout.glslPrelude,
        paramsVec4Count: layout.vec4Count,
        warnMissingParams: false,
        onError: (err) => this.#onEngineError(err),
      });
    } catch (err) {
      this.#failed = true;
      const error = err instanceof Error ? err : new Error(String(err));
      queueMicrotask(() => this.#emit('error', error));
      this.#sendFallback(
        err instanceof EngineError && err.code !== 'no-webgl2' ? 'compile' : 'no-webgl2',
      );
      this.#dropFailedCanvas();
      return;
    }
    if (this.#failed || engine.error) {
      // Failed synchronously inside the constructor (resource creation): #onEngineError already
      // reported it; do not keep the dead engine (nor its context) around.
      disposeAndRelease(engine);
      this.#dropFailedCanvas();
      return;
    }
    this.#engine = engine;
    this.#engineOpaque = cfg.render.overflow <= 0;
    this.#drawnSinceMount = false;
    this.#controller.setMaxDrawableSize(engine.caps.maxDrawableSize);
    if (this.#hookedCanvas !== canvas) {
      this.#releaseCanvas();
      this.#hookedCanvas = canvas;
      const ctl = new AbortController();
      this.#canvasCtl = ctl;
      const signal = ctl.signal;
      canvas.addEventListener('webglcontextlost', (e) => this.#onContextLost(e, canvas), {
        signal,
      });
      canvas.addEventListener('webglcontextrestored', () => this.#onContextRestored(canvas), {
        signal,
      });
    }
    if (engine.softwareFallback && !this.#software) {
      this.#software = true;
      this.#controller.setSoftwareFallback(true);
      this.#applyPixelCap();
      queueMicrotask(() =>
        this.#emit('warn', {
          code: 'software-webgl',
          message: `[pixel-life] WebGL runs on a software rasterizer (${engine.caps.renderer || 'unknown'}): low quality, 0.5 Mpx budget.`,
        }),
      );
    }
    this.#controller.invalidateGpu();
  }

  #disposeEngine(): void {
    const e = this.#engine;
    this.#engine = null;
    if (e) disposeAndRelease(e);
  }

  /** Stops listening to the current canvas (it is being dropped or the instance destroyed). */
  #releaseCanvas(): void {
    this.#canvasCtl?.abort();
    this.#canvasCtl = null;
    this.#hookedCanvas = null;
  }

  /** After a failure: no engine, no canvas, only the poster (which follows the config). */
  #dropFailedCanvas(): void {
    this.#releaseCanvas();
    this.#view.unmount();
    this.#drawnSinceMount = false;
    this.#view.showPoster(posterCss(this.#controller.getConfig()));
  }

  #onEngineError(err: Error): void {
    if (this.#destroyed || this.#failed) return;
    this.#failed = true;
    // Release the GPU objects and the context right away (null while still constructing: then
    // #ensureEngine disposes the engine when the constructor returns).
    this.#disposeEngine();
    if (this.#view.canvas) this.#dropFailedCanvas();
    this.#updateSubscription();
    this.#emit('error', err);
    this.#sendFallback('compile');
  }

  #onContextLost(e: Event, canvas: HTMLCanvasElement): void {
    // Without preventDefault the browser never restores the context.
    e.preventDefault();
    if (this.#destroyed || canvas !== this.#view.canvas || this.#lost) return;
    this.#lost = true;
    this.#drawnSinceMount = false;
    this.#view.showPoster(posterCss(this.#controller.getConfig()));
    this.#updateSubscription();
    this.#emit('contextlost', undefined);
    this.#emit('fallback', { reason: 'context-lost' });
  }

  #onContextRestored(canvas: HTMLCanvasElement): void {
    if (this.#destroyed || this.#failed || canvas !== this.#view.canvas) return;
    this.#lost = false;
    // The old engine's objects died with the context: rebuild from the controller's state.
    this.#engine?.dispose();
    this.#engine = null;
    this.#failed = false;
    this.#ensureEngine();
    this.#updateSubscription();
    this.#emit('contextrestored', undefined);
  }

  /** Overflow 0 <-> >0 changes the context's alpha attribute: new canvas, new engine. */
  #rebuildCanvas(): void {
    const running = this.#unsub !== null;
    this.#unsub?.();
    this.#unsub = null;
    this.#disposeEngine();
    // The old canvas is dropped: its context listeners must not keep it (and its context
    // wrapper) reachable from this instance.
    this.#releaseCanvas();
    this.#view.unmount();
    this.#view.showPoster(posterCss(this.#controller.getConfig()));
    this.#lost = false;
    if (running || this.#running) {
      this.#ensureEngine();
      this.#updateSubscription();
    }
  }

  #updateSubscription(): void {
    const cfg = this.#controller.getConfig();
    const visible = !cfg.render.pauseOffscreen || (this.#inView && !this.#hidden);
    const should =
      this.#running &&
      !this.#destroyed &&
      !this.#failed &&
      !this.#lost &&
      this.#engine !== null &&
      visible;
    if (should && !this.#unsub) {
      this.#lastNow = -1;
      this.#skip = 0;
      this.#accMs = 0;
      this.#controller.perf.resetWindow();
      this.#unsub = subscribeTicker(this.#tick);
    } else if (!should && this.#unsub) {
      this.#unsub();
      this.#unsub = null;
      // Config events must not wait for a frame that will not come.
      if (this.#pending.length > 0) this.#queueFlush();
    }
  }

  #afterConfig(changed: ParamPath[], source: ConfigSource = 'api'): void {
    if (changed.length === 0) return;
    const cfg = this.#controller.getConfig();
    let overflow = false;
    let render = false;
    let interaction = false;
    // One event per source, in call order: an echo filter (`source === mine`) must never drop
    // another source's changes. Consecutive calls of one source still coalesce.
    const pending = this.#pending;
    let batch = pending[pending.length - 1];
    if (!batch || batch.source !== source) {
      batch = { source, paths: new Set() };
      pending.push(batch);
    }
    for (const p of changed) {
      batch.paths.add(p);
      if (p === 'render.overflow') overflow = true;
      else if (p.startsWith('render.')) render = true;
      else if (p.startsWith('interaction.')) interaction = true;
    }
    if (overflow) {
      const opaque = cfg.render.overflow <= 0;
      if (this.#view.canvas && this.#engineOpaque !== null && this.#engineOpaque !== opaque) {
        this.#rebuildCanvas();
      } else {
        this.#view.setOverflow(cfg.render.overflow);
      }
      this.#observeInView();
    }
    if (render) {
      this.#applyReducedMotion();
      this.#updateSubscription();
    }
    if (interaction) this.#pointer.configure(cfg.interaction);
    if (this.#view.posterVisible) this.#view.showPoster(posterCss(cfg));
    if (!this.#unsub) this.#queueFlush();
  }

  #queueFlush(): void {
    if (this.#flushQueued) return;
    this.#flushQueued = true;
    queueMicrotask(() => {
      this.#flushQueued = false;
      if (!this.#unsub) this.#flushConfig();
    });
  }

  #flushConfig(): void {
    if (this.#pending.length === 0 || this.#destroyed) return;
    const batches = this.#pending;
    this.#pending = [];
    const config = this.#controller.getConfig();
    for (const b of batches) {
      if (this.#destroyed) return;
      this.#emit('config', { config, changed: [...b.paths], source: b.source });
    }
  }

  #measure(now: number): void {
    if (this.#destroyed) return;
    const c = this.#controller;
    const size = this.#view.takeSize(now, RESIZE_THROTTLE);
    if (size) {
      c.setViewport(size);
      this.#tracker.markAllDirty();
    }
    const o = this.#origin;
    if (this.#tracker.needsHostRect || this.#pointer.needsHostRect || c.needsClientOrigin) {
      this.#view.readClientOrigin(o);
      c.setClientOrigin(o[0] as number, o[1] as number);
    } else {
      o[0] = Number.NaN;
      o[1] = Number.NaN;
    }
    this.#tracker.measure(o[0] as number, o[1] as number);
    this.#pointer.measure(o[0] as number, o[1] as number, now);
  }

  #render(now: number): void {
    const engine = this.#engine;
    if (this.#destroyed || !engine) return;
    const c = this.#controller;
    const perf = c.perf;
    const raw = this.#lastNow < 0 ? perf.vsyncMs : now - this.#lastNow;
    this.#lastNow = now;
    // Feed every rAF (skipped ones too) so the refresh estimate reflects the display.
    const change = c.samplePerf(raw, this.#lastCpu, engine.gpuTimeMs, now);
    if (change) {
      this.#emit('quality', {
        scale: change.scale,
        quality: change.quality,
        reason: change.reason,
      });
    }

    // maxFps: render every k-th vsync (integer divisor of the refresh rate, even cadence). The
    // divisor uses the observed cadence, not the sticky refresh estimate: after a drop to a
    // slower display/OS rate, k must follow it (a 60 Hz cap with maxFps 60 is k = 1, not 2).
    const vsync = perf.cadenceMs;
    const maxFps = c.getConfig().render.maxFps;
    let k = 1;
    let deltaMs = raw;
    if (maxFps > 0) {
      k = Math.max(1, Math.round(1000 / vsync / maxFps));
      this.#accMs += raw;
      if (++this.#skip < k) return;
      this.#skip = 0;
      deltaMs = this.#accMs;
      this.#accMs = 0;
    }
    // Snap to vsync multiples: removes the +-1-2 ms rAF jitter from motion.
    const ideal = k * vsync;
    if (Math.abs(deltaMs - ideal) < 0.15 * ideal) deltaMs = ideal;
    const dt = Math.min(deltaMs, 100) / 1000;

    this.#flushConfig();
    const t0 = performance.now();
    const inputs = c.update(dt, now);
    const drawn = engine.render(inputs);
    // A failure inside render() disposed the engine and dropped the canvas.
    if (this.#engine !== engine) return;
    if (drawn) {
      c.commitFrame();
      if (!this.#drawnSinceMount) {
        this.#drawnSinceMount = true;
        this.#view.hidePoster();
        if (!this.#readyEmitted) {
          this.#readyEmitted = true;
          this.#emit('ready', undefined);
        }
      }
    }
    const cpu = performance.now() - t0;
    this.#lastCpu = cpu;
    this.#cpuEma += (cpu - this.#cpuEma) * 0.1;
    this.#time += dt;
    this.#statsFrames++;

    if (c.geometryChanged) {
      c.geometryChanged = false;
      const g = c.geo;
      this.#emit('resize', {
        width: g.canvasCssW - 2 * c.getConfig().render.overflow,
        height: g.canvasCssH - 2 * c.getConfig().render.overflow,
        cols: g.cols,
        rows: g.rows,
        dpr: g.effDpr,
        scale: perf.scale,
      });
    }
    if (this.#listeners.get('frame')?.size) {
      const fe = this.#frameEvent;
      fe.time = this.#time;
      fe.dt = dt;
      this.#emit('frame', fe);
    }
    if (now - this.#statsAt >= STATS_INTERVAL) {
      const span = now - this.#statsAt;
      this.#renderFps = this.#statsAt > 0 ? (this.#statsFrames * 1000) / span : 1000 / ideal;
      this.#statsAt = now;
      this.#statsFrames = 0;
      this.#updateStats(engine);
      if (this.#listeners.get('stats')?.size) this.#emit('stats', { ...this.#stats });
    }
  }

  #updateStats(engine: Engine): void {
    const c = this.#controller;
    const g = c.geo;
    const perf = c.perf;
    const s = this.#stats;
    s.fps = this.#renderFps;
    s.frameMs = this.#renderFps > 0 ? 1000 / this.#renderFps : 0;
    s.cpuMs = this.#cpuEma;
    s.gpuMs = engine.gpuTimeMs;
    s.vsyncMs = perf.vsyncMs;
    s.missRatio = perf.missRatio;
    s.scale = perf.scale;
    s.quality = perf.quality;
    s.dpr = g.effDpr;
    s.pixels = g.canvasW * g.canvasH;
    s.cols = g.cols;
    s.rows = g.rows;
    s.lifts = c.lifts.written;
    s.influences = c.influences.activeCount;
    s.softwareFallback = this.#software;
  }

  #applyPixelCap(): void {
    let cap = Number.POSITIVE_INFINITY;
    if (this.#coarse) cap = COARSE_MAX_PIXELS;
    if (this.#software) cap = Math.min(cap, SOFTWARE_MAX_PIXELS);
    this.#controller.setPixelCap(cap);
  }

  #applyReducedMotion(): void {
    const respect = this.#controller.getConfig().render.reducedMotion === 'respect';
    this.#controller.setReducedMotion(respect && !!this.#reducedMql?.matches);
  }

  #watchEnvironment(): void {
    const signal = this.#ctl.signal;
    const doc = this.host.ownerDocument;
    const win = doc.defaultView;
    if (!win) return;
    this.#hidden = doc.visibilityState === 'hidden';
    doc.addEventListener(
      'visibilitychange',
      () => {
        const wasHidden = this.#hidden;
        this.#hidden = doc.visibilityState === 'hidden';
        // OS power modes (low-power, energy saver) and displays may have changed meanwhile:
        // re-learn the refresh rate instead of trusting the sticky estimate.
        if (wasHidden && !this.#hidden) this.#controller.perf.resetVsync();
        this.#updateSubscription();
      },
      { signal },
    );
    if (win.matchMedia) {
      this.#reducedMql = win.matchMedia('(prefers-reduced-motion: reduce)');
      this.#reducedMql.addEventListener('change', () => this.#applyReducedMotion(), { signal });
      this.#applyReducedMotion();
    }
    signal.addEventListener('abort', () => this.#io?.disconnect(), { once: true });
    this.#observeInView();
  }

  /**
   * Offscreen pause. The canvas reaches `render.overflow` px beyond the host on every side, so
   * the margin grows with it: a visible strip of canvas must never freeze. Rebuilt when the
   * overflow changes.
   */
  #observeInView(): void {
    if (this.#destroyed) return;
    const win = this.host.ownerDocument.defaultView;
    if (!win || typeof win.IntersectionObserver !== 'function') return;
    const margin = IO_MARGIN + Math.max(0, this.#controller.getConfig().render.overflow);
    if (margin === this.#ioMargin && this.#io) return;
    this.#ioMargin = margin;
    this.#io?.disconnect();
    const io = new win.IntersectionObserver(
      (entries) => {
        if (io !== this.#io) return;
        const e = entries[entries.length - 1];
        if (!e) return;
        this.#inView = e.isIntersecting;
        this.#updateSubscription();
      },
      { rootMargin: `${margin}px` },
    );
    this.#io = io;
    io.observe(this.host);
  }

  #sendFallback(reason: PixelLifeEvents['fallback']['reason']): void {
    if (this.#fallbackSent && reason !== 'context-lost') return;
    this.#fallbackSent = true;
    // Deferred: listeners attached right after construction still receive it.
    queueMicrotask(() => {
      if (!this.#destroyed) this.#emit('fallback', { reason });
    });
  }

  #emit<K extends keyof PixelLifeEvents>(type: K, event: PixelLifeEvents[K]): void {
    const set = this.#listeners.get(type);
    if (!set || set.size === 0) return;
    for (const fn of set) {
      try {
        (fn as Listener<K>)(event);
      } catch (err) {
        console.error(err);
      }
    }
  }
}

/** Frees an engine's GPU objects and releases its context now instead of waiting for GC. */
function disposeAndRelease(e: Engine): void {
  e.dispose();
  try {
    e.loseContextForTesting();
  } catch {
    // Already lost.
  }
}

function deadInfluence(): InfluenceHandle {
  const noop = () => {};
  return { id: -1, active: false, update: noop, dispose: noop, [Symbol.dispose]: noop };
}

function deadModulator(): ModulatorHandle {
  const noop = () => {};
  return { set: noop, dispose: noop, [Symbol.dispose]: noop };
}
