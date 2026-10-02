/**
 * Lift pass: instanced quads for the few "popped out" cells (<= MAX_LIFTS), drawn over the
 * composite with premultiplied blending (ONE, ONE_MINUS_SRC_ALPHA).
 *
 * The vertex shader reads the source cell's color / intensity from the field textures, gates the
 * lift out when its cell went dark, and applies a 3D tilt with perspective (focal length of three
 * body sizes). Plane coordinates are interpolated perspective-correctly, so the fragment shader
 * evaluates the rounded body, a soft shadow and a wider halo in the lifted plane.
 *
 * Everything constant per instance (the tonemapped body color, the halo color direction) is
 * computed in the vertex shader and passed flat. The quad covers exactly the region where the
 * output can be nonzero: the body plus the larger of the halo and shadow margins (none while the
 * lift sits on its cell), not their sum.
 *
 * The program and its vertex array belong to the device and are shared by every slot; the
 * instance buffer belongs to the slot (createLiftBuffer) and the vertex array is re-pointed at it
 * only when a different slot draws lifts. Positions are relative to the slot's region (u_region),
 * like the composite's.
 */

import { MAX_LIFTS } from '../frame-block';
import { REGION_PIXEL_GLSL, type Region } from '../region';
import { LIFT_STRIDE } from '../types';
import {
  LazyProgram,
  type PassContext,
  setSampler,
  UNIT_FIELD_A,
  UNIT_FIELD_B,
  UNIT_LUT,
  type WarmTargets,
} from './shared';

function liftVs(header: string): string {
  return `${header}
layout(location = 0) in vec4 a_i0;  // cellX, cellY, offX, offY
layout(location = 1) in vec4 a_i1;  // scaleX, scaleY, tiltX, tiltY
layout(location = 2) in vec4 a_i2;  // h, alpha, blur, seed
uniform sampler2D u_fieldA;
uniform sampler2D u_fieldB;
uniform sampler2D u_lut;
uniform vec4 u_cellTex;
uniform vec4 u_region;  // xy region origin in the framebuffer (GL bottom-left, device px), zw size
out vec2 v_plane;
flat out vec4 v_body;  // rgb body color (tonemapped, sRGB), a unused
flat out vec4 v_halo;  // rgb halo color per unit of kernel (linear, exposure applied), a unused
flat out vec4 v_geo;   // xy body half extents px, z height, w edge feather px
flat out vec4 v_misc;  // xy shadow offset px, z alpha, w corner radius px

#ifdef P_lift_threshold
#define LIFT_GATE_HI P_lift_threshold
#else
#define LIFT_GATE_HI 0.2
#endif

void main() {
  ivec2 lim = ivec2(u_cellTex.xy) - 1;
  ivec2 cell = clamp(ivec2(floor(a_i0.xy + 0.5)), ivec2(0), lim);
  vec4 A = dec4(texelFetch(u_fieldA, cell, 0));
  vec4 B = texelFetch(u_fieldB, cell, 0);
  float Ipre = B.a * 2.0;
  float h = a_i2.x;
  // Fade the copy out when its source cell goes dark (it would float over nothing).
  float gate = smoothstep(0.5 * LIFT_GATE_HI, LIFT_GATE_HI, Ipre);
  float alpha = sat(a_i2.y) * gate;
  float pitch = f_grid.z;
  vec2 center = f_origin.xy + (vec2(cell) + 0.5) * pitch + a_i0.zw;
  vec2 halfB = (1.0 - P_grid_gap) * 0.5 * pitch * max(a_i1.xy, vec2(0.05));
  float corner = sat(P_grid_roundness) * min(halfB.x, halfB.y);
  float la = P_modes_sphere_lightAngle;
  vec2 shOff = -vec2(cos(la), sin(la)) * (max(h, 0.0) * 0.3 * pitch);
  // Crisp like a grid cell unless the controller gave this lift a depth-of-field blur (bokeh).
  float feather = P_grid_softness + 0.5 + max(a_i2.z, 0.0) + 0.02 * pitch * max(h, 0.0);
  // Nonzero output reaches past the body edge by at most: feather (the body's edge ramp), 0.9
  // pitch (the halo, zero while h <= 0.05) and the shadow offset + blur (zero while h <= 0). The
  // regions overlap, so the quad takes the largest margin (+2 px of slack), not their sum.
  float hp = max(h, 0.0);
  float haloM = (h > 0.05 && P_lift_halo != 0.0) ? 0.9 * pitch : 0.0;
  float shadowM = (hp > 0.0 && P_lift_shadow > 0.0) ? length(shOff) + (0.15 + 0.5 * hp) * pitch : 0.0;
  float ext = max(halfB.x, halfB.y) + max(max(haloM, shadowM), feather) + 2.0;
  vec2 c = (vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0) * ext;
  float tx = a_i1.z;
  float ty = a_i1.w;
  vec3 v = vec3(c.x, c.y * cos(tx), c.y * sin(tx));
  v = vec3(v.x * cos(ty) + v.z * sin(ty), v.y, -v.x * sin(ty) + v.z * cos(ty));
  float focal = 6.0 * max(halfB.x, halfB.y);
  float w = max((focal + v.z) / focal, 0.2);
  vec2 s = center + v.xy / w;
  vec2 ndc = vec2(s.x / u_region.z * 2.0 - 1.0, 1.0 - s.y / u_region.w * 2.0);
  gl_Position = alpha > 0.002 ? vec4(ndc * w, 0.0, w) : vec4(2.0, 2.0, 2.0, 1.0);
  v_plane = c;
  vec3 hotC = textureLod(u_lut, vec2(B.r * (255.0 / 256.0) + 0.5 / 256.0, 0.75), 0.0).rgb;
  hotC /= max(max3(hotC), 1e-4);
  // Brighter than the grid around it even after the tonemap shoulder (neighbours also get their
  // halo and bloom on top), otherwise the copy reads as a dim tile with a glowing outline.
  float Il = max(Ipre, 0.7) * (1.0 + 2.0 * P_lift_brightness * max(h, 0.0));
  // The popped cell glows in its local hue at full chroma even when it comes from the dark end
  // of the palette (outskirts); scaling a navy up would read as grey. Whitening stays a hint:
  // the hot tint is near white, and a pastel lift reads as a washed-out sticker.
  vec3 hue = A.rgb / max(max3(A.rgb), 1e-4);
  vec3 base = saturateColor(hue, 1.15);
  // Whitening mixes in a gamma-2 space: a linear mix of 10% near-white into saturated blue
  // already reads pastel after the sRGB encode.
  float whiten = sat(P_lift_whiten * max(h, 0.0) + 0.1 * B.g);
  vec3 col = sq3(mix(sqrt(base), sqrt(hotC), whiten)) * Il;
  float ex = P_glow_exposure;
  v_body = vec4(lin2srgb(tonemapMax(col * ex, P_glow_whitePoint)), 0.0);
  v_halo = vec4(saturateColor(base, P_glow_saturation) * (Il * P_lift_halo * 0.8 * ex), 0.0);
  v_geo = vec4(halfB, h, feather);
  v_misc = vec4(shOff, alpha, corner);
}
`;
}

function liftFs(header: string): string {
  return `${header}
uniform vec4 u_region;
uniform float u_opaque;  // 1 opaque output, 0 alpha canvas
in vec2 v_plane;
flat in vec4 v_body;
flat in vec4 v_halo;
flat in vec4 v_geo;
flat in vec4 v_misc;
out vec4 o_color;

void main() {
  // Plane positions and distances stay highp (tens of px, sub-pixel edges); colors are mediump.
  float pitch = f_grid.z;
  float h = max(v_geo.z, 0.0);
  float feather = v_geo.w;
  float d = sdRoundBox(v_plane, v_geo.xy, v_misc.w);
  mediump float body = 1.0 - smoothstep(-feather, feather, d);
  float ds = sdRoundBox(v_plane - v_misc.xy, v_geo.xy, v_misc.w);
  float sBlur = (0.15 + 0.5 * h) * pitch;
  mediump float shadow = P_lift_shadow;
  mediump float shadowA = satM(shadow) * satM(h) * (1.0 - smoothstep(-sBlur, sBlur, ds));
  // Soft lobe only (a tight rim would outline the tile instead of making it glow), grown in with
  // the height: at h ~ 0 the copy still sits on its own cell. Exactly 0 there and under the body.
  mediump vec3 haloS = vec3(0.0);
  if (h > 0.05 && body < 1.0) {
    float dh = max(d, 0.0) / pitch;
    mediump float r2 = max(P_glow_halo_radius, 0.01) * (1.0 + 1.5 * h);
    mediump float haloK = 0.45 * exp2(-dh * 1.4427 / r2) * sq(sat(1.0 - dh / 0.9))
                        * smoothstep(0.05, 0.6, h);
    mediump vec3 haloC = v_halo.rgb;
    mediump float wp = P_glow_whitePoint;
    haloS = lin2srgbM(tonemapMaxM(haloC * haloK, wp));
  }
  mediump float alpha = v_misc.z;
  mediump vec3 bodyS = v_body.rgb;
  mediump vec3 rgb = (bodyS * body + haloS * (1.0 - body)) * alpha;
  mediump float a = alpha * (body + shadowA * (1.0 - body));
  if (u_opaque < 0.5) {
    // Alpha canvas: outside the host the composite leaves glow-only pixels (alpha ~ max3(rgb)),
    // and the purely additive halo (rgb > a) would push them past valid premultiplied alpha.
    // Raise alpha there like the composite does; inside the host (opaque) keep it additive.
    vec2 px = ${REGION_PIXEL_GLSL};
    vec2 hp = px - f_host.xy;
    mediump float inHost = sat(min(hp.x, f_host.z - hp.x) + 0.5) * sat(min(hp.y, f_host.w - hp.y) + 0.5);
    a = mix(max(a, max3M(rgb)), a, inHost);
  }
  o_color = vec4(rgb, a);
}
`;
}

/** A slot's lift instance buffer (MAX_LIFTS records, rewritten every frame lifts are drawn). */
export function createLiftBuffer(gl: WebGL2RenderingContext): WebGLBuffer {
  const buffer = gl.createBuffer();
  if (!buffer) throw new Error('[lumicells] cannot create lift buffer');
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, MAX_LIFTS * LIFT_STRIDE * 4, gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  return buffer;
}

export class LiftPass {
  private readonly prog: LazyProgram;
  private readonly vao: WebGLVertexArrayObject;
  /** Instance buffer the vertex array currently reads (null: none yet). */
  private source: WebGLBuffer | null = null;
  /** Last uploaded uniforms (per program, so they stay valid whichever slot draws next). */
  private readonly last = new Float32Array(9).fill(Number.NaN);

  constructor(private readonly ctx: PassContext) {
    const gl = ctx.gl;
    this.prog = new LazyProgram(ctx, liftVs(ctx.header), liftFs(ctx.header), 'lift', (p) => {
      setSampler(gl, p, 'u_fieldA', UNIT_FIELD_A);
      setSampler(gl, p, 'u_fieldB', UNIT_FIELD_B);
      setSampler(gl, p, 'u_lut', UNIT_LUT);
    });
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('[lumicells] cannot create lift vertex array');
    this.vao = vao;
    gl.bindVertexArray(vao);
    for (let i = 0; i < 3; i++) {
      gl.enableVertexAttribArray(i);
      gl.vertexAttribDivisor(i, 1);
    }
    gl.bindVertexArray(null);
  }

  poll(): boolean {
    return this.prog.poll();
  }

  /**
   * The warm-up draw (see GpuDevice): one instance from `buffer` (zeros: alpha 0, so the quad
   * lands outside the clip volume), drawn like run() draws. On Direct3D 11 ANGLE builds this
   * program's vertex input layout and its flat-varying geometry shader on the first draw.
   */
  warm(targets: WarmTargets, buffer: WebGLBuffer): void {
    const gl = this.ctx.gl;
    this.prog.use();
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.framebuffer([this.ctx.caps.rgba8]));
    gl.viewport(0, 0, 1, 1);
    gl.bindVertexArray(this.vao);
    this.attach(buffer);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  /** Points the vertex array at `buffer` (only when it changed). The VAO must be bound. */
  private attach(buffer: WebGLBuffer): void {
    if (this.source === buffer) return;
    const gl = this.ctx.gl;
    const stride = LIFT_STRIDE * 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    for (let i = 0; i < 3; i++) gl.vertexAttribPointer(i, 4, gl.FLOAT, false, stride, i * 16);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.source = buffer;
  }

  /** A slot's buffer is being deleted: never keep pointing at it. */
  release(buffer: WebGLBuffer): void {
    if (this.source === buffer) this.source = null;
  }

  /**
   * Uploads `count` lift records into the slot's `buffer` and draws them over the composite,
   * into the region the composite set up (viewport and framebuffer are left bound by it).
   */
  run(
    buffer: WebGLBuffer,
    lifts: Float32Array,
    count: number,
    region: Region,
    w: number,
    h: number,
    allocW: number,
    allocH: number,
    opaque: boolean,
  ): void {
    const n = Math.min(count, MAX_LIFTS, Math.floor(lifts.length / LIFT_STRIDE));
    if (n <= 0) return;
    const gl = this.ctx.gl;
    const p = this.prog.use();
    const l = this.last;
    if (l[0] !== w || l[1] !== h || l[2] !== allocW || l[3] !== allocH) {
      l[0] = w;
      l[1] = h;
      l[2] = allocW;
      l[3] = allocH;
      gl.uniform4f(p.uniform('u_cellTex'), w, h, 1 / allocW, 1 / allocH);
    }
    const { x, y, width, height } = region;
    if (l[4] !== x || l[5] !== y || l[6] !== width || l[7] !== height) {
      l[4] = x;
      l[5] = y;
      l[6] = width;
      l[7] = height;
      gl.uniform4f(p.uniform('u_region'), x, y, width, height);
    }
    const op = opaque ? 1 : 0;
    if (l[8] !== op) {
      l[8] = op;
      gl.uniform1f(p.uniform('u_opaque'), op);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, lifts, 0, n * LIFT_STRIDE);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindVertexArray(this.vao);
    this.attach(buffer);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.ctx.gl;
    this.prog.dispose();
    gl.deleteVertexArray(this.vao);
    this.source = null;
  }
}
