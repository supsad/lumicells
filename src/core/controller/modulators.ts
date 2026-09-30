/**
 * Runtime modulators: a layer on top of the tweened config that is never persisted or exported.
 *
 * Several modulators on one parameter compose in insertion order on top of the tweened value:
 * `effective = clamp(m_n(...m_1(tweened)))`. Sources are read once per frame, so a closure over
 * app state (hover amount, audio level, scroll) drives a knob without touching the config.
 */

export type ModBlend = 'add' | 'mul' | 'override' | 'max';
export type ModSource = number | (() => number) | { get(): number };

const BLEND_CODE: Record<ModBlend, number> = { add: 0, mul: 1, override: 2, max: 3 };

const SRC_NUMBER = 0;
const SRC_FUNCTION = 1;
const SRC_OBJECT = 2;

export class Modulator {
  readonly blend: number;
  /** Exponential smoothing half-life of the source in ms (0 = none). */
  readonly halfLifeMs: number;
  /** Smoothed source value. */
  value = 0;
  primed = false;
  disposed = false;
  // The source is split by kind so a numeric source lives in a double field: set(v) every
  // frame then writes in place instead of boxing a number into a mixed-type field.
  private kind = SRC_NUMBER;
  private num = 0;
  private fn: (() => number) | null = null;
  private obj: { get(): number } | null = null;

  constructor(source: ModSource, blend: ModBlend = 'add', smoothingMs = 0) {
    this.blend = BLEND_CODE[blend] ?? 0;
    this.halfLifeMs = smoothingMs > 0 ? smoothingMs : 0;
    this.setSource(source);
  }

  setSource(source: ModSource): void {
    if (typeof source === 'number') {
      this.kind = SRC_NUMBER;
      this.num = source;
    } else if (typeof source === 'function') {
      this.kind = SRC_FUNCTION;
      this.fn = source;
    } else {
      this.kind = SRC_OBJECT;
      this.obj = source;
    }
  }

  /**
   * Reads the source (non-finite readings keep the previous value) and smooths into `value`.
   * Until the first finite reading the modulator is not `primed` and composes as the identity.
   */
  sample(dtSec: number): void {
    let raw: number;
    if (this.kind === SRC_NUMBER) raw = this.num;
    else {
      try {
        raw =
          this.kind === SRC_FUNCTION
            ? (this.fn as () => number)()
            : (this.obj as { get(): number }).get();
      } catch {
        raw = Number.NaN;
      }
    }
    if (!Number.isFinite(raw)) return;
    if (!this.primed || this.halfLifeMs <= 0) {
      this.value = raw;
      this.primed = true;
    } else {
      const k = 1 - 2 ** ((-dtSec * 1000) / this.halfLifeMs);
      this.value += (raw - this.value) * k;
    }
  }
}

/**
 * Composes modulators over `base` in insertion order. Disposed ones are skipped, and so are
 * unprimed ones (no finite reading yet): they must not multiply by / override with 0.
 */
export function composeModulators(base: number, mods: readonly Modulator[], dtSec: number): number {
  let v = base;
  for (let i = 0; i < mods.length; i++) {
    const m = mods[i] as Modulator;
    if (m.disposed) continue;
    m.sample(dtSec);
    if (!m.primed) continue;
    const s = m.value;
    switch (m.blend) {
      case 1:
        v *= s;
        break;
      case 2:
        v = s;
        break;
      case 3:
        v = v > s ? v : s;
        break;
      default:
        v += s;
    }
  }
  return v;
}
