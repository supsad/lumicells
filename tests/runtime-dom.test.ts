// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Controller } from '../src/core/controller/controller';
import { mulberry32 } from '../src/core/controller/math';
import { PointerInteraction } from '../src/core/dom/pointer';
import { ElementTracker } from '../src/core/dom/tracking';
import { getDefaults } from '../src/schema';

const hosts: HTMLElement[] = [];
afterEach(() => {
  for (const h of hosts.splice(0)) h.remove();
});

function setup() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  hosts.push(host);
  const c = new Controller({ random: mulberry32(3) });
  c.setViewport({ hostCssW: 400, hostCssH: 300, dpr: 1, deviceW: 0, deviceH: 0 });
  const ctl = new AbortController();
  return { host, c, ctl };
}

function interaction(p: Partial<ReturnType<typeof getDefaults>['interaction']>) {
  return { ...getDefaults().interaction, ...p };
}

function pointer(
  target: EventTarget,
  type: string,
  x: number,
  y: number,
  o: { pointerType?: string; pointerId?: number } = {},
): void {
  const e = new PointerEvent(type, { clientX: x, clientY: y, bubbles: false, button: 0 });
  Object.defineProperty(e, 'pointerType', { value: o.pointerType ?? 'mouse' });
  Object.defineProperty(e, 'pointerId', { value: o.pointerId ?? 1 });
  Object.defineProperty(e, 'isPrimary', { value: true });
  target.dispatchEvent(e);
}

describe('PointerInteraction', () => {
  it('toggling the pointer off and on does not bring the light back at a stale position', () => {
    const { host, c, ctl } = setup();
    const pi = new PointerInteraction(host, c, ctl.signal);
    pi.configure(interaction({ pointer: true }));
    pointer(host, 'pointerenter', 50, 60);
    pi.measure(0, 0, 0);
    expect(pi.needsHostRect).toBe(true);
    pi.configure(interaction({ pointer: false }));
    // The pointer leaves while nobody listens, then the pointer light is switched back on.
    pointer(host, 'pointerleave', 500, 500);
    pi.configure(interaction({ pointer: true }));
    expect(pi.needsHostRect).toBe(false);
    pi.measure(0, 0, 16);
    const alive = (c.influences as unknown as { list: { hidden: boolean }[] }).list;
    expect(alive.filter((e) => !e.hidden).length).toBe(0);
    // It comes back with the next real pointer event.
    pointer(host, 'pointermove', 70, 80);
    pi.measure(0, 0, 32);
    expect(alive.filter((e) => !e.hidden).length).toBe(1);
    ctl.abort();
  });

  it('touch: ripples on a tap only, not on scroll/pan gestures', () => {
    const { host, c, ctl } = setup();
    const pi = new PointerInteraction(host, c, ctl.signal);
    pi.configure(interaction({ click: true }));
    const touch = { pointerType: 'touch', pointerId: 7 };
    // Swipe: down, then the browser takes over the pan (pointercancel).
    pointer(host, 'pointerdown', 100, 100, touch);
    pi.measure(0, 0, 0);
    expect(c.pulses.count).toBe(0);
    pointer(host, 'pointercancel', 100, 60, touch);
    pi.measure(0, 0, 16);
    expect(c.pulses.count).toBe(0);
    // Drag beyond the slop, then up: still not a tap.
    pointer(host, 'pointerdown', 100, 100, touch);
    pointer(host, 'pointermove', 100, 130, touch);
    pointer(host, 'pointerup', 100, 130, touch);
    pi.measure(0, 0, 32);
    expect(c.pulses.count).toBe(0);
    // A tap: down + up in place.
    pointer(host, 'pointerdown', 100, 100, touch);
    pointer(host, 'pointerup', 103, 101, touch);
    expect(pi.needsHostRect).toBe(true);
    pi.measure(0, 0, 48);
    expect(c.pulses.count).toBe(1);
    // Mouse presses stay immediate.
    pointer(host, 'pointerdown', 10, 10);
    pi.measure(0, 0, 64);
    expect(c.pulses.count).toBe(2);
    ctl.abort();
  });

  it('hover lifts are off under reduced motion', () => {
    const { host, c, ctl } = setup();
    const lift = vi.spyOn(c, 'lift');
    const pi = new PointerInteraction(host, c, ctl.signal);
    pi.configure(interaction({ pointer: true, pointerLift: true }));
    c.setReducedMotion(true);
    pointer(host, 'pointermove', 100, 100);
    pi.measure(0, 0, 1000);
    expect(lift).not.toHaveBeenCalled();
    c.setReducedMotion(false);
    pointer(host, 'pointermove', 150, 150);
    pi.measure(0, 0, 2000);
    expect(lift).toHaveBeenCalledTimes(1);
    ctl.abort();
  });
});

/** Element with a controllable box (jsdom has no layout). */
function boxed(rect: { x: number; y: number; w: number; h: number } | null) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  hosts.push(el);
  const box = { current: rect };
  el.getBoundingClientRect = () => {
    const r = box.current ?? { x: 0, y: 0, w: 0, h: 0 };
    return {
      left: r.x,
      top: r.y,
      width: r.w,
      height: r.h,
      right: r.x + r.w,
      bottom: r.y + r.h,
      x: r.x,
      y: r.y,
      toJSON() {},
    } as DOMRect;
  };
  el.getClientRects = () =>
    (box.current ? [el.getBoundingClientRect()] : []) as unknown as DOMRectList;
  return { el, box };
}

describe('ElementTracker', () => {
  it('a binding whose influence expired (ttlMs) is dropped and stops reading layout', () => {
    const { c, ctl } = setup();
    const tracker = new ElementTracker(c.influences, ctl.signal);
    const { el } = boxed({ x: 10, y: 10, w: 50, h: 20 });
    const entry = c.createInfluence({ space: 'host', ttlMs: 100, fadeOutMs: 0 });
    const lost = vi.fn();
    tracker.add(el, entry, 'frame', 0, true, lost);
    tracker.measure(0, 0);
    expect(tracker.needsHostRect).toBe(true);
    for (let i = 0; i < 20; i++) c.update(1 / 60);
    expect(entry.removed).toBe(true);
    expect(tracker.needsHostRect).toBe(false);
    const read = vi.spyOn(el, 'getBoundingClientRect');
    tracker.measure(0, 0);
    expect(tracker.size).toBe(0);
    expect(lost).toHaveBeenCalledTimes(1);
    tracker.measure(0, 0);
    expect(read).not.toHaveBeenCalled();
    ctl.abort();
  });

  it('an element that is not rendered hides its influence instead of casting it at (0, 0)', () => {
    const { c, ctl } = setup();
    const tracker = new ElementTracker(c.influences, ctl.signal);
    const { el, box } = boxed({ x: 100, y: 50, w: 40, h: 20 });
    const entry = c.createInfluence({ space: 'host' });
    entry.hidden = true;
    tracker.add(el, entry, 'frame', 0, true, () => {});
    tracker.measure(10, 10);
    expect(entry.hidden).toBe(false);
    expect([entry.x, entry.y]).toEqual([110, 50]);
    box.current = null; // display:none
    tracker.measure(10, 10);
    expect(entry.hidden).toBe(true);
    expect([entry.x, entry.y]).toEqual([110, 50]);
    box.current = { x: 200, y: 50, w: 40, h: 20 };
    tracker.measure(10, 10);
    expect(entry.hidden).toBe(false);
    expect([entry.x, entry.y]).toEqual([210, 50]);
    ctl.abort();
  });

  it('finished fill-forwards animations do not keep an auto binding reading every frame', () => {
    const { c, ctl } = setup();
    const tracker = new ElementTracker(c.influences, ctl.signal);
    const { el } = boxed({ x: 0, y: 0, w: 10, h: 10 });
    const anims = [{ playState: 'finished', pending: false }];
    (el as unknown as { getAnimations: () => unknown[] }).getAnimations = () => anims;
    tracker.add(el, c.createInfluence({ space: 'host' }), 'auto', 0, true, () => {});
    tracker.measure(0, 0);
    expect(tracker.needsHostRect).toBe(false);
    // A running one does.
    anims[0] = { playState: 'running', pending: false };
    for (let i = 0; i < 4; i++) tracker.measure(0, 0);
    expect(tracker.needsHostRect).toBe(true);
    ctl.abort();
  });
});
