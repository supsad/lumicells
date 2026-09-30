/**
 * Look-tuning page: one PixelLife host (default = 'reference' look) next to the reference image,
 * with deterministic time so screenshots can be compared run to run.
 *
 * URL options:
 *   size=690       host side in CSS px (square)
 *   w=, h=         non-square host (overrides size)
 *   t=6            virtual seconds to run, then the instance stops (frozen frame); 0 = run forever
 *   seed=7         Math.random seed (see virtual-time.ts); virt=0 uses real time
 *   scene=1        mount the demo scene with the stand's bindings (use with virt=0)
 *   lifts=0        disable lifted pixels
 *   debug=field    debug view (final | field | halo | bloom | haze | cells)
 *   preset=orb     start from a preset
 *   cfg={...}      JSON patch over the config (URL-encoded)
 *   ref=0          hide the reference image
 *
 * Exposed for automation: window.tune = { pl, done, time, setConfig(patch) }.
 */

import './virtual-time';
import {
  type DebugView,
  type PixelLifeConfigInput,
  PixelLife as PixelLifeCore,
  type PresetId,
} from 'pixel-life';
import { PixelLife as PixelLifeReact } from 'pixel-life/react';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ModulationTracker } from '../../demo/stand/modulation';
import { SceneBinder, SceneLayer } from '../../demo/stand/scene-binding';

const q = new URLSearchParams(location.search);
const size = Number(q.get('size') ?? 690);
const hostW = Number(q.get('w') ?? size);
const hostH = Number(q.get('h') ?? size);
const stopAt = Number(q.get('t') ?? 6);
const withScene = q.get('scene') === '1';
const debug = (q.get('debug') ?? 'final') as DebugView;
const preset = (q.get('preset') ?? undefined) as PresetId | undefined;

let patch: PixelLifeConfigInput = {};
try {
  const raw = q.get('cfg');
  if (raw) patch = JSON.parse(raw) as PixelLifeConfigInput;
} catch (err) {
  console.error('[tune] bad cfg JSON', err);
}
if (q.get('lifts') === '0') patch = { ...patch, lift: { ...patch.lift, enabled: false } };
const config: PixelLifeConfigInput = preset ? { ...patch, extends: preset } : patch;

const host = document.getElementById('host') as HTMLElement;
host.style.width = `${hostW}px`;
host.style.height = `${hostH}px`;
const ref = document.getElementById('ref') as HTMLImageElement;
ref.style.width = `${Math.min(hostW, hostH)}px`;
ref.style.height = `${Math.min(hostW, hostH)}px`;
if (q.get('ref') === '0') ref.hidden = true;

interface TuneApi {
  pl: PixelLifeCore | null;
  done: boolean;
  time: number;
  setConfig(p: PixelLifeConfigInput): void;
}

const api: TuneApi = {
  pl: null,
  done: false,
  time: 0,
  setConfig(p) {
    api.pl?.setConfig(p, { transition: 0 });
  },
};
(window as unknown as { tune: TuneApi }).tune = api;

// ?light=0.5&tint=0.5 scale the strength / colorMix of every bound light, ?shadow=0.6&shpad=0
// scale the strength / override the padding (px) of bound shadows: try binding values for the
// demo scene without editing it.
const lightScale = Number(q.get('light') ?? 1);
const tintScale = Number(q.get('tint') ?? 1);
const shadowScale = Number(q.get('shadow') ?? 1);
const shadowPad = q.get('shpad');

function attach(pl: PixelLifeCore): void {
  api.pl = pl;
  if (lightScale !== 1 || tintScale !== 1 || shadowScale !== 1 || shadowPad !== null) {
    const bind = pl.bindElement.bind(pl);
    pl.bindElement = (el, opts = {}) => {
      if (opts.type === 'shadow') {
        return bind(el, {
          ...opts,
          strength: (opts.strength ?? 1) * shadowScale,
          padding: shadowPad === null ? opts.padding : Number(shadowPad),
        });
      }
      if (opts.type !== 'light') return bind(el, opts);
      const h = bind(el, {
        ...opts,
        strength: (opts.strength ?? 1) * lightScale,
        colorMix: (opts.colorMix ?? 0.5) * tintScale,
      });
      const update = h.update.bind(h);
      h.update = (p) =>
        update(p.strength === undefined ? p : { ...p, strength: p.strength * lightScale });
      return h;
    };
  }
  pl.setDebugView(debug);
  pl.on('frame', (e) => {
    api.time = e.time;
    if (stopAt > 0 && e.time >= stopAt && !api.done) {
      api.done = true;
      // Stop after this frame is drawn: the canvas keeps showing it.
      queueMicrotask(() => pl.stop());
      document.body.dataset.done = '1';
    }
  });
  pl.on('error', (e) => console.error('[tune]', e));
}

if (withScene) {
  const tracker = new ModulationTracker();
  const binder = new SceneBinder(tracker);
  const root = createRoot(host);
  root.render(
    createElement(
      PixelLifeReact,
      {
        config,
        transition: 0,
        style: { width: '100%', height: '100%', background: '#000032' },
        ref: (inst: PixelLifeCore | null) => {
          tracker.setInstance(inst);
          if (inst && api.pl !== inst) attach(inst);
        },
      },
      createElement(SceneLayer, { binder }),
    ),
  );
} else {
  attach(new PixelLifeCore(host, { config }));
}
