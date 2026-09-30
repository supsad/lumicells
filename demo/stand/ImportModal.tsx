/** Import dialog: a file or pasted JSON is normalized, its issues are listed, then applied. */

import {
  type ConfigIssue,
  isPresetId,
  type LumiCellsConfig,
  normalizeConfig,
  type PresetId,
} from 'lumicells';
import { useEffect, useMemo, useState } from 'react';
import { Badge, type BadgeTone, Button, EmptyState, FileDrop, Modal } from './ui';

interface Parsed {
  config: LumiCellsConfig;
  presetId: PresetId | null;
  issues: ConfigIssue[];
}

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
    return { ok: false, error: `Некорректный JSON: ${(e as Error).message}` };
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
      title="Импорт настроек"
      description="Загрузите файл lumicells.config.json или вставьте JSON. Значения вне диапазона будут исправлены, неизвестные ключи отброшены."
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
            Применить
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Отмена
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
          Перетащите JSON-файл сюда или выберите его
        </FileDrop>
        {fileError && <p className="stand-import__error">{fileError}</p>}
        <textarea
          className="stand-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder='{ "extends": "orb", "modes": { "sphere": { "radius": 0.8 } } }'
          spellCheck={false}
          aria-label="JSON конфигурации"
          rows={8}
        />
        {result && !result.ok && <p className="stand-import__error">{result.error}</p>}
        {value && (
          <section className="stand-issues" aria-label="Результат проверки">
            <div className="stand-issues__head">
              {value.issues.length === 0 ? (
                <Badge tone="ok">Проблем нет</Badge>
              ) : (
                <Badge tone="warn">Замечаний: {value.issues.length}</Badge>
              )}
              {value.presetId && <Badge tone="azure">extends: {value.presetId}</Badge>}
            </div>
            {value.issues.length > 0 ? (
              <table className="stand-issues__table">
                <thead>
                  <tr>
                    <th>Путь</th>
                    <th>Код</th>
                    <th>Сообщение</th>
                  </tr>
                </thead>
                <tbody>
                  {value.issues.map((i) => (
                    <tr key={`${i.path}:${i.code}:${i.message}`}>
                      <td>
                        <code>{i.path || '(корень)'}</code>
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
              <EmptyState>Файл корректен и будет применён как есть.</EmptyState>
            )}
          </section>
        )}
      </div>
    </Modal>
  );
}
