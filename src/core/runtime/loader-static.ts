/**
 * The loader of the <script src> bundle (vite.element.config.ts aliases runtime/loader to this
 * module): that bundle is one file anyway, so the GPU side is part of it and every instance gets
 * it at construction. Same exports as loader.ts.
 */

import type { PacerGL } from '../engine/warmup';
import * as live from './live';
import type { LiveModule } from './loader';

export type { LiveModule };

export function liveModule(): LiveModule | null {
  return live;
}

export function loadLive(): Promise<LiveModule> {
  return Promise.resolve(live);
}

export function offerPacer(gl: PacerGL, release: () => void): void {
  live.adoptPacer(gl, release);
}

export function liveLoadState(): 'idle' | 'loading' | 'loaded' | 'failed' {
  return 'loaded';
}

export function setLiveImporterForTesting(_fn: (() => Promise<LiveModule>) | null): void {}
