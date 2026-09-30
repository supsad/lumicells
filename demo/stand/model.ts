/**
 * Panel model: a plain tree derived from the config schema (walk order + field metadata).
 * The panel never lists parameters by hand; adding a field to the schema adds a control.
 */

import {
  type FieldDef,
  type GroupDef,
  getPath,
  isGroup,
  type LumiCellsConfig,
  schema,
  type VisibleWhen,
  valueEquals,
} from 'lumicells';

export interface LeafNode {
  type: 'leaf';
  path: string;
  key: string;
  field: FieldDef;
  /** visibleWhen of the field and all its ancestor groups. */
  chain: readonly VisibleWhen[];
  advanced: boolean;
  /** Lower-cased label + path + description for the search filter. */
  text: string;
}

export interface GroupNode {
  type: 'group';
  path: string;
  key: string;
  def: GroupDef;
  children: PanelNode[];
  /** Animation mode: its `weight` leaf is rendered in the section header. */
  isMode: boolean;
  weight: LeafNode | null;
  chain: readonly VisibleWhen[];
  advanced: boolean;
  text: string;
}

export type PanelNode = LeafNode | GroupNode;

export interface PanelModel {
  /** Top-level leaf fields (currently only `transition`), shown above the sections. */
  topLeaves: LeafNode[];
  sections: GroupNode[];
}

const textOf = (label: string, path: string, description?: string) =>
  `${label} ${path} ${description ?? ''}`.toLowerCase();

function byOrder<T extends { order?: number }>(entries: Array<[string, T]>): Array<[string, T]> {
  // Array.prototype.sort is stable: fields without `order` keep their declaration order.
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e[1].order ?? a.i) - (b.e[1].order ?? b.i) || a.i - b.i)
    .map((x) => x.e);
}

function buildGroup(
  key: string,
  path: string,
  def: GroupDef,
  parentChain: readonly VisibleWhen[],
  parentAdvanced: boolean,
): GroupNode {
  const chain = def.visibleWhen ? [...parentChain, def.visibleWhen] : parentChain;
  const advanced = parentAdvanced || !!def.advanced;
  const node: GroupNode = {
    type: 'group',
    path,
    key,
    def,
    children: [],
    isMode: def.role === 'mode',
    weight: null,
    chain,
    advanced,
    text: textOf(def.label, path, def.description),
  };
  for (const [k, child] of byOrder(Object.entries(def.fields))) {
    const p = `${path}.${k}`;
    if (isGroup(child)) {
      node.children.push(buildGroup(k, p, child, chain, advanced));
      continue;
    }
    const leaf = buildLeaf(k, p, child, chain, advanced);
    if (node.isMode && k === 'weight') node.weight = leaf;
    else node.children.push(leaf);
  }
  return node;
}

function buildLeaf(
  key: string,
  path: string,
  field: FieldDef,
  parentChain: readonly VisibleWhen[],
  parentAdvanced: boolean,
): LeafNode {
  return {
    type: 'leaf',
    path,
    key,
    field,
    chain: field.visibleWhen ? [...parentChain, field.visibleWhen] : parentChain,
    advanced: parentAdvanced || !!field.advanced,
    text: textOf(field.label, path, field.description),
  };
}

let cached: PanelModel | null = null;

export function getPanelModel(): PanelModel {
  if (cached) return cached;
  const topLeaves: LeafNode[] = [];
  const sections: GroupNode[] = [];
  for (const [key, node] of byOrder(Object.entries(schema.fields))) {
    if (isGroup(node)) sections.push(buildGroup(key, key, node, [], false));
    else topLeaves.push(buildLeaf(key, key, node, [], false));
  }
  cached = { topLeaves, sections };
  return cached;
}

/** One comparison of a `visibleWhen` rule against the live config. */
export function isWhenMet(cfg: LumiCellsConfig, w: VisibleWhen): boolean {
  const v = getPath(cfg, w.path);
  if (w.eq !== undefined && !valueEquals(v, w.eq)) return false;
  if (w.neq !== undefined && valueEquals(v, w.neq)) return false;
  if (w.gt !== undefined && !(typeof v === 'number' && v > w.gt)) return false;
  return true;
}

export function isChainMet(cfg: LumiCellsConfig, chain: readonly VisibleWhen[]): boolean {
  for (const w of chain) if (!isWhenMet(cfg, w)) return false;
  return true;
}

export interface Filtered {
  /** Paths (leaves and groups) that pass the search and the "advanced" switch. */
  visible: ReadonlySet<string>;
  /** Number of leaf controls that pass. */
  count: number;
  /** Search hits hidden only because they are advanced. */
  hiddenAdvanced: number;
}

/** Applies the search query and the advanced switch to the whole tree (structure only). */
export function filterModel(model: PanelModel, query: string, showAdvanced: boolean): Filtered {
  const q = query.trim().toLowerCase();
  const visible = new Set<string>();
  let count = 0;
  let hiddenAdvanced = 0;

  const visit = (node: PanelNode, inheritedMatch: boolean): boolean => {
    if (node.type === 'leaf') {
      const match = !q || inheritedMatch || node.text.includes(q);
      if (!match) return false;
      if (node.advanced && !showAdvanced) {
        hiddenAdvanced++;
        return false;
      }
      visible.add(node.path);
      count++;
      return true;
    }
    const match = inheritedMatch || (!!q && node.text.includes(q));
    let any = false;
    if (node.weight && visit(node.weight, match)) any = true;
    for (const c of node.children) if (visit(c, match)) any = true;
    if (any) visible.add(node.path);
    return any;
  };

  for (const l of model.topLeaves) visit(l, false);
  for (const s of model.sections) visit(s, false);
  return { visible, count, hiddenAdvanced };
}
