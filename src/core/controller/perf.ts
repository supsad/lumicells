/**
 * Adaptive quality: steps through discrete (tier, resolution scale) levels with hysteresis.
 *
 * rAF timing is quantized to vsync and polluted by things that are not our GPU cost (60 Hz caps
 * on 120 Hz panels, low-power modes, main-thread jank), so:
 * - the refresh interval is estimated from a rolling window of rAF deltas snapped to known rates;
 * - the metric is the GPU timer (budget 0.75 x vsync) when available, else the share of missed
 *   vsyncs, and only when our own CPU work is small (otherwise it is jank, not GPU load);
 * - the refresh estimate is sticky (fastest rate seen), so a GPU that halves the frame rate for
 *   good still counts as missing vsyncs instead of looking like a 30 Hz display;
 * - two consecutive steps down that do not reduce misses mean the OS/display caps the rate:
 *   revert and lock (one step alone may simply not be enough for a heavy load);
 * - a step up that brings misses back is reverted and that level is blacklisted for 30 s.
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
  missRatio = 0;
  frameMs = 16.67;
  fps = 60;
  cpuMs = 0;
  gpuMs: number | null = null;
  private readonly deltas = new Float64Array(PERF_WINDOW);
  private readonly cand = new Int8Array(PERF_WINDOW);
  private readonly counts = new Int32Array(VSYNC_CANDIDATES.length);
  private readonly blacklist = new Float64Array(QUALITY_LEVELS.length);
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
      this.resetWindow();
    }
    return q !== this.quality || s !== this.scale;
  }

  /** Forgets the sticky refresh estimate (e.g. the window moved to another display). */
  resetVsync(): void {
    this.bestVsync = Number.POSITIVE_INFINITY;
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
      if (vs >= 0) {
        const est = VSYNC_CANDIDATES[vs] as number;
        if (n >= 30 && est < this.bestVsync) this.bestVsync = est;
        this.vsyncMs = Math.min(est, this.bestVsync);
      }
    }
    const limit = 1.5 * this.vsyncMs;
    let miss = 0;
    for (let i = 0; i < n; i++) if ((this.deltas[i] as number) > limit) miss++;
    this.missRatio = n > 0 ? miss / n : 0;
    this.frameMs = n > 0 ? this.sum / n : d;
    this.fps = 1000 / this.frameMs;
    this.cpuMs += (Math.max(0, cpuMs) - this.cpuMs) * 0.1;
    if (gpuMs !== null && Number.isFinite(gpuMs)) {
      this.gpuMs = this.gpuMs === null ? gpuMs : this.gpuMs + (gpuMs - this.gpuMs) * 0.1;
    }

    if (this.mode !== 'auto' || this.locked) return null;
    const vsync = this.vsyncMs;
    const gpu = this.gpuMs;

    if (this.verify === VERIFY_UP) {
      if (now - this.verifyAt >= VERIFY_AFTER) this.verify = VERIFY_NONE;
      else if (n >= 30) {
        const slowish = gpu !== null ? gpu > 0.75 * vsync : this.missRatio > 0.15;
        if (slowish) {
          this.blacklist[this.level] = now + BLACKLIST_MS;
          return this.apply(this.verifyFrom, now, 'slow');
        }
      }
    }
    if (n < 60) return null;

    if (this.verify === VERIFY_DOWN && now - this.verifyAt >= VERIFY_AFTER) {
      this.verify = VERIFY_NONE;
      const improved = this.missRatio < 0.1 || this.missRatio < this.missBefore - 0.05;
      if (gpu !== null || improved) {
        this.noGain = 0;
      } else {
        if (this.noGain++ === 0) this.streakFrom = this.verifyFrom;
        if (this.noGain >= 2) {
          // Fewer pixels did not help: something else (display cap, OS throttling) sets the pace.
          this.locked = true;
          this.noGain = 0;
          return this.apply(this.streakFrom, now, 'locked');
        }
      }
    }

    const slow =
      gpu !== null ? gpu > 0.75 * vsync : this.missRatio > 0.25 && this.cpuMs < 0.3 * vsync;
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
      const ch = this.apply(from + 1, now, 'slow');
      this.verify = VERIFY_DOWN;
      this.verifyFrom = from;
      this.missBefore = missBefore;
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
