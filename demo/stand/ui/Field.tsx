import { type ReactNode, useId } from 'react';
import { useT } from '../i18n';
import { Icon } from './Icon';
import { copyText, cx, useFlash } from './utils';

/** Props shared by every labelled control. */
export interface FieldBaseProps {
  label: ReactNode;
  /** Description shown in the hover / keyboard-focus popover. */
  hint?: ReactNode;
  /** Config key, shown in monospace inside the popover; click copies it. */
  path?: string;
  disabled?: boolean;
  /** Puts a small note next to the label, e.g. a "modulated" badge. */
  badge?: ReactNode;
  className?: string;
}

export interface FieldProps extends FieldBaseProps {
  /** Id of the labelled control (for <label htmlFor>). */
  htmlFor?: string;
  labelId?: string;
  /** Shows the "changed" marker and enables the reset button. */
  changed?: boolean;
  onReset?(): void;
  /** `row`: label left, control right. `stack`: label above a full-width control. */
  layout?: 'row' | 'stack';
  children?: ReactNode;
}

/**
 * Layout shell of all controls: label + reset + control, plus a popover under the row
 * with the hint and the copyable config path. The popover is absolutely positioned,
 * so hovering never shifts the layout of a dense panel.
 */
export function Field({
  label,
  hint,
  path,
  disabled,
  badge,
  className,
  htmlFor,
  labelId,
  changed,
  onReset,
  layout = 'row',
  children,
}: FieldProps) {
  const t = useT();
  const title = typeof label === 'string' ? label : undefined;
  return (
    <div
      className={cx('lcui-field', `lcui-field--${layout}`, className)}
      data-disabled={disabled || undefined}
      data-changed={changed || undefined}
    >
      <div className="lcui-field__row">
        <div className="lcui-field__labelwrap">
          <label
            id={labelId}
            htmlFor={htmlFor}
            className="lcui-field__label"
            title={onReset ? `${title ?? ''}${title ? ' — ' : ''}${t.ui.doubleClickReset}` : title}
            onDoubleClick={() => !disabled && changed && onReset?.()}
          >
            {label}
          </label>
          {badge}
          {onReset && (
            <button
              type="button"
              className="lcui-field__reset"
              onClick={onReset}
              disabled={disabled || !changed}
              tabIndex={changed && !disabled ? 0 : -1}
              aria-label={t.ui.resetAria(title ?? t.ui.value)}
              title={t.ui.resetTitle}
            >
              <Icon name="reset" size={11} />
            </button>
          )}
        </div>
        <div className="lcui-field__control">{children}</div>
      </div>
      {(hint || path) && <FieldPop hint={hint} path={path} />}
    </div>
  );
}

function FieldPop({ hint, path }: { hint?: ReactNode; path?: string }) {
  const t = useT();
  const id = useId();
  const [copied, flash] = useFlash();
  return (
    <div className="lcui-field__pop" id={id}>
      {hint && <div className="lcui-field__hint">{hint}</div>}
      {path && (
        <button
          type="button"
          className={cx('lcui-path', copied && 'is-done')}
          onClick={async () => {
            if (await copyText(path)) flash();
          }}
          title={t.ui.copyPath}
        >
          <code>{path}</code>
          <Icon name={copied ? 'check' : 'copy'} size={11} />
        </button>
      )}
    </div>
  );
}

/** Tiny "modulated by animation" badge used next to labels. */
export function ModulatedBadge({ effective, decimals }: { effective: number; decimals: number }) {
  const t = useT();
  return (
    <span className="lcui-modbadge" title={t.ui.modulatedTitle(effective.toFixed(decimals))}>
      {t.ui.modulated}
    </span>
  );
}
