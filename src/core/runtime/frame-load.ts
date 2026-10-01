/**
 * Frame budget of the page, for the shared renderer's per-instance cost reducers.
 *
 * Fed once per frame with the rAF delta, the main-thread time of the previous frame (every
 * instance's work, see ticker.frameWorkMs), the shared device's GPU time when a timer exists and
 * the calibrated display interval (runtime/display). It answers one question with hysteresis:
 * how many levels of reducers the page needs (0 none; each level lowers the frame rate of the
 * inactive shared instances further, see levelDivisor).
 *
 * - Over budget: our main-thread work above half the frame, the shared GPU time above 60 % of
 *   it, or a fair share of missed frames while our work is a substantial part of the frame. Held
 *   for STEP_UP_MS, it raises the level by one step: to the next level that lowers the rate (on
 *   a 60 Hz display levels 1 and 2 are both 30 fps, so a step from 1 goes to 3).
 * - Missed frames while our measured work is small, without a GPU timer, may be a GPU too slow
 *   for the display or something else entirely (the OS, the display, the app): the level is
 *   raised on probation, kept only if the misses drop (and then held for a while: nothing tells
 *   when the GPU would keep up again), else reverted with a growing backoff.
 * - Under budget: the work, scaled by what relaxing one step would add back (`relaxRatio`), fits
 *   comfortably. Held for the relax delay (3 s, doubled after every relax that had to be undone
 *   soon after, up to a minute), it lowers the level by one step (to the next higher rate).
 *
 * The interval it plans with is the calibrated hint (setDisplayHint), bounded by the fastest
 * cadence seen since that hint came: a new calibration (a new epoch) or resetVsync() forgets
 * what the cadence taught before. A display that got slower without a calibration (a window
 * dragged to a 60 Hz monitor at the same DPR, an OS power profile) is adopted on evidence that
 * the pace is not ours: most of a full window at one slower rate while the GPU timer says our
 * cost is small, or, without a timer, while the highest level did not bring the frames back.
 *
 * Pure: no clock, no DOM (tests feed simulated timelines).
 */

import { VSYNC_CANDIDATES } from '../controller/perf';

/** Highest level (see levelDivisor). */
export const MAX_LEVEL = 3;
const WINDOW = 60;
const EMA = 0.1;
/** Over budget this long raises the level, ms. */
export const STEP_UP_MS = 500;
/** Under budget this long lowers it (doubled after a relax that did not hold), ms. */
export const RELAX_MS = 3000;
const MAX_RELAX_MS = 60000;
/** No change sooner than this after the previous one, ms. */
const MIN_INTERVAL = 1000;
/** A probe (see the header) is judged after this long, ms. */
const PROBE_MS = 2000;
const PROBE_BACKOFF_MS = 30000;
/**
 * Relax delay after a probe that helped: without a GPU timer nothing tells whether the GPU would
 * keep up one level lower, so the level holds a good while before it is tried.
 */
const PROBED_RELAX_MS = 30000;
const MAX_PROBE_BACKOFF_MS = 300000;
/** Share of a full window at one slower rate that counts as a display/OS pace. */
const RISE_SHARE = 0.8;

/**
 * Longest present period a level may reach by itself, ms: the controller's default animation step
 * bound (lower rates still run the animation in full, see Controller.update's maxDt, but the
 * levels stay within it where the display allows).
 */
const LEVEL_PERIOD_MS = 100;

/**
 * Frame divisor of the inactive shared instances at `level` on a display refreshing every
 * `intervalMs`: 1 at level 0; at most 60 fps (and at most half the refresh) at level 1; about
 * 30 fps at level 2; about 15 fps at level 3. A level never presents faster than the one below
 * it, so on slower displays neighbouring levels can share a divisor (60 Hz: levels 1 and 2 are
 * both 30 fps, see baseLevel / levelAbove); where level 3 would add nothing (a 30 Hz cadence) it
 * goes one divisor further while the present period stays within LEVEL_PERIOD_MS (10 fps there).
 */
export function levelDivisor(level: number, intervalMs: number): number {
  if (level <= 0) return 1;
  const I = Math.max(1, intervalMs);
  const hz = 1000 / I;
  // A little slack: 120.05 Hz is a 120 Hz display (2), not three frames per present.
  const d1 = Math.max(2, Math.ceil(hz / 60 - 0.05));
  if (level === 1) return d1;
  const d2 = Math.max(d1, Math.round(hz / 30));
  if (level === 2) return d2;
  const d3 = Math.max(d2, Math.round(hz / 15));
  return d3 === d2 && (d2 + 1) * I <= LEVEL_PERIOD_MS + 0.5 ? d2 + 1 : d3;
}

/** The lowest level presenting at the same rate as `level` (clamped to 0..MAX_LEVEL). */
export function baseLevel(level: number, intervalMs: number): number {
  let l = Math.min(MAX_LEVEL, Math.max(0, level));
  const d = levelDivisor(l, intervalMs);
  while (l > 0 && levelDivisor(l - 1, intervalMs) === d) l--;
  return l;
}

/** The next level above `level` that lowers the rate, or `level` when none does. */
export function levelAbove(level: number, intervalMs: number): number {
  const d = levelDivisor(level, intervalMs);
  for (let l = Math.max(0, level) + 1; l <= MAX_LEVEL; l++) {
    if (levelDivisor(l, intervalMs) !== d) return l;
  }
  return level;
}

/** The level below `level` that raises the rate (the lowest one at that rate), or 0. */
export function levelBelow(level: number, intervalMs: number): number {
  const b = baseLevel(level, intervalMs);
  return b > 0 ? baseLevel(b - 1, intervalMs) : 0;
}

/** Divisor for a fixed frame-rate cap (`secondaryMaxFps`): 1 when the cap is the refresh or more. */
export function fpsDivisor(maxFps: number, intervalMs: number): number {
  if (!(maxFps > 0)) return 1;
  const hz = 1000 / Math.max(1, intervalMs);
  return Math.max(1, Math.round(hz / maxFps));
}

function nearestCandidate(d: number): number {
  let best = -1;
  let bestErr = 0.15;
  for (let i = 0; i < VSYNC_CANDIDATES.length; i++) {
    const err = Math.abs(d / (VSYNC_CANDIDATES[i] as number) - 1);
    if (err < bestErr) {
      bestErr = err;
      best = i;
    }
  }
  return best;
}

export class FrameLoad {
  /** Levels the frame budget asks for (the effective level is max(floor, level)). */
  level = 0;
  /**
   * Display interval in use: the calibrated hint, bounded by the fastest cadence seen since it
   * came (16.67 before either is known), ms.
   */
  intervalMs = 16.67;
  /** Smoothed main-thread work per frame, ms. */
  workMs = 0;
  /** Smoothed shared GPU time per frame, ms (null without a timer). */
  gpuMs: number | null = null;
  /** Share of the last frames that missed a vsync. */
  missRatio = 0;
  /** The last sample found the frame over budget. */
  over = false;
  private readonly deltas = new Float64Array(WINDOW);
  private readonly cand = new Int8Array(WINDOW);
  private readonly counts = new Int32Array(VSYNC_CANDIDATES.length);
  private head = 0;
  private n = 0;
  /** Fastest cadence seen since the current hint (or resetVsync), ms. */
  private best = Number.POSITIVE_INFINITY;
  /** Calibrated display interval (setDisplayHint), ms; Infinity: none or rejected. */
  private hint = Number.POSITIVE_INFINITY;
  /** Epoch of the hint in use, and of the last one rejected by a rise (-1: none). */
  private hintEpoch = -1;
  private rejectedEpoch = -1;
  private overSince = -1;
  private underSince = -1;
  private lastChange = Number.NEGATIVE_INFINITY;
  private relaxMs = RELAX_MS;
  /** When the last relax happened (an over-budget soon after doubles the relax delay). */
  private relaxedAt = Number.NEGATIVE_INFINITY;
  /** Probe (see the header): when it started (-1: none) and the misses before it. */
  private probeAt = -1;
  private probeMiss = 0;
  private probeBackoff = PROBE_BACKOFF_MS;
  private probeBlockedUntil = Number.NEGATIVE_INFINITY;

  /**
   * To level `up` (the next one above the effective level that lowers the rate, see levelAbove).
   * Soon after a relax, that relax did not hold: relax later next time.
   */
  private raise(up: number, now: number): void {
    if (now - this.relaxedAt < 2 * this.relaxMs) {
      this.relaxMs = Math.min(MAX_RELAX_MS, this.relaxMs * 2);
    }
    this.level = up;
    this.lastChange = now;
    this.overSince = -1;
  }

  /**
   * The effective level for a `floor` other reasons already ask for (crowding, copy cost): the
   * lowest level at the rate of the higher of the two (see baseLevel), at the interval in use.
   */
  effective(floor: number): number {
    return baseLevel(Math.max(floor, this.level), this.intervalMs);
  }

  /**
   * The display refresh interval measured on frames without GL work (runtime/display), ms, or
   * null, and the epoch of that measurement. A new epoch is a fresh calibration: what the
   * cadence taught before it (the fastest rate seen, the window) is forgotten, so a slower
   * display is taken as soon as it is measured. A hint rejected by a rise stays out until a new
   * epoch.
   */
  setDisplayHint(ms: number | null, epoch: number): void {
    if (ms === null || !(ms > 0)) {
      this.hint = Number.POSITIVE_INFINITY;
      return;
    }
    if (epoch === this.rejectedEpoch) return;
    if (epoch !== this.hintEpoch) {
      this.hintEpoch = epoch;
      this.best = Number.POSITIVE_INFINITY;
      this.resetWindow();
    }
    this.hint = ms;
  }

  /** The display hint in use (Infinity: none or rejected). */
  get displayHint(): number {
    return this.hint;
  }

  /**
   * Forgets the fastest cadence seen and the probe backoff (the DPR changed, the window moved to
   * another display, the page resumes from a hidden tab: the refresh rate may have changed).
   */
  resetVsync(): void {
    this.best = Number.POSITIVE_INFINITY;
    this.probeBackoff = PROBE_BACKOFF_MS;
    this.probeBlockedUntil = Number.NEGATIVE_INFINITY;
    this.resetWindow();
  }

  /** Forgets the timing window (after a pause: the next deltas are not frame intervals). */
  resetWindow(): void {
    this.n = 0;
    this.head = 0;
    this.counts.fill(0);
    this.overSince = -1;
    this.underSince = -1;
  }

  /**
   * One frame (the calibrated display interval comes through setDisplayHint). `floor`: the level
   * other reasons ask for. `relaxRatio`: how much the per-frame cost would grow one step lower
   * (>= 1). Returns true when `level` changed.
   */
  sample(
    deltaMs: number,
    workMs: number,
    gpuMs: number | null,
    now: number,
    floor = 0,
    relaxRatio = 2,
  ): boolean {
    if (!(deltaMs > 0) || deltaMs > 250) {
      // A pause (hidden tab, nothing drawing): stale deltas say nothing about the budget.
      this.resetWindow();
      return false;
    }
    if (this.n === WINDOW) {
      const c = this.cand[this.head] as number;
      if (c >= 0) this.counts[c] = (this.counts[c] as number) - 1;
    } else {
      this.n++;
    }
    const c = nearestCandidate(deltaMs);
    this.deltas[this.head] = deltaMs;
    this.cand[this.head] = c;
    if (c >= 0) this.counts[c] = (this.counts[c] as number) + 1;
    this.head = (this.head + 1) % WINDOW;
    this.workMs += (Math.max(0, workMs) - this.workMs) * EMA;
    if (gpuMs !== null && Number.isFinite(gpuMs)) {
      this.gpuMs = this.gpuMs === null ? gpuMs : this.gpuMs + (gpuMs - this.gpuMs) * EMA;
    }
    if (this.n >= 20) {
      let maxI = -1;
      let maxC = 0;
      let fast = -1;
      for (let i = 0; i < VSYNC_CANDIDATES.length; i++) {
        const cnt = this.counts[i] as number;
        if (fast < 0 && cnt >= 0.2 * this.n) fast = i;
        if (cnt > maxC) {
          maxC = cnt;
          maxI = i;
        }
      }
      if (fast >= 0) this.best = Math.min(this.best, VSYNC_CANDIDATES[fast] as number);
      if (this.n === WINDOW && maxI >= 0 && maxC >= RISE_SHARE * WINDOW) {
        this.maybeRise(maxI, now);
      }
    }
    const interval = Math.min(this.hint, this.best);
    this.intervalMs = Number.isFinite(interval) ? interval : 16.67;
    const I = this.intervalMs;
    const n = this.n;
    if (n === 0) return false;
    const limit = 1.5 * I;
    let miss = 0;
    for (let i = 0; i < n; i++) if ((this.deltas[i] as number) > limit) miss++;
    this.missRatio = miss / n;
    if (n < 30) return false;

    const W = this.workMs;
    const G = this.gpuMs;
    const M = this.missRatio;
    const eff = this.effective(floor);
    // Steps change the rate: a level sharing its divisor with the one below is skipped.
    const up = levelAbove(eff, I);
    const over = W > 0.5 * I || (G !== null && G > 0.6 * I) || (M > 0.2 && W > 0.25 * I);
    this.over = over;
    const r = Math.max(1, relaxRatio);
    const under =
      M < 0.05 && W * r < 0.35 * I && (G === null || G * r < 0.45 * I) && eff > baseLevel(floor, I);
    this.overSince = over ? (this.overSince < 0 ? now : this.overSince) : -1;
    this.underSince = under ? (this.underSince < 0 ? now : this.underSince) : -1;

    // A probe on missed frames without a known cause: judged after PROBE_MS.
    if (this.probeAt >= 0 && now - this.probeAt >= PROBE_MS) {
      const helped = M < this.probeMiss - 0.1 || M < 0.05;
      this.probeAt = -1;
      if (helped) {
        this.probeBackoff = PROBE_BACKOFF_MS;
        this.relaxMs = Math.max(this.relaxMs, PROBED_RELAX_MS);
      } else {
        this.probeBlockedUntil = now + this.probeBackoff;
        this.probeBackoff = Math.min(MAX_PROBE_BACKOFF_MS, this.probeBackoff * 2);
        if (this.level > 0) {
          this.level = levelBelow(this.level, I);
          this.lastChange = now;
          return true;
        }
      }
    }
    if (now - this.lastChange < MIN_INTERVAL) return false;

    if (this.overSince >= 0 && now - this.overSince >= STEP_UP_MS && up > eff) {
      this.raise(up, now);
      return true;
    }
    if (
      !over &&
      G === null &&
      M > 0.3 &&
      this.probeAt < 0 &&
      now >= this.probeBlockedUntil &&
      up > eff
    ) {
      this.raise(up, now);
      this.probeAt = now;
      this.probeMiss = M;
      return true;
    }
    if (this.underSince >= 0 && now - this.underSince >= this.relaxMs && this.level > 0) {
      this.level = levelBelow(eff, I);
      this.lastChange = now;
      this.relaxedAt = now;
      this.underSince = -1;
      return true;
    }
    // A level that has held for a long while forgets the relax backoff.
    if (now - this.lastChange > MAX_RELAX_MS) this.relaxMs = RELAX_MS;
    return false;
  }

  /**
   * Most of a full window arrives at candidate `i`. If that is slower than the interval in use
   * and the pace is not ours, the display or the OS sets it (a slower monitor, a power profile):
   * adopt the slower rate (and drop the hint until a new calibration). The pace is not ours when
   * the GPU timer and the main thread both show a small cost, or, without a timer, when the
   * frame budget raised the level to the highest rate step, that held a while, and the frames still keep
   * that pace with little work of ours.
   */
  private maybeRise(i: number, now: number): void {
    const slower = VSYNC_CANDIDATES[i] as number;
    if (!(slower > Math.min(this.hint, this.best) * 1.1)) return;
    const G = this.gpuMs;
    const W = this.workMs;
    const small =
      G !== null
        ? G < 0.5 * slower && W < 0.5 * slower
        : this.level > 0 &&
          levelAbove(this.level, this.intervalMs) === this.level &&
          now - this.lastChange >= PROBE_MS &&
          W < 0.3 * slower;
    if (!small) return;
    if (Number.isFinite(this.hint)) {
      this.rejectedEpoch = this.hintEpoch;
      this.hint = Number.POSITIVE_INFINITY;
    }
    this.best = slower;
    this.resetWindow();
  }
}
