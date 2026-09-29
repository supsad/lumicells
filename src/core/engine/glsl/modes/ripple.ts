/**
 * Ripple: stateless raindrops. `rate * life` staggered slots each spawn one drop per epoch at a
 * hashed position inside the host; the ring radius grows with age and fades out over `life`.
 */
export const RIPPLE_GLSL = /* glsl */ `
vec3 mode_ripple(ModeIn m) {
  float life = max(P_modes_ripple_life, 0.1);
  float slots = min(P_modes_ripple_rate * life, 16.0);
  if (slots <= 0.0) return vec3(0.0);
  vec2 ext = 0.5 * f_host.zw * f_space.z;
  float zoom = max(P_scene_zoom, 0.05);
  float w = sqrt(sq(0.5 * P_modes_ripple_width) + sq(0.5 * m.cs));
  float acc = 0.0;
  for (int i = 0; i < 16; i++) {
    float fi = float(i);
    if (fi >= slots) break;
    float tt = f_clock.x / life + fi / slots;
    float e = floor(tt);
    float age = tt - e;
    uint hh = hash3(uvec3(uint(i), uint(e), 0x51f1u));
    // The last slot is only partially occupied so the drop rate is continuous in rate * life.
    if (fi + 1.0 > slots && u01(hh) > slots - fi) continue;
    vec2 c = (vec2(u01(pcg(hh)), u01(pcg(hh + 1u))) * 2.0 - 1.0) * ext * 0.9;
    c = (c - P_scene_center) / zoom;
    float radius = P_modes_ripple_speed * age * life;
    float dist = length(m.p - c);
    float band = exp(-sq(dist - radius) / (2.0 * w * w));
    float amp = pow(1.0 - age, 1.5) * smoothstep(0.0, 0.06, age);
    acc += band * amp;
  }
  float I = 1.0 - exp(-2.5 * acc);
  return vec3(I, 0.5 + 0.5 * I, 0.0);
}
`;
