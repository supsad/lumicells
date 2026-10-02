/**
 * Public API types of the core. The facade (LumiCells), the React wrapper and the Web Component
 * all speak these types, so they are kept in one dependency-free module.
 */

import type {
  LumiCellsConfig,
  LumiCellsConfigInput,
  ModulatablePath,
  ParamPath,
  PresetId,
} from '../schema';

export type ConfigSource = 'api' | 'stand' | 'attribute' | 'import' | 'preset';

/**
 * How much an instance matters when the page's WebGL context budget is full (see
 * `LumiCells.configure`). Among visible instances a higher priority keeps (or takes) a context
 * first; offscreen instances give theirs up before any visible one, whatever their priority.
 * An instance with `render.pauseOffscreen: false` draws wherever it is and ranks as visible.
 * At equal priority an `own` instance ranks above an `auto` one (which has the shared renderer
 * to go to), and an `auto` instance never takes the context of a visible `own` one.
 */
export type InstancePriority = 'high' | 'normal' | 'low';

/**
 * How an instance gets its pixels to the screen (`Stats.renderer`, the `renderer` event):
 * - `own`    a WebGL context of its own on a canvas in the host: no copies, isolated from other
 *            instances' context losses, but it takes one slot of the page's context budget
 *            (`LumiCells.configure({ maxContexts })`);
 * - `shared` one WebGL context for all shared instances of the page: each draws into a region
 *            of a common offscreen canvas (the atlas) and is copied into a 2D canvas in its host
 *            every frame. Any number of instances cost one context (on top of `maxContexts`), at
 *            the price of one copy per instance and frame; a loss of the shared context affects
 *            them all (they keep their last frame until it is back).
 */
export type InstanceRenderer = 'own' | 'shared';

/**
 * The renderer an instance asks for (`LumiCellsOptions.renderer`, `Stats.rendererMode`):
 * - `auto`   (default) the instance picks one and keeps re-evaluating it: an instance whose canvas
 *            covers at least `promoteArea` megapixels (device px) or a quarter of the viewport
 *            gets a context of its own while the budget has room (a hero, a full-screen
 *            background), everything else uses the shared renderer. When the budget is full it
 *            uses the shared renderer instead of waiting, and takes a context of its own once one
 *            frees up. Resizes switch it with hysteresis (own below 0.7x the threshold goes
 *            shared, shared from 1x goes own) and only after the size has held still for about a
 *            second, so dragging a resize handle never flips it back and forth. Among instances
 *            that compete for contexts, `priority: 'high'` wins first, except that an `auto`
 *            instance never takes the context of a visible `own` one (see InstancePriority): it
 *            stays on the shared renderer instead. Use `own` with `priority: 'high'` to
 *            guarantee a context;
 * - `own`    always a context of its own; waits (poster) while the budget is full;
 * - `shared` always the shared renderer.
 */
export type RendererMode = 'auto' | InstanceRenderer;

/**
 * Why the renderer of an instance changed (`renderer` event):
 * - `promote`  `auto`: the instance is large enough for a context of its own and got one;
 * - `demote`   `auto`: the instance became too small for a context of its own;
 * - `budget`   `auto`: the context budget is full (or a higher ranked instance took the slot),
 *              so the instance uses the shared renderer instead of waiting;
 * - `explicit` `setRenderer()` (or a wrapper prop or attribute) asked for the other renderer.
 */
export type RendererChangeReason = 'promote' | 'demote' | 'budget' | 'explicit';

/**
 * Which picture an instance shows (`LumiCellsOptions.look`, `setLook()`):
 * - `own`    (default) an animation of its own: its own clock, random lifts and runtime layers;
 * - `shared` cards whose config draws the same picture share ONE: it is rendered once per frame
 *            and every card shows a crop of it (one draw for any number of identical cards, plus
 *            one copy each). A card shares only while it draws nothing of its own (no influence,
 *            bound element, pointer light or hover lift, pulse, forced lift, modulator,
 *            `setEnergy()`, config transition or debug view): it leaves its group the moment it
 *            gets one, continuing the group's picture with the same clock, cells and lifted cells
 *            (the pattern of a card smaller than its group, or shifted in it, lays out for the
 *            card's own size), and rejoins about 2 seconds after the last one is gone (and the
 *            last activity of its own is over). All cards of a group animate in
 *            sync (see `lookOffset`). Needs the shared renderer: with `renderer: 'auto'` it keeps
 *            the instance on the shared renderer, `renderer: 'own'` wins over it.
 */
export type LookMode = 'own' | 'shared';

/** What an instance shows now (`Stats.look`): its own animation, or its group's picture. */
export type InstanceLook = 'own' | 'group';

/**
 * Why the look of an instance changed (`look` event):
 * - `join`     it joined a group (`look: 'shared'`, nothing of its own to draw);
 * - `layers`   it got something of its own to draw (an influence, a pulse, ..., see LookMode);
 * - `config`   its config changed: it no longer draws its group's picture;
 * - `explicit` `setLook('own')` (or a wrapper prop or attribute);
 * - `renderer` it gave its shared slot back: parked, moved to a context of its own, or failed.
 */
export type LookChangeReason = 'join' | 'layers' | 'config' | 'explicit' | 'renderer';

/**
 * Lifecycle of an instance's GPU side (`Stats.state`):
 * - `pending`  no context yet: not started, the engine's chunk still loading, not near the
 *              viewport yet, or queued for creation;
 * - `waiting`  (`renderer: 'own'`) near the viewport, but the context budget is full of
 *              instances that rank higher: the poster is shown until a context frees up;
 * - `live`     owns a WebGL context, or a slot on the shared one (drawing, paused offscreen or
 *              compiling its first frame);
 * - `parked`   gave its context (or shared slot) back (off screen for `parkAfterMs`, or evicted
 *              by a higher ranked instance): poster shown, config and runtime layers kept,
 *              rebuilt when it comes back near the viewport;
 * - `lost`     the browser took the context away (for a shared instance: the shared one, while
 *              its canvas keeps the last frame); waiting for it to be restored;
 * - `failed`   no WebGL2, a shader/resource failure, or the engine's chunk could not be loaded:
 *              the poster stays;
 * - `destroyed` after `destroy()`: no context, no canvas, nothing left to restore.
 */
export type InstanceState =
  | 'pending'
  | 'waiting'
  | 'live'
  | 'parked'
  | 'lost'
  | 'failed'
  | 'destroyed';

/**
 * Page-wide settings of every LumiCells instance (`LumiCells.configure`). Safe to call before
 * any instance exists and on the server (it touches no DOM).
 */
export interface ConfigureOptions {
  /**
   * Most WebGL contexts of their own LumiCells instances may hold at once on the page (the
   * shared renderer's one context comes on top). `'auto'` (default): 4, or 2 on touch devices
   * (`(pointer: coarse)`). Browsers keep about 16 contexts per page (fewer on phones) and kill
   * the oldest one past that; staying well below leaves room for the app's own WebGL. When the
   * budget is full, `renderer: 'auto'` instances use the shared renderer and `renderer: 'own'`
   * ones show their poster until a context frees up; offscreen instances give their context to
   * visible ones first. Lowering it evicts the lowest ranked instances at once (`auto` ones move
   * to the shared renderer, `own` ones park).
   */
  maxContexts?: number | 'auto';
  /**
   * An instance that stays farther than about one viewport from the screen for this long (ms)
   * releases its GPU resources and context and shows its poster; it is rebuilt when it comes
   * back (the Life automaton reseeds, everything else continues). Default 10000; `Infinity`
   * (or anything above 2147483647 ms, about 24.8 days, the longest timer delay) never parks.
   * Instances with `render.pauseOffscreen: false` are never parked. Inside a scroll container
   * "about one viewport" means one container size where the browser supports
   * IntersectionObserver `scrollMargin` (Chrome, Edge 120+); elsewhere a host outside the
   * container's visible part counts as far away.
   */
  parkAfterMs?: number;
  /**
   * Most engines (WebGL contexts) created per frame, default 1. Creating one costs several
   * milliseconds of main-thread time, so a list of backgrounds comes alive over a few frames
   * instead of one long task.
   */
  createPerFrame?: number;
  /**
   * Pixel budget of the shared renderer's atlas in megapixels (instances with
   * `renderer: 'shared'` that are drawing). `'auto'` (default): 4, or 2 on touch devices. When
   * the drawing shared instances need more at full resolution, all of them render at a lower
   * resolution, stretched to their size: the grid and the cell size on screen stay, only the
   * sharpness drops (each instance's factor snaps down to a whole device-px cell pitch, never
   * below 3 device px: an instance whose cells are already that small keeps its resolution and
   * the budget is exceeded). None is dropped. The budget caps the full-resolution size; adaptive
   * quality lowers the resolution further on top of it.
   */
  sharedBudget?: number | 'auto';
  /**
   * Renderer of the instances created afterwards that do not ask for one (`renderer` option,
   * React prop, `<lumi-cells renderer>`). Default `'auto'`. Existing instances keep theirs.
   */
  renderer?: RendererMode;
  /**
   * `renderer: 'auto'`: canvas size, in megapixels of device pixels (overflow margin included),
   * from which an instance prefers a context of its own. Default 0.5. An instance covering at
   * least a quarter of the viewport prefers one too, whatever its size. Existing `auto`
   * instances re-evaluate against the new value (with the usual dwell).
   */
  promoteArea?: number;
  /**
   * Frame-rate cap of the inactive shared instances (`renderer: 'shared'`, or `auto` ones on
   * the shared renderer). An instance is active while the pointer is over its host, for about a
   * second after a pulse, a lift, an influence that moved or changed, a config transition or a
   * modulated value. Active ones, and the largest drawing shared instance whatever its state,
   * always run at the full rate. The others present every n-th display frame, spread evenly over the
   * frames (half of them on even frames, half on odd ones at n = 2); their animation time runs
   * on, they only show fewer frames. A number caps them at that rate (snapped to a whole divisor
   * of the display refresh); `0` turns it off. `'auto'` (default): only when needed, i.e. more
   * than 8 shared instances drawing (at most 60 fps, and at most half the refresh), or the page
   * missing its frame budget or copies being expensive (down to about 30, then 15 fps; a step
   * that would not lower the rate is skipped, and on a 30 Hz display the last one is 10 fps),
   * and back up once the budget allows (see `Stats.shared.reducers`).
   */
  secondaryMaxFps?: number | 'auto';
  /**
   * Lite pipeline of the shared instances: the bloom and haze blurs run inside one glow pass
   * (2-D kernels at cell resolution) instead of separable passes of their own, 2 glow passes
   * instead of 5, with a very close look. It goes by activity only: an inactive instance (see
   * `secondaryMaxFps`) may draw lite even when it is the largest one and runs at the full rate.
   * `'auto'` (default): inactive instances whose canvas is under about 0.15 megapixels, or all
   * inactive ones while more than 12 shared instances draw; `true`: every inactive shared
   * instance; `false`: never.
   * An instance with a context of its own uses it only at the adaptive `'low'` tier (unless
   * `false`).
   */
  lite?: boolean | 'auto';
}

export interface LumiCellsOptions {
  /** Partial config merged over the preset (or defaults). */
  config?: LumiCellsConfigInput;
  /** Named preset used as the base under `config`. */
  preset?: PresetId;
  /**
   * Start right away (default true). The WebGL context itself is created lazily, once the host
   * comes within about one viewport of the screen (see `LumiCells.configure`).
   */
  autoStart?: boolean;
  /** Shortcut for `interaction.pointer` + `interaction.click`. */
  interactive?: boolean;
  /** Priority for the page's context budget (default `'normal'`). */
  priority?: InstancePriority;
  /**
   * `'auto'` (the default, see `LumiCells.configure({ renderer })`): large instances get a WebGL
   * context of their own while the budget has room, the others share one (see RendererMode).
   * `'own'`: always a context of its own. `'shared'`: always the page's shared renderer, copied
   * into a 2D canvas in the host (see InstanceRenderer). `setRenderer()` switches later.
   */
  renderer?: RendererMode;
  /**
   * `'shared'`: share one picture with every card whose config draws the same (see LookMode);
   * `'own'` (default): an animation of its own. `setLook()` changes it later.
   *
   * A card shows the part of its group's picture its own canvas covers, never scaled: a group of
   * equal cards shows exactly what each would draw alone. Cards of different sizes share a picture
   * only when their cells have the same size (`grid.sizing: 'pitch'`, or `'count'` with the same
   * shorter side); a card smaller than its group then shows the middle of a picture laid out for
   * the group's size (with its own cells, where it would draw them alone), and with
   * `render.overflow` its margin shows the group's cells.
   */
  look?: LookMode;
  /**
   * `look: 'shared'`: shifts this card's window into its group's picture by up to this share of
   * its size on each axis (0 to 0.5, whole cells, seeded per instance), so cards side by side do
   * not show the same cells in sync. The group renders larger to make room. Default 0 (every card
   * shows the centered window). The cells keep the card's own size (with `grid.sizing: 'count'`
   * too); the pattern is laid out for the larger picture.
   */
  lookOffset?: number;
}

export interface ConfigUpdateOptions {
  /** Tween duration in ms; defaults to `config.transition`. 0 applies instantly. */
  transition?: number;
  /** Who made the change; listeners use it to ignore their own echoes. */
  source?: ConfigSource;
}

/**
 * Coordinate spaces for influences, pulses and lifts:
 * - `host`   CSS px relative to the host element's top-left corner;
 * - `client` viewport CSS px (e.g. `PointerEvent.clientX`);
 * - `norm`   0..1 of the host size;
 * - `cells`  grid cells, (0, 0) is the top-left visible cell.
 */
export type Space = 'host' | 'client' | 'norm' | 'cells';

export type InfluenceType = 'light' | 'shadow' | 'lift' | 'seed' | 'repel';

export interface InfluenceShape {
  /** Center X in the chosen space. */
  x: number;
  /** Center Y in the chosen space. */
  y: number;
  /** Width of a rounded rectangle. Omit (with `h`) for a circle of `radius`. */
  w?: number;
  h?: number;
  /** Circle radius when `w`/`h` are omitted. */
  radius?: number;
  /** Corner radius of the rectangle. */
  cornerRadius?: number;
}

export interface InfluenceOptions extends Partial<InfluenceShape> {
  space?: Space;
  type?: InfluenceType;
  /** 0..2, defaults to `interaction.influenceStrength`. */
  strength?: number;
  /** Soft edge width in cells, defaults to `interaction.influenceFalloff`. */
  falloff?: number;
  /** Tint color (hex). */
  color?: string;
  /** 0 keeps the palette color, 1 fully uses `color`. */
  colorMix?: number;
  /** Higher priority wins a GPU slot when more influences exist than the shader can take. */
  priority?: number;
  fadeInMs?: number;
  fadeOutMs?: number;
  /** Auto-dispose after this many ms. */
  ttlMs?: number;
  /** Disposes the influence when aborted. */
  signal?: AbortSignal;
}

export interface Handle {
  dispose(): void;
  [Symbol.dispose](): void;
}

/**
 * Patch for `InfluenceHandle.update()`. `cornerRadius: null` resets the corner radius: for a
 * bound element it follows the element's border-radius again; an explicit number sticks.
 */
export type InfluenceUpdate = Omit<Partial<InfluenceOptions>, 'cornerRadius'> & {
  cornerRadius?: number | null;
};

export interface InfluenceHandle extends Handle {
  readonly id: number;
  /** True while the influence occupies a GPU slot. */
  readonly active: boolean;
  update(patch: InfluenceUpdate): void;
}

export interface BindElementOptions
  extends Omit<InfluenceOptions, 'x' | 'y' | 'w' | 'h' | 'space'> {
  /**
   * How the element position is tracked:
   * - `auto`   reads the rect only while something may have moved it (resize, scroll, running
   *            CSS transitions/animations, Web Animations);
   * - `frame`  reads the rect every frame (JS-animated elements);
   * - `manual` never reads the DOM, call `handle.update({ x, y, w, h })` in host space.
   */
  track?: 'auto' | 'frame' | 'manual';
  /** Grows the element rect by this many CSS px on each side. */
  padding?: number;
}

export interface PulseOptions {
  x: number;
  y: number;
  space?: Space;
  strength?: number;
  /** Ring speed in cells per second. */
  speed?: number;
  /** Ring width in cells. */
  width?: number;
  color?: string;
  colorMix?: number;
  /** Lifetime in seconds. */
  duration?: number;
}

/**
 * A forced lift. Like the random ones, forced lifts respect the user's accessibility
 * preference: with `render.reducedMotion: 'respect'` and the OS "reduce motion" setting on,
 * `lift()` is a no-op (and pointer hover lifts are off).
 */
export interface LiftOptions {
  x: number;
  y: number;
  space?: Space;
  /** How many cells to lift around the point. */
  count?: number;
  /** Spread radius in cells. */
  radius?: number;
}

export type ModulationSource = number | (() => number) | { get(): number };

export interface ModulateOptions {
  blend?: 'add' | 'mul' | 'override' | 'max';
  /** Exponential smoothing half-life of the source, ms. */
  smoothingMs?: number;
  signal?: AbortSignal;
}

export interface ModulatorHandle extends Handle {
  /** Replaces the source with a constant value. */
  set(value: number): void;
}

export type QualityTier = 'high' | 'medium' | 'low';

/** Cost reducers acting on one instance (`Stats.reducers`). */
export interface InstanceReducers {
  /** Draws with the lite pipeline (see `LumiCells.configure({ lite })`). */
  lite: boolean;
  /**
   * Presents every n-th display frame (1: every frame): the shared renderer's secondary rate
   * (see `LumiCells.configure({ secondaryMaxFps })`) or `render.maxFps`, whichever is lower.
   */
  frameDivisor: number;
}

/**
 * Why the inactive shared instances present fewer frames (`SharedReducers.reason`):
 * - `off`    they do not (nothing needs it, or `secondaryMaxFps: 0`);
 * - `fixed`  `secondaryMaxFps` is a number;
 * - `crowd`  more than 8 shared instances draw;
 * - `budget` the page misses its frame budget (main-thread or GPU time);
 * - `copy`   copying the shared frames into the instances' canvases is expensive.
 */
export type SharedReducerReason = 'off' | 'fixed' | 'crowd' | 'budget' | 'copy';

/** The shared renderer's cost reducers, page-wide (`SharedRendererStats.reducers`). */
export interface SharedReducers {
  /** Frame divisor of the inactive instances (1: every instance presents every frame). */
  frameDivisor: number;
  /**
   * 0 none, 1 crowded (at most 60 fps and half the refresh), 2 about 30 fps, 3 about 15 fps
   * (`secondaryMaxFps: 'auto'`; 10 fps on a 30 Hz display). A level at the same rate as the one
   * below is never reported: at 60 Hz and below, 30 fps is level 1 and the next step is 3.
   */
  level: number;
  reason: SharedReducerReason;
  /** Instances presenting at the lower rate now. */
  secondary: number;
  /** Instances drawing with the lite pipeline now. */
  lite: number;
  /** Display refresh interval the reducers plan with, ms (calibrated when it could be measured). */
  intervalMs: number;
  /**
   * The copy cost lowered the shared atlas budget to this many megapixels (null: it did not,
   * see `copyMsPerMpx`).
   */
  copyBudget: number | null;
}

/**
 * The shared renderer as a whole (`Stats.shared` of every shared instance): the one device all
 * shared instances draw on. Frame figures are smoothed over about ten frames.
 */
export interface SharedRendererStats {
  /** GPU time of every shared instance's passes in one frame, ms (null without a GPU timer). */
  gpuMs: number | null;
  /** Main-thread time of the draw series (every shared instance's GL commands), ms. */
  drawMs: number;
  /** Main-thread time of the copy series (every drawImage into the instances' 2D canvases), ms. */
  copyMs: number;
  /**
   * Part of `copyMs` no single copy owns, ms: the snapshot of the atlas (staged copies), or the
   * flush the first drawImage from the WebGL canvas pays (direct copies, estimated from frames
   * with several copies). Every instance's `presentMs` carries a share of it by pixels.
   */
  snapshotMs: number;
  /**
   * Copy series cost (snapshot included, canvas resizes and set-up excluded) per megapixel
   * copied, ms, averaged over 60 settled frames: no instance joining or resizing its canvas,
   * the copy path decided. Measured for the current atlas size and budget scale: null until
   * then, and again after either changes. Cheap on GPU-backed 2D canvases (Chrome, Safari); a
   * software 2D canvas reads every copy back from the GPU and costs much more. Much of the cost
   * is per call and per frame rather than per pixel, so the figure falls as regions grow.
   */
  copyMsPerMpx: number | null;
  /** Size of the shared canvas (the atlas), device px. */
  atlasWidth: number;
  atlasHeight: number;
  /** Instances holding a slot on the shared device. */
  members: number;
  /** Instances drawing into the atlas (each has a region there). */
  regions: number;
  /** Resolution factor all shared instances render at because of `sharedBudget` (1 = full). */
  scale: number;
  /**
   * The last copy series went through one snapshot of the atlas (a 2D staging canvas) instead of
   * copying every region from the WebGL canvas directly. Chosen by measurement: where every
   * drawImage() from a WebGL canvas reads back the whole canvas (Firefox), one readback per
   * frame instead of one per instance.
   */
  copyStaged: boolean;
  /**
   * The snapshot of the last staged copy series was read with readPixels (only the part of the
   * atlas in use) rather than drawn from the WebGL canvas (which, where it costs a readback,
   * reads all of it). Chosen by measurement too.
   */
  copyReadback: boolean;
  /** The per-instance cost reducers page-wide (lower frame rate, lite pipeline). */
  reducers: SharedReducers;
  /** Look groups (`look: 'shared'`): each is drawn once per frame, in one region of the atlas. */
  groups: number;
  /** Regions drawn in the last frame (look groups count once, whatever their members). */
  draws: number;
}

export interface Stats {
  fps: number;
  frameMs: number;
  /** Main-thread time of this instance per frame (update, GL commands and, when shared, its copy), ms. */
  cpuMs: number;
  /**
   * GPU time per frame, ms, null without a GPU timer. For a shared instance it is the time of
   * the whole shared device (every shared instance's passes), which adaptive quality reacts to.
   */
  gpuMs: number | null;
  vsyncMs: number;
  missRatio: number;
  scale: number;
  quality: QualityTier;
  dpr: number;
  pixels: number;
  cols: number;
  rows: number;
  lifts: number;
  influences: number;
  softwareFallback: boolean;
  /** GPU lifecycle state (always current, unlike the frame figures sampled about 4 times a second). */
  state: InstanceState;
  /**
   * The renderer the instance uses, or is about to use (always current). An `auto` instance
   * reports `'shared'` until it first asks for a GPU side (near the viewport), where it picks one.
   */
  renderer: InstanceRenderer;
  /** The renderer the instance asks for (`renderer` option or `setRenderer()`). */
  rendererMode: RendererMode;
  /**
   * Main-thread time of this instance's copy into its 2D canvas, with its share (by pixels) of
   * the copy series' snapshot, ms (null for `own`: no copy).
   */
  presentMs: number | null;
  /** The shared renderer's device (null for `own`). */
  shared: SharedRendererStats | null;
  /** Cost reducers acting on this instance now (always current). */
  reducers: InstanceReducers;
  /**
   * What the instance shows (always current): `'group'` while it is a member of a look group
   * (`look: 'shared'`), else `'own'` (also while parked: it rejoins when it comes back).
   */
  look: InstanceLook;
  /** Cards showing the same picture (this one included) while `look` is `'group'`, else 1. */
  groupSize: number;
}

export type DebugView = 'final' | 'field' | 'halo' | 'bloom' | 'haze' | 'cells';

export interface LumiCellsEvents {
  ready: undefined;
  /** Reused object, do not retain. */
  frame: { time: number; dt: number };
  /** Emitted about 4 times per second. */
  stats: Stats;
  resize: { width: number; height: number; cols: number; rows: number; dpr: number; scale: number };
  /**
   * Coalesced per frame (or per microtask when not rendering), never synchronously inside the
   * setter: consecutive changes of one source are merged into one event with the union of
   * their paths; a change from another source starts a new event, so every event carries only
   * its own source's paths (listeners can safely ignore their own echoes by `source`).
   */
  config: { config: Readonly<LumiCellsConfig>; changed: ParamPath[]; source: ConfigSource };
  /**
   * Adaptive quality stepped (`'slow'`, `'recovered'`, `'locked'`), or the instance now renders
   * at another tier because it joined, moved or left a shared look group (`'look'`).
   */
  quality: {
    scale: number;
    quality: QualityTier;
    reason: 'slow' | 'recovered' | 'locked' | 'look';
  };
  /**
   * Non-fatal warnings. Codes include `software-webgl` (CPU rasterizer), `influence-overflow`
   * (more influences than GPU slots) and `context-budget` (once per page: a visible
   * `renderer: 'own'` instance waits because the WebGL context budget is full, see
   * `LumiCells.configure`).
   */
  warn: { code: string; message: string };
  error: Error;
  /**
   * The poster is shown instead of the animation. `no-webgl2`, `compile` and `load` are final;
   * `context-lost` lasts until `contextrestored`; `budget` means a visible `renderer: 'own'`
   * instance waits for a WebGL context because the page budget
   * (`LumiCells.configure({ maxContexts })`) is full of instances that rank higher (an instance
   * with `render.pauseOffscreen: false` counts as visible): it starts drawing (with 'ready' if it
   * never drew before) as soon as a context frees up. `auto` instances never wait: they use the
   * shared renderer instead (see the `renderer` event). `load`: the engine, a chunk of its own
   * that loads behind the poster, could not be loaded (a network error; an `error` event carries
   * it). The failure lasts for the page: browsers keep a failed dynamic import, so instances
   * created later fall back the same way until the page is reloaded.
   */
  fallback: { reason: 'no-webgl2' | 'compile' | 'context-lost' | 'budget' | 'load' };
  /**
   * The renderer changed (`Stats.renderer`): an `auto` instance was promoted, demoted or moved
   * by the context budget, or `setRenderer()` asked for the other one. Not emitted for the first
   * choice of an `auto` instance (nothing was drawn before it). An `auto` instance that picks
   * again when it comes back from parking reports the switch once the new renderer serves it,
   * and not at all when the budget refuses it a context and it stays on the renderer it had.
   * The poster (or, for `auto`, the last frame) covers the switch until the new renderer draws.
   */
  renderer: {
    renderer: InstanceRenderer;
    previous: InstanceRenderer;
    reason: RendererChangeReason;
  };
  /**
   * The look changed (`Stats.look`): the instance joined a look group (`look: 'shared'`), or left
   * one (see LookChangeReason). `groupSize`: members of the group it is in now (1 when `'own'`).
   */
  look: {
    look: InstanceLook;
    previous: InstanceLook;
    reason: LookChangeReason;
    groupSize: number;
  };
  contextlost: undefined;
  contextrestored: undefined;
  destroy: undefined;
}

export type LumiCellsEventName = keyof LumiCellsEvents;

export type { LumiCellsConfig, LumiCellsConfigInput, ModulatablePath, ParamPath, PresetId };
