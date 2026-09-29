import { useState } from 'react';
import { clamp, cx, formatValue, parseNumber } from './utils';

export interface NumberInputProps {
  value: number;
  /** Called with a clamped value on Enter / blur / arrow keys. */
  onCommit(v: number): void;
  min?: number;
  max?: number;
  /** Arrow-key increment (Shift x10, Alt x0.1). */
  step?: number;
  decimals?: number;
  /** Strip trailing zeros in the display (12.50 -> 12.5). */
  trim?: boolean;
  unit?: string;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  /** Wrap out-of-range values instead of clamping (angles). */
  wrap?: boolean;
  className?: string;
}

/**
 * Text field for exact numeric entry. Edits stay local (a draft) until committed, so
 * typing "0." or "-" never fights the controlled value.
 */
export function NumberInput({
  value,
  onCommit,
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
  step = 1,
  decimals = 2,
  trim,
  unit,
  disabled,
  id,
  wrap,
  className,
  ...aria
}: NumberInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? formatValue(value, decimals, trim);
  const invalid = draft !== null && parseNumber(draft) === null && draft.trim() !== '';

  const constrain = (v: number) => {
    if (wrap && Number.isFinite(min) && Number.isFinite(max)) {
      const span = max - min;
      return span > 0 ? ((((v - min) % span) + span) % span) + min : min;
    }
    return clamp(v, min, max);
  };

  const commit = (text: string) => {
    const n = parseNumber(text);
    if (n !== null) {
      const v = constrain(n);
      if (v !== value) onCommit(Number(v.toFixed(6)));
    }
    setDraft(null);
  };

  return (
    <span className={cx('plui-num', invalid && 'is-invalid', className)}>
      <input
        id={id}
        className="plui-num__input"
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        value={shown}
        aria-invalid={invalid || undefined}
        {...aria}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => draft !== null && commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit(e.currentTarget.value);
            e.currentTarget.select();
          } else if (e.key === 'Escape') {
            setDraft(null);
            e.currentTarget.blur();
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
            const base = draft !== null ? (parseNumber(draft) ?? value) : value;
            const v = constrain(base + (e.key === 'ArrowUp' ? 1 : -1) * step * mult);
            onCommit(Number(v.toFixed(6)));
            setDraft(null);
          }
        }}
      />
      {unit && (
        <span className="plui-num__unit" title={unit}>
          {unit}
        </span>
      )}
    </span>
  );
}
