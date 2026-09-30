/**
 * Grid geometry: drawing-buffer size, integer device-px pitch, odd cell counts centered on the
 * host, pad cells for glow spill / overflow and the snapped grid origin.
 *
 * The pitch is snapped to whole device pixels so every cell and every gap is identical (no
 * alternating 1/2 px gaps or moire when DPR or the adaptive scale are fractional).
 */

export interface GeometryInput {
  /** Host padding-box size, CSS px. */
  hostCssW: number;
  hostCssH: number;
  /** Canvas margin around the host on every side, CSS px (render.overflow). */
  overflowCss: number;
  /** window.devicePixelRatio. */
  dpr: number;
  /** Exact canvas size in device px (devicePixelContentBoxSize), 0 when unknown. */
  deviceW: number;
  deviceH: number;
  maxDpr: number;
  /** Pixel budget in megapixels (already reduced for coarse pointers / software GL). */
  maxPixels: number;
  /** Adaptive resolution scale (perf controller). */
  scale: number;
  /** Desired cell pitch in CSS px (grid.pitch or shorter side / grid.count). */
  cssPitch: number;
  /**
   * Largest drawing-buffer side the GL context supports, device px (min of MAX_TEXTURE_SIZE,
   * MAX_RENDERBUFFER_SIZE and MAX_VIEWPORT_DIMS). 0 / undefined: no limit known.
   */
  maxDim?: number;
}

export interface Geometry {
  canvasW: number;
  canvasH: number;
  canvasCssW: number;
  canvasCssH: number;
  /** Effective device px per CSS px of the drawing buffer. */
  effDpr: number;
  sx: number;
  sy: number;
  /** Host rect in canvas device px. */
  hostX: number;
  hostY: number;
  hostW: number;
  hostH: number;
  pitchPx: number;
  cols: number;
  rows: number;
  pad: number;
  /** Canvas device px of the top-left corner of texel (0, 0) (pad included). */
  originX: number;
  originY: number;
  /** Host center, canvas device px. */
  centerX: number;
  centerY: number;
  /** Half of the host's shorter side, device px (1 mode unit). */
  halfMin: number;
}

export const MAX_PAD = 16;
/** Keeps the cell textures well inside every GPU's max texture size. */
export const MAX_GRID_CELLS = 2048;

export function createGeometry(): Geometry {
  return {
    canvasW: 1,
    canvasH: 1,
    canvasCssW: 1,
    canvasCssH: 1,
    effDpr: 1,
    sx: 1,
    sy: 1,
    hostX: 0,
    hostY: 0,
    hostW: 1,
    hostH: 1,
    pitchPx: 8,
    cols: 1,
    rows: 1,
    pad: 2,
    originX: 0,
    originY: 0,
    centerX: 0.5,
    centerY: 0.5,
    halfMin: 0.5,
  };
}

/** Effective device px per CSS px: DPR cap, pixel budget, adaptive scale. */
export function effectiveDpr(
  dpr: number,
  maxDpr: number,
  maxPixelsM: number,
  canvasCssW: number,
  canvasCssH: number,
  scale: number,
): number {
  const area = Math.max(1, canvasCssW * canvasCssH);
  const budget = Math.sqrt((Math.max(0.01, maxPixelsM) * 1e6) / area);
  return Math.max(0.05, Math.min(dpr > 0 ? dpr : 1, maxDpr, budget) * (scale > 0 ? scale : 1));
}

/** Fills `out`; returns true when anything the engine or events care about changed. */
export function computeGeometry(inp: GeometryInput, out: Geometry): boolean {
  const ov = Math.max(0, inp.overflowCss);
  const cssW = Math.max(1, inp.hostCssW + 2 * ov);
  const cssH = Math.max(1, inp.hostCssH + 2 * ov);
  const dpr = inp.dpr > 0 ? inp.dpr : 1;
  let eff = effectiveDpr(dpr, inp.maxDpr, inp.maxPixels, cssW, cssH, inp.scale);
  // The pixel budget limits the area only: a tall or extreme-aspect host can still ask for a
  // side the GPU cannot allocate (the browser would silently shrink the buffer and the grid
  // would come out cut off and non-square). Scale both sides down proportionally instead.
  const maxDim = inp.maxDim !== undefined && inp.maxDim > 0 ? inp.maxDim : 0;
  if (maxDim > 0 && (cssW * eff > maxDim || cssH * eff > maxDim)) {
    eff = Math.min(eff, maxDim / cssW, maxDim / cssH);
  }
  let cw: number;
  let ch: number;
  if (
    Math.abs(eff - dpr) < 1e-6 &&
    inp.deviceW > 0 &&
    inp.deviceH > 0 &&
    // Sanity check: some emulated/zoomed setups report the box in CSS px.
    Math.abs(inp.deviceW - cssW * dpr) <= 2 &&
    Math.abs(inp.deviceH - cssH * dpr) <= 2
  ) {
    // No cap applied: use the exact device box so the canvas maps 1:1 onto physical pixels.
    cw = inp.deviceW;
    ch = inp.deviceH;
  } else {
    cw = Math.max(1, Math.round(cssW * eff));
    ch = Math.max(1, Math.round(cssH * eff));
    if (maxDim > 0) {
      cw = Math.min(cw, maxDim);
      ch = Math.min(ch, maxDim);
    }
  }
  const sx = cw / cssW;
  const sy = ch / cssH;
  const mx = Math.round(ov * sx);
  const my = Math.round(ov * sy);
  const hw = Math.max(1, cw - 2 * mx);
  const hh = Math.max(1, ch - 2 * my);
  let pitch = Math.max(3, Math.round(inp.cssPitch * sx));
  pitch = Math.max(pitch, Math.ceil(Math.max(hw, hh) / (MAX_GRID_CELLS - 2 * MAX_PAD - 2)));
  let cols = Math.ceil(hw / pitch) + 1;
  if (cols % 2 === 0) cols++;
  let rows = Math.ceil(hh / pitch) + 1;
  if (rows % 2 === 0) rows++;
  const pad = Math.min(MAX_PAD, 2 + Math.ceil(Math.max(mx, my) / pitch));
  const centerX = mx + hw / 2;
  const centerY = my + hh / 2;
  const originX = Math.round(centerX - (cols / 2 + pad) * pitch);
  const originY = Math.round(centerY - (rows / 2 + pad) * pitch);

  const changed =
    out.canvasW !== cw ||
    out.canvasH !== ch ||
    out.pitchPx !== pitch ||
    out.cols !== cols ||
    out.rows !== rows ||
    out.pad !== pad ||
    out.originX !== originX ||
    out.originY !== originY ||
    out.hostW !== hw ||
    out.hostH !== hh ||
    out.effDpr !== eff;
  out.canvasW = cw;
  out.canvasH = ch;
  out.canvasCssW = cssW;
  out.canvasCssH = cssH;
  out.effDpr = eff;
  out.sx = sx;
  out.sy = sy;
  out.hostX = mx;
  out.hostY = my;
  out.hostW = hw;
  out.hostH = hh;
  out.pitchPx = pitch;
  out.cols = cols;
  out.rows = rows;
  out.pad = pad;
  out.originX = originX;
  out.originY = originY;
  out.centerX = centerX;
  out.centerY = centerY;
  out.halfMin = Math.min(hw, hh) / 2;
  return changed;
}
