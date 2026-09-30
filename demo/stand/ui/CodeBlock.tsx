import type { ReactNode } from 'react';
import { Icon } from './Icon';
import { copyText, cx, useFlash } from './utils';

export interface CodeBlockProps {
  code: string;
  /** Shown as a small tag in the header, e.g. "json". */
  language?: string;
  title?: ReactNode;
  /** CSS max-height of the scroll area (default 260px). */
  maxHeight?: number | string;
  wrap?: boolean;
  /** Called after a successful copy. */
  onCopy?(): void;
  className?: string;
}

export function CodeBlock({
  code,
  language,
  title,
  maxHeight = 260,
  wrap,
  onCopy,
  className,
}: CodeBlockProps) {
  const [copied, flash] = useFlash();
  const doCopy = async () => {
    if (await copyText(code)) {
      flash();
      onCopy?.();
    }
  };
  return (
    <figure className={cx('lcui-code', className)}>
      <figcaption className="lcui-code__head">
        <span className="lcui-code__title">{title ?? language ?? 'code'}</span>
        {title && language && <span className="lcui-code__lang">{language}</span>}
        <button
          type="button"
          className={cx('lcui-code__copy', copied && 'is-done')}
          onClick={doCopy}
          aria-label="Скопировать код"
        >
          <Icon name={copied ? 'check' : 'copy'} size={12} />
          <span aria-live="polite">{copied ? 'Скопировано' : 'Копировать'}</span>
        </button>
      </figcaption>
      <pre
        className={cx('lcui-code__pre', wrap && 'is-wrap')}
        style={{ maxHeight }}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard reachable
        tabIndex={0}
      >
        <code>{code}</code>
      </pre>
    </figure>
  );
}
