/**
 * Entry of the <script src> bundle (global `PixelLife`). Registers the element as a side effect
 * and exposes the class API for imperative use next to it.
 */

import './define';

export { PixelLife } from '../core/pixel-life';
export { PRESET_IDS, PRESETS } from '../schema';
export * from './index';
