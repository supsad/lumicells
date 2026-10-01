'use client';

import {
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { LumiCells as LumiCellsCore } from '../core/lumi-cells';
import { runtimeSettings } from '../core/runtime/scheduler';
import type { InstancePriority, LookMode, RendererMode, Stats } from '../core/types';
import { resolveConfig } from '../element/resolve';
import { type LumiCellsConfigInput, type PresetId, posterCss, stableStringify } from '../schema';
import { LumiCellsContext } from './context';

export interface LumiCellsProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'className' | 'style' | 'onError'> {
  /** Named preset used as the base under `config`. */
  preset?: PresetId;
  /** Partial config merged over the preset (defaults < preset < config). */
  config?: LumiCellsConfigInput;
  /** Tween duration (ms) used when the config changes; defaults to `config.transition`. */
  transition?: number;
  /** Stops rendering while true. */
  paused?: boolean;
  /** Shortcut for `interaction.pointer` + `interaction.click`. */
  interactive?: boolean;
  /** Lets the canvas extend beyond the box: `true` = 64px, a number = px, `false` = none. */
  overflow?: boolean | number;
  /**
   * Priority for the page's WebGL context budget (`LumiCells.configure({ maxContexts })`):
   * visible backgrounds with a higher priority keep or take a context first. Default `'normal'`.
   */
  priority?: InstancePriority;
  /**
   * `'auto'` (the default, see `LumiCells.configure({ renderer })`): a large background gets a
   * WebGL context of its own while the page budget has room, smaller ones share one. `'own'`:
   * always a context of its own. `'shared'`: always the page's shared context, copied into a 2D
   * canvas. Changing it switches the running instance (see `LumiCells.setRenderer`); removing it
   * goes back to the page default.
   */
  renderer?: RendererMode;
  /**
   * `'shared'`: share one picture with every background whose config draws the same (rendered
   * once per frame, a crop of it in each card) while this one draws nothing of its own (no
   * pointer light or hover lift, pulse, influence, modulator...): see `LumiCellsOptions.look`.
   * Default `'own'`. Changing it switches the running instance (see `LumiCells.setLook`).
   */
  look?: LookMode;
  /**
   * `look="shared"`: shifts this card's window into the shared picture by up to this share of its
   * size (0 to 0.5, seeded per instance), so cards side by side are not in sync. Default 0.
   */
  lookOffset?: number;
  /**
   * Rendered over the static poster when there is no animation: WebGL2 unavailable, a shader
   * failure, or (until it is restored) a lost context. Not for a wait on the context budget
   * (fallback reason `'budget'`): the poster alone covers that.
   */
  fallback?: ReactNode;
  className?: string;
  style?: CSSProperties;
  onReady?: (instance: LumiCellsCore) => void;
  onError?: (error: Error) => void;
  /** Called about 4 times per second. */
  onStats?: (stats: Stats) => void;
  /** The LumiCells instance (null until mounted). Needs React 19 (ref as a regular prop). */
  ref?: Ref<LumiCellsCore>;
  /** Rendered above the canvas. */
  children?: ReactNode;
}

type Status = 'pending' | 'ready' | 'fallback';

const CHILDREN_STYLE: CSSProperties = { position: 'relative', zIndex: 1, height: '100%' };
const FALLBACK_STYLE: CSSProperties = { position: 'absolute', inset: 0, zIndex: 0 };

export function LumiCells({
  preset,
  config,
  transition,
  paused = false,
  interactive,
  overflow,
  priority,
  renderer,
  look,
  lookOffset,
  fallback,
  className,
  style,
  onReady,
  onError,
  onStats,
  ref,
  children,
  ...rest
}: LumiCellsProps) {
  // Inline `config={{...}}` literals change identity every render; the key makes resolving
  // (normalize + poster) happen only when the content actually changed.
  const rawKey = stableStringify({
    preset: preset ?? null,
    config: config ?? null,
    interactive: interactive ?? null,
    overflow: overflow ?? null,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: rawKey is the content hash of all inputs
  const resolved = useMemo(() => {
    const r = resolveConfig({ preset, layers: [config], interactive, overflow });
    return { ...r, poster: posterCss(r.config) };
  }, [rawKey]);

  const hostRef = useRef<HTMLDivElement>(null);
  const [instance, setInstance] = useState<LumiCellsCore | null>(null);
  const [status, setStatus] = useState<Status>('pending');
  const appliedKey = useRef('');

  // Latest props for long-lived listeners; refreshed before the other effects of each commit.
  const latest = useRef({
    resolved,
    transition,
    paused,
    priority,
    renderer,
    look,
    lookOffset,
    onReady,
    onError,
    onStats,
  });
  useEffect(() => {
    latest.current = {
      resolved,
      transition,
      paused,
      priority,
      renderer,
      look,
      lookOffset,
      onReady,
      onError,
      onStats,
    };
  });

  // Created after mount (never during render), destroyed in cleanup: safe under StrictMode,
  // which runs mount -> cleanup -> mount and therefore builds two instances in a row.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const {
      resolved: initial,
      paused: startPaused,
      priority: initialPriority,
      renderer: initialRenderer,
      look: initialLook,
      lookOffset: initialOffset,
    } = latest.current;
    // autoStart is off so no event can fire before the listeners below are attached.
    const inst = new LumiCellsCore(host, {
      config: initial.config,
      autoStart: false,
      priority: initialPriority,
      renderer: initialRenderer,
      look: initialLook,
      lookOffset: initialOffset,
    });
    appliedKey.current = initial.key;
    // 'no-webgl2' and 'compile' are final; 'context-lost' is temporary (the facade rebuilds its
    // engine on 'webglcontextrestored'), so the consumer's fallback node must not outlive it.
    let sticky = !inst.supported;
    const offs = [
      inst.on('ready', () => {
        setStatus((s) => (s === 'fallback' ? s : 'ready'));
        latest.current.onReady?.(inst);
      }),
      inst.on('error', (e) => latest.current.onError?.(e)),
      inst.on('stats', (s) => latest.current.onStats?.(s)),
      inst.on('fallback', (e) => {
        // A wait for a context of the page budget is not a missing animation: the poster
        // covers it, and the instance draws (and fires 'ready') once it gets one.
        if (e.reason === 'budget') return;
        if (e.reason !== 'context-lost') sticky = true;
        setStatus('fallback');
      }),
      // 'ready' is emitted once per instance, so the restore is what ends a context-loss fallback
      // (the facade hides its own poster on the next drawn frame).
      inst.on('contextrestored', () => {
        if (!sticky) setStatus('ready');
      }),
    ];
    if (!inst.supported) setStatus('fallback');
    setInstance(inst);
    if (!startPaused) inst.start();
    return () => {
      for (const off of offs) off();
      inst.destroy();
      setInstance(null);
      setStatus('pending');
    };
  }, []);

  // Push config changes only when the normalized content changed, so an unrelated re-render
  // (or a new-but-equal object) never restarts a transition, and imperative changes made
  // through the instance are not clobbered.
  useEffect(() => {
    if (!instance || appliedKey.current === resolved.key) return;
    appliedKey.current = resolved.key;
    instance.replaceConfig(resolved.config, {
      transition: latest.current.transition,
      source: 'api',
    });
  }, [instance, resolved]);

  useEffect(() => {
    if (!instance) return;
    if (paused) instance.stop();
    else instance.start();
  }, [instance, paused]);

  useEffect(() => {
    instance?.setPriority(priority ?? 'normal');
  }, [instance, priority]);

  useEffect(() => {
    instance?.setRenderer(renderer ?? runtimeSettings().renderer);
  }, [instance, renderer]);

  useEffect(() => {
    instance?.setLook(look ?? 'own', lookOffset ?? 0);
  }, [instance, look, lookOffset]);

  // Exposes null while there is no instance (Ref<T> types the value as T | null anyway).
  useImperativeHandle(ref, () => instance as LumiCellsCore, [instance]);

  const hasChildren = children !== undefined && children !== null && children !== false;

  return (
    <LumiCellsContext.Provider value={instance}>
      <div
        {...rest}
        ref={hostRef}
        className={className}
        style={{ position: 'relative', isolation: 'isolate', ...style }}
        data-lumicells=""
      >
        {status !== 'ready' && (
          // Static stand-in for SSR, the first frames and the no-WebGL path. It sits below the
          // canvas (z-index 0) and is removed once the first frame is up.
          <div
            aria-hidden="true"
            data-lumicells-poster=""
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: -1,
              pointerEvents: 'none',
              background: resolved.poster,
            }}
          />
        )}
        {status === 'fallback' && fallback != null && (
          <div data-lumicells-fallback="" style={FALLBACK_STYLE}>
            {fallback}
          </div>
        )}
        {hasChildren && <div style={CHILDREN_STYLE}>{children}</div>}
      </div>
    </LumiCellsContext.Provider>
  );
}
