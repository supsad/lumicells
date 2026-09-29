/**
 * Visual playground of the control kit (examples/ui-kit.html). Not used by the stand itself:
 * it shows every component in a sample panel so the look can be checked in a browser.
 */
import { StrictMode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AngleInput,
  Badge,
  Button,
  CodeBlock,
  ColorInput,
  Divider,
  EmptyState,
  FileDrop,
  Grid,
  Hint,
  IconButton,
  Knob,
  Modal,
  PaletteEditor,
  Panel,
  Readout,
  SearchInput,
  Section,
  Segmented,
  Select,
  Slider,
  StatsGraph,
  type StatsGraphHandle,
  Switch,
  TabPanel,
  Tabs,
  ToastList,
  Toggle,
  Toolbar,
  ToolbarSeparator,
  ToolbarSpacer,
  Tooltip,
  useToasts,
  type Vec2,
  Vec2Pad,
} from './index';

const REFERENCE_PALETTE = [
  '#7a1d5a',
  '#f21239',
  '#e0267a',
  '#c43db2',
  '#6a3cc8',
  '#1f4fd8',
  '#0476ff',
  '#0a8cf0',
  '#0b3a9a',
  '#041557',
];

const QUICK = [
  { name: 'Референс', colors: REFERENCE_PALETTE },
  { name: 'Неон', colors: ['#ff2a4a', '#e0267a', '#6a3cc8', '#0476ff', '#19e6d0'] },
  { name: 'Матрица', colors: ['#001a0a', '#00a83c', '#38ff7a', '#d6ffe4'] },
  { name: 'Закат', colors: ['#2b0a3d', '#b1235c', '#ff6a3d', '#ffd166'] },
  { name: 'Лёд', colors: ['#031233', '#0b5cff', '#4de3ff', '#eaffff'] },
  { name: 'Моно', colors: ['#ffffff'] },
];

const SNIPPET = `import type { PixelLifeConfigInput } from 'pixel-life';

export const pixelLifeConfig = {
  grid: { columns: 31, gap: 0.27 },
  modes: { sphere: { weight: 1, radius: 0.66 } },
  color: { palette: ['#7a1d5a', '#f21239', '#0476ff'] },
} satisfies PixelLifeConfigInput;
`;

/** Generated controls: checks that ~120 rows stay usable and searchable. */
const DENSE = Array.from({ length: 120 }, (_, i) => {
  const groups = ['grid', 'animation', 'color', 'glow', 'lift', 'background'];
  const names = ['gain', 'radius', 'falloff', 'softness', 'strength', 'threshold', 'scale', 'rate'];
  const g = groups[i % groups.length] as string;
  const n = names[Math.floor(i / groups.length) % names.length] as string;
  const log = i % 7 === 3;
  return {
    key: `${g}.${n}${i}`,
    label: `${n[0]?.toUpperCase()}${n.slice(1)} ${i + 1}`,
    min: log ? 0.1 : 0,
    max: log ? 10 : 1 + (i % 4),
    step: log ? undefined : 0.01,
    scale: log ? ('log' as const) : ('linear' as const),
    def: log ? 1 : 0.5,
  };
});

function useSine(
  g: React.RefObject<StatsGraphHandle | null>,
  base: number,
  amp: number,
  spike = 0,
) {
  useEffect(() => {
    let raf = 0;
    let t = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = now - last;
      if (dt >= 16) {
        last = now;
        t += dt / 1000;
        const s = base + amp * Math.sin(t * 2.1) + amp * 0.3 * Math.sin(t * 7.3);
        g.current?.push(spike && Math.random() < 0.02 ? s + spike : s);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [g, base, amp, spike]);
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="pv-card">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function App() {
  // Panel state
  const [columns, setColumns] = useState(31);
  const [gap, setGap] = useState(0.27);
  const [pitch, setPitch] = useState(24);
  const [zoom, setZoom] = useState(1);
  const [speed, setSpeed] = useState(1);
  const [sizing, setSizing] = useState<'pitch' | 'columns'>('columns');
  const [blend, setBlend] = useState<'screen' | 'add' | 'max'>('screen');
  const [interp, setInterp] = useState<'oklab' | 'linear' | 'steps'>('oklab');
  const [weightSphere, setWeightSphere] = useState(1);
  const [weightPulse, setWeightPulse] = useState(0);
  const [radius, setRadius] = useState(0.66);
  const [hole, setHole] = useState(0.24);
  const [angle, setAngle] = useState(32);
  const [tilt, setTilt] = useState(20);
  const [center, setCenter] = useState<Vec2>([-0.02, -0.02]);
  const [bg, setBg] = useState('#000032');
  const [palette, setPalette] = useState<string[]>(REFERENCE_PALETTE);
  const [lift, setLift] = useState(true);
  const [pointer, setPointer] = useState(false);
  const [bloom, setBloom] = useState(0.35);
  const [halo, setHalo] = useState(0.55);
  const [energy, setEnergy] = useState(1);
  const [search, setSearch] = useState('');
  const [dense, setDense] = useState<Record<string, number>>({});
  const [collapsed, setCollapsed] = useState(false);

  // Gallery state
  const [tab, setTab] = useState('json');
  const [pill, setPill] = useState('a');
  const [modal, setModal] = useState(false);
  const [big, setBig] = useState(0.4);
  const toasts = useToasts();

  // A fake "modulator" moves the effective value of one slider.
  const [light, setLight] = useState(0.45);
  const [rim, setRim] = useState(1.3);
  const [wobble, setWobble] = useState(0.08);
  const [freq, setFreq] = useState(3);
  const [width, setWidth] = useState(0.14);
  const [eff, setEff] = useState(1);
  useEffect(() => {
    const id = window.setInterval(() => {
      setEff(Math.max(0, Math.min(3, energy + Math.sin(performance.now() / 700) * 0.6)));
    }, 60);
    return () => window.clearInterval(id);
  }, [energy]);

  const fps = useRef<StatsGraphHandle>(null);
  const gpu = useRef<StatsGraphHandle>(null);
  useSine(fps, 58, 3, -18);
  useSine(gpu, 6.5, 1.6, 9);

  const q = search.trim().toLowerCase();
  const denseShown = useMemo(
    () => DENSE.filter((d) => !q || d.label.toLowerCase().includes(q) || d.key.includes(q)),
    [q],
  );
  const show = (s: string) => !q || s.toLowerCase().includes(q);

  return (
    <div className="pv-stage">
      <main className="pv-main">
        <header className="pv-head">
          <h1>Pixel Life — набор контролов</h1>
          <p>
            Все компоненты стенда. Панель справа — рабочий образец с поиском и 120 сгенерированными
            параметрами.
          </p>
        </header>

        <div className="pv-grid">
          <Card title="Toolbar · Button · IconButton · Badge">
            <Toolbar aria-label="Пример панели инструментов">
              <IconButton icon="play" label="Запуск" />
              <IconButton icon="pause" label="Пауза" active />
              <ToolbarSeparator />
              <IconButton icon="download" label="Скачать" />
              <IconButton icon="upload" label="Загрузить" />
              <ToolbarSpacer />
              <Badge tone="ok">60 fps</Badge>
            </Toolbar>
            <div className="pv-row">
              <Button variant="primary" icon="check">
                Применить
              </Button>
              <Button>Обычная</Button>
              <Button variant="ghost" icon="reset">
                Сбросить
              </Button>
              <Button variant="danger" icon="trash">
                Удалить
              </Button>
              <Button disabled>Отключена</Button>
              <Button size="sm">Мелкая</Button>
            </div>
            <div className="pv-row">
              <Badge>neutral</Badge>
              <Badge tone="accent">accent</Badge>
              <Badge tone="azure">azure</Badge>
              <Badge tone="cyan">cyan</Badge>
              <Badge tone="warn">warn</Badge>
              <Badge tone="ok" outline>
                outline
              </Badge>
            </div>
          </Card>

          <Card title="Tabs · Tooltip · Hint">
            <Tabs
              aria-label="Формат"
              value={tab}
              onChange={setTab}
              items={[
                { id: 'json', label: 'JSON' },
                { id: 'ts', label: 'TypeScript', badge: 3 },
                { id: 'html', label: 'HTML' },
                { id: 'off', label: 'Недоступно', disabled: true },
              ]}
            >
              <TabPanel value="json">Вкладка JSON: конфигурация целиком.</TabPanel>
              <TabPanel value="ts">Вкладка TypeScript: типизированный объект.</TabPanel>
              <TabPanel value="html">Вкладка HTML: веб-компонент.</TabPanel>
            </Tabs>
            <Tabs
              variant="pills"
              fill
              aria-label="Вид"
              value={pill}
              onChange={setPill}
              items={[
                { id: 'a', label: 'Итог' },
                { id: 'b', label: 'Поле' },
                { id: 'c', label: 'Свечение' },
              ]}
            />
            <div className="pv-row">
              <Tooltip content="Подсказка над кнопкой">
                <Button size="sm">Наведи курсор</Button>
              </Tooltip>
              <Tooltip
                content="Снизу и с переносом длинного текста, чтобы проверить ширину"
                placement="bottom"
              >
                <Button size="sm" variant="ghost">
                  Снизу
                </Button>
              </Tooltip>
              <span className="pv-inline">
                Параметр <Hint>Хинт доступен и с клавиатуры (Tab).</Hint>
              </span>
            </div>
          </Card>

          <Card title="Modal · Toast · FileDrop">
            <div className="pv-row">
              <Button onClick={() => setModal(true)}>Открыть окно</Button>
              <Button
                variant="ghost"
                onClick={() => toasts.push('Конфиг скопирован в буфер', { tone: 'success' })}
              >
                Успех
              </Button>
              <Button
                variant="ghost"
                onClick={() =>
                  toasts.push('Не удалось разобрать файл', { tone: 'error', title: 'Ошибка' })
                }
              >
                Ошибка
              </Button>
              <Button
                variant="ghost"
                onClick={() =>
                  toasts.push('Изменено значение вне диапазона: 7 → 4', { tone: 'warn' })
                }
              >
                Предупреждение
              </Button>
            </div>
            <FileDrop
              onText={(t, f) =>
                toasts.push(`${f.name}: ${t.length} символов`, {
                  tone: 'info',
                  title: 'Файл прочитан',
                })
              }
              onError={(m) => toasts.push(m, { tone: 'error' })}
            />
          </Card>

          <Card title="CodeBlock">
            <CodeBlock
              code={SNIPPET}
              language="ts"
              title="pixel-life.config.ts"
              onCopy={() => toasts.push('Скопировано', { tone: 'success', duration: 1500 })}
            />
          </Card>

          <Card title="StatsGraph (240 отсчётов, без React-состояния)">
            <div className="pv-stats">
              <StatsGraph
                ref={fps}
                label="FPS"
                min={0}
                max={70}
                guides={[60, 30]}
                decimals={0}
                color="#19e6d0"
              />
              <StatsGraph
                ref={gpu}
                label="GPU"
                unit="мс"
                guides={[8.33, 16.67]}
                warnAbove={12}
                decimals={1}
              />
            </div>
            <Readout label="Сетка" value="31 × 31" />
            <Readout label="Качество" value="high" tone="ok" />
            <Readout label="Пропуски кадров" value="12%" tone="warn" />
          </Card>

          <Card title="Слайдеры: состояния">
            <div className="pv-well">
              <Slider
                label="Обычный"
                value={big}
                onChange={setBig}
                min={0}
                max={1}
                step={0.01}
                default={0.5}
                path="demo.normal"
                hint="Двойной клик по подписи сбрасывает значение."
              />
              <Slider
                label="Modulated"
                value={energy}
                onChange={setEnergy}
                min={0}
                max={3}
                step={0.01}
                default={1}
                effective={eff}
                path="animation.energy"
                hint="Эффективное значение двигается модулятором."
              />
              <Slider
                label="Лог. масштаб"
                value={zoom}
                onChange={setZoom}
                min={0.25}
                max={4}
                scale="log"
                default={1}
                decimals={2}
              />
              <Slider label="Отключён" value={0.3} onChange={() => {}} min={0} max={1} disabled />
              <Slider
                label="Очень длинная подпись параметра"
                value={0.7}
                onChange={() => {}}
                min={0}
                max={1}
                step={0.01}
                unit="px"
              />
            </div>
          </Card>
        </div>
      </main>

      <div className="pv-dock">
        <Panel
          title="Стенд"
          subtitle="pixel-life · образец панели"
          side="right"
          width={360}
          collapsed={collapsed}
          onCollapsedChange={setCollapsed}
          headerActions={
            <>
              <IconButton icon="download" label="Экспорт" />
              <IconButton icon="upload" label="Импорт" />
            </>
          }
          search={
            <SearchInput
              value={search}
              onChange={setSearch}
              count={denseShown.length}
              placeholder="Поиск параметра…"
            />
          }
          footer={
            <div className="pv-foot">
              <Button size="sm" variant="ghost" icon="reset">
                Сбросить всё
              </Button>
              <Button size="sm" variant="primary" icon="copy">
                Копировать
              </Button>
            </div>
          }
        >
          {show('сетка grid колонки gap шаг') && (
            <Section title="Сетка">
              <Segmented
                label="Размер"
                value={sizing}
                onChange={setSizing}
                default="columns"
                options={[
                  { value: 'pitch', label: 'Шаг в px' },
                  { value: 'columns', label: 'Число колонок' },
                ]}
              />
              {sizing === 'columns' ? (
                <Slider
                  label="Колонки"
                  value={columns}
                  onChange={setColumns}
                  min={8}
                  max={200}
                  step={1}
                  default={31}
                  path="grid.columns"
                  hint="Число колонок сетки по ширине хоста."
                />
              ) : (
                <Slider
                  label="Шаг"
                  value={pitch}
                  onChange={setPitch}
                  min={4}
                  max={96}
                  step={1}
                  unit="px"
                  default={24}
                  path="grid.pitch"
                />
              )}
              <Slider
                label="Зазор"
                value={gap}
                onChange={setGap}
                min={0.02}
                max={0.6}
                step={0.01}
                default={0.27}
                path="grid.gap"
                hint="Доля шага между телами клеток."
              />
              <Slider
                label="Зум"
                value={zoom}
                onChange={setZoom}
                min={0.25}
                max={4}
                scale="log"
                default={1}
                path="scene.zoom"
              />
              <Vec2Pad
                label="Центр"
                value={center}
                onChange={setCenter}
                min={-1}
                max={1}
                step={0.01}
                default={[-0.02, -0.02]}
                path="scene.center"
                hint="Центр композиции, единицы режима."
              />
            </Section>
          )}

          {show('режим сфера sphere вес радиус') && (
            <Section
              title="Сфера"
              dimmed={weightSphere === 0}
              header={
                <Slider
                  label="Вес"
                  value={weightSphere}
                  onChange={setWeightSphere}
                  min={0}
                  max={1}
                  step={0.01}
                  default={1}
                  path="modes.sphere.weight"
                />
              }
            >
              <Slider
                label="Радиус"
                value={radius}
                onChange={setRadius}
                min={0.1}
                max={1.6}
                step={0.01}
                default={0.66}
              />
              <Slider
                label="Дыра"
                value={hole}
                onChange={setHole}
                min={0}
                max={0.9}
                step={0.01}
                default={0.24}
              />
              <AngleInput
                label="Наклон"
                value={tilt}
                onChange={setTilt}
                min={-60}
                max={60}
                default={20}
                path="modes.sphere.tilt"
              />
              <Grid columns={3}>
                <Knob
                  layout="stack"
                  label="Свет"
                  value={light}
                  onChange={setLight}
                  default={0.45}
                  min={0}
                  max={1}
                  step={0.01}
                />
                <Knob
                  layout="stack"
                  label="Rim"
                  value={rim}
                  onChange={setRim}
                  default={1.3}
                  min={0.3}
                  max={6}
                  step={0.1}
                />
                <Knob
                  layout="stack"
                  label="Wobble"
                  value={wobble}
                  onChange={setWobble}
                  default={0.08}
                  min={0}
                  max={0.3}
                  step={0.01}
                  effective={Math.min(0.3, wobble + 0.04)}
                />
              </Grid>
            </Section>
          )}

          {show('режим пульсация pulse вес') && (
            <Section
              title="Пульсация"
              dimmed={weightPulse === 0}
              advanced
              header={
                <Slider
                  label="Вес"
                  value={weightPulse}
                  onChange={setWeightPulse}
                  min={0}
                  max={1}
                  step={0.01}
                  default={0}
                />
              }
              defaultOpen={false}
            >
              <Slider
                label="Частота"
                value={freq}
                onChange={setFreq}
                min={0.5}
                max={12}
                step={0.1}
                default={3}
              />
              <Knob
                label="Ширина"
                value={width}
                onChange={setWidth}
                min={0.02}
                max={0.6}
                step={0.01}
                default={0.14}
              />
            </Section>
          )}

          {show('цвет палитра color palette фон') && (
            <Section title="Цвет">
              <PaletteEditor
                label="Палитра"
                value={palette}
                onChange={setPalette}
                interpolation={interp}
                maxStops={32}
                default={REFERENCE_PALETTE}
                quickPalettes={QUICK}
                path="color.palette"
                hint="Стопы вдоль оси; интерполяция в OKLab."
              />
              <Segmented
                label="Интерполяция"
                value={interp}
                onChange={setInterp}
                default="oklab"
                options={['oklab', 'linear', 'steps']}
              />
              <AngleInput
                label="Угол оси"
                value={angle}
                onChange={setAngle}
                default={32}
                path="color.angle"
                hint="0° — вправо, по часовой."
              />
              <ColorInput
                label="Фон"
                value={bg}
                onChange={setBg}
                default="#000032"
                path="background.color"
              />
              <Select
                label="Смешение"
                value={blend}
                onChange={setBlend}
                default="screen"
                options={[
                  { value: 'screen', label: 'Screen' },
                  { value: 'add', label: 'Сложение' },
                  { value: 'max', label: 'Максимум' },
                ]}
              />
              <Slider
                label="Скорость"
                value={speed}
                onChange={setSpeed}
                min={0}
                max={4}
                step={0.01}
                default={1}
              />
            </Section>
          )}

          {show('свечение glow bloom halo') && (
            <Section title="Свечение">
              <Slider
                label="Bloom"
                value={bloom}
                onChange={setBloom}
                min={0}
                max={2}
                step={0.01}
                default={0.35}
              />
              <Slider
                label="Halo"
                value={halo}
                onChange={setHalo}
                min={0}
                max={2}
                step={0.01}
                default={0.55}
              />
            </Section>
          )}

          {show('всплывающие lift pointer тумблер') && (
            <Section title="Интерактив">
              <Toggle
                label="Всплывающие"
                checked={lift}
                onChange={setLift}
                default
                path="lift.enabled"
                hint="Клетки поднимаются над сеткой."
              />
              <Toggle label="Указатель" checked={pointer} onChange={setPointer} default={false} />
              <Toggle label="Отключено" checked disabled onChange={() => {}} />
              <div className="pv-header-switch">
                <span>Bare Switch</span>
                <Switch checked={lift} onChange={setLift} aria-label="Пример Switch" />
              </div>
            </Section>
          )}

          <Divider />

          <Section
            title={`Плотность: ${denseShown.length} из ${DENSE.length}`}
            advanced
            defaultOpen
          >
            {denseShown.length === 0 && <EmptyState>Ничего не найдено</EmptyState>}
            {denseShown.map((d) => (
              <Slider
                key={d.key}
                label={d.label}
                value={dense[d.key] ?? d.def}
                onChange={(v) => setDense((s) => ({ ...s, [d.key]: v }))}
                min={d.min}
                max={d.max}
                step={d.step}
                scale={d.scale}
                default={d.def}
                path={d.key}
                hint={`Сгенерированный параметр ${d.key}`}
              />
            ))}
          </Section>
        </Panel>
      </div>

      <Modal
        open={modal}
        onClose={() => setModal(false)}
        title="Импорт конфигурации"
        description="Вставьте JSON или перетащите файл. Неизвестные ключи будут отброшены."
        footer={
          <>
            <Button variant="ghost" onClick={() => setModal(false)}>
              Отмена
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setModal(false);
                toasts.push('Конфиг применён', { tone: 'success' });
              }}
            >
              Применить
            </Button>
          </>
        }
      >
        <FileDrop />
        <div style={{ height: 10 }} />
        <ColorInput label="Цвет в окне" value={bg} onChange={setBg} />
      </Modal>

      <ToastList items={toasts.toasts} onDismiss={toasts.dismiss} />
    </div>
  );
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
