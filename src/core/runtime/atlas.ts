/**
 * Atlas layout of the shared renderer: where each drawing shared instance lands in the shared
 * canvas, how big that canvas is, and how far every instance's resolution is scaled down to keep
 * the canvas within its pixel budget.
 *
 * Pure logic on plain numbers (no DOM, no GL) and deterministic: the same items give the same
 * placement whatever order they arrive in.
 *
 * - Shelf packing: items sorted by height, then width (both descending), then `order`; each goes
 *   onto the first shelf with room for it, else onto a new shelf below. A shelf is as tall as its
 *   first (tallest) item.
 * - Canvas size: whole buckets of ATLAS_STEP px per side, clamped to the GPU's largest drawable
 *   size. Resizing the canvas reallocates its drawing buffer, so a side changes only when the
 *   packing does not fit it or its bucket drops below half of it (needsRealloc, the same rule the
 *   cell targets use).
 * - Budget: when the packed area of the instances at full resolution exceeds the pixel budget,
 *   every instance's resolution is scaled by the same factor, taken from a ladder of steps
 *   2^(-1/8) apart (about 8 %). The step goes down at once and back up only with a clear margin
 *   (UP_MARGIN), so a page at the edge of the budget does not flip resolutions back and forth.
 *   Instances are never dropped: past MAX_BUDGET_STEP the budget is simply exceeded. Only the
 *   drawable size is a hard limit (a canvas cannot grow past it).
 */

import { bucketSize, needsRealloc } from '../gl/target';

/** Atlas sides are whole multiples of this (or the drawable limit). */
export const ATLAS_STEP = 256;
/** Resolution steps per halving of the scale (per quartering of the area). */
export const SCALE_STEPS_PER_OCTAVE = 8;
/** Lowest scale the budget alone may ask for: 2^(-24/8) = 1/8. */
export const MAX_BUDGET_STEP = 24;
/** Lowest scale at all (the drawable limit may need more than the budget). */
const MAX_STEP = 64;
/** The scale steps back up only when the area at the higher scale fits this share of the budget. */
export const UP_MARGIN = 0.8;
/** Target width of a packing: the square root of the total area plus this share of slack. */
const WIDTH_SLACK = 1.1;

/** Resolution factor of a scale step (step 0 = full resolution). */
export function scaleForStep(step: number): number {
  return 2 ** (-step / SCALE_STEPS_PER_OCTAVE);
}

/** One rectangle to place: `w x h` device px in, top-left corner out. */
export interface AtlasItem {
  w: number;
  h: number;
  /** Tie-break between equal sizes (creation order, lower first). */
  order: number;
  /** Top-left corner in the atlas (canvas orientation, y down), -1 when it could not be placed. */
  x: number;
  y: number;
}

export function createAtlasItem(order = 0): AtlasItem {
  return { w: 1, h: 1, order, x: -1, y: -1 };
}

function byShelf(a: AtlasItem, b: AtlasItem): number {
  return b.h - a.h || b.w - a.w || a.order - b.order;
}

/**
 * First-fit shelf packer. Reuses its shelf arrays between calls; `pack` sorts the items in place.
 */
export class ShelfPacker {
  readonly #shelfY: number[] = [];
  readonly #shelfH: number[] = [];
  readonly #shelfUsed: number[] = [];
  /** Widest shelf of the last packing, px. */
  usedWidth = 0;
  /** Total shelf height of the last packing, px. */
  usedHeight = 0;

  /**
   * Places every item on shelves `width` px wide. Items wider than that get x = y = -1 and the
   * result is false; everything else is placed (the height is unbounded here).
   */
  pack(items: AtlasItem[], width: number): boolean {
    items.sort(byShelf);
    const sy = this.#shelfY;
    const sh = this.#shelfH;
    const su = this.#shelfUsed;
    let shelves = 0;
    let height = 0;
    let used = 0;
    let ok = true;
    for (let i = 0; i < items.length; i++) {
      const it = items[i] as AtlasItem;
      const w = it.w;
      const h = it.h;
      if (w > width) {
        it.x = -1;
        it.y = -1;
        ok = false;
        continue;
      }
      let s = 0;
      while (s < shelves && ((su[s] as number) + w > width || (sh[s] as number) < h)) s++;
      if (s === shelves) {
        sy[s] = height;
        sh[s] = h;
        su[s] = 0;
        shelves++;
        height += h;
      }
      it.x = su[s] as number;
      it.y = sy[s] as number;
      const u = (su[s] as number) + w;
      su[s] = u;
      if (u > used) used = u;
    }
    this.usedWidth = used;
    this.usedHeight = height;
    return ok;
  }
}

/** Width to pack `items` into: about square, at least the widest item, at most `maxSide`. */
function idealWidth(items: readonly AtlasItem[], maxSide: number): number {
  let area = 0;
  let widest = 1;
  for (let i = 0; i < items.length; i++) {
    const it = items[i] as AtlasItem;
    area += it.w * it.h;
    if (it.w > widest) widest = it.w;
  }
  return Math.min(maxSide, Math.max(widest, Math.ceil(Math.sqrt(area * WIDTH_SLACK))));
}

/**
 * Smallest scale step at which `area` fits `budget` (soft, capped at MAX_BUDGET_STEP) and a
 * packing `height` px tall fits `maxSide` (hard).
 */
function stepFor(area: number, budget: number, height: number, maxSide: number): number {
  let k = 0;
  if (budget > 0 && area > budget) {
    // area * scale^2 <= budget, scale = 2^(-k/8)  =>  k >= 4 * log2(area / budget)
    k = Math.min(MAX_BUDGET_STEP, Math.ceil(4 * Math.log2(area / budget) - 1e-9));
  }
  if (maxSide > 0 && height > maxSide) {
    k = Math.max(k, Math.ceil(SCALE_STEPS_PER_OCTAVE * Math.log2(height / maxSide) - 1e-9));
  }
  return Math.min(MAX_STEP, Math.max(0, k));
}

/**
 * The atlas of one shared device: its allocated size and the budget scale step, with the
 * hysteresis described at the top of this file.
 */
export class AtlasPlanner {
  /** Allocated canvas size, px (0 until the first layout). */
  width = 0;
  height = 0;
  /** Current scale step (see scaleForStep). */
  step = 0;
  /** Packed area of the last planScale() input at full resolution, px. */
  naturalArea = 0;
  /** False when the last layout could not place every item (only past the drawable limit). */
  fits = true;
  readonly #packer = new ShelfPacker();

  get scale(): number {
    return scaleForStep(this.step);
  }

  /**
   * Picks the scale step for `items` given at full resolution (their positions are scratch).
   * Down at once, up only with UP_MARGIN of the budget to spare. Returns true when it changed.
   */
  planScale(items: AtlasItem[], budgetPx: number, maxSide: number): boolean {
    if (items.length === 0) return false;
    this.#packer.pack(items, idealWidth(items, maxSide));
    const p = this.#packer;
    const area = Math.max(1, p.usedWidth) * p.usedHeight;
    this.naturalArea = area;
    const need = stepFor(area, budgetPx, p.usedHeight, maxSide);
    let k = this.step;
    if (need > k) k = need;
    else if (need < k) k = Math.min(k, stepFor(area, budgetPx * UP_MARGIN, p.usedHeight, maxSide));
    if (k === this.step) return false;
    this.step = k;
    return true;
  }

  /**
   * One step lower than now, after a layout did not fit the drawable limit (the next frame's
   * sizes then fit). Returns false at the lowest step.
   */
  stepDown(): boolean {
    if (this.step >= MAX_STEP) return false;
    this.step++;
    return true;
  }

  /**
   * Places `items` at their current sizes and sizes the atlas for them. Returns true when the
   * allocated size changed (the canvas must be resized). Items that do not fit (only possible
   * past the drawable limit) get x = y = -1 and `fits` turns false.
   */
  layout(items: AtlasItem[], maxSide: number): boolean {
    const p = this.#packer;
    let widest = 1;
    for (let i = 0; i < items.length; i++) {
      const w = (items[i] as AtlasItem).w;
      if (w > widest) widest = w;
    }
    const ideal = idealWidth(items, maxSide);
    // Keep the current width while it holds the widest item and the ideal is within hysteresis.
    let w =
      this.width > 0 &&
      this.width <= maxSide &&
      this.width >= widest &&
      !needsRealloc(this.width, ideal, ATLAS_STEP)
        ? this.width
        : Math.min(maxSide, bucketSize(ideal, ATLAS_STEP));
    let fits = p.pack(items, w);
    if (p.usedHeight > maxSide && w < maxSide) {
      // Too tall: the widest possible atlas holds the most per shelf.
      w = maxSide;
      fits = p.pack(items, w);
    }
    const need = Math.max(1, p.usedHeight);
    const h =
      this.height > 0 && this.height <= maxSide && !needsRealloc(this.height, need, ATLAS_STEP)
        ? this.height
        : Math.min(maxSide, bucketSize(need, ATLAS_STEP));
    for (let i = 0; i < items.length; i++) {
      const it = items[i] as AtlasItem;
      if (it.x >= 0 && it.y + it.h > h) {
        it.x = -1;
        it.y = -1;
        fits = false;
      }
    }
    this.fits = fits;
    const resized = w !== this.width || h !== this.height;
    this.width = w;
    this.height = h;
    return resized;
  }

  /** Forgets the allocation (a new canvas); the scale step is kept. */
  resetSize(): void {
    this.width = 0;
    this.height = 0;
    this.fits = true;
  }
}
