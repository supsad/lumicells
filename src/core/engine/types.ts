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
  lifeStep: boolean;
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
  quality: RenderQuality;
  /** Overflow == 0: opaque output. */
  opaque: boolean;
  /** 0 final, 1 field, 2 halo, 3 bloom, 4 haze, 5 cells (no glow). */
  debugView: number;
}

/** Floats per lift instance. */
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
