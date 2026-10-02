/**
 * Contract between the (pure) controller and the (GL-only) engine.
 */

export type RenderQuality = 'high' | 'medium' | 'low';

/** Everything the engine needs for one frame. Buffers are owned and reused by the producer. */
export interface FrameInputs {
  /** Drawing buffer size in device px. */
  canvasWidth: number;
  canvasHeight: number;
  /** Visible grid cells; cell textures are (cols + 2*pad) x (rows + 2*pad). */
  cols: number;
  rows: number;
  pad: number;
  /** Integer device px. */
  pitchPx: number;
  /** ParamsBlock contents (layout.floatCount floats). Uploaded only when dirty. */
  params: Float32Array;
  paramsDirty: boolean;
  /** FrameBlock contents (FRAME_FLOATS floats). Uploaded every frame. */
  frame: Float32Array;
  /** 256 x 2 RGBA8 sRGB: row 0 base palette, row 1 hot tint. */
  lut: Uint8Array;
  lutDirty: boolean;
  /** Automaton steps due this frame (0..MAX_LIFE_STEPS); each runs with its own seed. */
  lifeSteps: number;
  lifeReset: boolean;
  lifeSeed: number;
  /** 0 conway, 1 highlife, 2 daynight, 3 seeds. */
  lifeRule: number;
  /** Spontaneous birth probability per cell per step. */
  lifeBirth: number;
  lifeSeedDensity: number;
  /** Lift instances, LIFT_STRIDE floats each (see LIFT_* offsets). */
  lifts: Float32Array;
  liftCount: number;
  /** Gaussian sigmas in cells; kernels are recomputed only when these change. */
  bloomSigma: number;
  hazeSigma: number;
  /**
   * glow.bloom.strength / glow.haze.strength (the same values the params block holds). When both
   * are 0 the engine skips the glow passes and the composite's glow lookup. Omitted = nonzero.
   */
  bloomStrength?: number;
  hazeStrength?: number;
  quality: RenderQuality;
  /**
   * Lite pipeline: the bloom and haze blurs run in the glow combine pass itself (2-D kernels at
   * cell resolution) instead of separable passes of their own: 2 glow passes instead of 5, a
   * very close look. Set by whoever owns the slot (the shared renderer for small or crowded
   * members, the facade for own instances at the 'low' tier). Omitted = full pipeline.
   */
  lite?: boolean;
  /** Overflow == 0: opaque output. */
  opaque: boolean;
  /** 0 final, 1 field, 2 halo, 3 bloom, 4 haze, 5 cells (no glow). */
  debugView: number;
  /**
   * Field features (engine/field-variants.ts) that tweens are about to turn on: the slot asks
   * for a field variant with them ahead of time (see Controller.setFieldGate). Omitted = none.
   */
  fieldPending?: number;
}

/** Floats per lift instance. */
/**
 * Most automaton steps one frame runs. A frame presented every few display frames (a shared
 * instance at a reduced rate, maxFps) carries the steps of the frames it skipped, up to this.
 */
export const MAX_LIFE_STEPS = 16;

export const LIFT_STRIDE = 12;
/** Source cell, texel coords including pad (same convention as f_socket). */
export const LIFT_CELL_X = 0;
export const LIFT_CELL_Y = 1;
/** Offset of the lifted body from its cell center, device px. */
export const LIFT_OFF_X = 2;
export const LIFT_OFF_Y = 3;
/** Body scale (includes landing squash). */
export const LIFT_SCALE_X = 4;
export const LIFT_SCALE_Y = 5;
/** 3D tilt, radians (rotation about the x and y axes). */
export const LIFT_TILT_X = 6;
export const LIFT_TILT_Y = 7;
/** Height 0..1.2 (spring overshoot allowed). */
export const LIFT_H = 8;
export const LIFT_ALPHA = 9;
/** Extra edge feather (bokeh), device px. */
export const LIFT_BLUR = 10;
export const LIFT_SEED = 11;

export const DEBUG_VIEW = { final: 0, field: 1, halo: 2, bloom: 3, haze: 4, cells: 5 } as const;

export interface EngineOptions {
  /** Output is opaque (overflow == 0): context is created with alpha:false. */
  opaque: boolean;
  /** GLSL from createParamLayout(): the ParamsBlock declaration plus P_* / E_* macros. */
  paramsPrelude: string;
  /** Number of vec4 in the ParamsBlock (layout.floatCount / 4). */
  paramsVec4Count: number;
  /** Called once when a shader fails to compile/link or a GPU resource cannot be created. */
  onError?: (error: Error) => void;
  /** Log params the engine expects but the prelude does not define (default true). */
  warnMissingParams?: boolean;
  /** Testing: use the RGBA8 (sqrt-encoded) targets even when float targets are available. */
  forceRgba8?: boolean;
}

export type EngineErrorCode = 'no-webgl2' | 'compile' | 'resource';

export class EngineError extends Error {
  constructor(
    readonly code: EngineErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'EngineError';
  }
}
