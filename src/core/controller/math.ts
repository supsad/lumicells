/**
 * Small allocation-free numeric helpers shared by the controller modules.
 */

import { hexToRgb, srgbToLinear } from '../color';

export const TAU = Math.PI * 2;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function sat(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = sat((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

export function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Positive modulo: the result is always in [0, period). */
export function wrap(v: number, period: number): number {
  const r = v % period;
  return r < 0 ? r + period : r;
}

/** Signed shortest angular difference `to - from` in degrees, in [-180, 180). */
export function shortestArcDeg(from: number, to: number): number {
  return wrap(to - from + 180, 360) - 180;
}

/**
 * Exponential approach factor for one step: reaches ~99.3% of the target after `durationMs`
 * (5 time constants), independent of the frame rate.
 */
export function tweenK(dtSec: number, durationMs: number): number {
  if (!(durationMs > 0)) return 1;
  return 1 - Math.exp((-dtSec * 5000) / durationMs);
}

/** Seeded PRNG (mulberry32): fast, 32-bit state, good enough for visual randomness. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------
// OKLab conversions writing into caller-owned arrays (the color.ts versions allocate tuples).

export type Vec3Out = { [i: number]: number };

export function linearToOklabInto(r: number, g: number, b: number, out: Vec3Out, o = 0): void {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  out[o] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  out[o + 1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  out[o + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
}

export function oklabToLinearInto(L: number, a: number, b: number, out: Vec3Out, o = 0): void {
  const l0 = L + 0.3963377774 * a + 0.2158037573 * b;
  const m0 = L - 0.1055613458 * a - 0.0638541728 * b;
  const s0 = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l0 * l0 * l0;
  const m = m0 * m0 * m0;
  const s = s0 * s0 * s0;
  out[o] = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  out[o + 1] = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  out[o + 2] = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
}

/** Hex -> linear sRGB into `out`. Not for per-frame use with changing strings (parses). */
export function hexToLinearInto(hex: string, out: Vec3Out, o = 0): void {
  const [r, g, b] = hexToRgb(hex);
  out[o] = srgbToLinear(r);
  out[o + 1] = srgbToLinear(g);
  out[o + 2] = srgbToLinear(b);
}

export function hexToOklabInto(hex: string, out: Vec3Out, o = 0): void {
  const [r, g, b] = hexToRgb(hex);
  linearToOklabInto(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b), out, o);
}
