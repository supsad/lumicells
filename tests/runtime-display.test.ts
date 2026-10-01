/**
 * Display refresh calibration (runtime/display): the cadence probe on simulated timelines, and
 * the page state the ticker feeds (quiet frames, the hold that keeps GL work back for a few
 * frames, recalibration requests).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CADENCE_MIN_SAMPLES,
  CadenceProbe,
  calibrationHold,
  displayEpoch,
  displayIntervalMs,
  HOLD_MAX_FRAMES,
  HOLD_MAX_MS,
  noteFrameEnd,
  noteFrameStart,
  noteTickerStopped,
  requestDisplayCalibration,
  resetDisplayForTesting,
} from '../src/core/runtime/display';

/** Deterministic jitter in [-a, a]. */
const jitter = (i: number, a: number) => (((i * 0.6180339887) % 1) * 2 - 1) * a;

describe('CadenceProbe', () => {
  it('publishes the display refresh from clean deltas, with jitter', () => {
    for (const [ms, expected] of [
      [6.06, 6.06],
      [8.33, 8.33],
      [16.67, 16.67],
      [6.94, 6.94],
    ] as const) {
      const p = new CadenceProbe();
      for (let i = 0; i < CADENCE_MIN_SAMPLES - 1; i++) p.feed(ms + jitter(i, 0.3), true);
      expect(p.intervalMs).toBeNull();
      expect(p.feed(ms + 0.1, true)).toBe(true);
      expect(p.intervalMs).toBe(expected);
      expect(p.epoch).toBe(1);
    }
  });

  it('ignores frames that are not clean (GL work or our main-thread work before them)', () => {
    const p = new CadenceProbe();
    // A GPU-bound page: every busy frame takes three vsyncs of a 165 Hz display.
    for (let i = 0; i < 50; i++) p.feed(18.18, false);
    expect(p.samples).toBe(0);
    expect(p.intervalMs).toBeNull();
    for (let i = 0; i < CADENCE_MIN_SAMPLES; i++) p.feed(6.06, true);
    expect(p.intervalMs).toBe(6.06);
  });

  it('takes the fastest rate a fair share hit: jank only ever lengthens a delta', () => {
    const p = new CadenceProbe();
    // Page start: some quiet frames still land late (decoding, layout), most are on time.
    const deltas = [6.06, 12.12, 6.06, 6.06, 18.18, 6.06, 12.12, 6.06, 6.06];
    for (const d of deltas) p.feed(d, true);
    expect(p.intervalMs).toBe(6.06);
  });

  it('publishes nothing without a dominant rate, and re-publishes only a new value', () => {
    const p = new CadenceProbe();
    // Every known rate equally often: none has a fair share.
    const rates = [4.17, 6.06, 6.94, 8.33, 11.11, 16.67, 33.33];
    for (let i = 0; i < 24; i++) p.feed(rates[i % rates.length] as number, true);
    expect(p.intervalMs).toBeNull();
    const q = new CadenceProbe();
    for (let i = 0; i < 10; i++) q.feed(16.67, true);
    expect(q.epoch).toBe(1);
    for (let i = 0; i < 10; i++) expect(q.feed(16.67, true)).toBe(false);
    q.reset();
    for (let i = 0; i < 24; i++) q.feed(8.33, true);
    expect(q.intervalMs).toBe(8.33);
    expect(q.epoch).toBe(2);
  });

  it('a reset followed by the same rate is a completed measurement too (new epoch)', () => {
    const p = new CadenceProbe();
    for (let i = 0; i < 10; i++) p.feed(6.06, true);
    expect(p.epoch).toBe(1);
    p.reset();
    let completed = 0;
    for (let i = 0; i < 10; i++) if (p.feed(6.06, true)) completed++;
    expect(completed).toBe(1);
    expect(p.intervalMs).toBe(6.06);
    expect(p.epoch).toBe(2);
  });

  it('drops implausible deltas (a paused ticker, a clock jump)', () => {
    const p = new CadenceProbe();
    expect(p.feed(0, true)).toBe(false);
    expect(p.feed(4000, true)).toBe(false);
    expect(p.samples).toBe(0);
  });
});

describe('page calibration state', () => {
  beforeEach(() => resetDisplayForTesting(true));

  /** Runs `n` ticker frames `ms` apart from `t`; `quiet(i)` says whether frame i was quiet. */
  function run(t: number, n: number, ms: number, quiet: (i: number) => boolean = () => true) {
    for (let i = 0; i < n; i++) {
      t += ms;
      noteFrameStart(t);
      noteFrameEnd(quiet(i));
    }
    return t;
  }

  it('holds GL work until quiet frames tell the refresh, then never again', () => {
    let t = 1000;
    noteFrameStart(t);
    expect(calibrationHold(t)).toBe(true);
    noteFrameEnd(true);
    // A delta is clean once the two frames before it were quiet: from the second frame on.
    t = run(t, CADENCE_MIN_SAMPLES, 6.06);
    expect(displayIntervalMs()).toBeNull();
    expect(calibrationHold(t)).toBe(true);
    t = run(t, 1, 6.06);
    expect(displayIntervalMs()).toBe(6.06);
    expect(calibrationHold(t)).toBe(false);
    expect(displayEpoch()).toBe(1);
  });

  it('gives up after HOLD_MAX_FRAMES or HOLD_MAX_MS when the frames stay busy', () => {
    let t = 1000;
    noteFrameStart(t);
    calibrationHold(t);
    noteFrameEnd(false);
    t = run(t, HOLD_MAX_FRAMES, 6.06, () => false);
    expect(calibrationHold(t)).toBe(true);
    t = run(t, 1, 6.06, () => false);
    expect(calibrationHold(t)).toBe(false);
    expect(displayIntervalMs()).toBeNull();
    // At 30 Hz the time limit comes first.
    resetDisplayForTesting(true);
    t = 5000;
    noteFrameStart(t);
    calibrationHold(t);
    t = run(t, Math.ceil(HOLD_MAX_MS / 33.33) + 1, 33.33, () => false);
    expect(calibrationHold(t)).toBe(false);
  });

  it('keeps measuring quiet frames after the hold, and a request recalibrates', () => {
    let t = 1000;
    noteFrameStart(t);
    calibrationHold(t);
    t = run(t, HOLD_MAX_FRAMES + 1, 6.06, () => false);
    expect(calibrationHold(t)).toBe(false);
    // Later quiet frames (everyone paused, contexts pending) still publish.
    t = run(t, 2 + CADENCE_MIN_SAMPLES, 16.67);
    expect(displayIntervalMs()).toBe(16.67);
    // Back from a hidden tab: a new calibration, with a hold, on a faster display.
    requestDisplayCalibration();
    expect(calibrationHold(t)).toBe(true);
    t = run(t, 2 + CADENCE_MIN_SAMPLES, 8.33);
    expect(displayIntervalMs()).toBe(8.33);
    expect(calibrationHold(t)).toBe(false);
  });

  it('a recalibration that confirms the same rate ends the hold early', () => {
    let t = 1000;
    noteFrameStart(t);
    calibrationHold(t);
    noteFrameEnd(true);
    t = run(t, 2 + CADENCE_MIN_SAMPLES, 16.67);
    expect(displayIntervalMs()).toBe(16.67);
    expect(calibrationHold(t)).toBe(false);
    const epoch = displayEpoch();
    // Back from a hidden tab on the same display.
    requestDisplayCalibration();
    let frames = 0;
    while (calibrationHold(t) && frames < 2 * HOLD_MAX_FRAMES) {
      t = run(t, 1, 16.67);
      frames++;
    }
    expect(frames).toBeLessThanOrEqual(CADENCE_MIN_SAMPLES + 2);
    expect(frames).toBeLessThan(HOLD_MAX_FRAMES);
    expect(displayIntervalMs()).toBe(16.67);
    expect(displayEpoch()).toBe(epoch + 1);
  });

  it('a stopped ticker breaks the delta chain', () => {
    let t = 1000;
    t = run(t, 5, 6.06);
    noteTickerStopped();
    // The first frame after the restart spans the idle time: no sample, no quiet history.
    t += 3000;
    noteFrameStart(t);
    noteFrameEnd(true);
    t = run(t, 1, 6.06);
    expect(displayIntervalMs()).toBeNull();
  });

  it('holds nothing when the hold is disabled (tests that count frames)', () => {
    resetDisplayForTesting(false);
    expect(calibrationHold(1000)).toBe(false);
  });
});
