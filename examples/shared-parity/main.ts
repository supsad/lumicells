/**
 * Shared renderer parity (see shared-parity.html): each pair is two LumiCells instances with
 * the same config, the same seed and the same time, one with `renderer: 'own'` and one with
 * `renderer: 'shared'`.
 *
 * Determinism: an instance's controller seeds its own generator from Math.random once, in its
 * constructor, so Math.random is replaced by one seeded generator per construction. Both
 * instances of a pair are granted their GPU side at the end of the same frame
 * (createPerFrame lets the own context and the shared device be created together), subscribe
 * to the shared ticker together and so see the same frame deltas; the 'frame' event's `time`
 * (the sum of those deltas) is compared to prove it. Things that are not deterministic are
 * switched off: the Life automaton (its GPU state starts at an instance's first drawn frame,
 * which depends on when its programs finished compiling), pointer interaction and adaptive
 * quality (it reacts to measured CPU/GPU times, which differ between the two renderers).
 *
 * Readback: the own canvas with readPixels inside its 'frame' event (same task as the draw: its
 * drawing buffer is not preserved), the shared 2D canvas with getImageData inside its 'frame'
 * event (right after the copy). readPixels returns what the WebGL canvas stores (premultiplied
 * when it has alpha), getImageData returns unpremultiplied values, so the 2D pixels are
 * premultiplied again before the comparison.
 */

import { LumiCells, type LumiCellsConfigInput } from 'lumicells';

const qs = new URLSearchParams(location.search);
const WAIT_FRAMES = Math.max(5, Number(qs.get('frames') ?? 60) || 60);

// The own context and the shared device of a pair are created in the same frame; every pair
// stays on the page, so the own contexts of all of them fit the budget.
LumiCells.configure({ createPerFrame: 8, maxContexts: 8 });

interface PairSpec {
  name: string;
  config: LumiCellsConfigInput;
  seed: number;
}

const DETERMINISTIC: LumiCellsConfigInput = {
  render: { quality: 'high', pauseOffscreen: false },
  interaction: { pointer: false, click: false },
  modes: { life: { weight: 0 } },
};

function spec(name: string, seed: number, config: LumiCellsConfigInput): PairSpec {
  return {
    name,
    seed,
    config: {
      ...config,
      render: { ...DETERMINISTIC.render, ...config.render },
      interaction: DETERMINISTIC.interaction,
      modes: { ...config.modes, life: { weight: 0 } },
    },
  };
}

const SPECS: readonly PairSpec[] = [
  spec('opaque reference', 11, { extends: 'reference' }),
  spec('opaque orb + lifts', 12, { extends: 'orb', lift: { amount: 0.06 } }),
  spec('overflow 24 orb + lifts', 13, {
    extends: 'orb',
    render: { overflow: 24 },
    lift: { amount: 0.06 },
  }),
  spec('overflow 16 rain', 14, { extends: 'rain', render: { overflow: 16 } }),
];

interface Capture {
  time: number;
  w: number;
  h: number;
  /** RGBA, top row first, premultiplied. */
  px: Uint8Array;
  /** Shared only: getImageData as returned (unpremultiplied). */
  raw?: Uint8ClampedArray;
}

interface Diff {
  pixels: number;
  /** Largest channel difference and pixels with any difference / with one above 1. */
  max: number;
  n1: number;
  n2: number;
}

interface PairResult {
  name: string;
  opaque: boolean;
  size: string;
  inSync: boolean;
  time: number;
  premultiplied: Diff;
  /** Overflow pairs: pixels with 0 < alpha < 255 (the transparent margin and glow). */
  marginPixels: number;
  /** Overflow pairs: unpremultiplied comparison of pixels with alpha >= 16. */
  unpremultiplied: Diff | null;
  ownState: string;
  sharedState: string;
  failures: string[];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Constructs with a seeded Math.random: two instances built with one seed are identical. */
function seeded(host: HTMLElement, s: PairSpec, renderer: 'own' | 'shared'): LumiCells {
  const orig = Math.random;
  Math.random = mulberry32(s.seed);
  try {
    return new LumiCells(host, { config: s.config, renderer });
  } finally {
    Math.random = orig;
  }
}

function readOwn(lc: LumiCells, time: number): Capture | null {
  const canvas = lc.canvas;
  const gl = canvas?.getContext('webgl2') as WebGL2RenderingContext | null;
  if (!gl) return null;
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const buf = new Uint8Array(w * h * 4);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  // GL rows run bottom-up.
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) px.set(buf.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
  return { time, w, h, px };
}

function readShared(lc: LumiCells, time: number): Capture | null {
  const canvas = lc.canvas;
  const ctx = canvas?.getContext('2d') as CanvasRenderingContext2D | null;
  if (!canvas || !ctx || canvas.width === 0) return null;
  const w = canvas.width;
  const h = canvas.height;
  const raw = ctx.getImageData(0, 0, w, h).data;
  const px = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 4) {
    const a = raw[i + 3] as number;
    px[i] = Math.round(((raw[i] as number) * a) / 255);
    px[i + 1] = Math.round(((raw[i + 1] as number) * a) / 255);
    px[i + 2] = Math.round(((raw[i + 2] as number) * a) / 255);
    px[i + 3] = a;
  }
  return { time, w, h, px, raw };
}

function diff(a: Uint8Array | Uint8ClampedArray, b: Uint8Array | Uint8ClampedArray): Diff {
  let max = 0;
  let n1 = 0;
  let n2 = 0;
  for (let i = 0; i < a.length; i += 4) {
    let m = 0;
    for (let c = 0; c < 4; c++)
      m = Math.max(m, Math.abs((a[i + c] as number) - (b[i + c] as number)));
    if (m > 0) n1++;
    if (m > 1) n2++;
    max = Math.max(max, m);
  }
  return { pixels: a.length / 4, max, n1, n2 };
}

/** Unpremultiplied comparison of pixels with alpha >= 16 (the own buffer is premultiplied). */
function diffUnpremultiplied(own: Capture, shared: Capture): Diff {
  const raw = shared.raw as Uint8ClampedArray;
  let max = 0;
  let n1 = 0;
  let n2 = 0;
  let pixels = 0;
  for (let i = 0; i < own.px.length; i += 4) {
    const a = own.px[i + 3] as number;
    if (a < 16) continue;
    pixels++;
    let m = Math.abs(a - (raw[i + 3] as number));
    for (let c = 0; c < 3; c++) {
      const v = Math.min(255, Math.round(((own.px[i + c] as number) * 255) / a));
      m = Math.max(m, Math.abs(v - (raw[i + c] as number)));
    }
    if (m > 0) n1++;
    if (m > 1) n2++;
    max = Math.max(max, m);
  }
  return { pixels, max, n1, n2 };
}

const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));
const pairsEl = document.getElementById('pairs') as HTMLElement;
const statusEl = document.getElementById('status') as HTMLElement;

function host(parent: HTMLElement): HTMLElement {
  const el = document.createElement('div');
  parent.append(el);
  return el;
}

async function runPair(s: PairSpec): Promise<PairResult> {
  const row = document.createElement('div');
  row.className = 'pair';
  const label = document.createElement('b');
  label.textContent = `${s.name}\nown | shared`;
  row.append(label);
  pairsEl.append(row);
  const own = seeded(host(row), s, 'own');
  const shared = seeded(host(row), s, 'shared');
  const ready = (lc: LumiCells) => new Promise<void>((r) => lc.on('ready', () => r()));
  const ownCaps = new Map<number, Capture>();
  const sharedCaps = new Map<number, Capture>();
  let armed = false;
  own.on('frame', (e) => {
    if (!armed) return;
    const c = readOwn(own, e.time);
    if (c) ownCaps.set(e.time, c);
  });
  shared.on('frame', (e) => {
    if (!armed) return;
    const c = readShared(shared, e.time);
    if (c) sharedCaps.set(e.time, c);
  });
  await Promise.all([ready(own), ready(shared)]);
  for (let i = 0; i < WAIT_FRAMES; i++) await nextFrame();
  armed = true;
  for (let i = 0; i < 3; i++) await nextFrame();
  armed = false;
  const failures: string[] = [];
  const common = [...ownCaps.keys()].filter((t) => sharedCaps.has(t));
  const opaque = (s.config.render?.overflow ?? 0) <= 0;
  const time = common[0] ?? Number.NaN;
  const a = ownCaps.get(time);
  const b = sharedCaps.get(time);
  const none: Diff = { pixels: 0, max: 255, n1: -1, n2: -1 };
  let premultiplied = none;
  let unpremultiplied: Diff | null = null;
  let marginPixels = 0;
  if (!a || !b) {
    failures.push(
      `no frame with the same time (own ${[...ownCaps.keys()].map((t) => t.toFixed(4))}, shared ${[...sharedCaps.keys()].map((t) => t.toFixed(4))})`,
    );
  } else if (a.w !== b.w || a.h !== b.h) {
    failures.push(`size differs: own ${a.w}x${a.h}, shared ${b.w}x${b.h}`);
  } else {
    premultiplied = diff(a.px, b.px);
    if (premultiplied.max > 1) failures.push(`max ${premultiplied.max} LSB (premultiplied)`);
    if (!opaque) {
      unpremultiplied = diffUnpremultiplied(a, b);
      for (let i = 3; i < a.px.length; i += 4) {
        const al = a.px[i] as number;
        if (al > 0 && al < 255) marginPixels++;
      }
    }
  }
  const ownState = own.getStats().state;
  const sharedState = shared.getStats().state;
  if (own.renderer !== 'own' || shared.renderer !== 'shared') failures.push('wrong renderers');
  return {
    name: s.name,
    opaque,
    size: a ? `${a.w}x${a.h}` : '?',
    inSync: !!a && !!b,
    time,
    premultiplied,
    marginPixels,
    unpremultiplied,
    ownState,
    sharedState,
    failures,
  };
}

interface GridResult {
  name: string;
  budget: number;
  scale: number;
  own: string;
  shared: string;
  failures: string[];
}

/**
 * Grid parity under a tiny shared budget: the shared instance renders at a lower resolution
 * (fewer pixels, softer) but with the same grid as the own one: same cols and rows, and the
 * same cell size on screen. Pixels cannot match here, so only the grid is compared.
 */
async function runGridPair(name: string, seed: number, budget: number): Promise<GridResult> {
  const s = spec(name, seed, {});
  const row = document.createElement('div');
  row.className = 'pair';
  const label = document.createElement('b');
  label.textContent = `${name}\nown | shared (budget ${budget} Mpx)`;
  row.append(label);
  pairsEl.append(row);
  LumiCells.configure({ sharedBudget: budget });
  const failures: string[] = [];
  let scale = 1;
  let ownGrid = '?';
  let sharedGrid = '?';
  try {
    const own = seeded(host(row), s, 'own');
    const shared = seeded(host(row), s, 'shared');
    const ready = (lc: LumiCells) => new Promise<void>((r) => lc.on('ready', () => r()));
    await Promise.all([ready(own), ready(shared)]);
    // Stats refresh about 4 times a second.
    for (let i = 0; i < Math.max(WAIT_FRAMES, 40); i++) await nextFrame();
    const a = own.getStats();
    const b = shared.getStats();
    scale = b.shared?.scale ?? 1;
    ownGrid = `${a.cols}x${a.rows}, ${a.pixels} px`;
    sharedGrid = `${b.cols}x${b.rows}, ${b.pixels} px`;
    if (!(scale < 1)) failures.push(`budget not binding (scale ${scale})`);
    if (!(b.pixels < a.pixels)) failures.push('shared did not render with fewer pixels');
    if (a.cols !== b.cols || a.rows !== b.rows) {
      failures.push(`grid differs: own ${a.cols}x${a.rows}, shared ${b.cols}x${b.rows}`);
    }
    // Cell size on screen: the canvas's CSS width over its cols.
    const cell = (lc: LumiCells, cols: number) =>
      (lc.canvas?.getBoundingClientRect().width ?? 0) / Math.max(1, cols);
    const ca = cell(own, a.cols);
    const cb = cell(shared, b.cols);
    if (!(Math.abs(ca - cb) <= 0.01 * ca)) {
      failures.push(`cell size differs: own ${ca.toFixed(3)}, shared ${cb.toFixed(3)} CSS px`);
    }
  } finally {
    LumiCells.configure({ sharedBudget: 'auto' });
  }
  return { name, budget, scale, own: ownGrid, shared: sharedGrid, failures };
}

function fmt(d: Diff | null): string {
  if (!d) return '-';
  return `max ${d.max}, >0 ${d.n1}, >1 ${d.n2} of ${d.pixels}`;
}

async function run() {
  pairsEl.replaceChildren();
  statusEl.textContent = 'running...';
  const results: PairResult[] = [];
  for (const s of SPECS) results.push(await runPair(s));
  // Last: it changes the page-wide budget while it runs.
  const grids = [await runGridPair('grid under a tiny budget', 15, 0.02)];
  const failures = [...results, ...grids].flatMap((r) => r.failures.map((f) => `${r.name}: ${f}`));
  const verdict = failures.length === 0 ? 'PASS' : 'FAIL';
  const lines = [
    `${verdict}${failures.length ? `: ${failures.length} problem(s)` : ''}`,
    ...failures.map((f) => `  - ${f}`),
    '',
    `own vs shared, same seed and time, ${WAIT_FRAMES} frames after both were ready; tolerance 1 LSB (premultiplied)`,
    ...results.map(
      (r) =>
        `[${r.name}] ${r.size} t=${r.time.toFixed(3)} s  premultiplied: ${fmt(r.premultiplied)}` +
        (r.opaque
          ? ''
          : `\n    margin pixels (0 < a < 255): ${r.marginPixels}; unpremultiplied (a >= 16): ${fmt(r.unpremultiplied)}`),
    ),
    ...grids.map(
      (g) =>
        `[${g.name}] budget ${g.budget} Mpx, share scale ${g.scale.toFixed(3)}  own ${g.own}  shared ${g.shared}`,
    ),
  ];
  statusEl.textContent = lines.join('\n');
  const result = { verdict, failures, results, grids };
  api.last = result;
  return result;
}

const api: { run: typeof run; last: unknown } = { run, last: null };
declare global {
  interface Window {
    parity: typeof api;
  }
}
window.parity = api;
if (qs.get('auto') !== '0') void run();
