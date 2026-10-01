/**
 * Simulated slow GPU and main-thread jank for the stress bench (adaptive quality checks).
 *
 * `slowGpu=K`: GPU work in proportion to the pixels the LumiCells contexts draw, K ms per
 * megapixel per frame, so that the load responds to quality steps like a fill-bound GPU would:
 * - the hog: a WebGL2 context of its own draws a busy loop on an offscreen canvas every frame,
 *   steered by its own GPU timer to take that long; the page's frames become GPU-bound exactly
 *   as with a slow GPU from the first frame (a 165 Hz display then delivers every 2nd or 3rd
 *   vsync, which the cadence alone reads as a slower display);
 * - the instances' GPU timers (EXT_disjoint_timer_query_webgl2) report `timerShare` of that on
 *   top of their own time (getQueryParameter is wrapped): the GPU-timer path sees it as theirs,
 *   the rest stands for GPU work a timer does not cover (compositing, the browser).
 * The hog first calibrates its loop for the expected pixels (CALIBRATE_MS after install, so
 * use mountDelay to keep the instances from starting meanwhile), then pauses until arm() (the
 * bench arms it once the first instance has a GPU side): the frames before stay free of GPU work,
 * as they would be on a slow GPU, and from then on (shader compiles included) the cadence is
 * GPU-bound.
 * `jank=MS`: a busy wait of MS on the main thread every frame, in a rAF callback of the page's
 * own (outside the library's frame): frames miss vsyncs while the GPU idles.
 * `noTimer=1`: the instances get no GPU timer (as on Safari, Firefox and most phones): adaptive
 * quality then works from missed frames alone.
 *
 * Bench only: it patches WebGL2RenderingContext.prototype.
 */

const QUERY_RESULT = 0x8866;

interface HogState {
  /** Simulated GPU ms per megapixel. */
  msPerMpx: number;
  /** Share of it the instances' GPU timers report. */
  timerShare: number;
  /** Megapixels the LumiCells contexts draw now. */
  mpx: () => number;
  /** Last GPU time the hog measured for itself, ms. */
  hogMs: number;
  /** Target the hog steered to, ms. */
  targetMs: number;
}

export interface SlowGpu {
  readonly state: HogState | null;
  /** Starts the load (after the calibration). */
  arm(): void;
}

/** How long the hog calibrates its loop count before it pauses for arm(), ms. */
const CALIBRATE_MS = 1500;

const VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
const FS = `#version 300 es
precision highp float;
uniform int u_n;
out vec4 o;
void main() {
  float a = gl_FragCoord.x * 0.001 + gl_FragCoord.y;
  for (int i = 0; i < u_n; i++) a = fract(sin(a + float(i)) * 43758.5453);
  o = vec4(a);
}`;

/** Contexts created from now on get no EXT_disjoint_timer_query_webgl2. */
function hideTimer(): void {
  const proto = WebGL2RenderingContext.prototype as unknown as {
    getExtension(this: WebGL2RenderingContext, name: string): unknown;
  };
  const get = proto.getExtension;
  proto.getExtension = function (this: WebGL2RenderingContext, name: string) {
    if (name === 'EXT_disjoint_timer_query_webgl2') return null;
    return get.call(this, name);
  };
}

function compile(gl: WebGL2RenderingContext): WebGLProgram | null {
  const p = gl.createProgram();
  for (const [type, src] of [
    [gl.VERTEX_SHADER, VS],
    [gl.FRAGMENT_SHADER, FS],
  ] as const) {
    const s = gl.createShader(type);
    if (!s || !p) return null;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    gl.attachShader(p, s);
  }
  if (!p) return null;
  gl.linkProgram(p);
  return gl.getProgramParameter(p, gl.LINK_STATUS) ? p : null;
}

/** Installs the simulation (no-op for K <= 0, jank <= 0 and noTimer false). */
export function installSlowGpu(opts: {
  msPerMpx: number;
  jankMs: number;
  /** Megapixels the instances draw now (0 before they report). */
  mpx: () => number;
  /** Megapixels expected before the instances report. */
  expectedMpx: number;
  noTimer?: boolean;
  timerShare?: number;
}): SlowGpu {
  const { msPerMpx, jankMs, noTimer = false } = opts;
  if (jankMs > 0) {
    const spin = () => {
      requestAnimationFrame(spin);
      const end = performance.now() + jankMs;
      while (performance.now() < end) {
        // busy
      }
    };
    requestAnimationFrame(spin);
  }
  if (!(msPerMpx > 0)) {
    if (noTimer) hideTimer();
    return { state: null, arm() {} };
  }
  const mpx = () => opts.mpx() || opts.expectedMpx;
  const state: HogState = {
    msPerMpx,
    timerShare: opts.timerShare ?? 1,
    mpx,
    hogMs: 0,
    targetMs: 0,
  };
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const gl = canvas.getContext('webgl2', { antialias: false, depth: false });
  const ext = gl?.getExtension('EXT_disjoint_timer_query_webgl2') as {
    TIME_ELAPSED_EXT: number;
  } | null;
  const prog = gl ? compile(gl) : null;
  if (!gl || !prog || !ext) {
    console.warn('[stress] slowGpu needs WebGL2 and EXT_disjoint_timer_query_webgl2');
    return { state: null, arm() {} };
  }
  if (noTimer) hideTimer();
  const uN = gl.getUniformLocation(prog, 'u_n');
  /** Queries in flight and the loop count each one timed. */
  const queries: { q: WebGLQuery; n: number }[] = [];
  let n = 1000;
  const start = performance.now();
  let armed = false;
  /**
   * GPU ms per loop iteration (the time is linear in the count): estimated during the
   * calibration, while nothing else runs on the GPU, then fixed (later the hog's own timer also
   * counts the waits for other work, so it no longer measures the loop alone).
   */
  let msPerN = 0;
  let calibrated = false;
  // The instances' timers report the simulated time on top of theirs (not the hog's own timer).
  const orig = WebGL2RenderingContext.prototype.getQueryParameter;
  WebGL2RenderingContext.prototype.getQueryParameter = function (
    this: WebGL2RenderingContext,
    q: WebGLQuery,
    pname: number,
  ) {
    const v = orig.call(this, q, pname);
    if (pname !== QUERY_RESULT || this === gl || typeof v !== 'number') return v;
    const c = this.canvas as HTMLCanvasElement;
    return v + state.timerShare * state.msPerMpx * ((c.width * c.height) / 1e6) * 1e6;
  };
  const frame = () => {
    requestAnimationFrame(frame);
    while (queries.length > 0) {
      const head = queries[0] as { q: WebGLQuery; n: number };
      if (!orig.call(gl, head.q, gl.QUERY_RESULT_AVAILABLE)) break;
      queries.shift();
      const ms = Number(orig.call(gl, head.q, gl.QUERY_RESULT)) / 1e6;
      gl.deleteQuery(head.q);
      if (!(ms > 0)) continue;
      state.hogMs += (ms - state.hogMs) * 0.3;
      if (!calibrated) {
        const per = ms / head.n;
        msPerN = msPerN === 0 ? per : msPerN + (per - msPerN) * 0.3;
      }
    }
    const calibrating = performance.now() - start < CALIBRATE_MS;
    if (!calibrating) calibrated = msPerN > 0;
    state.targetMs = state.msPerMpx * (calibrating ? opts.expectedMpx : state.mpx());
    if (msPerN > 0) n = Math.max(1, Math.min(2000000, Math.round(state.targetMs / msPerN)));
    if (state.targetMs <= 0.05 || (!calibrating && !armed)) return;
    const q = gl.createQuery();
    if (!q) return;
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's useProgram, not a React hook.
    gl.useProgram(prog);
    gl.uniform1i(uN, n);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    gl.flush();
    queries.push({ q, n });
  };
  requestAnimationFrame(frame);
  return {
    state,
    arm() {
      armed = true;
    },
  };
}
