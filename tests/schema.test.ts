import { describe, expect, it } from 'vitest';
import {
  cloneData,
  DEFAULT_SCHEMA_URL,
  deepMerge,
  diffConfigs,
  type FieldDef,
  flattenLeaves,
  getDefaults,
  getField,
  getLeafPaths,
  getNode,
  getPath,
  getPresetConfig,
  isGroup,
  MODE_IDS,
  normalizeConfig,
  normalizePatch,
  PRESET_IDS,
  PRESETS,
  posterCss,
  schema,
  setPath,
  stableStringify,
  toConfigFile,
  toHtmlSnippet,
  toJsonSchema,
  toJsonSnippet,
  toReactSnippet,
  toTsSnippet,
  validateConfig,
  walkSchema,
} from '../src/schema';

const codes = (issues: { code: string; path: string }[]) =>
  issues.map((i) => `${i.code}@${i.path}`);

describe('schema tree', () => {
  it('has the expected top-level groups in order', () => {
    expect(Object.keys(schema.fields)).toEqual([
      'grid',
      'scene',
      'animation',
      'modes',
      'color',
      'background',
      'glow',
      'lift',
      'interaction',
      'render',
      'transition',
    ]);
    expect(Object.keys(schema.fields.modes.fields)).toEqual([...MODE_IDS]);
  });

  it('every mode is a mode group whose first field is a gpu weight', () => {
    for (const id of MODE_IDS) {
      const g = schema.fields.modes.fields[id];
      expect(g.role).toBe('mode');
      const first = Object.keys(g.fields)[0];
      expect(first).toBe('weight');
      expect((g.fields as Record<string, FieldDef>).weight?.gpu).toBe(true);
    }
  });

  it('defaults are inside their ranges and labels are present', () => {
    walkSchema((node, path) => {
      expect(node.label, path).toBeTruthy();
      if (isGroup(node)) return;
      expect(node.description, path).toBeTruthy();
      const d = node.default;
      if (node.kind === 'number' || node.kind === 'int' || node.kind === 'angle') {
        expect(d as number, path).toBeGreaterThanOrEqual(node.min);
        expect(d as number, path).toBeLessThanOrEqual(node.max);
        if (node.kind === 'int') expect(Number.isInteger(d), path).toBe(true);
      }
      if (node.kind === 'enum') {
        expect(node.values, path).toContain(d);
        if (node.labels)
          expect(Object.keys(node.labels).sort(), path).toEqual([...node.values].sort());
      }
      if (node.kind === 'vec2') {
        for (const v of d as number[]) {
          expect(v, path).toBeGreaterThanOrEqual(node.min);
          expect(v, path).toBeLessThanOrEqual(node.max);
        }
      }
      if (node.kind === 'color') expect(d, path).toMatch(/^#[0-9a-f]{6}$/);
      if (node.kind === 'palette')
        for (const c of d as string[]) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    });
  });

  it('visibleWhen points at existing fields', () => {
    walkSchema((node, path) => {
      if (node.visibleWhen) expect(getField(node.visibleWhen.path), path).toBeDefined();
    });
  });

  it('spec spot checks', () => {
    const d = getDefaults();
    expect(d.version).toBe(1);
    expect(d.grid.count).toBe(31);
    expect(d.scene.center).toEqual([-0.02, -0.02]);
    expect(d.color.palette).toHaveLength(12);
    expect(d.background.color).toBe('#000032');
    expect(d.transition).toBe(600);
    expect(getField('color.mapping')).toMatchObject({
      kind: 'enum',
      transition: 'crossfade',
      gpu: true,
    });
    expect(getField('color.interpolation')?.live).toBe('lut');
    expect(getField('color.palette')?.live).toBe('lut');
    expect(getField('modes.life.rule')?.live).toBe('restart');
    expect(getField('grid.count')?.live).toBe('realloc');
    expect(getField('render.quality')?.live).toBe('static');
    expect(getField('glow.bloom.radius')?.gpu).toBe(false);
    expect(getField('modes.sphere.lightAngle')).toMatchObject({ kind: 'angle', fullCircle: true });
    expect(getField('modes.sphere.tilt')).toMatchObject({ min: -60, max: 60, fullCircle: false });
  });
});

describe('defaults', () => {
  it('match every schema default and are fresh copies', () => {
    const a = getDefaults();
    for (const p of getLeafPaths()) expect(getPath(a, p), p).toEqual(getField(p)?.default);
    a.color.palette.push('#ffffff');
    a.scene.center[0] = 5;
    const b = getDefaults();
    expect(b.color.palette).toHaveLength(12);
    expect(b.scene.center[0]).toBe(-0.02);
    expect(getField('color.palette')?.default).toHaveLength(12);
  });

  it('normalizing defaults yields no issues', () => {
    const r = normalizeConfig(getDefaults());
    expect(r.issues).toEqual([]);
    expect(r.config).toEqual(getDefaults());
    expect(normalizeConfig(undefined).config).toEqual(getDefaults());
    expect(normalizeConfig({}).issues).toEqual([]);
  });
});

describe('paths', () => {
  it('get/set by path', () => {
    const d = getDefaults();
    expect(getPath(d, 'glow.bloom.strength')).toBe(0.8);
    expect(getPath(d, 'glow.nope.x')).toBeUndefined();
    const e = setPath(d, 'glow.bloom.strength', 1);
    expect(e.glow.bloom.strength).toBe(1);
    expect(d.glow.bloom.strength).toBe(0.8);
    expect(e.grid).toBe(d.grid); // untouched branches are shared
    expect(e.glow.halo).toBe(d.glow.halo);
    expect(setPath({}, 'a.b.c', 1)).toEqual({ a: { b: { c: 1 } } });
  });

  it('flattenLeaves covers every leaf, arrays as leaves', () => {
    const m = flattenLeaves(getDefaults());
    expect([...m.keys()]).toEqual(getLeafPaths());
    expect(m.get('color.palette')).toHaveLength(12);
    expect(m.get('scene.center')).toEqual([-0.02, -0.02]);
    expect(m.has('transition')).toBe(true);
  });

  it('diffConfigs lists changed leaves in schema order', () => {
    const a = getDefaults();
    let b = setPath(a, 'color.palette', ['#ffffff']);
    b = setPath(b, 'grid.gap', 0.3);
    b = setPath(b, 'scene.center', [-0.02, -0.02]);
    expect(diffConfigs(a, b)).toEqual(['grid.gap', 'color.palette']);
    expect(diffConfigs(a, cloneData(a))).toEqual([]);
  });

  it('deepMerge merges objects and replaces arrays', () => {
    const base = { a: { x: 1, y: [1, 2, 3] }, b: 2 };
    const out = deepMerge(base, { a: { y: [9] }, c: 3, b: undefined });
    expect(out).toEqual({ a: { x: 1, y: [9] }, b: 2, c: 3 });
    expect(base.a.y).toEqual([1, 2, 3]);
  });

  it('stableStringify is key-order independent', () => {
    expect(stableStringify({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: 'x' } })).toBe(
      stableStringify({ a: { c: 'x', d: [1, { y: 2, z: 1 }] }, b: 1 }),
    );
    expect(stableStringify({ a: undefined, b: Number.NaN })).toBe('{"b":null}');
  });

  it('getNode resolves groups and leaves', () => {
    expect(isGroup(getNode('modes.sphere'))).toBe(true);
    expect(getNode('modes.sphere.radius')?.kind).toBe('number');
    expect(getNode('modes.nope')).toBeUndefined();
  });
});

describe('normalizeConfig', () => {
  it('clamps numbers and vec2 components', () => {
    const r = normalizeConfig({ grid: { gap: 5 }, scene: { center: [3, -0.5] } });
    expect(r.config.grid.gap).toBe(0.6);
    expect(r.config.scene.center).toEqual([1, -0.5]);
    expect(codes(r.issues)).toEqual(['clamped@grid.gap', 'clamped@scene.center.0']);
    expect(r.issues[0]?.value).toBe(5);
  });

  it('rounds ints and wraps full-circle angles', () => {
    const r = normalizeConfig({
      grid: { count: 40.6 },
      modes: { sphere: { lightAngle: 370, tilt: 90 }, wave: { angle: -30 } },
    });
    expect(r.config.grid.count).toBe(41);
    expect(r.config.modes.sphere.lightAngle).toBe(10);
    expect(r.config.modes.wave.angle).toBe(330);
    expect(r.config.modes.sphere.tilt).toBe(60);
    expect(codes(r.issues)).toEqual(['clamped@modes.sphere.tilt']);
  });

  it('coerces numeric strings and booleans with bad-type issues', () => {
    const r = normalizeConfig({ grid: { gap: '0.3' }, lift: { enabled: 'false' } });
    expect(r.config.grid.gap).toBe(0.3);
    expect(r.config.lift.enabled).toBe(false);
    expect(codes(r.issues)).toEqual(['bad-type@grid.gap', 'bad-type@lift.enabled']);
  });

  it('falls back to default for bad types and enums', () => {
    const r = normalizeConfig({
      grid: { gap: 'wide', roundness: Number.NaN },
      color: { mapping: 'diagonal' },
      animation: { flicker: 3 },
      scene: { center: [1] },
    });
    const d = getDefaults();
    expect(r.config.grid.gap).toBe(d.grid.gap);
    expect(r.config.grid.roundness).toBe(d.grid.roundness);
    expect(r.config.color.mapping).toBe('spatial');
    expect(r.config.animation.flicker).toEqual(d.animation.flicker);
    expect(r.config.scene.center).toEqual(d.scene.center);
    expect(codes(r.issues)).toEqual([
      'bad-type@grid.gap',
      'bad-type@grid.roundness',
      'bad-type@scene.center',
      'bad-type@animation.flicker',
      'bad-type@color.mapping',
    ]);
  });

  it('normalizes colors and reports bad ones', () => {
    const r = normalizeConfig({
      background: { color: '#ABC', spotA: { color: 'red' } },
    });
    expect(r.config.background.color).toBe('#aabbcc');
    expect(r.config.background.spotA.color).toBe('#6a1f6e');
    expect(codes(r.issues)).toEqual(['bad-color@background.spotA.color']);
  });

  it('filters, caps and validates the palette', () => {
    const many = Array.from(
      { length: 40 },
      (_, i) => `#${(i * 5).toString(16).padStart(2, '0')}0000`,
    );
    const r = normalizeConfig({ color: { palette: many } });
    expect(r.config.color.palette).toHaveLength(32);
    expect(codes(r.issues)).toEqual(['out-of-range@color.palette']);

    const r2 = normalizeConfig({ color: { palette: ['#FFF', 'nope', '#000000'] } });
    expect(r2.config.color.palette).toEqual(['#ffffff', '#000000']);
    expect(codes(r2.issues)).toEqual(['bad-color@color.palette.1']);

    const r3 = normalizeConfig({ color: { palette: ['nope'] } });
    expect(r3.config.color.palette).toEqual(getDefaults().color.palette);
    expect(codes(r3.issues)).toEqual(['bad-color@color.palette.0', 'out-of-range@color.palette']);

    const r4 = normalizeConfig({ color: { palette: 42 } });
    expect(codes(r4.issues)).toEqual(['bad-type@color.palette']);
  });

  it('drops unknown keys but accepts file meta keys', () => {
    const r = normalizeConfig({
      $schema: 'x',
      version: 1,
      foo: 1,
      grid: { gap: 0.3, bar: 2 },
      modes: { sphere: { radius: 0.5, spin: 1 } },
    });
    expect(codes(r.issues)).toEqual([
      'unknown-key@grid.bar',
      'unknown-key@modes.sphere.spin',
      'unknown-key@foo',
    ]);
    expect(r.config.grid.gap).toBe(0.3);
    expect(r.config.modes.sphere.radius).toBe(0.5);
    expect('foo' in r.config).toBe(false);
    expect('$schema' in r.config).toBe(false);
  });

  it('never throws on garbage', () => {
    for (const raw of [
      null,
      42,
      'str',
      [],
      [1, 2],
      { grid: null },
      { color: { hot: [] } },
      { version: 'x' },
    ]) {
      expect(() => normalizeConfig(raw)).not.toThrow();
      expect(normalizeConfig(raw).config.version).toBe(1);
    }
    expect(codes(normalizeConfig(42).issues)).toEqual(['bad-type@']);
    expect(codes(normalizeConfig({ version: 'x' }).issues)).toEqual(['bad-type@version']);
    expect(codes(normalizeConfig({ version: 7 }).issues)).toEqual(['out-of-range@version']);
  });

  it('applies extends before the patch', () => {
    const r = normalizeConfig({ extends: 'orb', modes: { sphere: { radius: 0.5 } } });
    expect(r.issues).toEqual([]);
    expect(r.config.modes.sphere.hole).toBe(0);
    expect(r.config.modes.sphere.radius).toBe(0.5);
    expect(r.config.color.palette).toEqual(PRESETS.orb.config.color?.palette);
    const bad = normalizeConfig({ extends: 'nope' });
    expect(codes(bad.issues)).toEqual(['bad-type@extends']);
    expect(bad.config).toEqual(getDefaults());
  });

  it('validateConfig is strict', () => {
    expect(validateConfig({ grid: { gap: 0.3 } }).ok).toBe(true);
    expect(validateConfig({ grid: { gap: '0.3' } }).ok).toBe(false);
    expect(validateConfig({ grid: { gap: 3 } }).ok).toBe(false);
  });
});

describe('normalizePatch', () => {
  it('keeps only valid present keys without filling defaults', () => {
    const r = normalizePatch({
      grid: { gap: 3, roundness: 'x' },
      color: { mapping: 'radial' },
      modes: {},
      nope: 1,
    });
    expect(r.patch).toEqual({ grid: { gap: 0.6 }, color: { mapping: 'radial' } });
    expect(codes(r.issues)).toEqual([
      'clamped@grid.gap',
      'bad-type@grid.roundness',
      'unknown-key@nope',
    ]);
    expect(normalizePatch({ extends: 'rain' }).patch).toEqual({ extends: 'rain' });
    expect(normalizePatch(undefined)).toEqual({ patch: {}, issues: [] });
  });
});

describe('presets', () => {
  it('have all ids with labels, descriptions and clean configs', () => {
    expect(Object.keys(PRESETS)).toEqual([...PRESET_IDS]);
    for (const id of PRESET_IDS) {
      const p = PRESETS[id];
      expect(p.label, id).toBeTruthy();
      expect(p.description, id).toBeTruthy();
      const r = normalizeConfig(p.config);
      expect(r.issues, id).toEqual([]);
      expect(getPresetConfig(id), id).toEqual(r.config);
    }
    expect(PRESETS.reference.config).toEqual({});
  });

  it('are visually distinct', () => {
    const keys = PRESET_IDS.map((id) => stableStringify(getPresetConfig(id)));
    expect(new Set(keys).size).toBe(PRESET_IDS.length);
    // Monochrome: a grey-to-white ramp with colour fully desaturated.
    expect(getPresetConfig('minimal').color.palette).toEqual(['#5c5c5c', '#d9d9d9', '#ffffff']);
    expect(getPresetConfig('minimal').color.saturation).toBe(0);
    expect(getPresetConfig('minimal').background.color).toBe('#050505');
    expect(getPresetConfig('rain').modes.rain.weight).toBe(1);
    expect(getPresetConfig('pulse').modes.sphere.weight).toBe(0);
    expect(getPresetConfig('life').animation.sparsity.amount).toBe(0);
  });
});

describe('export', () => {
  const custom = () => {
    let c = getDefaults();
    c = setPath(c, 'grid.gap', 0.33);
    c = setPath(c, 'color.palette', ['#ff0000', '#0000ff']);
    c = setPath(c, 'modes.pulse.weight', 0.5);
    c = setPath(c, 'transition', 900);
    return c;
  };

  it('full file round-trips', () => {
    const c = custom();
    const file = toConfigFile(c);
    expect(file.$schema).toBeTruthy();
    expect(file.version).toBe(1);
    expect(Object.keys(file).slice(0, 3)).toEqual(['$schema', 'version', 'grid']);
    const r = normalizeConfig(JSON.parse(JSON.stringify(file)));
    expect(r.issues).toEqual([]);
    expect(r.config).toEqual(c);
  });

  it('diff vs defaults contains only changed leaves', () => {
    const c = custom();
    const file = toConfigFile(c, { mode: 'diff', schemaUrl: 'https://example.test/s.json' });
    expect(file).toEqual({
      $schema: 'https://example.test/s.json',
      version: 1,
      grid: { gap: 0.33 },
      modes: { pulse: { weight: 0.5 } },
      color: { palette: ['#ff0000', '#0000ff'] },
      transition: 900,
    });
    expect(normalizeConfig(file).config).toEqual(c);
    expect(toConfigFile(getDefaults(), { mode: 'diff' })).toEqual({
      $schema: DEFAULT_SCHEMA_URL,
      version: 1,
    });
  });

  it('diff vs a preset uses extends and round-trips', () => {
    const c = setPath(getPresetConfig('orb'), 'modes.sphere.radius', 0.9);
    const file = toConfigFile(c, { mode: 'diff', base: 'orb' });
    expect(file.extends).toBe('orb');
    expect(file.modes).toEqual({ sphere: { radius: 0.9 } });
    expect(normalizeConfig(file).config).toEqual(c);
    // Every preset round-trips through both modes.
    for (const id of PRESET_IDS) {
      const p = getPresetConfig(id);
      expect(normalizeConfig(toConfigFile(p)).config, id).toEqual(p);
      expect(normalizeConfig(toConfigFile(p, { mode: 'diff' })).config, id).toEqual(p);
      expect(normalizeConfig(toConfigFile(c, { mode: 'diff', base: id })).config, id).toEqual(c);
    }
  });

  it('full file with a preset base records extends and still round-trips', () => {
    const c = setPath(getPresetConfig('rain'), 'modes.rain.speed', 0.1 + 0.58);
    const file = toConfigFile(c, { base: 'rain' });
    expect(file.extends).toBe('rain');
    // Float noise from slider arithmetic is trimmed in files.
    expect(file.modes?.rain?.speed).toBe(0.68);
    expect(normalizeConfig(JSON.parse(JSON.stringify(file))).config.modes.rain.speed).toBe(0.68);
    const clean = setPath(getPresetConfig('rain'), 'modes.rain.speed', 0.68);
    expect(normalizeConfig(toConfigFile(clean, { base: 'rain' })).config).toEqual(clean);
  });

  it('snippets have the documented shape', () => {
    const file = toConfigFile(custom(), { mode: 'diff' });
    expect(JSON.parse(toJsonSnippet(file))).toEqual(file);
    const ts = toTsSnippet(file);
    expect(
      ts.startsWith(
        "import type { PixelLifeConfigInput } from 'pixel-life';\n\nexport const pixelLifeConfig = {",
      ),
    ).toBe(true);
    expect(ts).toContain('} satisfies PixelLifeConfigInput;');
    expect(ts).toContain("palette: ['#ff0000', '#0000ff'],");
    expect(ts).not.toContain('$schema');
    const react = toReactSnippet(file);
    expect(react).toContain("import { PixelLife } from 'pixel-life/react';");
    expect(react).toContain('<PixelLife config={pixelLifeConfig} />');
    const html = toHtmlSnippet(file);
    expect(
      html.startsWith(
        '<pixel-life id="bg"></pixel-life>\n<script type="module">\n  import \'pixel-life/element/define\';\n  document.getElementById(\'bg\').config = {',
      ),
    ).toBe(true);
    expect(html.trimEnd().endsWith('};\n</script>')).toBe(true);
    // The object literal must evaluate back to the same data.
    const literal = ts.slice(ts.indexOf('= ') + 2, ts.lastIndexOf(' satisfies'));
    const evaluated = new Function(`return (${literal});`)();
    const { $schema: _s, ...rest } = file;
    expect(evaluated).toEqual(rest);
  });
});

describe('toJsonSchema', () => {
  const js = toJsonSchema() as { $schema: string; properties: Record<string, unknown> };

  it('is draft 2020-12 and contains every leaf path with metadata', () => {
    expect(js.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    for (const p of getLeafPaths()) {
      let node: Record<string, unknown> = js as unknown as Record<string, unknown>;
      for (const k of p.split('.')) {
        node = (node.properties as Record<string, Record<string, unknown>>)[k] as Record<
          string,
          unknown
        >;
        expect(node, p).toBeDefined();
      }
      const f = getField(p) as FieldDef;
      expect(node.title, p).toBe(f.label);
      expect(node.default, p).toEqual(f.default);
    }
    expect(js.properties.extends).toMatchObject({ enum: [...PRESET_IDS] });
  });

  it('describes types and ranges', () => {
    const props = js.properties as Record<
      string,
      { properties: Record<string, Record<string, unknown>> } & Record<string, unknown>
    >;
    expect(props.grid?.properties.gap).toMatchObject({
      type: 'number',
      minimum: 0.02,
      maximum: 0.6,
    });
    expect(props.grid?.properties.count).toMatchObject({
      type: 'integer',
      minimum: 8,
      maximum: 200,
    });
    expect(props.grid?.properties.softness?.['x-unit']).toBe('px');
    expect(props.grid?.properties.pitch?.['x-visibleWhen']).toEqual({
      path: 'grid.sizing',
      eq: 'pitch',
    });
    expect(props.color?.properties.mapping?.enum).toEqual([
      'spatial',
      'radial',
      'angular',
      'intensity',
      'noise',
    ]);
    expect(props.color?.properties.palette).toMatchObject({
      type: 'array',
      minItems: 1,
      maxItems: 32,
    });
    expect(props.render?.['x-advanced']).toBe(true);
    expect(props.grid?.['x-order']).toBe(10);
  });
});

describe('posterCss', () => {
  it('builds a layered background ending with the base color', () => {
    for (const id of PRESET_IDS) {
      const cfg = getPresetConfig(id);
      const css = posterCss(cfg);
      expect(css.endsWith(cfg.background.color), id).toBe(true);
      expect(css, id).not.toMatch(/NaN|undefined|Infinity/);
      expect(css, id).toContain('gradient(');
    }
  });
});
