import { type ReactNode, useRef, useState } from 'react';
import { Icon } from './Icon';
import { cx } from './utils';

export interface FileDropProps {
  /** Comma-separated extensions / mime types, like the native `accept` attribute. */
  accept?: string;
  /** Receives the raw file. */
  onFile?(file: File): void;
  /** Receives the file contents as text (read for you). */
  onText?(text: string, file: File): void;
  /** Called for rejected files (wrong type) or read errors. */
  onError?(message: string, file?: File): void;
  children?: ReactNode;
  disabled?: boolean;
  className?: string;
}

function matchesAccept(file: File, accept: string): boolean {
  const rules = accept
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (rules.length === 0) return true;
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return rules.some((r) =>
    r.startsWith('.')
      ? name.endsWith(r)
      : r.endsWith('/*')
        ? type.startsWith(r.slice(0, -1))
        : type === r,
  );
}

/**
 * Drop zone built on a <label> around a visually hidden file input: click, Enter and
 * Space open the picker natively, drag & drop is added on top.
 */
export function FileDrop({
  accept = '.json,application/json',
  onFile,
  onText,
  onError,
  children,
  disabled,
  className,
}: FileDropProps) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);

  const handle = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (!matchesAccept(file, accept)) {
      onError?.(`Файл «${file.name}» не подходит: нужен ${accept}`, file);
      return;
    }
    onFile?.(file);
    if (onText) {
      file.text().then(
        (t) => onText(t, file),
        () => onError?.(`Не удалось прочитать «${file.name}»`, file),
      );
    }
  };

  return (
    <label
      className={cx('lcui-drop', over && 'is-over', disabled && 'is-disabled', className)}
      onDragEnter={(e) => {
        e.preventDefault();
        depth.current++;
        if (!disabled) setOver(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        if (!disabled) handle(e.dataTransfer.files);
      }}
    >
      <Icon name="upload" size={18} />
      <span className="lcui-drop__text">
        {children ?? (
          <>
            Перетащите <b>.json</b> сюда или нажмите, чтобы выбрать
          </>
        )}
      </span>
      <input
        className="lcui-drop__input"
        type="file"
        accept={accept}
        disabled={disabled}
        onChange={(e) => {
          handle(e.target.files);
          // Allow picking the same file twice in a row.
          e.target.value = '';
        }}
      />
    </label>
  );
}
