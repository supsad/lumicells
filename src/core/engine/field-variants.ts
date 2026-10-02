/**
 * Field program variants: the field pass compiles only the parts of its shader a look uses.
 *
 * The field shader holds every mode plus two costly color features (the noise color mapping and
 * the palette warp). Compiling all of it is what made a cold start slow on Windows: ANGLE's
 * Direct3D backend runs the shader through FXC, whose compile time grows much faster than the
 * code, and the field shader cost seconds there (see passes/field.ts). A variant leaves out every
 * mode whose weight is 0 and the features the look does not use; the result is bit-identical,
 * since the full shader skips those parts on the same conditions (a mode runs only above
 * MODE_WEIGHT_MIN, the warp only above 0, the noise mapping only when a mapping in use is it).
 *
 * A feature mask has one bit per mode (ENGINE_MODE_IDS order), then FEATURE_NOISE_MAP and
 * FEATURE_WARP. Per frame a slot works out two masks from its params and frame blocks:
 * - needed: what the full shader would evaluate this frame (a variant must cover it to draw the
 *   very same pixels);
 * - wanted: needed plus every mode with a nonzero weight, so a mode that starts tweening in from
 *   0 gets its variant compiled while its weight is still below MODE_WEIGHT_MIN.
 * The pass draws with the smallest ready variant that covers `needed`. When none does, it keeps
 * drawing with the variant the slot used last until the new one is ready; a slot with no usable
 * variant (its first frame) draws nothing yet.
 *
 * Live changes: a tween that turns a feature on (a mode weight leaving 0, the warp leaving 0, a
 * crossfade into the noise mapping) would otherwise run while the new variant compiles (hundreds
 * of milliseconds on Direct3D, more than the default transition) and the feature would appear
 * mid-tween, at near full weight. So the controller holds such tweens at their start while the
 * slot has no ready variant for them (Controller.setFieldGate, RenderSlot.fieldReady), and asks
 * for that variant ahead of time (FrameInputs.fieldPending): the look stays exactly as it was,
 * then the feature fades in over its whole transition, starting late by the compile time. A
 * change without a transition (transition 0) is not held: the feature appears once its variant
 * is ready.
 *
 * A known cost on ANGLE/Direct3D 11: once a new variant's background compile (FXC, on a worker
 * thread) is done, the GPU process's main thread spends 0.1-0.2 s in the flush that resolves its
 * link and issues its warm-up draw (a trace shows one 150-230 ms WebGL task there right after
 * the worker's D3DCompile, without ANGLE events inside: the driver creating the shader). The
 * page presents no frame meanwhile. It happens once per variant and browser shader cache; the
 * tween hold above keeps it out of the fade (the feature starts after it).
 *
 * Everything here is plain data, so the selection is unit-tested without a GPU.
 */

import { OFF_MISC } from './frame-block';
import { ENGINE_MODE_IDS } from './glsl/modes/index';

export const MODE_COUNT = ENGINE_MODE_IDS.length;
/** mapT's noise mapping (an fbm per cell, the costliest color feature). */
export const FEATURE_NOISE_MAP = 1 << MODE_COUNT;
/** The palette warp (another fbm per cell). */
export const FEATURE_WARP = 1 << (MODE_COUNT + 1);
export const ALL_FEATURES = (1 << (MODE_COUNT + 2)) - 1;

/** The shader evaluates a mode only above this weight (float32, as the GLSL literal 0.001). */
export const MODE_WEIGHT_MIN = Math.fround(0.001);
/** A mapping crossfade runs while f_misc.y is below this (float32, as in the shader). */
const CROSSFADE_END = Math.fround(0.999);
/** mapT takes its noise branch for a mapping index from this up (and for NaN). */
export const NOISE_MAPPING_FROM = 3.5;

/**
 * The schema leaf behind each feature bit: the mode weights (ENGINE_MODE_IDS order), then the
 * color mapping (FEATURE_NOISE_MAP) and the warp (FEATURE_WARP).
 */
export const FEATURE_LEAVES: readonly string[] = [
  ...ENGINE_MODE_IDS.map((id) => `modes.${id}.weight`),
  'color.mapping',
  'color.warp',
];

/**
 * Where a params prelude keeps a value: a float offset in the params block, or a constant (a
 * prelude may bake values in, see constantParamsPrelude). Unknown (NaN constant, offset -1)
 * counts as "in use", so a feature is never left out by mistake.
 */
export interface ParamSource {
  offset: number;
  constant: number;
}

/** What the field features depend on, parsed once per prelude (see parseFeatureSource). */
export interface FeatureSource {
  /** One per mode (ENGINE_MODE_IDS order): its weight. */
  readonly modeWeights: readonly ParamSource[];
  readonly mapping: ParamSource;
  readonly warp: ParamSource;
}

const SWIZZLE = 'xyzw';

/**
 * Finds `#define <name> <value>` in the prelude: `u_p[i].c` gives an offset, a number a
 * constant; anything else (or nothing: the shader then uses its built-in default, see
 * PARAM_DEFAULTS_GLSL) is `fallback`.
 */
function paramSource(prelude: string, name: string, fallback: number): ParamSource {
  const re = new RegExp(`#define\\s+${name}\\s+(\\S[^\\n]*)`);
  const m = re.exec(prelude);
  if (!m) return { offset: -1, constant: fallback };
  const value = (m[1] as string).trim();
  const slot = /^u_p\s*\[\s*(\d+)\s*\]\s*\.\s*([xyzw])$/.exec(value);
  if (slot) {
    return { offset: Number(slot[1]) * 4 + SWIZZLE.indexOf(slot[2] as string), constant: 0 };
  }
  const n = Number(value);
  return { offset: -1, constant: value !== '' && Number.isFinite(n) ? n : Number.NaN };
}

/**
 * Parses a params prelude (createParamLayout's glslPrelude, or a constant one). Values the
 * prelude does not define take the shader's defaults for them: modes and warp unknown (NaN, so
 * in use), mapping 0 (spatial).
 */
export function parseFeatureSource(prelude: string): FeatureSource {
  return {
    modeWeights: ENGINE_MODE_IDS.map((id) =>
      paramSource(prelude, `P_modes_${id}_weight`, Number.NaN),
    ),
    mapping: paramSource(prelude, 'P_color_mapping', 0),
    warp: paramSource(prelude, 'P_color_warp', Number.NaN),
  };
}

function read(params: Float32Array, s: ParamSource): number {
  return s.offset >= 0 ? (params[s.offset] ?? 0) : s.constant;
}

/** NaN reads as in use (the safe side) wherever a threshold decides. */
function above(v: number, min: number): boolean {
  return Number.isNaN(v) || v > min;
}

/**
 * The features the full field shader evaluates for these params and frame (see the header):
 * a variant must cover them to draw the same pixels. Allocation-free.
 */
export function neededFeatures(
  params: Float32Array,
  frame: Float32Array,
  src: FeatureSource,
): number {
  let mask = 0;
  const weights = src.modeWeights;
  for (let i = 0; i < weights.length; i++) {
    if (above(read(params, weights[i] as ParamSource), MODE_WEIGHT_MIN)) mask |= 1 << i;
  }
  // mapT(mapping), and mapT(previous mapping) while a mapping change crossfades.
  const mapping = read(params, src.mapping);
  const fade = frame[OFF_MISC + 1] ?? 1;
  const previous = frame[OFF_MISC] ?? 0;
  if (
    !(mapping < NOISE_MAPPING_FROM) ||
    (fade < CROSSFADE_END && !(previous < NOISE_MAPPING_FROM))
  ) {
    mask |= FEATURE_NOISE_MAP;
  }
  if (above(read(params, src.warp), 0)) mask |= FEATURE_WARP;
  return mask;
}

/**
 * `needed` plus every mode with a nonzero weight (one tweening in from 0 is not needed yet, but
 * soon will be: its variant is requested early). Allocation-free.
 */
export function wantedFeatures(params: Float32Array, src: FeatureSource, needed: number): number {
  let mask = needed;
  const weights = src.modeWeights;
  for (let i = 0; i < weights.length; i++) {
    if (above(read(params, weights[i] as ParamSource), 0)) mask |= 1 << i;
  }
  return mask;
}

/** True when a variant compiled with `mask` evaluates everything in `needed`. */
export function covers(mask: number, needed: number): boolean {
  return (mask & needed) === needed;
}

/** Set bits of a feature mask. */
export function featureCount(mask: number): number {
  let n = 0;
  for (let m = mask; m !== 0; m &= m - 1) n++;
  return n;
}

/** A variant as the selection sees it. */
export interface VariantState {
  readonly mask: number;
  /** Compiled, linked and warmed up: usable for a draw. */
  readonly ready: boolean;
  /** Last frame (device frame counter) a slot drew with it. */
  readonly lastUsed: number;
}

/**
 * Index of the variant a slot draws with: the ready variant covering `needed` with the fewest
 * features (ties: the most recently used); else `previous` (the one the slot drew with last)
 * while it is ready; else -1 (nothing to draw with yet).
 */
export function pickVariant(
  variants: readonly VariantState[],
  needed: number,
  previous: number,
): number {
  let best = -1;
  let bestCount = 0;
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i] as VariantState;
    if (!v.ready || !covers(v.mask, needed)) continue;
    const n = featureCount(v.mask);
    const b = variants[best];
    if (best < 0 || n < bestCount || (n === bestCount && b && v.lastUsed > b.lastUsed)) {
      best = i;
      bestCount = n;
    }
  }
  if (best >= 0) return best;
  const p = variants[previous];
  return p?.ready ? previous : -1;
}

/**
 * The mask to compile for a slot that wants `wanted`, or -1 when a variant (ready or still
 * compiling) already covers it.
 */
export function variantToRequest(variants: readonly VariantState[], wanted: number): number {
  for (let i = 0; i < variants.length; i++) {
    if (covers((variants[i] as VariantState).mask, wanted)) return -1;
  }
  return wanted;
}

/**
 * Index of the variant to delete before compiling another one when `max` variants exist: the
 * ready one used longest ago and not since `keepAfter` (a variant drawn with in that frame or
 * later is in use). -1 when there is room or nothing can go.
 */
export function variantToEvict(
  variants: readonly VariantState[],
  max: number,
  keepAfter: number,
): number {
  if (variants.length < max) return -1;
  let victim = -1;
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i] as VariantState;
    if (!v.ready || v.lastUsed >= keepAfter) continue;
    const c = variants[victim];
    if (!c || v.lastUsed < c.lastUsed) victim = i;
  }
  return victim;
}
