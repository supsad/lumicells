import type { BindElementOptions } from '../core/types';

/**
 * Whether going from `prev` to `next` cannot be expressed as `handle.update(next)` and the
 * binding has to be disposed and created again. Shared by the Web Component and `useInfluence`.
 *
 * - `track`, `padding` and `signal` are read once, at bind time;
 * - `cornerRadius` going between undefined and defined flips the auto-corner tracking, which is
 *   also fixed at bind time;
 * - a key that disappeared (or became `undefined`, the usual React pattern) cannot be "unset"
 *   through update(), which skips undefined values.
 */
export function needsRebind(prev: BindElementOptions, next: BindElementOptions): boolean {
  if (prev.track !== next.track || prev.padding !== next.padding || prev.signal !== next.signal) {
    return true;
  }
  if ((prev.cornerRadius === undefined) !== (next.cornerRadius === undefined)) return true;
  const p = prev as Record<string, unknown>;
  const n = next as Record<string, unknown>;
  return Object.keys(p).some((k) => p[k] !== undefined && n[k] === undefined);
}
