/**
 * ParamStore: the three value layers of every schema leaf.
 *
 *   base (the config object)  ->  tweened (exp approach toward the base)  ->  effective (modulated)
 *
 * The store owns the ParamsBlock Float32Array and writes a slot only when its effective value
 * changes, so the engine re-uploads the block only while something moves. Numbers and vec2 tween
 * linearly in their own units, angles along the shortest arc (full-circle fields), colors in
 * OKLab, and `crossfade` enums keep the previous index plus a 0..1 mix. Everything else (booleans,
 * instant enums, static fields) snaps.
 */

import {
  type FieldDef,
  getField,
  getLeafPaths,
  getPath,
  type LumiCellsConfig,
  type ParamPath,
} from '../../schema';
import type { ParamLayout, ParamSlot } from './layout';
import { hexToOklabInto, oklabToLinearInto, shortestArcDeg, TAU, wrap } from './math';
import { type ModBlend, type ModSource, Modulator } from './modulators';

const K_NUM = 0;
const K_ANGLE = 1;
const K_BOOL = 2;
const K_COLOR = 3;
const K_VEC2 = 4;
const K_ENUM = 5;
const K_XFADE = 6;
const K_OTHER = 7;

const DEG = Math.PI / 180;

export interface ParamEntry {
  readonly id: number;
  readonly path: ParamPath;
  readonly field: FieldDef;
  readonly kind: number;
  /** Offset of the first tweened component in cur/tgt. */
  readonly off: number;
  /** Number of tweened components (0 = never tweens). */
  readonly n: number;
  readonly lo: number;
  readonly hi: number;
  /** Snap threshold per component. */
  readonly eps: number;
  /** Tweens at all (live uniform/realloc, numeric-ish and not `tween: 'none'`). */
  readonly tweenable: boolean;
  readonly fullCircle: boolean;
  readonly slot: ParamSlot | undefined;
  dur: number;
  active: boolean;
  mods: Modulator[] | null;
  /** Effective scalar value (numbers, angles in degrees, enum index, bool 0/1). */
  eff: number;
  /** Enum index (current) and previous index (crossfade source). */
  index: number;
  prev: number;
}

function kindOf(f: FieldDef): number {
  switch (f.kind) {
    case 'number':
    case 'int':
      return K_NUM;
    case 'angle':
      return K_ANGLE;
    case 'boolean':
      return K_BOOL;
    case 'color':
      return K_COLOR;
    case 'vec2':
      return K_VEC2;
    case 'enum':
      return f.transition === 'crossfade' ? K_XFADE : K_ENUM;
    default:
      return K_OTHER;
  }
}

function compsOf(kind: number): number {
  if (kind === K_NUM || kind === K_ANGLE || kind === K_XFADE) return 1;
  if (kind === K_VEC2) return 2;
  if (kind === K_COLOR) return 3;
  return 0;
}

export class ParamStore {
  readonly params: Float32Array;
  /** Set whenever a ParamsBlock slot is written; cleared by the consumer. */
  dirty = true;
  private readonly entries: ParamEntry[] = [];
  private readonly byPath = new Map<string, ParamEntry>();
  private readonly cur: Float64Array;
  private readonly tgt: Float64Array;
  private readonly active: Int32Array;
  private activeCount = 0;
  private modIds: Int32Array;
  private modCount = 0;
  private readonly rgb = new Float64Array(3);

  constructor(
    readonly layout: ParamLayout,
    config: LumiCellsConfig,
  ) {
    this.params = new Float32Array(layout.floatCount);
    let off = 0;
    for (const path of getLeafPaths()) {
      const field = getField(path);
      if (!field) continue;
      const kind = kindOf(field);
      const n = compsOf(kind);
      const ranged = field as { min?: number; max?: number; tween?: string };
      const lo = typeof ranged.min === 'number' ? ranged.min : 0;
      const hi = typeof ranged.max === 'number' ? ranged.max : 1;
      const tweenable =
        n > 0 && (field.live === 'uniform' || field.live === 'realloc') && ranged.tween !== 'none';
      const eps = kind === K_COLOR || kind === K_XFADE ? 1e-4 : Math.max(1e-9, (hi - lo) * 1e-4);
      const e: ParamEntry = {
        id: this.entries.length,
        path,
        field,
        kind,
        off,
        n,
        lo,
        hi,
        eps,
        tweenable,
        fullCircle: kind === K_ANGLE && (field as { fullCircle?: boolean }).fullCircle === true,
        slot: layout.slots.get(path),
        dur: 0,
        active: false,
        mods: null,
        eff: 0,
        index: 0,
        prev: 0,
      };
      off += n;
      this.entries.push(e);
      this.byPath.set(path, e);
    }
    this.cur = new Float64Array(off);
    this.tgt = new Float64Array(off);
    this.active = new Int32Array(this.entries.length);
    this.modIds = new Int32Array(8);
    this.reset(config);
  }

  /** Entry id for a path (resolve once, then read with `num(id)` every frame). */
  id(path: ParamPath): number {
    const e = this.byPath.get(path);
    if (!e) throw new Error(`[lumicells] unknown parameter '${path}'`);
    return e.id;
  }

  entry(path: string): ParamEntry | undefined {
    return this.byPath.get(path);
  }

  /** Snaps every value to `config` (no tweens) and rewrites the whole ParamsBlock. */
  reset(config: LumiCellsConfig): void {
    this.activeCount = 0;
    for (const e of this.entries) {
      e.active = false;
      this.snapTo(e, getPath(config, e.path));
      if (e.kind === K_XFADE) e.prev = e.index;
      this.refresh(e);
    }
    this.dirty = true;
  }

  /**
   * Starts tweening `path` toward `value` over `durationMs` (<= 0 or non-tweenable: instant).
   */
  setTarget(path: string, value: unknown, durationMs: number): void {
    const e = this.byPath.get(path);
    if (!e) return;
    if (!e.tweenable || !(durationMs > 0)) {
      if (e.kind === K_XFADE) {
        const idx = this.enumIndex(e, value);
        e.index = idx;
        e.prev = idx;
        this.cur[e.off] = 1;
        this.tgt[e.off] = 1;
      } else {
        this.snapTo(e, value);
      }
      if (e.active) this.deactivate(e);
      this.refresh(e);
      return;
    }
    const o = e.off;
    switch (e.kind) {
      case K_NUM:
        this.tgt[o] = value as number;
        break;
      case K_ANGLE: {
        // Unwrapped target nearest to the current value: the tween takes the short way round.
        const v = value as number;
        this.tgt[o] = e.fullCircle ? (this.cur[o] ?? 0) + shortestArcDeg(this.cur[o] ?? 0, v) : v;
        break;
      }
      case K_VEC2: {
        const v = value as readonly number[];
        this.tgt[o] = v[0] ?? 0;
        this.tgt[o + 1] = v[1] ?? 0;
        break;
      }
      case K_COLOR:
        hexToOklabInto(value as string, this.tgt, o);
        break;
      case K_XFADE: {
        const idx = this.enumIndex(e, value);
        if (idx === e.index) return;
        const mix = this.cur[o] ?? 1;
        if (idx === e.prev && mix < 1) {
          // Reversal mid-transition: swap the slots and mirror the mix so the blend on screen
          // stays exactly where it is and fades back from there.
          e.prev = e.index;
          e.index = idx;
          this.cur[o] = 1 - mix;
        } else {
          // A third value: crossfade from whatever dominates the screen right now (two slots
          // cannot hold a three-way blend).
          e.prev = mix >= 0.5 ? e.index : e.prev;
          e.index = idx;
          this.cur[o] = 0;
        }
        this.tgt[o] = 1;
        this.refresh(e);
        break;
      }
    }
    e.dur = durationMs;
    if (!e.active) {
      e.active = true;
      this.active[this.activeCount++] = e.id;
    }
  }

  /** Advances tweens and modulators by `dt` seconds. Returns true if any slot was written. */
  update(dt: number): boolean {
    const before = this.dirty;
    this.dirty = false;
    let w = 0;
    for (let i = 0; i < this.activeCount; i++) {
      const id = this.active[i] as number;
      const e = this.entries[id] as ParamEntry;
      const done = this.step(e, dt);
      if (!e.mods) this.refresh(e);
      if (done) e.active = false;
      else this.active[w++] = id;
    }
    this.activeCount = w;
    for (let i = 0; i < this.modCount; i++) {
      const e = this.entries[this.modIds[i] as number] as ParamEntry;
      const mods = e.mods;
      if (!mods) continue;
      // Same as composeModulators(), inlined: no double crosses a call boundary per frame.
      let v = e.kind === K_NUM || e.kind === K_ANGLE ? (this.cur[e.off] as number) : e.index;
      for (let j = 0; j < mods.length; j++) {
        const m = mods[j] as Modulator;
        if (m.disposed) continue;
        m.sample(dt);
        if (!m.primed) continue;
        const sv = m.value;
        if (m.blend === 1) v *= sv;
        else if (m.blend === 2) v = sv;
        else if (m.blend === 3) v = v > sv ? v : sv;
        else v += sv;
      }
      v = e.fullCircle ? e.lo + wrap(v - e.lo, e.hi - e.lo) : v < e.lo ? e.lo : v > e.hi ? e.hi : v;
      if (v !== e.eff) {
        e.eff = v;
        const sl = e.slot;
        if (sl && e.kind === K_NUM) {
          // Hot path written inline (every modulated number, every frame).
          this.params[sl.offset] = v;
          this.dirty = true;
        } else {
          this.writeSlot(e);
        }
      }
    }
    const changed = this.dirty;
    this.dirty = before || changed;
    return changed;
  }

  /** True while any tween is running (modulators are not counted). */
  get animating(): boolean {
    return this.activeCount > 0;
  }

  /** Effective scalar: numbers/ints, angles (degrees), enum index, boolean 0/1. */
  num(id: number): number {
    return (this.entries[id] as ParamEntry).eff;
  }

  /** Tweened component `c` of a vec2 (or color OKLab) entry. */
  comp(id: number, c: number): number {
    const e = this.entries[id] as ParamEntry;
    return this.cur[e.off + c] ?? 0;
  }

  /** Crossfade state of a `crossfade` enum: previous index and mix (1 = current only). */
  crossfadePrev(id: number): number {
    return (this.entries[id] as ParamEntry).prev;
  }

  crossfadeMix(id: number): number {
    const e = this.entries[id] as ParamEntry;
    return e.kind === K_XFADE ? (this.cur[e.off] ?? 1) : 1;
  }

  /** Tweening or modulated right now (its effective value may change this frame). */
  isLive(id: number): boolean {
    const e = this.entries[id] as ParamEntry;
    return e.active || e.mods !== null;
  }

  getEffective(path: string): number {
    return this.byPath.get(path)?.eff ?? Number.NaN;
  }

  isModulated(path: string): boolean {
    return !!this.byPath.get(path)?.mods;
  }

  /** Adds a modulator on a numeric path. Returns null for non-numeric paths. */
  addModulator(path: string, source: ModSource, blend?: ModBlend, smoothingMs?: number) {
    const e = this.byPath.get(path);
    if (!e || (e.kind !== K_NUM && e.kind !== K_ANGLE)) return null;
    const m = new Modulator(source, blend, smoothingMs);
    if (!e.mods) {
      e.mods = [];
      if (this.modCount >= this.modIds.length) {
        const grown = new Int32Array(this.modIds.length * 2);
        grown.set(this.modIds);
        this.modIds = grown;
      }
      this.modIds[this.modCount++] = e.id;
    }
    e.mods.push(m);
    return m;
  }

  removeModulator(path: string, m: Modulator): void {
    m.disposed = true;
    const e = this.byPath.get(path);
    if (!e?.mods) return;
    const i = e.mods.indexOf(m);
    if (i >= 0) e.mods.splice(i, 1);
    if (e.mods.length > 0) return;
    e.mods = null;
    let w = 0;
    for (let i = 0; i < this.modCount; i++) {
      const id = this.modIds[i] as number;
      if (id !== e.id) this.modIds[w++] = id;
    }
    this.modCount = w;
    // Back to the plain tweened value.
    this.refresh(e);
  }

  // -------------------------------------------------------------------------------------------

  private enumIndex(e: ParamEntry, value: unknown): number {
    if (typeof value === 'number') return value;
    const values = (e.field as { values?: readonly string[] }).values ?? [];
    const i = values.indexOf(value as string);
    return i < 0 ? 0 : i;
  }

  private deactivate(e: ParamEntry): void {
    e.active = false;
    let w = 0;
    for (let i = 0; i < this.activeCount; i++) {
      const id = this.active[i] as number;
      if (id !== e.id) this.active[w++] = id;
    }
    this.activeCount = w;
  }

  private snapTo(e: ParamEntry, value: unknown): void {
    const o = e.off;
    switch (e.kind) {
      case K_NUM:
      case K_ANGLE: {
        const v = typeof value === 'number' ? value : 0;
        this.cur[o] = v;
        this.tgt[o] = v;
        break;
      }
      case K_VEC2: {
        const v = (value as readonly number[] | undefined) ?? [0, 0];
        this.cur[o] = v[0] ?? 0;
        this.cur[o + 1] = v[1] ?? 0;
        this.tgt[o] = this.cur[o] as number;
        this.tgt[o + 1] = this.cur[o + 1] as number;
        break;
      }
      case K_COLOR:
        hexToOklabInto(typeof value === 'string' ? value : '#000000', this.cur, o);
        this.tgt[o] = this.cur[o] as number;
        this.tgt[o + 1] = this.cur[o + 1] as number;
        this.tgt[o + 2] = this.cur[o + 2] as number;
        break;
      case K_XFADE:
        e.index = this.enumIndex(e, value);
        this.cur[o] = 1;
        this.tgt[o] = 1;
        break;
      case K_ENUM:
        e.index = this.enumIndex(e, value);
        break;
      case K_BOOL:
        e.index = value ? 1 : 0;
        break;
    }
  }

  /** One exponential step of every component; returns true when all snapped. */
  private step(e: ParamEntry, dt: number): boolean {
    // k computed here, not by the caller: a double argument would be boxed on every call.
    const k = e.dur > 0 ? 1 - Math.exp((-dt * 5000) / e.dur) : 1;
    let done = true;
    const end = e.off + e.n;
    for (let j = e.off; j < end; j++) {
      const t = this.tgt[j] as number;
      let v = this.cur[j] as number;
      v += (t - v) * k;
      if (Math.abs(t - v) <= e.eps) v = t;
      else done = false;
      this.cur[j] = v;
    }
    if (done && e.fullCircle) {
      const v = e.lo + wrap((this.cur[e.off] as number) - e.lo, e.hi - e.lo);
      this.cur[e.off] = v;
      this.tgt[e.off] = v;
    }
    return done;
  }

  /** Recomputes the effective value from the tweened one (no modulators) and writes the slot. */
  private refresh(e: ParamEntry): void {
    switch (e.kind) {
      case K_NUM: {
        const v = this.cur[e.off] as number;
        e.eff = v;
        const sl = e.slot;
        if (sl && !e.mods) {
          this.params[sl.offset] = v;
          this.dirty = true;
        }
        return;
      }
      case K_ANGLE: {
        const v = this.cur[e.off] as number;
        e.eff = e.fullCircle ? e.lo + wrap(v - e.lo, e.hi - e.lo) : v;
        break;
      }
      case K_ENUM:
      case K_XFADE:
      case K_BOOL:
        e.eff = e.index;
        break;
      default:
        e.eff = 0;
    }
    if (e.mods) return;
    this.writeSlot(e);
  }

  private writeSlot(e: ParamEntry): void {
    const s = e.slot;
    if (!s) return;
    const p = this.params;
    const o = s.offset;
    switch (e.kind) {
      case K_NUM:
      case K_ENUM:
      case K_XFADE:
      case K_BOOL:
        p[o] = e.eff;
        break;
      case K_ANGLE:
        // Unwrapped degrees are fine on the GPU (only sin/cos read them) but keep them small.
        p[o] = e.fullCircle ? wrap(e.eff * DEG, TAU) : e.eff * DEG;
        break;
      case K_VEC2:
        p[o] = this.cur[e.off] as number;
        p[o + 1] = this.cur[e.off + 1] as number;
        break;
      case K_COLOR: {
        const c = this.rgb;
        oklabToLinearInto(
          this.cur[e.off] as number,
          this.cur[e.off + 1] as number,
          this.cur[e.off + 2] as number,
          c,
        );
        p[o] = Math.max(0, c[0] as number);
        p[o + 1] = Math.max(0, c[1] as number);
        p[o + 2] = Math.max(0, c[2] as number);
        break;
      }
      default:
        return;
    }
    this.dirty = true;
  }
}

export { K_ANGLE, K_BOOL, K_COLOR, K_ENUM, K_NUM, K_OTHER, K_VEC2, K_XFADE };

/** One scalar exponential tween (for controller-internal values such as the grid sizing mix). */
export class ScalarTween {
  cur: number;
  tgt: number;
  dur = 0;

  constructor(
    value: number,
    private readonly eps = 1e-4,
  ) {
    this.cur = value;
    this.tgt = value;
  }

  set(value: number, durationMs: number): void {
    this.tgt = value;
    this.dur = durationMs;
    if (!(durationMs > 0)) this.cur = value;
  }

  /** Returns true while moving. */
  step(dt: number): boolean {
    if (this.cur === this.tgt) return false;
    const k = this.dur > 0 ? 1 - Math.exp((-dt * 5000) / this.dur) : 1;
    this.cur += (this.tgt - this.cur) * k;
    if (Math.abs(this.tgt - this.cur) <= this.eps) this.cur = this.tgt;
    return true;
  }
}
