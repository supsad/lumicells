'use client';

import {
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import type { PixelLife } from '../core/pixel-life';
import type {
  BindElementOptions,
  InfluenceHandle,
  InfluenceOptions,
  ModulatablePath,
  ModulateOptions,
  ModulationSource,
  PixelLifeEvents,
  PulseOptions,
  Stats,
} from '../core/types';
import { PixelLifeContext } from './context';

const NO_OPTIONS: BindElementOptions = {};

/** The instance of the nearest <PixelLife>; null before mount, on the server and when unsupported. */
export function usePixelLife(): PixelLife | null {
  return useContext(PixelLifeContext);
}

function shallowEqual(a: object, b: object): boolean {
  if (a === b) return true;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra);
  return (
    ka.length === Object.keys(rb).length && ka.every((k) => k in rb && Object.is(ra[k], rb[k]))
  );
}

interface Bound {
  instance: PixelLife;
  el: Element;
  handle: InfluenceHandle;
  opts: BindElementOptions;
}

/**
 * Makes the element in `ref` light/shadow/lift the animation. Binds when the instance or the
 * element changes, forwards shallow-changed options through `handle.update()` and never
 * re-adds for option changes. Returns a ref to the current handle (for manual `update`).
 */
export function useInfluence(
  ref: RefObject<Element | null>,
  opts: BindElementOptions = NO_OPTIONS,
): RefObject<InfluenceHandle | null> {
  const instance = usePixelLife();
  const bound = useRef<Bound | null>(null);
  const handleRef = useRef<InfluenceHandle | null>(null);

  // Deliberately without a dependency list: `ref.current` is not reactive, so the element is
  // compared after every commit (cheap identity checks).
  useEffect(() => {
    const el = ref.current;
    let cur = bound.current;
    if (cur && (cur.instance !== instance || cur.el !== el)) {
      cur.handle.dispose();
      cur = bound.current = null;
      handleRef.current = null;
    }
    if (!cur) {
      if (instance && el) {
        const handle = instance.bindElement(el, opts);
        bound.current = { instance, el, handle, opts };
        handleRef.current = handle;
      }
      return;
    }
    if (!shallowEqual(cur.opts, opts)) {
      cur.handle.update(opts as Partial<InfluenceOptions>);
      cur.opts = opts;
    }
  });

  useEffect(
    () => () => {
      bound.current?.handle.dispose();
      bound.current = null;
      handleRef.current = null;
    },
    [],
  );

  return handleRef;
}

function readSource(source: ModulationSource): number {
  if (typeof source === 'number') return source;
  if (typeof source === 'function') return source();
  return source.get();
}

/**
 * Drives a numeric parameter from a value, a function or `{ get() }`. The source is read through
 * a ref, so changing it (e.g. a new inline function every render) does not re-register.
 */
export function useModulator(
  path: ModulatablePath,
  source: ModulationSource,
  opts?: ModulateOptions,
): void {
  const instance = usePixelLife();
  const sourceRef = useRef(source);
  useEffect(() => {
    sourceRef.current = source;
  });
  const blend = opts?.blend;
  const smoothingMs = opts?.smoothingMs;
  const signal = opts?.signal;
  useEffect(() => {
    if (!instance) return;
    const handle = instance.modulate(path, () => readSource(sourceRef.current), {
      blend,
      smoothingMs,
      signal,
    });
    return () => handle.dispose();
  }, [instance, path, blend, smoothingMs, signal]);
}

/** Stable callback that emits a pulse (no-op while there is no instance). */
export function usePulse(): (opts: PulseOptions) => void {
  const instance = usePixelLife();
  const ref = useRef(instance);
  useEffect(() => {
    ref.current = instance;
  });
  return useCallback((opts: PulseOptions) => {
    ref.current?.pulse(opts);
  }, []);
}

function createStatsStore(instance: PixelLife | null) {
  let snapshot: Stats | null = null;
  let off: (() => void) | null = null;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (!off && instance) {
        off = instance.on('stats', (stats) => {
          // The facade may reuse the object; useSyncExternalStore needs a new identity per change.
          snapshot = { ...stats };
          for (const l of listeners) l();
        });
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && off) {
          off();
          off = null;
        }
      };
    },
    getSnapshot: () => snapshot,
  };
}

const getServerStats = (): Stats | null => null;

/** Latest stats (about 4 Hz), or null until the first sample. */
export function usePixelLifeStats(): Stats | null {
  const instance = usePixelLife();
  const store = useMemo(() => createStatsStore(instance), [instance]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, getServerStats);
}

/** Subscribes to an instance event; the handler may change every render without resubscribing. */
export function usePixelLifeEvent<K extends keyof PixelLifeEvents>(
  type: K,
  handler: (event: PixelLifeEvents[K]) => void,
): void {
  const instance = usePixelLife();
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });
  useEffect(() => {
    if (!instance) return;
    return instance.on(type, (event) => handlerRef.current(event));
  }, [instance, type]);
}
