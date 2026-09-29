/**
 * Gradient noise on a lattice that repeats every 256 units on every axis.
 *
 * Phases uploaded by the controller wrap at 1024 (or at 4096 for the clock), so any noise input of
 * the form `phase * k` with 1024*k a multiple of 256 (k a multiple of 0.25; for the clock k a
 * multiple of 1/16) crosses the wrap without a visible jump. Gradient noise rather than value
 * noise: value noise on an integer lattice lines up with the cell grid and reads as blocky.
 */

export const NOISE_GLSL = /* glsl */ `
#define NOISE_WRAP 255
// Per-octave domain rotation (36.87 deg) hides lattice alignment between octaves.
const mat2 NOISE_ROT = mat2(0.8, 0.6, -0.6, 0.8);

float grad3(uint h, vec3 p) {
  uint k = h & 15u;
  float u = k < 8u ? p.x : p.y;
  float v = k < 4u ? p.y : ((k == 12u || k == 14u) ? p.x : p.z);
  return ((k & 1u) == 0u ? u : -u) + ((k & 2u) == 0u ? v : -v);
}

// Roughly [-1, 1], zero at lattice points.
float gnoise3(vec3 p) {
  vec3 fl = floor(p);
  vec3 f = p - fl;
  ivec3 a = ivec3(fl) & NOISE_WRAP;
  ivec3 b = (a + 1) & NOISE_WRAP;
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = grad3(hash3(uvec3(a.x, a.y, a.z)), f);
  float n100 = grad3(hash3(uvec3(b.x, a.y, a.z)), f - vec3(1.0, 0.0, 0.0));
  float n010 = grad3(hash3(uvec3(a.x, b.y, a.z)), f - vec3(0.0, 1.0, 0.0));
  float n110 = grad3(hash3(uvec3(b.x, b.y, a.z)), f - vec3(1.0, 1.0, 0.0));
  float n001 = grad3(hash3(uvec3(a.x, a.y, b.z)), f - vec3(0.0, 0.0, 1.0));
  float n101 = grad3(hash3(uvec3(b.x, a.y, b.z)), f - vec3(1.0, 0.0, 1.0));
  float n011 = grad3(hash3(uvec3(a.x, b.y, b.z)), f - vec3(0.0, 1.0, 1.0));
  float n111 = grad3(hash3(uvec3(b.x, b.y, b.z)), f - vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
    mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
    u.z);
}

vec2 grad2v(uint h) {
  return vec2(float(h & 0xffffu), float(h >> 16u)) * (2.0 / 65535.0) - 1.0;
}

float gnoise2(vec2 p) {
  vec2 fl = floor(p);
  vec2 f = p - fl;
  ivec2 a = ivec2(fl) & NOISE_WRAP;
  ivec2 b = (a + 1) & NOISE_WRAP;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n00 = dot(grad2v(hash2(uvec2(a.x, a.y))), f);
  float n10 = dot(grad2v(hash2(uvec2(b.x, a.y))), f - vec2(1.0, 0.0));
  float n01 = dot(grad2v(hash2(uvec2(a.x, b.y))), f - vec2(0.0, 1.0));
  float n11 = dot(grad2v(hash2(uvec2(b.x, b.y))), f - vec2(1.0, 1.0));
  return mix(mix(n00, n10, u.x), mix(n01, n11, u.x), u.y);
}

// fbm with domain rotation per octave. z (time) doubles per octave, which keeps periodicity.
float fbm3(vec3 p, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 5; i++) {
    if (i >= octaves) break;
    sum += amp * gnoise3(p);
    norm += amp;
    p.xy = NOISE_ROT * p.xy * 2.0 + vec2(17.0, 31.0);
    p.z *= 2.0;
    amp *= 0.5;
  }
  return sum / norm;
}
`;
