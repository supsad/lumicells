/**
 * Page signals every instance follows: the document's visibility and the
 * `prefers-reduced-motion` media query. One listener per document (and one query per window)
 * serves all instances: registering them once per instance adds up when a list of backgrounds
 * mounts in one task. Nothing happens at import (SSR-safe).
 */

interface Hub {
  readonly subs: Set<() => void>;
  readonly off: () => void;
}

function notify(subs: Set<() => void>): void {
  for (const cb of Array.from(subs)) {
    try {
      cb();
    } catch (err) {
      console.error(err);
    }
  }
}

function subscribe<K extends object>(
  hubs: WeakMap<K, Hub>,
  key: K,
  cb: () => void,
  attach: (fire: () => void) => () => void,
): () => void {
  let hub = hubs.get(key);
  if (!hub) {
    const subs = new Set<() => void>();
    hub = { subs, off: attach(() => notify(subs)) };
    hubs.set(key, hub);
  }
  const h = hub;
  h.subs.add(cb);
  return () => {
    if (!h.subs.delete(cb) || h.subs.size > 0) return;
    h.off();
    if (hubs.get(key) === h) hubs.delete(key);
  };
}

const visibilityHubs = new WeakMap<Document, Hub>();

/** Calls `cb` on every `visibilitychange` of `doc`. Returns the unsubscribe function. */
export function watchVisibility(doc: Document, cb: () => void): () => void {
  return subscribe(visibilityHubs, doc, cb, (fire) => {
    doc.addEventListener('visibilitychange', fire);
    return () => doc.removeEventListener('visibilitychange', fire);
  });
}

const reducedQueries = new WeakMap<Window, MediaQueryList>();
const reducedHubs = new WeakMap<Window, Hub>();

/** The `prefers-reduced-motion: reduce` query of `win` (one per window). */
export function reducedMotionQuery(win: Window): MediaQueryList {
  let mql = reducedQueries.get(win);
  if (!mql) {
    mql = win.matchMedia('(prefers-reduced-motion: reduce)');
    reducedQueries.set(win, mql);
  }
  return mql;
}

/** Calls `cb` when the reduced-motion preference of `win` changes. Returns the unsubscribe. */
export function watchReducedMotion(win: Window, cb: () => void): () => void {
  const mql = reducedMotionQuery(win);
  return subscribe(reducedHubs, win, cb, (fire) => {
    mql.addEventListener('change', fire);
    return () => mql.removeEventListener('change', fire);
  });
}
