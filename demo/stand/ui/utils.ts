import { useCallback, useEffect, useRef, useState } from 'react';

/** Joins truthy class names; every component root starts with a `plui-` class. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  let out = '';
  for (const p of parts) if (p) out += out ? ` ${p}` : p;
  return out;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export type SliderScale = 'linear' | 'log';

/** Log scale needs a positive lower bound; otherwise fall back to linear. */
export function effectiveScale(scale: SliderScale | undefined, min: number): SliderScale {
  return scale === 'log' && min > 0 ? 'log' : 'linear';
}

export function valueToNorm(v: number, min: number, max: number, scale: SliderScale): number {
  if (max === min) return 0;
  const x = clamp(v, min, max);
  if (scale === 'log') return Math.log(x / min) / Math.log(max / min);
  return (x - min) / (max - min);
}

export function normToValue(n: number, min: number, max: number, scale: SliderScale): number {
  const t = clamp(n, 0, 1);
  if (scale === 'log') return min * (max / min) ** t;
  return min + (max - min) * t;
}

/** Number of decimals needed to display multiples of `step` exactly. */
export function decimalsOf(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 3;
  const s = step.toString();
  if (s.includes('e-')) return Number.parseInt(s.split('e-')[1] ?? '0', 10);
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

/** Sensible display step when the caller gave none. */
export function autoStep(min: number, max: number): number {
  const span = Math.abs(max - min);
  if (span <= 0) return 1;
  const raw = span / 1000;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * mag;
}

/** Snaps to `step` measured from `min`, trimming float noise. */
export function snapToStep(v: number, min: number, step: number): number {
  if (!(step > 0)) return v;
  const snapped = min + Math.round((v - min) / step) * step;
  return Number(snapped.toFixed(Math.min(10, decimalsOf(step) + 1)));
}

export function formatValue(v: number, decimals: number, trim = false): string {
  if (!Number.isFinite(v)) return '—';
  let fixed = v.toFixed(decimals);
  if (trim && fixed.includes('.')) fixed = fixed.replace(/\.?0+$/, '');
  // Avoid "-0.00"
  return /^-0(\.0*)?$/.test(fixed) ? fixed.slice(1) : fixed;
}

export function parseNumber(text: string): number | null {
  const t = text.trim().replace(',', '.').replace(/\s+/g, '');
  if (t === '' || t === '-' || t === '.') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function wrapAngle(deg: number, min = 0, max = 360): number {
  const span = max - min;
  if (span <= 0) return min;
  return ((((deg - min) % span) + span) % span) + min;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Boolean that flips back to false after `ms` (for "copied" feedback). */
export function useFlash(ms = 1200): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const flash = useCallback(() => {
    setOn(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOn(false), ms);
  }, [ms]);
  return [on, flash];
}

/** Keeps the latest value in a ref so stable callbacks can read it. */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

export interface DragInfo {
  /** Pointer position relative to the element the drag started on. */
  x: number;
  y: number;
  /** Movement since the previous event. */
  dx: number;
  dy: number;
  /** Movement since pointer down. */
  totalDx: number;
  totalDy: number;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  rect: DOMRect;
  clientX: number;
  clientY: number;
}

export interface DragHandlers {
  onStart?(info: DragInfo): void;
  onMove(info: DragInfo): void;
  onEnd?(info: DragInfo): void;
}

interface DragState {
  id: number;
  x0: number;
  y0: number;
  lx: number;
  ly: number;
}

function dragInfo(s: DragState, e: React.PointerEvent<HTMLElement>): DragInfo {
  const rect = e.currentTarget.getBoundingClientRect();
  const info: DragInfo = {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
    dx: e.clientX - s.lx,
    dy: e.clientY - s.ly,
    totalDx: e.clientX - s.x0,
    totalDy: e.clientY - s.y0,
    shiftKey: e.shiftKey,
    altKey: e.altKey,
    ctrlKey: e.ctrlKey,
    rect,
    clientX: e.clientX,
    clientY: e.clientY,
  };
  s.lx = e.clientX;
  s.ly = e.clientY;
  return info;
}

/**
 * Pointer-capture drag helper. Returns props to spread on the drag surface.
 * Handlers are read through a ref so the returned callbacks are stable.
 */
export function usePointerDrag(handlers: DragHandlers, enabled = true) {
  const h = useLatest(handlers);
  const state = useRef<DragState | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || state.current) return;
      state.current = {
        id: e.pointerId,
        x0: e.clientX,
        y0: e.clientY,
        lx: e.clientX,
        ly: e.clientY,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
      h.current.onStart?.(dragInfo(state.current, e));
    },
    [h],
  );
  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const s = state.current;
      if (!s || s.id !== e.pointerId) return;
      h.current.onMove(dragInfo(s, e));
    },
    [h],
  );
  const end = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const s = state.current;
      if (!s || s.id !== e.pointerId) return;
      const info = dragInfo(s, e);
      state.current = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      h.current.onEnd?.(info);
    },
    [h],
  );

  if (!enabled) return {};
  return { onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end };
}

/** Non-passive wheel listener (React's onWheel is passive, so it cannot preventDefault). */
export function useWheel(
  ref: React.RefObject<HTMLElement | null>,
  fn: (e: WheelEvent) => void,
  enabled = true,
) {
  const latest = useLatest(fn);
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const onWheel = (e: WheelEvent) => latest.current(e);
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [ref, latest, enabled]);
}

export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = list.slice();
  const [it] = out.splice(from, 1);
  if (it === undefined) return out;
  out.splice(to, 0, it);
  return out;
}
