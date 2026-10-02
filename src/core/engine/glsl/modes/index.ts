/**
 * Mode library. Every mode is `vec3 mode_<id>(ModeIn m)` returning
 * (intensity, low-frequency envelope, accent). The envelope drives sparsity and dead-cell
 * visibility; accent is an optional hue cue (only the sphere uses it).
 *
 * ModeIn: p = aspect-correct composition space (1.0 = half the host's shorter side, y down),
 * r = |p|, cs = cell size in the same units (for band-limiting), cell = texel, h = cell hash.
 */

import { FLOW_GLSL } from './flow';
import { LIFE_GLSL } from './life';
import { PULSE_GLSL } from './pulse';
import { RAIN_GLSL } from './rain';
import { RIPPLE_GLSL } from './ripple';
import { SPHERE_GLSL } from './sphere';
import { VORTEX_GLSL } from './vortex';
import { WAVE_GLSL } from './wave';

/** Mode ids in schema order (must match the schema's MODE_IDS). */
export const ENGINE_MODE_IDS = [
  'flow',
  'sphere',
  'pulse',
  'wave',
  'ripple',
  'vortex',
  'life',
  'rain',
] as const;

export type EngineModeId = (typeof ENGINE_MODE_IDS)[number];

const MODE_SOURCES: Record<EngineModeId, string> = {
  flow: FLOW_GLSL,
  sphere: SPHERE_GLSL,
  pulse: PULSE_GLSL,
  wave: WAVE_GLSL,
  ripple: RIPPLE_GLSL,
  vortex: VORTEX_GLSL,
  life: LIFE_GLSL,
  rain: RAIN_GLSL,
};

export const MODE_STRUCT_GLSL = /* glsl */ `
struct ModeIn {
  vec2 p;
  float r;
  float cs;
  ivec2 cell;
  float h;
};
`;

/** Every mode in a feature mask (bit i = ENGINE_MODE_IDS[i], see field-variants.ts). */
export const ALL_MODES = (1 << ENGINE_MODE_IDS.length) - 1;

const included = (modes: number) => ENGINE_MODE_IDS.filter((_, i) => (modes & (1 << i)) !== 0);

/**
 * The functions of the modes in `modes` (expects ModeIn, the noise chunk and
 * `uniform sampler2D u_life`).
 */
export function modesGlsl(modes = ALL_MODES): string {
  return included(modes)
    .map((id) => MODE_SOURCES[id])
    .join('\n');
}

/**
 * GLSL statements that evaluate each mode of `modes` whose weight is above 0.001 (a uniform
 * branch, so disabled modes cost nothing) and accumulate into `Mix x` via addMode(), in
 * ENGINE_MODE_IDS order whatever the subset. The threshold is MODE_WEIGHT_MIN (field-variants.ts).
 */
export function modesEvalGlsl(modes = ALL_MODES): string {
  return included(modes)
    .map(
      (id) =>
        `  if (P_modes_${id}_weight > 0.001) addMode(x, P_modes_${id}_weight, mode_${id}(m));`,
    )
    .join('\n');
}
