/**
 * Public API types of the core. The facade (PixelLife), the React wrapper and the Web Component
 * all speak these types, so they are kept in one dependency-free module.
 */

import type {
  ModulatablePath,
  ParamPath,
  PixelLifeConfig,
  PixelLifeConfigInput,
  PresetId,
} from '../schema';

export type ConfigSource = 'api' | 'stand' | 'attribute' | 'import' | 'preset';

export interface PixelLifeOptions {
  /** Partial config merged over the preset (or defaults). */
  config?: PixelLifeConfigInput;
  /** Named preset used as the base under `config`. */
  preset?: PresetId;
  /** Start rendering right away (default true). */
  autoStart?: boolean;
  /** Shortcut for `interaction.pointer` + `interaction.click`. */
  interactive?: boolean;
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
}

export type DebugView = 'final' | 'field' | 'halo' | 'bloom' | 'haze' | 'cells';

export interface PixelLifeEvents {
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
  config: { config: Readonly<PixelLifeConfig>; changed: ParamPath[]; source: ConfigSource };
  quality: { scale: number; quality: QualityTier; reason: 'slow' | 'recovered' | 'locked' };
  warn: { code: string; message: string };
  error: Error;
  fallback: { reason: 'no-webgl2' | 'compile' | 'context-lost' };
  contextlost: undefined;
  contextrestored: undefined;
  destroy: undefined;
}

export type PixelLifeEventName = keyof PixelLifeEvents;

export type { ModulatablePath, ParamPath, PixelLifeConfig, PixelLifeConfigInput, PresetId };
