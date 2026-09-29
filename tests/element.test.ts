// @vitest-environment jsdom
// biome-ignore-all lint/suspicious/noExplicitAny: loosely typed recording doubles and config probes
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PixelLife } from '../src/core/pixel-life';
import { parsePlAttrs } from '../src/element/data-attrs';
import { definePixelLifeElement, PixelLifeElement } from '../src/element/index';

// The facade needs WebGL2, which jsdom does not have. A recording double stands in for it, so
// these tests cover the element's own logic (state, lifecycle, binding) independent of the runtime.
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
    static isSupported() {
      return FakePixelLife.supported;
    }
    readonly supported = FakePixelLife.supported;
    destroyed = false;
    running = false;
    replaced: Array<{ config: any; opts: any }> = [];
    handles: Handle[] = [];
    pulses: any[] = [];
    lifts: any[] = [];
    listeners = new Map<string, Set<(e: any) => void>>();
    interaction = { pointer: true, click: true };
    constructor(
      readonly host: HTMLElement,
      readonly options: any,
    ) {
      FakePixelLife.instances.push(this);
    }
    getConfig() {
      return { interaction: this.interaction };
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
  return { PixelLife: FakePixelLife };
});

interface Fake {
  host: HTMLElement;
  options: { config: any; autoStart: boolean };
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
const FakeClass = PixelLife as unknown as {
  instances: Fake[];
  supported: boolean;
};

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const live = () => FakeClass.instances.filter((i) => !i.destroyed);

function mount(html: string): PixelLifeElement {
  const holder = document.createElement('div');
  holder.innerHTML = html;
  document.body.append(holder);
  return holder.querySelector('pixel-life') as PixelLifeElement;
}

beforeAll(() => {
  definePixelLifeElement();
});

beforeEach(() => {
  FakeClass.instances.length = 0;
  FakeClass.supported = true;
});

afterEach(async () => {
  document.body.replaceChildren();
  await flush();
  vi.unstubAllGlobals();
});

describe('registration', () => {
  it('registers once and is idempotent', () => {
    expect(customElements.get('pixel-life')).toBe(PixelLifeElement);
    expect(definePixelLifeElement()).toBe(PixelLifeElement);
  });

  it('builds a shadow root with a stage and a slot above it', () => {
    const el = document.createElement('pixel-life');
    const root = el.shadowRoot;
    expect(root?.querySelector('.stage')).not.toBeNull();
    expect(root?.querySelector('.content slot')).not.toBeNull();
  });
});

describe('attributes and properties', () => {
  it('creates the instance on the stage with the resolved config, not started before listeners', async () => {
    const el = mount('<pixel-life preset="orb" interactive overflow></pixel-life>');
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

  it('maps overflow attribute values', async () => {
    mount('<pixel-life overflow="32"></pixel-life>');
    await flush();
    expect(live()[0]?.options.config.render.overflow).toBe(32);
    document.body.replaceChildren();
    await flush();
    mount('<pixel-life overflow="false"></pixel-life>');
    await flush();
    expect(live()[0]?.options.config.render.overflow).toBe(0);
  });

  it('applies property changes through replaceConfig once, and only for real changes', async () => {
    const el = mount('<pixel-life></pixel-life>');
    await flush();
    const inst = live()[0] as Fake;
    expect(inst.replaced).toHaveLength(0);

    el.config = { animation: { speed: 2 } };
    await flush();
    expect(inst.replaced).toHaveLength(1);
    expect(inst.replaced[0]?.config.animation.speed).toBe(2);
    expect(inst.replaced[0]?.opts.source).toBe('attribute');

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
  });

  it('passes transition to replaceConfig and ignores garbage values', async () => {
    const el = mount('<pixel-life transition="250"></pixel-life>');
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
    const el = mount('<pixel-life preset="nope"></pixel-life>');
    await flush();
    expect(el.preset).toBeNull();
    const inst = live()[0] as Fake;
    el.preset = 'orb';
    el.config = { modes: { sphere: { hole: 0.5 } } };
    await flush();
    expect(inst.replaced.at(-1)?.config.modes.sphere.hole).toBe(0.5);
    expect(inst.replaced.at(-1)?.config.modes.sphere.rimPower).toBe(0.6); // from orb
  });

  it('reflects boolean properties to attributes and back without echo loops', async () => {
    const el = mount('<pixel-life></pixel-life>');
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
    const el = mount('<pixel-life></pixel-life>');
    el.config = { interaction: { pointer: true } };
    await flush();
    expect(live()[0]?.options.config.interaction.pointer).toBe(true);
    // An explicit false does override it.
    el.interactive = false;
    await flush();
    expect(live()[0]?.replaced.at(-1)?.config.interaction.pointer).toBe(false);
  });

  it('captures properties assigned before the element was upgraded', async () => {
    const tag = 'pixel-life-upgrade';
    const el = document.createElement(tag) as PixelLifeElement;
    el.config = { animation: { speed: 3 } };
    (el as any).paused = true;
    (el as any).preset = 'orb';
    expect(Object.hasOwn(el, 'config')).toBe(true);
    document.body.append(el);

    customElements.define(tag, class extends PixelLifeElement {});
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
    const el = mount('<pixel-life></pixel-life>');
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
    const el = mount('<pixel-life></pixel-life>');
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
    const el = document.createElement('pixel-life') as PixelLifeElement;
    document.body.append(el);
    el.config = { animation: { speed: 2 } };
    await flush();
    expect(FakeClass.instances).toHaveLength(1);
    expect(FakeClass.instances[0]?.options.config.animation.speed).toBe(2);
    expect(FakeClass.instances[0]?.replaced).toHaveLength(0);
  });

  it('recreates the instance if it was destroyed from the outside', async () => {
    const el = mount('<pixel-life></pixel-life>');
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
    const el = mount('<pixel-life id="a"></pixel-life>');
    await flush();
    const inst = live()[0] as Fake;
    const seen: Record<string, unknown> = {};
    for (const type of ['pl-ready', 'pl-config', 'pl-stats', 'pl-error', 'pl-fallback']) {
      document.addEventListener(type, (e) => {
        seen[type] = (e as CustomEvent).detail;
      });
    }
    inst.emit('ready');
    inst.emit('config', { changed: ['animation.speed'], source: 'api' });
    inst.emit('stats', { fps: 60 });
    const err = new Error('boom');
    inst.emit('error', err);
    inst.emit('fallback', { reason: 'compile' });
    expect((seen['pl-ready'] as { instance: unknown }).instance).toBe(el.instance);
    expect(seen['pl-config']).toMatchObject({ source: 'api' });
    expect(seen['pl-stats']).toEqual({ fps: 60 });
    expect(seen['pl-error']).toBe(err);
    expect(seen['pl-fallback']).toEqual({ reason: 'compile' });
  });

  it('reports pl-fallback once when WebGL2 is unavailable', async () => {
    FakeClass.supported = false;
    const seen: unknown[] = [];
    document.addEventListener('pl-fallback', (e) => seen.push((e as CustomEvent).detail));
    mount('<pixel-life></pixel-life>');
    await flush();
    expect(seen).toEqual([{ reason: 'no-webgl2' }]);
    live()[0]?.emit('fallback', { reason: 'no-webgl2' });
    expect(seen).toHaveLength(2); // the facade's own event is passed through as well
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
    const el = mount('<pixel-life src="/c.json"></pixel-life>');
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

  it('a partial file keeps the preset underneath', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse({ animation: { speed: 3 } })),
    );
    mount('<pixel-life preset="life" src="/c.json"></pixel-life>');
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
    const el = mount('<pixel-life src="/a.json"></pixel-life>');
    await flush();
    el.src = '/b.json';
    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    el.remove();
    await flush();
    expect(signals[1]?.aborted).toBe(true);
  });

  it('reports fetch failures as pl-error and keeps running', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404 }) as Response),
    );
    const errors: Error[] = [];
    document.addEventListener('pl-error', (e) => errors.push((e as CustomEvent<Error>).detail));
    mount('<pixel-life src="/missing.json"></pixel-life>');
    await flush();
    await flush();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('404');
    expect(live()).toHaveLength(1);
  });
});

describe('data-pl-* parsing', () => {
  const attrs = (html: string) => {
    const d = document.createElement('div');
    d.innerHTML = html;
    return parsePlAttrs(d.firstElementChild as Element);
  };

  it('returns null influence without data-pl-influence', () => {
    expect(attrs('<i></i>').influence).toBeNull();
  });

  it('parses and clamps numbers, ignores garbage', () => {
    const a = attrs(
      '<i data-pl-influence data-pl-strength="9" data-pl-falloff="-4" data-pl-priority="abc" data-pl-padding="12"></i>',
    ).influence;
    expect(a).toEqual({ strength: 2, falloff: 0.2, padding: 12 });
  });

  it('validates colors with isHexColor and defaults colorMix to 1 when a color is set', () => {
    expect(attrs('<i data-pl-influence data-pl-color="#F00"></i>').influence).toEqual({
      color: '#ff0000',
      colorMix: 1,
    });
    expect(attrs('<i data-pl-influence data-pl-color="red"></i>').influence).toEqual({});
    expect(
      attrs('<i data-pl-influence data-pl-color="#00f" data-pl-color-mix="0.3"></i>').influence,
    ).toEqual({ color: '#0000ff', colorMix: 0.3 });
  });

  it('validates enums: type (attribute value shorthand), track, pulse, lift', () => {
    expect(attrs('<i data-pl-influence="shadow"></i>').influence).toEqual({ type: 'shadow' });
    expect(attrs('<i data-pl-influence="shadow" data-pl-type="repel"></i>').influence?.type).toBe(
      'repel',
    );
    expect(attrs('<i data-pl-influence data-pl-type="nope"></i>').influence).toEqual({});
    expect(attrs('<i data-pl-influence data-pl-track="frame"></i>').influence?.track).toBe('frame');
    expect(
      attrs('<i data-pl-influence data-pl-track="manual"></i>').influence?.track,
    ).toBeUndefined();
    expect(attrs('<i data-pl-pulse="hover"></i>').pulse).toBe('hover');
    expect(attrs('<i data-pl-pulse="tap"></i>').pulse).toBeNull();
    expect(attrs('<i data-pl-lift="click"></i>').lift).toBe('click');
    expect(attrs('<i data-pl-influence="false"></i>').influence).toBeNull();
  });
});

describe('auto-binding', () => {
  it('binds descendants and applies parsed options', async () => {
    mount(
      `<pixel-life>
        <div id="d" data-pl-influence data-pl-strength="9" data-pl-color="#f00"></div>
        <p id="plain"></p>
      </pixel-life>`,
    );
    await flush();
    const inst = live()[0] as Fake;
    expect(inst.handles).toHaveLength(1);
    expect(inst.handles[0]?.el.id).toBe('d');
    expect(inst.handles[0]?.opts).toEqual({ strength: 2, color: '#ff0000', colorMix: 1 });
  });

  it('binds elements added later, updates on attribute change, disposes on removal', async () => {
    const el = mount('<pixel-life></pixel-life>');
    await flush();
    const inst = live()[0] as Fake;
    const child = document.createElement('div');
    child.setAttribute('data-pl-influence', '');
    el.append(child);
    await flush();
    expect(inst.handles).toHaveLength(1);
    const handle = inst.handles[0] as Fake['handles'][number];

    child.setAttribute('data-pl-strength', '1.5');
    await flush();
    expect(handle.updates).toEqual([{ strength: 1.5 }]);
    expect(inst.handles).toHaveLength(1); // updated in place, never re-added

    child.removeAttribute('data-pl-strength');
    await flush();
    expect(inst.handles).toHaveLength(2); // a removed key cannot be unset: rebind
    expect(handle.disposed).toBe(true);

    child.setAttribute('data-pl-track', 'frame');
    await flush();
    expect(inst.handles).toHaveLength(3); // track is fixed at bind time

    child.remove();
    await flush();
    expect(inst.handles.at(-1)?.disposed).toBe(true);
  });

  it('disposes bindings when the element is torn down', async () => {
    const el = mount('<pixel-life><div data-pl-influence></div></pixel-life>');
    await flush();
    const inst = live()[0] as Fake;
    el.remove();
    await flush();
    expect(inst.handles.every((h) => h.disposed)).toBe(true);
  });

  it('binds portals through data-pl-for anywhere in the document', async () => {
    mount('<pixel-life id="bg"></pixel-life>');
    const outside = document.createElement('div');
    outside.setAttribute('data-pl-for', 'bg');
    outside.setAttribute('data-pl-influence', '');
    const stranger = document.createElement('div');
    stranger.setAttribute('data-pl-for', 'other');
    stranger.setAttribute('data-pl-influence', '');
    document.body.append(outside, stranger);
    await flush();
    const inst = live()[0] as Fake;
    expect(inst.handles.map((h) => h.el)).toEqual([outside]);

    outside.remove();
    await flush();
    expect(inst.handles[0]?.disposed).toBe(true);
  });

  it('a bare data-pl-for is shorthand for an influence', async () => {
    mount('<pixel-life id="bg"></pixel-life>');
    const outside = document.createElement('div');
    outside.setAttribute('data-pl-for', 'bg');
    document.body.append(outside);
    await flush();
    expect(live()[0]?.handles).toHaveLength(1);
  });

  it('binds portals that existed before the element connected', async () => {
    const outside = document.createElement('div');
    outside.setAttribute('data-pl-for', 'late');
    outside.setAttribute('data-pl-influence', '');
    document.body.append(outside);
    mount('<pixel-life id="late"></pixel-life>');
    await flush();
    expect(live()[0]?.handles.map((h) => h.el)).toEqual([outside]);
  });

  it('nested elements own their own descendants', async () => {
    mount(
      `<pixel-life id="outer">
        <div id="a" data-pl-influence></div>
        <pixel-life id="inner"><div id="b" data-pl-influence></div></pixel-life>
      </pixel-life>`,
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

  it('data-pl-pulse and data-pl-lift trigger the instance', async () => {
    mount(
      `<pixel-life>
        <button id="p" data-pl-pulse="click" data-pl-color="#f00" data-pl-strength="1.5">p</button>
        <button id="l" data-pl-lift="hover">l</button>
      </pixel-life>`,
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
    p.removeAttribute('data-pl-pulse');
    await flush();
    p.dispatchEvent(new MouseEvent('click', { clientX: 1, clientY: 1, detail: 1 }));
    expect(inst.pulses).toHaveLength(1);
  });

  it('forwards pointer events from slotted content to the stage while interactive', async () => {
    const el = mount('<pixel-life><div id="c"></div></pixel-life>');
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
