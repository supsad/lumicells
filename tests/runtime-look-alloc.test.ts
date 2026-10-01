/// <reference types="node" />
/**
 * The shared renderer reads a look group's folded member state (active, visible, rendering)
 * every frame. Those getters must not allocate: a for-of over the members creates an array
 * iterator per call until TurboFan escape-analyses it away, so the getters are kept out of the
 * optimizing tier here (%NeverOptimizeFunction) to see what they cost before the JIT settles.
 */
import v8 from 'node:v8';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { Controller, lookKeyOf } from '../src/core/controller/controller';
import { LookGroup, type LookSpec } from '../src/core/runtime/look';
import type { SharedSeat } from '../src/core/runtime/shared-renderer';

v8.setFlagsFromString('--expose-gc');
v8.setFlagsFromString('--allow-natives-syntax');
const gc = vm.runInNewContext('gc') as () => void;
// Compiled after the flag is set, so the natives syntax parses.
const neverOptimize = new Function('f', '%NeverOptimizeFunction(f);') as (f: unknown) => void;

function makeGroup(members: number): LookGroup {
  const c = new Controller({ config: {} });
  c.setViewport({ hostCssW: 320, hostCssH: 200, dpr: 1, deviceW: 0, deviceH: 0 });
  const spec = {
    hostW: 320,
    hostH: 200,
    dpr: 1,
    pixelCap: Number.POSITIVE_INFINITY,
    reducedMotion: false,
    offset: 0,
    shiftX: 0,
    shiftY: 0,
    controller: c,
    stateAt: -1,
  } satisfies LookSpec;
  const g = new LookGroup(lookKeyOf(c.getConfig()), spec, 4096, false);
  // None active, visible or rendering: every getter scans all members.
  for (let i = 0; i < members; i++) {
    g.members.push({
      spec,
      rendering: false,
      client: { active: false, visible: false },
    } as unknown as SharedSeat);
  }
  return g;
}

function getter(name: 'active' | 'visible' | 'rendering'): (this: LookGroup) => boolean {
  const get = Object.getOwnPropertyDescriptor(LookGroup.prototype, name)?.get;
  if (!get) throw new Error(`LookGroup.${name} is not a getter`);
  return get as (this: LookGroup) => boolean;
}

/** Heap growth per call over `calls` calls, best of 3. */
function bytesPerCall(g: LookGroup, get: (this: LookGroup) => boolean, calls: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let r = 0; r < 3; r++) {
    gc();
    const before = process.memoryUsage().heapUsed;
    let hits = 0;
    for (let i = 0; i < calls; i++) if (get.call(g)) hits++;
    const delta = process.memoryUsage().heapUsed - before;
    expect(hits).toBe(0);
    best = Math.min(best, delta);
  }
  return Math.max(0, best) / calls;
}

describe('LookGroup folded member state allocations', () => {
  it.each(['active', 'visible', 'rendering'] as const)('%s allocates nothing per call', (name) => {
    const g = makeGroup(100);
    const get = getter(name);
    neverOptimize(get);
    for (let i = 0; i < 2000; i++) get.call(g);
    // An iterator per call would be tens of bytes; the measurement itself costs a few KB total.
    expect(bytesPerCall(g, get, 50_000)).toBeLessThan(1);
  });
});
