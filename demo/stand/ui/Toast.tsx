import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { IconButton } from './Button';
import { Icon, type IconName } from './Icon';
import { cx } from './utils';

export type ToastTone = 'info' | 'success' | 'warn' | 'error';

export interface ToastItem {
  id: number;
  message: ReactNode;
  title?: ReactNode;
  tone?: ToastTone;
  /** ms before auto-dismiss; 0 keeps it until closed. Default 4000. */
  duration?: number;
}

const TONE_ICON: Record<ToastTone, IconName> = {
  info: 'info',
  success: 'check',
  warn: 'warning',
  error: 'warning',
};

export interface ToastListProps {
  items: readonly ToastItem[];
  onDismiss(id: number): void;
  /** Where the stack sits inside its positioned parent. */
  placement?: 'bottom-right' | 'bottom-left' | 'top-right';
  className?: string;
}

/** Live-region list of notices. Purely presentational; see `useToasts` for state. */
export function ToastList({
  items,
  onDismiss,
  placement = 'bottom-right',
  className,
}: ToastListProps) {
  const t = useT();
  return (
    <section
      className={cx('lcui-toasts', `lcui-toasts--${placement}`, className)}
      aria-label={t.ui.notifications}
      aria-live="polite"
    >
      {items.map((item) => (
        <ToastView key={item.id} item={item} onDismiss={onDismiss} />
      ))}
    </section>
  );
}

function ToastView({ item, onDismiss }: { item: ToastItem; onDismiss(id: number): void }) {
  const t = useT();
  const { id, duration = 4000, tone = 'info' } = item;
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (!duration || paused) return;
    const timer = window.setTimeout(() => onDismiss(id), duration);
    return () => window.clearTimeout(timer);
  }, [id, duration, paused, onDismiss]);

  return (
    <div
      className={cx('lcui-toast', `lcui-toast--${tone}`)}
      role={tone === 'error' ? 'alert' : 'status'}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
    >
      <Icon name={TONE_ICON[tone]} size={14} className="lcui-toast__icon" />
      <div className="lcui-toast__body">
        {item.title && <div className="lcui-toast__title">{item.title}</div>}
        <div className="lcui-toast__msg">{item.message}</div>
      </div>
      <IconButton
        icon="close"
        label={t.ui.dismissNotification}
        size="xs"
        onClick={() => onDismiss(id)}
      />
    </div>
  );
}

export interface UseToasts {
  toasts: ToastItem[];
  push(message: ReactNode, opts?: Omit<ToastItem, 'id' | 'message'>): number;
  dismiss(id: number): void;
  clear(): void;
}

/** Small state holder for `ToastList`. `push` and `dismiss` are referentially stable. */
export function useToasts(limit = 5): UseToasts {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const push = useCallback<UseToasts['push']>(
    (message, opts) => {
      const id = ++seq.current;
      setToasts((list) => [...list.slice(-(limit - 1)), { ...opts, id, message }]);
      return id;
    },
    [limit],
  );
  const dismiss = useCallback((id: number) => setToasts((l) => l.filter((t) => t.id !== id)), []);
  const clear = useCallback(() => setToasts([]), []);
  return { toasts, push, dismiss, clear };
}
