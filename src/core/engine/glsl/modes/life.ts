/**
 * Life: reads the cellular automaton state (stepped at a few Hz by the life pass) and fades cells
 * analytically between steps: g = steps since the last change, f_clock.y = fraction of the next
 * step, so the fade is frame-rate independent and never stalls in 8 bits.
 */
export const LIFE_GLSL = /* glsl */ `
vec3 mode_life(ModeIn m) {
  vec4 L = texelFetch(u_life, m.cell, 0);
  float F = max(P_modes_life_fadeSteps, 1.0);
  float t = sat((L.g * 255.0 + f_clock.y) / F);
  t = t * t * (3.0 - 2.0 * t);
  float e = L.r > 0.5 ? t : 1.0 - t;
  // Old cells cool down a little so long-lived still lifes do not dominate.
  float age = L.b * 255.0;
  e *= 1.0 - 0.25 * smoothstep(8.0, 60.0, age);
  return vec3(e, 0.8, 0.0);
}
`;
