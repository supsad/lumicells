/**
 * <lumi-cells>: the Web Component wrapper around the LumiCells facade.
 *
 * Properties are the source of truth; the scalar attributes (preset, src, interactive, overflow,
 * paused, transition, priority, renderer) feed the same state and only the boolean ones reflect
 * back. The module is
 * importable in Node (SSR bundlers evaluate it): the HTMLElement base is guarded and nothing
 * here touches the DOM until an element is constructed.
 */

import { LumiCells } from '../core/lumi-cells';
import { isRendererMode, runtimeSettings } from '../core/runtime/scheduler';
import type {
  ConfigSource,
  InfluenceHandle,
  InfluenceOptions,
  InstancePriority,
  LumiCellsEvents,
  RendererMode,
  Stats,
} from '../core/types';
import {
  isPresetId,
  type LumiCellsConfig,
  type LumiCellsConfigInput,
  normalizePatch,
  type PresetId,
} from '../schema';
import {
  ATTR_FOR,
  attrsSignature,
  DATA_LC_ATTRS,
  isManaged,
  type LcAttrs,
  MANAGED_SELECTOR,
  parseLcAttrs,
} from './data-attrs';
import { needsRebind } from './rebind';
import { resolveConfig } from './resolve';

export const LUMI_CELLS_TAG = 'lumi-cells';

export interface LumiCellsElementEventMap {
  'lc-ready': CustomEvent<{ instance: LumiCells }>;
  'lc-config': CustomEvent<LumiCellsEvents['config']>;
  'lc-stats': CustomEvent<Stats>;
  'lc-error': CustomEvent<Error>;
  'lc-fallback': CustomEvent<LumiCellsEvents['fallback']>;
  /** The WebGL context was lost (an `lc-fallback` with reason `context-lost` follows). */
  'lc-contextlost': CustomEvent<null>;
  /** The animation is back after a context loss: ends a `context-lost` fallback. */
  'lc-contextrestored': CustomEvent<null>;
  /** The renderer changed (`auto` promotion, demotion or budget move, or an explicit switch). */
  'lc-renderer': CustomEvent<LumiCellsEvents['renderer']>;
}

declare global {
  interface HTMLElementTagNameMap {
    'lumi-cells': LumiCellsElement;
  }
  interface HTMLElementEventMap extends LumiCellsElementEventMap {}
}

// Without a DOM (SSR, tests in node) the class still has to evaluate, so the base is a stub.
const Base = (typeof HTMLElement === 'undefined'
  ? class {}
  : HTMLElement) as unknown as typeof HTMLElement;

const STYLE = `
:host{display:block;position:relative;isolation:isolate}
:host([hidden]){display:none}
.stage{position:absolute;inset:0;z-index:0}
.content{position:relative;z-index:1;height:100%;pointer-events:none}
::slotted(*){pointer-events:auto}
`;

/** Constructable stylesheet shared by all instances (avoids inline <style> under strict CSP). */
let sharedSheet: CSSStyleSheet | null | undefined;

function applyStyle(root: ShadowRoot): void {
  if (sharedSheet === undefined) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(STYLE);
      sharedSheet = sheet;
    } catch {
      sharedSheet = null;
    }
  }
  if (sharedSheet && 'adoptedStyleSheets' in root) {
    root.adoptedStyleSheets = [sharedSheet];
    return;
  }
  const style = document.createElement('style');
  style.textContent = STYLE;
  root.append(style);
}

// One MutationObserver per root node serves every <lumi-cells> that has an id (the only elements
// that can own portals, data-lc-for), instead of each element observing the whole document.
type RootCallback = (records: MutationRecord[]) => void;
interface RootWatcher {
  mo: MutationObserver;
  subs: Set<RootCallback>;
}
const rootWatchers = new WeakMap<Node, RootWatcher>();

function watchRoot(root: Node, cb: RootCallback): () => void {
  let watcher = rootWatchers.get(root);
  if (!watcher) {
    const subs = new Set<RootCallback>();
    const mo = new MutationObserver((records) => {
      for (const sub of subs) sub(records);
    });
    mo.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [...DATA_LC_ATTRS],
    });
    watcher = { mo, subs };
    rootWatchers.set(root, watcher);
  }
  const w = watcher;
  w.subs.add(cb);
  return () => {
    w.subs.delete(cb);
    if (w.subs.size === 0) {
      w.mo.disconnect();
      if (rootWatchers.get(root) === w) rootWatchers.delete(root);
    }
  };
}

interface Binding {
  attrs: LcAttrs;
  sig: string;
  handle: InfluenceHandle | null;
  /** Aborts the pulse/lift listeners. */
  triggers: AbortController | null;
}

const UPGRADE_PROPS = [
  'config',
  'preset',
  'src',
  'interactive',
  'overflow',
  'paused',
  'transition',
  'priority',
  'renderer',
] as const;

const FORWARDED_EVENTS = [
  'pointermove',
  'pointerdown',
  'pointerup',
  'pointerenter',
  'pointerleave',
  'pointercancel',
  'click',
] as const;

function parseOverflowAttr(value: string | null): boolean | number | undefined {
  if (value === null) return undefined;
  const v = value.trim().toLowerCase();
  if (v === '' || v === 'true') return true;
  if (v === 'false') return false;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, n) : undefined;
}

function parsePriority(value: unknown): InstancePriority {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : value;
  return v === 'high' || v === 'low' ? v : 'normal';
}

/** A renderer mode, or null (the page default) for anything else. */
function parseRenderer(value: unknown): RendererMode | null {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : value;
  return isRendererMode(v) ? v : null;
}

function parseTransitionAttr(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : null;
}

export class LumiCellsElement extends Base {
  static readonly observedAttributes = [
    'preset',
    'src',
    'interactive',
    'overflow',
    'paused',
    'transition',
    'priority',
    'renderer',
    'id',
  ];

  #stage!: HTMLDivElement;

  // Property state (source of truth).
  #config: LumiCellsConfigInput | null = null;
  #preset: PresetId | null = null;
  #src: string | null = null;
  // Tri-state: undefined leaves interaction.* of the config alone.
  #interactive: boolean | undefined;
  #overflow: boolean | number | undefined;
  #paused = false;
  #transition: number | null = null;
  #priority: InstancePriority = 'normal';
  /** Null: the page default (`LumiCells.configure({ renderer })`). */
  #renderer: RendererMode | null = null;

  #instance: LumiCells | null = null;
  #unsubs: Array<() => void> = [];
  #key = '';
  #active = false;
  #scheduled = false;
  #reflecting = false;
  #token = 0;
  #fallbackNotified = false;

  #srcAbort: AbortController | null = null;
  #srcUrl: string | null = null;
  #srcPatch: LumiCellsConfigInput | null = null;
  /** The next flush applies a freshly loaded src patch: no visible crossfade from the default look. */
  #srcInstant = false;
  // Where the pending change came from, reported as `lc-config` detail.source.
  #pendingSource: ConfigSource = 'attribute';

  #bindings = new Map<Element, Binding>();
  #localObserver: MutationObserver | null = null;
  #unwatchRoot: (() => void) | null = null;
  #watchedRoot: Node | null = null;
  #forwardAbort: AbortController | null = null;

  constructor() {
    super();
    const root = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
    const stage = document.createElement('div');
    stage.className = 'stage';
    stage.setAttribute('part', 'stage');
    const content = document.createElement('div');
    content.className = 'content';
    content.setAttribute('part', 'content');
    content.append(document.createElement('slot'));
    root.replaceChildren();
    applyStyle(root);
    root.append(stage, content);
    this.#stage = stage;
  }

  // ---- properties -------------------------------------------------------------------------

  get config(): LumiCellsConfigInput | null {
    return this.#config;
  }
  set config(value: LumiCellsConfigInput | null) {
    this.#config = value ?? null;
    this.#touch('api');
  }

  get preset(): PresetId | null {
    return this.#preset;
  }
  set preset(value: PresetId | string | null) {
    this.#preset = isPresetId(value) ? value : null;
    this.#touch('api');
  }

  get src(): string | null {
    return this.#src;
  }
  set src(value: string | null) {
    const next = value ? String(value) : null;
    if (next === this.#src) return;
    this.#src = next;
    this.#loadSrc();
  }

  get interactive(): boolean {
    return this.#interactive === true;
  }
  set interactive(value: boolean) {
    this.#interactive = !!value;
    this.#reflect('interactive', this.#interactive);
    this.#touch('api');
  }

  get overflow(): boolean | number {
    return this.#overflow ?? false;
  }
  set overflow(value: boolean | number | string | null | undefined) {
    this.#overflow =
      typeof value === 'string'
        ? parseOverflowAttr(value)
        : value === null || value === undefined
          ? undefined
          : value;
    this.#touch('api');
  }

  get paused(): boolean {
    return this.#paused;
  }
  set paused(value: boolean) {
    this.#paused = !!value;
    this.#reflect('paused', this.#paused);
    this.#touch('api');
  }

  get transition(): number | null {
    return this.#transition;
  }
  set transition(value: number | string | null) {
    const n = value === null || value === '' ? null : Number(value);
    this.#transition = n !== null && Number.isFinite(n) ? Math.max(0, n) : null;
  }

  /**
   * Priority for the page's WebGL context budget (`high`, `normal` or `low`; anything else is
   * `normal`). Visible backgrounds with a higher priority keep or take a context first.
   */
  get priority(): InstancePriority {
    return this.#priority;
  }
  set priority(value: InstancePriority | string | null) {
    this.#priority = parsePriority(value);
    this.#instance?.setPriority(this.#priority);
  }

  /**
   * The renderer asked for: `auto` (the page default unless `LumiCells.configure({ renderer })`
   * says otherwise; a large background gets a WebGL context of its own while the budget has
   * room, smaller ones share one), `own` (always a context of its own) or `shared` (always the
   * page's shared context, copied into a 2D canvas). Anything else, or removing the attribute,
   * means the page default. Switches the running instance (see `LumiCells.setRenderer`); the
   * renderer it actually uses is `instance.renderer` (event `lc-renderer`).
   */
  get renderer(): RendererMode {
    return this.#renderer ?? this.#instance?.rendererMode ?? runtimeSettings().renderer;
  }
  set renderer(value: RendererMode | string | null) {
    this.#renderer = parseRenderer(value);
    this.#instance?.setRenderer(this.#renderer ?? runtimeSettings().renderer);
  }

  /** The live LumiCells instance while the element is connected. */
  get instance(): LumiCells | null {
    return this.#instance;
  }

  // ---- lifecycle --------------------------------------------------------------------------

  connectedCallback(): void {
    this.#captureUpgradedProperties();
    // A pending disconnect microtask (element is being moved) must not tear us down.
    this.#token++;
    this.#active = true;
    if (this.#instance && this.#watchedRoot !== this.getRootNode()) this.#rewatchRoot();
    this.#loadSrc();
    // Deferred so that properties set right after append() are part of the first config.
    this.#schedule();
  }

  disconnectedCallback(): void {
    const token = ++this.#token;
    queueMicrotask(() => {
      if (token === this.#token && !this.isConnected) this.#teardown();
    });
  }

  attributeChangedCallback(name: string, oldValue: string | null, value: string | null): void {
    if (this.#reflecting) return;
    // preset/src are not reflected: a property assignment can leave a stale attribute behind, so
    // re-setting the same attribute value must still win. They compare against the property state.
    if (oldValue === value && name !== 'preset' && name !== 'src') return;
    switch (name) {
      case 'preset':
        if ((isPresetId(value) ? value : null) !== this.#preset) {
          this.#preset = isPresetId(value) ? value : null;
          this.#touch('attribute');
        }
        break;
      case 'src':
        this.src = value;
        break;
      case 'interactive':
        this.#interactive = value !== null;
        this.#touch('attribute');
        break;
      case 'paused':
        this.#paused = value !== null;
        this.#touch('attribute');
        break;
      case 'overflow':
        this.#overflow = parseOverflowAttr(value);
        this.#touch('attribute');
        break;
      case 'transition':
        this.#transition = parseTransitionAttr(value);
        break;
      case 'priority':
        this.priority = value;
        break;
      case 'renderer':
        this.renderer = value;
        break;
      case 'id':
        if (this.#instance) {
          // The document-wide observer only exists for elements with an id.
          if ((this.#unwatchRoot !== null) !== (this.id !== '')) this.#rewatchRoot();
          else this.#scanBindings();
        }
        break;
    }
  }

  // ---- internals: state -> instance ---------------------------------------------------------

  #reflect(name: string, on: boolean): void {
    if (this.hasAttribute(name) === on) return;
    this.#reflecting = true;
    try {
      this.toggleAttribute(name, on);
    } finally {
      this.#reflecting = false;
    }
  }

  /** Values assigned before the element was upgraded shadow the accessors; re-assign them. */
  #captureUpgradedProperties(): void {
    const self = this as unknown as Record<string, unknown>;
    for (const prop of UPGRADE_PROPS) {
      if (Object.hasOwn(self, prop)) {
        const value = self[prop];
        delete self[prop];
        self[prop] = value;
      }
    }
  }

  #touch(source: ConfigSource): void {
    this.#pendingSource = source;
    this.#schedule();
  }

  #schedule(): void {
    if (this.#scheduled || !this.#active) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      this.#flush();
    });
  }

  #flush(): void {
    if (!this.#active || !this.isConnected) return;
    if (this.#instance?.destroyed) this.#dropInstance();
    const resolved = resolveConfig({
      preset: this.#preset,
      layers: [this.#srcPatch, this.#config],
      interactive: this.#interactive,
      overflow: this.#overflow,
    });
    if (!this.#instance) {
      this.#createInstance(resolved.config);
    } else if (resolved.key !== this.#key) {
      this.#instance.replaceConfig(resolved.config, {
        transition: this.#srcInstant ? 0 : (this.#transition ?? undefined),
        source: this.#pendingSource,
      });
    }
    this.#srcInstant = false;
    this.#pendingSource = 'attribute';
    this.#key = resolved.key;
    this.#syncPaused();
  }

  #syncPaused(): void {
    const instance = this.#instance;
    if (!instance) return;
    if (this.#paused) instance.stop();
    else instance.start();
  }

  #createInstance(config: LumiCellsConfig): void {
    // autoStart is off so no event can fire before the listeners below are attached.
    const instance = new LumiCells(this.#stage, {
      config,
      autoStart: false,
      priority: this.#priority,
      renderer: this.#renderer ?? undefined,
    });
    this.#instance = instance;
    this.#fallbackNotified = false;
    this.#unsubs = [
      instance.on('ready', () => this.#emit('lc-ready', { instance })),
      instance.on('config', (e) => this.#emit('lc-config', e)),
      instance.on('stats', (e) => this.#emit('lc-stats', { ...e })),
      instance.on('error', (e) => this.#emit('lc-error', e)),
      instance.on('fallback', (e) => {
        // The synchronous notice below (which paused elements rely on) already reported
        // no-webgl2; the facade's own deferred event for it must not be reported again.
        // 'compile' and 'context-lost' still pass.
        if (this.#fallbackNotified && e.reason === 'no-webgl2') return;
        this.#fallbackNotified = true;
        this.#emit('lc-fallback', e);
      }),
      instance.on('contextlost', () => this.#emit('lc-contextlost', null)),
      instance.on('contextrestored', () => this.#emit('lc-contextrestored', null)),
      instance.on('renderer', (e) => this.#emit('lc-renderer', e)),
    ];
    // The facade may have decided on the poster-only path during construction.
    if (!instance.supported && !this.#fallbackNotified) {
      this.#fallbackNotified = true;
      this.#emit('lc-fallback', { reason: 'no-webgl2' });
    }
    this.#startBinding();
  }

  #dropInstance(): void {
    this.#stopBinding();
    for (const off of this.#unsubs) off();
    this.#unsubs = [];
    this.#instance?.destroy();
    this.#instance = null;
    this.#key = '';
  }

  #teardown(): void {
    this.#active = false;
    this.#srcAbort?.abort();
    this.#srcAbort = null;
    if (!this.#srcPatch) this.#srcUrl = null;
    this.#srcInstant = false;
    this.#dropInstance();
  }

  #emit<K extends keyof LumiCellsElementEventMap>(
    type: K,
    detail: LumiCellsElementEventMap[K] extends CustomEvent<infer D> ? D : never,
  ): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  // ---- internals: src ---------------------------------------------------------------------

  #loadSrc(): void {
    if (!this.#active) return;
    const url = this.#src;
    if (url && this.#srcUrl === url && this.#srcPatch) return;
    this.#srcAbort?.abort();
    this.#srcAbort = null;
    if (!url) {
      if (this.#srcPatch) {
        this.#srcPatch = null;
        this.#srcUrl = null;
        this.#schedule();
      }
      return;
    }
    const ac = new AbortController();
    this.#srcAbort = ac;
    fetch(url, { signal: ac.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`lumicells: "${url}" responded with ${res.status}`);
        return res.json() as Promise<unknown>;
      })
      .then((raw) => {
        if (ac.signal.aborted) return;
        // A patch (not a full normalize) so a partial file keeps the preset underneath.
        const { patch, issues } = normalizePatch(raw);
        if (issues.length > 0) {
          console.warn(
            `[lumicells] ${issues.length} issue(s) in "${url}":`,
            issues.map((i) => `${i.path}: ${i.message}`),
          );
        }
        this.#srcPatch = patch;
        this.#srcUrl = url;
        this.#srcInstant = true;
        this.#touch('import');
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        this.#emit('lc-error', err instanceof Error ? err : new Error(String(err)));
      });
  }

  // ---- internals: data-lc-* bindings ------------------------------------------------------

  #startBinding(): void {
    this.#localObserver = new MutationObserver((records) => this.#onLocalMutations(records));
    this.#localObserver.observe(this, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [...DATA_LC_ATTRS],
    });
    this.#startForwarding();
    this.#rewatchRoot(); // also performs the initial scan
  }

  #stopBinding(): void {
    this.#localObserver?.disconnect();
    this.#localObserver = null;
    this.#unwatchRoot?.();
    this.#unwatchRoot = null;
    this.#watchedRoot = null;
    this.#forwardAbort?.abort();
    this.#forwardAbort = null;
    for (const el of [...this.#bindings.keys()]) this.#unbind(el);
  }

  #rewatchRoot(): void {
    this.#unwatchRoot?.();
    this.#unwatchRoot = null;
    this.#watchedRoot = this.getRootNode();
    // Only portals (data-lc-for, which need an id) care about mutations outside this element;
    // an element without an id must not make the browser report every DOM change on the page.
    if (this.id !== '') {
      this.#unwatchRoot = watchRoot(this.#watchedRoot, (records) => this.#onRootMutations(records));
    }
    this.#scanBindings();
  }

  /**
   * The stage sits below the slotted content, so pointer events over bubbles never reach it.
   * Re-dispatch them to the stage (which is the LumiCells host) while interaction is enabled.
   */
  #startForwarding(): void {
    const ac = new AbortController();
    this.#forwardAbort = ac;
    const hasPointerEvents = typeof PointerEvent !== 'undefined';
    const forward = (e: Event): void => {
      const instance = this.#instance;
      if (!instance || !(e instanceof MouseEvent)) return;
      if (e.composedPath()[0] === this.#stage) return;
      const { pointer, click } = instance.getConfig().interaction;
      if (!pointer && !click) return;
      const init: PointerEventInit = {
        bubbles: false,
        composed: false,
        clientX: e.clientX,
        clientY: e.clientY,
        screenX: e.screenX,
        screenY: e.screenY,
        button: e.button,
        buttons: e.buttons,
        ...(hasPointerEvents && e instanceof PointerEvent
          ? {
              pointerId: e.pointerId,
              pointerType: e.pointerType,
              isPrimary: e.isPrimary,
              pressure: e.pressure,
            }
          : {}),
      };
      this.#stage.dispatchEvent(
        hasPointerEvents && e instanceof PointerEvent
          ? new PointerEvent(e.type, init)
          : new MouseEvent(e.type, init),
      );
    };
    for (const type of FORWARDED_EVENTS) {
      this.addEventListener(type, forward, { signal: ac.signal, passive: true });
    }
  }

  /** Who a binding element belongs to: `data-lc-for` names an id, otherwise the nearest ancestor. */
  #owns(el: Element): boolean {
    if (el === this || !el.isConnected) return false;
    const target = el.getAttribute(ATTR_FOR);
    if (target !== null) {
      const id = this.id;
      return id !== '' && target.trim() === id;
    }
    return el.parentElement?.closest(this.localName) === this;
  }

  #scanBindings(): void {
    if (!this.#instance) return;
    const seen = new Set<Element>();
    const visit = (el: Element): void => {
      if (this.#owns(el) && (isManaged(el) || el.hasAttribute(ATTR_FOR))) {
        seen.add(el);
        this.#syncElement(el);
      }
    };
    for (const el of this.querySelectorAll(`${MANAGED_SELECTOR},[${ATTR_FOR}]`)) visit(el);
    const id = this.id;
    if (id !== '') {
      const root = this.getRootNode() as ParentNode;
      for (const el of root.querySelectorAll(`[${ATTR_FOR}]`)) visit(el);
    }
    for (const el of [...this.#bindings.keys()]) if (!seen.has(el)) this.#unbind(el);
  }

  #syncTree(el: Element): void {
    this.#syncElement(el);
    for (const child of el.querySelectorAll(`${MANAGED_SELECTOR},[${ATTR_FOR}]`)) {
      this.#syncElement(child);
    }
  }

  /** Drops bindings of elements that left the document or now belong to somebody else. */
  #sweep(): void {
    for (const el of [...this.#bindings.keys()]) if (!this.#owns(el)) this.#unbind(el);
  }

  #onLocalMutations(records: MutationRecord[]): void {
    let sweep = false;
    for (const r of records) {
      if (r.type === 'attributes') {
        if (r.target.nodeType === 1) this.#syncElement(r.target as Element);
        continue;
      }
      for (const node of r.addedNodes) if (node.nodeType === 1) this.#syncTree(node as Element);
      if (r.removedNodes.length > 0) sweep = true;
    }
    if (sweep) this.#sweep();
  }

  #onRootMutations(records: MutationRecord[]): void {
    // Only portals (data-lc-for) are interesting at document level; descendants are handled by
    // the local observer.
    if (this.id === '') return;
    let sweep = false;
    for (const r of records) {
      if (r.type === 'attributes') {
        const t = r.target;
        if (
          t.nodeType === 1 &&
          (r.attributeName === ATTR_FOR || (t as Element).hasAttribute(ATTR_FOR))
        ) {
          this.#syncElement(t as Element);
        }
        continue;
      }
      for (const node of r.addedNodes) {
        if (node.nodeType !== 1) continue;
        const el = node as Element;
        if (el.hasAttribute(ATTR_FOR)) this.#syncElement(el);
        for (const p of el.querySelectorAll(`[${ATTR_FOR}]`)) this.#syncElement(p);
      }
      if (r.removedNodes.length > 0) sweep = true;
    }
    if (sweep) this.#sweep();
  }

  #syncElement(el: Element): void {
    const instance = this.#instance;
    if (!instance) return;
    const portal = el.hasAttribute(ATTR_FOR);
    if (!this.#owns(el) || !(isManaged(el) || portal)) {
      this.#unbind(el);
      return;
    }
    const attrs = parseLcAttrs(el);
    // A bare data-lc-for="id" is shorthand for "light this element up".
    if (portal && !isManaged(el)) attrs.influence = {};
    const sig = attrsSignature(attrs);
    const current = this.#bindings.get(el);
    if (current?.sig === sig) return;

    if (!current) {
      const binding: Binding = {
        attrs,
        sig,
        handle: attrs.influence ? instance.bindElement(el, attrs.influence) : null,
        triggers: null,
      };
      this.#bindings.set(el, binding);
      this.#attachTriggers(el, binding);
      return;
    }

    const prev = current.attrs;
    const next = attrs.influence;
    if (!next) {
      current.handle?.dispose();
      current.handle = null;
    } else if (!current.handle || !prev.influence || needsRebind(prev.influence, next)) {
      current.handle?.dispose();
      current.handle = instance.bindElement(el, next);
    } else {
      current.handle.update(next as Partial<InfluenceOptions>);
    }
    current.attrs = attrs;
    current.sig = sig;
    this.#attachTriggers(el, current);
  }

  #unbind(el: Element): void {
    const binding = this.#bindings.get(el);
    if (!binding) return;
    binding.triggers?.abort();
    binding.handle?.dispose();
    this.#bindings.delete(el);
  }

  #attachTriggers(el: Element, binding: Binding): void {
    binding.triggers?.abort();
    binding.triggers = null;
    const { pulse, lift, pulseColor, pulseStrength } = binding.attrs;
    if (!pulse && !lift) return;
    const ac = new AbortController();
    binding.triggers = ac;

    const fire = (kind: 'pulse' | 'lift', e: MouseEvent): void => {
      const instance = this.#instance;
      if (!instance) return;
      // Keyboard-initiated clicks have no pointer position: use the element center.
      const keyboard = e.type === 'click' && e.detail === 0;
      let x = e.clientX;
      let y = e.clientY;
      if (keyboard || !Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) {
        const r = el.getBoundingClientRect();
        x = r.left + r.width / 2;
        y = r.top + r.height / 2;
      }
      if (kind === 'pulse') {
        instance.pulse({
          x,
          y,
          space: 'client',
          ...(pulseColor ? { color: pulseColor, colorMix: 1 } : {}),
          ...(pulseStrength !== undefined ? { strength: pulseStrength } : {}),
        });
      } else {
        instance.lift({ x, y, space: 'client' });
      }
    };

    const listen = (kind: 'pulse' | 'lift', mode: 'click' | 'hover'): void => {
      const type = mode === 'click' ? 'click' : 'pointerenter';
      el.addEventListener(type, (e) => fire(kind, e as MouseEvent), {
        signal: ac.signal,
        passive: true,
      });
    };
    if (pulse) listen('pulse', pulse);
    if (lift) listen('lift', lift);
  }
}

/**
 * Registers the element (idempotent, no-op without a custom elements registry). Returns the
 * constructor registered under `tag`, if any. Kept out of module scope so importing the module
 * has no side effects; `lumicells/element/define` calls it.
 */
export function defineLumiCellsElement(
  tag: string = LUMI_CELLS_TAG,
): typeof LumiCellsElement | null {
  if (typeof customElements === 'undefined') return null;
  const existing = customElements.get(tag);
  if (existing) return existing as typeof LumiCellsElement;
  customElements.define(tag, LumiCellsElement);
  return LumiCellsElement;
}
