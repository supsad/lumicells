/**
 * WebGL context probe for the stress bench: counts every WebGL context the page creates and
 * every loss, and tells a deliberate release (WEBGL_lose_context.loseContext(), which LumiCells
 * calls on destroy and for its support probe) from an eviction by the browser (Chrome keeps
 * about 16 live contexts per page and silently kills the oldest one when a new one is made).
 *
 * Contexts are held through WeakRefs so the probe itself never keeps a dead context alive.
 */

type GLContext = WebGLRenderingContext | WebGL2RenderingContext;

export interface ContextCounters {
  created: number;
  /** Every webglcontextlost event. */
  lost: number;
  /** Losses after loseContext() was called on that context. */
  released: number;
  /** Losses nobody asked for: evictions (too many contexts), GPU resets. */
  evicted: number;
  restored: number;
}

export interface ContextProbe {
  readonly counters: ContextCounters;
  /** Contexts that exist and are not lost right now. */
  liveNow(): number;
  /**
   * Most contexts alive at once since the probe was installed (or since resetPeak()). Sampled
   * right after every creation and restore, the only moments the count can grow.
   */
  peakLive(): number;
  resetPeak(): void;
  /** The context of a canvas when it was created through getContext. */
  contextOf(canvas: HTMLCanvasElement): GLContext | undefined;
}

type GetContext = (this: HTMLCanvasElement, type: string, attrs?: unknown) => unknown;
type GetExtension = (this: GLContext, name: string) => unknown;

let installed: ContextProbe | null = null;

export function installContextProbe(): ContextProbe {
  if (installed) return installed;
  const counters: ContextCounters = { created: 0, lost: 0, released: 0, evicted: 0, restored: 0 };
  const refs: WeakRef<GLContext>[] = [];
  const seen = new WeakSet<object>();
  const releasing = new WeakSet<object>();
  const byCanvas = new WeakMap<HTMLCanvasElement, GLContext>();
  let peak = 0;
  const liveNow = (): number => {
    let n = 0;
    for (const r of refs) {
      const gl = r.deref();
      if (gl && !gl.isContextLost()) n++;
    }
    return n;
  };
  const samplePeak = (): void => {
    peak = Math.max(peak, liveNow());
  };

  const proto = HTMLCanvasElement.prototype;
  const origGetContext = proto.getContext as unknown as GetContext;
  const patchedGetContext: GetContext = function (type, attrs) {
    const ctx = origGetContext.call(this, type, attrs);
    if (ctx && (type === 'webgl2' || type === 'webgl') && !seen.has(ctx as object)) {
      const gl = ctx as GLContext;
      seen.add(gl);
      refs.push(new WeakRef(gl));
      byCanvas.set(this, gl);
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
      // A browser eviction marks the victim lost synchronously inside getContext, so this
      // sample never counts an evicted context.
      samplePeak();
    }
    return ctx;
  };
  proto.getContext = patchedGetContext as unknown as typeof proto.getContext;

  // Mark contexts released on purpose: wrap loseContext() of every WEBGL_lose_context object.
  const wrapped = new WeakSet<object>();
  for (const glProto of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
    const origGetExtension = glProto.getExtension as unknown as GetExtension;
    const patchedGetExtension: GetExtension = function (name) {
      const ext = origGetExtension.call(this, name) as WEBGL_lose_context | null;
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
    glProto.getExtension = patchedGetExtension as unknown as typeof glProto.getExtension;
  }

  installed = {
    counters,
    liveNow,
    peakLive: () => peak,
    resetPeak() {
      peak = liveNow();
    },
    contextOf(canvas) {
      return byCanvas.get(canvas);
    },
  };
  return installed;
}
