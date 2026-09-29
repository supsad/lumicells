import { type ReactNode, useEffect, useId, useRef } from 'react';
import { IconButton } from './Button';
import { cx, useLatest } from './utils';

export interface ModalProps {
  open: boolean;
  onClose(): void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Buttons row at the bottom. */
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Close on backdrop click (default true). */
  dismissable?: boolean;
  className?: string;
}

/**
 * Modal dialog on top of the native <dialog>: the browser provides the top layer,
 * focus trapping, inertness of the page and Escape handling; we add the look,
 * backdrop click and focus restoration.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  dismissable = true,
  className,
}: ModalProps) {
  if (!open) return null;
  return (
    <ModalInner
      onClose={onClose}
      title={title}
      description={description}
      footer={footer}
      size={size}
      dismissable={dismissable}
      className={className}
    >
      {children}
    </ModalInner>
  );
}

function ModalInner({
  onClose,
  title,
  description,
  children,
  footer,
  size,
  dismissable,
  className,
}: Omit<ModalProps, 'open'> & { size: NonNullable<ModalProps['size']> }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const close = useLatest(onClose);

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    const prev = document.activeElement as HTMLElement | null;
    if (!dlg.open) dlg.showModal();
    return () => {
      if (dlg.open) dlg.close();
      prev?.focus?.();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className={cx('plui-modal', `plui-modal--${size}`, className)}
      aria-labelledby={`${id}-t`}
      aria-describedby={description ? `${id}-d` : undefined}
      onCancel={(e) => {
        e.preventDefault();
        close.current();
      }}
      onMouseDown={(e) => {
        // Only a press on the backdrop itself (dialog has no padding) closes.
        if (dismissable && e.target === e.currentTarget) close.current();
      }}
    >
      <div className="plui-modal__box">
        <header className="plui-modal__head">
          <h2 id={`${id}-t`} className="plui-modal__title">
            {title}
          </h2>
          <IconButton icon="close" label="Закрыть" size="sm" onClick={() => close.current()} />
        </header>
        {description && (
          <p id={`${id}-d`} className="plui-modal__desc">
            {description}
          </p>
        )}
        <div className="plui-modal__body">{children}</div>
        {footer && <footer className="plui-modal__foot">{footer}</footer>}
      </div>
    </dialog>
  );
}
