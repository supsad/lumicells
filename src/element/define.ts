/**
 * Side-effect entry: importing this module registers <lumi-cells>. Guarded, so it is a no-op on
 * the server and when the tag is already defined (e.g. loaded twice through two bundles).
 */

import { defineLumiCellsElement } from './lumi-cells-element';

defineLumiCellsElement();
