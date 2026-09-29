/**
 * Sphere: a thick hollow orb (the reference look).
 *
 * Profile (radii in mode units, R = radius): dark hole up to `hole`, soft inner edge over
 * `holeSoftness`, a broad plateau that rises gently toward the rim (rimPower), then an exponential
 * falloff outside (outerFalloff, in units of R) that matches the plateau at r = R. A half-lambert
 * key light, an asymmetric fade toward `fadeAngle` and a 3D noise texture that spins with the orb
 * (tilt + rotation phase) break the symmetry. Returns (I, envelope, accent) where accent marks
 * patchy cells along the inner edge (tinted toward cyan on the cool side of the palette).
 */
export const SPHERE_GLSL = /* glsl */ `
vec3 mode_sphere(ModeIn m) {
  float R0 = max(P_modes_sphere_radius, 0.02);
  float rr = m.r;
  vec2 dir = rr > 1e-5 ? m.p / rr : vec2(1.0, 0.0);
  // Irregular outline: noise on the unit circle (no atan seam), evolving with the clock.
  float wob = gnoise3(vec3(dir * 1.3 + vec2(3.1, 7.7), f_clock.x * 0.125));
  float scale = (1.0 + P_modes_sphere_breathe * sin(f_phaseA.z)) * (1.0 + P_modes_sphere_wobble * wob * 1.6);
  float R = R0 * scale;
  float r = rr / R;
  float bl = 0.7 * m.cs;

  float holeR = P_modes_sphere_hole * scale;
  float hs = sqrt(sq(P_modes_sphere_holeSoftness) + sq(bl));
  float holeMask = smoothstep(holeR - 0.25 * bl, holeR + hs, rr);

  float rc = min(r, 1.0);
  vec3 n = vec3(dir * rc, sqrt(max(1.0 - rc * rc, 0.0)));
  float la = P_modes_sphere_lightAngle;
  vec3 L = normalize(vec3(cos(la), sin(la), 0.9));
  float ndl = dot(n, L);
  // Soft wrap light on the body; most of the light shows as a narrow highlight that pushes cells
  // over the hot threshold (the pastel cores sit on the lit inner edge, as in the reference).
  float ls = P_modes_sphere_lightStrength;
  float key = 1.0 - 0.15 * ls * (0.5 - 0.5 * ndl);
  float spec = ls * 0.35 * pow(max(ndl, 0.0), 24.0);

  // Plateau around 0.6-0.8: bright after the tonemap toe, yet only texture peaks and the light's
  // highlight cross the hot threshold.
  float shellIn = 0.45 + 0.35 * pow(rc, max(P_modes_sphere_rimPower, 0.05));
  float outside = 0.8 * exp(-max(r - 1.0, 0.0) / max(P_modes_sphere_outerFalloff, 0.02));
  float prof = r < 1.0 ? shellIn : outside;
  // The envelope (which drives sparsity) falls slower than the intensity: the outskirts thin out
  // into isolated, still bright cells instead of a uniform dim fringe.
  float profEnv = r < 1.0 ? shellIn : sqrt(0.8 * outside);

  float fa = P_modes_sphere_fadeAngle;
  float fd = dot(m.p, vec2(cos(fa), sin(fa))) / R;
  float fade = 1.0 - P_modes_sphere_fadeAmount * smoothstep(1.05, 1.75, fd);

  float env = holeMask * profEnv * key * fade;
  float body = holeMask * prof * key * sqrt(fade);

  float surf = P_modes_sphere_surface;
  float ns = 0.5;
  float patchN = 0.0;
  if (surf > 0.001 || holeMask > 0.0) {
    float tl = P_modes_sphere_tilt;
    float th = f_phaseA.y;
    vec3 sn = n;
    sn = vec3(sn.x, sn.y * cos(tl) - sn.z * sin(tl), sn.y * sin(tl) + sn.z * cos(tl));
    sn = vec3(sn.x * cos(th) + sn.z * sin(th), sn.y, -sn.x * sin(th) + sn.z * cos(th));
    float ss = P_modes_sphere_surfaceScale;
    float fw = ss * m.cs / R;
    float nIn = 0.7 * gnoise3(sn * ss + 11.0)
              + 0.3 * bandLimit(2.1 * fw) * gnoise3(sn * ss * 2.1 + vec3(5.0, 1.0, 9.0));
    float nOut = gnoise3(vec3(m.p * ss + 3.0, f_clock.x * 0.125));
    ns = sat(0.5 + 1.1 * mix(nIn, nOut, smoothstep(0.9, 1.15, r)));
    patchN = gnoise3(sn * 3.4 + vec3(29.0, 3.0, 17.0));
  }
  float I = body * (mix(1.0, 0.35 + 1.3 * ns, surf) + spec * (0.5 + ns));

  float band = 1.0 - smoothstep(holeR + 0.5 * hs, holeR + hs + 0.3 * R, rr);
  float accent = holeMask * band * smoothstep(-0.05, 0.25, patchN);
  return vec3(I, env, accent);
}
`;
