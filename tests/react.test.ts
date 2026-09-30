// @vitest-environment jsdom
// biome-ignore-all lint/suspicious/noExplicitAny: loosely typed recording doubles and config probes
import {
  act,
  createElement,
  type ReactNode,
  type RefObject,
  StrictMode,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PixelLife as Core } from '../src/core/pixel-life';
import {
  PixelLife,
  useInfluence,
  useModulator,
  usePixelLife,
  usePixelLifeEvent,
  usePixelLifeStats,
  usePulse,
} from '../src/react/index';

// Recording double for the facade (jsdom has no WebGL2); covers the wrapper's own logic.
vi.mock('../src/core/pixel-life', () => {
  class Handle {
    disposed = false;
    updates: unknown[] = [];
    constructor(
      readonly el: Element | null,
      public opts: unknown,
    ) {}
    update(patch: unknown) {
      this.updates.push(patch);
    }
    dispose() {
      this.disposed = true;
    }
    [Symbol.dispose]() {
      this.dispose();
    }
  }
  class FakePixelLife {
    static instances: FakePixelLife[] = [];
    static supported = true;
    readonly supported = FakePixelLife.supported;
    destroyed = false;
    running = false;
    replaced: Array<{ config: any; opts: any }> = [];
    binds: Handle[] = [];
    modulators: Array<{ path: string; source: () => number; opts: any; disposed: boolean }> = [];
    pulses: unknown[] = [];
    listeners = new Map<string, Set<(e: any) => void>>();
    constructor(
      readonly host: HTMLElement,
      readonly options: any,
    ) {
      FakePixelLife.instances.push(this);
    }
    replaceConfig(config: any, opts: any) {
      this.replaced.push({ config, opts });
    }
    start() {
      this.running = true;
    }
    stop() {
      this.running = false;
    }
    destroy() {
      this.destroyed = true;
      this.running = false;
    }
    on(type: string, fn: (e: any) => void) {
      let set = this.listeners.get(type);
      if (!set) {
        set = new Set();
        this.listeners.set(type, set);
      }
      set.add(fn);
      return () => set.delete(fn);
    }
    emit(type: string, detail?: unknown) {
      for (const fn of [...(this.listeners.get(type) ?? [])]) fn(detail);
    }
    bindElement(el: Element, opts: unknown) {
      const h = new Handle(el, opts);
      this.binds.push(h);
      return h;
    }
    modulate(path: string, source: () => number, opts: any) {
      const m = { path, source, opts, disposed: false };
      this.modulators.push(m);
      return {
        set() {},
        dispose() {
          m.disposed = true;
        },
        [Symbol.dispose]() {
          m.disposed = true;
        },
      };
    }
    pulse(o: unknown) {
      this.pulses.push(o);
    }
  }
  return { PixelLife: FakePixelLife };
});

interface Fake {
  host: HTMLElement;
  options: { config: any; autoStart: boolean };
  destroyed: boolean;
  running: boolean;
  replaced: Array<{ config: any; opts: any }>;
  binds: Array<{ el: Element; opts: any; updates: any[]; disposed: boolean }>;
  modulators: Array<{ path: string; source: () => number; opts: any; disposed: boolean }>;
  pulses: unknown[];
  listeners: Map<string, Set<(e: any) => void>>;
  emit(type: string, detail?: unknown): void;
}
const FakeClass = Core as unknown as { instances: Fake[]; supported: boolean };
const live = () => FakeClass.instances.filter((i) => !i.destroyed);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  FakeClass.instances.length = 0;
  FakeClass.supported = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (node: ReactNode) => act(() => root.render(node));

describe('<PixelLife>', () => {
  it('creates one instance on mount, starts it, and destroys it on unmount', () => {
    render(createElement(PixelLife, { preset: 'orb' }));
    const inst = live()[0] as Fake;
    expect(FakeClass.instances).toHaveLength(1);
    expect(inst.host).toBe(container.firstElementChild);
    expect(inst.options.autoStart).toBe(false);
    expect(inst.running).toBe(true);
    expect(inst.options.config.modes.sphere.hole).toBe(0);
    act(() => root.unmount());
    expect(inst.destroyed).toBe(true);
    root = createRoot(container); // afterEach unmounts again
  });

  it('is StrictMode-safe: the discarded instance is destroyed, exactly one stays live', () => {
    render(createElement(StrictMode, null, createElement(PixelLife, { preset: 'orb' })));
    expect(FakeClass.instances.length).toBeGreaterThanOrEqual(2);
    expect(live()).toHaveLength(1);
    expect(live()[0]?.running).toBe(true);
    for (const dead of FakeClass.instances.filter((i) => i.destroyed)) {
      expect([...dead.listeners.values()].every((s) => s.size === 0)).toBe(true);
    }
  });

  it('replaces the config only when the normalized content changes', () => {
    const view = (config: object, extra: object = {}) =>
      createElement(PixelLife, { config, ...extra });
    render(view({ animation: { speed: 2 } }));
    const inst = live()[0] as Fake;
    expect(inst.replaced).toHaveLength(0);

    // A new-but-equal inline object, and an unrelated prop: nothing to apply.
    render(view({ animation: { speed: 2 } }, { className: 'x' }));
    expect(inst.replaced).toHaveLength(0);

    render(view({ animation: { speed: 3 } }, { transition: 250 }));
    expect(inst.replaced).toHaveLength(1);
    expect(inst.replaced[0]?.config.animation.speed).toBe(3);
    expect(inst.replaced[0]?.opts).toEqual({ transition: 250, source: 'api' });
    expect(live()).toHaveLength(1); // same instance, not recreated
  });

  it('merges defaults < preset < config and maps the shortcut props', () => {
    render(
      createElement(PixelLife, {
        preset: 'orb',
        config: { modes: { sphere: { hole: 0.5 } } },
        interactive: true,
        overflow: true,
      }),
    );
    const cfg = live()[0]?.options.config;
    expect(cfg.modes.sphere.hole).toBe(0.5);
    expect(cfg.modes.sphere.rimPower).toBe(0.8);
    expect(cfg.interaction.pointer).toBe(true);
    expect(cfg.interaction.click).toBe(true);
    expect(cfg.render.overflow).toBe(64);

    render(createElement(PixelLife, { overflow: 12 }));
    expect(live()[0]?.replaced.at(-1)?.config.render.overflow).toBe(12);
  });

  it('follows the paused prop', () => {
    render(createElement(PixelLife, { paused: true }));
    const inst = live()[0] as Fake;
    expect(inst.running).toBe(false);
    render(createElement(PixelLife, { paused: false }));
    expect(inst.running).toBe(true);
    render(createElement(PixelLife, { paused: true }));
    expect(inst.running).toBe(false);
  });

  it('exposes the instance through the ref prop (null when unmounted)', () => {
    const ref: { current: unknown } = { current: undefined };
    render(createElement(PixelLife, { ref: ref as RefObject<Core> }));
    expect(ref.current).toBe(live()[0]);
    act(() => root.unmount());
    expect(ref.current).toBeNull();
    root = createRoot(container);
  });

  it('shows the poster until ready, renders children above it and drops the poster on ready', () => {
    render(createElement(PixelLife, null, createElement('span', { id: 'kid' }, 'hi')));
    const host = container.firstElementChild as HTMLElement;
    expect(host.querySelector('[data-pixel-life-poster]')).not.toBeNull();
    const kid = host.querySelector('#kid') as HTMLElement;
    const wrapper = kid.parentElement as HTMLElement;
    expect(wrapper.style.zIndex).toBe('1');
    expect(wrapper.style.position).toBe('relative');
    expect(host.style.position).toBe('relative');

    act(() => live()[0]?.emit('ready'));
    expect(host.querySelector('[data-pixel-life-poster]')).toBeNull();
  });

  it('renders the fallback when WebGL2 is unavailable, keeping the poster', () => {
    FakeClass.supported = false;
    render(createElement(PixelLife, { fallback: createElement('em', { id: 'fb' }, 'no gl') }));
    const host = container.firstElementChild as HTMLElement;
    expect(host.querySelector('#fb')).not.toBeNull();
    expect(host.querySelector('[data-pixel-life-poster]')).not.toBeNull();

    // A late 'ready' must not hide the fallback state.
    act(() => live()[0]?.emit('ready'));
    expect(host.querySelector('#fb')).not.toBeNull();
  });

  it('shows the fallback on a fallback event', () => {
    render(createElement(PixelLife, { fallback: createElement('em', { id: 'fb' }, 'x') }));
    const host = container.firstElementChild as HTMLElement;
    expect(host.querySelector('#fb')).toBeNull();
    act(() => live()[0]?.emit('fallback', { reason: 'compile' }));
    expect(host.querySelector('#fb')).not.toBeNull();
  });

  it('routes onReady/onError/onStats to the latest callbacks', () => {
    const first = vi.fn();
    const second = vi.fn();
    const onError = vi.fn();
    const onStats = vi.fn();
    render(createElement(PixelLife, { onReady: first, onError, onStats }));
    render(createElement(PixelLife, { onReady: second, onError, onStats }));
    const inst = live()[0] as Fake;
    act(() => {
      inst.emit('ready');
      inst.emit('error', new Error('x'));
      inst.emit('stats', { fps: 1 });
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(inst);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onStats).toHaveBeenCalledWith({ fps: 1 });
    expect(live()).toHaveLength(1);
  });

  it('passes className, style and DOM attributes to the host', () => {
    render(
      createElement(PixelLife, {
        className: 'bg',
        style: { height: 100 },
        id: 'host',
        'aria-hidden': true,
      }),
    );
    const host = container.firstElementChild as HTMLElement;
    expect(host.className).toBe('bg');
    expect(host.id).toBe('host');
    expect(host.style.height).toBe('100px');
    expect(host.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('hooks', () => {
  it('useInfluence binds once, updates on shallow-changed options, rebinds on element change', () => {
    let setTag: (t: 'div' | 'section') => void = () => {};
    function Bubble({ strength }: { strength: number }) {
      const ref = useRef<HTMLElement>(null);
      const [tag, set] = useState<'div' | 'section'>('div');
      setTag = set;
      useInfluence(ref, { strength, type: 'light' });
      return createElement(tag, { ref: ref as RefObject<HTMLDivElement> }, 'b');
    }
    const view = (strength: number) =>
      createElement(PixelLife, null, createElement(Bubble, { strength }));

    render(view(1));
    const inst = live()[0] as Fake;
    expect(inst.binds).toHaveLength(1);
    expect(inst.binds[0]?.opts).toEqual({ strength: 1, type: 'light' });

    render(view(1)); // equal options in a new object
    expect(inst.binds[0]?.updates).toHaveLength(0);

    render(view(2));
    expect(inst.binds).toHaveLength(1); // never re-added
    expect(inst.binds[0]?.updates).toEqual([{ strength: 2, type: 'light' }]);

    act(() => setTag('section')); // different DOM element
    expect(inst.binds).toHaveLength(2);
    expect(inst.binds[0]?.disposed).toBe(true);
    expect(inst.binds[1]?.el.tagName).toBe('SECTION');

    act(() => root.unmount());
    expect(inst.binds[1]?.disposed).toBe(true);
    root = createRoot(container);
  });

  it('useInfluence survives StrictMode double effects with exactly one live binding', () => {
    function Bubble() {
      const ref = useRef<HTMLDivElement>(null);
      useInfluence(ref);
      return createElement('div', { ref });
    }
    render(createElement(StrictMode, null, createElement(PixelLife, null, createElement(Bubble))));
    const inst = live()[0] as Fake;
    expect(inst.binds.filter((b) => !b.disposed)).toHaveLength(1);
  });

  it('useModulator registers once per path and reads the latest source', () => {
    let value = 1;
    function Mod({ source }: { source: number | (() => number) }) {
      useModulator('animation.energy', source, { blend: 'mul' });
      return null;
    }
    render(createElement(PixelLife, null, createElement(Mod, { source: () => value })));
    const inst = live()[0] as Fake;
    expect(inst.modulators).toHaveLength(1);
    expect(inst.modulators[0]?.opts.blend).toBe('mul');
    expect(inst.modulators[0]?.source()).toBe(1);

    value = 5;
    expect(inst.modulators[0]?.source()).toBe(5);

    // A new inline function must not re-register; a numeric source is read live as well.
    render(createElement(PixelLife, null, createElement(Mod, { source: () => 9 })));
    expect(inst.modulators).toHaveLength(1);
    expect(inst.modulators[0]?.source()).toBe(9);
    render(createElement(PixelLife, null, createElement(Mod, { source: 3 })));
    expect(inst.modulators).toHaveLength(1);
    expect(inst.modulators[0]?.source()).toBe(3);

    act(() => root.unmount());
    expect(inst.modulators[0]?.disposed).toBe(true);
    root = createRoot(container);
  });

  it('usePulse returns a stable callback that reaches the instance', () => {
    const seen: Array<(o: { x: number; y: number }) => void> = [];
    function Btn() {
      const pulse = usePulse();
      seen.push(pulse);
      return createElement('button', { type: 'button', onClick: () => pulse({ x: 1, y: 2 }) });
    }
    render(createElement(PixelLife, null, createElement(Btn)));
    act(() => (container.querySelector('button') as HTMLButtonElement).click());
    expect(live()[0]?.pulses).toEqual([{ x: 1, y: 2 }]);
    expect(new Set(seen).size).toBe(1); // same identity across the re-render caused by the instance
  });

  it('usePixelLife provides the instance to descendants (null before mount)', () => {
    const seen: Array<Core | null> = [];
    function Probe() {
      seen.push(usePixelLife());
      return null;
    }
    render(createElement(PixelLife, null, createElement(Probe)));
    expect(seen[0]).toBeNull();
    expect(seen.at(-1)).toBe(live()[0]);
  });

  it('usePixelLifeStats returns fresh snapshots from stats events', () => {
    const seen: unknown[] = [];
    function Probe() {
      seen.push(usePixelLifeStats());
      return null;
    }
    render(createElement(PixelLife, null, createElement(Probe)));
    expect(seen.at(-1)).toBeNull();
    const shared = { fps: 60 };
    act(() => live()[0]?.emit('stats', shared));
    expect(seen.at(-1)).toEqual({ fps: 60 });
    shared.fps = 30; // the facade may mutate and re-emit one object
    act(() => live()[0]?.emit('stats', shared));
    expect(seen.at(-1)).toEqual({ fps: 30 });
    expect(seen[seen.length - 1]).not.toBe(shared);
  });

  it('usePixelLifeEvent subscribes once and calls the latest handler', () => {
    const calls: string[] = [];
    function Probe({ tag }: { tag: string }) {
      usePixelLifeEvent('resize', () => calls.push(tag));
      useEffect(() => {}, []);
      return null;
    }
    render(createElement(PixelLife, null, createElement(Probe, { tag: 'a' })));
    const inst = live()[0] as Fake;
    expect(inst.listeners.get('resize')?.size).toBe(1);
    render(createElement(PixelLife, null, createElement(Probe, { tag: 'b' })));
    expect(inst.listeners.get('resize')?.size).toBe(1);
    act(() => inst.emit('resize', {}));
    expect(calls).toEqual(['b']);
  });
});
