/**
 * Where a render slot draws inside its surface's framebuffer.
 *
 * A region is a rectangle in device px with GL's bottom-left origin (what gl.viewport and
 * gl.scissor take). The composite and lift shaders receive it as `u_region` and turn
 * gl_FragCoord into the slot's own top-left pixel coordinates with it (REGION_PIXEL_GLSL). For a
 * region at the origin the arithmetic is the one the own path always did. Under an offset the
 * rasterizer snaps vertices and interpolates varyings from other window coordinates, so the
 * output is expected to match the own canvas within 1 LSB per channel on a few pixels (edges of
 * lifts and, occasionally, of the composite), not bit for bit.
 *
 * Everything here is plain math on numbers (no GL calls), shared by the surfaces and the unit tests.
 */

export interface Region {
  /** Left edge, device px from the framebuffer's left side. */
  x: number;
  /** Bottom edge, device px from the framebuffer's bottom side (GL convention). */
  y: number;
  width: number;
  height: number;
}

export function createRegion(): Region {
  return { x: 0, y: 0, width: 0, height: 0 };
}

export function setRegion(out: Region, x: number, y: number, width: number, height: number) {
  out.x = x;
  out.y = y;
  out.width = width;
  out.height = height;
  return out;
}

/**
 * A region given by its top-left corner in canvas orientation (y down, like CSS and the
 * controller's device px) inside a framebuffer `fbHeight` px tall. Sizes are floored to whole
 * pixels (at least 1) and the corner is rounded, so every edge sits on the pixel grid. The region
 * may extend past the framebuffer; see scissorRegion for the part that can be written.
 */
export function placeRegion(
  out: Region,
  left: number,
  top: number,
  width: number,
  height: number,
  fbHeight: number,
): Region {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const x = Math.round(left);
  const t = Math.round(top);
  return setRegion(out, x, Math.round(fbHeight) - t - h, w, h);
}

/** True when the region is exactly the whole framebuffer (then no scissor is needed). */
export function coversFramebuffer(r: Region, fbWidth: number, fbHeight: number): boolean {
  return r.x === 0 && r.y === 0 && r.width === fbWidth && r.height === fbHeight;
}

/** True when some pixel of the region lies inside a `fbWidth x fbHeight` framebuffer. */
export function regionVisible(r: Region, fbWidth: number, fbHeight: number): boolean {
  return (
    r.width > 0 &&
    r.height > 0 &&
    r.x < fbWidth &&
    r.y < fbHeight &&
    r.x + r.width > 0 &&
    r.y + r.height > 0
  );
}

/**
 * The part of `r` inside a `fbWidth x fbHeight` framebuffer, written to `out` (the scissor box).
 * Returns false when nothing of the region is inside (width or height 0 then).
 */
export function scissorRegion(r: Region, fbWidth: number, fbHeight: number, out: Region): boolean {
  const x0 = Math.max(0, r.x);
  const y0 = Math.max(0, r.y);
  const x1 = Math.min(fbWidth, r.x + r.width);
  const y1 = Math.min(fbHeight, r.y + r.height);
  setRegion(out, x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0));
  return out.width > 0 && out.height > 0;
}

/**
 * GLSL for the slot-local pixel position (top-left origin, y down) of the current fragment: a
 * vec2 from gl_FragCoord and `uniform vec4 u_region` (xy origin, zw size, as a Region). The
 * composite and lift fragment shaders both splice in this exact text, so the two cannot drift
 * apart. With a region at the origin it is (x, height - y), the own-canvas formula, bit for bit
 * (under an offset see the note at the top of this file).
 */
export const REGION_PIXEL_GLSL =
  'vec2(gl_FragCoord.x - u_region.x, u_region.y + u_region.w - gl_FragCoord.y)';
