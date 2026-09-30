/**
 * Entry of the <script src> bundle (global `LumiCells`). Registers the element as a side effect
 * and exposes the class API for imperative use next to it.
 */

import './define';

export { LumiCells } from '../core/lumi-cells';
export { PRESET_IDS, PRESETS } from '../schema';
export * from './index';
