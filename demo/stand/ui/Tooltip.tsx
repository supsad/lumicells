import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { clamp, cx } from './utils';

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  placement?: 'top' | 'bottom';
  /** Hover delay in ms (focus shows immediately). */
  delay?: number;
  disabled?: boolean;
  className?: string;
}

interface Pos {
  left: number;
  top: number;
  arrowX: number;
  placement: 'top' | 'bottom';
}

/**
 * Tooltip rendered in a portal with fixed positioning, so scroll containers and
 * backdrop-filter stacking contexts of the panel never clip it.
 */
export function Tooltip({
  content,
  children,
  placement = 'top',
  delay = 350,
  disabled,
  className,
}: TooltipProps) {
  const id = useId();
  const wrap = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const timer = useRef(0);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Pos | null>(null);

  const show = useCallback(
    (immediate: boolean) => {
      window.clearTimeout(timer.current);
      if (immediate) setOpen(true);
      else timer.current = window.setTimeout(() => setOpen(true), delay);
    },
    [delay],
  );
  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setOpen(false);
    setPos(null);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && hide();
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', hide, { capture: true, passive: true });
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', hide, { capture: true });
    };
  }, [open, hide]);

  useLayoutEffect(() => {
    if (!open || !wrap.current || !tip.current) return;
    const a = wrap.current.getBoundingClientRect();
    const t = tip.current.getBoundingClientRect();
    const gap = 8;
    let p = placement;
    if (p === 'top' && a.top - t.height - gap < 4) p = 'bottom';
    else if (p === 'bottom' && a.bottom + t.height + gap > window.innerHeight - 4) p = 'top';
    const cx0 = a.left + a.width / 2;
    const left = clamp(cx0 - t.width / 2, 6, window.innerWidth - t.width - 6);
    setPos({
      left,
      top: p === 'top' ? a.top - t.height - gap : a.bottom + gap,
      arrowX: clamp(cx0 - left, 10, t.width - 10),
      placement: p,
    });
  }, [open, placement]);

  if (disabled || content == null || content === '') return <>{children}</>;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover/focus only reveal the tooltip; the wrapped child is the interactive element
    <span
      ref={wrap}
      className={cx('lcui-tip', className)}
      aria-describedby={open ? id : undefined}
      onPointerEnter={(e) => e.pointerType === 'mouse' && show(false)}
      onPointerLeave={hide}
      onFocus={() => show(true)}
      onBlur={hide}
      onPointerDown={hide}
    >
      {children}
      {open &&
        createPortal(
          <div
            ref={tip}
            id={id}
            role="tooltip"
            className={cx('lcui-tooltip', pos && 'is-placed')}
            data-placement={pos?.placement ?? placement}
            style={{
              left: pos?.left ?? 0,
              top: pos?.top ?? 0,
              ['--lcui-arrow-x' as string]: `${pos?.arrowX ?? 0}px`,
            }}
          >
            {content}
          </div>,
          document.body,
        )}
    </span>
  );
}

export interface HintProps {
  children: ReactNode;
  placement?: 'top' | 'bottom';
  label?: string;
}

/** Small "i" glyph with a tooltip; focusable so keyboard users can read it. */
export function Hint({ children, placement, label = 'Подсказка' }: HintProps) {
  return (
    <Tooltip content={children} placement={placement}>
      <button type="button" className="lcui-hint" aria-label={label}>
        <Icon name="info" size={12} />
      </button>
    </Tooltip>
  );
}
