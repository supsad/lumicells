/**
 * Surfaces: where a RenderSlot's composite and lifts land.
 *
 * The cell passes render into the slot's own targets; only the final full-resolution passes draw
 * into a surface, inside the region the surface assigns for the frame (see region.ts). A region
 * smaller than its framebuffer is scissored, so a slot never writes outside it.
 *
 * - OwnSurface: the default framebuffer of the device's own canvas, sized to the frame (one
 *   instance per context, zero copies: the path every instance used before slots existed).
 * - RegionSurface: a spot inside the default framebuffer of the device's canvas, which its owner
 *   sizes (several slots side by side in one canvas).
 */

import type { GpuDevice } from './device';
import { createRegion, placeRegion, type Region, regionVisible, setRegion } from './region';

/** What a surface assigned to one frame (filled by Surface.begin, owned by the slot). */
export interface SurfaceFrame {
  /** Where the slot draws, GL bottom-left origin, device px. */
  readonly region: Region;
  /** Size of the framebuffer the region lies in, device px. */
  fbWidth: number;
  fbHeight: number;
}

export function createSurfaceFrame(): SurfaceFrame {
  return { region: createRegion(), fbWidth: 0, fbHeight: 0 };
}

export interface Surface {
  /** Framebuffer holding the region (null = the default framebuffer of the device's canvas). */
  readonly framebuffer: WebGLFramebuffer | null;
  /**
   * Prepares a frame of `width x height` device px (the FrameInputs canvas size) and writes
   * where it goes into `out`. Returns false when no part of it can be seen (nothing is drawn).
   */
  begin(width: number, height: number, out: SurfaceFrame): boolean;
  /**
   * Whether begin() would resize a canvas for that size: a synchronous call (the browser waits
   * for the GPU process), which a slot defers while a warm-up compiles (see warmup.ts).
   */
  resizes(width: number, height: number): boolean;
}

/** The device's own canvas, resized to every frame: the region is its whole drawing buffer. */
export class OwnSurface implements Surface {
  readonly framebuffer = null;

  constructor(private readonly device: GpuDevice) {}

  resizes(width: number, height: number): boolean {
    const canvas = this.device.canvas;
    return (
      canvas.width !== Math.max(1, Math.floor(width)) ||
      canvas.height !== Math.max(1, Math.floor(height))
    );
  }

  begin(width: number, height: number, out: SurfaceFrame): boolean {
    const canvas = this.device.canvas;
    const gl = this.device.gl;
    const cw = Math.max(1, Math.floor(width));
    const ch = Math.max(1, Math.floor(height));
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
    // The browser may clamp the drawing buffer below the requested size; trust what we got.
    const vw = gl.drawingBufferWidth;
    const vh = gl.drawingBufferHeight;
    setRegion(out.region, 0, 0, vw, vh);
    out.fbWidth = vw;
    out.fbHeight = vh;
    return true;
  }
}

/**
 * A spot in the default framebuffer of the device's canvas: the frame is drawn with its top-left
 * corner at `left, top` (canvas orientation, device px) at its own size. The canvas is sized by
 * whoever lays the regions out, never by the surface.
 */
export class RegionSurface implements Surface {
  readonly framebuffer = null;

  constructor(
    private readonly device: GpuDevice,
    public left = 0,
    public top = 0,
  ) {}

  /** The canvas is sized by whoever lays the regions out. */
  resizes(): boolean {
    return false;
  }

  moveTo(left: number, top: number): void {
    this.left = left;
    this.top = top;
  }

  begin(width: number, height: number, out: SurfaceFrame): boolean {
    const gl = this.device.gl;
    const fw = gl.drawingBufferWidth;
    const fh = gl.drawingBufferHeight;
    placeRegion(out.region, this.left, this.top, width, height, fh);
    out.fbWidth = fw;
    out.fbHeight = fh;
    return regionVisible(out.region, fw, fh);
  }
}
