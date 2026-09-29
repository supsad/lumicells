import { describe, expectTypeOf, it } from 'vitest';
import type {
  FieldAt,
  ModulatablePath,
  ParamPath,
  ParamValue,
  PixelLifeConfig,
  PixelLifeConfigInput,
  PresetId,
} from '../src/schema';
import { getDefaults, type PRESETS } from '../src/schema';

// Type-level checks run under `tsc` (tests are in the project); the runtime bodies are trivial.
describe('schema types', () => {
  it('infers leaf value types from the schema', () => {
    expectTypeOf<ParamValue<'glow.bloom.strength'>>().toEqualTypeOf<number>();
    expectTypeOf<ParamValue<'color.palette'>>().toEqualTypeOf<string[]>();
    expectTypeOf<ParamValue<'color.mapping'>>().toEqualTypeOf<
      'spatial' | 'radial' | 'angular' | 'intensity' | 'noise'
    >();
    expectTypeOf<ParamValue<'scene.center'>>().toEqualTypeOf<[number, number]>();
    expectTypeOf<ParamValue<'lift.enabled'>>().toEqualTypeOf<boolean>();
    expectTypeOf<ParamValue<'transition'>>().toEqualTypeOf<number>();
    expectTypeOf<ParamValue<'background.color'>>().toEqualTypeOf<string>();
    expectTypeOf<FieldAt<'color.mapping'>['kind']>().toEqualTypeOf<'enum'>();
  });

  it('computes paths', () => {
    expectTypeOf<'modes.sphere.radius'>().toExtend<ModulatablePath>();
    expectTypeOf<'modes.sphere.lightAngle'>().toExtend<ModulatablePath>();
    expectTypeOf<'color.palette'>().not.toExtend<ModulatablePath>();
    expectTypeOf<'color.mapping'>().not.toExtend<ModulatablePath>();
    expectTypeOf<'modes.sphere'>().not.toExtend<ParamPath>();
    expectTypeOf<'nope'>().not.toExtend<ParamPath>();
    expectTypeOf<'color.palette'>().toExtend<ParamPath>();
    expectTypeOf<'transition'>().toExtend<ParamPath>();
  });

  it('config and input shapes', () => {
    expectTypeOf<PixelLifeConfig['version']>().toEqualTypeOf<1>();
    expectTypeOf<PixelLifeConfig['modes']['life']['rule']>().toEqualTypeOf<
      'conway' | 'highlife' | 'daynight' | 'seeds'
    >();
    expectTypeOf<PresetId>().toEqualTypeOf<keyof typeof PRESETS>();
    const input: PixelLifeConfigInput = {
      extends: 'orb',
      version: 1,
      $schema: 'x',
      glow: { bloom: { strength: 1 } },
      scene: { center: [0, 0] },
    };
    // @ts-expect-error unknown enum value
    const bad1: PixelLifeConfigInput = { color: { mapping: 'diagonal' } };
    // @ts-expect-error unknown preset
    const bad2: PixelLifeConfigInput = { extends: 'nope' };
    // @ts-expect-error tuples are leaves, not partial
    const bad3: PixelLifeConfigInput = { scene: { center: [0] } };
    const full: PixelLifeConfig = getDefaults();
    void [input, bad1, bad2, bad3, full];
  });
});
