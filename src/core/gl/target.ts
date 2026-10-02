/**
 * Textures and render targets.
 *
 * The default format is RGBA8 (color-renderable and filterable everywhere). Callers that probed
 * float support (see caps.ts) pass an RGBA16F format explicitly. Targets are created with
 * texImage2D (not texStorage2D) so they can be resized in place.
 *
 * Render targets get their initial (zero) contents by upload, never from WebGL's lazy
 * initialization (see createTargetTexture).
 */

import type { TextureFormat } from './caps';

export interface TextureOptions {
  filter?: GLenum;
  wrap?: GLenum;
  /** Defaults to RGBA8 / RGBA / UNSIGNED_BYTE. */
  format?: TextureFormat;
}

/** Uploads up to this size share one zero buffer (never written); larger ones get their own. */
const SHARED_ZEROS_MAX = 1 << 20;
let sharedZeros: ArrayBuffer | null = null;

/**
 * Zero texels for a `width x height` texImage2D of `format` (default RGBA8), typed as WebGL
 * requires for its component type: Uint8Array (UNSIGNED_BYTE), Uint16Array (HALF_FLOAT) or
 * Float32Array (FLOAT). Null for any other type (the texture is then left to lazy
 * initialization). Uploads with UNPACK_ALIGNMENT 1, so rows are tightly packed.
 */
export function zeroTexels(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  format?: TextureFormat,
): ArrayBufferView | null {
  const type = format?.type ?? gl.UNSIGNED_BYTE;
  const layout = format?.format ?? gl.RGBA;
  const size =
    type === gl.UNSIGNED_BYTE ? 1 : type === gl.HALF_FLOAT ? 2 : type === gl.FLOAT ? 4 : 0;
  if (size === 0) return null;
  const channels = layout === gl.RGBA ? 4 : layout === gl.RGB ? 3 : layout === gl.RG ? 2 : 1;
  const count = Math.max(1, width) * Math.max(1, height) * channels;
  const bytes = count * size;
  let buffer: ArrayBuffer;
  if (bytes > SHARED_ZEROS_MAX) {
    buffer = new ArrayBuffer(bytes);
  } else {
    if (!sharedZeros || sharedZeros.byteLength < bytes) sharedZeros = new ArrayBuffer(bytes);
    buffer = sharedZeros;
  }
  if (size === 1) return new Uint8Array(buffer, 0, count);
  if (size === 2) return new Uint16Array(buffer, 0, count);
  return new Float32Array(buffer, 0, count);
}

export function createTexture(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  { filter = gl.NEAREST, wrap = gl.CLAMP_TO_EDGE, format }: TextureOptions = {},
  data: ArrayBufferView | null = null,
): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error('[lumicells] cannot create texture');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    format?.internalFormat ?? gl.RGBA8,
    width,
    height,
    0,
    format?.format ?? gl.RGBA,
    format?.type ?? gl.UNSIGNED_BYTE,
    data,
  );
  return tex;
}

/**
 * A texture to render into, created with defined (zero) contents.
 *
 * WebGL guarantees that a texture created without data reads as zero, but leaves it to the
 * implementation how. ANGLE initializes such a texture lazily, right before the first draw that
 * renders into it, and on Direct3D 11 it does that with a ClearRenderTargetView of the whole
 * texture (allowClearForRobustResourceInit). On NVIDIA's D3D11 driver (seen with an RTX 5090,
 * driver 32.0.16.1074) a draw into a framebuffer whose color attachments were all just cleared
 * that way intermittently drops what it writes to COLOR_ATTACHMENT1: the texture keeps the clear
 * value while attachments 0 and 2 receive the draw. Whether it happens depends on how the
 * commands around that draw are batched (an extra flush next to it avoids it), so it came and
 * went with unrelated changes. An engine-free WebGL page reproduces it there and nowhere else
 * (not on WARP with the same ANGLE code, not with ANGLE's Vulkan or GL backends on the same GPU),
 * and never when at least one of the attachments had its contents uploaded. For the engine it
 * meant a cell stamp (baked once) whose halo layer stayed empty for good.
 *
 * Uploaded contents need no lazy initialization, so no clear ever precedes a target's first draw.
 * The upload happens only when a target is (re)allocated, never per frame.
 */
export function createTargetTexture(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  options: TextureOptions = {},
): WebGLTexture {
  return createTexture(gl, width, height, options, zeroTexels(gl, width, height, options.format));
}

export interface RenderTarget {
  readonly texture: WebGLTexture;
  readonly framebuffer: WebGLFramebuffer;
  readonly width: number;
  readonly height: number;
}

function checkComplete(gl: WebGL2RenderingContext): void {
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE && !gl.isContextLost()) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    throw new Error(`[lumicells] framebuffer incomplete: 0x${status.toString(16)}`);
  }
}

export function createRenderTarget(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  options?: TextureOptions,
): RenderTarget {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const texture = createTargetTexture(gl, w, h, options);
  const framebuffer = gl.createFramebuffer();
  if (!framebuffer) throw new Error('[lumicells] cannot create framebuffer');
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  checkComplete(gl);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { texture, framebuffer, width: w, height: h };
}

export function disposeRenderTarget(gl: WebGL2RenderingContext, target: RenderTarget | null): void {
  if (!target) return;
  gl.deleteFramebuffer(target.framebuffer);
  gl.deleteTexture(target.texture);
}

/**
 * A framebuffer with several color attachments (MRT). Textures are owned by the caller and come
 * from createTargetTexture (see there why). They are attached from COLOR_ATTACHMENT0 + `first`
 * on, with no draw buffer below (see MRT_PAD in engine/passes/shared.ts). `check`: verify
 * completeness (a synchronous call, which waits for the GPU process).
 */
export function createMrtFramebuffer(
  gl: WebGL2RenderingContext,
  textures: readonly WebGLTexture[],
  first = 0,
  check = true,
): WebGLFramebuffer {
  const fb = gl.createFramebuffer();
  if (!fb) throw new Error('[lumicells] cannot create framebuffer');
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  const buffers: GLenum[] = [];
  for (let i = 0; i < first; i++) buffers.push(gl.NONE);
  for (let i = 0; i < textures.length; i++) {
    const attachment = gl.COLOR_ATTACHMENT0 + first + i;
    gl.framebufferTexture2D(gl.FRAMEBUFFER, attachment, gl.TEXTURE_2D, textures[i] ?? null, 0);
    buffers.push(attachment);
  }
  gl.drawBuffers(buffers);
  if (check) checkComplete(gl);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return fb;
}

/**
 * Headroom bucket for resizable cell-resolution targets: the next multiple of `step`.
 * Small grid changes (continuous pitch tweens, window resizes) then stay inside one allocation.
 */
export function bucketSize(n: number, step = 32): number {
  return Math.max(step, Math.ceil(Math.max(1, n) / step) * step);
}

/**
 * Whether an allocation of `alloc` must change to hold `need`: grow when it does not fit, shrink
 * only when the needed bucket is less than half of it. The strict test is the hysteresis: with
 * `<=`, a size oscillating across a bucket boundary would reallocate every frame (need 33 grows
 * 32 -> 64, need 32 shrinks back because 32 * 2 <= 64); now it grows once and stays.
 */
export function needsRealloc(alloc: number, need: number, step = 32): boolean {
  return need > alloc || bucketSize(need, step) * 2 < alloc;
}
