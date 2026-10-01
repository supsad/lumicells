/**
 * One requestAnimationFrame loop shared by every LumiCells instance on the page.
 *
 * Several backgrounds (cards, hero, modal) cost a single rAF callback and see the same timestamp,
 * so their animations stay in phase. Each frame runs in four strict phases:
 *
 * 1. `before`  - app animators (e.g. flying bubbles) write their DOM/styles first;
 * 2. `measure` - every instance reads layout (host rect, bound elements) in one batch;
 * 3. `render`  - every instance does GPU work only, no DOM reads or writes;
 * 4. `present` - the shared renderer draws every shared instance into its atlas, then copies
 *                each one into its own 2D canvas (all draws strictly before all copies).
 *
 * Keeping reads and writes apart avoids forced synchronous layouts, and running animators first
 * removes the one-frame lag between a moving element and the light it casts on the grid.
 *
 * After them, internal frame-end callbacks run: the GPU scheduler creates queued engines there,
 * once it knows how heavy the frame already was (a new instance renders from the next frame).
 *
 * The ticker also keeps the page-level frame figures the runtime adapts to: a frame counter
 * (secondary instances present on every n-th frame, phase-staggered by it), the main-thread time
 * of the last frame, and whether it carried GL work, which feeds the display refresh
 * calibration (runtime/display).
 */

import { noteFrameEnd, noteFrameStart, noteTickerStopped, QUIET_WORK_MS } from './runtime/display';

export interface TickSubscriber {
  measure?(now: number): void;
  render?(now: number): void;
  present?(now: number): void;
}

type BeforeCallback = (now: number) => void;

const subscribers = new Set<TickSubscriber>();
const befores = new Set<BeforeCallback>();
const ends = new Set<BeforeCallback>();
let rafId = 0;
/** Timestamp of the frame being run, NaN outside of it. */
let current = Number.NaN;
/** Frames run so far (see frameSerial). */
let serial = 0;
/** Main-thread time of the last complete frame (every phase and frame-end callback), ms. */
let lastWorkMs = 0;
/** How late the running frame's callback started after its frame time (see frameLateMs), ms. */
let lateMs = 0;
/** GL work was submitted in the frame being run (see noteGpuWork). */
let gpuWork = false;

function busy(): boolean {
  return subscribers.size > 0 || befores.size > 0 || ends.size > 0;
}

// One broken subscriber must not stop the others: every call is guarded on its own.
function frame(now: number): void {
  rafId = busy() ? requestAnimationFrame(frame) : 0;
  const t0 = performance.now();
  // Clamped: a timestamp from another clock (tests, some engines) must not read as jank.
  lateMs = Math.min(250, Math.max(0, t0 - now));
  current = now;
  serial++;
  gpuWork = false;
  noteFrameStart(now);
  for (const cb of befores) {
    try {
      cb(now);
    } catch (err) {
      console.error(err);
    }
  }
  for (const s of subscribers) {
    try {
      s.measure?.(now);
    } catch (err) {
      console.error(err);
    }
  }
  for (const s of subscribers) {
    try {
      s.render?.(now);
    } catch (err) {
      console.error(err);
    }
  }
  for (const s of subscribers) {
    try {
      s.present?.(now);
    } catch (err) {
      console.error(err);
    }
  }
  for (const cb of ends) {
    try {
      cb(now);
    } catch (err) {
      console.error(err);
    }
  }
  current = Number.NaN;
  lastWorkMs = performance.now() - t0;
  // Quiet: no GL work and little main-thread work, ours or before ours (a late start).
  noteFrameEnd(!gpuWork && lastWorkMs < QUIET_WORK_MS && lateMs < QUIET_WORK_MS);
  if (!rafId) noteTickerStopped();
}

/**
 * Internal: number of frames the ticker ran so far (it keeps counting across idle periods).
 * Instances that present on every n-th frame compare it with their phase.
 */
export function frameSerial(): number {
  return serial;
}

/** Internal: main-thread time of the last complete frame (all phases and frame-end work), ms. */
export function frameWorkMs(): number {
  return lastWorkMs;
}

/**
 * Internal: how long after its frame time (the rAF timestamp) the running frame's callback
 * started, ms. Main-thread work that is not ours (long tasks, other rAF callbacks) delays it; a
 * GPU-bound frame does not (its frame time itself comes later).
 */
export function frameLateMs(): number {
  return lateMs;
}

/** Internal: GL work was submitted in the frame running now (it is not a quiet frame). */
export function noteGpuWork(): void {
  gpuWork = true;
}

/**
 * Internal: the timestamp of the frame running right now (in any of its phases or frame-end
 * callbacks), NaN outside of a frame. A WebGL canvas drawn in this frame still holds that frame
 * until the task ends (the browser presents it afterwards), so it can be copied.
 */
export function frameNow(): number {
  return current;
}

function ensureRunning(): void {
  if (!rafId && typeof requestAnimationFrame === 'function') {
    rafId = requestAnimationFrame(frame);
  }
}

function stopIfIdle(): void {
  if (!busy() && rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
    noteTickerStopped();
  }
}

/** Subscribes a renderer to the shared loop. Returns an unsubscribe function. */
export function subscribeTicker(subscriber: TickSubscriber): () => void {
  subscribers.add(subscriber);
  ensureRunning();
  return () => {
    subscribers.delete(subscriber);
    stopIfIdle();
  };
}

/**
 * Runs `cb` at the start of every frame, before any instance measures the DOM.
 * Use it to drive JS animations of elements that are bound to the background.
 */
export function onBeforeFrame(cb: BeforeCallback): () => void {
  befores.add(cb);
  ensureRunning();
  return () => {
    befores.delete(cb);
    stopIfIdle();
  };
}

/**
 * Internal (not exported from the package): runs `cb` last in every frame, after every
 * instance rendered. Returns an unsubscribe function.
 */
export function onFrameEnd(cb: BeforeCallback): () => void {
  ends.add(cb);
  ensureRunning();
  return () => {
    ends.delete(cb);
    stopIfIdle();
  };
}
