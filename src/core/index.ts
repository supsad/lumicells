/**
 * lumicells: live WebGL2 pixel-grid background.
 *
 * Importing this module has no side effects (safe for SSR); nothing touches `window` until a
 * LumiCells instance is constructed.
 */

export * from '../schema';
export {
  bakePaletteRamp,
  hexToRgb,
  isHexColor,
  normalizeHex,
  type PaletteInterpolation,
  type RGB,
  rgbToHex,
  samplePalette,
} from './color';
export { LumiCells } from './lumi-cells';
export { onBeforeFrame } from './ticker';
export type * from './types';
