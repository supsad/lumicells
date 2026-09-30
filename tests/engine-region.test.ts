import { describe, expect, it } from 'vitest';
import {
  coversFramebuffer,
  createRegion,
  placeRegion,
  REGION_PIXEL_GLSL,
  type Region,
  regionVisible,
  scissorRegion,
  setRegion,
} from '../src/core/engine/region';

describe('placeRegion', () => {
  it('turns a top-left rect into GL bottom-left coordinates', () => {
    const r = placeRegion(createRegion(), 40, 10, 300, 200, 500);
    expect(r).toEqual({ x: 40, y: 290, width: 300, height: 200 });
  });

  it('snaps the corner to whole pixels and floors the size (at least 1)', () => {
    const r = placeRegion(createRegion(), 10.4, 4.6, 99.9, 0.2, 100);
    expect(r).toEqual({ x: 10, y: 100 - 5 - 1, width: 99, height: 1 });
  });

  it('keeps a region that spills past the framebuffer unclipped (the scissor clips)', () => {
    const r = placeRegion(createRegion(), -20, -10, 100, 50, 200);
    expect(r).toEqual({ x: -20, y: 160, width: 100, height: 50 });
  });
});

describe('coversFramebuffer', () => {
  it('is true only for the exact framebuffer rect', () => {
    expect(coversFramebuffer(setRegion(createRegion(), 0, 0, 640, 480), 640, 480)).toBe(true);
    expect(coversFramebuffer(setRegion(createRegion(), 0, 0, 640, 479), 640, 480)).toBe(false);
    expect(coversFramebuffer(setRegion(createRegion(), 1, 0, 640, 480), 640, 480)).toBe(false);
  });
});

describe('scissorRegion', () => {
  it('clips to the framebuffer', () => {
    const s = createRegion();
    expect(scissorRegion(setRegion(createRegion(), -20, 160, 100, 50), 300, 200, s)).toBe(true);
    expect(s).toEqual({ x: 0, y: 160, width: 80, height: 40 });
  });

  it('reports a region with nothing inside', () => {
    const s = createRegion();
    expect(scissorRegion(setRegion(createRegion(), 300, 0, 50, 50), 300, 200, s)).toBe(false);
    expect(s.width).toBe(0);
  });
});

describe('regionVisible', () => {
  it('needs one pixel inside the framebuffer', () => {
    const r = createRegion();
    expect(regionVisible(setRegion(r, 0, 0, 10, 10), 100, 100)).toBe(true);
    expect(regionVisible(setRegion(r, 99, 99, 10, 10), 100, 100)).toBe(true);
    expect(regionVisible(setRegion(r, 100, 0, 10, 10), 100, 100)).toBe(false);
    expect(regionVisible(setRegion(r, -10, 0, 10, 10), 100, 100)).toBe(false);
    expect(regionVisible(setRegion(r, 0, 0, 0, 10), 100, 100)).toBe(false);
  });
});

/**
 * REGION_PIXEL_GLSL evaluated as written: the very text the composite and lift shaders splice in
 * (tests/engine-slots.test.ts checks that they do), run as JS with a shim for vec2 and the
 * swizzles it reads. The inputs are whole or half pixels, exact in float32, and so is every
 * intermediate sum, so JS doubles give the GPU's highp result.
 */
const evalRegionPixel = new Function(
  'vec2',
  'gl_FragCoord',
  'u_region',
  `return ${REGION_PIXEL_GLSL};`,
) as (
  vec2: (x: number, y: number) => number[],
  fragCoord: { x: number; y: number },
  region: { x: number; y: number; z: number; w: number },
) => number[];

function regionPixelOf(r: Region, fragX: number, fragY: number): number[] {
  const vec2 = (x: number, y: number) => [x, y];
  return evalRegionPixel(vec2, { x: fragX, y: fragY }, { x: r.x, y: r.y, z: r.width, w: r.height });
}

describe('REGION_PIXEL_GLSL', () => {
  it('at the origin it is the own-canvas formula (x, height - y), bit for bit', () => {
    const r = setRegion(createRegion(), 0, 0, 733, 411);
    for (const [fx, fy] of [
      [0.5, 0.5],
      [732.5, 410.5],
      [123.5, 77.5],
    ] as const) {
      expect(regionPixelOf(r, fx, fy)).toEqual([fx, 411 - fy]);
    }
  });

  it('a region elsewhere yields the same local pixel as its own canvas would', () => {
    const own = setRegion(createRegion(), 0, 0, 300, 200);
    const placed = placeRegion(createRegion(), 612, 48, 300, 200, 1080);
    for (let i = 0; i < 50; i++) {
      const lx = (i * 37) % 300;
      const ly = (i * 53) % 200;
      // The same local pixel center, as gl_FragCoord in each framebuffer.
      const a = regionPixelOf(own, lx + 0.5, ly + 0.5);
      const b = regionPixelOf(placed, placed.x + lx + 0.5, placed.y + ly + 0.5);
      expect(b).toEqual(a);
      // Top-left origin, y down: the local pixel center itself.
      expect(a).toEqual([lx + 0.5, 200 - ly - 0.5]);
    }
  });
});
