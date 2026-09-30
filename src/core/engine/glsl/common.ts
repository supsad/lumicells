/**
 * Shared GLSL: math helpers, integer hashes, color transforms, tonemap, dither, SDF and
 * B-spline texture sampling. Unused functions are stripped by the driver, so every pass can
 * include the whole chunk.
 */

export const COMMON_GLSL = /* glsl */ `
#define PI 3.14159265
#define TAU 6.28318531

float sat(float x) { return clamp(x, 0.0, 1.0); }
vec2 sat2(vec2 x) { return clamp(x, 0.0, 1.0); }
vec3 sat3(vec3 x) { return clamp(x, 0.0, 1.0); }
float sq(float x) { return x * x; }
vec3 sq3(vec3 x) { return x * x; }
float max3(vec3 c) { return max(c.r, max(c.g, c.b)); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 saturateColor(vec3 c, float s) { return max(vec3(0.0), mix(vec3(luma(c)), c, s)); }
// Mirrored repeat: identity on [0,1], folds back outside (seamless palette cycling).
float tri(float x) { return 1.0 - abs(fract(x * 0.5) * 2.0 - 1.0); }
// Fades a periodic feature out as it approaches the cell Nyquist limit (x = cycles per cell).
float bandLimit(float x) { return sat(1.0 - (x - 0.25) * 5.0); }

// ---- Integer hashes (PCG). Never sin-hashes: those break at large inputs on mobile GPUs.
uint pcg(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
uint hash2(uvec2 v) { return pcg(v.x + pcg(v.y)); }
uint hash3(uvec3 v) { return pcg(v.x + pcg(v.y + pcg(v.z))); }
// 24 random bits -> [0,1) without rounding up to 1.0.
float u01(uint h) { return float(h >> 8u) * (1.0 / 16777216.0); }

// ---- Render-target encoding: HDR targets store linear values, RGBA8 stores sqrt(x/4)
// (perceptual precision in the darks, headroom up to 4). Functions, not macros, so a texture
// fetch passed in is evaluated once.
#if HDR_RT
vec4 enc4(vec4 v) { return v; }
vec4 dec4(vec4 v) { return v; }
#else
vec4 enc4(vec4 v) { return sqrt(clamp(v * 0.25, 0.0, 1.0)); }
vec4 dec4(vec4 v) { return v * v * 4.0; }
#endif

// ---- Color
vec3 lin2srgb(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

float cbrt(float x) { return sign(x) * pow(abs(x), 1.0 / 3.0); }

vec3 lin2oklab(vec3 c) {
  float l = cbrt(dot(c, vec3(0.4122214708, 0.5363325363, 0.0514459929)));
  float m = cbrt(dot(c, vec3(0.2119034982, 0.6806995451, 0.1073969566)));
  float s = cbrt(dot(c, vec3(0.0883024619, 0.2817188376, 0.6299787005)));
  return vec3(
    dot(vec3(l, m, s), vec3(0.2104542553, 0.7936177850, -0.0040720468)),
    dot(vec3(l, m, s), vec3(1.9779984951, -2.4285922050, 0.4505937099)),
    dot(vec3(l, m, s), vec3(0.0259040371, 0.7827717662, -0.8086757660)));
}

vec3 oklab2lin(vec3 c) {
  float l = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  float m = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  float s = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  vec3 lms = vec3(l * l * l, m * m * m, s * s * s);
  return vec3(
    dot(lms, vec3(4.0767416621, -3.3077115913, 0.2309699292)),
    dot(lms, vec3(-1.2684380046, 2.6097574011, -0.3413193965)),
    dot(lms, vec3(-0.0041960863, -0.7034186147, 1.7076147010)));
}

// Hue-preserving tonemap on the max channel: linear up to the knee, then an extended Reinhard
// shoulder that reaches 1.0 at the white point. Per-channel curves would shift hues and bleach
// saturated neon toward white by accident; whitening is an explicit, spatially limited control.
#define TM_KNEE 0.6
vec3 tonemapMax(vec3 c, float wp) {
  float m = max3(c);
  if (m <= TM_KNEE) return c;
  float x = (m - TM_KNEE) * (1.0 / (1.0 - TM_KNEE));
  float w = max((wp - TM_KNEE) * (1.0 / (1.0 - TM_KNEE)), 0.05);
  float y = x * (1.0 + x / (w * w)) / (1.0 + x);
  return c * ((TM_KNEE + (1.0 - TM_KNEE) * min(y, 1.0)) / m);
}

// Triangular-PDF dither of +-1 LSB (8-bit) from one hash: kills banding in the deep navy.
float ditherTPDF(vec2 fragCoord) {
  uint h = hash2(uvec2(ivec2(fragCoord)));
  float a = float(h & 0xffffu) * (1.0 / 65535.0);
  float b = float(h >> 16u) * (1.0 / 65535.0);
  return (a + b - 1.0) * (1.0 / 255.0);
}

// Rounded box SDF: half extents b, corner radius r (inside the box). Negative inside.
float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// ---- Cell-space texture sampling. pos is in texel units (centers at i + 0.5), lim is the valid
// (logical) size inside a larger bucketed allocation, inv = 1 / allocation size. Every tap is
// clamped to the valid rect so stale headroom texels never bleed in.
vec4 texBilinear(sampler2D t, vec2 pos, vec2 lim, vec2 inv) {
  return texture(t, clamp(pos, vec2(0.5), lim - 0.5) * inv);
}

// Cubic B-spline in 4 bilinear taps: C2-smooth, so cell-resolution glow shows no diamonds or
// Mach bands when stretched over tens of pixels.
vec4 texBicubic(sampler2D t, vec2 pos, vec2 lim, vec2 inv) {
  vec2 st = pos - 0.5;
  vec2 i = floor(st);
  vec2 f = st - i;
  vec2 f2 = f * f;
  vec2 f3 = f2 * f;
  vec2 w0 = (1.0 / 6.0) * (-f3 + 3.0 * f2 - 3.0 * f + 1.0);
  vec2 w1 = (1.0 / 6.0) * (3.0 * f3 - 6.0 * f2 + 4.0);
  vec2 w2 = (1.0 / 6.0) * (-3.0 * f3 + 3.0 * f2 + 3.0 * f + 1.0);
  vec2 w3 = (1.0 / 6.0) * f3;
  vec2 g0 = w0 + w1;
  vec2 g1 = w2 + w3;
  vec2 lo = vec2(0.5);
  vec2 hi = lim - 0.5;
  vec2 h0 = clamp(i - 0.5 + w1 / g0, lo, hi) * inv;
  vec2 h1 = clamp(i + 1.5 + w3 / g1, lo, hi) * inv;
  return g0.y * (g0.x * texture(t, h0) + g1.x * texture(t, vec2(h1.x, h0.y)))
       + g1.y * (g0.x * texture(t, vec2(h0.x, h1.y)) + g1.x * texture(t, h1));
}
`;

/** Minimal vertex shader for full-target passes: one oversized triangle, no attributes. */
export const FULLSCREEN_VS = /* glsl */ `#version 300 es
precision highp float;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;
