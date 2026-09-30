import { describe, expect, it } from 'vitest';
import {
  gaussianTaps,
  gaussianWeights,
  MAX_RADIUS,
  MAX_TAPS,
} from '../src/core/engine/passes/bloom';

/** Applies a folded (linear-sampling) kernel to a 1-D signal the way bilinear taps would. */
function foldedAt(signal: number[], x: number, taps: Float32Array, count: number): number {
  const at = (p: number) => {
    const c = Math.min(Math.max(p, 0), signal.length - 1);
    const i = Math.floor(c);
    const f = c - i;
    return (signal[i] ?? 0) * (1 - f) + (signal[Math.min(i + 1, signal.length - 1)] ?? 0) * f;
  };
  let acc = at(x) * (taps[1] as number);
  for (let k = 1; k < count; k++) {
    const o = taps[k * 2] as number;
    acc += (at(x + o) + at(x - o)) * (taps[k * 2 + 1] as number);
  }
  return acc;
}

/** Per-texel kernel (the RGBA8 path: texelFetch + decode, clamped to the edge). */
function perTexelAt(signal: number[], x: number, w: Float32Array, radius: number): number {
  const at = (i: number) => signal[Math.min(Math.max(i, 0), signal.length - 1)] ?? 0;
  let acc = at(x) * (w[0] as number);
  for (let i = 1; i <= radius; i++) acc += (at(x + i) + at(x - i)) * (w[i] as number);
  return acc;
}

describe('blur kernels', () => {
  it('per-texel weights are normalized and span the same radius as the folded taps', () => {
    for (const sigma of [0.3, 1.2, 2.5, 6 / 4, 5, 20]) {
      const w = new Float32Array(MAX_RADIUS + 1);
      const r = gaussianWeights(sigma, w);
      expect(r).toBeLessThanOrEqual(MAX_RADIUS);
      let sum = w[0] as number;
      for (let i = 1; i <= r; i++) sum += 2 * (w[i] as number);
      expect(sum).toBeCloseTo(1, 6);
      for (let i = r + 1; i <= MAX_RADIUS; i++) expect(w[i]).toBe(0);
    }
  });

  it('both kernels blur a single lit cell identically (energy kept on the RGBA8 path)', () => {
    const signal = new Array(64).fill(0);
    signal[32] = 1;
    for (const sigma of [0.6, 1.2, 3]) {
      const taps = new Float32Array(MAX_TAPS * 2);
      const count = gaussianTaps(sigma, taps);
      const w = new Float32Array(MAX_RADIUS + 1);
      const r = gaussianWeights(sigma, w);
      let a = 0;
      let b = 0;
      for (let x = 0; x < signal.length; x++) {
        const fa = foldedAt(signal, x, taps, count);
        const fb = perTexelAt(signal, x, w, r);
        expect(fb).toBeCloseTo(fa, 6);
        a += fa;
        b += fb;
      }
      expect(a).toBeCloseTo(1, 6);
      expect(b).toBeCloseTo(1, 6);
    }
  });
});
