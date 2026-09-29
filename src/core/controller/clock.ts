/**
 * Phase accumulators. Time is never uploaded raw: each phase is advanced on the CPU in double
 * precision and wrapped to its period (noise lattices repeat every 1024 units, rotations every
 * 2pi), so fp32 on the GPU keeps full sub-cell precision after days of uptime.
 */

import { TAU, wrap } from './math';

export const NOISE_PERIOD = 1024;
export const CLOCK_PERIOD = 4096;

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
  /** Palette cycles per second. */
  drift: number;
  /** Life steps per second (0 = paused). */
  lifeRate: number;
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
  /** Scaled clock seconds (mod CLOCK_PERIOD): hash epochs of flicker/sparkle/sparsity/ripple. */
  seconds = 0;
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
    this.drift = wrap(this.drift + s * r.drift, 1);
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
