// Imperative WAAPI helpers for bubble motion. Only transform/translate/opacity are animated
// so nothing here triggers layout. Distances use cqmin (1 unit = 1% of the shorter scene side),
// so the motion scales with the container exactly like the CSS does.

const cq = (frac: number): string => `${(frac * 100).toFixed(3)}cqmin`;

let springCache: string | undefined;

/** Underdamped spring step response (~9% overshoot) as a CSS linear() easing, with a bezier fallback. */
export function springEasing(): string {
  if (springCache) return springCache;
  const supported =
    typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
      ? CSS.supports('animation-timing-function', 'linear(0, 1)')
      : false;
  if (!supported) {
    springCache = 'cubic-bezier(0.34, 1.45, 0.64, 1)';
    return springCache;
  }
  const zeta = 0.6;
  const omega = 11;
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  const n = 44;
  const pts: string[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const v =
      i === n
        ? 1
        : 1 -
          Math.exp(-zeta * omega * t) *
            (Math.cos(wd * t) + ((zeta * omega) / wd) * Math.sin(wd * t));
    pts.push(v.toFixed(4));
  }
  springCache = `linear(${pts.join(', ')})`;
  return springCache;
}

/** Small deterministic PRNG so the idle drift is stable between renders. */
export function seeded(seed: number): () => number {
  let a = (seed * 2654435761) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type FlightVector = { dx: number; dy: number }; // fractions of the stage side

function settle(anims: Animation[], onDone: () => void): void {
  Promise.all(anims.map((a) => a.finished)).then(onDone, () => {
    /* cancelled: the owner has already moved on */
  });
}

/** Fly from `from` (offset relative to the final position) to the resting place with a spring. */
export function flyIn(
  el: HTMLElement,
  from: FlightVector,
  opts: { delay: number; duration: number; reduced: boolean },
  onDone: () => void,
): Animation[] {
  const { delay, duration, reduced } = opts;
  const fade = el.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration: reduced ? 420 : Math.min(320, duration * 0.4),
    delay,
    easing: 'ease-out',
    fill: 'both',
  });
  const anims = [fade];
  if (!reduced) {
    anims.push(
      el.animate(
        [
          { transform: `translate(${cq(from.dx)}, ${cq(from.dy)}) scale(0.18)` },
          { transform: 'translate(0, 0) scale(1)' },
        ],
        { duration, delay, easing: springEasing(), fill: 'both' },
      ),
    );
  }
  settle(anims, () => {
    for (const a of anims) a.cancel(); // resting state equals the base CSS
    onDone();
  });
  return anims;
}

/** Fly to `to` while fading out. The elements stay hidden (fill forwards) until the caller resets them. */
export function flyOut(
  el: HTMLElement,
  to: FlightVector,
  opts: { delay: number; duration: number; reduced: boolean; scale: number },
  onDone: () => void,
): Animation[] {
  const { delay, duration, reduced, scale } = opts;
  const fade = el.animate([{ opacity: 1 }, { opacity: 1, offset: 0.35 }, { opacity: 0 }], {
    duration: reduced ? 380 : duration,
    delay,
    easing: 'linear',
    fill: 'both',
  });
  const anims = [fade];
  if (!reduced) {
    anims.push(
      el.animate(
        [
          { transform: 'translate(0, 0) scale(1)' },
          { transform: `translate(${cq(to.dx)}, ${cq(to.dy)}) scale(${scale})` },
        ],
        { duration, delay, easing: 'cubic-bezier(0.55, 0, 0.85, 0.35)', fill: 'both' },
      ),
    );
  }
  settle(anims, onDone);
  return anims;
}

/** Endless 2-6 s Lissajous-like drift around the resting place (starts and ends at the origin). */
export function startFloat(el: HTMLElement, seed: number): Animation {
  const rnd = seeded(seed + 11);
  const period = 2000 + rnd() * 4000;
  const ax = (0.7 + rnd() * 1.5) / 345; // reference px -> fraction of the stage
  const ay = (0.7 + rnd() * 1.5) / 345;
  const phase = rnd() * Math.PI * 2;
  const ky = rnd() > 0.5 ? 1 : 2;
  const steps = 24;
  const frames: Keyframe[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const x = ax * Math.sin(t);
    const y = ay * (Math.sin(ky * t + phase) - Math.sin(phase));
    frames.push({ translate: `${cq(x)} ${cq(y)}` });
  }
  return el.animate(frames, {
    duration: period,
    delay: rnd() * 900,
    iterations: Number.POSITIVE_INFINITY,
    easing: 'linear',
  });
}
