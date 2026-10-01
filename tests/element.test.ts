// @vitest-environment jsdom
// biome-ignore-all lint/suspicious/noExplicitAny: loosely typed recording doubles and config probes
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LumiCells } from '../src/core/lumi-cells';
import { configureRuntime, resetRuntimeForTesting } from '../src/core/runtime/scheduler';
import { parseLcAttrs } from '../src/element/data-attrs';
import { defineLumiCellsElement, LumiCellsElement } from '../src/element/index';
import { needsRebind } from '../src/element/rebind';

// The facade needs WebGL2, which jsdom does not have. A recording double stands in for it, so
// these tests cover the element's own logic (state, lifecycle, binding) independent of the runtime.
// Like the facade, it falls back to the page's default renderer (LumiCells.configure).
vi.mock('../src/core/lumi-cells', async () => {
  const { runtimeSettings } = await import('../src/core/runtime/scheduler');
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
    static isSupported() {
      return FakeLumiCells.supported;
    }
    readonly supported = FakeLumiCells.supported;
    destroyed = false;
    running = false;
    replaced: Array<{ config: any; opts: any }> = [];
    handles: Handle[] = [];
    pulses: any[] = [];
    lifts: any[] = [];
    listeners = new Map<string, Set<(e: any) => void>>();
    interaction = { pointer: true, click: true };
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
      this.renderer = options?.renderer ?? runtimeSettings().renderer;
    }
    get rendererMode() {
      return this.renderer;
    }
    setPriority(p: string) {
      this.priorities.push(p);
      this.priority = p;
    }
    setRenderer(r: string) {
      this.renderers.push(r);
      this.renderer = r;
    }
    getConfig() {
      return { interaction: this.interaction };
    }
    replaceConfig(config: any, opts: any) {
      this.replaced.push({ config, opts });
    }
    fallbackSent = false;
    start() {
      if (this.running) return;
      this.running = true;
      // Like the real facade: the poster-only path reports 'no-webgl2' on a microtask.
      if (!this.supported && !this.fallbackSent) {
        this.fallbackSent = true;
        queueMicrotask(() => {
          if (!this.destroyed) this.emit('fallback', { reason: 'no-webgl2' });
        });
      }
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
      for (const fn of this.listeners.get(type) ?? []) fn(detail);
    }
    bindElement(el: Element, opts: unknown) {
      const h = new Handle(el, opts);
      this.handles.push(h);
      return h;
    }
    pulse(o: unknown) {
      this.pulses.push(o);
    }
    lift(o: unknown) {
      this.lifts.push(o);
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
  handles: Array<{ el: Element; opts: any; updates: any[]; disposed: boolean }>;
  pulses: any[];
  lifts: any[];
  interaction: { pointer: boolean; click: boolean };
  listeners: Map<string, Set<(e: any) => void>>;
  emit(type: string, detail?: unknown): void;
}
const FakeClass = LumiCells as unknown as {
  instances: Fake[];
  supported: boolean;
};

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const live = () => FakeClass.instances.filter((i) => !i.destroyed);

function mount(html: string): LumiCellsElement {
  const holder = document.createElement('div');
  holder.innerHTML = html;
  document.body.append(holder);
  return holder.querySelector('lumi-cells') as LumiCellsElement;
}

beforeAll(() => {
  defineLumiCellsElement();
});

beforeEach(() => {
  FakeClass.instances.length = 0;
  FakeClass.supported = true;
  resetRuntimeForTesting();
});

afterEach(async () => {
  document.body.replaceChildren();
  await flush();
  vi.unstubAllGlobals();
});

describe('registration', () => {
  it('registers once and is idempotent', () => {
    expect(customElements.get('lumi-cells')).toBe(LumiCellsElement);
    expect(defineLumiCellsElement()).toBe(LumiCellsElement);
  });

  it('builds a shadow root with a stage and a slot above it', () => {
    const el = document.createElement('lumi-cells');
    const root = el.shadowRoot;
    expect(root?.querySelector('.stage')).not.toBeNull();
    expect(root?.querySelector('.content slot')).not.toBeNull();
  });
});

describe('attributes and properties', () => {
  it('creates the instance on the stage with the resolved config, not started before listeners', async () => {
    const el = mount('<lumi-cells preset="orb" interactive overflow></lumi-cells>');
    await flush();
    const inst = live()[0];
    expect(inst).toBeDefined();
    expect(inst?.host).toBe(el.shadowRoot?.querySelector('.stage'));
    expect(inst?.options.autoStart).toBe(false);
    expect(inst?.running).toBe(true);
    const cfg = inst?.options.config;
    expect(cfg.modes.sphere.hole).toBe(0); // orb preset
    expect(cfg.interaction.pointer).toBe(true);
    expect(cfg.interaction.click).toBe(true);
    expect(cfg.render.overflow).toBe(64); // bare `overflow` = true
    expect(el.instance).toBe(el.instance);
    expect(el.instance).not.toBeNull();
  });

  it('priority: attribute and property feed the instance, invalid values mean normal', async () => {
    const el = mount('<lumi-cells priority="high"></lumi-cells>');
    await flush();
    const inst = live()[0] as Fake;
    expect(inst.options.priority).toBe('high');
    expect(el.priority).toBe('high');
    el.setAttribute('priority', 'low');
    expect(inst.priority).toBe('low');
    el.priority = 'bogus';
    expect(el.priority).toBe('normal');
    expect(inst.priority).toBe('normal');
    el.removeAttribute('priority');
    expect(inst.priorities.at(-1)).toBe('normal');
    // The priority does not rebuild the instance.
    expect(FakeClass.instances).toHaveLength(1);
  });

  it('renderer: attribute and property switch the instance in place, invalid values mean the page default', async () => {
    const el = mount('<lumi-cells renderer="shared"></lumi-cells>');
    await flush();
    const inst = live()[0] as Fake;
    expect(inst.options.renderer).toBe('shared');
    expect(el.renderer).toBe('shared');
    el.setAttribute('renderer', 'OWN');
    expect(el.renderer).toBe('own');
    expect(inst.renderer).toBe('own');
    el.renderer = 'shared';
    expect(inst.renderer).toBe('shared');
    el.renderer = 'bogus';
    expect(el.renderer).toBe('auto');
    el.setAttribute('renderer', ' Auto ');
    expect(el.renderer).toBe('auto');
    el.setAttribute('renderer', 'shared');
    el.removeAttribute('renderer');
    expect(el.renderer).toBe('auto');
    expect(inst.renderers).toEqual(['own', 'shared', 'auto', 'auto', 'shared', 'auto']);
    // Switching never rebuilds the element's instance (runtime layers and bindings stay).
    expect(FakeClass.instances).toHaveLength(1);
  });

  it("without the attribute the page default decides: 'auto', or LumiCells.configure()", async () => {
    const el = mount('<lumi-cells></lumi-cells>');
    await flush();
    const inst = live()[0] as Fake;
    // Left to the facade, which reads the page default.
    expect(inst.options.renderer).toBeUndefined();
    expect(inst.renderer).toBe('auto');
    expect(el.renderer).toBe('auto');
    configureRuntime({ renderer: 'shared' });
    // The existing instance keeps the default it was created with.
    expect(el.renderer).toBe('auto');
    const next = mount('<lumi-cells></lumi-cells>');
    await flush();
    expect(live()[1]?.renderer).toBe('shared');
    expect(next.renderer).toBe('shared');
    el.renderer = 'own';
    el.renderer = null;
    expect(inst.renderers).toEqual(['own', 'shared']);
  });

  it("re-dispatches the instance's 'renderer' event as lc-renderer", async () => {
    const el = mount('<lumi-cells></lumi-cells>');
    await flush();
    const inst = live()[0] as Fake;
    const seen: unknown[] = [];
    document.body.addEventListener('lc-renderer', (e) => seen.push((e as CustomEvent).detail));
    const detail = { renderer: 'shared', previous: 'own', reason: 'demote' };
    inst.emit('renderer', detail);
    expect(seen).toEqual([detail]);
    expect(el.instance).toBe(inst);
  });

  it('renderer set before the element is connected is used at creation', async () => {
    const el = document.createElement('lumi-cells') as LumiCellsElement;
    el.renderer = 'shared';
    document.body.append(el);
    await flush();
    expect(live()[0]?.options.renderer).toBe('shared');
    expect(live()[0]?.renderers).toEqual([]);
  });

  it('priority set before the element is connected is used at creation', async () => {
    const el = document.createElement('lumi-cells') as LumiCellsElement;
    el.priority = 'low';
    document.body.append(el);
    await flush();
    expect(live()[0]?.options.priority).toBe('low');
  });

  it('maps overflow attribute values', async () => {
    mount('<lumi-cells overflow="32"></lumi-cells>');
    await flush();
    expect(live()[0]?.options.config.render.overflow).toBe(32);
    document.body.replaceChildren();
    await flush();
    mount('<lumi-cells overflow="false"></lumi-cells>');
    await flush();
    expect(live()[0]?.options.config.render.overflow).toBe(0);
  });

  it('applies property changes through replaceConfig once, and only for real changes', async () => {
    const el = mount('<lumi-cells></lumi-cells>');
    await flush();
    const inst = live()[0] as Fake;
    expect(inst.replaced).toHaveLength(0);

    el.config = { animation: { speed: 2 } };
    await flush();
    expect(inst.replaced).toHaveLength(1);
    expect(inst.replaced[0]?.config.animation.speed).toBe(2);
    // A property write is an API change; only attribute changes report 'attribute'.
    expect(inst.replaced[0]?.opts.source).toBe('api');

    // Equal content in a new object: nothing to apply.
    el.config = { animation: { speed: 2 } };
    await flush();
    expect(inst.replaced).toHaveLength(1);

    // Several changes in one task coalesce into one replaceConfig.
    el.preset = 'life';
    el.config = { animation: { speed: 3 } };
    el.interactive = true;
    await flush();
    expect(inst.replaced).toHaveLength(2);
    expect(inst.replaced[1]?.config.animation.speed).toBe(3);
    expect(inst.replaced[1]?.config.modes.life.weight).toBe(1); // life preset
    expect(inst.replaced[1]?.config.interaction.pointer).toBe(true);

    el.setAttribute('preset', 'rain');
    await flush();
    expect(inst.replaced).toHaveLength(3);
    expect(inst.replaced[2]?.opts.source).toBe('attribute');
  });

  it('passes transition to replaceConfig and ignores garbage values', async () => {
    const el = mount('<lumi-cells transition="250"></lumi-cells>');
    await flush();
    const inst = live()[0] as Fake;
    expect(el.transition).toBe(250);
    el.config = { animation: { speed: 2 } };
    await flush();
    expect(inst.replaced[0]?.opts.transition).toBe(250);
    el.setAttribute('transition', 'abc');
    expect(el.transition).toBeNull();
  });

  it('config wins over preset, preset wins over defaults; unknown preset is ignored', async () => {
    const el = mount('<lumi-cells preset="nope"></lumi-cells>');
    await flush();
    expect(el.preset).toBeNull();
    const inst = live()[0] as Fake;
    el.preset = 'orb';
    el.config = { modes: { sphere: { hole: 0.5 } } };
    await flush();
    expect(inst.replaced.at(-1)?.config.modes.sphere.hole).toBe(0.5);
    expect(inst.replaced.at(-1)?.config.modes.sphere.rimPower).toBe(0.8); // from orb
  });

  it('re-setting the same preset attribute value wins over a property override', async () => {
    const el = mount('<lumi-cells preset="orb"></lumi-cells>');
    await flush();
    const inst = live()[0] as Fake;
    expect(inst.options.config.modes.sphere.hole).toBe(0);

    el.preset = 'life'; // the attribute still says "orb"
    await flush();
    expect(el.preset).toBe('life');
    expect(inst.replaced.at(-1)?.config.modes.life.weight).toBe(1);

    el.setAttribute('preset', 'orb'); // old === new === 'orb'
    expect(el.preset).toBe('orb');
    await flush();
    expect(inst.replaced.at(-1)?.config.modes.sphere.hole).toBe(0);
  });

  it('reflects boolean properties to attributes and back without echo loops', async () => {
    const el = mount('<lumi-cells></lumi-cells>');
    await flush();
    const inst = live()[0] as Fake;

    el.interactive = true;
    expect(el.hasAttribute('interactive')).toBe(true);
    el.interactive = false;
    expect(el.hasAttribute('interactive')).toBe(false);

    el.paused = true;
    expect(el.hasAttribute('paused')).toBe(true);
    await flush();
    expect(inst.running).toBe(false);
    el.removeAttribute('paused');
    expect(el.paused).toBe(false);
    await flush();
    expect(inst.running).toBe(true);

    el.setAttribute('interactive', '');
    expect(el.interactive).toBe(true);
  });

  it('an unset interactive leaves interaction.* of the config alone', async () => {
    const el = mount('<lumi-cells></lumi-cells>');
    el.config = { interaction: { pointer: true } };
    await flush();
    expect(live()[0]?.options.config.interaction.pointer).toBe(true);
    // An explicit false does override it.
    el.interactive = false;
    await flush();
    expect(live()[0]?.replaced.at(-1)?.config.interaction.pointer).toBe(false);
  });

  it('captures properties assigned before the element was upgraded', async () => {
    const tag = 'lumi-cells-upgrade';
    const el = document.createElement(tag) as LumiCellsElement;
    el.config = { animation: { speed: 3 } };
    (el as any).paused = true;
    (el as any).preset = 'orb';
    expect(Object.hasOwn(el, 'config')).toBe(true);
    document.body.append(el);

    customElements.define(tag, class extends LumiCellsElement {});
    await flush();

    expect(Object.hasOwn(el, 'config')).toBe(false);
    expect(el.config).toEqual({ animation: { speed: 3 } });
    expect(el.paused).toBe(true);
    const inst = live()[0] as Fake;
    expect(inst.options.config.animation.speed).toBe(3);
    expect(inst.options.config.modes.sphere.hole).toBe(0);
    expect(inst.running).toBe(false);
  });
});

describe('lifecycle', () => {
  it('survives being moved within the document (no destroy/recreate)', async () => {
    const el = mount('<lumi-cells></lumi-cells>');
    await flush();
    const inst = el.instance;
    const other = document.createElement('section');
    document.body.append(other);
    other.append(el);
    await flush();
    expect(el.instance).toBe(inst);
    expect((inst as unknown as Fake).destroyed).toBe(false);
    expect(FakeClass.instances).toHaveLength(1);
  });

  it('destroys on removal and rebuilds on re-insertion', async () => {
    const el = mount('<lumi-cells></lumi-cells>');
    await flush();
    const first = FakeClass.instances[0] as Fake;
    el.remove();
    await flush();
    expect(first.destroyed).toBe(true);
    expect(el.instance).toBeNull();
    expect(first.listeners.get('ready')?.size).toBe(0);

    document.body.append(el);
    await flush();
    expect(FakeClass.instances).toHaveLength(2);
    expect(live()).toHaveLength(1);
    expect(el.instance).not.toBeNull();
  });

  it('a config set right after append() is part of the first config', async () => {
    const el = document.createElement('lumi-cells') as LumiCellsElement;
    document.body.append(el);
    el.config = { animation: { speed: 2 } };
    await flush();
    expect(FakeClass.instances).toHaveLength(1);
    expect(FakeClass.instances[0]?.options.config.animation.speed).toBe(2);
    expect(FakeClass.instances[0]?.replaced).toHaveLength(0);
  });

  it('recreates the instance if it was destroyed from the outside', async () => {
    const el = mount('<lumi-cells></lumi-cells>');
    await flush();
    (el.instance as unknown as Fake).destroyed = true;
    el.config = { animation: { speed: 2 } };
    await flush();
    expect(FakeClass.instances).toHaveLength(2);
    expect(FakeClass.instances[1]?.options.config.animation.speed).toBe(2);
  });
});

describe('events', () => {
  it('re-dispatches facade events as bubbling CustomEvents', async () => {
    const el = mount('<lumi-cells id="a"></lumi-cells>');
    await flush();
    const inst = live()[0] as Fake;
    const seen: Record<string, unknown> = {};
    for (const type of ['lc-ready', 'lc-config', 'lc-stats', 'lc-error', 'lc-fallback']) {
      document.addEventListener(type, (e) => {
        seen[type] = (e as CustomEvent).detail;
      });
    }
    inst.emit('ready');
    inst.emit('config', { changed: ['animation.speed'], source: 'api' });
    inst.emit('stats', { fps: 60 });
    const err = new Error('boom');
    inst.emit('error', err);
    inst.emit('fallback', { reason: 'budget' });
    expect(seen['lc-fallback']).toEqual({ reason: 'budget' });
    inst.emit('fallback', { reason: 'compile' });
    expect((seen['lc-ready'] as { instance: unknown }).instance).toBe(el.instance);
    expect(seen['lc-config']).toMatchObject({ source: 'api' });
    expect(seen['lc-stats']).toEqual({ fps: 60 });
    expect(seen['lc-error']).toBe(err);
    expect(seen['lc-fallback']).toEqual({ reason: 'compile' });
  });

  it('re-dispatches the context loss and its end (lc-contextlost, lc-contextrestored)', async () => {
    const el = mount('<lumi-cells></lumi-cells>');
    await flush();
    const inst = live()[0] as Fake;
    const seen: string[] = [];
    const ctl = new AbortController();
    for (const type of ['lc-contextlost', 'lc-fallback', 'lc-contextrestored']) {
      document.addEventListener(
        type,
        (e) => {
          const d = (e as CustomEvent).detail as { reason?: string } | null;
          const where = e.target === el && e.bubbles && e.composed ? '' : ' (not bubbling)';
          seen.push(`${d?.reason ? `${type}:${d.reason}` : type}${where}`);
        },
        { signal: ctl.signal },
      );
    }
    inst.emit('contextlost');
    inst.emit('fallback', { reason: 'context-lost' });
    inst.emit('contextrestored');
    ctl.abort();
    expect(seen).toEqual(['lc-contextlost', 'lc-fallback:context-lost', 'lc-contextrestored']);
  });

  it('reports lc-fallback once when WebGL2 is unavailable', async () => {
    FakeClass.supported = false;
    const seen: unknown[] = [];
    document.addEventListener('lc-fallback', (e) => seen.push((e as CustomEvent).detail));
    mount('<lumi-cells></lumi-cells>');
    await flush();
    await flush();
    // The synchronous notice and the facade's deferred event are one report, not two.
    expect(seen).toEqual([{ reason: 'no-webgl2' }]);
    live()[0]?.emit('fallback', { reason: 'no-webgl2' });
    expect(seen).toHaveLength(1);
    // Later reasons still pass through.
    live()[0]?.emit('fallback', { reason: 'context-lost' });
    live()[0]?.emit('fallback', { reason: 'compile' });
    expect(seen).toEqual([
      { reason: 'no-webgl2' },
      { reason: 'context-lost' },
      { reason: 'compile' },
    ]);
  });

  it('a paused element without WebGL2 is still notified once at mount', async () => {
    FakeClass.supported = false;
    const seen: unknown[] = [];
    document.addEventListener('lc-fallback', (e) => seen.push((e as CustomEvent).detail));
    mount('<lumi-cells paused></lumi-cells>');
    await flush();
    expect(seen).toEqual([{ reason: 'no-webgl2' }]);
  });
});

describe('src', () => {
  const okResponse = (body: unknown) =>
    ({ ok: true, status: 200, json: async () => body }) as Response;

  it('fetches, validates and layers the file under the config property', async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({ extends: 'orb', animation: { speed: 3 }, bogus: 1 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const el = mount('<lumi-cells src="/c.json"></lumi-cells>');
    await flush();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const inst = live()[0] as Fake;
    const last = inst.replaced.at(-1)?.config ?? inst.options.config;
    expect(last.animation.speed).toBe(3);
    expect(last.modes.sphere.hole).toBe(0);

    el.config = { animation: { speed: 1 } };
    await flush();
    expect(inst.replaced.at(-1)?.config.animation.speed).toBe(1);
    expect(inst.replaced.at(-1)?.config.modes.sphere.hole).toBe(0);
  });

  it('applies the first loaded file instantly (no crossfade from the default look)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse({ animation: { speed: 3 } })),
    );
    const el = mount('<lumi-cells src="/c.json" transition="250"></lumi-cells>');
    await flush();
    await flush();
    const inst = live()[0] as Fake;
    expect(inst.replaced).toHaveLength(1);
    expect(inst.replaced[0]?.config.animation.speed).toBe(3);
    expect(inst.replaced[0]?.opts.transition).toBe(0);

    // Later changes tween as usual.
    el.config = { animation: { speed: 1 } };
    await flush();
    expect(inst.replaced[1]?.opts.transition).toBe(250);
  });

  it('re-setting the same src attribute value reloads after a property override', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        urls.push(url);
        return new Promise<Response>(() => {});
      }),
    );
    const el = mount('<lumi-cells src="/a.json"></lumi-cells>');
    await flush();
    el.src = '/b.json';
    el.setAttribute('src', '/a.json'); // old === new === '/a.json'
    expect(el.src).toBe('/a.json');
    expect(urls).toEqual(['/a.json', '/b.json', '/a.json']);
  });

  it('a partial file keeps the preset underneath', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse({ animation: { speed: 3 } })),
    );
    mount('<lumi-cells preset="life" src="/c.json"></lumi-cells>');
    await flush();
    await flush();
    const inst = live()[0] as Fake;
    const last = inst.replaced.at(-1)?.config ?? inst.options.config;
    expect(last.animation.speed).toBe(3);
    expect(last.modes.life.weight).toBe(1);
  });

  it('aborts the previous request when src changes', async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        signals.push(init.signal as AbortSignal);
        return new Promise<Response>(() => {});
      }),
    );
    const el = mount('<lumi-cells src="/a.json"></lumi-cells>');
    await flush();
    el.src = '/b.json';
    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    el.remove();
    await flush();
    expect(signals[1]?.aborted).toBe(true);
  });

  it('reports fetch failures as lc-error and keeps running', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404 }) as Response),
    );
    const errors: Error[] = [];
    document.addEventListener('lc-error', (e) => errors.push((e as CustomEvent<Error>).detail));
    mount('<lumi-cells src="/missing.json"></lumi-cells>');
    await flush();
    await flush();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('404');
    expect(live()).toHaveLength(1);
  });
});

describe('data-lc-* parsing', () => {
  const attrs = (html: string) => {
    const d = document.createElement('div');
    d.innerHTML = html;
    return parseLcAttrs(d.firstElementChild as Element);
  };

  it('returns null influence without data-lc-influence', () => {
    expect(attrs('<i></i>').influence).toBeNull();
  });

  it('parses and clamps numbers, ignores garbage', () => {
    const a = attrs(
      '<i data-lc-influence data-lc-strength="9" data-lc-falloff="-4" data-lc-priority="abc" data-lc-padding="12"></i>',
    ).influence;
    expect(a).toEqual({ strength: 2, falloff: 0.2, padding: 12 });
  });

  it('validates colors with isHexColor and defaults colorMix to 1 when a color is set', () => {
    expect(attrs('<i data-lc-influence data-lc-color="#F00"></i>').influence).toEqual({
      color: '#ff0000',
      colorMix: 1,
    });
    expect(attrs('<i data-lc-influence data-lc-color="red"></i>').influence).toEqual({});
    expect(
      attrs('<i data-lc-influence data-lc-color="#00f" data-lc-color-mix="0.3"></i>').influence,
    ).toEqual({ color: '#0000ff', colorMix: 0.3 });
  });

  it('validates enums: type (attribute value shorthand), track, pulse, lift', () => {
    expect(attrs('<i data-lc-influence="shadow"></i>').influence).toEqual({ type: 'shadow' });
    expect(attrs('<i data-lc-influence="shadow" data-lc-type="repel"></i>').influence?.type).toBe(
      'repel',
    );
    expect(attrs('<i data-lc-influence data-lc-type="nope"></i>').influence).toEqual({});
    expect(attrs('<i data-lc-influence data-lc-track="frame"></i>').influence?.track).toBe('frame');
    expect(
      attrs('<i data-lc-influence data-lc-track="manual"></i>').influence?.track,
    ).toBeUndefined();
    expect(attrs('<i data-lc-pulse="hover"></i>').pulse).toBe('hover');
    expect(attrs('<i data-lc-pulse="tap"></i>').pulse).toBeNull();
    expect(attrs('<i data-lc-lift="click"></i>').lift).toBe('click');
    expect(attrs('<i data-lc-influence="false"></i>').influence).toBeNull();
  });
});

describe('auto-binding', () => {
  it('binds descendants and applies parsed options', async () => {
    mount(
      `<lumi-cells>
        <div id="d" data-lc-influence data-lc-strength="9" data-lc-color="#f00"></div>
        <p id="plain"></p>
      </lumi-cells>`,
    );
    await flush();
    const inst = live()[0] as Fake;
    expect(inst.handles).toHaveLength(1);
    expect(inst.handles[0]?.el.id).toBe('d');
    expect(inst.handles[0]?.opts).toEqual({ strength: 2, color: '#ff0000', colorMix: 1 });
  });

  it('binds elements added later, updates on attribute change, disposes on removal', async () => {
    const el = mount('<lumi-cells></lumi-cells>');
    await flush();
    const inst = live()[0] as Fake;
    const child = document.createElement('div');
    child.setAttribute('data-lc-influence', '');
    el.append(child);
    await flush();
    expect(inst.handles).toHaveLength(1);
    const handle = inst.handles[0] as Fake['handles'][number];

    child.setAttribute('data-lc-strength', '1.5');
    await flush();
    expect(handle.updates).toEqual([{ strength: 1.5 }]);
    expect(inst.handles).toHaveLength(1); // updated in place, never re-added

    child.removeAttribute('data-lc-strength');
    await flush();
    expect(inst.handles).toHaveLength(2); // a removed key cannot be unset: rebind
    expect(handle.disposed).toBe(true);

    child.setAttribute('data-lc-track', 'frame');
    await flush();
    expect(inst.handles).toHaveLength(3); // track is fixed at bind time

    child.remove();
    await flush();
    expect(inst.handles.at(-1)?.disposed).toBe(true);
  });

  it('disposes bindings when the element is torn down', async () => {
    const el = mount('<lumi-cells><div data-lc-influence></div></lumi-cells>');
    await flush();
    const inst = live()[0] as Fake;
    el.remove();
    await flush();
    expect(inst.handles.every((h) => h.disposed)).toBe(true);
  });

  it('binds portals through data-lc-for anywhere in the document', async () => {
    mount('<lumi-cells id="bg"></lumi-cells>');
    const outside = document.createElement('div');
    outside.setAttribute('data-lc-for', 'bg');
    outside.setAttribute('data-lc-influence', '');
    const stranger = document.createElement('div');
    stranger.setAttribute('data-lc-for', 'other');
    stranger.setAttribute('data-lc-influence', '');
    document.body.append(outside, stranger);
    await flush();
    const inst = live()[0] as Fake;
    expect(inst.handles.map((h) => h.el)).toEqual([outside]);

    outside.remove();
    await flush();
    expect(inst.handles[0]?.disposed).toBe(true);
  });

  it('a bare data-lc-for is shorthand for an influence', async () => {
    mount('<lumi-cells id="bg"></lumi-cells>');
    const outside = document.createElement('div');
    outside.setAttribute('data-lc-for', 'bg');
    document.body.append(outside);
    await flush();
    expect(live()[0]?.handles).toHaveLength(1);
  });

  it('binds portals that existed before the element connected', async () => {
    const outside = document.createElement('div');
    outside.setAttribute('data-lc-for', 'late');
    outside.setAttribute('data-lc-influence', '');
    document.body.append(outside);
    mount('<lumi-cells id="late"></lumi-cells>');
    await flush();
    expect(live()[0]?.handles.map((h) => h.el)).toEqual([outside]);
  });

  it('nested elements own their own descendants', async () => {
    mount(
      `<lumi-cells id="outer">
        <div id="a" data-lc-influence></div>
        <lumi-cells id="inner"><div id="b" data-lc-influence></div></lumi-cells>
      </lumi-cells>`,
    );
    await flush();
    const byHost = new Map(
      FakeClass.instances.map((i) => [
        (i.host.getRootNode() as ShadowRoot).host.id,
        i.handles.map((h) => h.el.id),
      ]),
    );
    expect(byHost.get('outer')).toEqual(['a']);
    expect(byHost.get('inner')).toEqual(['b']);
  });

  it('data-lc-pulse and data-lc-lift trigger the instance', async () => {
    mount(
      `<lumi-cells>
        <button id="p" data-lc-pulse="click" data-lc-color="#f00" data-lc-strength="1.5">p</button>
        <button id="l" data-lc-lift="hover">l</button>
      </lumi-cells>`,
    );
    await flush();
    const inst = live()[0] as Fake;
    expect(inst.handles).toHaveLength(0); // triggers do not create influences

    const p = document.getElementById('p') as HTMLElement;
    p.dispatchEvent(
      new MouseEvent('click', { clientX: 12, clientY: 34, detail: 1, bubbles: true }),
    );
    expect(inst.pulses).toEqual([
      { x: 12, y: 34, space: 'client', color: '#ff0000', colorMix: 1, strength: 1.5 },
    ]);

    const l = document.getElementById('l') as HTMLElement;
    l.dispatchEvent(new MouseEvent('pointerenter', { clientX: 5, clientY: 6 }));
    expect(inst.lifts).toEqual([{ x: 5, y: 6, space: 'client' }]);

    // Removing the attribute detaches the listener.
    p.removeAttribute('data-lc-pulse');
    await flush();
    p.dispatchEvent(new MouseEvent('click', { clientX: 1, clientY: 1, detail: 1 }));
    expect(inst.pulses).toHaveLength(1);
  });

  it('forwards pointer events from slotted content to the stage while interactive', async () => {
    const el = mount('<lumi-cells><div id="c"></div></lumi-cells>');
    await flush();
    const inst = live()[0] as Fake;
    const stage = el.shadowRoot?.querySelector('.stage') as HTMLElement;
    const got: MouseEvent[] = [];
    stage.addEventListener('pointermove', (e) => got.push(e as MouseEvent));

    const child = document.getElementById('c') as HTMLElement;
    child.dispatchEvent(new MouseEvent('pointermove', { clientX: 7, clientY: 9, bubbles: true }));
    expect(got).toHaveLength(1);
    expect(got[0]?.clientX).toBe(7);

    inst.interaction = { pointer: false, click: false };
    child.dispatchEvent(new MouseEvent('pointermove', { clientX: 7, clientY: 9, bubbles: true }));
    expect(got).toHaveLength(1);
  });
});

describe('document-wide observer', () => {
  const documentObserves = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.filter((c) => c[0] === document).length;

  it('is installed only for elements with an id, and follows id changes', async () => {
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    try {
      const el = mount('<lumi-cells></lumi-cells>');
      await flush();
      expect(documentObserves(observe)).toBe(0);

      el.id = 'bg';
      expect(documentObserves(observe)).toBe(1);
      const outside = document.createElement('div');
      outside.setAttribute('data-lc-for', 'bg');
      document.body.append(outside);
      await flush();
      expect(live()[0]?.handles.map((h) => h.el)).toEqual([outside]);

      disconnect.mockClear();
      el.removeAttribute('id');
      expect(disconnect).toHaveBeenCalledTimes(1);
      await flush();
      expect(live()[0]?.handles[0]?.disposed).toBe(true); // the portal is no longer owned

      el.id = 'other';
      expect(documentObserves(observe)).toBe(2);
    } finally {
      observe.mockRestore();
      disconnect.mockRestore();
    }
  });

  it('still binds descendants of an element without an id', async () => {
    mount('<lumi-cells><div data-lc-influence></div></lumi-cells>');
    await flush();
    expect(live()[0]?.handles).toHaveLength(1);
  });
});

describe('needsRebind', () => {
  it('flags what update() cannot apply', () => {
    expect(needsRebind({ strength: 1 }, { strength: 2 })).toBe(false);
    expect(needsRebind({ strength: 1 }, { strength: 1, color: '#f00' })).toBe(false);
    expect(needsRebind({}, { padding: 4 })).toBe(true);
    expect(needsRebind({ track: 'auto' }, { track: 'frame' })).toBe(true);
    expect(needsRebind({ cornerRadius: 4 }, { cornerRadius: 8 })).toBe(false);
    expect(needsRebind({}, { cornerRadius: 8 })).toBe(true);
    expect(needsRebind({ cornerRadius: 8 }, {})).toBe(true);
    expect(needsRebind({ color: '#f00' }, {})).toBe(true);
    expect(needsRebind({ color: '#f00' }, { color: undefined })).toBe(true);
    expect(needsRebind({ color: undefined }, {})).toBe(false);
  });
});
