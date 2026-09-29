/**
 * Lift pass: instanced quads for the few "popped out" cells (<= MAX_LIFTS), drawn over the
 * composite with premultiplied blending (ONE, ONE_MINUS_SRC_ALPHA).
 *
 * The vertex shader reads the source cell's color / intensity from the field textures, gates the
 * lift out when its cell went dark, and applies a 3D tilt with perspective (focal length of three
 * body sizes). Plane coordinates are interpolated perspective-correctly, so the fragment shader
 * evaluates the rounded body, a soft shadow and a wider halo in the lifted plane.
 */

import { MAX_LIFTS } from '../frame-block';
import { LIFT_STRIDE } from '../types';
import {
  LazyProgram,
  type PassContext,
  setSampler,
  UNIT_FIELD_A,
  UNIT_FIELD_B,
  UNIT_LUT,
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
uniform vec4 u_view;
out vec2 v_plane;
flat out vec4 v_base;  // rgb base color, a lifted intensity
flat out vec4 v_hot;   // rgb hot tint, a whitening mix
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
  float feather = P_grid_softness + 0.5 + max(a_i2.z, 0.0) + 0.08 * pitch * max(h, 0.0);
  float ext = max(halfB.x, halfB.y) + 0.9 * pitch + length(shOff) + (0.15 + 0.5 * max(h, 0.0)) * pitch
            + feather + 2.0;
  vec2 c = (vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0) * ext;
  float tx = a_i1.z;
  float ty = a_i1.w;
  vec3 v = vec3(c.x, c.y * cos(tx), c.y * sin(tx));
  v = vec3(v.x * cos(ty) + v.z * sin(ty), v.y, -v.x * sin(ty) + v.z * cos(ty));
  float focal = 6.0 * max(halfB.x, halfB.y);
  float w = max((focal + v.z) / focal, 0.2);
  vec2 s = center + v.xy / w;
  vec2 ndc = vec2(s.x / u_view.x * 2.0 - 1.0, 1.0 - s.y / u_view.y * 2.0);
  gl_Position = alpha > 0.002 ? vec4(ndc * w, 0.0, w) : vec4(2.0, 2.0, 2.0, 1.0);
  v_plane = c;
  vec3 hotC = textureLod(u_lut, vec2(B.r * (255.0 / 256.0) + 0.5 / 256.0, 0.75), 0.0).rgb;
  hotC /= max(max3(hotC), 1e-4);
  float Il = max(Ipre, 0.55) * (1.0 + P_lift_brightness * max(h, 0.0));
  // The popped cell glows in its local hue at full chroma even when it comes from the dark end
  // of the palette (outskirts); scaling a navy up would read as grey.
  vec3 hue = A.rgb / max(max3(A.rgb), 1e-4);
  v_base = vec4(saturateColor(hue, 1.1), Il);
  v_hot = vec4(hotC, sat(P_lift_whiten * max(h, 0.0) + 0.25 * B.g));
  v_geo = vec4(halfB, h, feather);
  v_misc = vec4(shOff, alpha, corner);
}
`;
}

function liftFs(header: string): string {
  return `${header}
in vec2 v_plane;
flat in vec4 v_base;
flat in vec4 v_hot;
flat in vec4 v_geo;
flat in vec4 v_misc;
out vec4 o_color;

void main() {
  float pitch = f_grid.z;
  float h = max(v_geo.z, 0.0);
  float feather = v_geo.w;
  float d = sdRoundBox(v_plane, v_geo.xy, v_misc.w);
  float body = 1.0 - smoothstep(-feather, feather, d);
  float dh = max(d, 0.0) / pitch;
  float r2 = max(P_glow_halo_radius, 0.01) * (1.0 + 1.5 * h);
  float haloK = (0.6 * exp2(-dh * 28.8539) + 0.25 * exp2(-dh * 1.4427 / r2)) * sq(sat(1.0 - dh / 0.9));
  float ds = sdRoundBox(v_plane - v_misc.xy, v_geo.xy, v_misc.w);
  float sBlur = (0.15 + 0.5 * h) * pitch;
  float shadowA = sat(P_lift_shadow) * sat(h) * (1.0 - smoothstep(-sBlur, sBlur, ds));
  vec3 col = mix(v_base.rgb, v_hot.rgb, v_hot.a) * v_base.a;
  vec3 haloC = saturateColor(v_base.rgb, P_glow_saturation) * (v_base.a * haloK * P_lift_halo * 0.5);
  float ex = P_glow_exposure;
  float wp = P_glow_whitePoint;
  vec3 bodyS = lin2srgb(tonemapMax(col * ex, wp));
  vec3 haloS = lin2srgb(tonemapMax(haloC * ex, wp));
  float alpha = v_misc.z;
  vec3 rgb = (bodyS * body + haloS * (1.0 - body)) * alpha;
  float a = alpha * (body + shadowA * (1.0 - body));
  o_color = vec4(rgb, a);
}
`;
}

export class LiftPass {
  private readonly prog: LazyProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly buffer: WebGLBuffer;
  private readonly last = new Float32Array(6).fill(Number.NaN);

  constructor(private readonly ctx: PassContext) {
    const gl = ctx.gl;
    this.prog = new LazyProgram(ctx, liftVs(ctx.header), liftFs(ctx.header), 'lift', (p) => {
      setSampler(gl, p, 'u_fieldA', UNIT_FIELD_A);
      setSampler(gl, p, 'u_fieldB', UNIT_FIELD_B);
      setSampler(gl, p, 'u_lut', UNIT_LUT);
    });
    const vao = gl.createVertexArray();
    const buffer = gl.createBuffer();
    if (!vao || !buffer) throw new Error('[pixel-life] cannot create lift buffers');
    this.vao = vao;
    this.buffer = buffer;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, MAX_LIFTS * LIFT_STRIDE * 4, gl.DYNAMIC_DRAW);
    const stride = LIFT_STRIDE * 4;
    for (let i = 0; i < 3; i++) {
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, 4, gl.FLOAT, false, stride, i * 16);
      gl.vertexAttribDivisor(i, 1);
    }
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  poll(): boolean {
    return this.prog.poll();
  }

  run(
    lifts: Float32Array,
    count: number,
    viewW: number,
    viewH: number,
    w: number,
    h: number,
    allocW: number,
    allocH: number,
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
    if (l[4] !== viewW || l[5] !== viewH) {
      l[4] = viewW;
      l[5] = viewH;
      gl.uniform4f(p.uniform('u_view'), viewW, viewH, 0, 0);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, lifts, 0, n * LIFT_STRIDE);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindVertexArray(this.vao);
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
    gl.deleteBuffer(this.buffer);
  }
}
