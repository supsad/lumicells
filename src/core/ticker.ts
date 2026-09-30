/**
 * One requestAnimationFrame loop shared by every LumiCells instance on the page.
 *
 * Several backgrounds (cards, hero, modal) cost a single rAF callback and see the same timestamp,
 * so their animations stay in phase. Each frame runs in three strict phases:
 *
 * 1. `before`  - app animators (e.g. flying bubbles) write their DOM/styles first;
 * 2. `measure` - every instance reads layout (host rect, bound elements) in one batch;
 * 3. `render`  - every instance does GPU work only, no DOM reads or writes.
 *
 * Keeping reads and writes apart avoids forced synchronous layouts, and running animators first
 * removes the one-frame lag between a moving element and the light it casts on the grid.
 */

export interface TickSubscriber {
  measure?(now: number): void;
  render(now: number): void;
}

type BeforeCallback = (now: number) => void;

const subscribers = new Set<TickSubscriber>();
const befores = new Set<BeforeCallback>();
let rafId = 0;

function safeCall(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    // One broken subscriber must not stop the others.
    console.error(err);
  }
}

function frame(now: number): void {
  rafId = subscribers.size > 0 || befores.size > 0 ? requestAnimationFrame(frame) : 0;
  for (const cb of befores) safeCall(() => cb(now));
  for (const s of subscribers) if (s.measure) safeCall(() => s.measure?.(now));
  for (const s of subscribers) safeCall(() => s.render(now));
}

function ensureRunning(): void {
  if (!rafId && typeof requestAnimationFrame === 'function') {
    rafId = requestAnimationFrame(frame);
  }
}

function stopIfIdle(): void {
  if (subscribers.size === 0 && befores.size === 0 && rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
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
