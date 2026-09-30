import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { type BubbleInfo, DemoScene } from './index';
import './preview.css';

const MAX_LOG = 7;

// ?size=345 renders the frame at the reference resolution for a pixel-level comparison
const sizeParam = Number(new URLSearchParams(window.location.search).get('size'));
const frameSize = Number.isFinite(sizeParam) && sizeParam >= 100 ? sizeParam : 690;

/** Static CSS stand-in for the WebGL background, only to judge the scene against the reference. */
function StaticBackground({ grid }: { grid: boolean }) {
  return (
    <div className="lc-preview-bg">
      <div className="lc-preview-art" />
      {grid ? <div className="lc-preview-grid" /> : null}
    </div>
  );
}

function Preview() {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [full, setFull] = useState(false);
  const [visible, setVisible] = useState(true);
  const [grid, setGrid] = useState(true);
  const [log, setLog] = useState<string[]>([]);
  const [mounted, setMounted] = useState(0);

  const push = useCallback((line: string) => {
    setLog((prev) => [line, ...prev].slice(0, MAX_LOG));
  }, []);

  const toggleFull = useCallback(() => {
    if (full) {
      setFull(false);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    } else {
      setFull(true);
      // CSS fixed mode (is-full) is the fallback when the Fullscreen API is refused
      frameRef.current?.requestFullscreen?.().catch(() => {});
    }
  }, [full]);

  useEffect(() => {
    const onFs = () => {
      if (!document.fullscreenElement) setFull(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFull(false);
    };
    document.addEventListener('fullscreenchange', onFs);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('fullscreenchange', onFs);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const label = (i: BubbleInfo) => `${i.label}${i.selected ? ' (выбрано)' : ''}`;

  return (
    <div className="lc-preview">
      <div className="lc-preview-bar">
        <button type="button" onClick={toggleFull}>
          {full ? 'Выйти из полного экрана' : 'Полный экран'}
        </button>
        <button type="button" onClick={() => setVisible((v) => !v)}>
          {visible ? 'Скрыть (exit)' : 'Показать (enter)'}
        </button>
        <label>
          <input type="checkbox" checked={grid} onChange={(e) => setGrid(e.target.checked)} /> сетка
        </label>
        <span className="lc-preview-count">bubbles mounted: {mounted}</span>
      </div>
      <div
        ref={frameRef}
        className={full ? 'lc-preview-frame is-full' : 'lc-preview-frame'}
        style={full ? undefined : { width: frameSize, height: frameSize }}
      >
        <StaticBackground grid={grid} />
        <DemoScene
          visible={visible}
          onBubbleMount={() => {
            setMounted((n) => n + 1);
            return () => setMounted((n) => n - 1);
          }}
          onBubbleClick={(_el, info, p) =>
            push(`click ${label(info)} @ ${Math.round(p.x)},${Math.round(p.y)}`)
          }
          onBubbleHover={(_el, info, hovering) => {
            if (hovering) push(`hover ${info.label} ${info.color}`);
          }}
          onAction={(action) => push(`action ${action}`)}
          onFlight={(_el, info, phase) => {
            if (info.kind === 'card' || info.id === 'done') push(`flight ${info.label} ${phase}`);
          }}
        />
        {full ? (
          <button type="button" className="lc-preview-exit" onClick={toggleFull}>
            Esc
          </button>
        ) : null}
      </div>
      <ul className="lc-preview-log">
        {log.map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: append-only debug log
          <li key={`${i}-${l}`}>{l}</li>
        ))}
      </ul>
    </div>
  );
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <Preview />
    </StrictMode>,
  );
}
