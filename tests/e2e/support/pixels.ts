/**
 * Pixel checks on screenshots: what the browser actually composited, not what the page reports.
 */
import type { Locator, Page } from '@playwright/test';
import { decodePng, type RgbaImage } from './png';

/**
 * Screenshot stylesheet that leaves only the LumiCells canvases visible: no page content over or
 * under them, no CSS poster on the host (the host is hidden too). A canvas the library keeps
 * hidden (inline `visibility: hidden` until it has drawn) stays hidden. Playwright applies it
 * inside shadow roots as well (<lumi-cells>).
 */
export const ONLY_CANVAS = [
  '*:not(canvas[data-lumicells]) { visibility: hidden !important; }',
  'canvas[data-lumicells] { visibility: visible; }',
].join('\n');

/** Screenshot of an element showing only the LumiCells canvases in it. */
export async function canvasShot(target: Locator): Promise<RgbaImage> {
  return decodePng(await target.screenshot({ style: ONLY_CANVAS }));
}

export async function pageShot(page: Page): Promise<RgbaImage> {
  return decodePng(await page.screenshot());
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PixelStats {
  pixels: number;
  /** Most frequent color (quantized to 4 bits per channel), as #rgb. */
  background: string;
  /** Share of pixels that differ from the background by more than 32 in some channel. */
  lit: number;
  /** Distinct colors, quantized to 4 bits per channel. */
  colors: number;
  /** Share of near-white pixels (every channel >= 240): a lost context's blank box. */
  white: number;
}

function clampRect(img: RgbaImage, r?: Rect): Rect {
  if (!r) return { x: 0, y: 0, w: img.width, h: img.height };
  const x = Math.max(0, Math.min(img.width, Math.round(r.x)));
  const y = Math.max(0, Math.min(img.height, Math.round(r.y)));
  return {
    x,
    y,
    w: Math.max(0, Math.min(img.width - x, Math.round(r.w))),
    h: Math.max(0, Math.min(img.height - y, Math.round(r.h))),
  };
}

export function pixelStats(img: RgbaImage, region?: Rect): PixelStats {
  const r = clampRect(img, region);
  const counts = new Map<number, number>();
  let white = 0;
  const d = img.data;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * img.width + x) * 4;
      const red = d[i] as number;
      const green = d[i + 1] as number;
      const blue = d[i + 2] as number;
      const q = ((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4);
      counts.set(q, (counts.get(q) ?? 0) + 1);
      if (red >= 240 && green >= 240 && blue >= 240) white++;
    }
  }
  let bg = 0;
  let bgCount = -1;
  for (const [q, n] of counts) {
    if (n > bgCount) {
      bg = q;
      bgCount = n;
    }
  }
  // Background color at the center of its quantization bucket.
  const br = ((bg >> 8) & 15) * 16 + 8;
  const bgg = ((bg >> 4) & 15) * 16 + 8;
  const bb = (bg & 15) * 16 + 8;
  let lit = 0;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * img.width + x) * 4;
      const dist = Math.max(
        Math.abs((d[i] as number) - br),
        Math.abs((d[i + 1] as number) - bgg),
        Math.abs((d[i + 2] as number) - bb),
      );
      if (dist > 32) lit++;
    }
  }
  const pixels = r.w * r.h;
  return {
    pixels,
    background: `#${bg.toString(16).padStart(3, '0')}`,
    lit: pixels ? lit / pixels : 0,
    colors: counts.size,
    white: pixels ? white / pixels : 0,
  };
}

/** Share of pixels that differ by more than `threshold` in some channel (same-size images). */
export function changedShare(a: RgbaImage, b: RgbaImage, threshold = 8): number {
  if (a.width !== b.width || a.height !== b.height) return 1;
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      Math.abs((a.data[i] as number) - (b.data[i] as number)) > threshold ||
      Math.abs((a.data[i + 1] as number) - (b.data[i + 1] as number)) > threshold ||
      Math.abs((a.data[i + 2] as number) - (b.data[i + 2] as number)) > threshold
    ) {
      changed++;
    }
  }
  return changed / (a.width * a.height);
}
