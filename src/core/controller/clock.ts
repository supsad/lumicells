/**
 * Phase accumulators. Time is never uploaded raw: each phase is advanced on the CPU in double
 * precision and wrapped to a period the shaders cross without a visible jump (noise lattices
 * repeat every 1024 units, rotations every 2pi, the palette fold every 2, hash epochs are indexed
 * modulo EPOCH_WRAP), so fp32 on the GPU keeps full precision after days of uptime.
 */

import { EPOCH_WRAP } from '../engine/frame-block';
import { TAU, wrap } from './math';

export { EPOCH_WRAP };

export const NOISE_PERIOD = 1024;
export const CLOCK_PERIOD = 4096;
/** The palette fold tri() in the field pass repeats every 2: the drift phase wraps there. */
export const DRIFT_PERIOD = 2;

/** Per-frame rates (units per second, already multiplied by the global speed). */
export interface ClockRates {
  /** Global time scale (animation.speed, reduced-motion damped). */
  speed: number;
  flow: number;
  /** rad/s */
  sphereRotation: number;
  /** Hz */
  sphereBreathe: number;
  pulse: number;
  wave: number;
  /** rad/s */
  vortex: number;
  rain: number;
  /** color.drift: palette positions per second (the fold makes a there-and-back sweep 2 units). */
  drift: number;
  /** Life steps per second (0 = paused). */
  lifeRate: number;
  /** Epochs per second of the hash-epoch effects: sparsity re-rolls (1/period). */
  sparsity: number;
  /** Flicker base rate (Hz); cells run at 0.6..1.4x of it. */
  flicker: number;
  /** Sparkle epochs (1/duration). */
  sparkle: number;
  /** Ripple slot epochs (1/life). */
  ripple: number;
}

export class Clock {
  flow = 0;
  sphereRotation = 0;
  sphereBreathe = 0;
  pulse = 0;
  wave = 0;
  vortex = 0;
  rain = 0;
  drift = 0;
  /** Scaled clock seconds (mod CLOCK_PERIOD): time axis of the noise lattices only. */
  seconds = 0;
  /**
   * Epoch phases (mod EPOCH_WRAP). Accumulated rather than derived from `seconds`: a wrap of
   * `seconds` would move them by a fractional number of epochs (every cell re-rolls at once), and
   * a rate or period change would jump them by `seconds * change`.
   */
  sparsity = 0;
  flicker = 0;
  sparkle = 0;
  ripple = 0;
  /** Unwrapped scaled seconds (CPU-only envelopes). */
  elapsed = 0;
  lifeAcc = 0;
  /** Life steps due this frame (0..2). */
  lifeSteps = 0;

  advance(dt: number, r: ClockRates): void {
    const s = dt * r.speed;
    this.seconds = wrap(this.seconds + s, CLOCK_PERIOD);
    this.elapsed += s;
    this.flow = wrap(this.flow + s * r.flow, NOISE_PERIOD);
    this.sphereRotation = wrap(this.sphereRotation + s * r.sphereRotation, TAU);
    this.sphereBreathe = wrap(this.sphereBreathe + s * r.sphereBreathe * TAU, TAU);
    this.pulse = wrap(this.pulse + s * r.pulse, NOISE_PERIOD);
    this.wave = wrap(this.wave + s * r.wave, NOISE_PERIOD);
    this.vortex = wrap(this.vortex + s * r.vortex, TAU);
    this.rain = wrap(this.rain + s * r.rain, NOISE_PERIOD);
    this.drift = wrap(this.drift + s * r.drift, DRIFT_PERIOD);
    this.sparsity = wrap(this.sparsity + s * r.sparsity, EPOCH_WRAP);
    this.flicker = wrap(this.flicker + s * r.flicker, EPOCH_WRAP);
    this.sparkle = wrap(this.sparkle + s * r.sparkle, EPOCH_WRAP);
    this.ripple = wrap(this.ripple + s * r.ripple, EPOCH_WRAP);
    this.lifeSteps = 0;
    if (r.lifeRate > 0) {
      this.lifeAcc += s * r.lifeRate;
      // At most two automaton steps per frame; a long stall must not fast-forward the sim.
      while (this.lifeAcc >= 1 && this.lifeSteps < 2) {
        this.lifeAcc -= 1;
        this.lifeSteps++;
      }
      if (this.lifeAcc >= 1) this.lifeAcc %= 1;
    }
  }
}
