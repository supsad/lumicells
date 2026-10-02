/**
 * Shell: the eager half of a LumiCells instance (the facade, lumi-cells.ts, is its API).
 *
 * It holds what exists before any GPU code has loaded: the config layer (config-state.ts), the
 * host view with its CSS poster, the page signals (visibility, reduced motion), the two
 * IntersectionObservers that say where the host is (view margin, creation zone), the event
 * listeners, the pending `config` events and the instance's observable state (renderer, look,
 * priority, `Stats`).
 *
 * The GPU side (runtime/live.ts: controller, element tracking, pointer, engines, the shared
 * renderer and look groups) is loaded on demand (runtime/loader.ts) and attaches to the shell
 * (`live`). Until it does, the runtime-layer calls (modulate, addInfluence, bindElement, pulse,
 * lift, setEnergy, setDebugView) and the config changes are kept in call order (`queue`) and
 * the handles handed out forward to the real ones once it is there; the GPU side replays the
 * queue first thing, so it ends up exactly where it would be had it existed from the start
 * (nothing is drawn before it exists). Nothing is queued for an instance that will never get a
 * GPU side (no WebGL2, known at construction or found by start(); the load failed; destroyed),
 * and its handles drop their updates.
 */

import {
  deepMerge,
  getField,
  getPath,
  type LumiCellsConfigInput,
  type ModulatablePath,
  type ParamPath,
} from '../schema';
import { type ConfigCommit, ConfigState } from './config-state';
import type { InfluenceInit } from './controller/influences';
import { reducedMotionQuery, watchReducedMotion, watchVisibility } from './dom/environment';
import { HostView } from './dom/host';
import { isLookMode, isPriority, lookOffset } from './options';
import { requestDisplayCalibration } from './runtime/display';
import type { LiveInstance } from './runtime/live';
import { type LiveModule, liveModule, loadLive } from './runtime/loader';
import { isRendererMode, runtimeSettings } from './runtime/settings';
import type {
  BindElementOptions,
  ConfigSource,
  DebugView,
  InfluenceHandle,
  InfluenceUpdate,
  InstancePriority,
  InstanceRenderer,
  InstanceState,
  LiftOptions,
  LookMode,
  LumiCellsEvents,
  LumiCellsOptions,
  ModulateOptions,
  ModulationSource,
  ModulatorHandle,
  PulseOptions,
  RendererChangeReason,
  RendererMode,
  Stats,
} from './types';

type Listener<K extends keyof LumiCellsEvents> = (event: LumiCellsEvents[K]) => void;

/** Creation counter (queue tie-break: older instances first). */
let instanceSeq = 0;
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

/** Config changes of one source, coalesced until the next flush (frame or microtask). */
interface ConfigBatch {
  source: ConfigSource;
  paths: Set<ParamPath>;
}

/** A modulate() made before the GPU side existed. */
export interface PendingModulator {
  readonly kind: 'modulate';
  readonly path: ModulatablePath;
  source: ModulationSource;
  readonly opts: { blend?: ModulateOptions['blend']; smoothingMs?: number };
  disposed: boolean;
  real: ModulatorHandle | null;
}

/** An addInfluence() or bindElement() made before the GPU side existed. */
export interface PendingInfluence {
  readonly kind: 'influence' | 'bind';
  /** The handle's id: the GPU side's registry gives the entry the same one. */
  readonly id: number;
  /** addInfluence: the influence; bindElement: the options (without `signal`). */
  readonly init: InfluenceInit | BindElementOptions;
  readonly el: Element | null;
  /**
   * The handle.update() calls made before, folded into one patch (later fields win, see
   * foldUpdate), so a handle updated on every scroll or pointer move during a slow load holds
   * one object; null: none.
   */
  pending: InfluenceUpdate | null;
  disposed: boolean;
  real: InfluenceHandle | null;
}

/** What the GPU side replays when it attaches, in call order. */
export type PendingOp =
  | { readonly kind: 'config'; readonly commit: ConfigCommit }
  | PendingModulator
  | PendingInfluence
  | { readonly kind: 'pulse'; readonly opts: PulseOptions }
  | { readonly kind: 'lift'; readonly opts: LiftOptions }
  | { readonly kind: 'debug'; readonly view: DebugView };

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

/**
 * Folds `patch` into `into` so that applying `into` once does what applying the patches in turn
 * would (InfluenceRegistry#apply): a field given (not undefined) replaces the earlier value.
 */
function foldUpdate(into: InfluenceUpdate, patch: InfluenceUpdate): void {
  // The one coupled field: a color without a mix makes a zero mix visible (0.5), so a zero mix
  // folded in before such a color is what that color turns it into.
  if (patch.color !== undefined && patch.colorMix === undefined && into.colorMix !== undefined) {
    if (Math.max(0, Math.min(1, into.colorMix)) === 0) into.colorMix = 0.5;
  }
  const dst = into as Record<string, unknown>;
  const src = patch as Record<string, unknown>;
  for (const key in src) {
    const v = src[key];
    if (v !== undefined) dst[key] = v;
  }
}

/** A field whose changes tween (see ParamStore): its effective value moves only on frames. */
function tweens(path: string): boolean {
  const f = getField(path) as { live?: string; tween?: string } | undefined;
  return !!f && (f.live === 'uniform' || f.live === 'realloc') && f.tween !== 'none';
}

export class Shell {
  readonly host: HTMLElement;
  readonly config: ConfigState;
  readonly view: HostView;
  /** Every listener and observer of the instance is registered with this signal. */
  readonly ctl = new AbortController();
  /** Creation order (the context budget's tie-break, the look's seeded window shift). */
  readonly order = ++instanceSeq;
  /**
   * Seed of the controller's random generator, drawn from Math.random at construction (where
   * the controller used to draw it), so a page that seeds Math.random around the constructor
   * still gets identical instances whenever their controllers are built.
   */
  readonly seed = (Math.random() * 4294967296) >>> 0;
  /** The GPU side, once its module has loaded (see runtime/loader.ts). */
  live: LiveInstance | null = null;
  destroyed = false;
  running = false;
  /** start() found no WebGL2. */
  noWebgl = false;
  /** The GPU side's module failed to load (or to start): the poster stays. */
  #loadFailed = false;
  /** The GPU side's module was asked for (see connect). */
  #requested = false;
  /**
   * No GPU side will come although start() has not said so yet: the page was known to lack
   * WebGL2 at construction, or this is not a browser (see connect). Unlike noWebgl, the state
   * stays 'pending' and the fallback waits for start().
   */
  #noLive = false;
  fallbackSent = false;
  /** The renderer asked for ('auto' picks `renderer`). */
  mode: RendererMode;
  /** The renderer used, or asked for (the actual one, `Stats.renderer`). */
  renderer: InstanceRenderer;
  /**
   * The renderer listeners last heard of (`renderer` event; the first choice counts as heard).
   * An 'auto' re-choice made while the instance holds nothing is announced only once the new
   * renderer serves it, so a request the budget turns down is never reported.
   */
  announced: InstanceRenderer;
  /** 'auto' made its first choice (the first one emits no 'renderer' event). */
  decided = false;
  /** When the renderer last switched (performance.now(), NaN: never; the 'auto' dwell). */
  switchedAt = Number.NaN;
  priority: InstancePriority;
  /** The look asked for (`look` option, setLook()). */
  look: LookMode;
  /** The window shift asked for (`lookOffset` option, setLook()). */
  lookOffset: number;
  /** Within the view margin (from the view observer; true when there is no observer). */
  inView = true;
  /** Within the creation zone (from the zone observer; true when there is no observer). */
  inZone = true;
  hidden = false;
  lastVisible = Number.NEGATIVE_INFINITY;
  io: IntersectionObserver | null = null;
  zoneIo: IntersectionObserver | null = null;
  #ioMargin = -1;
  /** Host border box, CSS px, as the observers last reported it (see noteHostSize). */
  hostW = 0;
  hostH = 0;
  hostSized = false;
  /** The host size comes from the ResizeObserver (preferred over intersection rects). */
  hostFromRo = false;
  /** `(pointer: coarse)`. */
  readonly coarse: boolean;
  /** The pointer is over the host (any pointer, whatever `interaction` says). */
  pointerInside = false;
  /** The pointer left since the GPU side's last frame. */
  pointerLeft = false;
  readonly stats: Stats;
  /** setEnergy()'s modulator. */
  energy: ModulatorHandle | null = null;
  /** Ordered per-source batches: consecutive calls of one source merge, another starts anew. */
  pending: ConfigBatch[] = [];
  /** Runtime-layer calls and config changes made before the GPU side, in call order. */
  #queue: PendingOp[] = [];
  /** Ids of the influence handles made before the GPU side (its registry continues above). */
  nextInfluenceId = 1;
  #flushQueued = false;
  #reducedMql: MediaQueryList | null = null;
  /** Page-wide visibility and reduced-motion subscriptions (see dom/environment). */
  readonly #unwatchEnv: (() => void)[] = [];
  readonly #listeners = new Map<keyof LumiCellsEvents, Set<Listener<never>>>();

  constructor(host: HTMLElement, options: LumiCellsOptions) {
    this.host = host;
    this.priority = isPriority(options.priority) ? options.priority : 'normal';
    const mode = isRendererMode(options.renderer) ? options.renderer : runtimeSettings().renderer;
    this.mode = mode;
    this.renderer = mode === 'own' ? 'own' : 'shared';
    this.announced = this.renderer;
    this.look = isLookMode(options.look) ? options.look : 'own';
    this.lookOffset = lookOffset(options.lookOffset);
    this.stats = {
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
      renderer: this.renderer,
      rendererMode: mode,
      presentMs: null,
      shared: null,
      reducers: { lite: false, frameDivisor: 1 },
      look: 'own',
      groupSize: 1,
    };
    // Merge order: defaults < preset < config (< the `interactive` shortcut).
    const base: LumiCellsConfigInput = options.preset ? { extends: options.preset } : {};
    let input = options.config ? deepMerge(base, options.config) : base;
    if (options.interactive !== undefined) {
      input = deepMerge(input, {
        interaction: { pointer: options.interactive, click: options.interactive },
      });
    }
    this.config = new ConfigState(input);
    this.config.onCommit = (commit) => this.#record({ kind: 'config', commit });
    const signal = this.ctl.signal;
    this.view = new HostView(host, signal);
    this.view.showPoster(this.config.poster);
    // Hover keeps a shared instance at the full frame rate (whatever `interaction` says): the
    // card under the pointer is the one being looked at.
    const listen = { passive: true, signal } as const;
    const enter = () => {
      this.pointerInside = true;
    };
    const leave = () => {
      this.pointerInside = false;
      this.pointerLeft = true;
    };
    host.addEventListener('pointerenter', enter, listen);
    host.addEventListener('pointerleave', leave, listen);
    host.addEventListener('pointercancel', leave, listen);
    this.coarse = this.view.coarsePointer;
    this.#watchEnvironment();
  }

  get signal(): AbortSignal {
    return this.ctl.signal;
  }

  /**
   * Connects the GPU side: at once when its module has loaded, else once it has (the first
   * instance of the page starts the import, see runtime/loader.ts).
   */
  connect(supported: boolean | undefined): void {
    const mod = liveModule();
    if (mod) {
      this.attach(mod);
      return;
    }
    // Nothing to load for a page known to lack WebGL2, nor outside a browser: nothing is kept
    // for a GPU side either (a paused instance would queue every call forever).
    if (supported === false || typeof window === 'undefined') {
      this.#noLive = true;
      this.#dropQueue();
      return;
    }
    this.#requestLive();
  }

  #requestLive(): void {
    if (this.#requested) return;
    this.#requested = true;
    loadLive().then(
      (mod) => this.attach(mod),
      (err: unknown) => this.#failLoad(err),
    );
  }

  /** The GPU side's module is there: build the GPU side (it replays the queue first). */
  attach(mod: LiveModule): void {
    if (this.live || !this.#queueing) return;
    const queue = this.#queue;
    this.#queue = [];
    this.config.onCommit = null;
    try {
      this.live = new mod.LiveInstance(this, queue);
    } catch (err) {
      this.live = null;
      this.#failLoad(err);
    }
  }

  /** The GPU side could not be loaded: an error, the 'load' fallback, the poster for good. */
  #failLoad(err: unknown): void {
    if (this.live || this.destroyed || this.noWebgl || this.#loadFailed) return;
    this.#loadFailed = true;
    this.#dropQueue();
    this.#publish();
    this.emit('error', err instanceof Error ? err : new Error(String(err)));
    this.sendFallback('load');
  }

  /** No GPU side will come (no WebGL2, failed, destroyed): nothing more is kept for it. */
  #dropQueue(): void {
    for (const op of this.#queue) {
      if (op.kind === 'influence' || op.kind === 'bind') op.pending = null;
    }
    this.#queue = [];
    if (!this.live) this.config.onCommit = null;
  }

  /** Whether calls made now are kept for a GPU side still to come. */
  get #queueing(): boolean {
    return !this.live && !this.destroyed && !this.noWebgl && !this.#loadFailed && !this.#noLive;
  }

  #record(op: PendingOp): void {
    if (this.#queueing) this.#queue.push(op);
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle

  start(supported: boolean): void {
    if (this.destroyed || this.running) return;
    this.running = true;
    if (!supported) {
      this.noWebgl = true;
      this.#dropQueue();
      this.#publish();
      this.sendFallback('no-webgl2');
      return;
    }
    if (this.live) this.live.syncAll();
    else if (this.#queueing) this.#requestLive();
  }

  stop(): void {
    this.running = false;
    if (this.live) this.live.syncAll();
    else this.#publish();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.running = false;
    this.live?.destroy();
    this.#dropQueue();
    // Every listener and observer was registered with this signal (or a per-canvas one), or is
    // one of the page-wide subscriptions and observers below.
    this.ctl.abort();
    for (const off of this.#unwatchEnv) off();
    this.#unwatchEnv.length = 0;
    this.io?.disconnect();
    this.zoneIo?.disconnect();
    this.io = null;
    this.zoneIo = null;
    this.energy = null;
    this.view.restore();
    this.#publish();
    this.emit('destroy', undefined);
    this.#listeners.clear();
    this.pending.length = 0;
  }

  // -------------------------------------------------------------------------------------------
  // State and events

  /** After every change of the GPU side: the state (and, with a GPU side, what follows it). */
  #publish(): void {
    const live = this.live;
    if (live) {
      live.publishState();
      return;
    }
    const s = this.stats;
    s.state = this.#computeState();
    s.renderer = this.renderer;
    s.rendererMode = this.mode;
  }

  /** The state without a GPU side (see LiveInstance for the others). */
  #computeState(): InstanceState {
    if (this.destroyed) return 'destroyed';
    if (this.noWebgl || this.#loadFailed) return 'failed';
    return 'pending';
  }

  on<K extends keyof LumiCellsEvents>(type: K, fn: Listener<K>): () => void {
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

  hasListeners(type: keyof LumiCellsEvents): boolean {
    return (this.#listeners.get(type)?.size ?? 0) > 0;
  }

  emit<K extends keyof LumiCellsEvents>(type: K, event: LumiCellsEvents[K]): void {
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

  sendFallback(reason: LumiCellsEvents['fallback']['reason']): void {
    if (this.fallbackSent && reason !== 'context-lost') return;
    this.fallbackSent = true;
    // Deferred: listeners attached right after construction still receive it.
    queueMicrotask(() => {
      if (!this.destroyed) this.emit('fallback', { reason });
    });
  }

  /**
   * Tells listeners about the current renderer when it differs from the one they last heard of
   * (a fallback back to that one, e.g. shared to own refused to shared, reports nothing).
   */
  announce(reason: RendererChangeReason): void {
    const renderer = this.renderer;
    const previous = this.announced;
    if (renderer === previous) return;
    this.announced = renderer;
    // Deferred: switches run inside scheduler passes and frame phases, listeners must not
    // re-enter them.
    queueMicrotask(() => {
      if (!this.destroyed) this.emit('renderer', { renderer, previous, reason });
    });
  }

  // -------------------------------------------------------------------------------------------
  // Renderer and look before the GPU side (it takes over from these values)

  /** setRenderer() without a GPU side: nothing to release, the switch is immediate. */
  setRendererEarly(mode: RendererMode): void {
    this.mode = mode;
    if (mode === 'auto') {
      // A flexible budget member from now on.
      this.decided = true;
      this.switchedAt = performance.now();
      this.#publish();
      return;
    }
    if (mode === this.renderer) {
      this.#publish();
      // An 'auto' re-choice not announced yet is now an explicit one.
      this.announce('explicit');
      return;
    }
    this.renderer = mode;
    this.#noteSwitchEarly();
  }

  /** setLook() without a GPU side: an 'auto' instance asked for its own context goes shared. */
  setLookEarly(changed: boolean): void {
    if (changed && this.mode === 'auto' && this.look === 'shared' && this.renderer === 'own') {
      this.renderer = 'shared';
      this.#noteSwitchEarly();
      return;
    }
    this.#publish();
  }

  #noteSwitchEarly(): void {
    this.decided = true;
    this.switchedAt = performance.now();
    this.#publish();
    this.announce('explicit');
  }

  // -------------------------------------------------------------------------------------------
  // Config

  afterConfig(changed: ParamPath[], source: ConfigSource = 'api'): void {
    if (changed.length === 0) return;
    const cfg = this.config.config;
    let overflow = false;
    let render = false;
    let interaction = false;
    // One event per source, in call order: an echo filter (`source === mine`) must never drop
    // another source's changes. Consecutive calls of one source still coalesce.
    const pending = this.pending;
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
    const live = this.live;
    if (overflow) {
      if (live) live.overflowChanged();
      else this.view.setOverflow(cfg.render.overflow);
      this.#observeInView();
    }
    if (render) this.#applyReducedMotion();
    live?.afterConfig(render, overflow, interaction);
    if (this.view.posterVisible) this.view.showPoster(this.config.poster);
    if (!live?.subscribed) this.queueFlush();
  }

  queueFlush(): void {
    if (this.#flushQueued) return;
    this.#flushQueued = true;
    queueMicrotask(() => {
      this.#flushQueued = false;
      if (!this.live?.subscribed) this.flushConfig();
    });
  }

  flushConfig(): void {
    if (this.pending.length === 0 || this.destroyed) return;
    const batches = this.pending;
    this.pending = [];
    const config = this.config.config;
    for (const b of batches) {
      if (this.destroyed) return;
      this.emit('config', { config, changed: [...b.paths], source: b.source });
    }
  }

  /**
   * getEffective() without a GPU side: the value its parameter store would hold, i.e. the first
   * config's, then every later change's unless that change tweens (a tween only moves on frames,
   * and none was drawn yet). Modulators act on frames too.
   */
  effectiveEarly(path: ModulatablePath): number {
    const st = this.config;
    if (!this.#queueing) return getPath(st.config, path) as number;
    let v = getPath(st.initial, path);
    for (const op of this.#queue) {
      if (op.kind !== 'config' || !op.commit.changed.includes(path)) continue;
      if (!tweens(path) || !(op.commit.transition > 0)) v = getPath(op.commit.next, path);
    }
    return v as number;
  }

  // -------------------------------------------------------------------------------------------
  // Runtime layers before the GPU side (see PendingOp)

  modulateEarly(
    path: ModulatablePath,
    source: ModulationSource,
    opts: ModulateOptions,
  ): ModulatorHandle {
    const op: PendingModulator = {
      kind: 'modulate',
      path,
      source,
      opts: { blend: opts.blend, smoothingMs: opts.smoothingMs },
      disposed: false,
      real: null,
    };
    this.#record(op);
    const signal = opts.signal;
    const dispose = () => {
      if (op.disposed) return;
      op.disposed = true;
      signal?.removeEventListener('abort', dispose);
      op.real?.dispose();
    };
    if (signal) {
      if (signal.aborted) dispose();
      else signal.addEventListener('abort', dispose, { once: true });
    }
    return {
      set: (v: number) => {
        if (op.disposed) return;
        if (op.real) op.real.set(v);
        else op.source = v;
      },
      dispose,
      [Symbol.dispose]: dispose,
    };
  }

  influenceEarly(
    kind: PendingInfluence['kind'],
    el: Element | null,
    init: InfluenceInit | BindElementOptions,
    signal: AbortSignal | undefined,
  ): InfluenceHandle {
    const op: PendingInfluence = {
      kind,
      id: this.nextInfluenceId++,
      init,
      el,
      pending: null,
      disposed: false,
      real: null,
    };
    this.#record(op);
    const shell = this;
    const dispose = () => {
      if (op.disposed) return;
      op.disposed = true;
      signal?.removeEventListener('abort', dispose);
      op.pending = null;
      op.real?.dispose();
    };
    if (signal) {
      if (signal.aborted) dispose();
      else signal.addEventListener('abort', dispose, { once: true });
    }
    return {
      id: op.id,
      get active() {
        return op.real?.active ?? false;
      },
      update(patch: InfluenceUpdate) {
        if (op.disposed) return;
        if (op.real) {
          op.real.update(patch);
          return;
        }
        // Kept only while a GPU side can still come (else nothing would ever take it).
        if (!shell.#queueing) return;
        if (op.pending) foldUpdate(op.pending, patch);
        else op.pending = { ...patch };
      },
      dispose,
      [Symbol.dispose]: dispose,
    };
  }

  pulseEarly(opts: PulseOptions): void {
    this.#record({ kind: 'pulse', opts: { ...opts } });
  }

  /** lift() without a GPU side: ignored under reduced motion, like the controller does. */
  liftEarly(opts: LiftOptions): void {
    if (this.reducedOn()) return;
    this.#record({ kind: 'lift', opts: { ...opts } });
  }

  debugViewEarly(view: DebugView): void {
    this.#record({ kind: 'debug', view });
  }

  // -------------------------------------------------------------------------------------------
  // Page signals and placement

  /** Reduced motion is in effect (render.reducedMotion 'respect' and the OS setting). */
  reducedOn(): boolean {
    return this.config.config.render.reducedMotion === 'respect' && !!this.#reducedMql?.matches;
  }

  #applyReducedMotion(): void {
    const on = this.reducedOn();
    const live = this.live;
    if (live) {
      live.setReducedMotion(on);
    } else if (on) {
      // Reduced motion turns every lift off, the queued ones included (see Controller).
      this.#queue = this.#queue.filter((op) => op.kind !== 'lift');
    }
  }

  /**
   * The display may have changed (DPR change, resume from a hidden tab): a calibration measures
   * the refresh rate again (and the GPU side forgets what it learned).
   */
  relearnDisplay(): void {
    if (this.live) this.live.relearnDisplay();
    else requestDisplayCalibration();
  }

  /** Host size from an observer: the ResizeObserver's border box wins over intersection rects. */
  noteHostSize(w: number, h: number, fromRo: boolean): void {
    if (!fromRo && this.hostFromRo) return;
    this.hostW = w > 0 ? w : 0;
    this.hostH = h > 0 ? h : 0;
    this.hostSized = true;
  }

  #watchEnvironment(): void {
    const doc = this.host.ownerDocument;
    const win = doc.defaultView;
    if (!win) return;
    this.hidden = doc.visibilityState === 'hidden';
    this.#unwatchEnv.push(
      watchVisibility(doc, () => {
        const wasHidden = this.hidden;
        this.hidden = doc.visibilityState === 'hidden';
        // OS power modes (low-power, energy saver) and displays may have changed meanwhile:
        // re-learn the refresh rate instead of trusting the sticky estimate.
        if (wasHidden && !this.hidden) this.relearnDisplay();
        this.live?.updateSubscription();
      }),
    );
    if (typeof win.matchMedia === 'function') {
      this.#reducedMql = reducedMotionQuery(win);
      this.#unwatchEnv.push(watchReducedMotion(win, () => this.#applyReducedMotion()));
    }
    if (typeof win.IntersectionObserver === 'function') {
      // Unknown until the observers report (right after the first frame): nothing is created
      // before that, so a page that mounts many instances off screen creates no context.
      this.inView = false;
      this.inZone = false;
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
        if (io !== this.zoneIo || this.destroyed) return;
        const e = entries[entries.length - 1];
        if (!e) return;
        this.inZone = e.isIntersecting;
        const r = e.boundingClientRect;
        if (r) this.noteHostSize(r.width, r.height, false);
        this.live?.onPlacement();
      },
      ZONE_MARGIN,
    );
    this.zoneIo = io;
    io.observe(this.host);
  }

  /**
   * Offscreen pause. The canvas reaches `render.overflow` px beyond the host on every side, so
   * the margin grows with it: a visible strip of canvas must never freeze. Rebuilt when the
   * overflow changes.
   */
  #observeInView(): void {
    if (this.destroyed) return;
    const win = this.host.ownerDocument.defaultView;
    if (!win || typeof win.IntersectionObserver !== 'function') return;
    const margin = IO_MARGIN + Math.max(0, this.config.config.render.overflow);
    if (margin === this.#ioMargin && this.io) return;
    this.#ioMargin = margin;
    this.io?.disconnect();
    const io = marginObserver(
      win,
      (entries) => {
        if (io !== this.io || this.destroyed) return;
        const e = entries[entries.length - 1];
        if (!e) return;
        const r = e.boundingClientRect;
        if (r) this.noteHostSize(r.width, r.height, false);
        const was = this.inView;
        this.inView = e.isIntersecting;
        if (was && !this.inView) this.lastVisible = performance.now();
        this.live?.onPlacement();
      },
      `${margin}px`,
    );
    this.io = io;
    io.observe(this.host);
  }
}
