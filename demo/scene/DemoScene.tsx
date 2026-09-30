import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import './scene.css';
import {
  ActionButton,
  type BubbleContext,
  type BubbleEntry,
  MusicCard,
  TopicBubble,
} from './bubbles';
import { Choreographer } from './choreography';
import { SCENE_ITEMS, TITLE_CENTER } from './layout';
import { SCENE_TEXT } from './texts';
import type { DemoSceneProps } from './types';

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';

function subscribeReduced(cb: () => void): () => void {
  const mq = window.matchMedia(REDUCED_QUERY);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}

function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReduced,
    () => window.matchMedia(REDUCED_QUERY).matches,
    () => false,
  );
}

/**
 * The UI layer of the reference composition. Presentational + animation only: it knows nothing about
 * the WebGL background and reports what the integrator needs through the `on*` callbacks.
 * Fills its (positioned) parent and scales with it via container query units.
 */
export function DemoScene(props: DemoSceneProps) {
  const { visible = true, className, locale = 'en' } = props;
  const text = SCENE_TEXT[locale];

  const hooks = useRef(props);
  hooks.current = props;

  const reduced = useReducedMotion();
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;

  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(SCENE_ITEMS.filter((i) => i.selected).map((i) => i.id)),
  );

  const rootRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLDivElement | null>(null);
  const entries = useRef(new Map<string, BubbleEntry>());
  const choreo = useRef<Choreographer | null>(null);

  const ctx = useMemo<BubbleContext>(
    () => ({
      hooks,
      register: (id, entry) => {
        if (entry) entries.current.set(id, entry);
        else entries.current.delete(id);
      },
      toggle: (id) =>
        setSelected((prev) => {
          const next = new Set(prev);
          if (!next.delete(id)) next.add(id);
          return next;
        }),
      action: (action, el) => {
        hooks.current.onAction?.(action, el);
        choreo.current?.action(action);
      },
    }),
    [],
  );

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const c = new Choreographer(
      root,
      () => [...entries.current.values()],
      () => hooks.current,
      () => reducedRef.current,
    );
    choreo.current = c;
    c.setVisible(hooks.current.visible ?? true);
    return () => {
      c.dispose();
      choreo.current = null;
    };
  }, []);

  useEffect(() => {
    choreo.current?.setVisible(visible);
  }, [visible]);

  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    return hooks.current.onTitleMount?.(el);
  }, []);

  return (
    <div ref={rootRef} className={className ? `lc-scene ${className}` : 'lc-scene'}>
      <div className="lc-scene-stage">
        <div
          ref={titleRef}
          className="lc-scene-title"
          style={{ left: `${TITLE_CENTER.fx * 100}%`, top: `${TITLE_CENTER.fy * 100}%` }}
        >
          {text.title.map((line) => (
            <span key={line.map((r) => r.text).join('')} className="lc-scene-title-line">
              {line.map((run) =>
                run.hl ? (
                  <span key={run.text} className="lc-scene-title-hl">
                    {run.text}
                  </span>
                ) : (
                  run.text
                ),
              )}
            </span>
          ))}
        </div>
        {SCENE_ITEMS.map((item) => {
          const isSelected = selected.has(item.id);
          const t = text.items[item.id] ?? { label: item.id };
          if (item.kind === 'card') {
            return <MusicCard key={item.id} item={item} text={t} selected={isSelected} ctx={ctx} />;
          }
          const Bubble = item.action ? ActionButton : TopicBubble;
          return <Bubble key={item.id} item={item} text={t} selected={isSelected} ctx={ctx} />;
        })}
      </div>
    </div>
  );
}
