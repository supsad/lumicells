import type { LumiCellsConfig, LumiCells as LumiCellsInstance, PresetId } from 'lumicells';
import { LumiCellsContext } from 'lumicells/react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ExportModal } from './stand/ExportModal';
import { hotkeyOf } from './stand/hotkeys';
import { ImportModal } from './stand/ImportModal';
import {
  I18nProvider,
  type Locale,
  localeFromUrl,
  MESSAGES,
  type Messages,
  syncUrlLocale,
} from './stand/i18n';
import { ModulationContext, ModulationTracker } from './stand/modulation';
import { usePauseModulators } from './stand/pause';
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
import { DEBUG_VIEWS, isNarrowViewport, type Prefs, sanitizePrefs } from './stand/prefs';
import { Stage } from './stand/Stage';
import { StandPanel } from './stand/StandPanel';
import { SceneBinder } from './stand/scene-binding';
import { StandStore, StoreContext } from './stand/store';
import { StandToolbar } from './stand/Toolbar';
import { copyText, ToastList, useToasts } from './stand/ui';

declare global {
  interface Window {
    /** Dev-only handles for checks from the console / browser automation. */
    __lumiCells?: LumiCellsInstance | null;
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
  const [instance, setInstance] = useState<LumiCellsInstance | null>(null);

  return (
    <StoreContext.Provider value={store}>
      <ModulationContext.Provider value={tracker}>
        {/* The stats block and toolbar live outside <LumiCells>, so the instance is shared here. */}
        <LumiCellsContext.Provider value={instance}>
          <Stand store={store} tracker={tracker} instance={instance} setInstance={setInstance} />
        </LumiCellsContext.Provider>
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
  t: Messages,
): void {
  const n = shared.issues.length;
  notify(n ? t.app.sharedWithIssues(n) : t.app.sharedLoaded, n ? 'warn' : 'success');
}

interface StandProps {
  store: StandStore;
  tracker: ModulationTracker;
  instance: LumiCellsInstance | null;
  setInstance(instance: LumiCellsInstance | null): void;
}

function Stand({ store, tracker, instance, setInstance }: StandProps) {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [binder] = useState(() => new SceneBinder(tracker));
  const toasts = useToasts(4);
  const { push } = toasts;

  // Whether the user has ever opened/closed the panel. Until then the panel state is a default
  // (collapsed on phones, open elsewhere) and is not saved, so it keeps following the viewport.
  const panelChosen = useRef<boolean | null>(null);
  const [prefs, setPrefs] = useState<Prefs>(() => {
    const saved = loadJson<Partial<Prefs>>(PREFS_KEY, {});
    panelChosen.current = typeof saved.panelCollapsed === 'boolean';
    const prefs = sanitizePrefs(saved);
    return {
      ...prefs,
      debug: 'final',
      panelCollapsed: panelChosen.current ? prefs.panelCollapsed : isNarrowViewport(),
    };
  });
  const patchPrefs = useCallback((patch: Partial<Prefs>) => {
    if ('panelCollapsed' in patch) panelChosen.current = true;
    setPrefs((p) => ({ ...p, ...patch }));
  }, []);
  useEffect(() => {
    saveJson(PREFS_KEY, {
      ...prefs,
      debug: undefined,
      panelCollapsed: panelChosen.current ? prefs.panelCollapsed : undefined,
    });
  }, [prefs]);

  // `?lang=` wins for this visit; picking a language in the switcher stores it in the prefs.
  const [urlLocale, setUrlLocale] = useState<Locale | null>(localeFromUrl);
  const locale = urlLocale ?? prefs.locale;
  const t = MESSAGES[locale];
  const setLocale = useCallback(
    (next: Locale) => {
      setUrlLocale(null);
      syncUrlLocale(next);
      patchPrefs({ locale: next });
    },
    [patchPrefs],
  );
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = MESSAGES[locale].meta.title;
  }, [locale]);

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

  // Pause freezes time but keeps rendering (see pause.ts): edits stay visible, stats stay live.
  usePauseModulators(instance, tracker, paused);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    window.__lumiCells = instance;
    window.__standStore = store;
  }, [instance, store]);

  useEffect(() => {
    if (!instance) return;
    const offs = [
      instance.on('fallback', (e) => {
        // A lost context has its own notice below.
        if (e.reason === 'context-lost') return;
        notify(e.reason === 'no-webgl2' ? t.app.noWebgl2 : t.app.fallback(e.reason), 'warn');
      }),
      instance.on('contextlost', () => notify(t.app.contextLost, 'warn')),
      instance.on('contextrestored', () => notify(t.app.contextRestored, 'success')),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [instance, notify, t]);

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
    if (init.source === 'hash') notifyShared(notify, init, t);
  }, [notify, t]);

  // A share link pasted into a tab where the stand is already open is a same-document fragment
  // navigation (no reload): apply it here, the same way as on load.
  useEffect(() => {
    const onHash = () => {
      const shared = decodeShareHash(window.location.hash);
      if (!shared) return;
      store.replace(shared.cfg, shared.presetId);
      notifyShared(notify, shared, t);
      try {
        const { pathname, search } = window.location;
        window.history.replaceState(null, '', pathname + search);
      } catch {
        // ignore
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [store, notify, t]);

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
      if (key === 'h') {
        panelChosen.current = true;
        setPrefs((p) => ({ ...p, panelCollapsed: !p.panelCollapsed }));
      } else if (key === 'p') setPaused((v) => !v);
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
    notify(ok ? t.app.linkCopied : t.app.linkCopyFailed, ok ? 'success' : 'error');
  }, [store, notify, t]);

  const applyImport = useCallback(
    (config: LumiCellsConfig, presetId: PresetId | null) => {
      store.replace(config, presetId ?? store.getSnapshot().presetId);
      notify(t.app.settingsApplied, 'success');
    },
    [store, notify, t],
  );

  const onError = useCallback(
    (e: Error) => notify(t.app.renderError(e.message), 'error'),
    [notify, t],
  );
  const onResize = useCallback(
    (w: number, h: number) => patchPrefs({ size: 'custom', customW: w, customH: h }),
    [patchPrefs],
  );

  return (
    <I18nProvider locale={locale} setLocale={setLocale}>
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
    </I18nProvider>
  );
}
