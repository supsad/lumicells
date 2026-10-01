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
 * The shared renderer (runtime/shared-renderer) creates its one context through the same
 * per-frame allowance (claimContextCreation) and reserves it on top of the budget: own contexts
 * keep all `maxContexts` slots, the shared one is the +1 (reserveSharedContext). Once refused,
 * it gets the next allowance before own engines: its one context serves every shared instance.
 *
 * `renderer: 'auto'` instances are flexible clients (see context-budget.ts): a refusal does not
 * make them wait (they draw on the shared renderer and may stay queued as candidates for a slot
 * that frees up later), so a pass goes on past a flexible refusal instead of refusing everyone
 * ranked below it.
 *
 * Nothing runs at import: the budget is created on first use (SSR-safe).
 */

import { onFrameEnd } from '../ticker';
import type { ConfigureOptions, RendererMode } from '../types';
import { DEFAULT_PROMOTE_AREA } from './auto-renderer';
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
  /**
   * The slot was taken for a better ranked instance (or the limit was lowered): release the GPU
   * now (park, or, flexible, move to the shared renderer).
   */
  evicted(): void;
  /**
   * The budget refused the request: wait (poster) until served, or, flexible, draw on the shared
   * renderer (staying queued or not). Called again on retries while queued.
   */
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
  /** Pixel budget of the shared renderer's atlas, megapixels, or 'auto'. */
  sharedBudget: number | 'auto';
  /** Renderer of new instances that do not ask for one. */
  renderer: RendererMode;
  /** `auto`: canvas megapixels from which an instance prefers a context of its own. */
  promoteArea: number;
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
  sharedBudget: 'auto',
  renderer: 'auto',
  promoteArea: DEFAULT_PROMOTE_AREA,
};

/** Default shared atlas budget on desktop (fine pointer), megapixels. */
export const DESKTOP_SHARED_BUDGET = 4;
/** Default shared atlas budget on phones and tablets (coarse pointer), megapixels. */
export const COARSE_SHARED_BUDGET = 2;

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
/** Contexts created in the frame stamped `ledgerAt` (own engines and the shared device alike). */
let ledgerAt = Number.NaN;
let ledgerCount = 0;
/** The shared renderer's device holds a context (counted on top of the budget). */
let sharedReserved = false;
/**
 * The shared renderer was refused a context creation and still waits for its device: the next
 * creation allowance goes to it (one device serves every shared instance) before own engines.
 */
let sharedClaim = false;
/** `(pointer: coarse)`, read once for the shared budget. */
let coarseMemo: boolean | undefined;
/** Shared instances holding a seat: they follow `parkAfterMs` changes like budget holders. */
const settingsWatchers = new Set<() => void>();

function coarsePointer(): boolean {
  const mm = (globalThis as { matchMedia?: (q: string) => MediaQueryList }).matchMedia;
  return typeof mm === 'function' && mm('(pointer: coarse)').matches;
}

function getBudget(): ContextBudget<GpuClient> {
  if (!budget)
    budget = new ContextBudget(resolveMaxContexts(settings.maxContexts, coarsePointer()));
  return budget;
}

function createdIn(now: number): number {
  return now === ledgerAt ? ledgerCount : 0;
}

function noteCreated(now: number): void {
  if (now !== ledgerAt) {
    ledgerAt = now;
    ledgerCount = 0;
  }
  ledgerCount++;
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
 * better ranked requesters, stop creating at `createPerFrame` creations (flexible requests past
 * that point that could never be served are refused right away). The first refusal of an
 * inflexible client ends the pass: nobody ranked lower could be served either. A flexible client
 * may take fewer slots than an inflexible one of lower rank (see mayEvict): its refusal ends
 * nothing.
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
  // The shared renderer may have created its context in this frame already, and one that is
  // waiting for its device creates it before any own engine (see claimContextCreation).
  let created = sharedClaim ? cap : createdIn(now);
  let capped = false;
  /** Past the cap: better ranked requests still queued (free slots go to them first). */
  let ahead = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i] as GpuClient;
    if (!queue.has(c)) continue; // withdrawn by a callback earlier in this pass
    if (created >= cap) {
      capped = true;
      // Nothing more is created this frame, but a flexible request that could never get a slot
      // (the free ones go to better ranked requests and no holder ranks clearly below it) is
      // refused now: it draws on the shared renderer from the next frames instead of showing
      // its poster until every better ranked request has been served. Inflexible ones wait.
      if (c.flexible && b.size + ahead >= b.max && b.victimFor(c) === null) c.refused();
      if (queue.has(c)) ahead++;
      continue;
    }
    const r = b.acquire(c);
    if (!r) {
      if (c.flexible) {
        c.refused();
        continue;
      }
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
    noteCreated(now);
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
  if (opts.sharedBudget !== undefined) {
    const v = opts.sharedBudget === 'auto' ? 'auto' : Number(opts.sharedBudget);
    if (v === 'auto' || (Number.isFinite(v) && v > 0)) settings.sharedBudget = v;
  }
  if (isRendererMode(opts.renderer)) settings.renderer = opts.renderer;
  if (opts.promoteArea !== undefined) {
    const v = Number(opts.promoteArea);
    if (Number.isFinite(v) && v > 0) settings.promoteArea = v;
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
  if (parkChanged) for (const cb of Array.from(settingsWatchers)) cb();
  if (queue.size > 0) kick();
}

export function runtimeSettings(): Readonly<RuntimeSettings> {
  return settings;
}

export function isRendererMode(v: unknown): v is RendererMode {
  return v === 'auto' || v === 'own' || v === 'shared';
}

/** The effective context limit of the page. */
export function maxContexts(): number {
  return getBudget().max;
}

/**
 * Contexts in use right now: own engines granted (alive or awaiting a browser restore) plus the
 * shared renderer's device, which is reserved on top of `maxContexts()`.
 */
export function contextsInUse(): number {
  return (budget?.size ?? 0) + (sharedReserved ? 1 : 0);
}

/**
 * The shared atlas pixel budget in device pixels (the setting, or 4 / 2 megapixels). Read every
 * frame by the shared renderer: the pointer query runs once.
 */
export function sharedBudgetPx(): number {
  const v = settings.sharedBudget;
  if (v !== 'auto') return v * 1e6;
  if (coarseMemo === undefined) coarseMemo = coarsePointer();
  return (coarseMemo ? COARSE_SHARED_BUDGET : DESKTOP_SHARED_BUDGET) * 1e6;
}

/**
 * Asks to create one context in the frame stamped `now` (the shared renderer's device): allowed
 * within `createPerFrame` creations per frame, own engines included, and never in a frame in
 * which an engine drew its first frame. Recorded when allowed.
 */
export function claimContextCreation(now: number): boolean {
  if (now === firstDrawAt || createdIn(now) >= settings.createPerFrame) {
    // Refused: own engines leave the next allowance to the shared device (see serve()).
    sharedClaim = true;
    return false;
  }
  sharedClaim = false;
  noteCreated(now);
  return true;
}

/** The shared renderer no longer waits for a context creation (nobody left to seat, or lost). */
export function withdrawContextClaim(): void {
  if (!sharedClaim) return;
  sharedClaim = false;
  if (queue.size > 0) kick();
}

/** The shared renderer's device holds a context (one on top of the own-context budget). */
export function reserveSharedContext(): void {
  sharedReserved = true;
}

/** The shared renderer released its context. */
export function releaseSharedContext(): void {
  if (!sharedReserved) return;
  sharedReserved = false;
  if (queue.size > 0) kick();
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

/**
 * An engine (or a shared slot) drew its first frame in the frame stamped `now` (a heavy frame:
 * see serve()).
 */
export function noteFirstDraw(now: number): void {
  firstDrawAt = now;
}

/**
 * Calls `cb` when a setting its caller acts on by itself changes (`parkAfterMs`), for instances
 * outside the context budget (shared seats). Returns the unsubscribe function.
 */
export function watchSettings(cb: () => void): () => void {
  settingsWatchers.add(cb);
  return () => {
    settingsWatchers.delete(cb);
  };
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
  ledgerAt = Number.NaN;
  ledgerCount = 0;
  sharedReserved = false;
  sharedClaim = false;
  coarseMemo = undefined;
}
