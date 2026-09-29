/**
 * Flow: thresholded drifting fbm, i.e. lit "continents" sliding in one direction.
 *
 * The noise is evaluated in a frame aligned with the flow direction so the drift runs along the
 * lattice x axis; each octave drifts along its own (rotated) axis at a quarter-unit multiple of
 * the phase, which keeps the 1024 phase wrap seamless and reads as gentle turbulence.
 */
export const FLOW_GLSL = /* glsl */ `
vec3 mode_flow(ModeIn m) {
  float a = P_modes_flow_direction;
  vec2 d = vec2(cos(a), sin(a));
  float sc = max(P_modes_flow_scale, 0.01);
  vec2 q = vec2(dot(m.p, d), dot(m.p, vec2(-d.y, d.x))) * sc;
  float ph = f_phaseA.x;
  float fw = sc * m.cs;
  float n = 0.5 * gnoise3(vec3(q.x - ph, q.y, ph * 0.25));
  vec2 q1 = NOISE_ROT * q * 2.0 + vec2(19.0, 7.0);
  n += 0.25 * bandLimit(2.0 * fw) * gnoise3(vec3(q1.x - ph * 1.5, q1.y, ph * 0.5));
  vec2 q2 = NOISE_ROT * q1 * 2.0 + vec2(-11.0, 23.0);
  n += 0.125 * bandLimit(4.0 * fw) * gnoise3(vec3(q2.x - ph * 2.25, q2.y, ph * 0.75));
  float v = 0.42 + 1.3 * n;
  // Widen the threshold edge to the cell footprint so contours do not crawl cell to cell.
  float soft = sqrt(sq(P_modes_flow_softness) + sq(0.35 * fw));
  float thr = P_modes_flow_threshold;
  float I = smoothstep(thr - 0.5 * soft, thr + 0.5 * soft, v);
  // The envelope is the lit mask itself: a faint flow layer must not keep the outskirts dense.
  return vec3(I * (0.65 + 0.5 * sat(v)), I, 0.0);
}
`;
