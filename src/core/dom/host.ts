/**
 * Host view: the canvas element and everything the browser tells us about its size.
 *
 * - A NEW canvas per mount (a canvas whose context was lost via WEBGL_lose_context cannot get a
 *   fresh one), inserted as the host's first child, extended by the overflow margin.
 * - Size from a ResizeObserver on the canvas: devicePixelContentBoxSize where supported (exact
 *   physical pixels), contentRect * devicePixelRatio otherwise (Safari). Sizes are only recorded
 *   here and applied by the owner in the next measure phase (throttled during live resizes).
 * - The first size is not read at mount: takeSize() reads it in the ticker's measure phase unless
 *   the observer reported first, so mounting N instances in one task costs one layout, not N
 *   (a synchronous clientWidth read after each insert would force a layout per instance).
 * - DPR changes (window dragged to another monitor, zoom) re-arm a resolution media query, armed
 *   with the first canvas (before that there is nothing to resize).
 * - The poster (static CSS gradient) sits on the host's background until the first frame.
 * - The canvas is hidden (visibility, so its size is still observed) until the owner has drawn a
 *   frame on it, and again while its context is lost: a canvas without a drawn frame shows
 *   nothing useful, and a lost context's canvas paints a blank box over the poster.
 * - While the owner switches renderers it may keep the last frame on screen: the old canvas (a
 *   2D canvas keeps its pixels) or a 2D copy of it (a WebGL canvas, copied in the task that drew
 *   it) stays as a stand-in above the poster until dropStandIn().
 * - The canvas is absolutely positioned against the host, so a static host is made `relative`.
 *   The computed style is read for every host created in one task together, in a microtask
 *   (reads first, then writes): reading it in each constructor would recalculate styles once per
 *   instance when a list mounts.
 */

/** `(pointer: coarse)` per window: read once, not once per instance. */
const coarseByWindow = new WeakMap<Window, boolean>();

/** Views created in this task whose host position is still to be checked (see the header). */
let positionQueue: HostView[] = [];

function flushPositions(): void {
  const list = positionQueue;
  positionQueue = [];
  const statics: boolean[] = [];
  // All reads first: one style recalculation for the whole batch.
  for (const v of list) statics.push(v.readsStatic());
  for (let i = 0; i < list.length; i++) if (statics[i]) (list[i] as HostView).makeRelative();
}

const BG_PROPS = [
  'background-image',
  'background-position',
  'background-size',
  'background-repeat',
  'background-attachment',
  'background-origin',
  'background-clip',
  'background-color',
] as const;

/** Saved background of a host that had no inline background (shared, read-only). */
const NO_BG: readonly { v: string; p: string }[] = BG_PROPS.map(() => ({ v: '', p: '' }));

export interface HostSize {
  /** Host padding box, CSS px. */
  hostCssW: number;
  hostCssH: number;
  /** Canvas device px when known exactly, else 0. */
  deviceW: number;
  deviceH: number;
  dpr: number;
}

export class HostView {
  canvas: HTMLCanvasElement | null = null;
  #overflow = 0;
  #ro: ResizeObserver | null = null;
  #mountCtl: AbortController | null = null;
  #savedPosition: string | null = null;
  #savedBg: readonly { v: string; p: string }[] | null = null;
  #posterCss = '';
  #pending = false;
  /** Mounted, but neither the observer nor a measure-phase read has reported a size yet. */
  #needsInitialRead = false;
  #everApplied = false;
  #lastApply = Number.NEGATIVE_INFINITY;
  #dprArmed = false;
  /** The last frame kept on screen during a renderer switch (see the header). */
  #standIn: HTMLCanvasElement | null = null;
  /** The position check is queued (see flushPositions). */
  #positionPending = false;
  readonly #size: HostSize = { hostCssW: 0, hostCssH: 0, deviceW: 0, deviceH: 0, dpr: 1 };
  /** Called when a new size is pending (so a paused owner can react). */
  onChange: (() => void) | null = null;
  /** Called when devicePixelRatio changed (zoom, or the window moved to another display). */
  onDprChange: (() => void) | null = null;

  readonly #signal: AbortSignal;

  constructor(
    readonly host: HTMLElement,
    signal: AbortSignal,
  ) {
    this.#signal = signal;
    // The canvas is absolutely positioned against the host. An inline non-static position needs
    // no computed-style read; otherwise it is read in a batch (see the header). The size read,
    // which forces layout, is deferred to the measure phase.
    const inline = host.style.position;
    if (host.ownerDocument.defaultView && !(inline && inline !== 'static')) {
      this.#positionPending = true;
      if (positionQueue.length === 0) queueMicrotask(flushPositions);
      positionQueue.push(this);
    }
  }

  /** The host is statically positioned (reads the computed style; see flushPositions). */
  readsStatic(): boolean {
    if (!this.#positionPending || this.#signal.aborted) return false;
    const win = this.host.ownerDocument.defaultView;
    const pos = win?.getComputedStyle(this.host).position;
    return !pos || pos === 'static';
  }

  makeRelative(): void {
    if (!this.#positionPending || this.#signal.aborted) return;
    this.#positionPending = false;
    this.#savedPosition = this.host.style.position;
    this.host.style.position = 'relative';
  }

  /** A canvas is about to be inserted: the host must be positioned now, not in the batch. */
  #ensurePositioned(): void {
    if (!this.#positionPending) return;
    if (this.readsStatic()) this.makeRelative();
    this.#positionPending = false;
  }

  get dpr(): number {
    return this.host.ownerDocument.defaultView?.devicePixelRatio || 1;
  }

  /** Coarse pointers (phones, tablets) get a smaller pixel budget. */
  get coarsePointer(): boolean {
    const win = this.host.ownerDocument.defaultView;
    if (!win) return false;
    let coarse = coarseByWindow.get(win);
    if (coarse === undefined) {
      coarse = !!win.matchMedia?.('(pointer: coarse)').matches;
      coarseByWindow.set(win, coarse);
    }
    return coarse;
  }

  /** Creates a fresh canvas with the given overflow margin (CSS px). */
  mount(overflow: number): HTMLCanvasElement {
    this.unmount();
    this.#ensurePositioned();
    const doc = this.host.ownerDocument;
    const canvas = doc.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.dataset.lumicells = '';
    const s = canvas.style;
    s.position = 'absolute';
    s.pointerEvents = 'none';
    s.display = 'block';
    s.zIndex = '0';
    s.visibility = 'hidden';
    this.canvas = canvas;
    this.#applyOverflow(overflow);
    this.host.insertBefore(canvas, this.host.firstChild);
    this.#mountCtl = new AbortController();
    this.#observe(canvas);
    if (!this.#dprArmed) {
      this.#dprArmed = true;
      this.#armDpr();
    }
    return canvas;
  }

  unmount(): void {
    this.#needsInitialRead = false;
    this.#mountCtl?.abort();
    this.#mountCtl = null;
    this.#ro?.disconnect();
    this.#ro = null;
    this.canvas?.remove();
    this.canvas = null;
  }

  /**
   * Keeps the current canvas on screen as it is (a 2D canvas keeps its pixels) as the stand-in
   * until dropStandIn(), and forgets it: the next mount() creates a new canvas.
   */
  holdCanvas(): void {
    const c = this.canvas;
    if (!c) return;
    this.dropStandIn();
    this.#needsInitialRead = false;
    this.#mountCtl?.abort();
    this.#mountCtl = null;
    this.#ro?.disconnect();
    this.#ro = null;
    this.canvas = null;
    this.#standIn = c;
  }

  /**
   * Keeps a 2D copy of the current canvas on screen as the stand-in until dropStandIn(). For a
   * WebGL canvas, call it in the task that drew the frame (later its drawing buffer may be
   * cleared). The canvas itself stays until unmount().
   */
  holdCopy(): void {
    const c = this.canvas;
    if (!c || c.width === 0 || c.height === 0) return;
    this.dropStandIn();
    const copy = this.host.ownerDocument.createElement('canvas');
    copy.width = c.width;
    copy.height = c.height;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = copy.getContext('2d');
      ctx?.drawImage(c, 0, 0);
    } catch {
      ctx = null;
    }
    if (!ctx) return;
    copy.setAttribute('aria-hidden', 'true');
    copy.dataset.lumicells = '';
    copy.style.cssText = c.style.cssText;
    this.host.insertBefore(copy, c);
    this.#standIn = copy;
  }

  /** Removes the stand-in (the new canvas shows its first frame, or the poster takes over). */
  dropStandIn(): void {
    const s = this.#standIn;
    if (!s) return;
    this.#standIn = null;
    s.remove();
    // Browsers cap the canvas memory of a page: free it now rather than at GC.
    s.width = 0;
    s.height = 0;
  }

  /** Shows the canvas once a frame is drawn on it; hides it while its context is lost. */
  setCanvasVisible(visible: boolean): void {
    const c = this.canvas;
    if (c) c.style.visibility = visible ? '' : 'hidden';
  }

  /** Changes the margin without rebuilding (both old and new values > 0). */
  setOverflow(overflow: number): void {
    if (overflow === this.#overflow) return;
    this.#applyOverflow(overflow);
    this.#markPending();
  }

  /**
   * Returns the pending size once the throttle allows it (the first size immediately), else null.
   * During continuous resizes the drawing buffer is reallocated at most every `throttleMs`; the
   * canvas is stretched by CSS in between.
   */
  takeSize(now: number, throttleMs = 100): HostSize | null {
    if (!this.#pending || !this.canvas) return null;
    if (this.#needsInitialRead) {
      // Measure phase: every instance reads here, after all of them wrote their mounts.
      const c = this.canvas;
      this.#record(c.clientWidth, c.clientHeight, 0, 0);
    }
    if (this.#everApplied && now - this.#lastApply < throttleMs) return null;
    this.#pending = false;
    this.#everApplied = true;
    this.#lastApply = now;
    return this.#size;
  }

  /** Host padding-box origin in client px into `out` [x, y] (forces layout if dirty). */
  readClientOrigin(out: number[]): void {
    const r = this.host.getBoundingClientRect();
    out[0] = r.left + this.host.clientLeft;
    out[1] = r.top + this.host.clientTop;
  }

  showPoster(css: string): void {
    const st = this.host.style;
    if (!this.#savedBg) {
      // Nothing to read on a host without inline styles (the common case, and cheaper when a
      // list of backgrounds mounts).
      this.#savedBg =
        st.length === 0
          ? NO_BG
          : BG_PROPS.map((p) => ({
              v: st.getPropertyValue(p),
              p: st.getPropertyPriority(p),
            }));
    }
    if (css === this.#posterCss) return;
    this.#posterCss = css;
    st.background = css;
  }

  hidePoster(): void {
    const saved = this.#savedBg;
    if (!saved) return;
    this.#savedBg = null;
    this.#posterCss = '';
    const st = this.host.style;
    BG_PROPS.forEach((p, i) => {
      const s = saved[i];
      if (s?.v) st.setProperty(p, s.v, s.p);
      else st.removeProperty(p);
    });
  }

  get posterVisible(): boolean {
    return this.#savedBg !== null;
  }

  /** Undo every host style change (destroy). */
  restore(): void {
    this.unmount();
    this.dropStandIn();
    this.#positionPending = false;
    this.hidePoster();
    if (this.#savedPosition !== null) {
      this.host.style.position = this.#savedPosition;
      this.#savedPosition = null;
    }
  }

  // -------------------------------------------------------------------------------------------

  #applyOverflow(overflow: number): void {
    this.#overflow = Math.max(0, overflow);
    const c = this.canvas;
    if (!c) return;
    const o = this.#overflow;
    const s = c.style;
    s.left = `${-o}px`;
    s.top = `${-o}px`;
    s.width = o > 0 ? `calc(100% + ${2 * o}px)` : '100%';
    s.height = o > 0 ? `calc(100% + ${2 * o}px)` : '100%';
  }

  #markPending(): void {
    this.#pending = true;
    this.onChange?.();
  }

  #record(cssW: number, cssH: number, devW: number, devH: number): void {
    this.#needsInitialRead = false;
    const o = this.#overflow;
    const s = this.#size;
    s.hostCssW = Math.max(1, cssW - 2 * o);
    s.hostCssH = Math.max(1, cssH - 2 * o);
    s.deviceW = devW;
    s.deviceH = devH;
    s.dpr = this.dpr;
    this.#markPending();
  }

  #observe(canvas: HTMLCanvasElement): void {
    const win = this.host.ownerDocument.defaultView;
    const signal = this.#mountCtl?.signal;
    if (win && typeof win.ResizeObserver === 'function') {
      const ro = new win.ResizeObserver((entries) => {
        const e = entries[entries.length - 1];
        if (!e) return;
        const dp = e.devicePixelContentBoxSize?.[0];
        this.#record(
          e.contentRect.width,
          e.contentRect.height,
          dp?.inlineSize ?? 0,
          dp?.blockSize ?? 0,
        );
      });
      try {
        ro.observe(canvas, { box: 'device-pixel-content-box' });
      } catch {
        ro.observe(canvas);
      }
      this.#ro = ro;
    } else if (win) {
      // No ResizeObserver: poll on window resizes.
      const read = () => this.#record(canvas.clientWidth, canvas.clientHeight, 0, 0);
      win.addEventListener('resize', read, { signal });
    }
    // The observer reports after this frame's rAF callbacks: the first size is read in the next
    // measure phase instead (deferred, not synchronously here, see takeSize()).
    this.#needsInitialRead = true;
    this.#markPending();
  }

  #armDpr(): void {
    const win = this.host.ownerDocument.defaultView;
    if (!win?.matchMedia) return;
    const mql = win.matchMedia(`(resolution: ${win.devicePixelRatio || 1}dppx)`);
    const onChange = () => {
      mql.removeEventListener('change', onChange);
      if (this.#signal.aborted) return;
      this.#size.dpr = this.dpr;
      this.#markPending();
      this.onDprChange?.();
      this.#armDpr();
    };
    mql.addEventListener('change', onChange, { signal: this.#signal });
  }
}
