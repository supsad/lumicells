/**
 * Palette LUT: 256 x 2 RGBA8 (sRGB) texture data.
 * Row 0 is the palette ramp; row 1 the "hot" tint of the same hue (OKLCh L = 0.93, C * 0.35),
 * used for pastel cores of bright cells.
 *
 * The ramp is kept in OKLab and animated entry-wise toward the newly baked target, so palette
 * edits of any stop count and interrupted transitions blend smoothly without a second texture.
 *
 * Baked ramps (OKLab and the encoded bytes) are cached per palette and interpolation (a few
 * dozen, least recently used first out): a page mounting many instances with one palette bakes
 * it once.
 */

import { hexToRgb, srgbToLinear } from '../color';
import { hexToOklabInto, linearToOklabInto } from './math';

export const LUT_SIZE = 256;
export type LutInterpolation = 'oklab' | 'linear' | 'steps';

const HOT_L = 0.93;
const HOT_C = 0.35;

function srgbByte(lin: number): number {
  const c = lin <= 0 ? 0 : lin >= 1 ? 1 : lin;
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

/** Linear -> sRGB byte table (built on first use): the per-frame encode needs no pow(). */
const SRGB_STEPS = 8192;
let srgbTable: Uint8Array | null = null;
function srgbLut(): Uint8Array {
  if (!srgbTable) {
    srgbTable = new Uint8Array(SRGB_STEPS + 1);
    for (let i = 0; i <= SRGB_STEPS; i++) srgbTable[i] = srgbByte(i / SRGB_STEPS);
  }
  return srgbTable;
}

/** Bakes `palette` into `out` (LUT_SIZE OKLab triples). */
export function bakePaletteOklab(
  palette: readonly string[],
  interpolation: LutInterpolation,
  out: Float32Array,
): void {
  const n = palette.length;
  if (n === 0) {
    out.fill(0);
    return;
  }
  const stops = new Float64Array(n * 3);
  if (interpolation === 'linear') {
    for (let i = 0; i < n; i++) {
      const [r, g, b] = hexToRgb(palette[i] as string);
      stops[i * 3] = srgbToLinear(r);
      stops[i * 3 + 1] = srgbToLinear(g);
      stops[i * 3 + 2] = srgbToLinear(b);
    }
  } else {
    for (let i = 0; i < n; i++) hexToOklabInto(palette[i] as string, stops, i * 3);
  }
  const tmp = new Float64Array(3);
  for (let x = 0; x < LUT_SIZE; x++) {
    const t = x / (LUT_SIZE - 1);
    const o = x * 3;
    if (n === 1) {
      out[o] = stops[0] as number;
      out[o + 1] = stops[1] as number;
      out[o + 2] = stops[2] as number;
      continue;
    }
    if (interpolation === 'steps') {
      const i = Math.min(n - 1, Math.floor(t * n)) * 3;
      out[o] = stops[i] as number;
      out[o + 1] = stops[i + 1] as number;
      out[o + 2] = stops[i + 2] as number;
      continue;
    }
    const f = t * (n - 1);
    const i = Math.min(n - 2, Math.floor(f));
    const k = f - i;
    const a = i * 3;
    const b = a + 3;
    for (let c = 0; c < 3; c++) {
      tmp[c] = (stops[a + c] as number) + ((stops[b + c] as number) - (stops[a + c] as number)) * k;
    }
    if (interpolation === 'linear') {
      linearToOklabInto(tmp[0] as number, tmp[1] as number, tmp[2] as number, out, o);
    } else {
      out[o] = tmp[0] as number;
      out[o + 1] = tmp[1] as number;
      out[o + 2] = tmp[2] as number;
    }
  }
}

interface Baked {
  /** LUT_SIZE OKLab triples. */
  readonly oklab: Float32Array;
  /** The encoded texture bytes of that ramp. */
  readonly bytes: Uint8Array;
}

/** Palettes kept baked (least recently used first out). */
const BAKED_MAX = 32;
const baked = new Map<string, Baked>();
let bakeCount = 0;

/** How many palettes were baked so far (a cached one is not baked again). */
export function lutBakeCount(): number {
  return bakeCount;
}

function bakedRamp(palette: readonly string[], interpolation: LutInterpolation): Baked {
  const key = `${interpolation}|${palette.join(',')}`;
  let b = baked.get(key);
  if (b) {
    // Most recently used last.
    baked.delete(key);
    baked.set(key, b);
    return b;
  }
  bakeCount++;
  const oklab = new Float32Array(LUT_SIZE * 3);
  bakePaletteOklab(palette, interpolation, oklab);
  const bytes = new Uint8Array(LUT_SIZE * 2 * 4);
  encodeRamp(oklab, bytes, srgbLut());
  b = { oklab, bytes };
  baked.set(key, b);
  if (baked.size > BAKED_MAX) baked.delete(baked.keys().next().value as string);
  return b;
}

/** OKLab -> linear -> sRGB bytes for both rows, fully inline (runs every transition frame). */
function encodeRamp(cur: Float32Array, b: Uint8Array, tab: Uint8Array): void {
  const N = SRGB_STEPS;
  for (let x = 0; x < LUT_SIZE; x++) {
    const A0 = cur[x * 3 + 1] as number;
    const B0 = cur[x * 3 + 2] as number;
    for (let row = 0; row < 2; row++) {
      const L = row === 0 ? (cur[x * 3] as number) : HOT_L;
      const A = row === 0 ? A0 : A0 * HOT_C;
      const B = row === 0 ? B0 : B0 * HOT_C;
      const l0 = L + 0.3963377774 * A + 0.2158037573 * B;
      const m0 = L - 0.1055613458 * A - 0.0638541728 * B;
      const s0 = L - 0.0894841775 * A - 1.291485548 * B;
      const l = l0 * l0 * l0;
      const m = m0 * m0 * m0;
      const s = s0 * s0 * s0;
      const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
      const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
      const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
      const o = row * LUT_SIZE * 4 + x * 4;
      b[o] = tab[r <= 0 ? 0 : r >= 1 ? N : (r * N + 0.5) | 0] as number;
      b[o + 1] = tab[g <= 0 ? 0 : g >= 1 ? N : (g * N + 0.5) | 0] as number;
      b[o + 2] = tab[bl <= 0 ? 0 : bl >= 1 ? N : (bl * N + 0.5) | 0] as number;
      b[o + 3] = 255;
    }
  }
}

export class PaletteLut {
  /** Texture bytes: row 0 palette, row 1 hot tint. */
  readonly bytes = new Uint8Array(LUT_SIZE * 2 * 4);
  /** Set when `bytes` changed; cleared by the consumer after upload. */
  dirty = true;
  private readonly cur = new Float32Array(LUT_SIZE * 3);
  private readonly tgt = new Float32Array(LUT_SIZE * 3);
  private readonly srgb = srgbLut();
  private animating = false;
  private dur = 0;

  constructor(palette: readonly string[], interpolation: LutInterpolation) {
    const b = bakedRamp(palette, interpolation);
    this.tgt.set(b.oklab);
    this.cur.set(b.oklab);
    this.bytes.set(b.bytes);
  }

  get transitioning(): boolean {
    return this.animating;
  }

  /** Re-bakes the target; the ramp moves there over `durationMs` (<= 0: instantly). */
  setTarget(palette: readonly string[], interpolation: LutInterpolation, durationMs: number): void {
    const b = bakedRamp(palette, interpolation);
    this.tgt.set(b.oklab);
    if (durationMs > 0) {
      this.dur = durationMs;
      this.animating = true;
    } else {
      this.cur.set(b.oklab);
      this.animating = false;
      this.bytes.set(b.bytes);
      this.dirty = true;
    }
  }

  /** Advances the transition; returns true when the bytes changed. */
  update(dt: number): boolean {
    if (!this.animating) return false;
    const k = this.dur > 0 ? 1 - Math.exp((-dt * 5000) / this.dur) : 1;
    let done = true;
    const cur = this.cur;
    const tgt = this.tgt;
    for (let i = 0; i < cur.length; i++) {
      const t = tgt[i] as number;
      let v = cur[i] as number;
      v += (t - v) * k;
      if (Math.abs(t - v) < 1e-4) v = t;
      else done = false;
      cur[i] = v;
    }
    if (done) this.animating = false;
    this.encode();
    return true;
  }

  /** OKLab value of entry `x` (tests, debugging). */
  sampleOklab(x: number, out: Float64Array | number[]): void {
    const o = Math.max(0, Math.min(LUT_SIZE - 1, x | 0)) * 3;
    out[0] = this.cur[o] as number;
    out[1] = this.cur[o + 1] as number;
    out[2] = this.cur[o + 2] as number;
  }

  private encode(): void {
    encodeRamp(this.cur, this.bytes, this.srgb);
    this.dirty = true;
  }
}
