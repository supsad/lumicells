/**
 * One-time capability probe for a WebGL2 context.
 *
 * Everything optional is detected here so the rest of the engine can branch on plain booleans
 * instead of sprinkling getExtension() calls around.
 */

export interface TextureFormat {
  readonly internalFormat: GLenum;
  readonly format: GLenum;
  readonly type: GLenum;
}

/** EXT_disjoint_timer_query_webgl2 (not in lib.dom). */
export interface TimerQueryExt {
  readonly TIME_ELAPSED_EXT: GLenum;
  readonly GPU_DISJOINT_EXT: GLenum;
}

export interface GLCaps {
  /** Half-float render targets work (values above 1, no banding). Otherwise RGBA8 + sqrt encoding. */
  readonly hdr: boolean;
  /** Format for HDR-ish targets: RGBA16F when `hdr`, else RGBA8. */
  readonly hdrFormat: TextureFormat;
  readonly rgba8: TextureFormat;
  readonly parallelCompile: KHR_parallel_shader_compile | null;
  readonly timerQuery: TimerQueryExt | null;
  readonly loseContext: WEBGL_lose_context | null;
  readonly maxTextureSize: number;
  readonly maxDrawBuffers: number;
  readonly maxUniformBlockSize: number;
  readonly renderer: string;
  /** Renderer string looks like a CPU rasterizer (SwiftShader, llvmpipe, WARP...). */
  readonly software: boolean;
}

const SOFTWARE_RE =
  /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic|mesa offscreen/i;

function readRenderer(gl: WebGL2RenderingContext): string {
  // Firefox deprecates the debug extension but reports the unmasked string in RENDERER already.
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const unmasked = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null;
  const plain = gl.getParameter(gl.RENDERER);
  return String(unmasked ?? plain ?? '');
}

/** Checks that a 4x4 texture of the given format can be attached and rendered to. */
function isRenderable(gl: WebGL2RenderingContext, f: TextureFormat): boolean {
  const tex = gl.createTexture();
  const fb = gl.createFramebuffer();
  if (!tex || !fb) return false;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, f.internalFormat, 4, 4, 0, f.format, f.type, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.deleteFramebuffer(fb);
  gl.deleteTexture(tex);
  return ok;
}

/** `forceRgba8` skips float targets (testing the RGBA8 + sqrt-encoding fallback path). */
export function probeCaps(gl: WebGL2RenderingContext, forceRgba8 = false): GLCaps {
  const rgba8: TextureFormat = {
    internalFormat: gl.RGBA8,
    format: gl.RGBA,
    type: gl.UNSIGNED_BYTE,
  };
  const half: TextureFormat = {
    internalFormat: gl.RGBA16F,
    format: gl.RGBA,
    type: gl.HALF_FLOAT,
  };
  // Some older iOS builds only expose the half-float variant; either makes RGBA16F renderable.
  const floatExt =
    gl.getExtension('EXT_color_buffer_float') ?? gl.getExtension('EXT_color_buffer_half_float');
  const hdr = !forceRgba8 && !!floatExt && isRenderable(gl, half);
  const renderer = readRenderer(gl);
  return {
    hdr,
    hdrFormat: hdr ? half : rgba8,
    rgba8,
    parallelCompile: gl.getExtension('KHR_parallel_shader_compile'),
    timerQuery: gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExt | null,
    loseContext: gl.getExtension('WEBGL_lose_context'),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    maxDrawBuffers: gl.getParameter(gl.MAX_DRAW_BUFFERS) as number,
    maxUniformBlockSize: gl.getParameter(gl.MAX_UNIFORM_BLOCK_SIZE) as number,
    renderer,
    software: SOFTWARE_RE.test(renderer),
  };
}
