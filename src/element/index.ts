/**
 * lumicells/element: the <lumi-cells> custom element class and helpers. Importing this module
 * does NOT register the tag (use `lumicells/element/define` for that), so it is safe on the
 * server and lets apps register the element under a different name.
 */

export {
  ATTR_FOR,
  ATTR_INFLUENCE,
  ATTR_LIFT,
  ATTR_PULSE,
  DATA_LC_ATTRS,
  isManaged,
  type LcAttrs,
  type PointerTrigger,
  parseLcAttrs,
} from './data-attrs';
export {
  defineLumiCellsElement,
  LUMI_CELLS_TAG,
  LumiCellsElement,
  type LumiCellsElementEventMap,
} from './lumi-cells-element';
export {
  DEFAULT_OVERFLOW_PX,
  overflowToPx,
  type ResolvedConfig,
  type ResolveInput,
  resolveConfig,
} from './resolve';
