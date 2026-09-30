/** Import dialog: a file or pasted JSON is normalized, its issues are listed, then applied. */

import {
  type ConfigIssue,
  isPresetId,
  type LumiCellsConfig,
  normalizeConfig,
  type PresetId,
} from 'lumicells';
import { useEffect, useMemo, useState } from 'react';
import { useT } from './i18n';
import { Badge, type BadgeTone, Button, EmptyState, FileDrop, Modal } from './ui';

interface Parsed {
  config: LumiCellsConfig;
  presetId: PresetId | null;
  issues: ConfigIssue[];
}

/** `error` is the raw JSON.parse message; the dialog wraps it in a localized sentence. */
type ParseResult = { ok: true; value: Parsed } | { ok: false; error: string } | null;

const CODE_TONE: Record<ConfigIssue['code'], BadgeTone> = {
  'unknown-key': 'warn',
  'out-of-range': 'warn',
  clamped: 'azure',
  'bad-type': 'accent',
  'bad-color': 'accent',
  migrated: 'cyan',
};

function parse(text: string): ParseResult {
  if (!text.trim()) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  // normalizeConfig never throws: a broken file yields defaults plus a list of issues.
  const { config, issues } = normalizeConfig(raw);
  const ext = (raw as { extends?: unknown } | null)?.extends;
  return { ok: true, value: { config, issues, presetId: isPresetId(ext) ? ext : null } };
}

interface ImportModalProps {
  open: boolean;
  onClose(): void;
  onApply(config: LumiCellsConfig, presetId: PresetId | null): void;
}

export function ImportModal({ open, onClose, onApply }: ImportModalProps) {
  const t = useT();
  const [text, setText] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setText('');
      setFileError(null);
    }
  }, [open]);

  const result = useMemo(() => parse(text), [text]);
  const value = result?.ok ? result.value : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={t.import.title}
      description={t.import.description}
      footer={
        <>
          <Button
            variant="primary"
            disabled={!value}
            onClick={() => {
              if (!value) return;
              onApply(value.config, value.presetId);
              onClose();
            }}
          >
            {t.import.apply}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t.import.cancel}
          </Button>
        </>
      }
    >
      <div className="stand-import">
        <FileDrop
          accept=".json,application/json"
          onText={(t) => {
            setFileError(null);
            setText(t);
          }}
          onError={setFileError}
        >
          {t.import.drop}
        </FileDrop>
        {fileError && <p className="stand-import__error">{fileError}</p>}
        <textarea
          className="stand-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder='{ "extends": "orb", "modes": { "sphere": { "radius": 0.8 } } }'
          spellCheck={false}
          aria-label={t.import.jsonAria}
          rows={8}
        />
        {result && !result.ok && (
          <p className="stand-import__error">{t.import.badJson(result.error)}</p>
        )}
        {value && (
          <section className="stand-issues" aria-label={t.import.resultAria}>
            <div className="stand-issues__head">
              {value.issues.length === 0 ? (
                <Badge tone="ok">{t.import.noIssues}</Badge>
              ) : (
                <Badge tone="warn">{t.import.issues(value.issues.length)}</Badge>
              )}
              {value.presetId && <Badge tone="azure">extends: {value.presetId}</Badge>}
            </div>
            {value.issues.length > 0 ? (
              <table className="stand-issues__table">
                <thead>
                  <tr>
                    <th>{t.import.path}</th>
                    <th>{t.import.code}</th>
                    <th>{t.import.message}</th>
                  </tr>
                </thead>
                <tbody>
                  {value.issues.map((i) => (
                    <tr key={`${i.path}:${i.code}:${i.message}`}>
                      <td>
                        <code>{i.path || t.import.root}</code>
                      </td>
                      <td>
                        <Badge tone={CODE_TONE[i.code]} outline>
                          {i.code}
                        </Badge>
                      </td>
                      <td>{i.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyState>{t.import.valid}</EmptyState>
            )}
          </section>
        )}
      </div>
    </Modal>
  );
}
