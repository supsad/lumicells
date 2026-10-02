import { describe, expect, it } from 'vitest';
import { bucketSize, needsRealloc, zeroTexels } from '../src/core/gl/target';

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

describe('zero texels for render targets', () => {
  // WebGL's constants (the values every context reports).
  const gl = {
    UNSIGNED_BYTE: 0x1401,
    FLOAT: 0x1406,
    HALF_FLOAT: 0x140b,
    UNSIGNED_INT_2_10_10_10_REV: 0x8368,
    RED: 0x1903,
    RGB: 0x1907,
    RGBA: 0x1908,
    RG: 0x8227,
  } as unknown as WebGL2RenderingContext;
  const format = (format: number, type: number) => ({ internalFormat: 0, format, type });

  it('types the texels as texImage2D requires and covers every component', () => {
    const rgba8 = zeroTexels(gl, 16, 16);
    expect(rgba8).toBeInstanceOf(Uint8Array);
    expect((rgba8 as Uint8Array).length).toBe(16 * 16 * 4);
    const half = zeroTexels(gl, 40, 24, format(gl.RGBA, gl.HALF_FLOAT));
    expect(half).toBeInstanceOf(Uint16Array);
    expect((half as Uint16Array).length).toBe(40 * 24 * 4);
    // R11F_G11F_B10F is uploaded as RGB / HALF_FLOAT.
    const packed = zeroTexels(gl, 40, 24, format(gl.RGB, gl.HALF_FLOAT));
    expect(packed).toBeInstanceOf(Uint16Array);
    expect((packed as Uint16Array).length).toBe(40 * 24 * 3);
    const float = zeroTexels(gl, 8, 8, format(gl.RG, gl.FLOAT));
    expect(float).toBeInstanceOf(Float32Array);
    expect((float as Float32Array).length).toBe(8 * 8 * 2);
    expect((zeroTexels(gl, 8, 8, format(gl.RED, gl.UNSIGNED_BYTE)) as Uint8Array).length).toBe(64);
  });

  it('leaves packed component types to lazy initialization (null)', () => {
    expect(zeroTexels(gl, 8, 8, format(gl.RGBA, gl.UNSIGNED_INT_2_10_10_10_REV))).toBeNull();
  });

  it('shares one zero buffer between small uploads and gives large ones their own', () => {
    const a = zeroTexels(gl, 32, 32) as Uint8Array;
    const b = zeroTexels(gl, 64, 64, format(gl.RGBA, gl.HALF_FLOAT)) as Uint16Array;
    const c = zeroTexels(gl, 16, 16) as Uint8Array;
    expect(c.buffer).toBe(b.buffer);
    expect(a.every((v) => v === 0) && b.every((v) => v === 0)).toBe(true);
    const big = zeroTexels(gl, 1024, 512, format(gl.RGBA, gl.HALF_FLOAT)) as Uint16Array;
    expect(big.buffer.byteLength).toBe(1024 * 512 * 8);
    expect(big.buffer).not.toBe(c.buffer);
    expect((zeroTexels(gl, 16, 16) as Uint8Array).buffer).toBe(c.buffer);
  });
});
