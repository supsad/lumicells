/**
 * Minimal WebGL2 program helpers: compile with readable errors, cache uniform locations,
 * and (optionally) link without blocking via KHR_parallel_shader_compile.
 */

export class ShaderError extends Error {
  constructor(
    message: string,
    readonly log: string,
    readonly source?: string,
  ) {
    super(message);
    this.name = 'ShaderError';
  }
}

function numbered(source: string): string {
  return source
    .split('\n')
    .map((line, i) => `${String(i + 1).padStart(4, ' ')}| ${line}`)
    .join('\n');
}

/** Pulls the offending lines out of a driver log ("ERROR: 0:123: ...") for a compact message. */
function excerpt(source: string, log: string): string {
  const lines = source.split('\n');
  const out: string[] = [];
  const re = /\d+:(\d+):/g;
  const seen = new Set<number>();
  for (let m = re.exec(log); m && out.length < 6; m = re.exec(log)) {
    const n = Number(m[1]);
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(`${String(n).padStart(4, ' ')}| ${lines[n - 1] ?? ''}`);
  }
  return out.join('\n');
}

export function compileShader(
  gl: WebGL2RenderingContext,
  type: GLenum,
  source: string,
  label: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new ShaderError(`[pixel-life] cannot create shader "${label}"`, '');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(shader) ?? '';
    gl.deleteShader(shader);
    throw new ShaderError(
      `[pixel-life] shader "${label}" failed to compile:\n${log}`,
      log,
      numbered(source),
    );
  }
  return shader;
}

export interface Program {
  readonly handle: WebGLProgram;
  readonly label: string;
  /** Cached uniform location lookup; returns null for optimized-out uniforms. */
  uniform(name: string): WebGLUniformLocation | null;
  /** Binds a named uniform block to a binding point (no-op when the block was optimized out). */
  bindBlock(name: string, binding: number): void;
  dispose(): void;
}

function wrapProgram(gl: WebGL2RenderingContext, handle: WebGLProgram, label: string): Program {
  const cache = new Map<string, WebGLUniformLocation | null>();
  return {
    handle,
    label,
    uniform(name) {
      let loc = cache.get(name);
      if (loc === undefined) {
        loc = gl.getUniformLocation(handle, name);
        cache.set(name, loc);
      }
      return loc;
    },
    bindBlock(name, binding) {
      const index = gl.getUniformBlockIndex(handle, name);
      if (index !== gl.INVALID_INDEX) gl.uniformBlockBinding(handle, index, binding);
    },
    dispose() {
      gl.deleteProgram(handle);
      cache.clear();
    },
  };
}

export function createProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
  label: string,
): Program {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource, `${label}.vert`);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource, `${label}.frag`);
  const handle = gl.createProgram();
  if (!handle) throw new ShaderError(`[pixel-life] cannot create program "${label}"`, '');
  gl.attachShader(handle, vs);
  gl.attachShader(handle, fs);
  gl.linkProgram(handle);
  // Shaders can be flagged for deletion right away; the program keeps them alive.
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(handle, gl.LINK_STATUS) && !gl.isContextLost()) {
    const log = gl.getProgramInfoLog(handle) ?? '';
    gl.deleteProgram(handle);
    throw new ShaderError(`[pixel-life] program "${label}" failed to link:\n${log}`, log);
  }
  return wrapProgram(gl, handle, label);
}

/**
 * A program whose compile/link was submitted but not yet checked.
 *
 * Status queries are what actually block on the driver, so with KHR_parallel_shader_compile we
 * only ask COMPLETION_STATUS (non-blocking) until it flips, then read the real status once.
 */
export interface PendingProgram {
  readonly label: string;
  /** Returns the linked program, null while still compiling; throws ShaderError on failure. */
  poll(): Program | null;
  /** Deletes GL objects if the program never got handed out. */
  dispose(): void;
}

export function createProgramAsync(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
  label: string,
  parallel: KHR_parallel_shader_compile | null,
): PendingProgram {
  const vs = gl.createShader(gl.VERTEX_SHADER);
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  const handle = gl.createProgram();
  if (!vs || !fs || !handle) {
    throw new ShaderError(`[pixel-life] cannot create program "${label}"`, '');
  }
  gl.shaderSource(vs, vertexSource);
  gl.shaderSource(fs, fragmentSource);
  gl.compileShader(vs);
  gl.compileShader(fs);
  gl.attachShader(handle, vs);
  gl.attachShader(handle, fs);
  gl.linkProgram(handle);

  let result: Program | null = null;
  let done = false;

  const cleanup = (deleteProgram: boolean) => {
    if (done) return;
    done = true;
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (deleteProgram) gl.deleteProgram(handle);
  };

  const fail = (): never => {
    let message = `[pixel-life] program "${label}" failed to link`;
    let log = gl.getProgramInfoLog(handle) ?? '';
    let source: string | undefined;
    for (const [shader, src, kind] of [
      [vs, vertexSource, 'vert'],
      [fs, fragmentSource, 'frag'],
    ] as const) {
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        log = gl.getShaderInfoLog(shader) ?? '';
        message = `[pixel-life] shader "${label}.${kind}" failed to compile:\n${log}\n${excerpt(src, log)}`;
        source = numbered(src);
        break;
      }
    }
    cleanup(true);
    throw new ShaderError(message, log, source);
  };

  return {
    label,
    poll() {
      if (result) return result;
      if (done) return null;
      if (gl.isContextLost()) return null;
      if (parallel && !gl.getProgramParameter(handle, parallel.COMPLETION_STATUS_KHR)) return null;
      if (!gl.getProgramParameter(handle, gl.LINK_STATUS)) fail();
      cleanup(false);
      result = wrapProgram(gl, handle, label);
      return result;
    },
    dispose() {
      if (result) {
        result.dispose();
        result = null;
        done = true;
        return;
      }
      cleanup(true);
    },
  };
}
