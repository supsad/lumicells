/**
 * <pixel-life>: the Web Component wrapper around the PixelLife facade.
 *
 * Properties are the source of truth; the scalar attributes (preset, src, interactive, overflow,
 * paused, transition) feed the same state and only the boolean ones reflect back. The module is
 * importable in Node (SSR bundlers evaluate it): the HTMLElement base is guarded and nothing
 * here touches the DOM until an element is constructed.
 */

import { PixelLife } from '../core/pixel-life';
import type {
  ConfigSource,
  InfluenceHandle,
  InfluenceOptions,
  PixelLifeEvents,
  Stats,
} from '../core/types';
import {
  isPresetId,
  normalizePatch,
  type PixelLifeConfig,
  type PixelLifeConfigInput,
  type PresetId,
} from '../schema';
import {
  ATTR_FOR,
  attrsSignature,
  DATA_PL_ATTRS,
  isManaged,
  MANAGED_SELECTOR,
  type PlAttrs,
  parsePlAttrs,
} from './data-attrs';
import { needsRebind } from './rebind';
import { resolveConfig } from './resolve';

export const PIXEL_LIFE_TAG = 'pixel-life';

export interface PixelLifeElementEventMap {
  'pl-ready': CustomEvent<{ instance: PixelLife }>;
  'pl-config': CustomEvent<PixelLifeEvents['config']>;
  'pl-stats': CustomEvent<Stats>;
  'pl-error': CustomEvent<Error>;
  'pl-fallback': CustomEvent<PixelLifeEvents['fallback']>;
}

declare global {
  interface HTMLElementTagNameMap {
    'pixel-life': PixelLifeElement;
  }
  interface HTMLElementEventMap extends PixelLifeElementEventMap {}
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

// One MutationObserver per root node serves every <pixel-life> that has an id (the only elements
// that can own portals, data-pl-for), instead of each element observing the whole document.
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
      attributeFilter: [...DATA_PL_ATTRS],
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
  attrs: PlAttrs;
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

function parseTransitionAttr(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : null;
}

export class PixelLifeElement extends Base {
  static readonly observedAttributes = [
    'preset',
    'src',
    'interactive',
    'overflow',
    'paused',
    'transition',
    'id',
  ];

  #stage!: HTMLDivElement;

  // Property state (source of truth).
  #config: PixelLifeConfigInput | null = null;
  #preset: PresetId | null = null;
  #src: string | null = null;
  // Tri-state: undefined leaves interaction.* of the config alone.
  #interactive: boolean | undefined;
  #overflow: boolean | number | undefined;
  #paused = false;
  #transition: number | null = null;

  #instance: PixelLife | null = null;
  #unsubs: Array<() => void> = [];
  #key = '';
  #active = false;
  #scheduled = false;
  #reflecting = false;
  #token = 0;
  #fallbackNotified = false;

  #srcAbort: AbortController | null = null;
  #srcUrl: string | null = null;
  #srcPatch: PixelLifeConfigInput | null = null;
  /** The next flush applies a freshly loaded src patch: no visible crossfade from the default look. */
  #srcInstant = false;
  // Where the pending change came from, reported as `pl-config` detail.source.
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

  get config(): PixelLifeConfigInput | null {
    return this.#config;
  }
  set config(value: PixelLifeConfigInput | null) {
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

  /** The live PixelLife instance while the element is connected. */
  get instance(): PixelLife | null {
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

  #createInstance(config: PixelLifeConfig): void {
    // autoStart is off so no event can fire before the listeners below are attached.
    const instance = new PixelLife(this.#stage, { config, autoStart: false });
    this.#instance = instance;
    this.#fallbackNotified = false;
    this.#unsubs = [
      instance.on('ready', () => this.#emit('pl-ready', { instance })),
      instance.on('config', (e) => this.#emit('pl-config', e)),
      instance.on('stats', (e) => this.#emit('pl-stats', { ...e })),
      instance.on('error', (e) => this.#emit('pl-error', e)),
      instance.on('fallback', (e) => {
        // The synchronous notice below (which paused elements rely on) already reported
        // no-webgl2; the facade's own deferred event for it must not be reported again.
        // 'compile' and 'context-lost' still pass.
        if (this.#fallbackNotified && e.reason === 'no-webgl2') return;
        this.#fallbackNotified = true;
        this.#emit('pl-fallback', e);
      }),
    ];
    // The facade may have decided on the poster-only path during construction.
    if (!instance.supported && !this.#fallbackNotified) {
      this.#fallbackNotified = true;
      this.#emit('pl-fallback', { reason: 'no-webgl2' });
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

  #emit<K extends keyof PixelLifeElementEventMap>(
    type: K,
    detail: PixelLifeElementEventMap[K] extends CustomEvent<infer D> ? D : never,
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
        if (!res.ok) throw new Error(`pixel-life: "${url}" responded with ${res.status}`);
        return res.json() as Promise<unknown>;
      })
      .then((raw) => {
        if (ac.signal.aborted) return;
        // A patch (not a full normalize) so a partial file keeps the preset underneath.
        const { patch, issues } = normalizePatch(raw);
        if (issues.length > 0) {
          console.warn(
            `[pixel-life] ${issues.length} issue(s) in "${url}":`,
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
        this.#emit('pl-error', err instanceof Error ? err : new Error(String(err)));
      });
  }

  // ---- internals: data-pl-* bindings ------------------------------------------------------

  #startBinding(): void {
    this.#localObserver = new MutationObserver((records) => this.#onLocalMutations(records));
    this.#localObserver.observe(this, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [...DATA_PL_ATTRS],
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
    // Only portals (data-pl-for, which need an id) care about mutations outside this element;
    // an element without an id must not make the browser report every DOM change on the page.
    if (this.id !== '') {
      this.#unwatchRoot = watchRoot(this.#watchedRoot, (records) => this.#onRootMutations(records));
    }
    this.#scanBindings();
  }

  /**
   * The stage sits below the slotted content, so pointer events over bubbles never reach it.
   * Re-dispatch them to the stage (which is the PixelLife host) while interaction is enabled.
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

  /** Who a binding element belongs to: `data-pl-for` names an id, otherwise the nearest ancestor. */
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
    // Only portals (data-pl-for) are interesting at document level; descendants are handled by
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
    const attrs = parsePlAttrs(el);
    // A bare data-pl-for="id" is shorthand for "light this element up".
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
 * has no side effects; `pixel-life/element/define` calls it.
 */
export function definePixelLifeElement(
  tag: string = PIXEL_LIFE_TAG,
): typeof PixelLifeElement | null {
  if (typeof customElements === 'undefined') return null;
  const existing = customElements.get(tag);
  if (existing) return existing as typeof PixelLifeElement;
  customElements.define(tag, PixelLifeElement);
  return PixelLifeElement;
}
