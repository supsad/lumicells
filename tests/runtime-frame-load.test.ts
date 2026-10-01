/**
 * The page's frame budget for the shared renderer's reducers (runtime/frame-load): divisors per
 * level and display, and the level decisions on simulated timelines (over budget, relaxing,
 * backoff, probes without a GPU timer).
 */
import { describe, expect, it } from 'vitest';
import {
  baseLevel,
  FrameLoad,
  fpsDivisor,
  levelAbove,
  levelBelow,
  levelDivisor,
  MAX_LEVEL,
  RELAX_MS,
  STEP_UP_MS,
} from '../src/core/runtime/frame-load';

describe('divisors', () => {
  it('level 1 caps at 60 fps and half the refresh, levels 2 and 3 aim at 30 and 15 fps', () => {
    const at = (ms: number) => [0, 1, 2, 3].map((l) => levelDivisor(l, ms));
    expect(at(16.67)).toEqual([1, 2, 2, 4]);
    expect(at(8.33)).toEqual([1, 2, 4, 8]);
    expect(at(6.94)).toEqual([1, 3, 5, 10]);
    expect(at(6.06)).toEqual([1, 3, 6, 11]);
    expect(at(4.17)).toEqual([1, 4, 8, 16]);
    // 50, 40 and 30 Hz: level 3 about 15 fps, or one divisor past level 2 within 100 ms (10 fps
    // at 30 Hz, not 7.5); level 2 never faster than level 1.
    expect(at(20)).toEqual([1, 2, 2, 3]);
    expect(at(25)).toEqual([1, 2, 2, 3]);
    expect(at(33.33)).toEqual([1, 2, 2, 3]);
  });

  it('divisors never fall as the level rises; levels 2 and 3 stay within 100 ms a present', () => {
    for (let ms = 4; ms <= 34; ms += 0.25) {
      for (let l = 1; l <= MAX_LEVEL; l++) {
        expect(levelDivisor(l, ms)).toBeGreaterThanOrEqual(levelDivisor(l - 1, ms));
      }
      expect(levelDivisor(MAX_LEVEL, ms) * ms).toBeLessThanOrEqual(100.5);
    }
  });

  it('steps skip a level that shares its rate with the one below (60 Hz: levels 1 and 2)', () => {
    expect(baseLevel(2, 16.67)).toBe(1);
    expect(levelAbove(0, 16.67)).toBe(1);
    expect(levelAbove(1, 16.67)).toBe(3);
    expect(levelAbove(3, 16.67)).toBe(3);
    expect(levelBelow(3, 16.67)).toBe(1);
    expect(levelBelow(2, 16.67)).toBe(0);
    expect(levelBelow(1, 16.67)).toBe(0);
    // 165 Hz: every level is a rate of its own.
    expect(levelAbove(1, 6.06)).toBe(2);
    expect(levelBelow(3, 6.06)).toBe(2);
  });

  it('a fixed cap snaps to a whole divisor of the refresh', () => {
    expect(fpsDivisor(30, 16.67)).toBe(2);
    expect(fpsDivisor(30, 6.06)).toBe(6);
    expect(fpsDivisor(60, 6.06)).toBe(3);
    expect(fpsDivisor(200, 6.06)).toBe(1);
    expect(fpsDivisor(0, 6.06)).toBe(1);
  });
});

interface Frame {
  delta: number;
  work: number;
  gpu: number | null;
}

/** Feeds `seconds` of frames from `frame(level)`; returns the level changes with their time. */
function drive(
  load: FrameLoad,
  seconds: number,
  frame: (level: number) => Frame,
  opts: {
    t0?: number;
    hint?: number | null;
    epoch?: number;
    floor?: number;
    relax?: number;
  } = {},
): { changes: { at: number; level: number }[]; now: number } {
  const changes: { at: number; level: number }[] = [];
  let now = opts.t0 ?? 0;
  const end = now + seconds * 1000;
  while (now < end) {
    const f = frame(load.effective(opts.floor ?? 0));
    now += f.delta;
    load.setDisplayHint(opts.hint === undefined ? 6.06 : opts.hint, opts.epoch ?? 1);
    if (load.sample(f.delta, f.work, f.gpu, now, opts.floor ?? 0, opts.relax ?? 2)) {
      changes.push({ at: now, level: load.level });
    }
  }
  return { changes, now };
}

/** 165 Hz: a frame arrives at the vsync after its work (main thread or GPU) is done. */
const VS = 6.06;
const paced = (ms: number) => Math.max(1, Math.ceil((ms + 0.3) / VS)) * VS;

describe('FrameLoad', () => {
  it('stays at 0 while the page keeps its budget', () => {
    const load = new FrameLoad();
    const r = drive(load, 10, () => ({ delta: VS, work: 1, gpu: 1 }));
    expect(r.changes).toEqual([]);
    expect(load.intervalMs).toBe(VS);
  });

  it('main-thread work above half the frame raises the level, one step per hold', () => {
    const load = new FrameLoad();
    // 100 instances on a slow CPU: the work shrinks with the level (fewer presents per frame).
    const work = [9, 4.5, 2.5, 1.5];
    const r = drive(load, 10, (l) => ({
      delta: paced(work[l] ?? 1),
      work: work[l] ?? 1,
      gpu: 0.5,
    }));
    expect(r.changes.map((c) => c.level)).toEqual([1, 2]);
    // Each step waited for the budget to be missed for STEP_UP_MS.
    expect(r.changes[0]?.at).toBeGreaterThanOrEqual(STEP_UP_MS);
    expect((r.changes[1]?.at ?? 0) - (r.changes[0]?.at ?? 0)).toBeGreaterThanOrEqual(1000);
    expect(load.level).toBe(2);
  });

  it('GPU time above 60 % of the frame raises it too', () => {
    const load = new FrameLoad();
    const gpu = [5.5, 3, 2, 1];
    const r = drive(load, 5, (l) => ({ delta: paced(gpu[l] ?? 1), work: 0.5, gpu: gpu[l] ?? 1 }));
    expect(r.changes.map((c) => c.level)).toEqual([1]);
  });

  it('relaxes only when the cost one level lower fits, after RELAX_MS', () => {
    const load = new FrameLoad();
    const work = [9, 2.6, 1.2];
    const r1 = drive(load, 6, (l) => ({
      delta: paced(work[l] ?? 1),
      work: work[l] ?? 1,
      gpu: null,
    }));
    expect(load.level).toBe(1);
    // Level 1 halves the presents per frame: 2.6 ms x 2 would not fit (no relax).
    const r2 = drive(load, 10, () => ({ delta: VS, work: 2.6, gpu: null }), { t0: r1.now });
    expect(r2.changes).toEqual([]);
    // The page got lighter (instances left): 0.8 ms x 2 fits, the level relaxes.
    const r3 = drive(load, 10, () => ({ delta: VS, work: 0.8, gpu: null }), { t0: r2.now });
    expect(r3.changes.map((c) => c.level)).toEqual([0]);
    expect((r3.changes[0]?.at ?? 0) - r2.now).toBeGreaterThanOrEqual(RELAX_MS);
  });

  it('a relax undone soon after doubles the next relax delay (no flip-flop)', () => {
    const load = new FrameLoad();
    // Optimistic projection (relax ratio 1) on a load that does not fit one level lower.
    const work = [4, 1];
    const r = drive(
      load,
      60,
      (l) => ({ delta: paced(work[l] ?? 1), work: work[l] ?? 1, gpu: null }),
      {
        relax: 1,
      },
    );
    const ups = r.changes.filter((c) => c.level === 1).map((c) => c.at);
    const downs = r.changes.filter((c) => c.level === 0).map((c) => c.at);
    expect(downs.length).toBeGreaterThanOrEqual(2);
    // Time spent at level 1 before each relax grows.
    const held = downs.map((d, i) => d - (ups[i] ?? 0));
    expect((held[1] ?? 0) / (held[0] ?? 1)).toBeGreaterThan(1.8);
    expect(downs.length).toBeLessThanOrEqual(5);
  });

  it('the floor (crowding, copy cost) is the starting point: a step goes above it', () => {
    const load = new FrameLoad();
    const r = drive(load, 3, () => ({ delta: paced(4), work: 4, gpu: null }), { floor: 1 });
    expect(r.changes.map((c) => c.level)).toEqual([2, 3]);
    expect(load.effective(1)).toBe(MAX_LEVEL);
    expect(load.effective(0)).toBe(MAX_LEVEL);
  });

  it('misses without a GPU timer and with little work of ours: a probe, kept if it helps', () => {
    // A GPU too slow for the display, no timer: fewer instances per frame cut the misses.
    const helped = new FrameLoad();
    const gpu = [9, 4, 2];
    const r1 = drive(helped, 8, (l) => ({ delta: paced(gpu[l] ?? 1), work: 0.6, gpu: null }));
    expect(r1.changes.map((c) => c.level)).toEqual([1]);
    expect(helped.level).toBe(1);
    // Something else holds the pace (the app, an OS cap): the probe is reverted, and the next
    // one waits a growing backoff.
    const not = new FrameLoad();
    const r2 = drive(not, 120, () => ({ delta: 2 * VS, work: 0.6, gpu: null }));
    const probes = r2.changes.filter((c) => c.level === 1).map((c) => c.at);
    expect(r2.changes.filter((c) => c.level === 0).length).toBe(probes.length);
    expect(probes.length).toBeGreaterThanOrEqual(2);
    expect(probes.length).toBeLessThanOrEqual(3);
    expect((probes[1] ?? 0) - (probes[0] ?? 0)).toBeGreaterThanOrEqual(30000);
  });

  it('without a calibrated refresh it plans with the fastest cadence it saw', () => {
    const load = new FrameLoad();
    const r1 = drive(load, 2, () => ({ delta: 8.33, work: 1, gpu: 1 }), { hint: null });
    expect(load.intervalMs).toBe(8.33);
    // A GPU that halves the frame rate is not a slower display.
    drive(load, 3, () => ({ delta: 16.67, work: 1, gpu: 12 }), { hint: null, t0: r1.now });
    expect(load.intervalMs).toBe(8.33);
  });

  it('a pause (hidden tab) forgets the window instead of reading it as a miss', () => {
    const load = new FrameLoad();
    const r1 = drive(load, 2, () => ({ delta: VS, work: 1, gpu: 1 }));
    expect(load.sample(5000, 1, 1, r1.now + 5000)).toBe(false);
    expect(load.missRatio).toBe(0);
  });
});

describe('FrameLoad on a display that got slower (165 Hz, then 60 Hz)', () => {
  const SIXTY = 16.67;
  /** 330 frames at 165 Hz with the calibrated hint (epoch 1); returns the time reached. */
  function at165(load: FrameLoad, gpu: number | null): number {
    return drive(load, 330 * VS * 0.001, () => ({ delta: VS, work: 2, gpu })).now;
  }

  it('a new calibration (a new epoch) replaces the fastest cadence learned before it', () => {
    for (const gpu of [2, null]) {
      const load = new FrameLoad();
      const t = at165(load, gpu);
      expect(load.intervalMs).toBe(VS);
      // The window moved to a 60 Hz monitor; the recalibration measured it.
      const r = drive(load, 60, () => ({ delta: SIXTY, work: 2, gpu }), {
        t0: t,
        hint: SIXTY,
        epoch: 2,
      });
      expect(r.changes).toEqual([]);
      expect(load.intervalMs).toBe(SIXTY);
      expect(load.missRatio).toBe(0);
      expect(load.level).toBe(0);
    }
  });

  it('with the crowd level as the floor, the inactive cards go back to 30 fps, not 5.5', () => {
    // The review scenario: 165 Hz, a pause (the window moved), then 60 Hz with 2 ms of work.
    const load = new FrameLoad();
    const t = drive(load, 200 * VS * 0.001, () => ({ delta: VS, work: 2, gpu: null }), {
      floor: 1,
    }).now;
    expect(load.sample(400, 2, null, t + 400, 1)).toBe(false);
    drive(load, 1200 * SIXTY * 0.001, () => ({ delta: SIXTY, work: 2, gpu: null }), {
      t0: t + 400,
      hint: SIXTY,
      epoch: 2,
      floor: 1,
    });
    expect(load.intervalMs).toBe(SIXTY);
    expect(load.missRatio).toBeLessThan(0.05);
    expect(load.effective(1)).toBe(1);
    expect(levelDivisor(load.effective(1), load.intervalMs)).toBe(2);
  });

  it('a recalibration at the same rate forgets the cadence too (same value, new epoch)', () => {
    const load = new FrameLoad();
    // A 60 Hz calibration, then 120 Hz frames: the cadence seen after it corrects it.
    const r1 = drive(load, 2, () => ({ delta: 8.33, work: 1, gpu: 12 }), { hint: SIXTY });
    expect(load.intervalMs).toBe(8.33);
    // The same measurement goes on: the cadence it learned stays.
    const r2 = drive(load, 2, () => ({ delta: SIXTY, work: 1, gpu: 12 }), {
      hint: SIXTY,
      t0: r1.now,
    });
    expect(load.intervalMs).toBe(8.33);
    // A recalibration (resume) measures 60 Hz again: same value, new epoch, the cadence learned
    // before it is forgotten.
    drive(load, 1, () => ({ delta: SIXTY, work: 1, gpu: 12 }), {
      hint: SIXTY,
      epoch: 2,
      t0: r2.now,
    });
    expect(load.intervalMs).toBe(SIXTY);
  });

  it('without a calibration a small GPU cost proves the slower pace: it is adopted (GPU timer)', () => {
    const load = new FrameLoad();
    const t = at165(load, 1);
    // Same DPR (no recalibration): the stale 165 Hz hint stays published.
    const r = drive(load, 60, () => ({ delta: SIXTY, work: 2, gpu: 1 }), { t0: t });
    expect(load.intervalMs).toBe(SIXTY);
    expect(load.displayHint).toBe(Number.POSITIVE_INFINITY);
    expect(load.missRatio).toBe(0);
    expect(load.level).toBe(0);
    expect(r.changes.every((c) => c.level <= 1)).toBe(true);
    // The same measurement stays rejected; a new calibration is taken.
    load.setDisplayHint(VS, 1);
    expect(load.displayHint).toBe(Number.POSITIVE_INFINITY);
    load.setDisplayHint(SIXTY, 2);
    expect(load.displayHint).toBe(SIXTY);
  });

  it('without a GPU timer the slower pace is adopted once the highest level did not help', () => {
    const load = new FrameLoad();
    const t = at165(load, null);
    const r = drive(load, 60, () => ({ delta: SIXTY, work: 2, gpu: null }), { t0: t });
    // The misses against 6.06 ms raise the level to the top; it does not bring the 165 Hz
    // frames back, so 60 Hz is the display's pace and the level relaxes.
    expect(Math.max(...r.changes.map((c) => c.level))).toBe(MAX_LEVEL);
    expect(load.intervalMs).toBe(SIXTY);
    expect(load.level).toBe(0);
    expect(load.missRatio).toBe(0);
  });

  it('resetVsync() forgets the fastest cadence (DPR change, resume)', () => {
    const load = new FrameLoad();
    const r1 = drive(load, 2, () => ({ delta: 8.33, work: 1, gpu: 12 }), { hint: null });
    load.resetVsync();
    drive(load, 1, () => ({ delta: SIXTY, work: 1, gpu: 12 }), { hint: null, t0: r1.now });
    expect(load.intervalMs).toBe(SIXTY);
  });
});

describe('FrameLoad on a 60 Hz display (levels 1 and 2 are both 30 fps)', () => {
  const SIXTY = 16.67;
  const paced60 = (ms: number) => Math.max(1, Math.ceil((ms + 0.3) / SIXTY)) * SIXTY;
  const opts = { hint: SIXTY, floor: 1 };

  it('a sustained over-budget load from the crowd level goes straight to 15 fps', () => {
    const load = new FrameLoad();
    // Main-thread work by effective level: levels 1 and 2 present the same frames.
    const work = [12, 12, 12, 4];
    const r = drive(
      load,
      6,
      (l) => ({ delta: paced60(work[l] ?? 1), work: work[l] ?? 1, gpu: 1 }),
      opts,
    );
    expect(r.changes.map((c) => c.level)).toEqual([3]);
    expect(load.effective(1)).toBe(3);
    expect(levelDivisor(load.effective(1), load.intervalMs)).toBe(4);
  });

  it('a probe without a GPU timer from the crowd level tries a real rate change, and keeps it', () => {
    const load = new FrameLoad();
    // A GPU too slow for 30 fps of the secondary instances, fine at 15 fps.
    const gpu = [30, 30, 30, 10];
    const r = drive(load, 8, (l) => ({ delta: paced60(gpu[l] ?? 1), work: 0.6, gpu: null }), opts);
    expect(r.changes.map((c) => c.level)).toEqual([3]);
    expect(load.level).toBe(3);
    expect(load.missRatio).toBeLessThan(0.05);
  });

  it('relaxing steps back over the shared rate: 15 fps, then 30, then the full rate', () => {
    const load = new FrameLoad();
    const heavy = [12, 12, 12, 4];
    const r1 = drive(
      load,
      4,
      (l) => ({
        delta: paced60(heavy[l] ?? 1),
        work: heavy[l] ?? 1,
        gpu: 1,
      }),
      { hint: SIXTY },
    );
    expect(r1.changes.map((c) => c.level)).toEqual([1, 3]);
    // The page got lighter.
    const r2 = drive(load, 20, () => ({ delta: SIXTY, work: 0.5, gpu: 0.5 }), {
      hint: SIXTY,
      t0: r1.now,
    });
    expect(r2.changes.map((c) => c.level)).toEqual([1, 0]);
    expect(load.level).toBe(0);
  });
});
