/**
 * Vortex: logarithmic-looking spiral arms rotating with the vortex phase. Arms are rounded to an
 * integer so cos(arms * angle) stays continuous across the atan seam even mid-tween.
 */
export const VORTEX_GLSL = /* glsl */ `
vec3 mode_vortex(ModeIn m) {
  float r = m.r;
  float a = atan(m.p.y, m.p.x);
  float arms = max(1.0, floor(P_modes_vortex_arms + 0.5));
  float twist = P_modes_vortex_twist;
  float s = arms * (a - f_phaseB.y + twist * r);
  float v = 0.5 + 0.5 * cos(s);
  // Local spatial frequency (cycles per mode unit) of the arms at this radius.
  float freq = arms * sqrt(1.0 / max(r * r, 1e-4) + twist * twist) / TAU;
  v = mix(0.5, v, bandLimit(freq * m.cs));
  v = pow(v, 1.0 + 5.0 * P_modes_vortex_sharpness);
  float fall = exp(-r * P_modes_vortex_falloff) * smoothstep(0.0, 0.12, r);
  return vec3(v * fall * 1.2, fall, 0.0);
}
`;
