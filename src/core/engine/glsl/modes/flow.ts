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
  // Octave 0 carries the structure: it fades only once the noise itself gets finer than a cell
  // (e.g. a large scale at low zoom), instead of turning into shimmering salt-and-pepper.
  // Octave k: amplitude 0.5 / 2^k, drift ph * (1, 1.5, 2.25), time ph * (0.25, 0.5, 0.75).
  // One noise call in a loop (see RUNTIME_COUNT).
  float n = 0.0;
  vec2 qk = q;
  for (int k = 0; k < RUNTIME_COUNT(3); k++) {
    float amp = k == 0 ? 0.5 : (k == 1 ? 0.25 : 0.125);
    float band = bandLimit((k == 0 ? 0.5 : (k == 1 ? 2.0 : 4.0)) * fw);
    float sx = k == 0 ? 1.0 : (k == 1 ? 1.5 : 2.25);
    float sz = k == 0 ? 0.25 : (k == 1 ? 0.5 : 0.75);
    n += amp * band * gnoise3(vec3(qk.x - ph * sx, qk.y, ph * sz));
    qk = NOISE_ROT * qk * 2.0 + (k == 0 ? vec2(19.0, 7.0) : vec2(-11.0, 23.0));
  }
  float v = 0.42 + 1.3 * n;
  // Widen the threshold edge to the cell footprint so contours do not crawl cell to cell.
  float soft = sqrt(sq(P_modes_flow_softness) + sq(0.35 * fw));
  float thr = P_modes_flow_threshold;
  float I = smoothstep(thr - 0.5 * soft, thr + 0.5 * soft, v);
  // The envelope is the lit mask itself: a faint flow layer must not keep the outskirts dense.
  return vec3(I * (0.65 + 0.5 * sat(v)), I, 0.0);
}
`;
