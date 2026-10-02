/**
 * The page-wide WebGL context budget: the pure ranking/eviction policy and the scheduler that
 * serves requests at frame end (with a manual rAF).
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  adoptPacer,
  type FenceGL,
  type PacerGL,
  resetWarmupForTesting,
  trackWarmup,
} from '../src/core/engine/warmup';
import {
  AREA_EVICT_RATIO,
  type BudgetMember,
  COARSE_MAX_CONTEXTS,
  ContextBudget,
  compareRank,
  DESKTOP_MAX_CONTEXTS,
  mayEvict,
  outranks,
  resolveMaxContexts,
  sanitizeMaxContexts,
} from '../src/core/runtime/context-budget';
import {
  cancelRequest,
  claimContextCreation,
  configureRuntime,
  contextsInUse,
  maxContexts,
  rankChanged,
  releaseContext,
  requestContext,
  resetRuntimeForTesting,
  runtimeSettings,
} from '../src/core/runtime/scheduler';

interface M extends BudgetMember {
  name: string;
  visible: boolean;
  inZone: boolean;
  priority: BudgetMember['priority'];
  area: number;
  lastVisible: number;
  flexible?: boolean;
}

function member(name: string, p: Partial<M> = {}): M {
  return {
    name,
    visible: true,
    inZone: true,
    priority: 'normal',
    area: 320 * 200,
    lastVisible: Number.NEGATIVE_INFINITY,
    ...p,
  };
}

const away = (name: string, lastVisible: number, p: Partial<M> = {}) =>
  member(name, { visible: false, inZone: false, lastVisible, ...p });
const near = (name: string, lastVisible: number, p: Partial<M> = {}) =>
  member(name, { visible: false, inZone: true, lastVisible, ...p });

describe('maxContexts resolution', () => {
  it("'auto' is 4 on desktop and 2 with a coarse pointer", () => {
    expect(resolveMaxContexts('auto', false)).toBe(DESKTOP_MAX_CONTEXTS);
    expect(resolveMaxContexts('auto', true)).toBe(COARSE_MAX_CONTEXTS);
    expect(DESKTOP_MAX_CONTEXTS).toBe(4);
    expect(COARSE_MAX_CONTEXTS).toBe(2);
  });

  it('numbers are floored to an integer >= 1; Infinity means no limit; junk is rejected', () => {
    expect(resolveMaxContexts(6.7, true)).toBe(6);
    expect(resolveMaxContexts(0, false)).toBe(1);
    expect(resolveMaxContexts(-3, false)).toBe(1);
    expect(resolveMaxContexts(Number.POSITIVE_INFINITY, false)).toBe(Number.POSITIVE_INFINITY);
    expect(resolveMaxContexts(Number.NaN, false)).toBe(DESKTOP_MAX_CONTEXTS);
    expect(sanitizeMaxContexts('4')).toBeNull();
    expect(sanitizeMaxContexts(Number.NEGATIVE_INFINITY)).toBeNull();
  });
});

describe('rank', () => {
  it('offscreen out of the zone < offscreen in the zone < visible, whatever the priority', () => {
    const a = away('a', 100, { priority: 'high' });
    const n = near('n', 50, { priority: 'low' });
    const v = member('v', { priority: 'low' });
    expect(compareRank(a, n)).toBeLessThan(0);
    expect(compareRank(n, v)).toBeLessThan(0);
    expect(compareRank(v, a)).toBeGreaterThan(0);
  });

  it('offscreen members: least recently visible first (never visible is the oldest)', () => {
    expect(compareRank(near('old', 10), near('new', 20))).toBeLessThan(0);
    expect(compareRank(near('never', Number.NEGATIVE_INFINITY), near('seen', 0))).toBeLessThan(0);
    // Two never-visible members rank equal (neither takes the other's slot).
    expect(
      compareRank(
        near('a', Number.NEGATIVE_INFINITY, { area: 1 }),
        near('b', Number.NEGATIVE_INFINITY, { area: 1 }),
      ),
    ).toBe(0);
  });

  it('visible members: lower priority first, then smaller area; near-equal areas are equal', () => {
    expect(compareRank(member('lo', { priority: 'low' }), member('n'))).toBeLessThan(0);
    expect(compareRank(member('n'), member('hi', { priority: 'high' }))).toBeLessThan(0);
    expect(compareRank(member('small', { area: 100 * 60 }), member('big'))).toBeLessThan(0);
    // Priority wins over area.
    expect(
      compareRank(member('big-low', { area: 1e6, priority: 'low' }), member('small', { area: 10 })),
    ).toBeLessThan(0);
    // Sub-pixel layout differences do not make one card outrank its neighbour.
    expect(compareRank(member('a', { area: 64000 }), member('b', { area: 64100 }))).toBe(0);
    // lastVisible is irrelevant while visible.
    expect(compareRank(member('a', { lastVisible: 1 }), member('b', { lastVisible: 99 }))).toBe(0);
  });
});

describe('ContextBudget', () => {
  it('grants free slots, then refuses equal ranks (no churn among equals)', () => {
    const b = new ContextBudget<M>(2);
    const [x, y, z] = [member('x'), member('y'), member('z')];
    expect(b.acquire(x)).toEqual({ evicted: null });
    expect(b.acquire(y)).toEqual({ evicted: null });
    expect(b.acquire(x)).toEqual({ evicted: null }); // already a holder
    expect(b.size).toBe(2);
    expect(b.acquire(z)).toBeNull();
    expect(b.holds(z)).toBe(false);
    b.release(x);
    expect(b.acquire(z)).toEqual({ evicted: null });
    expect(b.size).toBe(2);
  });

  it('evicts offscreen first (away before near, least recently visible first), then visible', () => {
    const b = new ContextBudget<M>(4);
    const vis = member('vis', { priority: 'low', area: 10 });
    const nearOld = near('nearOld', 100);
    const nearNew = near('nearNew', 200);
    const awayNew = away('awayNew', 300);
    for (const m of [vis, nearNew, awayNew, nearOld]) b.acquire(m);
    const order: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = b.acquire(member(`req${i}`, { priority: 'high' }));
      order.push(r?.evicted?.name ?? 'none');
    }
    expect(order).toEqual(['awayNew', 'nearOld', 'nearNew', 'vis']);
  });

  it('never takes a slot from a holder that ranks the same or higher', () => {
    const b = new ContextBudget<M>(1);
    const hi = member('hi', { priority: 'high' });
    b.acquire(hi);
    expect(b.acquire(member('n'))).toBeNull();
    expect(b.acquire(near('offscreen', 5, { priority: 'high' }))).toBeNull();
    expect(b.holds(hi)).toBe(true);
  });

  it('an offscreen requester (look-ahead) only takes slots of older or farther offscreen holders', () => {
    const b = new ContextBudget<M>(2);
    const scrolledPast = away('scrolledPast', 50);
    const recent = near('recent', 500);
    b.acquire(scrolledPast);
    b.acquire(recent);
    const ahead = near('ahead', Number.NEGATIVE_INFINITY);
    expect(b.acquire(ahead)?.evicted?.name).toBe('scrolledPast');
    // The one never seen cannot take the slot of the one seen recently (nor of a visible one).
    expect(b.acquire(near('ahead2', Number.NEGATIVE_INFINITY))).toBeNull();
  });

  it('eviction is one-way: the victim cannot take the slot back', () => {
    const b = new ContextBudget<M>(1);
    const small = member('small', { area: 100 });
    const big = member('big', { area: 1e6 });
    b.acquire(small);
    expect(b.acquire(big)?.evicted).toBe(small);
    expect(b.acquire(small)).toBeNull();
    expect(b.victimFor(small)).toBeNull();
  });

  it('by area alone a requester needs a clearly larger size (no swap across a bucket edge)', () => {
    // 2^16.5 is a bucket boundary: these two are 0.2 % apart but in different buckets.
    const edge = 2 ** 16.5;
    const below = member('below', { area: edge * 0.999 });
    const above = member('above', { area: edge * 1.001 });
    expect(compareRank(below, above)).toBeLessThan(0);
    expect(outranks(above, below)).toBe(false);
    const b = new ContextBudget<M>(1);
    b.acquire(below);
    expect(b.acquire(above)).toBeNull();
    // Clearly larger: takes the slot.
    const big = member('big', { area: below.area * AREA_EVICT_RATIO });
    expect(b.acquire(big)?.evicted).toBe(below);
    // Priority and visibility still decide on their own, whatever the areas.
    expect(outranks(member('hi', { priority: 'high', area: 1 }), member('n', { area: 1e6 }))).toBe(
      true,
    );
    expect(outranks(member('vis', { area: 1 }), near('off', 5, { area: 1e6 }))).toBe(true);
  });

  it('flexible members (auto) rank below inflexible ones of the same priority, above lower ones', () => {
    const flex = member('flex', { flexible: true, area: 1e6 });
    const own = member('own', { area: 10 });
    // Flexibility decides before the area.
    expect(compareRank(flex, own)).toBeLessThan(0);
    expect(outranks(own, flex)).toBe(true);
    // Priority decides before flexibility.
    expect(
      compareRank(member('flexHi', { flexible: true, priority: 'high' }), own),
    ).toBeGreaterThan(0);
    // Visibility still comes first.
    expect(compareRank(near('ownNear', 5), flex)).toBeLessThan(0);
  });

  it('a flexible requester never takes the slot of a visible inflexible holder', () => {
    const b = new ContextBudget<M>(1);
    const own = member('own', { priority: 'low', area: 10 });
    b.acquire(own);
    const hero = member('hero', { flexible: true, priority: 'high', area: 1e6 });
    expect(mayEvict(hero, own)).toBe(false);
    expect(outranks(hero, own)).toBe(false);
    expect(b.acquire(hero)).toBeNull();
    // An offscreen inflexible holder gives its slot (it would park anyway).
    const b2 = new ContextBudget<M>(1);
    const off = near('off', 5);
    b2.acquire(off);
    expect(b2.acquire(hero)?.evicted).toBe(off);
    // The victim search skips the holders it may not take: a flexible one is found behind them.
    const b3 = new ContextBudget<M>(2);
    const ownLow = member('ownLow', { priority: 'low', area: 10 });
    const flexNormal = member('flexNormal', { flexible: true });
    b3.acquire(ownLow);
    b3.acquire(flexNormal);
    expect(b3.victimFor(hero)).toBe(flexNormal);
  });

  it('flexible members of the same priority need a clearly larger area; higher priority wins', () => {
    const b = new ContextBudget<M>(1);
    const a = member('a', { flexible: true, area: 1e6 });
    b.acquire(a);
    expect(b.acquire(member('b', { flexible: true, area: 1.2e6 }))).toBeNull();
    expect(b.acquire(member('hi', { flexible: true, priority: 'high', area: 1 }))?.evicted).toBe(a);
  });

  it('lowering the limit evicts flexible holders before inflexible ones of the same rank', () => {
    const b = new ContextBudget<M>(2);
    const own = member('own');
    const flex = member('flex', { flexible: true });
    b.acquire(own);
    b.acquire(flex);
    expect(b.setMax(1).map((m) => m.name)).toEqual(['flex']);
  });

  it('setMax: lowering returns the lowest ranked holders, raising returns nothing', () => {
    const b = new ContextBudget<M>(3);
    const v = member('v');
    const n = near('n', 10);
    const a = away('a', 20);
    for (const m of [v, n, a]) b.acquire(m);
    expect(b.setMax(1).map((m) => m.name)).toEqual(['a', 'n']);
    expect(b.max).toBe(1);
    expect(b.holds(v)).toBe(true);
    expect(b.setMax(4)).toEqual([]);
    expect(b.setMax(Number.NaN)).toEqual([]);
    expect(b.max).toBe(4);
  });
});

// -------------------------------------------------------------------------------------------
// Scheduler (frame-end queue) with a manual requestAnimationFrame.

let rafQueue: FrameRequestCallback[] = [];
let now = 0;
function frame(): void {
  now += 16;
  const q = rafQueue;
  rafQueue = [];
  for (const cb of q) cb(now);
}

type Client = M & {
  order: number;
  granted: Mock<() => void>;
  evicted: Mock<() => void>;
  refused: Mock<() => void>;
  refreshArea: Mock<() => void>;
  settingsChanged: Mock<() => void>;
};

let order = 0;
function client(name: string, p: Partial<M> = {}): Client {
  return {
    ...member(name, p),
    order: ++order,
    granted: vi.fn<() => void>(),
    evicted: vi.fn<() => void>(),
    refused: vi.fn<() => void>(),
    refreshArea: vi.fn<() => void>(),
    settingsChanged: vi.fn<() => void>(),
  };
}

describe('scheduler', () => {
  beforeEach(() => {
    rafQueue = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {
      rafQueue = [];
    });
    resetRuntimeForTesting();
  });

  afterEach(() => {
    resetRuntimeForTesting();
    resetWarmupForTesting();
    vi.unstubAllGlobals();
  });

  it('uses the coarse-pointer default when the page has one', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(pointer: coarse)' }));
    expect(maxContexts()).toBe(2);
    resetRuntimeForTesting();
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    expect(maxContexts()).toBe(4);
  });

  it('serves requests at frame end, best ranked first, createPerFrame per frame', () => {
    configureRuntime({ createPerFrame: 2 });
    const a = client('a', { visible: false, lastVisible: 10 });
    const b = client('b');
    const c = client('c', { priority: 'high' });
    for (const x of [a, b, c]) requestContext(x);
    expect(c.granted).not.toHaveBeenCalled(); // nothing synchronous
    frame();
    expect(c.granted).toHaveBeenCalledTimes(1);
    expect(b.granted).toHaveBeenCalledTimes(1);
    expect(a.granted).not.toHaveBeenCalled();
    expect(a.refused).not.toHaveBeenCalled(); // just capped, not refused
    frame();
    expect(a.granted).toHaveBeenCalledTimes(1);
    expect(contextsInUse()).toBe(3);
    frame();
    expect(rafQueue.length).toBe(0); // idle again: the loop stopped
  });

  it('refuses everyone below the first refusal; a freed slot or a better rank serves them', () => {
    configureRuntime({ maxContexts: 1, createPerFrame: 4 });
    const holder = client('holder');
    requestContext(holder);
    frame();
    const w1 = client('w1');
    const w2 = client('w2', { visible: false, inZone: true });
    requestContext(w1);
    requestContext(w2);
    frame();
    expect(w1.refused).toHaveBeenCalledTimes(1);
    expect(w2.refused).toHaveBeenCalledTimes(1);
    expect(rafQueue.length).toBe(0); // nothing to do until something changes
    // w1 now outranks the holder (high priority): it takes the slot.
    w1.priority = 'high';
    rankChanged();
    frame();
    expect(holder.evicted).toHaveBeenCalledTimes(1);
    expect(w1.granted).toHaveBeenCalledTimes(1);
    // The slot is freed: the next waiter is served.
    releaseContext(w1);
    frame();
    expect(w2.granted).toHaveBeenCalledTimes(1);
  });

  it('a flexible refusal does not end the pass: an inflexible client ranked lower is served', () => {
    configureRuntime({ maxContexts: 1, createPerFrame: 4 });
    const holder = client('holder', { priority: 'low' });
    requestContext(holder);
    frame();
    // The flexible one ranks first (high) but may not take a visible inflexible slot.
    const flex = client('flex', { flexible: true, priority: 'high', area: 1e6 });
    const own = client('own');
    requestContext(flex);
    requestContext(own);
    frame();
    expect(flex.refused).toHaveBeenCalledTimes(1);
    expect(holder.evicted).toHaveBeenCalledTimes(1);
    expect(own.granted).toHaveBeenCalledTimes(1);
    // An inflexible refusal still refuses everyone ranked below it, flexible ones included.
    const own2 = client('own2');
    const flexLow = client('flexLow', { flexible: true, priority: 'low' });
    requestContext(own2);
    requestContext(flexLow);
    frame();
    expect(own2.refused).toHaveBeenCalledTimes(1);
    expect(flexLow.refused).toHaveBeenCalledTimes(1);
    expect(contextsInUse()).toBe(1);
  });

  it('a queued flexible client (standby) takes a slot as soon as one frees up', () => {
    configureRuntime({ maxContexts: 1 });
    const holder = client('holder');
    requestContext(holder);
    frame();
    const standby = client('standby', { flexible: true });
    requestContext(standby);
    frame();
    expect(standby.refused).toHaveBeenCalledTimes(1);
    frame();
    expect(rafQueue.length).toBe(0); // nothing to do until something changes
    releaseContext(holder);
    frame();
    expect(standby.granted).toHaveBeenCalledTimes(1);
  });

  it('configure: renderer and promoteArea are validated', () => {
    expect(runtimeSettings()).toMatchObject({ renderer: 'auto', promoteArea: 0.5 });
    configureRuntime({ renderer: 'shared', promoteArea: 1.5 });
    expect(runtimeSettings()).toMatchObject({ renderer: 'shared', promoteArea: 1.5 });
    configureRuntime({ renderer: 'bogus' as never, promoteArea: -1 });
    configureRuntime({ promoteArea: Number.NaN });
    configureRuntime({ promoteArea: Number.POSITIVE_INFINITY });
    expect(runtimeSettings()).toMatchObject({ renderer: 'shared', promoteArea: 1.5 });
    configureRuntime({ renderer: 'own' });
    expect(runtimeSettings().renderer).toBe('own');
  });

  it('equal ranks are served in creation order, whatever the request order', () => {
    const early = client('early');
    const late = client('late');
    requestContext(late);
    requestContext(early);
    frame();
    expect(early.granted).toHaveBeenCalledTimes(1);
    expect(late.granted).not.toHaveBeenCalled();
  });

  it('evicts before granting, so the budget is never exceeded', () => {
    configureRuntime({ maxContexts: 1 });
    const log: string[] = [];
    const old = client('old', { visible: false, lastVisible: 1 });
    old.granted.mockImplementation(() => log.push('grant old'));
    old.evicted.mockImplementation(() => log.push(`evict old (${contextsInUse()} in use)`));
    const fresh = client('fresh');
    fresh.granted.mockImplementation(() => log.push('grant fresh'));
    requestContext(old);
    frame();
    requestContext(fresh);
    frame();
    expect(log).toEqual(['grant old', 'evict old (1 in use)', 'grant fresh']);
  });

  it('a withdrawn request is never served and the loop stops', () => {
    const a = client('a');
    requestContext(a);
    cancelRequest(a);
    expect(rafQueue.length).toBe(0);
    frame();
    expect(a.granted).not.toHaveBeenCalled();
  });

  it('configure: validates values; lowering maxContexts evicts the lowest ranked at once', () => {
    configureRuntime({ maxContexts: 3, createPerFrame: 3 });
    const v = client('v');
    const n = client('n', { visible: false, lastVisible: 5 });
    const a = client('a', { visible: false, inZone: false, lastVisible: 9 });
    for (const x of [v, n, a]) requestContext(x);
    frame();
    expect(contextsInUse()).toBe(3);
    configureRuntime({ maxContexts: 1 });
    expect(a.evicted).toHaveBeenCalledTimes(1);
    expect(n.evicted).toHaveBeenCalledTimes(1);
    expect(v.evicted).not.toHaveBeenCalled();
    expect(maxContexts()).toBe(1);

    configureRuntime({ parkAfterMs: -1, createPerFrame: 0, maxContexts: Number.NaN });
    expect(runtimeSettings()).toMatchObject({ parkAfterMs: 10_000, createPerFrame: 3 });
    expect(maxContexts()).toBe(1);
    configureRuntime({ parkAfterMs: Number.POSITIVE_INFINITY, createPerFrame: 2.8 });
    expect(runtimeSettings()).toMatchObject({
      parkAfterMs: Number.POSITIVE_INFINITY,
      createPerFrame: 2,
    });
    configureRuntime({ maxContexts: 'auto' });
    expect(maxContexts()).toBe(4);
  });

  it('re-reads the areas of visible competitors right before ranking them, and only then', () => {
    configureRuntime({ maxContexts: 1 });
    const holder = client('holder', { area: 400 * 300 });
    requestContext(holder);
    frame();
    // A free slot: nobody competes, no layout read.
    expect(holder.refreshArea).not.toHaveBeenCalled();
    // The waiter's cached area is stale (the page shrank): the fresh one is equal to the holder's.
    const waiter = client('waiter', { area: 400 * 300 });
    waiter.refreshArea.mockImplementation(() => {
      waiter.area = 200 * 150;
    });
    holder.refreshArea.mockImplementation(() => {
      holder.area = 200 * 150;
    });
    const off = client('off', { visible: false, inZone: true, lastVisible: 1 });
    requestContext(waiter);
    requestContext(off);
    frame();
    expect(waiter.refreshArea).toHaveBeenCalledTimes(1);
    expect(holder.refreshArea).toHaveBeenCalledTimes(1);
    expect(off.refreshArea).not.toHaveBeenCalled(); // offscreen members never compare areas
    expect(holder.evicted).not.toHaveBeenCalled();
    expect(waiter.refused).toHaveBeenCalledTimes(1);
  });

  it('configure({ parkAfterMs }) beyond the longest timer delay means never', () => {
    const a = client('a');
    requestContext(a);
    frame();
    configureRuntime({ parkAfterMs: 0x7fffffff });
    expect(runtimeSettings().parkAfterMs).toBe(0x7fffffff);
    // setTimeout would wrap these around and fire at once.
    for (const v of [0x80000000, 30 * 24 * 3600 * 1000, Number.MAX_SAFE_INTEGER]) {
      configureRuntime({ parkAfterMs: v });
      expect(runtimeSettings().parkAfterMs).toBe(Number.POSITIVE_INFINITY);
    }
    // Infinity -> a huge value is no change: the holders are not bothered again.
    expect(a.settingsChanged).toHaveBeenCalledTimes(2);
  });

  it('configure({ parkAfterMs }) notifies the holders when the value changes', () => {
    const a = client('a');
    const b = client('b');
    requestContext(a);
    frame();
    requestContext(b); // queued, not a holder yet
    configureRuntime({ parkAfterMs: 500 });
    expect(a.settingsChanged).toHaveBeenCalledTimes(1);
    expect(b.settingsChanged).not.toHaveBeenCalled();
    configureRuntime({ parkAfterMs: 500 }); // unchanged
    configureRuntime({ createPerFrame: 2 });
    expect(a.settingsChanged).toHaveBeenCalledTimes(1);
  });
  it('creates no context while a warm-up compiles, and refuses nobody for it', () => {
    let done = false;
    const warm: FenceGL = {
      SYNC_STATUS: 1,
      SIGNALED: 2,
      getSyncParameter: () => (done ? 2 : 3),
      deleteSync: () => {},
      isContextLost: () => false,
    };
    trackWarmup(warm, {} as WebGLSync, () => {});
    const a = client('a');
    requestContext(a);
    frame();
    expect(a.granted).not.toHaveBeenCalled();
    expect(a.refused).not.toHaveBeenCalled();
    done = true;
    frame();
    expect(a.granted).toHaveBeenCalledTimes(1);
  });

  it('paces the first creation; the shared device does not take the turn of own engines', () => {
    const fences: WebGLSync[] = [];
    let signaled = false;
    const pacer: PacerGL = {
      SYNC_STATUS: 1,
      SIGNALED: 2,
      SYNC_GPU_COMMANDS_COMPLETE: 3,
      fenceSync: () => {
        const f = {} as WebGLSync;
        fences.push(f);
        return f;
      },
      flush: () => {},
      getSyncParameter: () => (signaled ? 2 : 4),
      deleteSync: () => {},
      isContextLost: () => false,
    };
    adoptPacer(pacer, () => {});
    const a = client('a');
    requestContext(a);
    // The shared renderer asks before the frame end: it leaves the pacer to the own request.
    expect(claimContextCreation(now + 16)).toBe(false);
    expect(fences).toHaveLength(0);
    frame();
    expect(fences).toHaveLength(1);
    expect(a.granted).not.toHaveBeenCalled();
    signaled = true;
    expect(claimContextCreation(now + 16)).toBe(false);
    frame();
    // Created first, as on a page that needs no pacing; the shared device gets the next frame.
    expect(a.granted).toHaveBeenCalledTimes(1);
    expect(claimContextCreation(now)).toBe(false);
    expect(claimContextCreation(now + 16)).toBe(true);
    // Without own requests waiting, the shared renderer paces the page by itself.
    resetWarmupForTesting();
    signaled = false;
    adoptPacer(pacer, () => {});
    expect(claimContextCreation(now + 32)).toBe(false);
    expect(fences).toHaveLength(2);
    signaled = true;
    expect(claimContextCreation(now + 48)).toBe(true);
  });
});
