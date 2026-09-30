/**
 * Plumbing shared by all passes: shader header assembly, fixed texture units and uniform block
 * bindings (set once after link, so per-frame work is just binds and draws).
 */

import type { GLCaps } from '../../gl/caps';
import { createProgramAsync, type PendingProgram, type Program } from '../../gl/program';
import { FRAME_BLOCK_GLSL } from '../frame-block';
import { COMMON_GLSL } from '../glsl/common';
import { PARAM_DEFAULTS_GLSL } from '../glsl/params';

export const UNIT_LIFE = 0;
export const UNIT_LUT = 1;
export const UNIT_FIELD_A = 2;
export const UNIT_FIELD_B = 3;
/** Combined bloom + haze (the only glow texture the composite samples). */
export const UNIT_GLOW = 4;
export const UNIT_HAZE = 5;
export const UNIT_SRC = 6;
/** Cell stamp (see passes/stamp.ts). */
export const UNIT_STAMP_A = 7;
export const UNIT_STAMP_B = 8;

export const BIND_PARAMS = 0;
export const BIND_FRAME = 1;

export function buildHeader(hdr: boolean, paramsPrelude: string): string {
  return `#version 300 es
precision highp float;
precision highp int;
precision mediump sampler2D;
#define HDR_RT ${hdr ? 1 : 0}
${paramsPrelude}
${PARAM_DEFAULTS_GLSL}
${FRAME_BLOCK_GLSL}
${COMMON_GLSL}
`;
}

export interface PassContext {
  readonly gl: WebGL2RenderingContext;
  readonly caps: GLCaps;
  /** #version, precision, HDR_RT, params prelude + fallbacks, FrameBlock and common GLSL. */
  readonly header: string;
}

/**
 * A program that becomes usable once linked. `setup` runs exactly once on link to bind uniform
 * blocks and sampler units (static state that never needs re-uploading).
 */
export class LazyProgram {
  private pending: PendingProgram | null;
  private program: Program | null = null;

  constructor(
    private readonly ctx: PassContext,
    vs: string,
    fs: string,
    label: string,
    private readonly setup: (p: Program) => void,
  ) {
    this.pending = createProgramAsync(ctx.gl, vs, fs, label, ctx.caps.parallelCompile);
  }

  /** True once linked; throws ShaderError on compile/link failure. */
  poll(): boolean {
    if (this.program) return true;
    if (!this.pending) return false;
    const p = this.pending.poll();
    if (!p) return false;
    this.pending = null;
    this.program = p;
    bindProgram(this.ctx.gl, p.handle);
    p.bindBlock('ParamsBlock', BIND_PARAMS);
    p.bindBlock('FrameBlock', BIND_FRAME);
    this.setup(p);
    return true;
  }

  get(): Program {
    if (!this.program) throw new Error('[lumicells] program used before link');
    return this.program;
  }

  /** Binds the program and returns it. */
  use(): Program {
    const p = this.get();
    bindProgram(this.ctx.gl, p.handle);
    return p;
  }

  dispose(): void {
    this.pending?.dispose();
    this.pending = null;
    this.program?.dispose();
    this.program = null;
  }
}

/** The single gl.useProgram call site (its name trips the React hooks lint rule). */
export function bindProgram(gl: WebGL2RenderingContext, handle: WebGLProgram): void {
  // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's useProgram, not a React hook.
  gl.useProgram(handle);
}

export function setSampler(gl: WebGL2RenderingContext, p: Program, name: string, unit: number) {
  const loc = p.uniform(name);
  if (loc) gl.uniform1i(loc, unit);
}

export function bindTexture(gl: WebGL2RenderingContext, unit: number, tex: WebGLTexture | null) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
}

// COLOR_ATTACHMENT0..2 (constant values, so the lists exist before a context does).
const DISCARD: readonly (readonly GLenum[])[] = [
  [],
  [0x8ce0],
  [0x8ce0, 0x8ce1],
  [0x8ce0, 0x8ce1, 0x8ce2],
];

/**
 * Tells the driver the bound framebuffer's first `count` color attachments are about to be fully
 * overwritten, so a tiled GPU skips loading their old contents into tile memory (no-op on other
 * GPUs, see GLCaps.tiled). Every cell pass rewrites its whole logical rect and nothing reads the
 * headroom texels outside it.
 */
export function discardTargets(ctx: PassContext, count = 1): void {
  if (!ctx.caps.tiled) return;
  ctx.gl.invalidateFramebuffer(ctx.gl.FRAMEBUFFER, DISCARD[count] as GLenum[]);
}
