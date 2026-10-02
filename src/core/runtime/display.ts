/**
 * Display refresh calibration: how often the display (or the OS) lets the page draw, measured on
 * frames that carry no GL work of ours.
 *
 * Adaptive quality reads the refresh interval from the rAF cadence while instances draw, and a
 * GPU that is slow from the very first frame paces that cadence itself: on a 165 Hz display a
 * frame that needs three vsyncs arrives every 18 ms, which the estimate snaps to 60 Hz, so every
 * frame "keeps its budget" and quality never steps down. rAF deltas of frames whose two
 * predecessors drew nothing (no draw call, no context created, little main-thread work of ours)
 * are paced by the display alone: the fastest refresh rate a fair share of them hit is the
 * display's. That figure (displayIntervalMs) is a hint for every PerfController and for the
 * shared renderer's frame budget.
 *
 * Such frames come for free while instances wait for their context or compile their programs
 * (parallel compiles run off the main thread). Where they are too few (warm shader caches), a
 * calibration holds the first draws for a few more frames (calibrationHold): the poster covers
 * them, and at most HOLD_MAX_FRAMES / HOLD_MAX_MS pass. The same happens when the page comes
 * back from a hidden tab or the device pixel ratio changes (requestDisplayCalibration): the
 * canvases keep their last frame meanwhile, until the probe confirms a rate (the same one
 * included). A display change that keeps the DPR is not seen here: the consumers adopt a slower
 * pace from the frame cadence on their own (PerfController.maybeRise, FrameLoad). A busy GPU (a compile that stalls it) can only make quiet
 * frames slower, never faster, and the hint is only ever used as an upper bound of the refresh
 * interval, so a disturbed calibration costs nothing over not having one.
 *
 * Nothing runs at import (SSR-safe): the ticker feeds frames once it runs.
 */

import { VSYNC_CANDIDATES } from './vsync';

/** Clean deltas kept (newest first out). */
export const CADENCE_WINDOW = 24;
/** Clean deltas needed before a result is published. */
export const CADENCE_MIN_SAMPLES = 4;
/** Share of the clean deltas the published refresh rate must have hit. */
const CADENCE_SHARE = 0.3;
/** Main-thread work of ours above which a frame counts as busy, ms. */
export const QUIET_WORK_MS = 2;
/** A calibration holds GL work for at most this many frames and this long. */
export const HOLD_MAX_FRAMES = 10;
export const HOLD_MAX_MS = 160;

/**
 * Turns rAF deltas into a display refresh interval. Feed every frame's delta with whether it is
 * clean (its two predecessors carried no GL work); only clean ones count. Pure: no clock, no DOM.
 */
export class CadenceProbe {
  readonly #deltas = new Float64Array(CADENCE_WINDOW);
  readonly #cand = new Int8Array(CADENCE_WINDOW);
  readonly #counts = new Int32Array(VSYNC_CANDIDATES.length);
  #head = 0;
  #n = 0;
  /** Published refresh interval, ms, or null before enough clean frames were seen. */
  intervalMs: number | null = null;
  /**
   * Bumped on every completed measurement: the first one after a reset (even when it confirms
   * the value already published) and every new value later. Consumers take a new epoch as a
   * fresh calibration: they re-apply a hint they had rejected and forget what they learned
   * before it.
   */
  epoch = 0;
  /** A measurement completed since the last reset. */
  #settled = false;

  /** Clean deltas collected since the last reset. */
  get samples(): number {
    return this.#n;
  }

  /** Forgets the samples (not the published value: a new one replaces it once measured). */
  reset(): void {
    this.#n = 0;
    this.#head = 0;
    this.#counts.fill(0);
    this.#settled = false;
  }

  /** Forgets the published value too. */
  clear(): void {
    this.reset();
    this.intervalMs = null;
  }

  /**
   * One frame: `deltaMs` since the previous one, `clean` when nothing of ours could have delayed
   * it. Returns true when a measurement completed: the first one since the last reset (whether
   * or not it changed the published value) or a new value later on.
   */
  feed(deltaMs: number, clean: boolean): boolean {
    if (!clean || !(deltaMs > 0.5) || deltaMs > 1000) return false;
    let best = -1;
    let bestErr = 0.15;
    for (let i = 0; i < VSYNC_CANDIDATES.length; i++) {
      const err = Math.abs(deltaMs / (VSYNC_CANDIDATES[i] as number) - 1);
      if (err < bestErr) {
        bestErr = err;
        best = i;
      }
    }
    if (this.#n === CADENCE_WINDOW) {
      const old = this.#cand[this.#head] as number;
      if (old >= 0) this.#counts[old] = (this.#counts[old] as number) - 1;
    } else {
      this.#n++;
    }
    this.#deltas[this.#head] = deltaMs;
    this.#cand[this.#head] = best;
    if (best >= 0) this.#counts[best] = (this.#counts[best] as number) + 1;
    this.#head = (this.#head + 1) % CADENCE_WINDOW;
    if (this.#n < CADENCE_MIN_SAMPLES) return false;
    // The fastest rate a fair share of quiet frames hit: jank only ever lengthens a delta.
    for (let i = 0; i < VSYNC_CANDIDATES.length; i++) {
      const c = this.#counts[i] as number;
      if (c >= 3 && c >= CADENCE_SHARE * this.#n) {
        const v = VSYNC_CANDIDATES[i] as number;
        if (v === this.intervalMs && this.#settled) return false;
        this.intervalMs = v;
        this.#settled = true;
        this.epoch++;
        return true;
      }
    }
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Page state (fed by the ticker)

let probe: CadenceProbe | null = null;
/** Frames since the last busy one (2+: the next delta is clean). */
let quietRun = 0;
let lastFrameAt = Number.NaN;
/** A calibration is wanted (page start, resume, display change). */
let wanted = true;
/** The hold of the current calibration: when it started (NaN: not started) and its frames. */
let holdStart = Number.NaN;
let holdFrames = 0;
let holdEnabled = true;

function getProbe(): CadenceProbe {
  if (!probe) probe = new CadenceProbe();
  return probe;
}

/**
 * Called by the ticker at the start of every frame with its timestamp: feeds the delta since the
 * previous frame (clean when the two frames before it were quiet).
 */
export function noteFrameStart(now: number): void {
  const p = getProbe();
  const delta = now - lastFrameAt;
  lastFrameAt = now;
  if (Number.isNaN(delta)) return;
  if (p.feed(delta, quietRun >= 2) && wanted) endCalibration();
  if (wanted && !Number.isNaN(holdStart)) {
    holdFrames++;
    if (holdFrames > HOLD_MAX_FRAMES || now - holdStart > HOLD_MAX_MS) endCalibration();
  }
}

/** Called by the ticker at the end of every frame: was it quiet (no GL work, little JS of ours)? */
export function noteFrameEnd(quiet: boolean): void {
  quietRun = quiet ? quietRun + 1 : 0;
}

/** The ticker stopped: the next frame's delta spans the idle time and is not a frame interval. */
export function noteTickerStopped(): void {
  lastFrameAt = Number.NaN;
  quietRun = 0;
}

function endCalibration(): void {
  wanted = false;
  holdStart = Number.NaN;
  holdFrames = 0;
}

/**
 * Asks for a new calibration (the page resumed from a hidden tab, or moved to another display):
 * the next frames collect quiet deltas again, holding GL work briefly when needed.
 */
export function requestDisplayCalibration(): void {
  if (wanted) return;
  wanted = true;
  holdStart = Number.NaN;
  holdFrames = 0;
  getProbe().reset();
}

/**
 * Whether GL work should wait in the frame stamped `now` for the calibration (instances skip
 * drawing; canvases keep their frame, posters stay up). Starts the hold on first ask.
 */
export function calibrationHold(now: number): boolean {
  if (!wanted || !holdEnabled) return false;
  if (Number.isNaN(holdStart)) {
    holdStart = now;
    holdFrames = 0;
  }
  return true;
}

/** The calibrated display refresh interval, ms, or null when not measured (yet). */
export function displayIntervalMs(): number | null {
  return probe?.intervalMs ?? null;
}

/**
 * Bumped on every completed calibration (a recalibration that confirms the same refresh rate
 * too) and whenever displayIntervalMs() publishes a new value.
 */
export function displayEpoch(): number {
  return probe?.epoch ?? 0;
}

/**
 * Tests only: forget everything. `hold` (default false): whether calibrations may hold GL work
 * (tests that count frames to the first draw keep it off).
 */
export function resetDisplayForTesting(hold = false): void {
  probe = null;
  quietRun = 0;
  lastFrameAt = Number.NaN;
  wanted = true;
  holdStart = Number.NaN;
  holdFrames = 0;
  holdEnabled = hold;
}
