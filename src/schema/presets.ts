/**
 * Named looks. Each preset is a patch over the defaults (the defaults ARE the reference look),
 * so a preset only lists what makes it different. Mode presets switch the sphere off explicitly.
 */

import type { LumiCellsConfigInput } from './schema';

export const PRESET_IDS = [
  'reference',
  'orb',
  'pulse',
  'life',
  'vortex',
  'waves',
  'ripples',
  'rain',
  'minimal',
] as const;
export type PresetId = (typeof PRESET_IDS)[number];

/** A preset's config patch. Its name and description are UI metadata (meta.ts). */
export interface PresetDef {
  config: LumiCellsConfigInput;
}

export const PRESETS: Record<PresetId, PresetDef> = {
  reference: {
    config: {},
  },

  orb: {
    config: {
      grid: { count: 34 },
      modes: {
        flow: { weight: 0 },
        sphere: {
          weight: 1,
          radius: 0.68,
          // The reference shifts the shell below its hole; a solid orb stays centered.
          shift: [0, 0],
          hole: 0,
          rimPower: 0.8,
          outerFalloff: 0.16,
          lightAngle: 215,
          lightStrength: 0.95,
          rotationSpeed: 0.3,
          tilt: 20,
          surface: 0.7,
          surfaceScale: 2.6,
          wobble: 0.02,
          breathe: 0.01,
          fadeAmount: 0,
        },
      },
      animation: { floor: 0.1, flicker: { amount: 0.2 }, sparsity: { amount: 0.6 } },
      color: {
        palette: ['#120a45', '#2a1f9e', '#1f4fe0', '#0a84f2', '#10c4e8', '#8ff4ff'],
        mapping: 'intensity',
        scale: 1.3,
        warp: 0.1,
        jitter: 0.08,
        intensityShift: 0,
        hot: { amount: 0.2, threshold: 0.9 },
        accent: { color: '#18d6c8', amount: 0.4 },
      },
      background: {
        color: '#01061f',
        spotA: { color: '#0c1f6e', position: [-1.1, -0.7], radius: 1.2, strength: 0.4 },
        spotB: { color: '#081a44', position: [1.1, 1], strength: 0.35 },
      },
      glow: { bloom: { strength: 0.55 }, haze: { strength: 0.2 } },
    },
  },

  pulse: {
    config: {
      grid: { count: 33 },
      modes: {
        sphere: { weight: 0 },
        flow: { weight: 0 },
        pulse: { weight: 1, speed: 0.4, frequency: 2.2, width: 0.09, breathe: 0.5, falloff: 0.4 },
      },
      animation: {
        brightness: 1.15,
        floor: 0.07,
        flicker: { amount: 0.2 },
        sparsity: { amount: 0.25 },
      },
      color: {
        palette: ['#3a0a6e', '#7b1fa2', '#c2189b', '#f72585', '#ff6ec7', '#ff9ad8'],
        mapping: 'radial',
        scale: 0.8,
        offset: 0.15,
        warp: 0.12,
        jitter: 0.08,
        intensityShift: 0.25,
        hot: { amount: 0.25, threshold: 0.88 },
      },
      background: {
        color: '#0a0019',
        spotA: { color: '#4a0d52', position: [-1.1, -0.8], strength: 0.45 },
        spotB: { color: '#22106a', position: [1, 1], strength: 0.4 },
      },
      glow: { bloom: { strength: 0.7 } },
    },
  },

  life: {
    config: {
      grid: { count: 40, gap: 0.22, roundness: 0.2 },
      modes: {
        sphere: { weight: 0 },
        flow: { weight: 0 },
        life: { weight: 1, stepRate: 6, birthRate: 0.003, fadeSteps: 6, seedDensity: 0.28 },
      },
      animation: {
        floor: 0.07,
        flicker: { amount: 0.08 },
        sparsity: { amount: 0 },
        sparkle: { amount: 0.12 },
      },
      color: {
        palette: ['#03302a', '#0d7a6a', '#14b8a6', '#2ee6c5', '#6ff2dc', '#b8fff0'],
        mapping: 'noise',
        warp: 0.2,
        warpScale: 0.8,
        jitter: 0.08,
        intensityShift: 0.15,
        hot: { amount: 0.2, threshold: 0.9 },
      },
      background: {
        color: '#010d0c',
        vignette: 0.45,
        spotA: { color: '#053b33', position: [-1.2, -0.4], strength: 0.4 },
        spotB: { color: '#063447', position: [0.9, 1], strength: 0.35 },
      },
      lift: { amount: 0.006 },
    },
  },

  vortex: {
    config: {
      modes: {
        sphere: { weight: 0 },
        flow: { weight: 0.08 },
        vortex: { weight: 1, arms: 3, twist: 3.2, speed: 0.3, falloff: 0.75, sharpness: 0.55 },
      },
      animation: { floor: 0.08, sparsity: { amount: 0.45 } },
      color: {
        palette: ['#ffe8a3', '#ffb347', '#f5652a', '#d11d5b', '#8a1a9b', '#3d0f7a'],
        mapping: 'radial',
        scale: 1.1,
        warp: 0.12,
        jitter: 0.08,
        intensityShift: -0.2,
        hot: { amount: 0.2, threshold: 0.9 },
      },
      background: {
        color: '#0b0014',
        spotA: { color: '#3f0d4a', position: [-1.2, 0.4], strength: 0.45 },
        spotB: { color: '#3a1405', position: [1.2, -0.8], strength: 0.3 },
      },
      glow: { bloom: { strength: 0.6 } },
    },
  },

  waves: {
    config: {
      grid: { count: 34 },
      modes: {
        sphere: { weight: 0 },
        flow: { weight: 0 },
        wave: {
          weight: 1,
          angle: 25,
          frequency: 1.3,
          speed: 0.3,
          sharpness: 0.45,
          interference: 0.85,
        },
      },
      animation: { floor: 0.08, flicker: { amount: 0.15 }, sparsity: { amount: 0.35 } },
      color: {
        palette: ['#0b0630', '#2a0f7a', '#5b2bd6', '#3f6df0', '#22c3ee', '#a7f3ff'],
        mapping: 'intensity',
        scale: 1.1,
        warp: 0.15,
        jitter: 0.06,
        intensityShift: 0,
        hot: { amount: 0.25, threshold: 0.9 },
      },
      background: {
        color: '#04021a',
        spotA: { color: '#1e0b5a', position: [-1.2, -0.6], strength: 0.45 },
        spotB: { color: '#062a4a', position: [0.8, 1.1], strength: 0.4 },
      },
    },
  },

  ripples: {
    config: {
      modes: {
        sphere: { weight: 0 },
        flow: { weight: 0.12, scale: 1.1, speed: 0.12, threshold: 0.62 },
        ripple: { weight: 1, rate: 1.8, speed: 0.42, width: 0.07, life: 3.2 },
      },
      animation: {
        floor: 0.06,
        flicker: { amount: 0.15 },
        sparkle: { amount: 0.2 },
        sparsity: { amount: 0.35 },
      },
      color: {
        palette: ['#0a1830', '#1c3a66', '#3d6aa8', '#7fa6d9', '#c6dcff', '#f2f7ff'],
        mapping: 'intensity',
        scale: 1.2,
        warp: 0.05,
        jitter: 0.05,
        intensityShift: 0,
        saturation: 0.85,
        hot: { amount: 0.3, threshold: 0.85 },
      },
      background: {
        color: '#030814',
        vignette: 0.5,
        spotA: { color: '#12254a', position: [-1.1, -0.5], strength: 0.35 },
        spotB: { color: '#0b1733', position: [1, 1], strength: 0.3 },
      },
      glow: {
        halo: { strength: 0.55 },
        bloom: { strength: 0.55 },
        haze: { strength: 0.1 },
        saturation: 0.9,
      },
    },
  },

  rain: {
    config: {
      grid: { count: 56, gap: 0.2, roundness: 0.15 },
      modes: {
        sphere: { weight: 0 },
        flow: { weight: 0.08 },
        rain: { weight: 1, speed: 0.6, density: 0.32, tail: 0.6, angle: 0 },
      },
      animation: { floor: 0.1, sparsity: { amount: 0.2 }, flicker: { amount: 0.1 } },
      color: {
        palette: ['#001a00', '#003b00', '#008f11', '#00ff41', '#b6ffb0'],
        interpolation: 'linear',
        mapping: 'intensity',
        warp: 0,
        jitter: 0.1,
        intensityShift: 0,
        hot: { amount: 0.5, threshold: 0.85 },
      },
      background: {
        color: '#000600',
        vignette: 0.5,
        spotA: { color: '#002a08', position: [-1, -0.8], strength: 0.3 },
        spotB: { color: '#001a10', position: [1, 1], strength: 0.25 },
      },
      glow: { halo: { strength: 0.45 }, bloom: { strength: 0.3 }, haze: { strength: 0.15 } },
      lift: { amount: 0.006, style: 'float' },
    },
  },

  minimal: {
    config: {
      grid: { count: 36, gap: 0.3, roundness: 0.25 },
      modes: {
        sphere: { weight: 0 },
        flow: { weight: 1, scale: 1.5, speed: 0.12, threshold: 0.64, softness: 0.4 },
      },
      animation: {
        floor: 0.08,
        gamma: 1.5,
        flicker: { amount: 0.25 },
        sparsity: { amount: 0.4 },
        sparkle: { amount: 0.2 },
      },
      color: {
        palette: ['#5c5c5c', '#d9d9d9', '#ffffff'],
        mapping: 'intensity',
        scale: 1,
        warp: 0,
        jitter: 0,
        intensityShift: 0,
        saturation: 0,
        hot: { amount: 0 },
        accent: { amount: 0 },
      },
      background: {
        color: '#050505',
        vignette: 0.25,
        spotA: { strength: 0 },
        spotB: { strength: 0 },
      },
      glow: {
        halo: { strength: 0.25 },
        bloom: { strength: 0.12 },
        haze: { strength: 0.06 },
        saturation: 0,
      },
      lift: { amount: 0.004, whiten: 0, halo: 0.4 },
    },
  },
};
