/**
 * Frame UBO layout shared by the controller (fills a Float32Array) and the engine (GLSL).
 *
 * Everything that changes every frame lives here; the engine uploads only the header and the
 * records in use (see frameUploadRanges). Offsets are in floats (4 per vec4, std140 arrays of
 * vec4 have a 16-byte stride).
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
const V_EPOCH_A = 9;
const V_EPOCH_B = 10;
const HEADER_VEC4S = 11;

/**
 * Epoch phases (sparsity re-rolls, flicker, sparkles, ripple slots) are accumulated on the CPU in
 * epochs and wrap at this many epochs. They are uploaded as (whole epochs, fraction), both exact
 * in fp32, and the shaders take epoch indices modulo the wrap, so crossing it continues the same
 * epoch sequence instead of re-rolling every cell (and the fraction keeps full precision).
 */
export const EPOCH_WRAP = 1 << 20;
/**
 * Flicker gives every cell its own rate: a multiple of 1/FLICKER_RATE_STEPS of the base rate,
 * so an EPOCH_WRAP jump of the base phase moves each cell by a whole number of its epochs.
 */
export const FLICKER_RATE_STEPS = 256;

/** x flow drift (mod 1024), y sphere rotation (rad), z sphere breathe (rad), w pulse phase (mod 1024). */
export const OFF_PHASE_A = V_PHASE_A * 4;
/** x wave phase (mod 1024), y vortex rotation (rad), z rain phase (mod 1024), w color drift (mod 2). */
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
/**
 * x previous color.mapping index, y mapping crossfade (1 = current only), z software 0/1,
 * w palette drift on 0/1 (drift rate or phase nonzero).
 */
export const OFF_MISC = V_MISC * 4;
/**
 * Epoch phases as (whole epochs mod EPOCH_WRAP, fraction): xy sparsity re-rolls (1/period),
 * zw sparkles (1/duration).
 */
export const OFF_EPOCH_A = V_EPOCH_A * 4;
/** Epoch phases: xy flicker (base rate), zw ripple slots (1/life). */
export const OFF_EPOCH_B = V_EPOCH_B * 4;

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

/** Total floats in the block: (11 + 192 + 48 + 128) * 4 = 1516 (6064 bytes). */
export const FRAME_FLOATS = OFF_SOCKET + MAX_LIFTS * 4;
export const FRAME_BYTES = FRAME_FLOATS * 4;

/** Two upload ranges separated by at most this many unused floats go up as one. */
export const UPLOAD_MERGE_GAP = 64;

/**
 * The parts of the block the shaders read this frame, as up to three [start, end) float ranges
 * written to `out` (pairs): header + used influences, used pulses, used sockets. Empty ranges are
 * skipped and ranges closer than UPLOAD_MERGE_GAP are merged. Returns the number of ranges.
 *
 * The records are fixed-size arrays, so a single prefix upload would have to run to the last
 * used socket: one live lift socket alone forced ~4 KB (the whole influence and pulse arrays).
 * Allocation-free.
 */
export function frameUploadRanges(frame: Float32Array, out: Int32Array): number {
  // Rounded like the shaders do: int(f_counts.x + 0.5).
  const count = (i: number, max: number) => {
    const v = Math.floor((frame[OFF_COUNTS + i] ?? 0) + 0.5);
    return v > 0 ? Math.min(v, max) : 0;
  };
  const nInf = count(0, MAX_INFLUENCES);
  const nPulse = count(1, MAX_PULSES);
  const nSock = count(2, MAX_LIFTS);
  let n = 0;
  const add = (start: number, end: number) => {
    if (end <= start) return;
    if (n > 0 && start - (out[n * 2 - 1] as number) <= UPLOAD_MERGE_GAP) {
      out[n * 2 - 1] = end;
      return;
    }
    out[n * 2] = start;
    out[n * 2 + 1] = end;
    n++;
  };
  add(0, OFF_INF + nInf * INF_VEC4S * 4);
  add(OFF_PULSE, OFF_PULSE + nPulse * PULSE_VEC4S * 4);
  add(OFF_SOCKET, OFF_SOCKET + nSock * 4);
  return n;
}

/**
 * Writes an epoch phase (epochs, in [0, EPOCH_WRAP)) as its whole part and fraction. Both are
 * exact in fp32; a single float would keep only ~0.1 epoch of precision near the wrap.
 */
export function writeEpochPhase(frame: Float32Array, offset: number, phase: number): void {
  const whole = Math.floor(phase);
  frame[offset] = whole;
  frame[offset + 1] = phase - whole;
}

/** Influence type codes written to f_inf[i*3+1].w. */
export const INFLUENCE_TYPE = { light: 0, shadow: 1, lift: 2, seed: 3, repel: 4 } as const;

export const FRAME_BLOCK_GLSL = /* glsl */ `
#define MAX_INFLUENCES ${MAX_INFLUENCES}
#define MAX_PULSES ${MAX_PULSES}
#define MAX_LIFTS ${MAX_LIFTS}
#define EPOCH_MASK ${EPOCH_WRAP - 1}u
#define FLICKER_RATE_STEPS ${FLICKER_RATE_STEPS}u
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
  vec4 f_epochA;
  vec4 f_epochB;
  vec4 f_inf[MAX_INFLUENCES * ${INF_VEC4S}];
  vec4 f_pulse[MAX_PULSES * ${PULSE_VEC4S}];
  vec4 f_socket[MAX_LIFTS];
};

// A loop bound the shader compiler cannot see through: n at run time (f_counts.x, a record
// count, is never negative). Loops whose body holds a gradient noise use it, so Direct3D's
// compiler (FXC, behind ANGLE) keeps them as loops instead of unrolling an inlined copy of the
// noise per iteration: its compile time grows much faster than the code it compiles.
#define RUNTIME_COUNT(n) ((n) + min(int(f_counts.x), 0))

// Hash epochs: the CPU accumulates each effect's phase in epochs (wrapped at EPOCH_WRAP) and
// uploads it as (whole epochs, fraction). Epoch indices are taken modulo the wrap, so crossing it
// continues the same epoch sequence; offset (a per-cell or per-slot shift, >= 0) is added to the
// fraction only, which keeps full fp32 precision. Returns the fraction, e = epoch index.
float epochAt(vec2 ph, float offset, out uint e) {
  float s = ph.y + offset;
  float fl = floor(s);
  e = (uint(ph.x) + uint(fl)) & EPOCH_MASK;
  return s - fl;
}
`;
