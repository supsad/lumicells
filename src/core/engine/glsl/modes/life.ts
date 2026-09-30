/**
 * Life: reads the cellular automaton state (stepped at a few Hz by the life pass) and fades cells
 * analytically between steps: g = steps since the last change, f_clock.y = fraction of the next
 * step, so the fade is frame-rate independent and never stalls in 8 bits.
 *
 * Births light up quickly (at most two steps), deaths fade over the full fadeSteps. The state's
 * alpha holds the level the cell was showing when it last changed, so a fade that is interrupted
 * (an oscillator, a cell reborn while still dying) continues from where it was instead of
 * popping to full or to black.
 */

/** Shared by the field pass (display) and the life pass (level captured at a change). */
export const LIFE_LEVEL_GLSL = /* glsl */ `
float lifeLevel(vec4 L, float frac) {
  float F = max(P_modes_life_fadeSteps, 1.0);
  bool alive = L.r > 0.5;
  float Fx = alive ? clamp(0.4 * F, 1.0, 2.0) : F;
  float t = sat((L.g * 255.0 + frac) / Fx);
  t = t * t * (3.0 - 2.0 * t);
  // Old cells cool down a little so long-lived still lifes do not dominate.
  float target = alive ? 1.0 - 0.25 * smoothstep(8.0, 60.0, L.b * 255.0) : 0.0;
  return mix(L.a, target, t);
}
`;

export const LIFE_GLSL = /* glsl */ `
${LIFE_LEVEL_GLSL}
vec3 mode_life(ModeIn m) {
  vec4 L = texelFetch(u_life, m.cell, 0);
  return vec3(lifeLevel(L, f_clock.y), 0.8, 0.0);
}
`;
