import { describe, expect, it } from 'vitest';
import { SHARE_GRID_MIN_SCALE } from '../src/core/controller/controller';
import { mulberry32 } from '../src/core/controller/math';
import {
  ATLAS_STEP,
  type AtlasItem,
  AtlasPlanner,
  createAtlasItem,
  MAX_BUDGET_STEP,
  ShelfPacker,
  scaleForStep,
  UP_MARGIN,
} from '../src/core/runtime/atlas';

function items(sizes: readonly (readonly [number, number])[]): AtlasItem[] {
  return sizes.map(([w, h], i) => ({ ...createAtlasItem(i + 1), w, h }));
}

/** Placement by `order`, independent of the array order the packer leaves behind. */
function placement(list: readonly AtlasItem[]): string[] {
  return [...list].sort((a, b) => a.order - b.order).map((it) => `${it.order}@${it.x},${it.y}`);
}

function shuffled<T>(list: readonly T[], seed: number): T[] {
  const rnd = mulberry32(seed);
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

function randomSizes(n: number, seed: number, max = 400): [number, number][] {
  const rnd = mulberry32(seed);
  return Array.from({ length: n }, () => [
    20 + Math.floor(rnd() * max),
    20 + Math.floor(rnd() * max * 0.7),
  ]);
}

/** No two placed items overlap and every one lies inside `w x h`. */
function assertDisjoint(list: readonly AtlasItem[], w: number, h: number): void {
  for (const a of list) {
    expect(a.x).toBeGreaterThanOrEqual(0);
    expect(a.y).toBeGreaterThanOrEqual(0);
    expect(a.x + a.w).toBeLessThanOrEqual(w);
    expect(a.y + a.h).toBeLessThanOrEqual(h);
  }
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i] as AtlasItem;
      const b = list[j] as AtlasItem;
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      expect(apart, `${a.order} overlaps ${b.order}`).toBe(true);
    }
  }
}

describe('ShelfPacker', () => {
  it('places items without overlap, tallest shelves first', () => {
    const list = items([
      [100, 50],
      [80, 80],
      [60, 30],
      [120, 80],
      [40, 50],
    ]);
    const p = new ShelfPacker();
    expect(p.pack(list, 256)).toBe(true);
    assertDisjoint(list, 256, p.usedHeight);
    // The two 80 px tall items open the first shelf together.
    const byOrder = placement(list);
    expect(byOrder).toContain('4@0,0');
    expect(byOrder).toContain('2@120,0');
    expect(p.usedHeight).toBe(80 + 50);
  });

  it('is deterministic: the same set in any order packs the same way', () => {
    const sizes = randomSizes(60, 7);
    const ref = items(sizes);
    const p = new ShelfPacker();
    p.pack(ref, 1024);
    const expected = placement(ref);
    for (const seed of [1, 2, 3, 4]) {
      const again = shuffled(items(sizes), seed);
      new ShelfPacker().pack(again, 1024);
      expect(placement(again)).toEqual(expected);
    }
  });

  it('ties between equal sizes are broken by order', () => {
    const list = items([
      [50, 50],
      [50, 50],
      [50, 50],
    ]);
    new ShelfPacker().pack(shuffled(list, 9), 100);
    expect(placement(list)).toEqual(['1@0,0', '2@50,0', '3@0,50']);
  });

  it('first fit: a narrow item fills a gap on an earlier shelf', () => {
    const list = items([
      [70, 60],
      [70, 50],
      [30, 40],
    ]);
    new ShelfPacker().pack(list, 100);
    // [70x60] opens shelf 1, [70x50] does not fit beside it and opens shelf 2; [30x40] fits into
    // shelf 1's remaining 30 px.
    expect(placement(list)).toEqual(['1@0,0', '2@0,60', '3@70,0']);
  });

  it('refuses items wider than the packing width', () => {
    const list = items([
      [300, 10],
      [50, 10],
    ]);
    expect(new ShelfPacker().pack(list, 200)).toBe(false);
    expect(placement(list)).toEqual(['1@-1,-1', '2@0,0']);
  });
});

describe('AtlasPlanner.layout', () => {
  it('sizes the atlas in whole buckets and places everything inside', () => {
    const list = items(randomSizes(40, 3, 200));
    const plan = new AtlasPlanner();
    expect(plan.layout(list, 8192)).toBe(true);
    expect(plan.fits).toBe(true);
    expect(plan.width % ATLAS_STEP).toBe(0);
    expect(plan.height % ATLAS_STEP).toBe(0);
    assertDisjoint(list, plan.width, plan.height);
    // Roughly square: never more than the ideal width's bucket.
    const area = list.reduce((a, it) => a + it.w * it.h, 0);
    expect(plan.width).toBeLessThanOrEqual(Math.ceil(Math.sqrt(area * 1.1) / 256) * 256);
  });

  it('keeps the allocation for small changes, grows at once, shrinks only below half', () => {
    const plan = new AtlasPlanner();
    const card = (n: number) =>
      items(Array.from({ length: n }, () => [180, 100] as [number, number]));
    // 21 cards of 180x100: 768 px wide (4 per shelf), 6 shelves in a 768 px tall canvas.
    expect(plan.layout(card(21), 8192)).toBe(true);
    const w0 = plan.width;
    const h0 = plan.height;
    expect([w0, h0]).toEqual([768, 768]);
    // A few cards more or less (scrolling): same canvas.
    let resizes = 0;
    for (const n of [22, 19, 21, 24, 18, 21, 20]) if (plan.layout(card(n), 8192)) resizes++;
    expect(resizes).toBe(0);
    expect([plan.width, plan.height]).toEqual([w0, h0]);
    // Many more: grows (once).
    expect(plan.layout(card(80), 8192)).toBe(true);
    const grown = plan.width * plan.height;
    expect(grown).toBeGreaterThan(w0 * h0);
    expect(plan.layout(card(70), 8192)).toBe(false);
    expect(plan.layout(card(80), 8192)).toBe(false);
    // Far fewer: shrinks.
    const few = card(4);
    expect(plan.layout(few, 8192)).toBe(true);
    expect(plan.width * plan.height).toBeLessThan(w0 * h0);
    assertDisjoint(few, plan.width, plan.height);
  });

  it('a size oscillating across a bucket boundary reallocates once', () => {
    const plan = new AtlasPlanner();
    let resizes = 0;
    for (const h of [250, 260, 250, 260, 250, 260, 255]) {
      if (plan.layout(items([[200, h]]), 8192)) resizes++;
    }
    // The first layout allocates, 260 grows the height to 512 once, then it stays.
    expect(resizes).toBe(2);
    expect(plan.height).toBe(512);
  });

  it('clamps to the drawable limit, widening before giving up', () => {
    const plan = new AtlasPlanner();
    const list = items(Array.from({ length: 30 }, () => [300, 300] as [number, number]));
    plan.layout(list, 2000);
    expect(plan.width).toBeLessThanOrEqual(2000);
    expect(plan.height).toBeLessThanOrEqual(2000);
    // 30 x 300^2 = 2.7 Mpx does not fit 4 Mpx... in 300 px shelves of a 2000 px square it does not:
    // 6 per shelf x 6 shelves = 36 slots of which the last shelf ends at 1800 px.
    expect(plan.fits).toBe(true);
    assertDisjoint(list, plan.width, plan.height);
    // Past the limit: the items that do not fit are marked, nothing overlaps.
    const tooMany = items(Array.from({ length: 50 }, () => [300, 300] as [number, number]));
    plan.layout(tooMany, 2000);
    expect(plan.fits).toBe(false);
    const placed = tooMany.filter((it) => it.x >= 0);
    expect(placed.length).toBe(36);
    assertDisjoint(placed, 2000, 2000);
    expect(plan.stepDown()).toBe(true);
  });
});

describe('AtlasPlanner.planScale', () => {
  const cards = (n: number, w = 360, h = 240) =>
    items(Array.from({ length: n }, () => [w, h] as [number, number]));

  it('stays at full resolution within the budget', () => {
    const plan = new AtlasPlanner();
    expect(plan.planScale(cards(10), 4e6, 8192)).toBe(false);
    expect(plan.scale).toBe(1);
  });

  it('scales every instance down uniformly when the packed area exceeds the budget', () => {
    const plan = new AtlasPlanner();
    // 100 cards of 360x240 = 8.6 Mpx, far above 4 Mpx.
    expect(plan.planScale(cards(100), 4e6, 8192)).toBe(true);
    const s = plan.scale;
    expect(s).toBeLessThan(1);
    expect(s).toBeGreaterThan(0.5);
    // The packed area at that scale fits the budget, one step higher would not.
    expect(plan.naturalArea * s * s).toBeLessThanOrEqual(4e6);
    const up = scaleForStep(plan.step - 1);
    expect(plan.naturalArea * up * up).toBeGreaterThan(4e6);
    // The instances then render smaller: their layout fits the budget too (never dropped).
    const scaled = cards(100, Math.floor(360 * s), Math.floor(240 * s));
    plan.layout(scaled, 8192);
    expect(plan.fits).toBe(true);
    expect(scaled.every((it) => it.x >= 0)).toBe(true);
  });

  it('goes down at once but back up only with a clear margin (hysteresis)', () => {
    const plan = new AtlasPlanner();
    plan.planScale(cards(100), 4e6, 8192);
    const low = plan.step;
    // Slightly fewer instances: still above what one step up would allow with the margin.
    expect(plan.planScale(cards(95), 4e6, 8192)).toBe(false);
    expect(plan.step).toBe(low);
    // Back and forth around the edge never flips.
    for (const n of [100, 96, 100, 97, 100]) plan.planScale(cards(n), 4e6, 8192);
    expect(plan.step).toBe(low);
    // Far fewer: back up, as far as the margin allows.
    expect(plan.planScale(cards(20), 4e6, 8192)).toBe(true);
    expect(plan.step).toBeLessThan(low);
    expect(plan.naturalArea * plan.scale ** 2).toBeLessThanOrEqual(4e6 * UP_MARGIN);
  });

  it('never drops members: past the lowest budget step the budget is exceeded', () => {
    const plan = new AtlasPlanner();
    plan.planScale(cards(2000, 1000, 800), 1e6, 1e9);
    expect(plan.step).toBe(MAX_BUDGET_STEP);
    expect(plan.scale).toBe(1 / 8);
  });

  it('the drawable limit is a hard limit (beyond the budget steps)', () => {
    const plan = new AtlasPlanner();
    // A very tall single column: 20 items of 1000x1000 in a 1000 px wide limit.
    plan.planScale(cards(20, 1000, 1000), Number.POSITIVE_INFINITY, 1000);
    // 20 000 px tall -> needs 1/20 or less on one side: more than MAX_BUDGET_STEP.
    expect(plan.scale * 20000).toBeLessThanOrEqual(1000 + 1e-6);
  });

  it('is deterministic for the same set in any order', () => {
    const sizes = randomSizes(80, 11, 600);
    const a = new AtlasPlanner();
    a.planScale(items(sizes), 2e6, 8192);
    for (const seed of [5, 6]) {
      const b = new AtlasPlanner();
      b.planScale(shuffled(items(sizes), seed), 2e6, 8192);
      expect(b.step).toBe(a.step);
      expect(b.naturalArea).toBe(a.naturalArea);
    }
  });
});

describe('budget ladder and the controller', () => {
  it('the lowest budget step is the lowest share scale that keeps the grid', () => {
    expect(scaleForStep(MAX_BUDGET_STEP)).toBe(SHARE_GRID_MIN_SCALE);
  });
});
