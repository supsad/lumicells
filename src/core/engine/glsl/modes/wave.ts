/**
 * Wave: plane waves along `angle`; `interference` blends in an interference plasma: a second,
 * slower wave at a crossing angle plus a circular wave from a slowly wandering center, over a
 * gently warped domain, so crests bend and merge instead of forming a regular egg-crate lattice.
 * Every component fades out near the cell Nyquist limit. Phase multipliers are multiples of
 * 1/8, so the 1024-unit phase wrap stays seamless.
 */
export const WAVE_GLSL = /* glsl */ `
vec3 mode_wave(ModeIn m) {
  float a = P_modes_wave_angle;
  float f = max(P_modes_wave_frequency, 0.01);
  float ph = f_phaseB.x;
  float k = P_modes_wave_interference;
  vec2 d1 = vec2(cos(a), sin(a));
  float w1 = 0.5 + 0.5 * sin(TAU * (dot(m.p, d1) * f - ph));
  w1 = mix(0.5, w1, bandLimit(f * m.cs));
  float v = w1;
  if (k > 0.001) {
    // Low-frequency domain warp (a quarter of the wave frequency): bends the crests.
    vec2 q = m.p;
    float wf = 0.35 * f;
    q += (0.12 / f) * vec2(sin(TAU * (m.p.y * wf + ph * 0.125)), sin(TAU * (m.p.x * wf - ph * 0.125)));
    vec2 d2 = vec2(cos(a + 1.1), sin(a + 1.1));
    float s1 = sin(TAU * (dot(q, d1) * f - ph)) * bandLimit(f * m.cs);
    float s2 = sin(TAU * (dot(q, d2) * f * 0.8 - ph * 0.75)) * bandLimit(0.8 * f * m.cs);
    vec2 c = 0.55 * vec2(sin(TAU * ph * 0.125), cos(TAU * ph * 0.1875));
    float s3 = sin(TAU * (length(q - c) * f * 0.7 - ph * 0.5)) * bandLimit(0.7 * f * m.cs);
    // Classic plasma: a sine of the summed waves draws wandering iso-lines (ridges that bend,
    // split and merge). The fold raises the local frequency ~1.5x, so it is band-limited too.
    float sum = s1 + s2 + s3;
    float fold = bandLimit(1.5 * f * m.cs);
    float plasma = 0.5 + 0.5 * mix(sum / 3.0, sin(1.6 * sum - TAU * ph * 0.25), fold);
    v = mix(w1, plasma, k);
  }
  v = pow(sat(v), 1.0 + 3.0 * P_modes_wave_sharpness);
  return vec3(v, 0.35 + 0.65 * v, 0.0);
}
`;
