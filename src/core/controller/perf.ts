/**
 * Adaptive quality: steps through discrete (tier, resolution scale) levels with hysteresis.
 *
 * rAF timing is quantized to vsync and polluted by things that are not our GPU cost (60 Hz caps
 * on 120 Hz panels, low-power modes, main-thread jank), so:
 * - the refresh interval is estimated from a rolling window of rAF deltas snapped to known rates;
 * - the metric is the GPU timer (budget 0.75 x vsync) when available, else the share of missed
 *   vsyncs, and only when the main thread is far from busy (under half a vsync: the caller feeds
 *   the whole frame's work and how late the frame started; otherwise it is jank, not GPU load);
 * - the refresh estimate is sticky (fastest rate seen), so a GPU that halves the frame rate for
 *   good still counts as missing vsyncs instead of looking like a 30 Hz display. It rises again
 *   only on clear evidence that the display/OS sets the slower pace: most of a full window at
 *   one slower rate while our own cost is small (GPU timer), or while locked (no GPU timer);
 *   resetVsync() (display change, resume from a hidden tab) forgets it;
 * - a GPU that is slow from the very first frame paces the cadence itself (three vsyncs of a
 *   165 Hz display arrive every 18 ms, which snaps to 60 Hz), so the cadence alone would never
 *   show a miss: the display refresh measured on frames without GL work (runtime/display) is a
 *   hint the estimate never goes above (setDisplayHint). Evidence that the display or the OS sets
 *   a slower pace (a rise, below, or a lock without a GPU timer) rejects the hint until a new
 *   calibration (a new epoch: every completed calibration brings one, even at the same rate);
 * - two consecutive steps down that reduce neither the misses nor the GPU time mean the
 *   OS/display caps the rate, or the GPU cost does not scale with pixels (per-draw overhead):
 *   revert and lock (one step alone may simply not be enough for a heavy load). The lock
 *   expires after a few minutes (and on resetVsync) so later GPU overload is still handled;
 * - a step up that brings misses back is reverted and that level is blacklisted, with an
 *   exponential backoff per level (30 s, 60 s, ... capped at 5 min) that resets once the level
 *   holds.
 */

import type { RenderQuality } from '../engine/types';

export type QualityMode = 'auto' | 'high' | 'medium' | 'low';

export interface QualityLevel {
  readonly quality: RenderQuality;
  readonly scale: number;
}

export const QUALITY_LEVELS: readonly QualityLevel[] = [
  { quality: 'high', scale: 1 },
  { quality: 'medium', scale: 1 },
  { quality: 'medium', scale: 0.85 },
  { quality: 'low', scale: 0.85 },
  { quality: 'low', scale: 0.72 },
  { quality: 'low', scale: 0.6 },
  { quality: 'low', scale: 0.5 },
];

/** Known refresh intervals, ms (240, 165, 144, 120, 90, 60, 30 Hz). */
export const VSYNC_CANDIDATES = [4.17, 6.06, 6.94, 8.33, 11.11, 16.67, 33.33] as const;

export const PERF_WINDOW = 120;
const STEP_DOWN_AFTER = 2000;
const STEP_UP_AFTER = 5000;
const MIN_INTERVAL = 2000;
const VERIFY_AFTER = 2000;
const BLACKLIST_MS = 30000;
const MAX_BLACKLIST_MS = 300000;
/** How long a 'locked' decision stands before adaptation probes again, ms. */
export const LOCK_MS = 180000;
/** Share of a full window at one slower rate that counts as a display/OS cap. */
const RISE_SHARE = 0.8;

export type PerfReason = 'slow' | 'recovered' | 'locked';

export interface PerfChange {
  quality: RenderQuality;
  scale: number;
  reason: PerfReason;
}

const VERIFY_NONE = 0;
const VERIFY_DOWN = 1;
const VERIFY_UP = 2;

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

export class PerfController {
  mode: QualityMode = 'auto';
  level = 0;
  locked = false;
  vsyncMs = 16.67;
  /**
   * Dominant rAF cadence in the window (ms): the interval frames actually arrive at. Unlike the
   * sticky vsyncMs it follows a display that got slower, so frame pacing (maxFps) uses it.
   */
  cadenceMs = 16.67;
  missRatio = 0;
  frameMs = 16.67;
  fps = 60;
  cpuMs = 0;
  gpuMs: number | null = null;
  private readonly deltas = new Float64Array(PERF_WINDOW);
  private readonly cand = new Int8Array(PERF_WINDOW);
  private readonly counts = new Int32Array(VSYNC_CANDIDATES.length);
  private readonly blacklist = new Float64Array(QUALITY_LEVELS.length);
  /** Failed step-ups per level (exponential blacklist backoff), reset when the level holds. */
  private readonly fails = new Uint8Array(QUALITY_LEVELS.length);
  private lockedUntil = 0;
  private head = 0;
  private n = 0;
  private sum = 0;
  private slowSince = -1;
  private goodSince = -1;
  private lastChange = Number.NEGATIVE_INFINITY;
  private verify = VERIFY_NONE;
  private verifyAt = 0;
  private verifyFrom = 0;
  private missBefore = 0;
  /** Consecutive steps down without fewer misses, and the level before the first of them. */
  private noGain = 0;
  private streakFrom = 0;
  /** Fastest refresh interval seen (sticky), ms. */
  private bestVsync = Number.POSITIVE_INFINITY;
  /** Calibrated display refresh interval (setDisplayHint), ms; Infinity: none or rejected. */
  private hint = Number.POSITIVE_INFINITY;
  /** Epoch of the hint in use, and of the last one rejected (-1: none). */
  private hintEpoch = -1;
  private rejectedEpoch = -1;
  /** GPU time when the last step down was taken (null: no GPU timer then). */
  private gpuBefore: number | null = null;
  /** Mean frame time when the last step down was taken, ms. */
  private frameBefore = 0;
  private readonly change: PerfChange = { quality: 'high', scale: 1, reason: 'slow' };

  get quality(): RenderQuality {
    if (this.mode !== 'auto') return this.mode;
    return (QUALITY_LEVELS[this.level] as QualityLevel).quality;
  }

  get scale(): number {
    if (this.mode !== 'auto') return 1;
    return (QUALITY_LEVELS[this.level] as QualityLevel).scale;
  }

  /** Samples in the current window. */
  get samples(): number {
    return this.n;
  }

  /** Switches between adaptive and a fixed tier; returns true when quality or scale changed. */
  setMode(mode: QualityMode): boolean {
    if (mode === this.mode) return false;
    const q = this.quality;
    const s = this.scale;
    this.mode = mode;
    if (mode === 'auto') {
      this.level = 0;
      this.locked = false;
      this.verify = VERIFY_NONE;
      this.noGain = 0;
      this.blacklist.fill(0);
      this.fails.fill(0);
      this.resetWindow();
    }
    return q !== this.quality || s !== this.scale;
  }

  /**
   * The display refresh interval measured on frames without GL work (runtime/display), ms, or
   * null. `epoch` identifies the measurement: a hint that was rejected (the display or the OS
   * proved to set a slower pace) stays rejected until a new measurement comes (runtime/display
   * bumps the epoch on every completed calibration, a recalibration at the same rate included).
   */
  setDisplayHint(ms: number | null, epoch: number): void {
    if (ms === null || !(ms > 0) || epoch === this.rejectedEpoch) {
      if (ms === null) this.hint = Number.POSITIVE_INFINITY;
      return;
    }
    if (epoch === this.hintEpoch && ms === this.hint) return;
    this.hintEpoch = epoch;
    this.hint = ms;
    if (ms < this.vsyncMs) this.vsyncMs = ms;
  }

  /** The display hint in use (Infinity: none). */
  get displayHint(): number {
    return this.hint;
  }

  /** The hint proved wrong (a slower pace set by the display or the OS): until a new one. */
  private rejectHint(): void {
    if (this.hint === Number.POSITIVE_INFINITY) return;
    this.rejectedEpoch = this.hintEpoch;
    this.hint = Number.POSITIVE_INFINITY;
  }

  /**
   * Forgets the sticky refresh estimate and every conclusion drawn from it: the lock, the
   * no-gain streak and the step-up backoff (the window moved to another display, the DPR
   * changed, or the page resumes from a hidden tab where OS power modes may have changed).
   */
  resetVsync(): void {
    this.bestVsync = Number.POSITIVE_INFINITY;
    this.locked = false;
    this.noGain = 0;
    this.blacklist.fill(0);
    this.fails.fill(0);
    this.resetWindow();
  }

  /** Forgets the timing window (after a pause or a resize, stale deltas are meaningless). */
  resetWindow(): void {
    this.n = 0;
    this.head = 0;
    this.sum = 0;
    this.counts.fill(0);
    this.slowSince = -1;
    this.goodSince = -1;
  }

  /**
   * Feeds one frame: rAF delta, our CPU time for the frame, the GPU time if measured, and the
   * frame timestamp (ms). Returns a (reused) change record when the level changed.
   */
  sample(deltaMs: number, cpuMs: number, gpuMs: number | null, now: number): PerfChange | null {
    const d = deltaMs > 0.5 ? (deltaMs < 1000 ? deltaMs : 1000) : 0.5;
    if (this.n === PERF_WINDOW) {
      this.sum -= this.deltas[this.head] as number;
      const c = this.cand[this.head] as number;
      if (c >= 0) this.counts[c] = (this.counts[c] as number) - 1;
    } else {
      this.n++;
    }
    const c = nearestCandidate(d);
    this.deltas[this.head] = d;
    this.cand[this.head] = c;
    if (c >= 0) this.counts[c] = (this.counts[c] as number) + 1;
    this.sum += d;
    this.head = (this.head + 1) % PERF_WINDOW;

    const n = this.n;
    this.cpuMs += (Math.max(0, cpuMs) - this.cpuMs) * 0.1;
    if (gpuMs !== null && Number.isFinite(gpuMs)) {
      this.gpuMs = this.gpuMs === null ? gpuMs : this.gpuMs + (gpuMs - this.gpuMs) * 0.1;
    }
    if (n >= 20) {
      // The fastest rate that a fair share of frames hit is the display refresh; slower
      // clusters are missed vsyncs (a 120 Hz panel running at 60 still reports 8.33 frames).
      let vs = -1;
      let maxI = -1;
      let maxC = 0;
      for (let i = 0; i < VSYNC_CANDIDATES.length; i++) {
        const cnt = this.counts[i] as number;
        if (vs < 0 && cnt >= 0.2 * n) vs = i;
        if (cnt > maxC) {
          maxC = cnt;
          maxI = i;
        }
      }
      if (vs < 0) vs = maxI;
      if (maxI >= 0) this.cadenceMs = VSYNC_CANDIDATES[maxI] as number;
      if (vs >= 0) {
        const est = VSYNC_CANDIDATES[vs] as number;
        if (n >= 30 && est < this.bestVsync) this.bestVsync = est;
        this.vsyncMs = Math.min(est, this.bestVsync, this.hint);
      }
      if (n === PERF_WINDOW && maxI >= 0 && maxC >= RISE_SHARE * n) this.maybeRise(maxI);
    }
    const limit = 1.5 * this.vsyncMs;
    let miss = 0;
    for (let i = 0; i < n; i++) if ((this.deltas[i] as number) > limit) miss++;
    this.missRatio = n > 0 ? miss / n : 0;
    this.frameMs = n > 0 ? this.sum / n : d;
    this.fps = 1000 / this.frameMs;

    if (this.locked && now >= this.lockedUntil) this.locked = false;
    if (this.mode !== 'auto' || this.locked) return null;
    const vsync = this.vsyncMs;
    const gpu = this.gpuMs;

    if (this.verify === VERIFY_UP) {
      if (now - this.verifyAt >= VERIFY_AFTER) {
        // The step up held: forget this level's failures.
        this.verify = VERIFY_NONE;
        this.fails[this.level] = 0;
      } else if (n >= 30) {
        const slowish = gpu !== null ? gpu > 0.75 * vsync : this.missRatio > 0.15;
        if (slowish) {
          const f = this.fails[this.level] as number;
          this.blacklist[this.level] = now + Math.min(BLACKLIST_MS * 2 ** f, MAX_BLACKLIST_MS);
          this.fails[this.level] = Math.min(16, f + 1);
          return this.apply(this.verifyFrom, now, 'slow');
        }
      }
    }
    if (n < 60) return null;

    if (this.verify === VERIFY_DOWN && now - this.verifyAt >= VERIFY_AFTER) {
      this.verify = VERIFY_NONE;
      // Fewer misses, faster frames (three vsyncs down to two is a gain even though both miss)
      // or, with a GPU timer, less GPU time (the cadence may be held by something else); a step
      // that cut none of them is no gain.
      const gpuBefore = this.gpuBefore;
      const improved =
        this.missRatio < 0.1 ||
        this.missRatio < this.missBefore - 0.05 ||
        this.frameMs < 0.9 * this.frameBefore ||
        (gpu !== null && gpuBefore !== null && gpu < 0.9 * gpuBefore);
      if (improved) {
        this.noGain = 0;
      } else {
        if (this.noGain++ === 0) this.streakFrom = this.verifyFrom;
        if (this.noGain >= 2) {
          // Fewer pixels did not help: probe again after LOCK_MS. Without a GPU timer that is
          // evidence about the pace (a display cap, OS throttling): re-learn the refresh rate
          // from here on. With one, the GPU time did not shrink with the pixels (per-draw
          // overhead), which says nothing about the display: the refresh estimate and the hint
          // stay.
          this.locked = true;
          this.lockedUntil = now + LOCK_MS;
          this.noGain = 0;
          if (gpu === null || gpuBefore === null) {
            this.bestVsync = Number.POSITIVE_INFINITY;
            this.rejectHint();
          }
          return this.apply(this.streakFrom, now, 'locked');
        }
      }
    }

    const slow =
      gpu !== null ? gpu > 0.75 * vsync : this.missRatio > 0.25 && this.cpuMs < 0.5 * vsync;
    const good = this.missRatio < 0.02 && (gpu === null || gpu < 0.5 * vsync);
    this.slowSince = slow ? (this.slowSince < 0 ? now : this.slowSince) : -1;
    this.goodSince = good ? (this.goodSince < 0 ? now : this.goodSince) : -1;
    if (now - this.lastChange < MIN_INTERVAL) return null;

    if (
      this.slowSince >= 0 &&
      now - this.slowSince >= STEP_DOWN_AFTER &&
      this.level < QUALITY_LEVELS.length - 1
    ) {
      const from = this.level;
      const missBefore = this.missRatio;
      const frameBefore = this.frameMs;
      const ch = this.apply(from + 1, now, 'slow');
      this.verify = VERIFY_DOWN;
      this.verifyFrom = from;
      this.missBefore = missBefore;
      this.frameBefore = frameBefore;
      this.gpuBefore = gpu;
      return ch;
    }
    if (
      this.goodSince >= 0 &&
      now - this.goodSince >= STEP_UP_AFTER &&
      this.level > 0 &&
      (this.blacklist[this.level - 1] as number) <= now
    ) {
      const from = this.level;
      const ch = this.apply(from - 1, now, 'recovered');
      this.verify = VERIFY_UP;
      this.verifyFrom = from;
      return ch;
    }
    return null;
  }

  /**
   * Most of a full window arrives at candidate `i`. If that is slower than the sticky estimate
   * and our own cost is small, the display or the OS (low-power mode, energy saver, a 60 Hz
   * monitor) sets the pace, not our GPU: adopt the slower rate.
   */
  private maybeRise(i: number): void {
    const slower = VSYNC_CANDIDATES[i] as number;
    if (!(slower > Math.min(this.bestVsync, this.hint) * 1.1)) return;
    const gpu = this.gpuMs;
    const small =
      gpu !== null
        ? gpu < 0.5 * slower && this.cpuMs < 0.5 * slower
        : this.locked && this.cpuMs < 0.3 * slower;
    if (!small) return;
    this.rejectHint();
    this.bestVsync = slower;
    this.vsyncMs = slower;
    this.missRatio = 0;
    this.noGain = 0;
    this.resetWindow();
  }

  private apply(level: number, now: number, reason: PerfReason): PerfChange {
    this.level = level;
    this.lastChange = now;
    this.verifyAt = now;
    this.verify = VERIFY_NONE;
    this.resetWindow();
    const ch = this.change;
    ch.quality = this.quality;
    ch.scale = this.scale;
    ch.reason = reason;
    return ch;
  }
}
