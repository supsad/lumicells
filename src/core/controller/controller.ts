/**
 * Controller: all per-frame state of one LumiCells instance, in pure TypeScript (no DOM, no GL).
 *
 * It owns the config layers (base -> tweened -> modulated), the palette LUT, the phase clock,
 * influences, pulses, lifts, grid geometry and the adaptive quality state, and turns them into
 * FrameInputs for the engine. Every buffer is preallocated: update() allocates nothing.
 *
 * Creation is cheap when many controllers start from the same config input (a list of cards with
 * one preset): the normalized config, the ParamStore values after its reset and the CSS poster
 * are kept per input (see initState), the palette LUT per palette (lut.ts), and the store's
 * schema-derived part per layout (tween.ts). Each controller still gets its own config copy.
 */

import {
  cloneData,
  deepMerge,
  diffConfigs,
  getField,
  getPath,
  isPlainObject,
  type LumiCellsConfig,
  type LumiCellsConfigInput,
  type ModulatablePath,
  normalizeConfig,
  normalizePatch,
  type ParamPath,
  posterCss,
  stableStringify,
} from '../../schema';
import {
  FRAME_FLOATS,
  OFF_CLOCK,
  OFF_COUNTS,
  OFF_EPOCH_A,
  OFF_EPOCH_B,
  OFF_GRID,
  OFF_HOST,
  OFF_MISC,
  OFF_ORIGIN,
  OFF_PHASE_A,
  OFF_PHASE_B,
  OFF_SPACE,
  writeEpochPhase,
} from '../engine/frame-block';
import type { FrameInputs } from '../engine/types';
import { Clock, type ClockRates } from './clock';
import {
  computeGeometry,
  computeScaledGeometry,
  createGeometry,
  type Geometry,
  type GeometryInput,
  MIN_PITCH_PX,
} from './geometry';
import {
  type Influence,
  type InfluenceContext,
  type InfluenceInit,
  InfluenceRegistry,
  SPACE_CELLS,
  SPACE_CLIENT,
  SPACE_CODE,
  SPACE_HOST,
  SPACE_NORM,
  type SpaceName,
} from './influences';
import { createParamLayout, type ParamLayout } from './layout';
import { createLiftParams, type LiftParams, LiftScheduler } from './lifts';
import { PaletteLut } from './lut';
import { clamp, hexToLinearInto, mulberry32 } from './math';
import type { ModBlend, ModSource } from './modulators';
import { type PerfChange, PerfController, type QualityMode } from './perf';
import { type PulseInit, PulseList } from './pulses';
import { ParamStore, ScalarTween, type StoreSnapshot } from './tween';

export interface ControllerOptions {
  config?: LumiCellsConfigInput;
  /** Deterministic randomness for tests. */
  random?: () => number;
  /** Reuse a layout (it is pure and identical for every instance). */
  layout?: ParamLayout;
  onWarn?: (code: string, message: string) => void;
}

export interface ConfigChangeOptions {
  transition?: number;
}

/** What the DOM layer measured. */
export interface ViewportInput {
  hostCssW: number;
  hostCssH: number;
  dpr: number;
  /** Exact canvas device px (devicePixelContentBoxSize) or 0. */
  deviceW: number;
  deviceH: number;
}

export interface ControllerModulator {
  set(value: number): void;
  dispose(): void;
  [Symbol.dispose](): void;
}

export interface ControllerInfluenceHandle {
  readonly id: number;
  readonly active: boolean;
  update(patch: InfluenceInit): void;
  dispose(): void;
  [Symbol.dispose](): void;
}

export interface PulseRequest {
  x: number;
  y: number;
  space?: SpaceName;
  strength?: number;
  speed?: number;
  width?: number;
  color?: string;
  colorMix?: number;
  duration?: number;
}

export interface LiftRequest {
  x: number;
  y: number;
  space?: SpaceName;
  count?: number;
  radius?: number;
}

const FORCED_QUEUE = 32;

/**
 * Lowest share scale that keeps the grid (see Controller.setShareScale): the lowest factor the
 * shared pixel budget asks for, scaleForStep(MAX_BUDGET_STEP) in runtime/atlas.ts. Lower ones
 * come only from the atlas's drawable limit.
 */
export const SHARE_GRID_MIN_SCALE = 0.125;

let sharedLayout: ParamLayout | null = null;
/** The layout depends only on the schema: build it once per page (lazily, SSR-safe). */
export function getSharedLayout(): ParamLayout {
  if (!sharedLayout) sharedLayout = createParamLayout();
  return sharedLayout;
}

/**
 * What a controller starts from for one config input (see the header): never handed out, each
 * controller gets a copy of `config`.
 */
interface InitState {
  readonly config: LumiCellsConfig;
  /**
   * `config` as JSON when that round trip is exact (it is for normalized configs: finite
   * numbers, strings, booleans, arrays, plain objects): JSON.parse copies it faster than a walk,
   * mostly while the code is still cold (a page mounting its backgrounds).
   */
  readonly json: string | null;
  readonly store: StoreSnapshot;
  /** posterCss(config), computed on first use. */
  poster: string | null;
  /** lookKeyOf(config), computed on first use. */
  lookKey: string | null;
}

/** Inputs kept per layout (least recently used first out). */
const INIT_MAX = 32;
const initStates = new WeakMap<ParamLayout, Map<string, InitState>>();
let initMisses = 0;

/** How many controllers normalized and reset their config themselves (a cached input does not). */
export function initMissCount(): number {
  return initMisses;
}

/**
 * Exact content key of a config input, or null when it holds anything but plain data (plain
 * objects, arrays, strings, numbers, booleans, null): normalization treats class instances and
 * the like differently from plain objects with the same fields, so those are never cached.
 */
function inputKey(v: unknown, depth = 0): string | null {
  if (v === null) return 'n';
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'number':
      return String(v);
    case 'boolean':
      return v ? 't' : 'f';
    case 'object':
      break;
    default:
      return null;
  }
  if (depth > 16) return null;
  if (Array.isArray(v)) {
    let out = '[';
    for (let i = 0; i < v.length; i++) {
      const k = inputKey(v[i], depth + 1);
      if (k === null) return null;
      out += i > 0 ? `,${k}` : k;
    }
    return `${out}]`;
  }
  if (!isPlainObject(v)) return null;
  const keys = Object.keys(v).sort();
  let out = '{';
  let first = true;
  for (const key of keys) {
    const val = v[key];
    // Normalization ignores undefined values like absent keys.
    if (val === undefined) continue;
    const k = inputKey(val, depth + 1);
    if (k === null) return null;
    out += `${first ? '' : ','}${JSON.stringify(key)}:${k}`;
    first = false;
  }
  return `${out}}`;
}

/** Whether JSON.parse(JSON.stringify(v)) gives back exactly `v` (see InitState.json). */
function jsonExact(v: unknown, depth = 0): boolean {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v) && !Object.is(v, -0);
  if (depth > 16) return false;
  if (Array.isArray(v)) return v.every((x) => jsonExact(x, depth + 1));
  if (!isPlainObject(v)) return false;
  for (const key of Object.keys(v)) {
    if (key === '__proto__' || !jsonExact(v[key], depth + 1)) return false;
  }
  return true;
}

/**
 * Key of the picture a config draws (`look: 'shared'` groups cards by it): the canonical
 * serialization of the normalized config without the paths that never change a frame on their
 * own. `interaction` (pointer, clicks and the defaults of influences and pulses) acts only through
 * runtime layers, which take a card out of its group anyway; `render.pauseOffscreen` only decides
 * when an instance draws; `transition` only shapes a config change, which changes the key.
 */
export function lookKeyOf(config: Readonly<LumiCellsConfig>): string {
  const { interaction: _i, transition: _t, render, ...rest } = config;
  const { pauseOffscreen: _p, ...visual } = render;
  return stableStringify({ ...rest, render: visual });
}

/** Store ids of the parameters read every frame, per layout (they depend on the schema only). */
const idsByLayout = new WeakMap<ParamLayout, ParamIds>();

export class Controller {
  readonly layout: ParamLayout;
  readonly store: ParamStore;
  readonly lut: PaletteLut;
  readonly clock = new Clock();
  readonly influences = new InfluenceRegistry();
  readonly pulses = new PulseList();
  readonly lifts: LiftScheduler;
  readonly perf = new PerfController();
  readonly geo: Geometry = createGeometry();
  readonly frame: FrameInputs;
  /** Set when the geometry changed; the facade clears it after emitting 'resize'. */
  geometryChanged = true;
  destroyed = false;

  private config: LumiCellsConfig;
  private readonly random: () => number;
  private readonly onWarn: ((code: string, message: string) => void) | undefined;
  private readonly sizingMix: ScalarTween;
  private readonly rates: ClockRates = {
    speed: 1,
    flow: 0,
    sphereRotation: 0,
    sphereBreathe: 0,
    pulse: 0,
    wave: 0,
    vortex: 0,
    rain: 0,
    drift: 0,
    lifeRate: 0,
    sparsity: 0,
    flicker: 0,
    sparkle: 0,
    ripple: 0,
  };
  private readonly liftParams: LiftParams = createLiftParams();
  private readonly geoIn: GeometryInput = {
    hostCssW: 300,
    hostCssH: 150,
    overflowCss: 0,
    dpr: 1,
    deviceW: 0,
    deviceH: 0,
    maxDpr: 2,
    maxPixels: 4.2,
    scale: 1,
    cssPitch: 10,
    maxDim: 0,
  };
  private readonly infCtx: InfluenceContext;
  private readonly forced = new Float64Array(FORCED_QUEUE * 5);
  private forcedCount = 0;
  private readonly pulseInit: PulseInit = {
    space: 0,
    x: 0,
    y: 0,
    strength: 0,
    speed: 0,
    width: 0,
    r: 1,
    g: 1,
    b: 1,
    colorMix: 0,
    duration: 1,
    minor: false,
  };
  private readonly tmp = new Float64Array(3);
  private pixelCap = Number.POSITIVE_INFINITY;
  /** Resolution factor of the shared renderer's pixel budget (1 = full resolution). */
  private shareScale = 1;
  /** Geometry at the adaptive scale alone (share scale 1): the grid the share scale keeps. */
  private readonly baseGeo: Geometry = createGeometry();
  /**
   * Geometry at full resolution (adaptive and share scale 1): the natural size the shared budget
   * plans with. Only computed while either scale is below 1 (`geo` is it otherwise).
   */
  private readonly natGeo: Geometry = createGeometry();
  private natSeparate = false;
  /** Shorter side 'count' sizing divides, CSS px (0: the host's own; see setCountBasis). */
  private countBasis = 0;
  private reducedMotion = false;
  private software = false;
  private clientX = 0;
  private clientY = 0;
  private hasViewport = false;
  /** The cached start this config came from (its poster is known), until the first change. */
  private init: InitState | null = null;
  private posterFor: LumiCellsConfig | null = null;
  private posterText = '';
  private lookKeyFor: LumiCellsConfig | null = null;
  private lookKeyText = '';
  /** A change of this instance's own (see takeActivity) since the owner last took it. */
  private activity = true;

  // Resolved entry ids of the parameters read every frame.
  private readonly ids: ParamIds;

  constructor(opts: ControllerOptions = {}) {
    this.random = opts.random ?? mulberry32((Math.random() * 4294967296) >>> 0);
    this.onWarn = opts.onWarn;
    this.layout = opts.layout ?? getSharedLayout();
    const input = opts.config ?? {};
    let key: string | null = null;
    try {
      key = inputKey(input);
    } catch {
      // A getter that throws, or the like: normalization copes, the cache stays out of it.
    }
    let states = initStates.get(this.layout);
    if (!states) {
      states = new Map();
      initStates.set(this.layout, states);
    }
    const hit = key === null ? undefined : states.get(key);
    if (hit) {
      states.delete(key as string);
      states.set(key as string, hit);
      this.config = hit.json !== null ? JSON.parse(hit.json) : cloneData(hit.config);
      this.store = new ParamStore(this.layout, this.config, hit.store);
      this.init = hit;
    } else {
      initMisses++;
      this.config = normalizeConfig(input).config;
      this.store = new ParamStore(this.layout, this.config);
      if (key !== null) {
        const config = cloneData(this.config);
        const state: InitState = {
          config,
          json: jsonExact(config) ? JSON.stringify(config) : null,
          store: this.store.snapshot(),
          poster: null,
          lookKey: null,
        };
        states.set(key, state);
        if (states.size > INIT_MAX) states.delete(states.keys().next().value as string);
        this.init = state;
      }
    }
    this.lut = new PaletteLut(this.config.color.palette, this.config.color.interpolation);
    this.lifts = new LiftScheduler(this.random, this.pulses);
    this.sizingMix = new ScalarTween(this.config.grid.sizing === 'pitch' ? 1 : 0);
    this.perf.setMode(this.config.render.quality);
    this.influences.onOverflow = (alive) =>
      this.warn(
        'influence-overflow',
        `[lumicells] ${alive} influences are alive but only 64 fit on the GPU; lower-priority ones fade out.`,
      );
    this.infCtx = {
      geo: this.geo,
      clientX: 0,
      clientY: 0,
      defaultStrength: 0.8,
      defaultFalloff: 2,
    };

    let ids = idsByLayout.get(this.layout);
    if (!ids) {
      ids = resolveIds(this.store);
      idsByLayout.set(this.layout, ids);
    }
    this.ids = ids;

    this.frame = {
      canvasWidth: 1,
      canvasHeight: 1,
      cols: 1,
      rows: 1,
      pad: 2,
      pitchPx: 8,
      params: this.store.params,
      paramsDirty: true,
      frame: new Float32Array(FRAME_FLOATS),
      lut: this.lut.bytes,
      lutDirty: true,
      lifeSteps: 0,
      lifeReset: true,
      lifeSeed: (this.random() * 4294967296) >>> 0,
      lifeRule: 0,
      lifeBirth: 0,
      lifeSeedDensity: 0.3,
      lifts: this.lifts.instances,
      liftCount: 0,
      bloomSigma: 1.2,
      hazeSigma: 6,
      bloomStrength: 0.8,
      hazeStrength: 0.12,
      quality: 'high',
      opaque: true,
      debugView: 0,
    };
    this.updateGeometry();
  }

  // -------------------------------------------------------------------------------------------
  // Config

  getConfig(): Readonly<LumiCellsConfig> {
    return this.config;
  }

  /** CSS poster of the current config (posterCss), computed once per config. */
  get poster(): string {
    const cfg = this.config;
    if (this.posterFor !== cfg) {
      const init = this.init;
      if (init) {
        init.poster ??= posterCss(cfg);
        this.posterText = init.poster;
      } else {
        this.posterText = posterCss(cfg);
      }
      this.posterFor = cfg;
    }
    return this.posterText;
  }

  /**
   * Key of the picture the current config draws (lookKeyOf), computed once per config: the same
   * string object until the config changes (cards started from one input share it).
   */
  get lookKey(): string {
    const cfg = this.config;
    if (this.lookKeyFor !== cfg) {
      const init = this.init;
      if (init) {
        init.lookKey ??= lookKeyOf(cfg);
        this.lookKeyText = init.lookKey;
      } else {
        this.lookKeyText = lookKeyOf(cfg);
      }
      this.lookKeyFor = cfg;
    }
    return this.lookKeyText;
  }

  /** Merges a partial config; returns the changed leaf paths (schema order). */
  setConfig(patch: LumiCellsConfigInput, opts: ConfigChangeOptions = {}): ParamPath[] {
    if (this.destroyed) return [];
    const { patch: clean } = normalizePatch(patch);
    return this.commit(normalizeConfig(deepMerge(this.config, clean)).config, opts);
  }

  /** Replaces the whole config (missing keys fall back to defaults / `extends`). */
  replaceConfig(input: LumiCellsConfigInput, opts: ConfigChangeOptions = {}): ParamPath[] {
    if (this.destroyed) return [];
    return this.commit(normalizeConfig(input).config, opts);
  }

  getEffective(path: ModulatablePath): number {
    const v = this.store.getEffective(path);
    return Number.isNaN(v) ? (getPath(this.config, path) as number) : v;
  }

  modulate(
    path: ModulatablePath,
    source: ModSource,
    opts: { blend?: ModBlend; smoothingMs?: number; signal?: AbortSignal } = {},
  ): ControllerModulator {
    const store = this.store;
    const m = this.destroyed
      ? null
      : store.addModulator(path, source, opts.blend, opts.smoothingMs);
    let disposed = !m;
    const dispose = () => {
      if (disposed || !m) return;
      disposed = true;
      opts.signal?.removeEventListener('abort', dispose);
      if (!this.destroyed) store.removeModulator(path, m);
    };
    if (m && opts.signal) {
      if (opts.signal.aborted) dispose();
      else opts.signal.addEventListener('abort', dispose, { once: true });
    }
    return {
      set: (v: number) => {
        if (!disposed && m) m.setSource(v);
      },
      dispose,
      [Symbol.dispose]: dispose,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Influences, pulses, lifts

  /** Raw registry entry (the DOM trackers move it without allocating). */
  createInfluence(init: InfluenceInit): Influence {
    return this.influences.add(init);
  }

  /** Public handle for an entry; `onDispose` runs once when the handle is disposed. */
  influenceHandle(
    e: Influence,
    signal?: AbortSignal,
    onDispose?: () => void,
  ): ControllerInfluenceHandle {
    const reg = this.influences;
    let done = false;
    const dispose = () => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', dispose);
      reg.dispose(e);
      onDispose?.();
    };
    if (signal) {
      if (signal.aborted) dispose();
      else signal.addEventListener('abort', dispose, { once: true });
    }
    return {
      id: e.id,
      get active() {
        return e.slot && !e.removed;
      },
      update: (patch: InfluenceInit) => {
        if (!done) reg.update(e, patch);
      },
      dispose,
      [Symbol.dispose]: dispose,
    };
  }

  addInfluence(init: InfluenceInit, signal?: AbortSignal): ControllerInfluenceHandle {
    if (this.destroyed) return deadInfluence();
    return this.influenceHandle(this.createInfluence(init), signal);
  }

  pulse(req: PulseRequest): void {
    if (this.destroyed) return;
    const s = this.store;
    const ids = this.ids;
    const p = this.pulseInit;
    p.space = SPACE_CODE[req.space ?? 'host'] ?? SPACE_HOST;
    p.x = req.x;
    p.y = req.y;
    p.strength = req.strength ?? s.num(ids.rippleStrength);
    p.speed = Math.max(0.01, req.speed ?? s.num(ids.rippleSpeed));
    p.width = Math.max(0.05, req.width ?? s.num(ids.rippleWidth));
    if (req.color) {
      hexToLinearInto(req.color, this.tmp);
      p.r = this.tmp[0] as number;
      p.g = this.tmp[1] as number;
      p.b = this.tmp[2] as number;
      p.colorMix = req.colorMix ?? 0.5;
    } else {
      p.r = 1;
      p.g = 1;
      p.b = 1;
      p.colorMix = req.colorMix ?? 0;
    }
    // Default life: long enough for the ring to cross the host.
    const g = this.geo;
    const halfDiagCells = Math.hypot(g.hostW, g.hostH) / 2 / g.pitchPx;
    p.duration = req.duration ?? clamp((1.2 * halfDiagCells) / p.speed, 0.8, 4);
    p.minor = false;
    this.pulses.add(p);
    this.activity = true;
  }

  /**
   * Queues a forced lift (resolved to cells at the next update, when geometry is current).
   * Ignored under reduced motion: the user's accessibility preference wins over the caller.
   */
  lift(req: LiftRequest): void {
    if (this.destroyed || this.reducedMotion || this.forcedCount >= FORCED_QUEUE) return;
    const o = this.forcedCount++ * 5;
    this.forced[o] = SPACE_CODE[req.space ?? 'host'] ?? SPACE_HOST;
    this.forced[o + 1] = req.x;
    this.forced[o + 2] = req.y;
    this.forced[o + 3] = Math.max(1, Math.min(32, Math.floor(req.count ?? 1)));
    this.forced[o + 4] = req.radius ?? Number.NaN;
    this.activity = true;
  }

  /** Cell (relative to the center cell) under a point, written into `out` [ci, cj]. */
  cellAt(space: number, x: number, y: number, out: Float64Array | number[]): void {
    const g = this.geo;
    let px: number;
    let py: number;
    switch (space) {
      case SPACE_NORM:
        px = g.hostX + x * g.hostW;
        py = g.hostY + y * g.hostH;
        break;
      case SPACE_CELLS:
        out[0] = Math.round(x) - (g.cols - 1) / 2;
        out[1] = Math.round(y) - (g.rows - 1) / 2;
        return;
      case SPACE_CLIENT:
        px = g.hostX + (x - this.clientX) * g.sx;
        py = g.hostY + (y - this.clientY) * g.sy;
        break;
      default:
        px = g.hostX + x * g.sx;
        py = g.hostY + y * g.sy;
    }
    out[0] = Math.floor((px - g.originX) / g.pitchPx) - g.pad - (g.cols - 1) / 2;
    out[1] = Math.floor((py - g.originY) / g.pitchPx) - g.pad - (g.rows - 1) / 2;
  }

  /** Something lives in `client` space: the DOM layer must report the host's client origin. */
  get needsClientOrigin(): boolean {
    if (this.influences.needsClientOrigin || this.pulses.needsClientOrigin) return true;
    for (let i = 0; i < this.forcedCount; i++) {
      if (this.forced[i * 5] === SPACE_CLIENT) return true;
    }
    return false;
  }

  /**
   * Something of this instance's own is in the picture, or on its way into it: a shown or still
   * fading influence, a pulse other than a landing ripple, a forced lift (queued or in the air), a
   * modulated value, a running config transition (tweens, palette, sizing) or a debug view. A card
   * without any draws exactly what an identical card draws (`look: 'shared'`).
   */
  get hasLayers(): boolean {
    return (
      this.forcedCount > 0 ||
      this.frame.debugView !== 0 ||
      this.store.modulated ||
      this.store.animating ||
      this.lut.transitioning ||
      this.sizingMix.cur !== this.sizingMix.tgt ||
      this.pulses.majorCount > 0 ||
      this.lifts.forcedAlive > 0 ||
      this.influences.shownCount > 0
    );
  }

  /**
   * Takes over the picture of `from` (a controller with the same config): every clock phase, the
   * lifts in the air and their landing ripples, the adaptive tier and the Life seed. This
   * picture's center cell sits (dx, dy) cells from the center cell of `from`'s: the lifts move by
   * that much (those outside this grid drop). Influences, other pulses, queued forced lifts,
   * modulators and tweens of this instance stay. A card leaving its shared look continues the
   * group's picture this way, and a new group continues the picture of the card that starts it.
   */
  adoptLook(from: Controller, dx: number, dy: number): void {
    if (this.destroyed || from === this) return;
    this.clock.copyFrom(from.clock);
    this.lifts.adopt(from.lifts, dx, dy);
    // Landing ripples live in visible-cell coordinates (0 = the leftmost visible column).
    const ox = (this.geo.cols - from.geo.cols) / 2 - dx;
    const oy = (this.geo.rows - from.geo.rows) / 2 - dy;
    this.pulses.adoptMinor(from.pulses, ox, oy);
    this.frame.lifeSeed = from.frame.lifeSeed;
    if (this.perf.adoptLevel(from.perf)) this.updateGeometry();
  }

  /** Host size (CSS px) and DPR of the last setViewport(). */
  get hostCssW(): number {
    return this.geoIn.hostCssW;
  }

  get hostCssH(): number {
    return this.geoIn.hostCssH;
  }

  get dpr(): number {
    return this.geoIn.dpr;
  }

  /** Cell size in host CSS px (for converting cell-based sizes in DOM code). */
  get cellCss(): number {
    return this.geo.pitchPx / this.geo.sx;
  }

  // -------------------------------------------------------------------------------------------
  // Environment

  setViewport(v: ViewportInput): void {
    const g = this.geoIn;
    g.hostCssW = Math.max(1, v.hostCssW);
    g.hostCssH = Math.max(1, v.hostCssH);
    g.dpr = v.dpr > 0 ? v.dpr : 1;
    g.deviceW = v.deviceW;
    g.deviceH = v.deviceH;
    this.hasViewport = true;
    this.updateGeometry();
  }

  /** Host padding-box origin in client px (for `client` space); set in the DOM measure phase. */
  setClientOrigin(x: number, y: number): void {
    this.clientX = x;
    this.clientY = y;
  }

  /** Extra pixel budget cap in megapixels (coarse pointer 2.4, software GL 0.5). */
  setPixelCap(mpx: number): void {
    const v = mpx > 0 ? mpx : Number.POSITIVE_INFINITY;
    if (v === this.pixelCap) return;
    this.pixelCap = v;
    this.updateGeometry();
  }

  /**
   * Resolution factor from the shared renderer's pixel budget (0..1, 1 = full resolution): the
   * drawing buffer shrinks by it on both sides, on top of the adaptive scale. The grid stays the
   * same (cols, rows, and the cell size on screen: the canvas is stretched by CSS), only the
   * sharpness drops. The factor snaps down to a whole device-px pitch (a pitch of 7 px at 0.6
   * becomes 4 px, 0.57) and never below the smallest pitch (3 device px): an instance whose
   * cells are that small already keeps its resolution. Only below SHARE_GRID_MIN_SCALE, which
   * the budget alone never asks for (only the atlas's drawable limit does), do the cells grow.
   */
  setShareScale(scale: number): void {
    const v = scale > 0 && scale < 1 ? scale : 1;
    if (v === this.shareScale) return;
    this.shareScale = v;
    this.updateGeometry();
  }

  /**
   * Drawing-buffer width at full resolution: without the shared budget's factor and without the
   * adaptive scale, so an adaptive step lowers the pixels below the budget instead of letting the
   * budget plan a higher factor that takes the saving back.
   */
  get naturalWidth(): number {
    return this.natSeparate ? this.natGeo.canvasW : this.geo.canvasW;
  }

  get naturalHeight(): number {
    return this.natSeparate ? this.natGeo.canvasH : this.geo.canvasH;
  }

  /** Geometry at full resolution (without the adaptive and the share scale). */
  get naturalGeo(): Readonly<Geometry> {
    return this.natSeparate ? this.natGeo : this.geo;
  }

  /**
   * Shorter side, CSS px, that `grid.sizing: 'count'` divides into `grid.count` cells instead of
   * the host's own (0: the host's). A look group laid out larger than its members (their window
   * shift margin) keeps the cells of the member that started it this way (runtime/look).
   */
  setCountBasis(cssSide: number): void {
    const v = cssSide > 0 && Number.isFinite(cssSide) ? cssSide : 0;
    if (v === this.countBasis) return;
    this.countBasis = v;
    this.updateGeometry();
  }

  /**
   * Largest drawing-buffer side the GL context supports (device px, 0 = unknown). The canvas is
   * scaled down proportionally so neither side exceeds it.
   */
  setMaxDrawableSize(px: number): void {
    const v = px > 0 && Number.isFinite(px) ? Math.floor(px) : 0;
    if (v === this.geoIn.maxDim) return;
    this.geoIn.maxDim = v;
    this.updateGeometry();
  }

  /**
   * Reduced motion (render.reducedMotion 'respect' + the OS setting): the clock slows down and
   * every lift is off, random ones and forced ones (lift() calls, pointer hover) alike.
   */
  setReducedMotion(on: boolean): void {
    this.reducedMotion = on;
    if (on) this.forcedCount = 0;
  }

  get isReducedMotion(): boolean {
    return this.reducedMotion;
  }

  /** Software GL: lowest tier, no adaptation. */
  setSoftwareFallback(on: boolean): void {
    this.software = on;
    this.perf.setMode(on ? 'low' : this.config.render.quality);
    this.updateGeometry();
  }

  setDebugView(v: number): void {
    this.frame.debugView = v | 0;
  }

  /** Feeds frame timing to the adaptive quality controller. */
  samplePerf(deltaMs: number, cpuMs: number, gpuMs: number | null, now: number): PerfChange | null {
    const ch = this.perf.sample(deltaMs, cpuMs, gpuMs, now);
    if (ch) this.updateGeometry();
    return ch;
  }

  /** The engine was recreated (context restore): everything must be uploaded again. */
  invalidateGpu(): void {
    this.frame.paramsDirty = true;
    this.frame.lutDirty = true;
    this.frame.lifeReset = true;
  }

  /**
   * Whether something changed this instance on its own since the last call, and forgets it:
   * a pulse, a forced lift, an influence that was added, moved, changed, shown, hidden, disposed
   * or is fading, a config change, a running transition (tweens, palette) or a modulated value
   * that moved. The ambient animation (the clock, random lifts and their landing ripples) does
   * not count. The shared renderer keeps such instances at the full frame rate for a while.
   */
  takeActivity(): boolean {
    const on =
      this.activity ||
      this.influences.touched ||
      this.store.animating ||
      this.lut.transitioning ||
      this.forcedCount > 0;
    this.activity = false;
    this.influences.touched = false;
    return on;
  }

  /** takeActivity() without forgetting. */
  get activityPending(): boolean {
    return (
      this.activity ||
      this.influences.touched ||
      this.store.animating ||
      this.lut.transitioning ||
      this.forcedCount > 0
    );
  }

  /** The engine drew the last FrameInputs: one-shot flags are consumed. */
  commitFrame(): void {
    const f = this.frame;
    f.paramsDirty = false;
    f.lutDirty = false;
    f.lifeReset = false;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.influences.clear();
    this.pulses.clear();
    this.lifts.clear();
    this.forcedCount = 0;
  }

  // -------------------------------------------------------------------------------------------
  // Frame

  /**
   * Advances everything by `dt` seconds and fills the preallocated FrameInputs. `maxDt`: the
   * longest step taken (a stall must not fast-forward the animation); a caller that presents
   * every few display frames passes the interval it presents at (or more), so a lower frame rate
   * never slows the animation down.
   */
  update(dt: number, _now = 0, maxDt = 0.1): FrameInputs {
    const f = this.frame;
    const fr = f.frame;
    if (this.destroyed) return f;
    const cap = maxDt > 0.1 ? maxDt : 0.1;
    const step = dt > 0 ? (dt < cap ? dt : cap) : 0;
    const s = this.store;
    const ids = this.ids;

    // A modulated value or a tween that moved is a change of this instance's own.
    if (s.update(step)) this.activity = true;
    if (s.dirty) {
      f.paramsDirty = true;
      s.dirty = false;
    }
    this.lut.update(step);
    if (this.lut.dirty) {
      f.lutDirty = true;
      this.lut.dirty = false;
    }
    // Geometry depends on a few values only; recompute while they move (not every frame).
    const sizing = this.sizingMix.step(step);
    if (
      sizing ||
      s.isLive(ids.count) ||
      s.isLive(ids.pitch) ||
      s.isLive(ids.maxDpr) ||
      s.isLive(ids.maxPixels)
    ) {
      this.updateGeometry();
    }
    const g = this.geo;

    // Clock
    const r = this.rates;
    const rm = this.reducedMotion;
    r.speed = Math.max(0, s.num(ids.speed)) * (rm ? 0.15 : 1);
    r.flow = s.num(ids.flowSpeed);
    r.sphereRotation = s.num(ids.rotation);
    r.sphereBreathe = s.num(ids.breathe);
    r.pulse = s.num(ids.pulseSpeed);
    r.wave = s.num(ids.waveSpeed);
    r.vortex = s.num(ids.vortexSpeed);
    r.rain = s.num(ids.rainSpeed);
    r.drift = s.num(ids.drift);
    r.lifeRate = s.num(ids.lifeWeight) > 0.001 ? s.num(ids.lifeRate) : 0;
    // Epoch rates use the same clamps as the field / ripple shaders.
    r.sparsity = 1 / Math.max(s.num(ids.sparsityPeriod), 0.1);
    r.flicker = Math.max(0, s.num(ids.flickerRate));
    r.sparkle = 1 / Math.max(s.num(ids.sparkleDuration), 0.05);
    r.ripple = 1 / Math.max(s.num(ids.rippleLife), 0.1);
    const c = this.clock;
    c.advance(step, r);

    // Life: every due step runs (see Clock.advance for the cap), each with its own seed.
    f.lifeSteps = c.lifeSteps;
    f.lifeSeed = (f.lifeSeed + c.lifeSteps) >>> 0;
    f.lifeRule = s.num(ids.lifeRule);
    f.lifeBirth = s.num(ids.lifeBirth);
    f.lifeSeedDensity = s.num(ids.lifeDensity);

    // Influences
    const ic = this.infCtx;
    ic.clientX = this.clientX;
    ic.clientY = this.clientY;
    ic.defaultStrength = s.num(ids.infStrength);
    ic.defaultFalloff = s.num(ids.infFalloff);
    const nInf = this.influences.step(step, ic, fr);

    // Lifts (forced first, then the random process), then pulses so landings show this frame.
    const lp = this.fillLiftParams();
    // Reduced motion: lifts off, forced ones included (queued before it was switched on).
    if (rm) this.forcedCount = 0;
    else this.drainForced(lp);
    const nLift = this.lifts.step(step, lp, g, fr);
    const nPulse = this.pulses.step(step, g, this.clientX, this.clientY, fr);

    // Header
    fr[OFF_PHASE_A] = c.flow;
    fr[OFF_PHASE_A + 1] = c.sphereRotation;
    fr[OFF_PHASE_A + 2] = c.sphereBreathe;
    fr[OFF_PHASE_A + 3] = c.pulse;
    fr[OFF_PHASE_B] = c.wave;
    fr[OFF_PHASE_B + 1] = c.vortex;
    fr[OFF_PHASE_B + 2] = c.rain;
    fr[OFF_PHASE_B + 3] = c.drift;
    fr[OFF_CLOCK] = c.seconds;
    fr[OFF_CLOCK + 1] = c.lifeAcc;
    fr[OFF_CLOCK + 2] = s.num(ids.energy);
    fr[OFF_CLOCK + 3] = rm ? 1 : 0;
    fr[OFF_GRID] = g.cols;
    fr[OFF_GRID + 1] = g.rows;
    fr[OFF_GRID + 2] = g.pitchPx;
    fr[OFF_GRID + 3] = g.pad;
    fr[OFF_ORIGIN] = g.originX;
    fr[OFF_ORIGIN + 1] = g.originY;
    fr[OFF_ORIGIN + 2] = g.canvasW;
    fr[OFF_ORIGIN + 3] = g.canvasH;
    fr[OFF_HOST] = g.hostX;
    fr[OFF_HOST + 1] = g.hostY;
    fr[OFF_HOST + 2] = g.hostW;
    fr[OFF_HOST + 3] = g.hostH;
    fr[OFF_SPACE] = g.centerX;
    fr[OFF_SPACE + 1] = g.centerY;
    fr[OFF_SPACE + 2] = 1 / g.halfMin;
    fr[OFF_SPACE + 3] = g.pitchPx / g.halfMin;
    fr[OFF_COUNTS] = nInf;
    fr[OFF_COUNTS + 1] = nPulse;
    fr[OFF_COUNTS + 2] = nLift;
    fr[OFF_COUNTS + 3] = f.debugView;
    fr[OFF_MISC] = s.crossfadePrev(ids.mapping);
    fr[OFF_MISC + 1] = s.crossfadeMix(ids.mapping);
    fr[OFF_MISC + 2] = this.software ? 1 : 0;
    // Drift folds the palette with tri(); keyed on the rate as well as the phase, so a phase that
    // lands exactly on 0 does not switch to the unfolded mapping for a frame.
    fr[OFF_MISC + 3] = r.drift !== 0 || c.drift !== 0 ? 1 : 0;
    writeEpochPhase(fr, OFF_EPOCH_A, c.sparsity);
    writeEpochPhase(fr, OFF_EPOCH_A + 2, c.sparkle);
    writeEpochPhase(fr, OFF_EPOCH_B, c.flicker);
    writeEpochPhase(fr, OFF_EPOCH_B + 2, c.ripple);

    f.canvasWidth = g.canvasW;
    f.canvasHeight = g.canvasH;
    f.cols = g.cols;
    f.rows = g.rows;
    f.pad = g.pad;
    f.pitchPx = g.pitchPx;
    f.liftCount = nLift;
    f.bloomSigma = s.num(ids.bloomSigma);
    f.hazeSigma = s.num(ids.hazeSigma);
    f.bloomStrength = s.num(ids.bloomStrength);
    f.hazeStrength = s.num(ids.hazeStrength);
    f.quality = this.perf.quality;
    f.opaque = this.config.render.overflow <= 0;
    return f;
  }

  /** Whether anything still moves without new input (tweens, LUT, pulses, lifts). */
  get settling(): boolean {
    return (
      this.store.animating ||
      this.lut.transitioning ||
      this.pulses.count > 0 ||
      this.lifts.count > 0
    );
  }

  // -------------------------------------------------------------------------------------------

  private warn(code: string, message: string): void {
    this.onWarn?.(code, message);
  }

  private commit(next: LumiCellsConfig, opts: ConfigChangeOptions): ParamPath[] {
    const changed = diffConfigs(this.config, next);
    if (changed.length === 0) return changed;
    this.config = next;
    this.activity = true;
    this.init = null;
    const dur = Math.max(0, opts.transition ?? next.transition);
    let lut = false;
    for (const path of changed) {
      const field = getField(path);
      if (!field) continue;
      const value = getPath(next, path);
      switch (field.live) {
        case 'lut':
          lut = true;
          break;
        case 'restart':
          this.store.setTarget(path, value, 0);
          this.frame.lifeReset = true;
          break;
        case 'static':
          this.store.setTarget(path, value, 0);
          if (path === 'render.quality' && !this.software) {
            this.perf.setMode(value as QualityMode);
          }
          break;
        default:
          this.store.setTarget(path, value, dur);
          if (path === 'grid.sizing') this.sizingMix.set(value === 'pitch' ? 1 : 0, dur);
      }
    }
    if (lut) this.lut.setTarget(next.color.palette, next.color.interpolation, dur);
    this.updateGeometry();
    return changed;
  }

  private fillLiftParams(): LiftParams {
    const s = this.store;
    const ids = this.ids;
    const p = this.liftParams;
    const lift = this.config.lift;
    p.enabled = lift.enabled && !this.reducedMotion;
    p.style = lift.style === 'float' ? 1 : 0;
    p.amount = s.num(ids.liftAmount);
    p.max = s.num(ids.liftMax);
    p.scale = s.num(ids.liftScale);
    p.height = s.num(ids.liftHeight);
    p.parallax = s.num(ids.liftParallax);
    p.tilt = s.num(ids.liftTilt);
    p.holdMin = s.num(ids.liftHoldMin);
    p.holdMax = s.num(ids.liftHoldMax);
    p.rise = s.num(ids.liftRise);
    p.fall = s.num(ids.liftFall);
    p.bokeh = s.num(ids.liftBokeh);
    p.socket = s.num(ids.liftSocket);
    p.outerBias = s.num(ids.liftOuterBias);
    p.cluster = s.num(ids.liftCluster);
    p.landing = s.num(ids.liftLanding);
    p.floatSpeed = s.num(ids.liftFloatSpeed);
    p.floatDrift = s.num(ids.liftFloatDrift);
    p.sceneX = s.comp(ids.center, 0);
    p.sceneY = s.comp(ids.center, 1);
    p.zoom = s.num(ids.zoom);
    return p;
  }

  private drainForced(p: LiftParams): void {
    const n = this.forcedCount;
    if (n === 0) return;
    this.forcedCount = 0;
    const q = this.forced;
    const cell = this.tmp;
    for (let i = 0; i < n; i++) {
      const o = i * 5;
      this.cellAt(q[o] as number, q[o + 1] as number, q[o + 2] as number, cell);
      const count = q[o + 3] as number;
      const radius = q[o + 4] as number;
      this.lifts.force(
        cell[0] as number,
        cell[1] as number,
        count,
        Number.isNaN(radius) ? Math.max(1, Math.sqrt(count)) : radius,
        p,
        this.geo,
      );
    }
  }

  private updateGeometry(): void {
    const s = this.store;
    const ids = this.ids;
    const gi = this.geoIn;
    const cfg = this.config;
    gi.overflowCss = cfg.render.overflow;
    gi.maxDpr = s.num(ids.maxDpr);
    gi.maxPixels = Math.min(s.num(ids.maxPixels), this.pixelCap);
    const perf = this.perf.scale;
    const share = this.shareScale;
    gi.scale = perf;
    // Sizing blends between "N cells across the shorter side" and "fixed pitch" in log space,
    // so switching the mode mid-session is a smooth zoom rather than a jump.
    const side = this.countBasis > 0 ? this.countBasis : Math.min(gi.hostCssW, gi.hostCssH);
    const countPitch = side / Math.max(1, s.num(ids.count));
    const fixedPitch = Math.max(1, s.num(ids.pitch));
    const m = this.sizingMix.cur;
    gi.cssPitch =
      m <= 0
        ? countPitch
        : m >= 1
          ? fixedPitch
          : Math.exp(Math.log(countPitch) * (1 - m) + Math.log(fixedPitch) * m);
    let changed: boolean;
    if (share >= 1) {
      changed = computeGeometry(gi, this.geo);
    } else {
      // The shared budget lowers the resolution of the grid at the adaptive scale, not the grid
      // itself: joining or leaving shared instances must not re-grid the others.
      const base = this.baseGeo;
      computeGeometry(gi, base);
      if (share >= SHARE_GRID_MIN_SCALE) {
        // Never below the smallest pitch: cells already that small keep their resolution (the
        // budget is exceeded by them) rather than the whole grid growing coarser.
        const pitch = Math.min(
          base.pitchPx,
          Math.max(MIN_PITCH_PX, Math.floor(base.pitchPx * share + 1e-9)),
        );
        changed = computeScaledGeometry(gi, base, pitch, this.geo);
      } else {
        // Only the drawable limit asks for this much (the atlas cannot grow any further): the
        // resolution can then only drop with bigger cells.
        gi.scale = perf * share;
        changed = computeGeometry(gi, this.geo);
      }
    }
    if (changed) this.geometryChanged = true;
    this.natSeparate = perf < 1 || share < 1;
    if (this.natSeparate) {
      gi.scale = 1;
      computeGeometry(gi, this.natGeo);
    }
  }

  /** Has the DOM layer reported a size yet? */
  get measured(): boolean {
    return this.hasViewport;
  }
}

/** Store ids of the parameters read every frame (resolved once per instance). */
function resolveIds(s: ParamStore) {
  return {
    speed: s.id('animation.speed'),
    energy: s.id('animation.energy'),
    flowSpeed: s.id('modes.flow.speed'),
    rotation: s.id('modes.sphere.rotationSpeed'),
    breathe: s.id('modes.sphere.breatheSpeed'),
    pulseSpeed: s.id('modes.pulse.speed'),
    waveSpeed: s.id('modes.wave.speed'),
    vortexSpeed: s.id('modes.vortex.speed'),
    rainSpeed: s.id('modes.rain.speed'),
    drift: s.id('color.drift'),
    sparsityPeriod: s.id('animation.sparsity.period'),
    flickerRate: s.id('animation.flicker.rate'),
    sparkleDuration: s.id('animation.sparkle.duration'),
    rippleLife: s.id('modes.ripple.life'),
    lifeWeight: s.id('modes.life.weight'),
    lifeRate: s.id('modes.life.stepRate'),
    lifeBirth: s.id('modes.life.birthRate'),
    lifeDensity: s.id('modes.life.seedDensity'),
    lifeRule: s.id('modes.life.rule'),
    mapping: s.id('color.mapping'),
    bloomSigma: s.id('glow.bloom.radius'),
    hazeSigma: s.id('glow.haze.radius'),
    bloomStrength: s.id('glow.bloom.strength'),
    hazeStrength: s.id('glow.haze.strength'),
    pitch: s.id('grid.pitch'),
    count: s.id('grid.count'),
    maxDpr: s.id('render.maxDpr'),
    maxPixels: s.id('render.maxPixels'),
    center: s.id('scene.center'),
    zoom: s.id('scene.zoom'),
    infStrength: s.id('interaction.influenceStrength'),
    infFalloff: s.id('interaction.influenceFalloff'),
    rippleStrength: s.id('interaction.rippleStrength'),
    rippleSpeed: s.id('interaction.rippleSpeed'),
    rippleWidth: s.id('interaction.rippleWidth'),
    liftAmount: s.id('lift.amount'),
    liftMax: s.id('lift.max'),
    liftScale: s.id('lift.scale'),
    liftHeight: s.id('lift.height'),
    liftParallax: s.id('lift.parallax'),
    liftTilt: s.id('lift.tilt'),
    liftHoldMin: s.id('lift.holdMin'),
    liftHoldMax: s.id('lift.holdMax'),
    liftRise: s.id('lift.rise'),
    liftFall: s.id('lift.fall'),
    liftBokeh: s.id('lift.bokeh'),
    liftSocket: s.id('lift.socket'),
    liftOuterBias: s.id('lift.outerBias'),
    liftCluster: s.id('lift.cluster'),
    liftLanding: s.id('lift.landing'),
    liftFloatSpeed: s.id('lift.floatSpeed'),
    liftFloatDrift: s.id('lift.floatDrift'),
  };
}

type ParamIds = ReturnType<typeof resolveIds>;

function deadInfluence(): ControllerInfluenceHandle {
  const noop = () => {};
  return { id: -1, active: false, update: noop, dispose: noop, [Symbol.dispose]: noop };
}
