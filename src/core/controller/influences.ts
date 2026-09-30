/**
 * Influence registry: any number of lights / shadows / lift zones / life seeds / repellers on the
 * CPU, at most MAX_INFLUENCES of them on the GPU.
 *
 * When more are alive than fit, they are ranked by priority, then by strength x on-screen area,
 * and the top ones hold GPU slots. Slots change hands without pops: an entry that loses its rank
 * fades out (keeping its slot until invisible) and the newcomer takes the freed slot and fades
 * in. Shapes are stored in their own space and converted to device px every frame, so `norm` and
 * `cells` influences follow resizes and grid changes, and `client` ones stay put in the viewport.
 */

import { INFLUENCE_TYPE, MAX_INFLUENCES, OFF_INF } from '../engine/frame-block';
import type { Geometry } from './geometry';
import { hexToLinearInto } from './math';

export const SPACE_HOST = 0;
export const SPACE_NORM = 1;
export const SPACE_CELLS = 2;
export const SPACE_CLIENT = 3;

export const SPACE_CODE = {
  host: SPACE_HOST,
  norm: SPACE_NORM,
  cells: SPACE_CELLS,
  client: SPACE_CLIENT,
};
export type SpaceName = keyof typeof SPACE_CODE;
export type InfluenceTypeName = keyof typeof INFLUENCE_TYPE;

/** Everything optional: unset strength/falloff follow the config defaults every frame. */
export interface InfluenceInit {
  space?: SpaceName;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  radius?: number;
  /** null resets it to unset (circle radius / no rounding). */
  cornerRadius?: number | null;
  type?: InfluenceTypeName;
  strength?: number;
  /** Soft edge in cells. */
  falloff?: number;
  color?: string;
  colorMix?: number;
  priority?: number;
  fadeInMs?: number;
  fadeOutMs?: number;
  ttlMs?: number;
}

export class Influence {
  space = SPACE_HOST;
  x = 0;
  y = 0;
  /** NaN = unset. */
  w = Number.NaN;
  h = Number.NaN;
  radius = Number.NaN;
  corner = Number.NaN;
  type = 0;
  strength = Number.NaN;
  falloff = Number.NaN;
  r = 1;
  g = 1;
  b = 1;
  colorMix = 0;
  priority = 0;
  fadeIn = 150;
  fadeOut = 250;
  ttl = Number.POSITIVE_INFINITY;
  age = 0;
  /** 0..1 fade weight on the GPU. */
  presence = 0;
  /** Holds a GPU slot. */
  slot = false;
  /** Selected for a slot this frame. */
  wanted = false;
  /** Temporarily off (fades out, keeps the entry). */
  hidden = false;
  disposing = false;
  /** Gone from the registry: handles become no-ops. */
  removed = false;
  score = 0;

  constructor(readonly id: number) {}
}

export interface InfluenceContext {
  geo: Geometry;
  /** Host padding-box origin in client (viewport) CSS px, for `client` space. */
  clientX: number;
  clientY: number;
  defaultStrength: number;
  defaultFalloff: number;
}

function smooth01(p: number): number {
  const t = p <= 0 ? 0 : p >= 1 ? 1 : p;
  return t * t * (3 - 2 * t);
}

/** Rank order: priority desc, then score desc, then age of registration. */
function before(a: Influence, b: Influence): boolean {
  if (a.priority !== b.priority) return a.priority > b.priority;
  if (a.score !== b.score) return a.score > b.score;
  return a.id < b.id;
}

export class InfluenceRegistry {
  private readonly list: Influence[] = [];
  private nextId = 1;
  private gpu = 0;
  private overflowWarned = false;
  /** Called once per registry when more influences are alive than GPU slots. */
  onOverflow: ((alive: number) => void) | null = null;

  /** Live (not disposing) entries. */
  get size(): number {
    let n = 0;
    for (let i = 0; i < this.list.length; i++) if (!(this.list[i] as Influence).disposing) n++;
    return n;
  }

  /** Entries currently holding a GPU slot. */
  get activeCount(): number {
    return this.gpu;
  }

  /** True when some live entry is in `client` space (the host rect must be measured). */
  get needsClientOrigin(): boolean {
    for (let i = 0; i < this.list.length; i++) {
      if ((this.list[i] as Influence).space === SPACE_CLIENT) return true;
    }
    return false;
  }

  add(init: InfluenceInit): Influence {
    const e = new Influence(this.nextId++);
    this.apply(e, init);
    this.list.push(e);
    return e;
  }

  update(e: Influence, patch: InfluenceInit): void {
    if (e.removed) return;
    this.apply(e, patch);
  }

  /** Moves an entry without touching anything else (hot path for trackers; no allocation). */
  setShape(e: Influence, space: number, x: number, y: number, w: number, h: number): void {
    e.space = space;
    e.x = x;
    e.y = y;
    e.w = w;
    e.h = h;
  }

  setHidden(e: Influence, hidden: boolean): void {
    e.hidden = hidden;
  }

  /**
   * Fades out, then frees. Idempotent. An entry without a GPU slot has nothing to fade and is
   * freed right away, so disposals never pile up while the instance is not rendering (stopped,
   * paused, offscreen); only slot holders (at most MAX_INFLUENCES) wait for the next frames.
   */
  dispose(e: Influence): void {
    if (e.removed) return;
    e.disposing = true;
    if (e.slot) return;
    e.removed = true;
    const i = this.list.indexOf(e);
    if (i >= 0) this.list.splice(i, 1);
  }

  /** Drops everything immediately (instance destroyed). */
  clear(): void {
    for (const e of this.list) {
      e.removed = true;
      e.disposing = true;
      e.slot = false;
    }
    this.list.length = 0;
    this.gpu = 0;
  }

  /**
   * Advances fades / ttl, picks the GPU set and writes f_inf records into `frame`.
   * Returns the number of records written.
   */
  step(dt: number, ctx: InfluenceContext, frame: Float32Array): number {
    const dtMs = dt * 1000;
    const list = this.list;
    // TTL and removal of fully faded disposals (stable compaction keeps rank order).
    let w = 0;
    let eligible = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i] as Influence;
      if (!e.disposing) {
        e.age += dtMs;
        if (e.age >= e.ttl) e.disposing = true;
      }
      if (e.disposing && !e.slot) {
        e.removed = true;
        continue;
      }
      if (!e.disposing && !e.hidden) eligible++;
      list[w++] = e;
    }
    list.length = w;

    if (eligible > MAX_INFLUENCES) {
      if (!this.overflowWarned) {
        this.overflowWarned = true;
        this.onOverflow?.(eligible);
      }
      for (let i = 0; i < list.length; i++) {
        const e = list[i] as Influence;
        e.score = this.strengthOf(e, ctx) * this.areaOf(e, ctx.geo);
      }
      // Insertion sort: the order barely changes between frames, so this is ~O(n) and in place.
      for (let i = 1; i < list.length; i++) {
        const e = list[i] as Influence;
        let j = i - 1;
        while (j >= 0 && before(e, list[j] as Influence)) {
          list[j + 1] = list[j] as Influence;
          j--;
        }
        list[j + 1] = e;
      }
      let n = 0;
      for (let i = 0; i < list.length; i++) {
        const e = list[i] as Influence;
        e.wanted = !e.disposing && !e.hidden && n < MAX_INFLUENCES;
        if (e.wanted) n++;
      }
    } else {
      for (let i = 0; i < list.length; i++) {
        const e = list[i] as Influence;
        e.wanted = !e.disposing && !e.hidden;
      }
    }

    // Fade and release first, then hand freed slots to waiting entries in rank order.
    for (let i = 0; i < list.length; i++) {
      const e = list[i] as Influence;
      if (!e.slot) continue;
      if (e.wanted) {
        e.presence = e.fadeIn > 0 ? Math.min(1, e.presence + dtMs / e.fadeIn) : 1;
      } else {
        e.presence = e.fadeOut > 0 ? e.presence - dtMs / e.fadeOut : 0;
        if (e.presence <= 0) {
          e.presence = 0;
          e.slot = false;
          this.gpu--;
        }
      }
    }
    for (let i = 0; i < list.length && this.gpu < MAX_INFLUENCES; i++) {
      const e = list[i] as Influence;
      if (e.slot || !e.wanted) continue;
      e.slot = true;
      this.gpu++;
      e.presence = e.fadeIn > 0 ? Math.min(1, dtMs / e.fadeIn) : 1;
    }

    let n = 0;
    for (let i = 0; i < list.length && n < MAX_INFLUENCES; i++) {
      const e = list[i] as Influence;
      if (!e.slot || e.presence <= 0) continue;
      this.write(e, ctx, frame, OFF_INF + n * 12);
      n++;
    }
    return n;
  }

  // -------------------------------------------------------------------------------------------

  private apply(e: Influence, p: InfluenceInit): void {
    if (p.space !== undefined) e.space = SPACE_CODE[p.space] ?? SPACE_HOST;
    if (p.x !== undefined) e.x = p.x;
    if (p.y !== undefined) e.y = p.y;
    if (p.w !== undefined) e.w = p.w;
    if (p.h !== undefined) e.h = p.h;
    if (p.radius !== undefined) e.radius = p.radius;
    if (p.cornerRadius !== undefined) e.corner = p.cornerRadius ?? Number.NaN;
    if (p.type !== undefined) e.type = INFLUENCE_TYPE[p.type] ?? 0;
    if (p.strength !== undefined) e.strength = p.strength;
    if (p.falloff !== undefined) e.falloff = p.falloff;
    if (p.color !== undefined) {
      const rgb = [1, 1, 1];
      hexToLinearInto(p.color, rgb);
      e.r = rgb[0] as number;
      e.g = rgb[1] as number;
      e.b = rgb[2] as number;
      // A color without an explicit mix should be visible.
      if (p.colorMix === undefined && e.colorMix === 0) e.colorMix = 0.5;
    }
    if (p.colorMix !== undefined) e.colorMix = Math.max(0, Math.min(1, p.colorMix));
    if (p.priority !== undefined) e.priority = p.priority;
    if (p.fadeInMs !== undefined) e.fadeIn = Math.max(0, p.fadeInMs);
    if (p.fadeOutMs !== undefined) e.fadeOut = Math.max(0, p.fadeOutMs);
    if (p.ttlMs !== undefined) {
      e.ttl = p.ttlMs > 0 ? p.ttlMs : Number.POSITIVE_INFINITY;
      e.age = 0;
    }
  }

  private strengthOf(e: Influence, ctx: InfluenceContext): number {
    return Number.isNaN(e.strength) ? ctx.defaultStrength : e.strength;
  }

  /** Units per device px for sizes in this entry's space. */
  private unit(e: Influence, g: Geometry, axis: 0 | 1 | 2): number {
    switch (e.space) {
      case SPACE_NORM:
        return axis === 0 ? g.hostW : axis === 1 ? g.hostH : Math.min(g.hostW, g.hostH);
      case SPACE_CELLS:
        return g.pitchPx;
      default:
        return axis === 1 ? g.sy : g.sx;
    }
  }

  private areaOf(e: Influence, g: Geometry): number {
    if (!Number.isNaN(e.w) || !Number.isNaN(e.h)) {
      const w = (Number.isNaN(e.w) ? 0 : e.w) * this.unit(e, g, 0);
      const h = (Number.isNaN(e.h) ? 0 : e.h) * this.unit(e, g, 1);
      return Math.max(1, w * h);
    }
    const r = (Number.isNaN(e.radius) ? 0 : e.radius) * this.unit(e, g, 2);
    return Math.max(1, Math.PI * r * r);
  }

  private write(e: Influence, ctx: InfluenceContext, f: Float32Array, o: number): void {
    const g = ctx.geo;
    let px: number;
    let py: number;
    switch (e.space) {
      case SPACE_NORM:
        px = g.hostX + e.x * g.hostW;
        py = g.hostY + e.y * g.hostH;
        break;
      case SPACE_CELLS:
        // Integer cell coordinates are cell centers; (0, 0) is the top-left visible cell.
        px = g.originX + (g.pad + e.x + 0.5) * g.pitchPx;
        py = g.originY + (g.pad + e.y + 0.5) * g.pitchPx;
        break;
      case SPACE_CLIENT:
        px = g.hostX + (e.x - ctx.clientX) * g.sx;
        py = g.hostY + (e.y - ctx.clientY) * g.sy;
        break;
      default:
        px = g.hostX + e.x * g.sx;
        py = g.hostY + e.y * g.sy;
    }
    let hw = 0;
    let hh = 0;
    let corner: number;
    if (!Number.isNaN(e.w) || !Number.isNaN(e.h)) {
      hw = Math.max(0, (Number.isNaN(e.w) ? 0 : e.w) * 0.5 * this.unit(e, g, 0));
      hh = Math.max(0, (Number.isNaN(e.h) ? 0 : e.h) * 0.5 * this.unit(e, g, 1));
      const c = Number.isNaN(e.corner) ? 0 : e.corner * this.unit(e, g, 2);
      corner = Math.max(0, Math.min(c, hw, hh));
    } else {
      corner = Math.max(0, (Number.isNaN(e.radius) ? 0 : e.radius) * this.unit(e, g, 2));
    }
    const falloff = Number.isNaN(e.falloff) ? ctx.defaultFalloff : e.falloff;
    f[o] = px;
    f[o + 1] = py;
    f[o + 2] = hw;
    f[o + 3] = hh;
    f[o + 4] = corner;
    f[o + 5] = Math.max(0, falloff) * g.pitchPx;
    f[o + 6] = this.strengthOf(e, ctx) * smooth01(e.presence);
    f[o + 7] = e.type;
    f[o + 8] = e.r;
    f[o + 9] = e.g;
    f[o + 10] = e.b;
    f[o + 11] = e.colorMix;
  }
}
