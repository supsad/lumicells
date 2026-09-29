import { createElement, useRef } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Globals whose mere access at import time would mean "touches the DOM on the server".
// (HTMLElement / customElements are excluded: `typeof` guards on them are the sanctioned way to
// detect a DOM inside the element module.)
const TRAPPED = [
  'window',
  'document',
  'navigator',
  'localStorage',
  'sessionStorage',
  'matchMedia',
  'ResizeObserver',
  'IntersectionObserver',
  'MutationObserver',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'getComputedStyle',
] as const;

let accessed: string[] = [];

beforeEach(() => {
  accessed = [];
  for (const name of TRAPPED) {
    if (name in globalThis) continue; // Node provides it; nothing to trap
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() {
        accessed.push(name);
        return undefined;
      },
    });
  }
});

afterEach(() => {
  for (const name of TRAPPED) {
    const desc = Object.getOwnPropertyDescriptor(globalThis, name);
    if (desc?.get) delete (globalThis as Record<string, unknown>)[name];
  }
  vi.resetModules();
});

const ENTRIES = {
  core: () => import('../src/core/index'),
  schema: () => import('../src/schema/index'),
  react: () => import('../src/react/index'),
  element: () => import('../src/element/index'),
  'element/define': () => import('../src/element/define'),
} as const;

describe('SSR safety: importing entries in a DOM-less environment', () => {
  it('the trap is armed (self-check)', () => {
    void (globalThis as Record<string, unknown>).document;
    expect(accessed).toContain('document');
  });

  for (const [name, load] of Object.entries(ENTRIES)) {
    it(`${name} imports without throwing or touching DOM globals`, async () => {
      vi.resetModules();
      await expect(load()).resolves.toBeDefined();
      expect(accessed).toEqual([]);
    });
  }

  it('exposes the public surface', async () => {
    const core = await import('../src/core/index');
    const react = await import('../src/react/index');
    const element = await import('../src/element/index');
    expect(typeof core.PixelLife).toBe('function');
    expect(typeof core.normalizeConfig).toBe('function');
    expect(typeof react.PixelLife).toBe('function');
    expect(typeof react.usePixelLifeStats).toBe('function');
    expect(typeof element.PixelLifeElement).toBe('function');
  });

  it('PixelLife.isSupported() is false on the server', async () => {
    const { PixelLife } = await import('../src/core/index');
    expect(PixelLife.isSupported()).toBe(false);
  });

  it('definePixelLifeElement is a no-op without a custom elements registry', async () => {
    const { definePixelLifeElement } = await import('../src/element/index');
    expect(definePixelLifeElement()).toBeNull();
  });
});

describe('React SSR', () => {
  it('renders the host with a poster background and the children, without a canvas', async () => {
    const { PixelLife } = await import('../src/react/index');
    const html = renderToString(
      createElement(
        PixelLife,
        { preset: 'orb', className: 'bg' },
        createElement('span', null, 'hello'),
      ),
    );
    expect(html).toContain('data-pixel-life');
    expect(html).toContain('class="bg"');
    expect(html).toContain('data-pixel-life-poster');
    expect(html).toContain('gradient');
    expect(html).toContain('hello');
    expect(html).not.toContain('<canvas');
    expect(accessed).toEqual([]);
  });

  it('renders the same markup for equal inputs (hydration-safe)', async () => {
    const { PixelLife } = await import('../src/react/index');
    const a = renderToString(createElement(PixelLife, { config: { animation: { speed: 2 } } }));
    const b = renderToString(createElement(PixelLife, { config: { animation: { speed: 2 } } }));
    expect(a).toBe(b);
  });

  it('hooks are safe to call during server render', async () => {
    const react = await import('../src/react/index');
    function Probe() {
      const ref = useRef<HTMLDivElement>(null);
      const instance = react.usePixelLife();
      const stats = react.usePixelLifeStats();
      const pulse = react.usePulse();
      react.useInfluence(ref, { strength: 1 });
      react.useModulator('animation.energy', 1);
      react.usePixelLifeEvent('ready', () => {});
      return createElement(
        'div',
        { ref, 'data-probe': `${instance === null}|${stats === null}|${typeof pulse}` },
        'probe',
      );
    }
    const html = renderToString(createElement(react.PixelLife, null, createElement(Probe)));
    expect(html).toContain('data-probe="true|true|function"');
  });
});
