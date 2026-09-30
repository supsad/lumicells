/**
 * Shared renderer: ONE WebGL context for every LumiCells instance created with
 * `renderer: 'shared'`.
 *
 * A page-wide manager (created on first use, nothing runs at import) owns one GpuDevice on a
 * canvas that never enters the document: the atlas. Each shared instance holds a seat: a
 * RenderSlot on the device (its own cell targets, uniform buffers, LUT) and, while it draws, a
 * region of the atlas (see atlas.ts). The ticker's `present` phase, after every instance ran its
 * render phase (controller update only, for shared instances), does two strict steps:
 *
 *   1. draw: every seat with a frame due draws its slot into its region (RegionSurface);
 *   2. copy: one series of drawImage(atlas, sx, sy, w, h, 0, 0, w, h) copies every region into
 *      its instance's own 2D canvas.
 *
 * Never interleaved: a drawImage() from a WebGL canvas makes the browser snapshot (and flush)
 * its drawing buffer, so draw-copy-draw-copy pays a pipeline flush per instance (measured: half
 * the frame rate). The copies run in the same task as the draws, so the atlas needs no
 * preserveDrawingBuffer, and every region is fully redrawn before it is copied (no clears).
 *
 * Some browsers (Firefox) snapshot the WHOLE drawing buffer again for every drawImage() from a
 * WebGL canvas, however small the region: the series then costs members x atlas (measured: 100
 * copies from a 1280x1024 atlas, 1 s). The copy path is chosen by measurement, not by browser:
 * the first frames with several copies time the direct copies; when a copy costs more than a
 * copy of its own pixels plausibly can (CHEAP_COPY_MS), the next frames time the staged path:
 * ONE drawImage of the used part of the atlas into a 2D staging canvas, then every region from
 * there. From then on each frame takes the cheaper of the two for its number of copies.
 *
 * The 2D canvases are sized to each instance's drawing buffer and stretched by CSS exactly like
 * an own canvas, so the copy is 1:1 (no filtering). When the drawing instances need more pixels
 * than the shared budget (LumiCells.configure({ sharedBudget })), all of them render at one
 * lower resolution (AtlasPlanner.planScale), decided once per frame before any of them updates.
 * The plan uses their sizes at full resolution (adaptive scale excluded: an adaptive step saves
 * pixels below the budget) and counts the instances about to draw too (so a mounting list drops
 * its scale once, not per batch of grants), and each instance keeps its grid at the lower
 * resolution (see Controller.setShareScale).
 *
 * Context budget: the device is one context on top of `maxContexts` (reserveSharedContext),
 * created through the scheduler's per-frame allowance when the first request is served, and
 * released (lost on purpose) when no instance holds or waits for a seat. Seats are granted at the
 * end of a frame, best ranked first, GRANTS_PER_FRAME per frame; first draws (which allocate the
 * slot's targets, with synchronous framebuffer checks) are limited to FIRST_DRAWS_PER_FRAME.
 *
 * Idle seats: an instance out of the creation zone (about one viewport beyond the screen) keeps
 * its seat, so it comes back without a new grant, but empties its 2D canvas at once (browsers cap
 * the canvas memory of a page). At most IDLE_SEATS_MIN, or IDLE_SEATS_PER_REGION per drawing
 * instance, idle seats are kept: past that the lowest ranked (longest away) park early, so a
 * fast scroll through a long list does not hold a slot for every card it passed.
 *
 * Context loss: every instance keeps the last frame in its 2D canvas and is told (`detached`).
 * On restore, or on a fresh canvas when the browser does not restore the context within
 * RESTORE_TIMEOUT_MS, the device and every slot are rebuilt (`attached` with `restored`). A
 * device that fails fails every current shared instance. Only a shader compile/link failure is
 * for good (the same GLSL would fail again: later requests fail at once); without a context (no
 * WebGL2, or the browser blocks new contexts for a while after GPU resets) or on a resource
 * failure, a later request tries a new device, like a new own instance does.
 */

import type { ParamLayout } from '../controller/layout';
import { GpuDevice, toEngineError } from '../engine/device';
import type { RenderSlot } from '../engine/slot';
import { RegionSurface } from '../engine/surface';
import type { EngineError, FrameInputs } from '../engine/types';
import { bucketSize, needsRealloc } from '../gl/target';
import { onFrameEnd, subscribeTicker } from '../ticker';
import type { SharedRendererStats } from '../types';
import { ATLAS_STEP, type AtlasItem, AtlasPlanner, createAtlasItem } from './atlas';
import { type BudgetMember, compareRank } from './context-budget';
import {
  claimContextCreation,
  noteFirstDraw,
  releaseSharedContext,
  reserveSharedContext,
  sharedBudgetPx,
} from './scheduler';

/** Seats granted per frame (a slot is a few small GL objects; its targets come with its first draw). */
export const GRANTS_PER_FRAME = 8;
/** First draws per frame: each allocates the slot's cell targets (synchronous framebuffer checks). */
export const FIRST_DRAWS_PER_FRAME = 4;
/** A lost shared context the browser has not restored by then is rebuilt on a fresh canvas. */
export const RESTORE_TIMEOUT_MS = 3000;
/** loseContextForTesting(): the simulated restore comes this much later (like the own path). */
const TEST_RESTORE_MS = 500;
/** Settled copy frames skipped before the calibration starts (the first copies set up images). */
const CALIBRATION_SKIP = 10;
/** Settled copy frames the calibration averages over (see noteCalibration). */
export const CALIBRATION_FRAMES = 60;
/** Idle seats kept whatever the number of drawing instances. */
export const IDLE_SEATS_MIN = 8;
/** Idle seats kept per drawing instance (see the header). */
export const IDLE_SEATS_PER_REGION = 2;
/** Region slack before a shrinking instance gets a smaller region (px bucket, see needsRealloc). */
const REGION_STEP = 16;
const EMA = 0.1;
/** Frames with several copies skipped before the copy path is probed (image set-up). */
const PROBE_SKIP = 2;
/** Frames with several copies each copy path is timed over. */
export const PROBE_FRAMES = 4;
/**
 * A direct copy (other than a frame's first, which pays the flush on either path) costing less
 * than this reads no more than its own pixels: the direct path stays, nothing else is tried.
 */
export const CHEAP_COPY_MS = 0.05;
/** The staged path is taken only when its estimate is below this share of the direct one. */
const STAGE_MARGIN = 0.75;

/** Copy path probe states (see the header): timing direct copies, timing staged ones, decided. */
const PROBE_DIRECT = 0;
const PROBE_STAGED = 1;
const DIRECT_ONLY = 2;
const CHOOSE = 3;

/** A shared instance as the renderer sees it. Callbacks run synchronously inside the renderer. */
export interface SharedClient extends BudgetMember {
  /** Creation order: tie-break for grants and for the atlas packing. */
  readonly order: number;
  /** The page's ParamLayout: every slot of the device must use its prelude. */
  readonly layout: ParamLayout;
  /** The instance's FrameInputs (a persistent object its controller refills every update). */
  readonly frame: FrameInputs;
  /** Drawing-buffer size at full resolution (share scale 1), device px. */
  readonly naturalWidth: number;
  readonly naturalHeight: number;
  /**
   * The natural size once the instance has been measured, else an estimate from its host's box
   * (for sizing the atlas ahead of instances that are about to draw).
   */
  readonly expectedWidth: number;
  readonly expectedHeight: number;
  /** Applies the uniform resolution factor of the shared pixel budget. */
  setShareScale(scale: number): void;
  /** Too many idle seats: give this one back (park). */
  evict(): void;
  /** Got a seat (a slot on the device); `restored`: rebuilt after a context loss. */
  attached(seat: SharedSeat, restored: boolean): void;
  /** The shared context is lost: the slot is gone, the 2D canvas keeps the last frame. */
  detached(): void;
  /** The device (or this slot) failed for good; the seat is released. */
  failed(error: EngineError): void;
  /**
   * The present phase of a frame the instance submitted is over: `drawn` the slot drew it (its
   * one-shot inputs are consumed), `shown` it was copied into the 2D canvas.
   */
  presented(drawn: boolean, shown: boolean, now: number): void;
}

/** One instance's place on the shared device, handed to it in `attached`. */
export class SharedSeat {
  /** Null while the context is lost. */
  slot: RenderSlot | null = null;
  surface: RegionSurface | null = null;
  /** Its region in the atlas (x < 0: none). */
  readonly item: AtlasItem;
  target: HTMLCanvasElement | null = null;
  ctx: CanvasRenderingContext2D | null = null;
  alpha = false;
  /** The 2D context state (composite op, smoothing) is set for the current canvas size. */
  ctxReady = false;
  /** Drawing (subscribed to the ticker): it needs a region. */
  rendering = false;
  /** Out of the creation zone: its 2D canvas is empty, the seat may be taken back. */
  idle = false;
  released = false;
  /** Drew at least once on the current slot (first draws are rate-limited). */
  everDrawn = false;
  /** This frame: the slot drew, the region was copied into the 2D canvas. */
  drawn = false;
  shown = false;
  /**
   * Main-thread time of its last draw and copy, ms (the copy with its share of the series'
   * snapshot or flush, see SharedRenderer.copy).
   */
  drawMs = 0;
  copyMs = 0;
  /** Pixels its last copy moved (0: not copied this frame). */
  copyPx = 0;

  constructor(
    private readonly owner: SharedRenderer,
    readonly client: SharedClient,
  ) {
    this.item = createAtlasItem(client.order);
  }

  /** The 2D canvas to copy into (a canvas's 2D context alpha is fixed: a new one for a change). */
  setTarget(canvas: HTMLCanvasElement | null, alpha: boolean): void {
    if (canvas === this.target && alpha === this.alpha) return;
    this.target = canvas;
    this.alpha = alpha;
    this.ctx = null;
    this.ctxReady = false;
  }

  setRendering(on: boolean): void {
    this.owner.setRendering(this, on);
  }

  /** Out of the creation zone (the instance emptied its 2D canvas) or back in it. */
  setIdle(on: boolean): void {
    this.owner.setIdle(this, on);
  }

  /** Called before the instance updates its controller: the budget scale is decided once per frame. */
  beginFrame(now: number): void {
    this.owner.beginFrame(now);
  }

  /** The instance updated its FrameInputs: draw and copy them in this frame's present phase. */
  submit(): void {
    this.owner.submit(this);
  }

  /** Gives the seat back (park, destroy, renderer switch). */
  release(): void {
    this.owner.release(this);
  }

  /** Simulates a loss of the shared context (and the restore about 0.5 s later). */
  loseContextForTesting(): void {
    this.owner.loseForTesting();
  }

  get maxDrawableSize(): number {
    return this.owner.maxDrawableSize;
  }

  get softwareFallback(): boolean {
    return this.owner.softwareFallback;
  }

  get rendererName(): string {
    return this.owner.rendererName;
  }

  /** Device-wide figures (a live object: copy what you keep). */
  get stats(): Readonly<SharedRendererStats> {
    return this.owner.stats;
  }
}

function byRank(x: SharedClient, y: SharedClient): number {
  return compareRank(y, x) || x.order - y.order;
}

export class SharedRenderer {
  readonly stats: SharedRendererStats = {
    gpuMs: null,
    drawMs: 0,
    copyMs: 0,
    snapshotMs: 0,
    copyMsPerMpx: null,
    atlasWidth: 0,
    atlasHeight: 0,
    members: 0,
    regions: 0,
    scale: 1,
    copyStaged: false,
  };
  /** Canvas resizes so far (each reallocates the atlas; tests and benches read it). */
  resizes = 0;
  private device: GpuDevice | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private canvasCtl: AbortController | null = null;
  private readonly seats: SharedSeat[] = [];
  private readonly queue = new Set<SharedClient>();
  /** Seats that submitted a frame since the last present phase (first `dueCount` entries). */
  private readonly due: (SharedSeat | null)[] = [];
  private dueCount = 0;
  private readonly items: AtlasItem[] = [];
  /** Drawing seats plus the ones about to draw (see relayout). */
  private readonly packItems: AtlasItem[] = [];
  private readonly comingPool: AtlasItem[] = [];
  private readonly planItems: AtlasItem[] = [];
  private readonly planPool: AtlasItem[] = [];
  private readonly planner = new AtlasPlanner();
  private renderingCount = 0;
  private idleCount = 0;
  private unhookTrim: (() => void) | null = null;
  private layoutDirty = true;
  private planAt = Number.NaN;
  private planKey = [-1, -1, -1, -1, -1, -1];
  /** Bumped whenever the queue changes (the budget plan counts the visible queued clients). */
  private queueEpoch = 0;
  private lost = false;
  private failure: EngineError | null = null;
  private restoreTimer: ReturnType<typeof setTimeout> | 0 = 0;
  private testTimer: ReturnType<typeof setTimeout> | 0 = 0;
  private unsubPresent: (() => void) | null = null;
  private unhookServe: (() => void) | null = null;
  private maxSide = 0;
  private calibSkip = 0;
  private calibFrames = 0;
  private calibMs = 0;
  private calibPx = 0;
  /** Atlas width, height and scale step the calibration was (re)started for. */
  private readonly calibKey = [-1, -1, -1];
  /** First draws in this frame's draw series (a frame of set-up, see noteCalibration). */
  private firstDrawsNow = 0;
  /** The staging canvas was resized in this frame. */
  private stagingResized = false;
  /** Copy path probe and its results (see the header). */
  private probe = PROBE_DIRECT as number;
  private probeSkip = 0;
  private probeFrames = 0;
  private probeMs = 0;
  private probeCount = 0;
  private probeUnits = 0;
  private probeSnapMs = 0;
  /** Direct: ms per copy (a frame's first one left out) per atlas megapixel. */
  private directMsPerMpx = 0;
  /** Staged: snapshot ms per megapixel snapshotted, and ms per region copy from the snapshot. */
  private snapMsPerMpx = 0;
  private stagedMsPerCopy = 0;
  private staging: HTMLCanvasElement | null = null;
  private stagingCtx: CanvasRenderingContext2D | null = null;
  private readonly tick = { present: (now: number) => this.present(now) };
  /** Adds a visible queued client to the budget plan (bound once: no closure per plan). */
  private readonly planQueued = (c: SharedClient): void => {
    if (c.visible) this.addPlanItem(c);
  };

  // -------------------------------------------------------------------------------------------
  // Membership

  /** Queues a request for a seat (served at the end of a frame). */
  request(c: SharedClient): void {
    if (this.queue.has(c)) return;
    this.queue.add(c);
    this.queueEpoch++;
    this.kick();
  }

  /** Withdraws a request that was not served yet. */
  cancel(c: SharedClient): void {
    if (!this.queue.delete(c)) return;
    this.queueEpoch++;
    if (this.queue.size === 0) this.unkick();
    this.maybeRelease();
  }

  release(seat: SharedSeat): void {
    if (seat.released) return;
    seat.released = true;
    const i = this.seats.indexOf(seat);
    if (i >= 0) this.seats.splice(i, 1);
    if (seat.rendering) {
      seat.rendering = false;
      this.renderingCount--;
      this.layoutDirty = true;
    }
    if (seat.idle) {
      seat.idle = false;
      this.idleCount--;
    }
    seat.slot?.dispose();
    seat.slot = null;
    seat.surface = null;
    seat.target = null;
    seat.ctx = null;
    this.stats.members = this.seats.length;
    this.syncPresent();
    this.maybeRelease();
  }

  setRendering(seat: SharedSeat, on: boolean): void {
    if (seat.released || seat.rendering === on) return;
    seat.rendering = on;
    this.renderingCount += on ? 1 : -1;
    this.layoutDirty = true;
    this.syncPresent();
  }

  setIdle(seat: SharedSeat, on: boolean): void {
    if (seat.released || seat.idle === on) return;
    seat.idle = on;
    this.idleCount += on ? 1 : -1;
    // Trimmed at the end of the frame, outside the instance's own callback.
    if (on && this.idleCount > this.idleCap() && !this.unhookTrim) {
      this.unhookTrim = onFrameEnd(() => this.trimIdle());
    }
  }

  /** Idle seats kept (see the header). */
  private idleCap(): number {
    return Math.max(IDLE_SEATS_MIN, IDLE_SEATS_PER_REGION * this.renderingCount);
  }

  /** Parks the lowest ranked idle seats until at most idleCap() are left. */
  private trimIdle(): void {
    this.unhookTrim?.();
    this.unhookTrim = null;
    while (this.idleCount > this.idleCap()) {
      let worst: SharedSeat | null = null;
      for (let i = 0; i < this.seats.length; i++) {
        const s = this.seats[i] as SharedSeat;
        if (s.idle && (!worst || compareRank(s.client, worst.client) < 0)) worst = s;
      }
      if (!worst) break;
      worst.client.evict();
      // An instance that did not give it back loses it anyway (the loop must end).
      if (!worst.released) this.release(worst);
    }
  }

  submit(seat: SharedSeat): void {
    // Bounded by the seats: a present phase that does not come cannot pile frames up.
    if (seat.released || !seat.slot || this.dueCount >= this.seats.length) return;
    this.due[this.dueCount++] = seat;
  }

  get maxDrawableSize(): number {
    return this.device?.caps.maxDrawableSize ?? 0;
  }

  get softwareFallback(): boolean {
    return this.device?.softwareFallback ?? false;
  }

  get rendererName(): string {
    return this.device?.caps.renderer ?? '';
  }

  /** Whether the device exists (alive, compiling or lost awaiting a restore). */
  get active(): boolean {
    return this.device !== null;
  }

  get seatCount(): number {
    return this.seats.length;
  }

  get pending(): number {
    return this.queue.size;
  }

  // -------------------------------------------------------------------------------------------
  // Serving requests (frame end)

  private kick(): void {
    if (!this.unhookServe) this.unhookServe = onFrameEnd((now) => this.serve(now));
  }

  private unkick(): void {
    this.unhookServe?.();
    this.unhookServe = null;
  }

  private serve(now: number): void {
    if (this.queue.size === 0) {
      this.unkick();
      return;
    }
    const failure = this.failure;
    if (failure) {
      const list = Array.from(this.queue);
      this.queue.clear();
      this.queueEpoch++;
      this.unkick();
      for (const c of list) c.failed(failure);
      return;
    }
    // A lost device serves nobody until it is rebuilt (the rebuild kicks again).
    if (this.lost) {
      this.unkick();
      return;
    }
    if (!this.device) {
      const first = this.queue.values().next().value as SharedClient;
      if (!claimContextCreation(now)) return;
      if (!this.createDevice(first.layout)) return;
    }
    const list = Array.from(this.queue).sort(byRank);
    let granted = 0;
    for (const c of list) {
      if (granted >= GRANTS_PER_FRAME || this.lost || this.failure || !this.device) break;
      if (!this.queue.has(c)) continue; // withdrawn by a callback earlier in this pass
      this.queue.delete(c);
      this.queueEpoch++;
      this.attach(c);
      granted++;
    }
    if (this.queue.size === 0) this.unkick();
  }

  private attach(c: SharedClient): void {
    const device = this.device as GpuDevice;
    let slot: RenderSlot;
    try {
      slot = device.createSlot({
        paramsPrelude: c.layout.glslPrelude,
        paramsVec4Count: c.layout.vec4Count,
      });
    } catch (err) {
      if (device.isContextLost()) {
        // Served again once the device is rebuilt.
        this.queue.add(c);
        this.queueEpoch++;
        this.enterLost();
        return;
      }
      c.failed(toEngineError(err, 'resource'));
      this.maybeRelease();
      return;
    }
    const seat = new SharedSeat(this, c);
    seat.slot = slot;
    seat.surface = new RegionSurface(device);
    this.seats.push(seat);
    this.stats.members = this.seats.length;
    c.setShareScale(this.planner.scale);
    c.attached(seat, false);
  }

  // -------------------------------------------------------------------------------------------
  // Device lifecycle

  private createDevice(layout: ParamLayout): boolean {
    const canvas = document.createElement('canvas');
    const ctl = new AbortController();
    canvas.addEventListener('webglcontextlost', (e) => this.onContextLost(e, canvas), {
      signal: ctl.signal,
    });
    canvas.addEventListener('webglcontextrestored', () => this.onContextRestored(canvas), {
      signal: ctl.signal,
    });
    this.canvas = canvas;
    this.canvasCtl = ctl;
    return this.buildDevice(layout);
  }

  /** A device on the current canvas (a new context, or the restored one). */
  private buildDevice(layout: ParamLayout): boolean {
    const canvas = this.canvas as HTMLCanvasElement;
    let device: GpuDevice | null = null;
    try {
      device = new GpuDevice(canvas, {
        opaque: false,
        paramsPrelude: layout.glslPrelude,
        warnMissingParams: false,
        // Later failures (a program that does not link) arrive from poll() in the present phase.
        onError: (err) => {
          if (device && this.device === device) this.fail(err);
        },
      });
    } catch (err) {
      this.fail(toEngineError(err, 'no-webgl2'));
      return false;
    }
    reserveSharedContext();
    this.device = device;
    this.maxSide = device.caps.maxDrawableSize;
    this.planner.resetSize();
    this.layoutDirty = true;
    if (device.error) {
      this.fail(device.error);
      return false;
    }
    if (device.isContextLost()) {
      this.enterLost();
      return false;
    }
    this.syncPresent();
    return true;
  }

  /** Nobody holds or waits for a seat: release the context now instead of waiting for GC. */
  private maybeRelease(): void {
    if (this.seats.length === 0 && this.queue.size === 0 && (this.device || this.canvas)) {
      this.releaseDevice();
    }
  }

  /** Tests only: releases the device (if any) and forgets everything. */
  resetForTesting(): void {
    this.queue.clear();
    this.queueEpoch++;
    this.unkick();
    this.unhookTrim?.();
    this.unhookTrim = null;
    for (const seat of this.seats.slice()) this.release(seat);
    this.releaseDevice();
  }

  private releaseDevice(): void {
    this.clearTimers();
    // Stop listening first: the release below must not come back as a context loss.
    this.canvasCtl?.abort();
    this.canvasCtl = null;
    const dev = this.device;
    this.device = null;
    this.canvas = null;
    if (dev) {
      dev.dispose();
      try {
        dev.loseContextForTesting();
      } catch {
        // Already lost.
      }
    }
    this.lost = false;
    this.planner.resetSize();
    this.layoutDirty = true;
    this.planKey[0] = -1;
    this.syncPresent();
    // The staging canvas holds a copy of the atlas: free its memory too.
    if (this.staging) {
      this.staging.width = 0;
      this.staging.height = 0;
    }
    this.staging = null;
    this.stagingCtx = null;
    const s = this.stats;
    s.atlasWidth = 0;
    s.atlasHeight = 0;
    s.gpuMs = null;
    s.regions = 0;
    s.copyStaged = false;
    releaseSharedContext();
  }

  /**
   * The device failed: every seat and queued request fails with `err`, and the device goes.
   * Only a compile/link failure is remembered (see the header).
   */
  private fail(err: EngineError): void {
    if (this.failure) return;
    if (err.code === 'compile') this.failure = err;
    const seats = this.seats.slice();
    const queued = Array.from(this.queue);
    this.queue.clear();
    this.queueEpoch++;
    for (const s of seats) {
      this.release(s);
      s.client.failed(err);
    }
    for (const c of queued) c.failed(err);
    this.releaseDevice();
  }

  private clearTimers(): void {
    if (this.restoreTimer) clearTimeout(this.restoreTimer);
    this.restoreTimer = 0;
    if (this.testTimer) clearTimeout(this.testTimer);
    this.testTimer = 0;
  }

  private syncPresent(): void {
    const want = this.renderingCount > 0 && this.device !== null && !this.lost;
    if (want && !this.unsubPresent) this.unsubPresent = subscribeTicker(this.tick);
    else if (!want && this.unsubPresent) {
      this.unsubPresent();
      this.unsubPresent = null;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Context loss

  private onContextLost(e: Event, canvas: HTMLCanvasElement): void {
    // Without preventDefault the browser never restores the context.
    e.preventDefault();
    if (canvas === this.canvas) this.enterLost();
  }

  private onContextRestored(canvas: HTMLCanvasElement): void {
    if (canvas === this.canvas && this.lost) this.rebuild(false);
  }

  /**
   * The shared context is gone: every slot died with it. The instances keep their last frame;
   * the device object stays until the rebuild (a simulated loss restores through it).
   */
  private enterLost(): void {
    // No device: it was released (e.g. its last seat failed while drawing), nothing is lost.
    if (this.lost || !this.device) return;
    this.lost = true;
    const seats = this.seats.slice();
    for (const s of seats) {
      s.slot?.dispose();
      s.slot = null;
      s.surface = null;
      s.everDrawn = false;
      s.item.x = -1;
    }
    this.device?.dispose();
    this.dueCount = 0;
    this.syncPresent();
    if (this.restoreTimer) clearTimeout(this.restoreTimer);
    this.restoreTimer = setTimeout(() => {
      this.restoreTimer = 0;
      if (this.lost) this.rebuild(true);
    }, RESTORE_TIMEOUT_MS);
    for (const s of seats) if (!s.released) s.client.detached();
  }

  /**
   * Rebuilds the device and every slot after a loss: on the restored context of the same canvas,
   * or (`fresh`) on a new canvas when the browser did not restore it in time.
   */
  private rebuild(fresh: boolean): void {
    this.clearTimers();
    if (this.seats.length === 0 && this.queue.size === 0) {
      this.releaseDevice();
      return;
    }
    const first = this.seats[0]?.client ?? (this.queue.values().next().value as SharedClient);
    this.device = null;
    this.lost = false;
    const ok = fresh ? this.freshCanvas(first.layout) : this.buildDevice(first.layout);
    if (!ok) return;
    const device = this.device as unknown as GpuDevice;
    for (const s of this.seats.slice()) {
      if (s.released) continue;
      try {
        s.slot = device.createSlot({
          paramsPrelude: s.client.layout.glslPrelude,
          paramsVec4Count: s.client.layout.vec4Count,
        });
      } catch (err) {
        if (device.isContextLost()) {
          this.enterLost();
          return;
        }
        this.release(s);
        s.client.failed(toEngineError(err, 'resource'));
        continue;
      }
      s.surface = new RegionSurface(device);
      s.everDrawn = false;
      s.client.setShareScale(this.planner.scale);
      s.client.attached(s, true);
    }
    this.layoutDirty = true;
    if (this.queue.size > 0) this.kick();
  }

  private freshCanvas(layout: ParamLayout): boolean {
    this.canvasCtl?.abort();
    this.canvasCtl = null;
    this.canvas = null;
    return this.createDevice(layout);
  }

  loseForTesting(): void {
    const dev = this.device;
    if (!dev || this.lost) return;
    dev.loseContextForTesting();
    if (this.testTimer) clearTimeout(this.testTimer);
    this.testTimer = setTimeout(() => {
      this.testTimer = 0;
      if (this.device === dev && this.lost) dev.restoreContextForTesting();
    }, TEST_RESTORE_MS);
  }

  // -------------------------------------------------------------------------------------------
  // Frame

  /**
   * Once per frame, before the first shared instance updates: re-plans the budget scale when the
   * full-resolution sizes (or the budget) changed, so every instance updates with the scale of
   * this frame. The plan counts the instances about to draw too (the same set relayout sizes the
   * atlas for: seated but not drawing yet, and queued, while on screen): a list mounting together
   * then takes its final scale once, instead of one step per batch of grants, each of which
   * would resize every member's 2D canvas. The queue is folded into the key by its epoch (it
   * changes with every grant), so the per-frame check stays O(seats).
   */
  beginFrame(now: number): void {
    if (now === this.planAt) return;
    this.planAt = now;
    if (!this.device || this.lost) return;
    const budget = sharedBudgetPx();
    let n = 0;
    let area = 0;
    let sumW = 0;
    let mix = 0;
    const seats = this.seats;
    for (let i = 0; i < seats.length; i++) {
      const s = seats[i] as SharedSeat;
      if (!this.inPlan(s)) continue;
      // Natural size once measured, else the estimate from the host's box.
      const w = s.client.expectedWidth;
      const h = s.client.expectedHeight;
      n++;
      area += w * h;
      sumW += w;
      mix += (w * 4099 + h) * ((s.client.order % 997) + 1);
    }
    const key = this.planKey;
    const epoch = this.queue.size > 0 ? this.queueEpoch : -1;
    if (
      key[0] === n &&
      key[1] === area &&
      key[2] === sumW &&
      key[3] === mix &&
      key[4] === budget &&
      key[5] === epoch
    ) {
      return;
    }
    key[0] = n;
    key[1] = area;
    key[2] = sumW;
    key[3] = mix;
    key[4] = budget;
    key[5] = epoch;
    const items = this.planItems;
    items.length = 0;
    for (let i = 0; i < seats.length; i++) {
      const s = seats[i] as SharedSeat;
      if (this.inPlan(s)) this.addPlanItem(s.client);
    }
    this.queue.forEach(this.planQueued);
    if (this.planner.planScale(items, budget, this.maxSide)) this.applyScale();
  }

  /**
   * A seat the budget plan counts: drawing, or seated on screen and about to draw (it never drew
   * on this slot: a seat that stopped drawing while on screen, e.g. a paused instance, does not
   * hold the others' resolution down).
   */
  private inPlan(s: SharedSeat): boolean {
    return s.slot !== null && (s.rendering || (s.client.visible && !s.everDrawn));
  }

  /** Appends `c` at its expected full-resolution size to the budget plan's items. */
  private addPlanItem(c: SharedClient): void {
    const items = this.planItems;
    let it = this.planPool[items.length];
    if (!it) {
      it = createAtlasItem();
      this.planPool.push(it);
    }
    it.w = Math.max(1, Math.floor(c.expectedWidth));
    it.h = Math.max(1, Math.floor(c.expectedHeight));
    it.order = c.order;
    items.push(it);
  }

  private applyScale(): void {
    const scale = this.planner.scale;
    this.stats.scale = scale;
    for (let i = 0; i < this.seats.length; i++) {
      (this.seats[i] as SharedSeat).client.setShareScale(scale);
    }
    this.layoutDirty = true;
  }

  /** The ticker's present phase: draw every due seat into the atlas, then copy them all. */
  present(now: number): void {
    const n = this.dueCount;
    if (n === 0) return;
    const due = this.due;
    try {
      const device = this.device;
      if (!device || this.lost || !this.canvas) return;
      if (device.isContextLost()) {
        this.enterLost();
        return;
      }
      if (!device.poll()) return; // compiling, or failed (fail() released every seat)
      if (this.layoutDirty || this.regionsStale(n)) this.relayout(device);
      this.draw(device, n, now);
      // Released while drawing (its last seat failed): nothing left to copy or to lose.
      if (this.device !== device) return;
      if (device.isContextLost()) {
        this.enterLost();
        return;
      }
      this.copy(n);
    } finally {
      this.dueCount = 0;
      // Every due instance hears about its frame (drawn and copied, or not), even on a failure.
      for (let i = 0; i < n; i++) {
        const s = due[i] as SharedSeat;
        due[i] = null;
        const drawn = s.drawn;
        const shown = s.shown;
        s.drawn = false;
        s.shown = false;
        if (!s.released) s.client.presented(drawn, shown, now);
      }
    }
  }

  /** A due seat has no region, or its frame outgrew (or clearly undershoots) its region. */
  private regionsStale(n: number): boolean {
    for (let i = 0; i < n; i++) {
      const s = this.due[i] as SharedSeat;
      if (s.released || !s.slot) continue;
      const f = s.client.frame;
      const it = s.item;
      if (it.x < 0) return true;
      const w = Math.max(1, Math.floor(f.canvasWidth));
      const h = Math.max(1, Math.floor(f.canvasHeight));
      if (needsRealloc(it.w, w, REGION_STEP) || needsRealloc(it.h, h, REGION_STEP)) return true;
    }
    return false;
  }

  /**
   * Packs every drawing seat at its current size and resizes the atlas when the plan says so.
   * The atlas is sized for the instances about to draw too (seated but not drawing yet, and
   * queued, while on screen): a resize is a synchronous call that waits for every command the
   * GPU process has not run yet, cheap while the device is idle and costly (measured 8 to 44 ms)
   * behind the draws of a hundred instances. A list mounting together then resizes the atlas
   * once instead of once per batch of grants.
   */
  private relayout(device: GpuDevice): void {
    this.layoutDirty = false;
    const items = this.items;
    items.length = 0;
    const seats = this.seats;
    for (let i = 0; i < seats.length; i++) {
      const s = seats[i] as SharedSeat;
      const it = s.item;
      if (!s.rendering || !s.slot) {
        it.x = -1;
        it.y = -1;
        continue;
      }
      const f = s.client.frame;
      it.w = Math.max(1, Math.floor(f.canvasWidth));
      it.h = Math.max(1, Math.floor(f.canvasHeight));
      it.order = s.client.order;
      items.push(it);
    }
    this.stats.regions = items.length;
    if (items.length === 0) return;
    const pack = this.packItems;
    pack.length = 0;
    for (let i = 0; i < items.length; i++) pack.push(items[i] as AtlasItem);
    this.addComing(pack);
    const canvas = this.canvas as HTMLCanvasElement;
    for (let attempt = 0; attempt < 3; attempt++) {
      let resized = this.planner.layout(pack, this.maxSide);
      if (!this.planner.fits && pack.length > items.length) {
        // The instances to come do not fit as well: lay out the drawing ones alone.
        pack.length = items.length;
        resized = this.planner.layout(pack, this.maxSide) || resized;
      }
      if (resized) {
        canvas.width = this.planner.width;
        canvas.height = this.planner.height;
        this.resizes++;
        // The browser may give a smaller drawing buffer than asked (memory limits): lay out
        // again within what it gave.
        const gw = device.gl.drawingBufferWidth;
        const gh = device.gl.drawingBufferHeight;
        if (gw < this.planner.width || gh < this.planner.height) {
          this.maxSide = Math.max(1, Math.min(this.maxSide, gw, gh));
          this.planner.resetSize();
          continue;
        }
      }
      break;
    }
    this.stats.atlasWidth = this.planner.width;
    this.stats.atlasHeight = this.planner.height;
    // Only past the drawable limit: the next frames render smaller (nobody is dropped).
    if (!this.planner.fits && this.planner.stepDown()) this.applyScale();
  }

  /**
   * Appends placeholders for the instances about to draw: seated but not drawing yet, or still
   * queued, while on screen (at their full size times the current budget scale).
   */
  private addComing(pack: AtlasItem[]): void {
    const pool = this.comingPool;
    const scale = this.planner.scale;
    let k = 0;
    const add = (c: SharedClient) => {
      let it = pool[k];
      if (!it) {
        it = createAtlasItem();
        pool.push(it);
      }
      k++;
      it.w = Math.max(1, Math.floor(c.expectedWidth * scale));
      it.h = Math.max(1, Math.floor(c.expectedHeight * scale));
      it.order = c.order;
      pack.push(it);
    };
    for (let i = 0; i < this.seats.length; i++) {
      const s = this.seats[i] as SharedSeat;
      if (!s.rendering && s.slot && s.client.visible) add(s.client);
    }
    for (const c of this.queue) if (c.visible) add(c);
  }

  /**
   * The draw series. First draws go first, together: a slot's first draw allocates its targets,
   * and the framebuffer checks that come with them are synchronous calls that wait until the GPU
   * process has run every command queued before them. The first check of a frame pays for the
   * backlog left by earlier frames (several ms while a hundred instances keep the GPU process
   * busy), the following ones only for the few commands queued since; behind this frame's
   * regular draws every first draw would pay for all of them again (measured: 2.5 to 15 ms per
   * first draw behind 100 drawing slots). At most FIRST_DRAWS_PER_FRAME per frame.
   */
  private draw(device: GpuDevice, n: number, now: number): void {
    const timer = device.timer;
    const due = this.due;
    let firstDraws = 0;
    let total = 0;
    timer?.begin();
    for (let i = 0; i < n; i++) {
      const s = due[i] as SharedSeat;
      s.drawn = false;
      s.drawMs = 0;
      if (s.everDrawn || firstDraws >= FIRST_DRAWS_PER_FRAME) continue;
      if (!this.drawSeat(device, s) || this.device !== device) break;
      total += s.drawMs;
      if (s.drawn) {
        s.everDrawn = true;
        firstDraws++;
      }
    }
    // The regular draws (the first ones above have `drawn` set; a lost device stops them).
    for (let i = 0; i < n && this.device === device && !device.isContextLost(); i++) {
      const s = due[i] as SharedSeat;
      if (!s.everDrawn || s.drawn) continue;
      if (!this.drawSeat(device, s)) break;
      total += s.drawMs;
    }
    if (this.device !== device) return; // released while drawing: its timer is gone
    timer?.end();
    this.firstDrawsNow = firstDraws;
    if (firstDraws > 0) noteFirstDraw(now);
    const st = this.stats;
    st.drawMs += (total - st.drawMs) * EMA;
    st.gpuMs = timer?.ms ?? null;
  }

  /** Draws one seat into its region. False when the context got lost (stop drawing). */
  private drawSeat(device: GpuDevice, s: SharedSeat): boolean {
    const slot = s.slot;
    const surface = s.surface;
    const it = s.item;
    if (s.released || !slot || !surface || it.x < 0) return true;
    surface.moveTo(it.x, it.y);
    const t0 = performance.now();
    try {
      s.drawn = slot.draw(s.client.frame, surface, null);
    } catch (err) {
      s.drawn = false;
      if (device.isContextLost()) return false;
      // A resource failure of this slot alone (e.g. its targets could not be allocated).
      this.release(s);
      s.client.failed(toEngineError(err, 'resource'));
      return true;
    }
    s.drawMs = performance.now() - t0;
    return true;
  }

  /**
   * The copy series. Each seat's `copyMs` is its own cost (canvas set-up and its drawImage) plus
   * a share, by pixels, of the part of the series no single copy owns: the snapshot of the atlas
   * (staged), or the flush the first drawImage from the WebGL canvas pays (direct: estimated as
   * the first copy's excess over the others' mean). The first member copied would otherwise
   * carry the whole device's flush in its cpuMs and presentMs.
   */
  private copy(n: number): void {
    const atlas = this.canvas as HTMLCanvasElement;
    const due = this.due;
    // This frame's copies, and the part of the atlas their regions cover.
    let count = 0;
    let bw = 0;
    let bh = 0;
    for (let i = 0; i < n; i++) {
      const s = due[i] as SharedSeat;
      s.copyMs = 0;
      s.copyPx = 0;
      if (!s.drawn || s.released || !s.target) continue;
      const f = s.client.frame;
      count++;
      bw = Math.max(bw, s.item.x + Math.max(1, Math.floor(f.canvasWidth)));
      bh = Math.max(bh, s.item.y + Math.max(1, Math.floor(f.canvasHeight)));
    }
    if (count === 0) return;
    let src: HTMLCanvasElement = atlas;
    let snapMs = 0;
    this.stagingResized = false;
    if (count >= 2 && this.wantsStaging(count, bw, bh)) {
      const t0 = performance.now();
      const stage = this.snapshot(atlas, bw, bh);
      snapMs = performance.now() - t0;
      if (stage) src = stage;
    }
    const staged = src !== atlas;
    // Frames that resize or set up canvases (a list joining) are left out of the calibration.
    let churn = this.stagingResized || this.firstDrawsNow > 0 || this.queue.size > 0;
    let copied = 0;
    let setupMs = 0;
    let regionMs = 0;
    let firstMs = -1;
    let first: SharedSeat | null = null;
    let px = 0;
    for (let i = 0; i < n; i++) {
      const s = due[i] as SharedSeat;
      if (!s.drawn || s.released) continue;
      const target = s.target;
      if (!target) continue;
      const f = s.client.frame;
      const w = Math.max(1, Math.floor(f.canvasWidth));
      const h = Math.max(1, Math.floor(f.canvasHeight));
      const t0 = performance.now();
      // A new size clears the canvas and resets its context state.
      if (target.width !== w || target.height !== h) {
        target.width = w;
        target.height = h;
        s.ctxReady = false;
        churn = true;
      }
      let ctx = s.ctx;
      if (!ctx) {
        ctx = target.getContext('2d', { alpha: s.alpha });
        s.ctx = ctx;
        s.ctxReady = false;
        churn = true;
        if (!ctx) {
          setupMs += performance.now() - t0;
          continue;
        }
      }
      if (!s.ctxReady) {
        // Replace, never blend: a transparent overflow margin must not pile up over old frames.
        // 1:1 copy at whole pixels: no filtering.
        ctx.globalCompositeOperation = 'copy';
        ctx.imageSmoothingEnabled = false;
        s.ctxReady = true;
      }
      const t1 = performance.now();
      // The staging canvas holds the atlas at the same coordinates.
      ctx.drawImage(src, s.item.x, s.item.y, w, h, 0, 0, w, h);
      const dt = performance.now() - t1;
      s.shown = true;
      s.copyMs = t1 - t0 + dt;
      s.copyPx = w * h;
      copied++;
      if (!first) {
        first = s;
        firstMs = dt;
      }
      setupMs += t1 - t0;
      regionMs += dt;
      px += w * h;
    }
    // The series cost no single copy owns (see above), spread over the copies by pixels.
    let common = snapMs;
    if (!staged && first && copied >= 2) {
      const flush = Math.max(0, firstMs - (regionMs - firstMs) / (copied - 1));
      first.copyMs -= flush;
      common = flush;
    }
    if (common > 0 && px > 0) {
      const perPx = common / px;
      for (let i = 0; i < n; i++) {
        const s = due[i] as SharedSeat;
        if (s.copyPx > 0) s.copyMs += perPx * s.copyPx;
      }
    }
    const st = this.stats;
    st.copyMs += (snapMs + setupMs + regionMs - st.copyMs) * EMA;
    // A lone direct copy cannot tell its flush from its own cost: the estimate waits.
    if (staged || copied >= 2) st.snapshotMs += (common - st.snapshotMs) * EMA;
    st.copyStaged = staged;
    if (copied === 0) return;
    this.noteCopyCost(staged, copied, regionMs, Math.max(0, firstMs), snapMs, bw * bh);
    // Snapshot included, canvas set-up excluded: what the copies of these pixels cost.
    this.noteCalibration(churn, copied, snapMs + regionMs, px);
  }

  /**
   * Feeds the copy cost calibration (copyMsPerMpx) with a frame of `count` copies, `px` pixels in
   * `ms`. Only settled frames count: no canvas resized or set up, no grant or first draw pending,
   * the copy path decided. A new atlas size or budget scale re-arms it (the cost per pixel
   * depends on both: null again until the new one is measured).
   */
  private noteCalibration(churn: boolean, count: number, ms: number, px: number): void {
    const st = this.stats;
    const p = this.planner;
    const k = this.calibKey;
    if (k[0] !== p.width || k[1] !== p.height || k[2] !== p.step) {
      k[0] = p.width;
      k[1] = p.height;
      k[2] = p.step;
      this.calibSkip = 0;
      this.calibFrames = 0;
      this.calibMs = 0;
      this.calibPx = 0;
      st.copyMsPerMpx = null;
    }
    if (st.copyMsPerMpx !== null || px <= 0 || churn) return;
    if (count >= 2 && (this.probe === PROBE_DIRECT || this.probe === PROBE_STAGED)) return;
    if (this.calibSkip < CALIBRATION_SKIP) {
      this.calibSkip++;
      return;
    }
    this.calibMs += ms;
    this.calibPx += px;
    if (++this.calibFrames >= CALIBRATION_FRAMES) {
      st.copyMsPerMpx = this.calibMs / (this.calibPx / 1e6);
    }
  }

  /** Whether this frame's `count` copies (regions within `bw` x `bh`) go through a snapshot. */
  private wantsStaging(count: number, bw: number, bh: number): boolean {
    switch (this.probe) {
      case PROBE_STAGED:
        return true;
      case CHOOSE: {
        const atlasMpx = (this.planner.width * this.planner.height) / 1e6;
        const direct = count * this.directMsPerMpx * atlasMpx;
        const staged = this.snapMsPerMpx * ((bw * bh) / 1e6) + count * this.stagedMsPerCopy;
        return staged < STAGE_MARGIN * direct;
      }
      default:
        return false;
    }
  }

  /**
   * One snapshot of the atlas's used part (`w` x `h` from its top-left corner) in the staging
   * canvas, for every copy of this frame. Null when no 2D context can be had (copy directly).
   */
  private snapshot(atlas: HTMLCanvasElement, w: number, h: number): HTMLCanvasElement | null {
    let stage = this.staging;
    if (!stage) {
      stage = document.createElement('canvas');
      this.staging = stage;
      this.stagingCtx = null;
    }
    // Sized in atlas buckets with the same hysteresis: it follows the atlas, not every frame.
    if (needsRealloc(stage.width, w, ATLAS_STEP) || needsRealloc(stage.height, h, ATLAS_STEP)) {
      stage.width = bucketSize(w, ATLAS_STEP);
      stage.height = bucketSize(h, ATLAS_STEP);
      this.stagingCtx = null;
      this.stagingResized = true;
    }
    let ctx = this.stagingCtx;
    if (!ctx) {
      ctx = stage.getContext('2d');
      if (!ctx) return null;
      // Replace: transparent atlas pixels must stay transparent.
      ctx.globalCompositeOperation = 'copy';
      ctx.imageSmoothingEnabled = false;
      this.stagingCtx = ctx;
    }
    ctx.drawImage(atlas, 0, 0, w, h, 0, 0, w, h);
    return stage;
  }

  /**
   * Feeds the copy path probe with a frame of `count` copies: `regionMs` for the region copies
   * (`firstMs` of it the first one), `snapMs` for the snapshot of `snapPx` pixels when staged.
   */
  private noteCopyCost(
    staged: boolean,
    count: number,
    regionMs: number,
    firstMs: number,
    snapMs: number,
    snapPx: number,
  ): void {
    const probe = this.probe;
    if (count < 2 || (probe !== PROBE_DIRECT && probe !== PROBE_STAGED)) return;
    if (this.probeSkip < PROBE_SKIP) {
      this.probeSkip++;
      return;
    }
    if (probe === PROBE_DIRECT && !staged) {
      // The first copy of a frame pays the flush on either path: left out.
      const atlasMpx = Math.max(1e-6, (this.planner.width * this.planner.height) / 1e6);
      this.probeMs += Math.max(0, regionMs - firstMs);
      this.probeCount += count - 1;
      this.probeUnits += (count - 1) * atlasMpx;
      if (++this.probeFrames < PROBE_FRAMES) return;
      const perCopy = this.probeMs / this.probeCount;
      this.directMsPerMpx = this.probeMs / this.probeUnits;
      this.resetProbe();
      this.probe = perCopy < CHEAP_COPY_MS ? DIRECT_ONLY : PROBE_STAGED;
    } else if (probe === PROBE_STAGED && staged) {
      this.probeMs += regionMs;
      this.probeCount += count;
      this.probeSnapMs += snapMs;
      this.probeUnits += snapPx / 1e6;
      if (++this.probeFrames < PROBE_FRAMES) return;
      this.snapMsPerMpx = this.probeSnapMs / Math.max(1e-6, this.probeUnits);
      this.stagedMsPerCopy = this.probeMs / this.probeCount;
      this.resetProbe();
      this.probe = CHOOSE;
    }
  }

  private resetProbe(): void {
    this.probeFrames = 0;
    this.probeMs = 0;
    this.probeCount = 0;
    this.probeUnits = 0;
    this.probeSnapMs = 0;
  }
}

let shared: SharedRenderer | null = null;

/** The page's shared renderer (created on first use). */
export function getSharedRenderer(): SharedRenderer {
  if (!shared) shared = new SharedRenderer();
  return shared;
}

/** The page's shared renderer if one was ever needed (tests, benches). */
export function peekSharedRenderer(): SharedRenderer | null {
  return shared;
}

/** Tests only: forget the renderer (its device, if any, is released first). */
export function resetSharedForTesting(): void {
  const s = shared;
  shared = null;
  s?.resetForTesting();
}
