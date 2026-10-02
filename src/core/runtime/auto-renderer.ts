/**
 * The `renderer: 'auto'` policy: which renderer an instance of a given size deserves, and when a
 * running instance may switch.
 *
 * Large instances (a hero, a full-screen background) are better off with a WebGL context of their
 * own: no copy per frame, and a loss of the shared context does not touch them. Everything else
 * shares one context. "Large" is either measure, whichever says more:
 *   - the canvas (host plus the overflow margin on every side, at the effective DPR, capped by the
 *     pixel budget) covers at least `promoteArea` device pixels;
 *   - the host covers at least PROMOTE_VIEWPORT_SHARE of the viewport.
 * Both give a score (1 = exactly at the threshold). A shared instance wants its own context from
 * a score of 1, an instance with its own context keeps it down to DEMOTE_RATIO: sizes in between
 * never flip it.
 *
 * A running instance switches only after its size has held still for AUTO_DWELL_MS and at least
 * AUTO_DWELL_MS after its previous switch: dragging a resize handle across the threshold (both
 * ways, many times) switches nothing until the drag ends. The first choice of an instance (when it
 * first asks for a GPU side) needs no dwell: nothing was drawn yet.
 *
 * Whether a context of its own is available is the context budget's business (context-budget.ts,
 * scheduler.ts): `auto` instances are flexible members there. They never wait for a context (a
 * refused one uses the shared renderer) and never take one from a visible instance that has no
 * other renderer to go to.
 *
 * Pure logic, no DOM, no timers: the caller passes sizes and timestamps.
 */

import type { InstanceRenderer } from '../types';

export { DEFAULT_PROMOTE_AREA } from './settings';
/** Share of the viewport area from which a host prefers its own context, whatever its pixels. */
export const PROMOTE_VIEWPORT_SHARE = 0.25;
/** An instance with its own context goes shared only below this share of the threshold. */
export const DEMOTE_RATIO = 0.7;
/** How long a size must hold still (and the last switch be ago) before a switch, ms. */
export const AUTO_DWELL_MS = 1000;

/** What the policy reads about an instance's size. */
export interface AutoSize {
  /** Host border box, CSS px (0 when unknown). */
  cssW: number;
  cssH: number;
  /** Canvas margin beyond the host on every side, CSS px (`render.overflow`). */
  overflow: number;
  /** Effective device pixel ratio (the display's, capped by `render.maxDpr`). */
  dpr: number;
  /** Pixel budget of the canvas, device px (`render.maxPixels` and device caps). */
  maxPixels: number;
  /** Viewport, CSS px. */
  viewportW: number;
  viewportH: number;
}

/**
 * How large an instance is relative to the promotion threshold (`promoteAreaPx`, device px):
 * the larger of its canvas pixels and its share of the viewport, each divided by its threshold.
 * 0 for an unknown (or empty) size.
 */
export function autoScore(s: AutoSize, promoteAreaPx: number): number {
  const w = s.cssW;
  const h = s.cssH;
  if (!(w > 0 && h > 0)) return 0;
  const o = s.overflow > 0 ? s.overflow : 0;
  const dpr = s.dpr > 0 ? s.dpr : 1;
  const cap = s.maxPixels > 0 ? s.maxPixels : Number.POSITIVE_INFINITY;
  const px = Math.min((w + 2 * o) * (h + 2 * o) * dpr * dpr, cap);
  const byArea = promoteAreaPx > 0 ? px / promoteAreaPx : 0;
  const vp = s.viewportW * s.viewportH;
  const byViewport = vp > 0 ? (w * h) / (vp * PROMOTE_VIEWPORT_SHARE) : 0;
  return Math.max(byArea, byViewport);
}

/** The renderer a score asks for, with hysteresis around the one the instance has. */
export function autoWants(score: number, current: InstanceRenderer): InstanceRenderer {
  if (current === 'own') return score >= DEMOTE_RATIO ? 'own' : 'shared';
  return score >= 1 ? 'own' : 'shared';
}

/**
 * The dwell bookkeeping of one instance: when its size last moved and when it last switched.
 * `dueAt()` is the earliest time a switch the current size asks for may happen.
 */
export class AutoDwell {
  #score = Number.NaN;
  #changedAt = Number.NEGATIVE_INFINITY;
  #switchedAt = Number.NEGATIVE_INFINITY;

  /** The latest score (NaN before the first). */
  get score(): number {
    return this.#score;
  }

  /** Records the score of the current size; a different score restarts the dwell. */
  note(score: number, now: number): void {
    if (score === this.#score) return;
    this.#score = score;
    this.#changedAt = now;
  }

  /** The instance switched renderer (by the policy, the budget or an explicit call). */
  switched(now: number): void {
    this.#switchedAt = now;
  }

  /** Earliest time a switch may happen: a dwell after both the last size change and switch. */
  dueAt(dwellMs = AUTO_DWELL_MS): number {
    return Math.max(this.#changedAt, this.#switchedAt) + dwellMs;
  }
}
