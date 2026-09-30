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
import { LumiCells as Core } from '../src/core/lumi-cells';
import {
  LumiCells,
  useInfluence,
  useLumiCells,
  useLumiCellsEvent,
  useLumiCellsStats,
  useModulator,
  usePulse,
} from '../src/react/index';

// Recording double for the facade (jsdom has no WebGL2); covers the wrapper's own logic.
vi.mock('../src/core/lumi-cells', () => {
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
  class FakeLumiCells {
    static instances: FakeLumiCells[] = [];
    static supported = true;
    readonly supported = FakeLumiCells.supported;
    destroyed = false;
    running = false;
    replaced: Array<{ config: any; opts: any }> = [];
    binds: Handle[] = [];
    modulators: Array<{ path: string; source: () => number; opts: any; disposed: boolean }> = [];
    pulses: unknown[] = [];
    listeners = new Map<string, Set<(e: any) => void>>();
    priority: string;
    priorities: string[] = [];
    renderer: string;
    renderers: string[] = [];
    constructor(
      readonly host: HTMLElement,
      readonly options: any,
    ) {
      FakeLumiCells.instances.push(this);
      this.priority = options?.priority ?? 'normal';
      this.renderer = options?.renderer ?? 'own';
    }
    setPriority(p: string) {
      this.priorities.push(p);
      this.priority = p;
    }
    setRenderer(r: string) {
      if (r !== this.renderer) this.renderers.push(r);
      this.renderer = r;
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
  return { LumiCells: FakeLumiCells };
});

interface Fake {
  host: HTMLElement;
  options: { config: any; autoStart: boolean; priority?: string; renderer?: string };
  priority: string;
  priorities: string[];
  renderer: string;
  renderers: string[];
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

describe('<LumiCells>', () => {
  it('creates one instance on mount, starts it, and destroys it on unmount', () => {
    render(createElement(LumiCells, { preset: 'orb' }));
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
    render(createElement(StrictMode, null, createElement(LumiCells, { preset: 'orb' })));
    expect(FakeClass.instances.length).toBeGreaterThanOrEqual(2);
    expect(live()).toHaveLength(1);
    expect(live()[0]?.running).toBe(true);
    for (const dead of FakeClass.instances.filter((i) => i.destroyed)) {
      expect([...dead.listeners.values()].every((s) => s.size === 0)).toBe(true);
    }
  });

  it('replaces the config only when the normalized content changes', () => {
    const view = (config: object, extra: object = {}) =>
      createElement(LumiCells, { config, ...extra });
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
      createElement(LumiCells, {
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

    render(createElement(LumiCells, { overflow: 12 }));
    expect(live()[0]?.replaced.at(-1)?.config.render.overflow).toBe(12);
  });

  it('follows the paused prop', () => {
    render(createElement(LumiCells, { paused: true }));
    const inst = live()[0] as Fake;
    expect(inst.running).toBe(false);
    render(createElement(LumiCells, { paused: false }));
    expect(inst.running).toBe(true);
    render(createElement(LumiCells, { paused: true }));
    expect(inst.running).toBe(false);
  });

  it('exposes the instance through the ref prop (null when unmounted)', () => {
    const ref: { current: unknown } = { current: undefined };
    render(createElement(LumiCells, { ref: ref as RefObject<Core> }));
    expect(ref.current).toBe(live()[0]);
    act(() => root.unmount());
    expect(ref.current).toBeNull();
    root = createRoot(container);
  });

  it('shows the poster until ready, renders children above it and drops the poster on ready', () => {
    render(createElement(LumiCells, null, createElement('span', { id: 'kid' }, 'hi')));
    const host = container.firstElementChild as HTMLElement;
    expect(host.querySelector('[data-lumicells-poster]')).not.toBeNull();
    const kid = host.querySelector('#kid') as HTMLElement;
    const wrapper = kid.parentElement as HTMLElement;
    expect(wrapper.style.zIndex).toBe('1');
    expect(wrapper.style.position).toBe('relative');
    expect(host.style.position).toBe('relative');

    act(() => live()[0]?.emit('ready'));
    expect(host.querySelector('[data-lumicells-poster]')).toBeNull();
  });

  it('renders the fallback when WebGL2 is unavailable, keeping the poster', () => {
    FakeClass.supported = false;
    render(createElement(LumiCells, { fallback: createElement('em', { id: 'fb' }, 'no gl') }));
    const host = container.firstElementChild as HTMLElement;
    expect(host.querySelector('#fb')).not.toBeNull();
    expect(host.querySelector('[data-lumicells-poster]')).not.toBeNull();

    // A late 'ready' must not hide the fallback state.
    act(() => live()[0]?.emit('ready'));
    expect(host.querySelector('#fb')).not.toBeNull();
  });

  it('shows the fallback on a fallback event', () => {
    render(createElement(LumiCells, { fallback: createElement('em', { id: 'fb' }, 'x') }));
    const host = container.firstElementChild as HTMLElement;
    expect(host.querySelector('#fb')).toBeNull();
    act(() => live()[0]?.emit('fallback', { reason: 'compile' }));
    expect(host.querySelector('#fb')).not.toBeNull();
  });

  it('a context-loss fallback ends on contextrestored (node and poster go away)', () => {
    render(createElement(LumiCells, { fallback: createElement('em', { id: 'fb' }, 'x') }));
    const host = container.firstElementChild as HTMLElement;
    const inst = live()[0] as Fake;
    act(() => inst.emit('ready'));
    expect(host.querySelector('[data-lumicells-poster]')).toBeNull();

    act(() => {
      inst.emit('contextlost');
      inst.emit('fallback', { reason: 'context-lost' });
    });
    expect(host.querySelector('#fb')).not.toBeNull();
    expect(host.querySelector('[data-lumicells-poster]')).not.toBeNull();

    act(() => inst.emit('contextrestored'));
    expect(host.querySelector('#fb')).toBeNull();
    expect(host.querySelector('[data-lumicells-poster]')).toBeNull();
  });

  it('compile and no-webgl2 fallbacks are sticky across contextrestored', () => {
    render(createElement(LumiCells, { fallback: createElement('em', { id: 'fb' }, 'x') }));
    const host = container.firstElementChild as HTMLElement;
    const inst = live()[0] as Fake;
    act(() => inst.emit('fallback', { reason: 'compile' }));
    act(() => inst.emit('contextrestored'));
    expect(host.querySelector('#fb')).not.toBeNull();

    act(() => root.unmount());
    FakeClass.supported = false;
    root = createRoot(container);
    render(createElement(LumiCells, { fallback: createElement('em', { id: 'fb' }, 'x') }));
    act(() => live()[0]?.emit('contextrestored'));
    expect((container.firstElementChild as HTMLElement).querySelector('#fb')).not.toBeNull();
  });

  it('a budget fallback is a wait, not a failure: no fallback node, poster until ready', () => {
    render(createElement(LumiCells, { fallback: createElement('em', { id: 'fb' }, 'x') }));
    const host = container.firstElementChild as HTMLElement;
    const inst = live()[0] as Fake;
    act(() => inst.emit('fallback', { reason: 'budget' }));
    expect(host.querySelector('#fb')).toBeNull();
    expect(host.querySelector('[data-lumicells-poster]')).not.toBeNull();
    // It gets a context later and draws: 'ready' ends the wait.
    act(() => inst.emit('ready'));
    expect(host.querySelector('[data-lumicells-poster]')).toBeNull();
    // A budget wait after the first frame changes nothing on the React side either.
    act(() => inst.emit('fallback', { reason: 'budget' }));
    expect(host.querySelector('#fb')).toBeNull();
    expect(host.querySelector('[data-lumicells-poster]')).toBeNull();
  });

  it('passes priority at construction and forwards later changes without a new instance', () => {
    render(createElement(LumiCells, { priority: 'high' }));
    const inst = live()[0] as Fake;
    expect(inst.options.priority).toBe('high');
    expect(inst.priority).toBe('high');
    render(createElement(LumiCells, { priority: 'low' }));
    expect(inst.priority).toBe('low');
    render(createElement(LumiCells, {}));
    expect(inst.priority).toBe('normal');
    expect(FakeClass.instances).toHaveLength(1);
  });

  it('passes renderer at construction and switches it later without a new instance', () => {
    render(createElement(LumiCells, { renderer: 'shared' }));
    const inst = live()[0] as Fake;
    expect(inst.options.renderer).toBe('shared');
    // The mount effect does not switch what the constructor already chose.
    expect(inst.renderers).toEqual([]);
    render(createElement(LumiCells, { renderer: 'own' }));
    expect(inst.renderer).toBe('own');
    render(createElement(LumiCells, { renderer: 'shared' }));
    render(createElement(LumiCells, {}));
    expect(inst.renderers).toEqual(['own', 'shared', 'own']);
    expect(FakeClass.instances).toHaveLength(1);
  });

  it('routes onReady/onError/onStats to the latest callbacks', () => {
    const first = vi.fn();
    const second = vi.fn();
    const onError = vi.fn();
    const onStats = vi.fn();
    render(createElement(LumiCells, { onReady: first, onError, onStats }));
    render(createElement(LumiCells, { onReady: second, onError, onStats }));
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
      createElement(LumiCells, {
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
      createElement(LumiCells, null, createElement(Bubble, { strength }));

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

  it('useInfluence re-binds for options that update() cannot apply', () => {
    let current: Record<string, unknown> = { type: 'shadow', padding: 0 };
    const handles: Array<{ current: unknown }> = [];
    function Bubble() {
      const ref = useRef<HTMLDivElement>(null);
      handles.push(useInfluence(ref, current as any) as { current: unknown });
      return createElement('div', { ref });
    }
    const view = () => createElement(LumiCells, null, createElement(Bubble));
    render(view());
    const inst = live()[0] as Fake;
    expect(inst.binds).toHaveLength(1);

    current = { type: 'shadow', padding: 24 }; // padding is fixed at bind time
    render(view());
    expect(inst.binds).toHaveLength(2);
    expect(inst.binds[0]?.disposed).toBe(true);
    expect(inst.binds[1]?.opts).toEqual({ type: 'shadow', padding: 24 });
    expect(handles.at(-1)?.current).not.toBeNull();

    current = { type: 'shadow', padding: 24, track: 'frame' };
    render(view());
    expect(inst.binds).toHaveLength(3);

    current = { type: 'shadow', padding: 24, track: 'frame', strength: 1 }; // plain update
    render(view());
    expect(inst.binds).toHaveLength(3);
    expect(inst.binds[2]?.updates).toEqual([current]);

    current = { type: 'shadow', padding: 24, track: 'frame', strength: undefined }; // key unset
    render(view());
    expect(inst.binds).toHaveLength(4);

    current = { ...current, cornerRadius: 6 }; // auto-corner flips off
    render(view());
    expect(inst.binds).toHaveLength(5);
    expect(inst.binds.filter((b) => !b.disposed)).toHaveLength(1);
  });

  it('useInfluence survives StrictMode double effects with exactly one live binding', () => {
    function Bubble() {
      const ref = useRef<HTMLDivElement>(null);
      useInfluence(ref);
      return createElement('div', { ref });
    }
    render(createElement(StrictMode, null, createElement(LumiCells, null, createElement(Bubble))));
    const inst = live()[0] as Fake;
    expect(inst.binds.filter((b) => !b.disposed)).toHaveLength(1);
  });

  it('useModulator registers once per path and reads the latest source', () => {
    let value = 1;
    function Mod({ source }: { source: number | (() => number) }) {
      useModulator('animation.energy', source, { blend: 'mul' });
      return null;
    }
    render(createElement(LumiCells, null, createElement(Mod, { source: () => value })));
    const inst = live()[0] as Fake;
    expect(inst.modulators).toHaveLength(1);
    expect(inst.modulators[0]?.opts.blend).toBe('mul');
    expect(inst.modulators[0]?.source()).toBe(1);

    value = 5;
    expect(inst.modulators[0]?.source()).toBe(5);

    // A new inline function must not re-register; a numeric source is read live as well.
    render(createElement(LumiCells, null, createElement(Mod, { source: () => 9 })));
    expect(inst.modulators).toHaveLength(1);
    expect(inst.modulators[0]?.source()).toBe(9);
    render(createElement(LumiCells, null, createElement(Mod, { source: 3 })));
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
    render(createElement(LumiCells, null, createElement(Btn)));
    act(() => (container.querySelector('button') as HTMLButtonElement).click());
    expect(live()[0]?.pulses).toEqual([{ x: 1, y: 2 }]);
    expect(new Set(seen).size).toBe(1); // same identity across the re-render caused by the instance
  });

  it('useLumiCells provides the instance to descendants (null before mount)', () => {
    const seen: Array<Core | null> = [];
    function Probe() {
      seen.push(useLumiCells());
      return null;
    }
    render(createElement(LumiCells, null, createElement(Probe)));
    expect(seen[0]).toBeNull();
    expect(seen.at(-1)).toBe(live()[0]);
  });

  it('useLumiCellsStats returns fresh snapshots from stats events', () => {
    const seen: unknown[] = [];
    function Probe() {
      seen.push(useLumiCellsStats());
      return null;
    }
    render(createElement(LumiCells, null, createElement(Probe)));
    expect(seen.at(-1)).toBeNull();
    const shared = { fps: 60 };
    act(() => live()[0]?.emit('stats', shared));
    expect(seen.at(-1)).toEqual({ fps: 60 });
    shared.fps = 30; // the facade may mutate and re-emit one object
    act(() => live()[0]?.emit('stats', shared));
    expect(seen.at(-1)).toEqual({ fps: 30 });
    expect(seen[seen.length - 1]).not.toBe(shared);
  });

  it('useLumiCellsEvent subscribes once and calls the latest handler', () => {
    const calls: string[] = [];
    function Probe({ tag }: { tag: string }) {
      useLumiCellsEvent('resize', () => calls.push(tag));
      useEffect(() => {}, []);
      return null;
    }
    render(createElement(LumiCells, null, createElement(Probe, { tag: 'a' })));
    const inst = live()[0] as Fake;
    expect(inst.listeners.get('resize')?.size).toBe(1);
    render(createElement(LumiCells, null, createElement(Probe, { tag: 'b' })));
    expect(inst.listeners.get('resize')?.size).toBe(1);
    act(() => inst.emit('resize', {}));
    expect(calls).toEqual(['b']);
  });
});
