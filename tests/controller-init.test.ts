// @vitest-environment jsdom
/**
 * What makes mounting many instances cheap: controllers started from the same config input share
 * one normalization and one ParamStore reset (per layout), palettes are baked once, and the
 * store's schema-derived part is shared. Each instance must still behave exactly like one built
 * from scratch and own its config copy.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Controller, initMissCount } from '../src/core/controller/controller';
import { createParamLayout } from '../src/core/controller/layout';
import { lutBakeCount, PaletteLut } from '../src/core/controller/lut';
import { ParamStore } from '../src/core/controller/tween';
import { reducedMotionQuery, watchVisibility } from '../src/core/dom/environment';
import { LumiCells } from '../src/core/lumi-cells';
import {
  getDefaults,
  getLeafPaths,
  type LumiCellsConfigInput,
  normalizeConfig,
  type ParamPath,
  posterCss,
} from '../src/schema';

const hosts: HTMLElement[] = [];
function host(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  hosts.push(el);
  return el;
}

afterEach(() => {
  for (const h of hosts.splice(0)) h.remove();
});

/** Every value a store exposes, by leaf path. */
function values(s: ParamStore): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const path of getLeafPaths()) {
    const id = s.id(path as ParamPath);
    out[path] = [s.num(id), s.crossfadePrev(id), s.crossfadeMix(id), s.comp(id, 0), s.comp(id, 1)];
  }
  return out;
}

describe('ParamStore snapshot', () => {
  it('a store started from a snapshot equals one reset from the same config, and moves the same', () => {
    const layout = createParamLayout();
    const cfg = normalizeConfig({ extends: 'reference' }).config;
    const a = new ParamStore(layout, cfg);
    const b = new ParamStore(layout, cfg, a.snapshot());
    expect(Array.from(b.params)).toEqual(Array.from(a.params));
    expect(values(b)).toEqual(values(a));
    expect(b.dirty).toBe(true);
    expect(b.animating).toBe(false);
    // The same changes give the same results (the snapshot shares nothing mutable).
    for (const s of [a, b]) {
      s.setTarget('modes.sphere.radius', 0.3, 500);
      s.setTarget('color.mapping', 'radial', 400);
      s.setTarget('background.color', '#ff0000', 300);
      s.addModulator('animation.energy', 1.5, 'override');
      for (let i = 0; i < 10; i++) s.update(1 / 60);
    }
    expect(Array.from(b.params)).toEqual(Array.from(a.params));
    expect(values(b)).toEqual(values(a));
    const c = new ParamStore(layout, cfg, a.snapshot());
    expect(c.isModulated('animation.energy')).toBe(false);
  });
});

describe('Controller start cache', () => {
  it('normalizes and resets once per input; each controller owns an equal config copy', () => {
    const input: LumiCellsConfigInput = { extends: 'orb', grid: { count: 33 } };
    const before = initMissCount();
    const list = Array.from({ length: 20 }, () => new Controller({ config: input }));
    expect(initMissCount() - before).toBe(1);
    const fresh = normalizeConfig(input).config;
    for (const c of list) expect(c.getConfig()).toEqual(fresh);
    expect(list[1]?.getConfig()).not.toBe(list[0]?.getConfig());
    expect(list[1]?.getConfig().color.palette).not.toBe(list[0]?.getConfig().color.palette);
    // A change of one never reaches the others, nor the next controller from the same input.
    list[0]?.setConfig({ grid: { count: 12 } });
    expect(list[1]?.getConfig().grid.count).toBe(33);
    expect(new Controller({ config: input }).getConfig().grid.count).toBe(33);
    // Equal content in another key order is the same input.
    new Controller({ config: { grid: { count: 33 }, extends: 'orb' } });
    expect(initMissCount() - before).toBe(1);
  });

  it('a cached start gives the same frame inputs as a fresh one', () => {
    const input: LumiCellsConfigInput = { extends: 'waves', animation: { speed: 1.3 } };
    const first = new Controller({ config: input, random: () => 0.25 });
    const second = new Controller({ config: input, random: () => 0.25 });
    for (const c of [first, second]) {
      c.setViewport({ hostCssW: 320, hostCssH: 200, dpr: 2, deviceW: 0, deviceH: 0 });
    }
    const fa = first.update(1 / 60, 0);
    const fb = second.update(1 / 60, 0);
    expect(Array.from(fb.params)).toEqual(Array.from(fa.params));
    expect(Array.from(fb.frame)).toEqual(Array.from(fa.frame));
    expect(Array.from(fb.lut)).toEqual(Array.from(fa.lut));
  });

  it('inputs that are not plain data are never cached', () => {
    class Grid {
      count = 40;
    }
    const before = initMissCount();
    const odd = { grid: new Grid() } as unknown as LumiCellsConfigInput;
    const a = new Controller({ config: odd });
    const b = new Controller({ config: odd });
    expect(initMissCount() - before).toBe(2);
    // Normalization reads a class instance as a bad type: the defaults stay, like before.
    expect(a.getConfig().grid.count).toBe(getDefaults().grid.count);
    expect(b.getConfig()).toEqual(a.getConfig());
  });

  it('the poster is computed once per config', () => {
    const input: LumiCellsConfigInput = { extends: 'vortex' };
    const c = new Controller({ config: input });
    const poster = c.poster;
    expect(poster).toBe(posterCss(c.getConfig()));
    expect(new Controller({ config: input }).poster).toBe(poster);
    c.setConfig({ background: { color: '#123456' } });
    expect(c.poster).not.toBe(poster);
    expect(c.poster).toContain('#123456');
  });
});

describe('palette LUT cache', () => {
  it('mounting many instances with one palette bakes it once', () => {
    const palette = ['#101010', '#20e0a0', '#f0f0f0'];
    const before = lutBakeCount();
    const list = Array.from(
      { length: 30 },
      () =>
        new LumiCells(host(), {
          config: { color: { palette, interpolation: 'linear' } },
          autoStart: false,
        }),
    );
    expect(lutBakeCount() - before).toBe(1);
    // The same palette through another input (another preset underneath) is not baked again.
    new PaletteLut(palette, 'linear');
    expect(lutBakeCount() - before).toBe(1);
    // Another interpolation is another ramp.
    new PaletteLut(palette, 'oklab');
    expect(lutBakeCount() - before).toBe(2);
    for (const pl of list) pl.destroy();
  });

  it('a cached ramp is copied, never shared', () => {
    const a = new PaletteLut(['#ff0000', '#0000ff'], 'oklab');
    const b = new PaletteLut(['#ff0000', '#0000ff'], 'oklab');
    expect(Array.from(b.bytes)).toEqual(Array.from(a.bytes));
    a.setTarget(['#00ff00'], 'oklab', 0);
    expect(Array.from(b.bytes)).not.toEqual(Array.from(a.bytes));
    expect(new PaletteLut(['#ff0000', '#0000ff'], 'oklab').bytes).toEqual(b.bytes);
  });
});

describe('page environment listeners', () => {
  it('one visibilitychange listener serves every instance, removed with the last', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const list = Array.from({ length: 10 }, () => new LumiCells(host(), { autoStart: false }));
    const adds = add.mock.calls.filter((c) => c[0] === 'visibilitychange');
    expect(adds).toHaveLength(1);
    for (const pl of list) pl.destroy();
    expect(remove.mock.calls.filter((c) => c[0] === 'visibilitychange')).toHaveLength(1);
    add.mockRestore();
    remove.mockRestore();
  });

  it('every subscriber hears the change; a throwing one does not stop the others', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: string[] = [];
    const offA = watchVisibility(document, () => {
      seen.push('a');
      throw new Error('boom');
    });
    const offB = watchVisibility(document, () => seen.push('b'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(seen).toEqual(['a', 'b']);
    offA();
    offB();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(seen).toEqual(['a', 'b']);
    err.mockRestore();
  });

  it('the reduced-motion query is created once per window', () => {
    const mm = vi.fn(
      (q: string) =>
        ({
          matches: false,
          media: q,
          addEventListener() {},
          removeEventListener() {},
        }) as unknown as MediaQueryList,
    );
    const win = { matchMedia: mm } as unknown as Window;
    expect(reducedMotionQuery(win)).toBe(reducedMotionQuery(win));
    expect(mm).toHaveBeenCalledTimes(1);
  });
});
