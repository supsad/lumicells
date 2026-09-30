/**
 * Stress bench: N animated card backgrounds on one page, three ways.
 *
 * - `lumicells`: one LumiCells instance per card. Every instance owns a WebGL2 context, and
 *   browsers keep only about 16 live contexts per page (Chrome evicts the oldest one when a new
 *   one is created), so this mode shows what happens past that limit.
 * - `shared`: one WebGL2 canvas renders a simple pixel-grid shader once per frame; each card is a
 *   2D canvas filled with drawImage() from it (see shared.ts).
 * - `mirror`: the same copy technique, but the source is ONE real LumiCells instance: the full
 *   look for N cards at the cost of one context (all cards show the same animation).
 *
 * URL parameters are documented in stress.html. `window.bench` is the automation surface:
 * `measure(ms)` records frame pacing, main-thread and GPU cost, context churn and memory over a
 * window; `snapshot()` returns the instantaneous state; `scrollThrough()` scrolls the whole page
 * down and back up and reports, per step, whether the visible cards are live or on the poster.
 */

import { LumiCells, onBeforeFrame, PRESET_IDS, type PresetId, type Stats } from 'lumicells';
import { installContextProbe } from './probe';
import { drawCover, type SharedCard, SharedRenderer } from './shared';

// The probe must patch getContext before the first instance (or the support probe) runs.
const probe = installContextProbe();

// -------------------------------------------------------------------------------------------
// Parameters

type Mode = 'lumicells' | 'shared' | 'mirror';
type Layout = 'visible' | 'scroll';

const qs = new URLSearchParams(location.search);
const presetParam = qs.get('preset') ?? 'reference';
const params = {
  n: clampInt(qs.get('n'), 1, 1000, 16),
  layout: (qs.get('layout') === 'scroll' ? 'scroll' : 'visible') as Layout,
  mode: (['shared', 'mirror'].includes(qs.get('mode') ?? '')
    ? qs.get('mode')
    : 'lumicells') as Mode,
  preset: ((PRESET_IDS as readonly string[]).includes(presetParam)
    ? presetParam
    : 'reference') as PresetId,
  pauseOffscreen: qs.get('pauseOffscreen') !== '0',
  hud: qs.get('hud') !== '0',
};

function clampInt(v: string | null, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Card CSS size per layout (must match stress.html). */
const CARD = params.layout === 'visible' ? { w: 130, h: 80 } : { w: 320, h: 200 };
const DPR = Math.min(2, window.devicePixelRatio || 1);

// -------------------------------------------------------------------------------------------
// Warnings: the library's console.warn plus its 'warn' events. The browser's own
// "Too many active WebGL contexts" message never reaches page scripts; the driver collects it
// from the DevTools console.

const pageWarnings = new Map<string, number>();
const origWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  const msg = args.map(String).join(' ').slice(0, 200);
  pageWarnings.set(msg, (pageWarnings.get(msg) ?? 0) + 1);
  origWarn(...args);
};
const warnCodes = new Map<string, number>();

// -------------------------------------------------------------------------------------------
// Frame recording

interface Recording {
  deltas: number[];
  /** Main-thread time of the page's own per-frame work (ticker frame or shared copy loop). */
  work: number[];
}
let rec: Recording | null = null;
let lastRaf = -1;
function rafLoop(now: number): void {
  if (rec && lastRaf >= 0) rec.deltas.push(now - lastRaf);
  lastRaf = now;
  requestAnimationFrame(rafLoop);
}
requestAnimationFrame(rafLoop);

interface LongTask {
  start: number;
  duration: number;
}
const longTasks: LongTask[] = [];
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) longTasks.push({ start: e.startTime, duration: e.duration });
  }).observe({ type: 'longtask', buffered: true });
} catch {
  // Long Tasks API unavailable (Firefox, Safari).
}

// -------------------------------------------------------------------------------------------
// Cards

document.body.className = params.layout;
const grid = document.getElementById('grid') as HTMLElement;
const hud = document.getElementById('hud') as HTMLElement;

interface Card {
  host: HTMLElement;
  visible: boolean;
}
const cards: Card[] = [];
for (let i = 0; i < params.n; i++) {
  const host = document.createElement('div');
  host.className = 'card';
  const label = document.createElement('b');
  label.textContent = String(i);
  host.appendChild(label);
  grid.appendChild(host);
  cards.push({ host, visible: false });
}
const cardIndex = new Map<Element, Card>(cards.map((c) => [c.host, c]));
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const c = cardIndex.get(e.target);
    if (c) c.visible = e.isIntersecting;
  }
});
for (const c of cards) io.observe(c.host);

// -------------------------------------------------------------------------------------------
// Mode setup

interface Entry {
  cells: LumiCells;
  card: Card;
  readyAt: number;
  stats: Stats | null;
  statsAt: number;
  lost: number;
  restored: number;
  fallbacks: number;
  errors: number;
}

const t0 = performance.now();
const entries: Entry[] = [];
let shared: SharedRenderer | null = null;
let sharedCards: (SharedCard & { card: Card })[] = [];
let mirrorSource: Entry | null = null;
let firstCopyAt = -1;

function watch(cells: LumiCells, card: Card): Entry {
  const e: Entry = {
    cells,
    card,
    readyAt: -1,
    stats: null,
    statsAt: 0,
    lost: 0,
    restored: 0,
    fallbacks: 0,
    errors: 0,
  };
  cells.on('ready', () => {
    e.readyAt = performance.now() - t0;
  });
  cells.on('stats', (s) => {
    e.stats = s;
    e.statsAt = performance.now();
  });
  cells.on('contextlost', () => e.lost++);
  cells.on('contextrestored', () => e.restored++);
  cells.on('fallback', () => e.fallbacks++);
  cells.on('error', () => e.errors++);
  cells.on('warn', ({ code }) => warnCodes.set(code, (warnCodes.get(code) ?? 0) + 1));
  return e;
}

function makeCardCanvas(card: Card): SharedCard & { card: Card } {
  const canvas = document.createElement('canvas');
  canvas.className = 'mirror';
  canvas.width = Math.round(CARD.w * DPR);
  canvas.height = Math.round(CARD.h * DPR);
  card.host.insertBefore(canvas, card.host.firstChild);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('2D canvas is not available');
  return {
    canvas,
    ctx,
    card,
    get visible() {
      return card.visible;
    },
  };
}

const renderConfig = { render: { pauseOffscreen: params.pauseOffscreen } };

if (params.mode === 'lumicells') {
  for (const card of cards) {
    const cells = new LumiCells(card.host, { preset: params.preset, config: renderConfig });
    entries.push(watch(cells, card));
  }
  onBeforeFrame(() => {
    const r = rec;
    if (!r) return;
    const start = performance.now();
    // Microtasks run right after the ticker's rAF callback: this measures the whole frame
    // (every instance's measure + render phase).
    queueMicrotask(() => r.work.push(performance.now() - start));
  });
} else if (params.mode === 'shared') {
  shared = new SharedRenderer(Math.round(320 * DPR), Math.round(200 * DPR));
  sharedCards = cards.map(makeCardCanvas);
  const renderer = shared;
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    const start = performance.now();
    renderer.frame((now - t0) / 1000, sharedCards, params.pauseOffscreen);
    if (firstCopyAt < 0) firstCopyAt = performance.now() - t0;
    rec?.work.push(performance.now() - start);
  };
  requestAnimationFrame(loop);
} else {
  const sourceHost = document.createElement('div');
  sourceHost.id = 'mirror-source';
  document.body.appendChild(sourceHost);
  const source = new LumiCells(sourceHost, {
    preset: params.preset,
    // The source is invisible by design: it must never pause.
    config: { render: { pauseOffscreen: false } },
  });
  mirrorSource = watch(source, { host: sourceHost, visible: true });
  sharedCards = cards.map(makeCardCanvas);
  onBeforeFrame(() => {
    const start = performance.now();
    const r = rec;
    // After the ticker's render phase, in the same task: the source's drawing buffer is valid.
    queueMicrotask(() => {
      const src = source.canvas;
      if (src && mirrorSource && mirrorSource.readyAt >= 0 && src.width > 0) {
        for (const c of sharedCards) {
          if (params.pauseOffscreen && !c.visible) continue;
          drawCover(c.ctx, src, c.canvas.width, c.canvas.height);
        }
        if (firstCopyAt < 0) firstCopyAt = performance.now() - t0;
      }
      r?.work.push(performance.now() - start);
    });
  });
}

// -------------------------------------------------------------------------------------------
// Measurements

const STATS_FRESH_MS = 700;

function isFresh(e: Entry, now: number): boolean {
  return e.stats !== null && now - e.statsAt < STATS_FRESH_MS;
}

function posterOn(host: HTMLElement): boolean {
  return host.style.getPropertyValue('background-image') !== '';
}

function contextAlive(canvas: HTMLCanvasElement | null): boolean {
  const gl = canvas ? probe.contextOf(canvas) : undefined;
  return !!gl && !gl.isContextLost();
}

function snapshot() {
  const now = performance.now();
  let live = 0;
  let poster = 0;
  let rendering = 0;
  let ready = 0;
  let visible = 0;
  let visibleLive = 0;
  let visiblePoster = 0;
  let webglBytes = 0;
  let canvas2dBytes = 0;
  let lostCanvas = 0;
  let readyAllMs: number | null = null;

  if (params.mode === 'lumicells') {
    let maxReady = 0;
    for (const e of entries) {
      const canvas = e.cells.canvas;
      const alive = contextAlive(canvas);
      const onPoster = posterOn(e.card.host);
      // A lost context's canvas stays in the card and paints over the poster.
      if (canvas && !alive) lostCanvas++;
      const isLive = alive && !onPoster;
      if (isLive) live++;
      if (onPoster) poster++;
      if (isFresh(e, now)) rendering++;
      if (e.readyAt >= 0) {
        ready++;
        maxReady = Math.max(maxReady, e.readyAt);
      }
      if (e.card.visible) {
        visible++;
        if (isLive) visibleLive++;
        if (onPoster) visiblePoster++;
      }
      // Default context: color buffer + a separate presentation buffer (x2).
      if (alive && canvas) webglBytes += canvas.width * canvas.height * 4 * 2;
    }
    if (ready === entries.length) readyAllMs = Math.round(maxReady);
  } else {
    const src = shared?.canvas ?? mirrorSource?.cells.canvas ?? null;
    const srcAlive = shared ? !shared.gl.isContextLost() : contextAlive(src);
    if (src && srcAlive) webglBytes += src.width * src.height * 4 * 2;
    for (const c of sharedCards) {
      canvas2dBytes += c.canvas.width * c.canvas.height * 4;
      if (srcAlive) live++;
      else poster++;
      if (c.card.visible) {
        visible++;
        if (srcAlive) visibleLive++;
        else visiblePoster++;
      }
    }
    rendering = srcAlive ? cards.length : 0;
    ready = firstCopyAt >= 0 ? cards.length : 0;
    if (firstCopyAt >= 0) readyAllMs = Math.round(firstCopyAt);
  }

  const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return {
    instances: {
      n: cards.length,
      live,
      poster,
      rendering,
      ready,
      visible,
      visibleLive,
      visiblePoster,
      lostCanvas,
    },
    readyAllMs,
    contexts: { ...probe.counters, liveNow: probe.liveNow() },
    memory: {
      usedJSHeapMB: mem ? round(mem.usedJSHeapSize / 1048576, 1) : null,
      webglBuffersMB: round(webglBytes / 1048576, 2),
      canvas2dMB: round(canvas2dBytes / 1048576, 2),
      drawingBuffersMB: round((webglBytes + canvas2dBytes) / 1048576, 2),
    },
  };
}

/** Sum of per-instance CPU (update + render submit) and GPU times of the instances drawing now. */
function sampleCost(): { cpu: number; gpu: number | null; gpuReporting: number } {
  const now = performance.now();
  if (params.mode === 'shared') {
    return { cpu: 0, gpu: shared?.gpuMs ?? null, gpuReporting: shared?.gpuMs != null ? 1 : 0 };
  }
  const list = params.mode === 'mirror' && mirrorSource ? [mirrorSource] : entries;
  let cpu = 0;
  let gpu = 0;
  let gpuReporting = 0;
  for (const e of list) {
    if (!isFresh(e, now) || !e.stats) continue;
    cpu += e.stats.cpuMs;
    if (e.stats.gpuMs !== null) {
      gpu += e.stats.gpuMs;
      gpuReporting++;
    }
  }
  return { cpu, gpu: gpuReporting > 0 ? gpu : null, gpuReporting };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function round(v: number, digits = 2): number {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
}

function mean(v: number[]): number {
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}

function frameSummary(deltas: number[]) {
  const sorted = [...deltas].sort((a, b) => a - b);
  const total = deltas.reduce((a, b) => a + b, 0);
  const med = pct(sorted, 0.5);
  return {
    frames: deltas.length,
    fps: total > 0 ? round((deltas.length * 1000) / total, 1) : 0,
    frameMsMedian: round(med),
    frameMsP95: round(pct(sorted, 0.95)),
    frameMsMax: round(sorted[sorted.length - 1] ?? 0),
    /** Share of frames that took longer than 1.5 median frames (dropped vsyncs). */
    jankRatio: round(deltas.filter((d) => d > med * 1.5).length / Math.max(1, deltas.length), 3),
  };
}

async function measure(ms = 5000) {
  const r: Recording = { deltas: [], work: [] };
  const c0 = { ...probe.counters };
  const cpu: number[] = [];
  const gpu: number[] = [];
  let gpuReporting = 0;
  const timeline: { t: number; liveContexts: number; lost: number; created: number }[] = [];
  const start = performance.now();
  rec = r;
  const iv = setInterval(() => {
    const s = sampleCost();
    cpu.push(s.cpu);
    if (s.gpu !== null) gpu.push(s.gpu);
    gpuReporting = Math.max(gpuReporting, s.gpuReporting);
    timeline.push({
      t: Math.round(performance.now() - start),
      liveContexts: probe.liveNow(),
      lost: probe.counters.lost - c0.lost,
      created: probe.counters.created - c0.created,
    });
  }, 250);
  await sleep(ms);
  clearInterval(iv);
  rec = null;
  const end = performance.now();
  const lt = longTasks.filter((t) => t.start >= start && t.start < end);
  const workSorted = [...r.work].sort((a, b) => a - b);
  const c1 = probe.counters;
  return {
    params,
    dpr: DPR,
    windowMs: Math.round(end - start),
    ...frameSummary(r.deltas),
    workMsMean: round(mean(r.work)),
    workMsP95: round(pct(workSorted, 0.95)),
    cpuMsSum: round(mean(cpu)),
    gpuMsSum: gpu.length ? round(mean(gpu)) : null,
    gpuReporting,
    longTasks: { count: lt.length, totalMs: Math.round(lt.reduce((a, t) => a + t.duration, 0)) },
    contextChurnInWindow: {
      created: c1.created - c0.created,
      lost: c1.lost - c0.lost,
      restored: c1.restored - c0.restored,
    },
    ...snapshot(),
    pageWarnings: Object.fromEntries(pageWarnings),
    warnEvents: Object.fromEntries(warnCodes),
    instanceEvents: summarizeEvents(),
    timeline,
  };
}

function summarizeEvents() {
  const list = mirrorSource ? [mirrorSource] : entries;
  let lost = 0;
  let restored = 0;
  let fallbacks = 0;
  let errors = 0;
  let lostInstances = 0;
  let lostFirstIndex = -1;
  let lostLastIndex = -1;
  list.forEach((e, i) => {
    lost += e.lost;
    restored += e.restored;
    fallbacks += e.fallbacks;
    errors += e.errors;
    if (e.lost > 0) {
      lostInstances++;
      if (lostFirstIndex < 0) lostFirstIndex = i;
      lostLastIndex = i;
    }
  });
  return { lost, restored, fallbacks, errors, lostInstances, lostFirstIndex, lostLastIndex };
}

/** Scrolls the page down to the end and back up, dwelling on each screen. */
async function scrollThrough(opts: { dwellMs?: number; stepFraction?: number } = {}) {
  const dwell = opts.dwellMs ?? 700;
  const step = Math.max(1, Math.round(innerHeight * (opts.stepFraction ?? 0.8)));
  const maxY = Math.max(0, document.documentElement.scrollHeight - innerHeight);
  const ys: number[] = [];
  for (let y = 0; y < maxY; y += step) ys.push(y);
  ys.push(maxY);
  for (let i = ys.length - 2; i >= 0; i--) ys.push(ys[i] as number);
  const c0 = { ...probe.counters };
  const steps = [];
  for (const y of ys) {
    scrollTo(0, y);
    const r: Recording = { deltas: [], work: [] };
    rec = r;
    await sleep(dwell);
    rec = null;
    const s = snapshot();
    const f = frameSummary(r.deltas);
    steps.push({
      y,
      fps: f.fps,
      frameMsP95: f.frameMsP95,
      visible: s.instances.visible,
      visibleLive: s.instances.visibleLive,
      visiblePoster: s.instances.visiblePoster,
      rendering: s.instances.rendering,
      liveContexts: s.contexts.liveNow,
      created: s.contexts.created - c0.created,
      lost: s.contexts.lost - c0.lost,
      evicted: s.contexts.evicted - c0.evicted,
      restored: s.contexts.restored - c0.restored,
    });
  }
  scrollTo(0, 0);
  const c1 = probe.counters;
  return {
    params,
    steps,
    totals: {
      created: c1.created - c0.created,
      lost: c1.lost - c0.lost,
      evicted: c1.evicted - c0.evicted,
      restored: c1.restored - c0.restored,
      stepsWithVisiblePoster: steps.filter((s) => s.visiblePoster > 0).length,
      maxVisiblePoster: Math.max(0, ...steps.map((s) => s.visiblePoster)),
      minFps: Math.min(...steps.map((s) => s.fps)),
    },
    end: snapshot(),
  };
}

// -------------------------------------------------------------------------------------------
// Automation surface + status line

const bench = { params, t0, measure, snapshot, scrollThrough };
declare global {
  interface Window {
    bench: typeof bench;
  }
}
window.bench = bench;

if (params.hud) {
  hud.hidden = false;
  let last = performance.now();
  let frames = 0;
  const tick = () => {
    frames++;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  setInterval(() => {
    const now = performance.now();
    const fps = (frames * 1000) / (now - last);
    frames = 0;
    last = now;
    const s = snapshot();
    const c = sampleCost();
    hud.textContent =
      `${params.mode} n=${params.n} ${params.layout} pauseOffscreen=${params.pauseOffscreen ? 1 : 0}\n` +
      `fps ${fps.toFixed(0)}  cpu ${c.cpu.toFixed(2)} ms  gpu ${c.gpu?.toFixed(2) ?? 'n/a'} ms\n` +
      `live ${s.instances.live}  poster ${s.instances.poster}  ready ${s.instances.ready}\n` +
      `contexts live ${s.contexts.liveNow} created ${s.contexts.created} lost ${s.contexts.lost}`;
  }, 500);
}
