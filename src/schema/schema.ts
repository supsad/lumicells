/**
 * THE config schema tree. Everything else (types, defaults, normalization, GPU layout, the stand
 * UI and JSON Schema) is derived from this object, so paths, ranges and defaults live only here.
 * It holds runtime data only; labels, descriptions, units and the stand's presentation hints are
 * UI metadata in meta.ts, keyed by the same dotted paths.
 *
 * Defaults are the "reference" look. Units: "cells" = grid pitch units; "mode units" =
 * aspect-correct space where 1.0 = half of the host's shorter side.
 */

import {
  angle,
  bool,
  color,
  type DeepPartial,
  enumField,
  group,
  type InferConfig,
  int,
  mode,
  type NodeAt,
  num,
  type PathValue,
  palette,
  type SchemaLeafPaths,
  vec2,
} from './fields';
import type { PresetId } from './presets';

const grid = group({
  sizing: enumField({ values: ['pitch', 'count'] as const, default: 'count', live: 'realloc' }),
  pitch: num({ min: 4, max: 96, step: 1, default: 24, live: 'realloc' }),
  count: int({ min: 8, max: 200, step: 1, default: 31, live: 'realloc' }),
  gap: num({ min: 0.02, max: 0.6, step: 0.01, default: 0.27, gpu: true }),
  roundness: num({ min: 0, max: 1, step: 0.01, default: 0.3, gpu: true }),
  softness: num({ min: 0, max: 3, step: 0.05, default: 0.6, gpu: true }),
  emitter: num({ min: 0, max: 0.6, step: 0.01, default: 0.18, gpu: true }),
  bevel: num({ min: 0, max: 0.15, step: 0.01, default: 0, gpu: true }),
});

const scene = group({
  center: vec2({ min: -1, max: 1, step: 0.01, default: [-0.02, -0.02], gpu: true }),
  zoom: num({ min: 0.25, max: 4, step: 0.01, scale: 'log', default: 1, gpu: true }),
});

const animation = group({
  speed: num({ min: 0, max: 4, step: 0.01, default: 1 }),
  blend: enumField({ values: ['screen', 'add', 'max'] as const, default: 'screen', gpu: true }),
  brightness: num({ min: 0, max: 3, step: 0.01, default: 1, gpu: true }),
  gamma: num({ min: 0.3, max: 3, step: 0.01, default: 1.15, gpu: true }),
  floor: num({ min: 0, max: 0.5, step: 0.01, default: 0.16, gpu: true }),
  energy: num({ min: 0, max: 3, step: 0.01, default: 1, gpu: true }),
  flicker: group({
    amount: num({ min: 0, max: 1, step: 0.01, default: 0.4, gpu: true }),
    rate: num({ min: 0.05, max: 5, step: 0.01, default: 0.3, gpu: true }),
  }),
  sparkle: group({
    amount: num({ min: 0, max: 2, step: 0.01, default: 0.35, gpu: true }),
    rate: num({ min: 0, max: 0.05, step: 0.001, default: 0.008, gpu: true }),
    duration: num({ min: 0.1, max: 2, step: 0.01, default: 0.5, gpu: true }),
  }),
  sparsity: group({
    amount: num({ min: 0, max: 1, step: 0.01, default: 0.55, gpu: true }),
    period: num({ min: 0.5, max: 10, step: 0.1, default: 3, gpu: true }),
  }),
});

const weight = (value: number) => num({ min: 0, max: 1, step: 0.01, default: value, gpu: true });

const modes = group({
  flow: mode({
    weight: weight(0.1),
    scale: num({ min: 0.2, max: 8, step: 0.01, scale: 'log', default: 1.6, gpu: true }),
    speed: num({ min: 0, max: 3, step: 0.01, default: 0.25 }),
    direction: angle({ default: 30, gpu: true }),
    threshold: num({ min: 0, max: 1, step: 0.01, default: 0.45, gpu: true }),
    softness: num({ min: 0.02, max: 1, step: 0.01, default: 0.3, gpu: true }),
  }),
  sphere: mode({
    weight: weight(1),
    radius: num({ min: 0.1, max: 1.6, step: 0.01, default: 0.68, gpu: true }),
    shift: vec2({ min: -1, max: 1, step: 0.01, default: [0.02, 0.16], gpu: true }),
    hole: num({ min: 0, max: 0.9, step: 0.01, default: 0.25, gpu: true }),
    holeSoftness: num({ min: 0.01, max: 0.5, step: 0.01, default: 0.12, gpu: true }),
    rimPower: num({ min: 0.3, max: 6, step: 0.01, default: 1.3, gpu: true }),
    outerFalloff: num({ min: 0.05, max: 1.5, step: 0.01, default: 0.38, gpu: true }),
    lightAngle: angle({ default: 200, gpu: true }),
    lightStrength: num({ min: 0, max: 1, step: 0.01, default: 0.45, gpu: true }),
    rotationSpeed: num({ min: -2, max: 2, step: 0.01, default: 0.12 }),
    tilt: angle({ min: -60, max: 60, default: 20, gpu: true }),
    surface: num({ min: 0, max: 1, step: 0.01, default: 0.55, gpu: true }),
    surfaceScale: num({ min: 0.5, max: 8, step: 0.01, default: 2.5, gpu: true }),
    wobble: num({ min: 0, max: 0.3, step: 0.005, default: 0.08, gpu: true }),
    breathe: num({ min: 0, max: 0.2, step: 0.005, default: 0.025, gpu: true }),
    breatheSpeed: num({ min: 0, max: 3, step: 0.01, default: 0.35 }),
    fadeAngle: angle({ default: 345, gpu: true }),
    fadeAmount: num({ min: 0, max: 1, step: 0.01, default: 1, gpu: true }),
  }),
  pulse: mode({
    weight: weight(0),
    speed: num({ min: 0, max: 3, step: 0.01, default: 0.45 }),
    frequency: num({ min: 0.5, max: 12, step: 0.01, default: 3, gpu: true }),
    width: num({ min: 0.02, max: 0.6, step: 0.01, default: 0.14, gpu: true }),
    breathe: num({ min: 0, max: 1, step: 0.01, default: 0.35, gpu: true }),
    falloff: num({ min: 0, max: 3, step: 0.01, default: 1, gpu: true }),
    origin: vec2({ min: -1, max: 1, step: 0.01, default: [0, 0], gpu: true }),
  }),
  wave: mode({
    weight: weight(0),
    angle: angle({ default: 20, gpu: true }),
    frequency: num({ min: 0.2, max: 12, step: 0.01, default: 2.5, gpu: true }),
    speed: num({ min: 0, max: 3, step: 0.01, default: 0.5 }),
    sharpness: num({ min: 0, max: 1, step: 0.01, default: 0.35, gpu: true }),
    interference: num({ min: 0, max: 1, step: 0.01, default: 0.5, gpu: true }),
  }),
  ripple: mode({
    weight: weight(0),
    rate: num({ min: 0, max: 6, step: 0.01, default: 1.2, gpu: true }),
    speed: num({ min: 0.05, max: 2, step: 0.01, default: 0.4, gpu: true }),
    width: num({ min: 0.02, max: 0.4, step: 0.01, default: 0.09, gpu: true }),
    life: num({ min: 0.5, max: 6, step: 0.1, default: 2.5, gpu: true }),
  }),
  vortex: mode({
    weight: weight(0),
    arms: int({ min: 1, max: 8, step: 1, default: 3, gpu: true }),
    twist: num({ min: -10, max: 10, step: 0.1, default: 3, gpu: true }),
    speed: num({ min: -3, max: 3, step: 0.01, default: 0.3 }),
    falloff: num({ min: 0, max: 3, step: 0.01, default: 0.9, gpu: true }),
    sharpness: num({ min: 0, max: 1, step: 0.01, default: 0.4, gpu: true }),
  }),
  life: mode({
    weight: weight(0),
    stepRate: num({ min: 1, max: 30, step: 0.1, default: 8 }),
    birthRate: num({ min: 0, max: 0.05, step: 0.0005, default: 0.004 }),
    fadeSteps: int({ min: 1, max: 16, step: 1, default: 4, gpu: true }),
    seedDensity: num({ min: 0, max: 1, step: 0.01, default: 0.3 }),
    rule: enumField({
      values: ['conway', 'highlife', 'daynight', 'seeds'] as const,
      default: 'conway',
      live: 'restart',
    }),
  }),
  rain: mode({
    weight: weight(0),
    speed: num({ min: 0.1, max: 5, step: 0.01, default: 1 }),
    density: num({ min: 0, max: 1, step: 0.01, default: 0.25, gpu: true }),
    tail: num({ min: 0.05, max: 1.5, step: 0.01, default: 0.5, gpu: true }),
    angle: angle({ min: -45, max: 45, default: 0, gpu: true }),
  }),
});

const colorGroup = group({
  palette: palette({
    default: [
      '#a0206a',
      '#f21239',
      '#e0267a',
      '#5a44d0',
      '#2a55e0',
      '#1f5fe8',
      '#0870f8',
      '#0476ff',
      '#0a84f2',
      '#0a8cf0',
      '#0a78e8',
      '#0b5ccc',
    ],
    minStops: 1,
    maxStops: 32,
  }),
  interpolation: enumField({
    values: ['oklab', 'linear', 'steps'] as const,
    default: 'oklab',
    live: 'lut',
  }),
  mapping: enumField({
    values: ['spatial', 'radial', 'angular', 'intensity', 'noise'] as const,
    default: 'spatial',
    transition: 'crossfade',
    gpu: true,
  }),
  angle: angle({ default: 22, gpu: true }),
  bend: num({ min: -1, max: 1, step: 0.01, default: 0.35, gpu: true }),
  scale: num({ min: 0.1, max: 4, step: 0.01, scale: 'log', default: 1, gpu: true }),
  offset: num({ min: -1, max: 1, step: 0.01, default: 0, gpu: true }),
  warp: num({ min: 0, max: 1, step: 0.01, default: 0.12, gpu: true }),
  warpScale: num({ min: 0.2, max: 6, step: 0.01, default: 1.3, gpu: true }),
  jitter: num({ min: 0, max: 0.5, step: 0.01, default: 0.12, gpu: true }),
  intensityShift: num({ min: -1, max: 1, step: 0.01, default: 0.12, gpu: true }),
  drift: num({ min: -0.5, max: 0.5, step: 0.001, default: 0 }),
  saturation: num({ min: 0, max: 2, step: 0.01, default: 1.05, gpu: true }),
  hot: group({
    amount: num({ min: 0, max: 1, step: 0.01, default: 0.15, gpu: true }),
    threshold: num({ min: 0, max: 1, step: 0.01, default: 0.92, gpu: true }),
    core: num({ min: 0.1, max: 1, step: 0.01, default: 0.8, gpu: true }),
  }),
  accent: group({
    color: color({ default: '#12c0d8', gpu: true }),
    amount: num({ min: 0, max: 1, step: 0.01, default: 0.9, gpu: true }),
  }),
});

const spot = (c: string, position: [number, number], radius: number, strength: number) =>
  group({
    color: color({ default: c, gpu: true }),
    position: vec2({ min: -2, max: 2, step: 0.01, default: position, gpu: true }),
    radius: num({ min: 0.1, max: 4, step: 0.01, default: radius, gpu: true }),
    strength: num({ min: 0, max: 1, step: 0.01, default: strength, gpu: true }),
  });

const background = group({
  color: color({ default: '#000032', gpu: true }),
  vignette: num({ min: 0, max: 1, step: 0.01, default: 0.35, gpu: true }),
  spotA: spot('#6a1f6e', [-1.3, -0.2], 1.25, 0.65),
  spotB: spot('#16207e', [-0.8, 1.1], 0.9, 0.5),
});

const glow = group({
  halo: group({
    strength: num({ min: 0, max: 2, step: 0.01, default: 0.5, gpu: true }),
    radius: num({ min: 0.02, max: 0.5, step: 0.01, default: 0.18, gpu: true }),
  }),
  bloom: group({
    strength: num({ min: 0, max: 2, step: 0.01, default: 0.8, gpu: true }),
    radius: num({ min: 0.5, max: 3, step: 0.05, default: 1.3 }),
    threshold: num({ min: 0, max: 1, step: 0.01, default: 0.35, gpu: true }),
    knee: num({ min: 0, max: 1, step: 0.01, default: 0.5, gpu: true }),
  }),
  haze: group({
    strength: num({ min: 0, max: 1, step: 0.01, default: 0.12, gpu: true }),
    radius: num({ min: 2, max: 12, step: 0.1, default: 4 }),
  }),
  saturation: num({ min: 0, max: 2, step: 0.01, default: 1.15, gpu: true }),
  exposure: num({ min: 0.2, max: 4, step: 0.01, scale: 'log', default: 1, gpu: true }),
  whitePoint: num({ min: 1, max: 16, step: 0.1, default: 4, gpu: true }),
});

const lift = group({
  enabled: bool({ default: true }),
  style: enumField({ values: ['pop', 'float'] as const, default: 'pop' }),
  amount: num({ min: 0, max: 0.06, step: 0.001, default: 0.016 }),
  max: int({ min: 0, max: 128, step: 1, default: 96, live: 'static' }),
  scale: num({ min: 1, max: 2.5, step: 0.01, default: 1.5 }),
  height: num({ min: 0, max: 2, step: 0.01, default: 0.35 }),
  parallax: num({ min: 0, max: 0.3, step: 0.01, default: 0.06 }),
  tilt: num({ min: 0, max: 20, step: 0.5, default: 6 }),
  holdMin: num({ min: 0.2, max: 10, step: 0.1, default: 1.5 }),
  holdMax: num({ min: 0.2, max: 10, step: 0.1, default: 3.5 }),
  rise: num({ min: 0.1, max: 2, step: 0.01, default: 0.6 }),
  fall: num({ min: 0.1, max: 2, step: 0.01, default: 0.45 }),
  brightness: num({ min: 0, max: 2, step: 0.01, default: 0.9, gpu: true }),
  whiten: num({ min: 0, max: 1, step: 0.01, default: 0.12, gpu: true }),
  bokeh: num({ min: 0, max: 1, step: 0.01, default: 0.3 }),
  shadow: num({ min: 0, max: 1, step: 0.01, default: 0.4, gpu: true }),
  halo: num({ min: 0, max: 2, step: 0.01, default: 0.8, gpu: true }),
  socket: num({ min: 0, max: 1, step: 0.01, default: 0.6 }),
  threshold: num({ min: 0, max: 1, step: 0.01, default: 0.2, gpu: true }),
  outerBias: num({ min: 0, max: 1, step: 0.01, default: 0.85 }),
  cluster: num({ min: 0, max: 0.5, step: 0.01, default: 0.15 }),
  landing: num({ min: 0, max: 1, step: 0.01, default: 0.25 }),
  floatSpeed: num({ min: 0.1, max: 4, step: 0.01, default: 0.9 }),
  floatDrift: num({ min: 0, max: 1, step: 0.01, default: 0.4 }),
});

const interaction = group({
  pointer: bool({ default: false }),
  pointerRadius: num({ min: 1, max: 30, step: 0.5, default: 4 }),
  pointerStrength: num({ min: 0, max: 2, step: 0.01, default: 0.6 }),
  pointerLift: bool({ default: true }),
  click: bool({ default: true }),
  rippleStrength: num({ min: 0, max: 2, step: 0.01, default: 0.8 }),
  rippleSpeed: num({ min: 2, max: 60, step: 0.5, default: 18 }),
  rippleWidth: num({ min: 0.5, max: 6, step: 0.1, default: 1.5 }),
  influenceStrength: num({ min: 0, max: 2, step: 0.01, default: 0.8 }),
  influenceFalloff: num({ min: 0.2, max: 10, step: 0.1, default: 2 }),
});

const render = group({
  quality: enumField({
    values: ['auto', 'high', 'medium', 'low'] as const,
    default: 'auto',
    live: 'static',
  }),
  maxDpr: num({ min: 0.5, max: 3, step: 0.05, default: 2, live: 'static' }),
  maxPixels: num({ min: 0.3, max: 12, step: 0.1, default: 4.2, live: 'static' }),
  overflow: num({ min: 0, max: 300, step: 1, default: 0, live: 'static' }),
  maxFps: int({ min: 0, max: 240, step: 1, default: 0, live: 'static' }),
  pauseOffscreen: bool({ default: true, live: 'static' }),
  reducedMotion: enumField({
    values: ['respect', 'ignore'] as const,
    default: 'respect',
    live: 'static',
  }),
});

const transition = num({ min: 0, max: 5000, step: 10, default: 600, live: 'static' });

/** Root of the schema tree. */
export const schema = group({
  grid,
  scene,
  animation,
  modes,
  color: colorGroup,
  background,
  glow,
  lift,
  interaction,
  render,
  transition,
});

export type Schema = typeof schema;
export type SchemaTree = Schema['fields'];

export const CONFIG_VERSION = 1 as const;

/** Mode ids in shader/stand order. */
export const MODE_IDS = [
  'flow',
  'sphere',
  'pulse',
  'wave',
  'ripple',
  'vortex',
  'life',
  'rain',
] as const;
export type ModeId = (typeof MODE_IDS)[number];

/** The complete, normalized config. */
export type LumiCellsConfig = { version: typeof CONFIG_VERSION } & InferConfig<SchemaTree>;

type ConfigBody = InferConfig<SchemaTree>;

/** What users write: any subset of the config, optionally based on a preset. */
export type LumiCellsConfigInput = DeepPartial<ConfigBody> & {
  $schema?: string;
  version?: number;
  extends?: PresetId;
};

/** Dotted path of every leaf parameter, e.g. 'glow.bloom.strength' | 'color.palette'. */
export type ParamPath = SchemaLeafPaths<SchemaTree>;

export type ParamValue<P extends ParamPath> = PathValue<ConfigBody, P>;

/** Schema field definition at a path. */
export type FieldAt<P extends ParamPath> = NodeAt<SchemaTree, P>;

/** Paths of numeric parameters: the ones that can be tweened and modulated. */
export type ModulatablePath = {
  [P in ParamPath]: ParamValue<P> extends number ? P : never;
}[ParamPath];
