/**
 * Side-effect entry: importing this module registers <lumi-cells>. Guarded, so it is a no-op on
 * the server and when the tag is already defined (e.g. loaded twice through two bundles).
 *
 * It also starts downloading the engine's chunk (LumiCells.preload): a page that registers the
 * element is about to render one, and the download then overlaps parsing and the app's own code
 * instead of starting when the first element connects (no-op on the server and on a page known
 * to lack WebGL2).
 */

import { LumiCells } from '../core/lumi-cells';
import { defineLumiCellsElement } from './lumi-cells-element';

// Only where the element could be registered: the server never gets past this check (and
// never touches `window`).
if (defineLumiCellsElement()) LumiCells.preload();
