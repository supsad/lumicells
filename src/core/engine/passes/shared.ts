/**
 * Plumbing shared by all passes: shader header assembly, fixed texture units and uniform block
 * bindings (set once after link, so per-frame work is just binds and draws).
 */

import type { GLCaps, TextureFormat } from '../../gl/caps';
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
/** The field pass's intermediate texels (staged pass, see passes/field.ts). */
export const UNIT_STAGE = 9;
export const UNIT_REST_COLOR = 10;
export const UNIT_REST_SCALAR = 11;

export const BIND_PARAMS = 0;
export const BIND_FRAME = 1;

/**
 * MRT_PAD (ANGLE on Direct3D only, GLCaps.d3d): a program with several outputs declares an unused
 * output at location 0 (mrtOutputs) and draws with no draw buffer there: its targets start at
 * COLOR_ATTACHMENT1 (mrtFirst).
 *
 * ANGLE's D3D11 backend compiles a program's pixel shader at link time (on a worker thread with
 * KHR_parallel_shader_compile) for an output layout it takes from the shader's first output
 * alone, then compiles it again on the first draw for the layout the framebuffer actually has (on
 * the GPU process's main thread). For an MRT program the link-time shader is never used, and the
 * field shader paid seconds for it before its real one could even start. With an unused output
 * first, the link-time shader writes only that output: everything else is dead code and it
 * compiles in a fraction of the time. The real shader is then compiled once, by the warm-up draw
 * (see GpuDevice). Other backends compile one shader per program at link time: no pad there.
 */
export function buildHeader(hdr: boolean, paramsPrelude: string, mrtPad = false): string {
  return `#version 300 es
precision highp float;
precision highp int;
precision mediump sampler2D;
#define HDR_RT ${hdr ? 1 : 0}
#define MRT_PAD ${mrtPad ? 1 : 0}
${paramsPrelude}
${PARAM_DEFAULTS_GLSL}
${FRAME_BLOCK_GLSL}
${COMMON_GLSL}
`;
}

export interface PassContext {
  readonly gl: WebGL2RenderingContext;
  readonly caps: GLCaps;
  /** #version, precision, HDR_RT, MRT_PAD, params prelude + fallbacks, FrameBlock and common GLSL. */
  readonly header: string;
  /** The header was built with MRT_PAD (see buildHeader). */
  readonly mrtPad: boolean;
  /** Every program created with this context, in creation order (see GpuDevice). */
  readonly programs?: LazyProgram[];
}

/** First color attachment of an MRT program's targets (1 behind the MRT_PAD output). */
export function mrtFirst(ctx: PassContext): number {
  return ctx.mrtPad ? 1 : 0;
}

/** Output declarations of an MRT program: `names` at consecutive locations after the pad. */
export function mrtOutputs(names: readonly string[]): string {
  const at = (first: number) =>
    names.map((n, i) => `layout(location = ${first + i}) out vec4 ${n};`).join('\n');
  return `#if MRT_PAD
layout(location = 0) out vec4 o_pad;
${at(1)}
#else
${at(0)}
#endif`;
}

/** Statement writing the MRT_PAD output (none without the pad). */
export const MRT_PAD_WRITE = `#if MRT_PAD
  o_pad = vec4(0.0);
#endif`;

/**
 * Scratch targets of the warm-up draws (see GpuDevice): 1x1 textures of the formats a pass
 * renders to, so the draw reaches the very shader variant its real draws use.
 */
export interface WarmTargets {
  /** A framebuffer with one texture per format, attached from COLOR_ATTACHMENT0 + `first`. */
  framebuffer(formats: readonly TextureFormat[], first?: number): WebGLFramebuffer;
}

/** A warm-up draw: `prog` once, a fullscreen triangle into a 1x1 viewport of `fb`. */
export function warmDraw(ctx: PassContext, prog: LazyProgram, fb: WebGLFramebuffer): void {
  const gl = ctx.gl;
  prog.use();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.viewport(0, 0, 1, 1);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

/**
 * A program that becomes usable once linked. `setup` runs exactly once on link to bind uniform
 * blocks and sampler units (static state that never needs re-uploading).
 */
export class LazyProgram {
  private pending: PendingProgram | null;
  private program: Program | null = null;
  /** When the compile was submitted, ms (performance.now). */
  readonly submitted = performance.now();
  /** From submission to the poll that found it linked (-1 before), ms. */
  linkMs = -1;

  constructor(
    private readonly ctx: PassContext,
    vs: string,
    fs: string,
    label: string,
    private readonly setup: (p: Program) => void,
  ) {
    this.pending = createProgramAsync(ctx.gl, vs, fs, label, ctx.caps.parallelCompile);
    ctx.programs?.push(this);
  }

  /** Linked by now, set up or not (non-blocking: see PendingProgram.completed). */
  completed(): boolean {
    return this.program !== null || (this.pending?.completed() ?? false);
  }

  /** True once linked; throws ShaderError on compile/link failure. */
  poll(): boolean {
    if (this.program) return true;
    if (!this.pending) return false;
    const p = this.pending.poll();
    if (!p) return false;
    this.linkMs = performance.now() - this.submitted;
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

// COLOR_ATTACHMENT0.. (constant values, so the lists exist before a context does), by first
// attachment and count.
const ATTACHMENT0 = 0x8ce0;
const DISCARD: readonly (readonly (readonly GLenum[])[])[] = [0, 1].map((first) =>
  [0, 1, 2, 3].map((count) => Array.from({ length: count }, (_, i) => ATTACHMENT0 + first + i)),
);

/**
 * Tells the driver the bound framebuffer's `count` color attachments from `first` on are about
 * to be fully overwritten, so a tiled GPU skips loading their old contents into tile memory
 * (no-op on other GPUs, see GLCaps.tiled). Every cell pass rewrites its whole logical rect and
 * nothing reads the headroom texels outside it.
 */
export function discardTargets(ctx: PassContext, count = 1, first = 0): void {
  if (!ctx.caps.tiled) return;
  ctx.gl.invalidateFramebuffer(ctx.gl.FRAMEBUFFER, DISCARD[first]?.[count] as GLenum[]);
}
