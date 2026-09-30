/**
 * Page-wide GPU scheduler: the settings of LumiCells.configure(), one context budget and one
 * engine-creation queue shared by every LumiCells instance.
 *
 * Instances do not create their engine in start(): they ask for a slot once their host comes
 * near the viewport. Requests are served at the end of a frame (after the ticker's render
 * phase), best ranked first, at most `createPerFrame` per frame, so mounting a long list costs
 * one engine creation per frame instead of one long task. Creating a context costs several
 * milliseconds (a synchronous round trip to the GPU process) and so does an engine's first draw
 * (programs bound, targets allocated): a frame in which an engine drew its first frame creates
 * nothing, so the two never add up in one frame. A request the budget refuses waits (the
 * instance shows its poster) until a slot frees up or the requester ranks higher, e.g. it became
 * visible and may now take the slot of an offscreen instance.
 *
 * Nothing runs at import: the budget is created on first use (SSR-safe).
 */

import { onFrameEnd } from '../ticker';
import type { ConfigureOptions } from '../types';
import {
  type BudgetMember,
  ContextBudget,
  compareRank,
  resolveMaxContexts,
  sanitizeMaxContexts,
} from './context-budget';

/** An instance as the scheduler sees it. Callbacks run synchronously inside the scheduler. */
export interface GpuClient extends BudgetMember {
  /**
   * Creation order: among equally ranked requests the older instance is served first (usually
   * document order), independent of the order the browser reports intersections in.
   */
  readonly order: number;
  /** A slot is granted: create the engine now (on failure, give the slot back at once). */
  granted(): void;
  /** The slot was taken for a better ranked instance: release the GPU now (park). */
  evicted(): void;
  /** The budget refused the request: wait (poster) until served. Called again on retries. */
  refused(): void;
  /**
   * Re-read `area` now: called right before members are ranked against each other (once per
   * pass, only when there are more candidates than slots), so holders and waiters are compared
   * on fresh sizes from the same source.
   */
  refreshArea(): void;
  /** A setting the holder acts on by itself changed (`parkAfterMs`): re-arm its park timer. */
  settingsChanged(): void;
}

export interface RuntimeSettings {
  maxContexts: number | 'auto';
  parkAfterMs: number;
  createPerFrame: number;
}

/**
 * Longest delay setTimeout honours (2^31 - 1 ms, about 24.8 days). Browsers and Node store the
 * delay as a signed 32-bit integer: anything longer wraps around and fires almost at once.
 */
const MAX_TIMER_MS = 0x7fffffff;

const DEFAULTS: Readonly<RuntimeSettings> = {
  maxContexts: 'auto',
  parkAfterMs: 10_000,
  createPerFrame: 1,
};

const settings: RuntimeSettings = { ...DEFAULTS };
let budget: ContextBudget<GpuClient> | null = null;
/** Clients that want a slot and do not hold one (queued or waiting), in request order. */
const queue = new Set<GpuClient>();
let unhook: (() => void) | null = null;
/** Something changed since the last pass: run another one next frame. */
let dirty = false;
let budgetWarned = false;
/** Timestamp of the last frame in which an engine drew its first frame. */
let firstDrawAt = Number.NaN;

function coarsePointer(): boolean {
  const mm = (globalThis as { matchMedia?: (q: string) => MediaQueryList }).matchMedia;
  return typeof mm === 'function' && mm('(pointer: coarse)').matches;
}

function getBudget(): ContextBudget<GpuClient> {
  if (!budget)
    budget = new ContextBudget(resolveMaxContexts(settings.maxContexts, coarsePointer()));
  return budget;
}

function kick(): void {
  dirty = true;
  if (!unhook) unhook = onFrameEnd(serve);
}

function unkick(): void {
  unhook?.();
  unhook = null;
}

/** Fresh areas for every visible member about to be ranked (only visible ones compare areas). */
function refreshAreas(b: ContextBudget<GpuClient>): void {
  for (const c of queue) if (c.visible) c.refreshArea();
  for (const h of b.holders()) if (h.visible) h.refreshArea();
}

/**
 * One pass over the queue, best ranked first: grant free slots, evict lower ranked holders for
 * better ranked requesters, stop at `createPerFrame` creations. The first refusal ends the
 * pass: nobody ranked lower could be served either.
 */
function serve(now: number): void {
  if (queue.size === 0) {
    dirty = false;
    unkick();
    return;
  }
  // This frame already paid for an engine's first draw: create in the next one.
  if (now === firstDrawAt) return;
  dirty = false;
  const b = getBudget();
  // Sizes matter only when members compete for slots; otherwise everyone is served anyway.
  if (b.size + queue.size > b.max) refreshAreas(b);
  const list = Array.from(queue).sort((x, y) => compareRank(y, x) || x.order - y.order);
  const cap = settings.createPerFrame;
  let created = 0;
  let capped = false;
  for (let i = 0; i < list.length; i++) {
    const c = list[i] as GpuClient;
    if (!queue.has(c)) continue; // withdrawn by a callback earlier in this pass
    if (created >= cap) {
      capped = true;
      break;
    }
    const r = b.acquire(c);
    if (!r) {
      for (let j = i; j < list.length; j++) {
        const w = list[j] as GpuClient;
        if (queue.has(w)) w.refused();
      }
      break;
    }
    queue.delete(c);
    // The victim's context is gone before the new one is created: never above the budget.
    r.evicted?.evicted();
    created++;
    c.granted();
  }
  if (!capped && !dirty) unkick();
}

/** Applies LumiCells.configure() options (invalid values are ignored). */
export function configureRuntime(opts: ConfigureOptions): void {
  let parkChanged = false;
  if (opts.parkAfterMs !== undefined) {
    let v = Number(opts.parkAfterMs);
    // A delay no timer can express means "never" (a wrapped timer would park at once).
    if (v > MAX_TIMER_MS) v = Number.POSITIVE_INFINITY;
    if (v >= 0 && v !== settings.parkAfterMs) {
      settings.parkAfterMs = v;
      parkChanged = true;
    }
  }
  if (opts.createPerFrame !== undefined) {
    const v = Number(opts.createPerFrame);
    if (v >= 1) settings.createPerFrame = Number.isFinite(v) ? Math.floor(v) : v;
  }
  if (opts.maxContexts !== undefined) {
    const v = opts.maxContexts === 'auto' ? 'auto' : sanitizeMaxContexts(opts.maxContexts);
    if (v !== null) {
      settings.maxContexts = v;
      if (budget) {
        const max = resolveMaxContexts(v, coarsePointer());
        if (budget.size > max) refreshAreas(budget);
        const victims = budget.setMax(max);
        for (const c of victims) c.evicted();
      }
    }
  }
  // Existing holders follow the new delay (only holders run a park timer). A copy: a holder
  // that has been away longer than the new delay parks, and releases its slot, right away.
  if (parkChanged && budget) for (const h of Array.from(budget.holders())) h.settingsChanged();
  if (queue.size > 0) kick();
}

export function runtimeSettings(): Readonly<RuntimeSettings> {
  return settings;
}

/** The effective context limit of the page. */
export function maxContexts(): number {
  return getBudget().max;
}

/** Contexts granted right now (engines alive or awaiting a browser restore). */
export function contextsInUse(): number {
  return budget?.size ?? 0;
}

/** Queues a request for a slot (served from the next frame on). */
export function requestContext(c: GpuClient): void {
  if (getBudget().holds(c)) return;
  queue.add(c);
  kick();
}

/** Withdraws a request that was not served yet. */
export function cancelRequest(c: GpuClient): void {
  if (queue.delete(c) && queue.size === 0) unkick();
}

/** Gives a slot back (engine disposed and context released). */
export function releaseContext(c: GpuClient): void {
  if (budget?.release(c) && queue.size > 0) kick();
}

/** A member's rank changed (visibility, zone, priority): waiting requests may be served now. */
export function rankChanged(): void {
  if (queue.size > 0) kick();
}

/** An engine drew its first frame in the frame stamped `now` (a heavy frame: see serve()). */
export function noteFirstDraw(now: number): void {
  firstDrawAt = now;
}

/** True once per page: the "visible instance waits for a context" warning is due. */
export function claimBudgetWarning(): boolean {
  if (budgetWarned) return false;
  budgetWarned = true;
  return true;
}

/** Tests only: back to the initial state (settings, budget, queue, warning). */
export function resetRuntimeForTesting(): void {
  Object.assign(settings, DEFAULTS);
  budget = null;
  queue.clear();
  unkick();
  dirty = false;
  budgetWarned = false;
  firstDrawAt = Number.NaN;
}
