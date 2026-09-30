/**
 * Stress bench: N animated card backgrounds on one page, three ways.
 *
 * - `lumicells`: one LumiCells instance per card. With `renderer=own` (default) a live instance
 *   owns a WebGL2 context and browsers keep only about 16 per page (Chrome evicts the oldest one
 *   when a new one is created); the library's context budget (LumiCells.configure,
 *   maxContexts=N here) keeps the page below that, so the cards past the budget show their
 *   poster. With `renderer=shared` every card is a member of the library's shared renderer: one
 *   context for all of them, drawn into an atlas and copied into each card's 2D canvas (`own=N`
 *   keeps the first N cards on contexts of their own: a mixed page).
 * - `shared`: one WebGL2 canvas renders a simple pixel-grid shader once per frame; each card is a
 *   2D canvas filled with drawImage() from it (see shared.ts).
 * - `mirror`: the same copy technique, but the source is ONE real LumiCells instance: the full
 *   look for N cards at the cost of one context (all cards show the same animation).
 *
 * URL parameters are documented in stress.html. `window.bench` is the automation surface:
 * `measure(ms)` records frame pacing, main-thread and GPU cost, context churn and memory over a
 * window; `snapshot()` returns the instantaneous state; `scrollThrough()` scrolls the whole page
 * down and back up and reports, per step, whether the visible cards are live or on the poster
 * and how long the newly visible ones took to come alive; `mount()` reports the cost of
 * creating the instances (they are created in a task of their own after the page settled, so
 * that task's long task / long animation frame is theirs alone); `lossTest()` forces WebGL
 * context losses on live visible cards and reports what those cards show until the contexts
 * are restored (a lost context's canvas must never paint its blank box over the page).
 */

import {
  type ConfigureOptions,
  type InstanceRenderer,
  LumiCells,
  onBeforeFrame,
  PRESET_IDS,
  type PresetId,
  type SharedRendererStats,
  type Stats,
} from 'lumicells';
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
  /** Renderer of the LumiCells instances (mode=lumicells). */
  renderer: (qs.get('renderer') === 'shared' ? 'shared' : 'own') as InstanceRenderer,
  /** With renderer=shared: the first N cards use their own context (a mixed page). */
  own: clampInt(qs.get('own'), 0, 1000, 0),
  hud: qs.get('hud') !== '0',
  /** LumiCells.configure() overrides (library default when absent). */
  maxContexts: qs.get('maxContexts'),
  parkAfterMs: qs.get('parkAfterMs'),
  createPerFrame: qs.get('createPerFrame'),
  sharedBudget: qs.get('sharedBudget'),
  /** Delay before the instances are created, ms (lets a profiler attach first). */
  mountDelay: clampInt(qs.get('mountDelay'), 0, 60_000, 0),
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

/** One step of scrollThrough(): numbers the report aggregates, plus raw per-step extras. */
interface ScrollStep {
  y: number;
  fps: number;
  frameMsP95: number;
  visible: number;
  visibleLive: number;
  visiblePoster: number;
  visibleDead: number;
  maxVisibleDead: number;
  settleMs: number;
  settleFrames: number;
  maxLiveContexts: number;
  [extra: string]: unknown;
}

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
/** Long animation frames (Chrome 123+): a frame whose tasks + rendering took over 50 ms. */
interface LongFrame extends LongTask {
  blocking: number;
  /** Where the time went: rendering (style/layout/paint) and the longest scripts. */
  renderMs: number;
  styleLayoutMs: number;
  scripts: { invoker: string; fn: string; ms: number }[];
}
interface LoafEntry extends PerformanceEntry {
  blockingDuration?: number;
  renderStart?: number;
  styleAndLayoutStart?: number;
  scripts?: {
    invoker: string;
    sourceFunctionName: string;
    duration: number;
  }[];
}
const longFrames: LongFrame[] = [];
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries() as LoafEntry[]) {
      const end = e.startTime + e.duration;
      const renderStart = e.renderStart ?? 0;
      const slStart = e.styleAndLayoutStart ?? 0;
      longFrames.push({
        start: e.startTime,
        duration: e.duration,
        blocking: e.blockingDuration ?? 0,
        renderMs: renderStart > 0 ? end - renderStart : 0,
        styleLayoutMs: slStart > 0 ? end - slStart : 0,
        scripts: (e.scripts ?? [])
          .map((sc) => ({ invoker: sc.invoker, fn: sc.sourceFunctionName, ms: sc.duration }))
          .sort((a, b) => b.ms - a.ms)
          .slice(0, 4),
      });
    }
  }).observe({ type: 'long-animation-frame', buffered: true });
} catch {
  // LoAF unavailable.
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

/** Set when the instances are created (see mountAll()). */
let t0 = performance.now();
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

/** LumiCells.configure() from the URL (only the given keys; absent means the library default). */
function applyRuntimeParams(): ConfigureOptions {
  const opts: ConfigureOptions = {};
  const num = (v: string | null) => (v === null || v === '' ? null : Number(v));
  const max = num(params.maxContexts);
  if (params.maxContexts === 'auto') opts.maxContexts = 'auto';
  else if (max !== null) opts.maxContexts = max;
  const park = num(params.parkAfterMs);
  if (park !== null) opts.parkAfterMs = park;
  const perFrame = num(params.createPerFrame);
  if (perFrame !== null) opts.createPerFrame = perFrame;
  const budget = num(params.sharedBudget);
  if (params.sharedBudget === 'auto') opts.sharedBudget = 'auto';
  else if (budget !== null) opts.sharedBudget = budget;
  if (Object.keys(opts).length > 0) LumiCells.configure(opts);
  return opts;
}
const runtimeParams = applyRuntimeParams();

const mountInfo = { startAt: -1, syncMs: -1 };

function mountAll(): void {
  if (params.mode === 'lumicells') {
    cards.forEach((card, i) => {
      const renderer = params.renderer === 'shared' && i < params.own ? 'own' : params.renderer;
      const cells = new LumiCells(card.host, {
        preset: params.preset,
        config: renderConfig,
        renderer,
      });
      entries.push(watch(cells, card));
    });
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
}

// The instances are created in a task of their own once the page has painted, so the long task
// (and long animation frame) of that task measures the mount alone, not module evaluation.
requestAnimationFrame(() =>
  setTimeout(() => {
    t0 = performance.now();
    mountInfo.startAt = t0;
    mountAll();
    mountInfo.syncMs = performance.now() - t0;
  }, params.mountDelay),
);

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

function canvasShown(canvas: HTMLCanvasElement): boolean {
  return canvas.style.visibility !== 'hidden' && canvas.style.display !== 'none';
}

/**
 * Whether the browser paints the canvas, from the computed style (page CSS included, not just
 * the inline flag the library sets). Read only for canvases whose context is lost, so the
 * per-frame checks force no style recalculation in the common case.
 */
function canvasPainted(canvas: HTMLCanvasElement): boolean {
  if (!canvas.isConnected) return false;
  const cs = getComputedStyle(canvas);
  return cs.visibility === 'visible' && cs.display !== 'none' && Number(cs.opacity) > 0;
}

type CardLook = 'live' | 'poster' | 'dead' | 'blank' | 'frozen';

/**
 * What a card shows: `live` a drawing canvas; `poster` the CSS poster; `dead` a canvas whose
 * context is gone painted over everything (Chrome draws a white box with a broken-image icon);
 * `frozen` a shared card's 2D canvas holding its last frame while the shared context is lost;
 * `blank` none of these (a canvas that has not drawn yet and no poster).
 */
function cardLook(e: Entry): CardLook {
  const canvas = e.cells.canvas;
  if (e.cells.renderer === 'shared') {
    // A 2D canvas: it never paints a blank box, it keeps whatever was copied last.
    const shown = !!canvas && canvasShown(canvas) && canvas.width > 0;
    if (shown && e.cells.getStats().state === 'lost') return 'frozen';
    if (shown) return 'live';
    return posterOn(e.card.host) ? 'poster' : 'blank';
  }
  if (canvas && !contextAlive(canvas) && canvasPainted(canvas)) return 'dead';
  if (posterOn(e.card.host)) return 'poster';
  return canvas && canvasShown(canvas) ? 'live' : 'blank';
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
  /** Shared cards that are parked (or waiting) but still hold 2D canvas pixels. */
  let parkedWithPixels = 0;
  let sharedStats: SharedRendererStats | null = null;
  let sharedMembers = 0;
  let frozen = 0;
  let lostCanvas = 0;
  let visibleDead = 0;
  let visibleBlank = 0;
  const states: Record<string, number> = {};
  /** Adaptive quality of the live instances: "tier@scale" -> count. */
  const quality: Record<string, number> = {};
  let readyAllMs: number | null = null;

  if (params.mode === 'lumicells') {
    let maxReady = 0;
    for (const e of entries) {
      const canvas = e.cells.canvas;
      const alive = contextAlive(canvas);
      const look = cardLook(e);
      // A lost context's canvas painting over the poster (a white box).
      if (look === 'dead') lostCanvas++;
      const isLive = look === 'live';
      const onPoster = look === 'poster';
      if (isLive) live++;
      if (onPoster) poster++;
      if (isFresh(e, now)) rendering++;
      if (e.readyAt >= 0) {
        ready++;
        maxReady = Math.max(maxReady, e.readyAt);
      }
      const st = e.cells.getStats();
      const state = st.state;
      if (state) states[state] = (states[state] ?? 0) + 1;
      if (look === 'frozen') frozen++;
      if (state === 'live') {
        const q = `${st.quality}@${st.scale}`;
        quality[q] = (quality[q] ?? 0) + 1;
      }
      if (st.renderer === 'shared') {
        sharedMembers++;
        if (st.shared && st.shared.atlasWidth > 0) sharedStats = st.shared;
        const px = canvas ? canvas.width * canvas.height : 0;
        canvas2dBytes += px * 4;
        if (px > 0 && state !== 'live' && state !== 'lost') parkedWithPixels++;
      }
      if (e.card.visible) {
        visible++;
        if (isLive) visibleLive++;
        if (onPoster) visiblePoster++;
        if (look === 'dead') visibleDead++;
        if (look === 'blank') visibleBlank++;
      }
      // Default context: color buffer + a separate presentation buffer (x2).
      if (alive && canvas) webglBytes += canvas.width * canvas.height * 4 * 2;
    }
    // The shared atlas: one default framebuffer (x2 like above), counted once.
    const atlas = sharedAtlas();
    if (atlas) webglBytes += atlas.w * atlas.h * 4 * 2;
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
      visibleDead,
      visibleBlank,
      lostCanvas,
      frozen,
      states,
      quality,
    },
    readyAllMs,
    shared:
      sharedMembers > 0
        ? {
            members: sharedMembers,
            parkedWithPixels,
            ...(sharedStats ?? {}),
            atlas: sharedAtlas(),
          }
        : null,
    contexts: { ...probe.counters, liveNow: probe.liveNow(), peakLive: probe.peakLive() },
    memory: {
      usedJSHeapMB: mem ? round(mem.usedJSHeapSize / 1048576, 1) : null,
      webglBuffersMB: round(webglBytes / 1048576, 2),
      canvas2dMB: round(canvas2dBytes / 1048576, 2),
      drawingBuffersMB: round((webglBytes + canvas2dBytes) / 1048576, 2),
    },
  };
}

/** Size of the shared renderer's atlas (from any shared member's stats), or null. */
function sharedAtlas(): { w: number; h: number } | null {
  for (const e of entries) {
    const s = e.cells.getStats().shared;
    if (s && s.atlasWidth > 0) return { w: s.atlasWidth, h: s.atlasHeight };
  }
  return null;
}

/**
 * Sum of per-instance CPU (update + render submit, plus the copy for shared ones) and GPU times
 * of the instances drawing now. The shared device's GPU time is reported by every shared
 * instance: it counts once.
 */
function sampleCost(): { cpu: number; gpu: number | null; gpuReporting: number } {
  const now = performance.now();
  if (params.mode === 'shared') {
    return { cpu: 0, gpu: shared?.gpuMs ?? null, gpuReporting: shared?.gpuMs != null ? 1 : 0 };
  }
  const list = params.mode === 'mirror' && mirrorSource ? [mirrorSource] : entries;
  let cpu = 0;
  let gpu = 0;
  let gpuReporting = 0;
  let sharedGpu: number | null = null;
  for (const e of list) {
    if (!isFresh(e, now) || !e.stats) continue;
    cpu += e.stats.cpuMs;
    if (e.stats.renderer === 'shared') {
      if (e.stats.gpuMs !== null) sharedGpu = e.stats.gpuMs;
      continue;
    }
    if (e.stats.gpuMs !== null) {
      gpu += e.stats.gpuMs;
      gpuReporting++;
    }
  }
  if (sharedGpu !== null) {
    gpu += sharedGpu;
    gpuReporting++;
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
  const copy: number[] = [];
  const draw: number[] = [];
  let gpuReporting = 0;
  const timeline: { t: number; liveContexts: number; lost: number; created: number }[] = [];
  const start = performance.now();
  rec = r;
  const iv = setInterval(() => {
    const s = sampleCost();
    cpu.push(s.cpu);
    if (s.gpu !== null) gpu.push(s.gpu);
    const sh = entries.find((x) => x.stats?.shared)?.stats?.shared;
    if (sh) {
      copy.push(sh.copyMs);
      draw.push(sh.drawMs);
    }
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
    /** Shared renderer: main-thread ms of the draw series and of the copy series per frame. */
    sharedDrawMs: draw.length ? round(mean(draw), 3) : null,
    sharedCopyMs: copy.length ? round(mean(copy), 3) : null,
    gpuReporting,
    longTasks: { count: lt.length, totalMs: Math.round(lt.reduce((a, t) => a + t.duration, 0)) },
    contextChurnInWindow: {
      created: c1.created - c0.created,
      lost: c1.lost - c0.lost,
      released: c1.released - c0.released,
      evicted: c1.evicted - c0.evicted,
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

function nextFrame(): Promise<number> {
  return new Promise((r) => requestAnimationFrame(r));
}

/** Visible cards (by the page's own observer) that do not show a live canvas. */
function visibleNotLive(): number {
  let n = 0;
  for (const e of entries) if (e.card.visible && cardLook(e) !== 'live') n++;
  return n;
}

/**
 * Scrolls the page down to the end and back up, dwelling on each screen. Per step: frame pacing,
 * what the visible cards show at the end of the dwell, the most live contexts seen during it,
 * and `settleMs` / `settleFrames`: how long after the jump every visible card showed a live
 * canvas (-1: not within the dwell). The page's observer updates `visible` one frame after a
 * scroll, so the check starts on the second frame.
 */
async function scrollThrough(opts: { dwellMs?: number; stepFraction?: number } = {}) {
  const dwell = opts.dwellMs ?? 700;
  const step = Math.max(1, Math.round(innerHeight * (opts.stepFraction ?? 0.8)));
  const maxY = Math.max(0, document.documentElement.scrollHeight - innerHeight);
  const ys: number[] = [];
  for (let y = 0; y < maxY; y += step) ys.push(y);
  ys.push(maxY);
  for (let i = ys.length - 2; i >= 0; i--) ys.push(ys[i] as number);
  const c0 = { ...probe.counters };
  const ev0 = summarizeEvents();
  probe.resetPeak();
  const steps: ScrollStep[] = [];
  for (const y of ys) {
    scrollTo(0, y);
    const r: Recording = { deltas: [], work: [] };
    rec = r;
    const start = performance.now();
    let frames = 0;
    let settleMs = -1;
    let settleFrames = -1;
    let maxLive = 0;
    let maxVisibleDead = 0;
    while (performance.now() - start < dwell) {
      await nextFrame();
      frames++;
      maxLive = Math.max(maxLive, probe.liveNow());
      if (params.mode === 'lumicells') {
        let dead = 0;
        for (const e of entries) if (e.card.visible && cardLook(e) === 'dead') dead++;
        maxVisibleDead = Math.max(maxVisibleDead, dead);
      }
      if (settleMs < 0 && frames >= 2 && (params.mode !== 'lumicells' || visibleNotLive() === 0)) {
        settleMs = Math.round(performance.now() - start);
        settleFrames = frames;
      }
    }
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
      visibleDead: s.instances.visibleDead,
      maxVisibleDead,
      settleMs,
      settleFrames,
      rendering: s.instances.rendering,
      liveContexts: s.contexts.liveNow,
      maxLiveContexts: maxLive,
      states: s.instances.states,
      created: s.contexts.created - c0.created,
      lost: s.contexts.lost - c0.lost,
      evicted: s.contexts.evicted - c0.evicted,
      restored: s.contexts.restored - c0.restored,
    });
  }
  scrollTo(0, 0);
  const c1 = probe.counters;
  const ev1 = summarizeEvents();
  const settled = steps.filter((s) => s.settleMs >= 0);
  const sum = (f: (s: (typeof steps)[number]) => number) => steps.reduce((a, s) => a + f(s), 0);
  const visibleCards = sum((s) => s.visible);
  const visibleLive = sum((s) => s.visibleLive);
  return {
    params,
    runtimeParams,
    steps,
    totals: {
      created: c1.created - c0.created,
      lost: c1.lost - c0.lost,
      released: c1.released - c0.released,
      evicted: c1.evicted - c0.evicted,
      restored: c1.restored - c0.restored,
      /** 'contextlost' events received by the instances during the pass. */
      instanceContextLost: ev1.lost - ev0.lost,
      peakLiveContexts: probe.peakLive(),
      maxLiveContextsSampled: Math.max(0, ...steps.map((s) => s.maxLiveContexts)),
      stepsWithVisiblePoster: steps.filter((s) => s.visiblePoster > 0).length,
      maxVisiblePoster: Math.max(0, ...steps.map((s) => s.visiblePoster)),
      /**
       * Visible cards summed over the steps (at the end of each dwell) and what they showed:
       * the share that animates, not just whether anything was broken.
       */
      visibleCards,
      visibleLive,
      visiblePoster: sum((s) => s.visiblePoster),
      visibleLiveShare: visibleCards > 0 ? round(visibleLive / visibleCards, 3) : 0,
      stepsWithVisibleDead: steps.filter((s) => s.maxVisibleDead > 0).length,
      stepsSettled: settled.length,
      steps: steps.length,
      maxSettleMs: settled.length ? Math.max(...settled.map((s) => s.settleMs)) : -1,
      maxSettleFrames: settled.length ? Math.max(...settled.map((s) => s.settleFrames)) : -1,
      minFps: Math.min(...steps.map((s) => s.fps)),
    },
    end: snapshot(),
  };
}

/**
 * Forces WebGL context losses and watches every frame for `watchMs`: how often the affected
 * cards showed a lost context's canvas (a blank box) instead of the poster, and how long until
 * all of them were live again. Two ways to lose them:
 * - default: up to `count` live visible cards call the library's loseContextForTesting() (lost
 *   now, restored by the browser about 0.5 s later);
 * - `appContexts: N`: the page creates N WebGL contexts of its own (like a map or three.js next
 *   to the backgrounds), pushing the browser past its limit so that it evicts the oldest ones,
 *   ours; evicted contexts are not restored. The page's contexts are released at the end.
 * `centers` are the affected cards' centres in viewport px, for a driver that samples
 * screenshot pixels during the loss.
 */
async function lossTest(opts: { count?: number; watchMs?: number; appContexts?: number } = {}) {
  const count = opts.count ?? 4;
  const watchMs = opts.watchMs ?? 2000;
  const appContexts = Math.max(0, opts.appContexts ?? 0);
  const liveNow = entries.filter(
    (e) => e.card.visible && e.cells.getStats().state === 'live' && cardLook(e) === 'live',
  );
  // An eviction hits whoever the browser picks: watch every instance that owns a context. A loss
  // of the shared context hits every shared instance: watch them all.
  const sharedLive = entries.filter(
    (e) => e.cells.renderer === 'shared' && e.cells.getStats().state === 'live',
  );
  const victims =
    appContexts > 0
      ? entries.filter((e) => e.cells.getStats().state === 'live')
      : liveNow.some((e) => e.cells.renderer === 'shared')
        ? [...liveNow.filter((e) => e.cells.renderer === 'own').slice(0, count), ...sharedLive]
        : liveNow.slice(0, count);
  const before = victims.map((e) => ({ lost: e.lost, restored: e.restored }));
  const centers = victims
    .filter((e) => e.card.visible)
    .map((e) => {
      const r = e.card.host.getBoundingClientRect();
      return {
        index: entries.indexOf(e),
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
      };
    });
  const c0 = { ...probe.counters };
  const start = performance.now();
  const appGl: WebGL2RenderingContext[] = [];
  if (appContexts > 0) {
    for (let i = 0; i < appContexts; i++) {
      const gl = document.createElement('canvas').getContext('webgl2');
      if (gl) appGl.push(gl);
    }
  } else {
    // One call on a shared member loses the shared context (all shared members).
    let sharedDone = false;
    for (const e of victims) {
      if (e.cells.renderer === 'shared') {
        if (sharedDone) continue;
        sharedDone = true;
      }
      e.cells.loseContextForTesting();
    }
  }
  const looks: Record<string, number> = {};
  const states: Record<string, number> = {};
  let frames = 0;
  let framesWithDead = 0;
  let maxDead = 0;
  let maxVisibleDead = 0;
  let allLiveAgainMs = -1;
  while (performance.now() - start < watchMs) {
    await nextFrame();
    frames++;
    let dead = 0;
    let back = 0;
    victims.forEach((e, i) => {
      const look = cardLook(e);
      looks[look] = (looks[look] ?? 0) + 1;
      const st = e.cells.getStats().state;
      states[st] = (states[st] ?? 0) + 1;
      if (look === 'dead') dead++;
      if (look === 'live' && e.restored > (before[i]?.restored ?? 0)) back++;
    });
    if (dead > 0) framesWithDead++;
    maxDead = Math.max(maxDead, dead);
    let visibleDead = 0;
    for (const e of entries) if (e.card.visible && cardLook(e) === 'dead') visibleDead++;
    maxVisibleDead = Math.max(maxVisibleDead, visibleDead);
    if (allLiveAgainMs < 0 && victims.length > 0 && back === victims.length) {
      allLiveAgainMs = Math.round(performance.now() - start);
    }
  }
  const c1 = probe.counters;
  const end = snapshot();
  for (const gl of appGl) gl.getExtension('WEBGL_lose_context')?.loseContext();
  return {
    params,
    runtimeParams,
    mode: appContexts > 0 ? `evicted by ${appGl.length} app contexts` : 'loseContextForTesting',
    watched: victims.length,
    forced: victims.filter((e, i) => e.lost > (before[i]?.lost ?? 0)).length,
    centers,
    frames,
    /** Card-frames by what the forced cards showed (dead: a lost context's canvas painted). */
    looks,
    /** Card-frames by getStats().state of the forced cards. */
    states,
    framesWithDead,
    maxDead,
    maxVisibleDead,
    lostEvents: victims.reduce((a, e, i) => a + e.lost - (before[i]?.lost ?? 0), 0),
    restoredEvents: victims.reduce((a, e, i) => a + e.restored - (before[i]?.restored ?? 0), 0),
    /** -1: not all of them were live again within watchMs. */
    allLiveAgainMs,
    contextChurn: {
      created: c1.created - c0.created,
      lost: c1.lost - c0.lost,
      restored: c1.restored - c0.restored,
      evicted: c1.evicted - c0.evicted,
    },
    end,
  };
}

/** Cost of creating the instances (they are created in one task, see mountAll()). */
function mount() {
  const start = mountInfo.startAt;
  const end = start + 5000;
  const lt = longTasks.filter((t) => t.start >= start - 1 && t.start < end);
  const lf = longFrames.filter((t) => t.start + t.duration >= start && t.start < end);
  const maxOf = (v: number[]) => (v.length ? Math.round(Math.max(...v)) : 0);
  return {
    syncMs: round(mountInfo.syncMs, 1),
    longTasks: lt.map((t) => ({ at: Math.round(t.start - start), ms: Math.round(t.duration) })),
    maxLongTaskMs: maxOf(lt.map((t) => t.duration)),
    longFrames: lf.map((t) => ({
      at: Math.round(t.start - start),
      ms: Math.round(t.duration),
      blockingMs: Math.round(t.blocking),
      renderMs: Math.round(t.renderMs),
      styleLayoutMs: Math.round(t.styleLayoutMs),
      scripts: t.scripts.map((sc) => `${sc.invoker} ${sc.fn} ${Math.round(sc.ms)}ms`),
    })),
    maxLongFrameMs: maxOf(lf.map((t) => t.duration)),
    maxLongFrameBlockingMs: maxOf(lf.map((t) => t.blocking)),
  };
}

// -------------------------------------------------------------------------------------------
// Automation surface + status line

const bench = {
  params,
  runtimeParams,
  get t0() {
    return t0;
  },
  get mounted() {
    return mountInfo.syncMs >= 0;
  },
  measure,
  snapshot,
  scrollThrough,
  mount,
  lossTest,
};
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
      `${params.mode}${params.mode === 'lumicells' ? `/${params.renderer}${params.own ? ` own=${params.own}` : ''}` : ''} n=${params.n} ${params.layout} pauseOffscreen=${params.pauseOffscreen ? 1 : 0}\n` +
      `fps ${fps.toFixed(0)}  cpu ${c.cpu.toFixed(2)} ms  gpu ${c.gpu?.toFixed(2) ?? 'n/a'} ms\n` +
      `live ${s.instances.live}  poster ${s.instances.poster}  ready ${s.instances.ready}\n` +
      `visible ${s.instances.visible}: live ${s.instances.visibleLive}  poster ${s.instances.visiblePoster}  dead ${s.instances.visibleDead}\n` +
      `contexts live ${s.contexts.liveNow} (peak ${s.contexts.peakLive}) created ${s.contexts.created} lost ${s.contexts.lost}
` +
      `states ${Object.entries(s.instances.states)
        .map(([k, v]) => `${k} ${v}`)
        .join('  ')}`;
  }, 500);
}
