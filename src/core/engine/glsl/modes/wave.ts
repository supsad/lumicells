/**
 * Wave: plane waves along `angle`, optionally interfering with a second, slower wave at a
 * crossing angle (moire-like beating). Amplitude fades out near the cell Nyquist limit.
 */
export const WAVE_GLSL = /* glsl */ `
vec3 mode_wave(ModeIn m) {
  float a = P_modes_wave_angle;
  float f = max(P_modes_wave_frequency, 0.01);
  vec2 d1 = vec2(cos(a), sin(a));
  vec2 d2 = vec2(cos(a + 1.1), sin(a + 1.1));
  float ph = f_phaseB.x;
  float w1 = 0.5 + 0.5 * sin(TAU * (dot(m.p, d1) * f - ph));
  float w2 = 0.5 + 0.5 * sin(TAU * (dot(m.p, d2) * f * 0.8 - ph * 0.75));
  w1 = mix(0.5, w1, bandLimit(f * m.cs));
  w2 = mix(0.5, w2, bandLimit(0.8 * f * m.cs));
  float v = mix(w1, 0.5 * (w1 + w2) * (0.6 + 0.8 * w1 * w2), P_modes_wave_interference);
  v = pow(sat(v), 1.0 + 3.0 * P_modes_wave_sharpness);
  return vec3(v, 0.35 + 0.65 * v, 0.0);
}
`;
