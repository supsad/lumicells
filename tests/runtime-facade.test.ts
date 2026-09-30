// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HostView } from '../src/core/dom/host';
import { LumiCells } from '../src/core/lumi-cells';
import type { LumiCellsEvents } from '../src/core/types';
import { getPresetConfig } from '../src/schema';

// jsdom has no WebGL: the facade must run its no-webgl2 fallback path (poster, handles, events).
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as typeof HTMLCanvasElement.prototype.getContext;
});

const hosts: HTMLElement[] = [];
function host(): HTMLElement {
  const el = document.createElement('div');
  el.style.width = '400px';
  el.style.height = '300px';
  document.body.appendChild(el);
  hosts.push(el);
  return el;
}

afterEach(() => {
  for (const h of hosts.splice(0)) h.remove();
});

const tick = () => new Promise<void>((r) => queueMicrotask(r));

/** jsdom cannot parse multi-layer backgrounds, so watch what the host view is asked to show. */
function posterSpy() {
  return vi.spyOn(HostView.prototype, 'showPoster');
}

describe('LumiCells without WebGL2', () => {
  it('reports unsupported, keeps the poster and emits a deferred fallback', async () => {
    expect(LumiCells.isSupported()).toBe(false);
    const el = host();
    const spy = posterSpy();
    const pl = new LumiCells(el);
    const seen: LumiCellsEvents['fallback'][] = [];
    pl.on('fallback', (e) => seen.push(e));
    expect(pl.supported).toBe(false);
    expect(pl.canvas).toBeNull();
    expect(el.style.position).toBe('relative');
    expect(String(spy.mock.calls[0]?.[0])).toContain('radial-gradient');
    // The poster follows config changes while it is visible.
    pl.set('background.color', '#ff0000');
    expect(String(spy.mock.calls.at(-1)?.[0])).toContain('#ff0000');
    spy.mockRestore();
    await tick();
    expect(seen).toEqual([{ reason: 'no-webgl2' }]);
    pl.destroy();
  });

  it('merges defaults < preset < config < interactive', () => {
    const pl = new LumiCells(host(), {
      preset: 'orb',
      config: { grid: { count: 40 } },
      interactive: true,
      autoStart: false,
    });
    const orb = getPresetConfig('orb');
    expect(pl.get('modes.sphere.hole')).toBe(orb.modes.sphere.hole);
    expect(pl.get('grid.count')).toBe(40);
    expect(pl.get('interaction.pointer')).toBe(true);
    expect(pl.get('interaction.click')).toBe(true);
    pl.destroy();
  });

  it('config changes are synchronous; the event is coalesced with the union of paths', async () => {
    const pl = new LumiCells(host(), { autoStart: false });
    const events: LumiCellsEvents['config'][] = [];
    pl.on('config', (e) => events.push(e));
    pl.set('modes.sphere.radius', 0.3, { source: 'stand' });
    pl.setConfig({ glow: { bloom: { strength: 1.2 } } }, { source: 'stand' });
    pl.set('modes.sphere.radius', 0.4, { source: 'stand' });
    expect(pl.get('modes.sphere.radius')).toBe(0.4);
    expect(pl.getConfig().glow.bloom.strength).toBe(1.2);
    expect(events.length).toBe(0);
    await tick();
    expect(events.length).toBe(1);
    expect(events[0]?.source).toBe('stand');
    expect(new Set(events[0]?.changed)).toEqual(
      new Set(['modes.sphere.radius', 'glow.bloom.strength']),
    );
    // Invalid values are clamped, unchanged values emit nothing.
    pl.set('modes.sphere.radius', 99);
    expect(pl.get('modes.sphere.radius')).toBe(1.6);
    await tick();
    events.length = 0;
    pl.set('modes.sphere.radius', 1.6);
    await tick();
    expect(events.length).toBe(0);
    pl.destroy();
  });

  it('changes from different sources are never attributed to one another', async () => {
    const pl = new LumiCells(host(), { autoStart: false });
    const events: LumiCellsEvents['config'][] = [];
    pl.on('config', (e) => events.push(e));
    pl.set('grid.count', 40, { source: 'api' });
    pl.set('background.color', '#ff0000', { source: 'attribute' });
    pl.setConfig({ grid: { gap: 0.3 } }, { source: 'attribute' });
    pl.set('glow.bloom.strength', 1.2);
    // Never synchronously inside the setters.
    expect(events.length).toBe(0);
    await tick();
    expect(events.map((e) => [e.source, e.changed])).toEqual([
      ['api', ['grid.count']],
      ['attribute', ['background.color', 'grid.gap']],
      ['api', ['glow.bloom.strength']],
    ]);
    // An echo filter drops only its own source's changes.
    const foreign = events.filter((e) => e.source !== 'attribute').flatMap((e) => e.changed);
    expect(foreign).toEqual(['grid.count', 'glow.bloom.strength']);
    pl.destroy();
  });

  it('replaceConfig resets to defaults plus the given config; exportConfig diffs', () => {
    const pl = new LumiCells(host(), { config: { grid: { gap: 0.4 } }, autoStart: false });
    pl.replaceConfig({ extends: 'rain' });
    expect(pl.get('grid.gap')).toBe(getPresetConfig('rain').grid.gap);
    const file = pl.exportConfig({ mode: 'diff', base: 'rain' });
    expect(file.extends).toBe('rain');
    expect(Object.keys(file)).not.toContain('grid');
    pl.destroy();
  });

  it('runtime layers work without a GPU and never touch the config', () => {
    const pl = new LumiCells(host(), { autoStart: false });
    const m = pl.modulate('modes.sphere.radius', 0.2);
    const inf = pl.addInfluence({ x: 10, y: 10, radius: 20 });
    const el = document.createElement('button');
    pl.host.appendChild(el);
    const bound = pl.bindElement(el, { type: 'shadow', track: 'frame' });
    pl.pulse({ x: 0.5, y: 0.5, space: 'norm' });
    pl.lift({ x: 3, y: 3, space: 'cells', count: 2 });
    pl.setEnergy(1.5);
    pl.setDebugView('bloom');
    expect(inf.id).toBeGreaterThan(0);
    expect(bound.id).toBeGreaterThan(inf.id);
    expect(pl.getConfig().modes.sphere.radius).toBe(0.68);
    expect(pl.exportConfig({ mode: 'diff' })).not.toHaveProperty('modes');
    m.dispose();
    inf.dispose();
    bound[Symbol.dispose]();
    pl.destroy();
  });

  it('destroy() is synchronous, idempotent and total', () => {
    const el = host();
    el.style.background = 'rgb(1, 2, 3)';
    const spy = posterSpy();
    const pl = new LumiCells(el);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    const destroyed = vi.fn();
    const config = vi.fn();
    pl.on('destroy', destroyed);
    pl.on('config', config);
    const m = pl.modulate('animation.energy', 2);
    const inf = pl.addInfluence({ x: 1, y: 1 });
    pl.destroy();
    pl.destroy();
    expect(pl.destroyed).toBe(true);
    expect(destroyed).toHaveBeenCalledTimes(1);
    expect(el.style.backgroundColor).toBe('rgb(1, 2, 3)');
    expect(el.style.backgroundImage).not.toContain('gradient');
    expect(el.style.position).toBe('');
    expect(el.querySelector('canvas')).toBeNull();
    // Everything is a no-op afterwards.
    m.set(1);
    m.dispose();
    inf.update({ x: 5 });
    inf.dispose();
    expect(inf.active).toBe(false);
    pl.setConfig({ grid: { gap: 0.5 } });
    pl.start();
    pl.pulse({ x: 1, y: 1 });
    expect(pl.addInfluence({ x: 1, y: 1 }).id).toBe(-1);
    expect(pl.on('stats', () => {})).toBeTypeOf('function');
    expect(config).not.toHaveBeenCalled();
    expect(pl.getStats().fps).toBe(0);
  });

  it('keeps a pre-existing positioned host as is', () => {
    const el = host();
    el.style.position = 'absolute';
    const pl = new LumiCells(el, { autoStart: false });
    expect(el.style.position).toBe('absolute');
    pl.destroy();
    expect(el.style.position).toBe('absolute');
  });

  it('many instances alone warn about nothing (the context budget handles them)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const list: LumiCells[] = [];
    const warns: string[] = [];
    for (let i = 0; i < 20; i++) {
      const pl = new LumiCells(host(), { autoStart: false });
      pl.on('warn', (e) => warns.push(e.code));
      list.push(pl);
    }
    await tick();
    expect(warn).not.toHaveBeenCalled();
    expect(warns).toEqual([]);
    for (const pl of list) pl.destroy();
    warn.mockRestore();
  });

  it('stats.state: pending until started, failed without WebGL2, destroyed after destroy()', () => {
    const pl = new LumiCells(host(), { autoStart: false });
    expect(pl.getStats().state).toBe('pending');
    pl.start();
    expect(pl.getStats().state).toBe('failed');
    pl.destroy();
    expect(pl.getStats().state).toBe('destroyed');
    const idle = new LumiCells(host(), { autoStart: false });
    idle.destroy();
    idle.stop();
    expect(idle.getStats().state).toBe('destroyed');
  });

  it('configure() and priority are safe without WebGL2', () => {
    LumiCells.configure({ maxContexts: 2, parkAfterMs: 0, createPerFrame: 2 });
    const pl = new LumiCells(host(), { priority: 'high' });
    expect(pl.priority).toBe('high');
    pl.setPriority('low');
    expect(pl.priority).toBe('low');
    // Invalid values are ignored.
    pl.setPriority('urgent' as never);
    expect(pl.priority).toBe('low');
    const bogus = new LumiCells(host(), { priority: 'bogus' as never, autoStart: false });
    expect(bogus.priority).toBe('normal');
    bogus.destroy();
    LumiCells.configure({ maxContexts: 'auto', parkAfterMs: 10_000, createPerFrame: 1 });
    pl.destroy();
  });

  it('listener errors do not break other listeners', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pl = new LumiCells(host(), { autoStart: false });
    const ok = vi.fn();
    pl.on('config', () => {
      throw new Error('boom');
    });
    pl.on('config', ok);
    pl.set('grid.gap', 0.3);
    await tick();
    expect(ok).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalled();
    pl.destroy();
    err.mockRestore();
  });
});
