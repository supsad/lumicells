/**
 * The GPU side of a LumiCells instance: everything that only matters once the instance draws, in
 * a chunk of its own that the facade loads on demand (see runtime/loader.ts and shell.ts). It
 * attaches to its instance's Shell (the eager half: config, poster, observers, events, the
 * observable state) and replays what was called before it existed.
 *
 * It wires the pure Controller (config layers, tweens, influences, lifts, adaptive quality) to
 * the DOM (host sizing, element tracking, pointer) and to the GL Engine, all driven by the shared
 * ticker: DOM reads in the measure phase, GPU work in the render phase.
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
 *
 * 'auto' (the default) chooses between the two by size (runtime/auto-renderer): the choice is
 * made when the instance first asks for a GPU side, from the host size its observers reported,
 * with no dwell. Afterwards a ResizeObserver on the host, viewport and DPR changes and config
 * changes re-evaluate it; a switch waits until the size held still for the dwell. An 'auto'
 * instance is a flexible client of the context budget: a refused request for its own context
 * falls back to the shared renderer, an evicted one moves there, and a large instance on the
 * shared renderer stays queued in the scheduler as a candidate (standby) until a slot frees up.
 * Switches reuse the explicit switch (release one side, ask the other) but keep the last frame on
 * screen until the new renderer draws: the 2D canvas itself (shared to own), or a 2D copy of the
 * WebGL canvas taken right after it drew (own to shared, so a size demotion runs in the render
 * phase).
 * Cost reducers: a shared instance that is not active (pointer over the host, or a change of
 * its own within ACTIVE_MS, see Controller.takeActivity) may present on every n-th frame only,
 * as the shared renderer decides each frame (SharedSeat.divisor and phase); skipped frames
 * accumulate their time, so the animation runs on and only fewer frames are shown. It may also
 * draw with the lite pipeline (FrameInputs.lite), which an own instance uses only at the 'low'
 * adaptive tier. The display refresh calibration (runtime/display) may hold every instance's GL
 * work for a few frames at page start and after the page comes back from a hidden tab.
 * Shared look (`look: 'shared'`, runtime/look): a shared instance whose config key matches and that
 * draws nothing of its own (Controller.hasLayers) joins a look group in its render phase. A member
 * is paced like any shared instance (render.maxFps, its secondary rate and phase) but does not
 * update its own controller: on its frames the group's picture is advanced to the frame (once,
 * by the first member presenting in it) and a crop of the group's region is copied into its 2D
 * canvas. It leaves in the render phase of the first frame with something of its own (or at once
 * on setLook('own')), taking over the group's picture state (Controller.adoptLook) so its own
 * frames continue the picture, and rejoins after LOOK_REJOIN_MS without activity and without a
 * layer of its own. A seat that
 * shows nothing of its own picture yet (fresh, or emptied while away) joins at once. 'auto' keeps
 * a look instance on the shared renderer.
 */

import type { ModulatablePath } from '../../schema';
import { Controller, type ControllerInfluenceHandle } from '../controller/controller';
import type { InfluenceInit } from '../controller/influences';
import type { HostView } from '../dom/host';
import { PointerInteraction } from '../dom/pointer';
import { ElementTracker } from '../dom/tracking';
import { viewportSize, watchViewport } from '../dom/viewport';
import { Engine } from '../engine/engine';
import { DEBUG_VIEW, EngineError } from '../engine/types';
import type { PendingOp, Shell } from '../shell';
import { statsCopy } from '../stats';
import {
  frameLateMs,
  frameNow,
  frameSerial,
  frameWorkMs,
  noteGpuWork,
  subscribeTicker,
} from '../ticker';
import type {
  BindElementOptions,
  DebugView,
  InfluenceHandle,
  InfluenceUpdate,
  InstanceLook,
  InstanceRenderer,
  InstanceState,
  LiftOptions,
  LookChangeReason,
  LumiCellsEvents,
  ModulateOptions,
  ModulationSource,
  ModulatorHandle,
  PulseOptions,
  QualityTier,
  RendererChangeReason,
  RendererMode,
  SharedRendererStats,
  Stats,
} from '../types';
import { AutoDwell, type AutoSize, autoScore, autoWants } from './auto-renderer';
import { areaBucket } from './context-budget';
import {
  calibrationHold,
  displayEpoch,
  displayIntervalMs,
  requestDisplayCalibration,
} from './display';
import { type LookGroup, type LookSpec, lookShift } from './look';
import {
  cancelRequest,
  claimBudgetWarning,
  type GpuClient,
  maxContexts,
  noteFirstDraw,
  rankChanged,
  releaseContext,
  requestContext,
  runtimeSettings,
  watchSettings,
} from './scheduler';
import {
  getSharedRenderer,
  peekSharedRenderer,
  type SharedClient,
  type SharedSeat,
} from './shared-renderer';

const COARSE_MAX_PIXELS = 2.4;
const SOFTWARE_MAX_PIXELS = 0.5;
const STATS_INTERVAL = 250;
const RESIZE_THROTTLE = 100;
/** An instance stays active (full frame rate on the shared renderer) this long after a change, ms. */
const ACTIVE_MS = 1000;
/** Longest animation step of one frame, ms (longer gaps are stalls, not frames to catch up). */
const MAX_STEP_MS = 100;
/**
 * A look instance that drew on its own rejoins a group only after this long without activity (see
 * #isActive) and without a layer of its own (#layersAt): a hovered card does not flip back and
 * forth as the pointer comes and goes, and a long layer (a debug view, a pulse, a held lift) is
 * followed by the same calm as a short one.
 */
const LOOK_REJOIN_MS = 2000;

// What the eager half (LumiCells.configure(), setPriority(), the support probe) reaches through
// this module once it has loaded.
export { adoptPacer } from '../engine/warmup';
export { rankChanged, settingsApplied } from './scheduler';

/** Instances in 'auto' mode: they re-evaluate when LumiCells.configure() changes promoteArea. */
const autoLives = new Set<LiveInstance>();

/** LumiCells.configure() changed `promoteArea`: every 'auto' instance re-evaluates its renderer. */
export function promoteAreaChanged(): void {
  for (const live of Array.from(autoLives)) live.autoCheck();
}

export class LiveInstance {
  readonly #s: Shell;
  readonly #host: HTMLElement;
  readonly #view: HostView;
  readonly #stats: Stats;
  /** Set first thing in destroy() (the shell is destroyed at the same moment). */
  #dead = false;
  readonly #controller: Controller;
  readonly #tracker: ElementTracker;
  readonly #pointer: PointerInteraction;
  #engine: Engine | null = null;
  /** Context alpha attribute of the current canvas (null before the first engine). */
  #engineOpaque: boolean | null = null;
  /** 'auto' on the shared renderer: queued in the scheduler for a context of its own. */
  #standby = false;
  /** 'auto': a size demotion waits for the next drawn frame (see #render). */
  #demoteDue = false;
  readonly #dwell = new AutoDwell();
  #autoTimer: ReturnType<typeof setTimeout> | 0 = 0;
  #unwatchViewport: (() => void) | null = null;
  readonly #autoSize: AutoSize = {
    cssW: 0,
    cssH: 0,
    overflow: 0,
    dpr: 1,
    maxPixels: 0,
    viewportW: 0,
    viewportH: 0,
  };
  /** Timestamp of the frame the own engine last drew (a stand-in copy is valid only then). */
  #drawnAt = Number.NaN;
  /** Pixel cap of the device (coarse pointer, software GL), megapixels. */
  #pixelCap = Number.POSITIVE_INFINITY;
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
  /** Frame timestamp of the last change of the instance's own (see Controller.takeActivity). */
  #activeAt = Number.NEGATIVE_INFINITY;
  /**
   * Last frame timestamp in which a `look: 'shared'` instance had a layer of its own
   * (Controller.hasLayers: a debug view, a pulse, a forced lift, a fading influence...).
   */
  #layersAt = Number.NEGATIVE_INFINITY;
  /** The shared renderer's figures as of the last stats update (`Stats.shared`). */
  #sharedStats: SharedRendererStats | null = null;
  /** What the instance shows, as listeners last heard it (`Stats.look`, the `look` event). */
  #lookShown: InstanceLook = 'own';
  /**
   * The canvas shows nothing of this instance's own picture (fresh seat, or emptied while away):
   * joining a group changes nothing on screen, so it may join at once.
   */
  #lookFresh = true;
  /** The controller's look key when the instance joined (a new key object means a new config). */
  #lookKey: string | null = null;
  /** What the instance shares with (see LookSpec): kept up to date while it is a member. */
  readonly #lookSpec: LookSpec;
  /** The group's quality epoch the instance last reported (its 'quality' event while a member). */
  #lookQuality = 0;
  /**
   * Tier and scale of the last 'quality' event (null: none yet, the own controller's start
   * values stand): joining or leaving a group at another tier reports the change.
   */
  #reportedQuality: QualityTier | null = null;
  #reportedScale = 1;
  /** The window shift changed: a member checks whether its group still fits it. */
  #lookRefit = false;
  /** 'auto': why a pending switch to the shared renderer happens (see #demoteDue). */
  #demoteReason: RendererChangeReason = 'demote';
  #unwatchSettings: (() => void) | null = null;
  #hookedCanvas: HTMLCanvasElement | null = null;
  /** Lifetime of the context listeners of #hookedCanvas (aborted when that canvas is dropped). */
  #canvasCtl: AbortController | null = null;
  #unsub: (() => void) | null = null;
  #lost = false;
  /**
   * The context was lost and then dropped (parked, evicted, canvas rebuilt) before the browser
   * restored it: the next engine built emits the 'contextrestored' that ends the loss.
   */
  #lostPending = false;
  #failed = false;
  // Context budget (runtime/scheduler): this instance's side of it.
  readonly #client: GpuClient;
  /** Host area, CSS px squared, read right before a ranking decision (see #refreshArea). */
  #area = 0;
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
  #readyEmitted = false;
  #drawnSinceMount = false;
  /** Frames the engine drew into its canvas while it was still hidden (see #render). */
  #hiddenDraws = 0;
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
  #restoreTimer: ReturnType<typeof setTimeout> | 0 = 0;
  readonly #origin = [Number.NaN, Number.NaN];
  readonly #frameEvent = { time: 0, dt: 0 };
  readonly #tick = {
    measure: (now: number) => this.#measure(now),
    render: (now: number) => this.#render(now),
  };

  /**
   * Builds the GPU side of the instance `s`, then replays `queue` (what was called before it
   * existed, in call order) and, when the instance is running, asks for a context.
   */
  constructor(s: Shell, queue: readonly PendingOp[]) {
    this.#s = s;
    this.#host = s.host;
    this.#view = s.view;
    this.#stats = s.stats;
    const self = this;
    this.#client = {
      order: s.order,
      // An instance that never pauses offscreen draws wherever it is (a capture or copy
      // source placed off screen): it ranks like a visible one, never as the first victim.
      get visible() {
        return s.inView || self.#alwaysOn();
      },
      get inZone() {
        return s.inZone || s.inView;
      },
      get priority() {
        return s.priority;
      },
      get area() {
        return self.#area;
      },
      get lastVisible() {
        return s.lastVisible;
      },
      get flexible() {
        return s.mode === 'auto';
      },
      granted: () => this.#onGranted(),
      evicted: () => this.#onEvicted(),
      refused: () => this.#onRefused(),
      refreshArea: () => this.#refreshArea(),
      settingsChanged: () => this.#onSettingsChanged(),
    };
    this.#sharedClient = {
      order: s.order,
      get visible() {
        return self.#client.visible;
      },
      get inZone() {
        return self.#client.inZone;
      },
      get priority() {
        return s.priority;
      },
      get area() {
        return self.#area;
      },
      get lastVisible() {
        return s.lastVisible;
      },
      get active() {
        return self.#isActive();
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
      get lookCandidate() {
        return s.look === 'shared' && !self.#controller.hasLayers;
      },
    };
    // Starts from the instance's first config; the changes made since are replayed below.
    const c = new Controller({
      state: s.config,
      seed: s.seed,
      onWarn: (code, message) => s.emit('warn', { code, message }),
    });
    this.#controller = c;
    // A tween that turns a field feature on (a mode, the noise mapping, the warp) starts once the
    // renderer can draw it (its field variant is ready): own engine, else the shared seat's slot.
    c.setFieldGate((pending) => {
      const engine = this.#engine;
      if (engine) return engine.fieldReady(pending);
      return this.#seat?.slot?.fieldReady(pending) ?? true;
    });
    this.#lookSpec = {
      hostW: 0,
      hostH: 0,
      dpr: 1,
      pixelCap: Number.POSITIVE_INFINITY,
      reducedMotion: false,
      offset: s.lookOffset,
      shiftX: 0,
      shiftY: 0,
      controller: c,
      stateAt: -1,
    };
    lookShift(s.order, this.#lookSpec);
    const view = this.#view;
    view.onChange = () => this.#tracker.markAllDirty();
    // Another display may have another refresh rate (and another DPR: another canvas size).
    view.onDprChange = () => {
      this.relearnDisplay();
      this.#autoCheck();
    };
    this.#tracker = new ElementTracker(c.influences, s.signal);
    this.#pointer = new PointerInteraction(this.#host, c, s.signal);
    this.#pointer.configure(c.getConfig().interaction);
    this.#applyPixelCap();
    c.setReducedMotion(s.reducedOn());
    for (const op of queue) this.#replay(op);
    // Ids handed out for handles disposed before they got here are never given again.
    c.influences.reserveIds(s.nextInfluenceId);
    c.follow();
    if (s.decided) this.#dwell.switched(s.switchedAt);
    this.#trackAuto();
    if (s.running) this.syncAll();
    else this.#publish();
  }

  /** One call made before the GPU side existed (see Shell). */
  #replay(op: PendingOp): void {
    const c = this.#controller;
    switch (op.kind) {
      case 'config':
        c.applyCommit(op.commit);
        return;
      case 'modulate':
        if (!op.disposed) op.real = c.modulate(op.path, op.source, op.opts);
        return;
      case 'influence':
      case 'bind': {
        if (op.disposed) return;
        const h =
          op.kind === 'bind'
            ? this.bindElement(op.el as Element, op.init as BindElementOptions, op.id)
            : this.addInfluence(op.init as InfluenceInit, undefined, op.id);
        op.real = h;
        if (op.pending) h.update(op.pending);
        op.pending = null;
        return;
      }
      case 'pulse':
        c.pulse(op.opts);
        return;
      case 'lift':
        c.lift(op.opts);
        return;
      case 'debug':
        this.setDebugView(op.view);
        return;
    }
  }

  /** Subscribed to the ticker (drawing): config events go out with the frame. */
  get subscribed(): boolean {
    return this.#unsub !== null;
  }

  /** Cards showing the same picture (this one included) while it is a look member, else 1. */
  get groupSize(): number {
    const group = this.#seat?.member;
    return group ? group.members.length : 1;
  }

  // -------------------------------------------------------------------------------------------
  // Facade calls

  /** start(), stop(): the wish for a context and the frame subscription follow `running`. */
  syncAll(): void {
    this.#syncGpu();
    this.#updateSubscription();
  }

  /**
   * See LumiCells.setRenderer (the facade validated `mode` and that it differs from the one asked
   * for).
   */
  setRenderer(mode: RendererMode): void {
    const s = this.#s;
    s.mode = mode;
    this.#trackAuto();
    if (mode === 'auto') {
      // A flexible budget member from now on (a waiting request draws shared at the next pass).
      s.decided = true;
      this.#dwell.switched(performance.now());
      rankChanged();
      this.#publish();
      this.#autoCheck();
      return;
    }
    this.#clearAutoTimer();
    this.#setStandby(false);
    if (mode === s.renderer) {
      // Same renderer, no longer flexible: a refused request now waits instead.
      rankChanged();
      this.#publish();
      // An 'auto' re-choice not announced yet (see Shell.announced) is now an explicit one.
      s.announce('explicit');
      return;
    }
    this.#dropGpu(false);
    s.renderer = mode;
    this.#parked = false;
    this.#updateSubscription();
    this.#syncGpu();
    this.#noteSwitch('explicit');
  }

  /**
   * See LumiCells.setLook (the facade stored the new look and offset). `changed`: the look,
   * `refit`: the offset.
   */
  lookChanged(changed: boolean, refit: boolean): void {
    const s = this.#s;
    const look = s.look;
    if (refit) this.#lookRefit = true;
    this.#lookSpec.offset = s.lookOffset;
    const seat = this.#seat;
    if (look === 'own' && seat?.member) this.#leaveLook(seat, 'explicit');
    // Asked for: joins at its next frame, without the rejoin delay.
    if (look === 'shared' && changed) this.#lookFresh = true;
    if (changed && s.mode === 'auto') {
      if (look === 'shared' && s.renderer === 'own') {
        this.#clearAutoTimer();
        this.#setStandby(false);
        if (this.#unsub && this.#engine && !this.#lost) {
          // After its next drawn frame, which stays on screen (see #render).
          this.#demoteDue = true;
          this.#demoteReason = 'explicit';
        } else {
          this.#autoSwitch('shared', 'explicit');
        }
      } else {
        this.#autoCheck();
      }
    }
    this.#publish();
  }

  getEffective(path: ModulatablePath): number {
    return this.#controller.getEffective(path);
  }

  modulate(
    path: ModulatablePath,
    source: ModulationSource,
    opts: ModulateOptions,
  ): ModulatorHandle {
    return this.#controller.modulate(path, source, opts);
  }

  addInfluence(init: InfluenceInit, signal?: AbortSignal, id?: number): InfluenceHandle {
    return this.#controller.addInfluence(init, signal, id);
  }

  bindElement(el: Element, opts: BindElementOptions, id?: number): InfluenceHandle {
    const { track = 'auto', padding = 0, signal, ...rest } = opts;
    const c = this.#controller;
    const entry = c.createInfluence({ ...(rest as InfluenceInit), space: 'host', x: 0, y: 0 }, id);
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
    this.#controller.pulse(opts);
  }

  lift(opts: LiftOptions): void {
    this.#controller.lift(opts);
  }

  setDebugView(view: DebugView): void {
    this.#controller.setDebugView(DEBUG_VIEW[view] ?? 0);
  }

  /** Reduced motion (render.reducedMotion 'respect' and the OS setting), see Shell.reducedOn. */
  setReducedMotion(on: boolean): void {
    this.#controller.setReducedMotion(on);
  }

  /** The host moved relative to the zones (observer callbacks). */
  onPlacement(): void {
    this.#syncGpu();
    this.#updateSubscription();
    this.#syncIdle();
    if (this.#s.mode === 'auto') this.#autoCheck();
    // A visible waiter is reported only once the next pass (at frame end) still refuses it.
    rankChanged();
  }

  /** render.overflow changed (the shell rebuilds its view observer afterwards). */
  overflowChanged(): void {
    const cfg = this.#controller.getConfig();
    const opaque = cfg.render.overflow <= 0;
    if (this.#seat) {
      // Shared: the region follows the new size by itself and the shared context stays; only
      // a switch between opaque and transparent needs a 2D canvas of the other kind.
      if (this.#targetAlpha !== null && this.#targetAlpha === opaque) this.#swapTarget();
      else this.#view.setOverflow(cfg.render.overflow);
    } else if (this.#view.canvas && this.#engineOpaque !== null && this.#engineOpaque !== opaque) {
      this.#rebuildCanvas();
    } else {
      this.#view.setOverflow(cfg.render.overflow);
    }
  }

  /** A config change touched `render.*` (`render`), the overflow, or `interaction.*`. */
  afterConfig(render: boolean, overflow: boolean, interaction: boolean): void {
    // The canvas size (overflow, maxDpr, maxPixels) picks an 'auto' renderer.
    if ((render || overflow) && this.#s.mode === 'auto') this.#autoCheck();
    if (render) {
      this.#syncGpu();
      this.#updateSubscription();
      this.#syncIdle();
      // render.pauseOffscreen decides whether an offscreen instance ranks as visible.
      rankChanged();
    }
    if (interaction) this.#pointer.configure(this.#controller.getConfig().interaction);
  }

  /** See LumiCells.destroy (the shell tears down its own half afterwards). */
  destroy(): void {
    this.#dead = true;
    this.#unsub?.();
    this.#unsub = null;
    if (this.#restoreTimer) clearTimeout(this.#restoreTimer);
    this.#restoreTimer = 0;
    this.#clearParkTimer();
    this.#clearAutoTimer();
    this.#cancelRequest();
    this.#setStandby(false);
    this.#trackAuto();
    this.#unwatchSettings?.();
    this.#unwatchSettings = null;
    this.#areaRo?.disconnect();
    this.#areaRo = null;
    this.#releaseCanvas();
    this.#tracker.clear();
    this.#pointer.dispose();
    this.#controller.destroy();
    // The context is released before the slot: the next instance's context comes after it.
    this.#disposeEngine();
    this.#releaseSlot();
    this.#view.onChange = null;
    this.#view.onDprChange = null;
  }

  /**
   * Simulates a context loss (and the browser's restore ~0.5 s later) to test recovery. On a
   * shared instance it loses the shared context: every shared instance on the page is affected.
   */
  loseContextForTesting(): void {
    if (this.#lost) return;
    const seat = this.#seat;
    if (seat) {
      if (seat.alive) seat.loseContextForTesting();
      return;
    }
    const e = this.#engine;
    if (!e) return;
    e.loseContextForTesting();
    if (this.#restoreTimer) clearTimeout(this.#restoreTimer);
    this.#restoreTimer = setTimeout(() => {
      this.#restoreTimer = 0;
      if (!this.#dead && this.#engine === e) e.restoreContextForTesting();
    }, 500);
  }

  // -------------------------------------------------------------------------------------------
  // Internals

  #ensureEngine(): void {
    const s = this.#s;
    if (this.#engine || this.#failed || this.#lost || this.#dead) return;
    const cfg = this.#controller.getConfig();
    // A canvas the shared renderer copied into (#targetAlpha set) has a 2D context: it can never
    // get a WebGL one, so the engine gets a new canvas.
    let canvas = this.#targetAlpha === null ? this.#view.canvas : null;
    if (!canvas) {
      canvas = this.#view.mount(cfg.render.overflow);
      this.#targetAlpha = null;
    }
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
      queueMicrotask(() => s.emit('error', error));
      s.sendFallback(
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
    // The field variant of the look compiles alongside the other programs (see
    // engine/field-variants.ts), not from the first frame the instance renders.
    engine.prepare(this.#controller.frame);
    this.#drawnSinceMount = false;
    this.#hiddenDraws = 0;
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
      this.#s.emit('warn', {
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
    const view = this.#view;
    this.#releaseCanvas();
    view.unmount();
    view.dropStandIn();
    this.#targetAlpha = null;
    this.#drawnSinceMount = false;
    view.showPoster(this.#controller.poster);
  }

  #onEngineError(err: Error): void {
    const s = this.#s;
    if (this.#dead || this.#failed) return;
    this.#failed = true;
    // Release the GPU objects and the context right away (null while still constructing: then
    // #ensureEngine disposes the engine when the constructor returns).
    this.#disposeEngine();
    if (this.#view.canvas) this.#dropFailedCanvas();
    this.#releaseSlot();
    this.#updateSubscription();
    this.#publish();
    s.emit('error', err);
    s.sendFallback('compile');
  }

  #onContextLost(e: Event, canvas: HTMLCanvasElement): void {
    // Without preventDefault the browser never restores the context.
    e.preventDefault();
    if (this.#dead || canvas !== this.#view.canvas) return;
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
    const s = this.#s;
    this.#lost = true;
    this.#drawnSinceMount = false;
    this.#hiddenDraws = 0;
    // A lost context's canvas paints a blank box over everything: hide it until the first frame
    // drawn on the restored context.
    this.#view.setCanvasVisible(false);
    this.#view.showPoster(this.#controller.poster);
    this.#updateSubscription();
    this.#publish();
    s.emit('contextlost', undefined);
    s.emit('fallback', { reason: 'context-lost' });
  }

  #onContextRestored(canvas: HTMLCanvasElement): void {
    const s = this.#s;
    if (this.#dead || this.#failed || canvas !== this.#view.canvas) return;
    this.#lost = false;
    this.#lostPending = false;
    // The old engine's objects died with the context: rebuild from the controller's state.
    this.#engine?.dispose();
    this.#engine = null;
    this.#failed = false;
    this.#ensureEngine();
    if (!this.#engine) this.#releaseSlot();
    this.#updateSubscription();
    this.#publish();
    s.emit('contextrestored', undefined);
  }

  /**
   * Overflow 0 <-> >0 changes the context's alpha attribute: new canvas, new engine, in the same
   * budget slot (a stopped instance gives the slot back and is rebuilt when started again).
   */
  #rebuildCanvas(): void {
    const view = this.#view;
    this.#unsub?.();
    this.#unsub = null;
    this.#disposeEngine();
    // The old canvas is dropped: its context listeners must not keep it (and its context
    // wrapper) reachable from this instance.
    this.#releaseCanvas();
    view.unmount();
    view.dropStandIn();
    view.showPoster(this.#controller.poster);
    if (this.#lost) this.#lostPending = true;
    this.#lost = false;
    this.#drawnSinceMount = false;
    if (this.#holds && this.#s.running) this.#ensureEngine();
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
    const s = this.#s;
    if (!s.running || this.#dead || this.#failed || s.noWebgl) return false;
    if (this.#alwaysOn()) return true;
    return s.inZone || s.inView;
  }

  /**
   * Asks the scheduler (or the shared renderer) for a slot, or withdraws the request, as the wish
   * changed. An 'auto' instance picks its renderer right before asking (see #chooseAuto), unless
   * `choose` is false: the caller has just picked it (a budget fallback must not be undone).
   * Its first choice waits for the observers' first size report (#awaitsSize): the request goes
   * out from there, so the constructor never reads layout. Nothing is lost by waiting: both
   * renderers serve requests at frame end, and the observers report right after the first frame.
   */
  #syncGpu(choose = true): void {
    const s = this.#s;
    if (!this.#holds && !this.#dead) {
      if (this.#wantsContext()) {
        if (!this.#requested && !(choose && s.mode === 'auto' && this.#awaitsSize())) {
          if (s.mode === 'auto') {
            // A fresh request replaces a standby one.
            this.#setStandby(false);
            if (choose) this.#chooseAuto();
          }
          this.#requested = true;
          if (s.renderer === 'shared') getSharedRenderer().request(this.#sharedClient);
          else requestContext(this.#client);
        }
      } else {
        this.#cancelRequest();
      }
    }
    this.#armParkTimer();
    this.#publish();
  }

  /**
   * The scheduler granted a slot: build the engine (same path as a context restore). A standby
   * 'auto' instance (on the shared renderer, waiting for a context of its own) is promoted.
   */
  #onGranted(): void {
    const s = this.#s;
    if (this.#standby) {
      this.#standby = false;
      const want =
        !this.#dead &&
        s.mode === 'auto' &&
        s.renderer === 'shared' &&
        this.#wantsContext() &&
        this.#autoWant(this.#dwell.score, 'own') === 'own';
      if (!want) {
        // Stale (it left the zone or shrank meanwhile): the slot goes straight back.
        releaseContext(this.#client);
        this.#publish();
        return;
      }
      this.#autoSwitch('own', 'promote', true);
      return;
    }
    this.#requested = false;
    this.#waiting = false;
    this.#budgetReported = false;
    this.#holds = true;
    if (this.#dead || !this.#wantsContext() || s.renderer !== 'own') {
      this.#releaseSlot();
      this.#publish();
      return;
    }
    this.#parked = false;
    this.#ensureEngine();
    if (!this.#engine) this.#releaseSlot();
    // An 'auto' re-choice of 'own' (back from parking, larger) is reported now that it holds one.
    else s.announce('promote');
    this.#updateSubscription();
    this.#armParkTimer();
    this.#publish();
    this.#endPendingLoss();
  }

  /**
   * The scheduler refused the request (again: it re-evaluates every waiter on each pass). Only a
   * real refusal reports a visible wait, never a stale one: an instance that waited offscreen
   * and then scrolled into view is reported only if the pass after the move still refuses it.
   */
  #onRefused(): void {
    const s = this.#s;
    if (this.#dead) return;
    if (s.mode === 'auto') {
      // Flexible: never waits. A standby candidate stays queued for the next free slot; a first
      // request for a context of its own draws on the shared renderer instead.
      if (!this.#standby && this.#requested && !this.#holds && s.renderer === 'own') {
        this.#autoSwitch('shared', 'budget');
      }
      return;
    }
    if (!this.#waiting) {
      this.#waiting = true;
      this.#publish();
    }
    this.#reportBudgetWait();
  }

  /** A context lost before a park or rebuild is over once a new engine exists. */
  #endPendingLoss(): void {
    if (!this.#lostPending || (!this.#engine && !this.#seat) || this.#lost) return;
    this.#lostPending = false;
    // Deferred: this runs inside the scheduler's pass, listeners must not re-enter it.
    queueMicrotask(() => {
      if (!this.#dead) this.#s.emit('contextrestored', undefined);
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
      const s = this.#s;
      if (this.#dead || !this.#waiting) return;
      if (claimBudgetWarning()) {
        const message = `[lumicells] A visible background waits for a WebGL context: the page budget of ${maxContexts()} contexts is taken by instances that rank higher. It shows its poster until one frees up. Raise the budget with LumiCells.configure({ maxContexts }) or set priority: 'high' on the backgrounds that matter most.`;
        console.warn(message);
        s.emit('warn', { code: 'context-budget', message });
      }
      s.emit('fallback', { reason: 'budget' });
    });
  }

  /**
   * Releases the GPU side (engine, context, canvas) and keeps everything else; the poster shows
   * instead. `evicted`: the scheduler already took the slot back. An instance that still wants a
   * context (evicted near the viewport) asks again and waits.
   */
  #park(evicted: boolean): void {
    if (!this.#holds || this.#dead) return;
    if (evicted) this.#holds = false;
    if (this.#restoreTimer) clearTimeout(this.#restoreTimer);
    this.#restoreTimer = 0;
    this.#demoteDue = false;
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
    this.#view.dropStandIn();
    this.#view.showPoster(this.#controller.poster);
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
      // A member takes its picture along (a later seat continues it, or rejoins).
      if (seat.member) this.#takeLook(seat, 'renderer');
      this.#seat = null;
      this.#unwatchSettings?.();
      this.#unwatchSettings = null;
      seat.release();
    }
    if (!this.#holds) return;
    this.#holds = false;
    if (!seat) releaseContext(this.#client);
  }

  /**
   * Withdraws a request that was not served yet (from whichever renderer it went to). A standby
   * request for a context of its own is not this request: see #setStandby.
   */
  #cancelRequest(): void {
    if (!this.#requested) return;
    // The wait (if any) ends here: a later one is reported anew.
    this.#requested = false;
    this.#waiting = false;
    this.#budgetReported = false;
    if (!this.#standby) cancelRequest(this.#client);
    peekSharedRenderer()?.cancel(this.#sharedClient);
  }

  /**
   * Releases whatever GPU side the instance has or asks for (renderer switch). `holdFrame`: keep
   * the current frame on screen until the next renderer draws (see HostView.holdCanvas/holdCopy).
   */
  #dropGpu(holdFrame: boolean): void {
    const view = this.#view;
    if (this.#restoreTimer) clearTimeout(this.#restoreTimer);
    this.#restoreTimer = 0;
    this.#cancelRequest();
    this.#setStandby(false);
    this.#demoteDue = false;
    if (holdFrame) this.#holdFrame();
    else view.dropStandIn();
    this.#releaseCanvas();
    this.#disposeEngine();
    this.#releaseSlot();
    view.unmount();
    this.#targetAlpha = null;
    this.#engineOpaque = null;
    // The shared budget's resolution factor belongs to the shared renderer (a new seat sets it).
    this.#controller.setShareScale(1);
    view.showPoster(this.#controller.poster);
    if (this.#lost) this.#lostPending = true;
    this.#lost = false;
    this.#drawnSinceMount = false;
  }

  /**
   * Keeps the frame on screen through a switch: the shared 2D canvas itself, or a 2D copy of the
   * WebGL canvas when its engine drew in the frame running now (its drawing buffer still holds
   * that frame; later it may be cleared). Otherwise the poster covers the switch.
   */
  #holdFrame(): void {
    const view = this.#view;
    if (!this.#drawnSinceMount || this.#lost || !view.canvas) return;
    if (this.#seat) view.holdCanvas();
    else if (this.#engine && this.#drawnAt === frameNow()) view.holdCopy();
  }

  // -------------------------------------------------------------------------------------------
  // renderer: 'auto'

  /** Joins or leaves the page's 'auto' instances (configure() and viewport watchers). */
  #trackAuto(): void {
    const s = this.#s;
    const on = s.mode === 'auto' && !this.#dead;
    if (on === autoLives.has(this)) return;
    if (on) {
      autoLives.add(this);
      const win = this.#host.ownerDocument.defaultView;
      if (win) this.#unwatchViewport = watchViewport(win, () => this.#autoCheck());
    } else {
      autoLives.delete(this);
      this.#unwatchViewport?.();
      this.#unwatchViewport = null;
      this.#clearAutoTimer();
    }
    this.#watchArea();
  }

  /**
   * The host size is unknown yet, and an IntersectionObserver will report it (its first report
   * comes right after the first frame, then #onPlacement asks and re-checks). Until then an
   * 'auto' instance neither chooses nor asks: a synchronous size read here would force layout
   * inside the mount task, once per instance.
   */
  #awaitsSize(): boolean {
    const s = this.#s;
    return !s.hostSized && (s.io !== null || s.zoneIo !== null);
  }

  /** How large the instance is for the 'auto' policy (1 = at the promotion threshold). */
  #autoScore(): number {
    const s = this.#s;
    const win = this.#host.ownerDocument.defaultView;
    if (!win) return 0;
    if (!s.hostSized) {
      // No observer reports sizes (no IntersectionObserver): read the size once.
      const r = this.#host.getBoundingClientRect();
      s.noteHostSize(r.width, r.height, false);
    }
    const cfg = this.#controller.getConfig().render;
    const vp = viewportSize(win);
    const a = this.#autoSize;
    a.cssW = s.hostW;
    a.cssH = s.hostH;
    a.overflow = cfg.overflow;
    a.dpr = Math.min(win.devicePixelRatio || 1, cfg.maxDpr);
    a.maxPixels = Math.min(cfg.maxPixels, this.#pixelCap) * 1e6;
    a.viewportW = vp.w;
    a.viewportH = vp.h;
    return autoScore(a, runtimeSettings().promoteArea * 1e6);
  }

  /**
   * 'auto', about to ask for a GPU side: picks the renderer for the current size (with hysteresis
   * around the current one, no dwell: nothing is drawn yet). The instance holds and asks for
   * nothing here. The first choice emits no event; a later one (back from parking) is announced
   * once the new renderer serves it (#onGranted, #onSeat), and not at all when the budget turns
   * the request down and the instance falls back to the renderer it had (#onRefused).
   */
  #chooseAuto(): void {
    const s = this.#s;
    const score = this.#autoScore();
    this.#dwell.note(score, performance.now());
    const next = this.#autoWant(score, s.renderer);
    const first = !s.decided;
    s.decided = true;
    if (next === s.renderer) return;
    this.#dropLeftovers();
    s.renderer = next;
    if (first) s.announced = next;
    this.#dwell.switched(performance.now());
    this.#publish();
  }

  /**
   * What a renderer switch leaves behind while the instance holds nothing (see #dropGpu): a
   * parked shared instance keeps its emptied 2D canvas in the host (and a canvas with a 2D
   * context never gets a WebGL one), and the shared budget's resolution factor belongs to the
   * shared renderer.
   */
  #dropLeftovers(): void {
    const view = this.#view;
    if (view.canvas) {
      this.#releaseCanvas();
      view.dropStandIn();
      view.unmount();
    }
    this.#targetAlpha = null;
    this.#engineOpaque = null;
    this.#controller.setShareScale(1);
  }

  /** LumiCells.configure() changed `promoteArea`: see #autoCheck. */
  autoCheck(): void {
    this.#autoCheck();
  }

  /**
   * 'auto': re-evaluates the renderer the size asks for (host, viewport, DPR or config changed,
   * placement changed, or the dwell timer fired) and switches, or schedules the switch, when the
   * size has held still long enough. Promotion goes through the scheduler (standby request).
   */
  #autoCheck(): void {
    const s = this.#s;
    if (s.mode !== 'auto' || this.#dead || this.#awaitsSize()) return;
    const now = performance.now();
    const score = this.#autoScore();
    this.#dwell.note(score, now);
    if (!s.running || this.#failed || s.noWebgl || !this.#wantsContext()) {
      // Out of the zone or stopped: nothing to switch now, the next request chooses again.
      this.#setStandby(false);
      this.#clearAutoTimer();
      return;
    }
    // A standby request leans own: it leaves only below the demotion ratio.
    const leaning: InstanceRenderer = this.#standby ? 'own' : s.renderer;
    const want = this.#autoWant(score, leaning);
    if (want === leaning) {
      this.#clearAutoTimer();
      return;
    }
    if (this.#standby) {
      // Shrank while waiting for a context of its own: nothing on screen changes.
      this.#setStandby(false);
      this.#clearAutoTimer();
      return;
    }
    if (!this.#holds && s.renderer === 'own') {
      // Asked for a context of its own, not served yet, and now too small: nothing was drawn,
      // ask the shared renderer right away.
      if (this.#requested) {
        this.#cancelRequest();
        this.#syncGpu();
      }
      this.#clearAutoTimer();
      return;
    }
    // Shared (drawing or about to) and now large enough: standby after the dwell. This also
    // holds after a budget fallback, which must not turn into a request per frame.
    const due = this.#dwell.dueAt();
    if (now < due) {
      this.#armAutoTimer(due - now);
      return;
    }
    this.#clearAutoTimer();
    if (s.renderer === 'shared') {
      // Promotion: queue for a context of its own; the grant switches (see #onGranted).
      this.#setStandby(true);
    } else if (this.#unsub && this.#engine && !this.#lost) {
      // Demotion of a drawing instance: right after its next frame, so that frame can be held.
      this.#demoteDue = true;
    } else {
      this.#autoSwitch('shared', 'demote');
    }
  }

  /** The renderer an 'auto' instance of this size wants: shared whenever it shares a look. */
  #autoWant(score: number, current: InstanceRenderer): InstanceRenderer {
    return this.#s.look === 'shared' ? 'shared' : autoWants(score, current);
  }

  /** Re-arms the dwell timer (bound once: a drag re-arms it on every resize report). */
  #armAutoTimer(ms: number): void {
    if (this.#autoTimer) clearTimeout(this.#autoTimer);
    this.#autoTimer = setTimeout(this.#onAutoTimer, Math.max(0, Math.ceil(ms)));
  }

  readonly #onAutoTimer = (): void => {
    this.#autoTimer = 0;
    this.#autoCheck();
  };

  #clearAutoTimer(): void {
    if (this.#autoTimer) clearTimeout(this.#autoTimer);
    this.#autoTimer = 0;
    this.#demoteDue = false;
    this.#demoteReason = 'demote';
  }

  /** Queues (or withdraws) a standby request for a context of its own (see #onGranted). */
  #setStandby(on: boolean): void {
    if (on === this.#standby) return;
    this.#standby = on;
    if (on) requestContext(this.#client);
    else cancelRequest(this.#client);
    this.#watchArea();
  }

  /**
   * Switches an 'auto' instance to `next`, keeping the last frame on screen until the new
   * renderer draws. `granted`: to own, on the slot the scheduler just granted.
   */
  #autoSwitch(next: InstanceRenderer, reason: RendererChangeReason, granted = false): void {
    this.#dropGpu(true);
    this.#s.renderer = next;
    this.#parked = false;
    if (granted) {
      this.#holds = true;
      this.#ensureEngine();
      if (!this.#engine) this.#releaseSlot();
    }
    this.#updateSubscription();
    this.#syncGpu(false);
    this.#noteSwitch(reason);
    this.#endPendingLoss();
    // The next switch waits a dwell from now (a pending one re-arms its timer).
    this.#autoCheck();
  }

  /** The renderer changed: the dwell restarts, stats follow, listeners hear it (deferred). */
  #noteSwitch(reason: RendererChangeReason): void {
    this.#s.decided = true;
    this.#dwell.switched(performance.now());
    this.#publish();
    this.#s.announce(reason);
  }

  /**
   * The scheduler gave this instance's slot to a higher ranked one (or lowered the budget). An
   * 'auto' instance near the viewport moves to the shared renderer instead of waiting.
   */
  #onEvicted(): void {
    if (this.#s.mode === 'auto' && this.#holds && !this.#seat && this.#wantsContext()) {
      // The budget already took the slot back.
      this.#holds = false;
      this.#autoSwitch('shared', 'budget');
      return;
    }
    this.#park(true);
  }

  /**
   * The shared renderer gave this instance a seat: the first grant (mount the 2D canvas; drawn
   * from the next frame, shown after the first copy), or the same seat rebuilt after a loss of
   * the shared context (the canvas still shows the last frame, the next copy replaces it).
   */
  #onSeat(seat: SharedSeat, restored: boolean): void {
    const s = this.#s;
    if (restored) {
      if (this.#dead || seat !== this.#seat) {
        seat.release();
        return;
      }
      this.#lost = false;
      this.#lostPending = false;
      this.#applySharedCaps(seat);
      this.#controller.invalidateGpu();
      this.#updateSubscription();
      this.#publish();
      s.emit('contextrestored', undefined);
      return;
    }
    this.#requested = false;
    this.#waiting = false;
    this.#budgetReported = false;
    if (this.#dead || !this.#wantsContext() || s.renderer !== 'shared') {
      seat.release();
      this.#publish();
      return;
    }
    this.#holds = true;
    this.#seat = seat;
    this.#parked = false;
    this.#lookFresh = true;
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
    // An 'auto' re-choice of 'shared' (back from parking, smaller) is reported now it has a seat.
    s.announce('demote');
    this.#updateSubscription();
    this.#syncIdle();
    this.#armParkTimer();
    this.#publish();
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
    const s = this.#s;
    const idle = !s.inZone && !s.inView && !this.#alwaysOn();
    if (idle && !seat.idle) {
      this.#shrinkTarget();
      this.#view.dropStandIn();
      this.#drawnSinceMount = false;
      this.#lookFresh = true;
      this.#view.showPoster(this.#controller.poster);
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
    const host = this.#host;
    const r = host.getBoundingClientRect();
    const cfg = c.getConfig().render;
    const dpr = Math.min(host.ownerDocument.defaultView?.devicePixelRatio || 1, cfg.maxDpr);
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
    const s = this.#s;
    if (this.#dead || !this.#seat || this.#lost) return;
    this.#lost = true;
    this.#updateSubscription();
    this.#publish();
    s.emit('contextlost', undefined);
    s.emit('fallback', { reason: 'context-lost' });
  }

  /** The shared device (or this slot) failed for good; the renderer already took the seat back. */
  #onSharedFailed(err: EngineError): void {
    const s = this.#s;
    this.#requested = false;
    this.#waiting = false;
    if (this.#dead || this.#failed) return;
    this.#failed = true;
    this.#seat = null;
    this.#holds = false;
    this.#setLookShown('own', 'renderer');
    this.#unwatchSettings?.();
    this.#unwatchSettings = null;
    this.#clearParkTimer();
    if (this.#view.canvas) this.#dropFailedCanvas();
    this.#updateSubscription();
    this.#publish();
    // Deferred: this runs inside the shared renderer's pass.
    queueMicrotask(() => {
      if (!this.#dead) s.emit('error', err);
    });
    s.sendFallback(err.code === 'no-webgl2' ? 'no-webgl2' : 'compile');
  }

  /** Overflow 0 <-> > 0 while shared: a 2D canvas with the other alpha attribute, same seat. */
  #swapTarget(): void {
    const view = this.#view;
    const cfg = this.#controller.getConfig();
    const alpha = cfg.render.overflow > 0;
    const canvas = view.mount(cfg.render.overflow);
    this.#targetAlpha = alpha;
    this.#seat?.setTarget(canvas, alpha);
    this.#drawnSinceMount = false;
    view.showPoster(this.#controller.poster);
  }

  /** Parked while shared: the 2D canvas frees its memory (browsers cap it per page) and hides. */
  #shrinkTarget(): void {
    const view = this.#view;
    const c = view.canvas;
    if (c) {
      c.width = 0;
      c.height = 0;
    }
    view.setCanvasVisible(false);
  }

  /**
   * Parks the instance after `parkAfterMs` out of the zone (instances that never pause stay).
   * `elapsedMs`: time already spent away, when the timer is re-armed for a new `parkAfterMs`.
   */
  #armParkTimer(elapsedMs = 0): void {
    const s = this.#s;
    const away = !s.inZone && !s.inView;
    if (!away || !this.#holds || this.#dead || this.#alwaysOn()) {
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
        if (!s.inZone && !s.inView) this.#park(false);
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
    if (this.#dead) return;
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
    if (this.#dead) return;
    const r = this.#host.getBoundingClientRect();
    this.#area = r.width > 0 && r.height > 0 ? r.width * r.height : 0;
  }

  /**
   * While the instance holds or asks for a slot, a resize of its host can change who deserves
   * one (among visible instances the larger ranks higher), yet no intersection callback reports
   * a resize: a ResizeObserver on the host asks the scheduler to rank again when the area moves
   * to another bucket (a waiting card that grows, a holder that shrinks). The pass then reads
   * every competitor's size afresh (#refreshArea); the observer is only the trigger. An 'auto'
   * instance with a GPU side (or asking for one) is watched too: its size picks its renderer.
   */
  #watchArea(): void {
    const s = this.#s;
    const active = this.#holds || this.#requested || this.#standby;
    const want = active && !this.#dead && (s.renderer === 'own' || s.mode === 'auto');
    if (want === this.#areaWatched) return;
    const win = this.#host.ownerDocument.defaultView;
    if (!win || typeof win.ResizeObserver !== 'function') return;
    this.#areaWatched = want;
    this.#areaBucket = -1;
    if (want) {
      this.#areaRo ??= new win.ResizeObserver((entries) => this.#onHostResize(entries));
      this.#areaRo.observe(this.#host);
    } else {
      this.#areaRo?.unobserve(this.#host);
      // Unwatched sizes go stale: intersection rects report again until the next watch.
      s.hostFromRo = false;
    }
  }

  #onHostResize(entries: ResizeObserverEntry[]): void {
    const s = this.#s;
    const e = entries[entries.length - 1];
    if (!e || this.#dead || !this.#areaWatched) return;
    const box = e.borderBoxSize?.[0];
    const w = box ? box.inlineSize : e.contentRect.width;
    const h = box ? box.blockSize : e.contentRect.height;
    s.hostFromRo = true;
    s.noteHostSize(w, h, true);
    const bucket = areaBucket(w > 0 && h > 0 ? w * h : 0);
    const was = this.#areaBucket;
    this.#areaBucket = bucket;
    // The first report only sets the baseline: the request was just ranked on fresh sizes.
    if (was >= 0 && bucket !== was) rankChanged();
    if (s.mode === 'auto') this.#autoCheck();
  }

  /** The shell's publish(): see #publish. */
  publishState(): void {
    this.#publish();
  }

  /** Called after every change of the GPU side: the state, and the resize watch that follows it. */
  #publish(): void {
    const s = this.#s;
    const st = this.#stats;
    st.state = this.#computeState();
    st.renderer = s.renderer;
    st.rendererMode = s.mode;
    if (s.renderer === 'own') {
      st.presentMs = null;
      st.shared = null;
    }
    this.#watchArea();
  }

  #computeState(): InstanceState {
    const s = this.#s;
    if (this.#dead) return 'destroyed';
    if (this.#failed || s.noWebgl) return 'failed';
    if (this.#engine || this.#seat) return this.#lost ? 'lost' : 'live';
    if (this.#waiting) return 'waiting';
    if (this.#requested) return 'pending';
    return this.#parked ? 'parked' : 'pending';
  }

  /** Subscribes to the ticker while there is something to draw, and unsubscribes otherwise. */
  updateSubscription(): void {
    this.#updateSubscription();
  }

  #updateSubscription(): void {
    const s = this.#s;
    const cfg = this.#controller.getConfig();
    const visible = !cfg.render.pauseOffscreen || (s.inView && !s.hidden);
    const should =
      s.running &&
      !this.#dead &&
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
      if (s.pending.length > 0) s.queueFlush();
    }
    // A drawing shared instance needs a region in the atlas.
    this.#seat?.setRendering(this.#unsub !== null);
  }

  #measure(now: number): void {
    if (this.#dead) return;
    const c = this.#controller;
    const view = this.#view;
    const size = view.takeSize(now, RESIZE_THROTTLE);
    if (size) {
      c.setViewport(size);
      this.#tracker.markAllDirty();
    }
    const o = this.#origin;
    if (this.#tracker.needsHostRect || this.#pointer.needsHostRect || c.needsClientOrigin) {
      view.readClientOrigin(o);
      c.setClientOrigin(o[0] as number, o[1] as number);
    } else {
      o[0] = Number.NaN;
      o[1] = Number.NaN;
    }
    this.#tracker.measure(o[0] as number, o[1] as number);
    this.#pointer.measure(o[0] as number, o[1] as number, now);
  }

  /**
   * Presents at the full rate on the shared renderer: the pointer is over the host, or a change
   * of its own is pending or less than ACTIVE_MS old.
   */
  #isActive(): boolean {
    const s = this.#s;
    if (s.pointerInside || s.pointerLeft || this.#controller.activityPending) return true;
    const now = frameNow();
    return (Number.isNaN(now) ? performance.now() : now) - this.#activeAt < ACTIVE_MS;
  }

  #render(now: number): void {
    const s = this.#s;
    const engine = this.#engine;
    const seat = this.#seat;
    if (this.#dead || (!engine && !seat)) return;
    // Lost since the last frame (the loss event may still be queued): hide the canvas now.
    if (engine?.isContextLost()) {
      this.#enterLost();
      return;
    }
    // A display refresh calibration wants frames without GL work (see runtime/display): the
    // canvas keeps its frame, or the poster stays up, and the animation time waits.
    if (calibrationHold(now)) {
      this.#lastNow = now;
      return;
    }
    // The shared renderer settles this frame's budget scale and reducers before any shared
    // instance updates.
    seat?.beginFrame(now);
    const c = this.#controller;
    if (c.takeActivity() || s.pointerLeft) this.#activeAt = now;
    s.pointerLeft = false;
    if (s.look === 'shared' && c.hasLayers) this.#layersAt = now;
    // A look member shows its group's picture (it may join, move or leave here first).
    const group = seat && (seat.member || s.look === 'shared') ? this.#lookStep(seat, now) : null;
    // A member renders at its group's adaptive tier: the group learns the frame timing.
    const perf = group ? group.controller.perf : c.perf;
    const raw = this.#lastNow < 0 ? perf.vsyncMs : now - this.#lastNow;
    this.#lastNow = now;
    if (group) {
      group.beginFrame(now);
    } else {
      // Feed every rAF (skipped ones too) so the refresh estimate reflects the display. A shared
      // instance feeds the GPU time of the whole shared device. The main-thread figure for the
      // jank guard is the whole frame's (every instance and the app's frame callbacks) plus how
      // late this frame started (main-thread work before it), not just this instance's share.
      perf.setDisplayHint(displayIntervalMs(), displayEpoch());
      const gpuMs = engine ? engine.gpuTimeMs : (seat?.stats.gpuMs ?? null);
      const busyMs = Math.max(this.#lastCpu, frameWorkMs() + frameLateMs());
      const change = c.samplePerf(raw, busyMs, gpuMs, now);
      if (change) this.#emitQuality(change.scale, change.quality, change.reason);
    }

    // maxFps: render every k-th vsync (integer divisor of the refresh rate, even cadence). The
    // divisor uses the observed cadence, not the sticky refresh estimate: after a drop to a
    // slower display/OS rate, k must follow it (a 60 Hz cap with maxFps 60 is k = 1, not 2).
    // A shared instance the renderer runs at a lower rate presents on the frames of its phase
    // instead (spread over the frames together with the other secondary instances). Skipped
    // frames add their time to the next presented one: the animation never slows down.
    const vsync = perf.cadenceMs;
    const maxFps = c.getConfig().render.maxFps;
    let k = maxFps > 0 ? Math.max(1, Math.round(1000 / vsync / maxFps)) : 1;
    let due: boolean;
    const sd = seat ? seat.divisor : 1;
    if (sd > k) {
      k = sd;
      due = (seat as SharedSeat).isDue(frameSerial());
    } else {
      due = k <= 1 || ++this.#skip >= k;
    }
    this.#stats.reducers.frameDivisor = k;
    this.#accMs += raw;
    if (!due) return;
    this.#skip = 0;
    let deltaMs = this.#accMs;
    this.#accMs = 0;
    // Snap to vsync multiples: removes the +-1-2 ms rAF jitter from motion.
    const ideal = k * vsync;
    if (Math.abs(deltaMs - ideal) < 0.15 * ideal) deltaMs = ideal;
    const maxDt = Math.max(MAX_STEP_MS, 1.5 * ideal) / 1000;
    const dt = Math.min(deltaMs / 1000, maxDt);

    s.flushConfig();
    if (group) {
      // The picture of this frame (the first member to present in it updates the group), copied
      // into this instance's canvas in the present phase.
      group.update(now, ideal);
      this.#stats.reducers.lite = group.seat?.lite ?? false;
      this.#updateMs = 0;
      this.#sharedDt = dt;
      this.#sharedIdeal = ideal;
      (seat as SharedSeat).submit();
      return;
    }
    const t0 = performance.now();
    const inputs = c.update(dt, now, maxDt);
    if (engine) {
      // An own instance draws lite only at the 'low' tier (see LumiCells.configure({ lite })).
      inputs.lite = inputs.quality === 'low' && runtimeSettings().lite !== false;
      this.#stats.reducers.lite = inputs.lite;
    } else {
      this.#stats.reducers.lite = (seat as SharedSeat).lite;
    }
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
      noteGpuWork();
      c.commitFrame();
      this.#drawnAt = now;
      // A new (or restored) canvas is shown with its second frame, when the first one has
      // reached the screen. WebKit presents a context's frame once its GPU process gets to it,
      // which can be well after the style change that reveals the canvas (other contexts
      // compiling meanwhile): shown with its first frame, an opaque canvas flashed black.
      if (!this.#drawnSinceMount) {
        if (this.#hiddenDraws++ === 0) noteFirstDraw(now);
        else this.#showFirstFrame();
      }
    }
    this.#finishFrame(performance.now() - t0, dt, ideal, now, engine.gpuTimeMs);
    // 'auto' demotion (see #autoCheck): right after a drawn frame, which stays on screen.
    if (this.#demoteDue && drawn && this.#drawnSinceMount) {
      const reason = this.#demoteReason;
      this.#demoteDue = false;
      this.#demoteReason = 'demote';
      this.#autoSwitch('shared', reason);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Shared look (see runtime/look.ts)

  /**
   * Render phase of a shared instance with `look: 'shared'` (or a member): joins, keeps, moves or
   * leaves its group. Returns the group the instance shows this frame, null when it draws on its
   * own.
   */
  #lookStep(seat: SharedSeat, now: number): LookGroup | null {
    const c = this.#controller;
    let g = seat.member;
    if (g) {
      if (!this.#lookEligible()) {
        this.#leaveLook(seat, c.lookKey !== g.key ? 'config' : 'layers');
        return null;
      }
      const key = c.lookKey;
      if (key !== this.#lookKey) {
        // A new config object: still the same picture? (e.g. only interaction changed)
        if (key !== g.key) {
          this.#leaveLook(seat, 'config');
          return null;
        }
        this.#lookKey = key;
      }
      if (this.#lookSpecStale()) {
        // Resized (or another DPR, pixel cap or window shift): another group may fit better.
        this.#fillLookSpec();
        if (!g.fits(this.#lookSpec, seat.maxDrawableSize)) {
          // Moves (the picture goes along: a new group continues it).
          g.cropOf(seat);
          c.adoptLook(g.controller, seat.cellDX, seat.cellDY);
          this.#lookSpec.stateAt = g.updatedAt;
          if (!seat.joinLook(key, this.#lookSpec) && !seat.member) {
            this.#ownAfterLook(g);
            this.#setLookShown('own', 'renderer');
            return null;
          }
          g = seat.member as LookGroup;
          this.#lookQuality = g.qualityEpoch;
          this.#syncQuality(g.controller.perf);
        }
      }
      return g;
    }
    if (!this.#lookEligible()) return null;
    // A card that shows a picture of its own waits until it has been calm for a while: no
    // activity and no layer of its own (which may outlast its one activity mark by far).
    if (
      !this.#lookFresh &&
      (this.#isActive() || now - Math.max(this.#activeAt, this.#layersAt) < LOOK_REJOIN_MS)
    ) {
      return null;
    }
    this.#fillLookSpec();
    // A group started by this card continues its picture from the frame it last advanced in.
    this.#lookSpec.stateAt = this.#lastNow >= 0 ? this.#lastNow - this.#accMs : -1;
    const key = c.lookKey;
    if (!seat.joinLook(key, this.#lookSpec)) return null;
    this.#lookKey = key;
    this.#lookFresh = false;
    // Quality events report the group's changes from now on, not the ones before it joined; a
    // group at another tier than the one last reported is a change of its own.
    const joined = seat.member as LookGroup;
    this.#lookQuality = joined.qualityEpoch;
    this.#syncQuality(joined.controller.perf);
    this.#setLookShown('group', 'join');
    return joined;
  }

  /** May join (or stay in) a group: `look: 'shared'`, measured, nothing of its own to draw. */
  #lookEligible(): boolean {
    return (
      this.#s.look === 'shared' &&
      !this.#lost &&
      this.#controller.measured &&
      !this.#controller.hasLayers
    );
  }

  /** The member's size, DPR, pixel cap or window shift moved since it last told its group. */
  #lookSpecStale(): boolean {
    const s = this.#lookSpec;
    const c = this.#controller;
    return (
      this.#lookRefit ||
      s.hostW !== c.hostCssW ||
      s.hostH !== c.hostCssH ||
      s.dpr !== c.dpr ||
      s.pixelCap !== this.#pixelCap ||
      s.reducedMotion !== c.isReducedMotion
    );
  }

  #fillLookSpec(): void {
    const s = this.#lookSpec;
    const c = this.#controller;
    this.#lookRefit = false;
    s.hostW = c.hostCssW;
    s.hostH = c.hostCssH;
    s.dpr = c.dpr;
    s.pixelCap = this.#pixelCap;
    s.reducedMotion = c.isReducedMotion;
  }

  /**
   * Leaves the group: the controller takes over the group's picture (clock, lifted cells, tier),
   * and the next frame is drawn on its own, continuing it.
   */
  #leaveLook(seat: SharedSeat, reason: LookChangeReason): void {
    if (!seat.member) return;
    this.#takeLook(seat, reason);
    seat.leaveLook();
  }

  /** Takes the member's picture state into its own controller (before its seat leaves the group). */
  #takeLook(seat: SharedSeat, reason: LookChangeReason): void {
    const g = seat.member;
    if (!g) return;
    g.cropOf(seat);
    this.#controller.adoptLook(g.controller, seat.cellDX, seat.cellDY);
    this.#ownAfterLook(g);
    this.#syncQuality(this.#controller.perf);
    this.#setLookShown('own', reason);
  }

  /** A 'quality' event; the tier and scale it reports are what #syncQuality compares with. */
  #emitQuality(scale: number, quality: QualityTier, reason: LumiCellsEvents['quality']['reason']) {
    this.#reportedQuality = quality;
    this.#reportedScale = scale;
    this.#s.emit('quality', { scale, quality, reason });
  }

  /**
   * The instance now renders at `perf`'s tier (it joined, moved or left a look group): a tier or
   * scale other than the last reported one is reported (reason 'look').
   */
  #syncQuality(perf: { readonly quality: QualityTier; readonly scale: number }): void {
    const own = this.#controller.perf;
    const quality = this.#reportedQuality ?? own.quality;
    const scale = this.#reportedQuality ? this.#reportedScale : own.scale;
    if (perf.quality === quality && perf.scale === scale) return;
    this.#emitQuality(perf.scale, perf.quality, 'look');
  }

  /** The instance's own clock starts where `g`'s last frame was (its next dt spans the gap). */
  #ownAfterLook(g: LookGroup): void {
    this.#controller.invalidateGpu();
    // Its own timing window is from before it joined.
    this.#controller.perf.resetWindow();
    if (g.updatedAt >= 0) this.#lastNow = g.updatedAt;
    this.#accMs = 0;
    this.#skip = 0;
    this.#lookFresh = false;
    this.#lookKey = null;
  }

  /** What the instance shows now (`Stats.look`); listeners hear about changes (deferred). */
  #setLookShown(look: InstanceLook, reason: LookChangeReason): void {
    const st = this.#stats;
    st.look = look;
    st.groupSize = look === 'group' ? (this.#seat?.member?.members.length ?? 1) : 1;
    const previous = this.#lookShown;
    if (previous === look) return;
    this.#lookShown = look;
    // Deferred: joins and leaves happen inside frame phases and the renderer's passes.
    queueMicrotask(() => {
      if (this.#dead) return;
      const groupSize = look === 'group' ? (this.#seat?.member?.members.length ?? 1) : 1;
      this.#s.emit('look', { look, previous, reason, groupSize });
    });
  }

  /** The shared renderer drew (and copied) the frame this instance submitted, or could not. */
  #onPresented(drawn: boolean, shown: boolean, now: number): void {
    const seat = this.#seat;
    if (this.#dead || !seat) return;
    const g = seat.member;
    // Drawn: the slot consumed the one-shot inputs (uploads, life reset). A member's own
    // controller drew nothing (its group's slot did).
    if (drawn && !g) this.#controller.commitFrame();
    if (shown) {
      this.#presentEma += (seat.copyMs - this.#presentEma) * 0.1;
      if (!this.#drawnSinceMount) this.#showFirstFrame();
      if (!g) this.#lookFresh = false;
    }
    let cpu = this.#updateMs + seat.drawMs + seat.copyMs;
    if (g) {
      // The group's update and draw, shared by its members.
      cpu = (g.updateMs + (g.seat?.drawMs ?? 0)) / Math.max(1, g.members.length) + seat.copyMs;
      if (g.qualityEpoch !== this.#lookQuality) {
        this.#lookQuality = g.qualityEpoch;
        const q = g.qualityChange;
        this.#emitQuality(q.scale, q.quality, q.reason);
      }
    }
    this.#finishFrame(cpu, this.#sharedDt, this.#sharedIdeal, now, seat.stats.gpuMs);
  }

  /** The canvas shows a frame for the first time since it was mounted (or rebuilt). */
  #showFirstFrame(): void {
    const view = this.#view;
    this.#drawnSinceMount = true;
    this.#hiddenDraws = 0;
    view.setCanvasVisible(true);
    view.dropStandIn();
    view.hidePoster();
    if (!this.#readyEmitted) {
      this.#readyEmitted = true;
      this.#s.emit('ready', undefined);
    }
  }

  /** Per-frame bookkeeping after the frame was drawn (or not): timings, events, stats. */
  #finishFrame(cpu: number, dt: number, ideal: number, now: number, gpuMs: number | null): void {
    const s = this.#s;
    const c = this.#controller;
    const perf = c.perf;
    this.#lastCpu = cpu;
    this.#cpuEma += (cpu - this.#cpuEma) * 0.1;
    this.#time += dt;
    this.#statsFrames++;

    if (c.geometryChanged) {
      c.geometryChanged = false;
      const g = c.geo;
      s.emit('resize', {
        width: g.canvasCssW - 2 * c.getConfig().render.overflow,
        height: g.canvasCssH - 2 * c.getConfig().render.overflow,
        cols: g.cols,
        rows: g.rows,
        dpr: g.effDpr,
        scale: perf.scale,
      });
    }
    if (s.hasListeners('frame')) {
      const fe = this.#frameEvent;
      fe.time = this.#time;
      fe.dt = dt;
      s.emit('frame', fe);
    }
    if (now - this.#statsAt >= STATS_INTERVAL) {
      const span = now - this.#statsAt;
      this.#renderFps = this.#statsAt > 0 ? (this.#statsFrames * 1000) / span : 1000 / ideal;
      this.#statsAt = now;
      this.#statsFrames = 0;
      this.#updateStats(gpuMs);
      if (s.hasListeners('stats')) s.emit('stats', statsCopy(this.#stats, this.groupSize));
    }
  }

  #updateStats(gpuMs: number | null): void {
    const c = this.#controller;
    const g = c.geo;
    const group = this.#seat?.member ?? null;
    // A member renders at its group's adaptive tier.
    const perf = group ? group.controller.perf : c.perf;
    const s = this.#stats;
    s.groupSize = group ? group.members.length : 1;
    s.fps = this.#renderFps;
    s.frameMs = this.#renderFps > 0 ? 1000 / this.#renderFps : 0;
    s.cpuMs = this.#cpuEma;
    s.gpuMs = gpuMs;
    s.vsyncMs = perf.vsyncMs;
    s.missRatio = perf.missRatio;
    s.scale = perf.scale;
    s.quality = perf.quality;
    const seat = this.#seat;
    if (group && seat) {
      // A member's own controller idles: what its canvas shows is its crop of the group's frame.
      const gg = group.controller.geo;
      const p = gg.pitchPx > 0 ? gg.pitchPx : 1;
      s.dpr = gg.effDpr;
      s.pixels = seat.cropW * seat.cropH;
      s.cols = Math.round(seat.cropW / p);
      s.rows = Math.round(seat.cropH / p);
      s.lifts = group.controller.lifts.written;
    } else {
      s.dpr = g.effDpr;
      s.pixels = g.canvasW * g.canvasH;
      s.cols = g.cols;
      s.rows = g.rows;
      s.lifts = c.lifts.written;
    }
    s.influences = c.influences.activeCount;
    s.softwareFallback = this.#software;
    if (seat) {
      // A copy (the renderer's own object changes every frame), with reducers of its own.
      const src = seat.stats;
      let d = this.#sharedStats;
      if (d) {
        const reducers = d.reducers;
        Object.assign(d, src);
        d.reducers = Object.assign(reducers, src.reducers);
      } else {
        d = { ...src, reducers: { ...src.reducers } };
        this.#sharedStats = d;
      }
      s.shared = d;
      s.presentMs = this.#presentEma;
    }
  }

  #applyPixelCap(): void {
    let cap = Number.POSITIVE_INFINITY;
    if (this.#s.coarse) cap = COARSE_MAX_PIXELS;
    if (this.#software) cap = Math.min(cap, SOFTWARE_MAX_PIXELS);
    this.#pixelCap = cap;
    this.#controller.setPixelCap(cap);
  }

  /**
   * The display may have changed (DPR change, resume from a hidden tab): adaptive quality and
   * the shared frame budget forget the refresh rate they learned, and a calibration measures it
   * again.
   */
  relearnDisplay(): void {
    this.#controller.perf.resetVsync();
    peekSharedRenderer()?.load.resetVsync();
    requestDisplayCalibration();
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
