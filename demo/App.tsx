import type { PixelLifeConfig, PixelLife as PixelLifeInstance, PresetId } from 'pixel-life';
import { PixelLifeContext } from 'pixel-life/react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ExportModal } from './stand/ExportModal';
import { hotkeyOf } from './stand/hotkeys';
import { ImportModal } from './stand/ImportModal';
import { ModulationContext, ModulationTracker } from './stand/modulation';
import {
  decodeShareHash,
  getInitialState,
  type LoadedState,
  loadJson,
  saveAutosave,
  saveJson,
  shareUrl,
  UI_KEY,
} from './stand/persistence';
import { DEBUG_VIEWS, DEFAULT_PREFS, type Prefs, sanitizePrefs } from './stand/prefs';
import { Stage } from './stand/Stage';
import { StandPanel } from './stand/StandPanel';
import { SceneBinder } from './stand/scene-binding';
import { StandStore, StoreContext } from './stand/store';
import { StandToolbar } from './stand/Toolbar';
import { copyText, ToastList, useToasts } from './stand/ui';

declare global {
  interface Window {
    /** Dev-only handles for checks from the console / browser automation. */
    __pixelLife?: PixelLifeInstance | null;
    __standStore?: StandStore;
  }
}

const PREFS_KEY = `${UI_KEY}:prefs`;

export function App() {
  const [store] = useState(() => {
    const init = getInitialState();
    return new StandStore(init.cfg, init.presetId);
  });
  const [tracker] = useState(() => new ModulationTracker());
  const [instance, setInstance] = useState<PixelLifeInstance | null>(null);

  return (
    <StoreContext.Provider value={store}>
      <ModulationContext.Provider value={tracker}>
        {/* The stats block and toolbar live outside <PixelLife>, so the instance is shared here. */}
        <PixelLifeContext.Provider value={instance}>
          <Stand store={store} tracker={tracker} instance={instance} setInstance={setInstance} />
        </PixelLifeContext.Provider>
      </ModulationContext.Provider>
    </StoreContext.Provider>
  );
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

function notifyShared(
  notify: (message: string, tone: 'success' | 'warn') => void,
  shared: Pick<LoadedState, 'issues'>,
): void {
  const n = shared.issues.length;
  notify(
    n ? `Настройки из ссылки применены, замечаний: ${n}` : 'Настройки загружены из ссылки',
    n ? 'warn' : 'success',
  );
}

interface StandProps {
  store: StandStore;
  tracker: ModulationTracker;
  instance: PixelLifeInstance | null;
  setInstance(instance: PixelLifeInstance | null): void;
}

function Stand({ store, tracker, instance, setInstance }: StandProps) {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [binder] = useState(() => new SceneBinder(tracker));
  const toasts = useToasts(4);
  const { push } = toasts;

  const [prefs, setPrefs] = useState<Prefs>(() => ({
    ...sanitizePrefs(loadJson<Prefs>(PREFS_KEY, DEFAULT_PREFS)),
    debug: 'final',
  }));
  const patchPrefs = useCallback(
    (patch: Partial<Prefs>) => setPrefs((p) => ({ ...p, ...patch })),
    [],
  );
  useEffect(() => {
    saveJson(PREFS_KEY, { ...prefs, debug: undefined });
  }, [prefs]);

  const [paused, setPaused] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const openExport = useCallback(() => setExportOpen(true), []);
  const openImport = useCallback(() => setImportOpen(true), []);
  const notify = useCallback(
    (message: string, tone: 'info' | 'success' | 'warn' | 'error' = 'info') =>
      push(message, { tone }),
    [push],
  );

  // ---------------------------------------------------------------- instance wiring

  useEffect(() => {
    tracker.setInstance(instance);
    return () => tracker.setInstance(null);
  }, [tracker, instance]);

  useEffect(() => {
    if (instance) instance.setDebugView(prefs.debug);
  }, [instance, prefs.debug]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    window.__pixelLife = instance;
    window.__standStore = store;
  }, [instance, store]);

  useEffect(() => {
    if (!instance) return;
    const offs = [
      instance.on('fallback', (e) => {
        // A lost context has its own notice below.
        if (e.reason === 'context-lost') return;
        notify(
          e.reason === 'no-webgl2'
            ? 'WebGL2 недоступен: показана статичная заставка'
            : `Отказ рендера: ${e.reason}`,
          'warn',
        );
      }),
      instance.on('contextlost', () => notify('WebGL-контекст потерян', 'warn')),
      instance.on('contextrestored', () => notify('Контекст восстановлен', 'success')),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [instance, notify]);

  // ------------------------------------------------------------ history and autosave

  useEffect(() => {
    // Releasing the pointer closes the current coalescing group: one drag = one undo step.
    window.addEventListener('pointerup', store.endGroup, true);
    window.addEventListener('pointercancel', store.endGroup, true);
    return () => {
      window.removeEventListener('pointerup', store.endGroup, true);
      window.removeEventListener('pointercancel', store.endGroup, true);
    };
  }, [store]);

  useEffect(() => {
    let timer = 0;
    const save = () => {
      const s = store.getSnapshot();
      saveAutosave(s.cfg, s.presetId);
    };
    const unsub = store.subscribe(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(save, 300);
    });
    const flush = () => {
      if (!timer) return;
      window.clearTimeout(timer);
      timer = 0;
      save();
    };
    window.addEventListener('pagehide', flush);
    return () => {
      unsub();
      window.clearTimeout(timer);
      window.removeEventListener('pagehide', flush);
    };
  }, [store]);

  // Tell the user where the initial state came from (once, also under StrictMode).
  const announced = useRef(false);
  useEffect(() => {
    if (announced.current) return;
    announced.current = true;
    const init = getInitialState();
    if (init.source === 'hash') notifyShared(notify, init);
  }, [notify]);

  // A share link pasted into a tab where the stand is already open is a same-document fragment
  // navigation (no reload): apply it here, the same way as on load.
  useEffect(() => {
    const onHash = () => {
      const shared = decodeShareHash(window.location.hash);
      if (!shared) return;
      store.replace(shared.cfg, shared.presetId);
      notifyShared(notify, shared);
      try {
        const { pathname, search } = window.location;
        window.history.replaceState(null, '', pathname + search);
      } catch {
        // ignore
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [store, notify]);

  // ------------------------------------------------------------------------ hotkeys

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey) return;
      if (document.querySelector('dialog[open]')) return;
      const key = hotkeyOf(e);
      const mod = e.ctrlKey || e.metaKey;
      if (mod) {
        // Inside text fields Ctrl+Z belongs to the field itself.
        if (isTyping(e.target)) return;
        if (key === 'z' && !e.shiftKey) store.undo();
        else if ((key === 'z' && e.shiftKey) || key === 'y') store.redo();
        else return;
        e.preventDefault();
        return;
      }
      if (isTyping(e.target)) return;
      if (key === 'h') setPrefs((p) => ({ ...p, panelCollapsed: !p.panelCollapsed }));
      else if (key === 'p') setPaused((v) => !v);
      else if (key === 'd') {
        setPrefs((p) => {
          const i = DEBUG_VIEWS.findIndex((d) => d.id === p.debug);
          return { ...p, debug: DEBUG_VIEWS[(i + 1) % DEBUG_VIEWS.length]?.id ?? 'final' };
        });
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store]);

  // ---------------------------------------------------------------------- actions

  const copyLink = useCallback(async () => {
    const s = store.getSnapshot();
    const ok = await copyText(shareUrl(s.cfg, s.presetId));
    notify(ok ? 'Ссылка скопирована' : 'Не удалось скопировать ссылку', ok ? 'success' : 'error');
  }, [store, notify]);

  const applyImport = useCallback(
    (config: PixelLifeConfig, presetId: PresetId | null) => {
      store.replace(config, presetId ?? store.getSnapshot().presetId);
      notify('Настройки применены', 'success');
    },
    [store, notify],
  );

  const onError = useCallback(
    (e: Error) => notify(`Ошибка рендера: ${e.message}`, 'error'),
    [notify],
  );
  const onResize = useCallback(
    (w: number, h: number) => patchPrefs({ size: 'custom', customW: w, customH: h }),
    [patchPrefs],
  );

  return (
    <div className="stand" data-collapsed={prefs.panelCollapsed || undefined}>
      <div className="stand__bar">
        <StandToolbar
          prefs={prefs}
          patchPrefs={patchPrefs}
          paused={paused}
          onPaused={setPaused}
          onExport={openExport}
          onImport={openImport}
          onCopyLink={copyLink}
        />
      </div>
      <div className="stand__body">
        <main className="stand__main">
          <Stage
            cfg={snap.cfg}
            transition={snap.transition}
            paused={paused}
            prefs={prefs}
            binder={binder}
            onInstance={setInstance}
            onResize={onResize}
            onError={onError}
          />
        </main>
        <div className="stand__dock">
          <StandPanel prefs={prefs} patchPrefs={patchPrefs} />
        </div>
      </div>

      <ExportModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        cfg={snap.cfg}
        presetId={snap.presetId}
        notify={notify}
      />
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} onApply={applyImport} />
      <ToastList items={toasts.toasts} onDismiss={toasts.dismiss} placement="bottom-left" />
    </div>
  );
}
