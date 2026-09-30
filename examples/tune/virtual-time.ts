/**
 * Deterministic time and randomness for the tuning page. Imported before 'lumicells' so the
 * shared ticker sees the patched requestAnimationFrame from its first frame.
 *
 * - `?seed=N`  replaces Math.random with a seeded PRNG (the controller seeds its own generator
 *              from Math.random, so lifts, life seeds and hashes repeat exactly between runs);
 * - `?virt=1`  (default) every rAF callback receives a virtual timestamp advancing by exactly
 *              1/60 s, so the clock, tweens and lift envelopes do not depend on the display rate.
 *              `virt=0` keeps real time (use it with the demo scene, whose WAAPI runs on real time).
 */

const params = new URLSearchParams(location.search);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

Math.random = mulberry32(Number(params.get('seed') ?? 7));

export const VIRTUAL = params.get('virt') !== '0';
export const STEP_MS = 1000 / 60;

/** Virtual milliseconds elapsed (advances only while frames are requested). */
export const virtualClock = { now: 1000 };

if (VIRTUAL) {
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb: FrameRequestCallback): number =>
    raf(() => {
      virtualClock.now += STEP_MS;
      cb(virtualClock.now);
    });
}
