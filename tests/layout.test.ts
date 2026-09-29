import { describe, expect, it } from 'vitest';
import { hexToRgb, srgbToLinear } from '../src/core/color';
import { createParamLayout, paramsDefine } from '../src/core/controller/layout';
import { getDefaults, isGroup, walkSchema } from '../src/schema';

describe('createParamLayout', () => {
  const layout = createParamLayout();

  it('gives every gpu field a slot and nothing else', () => {
    const gpuPaths: string[] = [];
    walkSchema((node, path) => {
      if (!isGroup(node) && node.gpu) gpuPaths.push(path);
    });
    expect(gpuPaths.length).toBeGreaterThan(50);
    expect([...layout.slots.keys()]).toEqual(gpuPaths);
    expect(layout.paths).toEqual(gpuPaths);
  });

  it('is deterministic', () => {
    const again = createParamLayout();
    expect(again.glslPrelude).toBe(layout.glslPrelude);
    for (const [p, s] of layout.slots) {
      const t = again.slots.get(p);
      expect([t?.index, t?.comp, t?.size]).toEqual([s.index, s.comp, s.size]);
    }
  });

  it('never overlaps slots or crosses vec4 boundaries', () => {
    const taken = new Set<number>();
    for (const [path, s] of layout.slots) {
      expect(s.comp + s.size, path).toBeLessThanOrEqual(4);
      if (s.size === 2) expect(s.comp % 2, path).toBe(0);
      if (s.size === 3) expect(s.comp, path).toBe(0);
      expect(s.offset).toBe(s.index * 4 + s.comp);
      for (let i = 0; i < s.size; i++) {
        expect(taken.has(s.offset + i), path).toBe(false);
        taken.add(s.offset + i);
      }
    }
    expect(layout.vec4Count).toBeLessThanOrEqual(64);
    expect(layout.floatCount).toBe(layout.vec4Count * 4);
    expect(Math.max(...taken)).toBeLessThan(layout.floatCount);
  });

  it('prelude declares the block, every define and enum macros', () => {
    const pre = layout.glslPrelude;
    expect(pre).toContain(`layout(std140) uniform ParamsBlock { vec4 u_p[${layout.vec4Count}]; };`);
    for (const [path, s] of layout.slots) {
      const swz = 'xyzw'.slice(s.comp, s.comp + s.size);
      expect(pre).toContain(`#define ${paramsDefine(path)} u_p[${s.index}].${swz}\n`);
    }
    expect(paramsDefine('glow.bloom.strength')).toBe('P_glow_bloom_strength');
    expect(pre).toContain('#define E_color_mapping_spatial 0.0');
    expect(pre).toContain('#define E_color_mapping_noise 4.0');
    expect(pre).toContain('#define E_animation_blend_max 2.0');
    expect(pre).toContain('#define E_modes_life_rule_seeds 3.0');
    expect(pre).toContain('#define MODE_FLOW 0');
    expect(pre).toContain('#define MODE_RAIN 7');
  });

  it('write converts angle, color, enum, bool and vec2', () => {
    const buf = new Float32Array(layout.floatCount);
    const at = (p: string) => layout.slots.get(p)?.offset ?? -1;

    expect(layout.write(buf, 'modes.sphere.lightAngle', 180)).toBe(true);
    expect(buf[at('modes.sphere.lightAngle')]).toBeCloseTo(Math.PI, 5);

    layout.write(buf, 'background.color', '#ff8000');
    const o = at('background.color');
    const [r, g, b] = hexToRgb('#ff8000').map(srgbToLinear);
    expect(buf[o]).toBeCloseTo(r as number, 5);
    expect(buf[o + 1]).toBeCloseTo(g as number, 5);
    expect(buf[o + 2]).toBeCloseTo(b as number, 5);

    layout.write(buf, 'background.color', [0.1, 0.2, 0.3]);
    expect(buf[o + 1]).toBeCloseTo(0.2, 6);

    layout.write(buf, 'color.mapping', 'angular');
    expect(buf[at('color.mapping')]).toBe(2);
    layout.write(buf, 'animation.blend', 'max');
    expect(buf[at('animation.blend')]).toBe(2);

    layout.write(buf, 'scene.center', [0.25, -0.5]);
    expect(buf[at('scene.center')]).toBe(0.25);
    expect(buf[at('scene.center') + 1]).toBe(-0.5);

    layout.write(buf, 'grid.gap', 0.5);
    expect(buf[at('grid.gap')]).toBe(0.5);

    expect(layout.write(buf, 'modes.flow.speed', 1)).toBe(false);
  });

  it('writeAll fills from a full config', () => {
    const buf = new Float32Array(layout.floatCount).fill(-99);
    const cfg = getDefaults();
    layout.writeAll(buf, cfg);
    const at = (p: string) => layout.slots.get(p)?.offset ?? -1;
    expect(buf[at('grid.gap')]).toBeCloseTo(0.27, 6);
    expect(buf[at('color.angle')]).toBeCloseTo((32 * Math.PI) / 180, 6);
    expect(buf[at('modes.sphere.weight')]).toBe(1);
    for (const s of layout.slots.values()) {
      for (let i = 0; i < s.size; i++) expect(buf[s.offset + i]).not.toBe(-99);
    }
  });
});
