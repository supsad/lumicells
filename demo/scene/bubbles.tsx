import {
  type CSSProperties,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import { Headphones } from './Headphones';
import type { SceneItem } from './layout';
import {
  type BubbleInfo,
  COLOR_BLUE,
  COLOR_RED,
  type DemoSceneProps,
  type SceneAction,
} from './types';

/** What the scene needs to know about a mounted bubble to fly it around. */
export type BubbleEntry = {
  item: SceneItem;
  el: HTMLElement;
  info: () => BubbleInfo;
  resetHover: () => void;
};

export type BubbleContext = {
  /** Always points at the latest props, so callbacks never re-run mount effects. */
  hooks: { current: DemoSceneProps };
  register: (id: string, entry: BubbleEntry | null) => void;
  toggle: (id: string) => void;
  action: (action: SceneAction, el: HTMLElement) => void;
};

type BubbleProps = { item: SceneItem; selected: boolean; ctx: BubbleContext };

function bubbleColor(item: SceneItem, selected: boolean): string {
  switch (item.kind) {
    case 'topic':
    case 'primary':
      return selected ? COLOR_BLUE : COLOR_RED;
    case 'action':
      return COLOR_RED;
    default:
      return COLOR_BLUE;
  }
}

function useBubble(item: SceneItem, selected: boolean, ctx: BubbleContext) {
  const elRef = useRef<HTMLButtonElement | null>(null);
  const hoverRef = useRef(false);
  const info = useMemo<BubbleInfo>(
    () => ({
      id: item.id,
      label: item.label,
      kind: item.kind,
      color: bubbleColor(item, selected),
      selected,
    }),
    [item, selected],
  );
  const infoRef = useRef(info);
  infoRef.current = info;

  const setHover = useCallback(
    (hovering: boolean) => {
      const el = elRef.current;
      if (!el || hoverRef.current === hovering) return;
      hoverRef.current = hovering;
      el.toggleAttribute('data-hover', hovering);
      const next = { ...infoRef.current, hovered: hovering };
      ctx.hooks.current.onBubbleHover?.(el, next, hovering);
      ctx.hooks.current.onBubbleChange?.(el, next);
    },
    [ctx],
  );

  // Registration + user mount hook. The callbacks are read through the ref, so they may change freely.
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    ctx.register(item.id, {
      item,
      el,
      info: () => infoRef.current,
      resetHover: () => setHover(false),
    });
    const cleanup = ctx.hooks.current.onBubbleMount?.(el, infoRef.current);
    return () => {
      ctx.register(item.id, null);
      hoverRef.current = false;
      cleanup?.();
    };
  }, [ctx, item, setHover]);

  // Selection changes are reported after the DOM reflects them (skip the initial value).
  const first = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a selection change should notify
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const el = elRef.current;
    if (el) ctx.hooks.current.onBubbleChange?.(el, infoRef.current);
  }, [selected]);

  const onClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      const el = elRef.current;
      if (!el) return;
      let point = { x: e.clientX, y: e.clientY };
      if (e.detail === 0) {
        // keyboard activation has no pointer position: use the element center
        const r = el.getBoundingClientRect();
        point = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      const toggles = item.kind === 'topic' || item.kind === 'primary';
      const next = toggles
        ? { ...infoRef.current, selected: !infoRef.current.selected }
        : infoRef.current;
      ctx.hooks.current.onBubbleClick?.(el, next, point);
      if (toggles) ctx.toggle(item.id);
      else if (item.action) ctx.action(item.action, el);
    },
    [ctx, item],
  );

  return {
    elRef,
    handlers: {
      onClick,
      onPointerEnter: () => setHover(true),
      onPointerLeave: () => setHover(false),
    },
  };
}

function slotStyle(item: SceneItem): CSSProperties {
  return {
    left: `${item.fx * 100}%`,
    top: `${item.fy * 100}%`,
    '--w': item.w,
    '--h': item.h,
  } as CSSProperties;
}

function Slot({ item, children }: { item: SceneItem; children: ReactNode }) {
  return (
    <div className="lc-scene-slot" style={slotStyle(item)}>
      {children}
    </div>
  );
}

/** Red pill that turns blue when selected. Also renders the blue primary/secondary variants. */
export const TopicBubble = memo(function TopicBubble({ item, selected, ctx }: BubbleProps) {
  const { elRef, handlers } = useBubble(item, selected, ctx);
  const toggles = item.kind === 'topic' || item.kind === 'primary';
  return (
    <Slot item={item}>
      <button
        ref={elRef}
        type="button"
        className="lc-scene-bubble lc-scene-pill"
        data-kind={item.kind}
        data-id={item.id}
        data-selected={selected ? '' : undefined}
        aria-pressed={toggles ? selected : undefined}
        {...handlers}
      >
        <span className="lc-scene-label">{item.label}</span>
        {item.caption ? <span className="lc-scene-caption">{item.caption}</span> : null}
      </button>
    </Slot>
  );
});

/** 'готово' / 'назад': a pill that triggers a scene action instead of toggling. */
export const ActionButton = TopicBubble;

export const MusicCard = memo(function MusicCard({ item, selected, ctx }: BubbleProps) {
  const { elRef, handlers } = useBubble(item, selected, ctx);
  return (
    <Slot item={item}>
      <button
        ref={elRef}
        type="button"
        className="lc-scene-bubble lc-scene-card"
        data-kind="card"
        data-id={item.id}
        aria-label={item.label}
        {...handlers}
      >
        <Headphones className="lc-scene-card-art" />
        <span className="lc-scene-card-tag">{item.label}</span>
      </button>
    </Slot>
  );
});
