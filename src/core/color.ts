/**
 * Color helpers shared by the renderer and the stand.
 *
 * Palettes are authored in sRGB hex, interpolated in OKLab (perceptually even, no muddy
 * midpoints between complementary neon colors) and baked into a small ramp texture.
 */

export type RGB = [r: number, g: number, b: number];

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_RE.test(value.trim());
}

/** Parses `#rgb` / `#rrggbb` into sRGB components in 0..1. Invalid input yields black. */
export function hexToRgb(hex: string): RGB {
  const m = HEX_RE.exec(hex.trim());
  if (!m?.[1]) return [0, 0, 0];
  let h = m[1];
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  const n = Number.parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex([r, g, b]: RGB): string {
  const to = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** Normalizes any valid hex to lowercase `#rrggbb`. */
export function normalizeHex(hex: string): string {
  return rgbToHex(hexToRgb(hex));
}

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

/** Linear sRGB -> OKLab. */
export function linearToOklab([r, g, b]: RGB): RGB {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab -> linear sRGB (may fall slightly outside 0..1, callers clamp). */
export function oklabToLinear([L, a, b]: RGB): RGB {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

export type PaletteInterpolation = 'oklab' | 'linear' | 'steps';

/**
 * Samples a palette at `t` in 0..1 and returns sRGB 0..1.
 * A single color palette is a flat ramp; `steps` gives hard bands (posterized look).
 */
export function samplePalette(
  palette: readonly string[],
  t: number,
  interpolation: PaletteInterpolation = 'oklab',
): RGB {
  const n = palette.length;
  if (n === 0) return [0, 0, 0];
  if (n === 1) return hexToRgb(palette[0] as string);
  const x = Math.min(1, Math.max(0, t));
  if (interpolation === 'steps') {
    const i = Math.min(n - 1, Math.floor(x * n));
    return hexToRgb(palette[i] as string);
  }
  const f = x * (n - 1);
  const i = Math.min(n - 2, Math.floor(f));
  const k = f - i;
  const a = hexToRgb(palette[i] as string).map(srgbToLinear) as RGB;
  const b = hexToRgb(palette[i + 1] as string).map(srgbToLinear) as RGB;
  let lin: RGB;
  if (interpolation === 'oklab') {
    const la = linearToOklab(a);
    const lb = linearToOklab(b);
    lin = oklabToLinear([
      la[0] + (lb[0] - la[0]) * k,
      la[1] + (lb[1] - la[1]) * k,
      la[2] + (lb[2] - la[2]) * k,
    ]);
  } else {
    lin = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  }
  return lin.map((c) => linearToSrgb(Math.min(1, Math.max(0, c)))) as RGB;
}

/**
 * Bakes a palette into an RGBA8 ramp of `width` texels (sRGB encoded, alpha = 255).
 * Upload as a width x 1 texture with LINEAR filtering and CLAMP_TO_EDGE wrapping.
 */
export function bakePaletteRamp(
  palette: readonly string[],
  interpolation: PaletteInterpolation = 'oklab',
  width = 256,
): Uint8Array {
  const out = new Uint8Array(width * 4);
  for (let x = 0; x < width; x++) {
    const [r, g, b] = samplePalette(palette, width === 1 ? 0 : x / (width - 1), interpolation);
    const o = x * 4;
    out[o] = Math.round(r * 255);
    out[o + 1] = Math.round(g * 255);
    out[o + 2] = Math.round(b * 255);
    out[o + 3] = 255;
  }
  return out;
}
