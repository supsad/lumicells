import { type Ref, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { useT } from '../i18n';
import { cx } from './utils';

export const STATS_GRAPH_CAPACITY = 240;

export interface StatsGraphHandle {
  /** Appends a sample; O(1), no React state, drawing is coalesced into one rAF. */
  push(value: number): void;
  clear(): void;
}

export interface StatsGraphProps {
  ref?: Ref<StatsGraphHandle>;
  label: string;
  unit?: string;
  /** Fixed axis bounds; when omitted the axis auto-fits the buffer (min clamped to 0). */
  min?: number;
  max?: number;
  /** Horizontal reference lines, e.g. the frame budget. */
  guides?: readonly number[];
  /** Values above this are drawn in the warning color. */
  warnAbove?: number;
  decimals?: number;
  height?: number;
  /** CSS color overriding the accent (defaults to --lcui-azure). */
  color?: string;
  className?: string;
}

interface Palette {
  line: string;
  fillTop: string;
  warn: string;
  guide: string;
}

function readPalette(el: HTMLElement, color: string | undefined): Palette {
  const cs = getComputedStyle(el);
  const v = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb;
  const line = color ?? v('--lcui-azure', '#0476ff');
  return {
    line,
    fillTop: color ?? v('--lcui-azure', '#0476ff'),
    warn: v('--lcui-accent', '#f21239'),
    guide: v('--lcui-border-strong', 'rgba(255,255,255,0.25)'),
  };
}

/**
 * Canvas2D sparkline over a ring buffer of 240 samples. Samples arrive through the
 * imperative `push`, so per-frame stats never re-render React.
 */
export function StatsGraph({
  ref,
  label,
  unit,
  min,
  max,
  guides,
  warnAbove,
  decimals = 1,
  height = 44,
  color,
  className,
}: StatsGraphProps) {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const valueEl = useRef<HTMLSpanElement>(null);
  const rangeEl = useRef<HTMLSpanElement>(null);
  const t = useT();
  // Read by the imperative draw loop, which must not capture a stale locale.
  const tRef = useRef(t);
  tRef.current = t;

  // Everything mutable lives in one ref object to keep push() allocation-free.
  const st = useRef({
    buf: new Float32Array(STATS_GRAPH_CAPACITY),
    head: 0,
    count: 0,
    raf: 0,
    w: 0,
    h: 0,
    dpr: 1,
    palette: null as Palette | null,
    props: { min, max, guides, warnAbove, decimals, color },
    lastText: '',
    lastRange: '',
  });
  st.current.props = { min, max, guides, warnAbove, decimals, color };
  const guidesKey = guides?.join(',');

  const draw = useRef(() => {});
  draw.current = () => {
    const s = st.current;
    s.raf = 0;
    const cv = canvas.current;
    const ctx = cv?.getContext('2d');
    if (!cv || !ctx || !root.current || s.w === 0) return;
    const p = s.props;
    s.palette ??= readPalette(root.current, p.color);
    const pal = s.palette;
    const n = s.count;
    const { w, h } = s;
    ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Range (one pass over the buffer)
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    let sum = 0;
    const start = (s.head - n + STATS_GRAPH_CAPACITY) % STATS_GRAPH_CAPACITY;
    for (let i = 0; i < n; i++) {
      const v = s.buf[(start + i) % STATS_GRAPH_CAPACITY] as number;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      sum += v;
    }
    const last = n
      ? (s.buf[(s.head - 1 + STATS_GRAPH_CAPACITY) % STATS_GRAPH_CAPACITY] as number)
      : 0;
    const axMin = p.min ?? Math.min(0, n ? lo : 0);
    let axMax = p.max ?? (n ? hi : 1);
    if (axMax - axMin < 1e-6) axMax = axMin + 1;
    if (p.max === undefined) axMax += (axMax - axMin) * 0.1;
    const pad = 3;
    const yOf = (v: number) => h - pad - ((v - axMin) / (axMax - axMin)) * (h - pad * 2);

    if (p.guides) {
      ctx.strokeStyle = pal.guide;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      for (const g of p.guides) {
        if (g < axMin || g > axMax) continue;
        const y = Math.round(yOf(g)) + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (n > 1) {
      const dx = w / (STATS_GRAPH_CAPACITY - 1);
      const x0 = w - (n - 1) * dx;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const v = s.buf[(start + i) % STATS_GRAPH_CAPACITY] as number;
        const x = x0 + i * dx;
        const y = yOf(v);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      // Fill under the line with a fade
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, pal.fillTop);
      g.addColorStop(1, 'transparent');
      ctx.save();
      ctx.lineTo(w, h);
      ctx.lineTo(x0, h);
      ctx.closePath();
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = g;
      ctx.fill();
      ctx.restore();

      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const v = s.buf[(start + i) % STATS_GRAPH_CAPACITY] as number;
        const x = x0 + i * dx;
        const y = yOf(v);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.lineWidth = 1.4;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = p.warnAbove !== undefined && last > p.warnAbove ? pal.warn : pal.line;
      ctx.stroke();
    }

    // Text readouts are written straight to the DOM (no React render per sample).
    const dec = p.decimals ?? 1;
    const text = n ? last.toFixed(dec) : '—';
    if (valueEl.current && s.lastText !== text) {
      s.lastText = text;
      valueEl.current.textContent = text;
      valueEl.current.dataset.warn = p.warnAbove !== undefined && last > p.warnAbove ? '1' : '0';
    }
    if (rangeEl.current) {
      const range = n
        ? tRef.current.ui.graphSummary(lo.toFixed(dec), (sum / n).toFixed(dec), hi.toFixed(dec))
        : '';
      // Assigning textContent replaces the text node even for an equal string: write on change only.
      if (s.lastRange !== range) {
        s.lastRange = range;
        rangeEl.current.textContent = range;
      }
    }
  };

  const schedule = useCallback(() => {
    const s = st.current;
    if (!s.raf) s.raf = requestAnimationFrame(() => draw.current());
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      push(value: number) {
        const s = st.current;
        s.buf[s.head] = value;
        s.head = (s.head + 1) % STATS_GRAPH_CAPACITY;
        if (s.count < STATS_GRAPH_CAPACITY) s.count++;
        schedule();
      },
      clear() {
        const s = st.current;
        s.head = 0;
        s.count = 0;
        s.lastText = '';
        s.lastRange = '';
        schedule();
      },
    }),
    [schedule],
  );

  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const s = st.current;
    const resize = () => {
      const r = cv.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      s.w = r.width;
      s.h = r.height;
      s.dpr = dpr;
      cv.width = Math.max(1, Math.round(r.width * dpr));
      cv.height = Math.max(1, Math.round(r.height * dpr));
      s.palette = null;
      schedule();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(cv);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(s.raf);
      s.raf = 0;
    };
  }, [schedule]);

  // Axis / style props changed: redraw once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: props are read via st.current
  useEffect(() => {
    st.current.palette = null;
    schedule();
  }, [min, max, warnAbove, decimals, color, guidesKey, schedule]);

  return (
    <div ref={root} className={cx('lcui-stats', className)}>
      <div className="lcui-stats__head">
        <span className="lcui-stats__label">{label}</span>
        <span className="lcui-stats__value">
          <span ref={valueEl}>—</span>
          {unit && <span className="lcui-stats__unit">{unit}</span>}
        </span>
      </div>
      <canvas
        ref={canvas}
        className="lcui-stats__canvas"
        style={{ height }}
        role="img"
        aria-label={t.ui.graphAria(label)}
      />
      <span ref={rangeEl} className="lcui-stats__range" />
    </div>
  );
}
