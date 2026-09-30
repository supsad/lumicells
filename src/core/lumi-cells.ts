/**
 * LumiCells facade: the only class consumers construct.
 *
 * Wires the pure Controller (config layers, tweens, influences, lifts, adaptive quality) to the
 * DOM (host sizing, element tracking, pointer, visibility) and to the GL Engine, all driven by
 * the shared ticker: DOM reads in the measure phase, GPU work in the render phase.
 *
 * Lifecycle: start() creates nothing on the GPU. Once the host comes within about one viewport
 * of the screen, the instance asks the page-wide GPU scheduler (runtime/scheduler) for a
 * context: it keeps the page within its context budget (LumiCells.configure) and creates at most
 * a few engines per frame. Programs compile in parallel and 'ready' fires after the first drawn
 * frame; the CSS poster covers the gap and the canvas stays hidden until it has drawn.
 * An instance that stays far from the viewport for `parkAfterMs`, or loses its slot to a better
 * ranked one, is parked: engine disposed, context released, canvas removed, poster shown. The
 * controller (time, tweens, runtime layers) lives on, and the engine is rebuilt through the same
 * path as a context restore when the instance comes back. A lost context hides the canvas behind
 * the poster and is rebuilt on restore with a new Engine on the same canvas. An engine that fails
 * (compile/link or resource error) is disposed and its context released at once.
 *
 * Renderers (`renderer` option, setRenderer()): 'own' is the path above, one context per
 * instance. 'shared' asks the page's shared renderer (runtime/shared-renderer) for a seat
 * instead: a slot on its one device and, while drawing, a region of its atlas. The render phase
 * then only updates the controller; the shared renderer draws every shared instance in the
 * ticker's present phase and copies each into a 2D canvas that HostView places exactly like the
 * WebGL canvas ('ready' after the first copy). Parking gives the seat back and shrinks the 2D
 * canvas to 0x0 (browsers cap the canvas memory of a page); a loss of the shared context keeps
 * every 2D canvas on its last frame until the device is rebuilt.
 * destroy() is synchronous, idempotent and total.
 */

import {
  deepMerge,
  type LumiCellsConfig,
  type LumiCellsConfigFile,
  type LumiCellsConfigInput,
  type ParamPath,
  type ParamValue,
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
import { areaBucket } from './runtime/context-budget';
import {
  cancelRequest,
  claimBudgetWarning,
  configureRuntime,
  type GpuClient,
  maxContexts,
  noteFirstDraw,
  rankChanged,
  releaseContext,
  requestContext,
  runtimeSettings,
  watchSettings,
} from './runtime/scheduler';
import {
  getSharedRenderer,
  peekSharedRenderer,
  type SharedClient,
  type SharedSeat,
} from './runtime/shared-renderer';
import { subscribeTicker } from './ticker';
import type {
  BindElementOptions,
  ConfigSource,
  ConfigUpdateOptions,
  ConfigureOptions,
  DebugView,
  InfluenceHandle,
  InfluenceOptions,
  InfluenceUpdate,
  InstancePriority,
  InstanceRenderer,
  InstanceState,
  LiftOptions,
  LumiCellsEvents,
  LumiCellsOptions,
  ModulatablePath,
  ModulateOptions,
  ModulationSource,
  ModulatorHandle,
  PulseOptions,
  SharedRendererStats,
  Stats,
} from './types';

type Listener<K extends keyof LumiCellsEvents> = (event: LumiCellsEvents[K]) => void;

let supportedMemo: boolean | undefined;
/** Creation counter (queue tie-break: older instances first). */
let instanceSeq = 0;
const COARSE_MAX_PIXELS = 2.4;
const SOFTWARE_MAX_PIXELS = 0.5;
const STATS_INTERVAL = 250;
const RESIZE_THROTTLE = 100;
/** IntersectionObserver margin around the canvas (host + overflow), CSS px. */
const IO_MARGIN = 64;
/**
 * Creation zone: one viewport beyond the screen on every side. The engine is created when the
 * host enters it (ahead of scrolling it into view) and parked after it stays out of it. The
 * view margin above (which follows the overflow) counts as inside the zone too.
 *
 * rootMargin only grows the viewport: a scrolling ancestor (carousel, chat pane, scrollable
 * panel) still clips the host at its own edge. Both observers therefore pass the same margin
 * as `scrollMargin` too (Chrome and Edge 120+; percentages there are of the scroll container),
 * so a host within one container size of its visible part is in the zone. Browsers without it
 * ignore the option: there, a host outside a scroll container's visible part counts as far away.
 */
const ZONE_MARGIN = '100%';

/** One `prefers-reduced-motion` query per window, shared by its instances (each listens itself). */
const reducedMotionQueries = new WeakMap<Window, MediaQueryList>();

function reducedMotionQuery(win: Window): MediaQueryList {
  let mql = reducedMotionQueries.get(win);
  if (!mql) {
    mql = win.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotionQueries.set(win, mql);
  }
  return mql;
}

function isPriority(v: unknown): v is InstancePriority {
  return v === 'high' || v === 'normal' || v === 'low';
}

function isRenderer(v: unknown): v is InstanceRenderer {
  return v === 'own' || v === 'shared';
}

/** Config changes of one source, coalesced until the next flush (frame or microtask). */
interface ConfigBatch {
  source: ConfigSource;
  paths: Set<ParamPath>;
}

export class LumiCells {
  /**
   * Page-wide settings shared by every instance: the WebGL context budget, parking of offscreen
   * instances and the engine creation rate (see ConfigureOptions). Applies to existing instances
   * too; safe to call before any instance exists and on the server.
   */
  static configure(options: ConfigureOptions): void {
    configureRuntime(options);
  }

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
  #renderer: InstanceRenderer;
  readonly #sharedClient: SharedClient;
  /** Seat on the shared renderer ('shared' only); its slot is null while the context is lost. */
  #seat: SharedSeat | null = null;
  /** 2D alpha attribute the current canvas was handed to a seat with (null: never). */
  #targetAlpha: boolean | null = null;
  /** Main-thread time of the last controller update of a shared frame, ms. */
  #updateMs = 0;
  /** dt and vsync-ideal of the frame submitted to the shared renderer (reported in present). */
  #sharedDt = 0;
  #sharedIdeal = 16.67;
  #presentEma = 0;
  readonly #sharedStats: SharedRendererStats = {
    gpuMs: null,
    drawMs: 0,
    copyMs: 0,
    snapshotMs: 0,
    copyMsPerMpx: null,
    atlasWidth: 0,
    atlasHeight: 0,
    members: 0,
    regions: 0,
    scale: 1,
    copyStaged: false,
  };
  #unwatchSettings: (() => void) | null = null;
  #hookedCanvas: HTMLCanvasElement | null = null;
  /** Lifetime of the context listeners of #hookedCanvas (aborted when that canvas is dropped). */
  #canvasCtl: AbortController | null = null;
  #io: IntersectionObserver | null = null;
  #ioMargin = -1;
  #zoneIo: IntersectionObserver | null = null;
  #destroyed = false;
  #running = false;
  #unsub: (() => void) | null = null;
  /** Within the view margin (from the view observer; true when there is no observer). */
  #inView = true;
  /** Within the creation zone (from the zone observer; true when there is no observer). */
  #inZone = true;
  #hidden = false;
  #lost = false;
  /**
   * The context was lost and then dropped (parked, evicted, canvas rebuilt) before the browser
   * restored it: the next engine built emits the 'contextrestored' that ends the loss.
   */
  #lostPending = false;
  #failed = false;
  /** start() found no WebGL2. */
  #noWebgl = false;
  // Context budget (runtime/scheduler): this instance's side of it.
  readonly #client: GpuClient;
  #priority: InstancePriority;
  /** Host area, CSS px squared, read right before a ranking decision (see #refreshArea). */
  #area = 0;
  #lastVisible = Number.NEGATIVE_INFINITY;
  /** Owns a slot: the engine exists (or its context is lost and awaits a restore). */
  #holds = false;
  /** Queued in the scheduler. */
  #requested = false;
  /** The budget refused the request; poster until served. */
  #waiting = false;
  /** Gave its context back (parked or evicted) and has not got a new one yet. */
  #parked = false;
  #parkTimer: ReturnType<typeof setTimeout> | 0 = 0;
  /** When the holder went out of the zone (performance.now()), NaN while it is not away. */
  #awaySince = Number.NaN;
  /** The 'budget' fallback was reported for the current wait. */
  #budgetReported = false;
  /** Watches the host's size while it holds or asks for a slot (see #watchArea). */
  #areaRo: ResizeObserver | null = null;
  #areaWatched = false;
  /** Area bucket of the last host size the watch reported (-1: none yet). */
  #areaBucket = -1;
  #fallbackSent = false;
  #readyEmitted = false;
  #drawnSinceMount = false;
  #listeners = new Map<keyof LumiCellsEvents, Set<Listener<never>>>();
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
    state: 'pending',
    renderer: 'own',
    presentMs: null,
    shared: null,
  };

  constructor(host: HTMLElement, options: LumiCellsOptions = {}) {
    this.host = host;
    this.#priority = isPriority(options.priority) ? options.priority : 'normal';
    this.#renderer = options.renderer === 'shared' ? 'shared' : 'own';
    this.#stats.renderer = this.#renderer;
    const self = this;
    this.#client = {
      order: ++instanceSeq,
      // An instance that never pauses offscreen draws wherever it is (a capture or copy
      // source placed off screen): it ranks like a visible one, never as the first victim.
      get visible() {
        return self.#inView || self.#alwaysOn();
      },
      get inZone() {
        return self.#inZone || self.#inView;
      },
      get priority() {
        return self.#priority;
      },
      get area() {
        return self.#area;
      },
      get lastVisible() {
        return self.#lastVisible;
      },
      granted: () => this.#onGranted(),
      evicted: () => this.#park(true),
      refused: () => this.#onRefused(),
      refreshArea: () => this.#refreshArea(),
      settingsChanged: () => this.#onSettingsChanged(),
    };
    this.#sharedClient = {
      order: this.#client.order,
      get visible() {
        return self.#client.visible;
      },
      get inZone() {
        return self.#client.inZone;
      },
      get priority() {
        return self.#priority;
      },
      get area() {
        return self.#area;
      },
      get lastVisible() {
        return self.#lastVisible;
      },
      get layout() {
        return self.#controller.layout;
      },
      get frame() {
        return self.#controller.frame;
      },
      get naturalWidth() {
        return self.#controller.naturalWidth;
      },
      get naturalHeight() {
        return self.#controller.naturalHeight;
      },
      get expectedWidth() {
        return self.#expectedSize(0);
      },
      get expectedHeight() {
        return self.#expectedSize(1);
      },
      setShareScale: (scale) => this.#controller.setShareScale(scale),
      evict: () => this.#park(false),
      attached: (seat, restored) => this.#onSeat(seat, restored),
      detached: () => this.#onSharedLost(),
      failed: (err) => this.#onSharedFailed(err),
      presented: (drawn, shown, now) => this.#onPresented(drawn, shown, now),
    };
    // Merge order: defaults < preset < config (< the `interactive` shortcut).
    const base: LumiCellsConfigInput = options.preset ? { extends: options.preset } : {};
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
    if (options.autoStart !== false) this.start();
  }

  get destroyed(): boolean {
    return this.#destroyed;
  }

  get supported(): boolean {
    return LumiCells.isSupported();
  }

  /**
   * The canvas of this instance. With `renderer: 'own'` the WebGL canvas (a new element per
   * engine), null until the instance owns a WebGL context (see `getStats().state`) and while it
   * is parked. With `renderer: 'shared'` the 2D canvas the shared renderer copies into, null
   * until the instance first gets its slot; while parked it stays in the host at 0x0. Null after
   * destroy.
   */
  get canvas(): HTMLCanvasElement | null {
    return this.#view.canvas;
  }

  /** The renderer this instance uses (see `LumiCellsOptions.renderer`). */
  get renderer(): InstanceRenderer {
    return this.#renderer;
  }

  /**
   * Switches between a WebGL context of its own and the page's shared renderer. The current GPU
   * side is released and the instance asks the other renderer (the poster shows in between,
   * usually for a frame or two); config, time and runtime layers are kept, the Life automaton
   * reseeds.
   */
  setRenderer(renderer: InstanceRenderer): void {
    if (this.#destroyed || !isRenderer(renderer) || renderer === this.#renderer) return;
    this.#dropGpu();
    this.#renderer = renderer;
    this.#parked = false;
    this.#updateSubscription();
    this.#syncGpu();
  }

  /** Priority for the page's WebGL context budget. */
  get priority(): InstancePriority {
    return this.#priority;
  }

  /** Changes the budget priority; a waiting instance may get a context right away. */
  setPriority(priority: InstancePriority): void {
    if (this.#destroyed || !isPriority(priority) || priority === this.#priority) return;
    this.#priority = priority;
    rankChanged();
  }

  // -------------------------------------------------------------------------------------------
  // Config

  getConfig(): Readonly<LumiCellsConfig> {
    return this.#controller.getConfig();
  }

  setConfig(patch: LumiCellsConfigInput, opts: ConfigUpdateOptions = {}): void {
    if (this.#destroyed) return;
    this.#afterConfig(this.#controller.setConfig(patch, opts), opts.source);
  }

  replaceConfig(config: LumiCellsConfigInput, opts: ConfigUpdateOptions = {}): void {
    if (this.#destroyed) return;
    this.#afterConfig(this.#controller.replaceConfig(config, opts), opts.source);
  }

  set<P extends ParamPath>(path: P, value: ParamValue<P>, opts: ConfigUpdateOptions = {}): void {
    if (this.#destroyed) return;
    this.setConfig(setPath({}, path, value) as LumiCellsConfigInput, opts);
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
  ): LumiCellsConfigFile {
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

  on<K extends keyof LumiCellsEvents>(type: K, fn: Listener<K>): () => void {
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
    const s = this.#stats;
    return { ...s, shared: s.shared ? { ...s.shared } : null };
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle

  /**
   * Starts rendering. The WebGL context is not created here: the instance asks the page's GPU
   * scheduler for one once the host is near the viewport (see LumiCells.configure).
   */
  start(): void {
    if (this.#destroyed || this.#running) return;
    this.#running = true;
    if (!this.supported) {
      this.#noWebgl = true;
      this.#publishState();
      this.#sendFallback('no-webgl2');
      return;
    }
    this.#syncGpu();
    this.#updateSubscription();
  }

  /** Stops rendering. An existing context is kept (the canvas keeps its last frame). */
  stop(): void {
    this.#running = false;
    this.#syncGpu();
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
    this.#clearParkTimer();
    this.#cancelRequest();
    this.#unwatchSettings?.();
    this.#unwatchSettings = null;
    // Every listener and observer was registered with this signal (or a per-canvas one).
    this.#ctl.abort();
    this.#releaseCanvas();
    this.#io = null;
    this.#zoneIo = null;
    this.#areaRo = null;
    this.#tracker.clear();
    this.#pointer.dispose();
    this.#controller.destroy();
    this.#energy = null;
    // The context is released before the slot: the next instance's context comes after it.
    this.#disposeEngine();
    this.#releaseSlot();
    this.#view.restore();
    this.#publishState();
    this.#emit('destroy', undefined);
    this.#listeners.clear();
    this.#pending.length = 0;
  }

  /**
   * Simulates a context loss (and the browser's restore ~0.5 s later) to test recovery. On a
   * shared instance it loses the shared context: every shared instance on the page is affected.
   */
  loseContextForTesting(): void {
    if (this.#destroyed || this.#lost) return;
    const seat = this.#seat;
    if (seat) {
      if (seat.slot) seat.loseContextForTesting();
      return;
    }
    const e = this.#engine;
    if (!e) return;
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
    if (engine.softwareFallback) this.#noteSoftware(engine.caps.renderer);
    this.#controller.invalidateGpu();
  }

  /** The context runs on a CPU rasterizer: lowest tier, small pixel budget, one warning. */
  #noteSoftware(renderer: string): void {
    if (this.#software) return;
    this.#software = true;
    this.#controller.setSoftwareFallback(true);
    this.#applyPixelCap();
    queueMicrotask(() =>
      this.#emit('warn', {
        code: 'software-webgl',
        message: `[lumicells] WebGL runs on a software rasterizer (${renderer || 'unknown'}): low quality, 0.5 Mpx budget.`,
      }),
    );
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
    this.#targetAlpha = null;
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
    this.#releaseSlot();
    this.#updateSubscription();
    this.#publishState();
    this.#emit('error', err);
    this.#sendFallback('compile');
  }

  #onContextLost(e: Event, canvas: HTMLCanvasElement): void {
    // Without preventDefault the browser never restores the context.
    e.preventDefault();
    if (this.#destroyed || canvas !== this.#view.canvas) return;
    this.#enterLost();
  }

  /**
   * The context is gone. Reached from the loss event, or earlier from the render phase: the
   * context reports the loss at once, but the browser dispatches the event as a task that may
   * run only after the next frame is painted, and that frame would show the lost canvas's blank
   * box.
   */
  #enterLost(): void {
    if (this.#lost) return;
    this.#lost = true;
    this.#drawnSinceMount = false;
    // A lost context's canvas paints a blank box over everything: hide it until the first frame
    // drawn on the restored context.
    this.#view.setCanvasVisible(false);
    this.#view.showPoster(posterCss(this.#controller.getConfig()));
    this.#updateSubscription();
    this.#publishState();
    this.#emit('contextlost', undefined);
    this.#emit('fallback', { reason: 'context-lost' });
  }

  #onContextRestored(canvas: HTMLCanvasElement): void {
    if (this.#destroyed || this.#failed || canvas !== this.#view.canvas) return;
    this.#lost = false;
    this.#lostPending = false;
    // The old engine's objects died with the context: rebuild from the controller's state.
    this.#engine?.dispose();
    this.#engine = null;
    this.#failed = false;
    this.#ensureEngine();
    if (!this.#engine) this.#releaseSlot();
    this.#updateSubscription();
    this.#publishState();
    this.#emit('contextrestored', undefined);
  }

  /**
   * Overflow 0 <-> >0 changes the context's alpha attribute: new canvas, new engine, in the same
   * budget slot (a stopped instance gives the slot back and is rebuilt when started again).
   */
  #rebuildCanvas(): void {
    this.#unsub?.();
    this.#unsub = null;
    this.#disposeEngine();
    // The old canvas is dropped: its context listeners must not keep it (and its context
    // wrapper) reachable from this instance.
    this.#releaseCanvas();
    this.#view.unmount();
    this.#view.showPoster(posterCss(this.#controller.getConfig()));
    if (this.#lost) this.#lostPending = true;
    this.#lost = false;
    this.#drawnSinceMount = false;
    if (this.#holds && this.#running) this.#ensureEngine();
    if (!this.#engine && this.#holds) {
      this.#releaseSlot();
      this.#parked = !this.#failed;
    }
    this.#updateSubscription();
    this.#syncGpu();
    this.#endPendingLoss();
  }

  // -------------------------------------------------------------------------------------------
  // Context budget: lazy creation, waiting, parking

  /** `render.pauseOffscreen: false`: draws wherever the host is, so it is never parked. */
  #alwaysOn(): boolean {
    return !this.#controller.getConfig().render.pauseOffscreen;
  }

  /** Wants a context now: started, working, and near the viewport (or never paused offscreen). */
  #wantsContext(): boolean {
    if (!this.#running || this.#destroyed || this.#failed || this.#noWebgl) return false;
    if (this.#alwaysOn()) return true;
    return this.#inZone || this.#inView;
  }

  /** Asks the scheduler for a slot, or withdraws the request, as the wish changed. */
  #syncGpu(): void {
    if (!this.#holds && !this.#destroyed) {
      if (this.#wantsContext()) {
        if (!this.#requested) {
          this.#requested = true;
          if (this.#renderer === 'shared') getSharedRenderer().request(this.#sharedClient);
          else requestContext(this.#client);
        }
      } else {
        this.#cancelRequest();
      }
    }
    this.#armParkTimer();
    this.#publishState();
  }

  /** The scheduler granted a slot: build the engine (same path as a context restore). */
  #onGranted(): void {
    this.#requested = false;
    this.#waiting = false;
    this.#budgetReported = false;
    this.#holds = true;
    if (this.#destroyed || !this.#wantsContext() || this.#renderer !== 'own') {
      this.#releaseSlot();
      this.#publishState();
      return;
    }
    this.#parked = false;
    this.#ensureEngine();
    if (!this.#engine) this.#releaseSlot();
    this.#updateSubscription();
    this.#armParkTimer();
    this.#publishState();
    this.#endPendingLoss();
  }

  /**
   * The scheduler refused the request (again: it re-evaluates every waiter on each pass). Only a
   * real refusal reports a visible wait, never a stale one: an instance that waited offscreen
   * and then scrolled into view is reported only if the pass after the move still refuses it.
   */
  #onRefused(): void {
    if (this.#destroyed) return;
    if (!this.#waiting) {
      this.#waiting = true;
      this.#publishState();
    }
    this.#reportBudgetWait();
  }

  /** A context lost before a park or rebuild is over once a new engine exists. */
  #endPendingLoss(): void {
    if (!this.#lostPending || (!this.#engine && !this.#seat) || this.#lost) return;
    this.#lostPending = false;
    // Deferred: this runs inside the scheduler's pass, listeners must not re-enter it.
    queueMicrotask(() => {
      if (!this.#destroyed) this.#emit('contextrestored', undefined);
    });
  }

  /**
   * A visible instance (or one that never pauses offscreen) kept waiting by the budget: 'budget'
   * fallback, and one page warning.
   */
  #reportBudgetWait(): void {
    if (!this.#waiting || !this.#client.visible || this.#budgetReported) return;
    this.#budgetReported = true;
    queueMicrotask(() => {
      if (this.#destroyed || !this.#waiting) return;
      if (claimBudgetWarning()) {
        const message = `[lumicells] A visible background waits for a WebGL context: the page budget of ${maxContexts()} contexts is taken by instances that rank higher. It shows its poster until one frees up. Raise the budget with LumiCells.configure({ maxContexts }) or set priority: 'high' on the backgrounds that matter most.`;
        console.warn(message);
        this.#emit('warn', { code: 'context-budget', message });
      }
      this.#emit('fallback', { reason: 'budget' });
    });
  }

  /**
   * Releases the GPU side (engine, context, canvas) and keeps everything else; the poster shows
   * instead. `evicted`: the scheduler already took the slot back. An instance that still wants a
   * context (evicted near the viewport) asks again and waits.
   */
  #park(evicted: boolean): void {
    if (!this.#holds || this.#destroyed) return;
    if (evicted) this.#holds = false;
    if (this.#restoreTimer) clearTimeout(this.#restoreTimer);
    this.#restoreTimer = 0;
    if (this.#seat) {
      // Shared: the seat (slot and region) goes back; the 2D canvas stays in the host, emptied.
      this.#releaseSlot();
      this.#shrinkTarget();
    } else {
      // Stop listening first: the release below must not come back as a context loss.
      this.#releaseCanvas();
      this.#disposeEngine();
      this.#view.unmount();
    }
    this.#view.showPoster(posterCss(this.#controller.getConfig()));
    // A lost context is dropped here, not restored: the rebuild on the next grant ends the loss.
    if (this.#lost) this.#lostPending = true;
    this.#lost = false;
    this.#drawnSinceMount = false;
    this.#parked = true;
    this.#releaseSlot();
    this.#updateSubscription();
    this.#syncGpu();
  }

  /**
   * Gives the budget slot back (after the engine and its context are gone), or, when shared,
   * the seat (its slot and region).
   */
  #releaseSlot(): void {
    this.#clearParkTimer();
    const seat = this.#seat;
    if (seat) {
      this.#seat = null;
      this.#unwatchSettings?.();
      this.#unwatchSettings = null;
      seat.release();
    }
    if (!this.#holds) return;
    this.#holds = false;
    if (!seat) releaseContext(this.#client);
  }

  /** Withdraws a request that was not served yet (from whichever renderer it went to). */
  #cancelRequest(): void {
    if (!this.#requested) return;
    // The wait (if any) ends here: a later one is reported anew.
    this.#requested = false;
    this.#waiting = false;
    this.#budgetReported = false;
    cancelRequest(this.#client);
    peekSharedRenderer()?.cancel(this.#sharedClient);
  }

  /** Releases whatever GPU side the instance has or asks for (renderer switch). */
  #dropGpu(): void {
    if (this.#restoreTimer) clearTimeout(this.#restoreTimer);
    this.#restoreTimer = 0;
    this.#cancelRequest();
    this.#releaseCanvas();
    this.#disposeEngine();
    this.#releaseSlot();
    this.#view.unmount();
    this.#targetAlpha = null;
    this.#engineOpaque = null;
    // The shared budget's resolution factor belongs to the shared renderer (a new seat sets it).
    this.#controller.setShareScale(1);
    this.#view.showPoster(posterCss(this.#controller.getConfig()));
    if (this.#lost) this.#lostPending = true;
    this.#lost = false;
    this.#drawnSinceMount = false;
  }

  /**
   * The shared renderer gave this instance a seat: the first grant (mount the 2D canvas; drawn
   * from the next frame, shown after the first copy), or the same seat rebuilt after a loss of
   * the shared context (the canvas still shows the last frame, the next copy replaces it).
   */
  #onSeat(seat: SharedSeat, restored: boolean): void {
    if (restored) {
      if (this.#destroyed || seat !== this.#seat) {
        seat.release();
        return;
      }
      this.#lost = false;
      this.#lostPending = false;
      this.#applySharedCaps(seat);
      this.#controller.invalidateGpu();
      this.#updateSubscription();
      this.#publishState();
      this.#emit('contextrestored', undefined);
      return;
    }
    this.#requested = false;
    this.#waiting = false;
    this.#budgetReported = false;
    if (this.#destroyed || !this.#wantsContext() || this.#renderer !== 'shared') {
      seat.release();
      this.#publishState();
      return;
    }
    this.#holds = true;
    this.#seat = seat;
    this.#parked = false;
    this.#unwatchSettings ??= watchSettings(() => this.#onSettingsChanged());
    const overflow = this.#controller.getConfig().render.overflow;
    const alpha = overflow > 0;
    let canvas = this.#view.canvas;
    // A canvas keeps the 2D context (and its alpha attribute) it was first given.
    if (!canvas || (this.#targetAlpha !== null && this.#targetAlpha !== alpha)) {
      canvas = this.#view.mount(overflow);
      this.#drawnSinceMount = false;
    }
    this.#targetAlpha = alpha;
    seat.setTarget(canvas, alpha);
    this.#applySharedCaps(seat);
    this.#controller.invalidateGpu();
    this.#updateSubscription();
    this.#syncIdle();
    this.#armParkTimer();
    this.#publishState();
    this.#endPendingLoss();
  }

  /**
   * Shared, out of the creation zone: the 2D canvas frees its memory at once (browsers cap the
   * canvas memory of a page) while the seat stays for a quick return; the poster shows until the
   * next copy refills the canvas. Parking (later, or early when too many seats are idle) gives
   * the seat back too.
   */
  #syncIdle(): void {
    const seat = this.#seat;
    if (!seat) return;
    const idle = !this.#inZone && !this.#inView && !this.#alwaysOn();
    if (idle && !seat.idle) {
      this.#shrinkTarget();
      this.#drawnSinceMount = false;
      this.#view.showPoster(posterCss(this.#controller.getConfig()));
    }
    seat.setIdle(idle);
  }

  /**
   * Drawing-buffer size (0 width, 1 height) at full resolution: the controller's once it has
   * been measured, else estimated from the host's box, the overflow margin and the DPR cap (read
   * by the shared renderer to size its atlas ahead of instances about to draw).
   */
  #expectedSize(axis: 0 | 1): number {
    const c = this.#controller;
    if (c.measured) return axis === 0 ? c.naturalWidth : c.naturalHeight;
    const r = this.host.getBoundingClientRect();
    const cfg = c.getConfig().render;
    const dpr = Math.min(this.host.ownerDocument.defaultView?.devicePixelRatio || 1, cfg.maxDpr);
    const css = (axis === 0 ? r.width : r.height) + 2 * Math.max(0, cfg.overflow);
    return Math.max(1, Math.round(css * dpr));
  }

  #applySharedCaps(seat: SharedSeat): void {
    this.#controller.setMaxDrawableSize(seat.maxDrawableSize);
    if (seat.softwareFallback) this.#noteSoftware(seat.rendererName);
  }

  /**
   * The shared context is lost. Unlike an own canvas, the 2D canvas keeps showing the last frame
   * copied into it (no poster, no blank box) until the shared renderer rebuilds the device.
   */
  #onSharedLost(): void {
    if (this.#destroyed || !this.#seat || this.#lost) return;
    this.#lost = true;
    this.#updateSubscription();
    this.#publishState();
    this.#emit('contextlost', undefined);
    this.#emit('fallback', { reason: 'context-lost' });
  }

  /** The shared device (or this slot) failed for good; the renderer already took the seat back. */
  #onSharedFailed(err: EngineError): void {
    this.#requested = false;
    this.#waiting = false;
    if (this.#destroyed || this.#failed) return;
    this.#failed = true;
    this.#seat = null;
    this.#holds = false;
    this.#unwatchSettings?.();
    this.#unwatchSettings = null;
    this.#clearParkTimer();
    if (this.#view.canvas) this.#dropFailedCanvas();
    this.#updateSubscription();
    this.#publishState();
    // Deferred: this runs inside the shared renderer's pass.
    queueMicrotask(() => {
      if (!this.#destroyed) this.#emit('error', err);
    });
    this.#sendFallback(err.code === 'no-webgl2' ? 'no-webgl2' : 'compile');
  }

  /** Overflow 0 <-> > 0 while shared: a 2D canvas with the other alpha attribute, same seat. */
  #swapTarget(): void {
    const cfg = this.#controller.getConfig();
    const alpha = cfg.render.overflow > 0;
    const canvas = this.#view.mount(cfg.render.overflow);
    this.#targetAlpha = alpha;
    this.#seat?.setTarget(canvas, alpha);
    this.#drawnSinceMount = false;
    this.#view.showPoster(posterCss(cfg));
  }

  /** Parked while shared: the 2D canvas frees its memory (browsers cap it per page) and hides. */
  #shrinkTarget(): void {
    const c = this.#view.canvas;
    if (c) {
      c.width = 0;
      c.height = 0;
    }
    this.#view.setCanvasVisible(false);
  }

  /**
   * Parks the instance after `parkAfterMs` out of the zone (instances that never pause stay).
   * `elapsedMs`: time already spent away, when the timer is re-armed for a new `parkAfterMs`.
   */
  #armParkTimer(elapsedMs = 0): void {
    const away = !this.#inZone && !this.#inView;
    if (!away || !this.#holds || this.#destroyed || this.#alwaysOn()) {
      this.#clearParkTimer();
      return;
    }
    if (Number.isNaN(this.#awaySince)) this.#awaySince = performance.now();
    if (this.#parkTimer) return;
    const ms = runtimeSettings().parkAfterMs;
    if (!(ms < Number.POSITIVE_INFINITY)) return;
    this.#parkTimer = setTimeout(
      () => {
        this.#parkTimer = 0;
        if (!this.#inZone && !this.#inView) this.#park(false);
      },
      Math.max(0, ms - elapsedMs),
    );
  }

  #clearParkTimer(): void {
    if (this.#parkTimer) clearTimeout(this.#parkTimer);
    this.#parkTimer = 0;
    this.#awaySince = Number.NaN;
  }

  /** LumiCells.configure() changed `parkAfterMs`: a pending (or missing) timer follows it. */
  #onSettingsChanged(): void {
    if (this.#destroyed) return;
    if (this.#parkTimer) clearTimeout(this.#parkTimer);
    this.#parkTimer = 0;
    const since = this.#awaySince;
    this.#armParkTimer(Number.isNaN(since) ? 0 : performance.now() - since);
  }

  /**
   * Host size for ranking among visible instances. Read by the scheduler right before it ranks
   * (once per pass, only while instances compete for slots), from one source for holders and
   * waiters alike: a waiter has no canvas to measure, so a cached size could be stale.
   */
  #refreshArea(): void {
    if (this.#destroyed) return;
    const r = this.host.getBoundingClientRect();
    this.#area = r.width > 0 && r.height > 0 ? r.width * r.height : 0;
  }

  /**
   * While the instance holds or asks for a slot, a resize of its host can change who deserves
   * one (among visible instances the larger ranks higher), yet no intersection callback reports
   * a resize: a ResizeObserver on the host asks the scheduler to rank again when the area moves
   * to another bucket (a waiting card that grows, a holder that shrinks). The pass then reads
   * every competitor's size afresh (#refreshArea); the observer is only the trigger.
   */
  #watchArea(): void {
    // Only own contexts compete for budget slots by size.
    const want = this.#renderer === 'own' && (this.#holds || this.#requested) && !this.#destroyed;
    if (want === this.#areaWatched) return;
    const win = this.host.ownerDocument.defaultView;
    if (!win || typeof win.ResizeObserver !== 'function') return;
    this.#areaWatched = want;
    this.#areaBucket = -1;
    if (want) {
      this.#areaRo ??= new win.ResizeObserver((entries) => this.#onHostResize(entries));
      this.#areaRo.observe(this.host);
    } else {
      this.#areaRo?.unobserve(this.host);
    }
  }

  #onHostResize(entries: ResizeObserverEntry[]): void {
    const e = entries[entries.length - 1];
    if (!e || this.#destroyed || !this.#areaWatched) return;
    const box = e.borderBoxSize?.[0];
    const w = box ? box.inlineSize : e.contentRect.width;
    const h = box ? box.blockSize : e.contentRect.height;
    const bucket = areaBucket(w > 0 && h > 0 ? w * h : 0);
    const was = this.#areaBucket;
    this.#areaBucket = bucket;
    // The first report only sets the baseline: the request was just ranked on fresh sizes.
    if (was >= 0 && bucket !== was) rankChanged();
  }

  /** The host moved relative to the zones (observer callbacks). */
  #onPlacement(): void {
    this.#syncGpu();
    this.#updateSubscription();
    this.#syncIdle();
    // A visible waiter is reported only once the next pass (at frame end) still refuses it.
    rankChanged();
  }

  /** Called after every change of the GPU side: the state, and the resize watch that follows it. */
  #publishState(): void {
    const s = this.#stats;
    s.state = this.#computeState();
    s.renderer = this.#renderer;
    if (this.#renderer === 'own') {
      s.presentMs = null;
      s.shared = null;
    }
    this.#watchArea();
  }

  #computeState(): InstanceState {
    if (this.#destroyed) return 'destroyed';
    if (this.#failed || this.#noWebgl) return 'failed';
    if (this.#engine || this.#seat) return this.#lost ? 'lost' : 'live';
    if (this.#waiting) return 'waiting';
    if (this.#requested) return 'pending';
    return this.#parked ? 'parked' : 'pending';
  }

  #updateSubscription(): void {
    const cfg = this.#controller.getConfig();
    const visible = !cfg.render.pauseOffscreen || (this.#inView && !this.#hidden);
    const should =
      this.#running &&
      !this.#destroyed &&
      !this.#failed &&
      !this.#lost &&
      (this.#engine !== null || this.#seat !== null) &&
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
    // A drawing shared instance needs a region in the atlas.
    this.#seat?.setRendering(this.#unsub !== null);
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
      if (this.#seat) {
        // Shared: the region follows the new size by itself and the shared context stays; only
        // a switch between opaque and transparent needs a 2D canvas of the other kind.
        if (this.#targetAlpha !== null && this.#targetAlpha === opaque) this.#swapTarget();
        else this.#view.setOverflow(cfg.render.overflow);
      } else if (
        this.#view.canvas &&
        this.#engineOpaque !== null &&
        this.#engineOpaque !== opaque
      ) {
        this.#rebuildCanvas();
      } else {
        this.#view.setOverflow(cfg.render.overflow);
      }
      this.#observeInView();
    }
    if (render) {
      this.#applyReducedMotion();
      this.#syncGpu();
      this.#updateSubscription();
      this.#syncIdle();
      // render.pauseOffscreen decides whether an offscreen instance ranks as visible.
      rankChanged();
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
    const seat = this.#seat;
    if (this.#destroyed || (!engine && !seat)) return;
    // Lost since the last frame (the loss event may still be queued): hide the canvas now.
    if (engine?.isContextLost()) {
      this.#enterLost();
      return;
    }
    // The shared renderer settles this frame's budget scale before any shared instance updates.
    seat?.beginFrame(now);
    const c = this.#controller;
    const perf = c.perf;
    const raw = this.#lastNow < 0 ? perf.vsyncMs : now - this.#lastNow;
    this.#lastNow = now;
    // Feed every rAF (skipped ones too) so the refresh estimate reflects the display. A shared
    // instance feeds the GPU time of the whole shared device.
    const gpuMs = engine ? engine.gpuTimeMs : (seat?.stats.gpuMs ?? null);
    const change = c.samplePerf(raw, this.#lastCpu, gpuMs, now);
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
    if (!engine) {
      // Shared: drawn and copied in the present phase, reported in #onPresented.
      this.#updateMs = performance.now() - t0;
      this.#sharedDt = dt;
      this.#sharedIdeal = ideal;
      (seat as SharedSeat).submit();
      return;
    }
    const drawn = engine.render(inputs);
    // A failure inside render() disposed the engine and dropped the canvas.
    if (this.#engine !== engine) return;
    if (drawn) {
      c.commitFrame();
      if (!this.#drawnSinceMount) {
        noteFirstDraw(now);
        this.#showFirstFrame();
      }
    }
    this.#finishFrame(performance.now() - t0, dt, ideal, now, engine.gpuTimeMs);
  }

  /** The shared renderer drew (and copied) the frame this instance submitted, or could not. */
  #onPresented(drawn: boolean, shown: boolean, now: number): void {
    const seat = this.#seat;
    if (this.#destroyed || !seat) return;
    // Drawn: the slot consumed the one-shot inputs (uploads, life reset).
    if (drawn) this.#controller.commitFrame();
    if (shown) {
      this.#presentEma += (seat.copyMs - this.#presentEma) * 0.1;
      if (!this.#drawnSinceMount) this.#showFirstFrame();
    }
    this.#finishFrame(
      this.#updateMs + seat.drawMs + seat.copyMs,
      this.#sharedDt,
      this.#sharedIdeal,
      now,
      seat.stats.gpuMs,
    );
  }

  /** The canvas shows a frame for the first time since it was mounted (or rebuilt). */
  #showFirstFrame(): void {
    this.#drawnSinceMount = true;
    this.#view.setCanvasVisible(true);
    this.#view.hidePoster();
    if (!this.#readyEmitted) {
      this.#readyEmitted = true;
      this.#emit('ready', undefined);
    }
  }

  /** Per-frame bookkeeping after the frame was drawn (or not): timings, events, stats. */
  #finishFrame(cpu: number, dt: number, ideal: number, now: number, gpuMs: number | null): void {
    const c = this.#controller;
    const perf = c.perf;
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
      this.#updateStats(gpuMs);
      if (this.#listeners.get('stats')?.size) this.#emit('stats', this.getStats());
    }
  }

  #updateStats(gpuMs: number | null): void {
    const c = this.#controller;
    const g = c.geo;
    const perf = c.perf;
    const s = this.#stats;
    s.fps = this.#renderFps;
    s.frameMs = this.#renderFps > 0 ? 1000 / this.#renderFps : 0;
    s.cpuMs = this.#cpuEma;
    s.gpuMs = gpuMs;
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
    const seat = this.#seat;
    if (seat) {
      const d = this.#sharedStats;
      const src = seat.stats;
      d.gpuMs = src.gpuMs;
      d.drawMs = src.drawMs;
      d.copyMs = src.copyMs;
      d.snapshotMs = src.snapshotMs;
      d.copyMsPerMpx = src.copyMsPerMpx;
      d.atlasWidth = src.atlasWidth;
      d.atlasHeight = src.atlasHeight;
      d.members = src.members;
      d.regions = src.regions;
      d.scale = src.scale;
      d.copyStaged = src.copyStaged;
      s.shared = d;
      s.presentMs = this.#presentEma;
    }
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
    if (typeof win.matchMedia === 'function') {
      this.#reducedMql = reducedMotionQuery(win);
      this.#reducedMql.addEventListener('change', () => this.#applyReducedMotion(), { signal });
      this.#applyReducedMotion();
    }
    signal.addEventListener(
      'abort',
      () => {
        this.#io?.disconnect();
        this.#zoneIo?.disconnect();
        this.#areaRo?.disconnect();
      },
      { once: true },
    );
    if (typeof win.IntersectionObserver === 'function') {
      // Unknown until the observers report (right after the first frame): nothing is created
      // before that, so a page that mounts many instances off screen creates no context.
      this.#inView = false;
      this.#inZone = false;
    }
    this.#observeInView();
    this.#observeZone();
  }

  /** Lazy creation and parking: is the host within about one viewport of the screen? */
  #observeZone(): void {
    const win = this.host.ownerDocument.defaultView;
    if (!win || typeof win.IntersectionObserver !== 'function') return;
    const io = marginObserver(
      win,
      (entries) => {
        if (io !== this.#zoneIo || this.#destroyed) return;
        const e = entries[entries.length - 1];
        if (!e) return;
        this.#inZone = e.isIntersecting;
        this.#onPlacement();
      },
      ZONE_MARGIN,
    );
    this.#zoneIo = io;
    io.observe(this.host);
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
    const io = marginObserver(
      win,
      (entries) => {
        if (io !== this.#io || this.#destroyed) return;
        const e = entries[entries.length - 1];
        if (!e) return;
        const was = this.#inView;
        this.#inView = e.isIntersecting;
        if (was && !this.#inView) this.#lastVisible = performance.now();
        this.#onPlacement();
      },
      `${margin}px`,
    );
    this.#io = io;
    io.observe(this.host);
  }

  #sendFallback(reason: LumiCellsEvents['fallback']['reason']): void {
    if (this.#fallbackSent && reason !== 'context-lost') return;
    this.#fallbackSent = true;
    // Deferred: listeners attached right after construction still receive it.
    queueMicrotask(() => {
      if (!this.#destroyed) this.#emit('fallback', { reason });
    });
  }

  #emit<K extends keyof LumiCellsEvents>(type: K, event: LumiCellsEvents[K]): void {
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

/**
 * An IntersectionObserver whose margin grows the viewport (rootMargin) and every scroll container
 * on the way to the target (scrollMargin, see ZONE_MARGIN). Engines that do not know scrollMargin
 * ignore it; one that knows it but rejects the value gets the viewport margin alone.
 */
function marginObserver(
  win: Window & typeof globalThis,
  cb: IntersectionObserverCallback,
  margin: string,
): IntersectionObserver {
  try {
    return new win.IntersectionObserver(cb, { rootMargin: margin, scrollMargin: margin });
  } catch {
    return new win.IntersectionObserver(cb, { rootMargin: margin });
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
