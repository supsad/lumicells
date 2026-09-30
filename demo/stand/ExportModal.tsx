/** Export dialog: the config as JSON (full / diff), TypeScript, React or HTML, plus JSON Schema. */

import {
  type PixelLifeConfig,
  PRESETS,
  type PresetId,
  toConfigFile,
  toHtmlSnippet,
  toJsonSchema,
  toJsonSnippet,
  toReactSnippet,
  toTsSnippet,
} from 'pixel-life';
import { useMemo, useState } from 'react';
import { Button, CodeBlock, copyText, Modal, Tabs } from './ui';

type Tab = 'json-full' | 'json-diff' | 'ts' | 'react' | 'html';
type Scope = 'diff' | 'full';

/** Fixed height of the code area (also set in CSS): every tab gives the modal the same size. */
const CODE_HEIGHT = '46vh';

const TABS = [
  { id: 'json-full', label: 'JSON (полный)' },
  { id: 'json-diff', label: 'JSON (разница с пресетом)' },
  { id: 'ts', label: 'TypeScript' },
  { id: 'react', label: 'React' },
  { id: 'html', label: 'HTML' },
] as const;

const SCOPES = [
  { id: 'diff', label: 'Только отличия от пресета' },
  { id: 'full', label: 'Все параметры' },
] as const;

/** Different names, so a full file never overwrites a diff file in the downloads folder. */
const FULL_FILE_NAME = 'pixel-life.config.json';
const DIFF_FILE_NAME = 'pixel-life.config.diff.json';

const LANGUAGE: Record<Tab, string> = {
  'json-full': 'json',
  'json-diff': 'json',
  ts: 'ts',
  react: 'tsx',
  html: 'html',
};

/** Saves text as a file through a temporary link (no server round trip). */
export function downloadText(name: string, text: string, mime = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

interface ExportModalProps {
  open: boolean;
  onClose(): void;
  cfg: PixelLifeConfig;
  presetId: PresetId;
  notify(message: string, tone?: 'info' | 'success' | 'error'): void;
}

export function ExportModal({ open, onClose, cfg, presetId, notify }: ExportModalProps) {
  const [tab, setTab] = useState<Tab>('json-diff');
  const [scope, setScope] = useState<Scope>('diff');

  const mode = tab === 'json-full' ? 'full' : tab === 'json-diff' ? 'diff' : scope;

  const code = useMemo(() => {
    if (!open) return '';
    const file = toConfigFile(cfg, { mode, base: presetId });
    switch (tab) {
      case 'ts':
        return toTsSnippet(file);
      case 'react':
        return toReactSnippet(file);
      case 'html':
        return toHtmlSnippet(file);
      default:
        return toJsonSnippet(file);
    }
  }, [open, cfg, presetId, tab, mode]);

  const isCode = tab === 'ts' || tab === 'react' || tab === 'html';

  const downloadJson = () => {
    // Both files carry `extends: <preset>`, so importing either restores the base preset.
    downloadText(
      mode === 'full' ? FULL_FILE_NAME : DIFF_FILE_NAME,
      toJsonSnippet(toConfigFile(cfg, { mode, base: presetId })),
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Экспорт настроек"
      description={`Пресет-основа: ${PRESETS[presetId].label}. Файл ссылается на неё через extends; «разница» содержит только изменённые параметры.`}
      footer={
        <>
          <Button
            variant="primary"
            icon="copy"
            onClick={async () => {
              const ok = await copyText(code);
              notify(ok ? 'Скопировано' : 'Не удалось скопировать', ok ? 'success' : 'error');
            }}
          >
            Копировать
          </Button>
          <Button icon="download" onClick={downloadJson}>
            Скачать JSON
          </Button>
          <Button
            icon="download"
            onClick={() =>
              downloadText('pixel-life.schema.json', `${JSON.stringify(toJsonSchema(), null, 2)}\n`)
            }
            title="JSON Schema для подсказок в редакторе"
          >
            Скачать JSON Schema
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Закрыть
          </Button>
        </>
      }
    >
      <div className="stand-export">
        <Tabs
          items={TABS}
          value={tab}
          onChange={(id) => setTab(id as Tab)}
          aria-label="Формат экспорта"
        />
        {/* The row keeps its height on the JSON tabs (hidden, not removed): no layout jump. */}
        <div className="stand-export__scope-slot" data-idle={!isCode || undefined} inert={!isCode}>
          <Tabs
            variant="pills"
            items={SCOPES}
            value={scope}
            onChange={(id) => setScope(id as Scope)}
            aria-label="Объём данных"
            className="stand-export__scope"
          />
        </div>
        <CodeBlock
          code={code}
          language={LANGUAGE[tab]}
          title={TABS.find((t) => t.id === tab)?.label}
          maxHeight={CODE_HEIGHT}
          className="stand-export__code"
        />
      </div>
    </Modal>
  );
}
