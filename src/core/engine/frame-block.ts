/**
 * Frame UBO layout shared by the controller (fills a Float32Array) and the engine (GLSL).
 *
 * Everything that changes every frame lives here and is uploaded with one bufferSubData.
 * Offsets are in floats (4 per vec4, std140 arrays of vec4 have a 16-byte stride).
 */

export const MAX_INFLUENCES = 64;
export const MAX_PULSES = 16;
export const MAX_LIFTS = 128;

/** vec4 slots per influence / pulse record. */
export const INF_VEC4S = 3;
export const PULSE_VEC4S = 3;

// Header vec4 indices.
const V_PHASE_A = 0;
const V_PHASE_B = 1;
const V_CLOCK = 2;
const V_GRID = 3;
const V_ORIGIN = 4;
const V_HOST = 5;
const V_SPACE = 6;
const V_COUNTS = 7;
const V_MISC = 8;
const HEADER_VEC4S = 9;

/** x flow drift (mod 1024), y sphere rotation (rad), z sphere breathe (rad), w pulse phase (mod 1024). */
export const OFF_PHASE_A = V_PHASE_A * 4;
/** x wave phase (mod 1024), y vortex rotation (rad), z rain phase (mod 1024), w color drift (mod 1). */
export const OFF_PHASE_B = V_PHASE_B * 4;
/** x clock seconds (mod 4096), y life stepFrac, z energy (effective), w reducedMotion 0/1. */
export const OFF_CLOCK = V_CLOCK * 4;
/** x visible cols, y visible rows, z pitch (integer device px), w pad cells per side. */
export const OFF_GRID = V_GRID * 4;
/** xy canvas device px of the top-left corner of texel (0,0) incl. pad, zw canvas size device px. */
export const OFF_ORIGIN = V_ORIGIN * 4;
/** Host rect in canvas device px: x, y, w, h. */
export const OFF_HOST = V_HOST * 4;
/** xy host center device px, z 1/halfMinPx (px -> mode units), w cell size in mode units. */
export const OFF_SPACE = V_SPACE * 4;
/** x influences, y pulses, z sockets, w debugView. */
export const OFF_COUNTS = V_COUNTS * 4;
/** x previous color.mapping index, y mapping crossfade (1 = current only), z software 0/1, w 0. */
export const OFF_MISC = V_MISC * 4;

/**
 * Influences: 3 vec4 each.
 * [i*3+0] center.xy px, halfSize.xy px (radius-only: halfSize 0 and cornerRadius = radius)
 * [i*3+1] x cornerRadius px, y falloff px, z strength*presence, w type (0 light,1 shadow,2 lift,3 seed,4 repel)
 * [i*3+2] rgb linear color, a colorMix
 */
export const OFF_INF = HEADER_VEC4S * 4;
/**
 * Pulses: 3 vec4 each.
 * [i*3+0] center.xy px, z radius px, w width px
 * [i*3+1] x strength, y colorMix
 * [i*3+2] rgb linear color
 */
export const OFF_PULSE = OFF_INF + MAX_INFLUENCES * INF_VEC4S * 4;
/** Sockets: 1 vec4 each: xy source cell (texel coords incl. pad), z dim amount. */
export const OFF_SOCKET = OFF_PULSE + MAX_PULSES * PULSE_VEC4S * 4;

/** Total floats in the block: (9 + 192 + 48 + 128) * 4 = 1508 (6032 bytes). */
export const FRAME_FLOATS = OFF_SOCKET + MAX_LIFTS * 4;
export const FRAME_BYTES = FRAME_FLOATS * 4;

/** Influence type codes written to f_inf[i*3+1].w. */
export const INFLUENCE_TYPE = { light: 0, shadow: 1, lift: 2, seed: 3, repel: 4 } as const;

export const FRAME_BLOCK_GLSL = /* glsl */ `
#define MAX_INFLUENCES ${MAX_INFLUENCES}
#define MAX_PULSES ${MAX_PULSES}
#define MAX_LIFTS ${MAX_LIFTS}
layout(std140) uniform FrameBlock {
  vec4 f_phaseA;
  vec4 f_phaseB;
  vec4 f_clock;
  vec4 f_grid;
  vec4 f_origin;
  vec4 f_host;
  vec4 f_space;
  vec4 f_counts;
  vec4 f_misc;
  vec4 f_inf[MAX_INFLUENCES * ${INF_VEC4S}];
  vec4 f_pulse[MAX_PULSES * ${PULSE_VEC4S}];
  vec4 f_socket[MAX_LIFTS];
};
`;
