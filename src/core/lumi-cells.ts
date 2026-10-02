/**
 * LumiCells facade: the only class consumers construct.
 *
 * The instance comes in two halves. The facade and its shell (shell.ts) are eager and small: the
 * API, the config layer (normalization, `config` events, the CSS poster), the host view, the page
 * signals and the observers that say where the host is, and the instance's side of the context
 * budget's settings. The GPU side (runtime/live.ts: the pure Controller with its config layers,
 * tweens, influences, lifts and adaptive quality, element tracking, the pointer, the engines,
 * the shared renderer and look groups) is a chunk of its own, loaded on demand
 * (runtime/loader.ts): the first instance constructed in a browser starts the import, so it
 * downloads while the poster shows and the observers report; every later instance gets its GPU
 * side at once. Calls made before it is there are kept in call order and replayed (see Shell),
 * so the API behaves as if it had always been there: the constructor is synchronous, the config
 * API works from the first line, handles are returned at once and forward once it is there.
 * If the chunk fails to load (network), the instance reports 'error' and the 'load' fallback
 * and keeps its poster, and so does every instance constructed later: the browser keeps the
 * failed import until the page is reloaded (see runtime/loader.ts).
 *
 * Lifecycle of the GPU side (see runtime/live.ts for the details): start() creates nothing on
 * the GPU. Once the host comes within about one viewport of the screen, the instance asks the
 * page-wide GPU scheduler (runtime/scheduler) for a context, or the shared renderer for a seat
 * (`renderer`: 'own', 'shared' or 'auto', the default, which chooses by size); 'ready' fires
 * after the first drawn frame, the CSS poster covers the gap and the canvas stays hidden until it
 * has drawn. Instances far from the viewport for `parkAfterMs` are parked (context released,
 * poster shown, everything else kept); lost contexts are rebuilt on restore.
 * destroy() is synchronous, idempotent and total; destroyed before the chunk arrived, the
 * instance never gets a GPU side.
 */

import {
  type LumiCellsConfig,
  type LumiCellsConfigFile,
  type LumiCellsConfigInput,
  type ParamPath,
  type ParamValue,
  type PresetId,
  setPath,
  toConfigFile,
} from '../schema';
import type { InfluenceInit } from './controller/influences';
import { isLookMode, isPriority, lookOffset } from './options';
import { liveModule, loadLive, offerPacer } from './runtime/loader';
import { applySettings, isRendererMode, runtimeSettings } from './runtime/settings';
import { Shell } from './shell';
import { statsCopy } from './stats';
import type {
  BindElementOptions,
  ConfigUpdateOptions,
  ConfigureOptions,
  DebugView,
  InfluenceHandle,
  InfluenceOptions,
  InstancePriority,
  InstanceRenderer,
  LiftOptions,
  LookMode,
  LumiCellsEvents,
  LumiCellsOptions,
  ModulatablePath,
  ModulateOptions,
  ModulationSource,
  ModulatorHandle,
  PulseOptions,
  RendererMode,
  Stats,
} from './types';

type Listener<K extends keyof LumiCellsEvents> = (event: LumiCellsEvents[K]) => void;

let supportedMemo: boolean | undefined;

export class LumiCells {
  /**
   * Starts downloading the engine's chunk now instead of at the first instance's construction.
   * On a first visit over a network the first animated frame otherwise comes about one round
   * trip later than with a single bundle (the chunk is requested only once the app's own code
   * runs and constructs an instance); call this from the app's entry, or add a
   * `<link rel="modulepreload">` for the chunk, to overlap the two. `lumicells/element/define`
   * and the React component call it themselves. Idempotent; a no-op on the server, on a page
   * known to lack WebGL2 and once the chunk is there. A failed download is reported by the
   * instances (`error`, then the `'load'` fallback) and lasts for the page's lifetime.
   */
  static preload(): void {
    if (supportedMemo === false || typeof window === 'undefined' || liveModule()) return;
    loadLive().catch(() => {});
  }

  /**
   * Page-wide settings shared by every instance: the WebGL context budget, parking of offscreen
   * instances, the engine creation rate, the shared atlas budget, the default renderer and the
   * `auto` promotion threshold (see ConfigureOptions). Applies to existing instances too, except
   * `renderer` (the default of instances created afterwards); safe to call before any instance
   * exists and on the server.
   */
  static configure(options: ConfigureOptions): void {
    const area = runtimeSettings().promoteArea;
    const change = applySettings(options);
    // Without the GPU side nothing holds or waits for a context yet: it reads the settings when
    // it starts.
    const live = liveModule();
    if (!live) return;
    live.settingsApplied(change);
    if (runtimeSettings().promoteArea !== area) live.promoteAreaChanged();
  }

  /** Whether WebGL2 is available. Memoized; always false on the server. */
  static isSupported(): boolean {
    if (supportedMemo !== undefined) return supportedMemo;
    if (typeof document === 'undefined') return false;
    try {
      const probe = document.createElement('canvas');
      probe.width = 1;
      probe.height = 1;
      const gl = probe.getContext('webgl2');
      supportedMemo = !!gl;
      // Lost once it has paced the page's first context creation (see engine/warmup.ts).
      if (gl) offerPacer(gl, () => gl.getExtension('WEBGL_lose_context')?.loseContext());
    } catch {
      supportedMemo = false;
    }
    return supportedMemo;
  }

  readonly host: HTMLElement;
  readonly #s: Shell;

  constructor(host: HTMLElement, options: LumiCellsOptions = {}) {
    this.host = host;
    const s = new Shell(host, options);
    this.#s = s;
    // The GPU side's chunk starts loading now, unless the page is known to lack WebGL2: ahead of
    // the support probe in start() (on a first visit the probe waits for the GPU process for a
    // while), so it downloads meanwhile, and while the poster shows and the observers report.
    s.connect(supportedMemo);
    if (options.autoStart !== false) this.start();
  }

  get destroyed(): boolean {
    return this.#s.destroyed;
  }

  get supported(): boolean {
    return LumiCells.isSupported();
  }

  /**
   * The canvas of this instance. On the own renderer the WebGL canvas (a new element per
   * engine), null until the instance owns a WebGL context (see `getStats().state`) and while it
   * is parked. On the shared renderer the 2D canvas the shared renderer copies into, null until
   * the instance first gets its slot; while parked it stays in the host at 0x0. A renderer switch
   * gives it a new canvas. Null after destroy.
   */
  get canvas(): HTMLCanvasElement | null {
    return this.#s.view.canvas;
  }

  /**
   * The renderer this instance uses, or is about to use (`Stats.renderer`). With
   * `renderer: 'auto'` it changes over time (see the `renderer` event).
   */
  get renderer(): InstanceRenderer {
    return this.#s.renderer;
  }

  /** The renderer this instance asks for (`LumiCellsOptions.renderer`, `setRenderer()`). */
  get rendererMode(): RendererMode {
    return this.#s.mode;
  }

  /**
   * Changes the renderer the instance asks for. `'own'` or `'shared'` other than the current one
   * switches now: the current GPU side is released and the instance asks the other renderer (the
   * poster shows in between, usually for a frame or two); config, time and runtime layers are
   * kept, the Life automaton reseeds. `'auto'` keeps the current renderer and lets the policy
   * take over from there (a switch waits the usual dwell). Emits `renderer` when the renderer
   * changes.
   */
  setRenderer(mode: RendererMode): void {
    const s = this.#s;
    if (s.destroyed || !isRendererMode(mode) || mode === s.mode) return;
    if (s.live) s.live.setRenderer(mode);
    else s.setRendererEarly(mode);
  }

  /** Priority for the page's WebGL context budget. */
  get priority(): InstancePriority {
    return this.#s.priority;
  }

  /** Changes the budget priority; a waiting instance may get a context right away. */
  setPriority(priority: InstancePriority): void {
    const s = this.#s;
    if (s.destroyed || !isPriority(priority) || priority === s.priority) return;
    s.priority = priority;
    // Only an instance with a GPU side can be queued for a context.
    if (s.live) liveModule()?.rankChanged();
  }

  /** The look asked for (`LumiCellsOptions.look`, `setLook()`); what it shows is `getStats().look`. */
  get look(): LookMode {
    return this.#s.look;
  }

  /** The window shift asked for (`LumiCellsOptions.lookOffset`). */
  get lookOffset(): number {
    return this.#s.lookOffset;
  }

  /**
   * Changes the look (see LookMode). `'own'` leaves the group now: the picture continues as the
   * instance's own (clock and lifted cells taken over, the Life automaton reseeds). `'shared'`
   * lets the instance join a group of cards that draw the same picture at its next frame (it
   * must draw nothing of its own); an `auto` instance on a context of its own first moves to the
   * shared renderer (after its next frame, which stays on screen; the `renderer` event reports it
   * with reason `'explicit'`). `offset`: a new `lookOffset` (kept when omitted). Emits `look`
   * when what the instance shows changes.
   */
  setLook(look: LookMode, offset?: number): void {
    const s = this.#s;
    if (s.destroyed || !isLookMode(look)) return;
    const off = offset === undefined ? s.lookOffset : lookOffset(offset);
    if (look === s.look && off === s.lookOffset) return;
    const changed = look !== s.look;
    const refit = off !== s.lookOffset;
    s.look = look;
    s.lookOffset = off;
    if (s.live) s.live.lookChanged(changed, refit);
    else s.setLookEarly(changed);
  }

  // -------------------------------------------------------------------------------------------
  // Config

  getConfig(): Readonly<LumiCellsConfig> {
    return this.#s.config.config;
  }

  setConfig(patch: LumiCellsConfigInput, opts: ConfigUpdateOptions = {}): void {
    const s = this.#s;
    if (s.destroyed) return;
    s.afterConfig(s.config.setConfig(patch, opts.transition), opts.source);
  }

  replaceConfig(config: LumiCellsConfigInput, opts: ConfigUpdateOptions = {}): void {
    const s = this.#s;
    if (s.destroyed) return;
    s.afterConfig(s.config.replaceConfig(config, opts.transition), opts.source);
  }

  set<P extends ParamPath>(path: P, value: ParamValue<P>, opts: ConfigUpdateOptions = {}): void {
    if (this.#s.destroyed) return;
    this.setConfig(setPath({}, path, value) as LumiCellsConfigInput, opts);
  }

  get<P extends ParamPath>(path: P): ParamValue<P> {
    let cur: unknown = this.#s.config.config;
    for (const key of path.split('.')) cur = (cur as Record<string, unknown>)[key];
    return cur as ParamValue<P>;
  }

  /** Current value after tweening and modulation. */
  getEffective(path: ModulatablePath): number {
    const s = this.#s;
    return s.live ? s.live.getEffective(path) : s.effectiveEarly(path);
  }

  exportConfig(
    opts: { mode?: 'full' | 'diff'; base?: 'defaults' | PresetId } = {},
  ): LumiCellsConfigFile {
    return toConfigFile(this.#s.config.config, opts);
  }

  // -------------------------------------------------------------------------------------------
  // Runtime layers

  modulate(
    path: ModulatablePath,
    source: ModulationSource,
    opts: ModulateOptions = {},
  ): ModulatorHandle {
    const s = this.#s;
    if (s.destroyed) return deadModulator();
    return s.live ? s.live.modulate(path, source, opts) : s.modulateEarly(path, source, opts);
  }

  addInfluence(opts: InfluenceOptions): InfluenceHandle {
    const s = this.#s;
    if (s.destroyed) return deadInfluence();
    const { signal, ...init } = opts;
    if (s.live) return s.live.addInfluence(init as InfluenceInit, signal);
    return s.influenceEarly('influence', null, init as InfluenceInit, signal);
  }

  bindElement(el: Element, opts: BindElementOptions = {}): InfluenceHandle {
    const s = this.#s;
    if (s.destroyed) return deadInfluence();
    if (s.live) return s.live.bindElement(el, opts);
    const { signal, ...rest } = opts;
    return s.influenceEarly('bind', el, rest, signal);
  }

  pulse(opts: PulseOptions): void {
    const s = this.#s;
    if (s.destroyed) return;
    if (s.live) s.live.pulse(opts);
    else s.pulseEarly(opts);
  }

  /**
   * Lifts cells around a point. Respects the user's accessibility preference: with
   * `render.reducedMotion: 'respect'` and the OS "reduce motion" setting on, every lift is off
   * (random ones, pointer hover and explicit lift() calls alike), so this is a no-op then.
   */
  lift(opts: LiftOptions): void {
    const s = this.#s;
    if (s.destroyed) return;
    if (s.live) s.live.lift(opts);
    else s.liftEarly(opts);
  }

  /** External drive of the whole field (0..3): sugar for an override modulator on animation.energy. */
  setEnergy(value: number): void {
    const s = this.#s;
    if (s.destroyed) return;
    if (!s.energy) {
      s.energy = this.modulate('animation.energy', value, { blend: 'override' });
    } else {
      s.energy.set(value);
    }
  }

  setDebugView(view: DebugView): void {
    const s = this.#s;
    if (s.destroyed) return;
    if (s.live) s.live.setDebugView(view);
    else s.debugViewEarly(view);
  }

  // -------------------------------------------------------------------------------------------
  // Events

  on<K extends keyof LumiCellsEvents>(type: K, fn: Listener<K>): () => void {
    if (this.#s.destroyed) return () => {};
    return this.#s.on(type, fn);
  }

  getStats(): Stats {
    const s = this.#s;
    return statsCopy(s.stats, s.live?.groupSize ?? 1);
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle

  /**
   * Starts rendering. The WebGL context is not created here: the instance asks the page's GPU
   * scheduler for one once the host is near the viewport (see LumiCells.configure).
   */
  start(): void {
    const s = this.#s;
    if (s.destroyed || s.running) return;
    s.start(this.supported);
  }

  /** Stops rendering. An existing context is kept (the canvas keeps its last frame). */
  stop(): void {
    this.#s.stop();
  }

  destroy(): void {
    this.#s.destroy();
  }

  /**
   * Simulates a context loss (and the browser's restore ~0.5 s later) to test recovery. On a
   * shared instance it loses the shared context: every shared instance on the page is affected.
   */
  loseContextForTesting(): void {
    if (this.#s.destroyed) return;
    this.#s.live?.loseContextForTesting();
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
