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
 */
export type InstancePriority = 'high' | 'normal' | 'low';

/**
 * Lifecycle of an instance's GPU side (`Stats.state`):
 * - `pending`  no context yet: not started, not near the viewport yet, or queued for creation;
 * - `waiting`  near the viewport, but the context budget is full of instances that rank higher:
 *              the poster is shown until a context frees up;
 * - `live`     owns a WebGL context (drawing, paused offscreen or compiling its first frame);
 * - `parked`   gave its context back (off screen for `parkAfterMs`, or evicted by a higher
 *              ranked instance): poster shown, config and runtime layers kept, rebuilt when it
 *              comes back near the viewport;
 * - `lost`     the browser took the context away; waiting for it to be restored;
 * - `failed`   no WebGL2 or a shader/resource failure: the poster stays;
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
   * Most WebGL contexts LumiCells may own at once on the page. `'auto'` (default): 4, or 2 on
   * touch devices (`(pointer: coarse)`). Browsers keep about 16 contexts per page (fewer on
   * phones) and kill the oldest one past that; staying well below leaves room for the app's own
   * WebGL. Instances beyond the budget show their poster; offscreen ones give their context to
   * visible ones first. Lowering it evicts the lowest ranked instances at once.
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

export interface Stats {
  fps: number;
  frameMs: number;
  cpuMs: number;
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
  quality: { scale: number; quality: QualityTier; reason: 'slow' | 'recovered' | 'locked' };
  /**
   * Non-fatal warnings. Codes include `software-webgl` (CPU rasterizer), `influence-overflow`
   * (more influences than GPU slots) and `context-budget` (once per page: a visible instance
   * waits because the WebGL context budget is full, see `LumiCells.configure`).
   */
  warn: { code: string; message: string };
  error: Error;
  /**
   * The poster is shown instead of the animation. `no-webgl2` and `compile` are final;
   * `context-lost` lasts until `contextrestored`; `budget` means a visible instance waits for a
   * WebGL context because the page budget (`LumiCells.configure({ maxContexts })`) is full of
   * instances that rank higher (an instance with `render.pauseOffscreen: false` counts as
   * visible): it starts drawing (with 'ready' if it never drew before) as soon as a context frees
   * up.
   */
  fallback: { reason: 'no-webgl2' | 'compile' | 'context-lost' | 'budget' };
  contextlost: undefined;
  contextrestored: undefined;
  destroy: undefined;
}

export type LumiCellsEventName = keyof LumiCellsEvents;

export type { LumiCellsConfig, LumiCellsConfigInput, ModulatablePath, ParamPath, PresetId };
