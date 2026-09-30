/**
 * Context budget: the page-wide policy that decides which LumiCells instances own a WebGL
 * context when there are more instances than contexts.
 *
 * Browsers keep only a handful of live WebGL contexts per page (Chrome and Edge 16, Android
 * about 8) and silently kill the oldest one when another is created: usually the page's main
 * background, or the host app's own WebGL (maps, three.js). The budget keeps our contexts well
 * below that limit (4 on desktop, 2 on touch devices by default), so the browser never has to
 * evict anything and the app keeps room for its own contexts.
 *
 * Pure logic, no DOM: members describe themselves (visibility, creation zone, priority, area,
 * when they were last visible) and the budget grants slots and picks eviction victims. Rank,
 * lowest first (evicted first):
 *   1. offscreen members outside the creation zone, least recently visible first;
 *   2. offscreen members inside the zone, least recently visible first;
 *   3. visible members (and members that never pause offscreen), lower priority first, then
 *      smaller area.
 * A requester may take the slot of the lowest ranked holder only when it ranks strictly higher,
 * so two members can never keep taking a slot from each other. When only the area decides, it
 * must also be clearly larger (see AREA_EVICT_RATIO).
 */

import type { InstancePriority } from '../types';

const PRIORITY_WEIGHT: Record<InstancePriority, number> = { low: 0, normal: 1, high: 2 };

/** What the budget reads about a member on every decision (the owner keeps it current). */
export interface BudgetMember {
  /**
   * On screen (within the small view margin), or drawing wherever it is: an instance that never
   * pauses offscreen (a capture or copy source) ranks like a visible one.
   */
  readonly visible: boolean;
  /** Within the creation zone around the viewport (visible members are in it too). */
  readonly inZone: boolean;
  readonly priority: InstancePriority;
  /** On-screen size, CSS px squared (0 when unknown). */
  readonly area: number;
  /** When the member was last visible (any monotonic ms clock), -Infinity if never. */
  readonly lastVisible: number;
}

/** Default budget on desktop (fine pointer). */
export const DESKTOP_MAX_CONTEXTS = 4;
/** Default budget on phones and tablets (coarse pointer). */
export const COARSE_MAX_CONTEXTS = 2;

/** A usable limit: an integer >= 1 or Infinity (no limit); anything else is null. */
export function sanitizeMaxContexts(value: unknown): number | null {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  if (value === Number.POSITIVE_INFINITY) return value;
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : null;
}

/** The effective limit for a `maxContexts` setting. */
export function resolveMaxContexts(value: number | 'auto', coarsePointer: boolean): number {
  if (value !== 'auto') {
    const n = sanitizeMaxContexts(value);
    if (n !== null) return n;
  }
  return coarsePointer ? COARSE_MAX_CONTEXTS : DESKTOP_MAX_CONTEXTS;
}

const TIER_AWAY = 0;
const TIER_NEAR = 1;
const TIER_VISIBLE = 2;

function tier(m: BudgetMember): number {
  if (m.visible) return TIER_VISIBLE;
  return m.inZone ? TIER_NEAR : TIER_AWAY;
}

/**
 * Areas are compared in half-octave buckets (a factor of about 1.41): two cards of nearly the
 * same size (sub-pixel layout differences) rank equal, so neither evicts the other. Members use
 * it too, to tell a resize that may change the ranking from one that cannot.
 */
export function areaBucket(area: number): number {
  return area > 1 ? Math.floor(Math.log2(area) * 2) : 0;
}

/**
 * Between visible members of the same priority, a requester takes a slot only with an area at
 * least this many times the holder's. Buckets alone would let two nearly equal sizes on either
 * side of a bucket boundary evict each other once.
 */
export const AREA_EVICT_RATIO = Math.SQRT2;

function cmp(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Orders members by how much they deserve a context: negative when `a` should lose its slot
 * before `b`, 0 when neither may take the other's slot.
 */
export function compareRank(a: BudgetMember, b: BudgetMember): number {
  const ta = tier(a);
  const d = ta - tier(b);
  if (d !== 0) return d;
  if (ta !== TIER_VISIBLE) {
    const lv = cmp(a.lastVisible, b.lastVisible);
    if (lv !== 0) return lv;
  }
  const p = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority];
  if (p !== 0) return p;
  return cmp(areaBucket(a.area), areaBucket(b.area));
}

/** Whether `m` may take the slot of `holder`: it ranks strictly higher, by a clear margin. */
export function outranks(m: BudgetMember, holder: BudgetMember): boolean {
  if (compareRank(holder, m) >= 0) return false;
  if (tier(m) === TIER_VISIBLE && tier(holder) === TIER_VISIBLE && m.priority === holder.priority)
    return m.area >= holder.area * AREA_EVICT_RATIO;
  return true;
}

export interface AcquireResult<M> {
  /** The holder whose slot was handed over (it must release its GPU before the new context is made). */
  evicted: M | null;
}

export class ContextBudget<M extends BudgetMember> {
  #max: number;
  readonly #holders = new Set<M>();

  constructor(max: number) {
    this.#max = sanitizeMaxContexts(max) ?? DESKTOP_MAX_CONTEXTS;
  }

  get max(): number {
    return this.#max;
  }

  /** Slots in use. */
  get size(): number {
    return this.#holders.size;
  }

  holds(m: M): boolean {
    return this.#holders.has(m);
  }

  /** The current holders (live view: copy it before releasing slots while iterating). */
  holders(): IterableIterator<M> {
    return this.#holders.values();
  }

  /**
   * Changes the limit. Returns the holders that lost their slot (lowest ranked first) when the
   * new limit is below the slots in use; they are no longer holders.
   */
  setMax(max: number): M[] {
    this.#max = sanitizeMaxContexts(max) ?? this.#max;
    const out: M[] = [];
    while (this.#holders.size > this.#max) {
      const v = this.#lowest(null);
      if (!v) break;
      this.#holders.delete(v);
      out.push(v);
    }
    return out;
  }

  /** The holder `m` would take the slot of, or null when none ranks clearly below it. */
  victimFor(m: M): M | null {
    const v = this.#lowest(m);
    return v !== null && outranks(m, v) ? v : null;
  }

  /**
   * Asks for a slot: granted when one is free, otherwise taken from the lowest ranked holder if
   * `m` outranks it. Null when refused (the caller waits).
   */
  acquire(m: M): AcquireResult<M> | null {
    if (this.#holders.has(m)) return { evicted: null };
    if (this.#holders.size < this.#max) {
      this.#holders.add(m);
      return { evicted: null };
    }
    const victim = this.victimFor(m);
    if (!victim) return null;
    this.#holders.delete(victim);
    this.#holders.add(m);
    return { evicted: victim };
  }

  /** Gives a slot back. Returns whether `m` held one. */
  release(m: M): boolean {
    return this.#holders.delete(m);
  }

  /** The lowest ranked holder other than `except` (the oldest one among equals). */
  #lowest(except: M | null): M | null {
    let low: M | null = null;
    for (const h of this.#holders) {
      if (h === except) continue;
      if (low === null || compareRank(h, low) < 0) low = h;
    }
    return low;
  }
}
