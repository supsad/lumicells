import { describe, expect, it } from 'vitest';
import { Controller, SHARE_GRID_MIN_SCALE } from '../src/core/controller/controller';
import {
  computeGeometry,
  createGeometry,
  effectiveDpr,
  type GeometryInput,
  MAX_PAD,
} from '../src/core/controller/geometry';
import { mulberry32 } from '../src/core/controller/math';
import { OFF_GRID, OFF_HOST, OFF_ORIGIN, OFF_SPACE } from '../src/core/engine/frame-block';

function input(p: Partial<GeometryInput> = {}): GeometryInput {
  return {
    hostCssW: 1000,
    hostCssH: 600,
    overflowCss: 0,
    dpr: 1,
    deviceW: 0,
    deviceH: 0,
    maxDpr: 2,
    maxPixels: 4.2,
    scale: 1,
    cssPitch: 19.35,
    ...p,
  };
}

function geo(p: Partial<GeometryInput> = {}) {
  const g = createGeometry();
  computeGeometry(input(p), g);
  return g;
}

describe('grid geometry', () => {
  it('snaps the pitch to whole device px', () => {
    expect(geo({ cssPitch: 19.35, dpr: 1 }).pitchPx).toBe(19);
    expect(geo({ cssPitch: 19.35, dpr: 1.5 }).pitchPx).toBe(29);
    expect(geo({ cssPitch: 7.3, dpr: 2 }).pitchPx).toBe(15);
    expect(geo({ cssPitch: 1, dpr: 1 }).pitchPx).toBe(3); // floor of 3 device px
  });

  it('odd cell counts covering the host, grid centered on it', () => {
    for (const [w, h, pitch] of [
      [1000, 600, 19.35],
      [345, 345, 11.13],
      [1920, 1080, 24],
      [390, 844, 12.6],
    ] as const) {
      const g = geo({ hostCssW: w, hostCssH: h, cssPitch: pitch });
      expect(g.cols % 2).toBe(1);
      expect(g.rows % 2).toBe(1);
      expect(g.cols * g.pitchPx).toBeGreaterThanOrEqual(g.hostW);
      expect(g.rows * g.pitchPx).toBeGreaterThanOrEqual(g.hostH);
      expect(Number.isInteger(g.originX)).toBe(true);
      expect(Number.isInteger(g.originY)).toBe(true);
      // The middle cell's center sits on the host center (within half a device px).
      const midX = g.originX + (g.pad + (g.cols - 1) / 2 + 0.5) * g.pitchPx;
      const midY = g.originY + (g.pad + (g.rows - 1) / 2 + 0.5) * g.pitchPx;
      expect(Math.abs(midX - g.centerX)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(midY - g.centerY)).toBeLessThanOrEqual(0.5);
      // The visible grid (without pad) covers the host rect.
      expect(g.originX + g.pad * g.pitchPx).toBeLessThanOrEqual(g.hostX);
      expect(g.originX + (g.pad + g.cols) * g.pitchPx).toBeGreaterThanOrEqual(g.hostX + g.hostW);
    }
  });

  it('pad = 2 + margin in cells (capped); host rect inset by the overflow', () => {
    const g0 = geo();
    expect(g0.pad).toBe(2);
    expect(g0.hostX).toBe(0);
    const g = geo({ overflowCss: 60, dpr: 2, cssPitch: 10, maxPixels: 12 });
    expect(g.sx).toBe(2);
    expect(g.hostX).toBe(120);
    expect(g.hostW).toBe(2000);
    expect(g.canvasW).toBe(2240);
    expect(g.pad).toBe(2 + Math.ceil(120 / 20));
    expect(geo({ overflowCss: 300, cssPitch: 4 }).pad).toBe(MAX_PAD);
  });

  it('DPR cap, pixel budget and adaptive scale', () => {
    expect(effectiveDpr(3, 2, 100, 1000, 1000, 1)).toBe(2);
    // 4.2 Mpx over a 2000 x 1500 CSS canvas: sqrt(4.2e6 / 3e6).
    expect(effectiveDpr(2, 2, 4.2, 2000, 1500, 1)).toBeCloseTo(Math.sqrt(1.4), 6);
    expect(effectiveDpr(2, 2, 100, 100, 100, 0.5)).toBe(1);
    const g = geo({ hostCssW: 2000, hostCssH: 1500, dpr: 2 });
    expect(g.canvasW * g.canvasH).toBeLessThanOrEqual(4.2e6 * 1.01);
  });

  it('uses the exact device-pixel box when no cap applies', () => {
    const g = geo({ hostCssW: 333.33, hostCssH: 200, dpr: 1.5, deviceW: 500, deviceH: 300 });
    expect(g.canvasW).toBe(500);
    expect(g.canvasH).toBe(300);
    // A device box that does not match css x dpr (emulation quirks) is ignored.
    const bogus = geo({
      hostCssW: 1280,
      hostCssH: 800,
      dpr: 2,
      deviceW: 1280,
      deviceH: 800,
      maxPixels: 12,
    });
    expect(bogus.canvasW).toBe(2560);
    const capped = geo({
      hostCssW: 333.33,
      hostCssH: 200,
      dpr: 3,
      maxDpr: 2,
      deviceW: 1000,
      deviceH: 600,
    });
    expect(capped.canvasW).toBe(667);
  });

  it('clamps the drawing buffer to the GL size limit proportionally (tall hosts)', () => {
    // A 390 x 20000 page background on a DPR 3 phone with the coarse 2.4 Mpx budget.
    const free = geo({ hostCssW: 390, hostCssH: 20000, dpr: 3, maxDpr: 3, maxPixels: 2.4 });
    expect(free.canvasH).toBeGreaterThan(8192);
    const g = geo({
      hostCssW: 390,
      hostCssH: 20000,
      dpr: 3,
      maxDpr: 3,
      maxPixels: 2.4,
      maxDim: 8192,
    });
    expect(g.canvasH).toBe(8192);
    expect(g.canvasW).toBeLessThanOrEqual(8192);
    // Same scale on both axes: cells stay square and the grid stays centered.
    expect(g.sx).toBeCloseTo(g.sy, 2);
    expect(g.effDpr).toBeCloseTo(8192 / 20000, 6);
    // Wide hosts too, and a limit above the request changes nothing.
    const wide = geo({ hostCssW: 60000, hostCssH: 1440, dpr: 2, maxPixels: 12, maxDim: 16384 });
    expect(wide.canvasW).toBe(16384);
    const roomy = geo({ hostCssW: 1000, hostCssH: 600, maxDim: 16384 });
    expect(roomy.canvasW).toBe(geo({ hostCssW: 1000, hostCssH: 600 }).canvasW);
  });

  it('reports changes only when something changed', () => {
    const g = createGeometry();
    expect(computeGeometry(input(), g)).toBe(true);
    expect(computeGeometry(input(), g)).toBe(false);
    expect(computeGeometry(input({ hostCssW: 1001 }), g)).toBe(true);
  });
});

describe('controller geometry', () => {
  function controller(cfg = {}) {
    const c = new Controller({ random: mulberry32(1), config: cfg });
    c.setViewport({ hostCssW: 1000, hostCssH: 600, dpr: 1, deviceW: 0, deviceH: 0 });
    return c;
  }

  it("grid.count = cells across the host's shorter side", () => {
    const c = controller({ grid: { sizing: 'count', count: 30 } });
    expect(c.geo.pitchPx).toBe(20); // 600 / 30
    const f = c.update(1 / 60);
    expect(f.pitchPx).toBe(20);
    expect(f.frame[OFF_GRID + 2]).toBe(20);
    expect(f.frame[OFF_GRID]).toBe(c.geo.cols);
    expect(f.frame[OFF_GRID + 3]).toBe(c.geo.pad);
  });

  it('pitch sizing uses CSS px', () => {
    const c = controller({ grid: { sizing: 'pitch', pitch: 12 } });
    expect(c.geo.pitchPx).toBe(12);
  });

  it('count changes tween the pitch continuously', () => {
    const c = controller({ grid: { count: 30 } });
    c.setConfig({ grid: { count: 60 } }, { transition: 600 });
    const seen = new Set<number>();
    for (let i = 0; i < 90; i++) seen.add(c.update(1 / 60).pitchPx);
    expect(seen.size).toBeGreaterThan(5);
    expect(c.geo.pitchPx).toBe(10);
  });

  it('switching sizing mode is a smooth (log-space) zoom, not a jump', () => {
    const c = controller({ grid: { sizing: 'count', count: 30, pitch: 10 } });
    c.setConfig({ grid: { sizing: 'pitch' } }, { transition: 600 });
    const p: number[] = [];
    for (let i = 0; i < 90; i++) p.push(c.update(1 / 60).pitchPx);
    for (let i = 1; i < p.length; i++)
      expect(Math.abs((p[i] as number) - (p[i - 1] as number))).toBeLessThanOrEqual(2);
    expect(p[p.length - 1]).toBe(10);
  });

  it('fills the frame header: origin, host rect, mode space', () => {
    const c = controller({ render: { overflow: 20 } });
    const f = c.update(1 / 60);
    const g = c.geo;
    const fr = f.frame;
    expect([fr[OFF_ORIGIN], fr[OFF_ORIGIN + 1], fr[OFF_ORIGIN + 2], fr[OFF_ORIGIN + 3]]).toEqual([
      g.originX,
      g.originY,
      g.canvasW,
      g.canvasH,
    ]);
    expect([fr[OFF_HOST], fr[OFF_HOST + 1], fr[OFF_HOST + 2], fr[OFF_HOST + 3]]).toEqual([
      20, 20, 1000, 600,
    ]);
    expect(fr[OFF_SPACE]).toBe(520);
    expect(fr[OFF_SPACE + 1]).toBe(320);
    expect(fr[OFF_SPACE + 2]).toBeCloseTo(1 / 300, 8);
    expect(fr[OFF_SPACE + 3]).toBeCloseTo(g.pitchPx / 300, 6);
    expect(f.opaque).toBe(false);
    expect(f.canvasWidth).toBe(1040);
  });

  it('setMaxDrawableSize clamps the canvas to the GL limit', () => {
    const c = controller({ render: { maxPixels: 12 } });
    c.setViewport({ hostCssW: 1440, hostCssH: 60000, dpr: 2, deviceW: 0, deviceH: 0 });
    expect(c.geo.canvasH).toBeGreaterThan(16384);
    c.setMaxDrawableSize(16384);
    expect(c.geo.canvasH).toBe(16384);
    const f = c.update(1 / 60);
    expect(f.canvasHeight).toBe(16384);
  });

  it('pixel cap (coarse pointer / software GL) lowers the effective DPR', () => {
    const c = new Controller({ random: mulberry32(1) });
    c.setViewport({ hostCssW: 1600, hostCssH: 1000, dpr: 2, deviceW: 0, deviceH: 0 });
    const full = c.geo.canvasW * c.geo.canvasH;
    c.setPixelCap(0.5);
    expect(c.geo.canvasW * c.geo.canvasH).toBeLessThanOrEqual(0.5e6 * 1.01);
    expect(c.geo.canvasW * c.geo.canvasH).toBeLessThan(full);
    expect(c.geometryChanged).toBe(true);
  });
});

describe('shared renderer resolution factor', () => {
  it('scales the drawing buffer, keeps the natural size and the grid', () => {
    const c = new Controller({ random: mulberry32(1), config: { grid: { sizing: 'pitch' } } });
    c.setViewport({ hostCssW: 400, hostCssH: 200, dpr: 1, deviceW: 0, deviceH: 0 });
    const full = { ...c.geo, cellCss: c.cellCss };
    expect([c.naturalWidth, c.naturalHeight]).toEqual([full.canvasW, full.canvasH]);
    c.setShareScale(0.5);
    // The factor snaps down to a whole device-px pitch: never more pixels than asked for.
    expect(c.geo.pitchPx).toBe(Math.floor(full.pitchPx * 0.5));
    const r = c.geo.pitchPx / full.pitchPx;
    expect(c.geo.canvasW).toBe(Math.round(full.canvasW * r));
    expect(c.geo.canvasH).toBe(Math.round(full.canvasH * r));
    expect(c.geo.canvasW).toBeLessThanOrEqual(Math.round(full.canvasW * 0.5));
    // The natural size is what the budget plans with: unchanged by the factor itself.
    expect([c.naturalWidth, c.naturalHeight]).toEqual([full.canvasW, full.canvasH]);
    c.setShareScale(1);
    expect([c.geo.canvasW, c.geo.canvasH]).toEqual([full.canvasW, full.canvasH]);
    // Out of range means full resolution.
    c.setShareScale(0);
    expect(c.geo.canvasW).toBe(full.canvasW);
  });

  it('keeps cols, rows and the cell size on screen at every budget factor (no re-grid)', () => {
    // Small cards at DPR 1 and 2, with and without an overflow margin: the pitch rounding
    // used to change the grid at every step of the budget scale.
    for (const [w, h, dpr, overflow, count] of [
      [300, 200, 1, 0, 34],
      [300, 200, 2, 0, 34],
      [260, 180, 1.5, 12, 22],
      [420, 240, 2, 0, 60],
    ] as const) {
      const c = new Controller({
        random: mulberry32(2),
        config: { grid: { sizing: 'count', count }, render: { overflow } },
      });
      c.setViewport({ hostCssW: w, hostCssH: h, dpr, deviceW: 0, deviceH: 0 });
      const full = { ...c.geo, cellCss: c.cellCss };
      for (let k = 1; k <= 24; k++) {
        const scale = 2 ** (-k / 8);
        c.geometryChanged = false;
        c.setShareScale(scale);
        const g = c.geo;
        expect([g.cols, g.rows, g.pad]).toEqual([full.cols, full.rows, full.pad]);
        expect(Number.isInteger(g.pitchPx)).toBe(true);
        // Same cell size on screen within the canvas rounding (well under 1 %).
        expect(Math.abs(c.cellCss - full.cellCss) / full.cellCss).toBeLessThan(0.01);
        // Snapped down to a whole pitch, never below the 3 px minimum (nor above the full one).
        expect(g.pitchPx).toBe(
          Math.min(full.pitchPx, Math.max(3, Math.floor(full.pitchPx * scale))),
        );
        if (Math.floor(full.pitchPx * scale) >= 3) {
          // Never more pixels than the budget factor asks for.
          expect(g.canvasW * g.canvasH).toBeLessThanOrEqual(
            Math.ceil(full.canvasW * scale + 1) * Math.ceil(full.canvasH * scale + 1),
          );
        }
        // The grid still covers the host and stays centered on it.
        expect(g.cols * g.pitchPx).toBeGreaterThanOrEqual(g.hostW);
        expect(g.rows * g.pitchPx).toBeGreaterThanOrEqual(g.hostH);
        const midX = g.originX + (g.pad + (g.cols - 1) / 2 + 0.5) * g.pitchPx;
        expect(Math.abs(midX - g.centerX)).toBeLessThanOrEqual(0.5);
        expect(Math.abs(g.originX / g.pitchPx - full.originX / full.pitchPx)).toBeLessThan(0.5);
        expect([c.naturalWidth, c.naturalHeight]).toEqual([full.canvasW, full.canvasH]);
      }
    }
  });

  it('a default small card keeps its grid at the lowest budget step (the 3 px pitch floor)', () => {
    // Default config (sizing 'count'), 180x100 CSS at DPR 1: already at the 3 px pitch.
    const c = new Controller({ random: mulberry32(4) });
    c.setViewport({ hostCssW: 180, hostCssH: 100, dpr: 1, deviceW: 0, deviceH: 0 });
    const full = { ...c.geo, cellCss: c.cellCss };
    expect(full.pitchPx).toBe(3);
    for (const scale of [0.917, Math.SQRT1_2, 0.5, SHARE_GRID_MIN_SCALE]) {
      c.setShareScale(scale);
      expect([c.geo.cols, c.geo.rows, c.geo.pitchPx]).toEqual([full.cols, full.rows, 3]);
      expect([c.geo.canvasW, c.geo.canvasH]).toEqual([full.canvasW, full.canvasH]);
      expect(c.cellCss).toBeCloseTo(full.cellCss, 6);
    }
    // Only the drawable limit asks for less: then the cells grow.
    c.setShareScale(SHARE_GRID_MIN_SCALE / 2);
    expect(c.geo.canvasW).toBeLessThan(full.canvasW);
    expect(c.cellCss).toBeGreaterThan(full.cellCss);
    // DPR 2: cell size on screen and grid stay put across the whole budget ladder (it used to
    // wobble non-monotonically as the scaled pitch re-snapped).
    c.setShareScale(1);
    c.setViewport({ hostCssW: 180, hostCssH: 100, dpr: 2, deviceW: 0, deviceH: 0 });
    const full2 = { ...c.geo, cellCss: c.cellCss };
    for (let k = 1; k <= 24; k++) {
      c.setShareScale(2 ** (-k / 8));
      expect([c.geo.cols, c.geo.rows]).toEqual([full2.cols, full2.rows]);
      expect(Math.abs(c.cellCss - full2.cellCss) / full2.cellCss).toBeLessThan(0.01);
    }
  });

  it('the natural size leaves the adaptive scale out (adaptive steps save pixels)', () => {
    const c = new Controller({ random: mulberry32(3) });
    c.setViewport({ hostCssW: 400, hostCssH: 300, dpr: 2, deviceW: 0, deviceH: 0 });
    const natW = c.naturalWidth;
    const natH = c.naturalHeight;
    // Adaptive quality at its 0.72 resolution level (level 4 of QUALITY_LEVELS).
    (c.perf as unknown as { level: number }).level = 4;
    expect(c.perf.scale).toBe(0.72);
    c.setViewport({ hostCssW: 400, hostCssH: 300, dpr: 2, deviceW: 0, deviceH: 0 });
    expect(c.geo.canvasW).toBeLessThan(natW);
    // Unchanged: the budget plan does not see the adaptive step, so it does not undo it.
    expect([c.naturalWidth, c.naturalHeight]).toEqual([natW, natH]);
    const adaptive = { ...c.geo };
    // The share factor comes on top of the adaptive one, on the adaptive grid.
    c.setShareScale(0.5);
    expect([c.naturalWidth, c.naturalHeight]).toEqual([natW, natH]);
    expect(c.geo.canvasW).toBeLessThanOrEqual(Math.round(adaptive.canvasW * 0.5));
    expect([c.geo.cols, c.geo.rows]).toEqual([adaptive.cols, adaptive.rows]);
  });
});
