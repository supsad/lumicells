/**
 * Entry of the <script src> bundle (global `LumiCells`). Registers the element as a side effect
 * and exposes the class API for imperative use next to it.
 */

import './define';

export { LumiCells } from '../core/lumi-cells';
// PRESETS holds config patches only; PRESET_TEXTS names them (English) for a preset picker.
export { PRESET_IDS, PRESET_TEXTS, PRESETS } from '../schema';
export * from './index';
