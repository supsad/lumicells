import { describe, expect, it } from 'vitest';
import { bucketSize, needsRealloc } from '../src/core/gl/target';

/** Replays a sequence of needed sizes through the grow/shrink rule; counts reallocations. */
function replay(needs: number[], step: number): { allocs: number[]; reallocs: number } {
  let alloc = 0;
  let reallocs = 0;
  const allocs: number[] = [];
  for (const need of needs) {
    if (alloc === 0 || needsRealloc(alloc, need, step)) {
      if (alloc !== 0) reallocs++;
      alloc = bucketSize(need, step);
    }
    allocs.push(alloc);
  }
  return { allocs, reallocs };
}

describe('render target buckets', () => {
  it('rounds up to whole buckets', () => {
    expect(bucketSize(1, 32)).toBe(32);
    expect(bucketSize(32, 32)).toBe(32);
    expect(bucketSize(33, 32)).toBe(64);
    expect(bucketSize(9, 8)).toBe(16);
  });

  it('grows when the need does not fit', () => {
    expect(needsRealloc(32, 33, 32)).toBe(true);
    expect(needsRealloc(8, 9, 8)).toBe(true);
    expect(needsRealloc(64, 64, 32)).toBe(false);
  });

  it('does not shrink back at exactly half (hysteresis)', () => {
    expect(needsRealloc(64, 32, 32)).toBe(false);
    expect(needsRealloc(64, 31, 32)).toBe(false);
    expect(needsRealloc(16, 8, 8)).toBe(false);
    expect(needsRealloc(16, 7, 8)).toBe(false);
  });

  it('still shrinks an allocation that is clearly oversized', () => {
    expect(needsRealloc(128, 32, 32)).toBe(true);
    expect(needsRealloc(96, 31, 32)).toBe(true);
    expect(needsRealloc(32, 8, 8)).toBe(true);
  });

  it('a size oscillating across a bucket boundary reallocates once, not every frame', () => {
    const cells = replay([32, 33, 32, 33, 32, 33, 31, 33, 32], 32);
    expect(cells.reallocs).toBe(1);
    expect(cells.allocs.at(-1)).toBe(64);
    // Quarter-res haze: ceil(W / 4) flips 8 <-> 9.
    const quarter = replay([8, 9, 8, 9, 8, 9, 7, 9], 8);
    expect(quarter.reallocs).toBe(1);
    expect(quarter.allocs.at(-1)).toBe(16);
  });
});
