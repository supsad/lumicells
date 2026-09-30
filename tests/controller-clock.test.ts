import { describe, expect, it } from 'vitest';
import {
  CLOCK_PERIOD,
  Clock,
  type ClockRates,
  DRIFT_PERIOD,
  EPOCH_WRAP,
} from '../src/core/controller/clock';
import { Controller } from '../src/core/controller/controller';
import { createParamLayout } from '../src/core/controller/layout';
import { mulberry32 } from '../src/core/controller/math';
import {
  FLICKER_RATE_STEPS,
  FRAME_FLOATS,
  OFF_EPOCH_A,
  OFF_EPOCH_B,
  OFF_MISC,
  writeEpochPhase,
} from '../src/core/engine/frame-block';

const layout = createParamLayout();
const MASK = EPOCH_WRAP - 1;
const FLICKER_MASK = Math.floor(MASK / FLICKER_RATE_STEPS);
const f32 = Math.fround;

function rates(patch: Partial<ClockRates> = {}): ClockRates {
  return {
    speed: 1,
    flow: 0,
    sphereRotation: 0,
    sphereBreathe: 0,
    pulse: 0,
    wave: 0,
    vortex: 0,
    rain: 0,
    drift: 0,
    lifeRate: 0,
    sparsity: 0,
    flicker: 0,
    sparkle: 0,
    ripple: 0,
    ...patch,
  };
}

/** The phase exactly as the shader receives it (whole, fraction) through the fp32 frame block. */
function uploaded(phase: number): [number, number] {
  const fr = new Float32Array(2);
  writeEpochPhase(fr, 0, phase);
  return [fr[0] as number, fr[1] as number];
}

/** GLSL epochAt() (frame-block.ts) in fp32. */
function epochAt(ph: [number, number], offset: number): [number, number] {
  const s = f32(ph[1] + offset);
  const fl = Math.floor(s);
  return [(ph[0] + fl) & MASK, s - fl];
}

/** GLSL flickerF() epoch index + fraction for a cell hash h, in fp32. */
function flickerEpoch(ph: [number, number], h: number): [number, number] {
  const Q = FLICKER_RATE_STEPS;
  const k = Math.floor(f32((0.6 + 0.8 * h) * Q) + 0.5);
  const pk = ph[0] * k;
  const tt = f32(f32((pk % Q) + f32(ph[1] * k)) / Q + f32(h * 7));
  const e = Math.floor(tt);
  return [(Math.floor(pk / Q) + e) & FLICKER_MASK, tt - e];
}

/**
 * Distance between an epoch position (index + fraction, index taken modulo `period`) and an
 * unwrapped reference. An fp32 fraction may round up to the next index (1.0 == next epoch at
 * 0.0): same position, so positions are compared rather than index and fraction separately.
 */
function cyclicDiff(pos: number, ref: number, period: number): number {
  const d = (((pos - ref) % period) + period) % period;
  return d > period / 2 ? d - period : d;
}

const tri = (x: number) => 1 - Math.abs(((((x * 0.5) % 1) + 1) % 1) * 2 - 1);

describe('Clock', () => {
  it('wraps every phase to its period', () => {
    const c = new Clock();
    const r = rates({ flow: 3, rain: 5, drift: 0.4, sparsity: 1 / 3 });
    c.seconds = CLOCK_PERIOD - 0.01;
    c.drift = DRIFT_PERIOD - 0.001;
    c.sparsity = EPOCH_WRAP - 0.001;
    c.advance(0.1, r);
    expect(c.seconds).toBeCloseTo(0.09, 9);
    expect(c.drift).toBeCloseTo(0.039, 9);
    expect(c.sparsity).toBeCloseTo(0.1 / 3 - 0.001, 9);
  });

  it('drift wraps at the period of the palette fold: tri(t + phase) stays continuous', () => {
    const c = new Clock();
    const r = rates({ drift: 0.1 });
    c.drift = DRIFT_PERIOD - 0.0005;
    const before = c.drift;
    c.advance(1 / 60, r);
    expect(c.drift).toBeLessThan(0.01);
    for (let t = -0.3; t <= 1.3; t += 0.05) {
      expect(Math.abs(tri(t + c.drift) - tri(t + before))).toBeLessThan(0.01);
    }
  });

  it('epoch phases cross EPOCH_WRAP on the same epoch sequence (sparsity, sparkle, ripple)', () => {
    const c = new Clock();
    const rate = 1 / 3;
    const r = rates({ sparsity: rate });
    const start = EPOCH_WRAP - 0.5;
    c.sparsity = start;
    let unwrapped = start;
    const dt = 1 / 60;
    const offsets = [0, 0.13, 0.5, 0.77, 0.999];
    let crossed = false;
    for (let i = 0; i < 400; i++) {
      c.advance(dt, r);
      unwrapped += dt * rate;
      crossed ||= unwrapped >= EPOCH_WRAP;
      const ph = uploaded(c.sparsity);
      expect(ph[0]).toBeLessThan(EPOCH_WRAP);
      for (const h of offsets) {
        const [e, f] = epochAt(ph, h);
        const ref = unwrapped + h;
        expect(Math.abs(cyclicDiff(e + f, ref, EPOCH_WRAP))).toBeLessThan(1e-5);
        // The hash sees the index itself: the same one as the unwrapped phase, modulo the wrap.
        if (Math.abs(f - 0.5) < 0.49) expect(e).toBe(Math.floor(ref) % EPOCH_WRAP);
      }
    }
    expect(crossed).toBe(true);
  });

  it('flicker epochs stay continuous for every per-cell rate across the wrap', () => {
    const c = new Clock();
    const rate = 0.3;
    const r = rates({ flicker: rate });
    const start = EPOCH_WRAP - 0.2;
    c.flicker = start;
    let unwrapped = start;
    const dt = 1 / 60;
    const cells = [0, 0.1234, 0.5, 0.8765, 0.9999];
    for (let i = 0; i < 120; i++) {
      c.advance(dt, r);
      unwrapped += dt * rate;
      const ph = uploaded(c.flicker);
      for (const h of cells) {
        const k = Math.floor(f32((0.6 + 0.8 * h) * FLICKER_RATE_STEPS) + 0.5);
        const ref = (unwrapped * k) / FLICKER_RATE_STEPS + h * 7;
        const [e, f] = flickerEpoch(ph, h);
        expect(Math.abs(cyclicDiff(e + f, ref, FLICKER_MASK + 1))).toBeLessThan(1e-4);
        if (Math.abs(f - 0.5) < 0.49) expect(e).toBe(Math.floor(ref) % (FLICKER_MASK + 1));
      }
    }
    expect(unwrapped).toBeGreaterThan(EPOCH_WRAP);
  });

  it('writes epoch phases exactly: whole part below 2^24, fraction in [0, 1]', () => {
    const fr = new Float32Array(2);
    for (const p of [0, 0.25, 12345.678, EPOCH_WRAP - 1e-9, EPOCH_WRAP - 0.37]) {
      writeEpochPhase(fr, 0, p);
      const whole = fr[0] as number;
      const frac = fr[1] as number;
      expect(Number.isInteger(whole)).toBe(true);
      expect(whole).toBeLessThan(2 ** 24);
      expect(frac).toBeGreaterThanOrEqual(0);
      expect(frac).toBeLessThanOrEqual(1);
      expect(Math.abs(whole + frac - p)).toBeLessThan(1e-6);
    }
  });

  it('a rate change bends the epoch phase instead of jumping it', () => {
    const c = new Clock();
    for (let i = 0; i < 600; i++) c.advance(1 / 60, rates({ sparsity: 1 / 3 }));
    const before = c.sparsity;
    c.advance(1 / 60, rates({ sparsity: 1 / 8 }));
    expect(c.sparsity - before).toBeCloseTo(1 / 60 / 8, 12);
  });

  it('schedules at most two life steps per frame and keeps the remainder', () => {
    const c = new Clock();
    const r = rates({ lifeRate: 30 });
    let total = 0;
    for (let i = 0; i < 24; i++) {
      c.advance(1 / 24, r);
      expect(c.lifeSteps).toBeLessThanOrEqual(2);
      total += c.lifeSteps;
    }
    expect(total).toBe(30);
  });
});

describe('Controller clock outputs', () => {
  function controller(config = {}) {
    const c = new Controller({ random: mulberry32(3), layout, config });
    c.setViewport({ hostCssW: 400, hostCssH: 400, dpr: 1, deviceW: 0, deviceH: 0 });
    return c;
  }

  it('hands every due life step to the engine (30 Hz automaton at 24 fps)', () => {
    const c = controller({ modes: { life: { weight: 1, stepRate: 30 } } });
    c.update(1 / 24);
    let steps = 0;
    const seed0 = c.frame.lifeSeed;
    for (let i = 0; i < 48; i++) {
      const f = c.update(1 / 24);
      expect(f.lifeSteps).toBeGreaterThanOrEqual(1);
      expect(f.lifeSteps).toBeLessThanOrEqual(2);
      steps += f.lifeSteps;
    }
    expect(steps).toBeGreaterThanOrEqual(59);
    expect(steps).toBeLessThanOrEqual(61);
    expect((c.frame.lifeSeed - seed0) >>> 0).toBe(steps);
  });

  it('uploads epoch phases from the effect periods and rates', () => {
    const c = controller({
      animation: {
        sparsity: { period: 4 },
        sparkle: { duration: 0.5 },
        flicker: { rate: 0.3 },
      },
      modes: { ripple: { life: 2 } },
    });
    let fr = c.frame.frame;
    for (let i = 0; i < 120; i++) fr = c.update(1 / 60).frame;
    const read = (off: number) => (fr[off] as number) + (fr[off + 1] as number);
    expect(read(OFF_EPOCH_A)).toBeCloseTo(2 / 4, 4);
    expect(read(OFF_EPOCH_A + 2)).toBeCloseTo(2 / 0.5, 4);
    expect(read(OFF_EPOCH_B)).toBeCloseTo(2 * 0.3, 4);
    expect(read(OFF_EPOCH_B + 2)).toBeCloseTo(2 / 2, 4);
    expect(fr.length).toBe(FRAME_FLOATS);
  });

  it('flags palette drift by rate or phase, never by a phase that lands on 0', () => {
    const c = controller();
    expect(c.update(1 / 60).frame[OFF_MISC + 3]).toBe(0);
    c.setConfig({ color: { drift: 0.2 } }, { transition: 0 });
    expect(c.update(1 / 60).frame[OFF_MISC + 3]).toBe(1);
    // Stopped mid-sweep: the fold keeps its frozen phase (no pop back to the unfolded palette).
    c.setConfig({ color: { drift: 0 } }, { transition: 0 });
    expect(c.update(1 / 60).frame[OFF_MISC + 3]).toBe(1);
  });
});
