/**
 * Every ParamsBlock macro the shaders read, with its schema default in GPU units
 * (angles in radians, colors in linear RGB, enums as float indices).
 *
 * The engine does not import the schema: it receives the generated prelude and only guards
 * against missing names here, so a renamed schema field degrades to its default (and is
 * reported by missingParamMacros) instead of breaking shader compilation.
 */

export const PARAM_MACRO_DEFAULTS: ReadonlyArray<readonly [name: string, glsl: string]> = [
  ['P_grid_gap', '0.27'],
  ['P_grid_roundness', '0.3'],
  ['P_grid_softness', '0.6'],
  ['P_grid_emitter', '0.18'],
  ['P_grid_bevel', '0.0'],
  ['P_scene_center', 'vec2(-0.02, -0.02)'],
  ['P_scene_zoom', '1.0'],
  ['P_animation_blend', '0.0'],
  ['P_animation_brightness', '1.0'],
  ['P_animation_gamma', '1.15'],
  ['P_animation_floor', '0.16'],
  ['P_animation_energy', '1.0'],
  ['P_animation_flicker_amount', '0.18'],
  ['P_animation_flicker_rate', '0.7'],
  ['P_animation_sparkle_amount', '0.35'],
  ['P_animation_sparkle_rate', '0.008'],
  ['P_animation_sparkle_duration', '0.5'],
  ['P_animation_sparsity_amount', '0.55'],
  ['P_animation_sparsity_period', '3.0'],
  ['P_modes_flow_weight', '0.2'],
  ['P_modes_flow_scale', '1.6'],
  ['P_modes_flow_direction', '0.5235988'],
  ['P_modes_flow_threshold', '0.45'],
  ['P_modes_flow_softness', '0.3'],
  ['P_modes_sphere_weight', '1.0'],
  ['P_modes_sphere_radius', '0.66'],
  ['P_modes_sphere_hole', '0.24'],
  ['P_modes_sphere_holeSoftness', '0.16'],
  ['P_modes_sphere_rimPower', '1.3'],
  ['P_modes_sphere_outerFalloff', '0.45'],
  ['P_modes_sphere_lightAngle', '3.4906585'],
  ['P_modes_sphere_lightStrength', '0.45'],
  ['P_modes_sphere_tilt', '0.3490659'],
  ['P_modes_sphere_surface', '0.55'],
  ['P_modes_sphere_surfaceScale', '2.5'],
  ['P_modes_sphere_wobble', '0.08'],
  ['P_modes_sphere_breathe', '0.025'],
  ['P_modes_sphere_fadeAngle', '0.0'],
  ['P_modes_sphere_fadeAmount', '0.75'],
  ['P_modes_pulse_weight', '0.0'],
  ['P_modes_pulse_frequency', '3.0'],
  ['P_modes_pulse_width', '0.14'],
  ['P_modes_pulse_breathe', '0.35'],
  ['P_modes_pulse_falloff', '1.0'],
  ['P_modes_pulse_origin', 'vec2(0.0, 0.0)'],
  ['P_modes_wave_weight', '0.0'],
  ['P_modes_wave_angle', '0.3490659'],
  ['P_modes_wave_frequency', '2.5'],
  ['P_modes_wave_sharpness', '0.35'],
  ['P_modes_wave_interference', '0.5'],
  ['P_modes_ripple_weight', '0.0'],
  ['P_modes_ripple_rate', '1.2'],
  ['P_modes_ripple_speed', '0.4'],
  ['P_modes_ripple_width', '0.09'],
  ['P_modes_ripple_life', '2.5'],
  ['P_modes_vortex_weight', '0.0'],
  ['P_modes_vortex_arms', '3.0'],
  ['P_modes_vortex_twist', '3.0'],
  ['P_modes_vortex_falloff', '0.9'],
  ['P_modes_vortex_sharpness', '0.4'],
  ['P_modes_life_weight', '0.0'],
  ['P_modes_life_fadeSteps', '4.0'],
  ['P_modes_rain_weight', '0.0'],
  ['P_modes_rain_density', '0.25'],
  ['P_modes_rain_tail', '0.5'],
  ['P_modes_rain_angle', '0.0'],
  ['P_color_mapping', '0.0'],
  ['P_color_angle', '0.5585054'],
  ['P_color_scale', '1.0'],
  ['P_color_offset', '0.0'],
  ['P_color_warp', '0.12'],
  ['P_color_warpScale', '1.3'],
  ['P_color_jitter', '0.06'],
  ['P_color_intensityShift', '0.12'],
  ['P_color_saturation', '1.05'],
  ['P_color_hot_amount', '0.35'],
  ['P_color_hot_threshold', '0.78'],
  ['P_color_hot_core', '0.55'],
  ['P_background_color', 'vec3(0.0, 0.0, 0.0319)'],
  ['P_background_vignette', '0.35'],
  ['P_background_spotA_color', 'vec3(0.1441, 0.0137, 0.1612)'],
  ['P_background_spotA_position', 'vec2(-1.3, -0.2)'],
  ['P_background_spotA_radius', '1.1'],
  ['P_background_spotA_strength', '0.55'],
  ['P_background_spotB_color', 'vec3(0.0080, 0.0144, 0.2086)'],
  ['P_background_spotB_position', 'vec2(-0.8, 1.1)'],
  ['P_background_spotB_radius', '0.9'],
  ['P_background_spotB_strength', '0.5'],
  ['P_glow_halo_strength', '0.55'],
  ['P_glow_halo_radius', '0.18'],
  ['P_glow_bloom_strength', '0.35'],
  ['P_glow_bloom_threshold', '0.45'],
  ['P_glow_bloom_knee', '0.5'],
  ['P_glow_haze_strength', '0.22'],
  ['P_glow_saturation', '1.15'],
  ['P_glow_exposure', '1.0'],
  ['P_glow_whitePoint', '4.0'],
  ['P_lift_brightness', '0.7'],
  ['P_lift_whiten', '0.2'],
  ['P_lift_shadow', '0.4'],
  ['P_lift_halo', '0.8'],
  ['E_animation_blend_screen', '0.0'],
  ['E_animation_blend_add', '1.0'],
  ['E_animation_blend_max', '2.0'],
  ['E_color_mapping_spatial', '0.0'],
  ['E_color_mapping_radial', '1.0'],
  ['E_color_mapping_angular', '2.0'],
  ['E_color_mapping_intensity', '3.0'],
  ['E_color_mapping_noise', '4.0'],
];

/** `#ifndef` guards so the shaders compile against any prelude (or none). */
export const PARAM_DEFAULTS_GLSL = PARAM_MACRO_DEFAULTS.map(
  ([name, value]) => `#ifndef ${name}\n#define ${name} ${value}\n#endif`,
).join('\n');

/** Names the engine reads that the given prelude does not define. */
export function missingParamMacros(prelude: string): string[] {
  const defined = new Set<string>();
  const re = /#define\s+([A-Za-z_]\w*)/g;
  for (let m = re.exec(prelude); m; m = re.exec(prelude)) {
    if (m[1]) defined.add(m[1]);
  }
  return PARAM_MACRO_DEFAULTS.map(([name]) => name).filter((name) => !defined.has(name));
}

/**
 * A self-contained prelude with the defaults baked in as constants (no ParamsBlock).
 * Useful for harnesses and tests that run the engine without the schema/controller.
 */
export function constantParamsPrelude(): string {
  return PARAM_MACRO_DEFAULTS.map(([name, value]) => `#define ${name} ${value}`).join('\n');
}
