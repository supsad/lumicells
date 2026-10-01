/**
 * Viewport size per window, for the `renderer: 'auto'` policy (a host covering a quarter of the
 * viewport prefers a context of its own).
 *
 * Reading `innerWidth` / `innerHeight` may force a layout, so the size is read once per window
 * and then only in its `resize` event, where one listener per window updates it and notifies the
 * instances watching it. Nothing happens at import (SSR-safe).
 */

interface ViewportWatch {
  w: number;
  h: number;
  readonly subs: Set<() => void>;
}

const watches = new WeakMap<Window, ViewportWatch>();

function watchOf(win: Window): ViewportWatch {
  let v = watches.get(win);
  if (!v) {
    const watch: ViewportWatch = { w: win.innerWidth, h: win.innerHeight, subs: new Set() };
    win.addEventListener('resize', () => {
      watch.w = win.innerWidth;
      watch.h = win.innerHeight;
      for (const cb of Array.from(watch.subs)) {
        try {
          cb();
        } catch (err) {
          console.error(err);
        }
      }
    });
    watches.set(win, watch);
    v = watch;
  }
  return v;
}

/** The viewport size of `win`, CSS px, as of its last `resize` event. */
export function viewportSize(win: Window): { readonly w: number; readonly h: number } {
  return watchOf(win);
}

/** Calls `cb` after every resize of `win`'s viewport. Returns the unsubscribe function. */
export function watchViewport(win: Window, cb: () => void): () => void {
  const v = watchOf(win);
  v.subs.add(cb);
  return () => {
    v.subs.delete(cb);
  };
}
