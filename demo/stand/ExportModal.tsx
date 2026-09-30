/** Export dialog: the config as JSON (full / diff), TypeScript, React or HTML, plus JSON Schema. */

import {
  type LumiCellsConfig,
  type PresetId,
  toConfigFile,
  toHtmlSnippet,
  toJsonSchema,
  toJsonSnippet,
  toReactSnippet,
  toTsSnippet,
} from 'lumicells';
import { useMemo, useState } from 'react';
import { useSchemaText, useT } from './i18n';
import { Button, CodeBlock, copyText, Modal, Tabs } from './ui';

type Tab = 'json-full' | 'json-diff' | 'ts' | 'react' | 'html';
type Scope = 'diff' | 'full';

/** Fixed height of the code area (also set in CSS): every tab gives the modal the same size. */
const CODE_HEIGHT = '46vh';

/** Different names, so a full file never overwrites a diff file in the downloads folder. */
const FULL_FILE_NAME = 'lumicells.config.json';
const DIFF_FILE_NAME = 'lumicells.config.diff.json';

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
  cfg: LumiCellsConfig;
  presetId: PresetId;
  notify(message: string, tone?: 'info' | 'success' | 'error'): void;
}

export function ExportModal({ open, onClose, cfg, presetId, notify }: ExportModalProps) {
  const t = useT();
  const st = useSchemaText();
  const tabs = useMemo(
    () => [
      { id: 'json-full', label: t.export.tabJsonFull },
      { id: 'json-diff', label: t.export.tabJsonDiff },
      { id: 'ts', label: 'TypeScript' },
      { id: 'react', label: 'React' },
      { id: 'html', label: 'HTML' },
    ],
    [t],
  );
  const scopes = useMemo(
    () => [
      { id: 'diff', label: t.export.scopeDiff },
      { id: 'full', label: t.export.scopeFull },
    ],
    [t],
  );
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
      title={t.export.title}
      description={t.export.description(st.preset(presetId).label)}
      footer={
        <>
          <Button
            variant="primary"
            icon="copy"
            onClick={async () => {
              const ok = await copyText(code);
              notify(ok ? t.export.copied : t.export.copyFailed, ok ? 'success' : 'error');
            }}
          >
            {t.export.copy}
          </Button>
          <Button icon="download" onClick={downloadJson}>
            {t.export.downloadJson}
          </Button>
          <Button
            icon="download"
            onClick={() =>
              downloadText('lumicells.schema.json', `${JSON.stringify(toJsonSchema(), null, 2)}\n`)
            }
            title={t.export.schemaTitle}
          >
            {t.export.downloadSchema}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t.export.close}
          </Button>
        </>
      }
    >
      <div className="stand-export">
        <Tabs
          items={tabs}
          value={tab}
          onChange={(id) => setTab(id as Tab)}
          aria-label={t.export.formatAria}
        />
        {/* The row keeps its height on the JSON tabs (hidden, not removed): no layout jump. */}
        <div className="stand-export__scope-slot" data-idle={!isCode || undefined} inert={!isCode}>
          <Tabs
            variant="pills"
            items={scopes}
            value={scope}
            onChange={(id) => setScope(id as Scope)}
            aria-label={t.export.scopeAria}
            className="stand-export__scope"
          />
        </div>
        <CodeBlock
          code={code}
          language={LANGUAGE[tab]}
          title={tabs.find((x) => x.id === tab)?.label}
          maxHeight={CODE_HEIGHT}
          className="stand-export__code"
        />
      </div>
    </Modal>
  );
}
