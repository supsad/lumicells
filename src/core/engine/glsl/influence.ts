/**
 * Influence footprint shared by the field and life passes (both at cell resolution).
 *
 * Shapes are rounded rects in device px. A radius-only influence arrives as halfSize = 0 and
 * cornerRadius = radius; growing the half extents to at least the corner radius turns both cases
 * into the same SDF (a circle is a fully rounded square).
 */
export const INFLUENCE_GLSL = /* glsl */ `
// Coverage 0..1 of influence i for a cell centered at px: 1 inside, smooth falloff outside,
// widened by half a cell so small shapes still register on at least one cell.
float influenceK(int i, vec2 px, float pitch) {
  vec4 a = f_inf[i * 3];
  vec4 b = f_inf[i * 3 + 1];
  vec2 hs = max(a.zw, vec2(b.x));
  float r = min(b.x, min(hs.x, hs.y));
  float d = sdRoundBox(px - a.xy, hs, r);
  float fo = max(b.y, 0.5 * pitch);
  return 1.0 - smoothstep(-0.5 * pitch, fo, d);
}
`;
