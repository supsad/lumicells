/**
 * Toolbar above the stage: preset, stage size, toggles, debug view, history and file actions,
 * plus the language switcher and the GitHub / examples links.
 */

import { diffConfigs, PRESET_IDS, type PresetId } from 'lumicells';
import { useLumiCells } from 'lumicells/react';
import { memo, type ReactNode, useEffect, useMemo, useRef } from 'react';
import { LOCALE_NAMES, type Locale, useI18n, useSchemaText } from './i18n';
import { DEBUG_VIEWS, MAX_STAGE, MIN_STAGE, type Prefs, SIZE_MODES, type SizeMode } from './prefs';
import { useSelector, useStore } from './store';
import { Badge, Button, IconButton, Toolbar as KitToolbar, Tooltip } from './ui';

interface ToolbarProps {
  prefs: Prefs;
  patchPrefs(patch: Partial<Prefs>): void;
  paused: boolean;
  onPaused(paused: boolean): void;
  onExport(): void;
  onImport(): void;
  onCopyLink(): void;
}

function Glyph({ d }: { d: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" className="lcui-icon">
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const UNDO = 'M6 3.5 3 6.5l3 3M3 6.5h6a3.5 3.5 0 0 1 0 7H6.5';
const REDO = 'M10 3.5l3 3-3 3M13 6.5H7a3.5 3.5 0 0 0 0 7h2.5';

function NativeSelect<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T;
  onChange(v: T): void;
  options: ReadonlyArray<{ value: T; label: string }>;
  label: string;
  className?: string;
}) {
  return (
    <select
      className={`stand-select${className ? ` ${className}` : ''}`}
      value={value}
      aria-label={label}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="stand-tb-field">
      <span className="stand-tb-label">{label}</span>
      {children}
    </span>
  );
}

export const REPO_URL = 'https://github.com/supsad/lumicells';

/** Relative, so the links keep working when the site is served from a sub-path. */
const EXAMPLES = [
  { href: './examples/web-component.html', key: 'exampleElement' },
  { href: './examples/core-basic.html', key: 'exampleVanilla' },
] as const;

const LOCALE_ORDER: readonly Locale[] = ['en', 'ru'];

/** EN / RU segmented switch; each caption is written in its own language. */
function LanguageSwitch() {
  const { locale, setLocale, t } = useI18n();
  return (
    <fieldset className="stand-lang" aria-label={t.meta.language}>
      {LOCALE_ORDER.map((l) => (
        <button
          key={l}
          type="button"
          className="stand-lang__btn"
          aria-pressed={locale === l}
          lang={l}
          title={t.meta.localeNames[l]}
          onClick={() => setLocale(l)}
        >
          {LOCALE_NAMES[l].short}
        </button>
      ))}
    </fieldset>
  );
}

/** A disclosure with the plain HTML examples; closes on outside click and Escape. */
function ExamplesMenu() {
  const { t } = useI18n();
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: Event) => {
      const el = ref.current;
      if (!el?.open) return;
      if (e instanceof KeyboardEvent) {
        if (e.key !== 'Escape') return;
        el.open = false;
        el.querySelector('summary')?.focus();
      } else if (!el.contains(e.target as Node)) el.open = false;
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, []);
  return (
    <details ref={ref} className="stand-menu">
      <summary className="stand-link" title={t.meta.examplesTitle}>
        {t.meta.examples}
      </summary>
      <div className="stand-menu__list">
        {EXAMPLES.map((e) => (
          <a key={e.href} className="stand-menu__item" href={e.href}>
            {t.meta[e.key]}
          </a>
        ))}
      </div>
    </details>
  );
}

export const StandToolbar = memo(function StandToolbar({
  prefs,
  patchPrefs,
  paused,
  onPaused,
  onExport,
  onImport,
  onCopyLink,
}: ToolbarProps) {
  const store = useStore();
  const instance = useLumiCells();
  const { t } = useI18n();
  const st = useSchemaText();
  const presetOptions = useMemo(
    () => PRESET_IDS.map((id) => ({ value: id, label: st.preset(id).label })),
    [st],
  );
  const sizeOptions = useMemo(
    () => SIZE_MODES.map((s) => ({ value: s.id, label: t.sizes[s.id] })),
    [t],
  );
  const debugOptions = useMemo(
    () => DEBUG_VIEWS.map((d) => ({ value: d.id, label: t.debugViews[d.id] })),
    [t],
  );
  const presetId = useSelector((s) => s.presetId);
  const changed = useSelector((s) => diffConfigs(s.cfg, s.presetCfg).length);
  const canUndo = useSelector((s) => s.canUndo);
  const canRedo = useSelector((s) => s.canRedo);
  const interactive = useSelector((s) => s.cfg.interaction.pointer && s.cfg.interaction.click);

  const setSize = (size: SizeMode) => patchPrefs({ size });
  const dim = (key: 'customW' | 'customH', raw: string) => {
    const v = Number.parseInt(raw, 10);
    if (Number.isFinite(v)) {
      patchPrefs({ [key]: Math.min(MAX_STAGE, Math.max(MIN_STAGE, v)) });
    }
  };

  return (
    <KitToolbar className="stand-toolbar" aria-label={t.toolbar.aria}>
      <div className="stand-tb-group">
        <Labeled label={t.toolbar.preset}>
          <Tooltip content={st.preset(presetId).description} placement="bottom">
            <NativeSelect<PresetId>
              value={presetId}
              onChange={(id) => store.selectPreset(id)}
              options={presetOptions}
              label={t.toolbar.preset}
              className="stand-select--preset"
            />
          </Tooltip>
          {changed > 0 && (
            <Badge tone="accent" title={t.toolbar.changedTitle}>
              {t.toolbar.changed(changed)}
            </Badge>
          )}
        </Labeled>
      </div>
      <div className="stand-tb-group">
        <Labeled label={t.toolbar.stage}>
          <NativeSelect<SizeMode>
            value={prefs.size}
            onChange={setSize}
            options={sizeOptions}
            label={t.toolbar.stageSize}
          />
          {prefs.size === 'custom' && (
            <span className="stand-dims">
              <input
                className="stand-dim"
                type="number"
                min={MIN_STAGE}
                max={MAX_STAGE}
                value={prefs.customW}
                aria-label={t.toolbar.width}
                onChange={(e) => dim('customW', e.target.value)}
              />
              ×
              <input
                className="stand-dim"
                type="number"
                min={MIN_STAGE}
                max={MAX_STAGE}
                value={prefs.customH}
                aria-label={t.toolbar.height}
                onChange={(e) => dim('customH', e.target.value)}
              />
            </span>
          )}
        </Labeled>
      </div>
      <div className="stand-tb-group">
        <Button
          size="sm"
          active={prefs.scene}
          onClick={() => patchPrefs({ scene: !prefs.scene })}
          title={t.toolbar.demoSceneTitle}
        >
          {t.toolbar.demoScene}
        </Button>
        <Button
          size="sm"
          active={interactive}
          onClick={() =>
            store.setMany(
              [
                ['interaction.pointer', !interactive],
                ['interaction.click', !interactive],
              ],
              { discrete: true },
            )
          }
          title={t.toolbar.interactiveTitle}
        >
          {t.toolbar.interactive}
        </Button>
      </div>
      <div className="stand-tb-group">
        <Labeled label={t.toolbar.view}>
          <NativeSelect
            value={prefs.debug}
            onChange={(debug) => patchPrefs({ debug })}
            options={debugOptions}
            label={t.toolbar.debugView}
          />
        </Labeled>
        <IconButton
          icon={paused ? 'play' : 'pause'}
          label={paused ? t.toolbar.resume : t.toolbar.pause}
          active={paused}
          onClick={() => onPaused(!paused)}
        />
        <IconButton
          icon="warning"
          label={t.toolbar.loseContext}
          onClick={() => instance?.loseContextForTesting()}
          disabled={!instance}
        />
      </div>
      <div className="stand-tb-group stand-tb-group--end">
        <Button
          size="sm"
          variant="ghost"
          disabled={!canUndo}
          onClick={() => store.undo()}
          aria-label={t.toolbar.undo}
          title={t.toolbar.undo}
        >
          <Glyph d={UNDO} />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!canRedo}
          onClick={() => store.redo()}
          aria-label={t.toolbar.redo}
          title={t.toolbar.redo}
        >
          <Glyph d={REDO} />
        </Button>
        <IconButton
          icon="reset"
          label={t.toolbar.reset}
          onClick={() => store.reset()}
          disabled={changed === 0}
        />
      </div>
      <div className="stand-tb-group">
        <Button size="sm" icon="download" onClick={onExport}>
          {t.toolbar.export}
        </Button>
        <Button size="sm" icon="upload" onClick={onImport}>
          {t.toolbar.import}
        </Button>
        <Button size="sm" icon="copy" onClick={onCopyLink} title={t.toolbar.linkTitle}>
          {t.toolbar.link}
        </Button>
      </div>
      <div className="stand-tb-group stand-tb-group--meta">
        <LanguageSwitch />
        <a
          className="stand-link"
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          title={t.meta.githubTitle}
        >
          {t.meta.github}
        </a>
        <ExamplesMenu />
      </div>
    </KitToolbar>
  );
});
