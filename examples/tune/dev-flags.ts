/**
 * Dev-only switches for the tuning page (imported before 'pixel-life' creates anything).
 *
 * - `?ldr=1`        hides EXT_color_buffer_float / EXT_color_buffer_half_float, so the engine
 *                   takes its RGBA8 (sqrt-encoded) fallback targets, like a device without float
 *                   render targets. Compare against the same URL without it for HDR parity.
 * - `?prewrap=2`    on the first clock advance, moves every wrapped phase of the controller clock
 *                   (noise and mode phases, rotations, palette drift, the 4096 s clock and the
 *                   per-effect epoch phases) to `prewrap` scaled seconds before its wrap point,
 *                   so all wraps happen together at t = prewrap. Render frames right before and
 *                   after that moment to check that nothing pops (see the engine-fix notes).
 */

import type { ClockRates } from '../../src/core/controller/clock';
import * as clockModule from '../../src/core/controller/clock';

const params = new URLSearchParams(location.search);

if (params.get('ldr') === '1') {
  const hidden = new Set(['EXT_color_buffer_float', 'EXT_color_buffer_half_float']);
  const proto = WebGL2RenderingContext.prototype;
  type GetExtension = (this: WebGL2RenderingContext, name: string) => unknown;
  const getExtension = proto.getExtension as GetExtension;
  proto.getExtension = function (this: WebGL2RenderingContext, name: string) {
    return hidden.has(name) ? null : getExtension.call(this, name);
  } as typeof proto.getExtension;
}

const lead = Number(params.get('prewrap') ?? 0);
if (lead > 0) {
  const TAU = Math.PI * 2;
  const mod = clockModule as Record<string, unknown>;
  const num = (key: string, fallback: number) =>
    typeof mod[key] === 'number' ? (mod[key] as number) : fallback;
  const noise = num('NOISE_PERIOD', 1024);
  const clockPeriod = num('CLOCK_PERIOD', 4096);
  const drift = num('DRIFT_PERIOD', 1);
  const epoch = num('EPOCH_WRAP', 1048576);
  type Rates = ClockRates & Record<string, number>;
  // [clock field, wrap period, phase units per scaled second]
  const table: [string, number, (r: Rates) => number][] = [
    ['flow', noise, (r) => r.flow],
    ['sphereRotation', TAU, (r) => r.sphereRotation],
    ['sphereBreathe', TAU, (r) => r.sphereBreathe * TAU],
    ['pulse', noise, (r) => r.pulse],
    ['wave', noise, (r) => r.wave],
    ['vortex', TAU, (r) => r.vortex],
    ['rain', noise, (r) => r.rain],
    ['drift', drift, (r) => r.drift],
    ['seconds', clockPeriod, () => 1],
    ['sparsity', epoch, (r) => r.sparsity ?? 0],
    ['flicker', epoch, (r) => r.flicker ?? 0],
    ['sparkle', epoch, (r) => r.sparkle ?? 0],
    ['ripple', epoch, (r) => r.ripple ?? 0],
  ];
  const proto = clockModule.Clock.prototype as unknown as {
    advance(this: Record<string, number>, dt: number, r: Rates): void;
  };
  const advance = proto.advance;
  const primed = new WeakSet<object>();
  proto.advance = function (dt, r) {
    if (!primed.has(this)) {
      primed.add(this);
      for (const [key, period, rate] of table) {
        if (typeof this[key] !== 'number') continue;
        const v = -lead * r.speed * rate(r);
        this[key] = ((v % period) + period) % period;
      }
      console.info(`[tune] clock primed ${lead} s before its wraps`);
    }
    advance.call(this, dt, r);
  };
}
