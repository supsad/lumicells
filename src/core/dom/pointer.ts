/**
 * Pointer interaction on the host (config.interaction): a light that follows the pointer, lifts
 * under a hovering pointer and a ripple on click. Events only record client coordinates; the
 * conversion to host space happens in the measure phase with that frame's host rect.
 *
 * Click ripples: a mouse press ripples at once (pointerdown). A touch or pen contact ripples on
 * pointerup of the same pointer, only if no pointercancel arrived and it moved less than
 * TAP_SLOP px: pointerdown fires before the browser knows the gesture is a pan or a pinch, so
 * scrolling over an interactive background must not ripple on every swipe.
 * Hover lifts are off under reduced motion.
 */

import type { Controller, LiftRequest, PulseRequest } from '../controller/controller';
import { type Influence, SPACE_HOST } from '../controller/influences';
import type { LumiCellsConfig } from '../types';

const MAX_CLICKS = 8;
/** Minimum time between hover lifts, ms. */
const HOVER_LIFT_MS = 90;
/** Movement (CSS px) after which a touch/pen contact is a drag, not a tap. */
const TAP_SLOP = 10;

export class PointerInteraction {
  private ctl: AbortController | null = null;
  private light: Influence | null = null;
  private inside = false;
  private cx = 0;
  private cy = 0;
  private readonly clicks = new Float64Array(MAX_CLICKS * 2);
  private clickCount = 0;
  private pointerOn = false;
  private clickOn = false;
  private liftOn = false;
  private lastLiftAt = Number.NEGATIVE_INFINITY;
  private lastCellX = Number.NaN;
  private lastCellY = Number.NaN;
  /** Touch/pen contact that may become a tap (pointerId, -1 = none) and where it went down. */
  private tapId = -1;
  private tapX = 0;
  private tapY = 0;
  private readonly cell = new Float64Array(2);
  private readonly pulseReq: PulseRequest = { x: 0, y: 0, space: 'host' };
  private readonly liftReq: LiftRequest = { x: 0, y: 0, space: 'host', count: 1, radius: 0 };

  constructor(
    private readonly host: HTMLElement,
    private readonly controller: Controller,
    private readonly signal: AbortSignal,
  ) {}

  /** Host rect is needed while the pointer is inside (the page may scroll) or clicks wait. */
  get needsHostRect(): boolean {
    return (this.inside && this.pointerOn) || this.clickCount > 0;
  }

  configure(cfg: LumiCellsConfig['interaction']): void {
    const pointer = cfg.pointer;
    const click = cfg.click;
    this.liftOn = pointer && cfg.pointerLift;
    if (pointer === this.pointerOn && click === this.clickOn) return;
    this.pointerOn = pointer;
    this.clickOn = click;
    this.ctl?.abort();
    this.ctl = null;
    // The listeners that tracked these are gone, so their values can no longer be trusted: a
    // pointer that left meanwhile must not bring the light back at a stale position.
    this.inside = false;
    this.lastCellX = Number.NaN;
    this.lastCellY = Number.NaN;
    this.tapId = -1;
    if (this.light) this.light.hidden = true;
    if (!pointer && this.light) {
      this.controller.influences.dispose(this.light);
      this.light = null;
    }
    if (!pointer && !click) return;
    if (this.signal.aborted) return;
    const ctl = new AbortController();
    this.ctl = ctl;
    this.signal.addEventListener('abort', () => ctl.abort(), { once: true, signal: ctl.signal });
    const opts = { passive: true, signal: ctl.signal } as const;
    const h = this.host;
    if (pointer) {
      const move = (e: PointerEvent) => {
        this.cx = e.clientX;
        this.cy = e.clientY;
        this.inside = true;
      };
      const leave = (e: PointerEvent) => {
        if (e.type === 'pointerup' && e.pointerType === 'mouse') return;
        this.inside = false;
        if (this.light) this.light.hidden = true;
      };
      h.addEventListener('pointermove', move, opts);
      h.addEventListener('pointerenter', move, opts);
      h.addEventListener('pointerleave', leave, opts);
      h.addEventListener('pointercancel', leave, opts);
      h.addEventListener('pointerup', leave, opts);
    }
    if (click) {
      h.addEventListener(
        'pointerdown',
        (e: PointerEvent) => {
          if (!e.isPrimary || e.button !== 0) return;
          if (e.pointerType === 'mouse' || !e.pointerType) {
            this.queueClick(e.clientX, e.clientY);
          } else {
            this.tapId = e.pointerId;
            this.tapX = e.clientX;
            this.tapY = e.clientY;
          }
        },
        opts,
      );
      h.addEventListener(
        'pointermove',
        (e: PointerEvent) => {
          if (e.pointerId !== this.tapId) return;
          if (Math.hypot(e.clientX - this.tapX, e.clientY - this.tapY) > TAP_SLOP) this.tapId = -1;
        },
        opts,
      );
      h.addEventListener(
        'pointerup',
        (e: PointerEvent) => {
          if (e.pointerId !== this.tapId) return;
          this.tapId = -1;
          if (Math.hypot(e.clientX - this.tapX, e.clientY - this.tapY) > TAP_SLOP) return;
          this.queueClick(this.tapX, this.tapY);
        },
        opts,
      );
      h.addEventListener(
        'pointercancel',
        (e: PointerEvent) => {
          if (e.pointerId === this.tapId) this.tapId = -1;
        },
        opts,
      );
    }
  }

  private queueClick(x: number, y: number): void {
    if (this.clickCount >= MAX_CLICKS) return;
    const o = this.clickCount++ * 2;
    this.clicks[o] = x;
    this.clicks[o + 1] = y;
  }

  /** Measure phase: host padding-box origin in client px (NaN when not read). */
  measure(hostX: number, hostY: number, now: number): void {
    if (Number.isNaN(hostX)) return;
    const c = this.controller;
    for (let i = 0; i < this.clickCount; i++) {
      const p = this.pulseReq;
      p.x = (this.clicks[i * 2] as number) - hostX;
      p.y = (this.clicks[i * 2 + 1] as number) - hostY;
      c.pulse(p);
    }
    this.clickCount = 0;
    if (!this.pointerOn || !this.inside) return;
    const x = this.cx - hostX;
    const y = this.cy - hostY;
    let light = this.light;
    if (!light) {
      light = c.createInfluence({ space: 'host', type: 'light', fadeInMs: 120, fadeOutMs: 350 });
      light.priority = 100;
      this.light = light;
    }
    const cellCss = c.cellCss;
    c.influences.setShape(light, SPACE_HOST, x, y, Number.NaN, Number.NaN);
    light.radius = c.getEffective('interaction.pointerRadius') * cellCss * 0.5;
    light.falloff = c.getEffective('interaction.pointerRadius') * 0.5;
    light.strength = c.getEffective('interaction.pointerStrength');
    light.hidden = false;
    if (this.liftOn && !c.isReducedMotion && now - this.lastLiftAt >= HOVER_LIFT_MS) {
      c.cellAt(SPACE_HOST, x, y, this.cell);
      const cx = this.cell[0] as number;
      const cy = this.cell[1] as number;
      if (cx !== this.lastCellX || cy !== this.lastCellY) {
        this.lastCellX = cx;
        this.lastCellY = cy;
        this.lastLiftAt = now;
        const r = this.liftReq;
        r.x = x;
        r.y = y;
        c.lift(r);
      }
    }
  }

  dispose(): void {
    this.ctl?.abort();
    this.ctl = null;
    this.light = null;
  }
}
