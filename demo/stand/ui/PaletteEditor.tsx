import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  isHexColor,
  normalizeHex,
  type PaletteInterpolation,
  rgbToHex,
  samplePalette,
} from '../../../src/core/color';
import { Button, IconButton } from './Button';
import { Field } from './Field';
import { HexField } from './Inputs';
import { copyText, cx, moveItem, useFlash } from './utils';

export interface QuickPalette {
  id?: string;
  name: string;
  colors: readonly string[];
}

export interface PaletteEditorProps {
  label?: ReactNode;
  hint?: ReactNode;
  path?: string;
  value: readonly string[];
  onChange(next: string[]): void;
  /** Preview and midpoint math follow the same mode the renderer uses. */
  interpolation?: PaletteInterpolation;
  minStops?: number;
  maxStops?: number;
  quickPalettes?: readonly QuickPalette[];
  /** Enables reset. */
  default?: readonly string[];
  disabled?: boolean;
  className?: string;
}

const RGB = (c: readonly number[]) =>
  `rgb(${Math.round((c[0] ?? 0) * 255)},${Math.round((c[1] ?? 0) * 255)},${Math.round((c[2] ?? 0) * 255)})`;

/** CSS gradient of a palette, sampled with the renderer's own `samplePalette`. */
export function paletteGradientCss(
  colors: readonly string[],
  interpolation: PaletteInterpolation = 'oklab',
  angle = 90,
): string {
  const n = colors.length;
  if (n === 0) return 'transparent';
  if (n === 1) return normalizeHex(colors[0] as string);
  if (interpolation === 'steps') {
    const parts: string[] = [];
    for (let i = 0; i < n; i++) {
      const c = normalizeHex(colors[i] as string);
      parts.push(
        `${c} ${((i / n) * 100).toFixed(3)}%`,
        `${c} ${(((i + 1) / n) * 100).toFixed(3)}%`,
      );
    }
    return `linear-gradient(${angle}deg, ${parts.join(',')})`;
  }
  const samples = Math.min(64, Math.max(8, (n - 1) * 8));
  const parts: string[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    parts.push(`${RGB(samplePalette(colors, t, interpolation))} ${(t * 100).toFixed(2)}%`);
  }
  return `linear-gradient(${angle}deg, ${parts.join(',')})`;
}

const HEX_RE = /(?<![0-9a-z])#?([0-9a-f]{6}|[0-9a-f]{3})(?![0-9a-z])/gi;

/** Extracts hex colors from arbitrary text (JSON arrays, CSS lists, one per line...). */
export function parseHexList(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(HEX_RE)) out.push(normalizeHex(m[1] as string));
  return out;
}

function midColor(a: string, b: string, interpolation: PaletteInterpolation): string {
  const mode = interpolation === 'linear' ? 'linear' : 'oklab';
  return rgbToHex(samplePalette([a, b], 0.5, mode));
}

/**
 * Palette editor: live gradient preview, unlimited stops (up to `maxStops`), add/remove,
 * duplicate, reverse, reorder by drag or keyboard, paste a list of hex colors and
 * one-click quick palettes.
 */
export function PaletteEditor({
  label = 'Палитра',
  hint,
  path,
  value,
  onChange,
  interpolation = 'oklab',
  minStops = 1,
  maxStops = 32,
  quickPalettes,
  default: def,
  disabled,
  className,
}: PaletteEditorProps) {
  const uid = useId();
  const n = value.length;

  // Stable ids per stop so focus and DOM nodes follow a stop when it is moved.
  const seq = useRef(0);
  const idsRef = useRef<number[]>([]);
  if (idsRef.current.length !== n) idsRef.current = value.map(() => ++seq.current);
  const ids = idsRef.current;

  const [selected, setSelected] = useState(n - 1);
  const sel = Math.min(Math.max(selected, 0), n - 1);
  const [focusId, setFocusId] = useState<number | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [quickOpen, setQuickOpen] = useState(false);
  const [copied, flashCopied] = useFlash();
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    if (focusId === null) return;
    const input = listRef.current?.querySelector<HTMLInputElement>(
      `[data-stop-id="${focusId}"] input[type=text]`,
    );
    input?.focus();
    setFocusId(null);
  }, [focusId]);

  const apply = (colors: string[], nextIds: number[]) => {
    idsRef.current = nextIds;
    onChange(colors);
  };

  const insertAt = (index: number, color: string) => {
    if (n >= maxStops) return;
    const colors = value.slice();
    const nextIds = ids.slice();
    const id = ++seq.current;
    colors.splice(index, 0, color);
    nextIds.splice(index, 0, id);
    apply(colors, nextIds);
    setSelected(index);
    setFocusId(id);
  };

  const add = () => {
    if (n === 0) return insertAt(0, '#ffffff');
    const a = value[sel] as string;
    if (sel < n - 1) return insertAt(sel + 1, midColor(a, value[sel + 1] as string, interpolation));
    // The last stop has no next one: a copy of it would not change the gradient at all. Insert
    // the midpoint between the previous stop and the last one, before the last one.
    if (n >= 2) return insertAt(n - 1, midColor(value[n - 2] as string, a, interpolation));
    insertAt(n, a);
  };

  const remove = (i: number) => {
    if (n <= minStops) return;
    apply(
      value.filter((_, k) => k !== i),
      ids.filter((_, k) => k !== i),
    );
    setSelected(Math.min(i, n - 2));
  };

  const duplicate = (i: number) => {
    if (n >= maxStops) return;
    insertAt(i + 1, value[i] as string);
  };

  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= n) return;
    apply(moveItem(value, from, to), moveItem(ids, from, to));
    setSelected(to);
  };

  const setColor = (i: number, hex: string) => {
    const next = value.slice();
    next[i] = hex;
    onChange(next);
  };

  const reverse = () => {
    apply(value.slice().reverse(), ids.slice().reverse());
    setSelected(n - 1 - sel);
  };

  const setAll = (colors: readonly string[]) => {
    const list = colors.filter(isHexColor).map(normalizeHex).slice(0, maxStops);
    if (list.length < Math.max(1, minStops)) return;
    idsRef.current = list.map(() => ++seq.current);
    onChange(list);
    setSelected(list.length - 1);
  };

  // Double-click on the bar inserts a stop where you clicked, with the color found there.
  const onBarDouble = (e: React.MouseEvent<HTMLDivElement>) => {
    if (disabled || n >= maxStops) return;
    const r = e.currentTarget.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const color = rgbToHex(samplePalette(value, t, interpolation));
    const index = interpolation === 'steps' ? Math.floor(t * n) + 1 : Math.floor(t * (n - 1)) + 1;
    insertAt(Math.min(index, n), color);
  };

  // Drag reorder via the grip handle.
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);
  const dragRef = useRef<{ pointer: number; from: number; over: number } | null>(null);
  const overIndex = (clientY: number) => {
    const rows = listRef.current?.children;
    if (!rows) return 0;
    for (let i = 0; i < rows.length; i++) {
      const r = (rows[i] as HTMLElement).getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return rows.length - 1;
  };

  const gradient = useMemo(() => paletteGradientCss(value, interpolation), [value, interpolation]);
  const changed = def !== undefined && (def.length !== n || def.some((c, i) => c !== value[i]));
  const parsed = useMemo(() => (pasteOpen ? parseHexList(pasteText) : []), [pasteOpen, pasteText]);

  const chipPos = (i: number) =>
    interpolation === 'steps' ? (i + 0.5) / n : n === 1 ? 0.5 : i / (n - 1);

  return (
    <Field
      label={label}
      hint={hint}
      path={path}
      disabled={disabled}
      layout="stack"
      className={cx('plui-pal', className)}
      labelId={`${uid}-l`}
      changed={changed}
      onReset={def ? () => setAll(def) : undefined}
      badge={
        <span className="plui-pal__count" title="Число цветов / максимум">
          {n}/{maxStops}
        </span>
      }
    >
      <div className="plui-pal__main">
        <div
          className="plui-pal__bar"
          style={{ background: gradient }}
          onDoubleClick={onBarDouble}
          title="Двойной клик — добавить цвет в этой точке"
          role="img"
          aria-label={`Градиент палитры, ${n} цветов`}
        />
        <div className="plui-pal__chips" aria-hidden="true">
          {value.map((c, i) => (
            <button
              key={ids[i] ?? i}
              type="button"
              tabIndex={-1}
              className={cx('plui-pal__chip', i === sel && 'is-selected')}
              style={{ left: `${chipPos(i) * 100}%`, background: isHexColor(c) ? c : '#000' }}
              onClick={() => {
                setSelected(i);
                setFocusId(ids[i] ?? null);
              }}
              disabled={disabled}
            />
          ))}
        </div>

        <ol className="plui-pal__list" ref={listRef} aria-labelledby={`${uid}-l`}>
          {value.map((c, i) => {
            const id = ids[i] ?? i;
            const dropCls =
              drag && drag.over === i && drag.from !== i
                ? drag.over > drag.from
                  ? 'is-drop-after'
                  : 'is-drop-before'
                : false;
            return (
              <li
                key={id}
                data-stop-id={id}
                className={cx(
                  'plui-pal__row',
                  i === sel && 'is-selected',
                  drag?.from === i && 'is-dragging',
                  dropCls,
                )}
                onFocusCapture={() => setSelected(i)}
              >
                <button
                  type="button"
                  className="plui-pal__grip"
                  disabled={disabled}
                  aria-label={`Цвет ${i + 1}: переместить (стрелки вверх/вниз или перетаскивание)`}
                  title="Перетащить · стрелки ↑↓"
                  onPointerDown={(e) => {
                    if (e.button !== 0 || disabled) return;
                    e.currentTarget.setPointerCapture(e.pointerId);
                    dragRef.current = { pointer: e.pointerId, from: i, over: i };
                    setDrag({ from: i, over: i });
                  }}
                  onPointerMove={(e) => {
                    const d = dragRef.current;
                    if (!d || d.pointer !== e.pointerId) return;
                    const o = overIndex(e.clientY);
                    if (o !== d.over) {
                      d.over = o;
                      setDrag({ from: d.from, over: o });
                    }
                  }}
                  onPointerUp={(e) => {
                    const d = dragRef.current;
                    if (!d || d.pointer !== e.pointerId) return;
                    dragRef.current = null;
                    setDrag(null);
                    move(d.from, d.over);
                  }}
                  onPointerCancel={() => {
                    dragRef.current = null;
                    setDrag(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowUp') move(i, i - 1);
                    else if (e.key === 'ArrowDown') move(i, i + 1);
                    else return;
                    e.preventDefault();
                  }}
                >
                  <svg width="10" height="14" viewBox="0 0 10 14" aria-hidden="true">
                    <path
                      d="M2.5 2.5v.01M7.5 2.5v.01M2.5 7v.01M7.5 7v.01M2.5 11.5v.01M7.5 11.5v.01"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
                <span className="plui-pal__idx" aria-hidden="true">
                  {i + 1}
                </span>
                <HexField
                  value={c}
                  onChange={(hex) => setColor(i, hex)}
                  disabled={disabled}
                  aria-label={`Цвет ${i + 1}`}
                />
                <span className="plui-pal__acts">
                  <IconButton
                    icon="up"
                    label={`Цвет ${i + 1}: выше`}
                    size="xs"
                    disabled={disabled || i === 0}
                    onClick={() => move(i, i - 1)}
                  />
                  <IconButton
                    icon="down"
                    label={`Цвет ${i + 1}: ниже`}
                    size="xs"
                    disabled={disabled || i === n - 1}
                    onClick={() => move(i, i + 1)}
                  />
                  <IconButton
                    icon="duplicate"
                    label={`Цвет ${i + 1}: дублировать`}
                    size="xs"
                    disabled={disabled || n >= maxStops}
                    onClick={() => duplicate(i)}
                  />
                  <IconButton
                    icon="close"
                    label={`Цвет ${i + 1}: удалить`}
                    size="xs"
                    variant="danger"
                    disabled={disabled || n <= minStops}
                    onClick={() => remove(i)}
                  />
                </span>
              </li>
            );
          })}
        </ol>

        <div className="plui-pal__tools">
          <Button
            size="sm"
            icon="plus"
            onClick={add}
            disabled={disabled || n >= maxStops}
            title="Добавить цвет: средний между выбранным и следующим (для последнего: между предпоследним и последним)"
          >
            Добавить
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon="reverse"
            onClick={reverse}
            disabled={disabled || n < 2}
          >
            Реверс
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon="paste"
            active={pasteOpen}
            onClick={() => setPasteOpen((o) => !o)}
            disabled={disabled}
          >
            Вставить
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={copied ? 'check' : 'copy'}
            disabled={disabled}
            onClick={async () => {
              if (await copyText(value.join('\n'))) flashCopied();
            }}
          >
            {copied ? 'Скопировано' : 'Копировать'}
          </Button>
          {quickPalettes && quickPalettes.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              active={quickOpen}
              onClick={() => setQuickOpen((o) => !o)}
              disabled={disabled}
            >
              Готовые
            </Button>
          )}
        </div>

        {pasteOpen && (
          <div className="plui-pal__paste">
            <textarea
              className="plui-textarea"
              rows={3}
              value={pasteText}
              placeholder={'#ff2a4a, #6a3cc8, #0476ff\nили JSON-массив, по одному на строку…'}
              aria-label="Список цветов в формате HEX"
              spellCheck={false}
              onChange={(e) => setPasteText(e.target.value)}
            />
            <div className="plui-pal__pastebar">
              <span
                className="plui-pal__pastepreview"
                style={{
                  background: parsed.length ? paletteGradientCss(parsed, interpolation) : undefined,
                }}
              />
              <span className="plui-pal__pastecount">
                {parsed.length ? `найдено: ${parsed.length}` : 'нет цветов'}
                {parsed.length > maxStops && ` (будет взято ${maxStops})`}
              </span>
              <Button
                size="sm"
                variant="primary"
                disabled={parsed.length < Math.max(1, minStops)}
                onClick={() => {
                  setAll(parsed);
                  setPasteOpen(false);
                  setPasteText('');
                }}
              >
                Применить
              </Button>
            </div>
          </div>
        )}

        {quickOpen && quickPalettes && (
          <ul className="plui-pal__quick" aria-label="Готовые палитры">
            {quickPalettes.map((q) => (
              <li key={q.id ?? q.name}>
                <button
                  type="button"
                  className="plui-pal__quickitem"
                  disabled={disabled}
                  title={`${q.name}: ${q.colors.length} цв.`}
                  onClick={() => setAll(q.colors)}
                >
                  <span
                    className="plui-pal__quickbar"
                    style={{ background: paletteGradientCss(q.colors, interpolation) }}
                  />
                  <span className="plui-pal__quickname">{q.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Field>
  );
}
