/**
 * Field program variants (src/core/engine/field-variants.ts): which parts of the field shader a
 * frame needs, read from the params and frame blocks exactly as the shader decides, and which
 * compiled variant a slot draws with.
 */
import { describe, expect, it } from 'vitest';
import { Controller } from '../src/core/controller/controller';
import { createParamLayout } from '../src/core/controller/layout';
import { mulberry32 } from '../src/core/controller/math';
import {
  ALL_FEATURES,
  covers,
  FEATURE_NOISE_MAP,
  FEATURE_WARP,
  featureCount,
  MODE_COUNT,
  MODE_WEIGHT_MIN,
  neededFeatures,
  parseFeatureSource,
  pickVariant,
  type VariantState,
  variantToEvict,
  variantToRequest,
  wantedFeatures,
} from '../src/core/engine/field-variants';
import { FRAME_FLOATS, OFF_MISC } from '../src/core/engine/frame-block';
import { ENGINE_MODE_IDS, modesEvalGlsl, modesGlsl } from '../src/core/engine/glsl/modes/index';
import { constantParamsPrelude } from '../src/core/engine/glsl/params';
import { fieldFs, fieldModesFs, fieldPackFs, fieldRestFs } from '../src/core/engine/passes/field';
import { buildHeader } from '../src/core/engine/passes/shared';
import { PRESET_IDS, type PresetId } from '../src/schema';

const bit = (id: (typeof ENGINE_MODE_IDS)[number]) => 1 << ENGINE_MODE_IDS.indexOf(id);

const layout = createParamLayout();
const src = parseFeatureSource(layout.glslPrelude);

/** A frame block with no mapping crossfade (f_misc.y = 1). */
function frameBlock(prevMapping = 0, fade = 1): Float32Array {
  const f = new Float32Array(FRAME_FLOATS);
  f[OFF_MISC] = prevMapping;
  f[OFF_MISC + 1] = fade;
  return f;
}

function paramsWith(values: Record<string, unknown>): Float32Array {
  const p = new Float32Array(layout.floatCount);
  for (const id of ENGINE_MODE_IDS) layout.write(p, `modes.${id}.weight`, 0);
  layout.write(p, 'color.warp', 0);
  layout.write(p, 'color.mapping', 'spatial');
  for (const [path, v] of Object.entries(values)) layout.write(p, path, v);
  return p;
}

describe('parseFeatureSource', () => {
  it('finds every mode weight, the mapping and the warp in the layout prelude', () => {
    for (const [i, id] of ENGINE_MODE_IDS.entries()) {
      expect(src.modeWeights[i]?.offset).toBe(layout.slots.get(`modes.${id}.weight`)?.offset);
    }
    expect(src.mapping.offset).toBe(layout.slots.get('color.mapping')?.offset);
    expect(src.warp.offset).toBe(layout.slots.get('color.warp')?.offset);
  });

  it('reads constants baked into a prelude, and counts what it cannot read as in use', () => {
    const c = parseFeatureSource(constantParamsPrelude());
    const empty = new Float32Array(4);
    // Defaults: flow 0.2 and sphere 1, spatial mapping, warp 0.12.
    expect(neededFeatures(empty, frameBlock(), c)).toBe(bit('flow') | bit('sphere') | FEATURE_WARP);
    const none = parseFeatureSource('');
    const all = (1 << MODE_COUNT) - 1;
    expect(neededFeatures(empty, frameBlock(), none)).toBe(all | FEATURE_WARP);
  });
});

describe('neededFeatures', () => {
  it('matches every preset: modes above the shader threshold, noise mapping, warp', () => {
    for (const preset of PRESET_IDS) {
      const c = new Controller({
        random: mulberry32(1),
        config: { extends: preset as PresetId } as never,
      });
      const f = c.update(0, 0);
      const cfg = c.getConfig();
      let expected = 0;
      for (const id of ENGINE_MODE_IDS) {
        if ((cfg.modes[id] as { weight: number }).weight > 0.001) expected |= bit(id);
      }
      if (cfg.color.mapping === 'noise') expected |= FEATURE_NOISE_MAP;
      if (cfg.color.warp > 0) expected |= FEATURE_WARP;
      expect(neededFeatures(f.params, f.frame, src), preset).toBe(expected);
    }
  });

  it('uses the shader threshold in float32: exactly 0.001 is off, the next float up is on', () => {
    const p = paramsWith({});
    const off = layout.slots.get('modes.wave.weight')?.offset as number;
    p[off] = MODE_WEIGHT_MIN;
    expect(neededFeatures(p, frameBlock(), src) & bit('wave')).toBe(0);
    p[off] = 0.0010001;
    expect(neededFeatures(p, frameBlock(), src) & bit('wave')).toBe(bit('wave'));
    p[off] = Number.NaN;
    expect(neededFeatures(p, frameBlock(), src) & bit('wave')).toBe(bit('wave'));
  });

  it('needs the noise mapping while a crossfade from it runs, and no longer after', () => {
    const p = paramsWith({ 'color.mapping': 'intensity' });
    expect(neededFeatures(p, frameBlock(4, 0.5), src)).toBe(FEATURE_NOISE_MAP);
    expect(neededFeatures(p, frameBlock(4, 1), src)).toBe(0);
    expect(neededFeatures(p, frameBlock(2, 0.5), src)).toBe(0);
    const noise = paramsWith({ 'color.mapping': 'noise' });
    expect(neededFeatures(noise, frameBlock(), src)).toBe(FEATURE_NOISE_MAP);
  });

  it('wants the modes tweening in from 0 before the shader evaluates them', () => {
    const p = paramsWith({ 'modes.pulse.weight': 0.0004, 'modes.rain.weight': 0.5 });
    const needed = neededFeatures(p, frameBlock(), src);
    expect(needed).toBe(bit('rain'));
    expect(wantedFeatures(p, src, needed)).toBe(bit('rain') | bit('pulse'));
  });
});

const v = (mask: number, ready = true, lastUsed = 0): VariantState => ({ mask, ready, lastUsed });

describe('variant selection', () => {
  it('covers / featureCount', () => {
    expect(covers(0b1011, 0b0011)).toBe(true);
    expect(covers(0b1011, 0b0111)).toBe(false);
    expect(featureCount(ALL_FEATURES)).toBe(MODE_COUNT + 2);
    expect(featureCount(0)).toBe(0);
  });

  it('draws with the smallest ready variant that covers the frame, the most recent on a tie', () => {
    const list = [v(0b1111, true, 5), v(0b0011, true, 1), v(0b0111, true, 9), v(0b0101, true, 9)];
    expect(pickVariant(list, 0b0010, -1)).toBe(1);
    // 0b0011 and 0b0101 tie on size: the one drawn with last.
    expect(pickVariant(list, 0b0001, -1)).toBe(3);
    expect(pickVariant(list, 0b1000, -1)).toBe(0);
    expect(pickVariant([v(0b0110, true, 1), v(0b0011, true, 2)], 0b0010, -1)).toBe(1);
    // Not ready yet: skipped.
    expect(pickVariant([v(0b0011, false), v(0b0111)], 0b0001, -1)).toBe(1);
  });

  it('keeps the previous variant while the one a new look needs compiles; nothing on a first frame', () => {
    const list = [v(0b0011), v(0b0111, false)];
    expect(pickVariant(list, 0b0110, 0)).toBe(0);
    expect(pickVariant(list, 0b0110, -1)).toBe(-1);
    expect(pickVariant([v(0b0011, false)], 0b0001, 0)).toBe(-1);
  });

  it('requests a variant only when none (ready or compiling) covers what is wanted', () => {
    expect(variantToRequest([v(0b0111, false)], 0b0101)).toBe(-1);
    expect(variantToRequest([v(0b0011)], 0b0101)).toBe(0b0101);
    expect(variantToRequest([], 0)).toBe(0);
  });

  it('evicts the ready variant used longest ago, never one in use or still compiling', () => {
    const list = [v(1, true, 8), v(2, true, 3), v(4, false, 0), v(8, true, 10)];
    expect(variantToEvict(list, 5, 9)).toBe(-1);
    expect(variantToEvict(list, 4, 9)).toBe(1);
    expect(variantToEvict(list, 4, 2)).toBe(-1);
  });
});

describe('variant GLSL', () => {
  const header = buildHeader(true, layout.glslPrelude);

  it('evaluates the modes of a mask in schema order, and declares only theirs', () => {
    const mask = bit('rain') | bit('flow') | bit('vortex');
    const evals = modesEvalGlsl(mask)
      .split('\n')
      .map((l) => /mode_(\w+)\(m\)/.exec(l)?.[1]);
    expect(evals).toEqual(['flow', 'vortex', 'rain']);
    const fns = modesGlsl(mask);
    for (const id of ENGINE_MODE_IDS) {
      expect(fns.includes(`vec3 mode_${id}(`), id).toBe((mask & bit(id)) !== 0);
    }
    // Every mode uses the shader threshold the selection mirrors.
    expect(modesEvalGlsl()).toContain('_weight > 0.001)');
    expect(Math.fround(0.001)).toBe(MODE_WEIGHT_MIN);
  });

  it('switches the noise mapping and the warp per variant, in each program that has them', () => {
    const fused = fieldFs(header, FEATURE_WARP);
    expect(fused).toContain('#define FIELD_NOISE_MAP 0');
    expect(fused).toContain('#define FIELD_WARP 1');
    const modes = fieldModesFs(header, FEATURE_NOISE_MAP | bit('sphere'));
    expect(modes).toContain('#define FIELD_WARP 0');
    expect(modes).toContain('mode_sphere(m)');
    expect(modes).not.toContain('o_fieldA');
    // The second stage depends on the noise mapping alone (one per mapping, shared by variants).
    for (const out of ['color', 'scalar'] as const) {
      const rest = fieldRestFs(header, ALL_FEATURES, out);
      expect(rest).toContain('#define FIELD_NOISE_MAP 1');
      expect(rest).toContain('#define FIELD_WARP 0');
      expect(rest).not.toMatch(/mode_\w+\(/);
      expect(fieldRestFs(header, ALL_FEATURES & ~FEATURE_NOISE_MAP, out)).toBe(
        fieldRestFs(header, 0, out),
      );
    }
  });

  it('staged pass: one output per heavy program, the outputs packed by a tiny one', () => {
    const d3d = buildHeader(true, layout.glslPrelude, true);
    const outputs = (src: string) =>
      (src.match(/^\s*(?:layout\([^)]*\)\s*)?out vec4 /gm) ?? []).length;
    expect(outputs(fieldModesFs(d3d, ALL_FEATURES))).toBe(1);
    expect(outputs(fieldRestFs(d3d, ALL_FEATURES, 'color'))).toBe(1);
    expect(fieldRestFs(d3d, 0, 'color')).toContain('o_rest = vec4(base, I);');
    expect(fieldRestFs(d3d, 0, 'scalar')).toContain('o_rest = vec4(t, hot, dead, Ipre);');
    // The pack writes the fused pass's outputs, from the values the second stage stored.
    const pack = fieldPackFs(d3d);
    const fusedOut = fieldFs(d3d, 0).slice(fieldFs(d3d, 0).lastIndexOf('#if MRT_PAD'));
    expect(pack).toContain(fusedOut.slice(0, fusedOut.lastIndexOf('}')).trim());
    expect(pack).not.toContain('u_lut');
  });
});

describe('live changes wait for their field variant (Controller.setFieldGate)', () => {
  const DT = 1 / 60;

  /** A controller with vortex off, the warp off and the spatial mapping. */
  function ctl(): Controller {
    const c = new Controller({ random: mulberry32(3), config: { extends: 'reference' } as never });
    c.setConfig(
      { modes: { vortex: { weight: 0 } }, color: { warp: 0, mapping: 'spatial' } },
      { transition: 0 },
    );
    c.update(DT);
    return c;
  }

  it('holds a mode tweening in from 0 until the renderer can draw it, then runs the whole tween', () => {
    let ready = false;
    const asked: number[] = [];
    const held = ctl();
    held.setFieldGate((pending) => {
      asked.push(pending);
      return ready;
    });
    const free = ctl();
    held.setConfig({ modes: { vortex: { weight: 1 } } }, { transition: 600 });
    free.setConfig({ modes: { vortex: { weight: 1 } } }, { transition: 600 });
    for (let i = 0; i < 90; i++) {
      const f = held.update(DT);
      // The variant is asked for ahead of time; the frame needs exactly what it needed before.
      expect(f.fieldPending).toBe(bit('vortex'));
      expect(neededFeatures(f.params, f.frame, src) & bit('vortex')).toBe(0);
    }
    expect(held.getEffective('modes.vortex.weight')).toBe(0);
    expect(asked.every((m) => m === bit('vortex'))).toBe(true);
    ready = true;
    // From here on it moves exactly like a tween that started now.
    for (let i = 0; i < 30; i++) {
      held.update(DT);
      free.update(DT);
      expect(held.getEffective('modes.vortex.weight')).toBe(
        free.getEffective('modes.vortex.weight'),
      );
    }
    expect(held.getEffective('modes.vortex.weight')).toBeGreaterThan(0.9);
    expect(held.update(DT).fieldPending).toBe(0);
  });

  it('holds a crossfade into the noise mapping at mix 0, and the warp at 0', () => {
    let ready = false;
    const c = ctl();
    c.setFieldGate(() => ready);
    c.setConfig({ color: { mapping: 'noise', warp: 0.2 } }, { transition: 600 });
    for (let i = 0; i < 30; i++) {
      const f = c.update(DT);
      expect(f.fieldPending).toBe(FEATURE_NOISE_MAP | FEATURE_WARP);
      // Mix 0: the previous mapping alone is on screen (mix(prev, noise, 0) is prev).
      expect(f.frame[OFF_MISC + 1]).toBe(0);
      expect(c.getEffective('color.warp')).toBe(0);
    }
    ready = true;
    const f = c.update(DT);
    expect(f.frame[OFF_MISC + 1]).toBeGreaterThan(0);
    expect(c.getEffective('color.warp')).toBeGreaterThan(0);
    // Started: the frame needs them now (their variant is ready), nothing is pending any more.
    expect(neededFeatures(f.params, f.frame, src)).toBe(
      neededFeatures(f.params, f.frame, src) | FEATURE_NOISE_MAP | FEATURE_WARP,
    );
    expect(c.update(DT).fieldPending).toBe(0);
  });

  it('never holds a tween that turns a feature off, nor without a gate', () => {
    const c = ctl();
    c.setConfig({ modes: { vortex: { weight: 1 } } }, { transition: 0 });
    c.update(DT);
    let calls = 0;
    c.setFieldGate(() => {
      calls++;
      return false;
    });
    c.setConfig({ modes: { vortex: { weight: 0 } } }, { transition: 600 });
    c.update(DT);
    expect(c.getEffective('modes.vortex.weight')).toBeLessThan(1);
    expect(calls).toBe(0);
    const free = ctl();
    free.setConfig({ modes: { vortex: { weight: 1 } } }, { transition: 600 });
    const f = free.update(DT);
    expect(f.fieldPending).toBe(bit('vortex'));
    expect(free.getEffective('modes.vortex.weight')).toBeGreaterThan(0);
  });

  it('gives up holding after a while (a variant that never gets ready)', () => {
    const c = ctl();
    c.setFieldGate(() => false);
    c.setConfig({ modes: { vortex: { weight: 1 } } }, { transition: 600 });
    for (let i = 0; i < 9.5 * 60; i++) c.update(DT);
    expect(c.getEffective('modes.vortex.weight')).toBe(0);
    for (let i = 0; i < 60; i++) c.update(DT);
    expect(c.getEffective('modes.vortex.weight')).toBeGreaterThan(0.5);
  });
});
