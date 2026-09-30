/**
 * The stage: a frame of the chosen size holding <LumiCells> and, above it, the demo scene.
 * The frame keeps the same React element across size modes, so switching sizes only resizes the
 * host (the instance is never re-created).
 */

import type { LumiCellsConfig, LumiCells as LumiCellsInstance } from 'lumicells';
import { LumiCells } from 'lumicells/react';
import { type PointerEvent as ReactPointerEvent, useRef, useState } from 'react';
import { useT } from './i18n';
import { frameSize, MAX_STAGE, MIN_STAGE, type Prefs } from './prefs';
import { type SceneBinder, SceneLayer } from './scene-binding';
import { useSelector, useStore } from './store';
import { Button, IconButton } from './ui';

interface StageProps {
  cfg: LumiCellsConfig;
  transition: number;
  prefs: Prefs;
  binder: SceneBinder;
  onInstance(instance: LumiCellsInstance | null): void;
  onResize(w: number, h: number): void;
  onError(error: Error): void;
}

const clampDim = (v: number) => Math.min(MAX_STAGE, Math.max(MIN_STAGE, Math.round(v)));

export function Stage({
  cfg,
  transition,
  prefs,
  binder,
  onInstance,
  onResize,
  onError,
}: StageProps) {
  const store = useStore();
  const t = useT();
  const size = frameSize(prefs);
  const overflow = useSelector((s) => s.cfg.render.overflow);
  const [hintDismissed, setHintDismissed] = useState(false);
  const drag = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);

  const showHint = prefs.size === 'card' && overflow === 0 && !hintDismissed;

  const onHandleDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, w: rect.width, h: rect.height };
  };
  const onHandleMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    // The frame is centered, so it grows on both sides: the handle moves half the size delta.
    onResize(clampDim(d.w + (e.clientX - d.x) * 2), clampDim(d.h + (e.clientY - d.y) * 2));
  };
  const onHandleUp = () => {
    drag.current = null;
  };

  return (
    <div className="stand-stage" data-size={prefs.size}>
      <div className="stand-stage__scroll">
        <div
          ref={frameRef}
          className="stand-frame"
          data-fullscreen={size ? undefined : ''}
          style={size ? { width: size.w, height: size.h } : undefined}
        >
          <LumiCells
            ref={onInstance}
            className="stand-host"
            config={cfg}
            transition={transition}
            onError={onError}
          >
            {prefs.scene && <SceneLayer binder={binder} />}
          </LumiCells>
          {size && (
            <>
              <span className="stand-frame__size" aria-hidden="true">
                {size.w} × {size.h}
              </span>
              {/* biome-ignore lint/a11y/useSemanticElements: a drag handle, not a thematic break */}
              <div
                className="stand-frame__handle"
                role="separator"
                aria-label={t.stage.resizeAria}
                title={t.stage.resizeTitle}
                onPointerDown={onHandleDown}
                onPointerMove={onHandleMove}
                onPointerUp={onHandleUp}
                onPointerCancel={onHandleUp}
              />
            </>
          )}
        </div>
      </div>
      {showHint && (
        <div className="stand-hint" role="note">
          <span>
            {t.stage.overflowBefore}
            <code>render.overflow</code>
            {t.stage.overflowAfter}
          </span>
          <Button
            size="sm"
            variant="primary"
            onClick={() =>
              store.setMany(
                [
                  ['render.overflow', 80],
                  ['lift.style', 'float'],
                ],
                { discrete: true },
              )
            }
          >
            {t.stage.enable}
          </Button>
          <IconButton
            icon="close"
            label={t.stage.hideHint}
            size="xs"
            onClick={() => setHintDismissed(true)}
          />
        </div>
      )}
    </div>
  );
}
