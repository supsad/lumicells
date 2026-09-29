import { type KeyboardEvent, type ReactNode, useId, useRef } from 'react';
import { Field, type FieldBaseProps, ModulatedBadge } from './Field';
import { NumberInput } from './NumberInput';
import {
  autoStep,
  clamp,
  cx,
  decimalsOf,
  effectiveScale,
  formatValue,
  normToValue,
  type SliderScale,
  snapToStep,
  useLatest,
  usePointerDrag,
  useWheel,
  valueToNorm,
} from './utils';

export interface NumericControlProps extends FieldBaseProps {
  value: number;
  onChange(value: number): void;
  min: number;
  max: number;
  /** Snap step. For log sliders without a step the value keeps 3 significant digits. */
  step?: number;
  scale?: SliderScale;
  unit?: string;
  /** Default value: enables reset (button and double-click on the label) and shows a tick. */
  default?: number;
  /** Value after animation modulation. Shows the "modulated" badge and a marker. */
  effective?: number;
  /** Display decimals; derived from `step` when omitted. */
  decimals?: number;
}

function useNumeric(p: NumericControlProps) {
  const { min, max } = p;
  const scale = effectiveScale(p.scale, min);
  const step = p.step ?? (scale === 'log' ? undefined : autoStep(min, max));
  const decimals = p.decimals ?? (step ? decimalsOf(step) : max >= 100 ? 0 : max >= 10 ? 1 : 2);
  const finalize = (v: number) => {
    if (step) return clamp(snapToStep(v, min, step), min, max);
    return clamp(Number(v.toPrecision(3)), min, max);
  };
  const toNorm = (v: number) => valueToNorm(v, min, max, scale);
  const fromNorm = (n: number) => finalize(normToValue(n, min, max, scale));

  /** One notch up/down. `mult` scales it; linear moves by steps, log by norm fractions. */
  const nudge = (value: number, dir: 1 | -1, mult = 1) => {
    if (scale === 'log') {
      const next = fromNorm(toNorm(value) + dir * 0.01 * mult);
      // Coarse snapping can swallow a small nudge; force at least a visible move.
      return next === value ? finalize(value + dir * (step ?? value * 0.01)) : next;
    }
    return clamp(snapToStep(value + dir * (step ?? 1) * mult, min, step ?? 1), min, max);
  };

  const onKey = (e: KeyboardEvent, value: number, apply: (v: number) => void) => {
    const mult = e.shiftKey ? 10 : 1;
    let v: number | null = null;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        v = nudge(value, 1, mult);
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        v = nudge(value, -1, mult);
        break;
      case 'PageUp':
        v = nudge(value, 1, 10);
        break;
      case 'PageDown':
        v = nudge(value, -1, 10);
        break;
      case 'Home':
        v = min;
        break;
      case 'End':
        v = max;
        break;
      default:
        return;
    }
    e.preventDefault();
    if (v !== value) apply(v);
  };

  const changed = p.default !== undefined && Math.abs(p.value - p.default) > 1e-9;
  const valueText = `${formatValue(p.value, decimals)}${p.unit ? ` ${p.unit}` : ''}`;
  return { scale, step, decimals, finalize, toNorm, fromNorm, nudge, onKey, changed, valueText };
}

export interface SliderProps extends NumericControlProps {
  id?: string;
}

/**
 * Horizontal slider with an exact-value input. Drag on the track; hold Shift for
 * 10x finer drag; arrows / PageUp / PageDown / Home / End from the keyboard.
 */
export function Slider(props: SliderProps) {
  const { value, onChange, min, max, unit, disabled, effective, default: def } = props;
  const uid = useId();
  const num = useNumeric(props);
  const norm = num.toNorm(value);
  const latest = useLatest({ value, norm, onChange, num });
  const d = useRef({ fine: false, x0: 0, n0: 0 });

  const apply = (n: number) => {
    const c = latest.current;
    const v = c.num.fromNorm(n);
    if (v !== c.value) c.onChange(v);
  };

  const drag = usePointerDrag(
    {
      onStart(i) {
        d.current = { fine: i.shiftKey, x0: i.clientX, n0: latest.current.norm };
        if (!i.shiftKey) apply(i.x / i.rect.width);
      },
      onMove(i) {
        const s = d.current;
        // Toggling Shift mid-drag re-anchors, so the thumb never jumps.
        if (i.shiftKey !== s.fine) {
          s.fine = i.shiftKey;
          s.x0 = i.clientX;
          s.n0 = latest.current.norm;
        }
        apply(s.fine ? s.n0 + ((i.clientX - s.x0) / i.rect.width) * 0.1 : i.x / i.rect.width);
      },
    },
    !disabled,
  );

  const modulated = effective !== undefined && Math.abs(effective - value) > 1e-6;
  const effNorm = effective !== undefined ? num.toNorm(effective) : 0;
  const reset = def !== undefined ? () => onChange(def) : undefined;

  return (
    <Field
      {...props}
      className={cx('plui-slider', props.className)}
      htmlFor={`${uid}-n`}
      labelId={`${uid}-l`}
      changed={num.changed}
      onReset={reset}
      badge={
        modulated && effective !== undefined ? (
          <ModulatedBadge effective={effective} decimals={num.decimals} />
        ) : undefined
      }
    >
      <div
        className="plui-slider__track"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-labelledby={`${uid}-l`}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={num.valueText}
        aria-disabled={disabled || undefined}
        onKeyDown={(e) => !disabled && num.onKey(e, value, onChange)}
        {...drag}
        style={{ ['--plui-p' as string]: norm }}
      >
        <div className="plui-slider__rail" />
        {modulated && (
          <div
            className="plui-slider__mod"
            style={{
              left: `${Math.min(norm, effNorm) * 100}%`,
              width: `${Math.abs(effNorm - norm) * 100}%`,
            }}
          />
        )}
        <div className="plui-slider__fill" />
        {def !== undefined && (
          <div className="plui-slider__default" style={{ left: `${num.toNorm(def) * 100}%` }} />
        )}
        {modulated && (
          <div
            className="plui-slider__eff"
            style={{ left: `${effNorm * 100}%` }}
            title={`Эффективное значение: ${effective?.toFixed(num.decimals)}`}
          />
        )}
        <div className="plui-slider__thumb" />
      </div>
      <NumberInput
        id={`${uid}-n`}
        value={value}
        onCommit={onChange}
        min={min}
        max={max}
        step={num.step ?? Math.max(1e-3, value * 0.01)}
        decimals={num.decimals}
        unit={unit}
        disabled={disabled}
      />
    </Field>
  );
}

/* ------------------------------------------------------------------ Knob */

export interface KnobProps extends NumericControlProps {
  /** `row`: label, then knob + number on one line. `stack`: compact cell for grids. */
  layout?: 'row' | 'stack';
  /** Diameter in px (default 28). */
  size?: number;
}

const SWEEP = 135; // degrees each side of straight up

function polar(r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [16 + r * Math.sin(a), 16 - r * Math.cos(a)];
}

function arc(r: number, from: number, to: number): string {
  const [x0, y0] = polar(r, from);
  const [x1, y1] = polar(r, to);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/**
 * Rotary knob. Drag vertically (Shift for fine), mouse wheel while focused,
 * arrow keys, double-click to reset.
 */
export function Knob(props: KnobProps) {
  const {
    value,
    onChange,
    min,
    max,
    unit,
    disabled,
    effective,
    default: def,
    layout = 'row',
    size = 28,
  } = props;
  const uid = useId();
  const num = useNumeric(props);
  const norm = num.toNorm(value);
  const ref = useRef<HTMLDivElement>(null);
  const latest = useLatest({ value, norm, onChange, num });
  const k = useRef(0);

  const apply = (n: number) => {
    const c = latest.current;
    const v = c.num.fromNorm(n);
    if (v !== c.value) c.onChange(v);
  };

  const drag = usePointerDrag(
    {
      onStart() {
        k.current = latest.current.norm;
        ref.current?.focus({ preventScroll: true });
      },
      onMove(i) {
        k.current = clamp(k.current - i.dy / (i.shiftKey ? 1000 : 150), 0, 1);
        apply(k.current);
      },
    },
    !disabled,
  );

  // Wheel only acts while the knob has focus, so scrolling the panel over a knob still works.
  useWheel(
    ref,
    (e) => {
      if (document.activeElement !== ref.current) return;
      e.preventDefault();
      const c = latest.current;
      const dir = e.deltaY < 0 ? 1 : -1;
      const mult =
        c.num.scale === 'log' ? 2 : Math.max(1, Math.round((max - min) / (c.num.step ?? 1) / 100));
      const v = c.num.nudge(c.value, dir, e.shiftKey ? 1 : mult);
      if (v !== c.value) c.onChange(v);
    },
    !disabled,
  );

  const modulated = effective !== undefined && Math.abs(effective - value) > 1e-6;
  const effNorm = effective !== undefined ? num.toNorm(effective) : 0;
  const angle = (n: number) => -SWEEP + n * SWEEP * 2;
  const reset = def !== undefined ? () => onChange(def) : undefined;
  const [tx, ty] = polar(10, angle(norm));
  const [ix, iy] = polar(4, angle(norm));

  const control: ReactNode = (
    <>
      <div
        ref={ref}
        className="plui-knob__dial"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-labelledby={`${uid}-l`}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={num.valueText}
        aria-orientation="vertical"
        aria-disabled={disabled || undefined}
        style={{ width: size, height: size }}
        onKeyDown={(e) => !disabled && num.onKey(e, value, onChange)}
        onDoubleClick={() => !disabled && reset?.()}
        title="Тяните вверх/вниз (Shift — точнее). Колесо — при фокусе. Двойной клик — сброс"
        {...drag}
      >
        <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
          <path className="plui-knob__track" d={arc(13, -SWEEP, SWEEP)} />
          {norm > 0.002 && <path className="plui-knob__value" d={arc(13, -SWEEP, angle(norm))} />}
          {modulated && (
            <path
              className="plui-knob__mod"
              d={arc(
                13,
                Math.min(angle(norm), angle(effNorm)),
                Math.max(angle(norm), angle(effNorm)),
              )}
            />
          )}
          <circle className="plui-knob__cap" cx="16" cy="16" r="9" />
          <line className="plui-knob__needle" x1={ix} y1={iy} x2={tx} y2={ty} />
        </svg>
      </div>
      <NumberInput
        value={value}
        onCommit={onChange}
        min={min}
        max={max}
        step={num.step ?? Math.max(1e-3, value * 0.01)}
        decimals={num.decimals}
        unit={layout === 'row' ? unit : undefined}
        disabled={disabled}
        aria-labelledby={`${uid}-l`}
      />
    </>
  );

  return (
    <Field
      {...props}
      className={cx('plui-knob', `plui-knob--${layout}`, props.className)}
      labelId={`${uid}-l`}
      layout={layout === 'stack' ? 'stack' : 'row'}
      changed={num.changed}
      onReset={layout === 'row' ? reset : undefined}
      badge={
        modulated && effective !== undefined ? (
          <ModulatedBadge effective={effective} decimals={num.decimals} />
        ) : undefined
      }
    >
      {control}
    </Field>
  );
}
