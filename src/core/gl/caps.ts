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
  /**
   * Format for the final (sampled, never re-filtered in a pass) glow target: R11F_G11F_B10F when
   * `hdr` and it is renderable (32 bpp, full-rate filtering on mobile GPUs; the glow is >= 0 and
   * needs no alpha), else `hdrFormat`.
   */
  readonly glowFormat: TextureFormat;
  readonly rgba8: TextureFormat;
  readonly parallelCompile: KHR_parallel_shader_compile | null;
  readonly timerQuery: TimerQueryExt | null;
  readonly loseContext: WEBGL_lose_context | null;
  readonly maxTextureSize: number;
  readonly maxRenderbufferSize: number;
  /** MAX_VIEWPORT_DIMS [width, height]. */
  readonly maxViewportDims: readonly [number, number];
  /**
   * Largest drawing-buffer side that is safe to request: min of MAX_TEXTURE_SIZE,
   * MAX_RENDERBUFFER_SIZE and both MAX_VIEWPORT_DIMS. Larger canvases are silently shrunk by
   * the browser, so the controller clamps the geometry to this instead.
   */
  readonly maxDrawableSize: number;
  readonly maxDrawBuffers: number;
  readonly maxUniformBlockSize: number;
  readonly renderer: string;
  /** Renderer string looks like a CPU rasterizer (SwiftShader, llvmpipe, WARP...). */
  readonly software: boolean;
  /**
   * Not a known immediate-mode (desktop) GPU, so probably a tiler (Mali, Adreno, PowerVR, Apple):
   * render targets about to be fully overwritten are invalidated there, which lets a tiler skip
   * loading their old contents. Desktop GPUs gain nothing, and ANGLE's D3D11 backend turns every
   * invalidation into a clear of the whole texture (measured: ~10 us per frame for the cell passes).
   */
  readonly tiled: boolean;
  /**
   * ANGLE on Direct3D (Chrome, Edge and Firefox on Windows): programs with several outputs get
   * their pixel shader compiled again on the first draw (see passes/shared.ts, MRT_PAD).
   */
  readonly d3d: boolean;
  /**
   * RGBA32F, for the staged field pass (see engine/passes/field.ts): only on Direct3D (`d3d`)
   * and when it is color-renderable (EXT_color_buffer_float); null otherwise.
   */
  readonly stageFormat: TextureFormat | null;
}

const SOFTWARE_RE =
  /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic|mesa offscreen/i;
/** Immediate-mode desktop GPU vendors (CPU rasterizers are no tilers either: SOFTWARE_RE). */
const IMMEDIATE_RE = /nvidia|geforce|quadro|radeon|\bamd\b|\bati\b|intel/i;

const D3D_RE = /direct3d|\bd3d(?:9|11)\b/i;

/** GLCaps.d3d from a renderer string (ANGLE names its backend: "... Direct3D11 vs_5_0 ..."). */
export function isD3DRenderer(renderer: string): boolean {
  return D3D_RE.test(renderer);
}

/** GLCaps.tiled from a renderer string: anything but a known desktop vendor or CPU rasterizer. */
export function isTiledRenderer(renderer: string): boolean {
  return !IMMEDIATE_RE.test(renderer) && !SOFTWARE_RE.test(renderer);
}

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
  const packed: TextureFormat = {
    internalFormat: gl.R11F_G11F_B10F,
    format: gl.RGB,
    type: gl.HALF_FLOAT,
  };
  const glowPacked = hdr && isRenderable(gl, packed);
  const renderer = readRenderer(gl);
  const d3d = isD3DRenderer(renderer);
  const f32: TextureFormat = { internalFormat: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT };
  const stageRenderable =
    d3d && !!gl.getExtension('EXT_color_buffer_float') && isRenderable(gl, f32);
  const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  const maxRenderbufferSize = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number;
  const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as ArrayLike<number> | null;
  const maxViewportDims: [number, number] = [Number(vp?.[0] ?? 0), Number(vp?.[1] ?? 0)];
  let maxDrawableSize = Number.POSITIVE_INFINITY;
  for (const v of [maxTextureSize, maxRenderbufferSize, maxViewportDims[0], maxViewportDims[1]]) {
    if (v > 0 && Number.isFinite(v)) maxDrawableSize = Math.min(maxDrawableSize, v);
  }
  return {
    hdr,
    hdrFormat: hdr ? half : rgba8,
    glowFormat: glowPacked ? packed : hdr ? half : rgba8,
    rgba8,
    parallelCompile: gl.getExtension('KHR_parallel_shader_compile'),
    timerQuery: gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExt | null,
    loseContext: gl.getExtension('WEBGL_lose_context'),
    maxTextureSize,
    maxRenderbufferSize,
    maxViewportDims,
    // 0 = unknown (a driver that reports nothing): no clamp.
    maxDrawableSize: Number.isFinite(maxDrawableSize) ? maxDrawableSize : 0,
    maxDrawBuffers: gl.getParameter(gl.MAX_DRAW_BUFFERS) as number,
    maxUniformBlockSize: gl.getParameter(gl.MAX_UNIFORM_BLOCK_SIZE) as number,
    renderer,
    software: SOFTWARE_RE.test(renderer),
    tiled: isTiledRenderer(renderer),
    d3d,
    stageFormat: stageRenderable ? f32 : null,
  };
}
