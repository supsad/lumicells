/**
 * Wires the demo scene (HTML bubbles) to the WebGL background. This file doubles as the
 * documentation of "binding shader knobs to the environment":
 *
 *  - bindElement(el)   turns a DOM element into a light or a shadow in the pixel field; the
 *                      runtime follows the element's rect (including CSS/WAAPI motion);
 *  - handle.update()   changes the influence live (hover boost, new color);
 *  - pulse()/lift()    one-shot events at a point (click ripple, cells popping up);
 *  - modulate()        drives a numeric parameter from a function, blended over the config value
 *                      (`mul` = scale it, `add` = offset it). It never touches the stored config,
 *                      so sliders keep their values and the panel just shows the effective one.
 *
 * The scene is mounted before the WebGL instance exists (child effects run first), so the binder
 * remembers the elements and attaches influences whenever an instance shows up.
 */

import type { BindElementOptions, InfluenceHandle, LumiCells } from 'lumicells';
import { useLumiCells } from 'lumicells/react';
import { memo, useEffect } from 'react';
import { type BubbleInfo, DemoScene, type DemoSceneProps } from '../scene';
import type { ModulationTracker, TrackedModulator } from './modulation';

// Light of a bubble: a colored glow under the pill (colorMix keeps some of the palette color).
const LIGHT_BASE: BindElementOptions = {
  track: 'auto',
  type: 'light',
  colorMix: 0.2,
  falloff: 1.6,
};
const LIGHT_STRENGTH = 0.28;
const LIGHT_HOVER_STRENGTH = 0.7;

const SPHERE_BUMP = 0.12; // extra sphere radius right after "готово"
const SPHERE_BUMP_MS = 1400;

interface BubbleRec {
  el: HTMLElement;
  info: BubbleInfo;
  handle: InfluenceHandle | null;
  /** False before the entrance flight and after the exit flight: the light stays off. */
  live: boolean;
  hovered: boolean;
}

function centerOf(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** Center of the whole scene (the composition center), in client px. */
function sceneCenter(el: Element): { x: number; y: number } {
  return centerOf(el.closest('.lc-scene') ?? el);
}

function scenePhase(el: Element): string | undefined {
  return el.closest<HTMLElement>('.lc-scene')?.dataset.phase;
}

export class SceneBinder {
  instance: LumiCells | null = null;
  /** Number of bubbles under the pointer; feeds the energy modulator. */
  hoveredCount = 0;

  private bubbles = new Map<HTMLElement, BubbleRec>();
  private title: { el: HTMLElement; handle: InfluenceHandle | null } | null = null;
  private energy: TrackedModulator | null = null;
  private bumps = new Set<TrackedModulator>();
  private timers = new Set<number>();

  constructor(private tracker: ModulationTracker) {}

  /** Called by <SceneLayer> when the WebGL instance appears, changes or goes away. */
  setInstance(instance: LumiCells | null): void {
    this.detachAll();
    this.instance = instance;
    if (!instance) return;
    for (const rec of this.bubbles.values()) this.attachBubble(rec);
    if (this.title) this.attachTitle(this.title);
    // Environment -> shader: the more bubbles are hovered, the more the whole field "breathes".
    this.energy = this.tracker.modulate(
      instance,
      'animation.energy',
      () => 1 + 0.2 * this.hoveredCount,
      { blend: 'mul', smoothingMs: 250 },
    );
  }

  private detachAll(): void {
    for (const rec of this.bubbles.values()) {
      rec.handle?.dispose();
      rec.handle = null;
    }
    this.title?.handle?.dispose();
    if (this.title) this.title.handle = null;
    this.energy?.dispose();
    this.energy = null;
    for (const b of this.bumps) b.dispose();
    this.bumps.clear();
    for (const t of this.timers) window.clearTimeout(t);
    this.timers.clear();
  }

  private strengthOf(rec: BubbleRec): number {
    if (!rec.live) return 0;
    return rec.hovered ? LIGHT_HOVER_STRENGTH : LIGHT_STRENGTH;
  }

  private attachBubble(rec: BubbleRec): void {
    const pl = this.instance;
    if (!pl || rec.handle) return;
    rec.handle = pl.bindElement(rec.el, {
      ...LIGHT_BASE,
      color: rec.info.color,
      strength: this.strengthOf(rec),
    });
  }

  private attachTitle(t: { el: HTMLElement; handle: InfluenceHandle | null }): void {
    const pl = this.instance;
    if (!pl || t.handle) return;
    // A soft shadow behind the caption keeps the text readable over bright cells.
    t.handle = pl.bindElement(t.el, {
      track: 'auto',
      type: 'shadow',
      strength: 0.65,
      padding: 0,
      falloff: 1.4,
    });
  }

  private pushStrength(rec: BubbleRec): void {
    rec.handle?.update({ strength: this.strengthOf(rec) });
  }

  private later(ms: number, fn: () => void): void {
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, ms);
    this.timers.add(id);
  }

  /** Callbacks handed to <DemoScene>. Stable identities; state lives in this class. */
  readonly props: DemoSceneProps = {
    onBubbleMount: (el, info) => {
      const rec: BubbleRec = { el, info, handle: null, live: false, hovered: false };
      this.bubbles.set(el, rec);
      this.attachBubble(rec);
      return () => {
        if (rec.hovered) this.hoveredCount = Math.max(0, this.hoveredCount - 1);
        rec.handle?.dispose();
        this.bubbles.delete(el);
      };
    },

    onBubbleHover: (el, _info, hovering) => {
      const rec = this.bubbles.get(el);
      const pl = this.instance;
      if (!rec || rec.hovered === hovering) return;
      rec.hovered = hovering;
      this.hoveredCount = Math.max(0, this.hoveredCount + (hovering ? 1 : -1));
      // Brighter light while hovered, back to normal on leave.
      this.pushStrength(rec);
      if (hovering && pl) {
        // Cells pop up around the bubble, as if the light attracted them.
        const c = centerOf(el);
        pl.lift({ x: c.x, y: c.y, space: 'client', count: 3, radius: 1.5 });
      }
    },

    onBubbleClick: (_el, info, point) => {
      // Ripple from the click point in the bubble's color.
      this.instance?.pulse({
        x: point.x,
        y: point.y,
        space: 'client',
        color: info.color,
        colorMix: 0.6,
        strength: 0.9,
      });
    },

    onBubbleChange: (el, info) => {
      const rec = this.bubbles.get(el);
      if (!rec) return;
      rec.info = info;
      // A toggled topic changes color (red <-> blue): the light follows.
      rec.handle?.update({ color: info.color });
    },

    onFlight: (el, info, phase) => {
      const rec = this.bubbles.get(el);
      const pl = this.instance;
      const entering = scenePhase(el) === 'entering';
      if (rec) {
        // The light is only on while the bubble is on screen (it rests invisible at its final
        // position before the entrance).
        if (entering && phase === 'start') rec.live = true;
        if (!entering && phase === 'end') rec.live = false;
        this.pushStrength(rec);
      }
      if (!pl || !entering) return;
      if (phase === 'start') {
        // A bubble leaves the center: a faint ripple where it starts.
        const c = sceneCenter(el);
        pl.pulse({
          x: c.x,
          y: c.y,
          space: 'client',
          strength: 0.25,
          color: info.color,
          colorMix: 0.4,
        });
      } else {
        const c = centerOf(el);
        pl.pulse({
          x: c.x,
          y: c.y,
          space: 'client',
          strength: 0.3,
          color: info.color,
          colorMix: 0.5,
        });
      }
    },

    onTitleMount: (el) => {
      const rec = { el, handle: null as InfluenceHandle | null };
      this.title = rec;
      this.attachTitle(rec);
      return () => {
        rec.handle?.dispose();
        if (this.title === rec) this.title = null;
      };
    },

    onAction: (action, el) => {
      const pl = this.instance;
      if (!pl || action !== 'done') return;
      // "Готово": a strong ring from the center...
      const c = sceneCenter(el);
      pl.pulse({
        x: c.x,
        y: c.y,
        space: 'client',
        strength: 1.1,
        speed: 30,
        width: 2.4,
        duration: 1.6,
      });
      // ...and the sphere swells for a moment. `add` offsets the configured radius by a decaying
      // bump, so the sphere returns to exactly the slider value afterwards.
      const t0 = performance.now();
      const bump = this.tracker.modulate(
        pl,
        'modes.sphere.radius',
        () => {
          const u = (performance.now() - t0) / SPHERE_BUMP_MS;
          if (u >= 1) return 0;
          return SPHERE_BUMP * Math.min(1, u * 12) * (1 - u) ** 2;
        },
        { blend: 'add' },
      );
      this.bumps.add(bump);
      this.later(SPHERE_BUMP_MS + 100, () => {
        bump.dispose();
        this.bumps.delete(bump);
      });
    },
  };
}

/** Renders the demo scene inside <LumiCells> and connects it to the instance from context. */
export const SceneLayer = memo(function SceneLayer({ binder }: { binder: SceneBinder }) {
  const pl = useLumiCells();
  useEffect(() => {
    binder.setInstance(pl);
    return () => binder.setInstance(null);
  }, [binder, pl]);
  return <DemoScene {...binder.props} />;
});
