/**
 * The shared-context technique, minimal: ONE WebGL2 canvas (not in the document) renders a
 * simple animated pixel grid once per frame, and every card gets a plain 2D canvas that copies
 * it with a cover-cropped drawImage(). N cards cost one context, one shader run and N texture
 * blits; every card shows the same animation (no per-card state or interaction).
 *
 * The copy happens in the same task as the draw: with preserveDrawingBuffer: false the WebGL
 * drawing buffer is only guaranteed until the frame is presented.
 */

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

// A rounded-cell grid lit by a drifting value-noise field and a slow radial wave, colored along
// a crimson -> violet -> blue ramp. Deliberately cheap: one pass, no textures.
const FRAG = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform float u_time;
uniform vec2 u_size;
out vec4 o_color;

float hash(vec2 p) {
  p = fract(p * vec2(0.1031, 0.1030));
  p += dot(p, p.yx + 33.33);
  return fract((p.x + p.y) * p.x);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}

void main() {
  float pitch = 14.0;
  vec2 px = v_uv * u_size;
  vec2 cell = floor(px / pitch);
  vec2 local = fract(px / pitch) - 0.5;
  vec2 q = abs(local) - 0.33;
  float body = 1.0 - smoothstep(-0.02, 0.04, length(max(q, 0.0)) - 0.08);

  vec2 c = (cell + 0.5) * pitch / u_size - 0.5;
  float field = vnoise(cell * 0.18 + vec2(u_time * 0.21, -u_time * 0.13));
  float wave = 0.5 + 0.5 * sin(length(c) * 14.0 - u_time * 1.6);
  float twinkle = 0.8 + 0.2 * sin(u_time * 2.1 + hash(cell) * 6.2831);
  float lit = smoothstep(0.35, 0.8, field * 0.75 + wave * 0.35) * twinkle;

  float k = clamp(v_uv.x * 0.7 + (1.0 - v_uv.y) * 0.3, 0.0, 1.0);
  vec3 ramp = mix(vec3(0.95, 0.07, 0.22), vec3(0.77, 0.24, 0.7), smoothstep(0.0, 0.5, k));
  ramp = mix(ramp, vec3(0.02, 0.46, 1.0), smoothstep(0.45, 1.0, k));
  vec3 color = mix(vec3(0.03, 0.04, 0.2), ramp, 0.12 + 0.88 * lit);
  o_color = vec4(mix(vec3(0.0, 0.0, 0.2), color, body), 1.0);
}`;

interface TimerQueryExt {
  readonly TIME_ELAPSED_EXT: GLenum;
  readonly GPU_DISJOINT_EXT: GLenum;
}

export interface SharedCard {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  /** Cards outside the viewport are skipped when the renderer pauses offscreen ones. */
  visible: boolean;
}

export class SharedRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  private readonly timeLoc: WebGLUniformLocation | null;
  private readonly timer: TimerQueryExt | null;
  private readonly queries: (WebGLQuery | null)[] = [null, null, null, null];
  private qHead = 0;
  /** Newest GPU time of the shared draw (not of the copies), ms. */
  gpuMs: number | null = null;

  constructor(width: number, height: number) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 is not available');
    this.canvas = canvas;
    this.gl = gl;
    const program = link(gl, VERT, FRAG);
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's useProgram, not a React hook.
    gl.useProgram(program);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(gl.getUniformLocation(program, 'u_size'), width, height);
    gl.viewport(0, 0, width, height);
    this.timeLoc = gl.getUniformLocation(program, 'u_time');
    this.timer = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExt | null;
  }

  /** Draws one frame and copies it into every visible card. */
  frame(seconds: number, cards: readonly SharedCard[], pauseOffscreen: boolean): void {
    const gl = this.gl;
    const t = this.timer;
    let q: WebGLQuery | null = null;
    if (t) {
      this.readQuery();
      q = this.queries[this.qHead] ?? null;
      if (!q) {
        q = gl.createQuery();
        this.queries[this.qHead] = q;
      }
      if (q) gl.beginQuery(t.TIME_ELAPSED_EXT, q);
    }
    gl.uniform1f(this.timeLoc, seconds);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (t && q) {
      gl.endQuery(t.TIME_ELAPSED_EXT);
      this.qHead = (this.qHead + 1) % this.queries.length;
    }
    const src = this.canvas;
    for (const card of cards) {
      if (pauseOffscreen && !card.visible) continue;
      drawCover(card.ctx, src, card.canvas.width, card.canvas.height);
    }
  }

  /** Reads the oldest query of the ring (results arrive a few frames late). */
  private readQuery(): void {
    const gl = this.gl;
    const t = this.timer;
    const q = this.queries[this.qHead];
    if (!t || !q) return;
    if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) return;
    const disjoint = gl.getParameter(t.GPU_DISJOINT_EXT) as boolean;
    const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
    if (!disjoint) this.gpuMs = ns / 1e6;
  }

  dispose(): void {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

/** Cover crop: the largest centered source rect with the destination's aspect ratio. */
export function drawCover(
  ctx: CanvasRenderingContext2D,
  src: HTMLCanvasElement,
  dw: number,
  dh: number,
): void {
  const sw = src.width;
  const sh = src.height;
  const scale = Math.max(dw / sw, dh / sh);
  const cw = dw / scale;
  const ch = dh / scale;
  ctx.drawImage(src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, dw, dh);
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const program = gl.createProgram();
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ] as const) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('createShader failed');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) ?? 'compile failed');
    }
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? 'link failed');
  }
  return program;
}
