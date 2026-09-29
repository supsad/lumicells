import { type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode, useRef } from 'react';
import { Icon, type IconName } from './Icon';
import { cx } from './utils';

export type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  icon?: IconName;
  /** Stretches the button to the container width. */
  block?: boolean;
  /** Pressed / toggled-on look (also sets aria-pressed when defined). */
  active?: boolean;
}

export function Button({
  variant = 'default',
  size = 'md',
  icon,
  block,
  active,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        'plui-btn',
        `plui-btn--${variant}`,
        size === 'sm' && 'plui-btn--sm',
        block && 'plui-btn--block',
        active && 'is-active',
        className,
      )}
      aria-pressed={active === undefined ? undefined : active}
      {...rest}
    >
      {icon && <Icon name={icon} size={size === 'sm' ? 12 : 14} />}
      {children != null && <span className="plui-btn__text">{children}</span>}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: IconName;
  /** Required: used as aria-label and native tooltip. */
  label: string;
  size?: 'xs' | 'sm' | 'md';
  variant?: 'default' | 'ghost' | 'danger';
  active?: boolean;
}

export function IconButton({
  icon,
  label,
  size = 'md',
  variant = 'ghost',
  active,
  className,
  type = 'button',
  title,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        'plui-iconbtn',
        `plui-iconbtn--${size}`,
        `plui-iconbtn--${variant}`,
        active && 'is-active',
        className,
      )}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      title={title ?? label}
      {...rest}
    >
      <Icon name={icon} size={size === 'xs' ? 11 : size === 'sm' ? 13 : 15} />
    </button>
  );
}

export type BadgeTone = 'neutral' | 'accent' | 'azure' | 'cyan' | 'warn' | 'ok';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  /** Outline instead of a tinted fill. */
  outline?: boolean;
}

export function Badge({ tone = 'neutral', outline, className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cx(
        'plui-badge',
        `plui-badge--${tone}`,
        outline && 'plui-badge--outline',
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}

export interface ToolbarProps extends HTMLAttributes<HTMLDivElement> {
  'aria-label'?: string;
  children?: ReactNode;
}

/** Row of buttons with roving arrow-key navigation (Left/Right/Home/End). */
export function Toolbar({ className, children, onKeyDown, ...rest }: ToolbarProps) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={ref}
      role="toolbar"
      className={cx('plui-toolbar', className)}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.defaultPrevented) return;
        const t = e.target as HTMLElement;
        // Do not steal arrows from text fields / selects inside the toolbar.
        if (t.matches('input:not([type=checkbox]):not([type=button]), textarea, select')) return;
        const items = Array.from(
          ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [role=tab]') ?? [],
        );
        const i = items.indexOf(t);
        if (i < 0) return;
        let next = -1;
        if (e.key === 'ArrowRight') next = (i + 1) % items.length;
        else if (e.key === 'ArrowLeft') next = (i - 1 + items.length) % items.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = items.length - 1;
        if (next >= 0) {
          e.preventDefault();
          items[next]?.focus();
        }
      }}
      {...rest}
    >
      {children}
    </div>
  );
}

export function ToolbarSeparator() {
  return <hr className="plui-toolbar__sep" aria-orientation="vertical" />;
}

export function ToolbarSpacer() {
  return <span className="plui-toolbar__spacer" />;
}
