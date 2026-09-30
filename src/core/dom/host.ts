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
 * - DPR changes (window dragged to another monitor, zoom) re-arm a resolution media query.
 * - The poster (static CSS gradient) sits on the host's background until the first frame.
 */

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
  private overflow = 0;
  private ro: ResizeObserver | null = null;
  private mountCtl: AbortController | null = null;
  private savedPosition: string | null = null;
  private savedBg: { v: string; p: string }[] | null = null;
  private posterCss = '';
  private pending = false;
  /** Mounted, but neither the observer nor a measure-phase read has reported a size yet. */
  private needsInitialRead = false;
  private everApplied = false;
  private lastApply = Number.NEGATIVE_INFINITY;
  private readonly size: HostSize = { hostCssW: 0, hostCssH: 0, deviceW: 0, deviceH: 0, dpr: 1 };
  /** Called when a new size is pending (so a paused owner can react). */
  onChange: (() => void) | null = null;
  /** Called when devicePixelRatio changed (zoom, or the window moved to another display). */
  onDprChange: (() => void) | null = null;

  constructor(
    readonly host: HTMLElement,
    private readonly signal: AbortSignal,
  ) {
    const win = host.ownerDocument.defaultView;
    // The canvas is absolutely positioned against the host. An inline non-static position needs
    // no computed-style read (that read forces a style recalc when several instances mount in
    // one task; the size read, which forces layout, is deferred to the measure phase).
    const inline = host.style.position;
    const pos = inline && inline !== 'static' ? inline : win?.getComputedStyle(host).position;
    if (win && (!pos || pos === 'static')) {
      this.savedPosition = host.style.position;
      host.style.position = 'relative';
    }
    this.armDpr();
  }

  get dpr(): number {
    return this.host.ownerDocument.defaultView?.devicePixelRatio || 1;
  }

  /** Coarse pointers (phones, tablets) get a smaller pixel budget. */
  get coarsePointer(): boolean {
    const win = this.host.ownerDocument.defaultView;
    return !!win?.matchMedia?.('(pointer: coarse)').matches;
  }

  /** Creates a fresh canvas with the given overflow margin (CSS px). */
  mount(overflow: number): HTMLCanvasElement {
    this.unmount();
    const doc = this.host.ownerDocument;
    const canvas = doc.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.dataset.pixelLife = '';
    const s = canvas.style;
    s.position = 'absolute';
    s.pointerEvents = 'none';
    s.display = 'block';
    s.zIndex = '0';
    this.canvas = canvas;
    this.applyOverflow(overflow);
    this.host.insertBefore(canvas, this.host.firstChild);
    this.mountCtl = new AbortController();
    this.observe(canvas);
    return canvas;
  }

  unmount(): void {
    this.needsInitialRead = false;
    this.mountCtl?.abort();
    this.mountCtl = null;
    this.ro?.disconnect();
    this.ro = null;
    this.canvas?.remove();
    this.canvas = null;
  }

  /** Changes the margin without rebuilding (both old and new values > 0). */
  setOverflow(overflow: number): void {
    if (overflow === this.overflow) return;
    this.applyOverflow(overflow);
    this.markPending();
  }

  /**
   * Returns the pending size once the throttle allows it (the first size immediately), else null.
   * During continuous resizes the drawing buffer is reallocated at most every `throttleMs`; the
   * canvas is stretched by CSS in between.
   */
  takeSize(now: number, throttleMs = 100): HostSize | null {
    if (!this.pending || !this.canvas) return null;
    if (this.needsInitialRead) {
      // Measure phase: every instance reads here, after all of them wrote their mounts.
      const c = this.canvas;
      this.record(c.clientWidth, c.clientHeight, 0, 0);
    }
    if (this.everApplied && now - this.lastApply < throttleMs) return null;
    this.pending = false;
    this.everApplied = true;
    this.lastApply = now;
    return this.size;
  }

  /** Host padding-box origin in client px into `out` [x, y] (forces layout if dirty). */
  readClientOrigin(out: number[]): void {
    const r = this.host.getBoundingClientRect();
    out[0] = r.left + this.host.clientLeft;
    out[1] = r.top + this.host.clientTop;
  }

  showPoster(css: string): void {
    const st = this.host.style;
    if (!this.savedBg) {
      this.savedBg = BG_PROPS.map((p) => ({
        v: st.getPropertyValue(p),
        p: st.getPropertyPriority(p),
      }));
    }
    if (css === this.posterCss) return;
    this.posterCss = css;
    st.background = css;
  }

  hidePoster(): void {
    const saved = this.savedBg;
    if (!saved) return;
    this.savedBg = null;
    this.posterCss = '';
    const st = this.host.style;
    BG_PROPS.forEach((p, i) => {
      const s = saved[i];
      if (s?.v) st.setProperty(p, s.v, s.p);
      else st.removeProperty(p);
    });
  }

  get posterVisible(): boolean {
    return this.savedBg !== null;
  }

  /** Undo every host style change (destroy). */
  restore(): void {
    this.unmount();
    this.hidePoster();
    if (this.savedPosition !== null) {
      this.host.style.position = this.savedPosition;
      this.savedPosition = null;
    }
  }

  // -------------------------------------------------------------------------------------------

  private applyOverflow(overflow: number): void {
    this.overflow = Math.max(0, overflow);
    const c = this.canvas;
    if (!c) return;
    const o = this.overflow;
    const s = c.style;
    s.left = `${-o}px`;
    s.top = `${-o}px`;
    s.width = o > 0 ? `calc(100% + ${2 * o}px)` : '100%';
    s.height = o > 0 ? `calc(100% + ${2 * o}px)` : '100%';
  }

  private markPending(): void {
    this.pending = true;
    this.onChange?.();
  }

  private record(cssW: number, cssH: number, devW: number, devH: number): void {
    this.needsInitialRead = false;
    const o = this.overflow;
    const s = this.size;
    s.hostCssW = Math.max(1, cssW - 2 * o);
    s.hostCssH = Math.max(1, cssH - 2 * o);
    s.deviceW = devW;
    s.deviceH = devH;
    s.dpr = this.dpr;
    this.markPending();
  }

  private observe(canvas: HTMLCanvasElement): void {
    const win = this.host.ownerDocument.defaultView;
    const signal = this.mountCtl?.signal;
    if (win && typeof win.ResizeObserver === 'function') {
      const ro = new win.ResizeObserver((entries) => {
        const e = entries[entries.length - 1];
        if (!e) return;
        const dp = e.devicePixelContentBoxSize?.[0];
        this.record(
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
      this.ro = ro;
    } else if (win) {
      // No ResizeObserver: poll on window resizes.
      const read = () => this.record(canvas.clientWidth, canvas.clientHeight, 0, 0);
      win.addEventListener('resize', read, { signal });
    }
    // The observer reports after this frame's rAF callbacks: the first size is read in the next
    // measure phase instead (deferred, not synchronously here, see takeSize()).
    this.needsInitialRead = true;
    this.markPending();
  }

  private armDpr(): void {
    const win = this.host.ownerDocument.defaultView;
    if (!win?.matchMedia) return;
    const mql = win.matchMedia(`(resolution: ${win.devicePixelRatio || 1}dppx)`);
    const onChange = () => {
      mql.removeEventListener('change', onChange);
      if (this.signal.aborted) return;
      this.size.dpr = this.dpr;
      this.markPending();
      this.onDprChange?.();
      this.armDpr();
    };
    mql.addEventListener('change', onChange, { signal: this.signal });
  }
}
