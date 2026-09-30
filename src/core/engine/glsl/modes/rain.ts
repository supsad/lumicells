/**
 * Rain: falling streaks per grid column (in cell units, tilted by `angle`). Each column has its
 * own speed and segment length; a segment holds a drop with probability `density`, drawn as a
 * bright head with a fading tail of `tail` mode units.
 */
export const RAIN_GLSL = /* glsl */ `
vec3 mode_rain(ModeIn m) {
  float a = P_modes_rain_angle;
  vec2 across = vec2(cos(a), sin(a));
  vec2 down = vec2(-sin(a), cos(a));
  float cs = max(m.cs, 1e-4);
  float col = floor(dot(m.p, across) / cs + 0.5);
  float along = dot(m.p, down) / cs;
  uint hc = pcg(uint(int(col) + 65536) * 3u + 17u);
  float spd = 0.5 + 0.25 * floor(u01(hc) * 5.0);
  float tailCells = max(P_modes_rain_tail / cs, 1.0);
  float segLen = tailCells * (1.4 + 1.6 * u01(pcg(hc + 1u)));
  float u = (along - f_phaseB.z * spd / cs) / segLen + u01(pcg(hc + 2u));
  float k = floor(u);
  float x = (u - k) * segLen - (segLen - tailCells);
  float isOn = step(u01(hash3(uvec3(uint(int(col) + 65536), uint(int(k) + 65536), 0x7a1u))), P_modes_rain_density);
  float tail = sat(x / tailCells);
  // The head's leading edge spans 1.5 cells: a fast column then brightens a cell over a few
  // frames instead of switching it on in one.
  float head = 1.0 - smoothstep(segLen - 1.5, segLen, (u - k) * segLen);
  // The tail end ramps in over one cell (a hard step there would pop cells off as it passes).
  float I = isOn * head * sat(x) * (0.2 + 0.8 * pow(tail, 1.4) + 0.3 * smoothstep(0.85, 1.0, tail));
  return vec3(I, 0.3 + 0.7 * sat(P_modes_rain_density * 2.0), 0.0);
}
`;
