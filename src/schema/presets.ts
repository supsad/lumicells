/**
 * Named looks. Each preset is a patch over the defaults (the defaults ARE the reference look),
 * so a preset only lists what makes it different. Mode presets switch the sphere off explicitly.
 */

import type { PixelLifeConfigInput } from './schema';

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

export interface PresetDef {
  label: string;
  description: string;
  config: PixelLifeConfigInput;
}

export const PRESETS: Record<PresetId, PresetDef> = {
  reference: {
    label: 'Референс',
    description:
      'Полая неоновая сфера: малиновый верх слева, синий низ справа, угасание в тёмно-синий.',
    config: {},
  },

  orb: {
    label: 'Сфера',
    description: 'Сплошной вращающийся шар в холодных сине-голубых тонах с ярким бликом.',
    config: {
      modes: {
        flow: { weight: 0.1 },
        sphere: {
          weight: 1,
          radius: 0.72,
          hole: 0,
          rimPower: 0.6,
          outerFalloff: 0.35,
          lightAngle: 225,
          lightStrength: 0.8,
          rotationSpeed: 0.25,
          tilt: 25,
          surface: 0.7,
          surfaceScale: 3,
          fadeAmount: 0.25,
        },
      },
      color: {
        palette: ['#041557', '#0b3a9a', '#1f4fd8', '#0476ff', '#0a8cf0', '#02bcd2', '#7ff0ff'],
        mapping: 'radial',
        scale: 1.1,
        offset: 0.05,
        warp: 0.18,
        intensityShift: 0.25,
        hot: { amount: 0.45, threshold: 0.72 },
      },
      background: {
        color: '#010a26',
        spotA: { color: '#0d2b7a', position: [-1.2, -0.6], strength: 0.45 },
        spotB: { color: '#062a4a', position: [1.1, 0.9], strength: 0.4 },
      },
      glow: { bloom: { strength: 0.45 }, haze: { strength: 0.28 } },
    },
  },

  pulse: {
    label: 'Пульс',
    description: 'Расходящиеся кольца в малиново-фиолетовой гамме, мягко дышащие в такт.',
    config: {
      modes: {
        sphere: { weight: 0 },
        flow: { weight: 0.15 },
        pulse: { weight: 1, frequency: 3.2, width: 0.16, breathe: 0.45, falloff: 0.8 },
      },
      color: {
        palette: ['#2a0845', '#6a1b9a', '#b5179e', '#f72585', '#ff7ad9', '#b388ff'],
        mapping: 'radial',
        scale: 0.9,
        warp: 0.1,
        intensityShift: 0.2,
      },
      background: {
        color: '#0c0020',
        spotA: { color: '#5a0f5e', position: [-1.1, -0.8], strength: 0.5 },
        spotB: { color: '#2b0f6e', position: [1, 1], strength: 0.45 },
      },
      animation: { sparsity: { amount: 0.35 } },
    },
  },

  life: {
    label: 'Жизнь',
    description: 'Клеточный автомат Конвея в зелёно-бирюзовых тонах поверх лёгкого течения.',
    config: {
      grid: { count: 40, gap: 0.22, roundness: 0.2 },
      modes: {
        sphere: { weight: 0 },
        flow: { weight: 0.1, scale: 1.2 },
        life: { weight: 1, stepRate: 8, birthRate: 0.004, fadeSteps: 5, seedDensity: 0.3 },
      },
      animation: {
        floor: 0.12,
        flicker: { amount: 0.08 },
        sparsity: { amount: 0 },
        sparkle: { amount: 0.15 },
      },
      color: {
        palette: ['#022c22', '#0f766e', '#10b981', '#34d399', '#22d3ee', '#a5f3fc'],
        mapping: 'noise',
        warp: 0.2,
        warpScale: 0.8,
        intensityShift: 0.3,
      },
      background: {
        color: '#010d0c',
        vignette: 0.45,
        spotA: { color: '#053b33', position: [-1.2, -0.4], strength: 0.4 },
        spotB: { color: '#063447', position: [0.9, 1], strength: 0.35 },
      },
      lift: { amount: 0.008 },
    },
  },

  vortex: {
    label: 'Вихрь',
    description: 'Трёхрукавная спираль в закатных тонах: от фиолетового к огненно-жёлтому.',
    config: {
      modes: {
        sphere: { weight: 0 },
        flow: { weight: 0.15 },
        vortex: { weight: 1, arms: 3, twist: 4, speed: 0.25, falloff: 0.8, sharpness: 0.45 },
      },
      color: {
        palette: ['#1a0033', '#5b0e91', '#b5179e', '#d7263d', '#f46036', '#ffc15e', '#fff1c1'],
        mapping: 'angular',
        scale: 1,
        warp: 0.15,
        intensityShift: 0.3,
        hot: { amount: 0.4, threshold: 0.7 },
      },
      background: {
        color: '#0b0014',
        spotA: { color: '#4a0f3a', position: [-1.2, 0.4], strength: 0.45 },
        spotB: { color: '#3a1a05', position: [1.2, -0.8], strength: 0.35 },
      },
      glow: { bloom: { strength: 0.45 } },
    },
  },

  waves: {
    label: 'Волны',
    description: 'Интерферирующие морские волны: глубокий синий, бирюза и пена.',
    config: {
      modes: {
        sphere: { weight: 0 },
        flow: { weight: 0.2, scale: 1 },
        wave: {
          weight: 1,
          angle: 20,
          frequency: 2.2,
          speed: 0.4,
          sharpness: 0.4,
          interference: 0.6,
        },
      },
      color: {
        palette: ['#001427', '#023e7d', '#0077b6', '#00b4d8', '#90e0ef', '#caf0f8'],
        mapping: 'intensity',
        warp: 0.1,
        intensityShift: 0.2,
      },
      background: {
        color: '#000b18',
        spotA: { color: '#03224d', position: [-1.2, -0.6], strength: 0.45 },
        spotB: { color: '#013a4a', position: [0.8, 1.1], strength: 0.4 },
      },
      animation: { sparsity: { amount: 0.3 } },
    },
  },

  ripples: {
    label: 'Капли',
    description: 'Серебристо-синяя гладь, по которой расходятся круги от случайных капель.',
    config: {
      modes: {
        sphere: { weight: 0 },
        flow: { weight: 0.3, scale: 1.2, threshold: 0.55 },
        ripple: { weight: 1, rate: 1.8, speed: 0.45, width: 0.1, life: 3 },
      },
      color: {
        palette: ['#0d1b2a', '#1b263b', '#415a77', '#778da9', '#a9c4ff', '#e0e1dd'],
        mapping: 'intensity',
        warp: 0.08,
        saturation: 0.9,
      },
      background: {
        color: '#050b16',
        vignette: 0.45,
        spotA: { color: '#1b2a4a', position: [-1.1, -0.5], strength: 0.4 },
        spotB: { color: '#0f1d3a', position: [1, 1], strength: 0.35 },
      },
      glow: { saturation: 0.9 },
      animation: { sparsity: { amount: 0.3 } },
    },
  },

  rain: {
    label: 'Дождь',
    description: 'Зелёный «цифровой дождь» на почти чёрном фоне, мелкая сетка.',
    config: {
      grid: { count: 56, gap: 0.2, roundness: 0.15 },
      modes: {
        sphere: { weight: 0 },
        flow: { weight: 0.08 },
        rain: { weight: 1, speed: 1.2, density: 0.32, tail: 0.7, angle: 0 },
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
    label: 'Минимализм',
    description: 'Монохромный белый узор на угольном фоне, сдержанное свечение.',
    config: {
      grid: { gap: 0.3, roundness: 0.25 },
      modes: {
        sphere: { weight: 0 },
        flow: { weight: 1, scale: 1.4, speed: 0.2, threshold: 0.5, softness: 0.35 },
      },
      animation: { floor: 0.08, sparsity: { amount: 0.2 }, sparkle: { amount: 0.2 } },
      color: {
        palette: ['#ffffff'],
        warp: 0,
        jitter: 0,
        intensityShift: 0,
        saturation: 0,
        hot: { amount: 0 },
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
