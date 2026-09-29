/** Toolbar above the stage: preset, stage size, toggles, debug view, history and file actions. */

import { diffConfigs, PRESET_IDS, PRESETS, type PresetId } from 'pixel-life';
import { usePixelLife } from 'pixel-life/react';
import { memo, type ReactNode } from 'react';
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
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" className="plui-icon">
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

const PRESET_OPTIONS = PRESET_IDS.map((id) => ({ value: id, label: PRESETS[id].label }));
const SIZE_OPTIONS = SIZE_MODES.map((s) => ({ value: s.id, label: s.label }));
const DEBUG_OPTIONS = DEBUG_VIEWS.map((d) => ({ value: d.id, label: d.label }));

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
  const instance = usePixelLife();
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
    <KitToolbar className="stand-toolbar" aria-label="Панель стенда">
      <div className="stand-tb-group">
        <Labeled label="Пресет">
          <Tooltip content={PRESETS[presetId].description} placement="bottom">
            <NativeSelect<PresetId>
              value={presetId}
              onChange={(id) => store.selectPreset(id)}
              options={PRESET_OPTIONS}
              label="Пресет"
              className="stand-select--preset"
            />
          </Tooltip>
          {changed > 0 && (
            <Badge tone="accent" title="Параметров изменено относительно пресета">
              изменено · {changed}
            </Badge>
          )}
        </Labeled>
      </div>
      <div className="stand-tb-group">
        <Labeled label="Сцена">
          <NativeSelect<SizeMode>
            value={prefs.size}
            onChange={setSize}
            options={SIZE_OPTIONS}
            label="Размер сцены"
          />
          {prefs.size === 'custom' && (
            <span className="stand-dims">
              <input
                className="stand-dim"
                type="number"
                min={MIN_STAGE}
                max={MAX_STAGE}
                value={prefs.customW}
                aria-label="Ширина, px"
                onChange={(e) => dim('customW', e.target.value)}
              />
              ×
              <input
                className="stand-dim"
                type="number"
                min={MIN_STAGE}
                max={MAX_STAGE}
                value={prefs.customH}
                aria-label="Высота, px"
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
          title="Показать HTML-сцену поверх фона"
        >
          Демо-сцена
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
          title="Свет под курсором и волны по клику (interaction.pointer + click)"
        >
          Интерактив
        </Button>
      </div>
      <div className="stand-tb-group">
        <Labeled label="Вид">
          <NativeSelect
            value={prefs.debug}
            onChange={(debug) => patchPrefs({ debug })}
            options={DEBUG_OPTIONS}
            label="Режим отладки (D)"
          />
        </Labeled>
        <IconButton
          icon={paused ? 'play' : 'pause'}
          label={paused ? 'Продолжить (P)' : 'Пауза (P)'}
          active={paused}
          onClick={() => onPaused(!paused)}
        />
        <IconButton
          icon="warning"
          label="Потеря контекста: имитировать сбой WebGL и проверить восстановление"
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
          aria-label="Отменить (Ctrl+Z)"
          title="Отменить (Ctrl+Z)"
        >
          <Glyph d={UNDO} />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!canRedo}
          onClick={() => store.redo()}
          aria-label="Повторить (Ctrl+Shift+Z)"
          title="Повторить (Ctrl+Shift+Z)"
        >
          <Glyph d={REDO} />
        </Button>
        <IconButton
          icon="reset"
          label="Сбросить к значениям пресета"
          onClick={() => store.reset()}
          disabled={changed === 0}
        />
      </div>
      <div className="stand-tb-group">
        <Button size="sm" icon="download" onClick={onExport}>
          Экспорт
        </Button>
        <Button size="sm" icon="upload" onClick={onImport}>
          Импорт
        </Button>
        <Button size="sm" icon="copy" onClick={onCopyLink} title="Скопировать ссылку с настройками">
          Ссылка
        </Button>
      </div>
    </KitToolbar>
  );
});
