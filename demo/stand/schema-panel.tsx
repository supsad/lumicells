/**
 * The tuning panel, generated from the config schema: sections follow the schema groups and
 * their `order`, control kinds follow `field.kind`. Nothing here names a concrete parameter.
 */

import {
  type AngleField,
  type EnumField,
  type FieldDef,
  getPath,
  getPresetConfig,
  type PaletteField,
  PRESET_IDS,
  type Vec2Field,
} from 'lumicells';
import {
  createContext,
  memo,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';
import { type SchemaText, useSchemaText, useT } from './i18n';
import { filterModel, type GroupNode, getPanelModel, isChainMet, type LeafNode } from './model';
import { useModulated } from './modulation';
import { loadJson, saveJson, UI_KEY } from './persistence';
import { usePathValue, useSelector, useStore } from './store';
import {
  AngleInput,
  ColorInput,
  EmptyState,
  PaletteEditor,
  type QuickPalette,
  Section,
  Segmented,
  Select,
  Slider,
  Toggle,
  Vec2Pad,
} from './ui';

// ------------------------------------------------------------ section state

const DEFAULT_OPEN: Record<string, boolean> = { color: true, modes: true, 'modes.sphere': true };

interface SectionState {
  isOpen(path: string): boolean;
  setOpen(path: string, open: boolean): void;
  /** Search results are shown expanded. */
  forceOpen: boolean;
}

const SectionStateContext = createContext<SectionState>({
  isOpen: () => true,
  setOpen: () => {},
  forceOpen: false,
});

/** Section open/closed state, persisted per path. */
export function useSectionState(forceOpen: boolean) {
  const [open, setOpenMap] = useState<Record<string, boolean>>(() => ({
    ...DEFAULT_OPEN,
    ...loadJson<{ sections: Record<string, boolean> }>(`${UI_KEY}:sections`, { sections: {} })
      .sections,
  }));
  const state = useMemo<SectionState>(
    () => ({
      isOpen: (p) => open[p] ?? false,
      setOpen: (p, v) =>
        setOpenMap((prev) => {
          const next = { ...prev, [p]: v };
          saveJson(`${UI_KEY}:sections`, { sections: next });
          return next;
        }),
      forceOpen,
    }),
    [open, forceOpen],
  );
  const setAll = useCallback((v: boolean) => {
    const model = getPanelModel();
    const next: Record<string, boolean> = {};
    const visit = (g: GroupNode) => {
      next[g.path] = v;
      for (const c of g.children) if (c.type === 'group') visit(c);
    };
    for (const s of model.sections) visit(s);
    setOpenMap(next);
    saveJson(`${UI_KEY}:sections`, { sections: next });
  }, []);
  return { state, setAll };
}

export { SectionStateContext };

// ------------------------------------------------------------- quick palettes

function useQuickPalettes(): QuickPalette[] {
  const st = useSchemaText();
  return useMemo(() => {
    const seen = new Set<string>();
    const out: QuickPalette[] = [];
    for (const id of PRESET_IDS) {
      const colors = getPresetConfig(id).color.palette;
      const key = colors.join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id, name: st.preset(id).label, colors });
    }
    return out;
  }, [st]);
}

// ---------------------------------------------------------------- field rows

function enumOptions(field: EnumField, path: string, st: SchemaText) {
  return field.values.map((v) => ({ value: v, label: st.enumLabel(path, v) }));
}

/**
 * One control. Memoized on the (stable) model node and subscribed to exactly the state it
 * shows, so a slider drag re-renders this row and the rows that depend on its value.
 */
export const FieldRow = memo(function FieldRow({ node }: { node: LeafNode }) {
  const store = useStore();
  const { path, field } = node;
  const visible = useSelector((s) => isChainMet(s.cfg, node.chain));
  const stored = usePathValue(path);
  const def = useSelector((s) => getPath(s.presetCfg, path)) ?? field.default;
  // A field added after the config was stored (HMR, old autosave) reads as its default.
  const value = stored ?? def;
  const effective = useModulated(path);
  const discrete = field.kind === 'boolean' || field.kind === 'enum';
  const onChange = useCallback(
    (v: unknown) => store.set(path, v, { discrete }),
    [store, path, discrete],
  );
  if (!visible) return null;
  return (
    <Control
      field={field}
      path={path}
      value={value}
      def={def}
      effective={effective}
      onChange={onChange}
    />
  );
});

interface ControlProps {
  field: FieldDef;
  path: string;
  value: unknown;
  def: unknown;
  effective: number | undefined;
  onChange(v: unknown): void;
}

function Control({ field, path, value, def, effective, onChange }: ControlProps): ReactNode {
  const st = useSchemaText();
  const common = { label: st.label(path, field), hint: st.description(path, field), path };
  switch (field.kind) {
    case 'number':
    case 'int':
      return (
        <Slider
          {...common}
          value={value as number}
          onChange={onChange}
          min={field.min}
          max={field.max}
          step={field.step ?? (field.kind === 'int' ? 1 : undefined)}
          scale={field.scale}
          unit={st.unit(path, field)}
          default={def as number}
          effective={effective}
        />
      );
    case 'angle': {
      const f: AngleField = field;
      return (
        <AngleInput
          {...common}
          value={value as number}
          onChange={onChange}
          min={f.min}
          max={f.max}
          step={f.step}
          default={def as number}
        />
      );
    }
    case 'boolean':
      return (
        <Toggle
          {...common}
          checked={value as boolean}
          onChange={onChange}
          default={def as boolean}
        />
      );
    case 'enum': {
      const options = enumOptions(field, path, st);
      const long = options.reduce((n, o) => n + o.label.length, 0) > 22;
      return options.length <= 4 ? (
        <Segmented
          {...common}
          value={value as string}
          onChange={onChange}
          options={options}
          default={def as string}
          layout={long ? 'stack' : 'row'}
        />
      ) : (
        <Select
          {...common}
          value={value as string}
          onChange={onChange}
          options={options}
          default={def as string}
        />
      );
    }
    case 'color':
      return (
        <ColorInput
          {...common}
          value={value as string}
          onChange={onChange}
          default={def as string}
        />
      );
    case 'vec2': {
      const f: Vec2Field = field;
      return (
        <Vec2Pad
          {...common}
          value={value as [number, number]}
          onChange={onChange}
          min={f.min}
          max={f.max}
          step={f.step}
          default={def as [number, number]}
        />
      );
    }
    case 'palette':
      return (
        <PaletteRow
          field={field}
          common={common}
          value={value as string[]}
          def={def as string[]}
          onChange={onChange}
        />
      );
    default:
      return null;
  }
}

function PaletteRow({
  field,
  common,
  value,
  def,
  onChange,
}: {
  field: PaletteField;
  common: { label: string; hint?: string; path: string };
  value: string[];
  def: string[];
  onChange(v: unknown): void;
}) {
  const quick = useQuickPalettes();
  // Preview math follows the interpolation the renderer will use.
  const interpolation = usePathValue<'oklab' | 'linear' | 'steps'>('color.interpolation');
  return (
    <PaletteEditor
      {...common}
      value={value}
      onChange={onChange}
      interpolation={interpolation}
      minStops={field.minStops}
      maxStops={field.maxStops}
      quickPalettes={quick}
      default={def}
    />
  );
}

// ------------------------------------------------------------------ sections

const GroupSection = memo(function GroupSection({
  node,
  visible,
  level,
}: {
  node: GroupNode;
  visible: ReadonlySet<string>;
  level: 1 | 2;
}) {
  const shown = useSelector((s) => isChainMet(s.cfg, node.chain));
  const sections = useContext(SectionStateContext);
  const st = useSchemaText();
  const weight = node.weight;
  // A mode with weight 0 does not contribute: dim its body (controls stay usable).
  const dimmed = useSelector((s) => (weight ? getPath(s.cfg, weight.path) === 0 : false));
  if (!shown || !visible.has(node.path)) return null;
  return (
    <Section
      title={st.label(node.path, node.def)}
      level={level}
      advanced={node.def.advanced}
      open={sections.forceOpen || sections.isOpen(node.path)}
      onOpenChange={(v) => sections.setOpen(node.path, v)}
      dimmed={dimmed}
      header={
        weight && visible.has(weight.path) ? (
          <div className="stand-mode-weight">
            <FieldRow node={weight} />
          </div>
        ) : undefined
      }
    >
      {node.def.description && level === 1 && (
        <p className="stand-section-note">{st.description(node.path, node.def)}</p>
      )}
      {node.children.map((c) =>
        c.type === 'leaf' ? (
          visible.has(c.path) && <FieldRow key={c.path} node={c} />
        ) : (
          <GroupSection key={c.path} node={c} visible={visible} level={2} />
        ),
      )}
    </Section>
  );
});

// --------------------------------------------------------------------- panel

export const SchemaPanel = memo(function SchemaPanel({
  query,
  showAdvanced,
}: {
  query: string;
  showAdvanced: boolean;
}) {
  const t = useT();
  const model = getPanelModel();
  const filtered = useMemo(
    () => filterModel(model, query, showAdvanced),
    [model, query, showAdvanced],
  );
  const { visible } = filtered;
  return (
    <>
      {model.topLeaves.map(
        (l) =>
          visible.has(l.path) && (
            <div className="stand-topfield" key={l.path}>
              <FieldRow node={l} />
            </div>
          ),
      )}
      {model.sections.map((s) => (
        <GroupSection key={s.path} node={s} visible={visible} level={1} />
      ))}
      {filtered.count === 0 && (
        <EmptyState>
          {t.panel.notFound(query)}
          {filtered.hiddenAdvanced > 0 && t.panel.notFoundAdvanced}
        </EmptyState>
      )}
      {filtered.count > 0 && filtered.hiddenAdvanced > 0 && (
        <p className="stand-adv-note">{t.panel.moreAdvanced(filtered.hiddenAdvanced)}</p>
      )}
    </>
  );
});
