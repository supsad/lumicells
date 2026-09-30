import {
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  useId,
  useRef,
  useState,
} from 'react';
import { Badge, IconButton } from './Button';
import { Icon } from './Icon';
import { cx } from './utils';

/* --------------------------------------------------------------- Section */

export interface SectionProps {
  title: ReactNode;
  children?: ReactNode;
  /** Controlled open state. */
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?(open: boolean): void;
  /** Row under the title that stays visible when collapsed (e.g. a mode weight slider). */
  header?: ReactNode;
  /** Small controls at the right of the title row (e.g. a Switch). */
  actions?: ReactNode;
  /** Fades the body, e.g. when the mode weight is 0 (controls stay usable). */
  dimmed?: boolean;
  /** Adds the "advanced" badge. */
  advanced?: boolean;
  /** Extra badge after the title. */
  badge?: ReactNode;
  /** Nested sections get a lighter look. */
  level?: 1 | 2;
  id?: string;
  className?: string;
}

/** Collapsible group of controls. The body stays mounted while collapsed (state is kept). */
export function Section({
  title,
  children,
  open: openProp,
  defaultOpen = true,
  onOpenChange,
  header,
  actions,
  dimmed,
  advanced,
  badge,
  level = 1,
  id,
  className,
}: SectionProps) {
  const uid = useId();
  const bodyId = id ? `${id}-body` : `${uid}-body`;
  const [inner, setInner] = useState(defaultOpen);
  const open = openProp ?? inner;
  const toggle = () => {
    const next = !open;
    if (openProp === undefined) setInner(next);
    onOpenChange?.(next);
  };
  return (
    <section
      id={id}
      className={cx('lcui-section', `lcui-section--l${level}`, className)}
      data-open={open}
      data-dimmed={dimmed || undefined}
    >
      <div className="lcui-section__head">
        <button
          type="button"
          className="lcui-section__toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={toggle}
        >
          <Icon name="chevron" size={12} className="lcui-section__chev" />
          <span className="lcui-section__title">{title}</span>
          {advanced && (
            <Badge tone="neutral" outline title="Расширенные настройки">
              доп.
            </Badge>
          )}
          {badge}
        </button>
        {actions && <div className="lcui-section__actions">{actions}</div>}
      </div>
      {header && <div className="lcui-section__slot">{header}</div>}
      <div className="lcui-section__body" id={bodyId} hidden={!open}>
        {children}
      </div>
    </section>
  );
}

/* ----------------------------------------------------------- SearchInput */

export interface SearchInputProps {
  value: string;
  onChange(value: string): void;
  placeholder?: string;
  /** Optional result counter shown at the right. */
  count?: number;
  className?: string;
  'aria-label'?: string;
}

export function SearchInput({
  value,
  onChange,
  placeholder = 'Поиск параметра…',
  count,
  className,
  'aria-label': ariaLabel = 'Поиск параметра',
}: SearchInputProps) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className={cx('lcui-search', className)}>
      <Icon name="search" size={13} className="lcui-search__icon" />
      <input
        ref={ref}
        type="search"
        className="lcui-search__input"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.preventDefault();
            onChange('');
          }
        }}
      />
      {count !== undefined && value && <span className="lcui-search__count">{count}</span>}
      {value && (
        <IconButton
          icon="close"
          label="Очистить поиск"
          size="xs"
          onClick={() => {
            onChange('');
            ref.current?.focus();
          }}
        />
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- Panel */

export interface PanelProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Buttons at the right of the header (left of the collapse button). */
  headerActions?: ReactNode;
  /** Search / filter row under the header (see `SearchInput`). */
  search?: ReactNode;
  /** Sticky area at the bottom. */
  footer?: ReactNode;
  children?: ReactNode;
  collapsed?: boolean;
  defaultCollapsed?: boolean;
  onCollapsedChange?(collapsed: boolean): void;
  /** Edge the panel is docked to: decides the collapse arrow direction. */
  side?: 'left' | 'right';
  /** Expanded width (CSS length or px). */
  width?: number | string;
  className?: string;
  style?: CSSProperties;
  'aria-label'?: string;
}

/**
 * Glassy side-panel shell: header, search slot, scrolling body, footer, collapse button.
 * It fills its positioned container's height; place it with your own CSS.
 */
export function Panel({
  title,
  subtitle,
  headerActions,
  search,
  footer,
  children,
  collapsed: collapsedProp,
  defaultCollapsed = false,
  onCollapsedChange,
  side = 'right',
  width = 340,
  className,
  style,
  'aria-label': ariaLabel,
}: PanelProps) {
  const [inner, setInner] = useState(defaultCollapsed);
  const collapsed = collapsedProp ?? inner;
  const setCollapsed = (v: boolean) => {
    if (collapsedProp === undefined) setInner(v);
    onCollapsedChange?.(v);
  };
  const titleText = typeof title === 'string' ? title : 'Панель';
  const arrow = collapsed === (side === 'right') ? 'chevron-left' : 'chevron-right';
  return (
    <aside
      className={cx('lcui-panel', `lcui-panel--${side}`, collapsed && 'is-collapsed', className)}
      style={{
        ['--lcui-panel-w' as string]: typeof width === 'number' ? `${width}px` : width,
        ...style,
      }}
      aria-label={ariaLabel ?? titleText}
    >
      <header className="lcui-panel__head">
        {!collapsed && (
          <div className="lcui-panel__titles">
            {title && <h2 className="lcui-panel__title">{title}</h2>}
            {subtitle && <div className="lcui-panel__subtitle">{subtitle}</div>}
          </div>
        )}
        {collapsed && title && <span className="lcui-panel__rail-title">{title}</span>}
        {!collapsed && headerActions && <div className="lcui-panel__actions">{headerActions}</div>}
        <IconButton
          icon={arrow}
          label={collapsed ? 'Развернуть панель' : 'Свернуть панель'}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
        />
      </header>
      <div className="lcui-panel__content" hidden={collapsed}>
        {search && <div className="lcui-panel__search">{search}</div>}
        <div className="lcui-panel__body">{children}</div>
        {footer && <footer className="lcui-panel__foot">{footer}</footer>}
      </div>
    </aside>
  );
}

/* -------------------------------------------------------------- Helpers */

export interface GridProps extends HTMLAttributes<HTMLDivElement> {
  /** Equal columns (default 3) — handy for stacked `Knob`s. */
  columns?: number;
}

export function Grid({ columns = 3, className, style, children, ...rest }: GridProps) {
  return (
    <div
      className={cx('lcui-grid', className)}
      style={{ ['--lcui-cols' as string]: columns, ...style }}
      {...rest}
    >
      {children}
    </div>
  );
}

export function Divider({ className }: { className?: string }) {
  return <hr className={cx('lcui-divider', className)} />;
}

export interface ReadoutProps {
  label: ReactNode;
  value: ReactNode;
  /** Colors the value: default, warn (magenta) or ok (cyan). */
  tone?: 'default' | 'warn' | 'ok';
  className?: string;
}

/** Label / monospace value row for stats. */
export function Readout({ label, value, tone = 'default', className }: ReadoutProps) {
  return (
    <div className={cx('lcui-readout', `lcui-readout--${tone}`, className)}>
      <span className="lcui-readout__label">{label}</span>
      <span className="lcui-readout__value">{value}</span>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="lcui-empty">{children}</div>;
}
