/**
 * Sphere: a thick hollow orb (the reference look).
 *
 * Profile (radii in mode units, R = radius): a round dark hole up to `hole`, a soft inner edge
 * over `holeSoftness`, then a broad, evenly lit plateau up to R (rimPower tilts it toward the
 * rim). Outside R the orb does not simply dim: cell DENSITY (the envelope, which drives sparsity)
 * falls as a gaussian of width `outerFalloff` (in units of R) while the BRIGHTNESS of the cells
 * that remain falls only half as fast, so the outskirts read as sparse, crisp survivors. A
 * half-lambert key light with a narrow highlight, an asymmetric fade toward `fadeAngle` and a 3D
 * noise texture that spins with the orb (tilt + rotation phase) break the symmetry.
 * Returns (I, envelope, accent) where accent marks organic patches along the inner edge (the
 * field pass tints them with color.accent on the cool side of the palette).
 */
export const SPHERE_GLSL = /* glsl */ `
vec3 mode_sphere(ModeIn m) {
  float R0 = max(P_modes_sphere_radius, 0.02);
  // The shell may sit off-center around the hole (thicker on the side it is shifted to); the
  // hole itself always stays on the composition center.
  vec2 sp = m.p - P_modes_sphere_shift;
  float rr = length(sp);
  vec2 dir = rr > 1e-5 ? sp / rr : vec2(1.0, 0.0);
  float br = 1.0 + P_modes_sphere_breathe * sin(f_phaseA.z);
  float bl = 0.7 * m.cs;
  float hs = sqrt(sq(P_modes_sphere_holeSoftness) + sq(bl));
  // hole = 0 is a solid ball (no dark dot or rim left in the middle).
  bool solid = P_modes_sphere_hole < 1e-3;
  float surf = P_modes_sphere_surface;
  float ss = P_modes_sphere_surfaceScale;

  // All five noises of the orb come from one noise call in a loop (see RUNTIME_COUNT): k = 0 is
  // the outline, which sizes the orb; k = 1..4 are the surface noises (inner texture, its finer
  // octave, outskirts, accent patches), sampled on the rotated normal of the sized orb, and only
  // where they show.
  float R = 0.0;
  float r = 0.0;
  float rc = 0.0;
  float holeR = 0.0;
  float holeMask = 0.0;
  vec3 n = vec3(0.0);
  vec3 sn = vec3(0.0);
  vec4 g = vec4(0.0);
  int noises = 1;
  for (int k = 0; k < RUNTIME_COUNT(noises); k++) {
    vec3 q = k == 0 ? vec3(dir * 1.3 + vec2(3.1, 7.7), f_clock.x * 0.125)
           : k == 1 ? sn * ss + 11.0
           : k == 2 ? sn * ss * 2.1 + vec3(5.0, 1.0, 9.0)
           : k == 3 ? vec3(sp * ss + 3.0, f_clock.x * 0.125)
           : sn * 3.4 + vec3(29.0, 3.0, 17.0);
    float v = gnoise3(q);
    if (k == 0) {
      // Irregular outline: noise on the unit circle (no atan seam), evolving with the clock.
      float wob = v;
      float scale = br * (1.0 + P_modes_sphere_wobble * wob * 1.6);
      R = R0 * scale;
      r = rr / R;
      // The hole wobbles far less than the outline: it frames the title and must stay round.
      holeR = P_modes_sphere_hole * br * (1.0 + P_modes_sphere_wobble * wob * 0.5);
      holeMask = solid ? 1.0 : smoothstep(holeR - 0.25 * bl, holeR + hs, m.r);
      rc = min(r, 1.0);
      n = vec3(dir * rc, sqrt(max(1.0 - rc * rc, 0.0)));
      if (surf > 0.001 || holeMask > 0.0) {
        float tl = P_modes_sphere_tilt;
        float th = f_phaseA.y;
        sn = n;
        sn = vec3(sn.x, sn.y * cos(tl) - sn.z * sin(tl), sn.y * sin(tl) + sn.z * cos(tl));
        sn = vec3(sn.x * cos(th) + sn.z * sin(th), sn.y, -sn.x * sin(th) + sn.z * cos(th));
        noises = 5;
      }
    } else if (k == 1) g.x = v;
    else if (k == 2) g.y = v;
    else if (k == 3) g.z = v;
    else g.w = v;
  }

  float la = P_modes_sphere_lightAngle;
  vec3 L = normalize(vec3(cos(la), sin(la), 0.9));
  float ndl = dot(n, L);
  // Soft wrap light on the body; most of the light shows as a narrow highlight that pushes a few
  // cells over the hot threshold on the lit inner edge.
  float ls = P_modes_sphere_lightStrength;
  // Up to ls = 0.5 a gentle wrap (the hollow reference ring); above it the shadow side deepens
  // toward a real terminator, so a solid orb reads as a lit planet.
  float shadeK = 0.3 * ls + 2.4 * sq(max(ls - 0.5, 0.0));
  float key = 1.0 - shadeK * (0.5 - 0.5 * ndl);
  float spec = ls * 0.35 * pow(max(ndl, 0.0), 24.0);

  float shellIn = 0.74 + 0.18 * pow(rc, max(P_modes_sphere_rimPower, 0.05));
  float ro = max(r - 1.0, 0.0);
  float of = max(P_modes_sphere_outerFalloff, 0.02);
  float dens = exp(-sq(ro / of));
  float bri = r < 1.0 ? shellIn : 0.92 * exp(-ro / (2.0 * of));

  float fa = P_modes_sphere_fadeAngle;
  float fd = dot(sp, vec2(cos(fa), sin(fa))) / R;
  float fade = 1.0 - P_modes_sphere_fadeAmount * smoothstep(0.9, 1.35, fd);

  float ns = 0.5;
  float patchN = 0.0;
  if (noises > 1) {
    float fw = ss * m.cs / R;
    // Every noise fades to its mean once it gets finer than a cell (noiseBand), so large
    // surface scales or a small orb do not alias into crawling per-cell speckle.
    float nIn = 0.7 * noiseBand(fw) * g.x + 0.3 * bandLimit(2.1 * fw) * g.y;
    float nOut = noiseBand(ss * m.cs) * g.z;
    ns = sat(0.5 + 1.1 * mix(nIn, nOut, smoothstep(0.9, 1.15, r)));
    patchN = noiseBand(3.4 * m.cs / R) * g.w;
  }
  float tex = mix(1.0, 0.35 + 1.3 * ns, surf);
  // Density follows the texture outside the rim too: the outskirts thin out in patches.
  float env = holeMask * fade * dens * mix(1.0, tex, smoothstep(0.95, 1.3, r));
  // A lit inner rim just outside the hole: the brightest cells frame the hole with a crisp edge.
  float rimIn = solid ? 0.0 : exp(-sq((m.r - holeR - hs) / (0.6 * hs + bl)));
  // The fade thins the density out much more than it dims the survivors (sparse, still crisp).
  float I = holeMask * bri * key * mix(1.0, fade, 0.25) * (tex + spec * (0.5 + ns)) * (1.0 + 0.2 * rimIn);

  float band = 1.0 - smoothstep(holeR + hs, holeR + hs + 0.6 * R, m.r);
  float accent = holeMask * band * smoothstep(-0.2, 0.2, patchN);
  return vec3(I, env, accent);
}
`;
