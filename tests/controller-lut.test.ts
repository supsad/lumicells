import { describe, expect, it } from 'vitest';
import { hexToRgb } from '../src/core/color';
import { Controller } from '../src/core/controller/controller';
import { LUT_SIZE, PaletteLut } from '../src/core/controller/lut';
import { hexToOklabInto, mulberry32 } from '../src/core/controller/math';

const HOT_ROW = LUT_SIZE * 4;

function rgbAt(lut: PaletteLut, x: number, row = 0): [number, number, number] {
  const o = row * HOT_ROW + x * 4;
  return [lut.bytes[o] as number, lut.bytes[o + 1] as number, lut.bytes[o + 2] as number];
}

function hexBytes(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex);
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function close(a: readonly number[], b: readonly number[], tol = 1): void {
  for (let i = 0; i < 3; i++)
    expect(Math.abs((a[i] as number) - (b[i] as number))).toBeLessThanOrEqual(tol);
}

describe('PaletteLut', () => {
  it('bakes the palette ends exactly and marks the texture dirty', () => {
    const lut = new PaletteLut(['#7a1d5a', '#f21239', '#041557'], 'oklab');
    expect(lut.dirty).toBe(true);
    close(rgbAt(lut, 0), hexBytes('#7a1d5a'));
    close(rgbAt(lut, 255), hexBytes('#041557'));
    close(rgbAt(lut, 127), hexBytes('#f21239'), 3);
    // Opaque alpha everywhere.
    for (let x = 0; x < LUT_SIZE; x++) expect(lut.bytes[x * 4 + 3]).toBe(255);
  });

  it('row 1 is a light tint with the same hue (OKLCh L 0.93, C x 0.35)', () => {
    const lut = new PaletteLut(['#0476ff'], 'oklab');
    const base = rgbAt(lut, 10);
    const hot = rgbAt(lut, 10, 1);
    const lum = (c: readonly number[]) => (c[0] as number) + (c[1] as number) + (c[2] as number);
    expect(lum(hot)).toBeGreaterThan(lum(base));
    // Same dominant channel (blue) => same hue family.
    expect(hot[2]).toBeGreaterThanOrEqual(hot[0]);
    expect(hot[2]).toBeGreaterThanOrEqual(hot[1]);
    const lab = [0, 0, 0];
    lut.sampleOklab(10, lab);
    const ref = [0, 0, 0];
    hexToOklabInto('#0476ff', ref);
    expect(lab[0]).toBeCloseTo(ref[0] as number, 4);
  });

  it('steps interpolation gives hard bands', () => {
    const lut = new PaletteLut(['#ff0000', '#00ff00', '#0000ff'], 'steps');
    const colors = new Set<string>();
    for (let x = 0; x < LUT_SIZE; x++) colors.add(rgbAt(lut, x).join(','));
    expect(colors.size).toBe(3);
  });

  it('linear interpolation differs from oklab in the middle', () => {
    const a = new PaletteLut(['#ff0000', '#0000ff'], 'linear');
    const b = new PaletteLut(['#ff0000', '#0000ff'], 'oklab');
    const ma = rgbAt(a, 128);
    const mb = rgbAt(b, 128);
    expect(ma.join()).not.toBe(mb.join());
  });

  it('animates toward a new palette and goes idle when done', () => {
    const lut = new PaletteLut(['#000000'], 'oklab');
    lut.dirty = false;
    lut.setTarget(['#ffffff'], 'oklab', 600);
    expect(lut.transitioning).toBe(true);
    expect(lut.update(1 / 60)).toBe(true);
    expect(lut.dirty).toBe(true);
    const early = rgbAt(lut, 0)[0];
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(255);
    for (let i = 0; i < 180; i++) lut.update(1 / 60);
    expect(lut.transitioning).toBe(false);
    close(rgbAt(lut, 0), [255, 255, 255]);
    lut.dirty = false;
    expect(lut.update(1 / 60)).toBe(false);
    expect(lut.dirty).toBe(false);
  });

  it('an interrupted transition continues from the current colors to the latest target', () => {
    const lut = new PaletteLut(['#000000'], 'oklab');
    lut.setTarget(['#ffffff'], 'oklab', 600);
    for (let i = 0; i < 10; i++) lut.update(1 / 60);
    const mid = rgbAt(lut, 0);
    lut.setTarget(['#ff0000'], 'oklab', 600);
    lut.update(1 / 60);
    const next = rgbAt(lut, 0);
    // No jump back to black or to white: a small step from the current value.
    for (let i = 0; i < 3; i++)
      expect(Math.abs((next[i] as number) - (mid[i] as number))).toBeLessThan(40);
    for (let i = 0; i < 200; i++) lut.update(1 / 60);
    close(rgbAt(lut, 0), hexBytes('#ff0000'));
  });

  it('duration 0 applies at once; any stop count works', () => {
    const lut = new PaletteLut(['#000000', '#ffffff'], 'oklab');
    const stops = Array.from({ length: 32 }, (_, i) => (i % 2 ? '#ff00ff' : '#00ff00'));
    lut.setTarget(stops, 'oklab', 0);
    expect(lut.transitioning).toBe(false);
    close(rgbAt(lut, 0), hexBytes('#00ff00'));
    close(rgbAt(lut, 255), hexBytes('#ff00ff'));
  });
});

describe('Controller LUT flags', () => {
  it('lutDirty is set while the palette changes and cleared by commitFrame', () => {
    const c = new Controller({ random: mulberry32(3) });
    let f = c.update(1 / 60);
    expect(f.lutDirty).toBe(true);
    c.commitFrame();
    f = c.update(1 / 60);
    expect(f.lutDirty).toBe(false);
    c.setConfig({ color: { palette: ['#00ff88', '#0033ff'] } }, { transition: 300 });
    f = c.update(1 / 60);
    expect(f.lutDirty).toBe(true);
    c.commitFrame();
    for (let i = 0; i < 90; i++) {
      c.update(1 / 60);
      c.commitFrame();
    }
    f = c.update(1 / 60);
    expect(f.lutDirty).toBe(false);
    // Uncommitted frames keep the flag (the engine did not draw, e.g. still compiling).
    c.setConfig({ color: { interpolation: 'steps' } }, { transition: 0 });
    f = c.update(1 / 60);
    expect(f.lutDirty).toBe(true);
    f = c.update(1 / 60);
    expect(f.lutDirty).toBe(true);
  });
});
