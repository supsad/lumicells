/**
 * bindElement tracking: keeps an influence glued to a DOM element.
 *
 * All reads happen in the ticker's measure phase (after app animators wrote their styles, before
 * any GL work), so a moving element and its light never lag by a frame and reads never
 * interleave with writes.
 * - `frame`  reads getBoundingClientRect every frame (JS-animated elements);
 * - `auto`   reads only while something may have moved it: its ResizeObserver, scroll, window
 *            resize, running CSS transitions/animations, Web Animations, plus a slow safety poll;
 * - `manual` never reads the DOM (the caller moves the handle in host space).
 * A binding whose element stays disconnected for 2 consecutive frames disposes itself, and so
 * does one whose influence left the registry on its own (ttlMs expiry). An element that is not
 * rendered (display:none, [hidden], closed <details>) hides its influence until it has a box.
 */

import type { Influence, InfluenceRegistry } from '../controller/influences';
import { SPACE_HOST } from '../controller/influences';

export type TrackMode = 'auto' | 'frame' | 'manual';

const MODE_AUTO = 0;
const MODE_FRAME = 1;
const MODE_MANUAL = 2;
/** Auto bindings re-read at least this often (layout shifts fire no events), frames. */
const SAFETY_POLL = 30;
/** How often an idle auto binding checks el.getAnimations() (it allocates), frames. */
const ANIM_CHECK = 4;

export class Binding {
  dirty = true;
  radiusDirty = true;
  running = 0;
  animated = false;
  animCheck = 0;
  sinceRead = 0;
  lost = 0;
  radius = 0;
  disposed = false;
  readonly ctl: AbortController | null;

  constructor(
    readonly el: Element,
    readonly entry: Influence,
    readonly mode: number,
    readonly padding: number,
    /**
     * Corner radius follows the element's border-radius (no explicit cornerRadius given).
     * Mutable: handle.update({ cornerRadius }) turns it off, `cornerRadius: null` back on.
     */
    public autoCorner: boolean,
    readonly onLost: () => void,
  ) {
    this.ctl = mode === MODE_AUTO ? new AbortController() : null;
  }
}

export class ElementTracker {
  readonly #list: Binding[] = [];
  #ro: ResizeObserver | null = null;
  readonly #byEl = new Map<Element, Binding[]>();
  #windowHooked = false;

  readonly #registry: InfluenceRegistry;
  readonly #signal: AbortSignal;

  constructor(registry: InfluenceRegistry, signal: AbortSignal) {
    this.#registry = registry;
    this.#signal = signal;
  }

  get size(): number {
    return this.#list.length;
  }

  /** Whether the next measure needs the host's client rect. */
  get needsHostRect(): boolean {
    const l = this.#list;
    for (let i = 0; i < l.length; i++) {
      const b = l[i] as Binding;
      // Expired (ttlMs) or fading out: nothing left to place.
      if (b.entry.removed || b.entry.disposing) continue;
      if (b.mode === MODE_FRAME) return true;
      if (
        b.mode === MODE_AUTO &&
        (b.dirty || b.animated || b.running > 0 || b.sinceRead >= SAFETY_POLL)
      )
        return true;
    }
    return false;
  }

  add(
    el: Element,
    entry: Influence,
    track: TrackMode,
    padding: number,
    autoCorner: boolean,
    onLost: () => void,
  ): Binding {
    const mode = track === 'frame' ? MODE_FRAME : track === 'manual' ? MODE_MANUAL : MODE_AUTO;
    const b = new Binding(el, entry, mode, padding, autoCorner, onLost);
    this.#list.push(b);
    if (mode !== MODE_MANUAL) {
      let arr = this.#byEl.get(el);
      if (!arr) {
        arr = [];
        this.#byEl.set(el, arr);
        this.#observer()?.observe(el);
      }
      arr.push(b);
    }
    if (b.ctl) {
      const opts = { signal: b.ctl.signal, passive: true } as const;
      const start = () => {
        b.running++;
        b.dirty = true;
      };
      const end = () => {
        b.running = Math.max(0, b.running - 1);
        b.dirty = true;
      };
      el.addEventListener('transitionrun', start, opts);
      el.addEventListener('transitionend', end, opts);
      el.addEventListener('transitioncancel', end, opts);
      el.addEventListener('animationstart', start, opts);
      el.addEventListener('animationend', end, opts);
      el.addEventListener('animationcancel', end, opts);
      this.#hookWindow();
    }
    return b;
  }

  remove(b: Binding): void {
    if (b.disposed) return;
    b.disposed = true;
    b.ctl?.abort();
    const i = this.#list.indexOf(b);
    if (i >= 0) this.#list.splice(i, 1);
    const arr = this.#byEl.get(b.el);
    if (arr) {
      const j = arr.indexOf(b);
      if (j >= 0) arr.splice(j, 1);
      if (arr.length === 0) {
        this.#byEl.delete(b.el);
        this.#ro?.unobserve(b.el);
      }
    }
  }

  /** Something global moved (scroll, host resize): re-read every auto binding. */
  markAllDirty(): void {
    for (let i = 0; i < this.#list.length; i++) (this.#list[i] as Binding).dirty = true;
  }

  /** Measure phase: host padding-box origin in client px (NaN when not read this frame). */
  measure(hostX: number, hostY: number): void {
    const l = this.#list;
    for (let i = l.length - 1; i >= 0; i--) {
      const b = l[i] as Binding;
      if (b.entry.removed) {
        // The registry dropped the influence on its own (ttlMs): release the DOM side too.
        this.remove(b);
        b.onLost();
        continue;
      }
      if (b.entry.disposing) continue;
      if (!b.el.isConnected) {
        if (++b.lost >= 2) {
          this.remove(b);
          b.onLost();
        }
        continue;
      }
      b.lost = 0;
      if (b.mode === MODE_MANUAL) continue;
      b.sinceRead++;
      if (b.mode === MODE_AUTO) {
        if (!b.animated && --b.animCheck <= 0) {
          b.animCheck = ANIM_CHECK;
          b.animated = hasAnimations(b.el);
        } else if (b.animated && --b.animCheck <= 0) {
          // Re-check rarely while animating: infinite Web Animations never fire events.
          b.animCheck = SAFETY_POLL;
          b.animated = hasAnimations(b.el);
        }
        if (!(b.dirty || b.animated || b.running > 0 || b.sinceRead >= SAFETY_POLL)) continue;
      }
      if (Number.isNaN(hostX)) continue;
      this.#read(b, hostX, hostY);
    }
  }

  clear(): void {
    for (const b of this.#list.slice()) this.remove(b);
    this.#ro?.disconnect();
    this.#ro = null;
  }

  // -------------------------------------------------------------------------------------------

  #read(b: Binding, hostX: number, hostY: number): void {
    b.dirty = false;
    b.sinceRead = 0;
    if (b.el.getClientRects().length === 0) {
      // Not rendered (display:none, [hidden], closed <details>): its rect is all zeros, which
      // would cast the influence at the viewport corner. Hide it; the ResizeObserver or the
      // safety poll brings it back on the next read that finds a box.
      b.entry.hidden = true;
      b.radiusDirty = true;
      return;
    }
    const r = b.el.getBoundingClientRect();
    if (b.radiusDirty) {
      b.radiusDirty = false;
      b.radius = readRadius(b.el, r.width, r.height);
    }
    const pad = b.padding;
    const e = b.entry;
    this.#registry.setShape(
      e,
      SPACE_HOST,
      r.left + r.width / 2 - hostX,
      r.top + r.height / 2 - hostY,
      r.width + 2 * pad,
      r.height + 2 * pad,
    );
    if (b.autoCorner) e.corner = b.radius + pad;
    e.hidden = false;
  }

  #observer(): ResizeObserver | null {
    if (this.#ro) return this.#ro;
    const RO = typeof ResizeObserver === 'function' ? ResizeObserver : null;
    if (!RO) return null;
    this.#ro = new RO((entries) => {
      for (const en of entries) {
        const arr = this.#byEl.get(en.target);
        if (!arr) continue;
        for (const b of arr) {
          b.dirty = true;
          b.radiusDirty = true;
        }
      }
    });
    this.#signal.addEventListener('abort', () => this.#ro?.disconnect(), { once: true });
    return this.#ro;
  }

  #hookWindow(): void {
    if (this.#windowHooked || typeof window === 'undefined') return;
    this.#windowHooked = true;
    const dirty = () => this.markAllDirty();
    const opts = { signal: this.#signal, passive: true, capture: true } as const;
    window.addEventListener('scroll', dirty, opts);
    window.addEventListener('resize', dirty, opts);
  }
}

/**
 * Animations that can still move the element. getAnimations() also returns finished ones that
 * keep applying through fill 'forwards'/'both' (a very common entrance pattern); counting those
 * would read layout every frame for the rest of the session.
 */
function hasAnimations(el: Element): boolean {
  const fn = (el as Element & { getAnimations?: () => Animation[] }).getAnimations;
  if (typeof fn !== 'function') return false;
  const list = fn.call(el);
  for (let i = 0; i < list.length; i++) {
    const a = list[i] as Animation;
    if (a.playState === 'running' || a.pending) return true;
  }
  return false;
}

function readRadius(el: Element, w: number, h: number): number {
  const view = el.ownerDocument.defaultView;
  if (!view) return 0;
  const raw = view.getComputedStyle(el).borderTopLeftRadius;
  const v = Number.parseFloat(raw);
  if (!Number.isFinite(v)) return 0;
  const r = raw.trim().endsWith('%') ? (v / 100) * Math.min(w, h) : v;
  return Math.max(0, Math.min(r, w / 2, h / 2));
}
