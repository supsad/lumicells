/**
 * Shared look checks for the stress bench (`look=shared`): pixel parity of cards that show a crop
 * of their group's picture.
 *
 * Every instance is frozen (animation.speed 0, no random lifts), so the clock stays at its start
 * and the only differences left are the ones a crop could introduce. Three checks:
 * - equal size: a member of a group of cards of its own size against a solo instance: the crop
 *   must be its solo picture (within the dither, keyed to the region-local pixel: 2 levels);
 * - crop, never scale: a 'pitch'-sized member smaller than its group against a solo instance of
 *   the group's size: the member's picture must be a sub-rectangle of it, pixel for pixel;
 * - cells: the same member against its own solo render: same canvas size, and the cell lattice
 *   (found from the dark gaps between cells) at the same phase on both axes. The colors differ
 *   (the pattern is laid out for the group's size), the cells must not.
 *
 * Every instance draws on the shared renderer (a solo one with `look: 'own'`), with
 * `pauseOffscreen: false`, in a fixed overlay the check removes afterwards.
 */

import { LumiCells, type LumiCellsConfigInput } from 'lumicells';

interface Pixels {
  w: number;
  h: number;
  px: Uint8ClampedArray;
}

const FROZEN: LumiCellsConfigInput = {
  animation: { speed: 0 },
  lift: { enabled: false },
  render: { pauseOffscreen: false },
};
/** CSS px cell pitch of the 'pitch'-sized checks. */
const PITCH_CSS = 12;
const PITCHED: LumiCellsConfigInput = { ...FROZEN, grid: { sizing: 'pitch', pitch: PITCH_CSS } };

function pixelsOf(pl: LumiCells): Pixels | null {
  const c = pl.canvas;
  const ctx = c?.getContext('2d');
  if (!c || !ctx || c.width === 0) return null;
  const img = ctx.getImageData(0, 0, c.width, c.height);
  return { w: img.width, h: img.height, px: img.data };
}

/** Channel differences of `a` against the `a`-sized part of `b` at (ox, oy). */
function diff(a: Pixels, b: Pixels, ox = 0, oy = 0) {
  let max = 0;
  let sum = 0;
  let over2 = 0;
  for (let y = 0; y < a.h; y++) {
    for (let x = 0; x < a.w; x++) {
      const i = (y * a.w + x) * 4;
      const j = ((y + oy) * b.w + x + ox) * 4;
      let m = 0;
      for (let c = 0; c < 3; c++) {
        const d = Math.abs((a.px[i + c] as number) - (b.px[j + c] as number));
        sum += d;
        if (d > m) m = d;
      }
      if (m > max) max = m;
      if (m > 2) over2++;
    }
  }
  return { max, meanAbs: Math.round((sum / (a.w * a.h * 3)) * 1000) / 1000, over2 };
}

/** Where `a` sits in the larger `b`: the offset with the smallest mean difference (whole image). */
function locate(a: Pixels, b: Pixels): { x: number; y: number; diff: ReturnType<typeof diff> } {
  let best = { x: 0, y: 0, diff: diff(a, b) };
  for (let oy = 0; oy <= b.h - a.h; oy++) {
    for (let ox = 0; ox <= b.w - a.w; ox++) {
      // Coarse first: a sparse sample decides whether the full comparison is worth it.
      let sum = 0;
      for (let k = 0; k < 400; k++) {
        const x = (k * 37) % a.w;
        const y = (k * 53) % a.h;
        const i = (y * a.w + x) * 4;
        const j = ((y + oy) * b.w + x + ox) * 4;
        sum += Math.abs((a.px[i] as number) - (b.px[j] as number));
      }
      if (sum / 400 > best.diff.meanAbs * 3 + 1) continue;
      const d = diff(a, b, ox, oy);
      if (d.meanAbs < best.diff.meanAbs) best = { x: ox, y: oy, diff: d };
    }
  }
  return best;
}

/**
 * Phase of the cell lattice on one axis: the offset (mod `p`) whose rows or columns are darkest
 * on average (the gaps between cells), and how much darker than the brightest offset.
 */
function latticePhase(
  img: Pixels,
  p: number,
  axis: 'x' | 'y',
): { phase: number; contrast: number } {
  const sum = new Float64Array(p);
  const count = new Float64Array(p);
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * 4;
      const lum =
        0.2126 * (img.px[i] as number) +
        0.7152 * (img.px[i + 1] as number) +
        0.0722 * (img.px[i + 2] as number);
      const k = (axis === 'x' ? x : y) % p;
      sum[k] = (sum[k] as number) + lum;
      count[k] = (count[k] as number) + 1;
    }
  }
  let lo = Number.POSITIVE_INFINITY;
  let hi = 0;
  let phase = 0;
  for (let k = 0; k < p; k++) {
    const m = (sum[k] as number) / Math.max(1, count[k] as number);
    if (m < lo) {
      lo = m;
      phase = k;
    }
    hi = Math.max(hi, m);
  }
  return { phase, contrast: hi > 0 ? Math.round(((hi - lo) / hi) * 1000) / 1000 : 0 };
}

const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));

/**
 * Runs the three checks (see the header). `maxDiff`: largest channel difference allowed (the
 * dither is keyed to the region-local pixel, so a crop sees other noise).
 */
export async function lookParity(opts: { maxDiff?: number } = {}) {
  const maxDiff = opts.maxDiff ?? 2;
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;left:8px;top:8px;z-index:20;display:flex;gap:8px;align-items:flex-start;pointer-events:none';
  document.body.appendChild(overlay);
  const made: LumiCells[] = [];
  const make = (w: number, h: number, config: LumiCellsConfigInput, look: 'own' | 'shared') => {
    const el = document.createElement('div');
    el.style.cssText = `position:relative;width:${w}px;height:${h}px;flex:none`;
    overlay.appendChild(el);
    const pl = new LumiCells(el, { config, renderer: 'shared', look });
    made.push(pl);
    return pl;
  };
  try {
    // Equal size: two members and a solo instance of the default look.
    const eq = make(200, 120, FROZEN, 'shared');
    make(200, 120, FROZEN, 'shared');
    const eqSolo = make(200, 120, FROZEN, 'own');
    // Pitch-sized: a 300x180 card makes the group, a 200x120 member shows a crop of it.
    make(300, 180, PITCHED, 'shared');
    const m = make(200, 120, PITCHED, 'shared');
    const groupSolo = make(300, 180, PITCHED, 'own');
    const mSolo = make(200, 120, PITCHED, 'own');
    const start = performance.now();
    while (performance.now() - start < 4000) {
      await nextFrame();
      if (made.every((pl) => (pl.canvas?.width ?? 0) > 0 && pl.getStats().state === 'live')) break;
    }
    for (let i = 0; i < 20; i++) await nextFrame();
    const pEq = pixelsOf(eq);
    const pEqSolo = pixelsOf(eqSolo);
    const pM = pixelsOf(m);
    const pGroupSolo = pixelsOf(groupSolo);
    const pMSolo = pixelsOf(mSolo);
    if (!pEq || !pEqSolo || !pM || !pGroupSolo || !pMSolo) {
      return {
        result: 'FAIL',
        reason: 'not every instance drew',
        states: made.map((pl) => pl.getStats().state),
      };
    }
    const sEq = eq.getStats();
    const sM = m.getStats();
    const equal =
      pEq.w === pEqSolo.w && pEq.h === pEqSolo.h
        ? diff(pEq, pEqSolo)
        : { sizeMismatch: true, max: 255 };
    const crop = locate(pM, pGroupSolo);
    const p = Math.round(PITCH_CSS * sM.dpr);
    const lattice = {
      pitchPx: p,
      member: { x: latticePhase(pM, p, 'x'), y: latticePhase(pM, p, 'y') },
      solo: { x: latticePhase(pMSolo, p, 'x'), y: latticePhase(pMSolo, p, 'y') },
    };
    const sameCells =
      pM.w === pMSolo.w &&
      pM.h === pMSolo.h &&
      lattice.member.x.phase === lattice.solo.x.phase &&
      lattice.member.y.phase === lattice.solo.y.phase &&
      lattice.solo.x.contrast > 0.05;
    const checks = {
      equalSize: sEq.look === 'group' && sEq.groupSize === 2 && equal.max <= maxDiff,
      cropNotScaled: sM.look === 'group' && sM.groupSize === 2 && crop.diff.max <= maxDiff,
      sameCells,
    };
    return {
      result: checks.equalSize && checks.cropNotScaled && checks.sameCells ? 'PASS' : 'FAIL',
      checks,
      maxDiff,
      equalSize: { look: sEq.look, groupSize: sEq.groupSize, size: [pEq.w, pEq.h], diff: equal },
      smallerMember: {
        look: sM.look,
        groupSize: sM.groupSize,
        size: [pM.w, pM.h],
        soloSize: [pMSolo.w, pMSolo.h],
        cropAt: [crop.x, crop.y],
        cropDiff: crop.diff,
        lattice,
        // Informational: the colors follow the group's layout, the cells do not.
        diffToSolo: pM.w === pMSolo.w && pM.h === pMSolo.h ? diff(pM, pMSolo) : null,
      },
      groups: sEq.shared?.groups ?? null,
    };
  } finally {
    for (const pl of made) pl.destroy();
    overlay.remove();
  }
}
