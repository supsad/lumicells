/**
 * Shared look (`look: 'shared'`): cards with an identical config that draw nothing of their own
 * share ONE picture. Render once, copy into every card.
 *
 * A LookGroup is one picture on the shared renderer (runtime/shared-renderer): a Controller of its
 * own (clock, random lifts, adaptive tier), one RenderSlot and one region of the atlas, drawn at
 * most once per frame. Every member (an instance with `look: 'shared'`) gives up its own slot and
 * region; the renderer copies a crop of the group's region into the member's 2D canvas instead,
 * in the same copy series as every other shared instance. N identical cards cost one draw per
 * frame plus one drawImage per card that presents.
 *
 * Crop, never scale. A group lays its picture out for a host size of its own (at least each
 * member's, plus the member's window shift margin, see LumiCellsOptions.lookOffset). A member
 * shows the part of the group's frame its own canvas covers, at the same device-px scale: the
 * centered part (or shifted by whole cells), placed so that the crop's cell lattice is the one the
 * member draws on its own (both grids are centered on their host the same way). A member joins
 * only a group whose cells have the size its own would have: with `grid.sizing: 'pitch'` any
 * group at the same DPR (and pixel caps), with 'count' only one whose starter's shorter side gives
 * the same pitch (a group divides its starter's shorter side, not that of the larger host a window
 * shift lays it out for: Controller.setCountBasis). The crop is the member's own canvas (its solo
 * geometry, exact device-pixel box included) on its own lattice; a member for which the frame has
 * no such place does not fit. A member of the group's size therefore shows exactly its solo
 * picture. What still differs for a member smaller than its group (or shifted in it): the pattern
 * is laid out for the group's size (mode units, the vignette and the background spots follow the
 * group's host), so it shows part of a larger picture, laid out for the card's own size again
 * when it leaves; and with `render.overflow` its margin shows the group's cells instead of glow.
 *
 * Sizes never change under the members' eyes: once a group has drawn, its size is fixed. A card
 * that does not fit any group of its key starts a group of its own; one that grows out of its
 * group moves to a group that fits (or starts one); a group whose largest member leaves keeps its
 * size. Only a group that has not drawn yet grows to fit cards joining in the same frames (a list
 * mounting together).
 *
 * Rates. The members are the instances the reducers pace (runtime/shared-renderer): each presents
 * at its own rate and phase like any shared instance (the copy into its canvas is what costs per
 * card), while the group's region is drawn once in every frame in which at least one member
 * presents, its picture advanced to that frame. So a crowd of identical cards spreads its copies
 * over the frames as before and costs one draw per frame instead of one per card.
 *
 * Membership is decided by the member (the facade): it joins when its config key matches
 * (lookKeyOf), it has been measured and it draws nothing of its own (Controller.hasLayers), and it
 * leaves at once when that stops being true, taking over the group's picture state first (clock,
 * lifts, adaptive tier: Controller.adoptLook), so its first frame in a region of its own continues
 * the picture. A new group takes over the state of the card that starts it the same way, so a card
 * that rejoins after a while on its own, or moves to another group, continues its own picture.
 */

import { Controller } from '../controller/controller';
import { computeGeometry, createGeometry, type GeometryInput } from '../controller/geometry';
import type { ParamLayout } from '../controller/layout';
import type { PerfChange } from '../controller/perf';
import type { FrameInputs } from '../engine/types';
import { frameLateMs, frameWorkMs } from '../ticker';
import type { InstancePriority, QualityTier } from '../types';
import { displayEpoch, displayIntervalMs } from './display';
import type { SharedClient, SharedSeat } from './shared-renderer';

/** Largest window shift (LumiCellsOptions.lookOffset), share of the host size per axis. */
export const MAX_LOOK_OFFSET = 0.5;
/** Longest animation step of one frame, ms (as the facade). */
const MAX_STEP_MS = 100;
/**
 * A gap this long between two frames in which any member ran (its render phase, presenting or
 * not) is a pause (every member stopped), not a frame.
 */
const RESUME_GAP_MS = 250;
/**
 * Device px a member's own canvas may exceed its group's frame by and still share it: equal CSS
 * sizes whose exact device-pixel boxes (devicePixelContentBoxSize) round differently.
 */
const DEVICE_SLACK_PX = 2;
/** Group orders sit above every instance's (atlas tie-break and plan key). */
const GROUP_ORDER_BASE = 1_000_000_000;

/** What a group needs to know about a member (a live object the member keeps up to date). */
export interface LookSpec {
  /** Host size, CSS px (the canvas adds `render.overflow` on every side). */
  hostW: number;
  hostH: number;
  /** devicePixelRatio the member is measured at. */
  dpr: number;
  /** Pixel cap of the member (coarse pointer, software GL), megapixels. */
  pixelCap: number;
  /** Reduced motion is in effect for the member (render.reducedMotion and the OS setting). */
  reducedMotion: boolean;
  /** Largest window shift, share of the host size per axis (0: centered). */
  offset: number;
  /** Seeded direction of the shift, -1..1 per axis (times `offset` times the host size). */
  shiftX: number;
  shiftY: number;
  /** The member's controller: its config is the group's; picture state moves between them. */
  controller: Controller;
  /**
   * Frame timestamp the controller's picture state belongs to (-1: none yet): a group that
   * continues it advances from there, so a picture taken over in the middle of a frame (after
   * its old group already ran in it) is not advanced twice.
   */
  stateAt: number;
}

/** Clamps a lookOffset value (non-numbers are 0). */
export function lookOffset(v: unknown): number {
  return typeof v === 'number' && v > 0 ? Math.min(MAX_LOOK_OFFSET, v) : 0;
}

/** Seeded shift direction of an instance (`order`: its creation number), -1..1 per axis. */
export function lookShift(order: number, out: { shiftX: number; shiftY: number }): void {
  // A 32-bit integer hash (splitmix-like): neighbouring orders land far apart.
  let h = Math.imul(order ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  out.shiftX = ((h & 0xffff) / 0xffff) * 2 - 1;
  out.shiftY = ((h >>> 16) / 0xffff) * 2 - 1;
}

/** Host size a member needs from its group, CSS px: its own plus the shift margin on each side. */
function needW(s: LookSpec): number {
  return s.hostW * (1 + 2 * s.offset);
}

function needH(s: LookSpec): number {
  return s.hostH * (1 + 2 * s.offset);
}

const pitchIn: GeometryInput = {
  hostCssW: 1,
  hostCssH: 1,
  overflowCss: 0,
  dpr: 1,
  deviceW: 0,
  deviceH: 0,
  maxDpr: 2,
  maxPixels: 4.2,
  scale: 1,
  cssPitch: 10,
  maxDim: 0,
};
const pitchGeo = /* @__PURE__ */ createGeometry();

/**
 * Device-px cell pitch at full resolution of a picture laid out for `w` x `h` CSS px with the
 * config of `s.controller` (the controller's own geometry rule, see Controller.updateGeometry).
 * `countSide`: the shorter side `grid.sizing: 'count'` divides, CSS px (default: that of `w` x
 * `h`; see Controller.setCountBasis).
 */
export function lookPitch(
  s: LookSpec,
  w: number,
  h: number,
  maxDim: number,
  countSide = 0,
): number {
  const cfg = s.controller.getConfig();
  const g = pitchIn;
  g.hostCssW = Math.max(1, w);
  g.hostCssH = Math.max(1, h);
  g.overflowCss = cfg.render.overflow;
  g.dpr = s.dpr > 0 ? s.dpr : 1;
  g.maxDpr = cfg.render.maxDpr;
  g.maxPixels = Math.min(cfg.render.maxPixels, s.pixelCap);
  g.maxDim = maxDim;
  g.cssPitch =
    cfg.grid.sizing === 'pitch'
      ? Math.max(1, cfg.grid.pitch)
      : (countSide > 0 ? countSide : Math.min(g.hostCssW, g.hostCssH)) /
        Math.max(1, cfg.grid.count);
  computeGeometry(g, pitchGeo);
  return pitchGeo.pitchPx;
}

let groupSeq = 0;

/**
 * One shared picture (see the header). The renderer creates it, gives it a seat of its own (slot
 * and region: `seat`) and adds and removes members; it is a SharedClient of that seat.
 */
export class LookGroup implements SharedClient {
  readonly order = GROUP_ORDER_BASE + ++groupSeq;
  readonly controller: Controller;
  /** The members' seats (they copy a crop of this group's region). */
  readonly members: SharedSeat[] = [];
  /** The group's own seat (slot and region), set by the renderer right after construction. */
  seat: SharedSeat | null = null;
  /** Host size the picture is laid out for, CSS px. */
  hostW: number;
  hostH: number;
  /** Device-px cell pitch at full resolution: the solo pitch of every member. */
  pitch: number;
  /**
   * Shorter side `grid.sizing: 'count'` divides, CSS px: that of the member that started the
   * group, not of the (larger, see lookOffset) host the picture is laid out for, so its cells
   * have the size each member's own would have and leaving does not re-grid a card.
   */
  readonly countSide: number;
  /** Drew a frame: its size is fixed from now on (see the header). */
  shown = false;
  /** Animation step of the last update, s. */
  dt = 0;
  /** Frame timestamp of the last update (-1: none yet): the time the picture state belongs to. */
  updatedAt = -1;
  /** Main-thread time of the last controller update, ms. */
  updateMs = 0;
  /** Bumped when the adaptive tier changes (members report it as their `quality` event). */
  qualityEpoch = 0;
  readonly qualityChange: { scale: number; quality: QualityTier; reason: PerfChange['reason'] } = {
    scale: 1,
    quality: 'high',
    reason: 'slow',
  };
  /** Frame the timing was last sampled in (see beginFrame), and the one last submitted. */
  private frameAt = Number.NaN;
  private submittedAt = Number.NaN;
  private lastNow = -1;
  /** Frame in which the members came back from a pause (see beginFrame; -1: none). */
  private resumedAt = -1;
  /** Exact device-pixel box the picture is laid out with (the starter's, see the constructor). */
  private deviceW = 0;
  private deviceH = 0;

  /**
   * A picture for `key` with the config of `spec`'s controller, laid out for the size that member
   * needs (adoptFrom then continues its picture). `maxDim`: the device's largest drawable side.
   */
  constructor(
    readonly key: string,
    spec: LookSpec,
    maxDim: number,
    software: boolean,
  ) {
    this.hostW = needW(spec);
    this.hostH = needH(spec);
    this.countSide = Math.min(spec.hostW, spec.hostH);
    const from = spec.controller;
    // A group of the starter's own size takes its exact device-pixel box too: the starter (and
    // every card of that box) then shows exactly its solo frame.
    if (from.hostCssW === this.hostW && from.hostCssH === this.hostH) {
      const solo = from.naturalGeo;
      this.deviceW = solo.canvasW;
      this.deviceH = solo.canvasH;
    }
    const c = new Controller({ config: from.getConfig(), layout: from.layout });
    this.controller = c;
    c.setPixelCap(spec.pixelCap);
    c.setMaxDrawableSize(maxDim);
    c.setCountBasis(this.countSide);
    if (software) c.setSoftwareFallback(true);
    c.setReducedMotion(spec.reducedMotion);
    this.applySize(spec.dpr);
    this.pitch = c.naturalGeo.pitchPx;
  }

  /**
   * The member's spec fits this group: it covers the member's need with cells of the member's
   * own (solo) pitch, and the member's own canvas fits in the frame on its own cell lattice.
   */
  fits(spec: LookSpec, maxDim: number): boolean {
    return (
      this.hostW + 0.5 >= needW(spec) &&
      this.hostH + 0.5 >= needH(spec) &&
      this.controller.dpr === spec.dpr &&
      lookPitch(spec, spec.hostW, spec.hostH, maxDim) === this.pitch &&
      this.placeable(spec)
    );
  }

  /**
   * The member's own canvas (full resolution) has a place in the frame where the crop's cell
   * lattice is its own (see cropOf), or is the frame give or take DEVICE_SLACK_PX.
   */
  private placeable(spec: LookSpec): boolean {
    const g = this.controller.naturalGeo;
    const solo = spec.controller.naturalGeo;
    const p = g.pitchPx;
    for (let axis = 0; axis < 2; axis++) {
      const full = axis === 0 ? g.canvasW : g.canvasH;
      const size = axis === 0 ? solo.canvasW : solo.canvasH;
      if (size >= full) {
        if (size - full > DEVICE_SLACK_PX) return false;
        continue;
      }
      const origin = axis === 0 ? g.originX : g.originY;
      const phase = axis === 0 ? solo.originX : solo.originY;
      // Any lattice position inside the frame will do (the shift picks one in cropOf).
      if (latticeStart(origin, full, size, p, 0, phase) < 0) return false;
    }
    return true;
  }

  /**
   * A group that has not drawn yet grows to fit `spec` when its cells keep their size. Returns
   * whether it fits now.
   */
  grow(spec: LookSpec, maxDim: number): boolean {
    if (this.shown || this.controller.dpr !== spec.dpr) return false;
    const w = Math.max(this.hostW, needW(spec));
    const h = Math.max(this.hostH, needH(spec));
    if (
      lookPitch(spec, w, h, maxDim, this.countSide) !== this.pitch ||
      lookPitch(spec, spec.hostW, spec.hostH, maxDim) !== this.pitch
    ) {
      return false;
    }
    const hostW = this.hostW;
    const hostH = this.hostH;
    const devW = this.deviceW;
    const devH = this.deviceH;
    if (w !== hostW || h !== hostH) {
      // Laid out for another size: the starter's device-pixel box no longer applies.
      this.deviceW = 0;
      this.deviceH = 0;
    }
    this.hostW = w;
    this.hostH = h;
    this.applySize(spec.dpr);
    let ok = this.controller.naturalGeo.pitchPx === this.pitch && this.placeable(spec);
    for (let i = 0; ok && i < this.members.length; i++) {
      const s = this.members[i]?.spec;
      if (s) ok = this.placeable(s);
    }
    if (!ok) {
      // The new size has no place on its own lattice for a card: keep the old one.
      this.hostW = hostW;
      this.hostH = hostH;
      this.deviceW = devW;
      this.deviceH = devH;
      this.applySize(spec.dpr);
      return false;
    }
    return true;
  }

  private applySize(dpr: number): void {
    this.controller.setViewport({
      hostCssW: this.hostW,
      hostCssH: this.hostH,
      dpr,
      deviceW: this.deviceW,
      deviceH: this.deviceH,
    });
  }

  /** Area of the picture's host, CSS px squared (the smallest fitting group is preferred). */
  get hostArea(): number {
    return this.hostW * this.hostH;
  }

  /**
   * Writes where member `m` shows the group's frame (m.cropX/Y/W/H, device px of the group's
   * frame) and how many cells its center cell sits from the group's (m.cellDX/DY). See the header.
   */
  cropOf(m: SharedSeat): void {
    const spec = m.spec;
    if (!spec) return;
    const c = this.controller;
    const g = c.geo;
    const nat = c.naturalGeo;
    const solo = spec.controller.naturalGeo;
    const sx = g.canvasW / g.canvasCssW;
    const sy = g.canvasH / g.canvasCssH;
    const p = g.pitchPx;
    let cw: number;
    let ch: number;
    let phaseX: number;
    let phaseY: number;
    if (g === nat) {
      // Full resolution: the member's own canvas, its cells where it draws them alone.
      cw = Math.min(g.canvasW, solo.canvasW);
      ch = Math.min(g.canvasH, solo.canvasH);
      phaseX = solo.originX;
      phaseY = solo.originY;
    } else {
      // Below it (adaptive or share scale): the same part of the frame at the frame's scale, on
      // the lattice a centered grid of that size has (odd cols: a cell centered on the middle).
      cw = Math.min(g.canvasW, Math.max(1, Math.round((solo.canvasW * g.canvasW) / nat.canvasW)));
      ch = Math.min(g.canvasH, Math.max(1, Math.round((solo.canvasH * g.canvasH) / nat.canvasH)));
      phaseX = Math.round(cw / 2 - p / 2);
      phaseY = Math.round(ch / 2 - p / 2);
    }
    const shiftX = spec.shiftX * spec.offset * spec.hostW * sx;
    const shiftY = spec.shiftY * spec.offset * spec.hostH * sy;
    let x = latticeStart(g.originX, g.canvasW, cw, p, shiftX, phaseX);
    let y = latticeStart(g.originY, g.canvasH, ch, p, shiftY, phaseY);
    // No lattice position inside the frame (fits() rules that out at full resolution): the
    // nearest position to the target.
    if (x < 0) x = nearestStart(g.canvasW, cw, shiftX);
    if (y < 0) y = nearestStart(g.canvasH, ch, shiftY);
    m.cropX = x;
    m.cropY = y;
    m.cropW = cw;
    m.cropH = ch;
    m.cellDX = Math.round((x + cw / 2 - g.centerX) / p);
    m.cellDY = Math.round((y + ch / 2 - g.centerY) / p);
  }

  /**
   * Continues the picture of member `m` (the card that starts the group): the group's controller
   * takes over the state of the member's, moved to the member's window (see cropOf).
   */
  adoptFrom(m: SharedSeat): void {
    const spec = m.spec;
    if (!spec) return;
    this.cropOf(m);
    this.controller.adoptLook(spec.controller, -m.cellDX, -m.cellDY);
    this.updatedAt = spec.stateAt;
  }

  /**
   * Called by every member in its render phase, before it decides whether it presents: the first
   * call of a frame feeds the frame's timing to the picture's adaptive tier (the members' pace
   * follows the refresh it learns). Allocation-free.
   */
  beginFrame(now: number): void {
    if (now === this.frameAt) return;
    this.frameAt = now;
    const seat = this.seat;
    if (!seat || seat.released) return;
    const c = this.controller;
    const perf = c.perf;
    const first = this.members[0]?.spec;
    if (first && first.reducedMotion !== c.isReducedMotion) c.setReducedMotion(first.reducedMotion);
    // A long gap: every member was paused or away, not a slow frame. Every member runs this in
    // every frame it renders, presenting or not, so members paced down to a few presents per
    // second (render.maxFps, the secondary rate) never look like a pause here.
    const paused = this.lastNow >= 0 && now - this.lastNow > RESUME_GAP_MS;
    if (paused) this.resumedAt = now;
    const resumed = this.lastNow < 0 || paused;
    if (resumed) perf.resetWindow();
    const raw = resumed ? perf.vsyncMs : now - this.lastNow;
    this.lastNow = now;
    perf.setDisplayHint(displayIntervalMs(), displayEpoch());
    const busyMs = Math.max(this.updateMs, frameWorkMs() + frameLateMs());
    const change = c.samplePerf(raw, busyMs, seat.stats.gpuMs, now);
    if (change) {
      const q = this.qualityChange;
      q.scale = change.scale;
      q.quality = change.quality;
      q.reason = change.reason;
      this.qualityEpoch++;
    }
  }

  /**
   * A member presents in this frame: the first one advances the picture to it (by the time since
   * the last update, in whole refresh intervals, like an instance of its own) and submits the
   * group's seat, drawn in the present phase before any copy. Later calls of the frame do nothing.
   * `pace`: the presenting member's own step, ms (its frame divisor times the refresh interval;
   * 0: unknown): the longest step is bounded by it like an instance's of its own.
   */
  update(now: number, pace = 0): void {
    if (now === this.submittedAt) return;
    const seat = this.seat;
    if (!seat || seat.released) return;
    this.submittedAt = now;
    const c = this.controller;
    const vsync = c.perf.cadenceMs;
    // A picture taken over in this very frame (from a group that already ran in it) is current:
    // it is drawn as it is (a zero step still fills the frame inputs).
    let deltaMs = 0;
    let ideal = vsync;
    if (now !== this.updatedAt) {
      // Right after a pause (see beginFrame) the picture goes on by one refresh interval;
      // otherwise by the time since its last update, however rarely the members present.
      const resumed = this.updatedAt < 0 || this.resumedAt === now;
      deltaMs = resumed ? vsync : now - this.updatedAt;
      // Snap to vsync multiples: removes the rAF jitter from motion.
      ideal = Math.max(1, Math.round(deltaMs / vsync)) * vsync;
      if (Math.abs(deltaMs - ideal) < 0.15 * ideal) deltaMs = ideal;
    }
    const maxDt = Math.max(MAX_STEP_MS, 1.5 * (pace > 0 ? pace : ideal)) / 1000;
    this.dt = Math.min(deltaMs / 1000, maxDt);
    this.updatedAt = now;
    const t0 = performance.now();
    c.update(this.dt, now, maxDt);
    this.updateMs = performance.now() - t0;
    seat.submit();
  }

  // -------------------------------------------------------------------------------------------
  // SharedClient (the group's own seat): the members' state, folded.

  // Indexed loops in these getters: the renderer reads them every frame, and for-of allocates an
  // iterator until the code is optimized.
  get visible(): boolean {
    const ms = this.members;
    for (let i = 0; i < ms.length; i++) if (ms[i]?.client.visible) return true;
    return false;
  }

  // A group's seat is never queued nor idle: nothing ranks it (see BudgetMember).
  readonly inZone = true;
  readonly priority: InstancePriority = 'normal';
  readonly area = 0;
  readonly lastVisible = 0;

  /** Any member is active (pointer over it, a recent change): the picture runs at the full rate. */
  get active(): boolean {
    const ms = this.members;
    for (let i = 0; i < ms.length; i++) if (ms[i]?.client.active) return true;
    return false;
  }

  get layout(): ParamLayout {
    return this.controller.layout;
  }

  get frame(): FrameInputs {
    return this.controller.frame;
  }

  get naturalWidth(): number {
    return this.controller.naturalWidth;
  }

  get naturalHeight(): number {
    return this.controller.naturalHeight;
  }

  get expectedWidth(): number {
    return this.controller.naturalWidth;
  }

  get expectedHeight(): number {
    return this.controller.naturalHeight;
  }

  setShareScale(scale: number): void {
    this.controller.setShareScale(scale);
  }

  /** A group's seat is never idle: nothing to give back. */
  evict(): void {}

  attached(_seat: SharedSeat, restored: boolean): void {
    if (restored) this.controller.invalidateGpu();
  }

  /** The renderer tells every member itself (each keeps its last frame). */
  detached(): void {}

  /** The renderer fails the members itself. */
  failed(): void {}

  presented(drawn: boolean): void {
    if (!drawn) return;
    this.controller.commitFrame();
    this.shown = true;
  }

  /** Members drawing now (subscribed to the ticker). */
  get rendering(): boolean {
    const ms = this.members;
    for (let i = 0; i < ms.length; i++) if (ms[i]?.rendering) return true;
    return false;
  }

  destroy(): void {
    this.controller.destroy();
  }
}

/**
 * Start (device px) of a crop `size` wide in a frame `full` wide whose cell lattice starts at
 * `origin` with pitch `p`: as close as possible to the centered position plus `shift`, on a
 * position where the crop's lattice is the member's own (its grid starts at `phase` in its own
 * canvas), inside the frame. -1 when the frame has no such position; 0 for a crop larger than the
 * frame (clamped to it).
 */
function latticeStart(
  origin: number,
  full: number,
  size: number,
  p: number,
  shift: number,
  phase: number,
): number {
  const max = full - size;
  if (max < 0) return 0;
  const base = origin - phase;
  const target = max / 2 + shift;
  let x = base + p * Math.round((target - base) / p);
  if (x < 0) x += p * Math.ceil(-x / p);
  if (x > max) x -= p * Math.ceil((x - max) / p);
  return x < 0 || x > max ? -1 : x;
}

/** The centered start of a crop `size` wide in a frame `full` wide, plus `shift`, inside it. */
function nearestStart(full: number, size: number, shift: number): number {
  const max = full - size;
  return max <= 0 ? 0 : Math.min(max, Math.max(0, Math.round(max / 2 + shift)));
}
