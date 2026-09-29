/**
 * Pulse: concentric rings travelling outward from `origin`, gaussian band per ring, widened to
 * the cell footprint and faded to their mean when rings get denser than the grid can show.
 */
export const PULSE_GLSL = /* glsl */ `
vec3 mode_pulse(ModeIn m) {
  float r = length(m.p - P_modes_pulse_origin);
  float f = max(P_modes_pulse_frequency, 0.01);
  float x = r * f - f_phaseA.w;
  float dd = (fract(x + 0.5) - 0.5) / f;
  float w = sqrt(sq(0.5 * P_modes_pulse_width) + sq(0.5 * m.cs));
  float band = exp(-dd * dd / (2.0 * w * w));
  float mean = min(1.0, w * 2.5066 * f);
  band = mix(mean, band, bandLimit(f * m.cs));
  float fall = 0.25 + 0.95 * exp(-r * P_modes_pulse_falloff);
  // Breathes once every 4 rings; 0.25 * 1024 keeps the phase wrap seamless.
  float br = 1.0 - P_modes_pulse_breathe * (0.5 - 0.5 * cos(f_phaseA.w * TAU * 0.25));
  return vec3(band * fall * br, fall * br, 0.0);
}
`;
