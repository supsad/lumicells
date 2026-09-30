import { describe, expect, it } from 'vitest';
import { Controller } from '../src/core/controller/controller';
import { computeGeometry, createGeometry } from '../src/core/controller/geometry';
import {
  createLiftParams,
  LANDING,
  type LiftParams,
  LiftScheduler,
  springRise,
} from '../src/core/controller/lifts';
import { mulberry32 } from '../src/core/controller/math';
import { PulseList } from '../src/core/controller/pulses';
import { FRAME_FLOATS, MAX_LIFTS, OFF_SOCKET } from '../src/core/engine/frame-block';
import {
  LIFT_ALPHA,
  LIFT_CELL_X,
  LIFT_CELL_Y,
  LIFT_H,
  LIFT_OFF_Y,
  LIFT_SCALE_X,
  LIFT_SCALE_Y,
} from '../src/core/engine/types';

function geometry() {
  const g = createGeometry();
  computeGeometry(
    {
      hostCssW: 620,
      hostCssH: 620,
      overflowCss: 0,
      dpr: 1,
      deviceW: 0,
      deviceH: 0,
      maxDpr: 2,
      maxPixels: 4.2,
      scale: 1,
      cssPitch: 20,
    },
    g,
  );
  return g;
}

function params(p: Partial<LiftParams> = {}): LiftParams {
  return { ...createLiftParams(), ...p };
}

describe('lift spawning', () => {
  const geo = geometry();
  const frame = new Float32Array(FRAME_FLOATS);
  const cells = 31 * 31; // centers inside the 620 px host at a 20 px pitch

  function averageActive(p: LiftParams, seed: number, seconds = 120): number {
    const s = new LiftScheduler(mulberry32(seed), null);
    const dt = 1 / 60;
    for (let i = 0; i < 20 * 60; i++) s.step(dt, p, geo, frame); // warm up
    let sum = 0;
    const n = seconds * 60;
    for (let i = 0; i < n; i++) {
      s.step(dt, p, geo, frame);
      sum += s.count;
    }
    return sum / n;
  }

  it('keeps about amount * cells lifted (Poisson rate = expected / lifetime)', () => {
    expect(geo.pitchPx).toBe(20);
    const p = params({ outerBias: 0, cluster: 0 });
    const avg = averageActive(p, 42);
    const expected = p.amount * cells;
    expect(avg).toBeGreaterThan(expected * 0.85);
    expect(avg).toBeLessThan(expected * 1.15);
  });

  it('clusters and the outer-band bias keep the same expected count', () => {
    const p = params({ outerBias: 0.6, cluster: 0.3, amount: 0.03 });
    const avg = averageActive(p, 7);
    const expected = p.amount * cells;
    expect(avg).toBeGreaterThan(expected * 0.75);
    expect(avg).toBeLessThan(expected * 1.25);
  });

  it('never exceeds lift.max', () => {
    const p = params({ amount: 0.06, max: 10 });
    const s = new LiftScheduler(mulberry32(3), null);
    let peak = 0;
    for (let i = 0; i < 600; i++) {
      s.step(1 / 60, p, geo, frame);
      peak = Math.max(peak, s.count);
    }
    expect(peak).toBeLessThanOrEqual(10);
    expect(peak).toBeGreaterThan(5);
  });

  it('prefers the outer band when outerBias is 1', () => {
    const p = params({ outerBias: 1, cluster: 0, amount: 0.05, max: 128 });
    const s = new LiftScheduler(mulberry32(9), null);
    let inner = 0;
    let outer = 0;
    for (let i = 0; i < 1200; i++) {
      s.step(1 / 60, p, geo, frame);
      for (let k = 0; k < s.written; k++) {
        const cx = (s.instances[k * 12 + LIFT_CELL_X] as number) - geo.pad - (geo.cols - 1) / 2;
        const cy = (s.instances[k * 12 + LIFT_CELL_Y] as number) - geo.pad - (geo.rows - 1) / 2;
        const r = (Math.hypot(cx, cy) * geo.pitchPx) / geo.halfMin;
        if (r < 0.6) inner++;
        else outer++;
      }
    }
    expect(inner).toBe(0);
    expect(outer).toBeGreaterThan(0);
  });

  it('disabled (lift.enabled false / reduced motion): no random lifts', () => {
    const s = new LiftScheduler(mulberry32(3), null);
    const p = params({ enabled: false });
    for (let i = 0; i < 600; i++) s.step(1 / 60, p, geo, frame);
    expect(s.count).toBe(0);
  });
});

describe('lift envelopes', () => {
  const geo = geometry();

  function trace(p: LiftParams) {
    const pulses = new PulseList();
    const s = new LiftScheduler(mulberry32(1), pulses);
    const frame = new Float32Array(FRAME_FLOATS);
    expect(s.force(0, 0, 1, 0, p, geo)).toBe(1);
    const out: {
      t: number;
      h: number;
      sx: number;
      sy: number;
      a: number;
      y: number;
      sock: number;
    }[] = [];
    const dt = 1 / 240;
    let t = 0;
    for (let i = 0; i < 240 * 8 && s.count > 0; i++) {
      s.step(dt, p, geo, frame);
      t += dt;
      if (s.written === 0) continue;
      out.push({
        t,
        h: s.instances[LIFT_H] as number,
        sx: s.instances[LIFT_SCALE_X] as number,
        sy: s.instances[LIFT_SCALE_Y] as number,
        a: s.instances[LIFT_ALPHA] as number,
        y: s.instances[LIFT_OFF_Y] as number,
        sock: frame[OFF_SOCKET + 2] as number,
      });
    }
    return { out, pulses, end: t };
  }

  it('pop: spring rise with overshoot, hold, ease-in fall, landing squash + ripple', () => {
    const p = params({
      enabled: false,
      holdMin: 1,
      holdMax: 1,
      rise: 0.6,
      fall: 0.45,
      landing: 0.3,
    });
    const { out, pulses, end } = trace(p);
    const rise = out.filter((o) => o.t <= 0.6);
    const peak = Math.max(...rise.map((o) => o.h));
    expect(peak).toBeGreaterThan(1.05);
    expect(peak).toBeLessThan(1.2);
    expect(springRise(0, 0.6)).toBe(0);
    const held = out.filter((o) => o.t > 1.2 && o.t < 1.55);
    for (const o of held) expect(Math.abs(o.h - 1)).toBeLessThan(0.06);
    const fall = out.filter((o) => o.t > 1.61 && o.t < 2.04);
    for (let i = 1; i < fall.length; i++) {
      expect((fall[i] as { h: number }).h).toBeLessThanOrEqual(
        (fall[i - 1] as { h: number }).h + 1e-9,
      );
    }
    // Lifted copy moves up (negative y offset) and the socket dims with the height.
    const top = out.find((o) => o.t > 1.3);
    expect(top?.y).toBeLessThan(0);
    expect(top?.sock).toBeCloseTo(0.6 * Math.min(1, top?.h ?? 0), 5);
    const land = out.filter((o) => o.t > 2.05 + 0.02 && o.t < 2.05 + LANDING - 0.02);
    expect(land.length).toBeGreaterThan(0);
    for (const o of land) {
      expect(o.h).toBe(0);
      expect(o.sx).toBeGreaterThan(1);
      expect(o.sy).toBeLessThan(1);
    }
    expect(end).toBeGreaterThan(2.05 + LANDING - 0.01);
    expect(end).toBeLessThan(2.05 + LANDING + 0.02);
    expect(pulses.count).toBe(1);
  });

  it('float: drifts up out of its cell and fades out at the end', () => {
    const p = params({ enabled: false, style: 1, holdMin: 2, holdMax: 2, floatSpeed: 1 });
    const { out } = trace(p);
    const life = 0.6 + 2 + 0.45;
    const early = out.find((o) => o.t > 0.5) as { y: number; a: number; sx: number };
    const late = out.find((o) => o.t > life * 0.8) as { y: number; a: number; sx: number };
    expect(late.y).toBeLessThan(early.y - geo.pitchPx);
    expect(late.a).toBeLessThan(early.a);
    expect(late.sx).toBeLessThan(early.sx);
    const last = out[out.length - 1] as { a: number; t: number };
    expect(last.a).toBeLessThan(0.05);
    expect(last.t).toBeLessThan(life + 0.01);
  });
});

describe('controller lifts', () => {
  it('forced lifts land on the requested cell and write sockets', () => {
    const c = new Controller({ random: mulberry32(2), config: { lift: { enabled: false } } });
    c.setViewport({ hostCssW: 620, hostCssH: 620, dpr: 1, deviceW: 0, deviceH: 0 });
    c.lift({ x: 3, y: 4, space: 'cells' });
    let f = c.update(1 / 60);
    for (let i = 0; i < 20; i++) f = c.update(1 / 60);
    expect(f.liftCount).toBe(1);
    const pad = c.geo.pad;
    expect(f.lifts[LIFT_CELL_X]).toBe(3 + pad);
    expect(f.lifts[LIFT_CELL_Y]).toBe(4 + pad);
    expect(f.frame[OFF_SOCKET]).toBe(3 + pad);
    expect(f.frame[OFF_SOCKET + 1]).toBe(4 + pad);
    expect(f.frame[OFF_SOCKET + 2]).toBeGreaterThan(0);
  });

  it('host-space lifts with a count spread around the point', () => {
    const c = new Controller({ random: mulberry32(2), config: { lift: { enabled: false } } });
    c.setViewport({ hostCssW: 620, hostCssH: 620, dpr: 1, deviceW: 0, deviceH: 0 });
    c.lift({ x: 310, y: 310, count: 6, radius: 2 });
    let f = c.update(1 / 60);
    for (let i = 0; i < 40; i++) f = c.update(1 / 60);
    expect(f.liftCount).toBe(6);
    const cells = new Set<string>();
    for (let i = 0; i < 6; i++) cells.add(`${f.lifts[i * 12]},${f.lifts[i * 12 + 1]}`);
    expect(cells.size).toBe(6);
  });

  it('reduced motion turns forced lifts off too (lift() calls, pointer hover)', () => {
    const c = new Controller({ random: mulberry32(2), config: { lift: { enabled: false } } });
    c.setViewport({ hostCssW: 620, hostCssH: 620, dpr: 1, deviceW: 0, deviceH: 0 });
    // Queued before reduced motion was switched on: dropped as well.
    c.lift({ x: 100, y: 100, count: 3 });
    c.setReducedMotion(true);
    c.lift({ x: 200, y: 150, count: 5 });
    for (let i = 0; i < 20; i++) c.update(1 / 60);
    expect(c.lifts.count).toBe(0);
    expect(c.lifts.written).toBe(0);
    c.setReducedMotion(false);
    c.lift({ x: 200, y: 150, count: 5 });
    for (let i = 0; i < 20; i++) c.update(1 / 60);
    expect(c.lifts.count).toBe(5);
  });

  it('reduced motion stops random lifts; the cap is MAX_LIFTS', () => {
    const c = new Controller({ random: mulberry32(2), config: { lift: { amount: 0.06 } } });
    c.setViewport({ hostCssW: 1200, hostCssH: 800, dpr: 1, deviceW: 0, deviceH: 0 });
    c.setReducedMotion(true);
    for (let i = 0; i < 300; i++) c.update(1 / 60);
    expect(c.lifts.count).toBe(0);
    c.setReducedMotion(false);
    let peak = 0;
    for (let i = 0; i < 600; i++) {
      c.update(1 / 60);
      peak = Math.max(peak, c.lifts.count);
    }
    expect(peak).toBeGreaterThan(20);
    expect(peak).toBeLessThanOrEqual(Math.min(96, MAX_LIFTS));
  });
});
