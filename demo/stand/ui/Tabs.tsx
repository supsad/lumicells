import { createContext, type ReactNode, useContext, useId, useMemo } from 'react';
import { Icon, type IconName } from './Icon';
import { cx } from './utils';

export interface TabItem {
  id: string;
  label: ReactNode;
  icon?: IconName;
  /** Small counter / marker after the label. */
  badge?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  items: readonly TabItem[];
  value: string;
  onChange(id: string): void;
  /** `TabPanel` children (optional; the strip works alone too). */
  children?: ReactNode;
  variant?: 'underline' | 'pills';
  /** Tabs share the row equally. */
  fill?: boolean;
  className?: string;
  'aria-label'?: string;
}

interface TabsCtx {
  base: string;
  value: string;
}
const Ctx = createContext<TabsCtx | null>(null);

export function Tabs({
  items,
  value,
  onChange,
  children,
  variant = 'underline',
  fill,
  className,
  'aria-label': ariaLabel,
}: TabsProps) {
  const base = useId();
  const ctx = useMemo(() => ({ base, value }), [base, value]);

  const focusTab = (dir: 1 | -1 | 'first' | 'last', from: number) => {
    const n = items.length;
    const enabled = (i: number) => !items[i]?.disabled;
    let i = from;
    if (dir === 'first') i = -1;
    if (dir === 'last') i = n;
    const step = dir === 'last' ? -1 : dir === 'first' ? 1 : dir;
    for (let k = 0; k < n; k++) {
      i = (i + step + n) % n;
      if (enabled(i)) break;
    }
    const it = items[i];
    if (it) {
      onChange(it.id);
      document.getElementById(`${base}-tab-${it.id}`)?.focus();
    }
  };

  return (
    <Ctx.Provider value={ctx}>
      <div
        className={cx('plui-tabs', `plui-tabs--${variant}`, fill && 'plui-tabs--fill', className)}
      >
        <div className="plui-tabs__list" role="tablist" aria-label={ariaLabel}>
          {items.map((it, i) => {
            const selected = it.id === value;
            return (
              <button
                key={it.id}
                type="button"
                role="tab"
                id={`${base}-tab-${it.id}`}
                aria-selected={selected}
                aria-controls={`${base}-panel-${it.id}`}
                tabIndex={selected ? 0 : -1}
                disabled={it.disabled}
                className={cx('plui-tab', selected && 'is-selected')}
                onClick={() => onChange(it.id)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowRight') focusTab(1, i);
                  else if (e.key === 'ArrowLeft') focusTab(-1, i);
                  else if (e.key === 'Home') focusTab('first', i);
                  else if (e.key === 'End') focusTab('last', i);
                  else return;
                  e.preventDefault();
                }}
              >
                {it.icon && <Icon name={it.icon} size={12} />}
                <span>{it.label}</span>
                {it.badge != null && <span className="plui-tab__badge">{it.badge}</span>}
              </button>
            );
          })}
        </div>
        {children}
      </div>
    </Ctx.Provider>
  );
}

export interface TabPanelProps {
  value: string;
  children?: ReactNode;
  className?: string;
  /** Keep the panel mounted (hidden) when inactive. */
  keepMounted?: boolean;
}

export function TabPanel({ value, children, className, keepMounted }: TabPanelProps) {
  const ctx = useContext(Ctx);
  const active = ctx?.value === value;
  if (!active && !keepMounted) return null;
  return (
    <div
      role="tabpanel"
      id={ctx ? `${ctx.base}-panel-${value}` : undefined}
      aria-labelledby={ctx ? `${ctx.base}-tab-${value}` : undefined}
      hidden={!active}
      className={cx('plui-tabpanel', className)}
    >
      {children}
    </div>
  );
}
