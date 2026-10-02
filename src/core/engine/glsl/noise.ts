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
  // Corner hashes: hash3(x, y, z) = pcg(x + pcg(y + pcg(z))) with the inner levels shared.
  uvec3 ua = uvec3(a);
  uvec3 ub = uvec3(b);
  uint za = pcg(ua.z);
  uint zb = pcg(ub.z);
  uint yaa = pcg(ua.y + za);
  uint yba = pcg(ub.y + za);
  uint yab = pcg(ua.y + zb);
  uint ybb = pcg(ub.y + zb);
  float n000 = grad3(pcg(ua.x + yaa), f);
  float n100 = grad3(pcg(ub.x + yaa), f - vec3(1.0, 0.0, 0.0));
  float n010 = grad3(pcg(ua.x + yba), f - vec3(0.0, 1.0, 0.0));
  float n110 = grad3(pcg(ub.x + yba), f - vec3(1.0, 1.0, 0.0));
  float n001 = grad3(pcg(ua.x + yab), f - vec3(0.0, 0.0, 1.0));
  float n101 = grad3(pcg(ub.x + yab), f - vec3(1.0, 0.0, 1.0));
  float n011 = grad3(pcg(ua.x + ybb), f - vec3(0.0, 1.0, 1.0));
  float n111 = grad3(pcg(ub.x + ybb), f - vec3(1.0, 1.0, 1.0));
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

// Band limit for gradient noise sampled once per cell; fw = its footprint in lattice units per
// cell. The noise spectrum peaks near 0.5 cycles per lattice unit, so the octave fades to its
// mean (0) as that peak approaches the cell Nyquist limit (fw 0.5..0.9) instead of aliasing
// into per-cell speckle.
float noiseBand(float fw) { return bandLimit(0.5 * fw); }

// fbm with domain rotation per octave. z (time) doubles per octave, which keeps periodicity.
// fw = footprint of octave 0 (lattice units per cell): finer octaves fade out by noiseBand().
float fbm3(vec3 p, int octaves, float fw) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 5; i++) {
    if (i >= octaves) break;
    sum += amp * noiseBand(fw) * gnoise3(p);
    norm += amp;
    p.xy = NOISE_ROT * p.xy * 2.0 + vec2(17.0, 31.0);
    p.z *= 2.0;
    amp *= 0.5;
    fw *= 2.0;
  }
  return sum / norm;
}
`;
