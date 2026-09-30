/**
 * Textures and render targets.
 *
 * The default format is RGBA8 (color-renderable and filterable everywhere). Callers that probed
 * float support (see caps.ts) pass an RGBA16F format explicitly. Targets are created with
 * texImage2D (not texStorage2D) so they can be resized in place.
 */

import type { TextureFormat } from './caps';

export interface TextureOptions {
  filter?: GLenum;
  wrap?: GLenum;
  /** Defaults to RGBA8 / RGBA / UNSIGNED_BYTE. */
  format?: TextureFormat;
}

export function createTexture(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  { filter = gl.NEAREST, wrap = gl.CLAMP_TO_EDGE, format }: TextureOptions = {},
  data: ArrayBufferView | null = null,
): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error('[pixel-life] cannot create texture');
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
    throw new Error(`[pixel-life] framebuffer incomplete: 0x${status.toString(16)}`);
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
  const texture = createTexture(gl, w, h, options);
  const framebuffer = gl.createFramebuffer();
  if (!framebuffer) throw new Error('[pixel-life] cannot create framebuffer');
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

/** A framebuffer with several color attachments (MRT). Textures are owned by the caller. */
export function createMrtFramebuffer(
  gl: WebGL2RenderingContext,
  textures: readonly WebGLTexture[],
): WebGLFramebuffer {
  const fb = gl.createFramebuffer();
  if (!fb) throw new Error('[pixel-life] cannot create framebuffer');
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  const buffers: GLenum[] = [];
  for (let i = 0; i < textures.length; i++) {
    const attachment = gl.COLOR_ATTACHMENT0 + i;
    gl.framebufferTexture2D(gl.FRAMEBUFFER, attachment, gl.TEXTURE_2D, textures[i] ?? null, 0);
    buffers.push(attachment);
  }
  gl.drawBuffers(buffers);
  checkComplete(gl);
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
