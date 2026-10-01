/**
 * WebGL context and canvas probe, installed with page.addInitScript() before any page script
 * (see test.ts), so it also sees the library's support probe and every page of the suite (the
 * stress bench has a probe of its own on top, examples/stress/probe.ts; both count).
 *
 * The function is serialized into the page: it must stay self-contained (no imports, no
 * closures over this module). Contexts and canvases are held through WeakRefs, so the probe never
 * keeps a dead one alive; after a garbage collection (CDP HeapProfiler.collectGarbage) the
 * canvases still alive are the ones somebody holds.
 */

export interface GlProbeCounters {
  /** WebGL contexts created (each context once, however often getContext returns it). */
  created: number;
  /** webglcontextlost events. */
  lost: number;
  /** Losses after WEBGL_lose_context.loseContext() on that context (deliberate releases). */
  released: number;
  /** Losses nobody asked for: browser evictions, GPU resets. */
  evicted: number;
  restored: number;
  /** Most contexts alive at once, sampled after every creation and restore. */
  peakLive: number;
  /**
   * Most own contexts alive at once (see GlProbe.liveOwnNow), sampled like peakLive: the
   * library's context budget applies to these, not to the shared renderer's device.
   */
  peakLiveOwn: number;
}

export interface GlProbe {
  readonly counters: GlProbeCounters;
  /** Contexts that exist and are not lost now. */
  liveNow(): number;
  /**
   * Live contexts of LumiCells instances with a context of their own: their canvas carries the
   * library's `data-lumicells` attribute (the shared renderer's device canvas and the support
   * probe's canvas do not).
   */
  liveOwnNow(): number;
  /** Restarts both peaks at the current counts. */
  resetPeak(): void;
  /** Canvases that got a context (any kind) and are still alive (call after a GC). */
  canvasesAlive(): { total: number; webgl: number; inDocument: number };
}

declare global {
  interface Window {
    __glProbe: GlProbe;
  }
}

export function installGlProbe(): void {
  type GL = WebGLRenderingContext | WebGL2RenderingContext;
  type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
  if (window.__glProbe) return;
  const counters: GlProbeCounters = {
    created: 0,
    lost: 0,
    released: 0,
    evicted: 0,
    restored: 0,
    peakLive: 0,
    peakLiveOwn: 0,
  };
  let contexts: WeakRef<GL>[] = [];
  let canvases: { ref: WeakRef<AnyCanvas>; webgl: boolean }[] = [];
  const seenCanvas = new WeakSet<object>();
  const seenGl = new WeakSet<object>();
  const releasing = new WeakSet<object>();

  const liveNow = (): number => {
    let n = 0;
    contexts = contexts.filter((r) => {
      const gl = r.deref();
      if (gl && !gl.isContextLost()) n++;
      return gl !== undefined;
    });
    return n;
  };
  const isOwn = (gl: GL): boolean => {
    const c = gl.canvas;
    return c instanceof HTMLCanvasElement && c.hasAttribute('data-lumicells');
  };
  const liveOwnNow = (): number => {
    let n = 0;
    for (const r of contexts) {
      const gl = r.deref();
      if (gl && !gl.isContextLost() && isOwn(gl)) n++;
    }
    return n;
  };
  const samplePeak = (): void => {
    counters.peakLive = Math.max(counters.peakLive, liveNow());
    counters.peakLiveOwn = Math.max(counters.peakLiveOwn, liveOwnNow());
  };

  type GetContext = (this: AnyCanvas, type: string, ...rest: unknown[]) => unknown;
  const wrap = (proto: { getContext: unknown }): void => {
    const orig = proto.getContext as GetContext;
    const patched: GetContext = function (type, ...rest) {
      const ctx = orig.call(this, type, ...rest);
      if (!ctx) return ctx;
      const webgl = type === 'webgl2' || type === 'webgl';
      if (!seenCanvas.has(this)) {
        seenCanvas.add(this);
        canvases.push({ ref: new WeakRef(this), webgl });
      }
      if (webgl && !seenGl.has(ctx as object)) {
        const gl = ctx as GL;
        seenGl.add(gl);
        contexts.push(new WeakRef(gl));
        counters.created++;
        this.addEventListener('webglcontextlost', () => {
          counters.lost++;
          if (releasing.has(gl)) counters.released++;
          else counters.evicted++;
        });
        this.addEventListener('webglcontextrestored', () => {
          counters.restored++;
          releasing.delete(gl);
          samplePeak();
        });
        // An eviction marks its victim lost synchronously inside getContext: never counted here.
        samplePeak();
      }
      return ctx;
    };
    proto.getContext = patched;
  };
  wrap(HTMLCanvasElement.prototype);
  if (typeof OffscreenCanvas !== 'undefined') wrap(OffscreenCanvas.prototype);

  // Deliberate releases: wrap loseContext() of every WEBGL_lose_context object handed out.
  type GetExtension = (this: GL, name: string) => unknown;
  const wrapped = new WeakSet<object>();
  for (const glProto of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
    const orig = glProto.getExtension as unknown as GetExtension;
    const patched: GetExtension = function (name) {
      const ext = orig.call(this, name) as WEBGL_lose_context | null;
      if (ext && name === 'WEBGL_lose_context' && !wrapped.has(ext)) {
        wrapped.add(ext);
        const lose = ext.loseContext.bind(ext);
        ext.loseContext = () => {
          releasing.add(this);
          lose();
        };
      }
      return ext;
    };
    glProto.getExtension = patched as unknown as typeof glProto.getExtension;
  }

  window.__glProbe = {
    counters,
    liveNow,
    liveOwnNow,
    resetPeak() {
      counters.peakLive = liveNow();
      counters.peakLiveOwn = liveOwnNow();
    },
    canvasesAlive() {
      let total = 0;
      let webgl = 0;
      let inDocument = 0;
      canvases = canvases.filter((c) => {
        const canvas = c.ref.deref();
        if (!canvas) return false;
        total++;
        if (c.webgl) webgl++;
        if (canvas instanceof HTMLCanvasElement && canvas.isConnected) inDocument++;
        return true;
      });
      return { total, webgl, inDocument };
    },
  };
}
