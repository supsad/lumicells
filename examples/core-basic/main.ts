/**
 * Vanilla usage of the core: a fullscreen background with JS-animated bubbles bound as lights,
 * a title bound as a shadow, click ripples and hover lifts, plus a card-sized second instance
 * whose floating pixels leave its bounds (render.overflow).
 *
 * Exposed for automated checks: window.pl, window.card, window.recreate(n), window.bench().
 */

import { type InfluenceHandle, onBeforeFrame, PixelLife, type Stats } from 'pixel-life';

const bg = document.getElementById('bg') as HTMLElement;
const title = document.getElementById('title') as HTMLElement;
const cardHost = document.getElementById('card') as HTMLElement;
const hudText = document.getElementById('hud-text') as HTMLElement;

const BUBBLES = [
  { label: 'путешествия', blue: false, ax: 0.62, ay: 0.3, wx: 0.21, wy: 0.33, p: 0.0 },
  { label: 'музыка', blue: true, ax: 0.5, ay: 0.42, wx: 0.17, wy: 0.26, p: 1.7 },
  { label: 'наука', blue: true, ax: 0.7, ay: 0.36, wx: 0.13, wy: 0.19, p: 3.1 },
  { label: 'еда', blue: false, ax: 0.44, ay: 0.55, wx: 0.24, wy: 0.15, p: 4.4 },
  { label: 'спорт', blue: false, ax: 0.8, ay: 0.25, wx: 0.11, wy: 0.29, p: 5.6 },
  { label: 'кино', blue: true, ax: 0.35, ay: 0.62, wx: 0.28, wy: 0.21, p: 2.4 },
];

const RED = '#ee2848';
const BLUE = '#0481f5';

// -------------------------------------------------------------------------------------------
// Bubbles: plain buttons moved by JS before the background measures them (no lag).

const bubbles = BUBBLES.map((b) => {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = b.blue ? 'bubble blue' : 'bubble';
  el.textContent = b.label;
  bg.appendChild(el);
  return { ...b, el };
});

let t0 = -1;
onBeforeFrame((now) => {
  if (t0 < 0) t0 = now;
  const t = (now - t0) / 1000;
  const w = bg.clientWidth;
  const h = bg.clientHeight;
  const r = Math.min(w, h) / 2;
  for (const b of bubbles) {
    const x = w / 2 + Math.cos(t * b.wx * Math.PI * 2 + b.p) * b.ax * r * 1.25;
    const y = h / 2 + Math.sin(t * b.wy * Math.PI * 2 + b.p * 1.3) * b.ay * r * 1.6;
    b.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
  }
});

// -------------------------------------------------------------------------------------------
// Instances

function createMain(): PixelLife {
  const pl = new PixelLife(bg, { config: { interaction: { pointer: pointerOn } } });
  const handles: InfluenceHandle[] = [];
  for (const b of bubbles) {
    handles.push(
      pl.bindElement(b.el, {
        track: 'frame',
        type: 'light',
        color: b.blue ? BLUE : RED,
        colorMix: 0.55,
        strength: 1.1,
        falloff: 1.5,
        padding: 4,
      }),
    );
  }
  handles.push(
    pl.bindElement(title, {
      type: 'shadow',
      track: 'auto',
      strength: 0.95,
      falloff: 2.5,
      padding: 10,
    }),
  );
  pl.on('stats', (s) => {
    mainStats = s;
    renderHud();
  });
  pl.on('ready', () => console.info('[core-basic] main ready'));
  pl.on('warn', (w) => console.warn('[core-basic] warn', w.code, w.message));
  pl.on('error', (e) => console.error('[core-basic] error', e));
  pl.on('fallback', (f) => console.info('[core-basic] fallback', f.reason));
  pl.on('contextlost', () => console.info('[core-basic] context lost'));
  pl.on('contextrestored', () => console.info('[core-basic] context restored'));
  pl.on('quality', (q) => console.info('[core-basic] quality', q.quality, q.scale, q.reason));
  return pl;
}

function createCard(): PixelLife {
  const pl = new PixelLife(cardHost, {
    config: {
      grid: { count: 14 },
      render: { overflow: 60 },
      lift: {
        style: 'float',
        amount: 0.05,
        floatSpeed: 1.4,
        floatDrift: 0.5,
        holdMin: 1.2,
        holdMax: 2.4,
      },
      interaction: { click: true },
    },
  });
  pl.on('stats', (s) => {
    cardStats = s;
    renderHud();
  });
  return pl;
}

let pointerOn = true;
let mainStats: Stats | null = null;
let cardStats: Stats | null = null;
let pl = createMain();
const card = createCard();

// Bubble interactions: click -> colored ripple, hover -> a burst of lifts around the bubble.
for (const b of bubbles) {
  b.el.addEventListener('click', () => {
    const r = b.el.getBoundingClientRect();
    pl.pulse({
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      space: 'client',
      color: b.blue ? BLUE : RED,
      strength: 1.2,
    });
  });
  b.el.addEventListener('pointerenter', () => {
    const r = b.el.getBoundingClientRect();
    pl.lift({
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      space: 'client',
      count: 6,
      radius: 2.5,
    });
  });
}

// -------------------------------------------------------------------------------------------
// HUD

function fmt(s: Stats | null, name: string): string {
  if (!s) return `${name}: …`;
  const gpu = s.gpuMs === null ? 'н/д' : `${s.gpuMs.toFixed(2)} мс`;
  return [
    `${name}: ${s.fps.toFixed(0)} FPS  кадр ${s.frameMs.toFixed(2)} мс`,
    `  CPU ${s.cpuMs.toFixed(3)} мс  GPU ${gpu}  vsync ${s.vsyncMs} мс  промахи ${(s.missRatio * 100).toFixed(0)}%`,
    `  ${s.quality} × ${s.scale}  dpr ${s.dpr.toFixed(2)}  ${(s.pixels / 1e6).toFixed(2)} Мп  сетка ${s.cols}×${s.rows}`,
    `  подъёмы ${s.lifts}  влияния ${s.influences}${s.softwareFallback ? '  ПРОГРАММНЫЙ GL' : ''}`,
  ].join('\n');
}

function renderHud(): void {
  hudText.textContent = `${fmt(mainStats, 'фон')}\n${fmt(cardStats, 'карточка')}`;
}

// -------------------------------------------------------------------------------------------
// Controls

async function nextFrames(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r));
}

async function recreate(n = 20): Promise<number> {
  for (let i = 0; i < n; i++) {
    pl.destroy();
    pl = createMain();
    Object.assign(window, { pl });
    await nextFrames(3);
  }
  return document.querySelectorAll('canvas').length;
}

/** Average CPU ms of one instance's frame (controller.update + engine submit) over `ms`. */
async function bench(ms = 3000): Promise<{ main: number; card: number; fps: number }> {
  const samples: number[] = [];
  const cards: number[] = [];
  const offA = pl.on('stats', (s) => samples.push(s.cpuMs));
  const offB = card.on('stats', (s) => cards.push(s.cpuMs));
  await new Promise((r) => setTimeout(r, ms));
  offA();
  offB();
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  return { main: avg(samples), card: avg(cards), fps: pl.getStats().fps };
}

document.getElementById('btn-lose')?.addEventListener('click', () => pl.loseContextForTesting());
document.getElementById('btn-recreate')?.addEventListener('click', () => {
  void recreate(20).then((n) => console.info('[core-basic] canvases after recreate', n));
});
document.getElementById('btn-radius')?.addEventListener('click', () => {
  pl.set('modes.sphere.radius', pl.get('modes.sphere.radius') > 0.5 ? 0.3 : 0.66);
});
document.getElementById('btn-pointer')?.addEventListener('click', () => {
  pointerOn = !pointerOn;
  pl.set('interaction.pointer', pointerOn);
});

Object.assign(window, { pl, card, recreate, bench, PixelLife });
