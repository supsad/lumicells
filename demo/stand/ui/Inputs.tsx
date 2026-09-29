import { useEffect, useId, useRef, useState } from 'react';
import { isHexColor, normalizeHex } from '../../../src/core/color';
import { Field, type FieldBaseProps } from './Field';
import { NumberInput } from './NumberInput';
import {
  autoStep,
  clamp,
  cx,
  type DragInfo,
  decimalsOf,
  snapToStep,
  useLatest,
  usePointerDrag,
  wrapAngle,
} from './utils';

/* ---------------------------------------------------------------- Switch */

export interface SwitchProps {
  checked: boolean;
  onChange(checked: boolean): void;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  className?: string;
}

/** Bare on/off switch (no label) for headers and custom rows. */
export function Switch({ checked, onChange, disabled, id, className, ...aria }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      disabled={disabled}
      className={cx('plui-switch', checked && 'is-on', className)}
      onClick={() => onChange(!checked)}
      {...aria}
    >
      <span className="plui-switch__thumb" />
    </button>
  );
}

export interface ToggleProps extends FieldBaseProps {
  checked: boolean;
  onChange(checked: boolean): void;
  default?: boolean;
}

export function Toggle(props: ToggleProps) {
  const { checked, onChange, disabled, default: def } = props;
  const id = useId();
  return (
    <Field
      {...props}
      className={cx('plui-toggle', props.className)}
      htmlFor={id}
      changed={def !== undefined && def !== checked}
      onReset={def !== undefined ? () => onChange(def) : undefined}
    >
      <Switch id={id} checked={checked} onChange={onChange} disabled={disabled} />
    </Field>
  );
}

/* ---------------------------------------------------------------- Select */

export type Option<T extends string = string> =
  | T
  | { value: T; label: string; disabled?: boolean; title?: string };

function opt<T extends string>(o: Option<T>) {
  return typeof o === 'string' ? { value: o, label: o } : o;
}

export interface SelectProps<T extends string = string> extends FieldBaseProps {
  value: T;
  onChange(value: NoInfer<T>): void;
  options: readonly Option<NoInfer<T>>[];
  default?: NoInfer<T>;
}

export function Select<T extends string = string>(props: SelectProps<T>) {
  const { value, onChange, options, disabled, default: def } = props;
  const id = useId();
  return (
    <Field
      {...props}
      className={cx('plui-select', props.className)}
      htmlFor={id}
      changed={def !== undefined && def !== value}
      onReset={def !== undefined ? () => onChange(def) : undefined}
    >
      <span className="plui-select__wrap">
        <select
          id={id}
          className="plui-select__input"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value as T)}
        >
          {options.map((o) => {
            const x = opt(o);
            return (
              <option key={x.value} value={x.value} disabled={'disabled' in x && x.disabled}>
                {x.label}
              </option>
            );
          })}
        </select>
        <svg
          className="plui-select__chev"
          width="10"
          height="10"
          viewBox="0 0 16 16"
          aria-hidden="true"
        >
          <path d="M3.5 6l4.5 4.5L12.5 6" fill="none" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      </span>
    </Field>
  );
}

/* ------------------------------------------------------------- Segmented */

export interface SegmentedProps<T extends string = string> extends FieldBaseProps {
  value: T;
  onChange(value: NoInfer<T>): void;
  options: readonly Option<NoInfer<T>>[];
  default?: NoInfer<T>;
  /** Default: `stack` for more than 3 options, otherwise `row`. */
  layout?: 'row' | 'stack';
}

export function Segmented<T extends string = string>(props: SegmentedProps<T>) {
  const { value, onChange, options, disabled, default: def } = props;
  const uid = useId();
  const list = options.map(opt);
  const layout = props.layout ?? (list.length > 3 ? 'stack' : 'row');
  const group = useRef<HTMLDivElement>(null);

  const move = (from: number, dir: 1 | -1 | 'first' | 'last') => {
    const n = list.length;
    let i = dir === 'first' ? -1 : dir === 'last' ? n : from;
    const step = dir === 'last' ? -1 : dir === 'first' ? 1 : dir;
    for (let k = 0; k < n; k++) {
      i = (i + step + n) % n;
      if (!list[i]?.disabled) break;
    }
    const o = list[i];
    if (o) {
      onChange(o.value);
      group.current?.querySelectorAll<HTMLElement>('[role=radio]')[i]?.focus();
    }
  };

  return (
    <Field
      {...props}
      className={cx('plui-segmented-field', props.className)}
      labelId={`${uid}-l`}
      layout={layout}
      changed={def !== undefined && def !== value}
      onReset={def !== undefined ? () => onChange(def) : undefined}
    >
      <div
        ref={group}
        className="plui-segmented"
        role="radiogroup"
        aria-labelledby={`${uid}-l`}
        aria-disabled={disabled || undefined}
      >
        {list.map((o, i) => {
          const on = o.value === value;
          return (
            // biome-ignore lint/a11y/useSemanticElements: APG radio-group pattern with roving tabindex on buttons
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              disabled={disabled || o.disabled}
              title={o.title}
              className={cx('plui-segmented__opt', on && 'is-on')}
              onClick={() => onChange(o.value)}
              onKeyDown={(e) => {
                const k = e.key;
                if (k === 'ArrowRight' || k === 'ArrowDown') move(i, 1);
                else if (k === 'ArrowLeft' || k === 'ArrowUp') move(i, -1);
                else if (k === 'Home') move(i, 'first');
                else if (k === 'End') move(i, 'last');
                else return;
                e.preventDefault();
              }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </Field>
  );
}

/* ------------------------------------------------------------ AngleInput */

export interface AngleInputProps extends FieldBaseProps {
  /** Degrees. 0 points right, positive turns clockwise on screen (like CSS). */
  value: number;
  onChange(deg: number): void;
  /** Range; a span of 360 or more wraps around, a smaller one clamps. */
  min?: number;
  max?: number;
  default?: number;
  /** Arrow-key step in degrees (default 1). */
  step?: number;
}

function angleFromPointer(cx0: number, cy0: number, x: number, y: number) {
  return (Math.atan2(y - cy0, x - cx0) * 180) / Math.PI;
}

/** Dial (drag; Shift snaps to 15°) plus an exact number field. */
export function AngleInput(props: AngleInputProps) {
  const { value, onChange, min = 0, max = 360, disabled, default: def, step = 1 } = props;
  const uid = useId();
  const full = max - min >= 360;
  const latest = useLatest({ value, onChange });

  const constrain = (deg: number) => {
    if (full) return wrapAngle(deg, min, max);
    // Pick the equivalent angle that lies inside the range, otherwise the nearest end.
    for (const c of [deg, deg + 360, deg - 360]) if (c >= min && c <= max) return c;
    const dist = (a: number, b: number) => Math.abs(wrapAngle(a - b, -180, 180));
    return dist(deg, min) < dist(deg, max) ? min : max;
  };

  const setFromPointer = (i: DragInfo) => {
    const r = i.rect;
    let a = angleFromPointer(r.left + r.width / 2, r.top + r.height / 2, i.clientX, i.clientY);
    a = i.shiftKey ? Math.round(a / 15) * 15 : Math.round(a);
    const v = constrain(a);
    if (v !== latest.current.value) latest.current.onChange(v);
  };
  const drag = usePointerDrag({ onStart: setFromPointer, onMove: setFromPointer }, !disabled);

  const rad = (value * Math.PI) / 180;
  const nx = 16 + 10.5 * Math.cos(rad);
  const ny = 16 + 10.5 * Math.sin(rad);

  return (
    <Field
      {...props}
      className={cx('plui-angle', props.className)}
      labelId={`${uid}-l`}
      changed={def !== undefined && Math.abs(def - value) > 1e-9}
      onReset={def !== undefined ? () => onChange(def) : undefined}
    >
      <div
        className="plui-angle__dial"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-labelledby={`${uid}-l`}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={`${Math.round(value * 10) / 10}°`}
        aria-disabled={disabled || undefined}
        title="Тяните по кругу (Shift — шаг 15°)"
        {...drag}
        onKeyDown={(e) => {
          if (disabled) return;
          let v: number | null = null;
          const big = e.shiftKey ? 15 : step;
          if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v = constrain(value + big);
          else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v = constrain(value - big);
          else if (e.key === 'PageUp') v = constrain(value + 15);
          else if (e.key === 'PageDown') v = constrain(value - 15);
          else if (e.key === 'Home' && !full) v = min;
          else if (e.key === 'End' && !full) v = max;
          if (v === null) return;
          e.preventDefault();
          if (v !== value) onChange(v);
        }}
      >
        <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
          <circle className="plui-angle__ring" cx="16" cy="16" r="13" />
          {[0, 90, 180, 270].map((a) => (
            <line
              key={a}
              className="plui-angle__tick"
              x1={16 + 10.5 * Math.cos((a * Math.PI) / 180)}
              y1={16 + 10.5 * Math.sin((a * Math.PI) / 180)}
              x2={16 + 13 * Math.cos((a * Math.PI) / 180)}
              y2={16 + 13 * Math.sin((a * Math.PI) / 180)}
            />
          ))}
          <line className="plui-angle__needle" x1="16" y1="16" x2={nx} y2={ny} />
          <circle className="plui-angle__dot" cx={nx} cy={ny} r="2.6" />
          <circle className="plui-angle__hub" cx="16" cy="16" r="1.8" />
        </svg>
      </div>
      <NumberInput
        value={value}
        onCommit={onChange}
        min={min}
        max={max}
        wrap={full}
        step={step}
        decimals={1}
        trim
        unit="°"
        disabled={disabled}
        aria-labelledby={`${uid}-l`}
      />
    </Field>
  );
}

/* ---------------------------------------------------------------- Vec2Pad */

export type Vec2 = [number, number];

export interface Vec2PadProps extends FieldBaseProps {
  value: Vec2;
  onChange(v: Vec2): void;
  min: number;
  max: number;
  step?: number;
  default?: Vec2;
  /** `true`: +y is up (math). Default `false`: +y is down (screen coordinates). */
  yUp?: boolean;
  /** Pad edge in px (default 76). */
  size?: number;
}

/** 2D pad with crosshair (Shift = fine drag, double-click = reset) and two exact inputs. */
export function Vec2Pad(props: Vec2PadProps) {
  const { value, onChange, min, max, disabled, default: def, yUp = false, size = 76 } = props;
  const uid = useId();
  const step = props.step ?? autoStep(min, max) * 10;
  const decimals = decimalsOf(step);
  const span = max - min;
  const fine = useRef({ on: false, x0: 0, y0: 0, nx: 0, ny: 0 });
  const latest = useLatest({ value, onChange });

  const toNorm = (v: Vec2): [number, number] => {
    const nx = (v[0] - min) / span;
    const ny = (v[1] - min) / span;
    return [nx, yUp ? 1 - ny : ny];
  };
  const fromNorm = (nx: number, ny: number): Vec2 => {
    const y = yUp ? 1 - ny : ny;
    const f = (n: number) => clamp(snapToStep(min + clamp(n, 0, 1) * span, min, step), min, max);
    return [f(nx), f(y)];
  };
  const put = (v: Vec2) => {
    const c = latest.current.value;
    if (v[0] !== c[0] || v[1] !== c[1]) latest.current.onChange(v);
  };

  const drag = usePointerDrag(
    {
      onStart(i) {
        const [nx, ny] = toNorm(latest.current.value);
        fine.current = { on: i.shiftKey, x0: i.clientX, y0: i.clientY, nx, ny };
        if (!i.shiftKey) put(fromNorm(i.x / i.rect.width, i.y / i.rect.height));
      },
      onMove(i) {
        const f = fine.current;
        if (i.shiftKey !== f.on) {
          const [nx, ny] = toNorm(latest.current.value);
          fine.current = { on: i.shiftKey, x0: i.clientX, y0: i.clientY, nx, ny };
        }
        const s = fine.current;
        if (s.on) {
          put(
            fromNorm(
              s.nx + ((i.clientX - s.x0) / i.rect.width) * 0.1,
              s.ny + ((i.clientY - s.y0) / i.rect.height) * 0.1,
            ),
          );
        } else {
          put(fromNorm(i.x / i.rect.width, i.y / i.rect.height));
        }
      },
    },
    !disabled,
  );

  const [hx, hy] = toNorm(value);
  const [dx, dy] = def ? toNorm(def) : [0, 0];
  const changed = def !== undefined && (def[0] !== value[0] || def[1] !== value[1]);
  const setAxis = (axis: 0 | 1, v: number) => {
    const next: Vec2 = [value[0], value[1]];
    next[axis] = v;
    onChange(next);
  };

  return (
    <Field
      {...props}
      className={cx('plui-vec2', props.className)}
      layout="stack"
      labelId={`${uid}-l`}
      changed={changed}
      onReset={def ? () => onChange([def[0], def[1]]) : undefined}
    >
      <div className="plui-vec2__body">
        <div
          className="plui-vec2__pad"
          role="application"
          tabIndex={disabled ? -1 : 0}
          aria-roledescription="двумерная панель"
          aria-label={`${typeof props.label === 'string' ? props.label : 'Вектор'}: x ${value[0].toFixed(decimals)}, y ${value[1].toFixed(decimals)}`}
          aria-disabled={disabled || undefined}
          style={{ width: size, height: size }}
          title="Shift — точнее, двойной клик — сброс"
          onDoubleClick={() => !disabled && def && onChange([def[0], def[1]])}
          onKeyDown={(e) => {
            if (disabled) return;
            const m = e.shiftKey ? 10 : 1;
            const sgnY = yUp ? 1 : -1; // ArrowUp moves the handle up on screen
            let dxv = 0;
            let dyv = 0;
            if (e.key === 'ArrowLeft') dxv = -1;
            else if (e.key === 'ArrowRight') dxv = 1;
            else if (e.key === 'ArrowUp') dyv = sgnY;
            else if (e.key === 'ArrowDown') dyv = -sgnY;
            else return;
            e.preventDefault();
            put([
              clamp(snapToStep(value[0] + dxv * step * m, min, step), min, max),
              clamp(snapToStep(value[1] + dyv * step * m, min, step), min, max),
            ]);
          }}
          {...drag}
        >
          <span className="plui-vec2__axis plui-vec2__axis--x" />
          <span className="plui-vec2__axis plui-vec2__axis--y" />
          {def && (
            <span
              className="plui-vec2__default"
              style={{ left: `${dx * 100}%`, top: `${dy * 100}%` }}
            />
          )}
          <span
            className="plui-vec2__handle"
            style={{ left: `${hx * 100}%`, top: `${hy * 100}%` }}
          />
        </div>
        <div className="plui-vec2__inputs">
          <div className="plui-vec2__axislabel">
            <span aria-hidden="true">X</span>
            <NumberInput
              value={value[0]}
              onCommit={(v) => setAxis(0, v)}
              min={min}
              max={max}
              step={step}
              decimals={Math.max(2, decimals)}
              trim
              disabled={disabled}
              aria-label={`${typeof props.label === 'string' ? props.label : 'Вектор'}: X`}
            />
          </div>
          <div className="plui-vec2__axislabel">
            <span aria-hidden="true">Y</span>
            <NumberInput
              value={value[1]}
              onCommit={(v) => setAxis(1, v)}
              min={min}
              max={max}
              step={step}
              decimals={Math.max(2, decimals)}
              trim
              disabled={disabled}
              aria-label={`${typeof props.label === 'string' ? props.label : 'Вектор'}: Y`}
            />
          </div>
          <span className="plui-vec2__range">
            {min}…{max}
          </span>
        </div>
      </div>
    </Field>
  );
}

/* ------------------------------------------------------------- ColorInput */

export interface ColorInputProps extends FieldBaseProps {
  /** `#rrggbb`. */
  value: string;
  onChange(hex: string): void;
  default?: string;
}

const HEX_LIVE = /^#?[0-9a-f]{6}$/i;

/** Swatch that opens the native picker + a validated hex text field. */
export function ColorInput(props: ColorInputProps) {
  const { value, onChange, disabled, default: def } = props;
  const uid = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value;
  const invalid = draft !== null && draft.trim() !== '' && !isHexColor(draft);
  const valid = normalizeHex(isHexColor(value) ? value : '#000000');

  const commit = (text: string) => {
    if (isHexColor(text)) {
      const n = normalizeHex(text);
      if (n !== value) onChange(n);
    }
    setDraft(null);
  };

  return (
    <Field
      {...props}
      className={cx('plui-color', props.className)}
      htmlFor={`${uid}-h`}
      changed={def !== undefined && normalizeHex(def) !== value.toLowerCase()}
      onReset={def !== undefined ? () => onChange(normalizeHex(def)) : undefined}
    >
      <label className="plui-swatch" style={{ background: valid }} title="Выбрать цвет">
        <input
          type="color"
          className="plui-swatch__input"
          value={valid}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value.toLowerCase())}
          aria-label={`${typeof props.label === 'string' ? props.label : 'Цвет'}: выбор цвета`}
        />
      </label>
      <input
        id={`${uid}-h`}
        className={cx('plui-hex', invalid && 'is-invalid')}
        type="text"
        value={shown}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        maxLength={9}
        aria-invalid={invalid || undefined}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          const t = e.target.value;
          setDraft(t);
          // Commit as soon as the text is a complete 6-digit color; 3-digit waits for blur/Enter.
          if (HEX_LIVE.test(t)) onChange(normalizeHex(t));
        }}
        onBlur={(e) => draft !== null && commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(e.currentTarget.value);
          else if (e.key === 'Escape') {
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
      />
    </Field>
  );
}

/** Plain swatch + hex text used inside the palette editor rows. */
export interface HexFieldProps {
  value: string;
  onChange(hex: string): void;
  'aria-label': string;
  disabled?: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
}

export function HexField({ value, onChange, disabled, inputRef, ...aria }: HexFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const invalid = draft !== null && draft.trim() !== '' && !isHexColor(draft);
  const valid = isHexColor(value) ? normalizeHex(value) : '#000000';
  // Drop a stale draft when the value is changed from outside (reorder, reverse, ...).
  const prev = useRef(value);
  useEffect(() => {
    if (prev.current !== value) {
      prev.current = value;
      setDraft(null);
    }
  }, [value]);
  const commit = (t: string) => {
    if (isHexColor(t)) {
      const n = normalizeHex(t);
      if (n !== value) onChange(n);
    }
    setDraft(null);
  };
  return (
    <>
      <label className="plui-swatch plui-swatch--sm" style={{ background: valid }}>
        <input
          type="color"
          className="plui-swatch__input"
          value={valid}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value.toLowerCase())}
          aria-label={`${aria['aria-label']}: выбор цвета`}
        />
      </label>
      <input
        ref={inputRef}
        className={cx('plui-hex plui-hex--sm', invalid && 'is-invalid')}
        type="text"
        value={draft ?? value}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        maxLength={9}
        aria-invalid={invalid || undefined}
        aria-label={aria['aria-label']}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          const t = e.target.value;
          setDraft(t);
          if (HEX_LIVE.test(t)) onChange(normalizeHex(t));
        }}
        onBlur={(e) => draft !== null && commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(e.currentTarget.value);
          else if (e.key === 'Escape') {
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
      />
    </>
  );
}
