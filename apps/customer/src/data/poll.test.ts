import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyFailure, createPoller, RequestBudget, type Fetcher, type Outcome, type VisibilitySource } from './poll';
import { blockingState, combine, switchMap, type Source } from './source';
import type { Loadable } from './types';

function visibility(): VisibilitySource & { set(visible: boolean): void } {
  let visible = true;
  const listeners = new Set<() => void>();
  return {
    isVisible: () => visible,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      visible = next;
      listeners.forEach((l) => l());
    },
  };
}

function counter<T>(make: (n: number) => Outcome<T>) {
  const fn = vi.fn(async () => make(fn.mock.calls.length));
  return fn as unknown as Fetcher<T> & { mock: { calls: unknown[] } };
}

const ok = <T>(data: T): Outcome<T> => ({ ok: true, data });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
});
afterEach(() => vi.useRealTimers());

describe('poller: dedupe and cadence', () => {
  it('shares one request between components asking for the same key', async () => {
    const poller = createPoller({ visibility: visibility() });
    const fetcher = counter((n) => ok(n));
    const a = poller.source('tickers', fetcher, { intervalMs: 10_000 });
    const b = poller.source('tickers', fetcher, { intervalMs: 10_000 });
    const seenA = vi.fn();
    const seenB = vi.fn();
    const stopA = a.subscribe(seenA);
    const stopB = b.subscribe(seenB);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher.mock.calls.length).toBe(1);
    expect(a.getSnapshot()).toMatchObject({ status: 'ready', data: 1 });
    expect(b.getSnapshot()).toBe(a.getSnapshot());
    expect(seenA).toHaveBeenCalled();
    expect(seenB).toHaveBeenCalled();
    stopA();
    stopB();
    poller.dispose();
  });

  it('shows loading before the first answer, and a late subscriber gets the cached answer without a request', async () => {
    const poller = createPoller({ visibility: visibility() });
    const fetcher = counter((n) => ok(n));
    const first = poller.source('k', fetcher, { intervalMs: 10_000 });
    expect(first.getSnapshot()).toEqual({ status: 'loading' });
    const stop = first.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(2_000);
    const stopLate = poller.source('k', fetcher, { intervalMs: 10_000 }).subscribe(() => undefined);
    expect(fetcher.mock.calls.length).toBe(1);
    stop();
    stopLate();
    poller.dispose();
  });

  it('polls on the interval, and the fastest subscriber sets the pace', async () => {
    const poller = createPoller({ visibility: visibility() });
    const fetcher = counter((n) => ok(n));
    const slow = poller.source('k', fetcher, { intervalMs: 30_000 }).subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher.mock.calls.length).toBe(1);
    const fast = poller.source('k', fetcher, { intervalMs: 5_000 }).subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10_000);
    // 5 s interval plus up to 20 % phase offset: one or two more calls in 10 s (the 30 s subscriber alone would give none).
    expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(3);
    fast();
    slow();
    poller.dispose();
  });

  it('stops polling when the last subscriber leaves', async () => {
    const poller = createPoller({ visibility: visibility() });
    const fetcher = counter((n) => ok(n));
    const stop = poller.source('k', fetcher, { intervalMs: 5_000 }).subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(1);
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher.mock.calls.length).toBe(1);
    poller.dispose();
  });

  it('uses the newest fetcher, so a refreshed session token is picked up', async () => {
    const poller = createPoller({ visibility: visibility() });
    const oldClient = counter(() => ok('old'));
    const newClient = counter(() => ok('new'));
    const stop = poller.source('balance:u1', oldClient, { intervalMs: 10_000 }).subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(1);
    poller.source('balance:u1', newClient, { intervalMs: 10_000 });
    await vi.advanceTimersByTimeAsync(13_000);
    expect(newClient.mock.calls.length).toBe(1);
    stop();
    poller.dispose();
  });
});

describe('poller: visibility', () => {
  it('pauses while hidden and catches up once when shown', async () => {
    const vis = visibility();
    const poller = createPoller({ visibility: vis });
    const fetcher = counter((n) => ok(n));
    const stop = poller.source('k', fetcher, { intervalMs: 10_000 }).subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher.mock.calls.length).toBe(1);
    vis.set(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetcher.mock.calls.length).toBe(1);
    vis.set(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher.mock.calls.length).toBe(2);
    stop();
    poller.dispose();
  });

  it('does not fetch at all when subscribed in a hidden tab until shown', async () => {
    const vis = visibility();
    vis.set(false);
    const poller = createPoller({ visibility: vis });
    const fetcher = counter((n) => ok(n));
    const stop = poller.source('k', fetcher, { intervalMs: 10_000 }).subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher.mock.calls.length).toBe(0);
    vis.set(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher.mock.calls.length).toBe(1);
    stop();
    poller.dispose();
  });
});

describe('poller: request budget', () => {
  it('never starts more than the limit in any rolling minute, and the counter says so', async () => {
    const poller = createPoller({ visibility: visibility(), budgetPerMinute: 120 });
    const stops: Array<() => void> = [];
    let started = 0;
    for (let i = 0; i < 80; i += 1) {
      // 80 distinct keys, each wanting a request every 2 s = 2400 per minute.
      const fetcher: Fetcher<number> = async () => {
        started += 1;
        return ok(i);
      };
      stops.push(poller.source(`k${i}`, fetcher, { intervalMs: 2_000 }).subscribe(() => undefined));
    }
    for (let second = 0; second < 180; second += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(poller.stats().requestsLastMinute).toBeLessThanOrEqual(120);
    }
    const stats = poller.stats();
    expect(stats.peakPerMinute).toBeLessThanOrEqual(120);
    expect(stats.deferred).toBeGreaterThan(0);
    expect(stats.totalRequests).toBe(started);
    // The budget is spent, not wasted: close to 120 per minute over 3 minutes.
    expect(stats.totalRequests).toBeGreaterThan(300);
    expect(stats.totalRequests).toBeLessThanOrEqual(3 * 120 + 120);
    stops.forEach((s) => s());
    poller.dispose();
  });

  it('the Desk screen plan from the spec fits the budget (<= 95 per minute)', async () => {
    const poller = createPoller({ visibility: visibility(), budgetPerMinute: 120 });
    const plan: Array<[string, number]> = [
      ['book', 2_000],
      ['trades', 3_000],
      ['ticker', 3_000],
      ['candle', 10_000],
      ['orders', 10_000],
      ['balances', 15_000],
      ['panel', 10_000],
    ];
    const stops = plan.map(([key, ms]) =>
      poller
        .source(
          key,
          counter((n) => ok(n)),
          { intervalMs: ms },
        )
        .subscribe(() => undefined),
    );
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const perMinute = poller.stats().totalRequests / 5;
    expect(perMinute).toBeLessThanOrEqual(95);
    expect(poller.stats().peakPerMinute).toBeLessThanOrEqual(120);
    expect(poller.stats().deferred).toBe(0);
    stops.forEach((s) => s());
    poller.dispose();
  });

  it('the Home plan fits too (<= 30 per minute)', async () => {
    const poller = createPoller({ visibility: visibility() });
    const keys: Array<[string, number]> = [
      ['tickers', 10_000],
      ['balance', 30_000],
      ...['BTC', 'ETH', 'IFC', 'X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7'].map((s): [string, number] => [`ohlcv:${s}`, 60_000]),
    ];
    const stops = keys.map(([key, ms]) =>
      poller
        .source(
          key,
          counter((n) => ok(n)),
          { intervalMs: ms },
        )
        .subscribe(() => undefined),
    );
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(poller.stats().totalRequests / 5).toBeLessThanOrEqual(30);
    stops.forEach((s) => s());
    poller.dispose();
  });

  it('counts requests made outside the scheduler', () => {
    const poller = createPoller({ visibility: visibility() });
    poller.recordExternalRequest(3);
    expect(poller.stats().requestsLastMinute).toBe(3);
    poller.dispose();
  });

  it('the rolling window forgets old requests', () => {
    const budget = new RequestBudget(2);
    expect(budget.tryAcquire(0)).toBe(0);
    expect(budget.tryAcquire(10)).toBe(0);
    expect(budget.tryAcquire(20)).toBeGreaterThan(0);
    expect(budget.count(20)).toBe(2);
    expect(budget.tryAcquire(60_001)).toBe(0);
  });
});

describe('poller: failures', () => {
  it('maps a typed 4xx to a refusal and a 5xx to an error with retry', async () => {
    expect(classifyFailure({ reason: 'forbidden', status: 403, code: 'denied.screening_fixture' })).toEqual({
      kind: 'refused',
      code: 'denied.screening_fixture',
    });
    expect(classifyFailure({ reason: 'error', status: 400 })).toEqual({ kind: 'refused', code: 'unknown' });
    expect(classifyFailure({ reason: 'unauthorized', status: 401 })).toEqual({ kind: 'refused', code: 'auth.required' });
    expect(classifyFailure({ reason: 'error', status: 429, code: 'edge.rate_limited' }).kind).toBe('error');
    expect(classifyFailure({ reason: 'unreachable', status: 502 }).kind).toBe('error');
    expect(classifyFailure({ reason: 'unreachable' }).kind).toBe('error');
  });

  it('surfaces a refusal as soon as it arrives', async () => {
    const poller = createPoller({ visibility: visibility() });
    const fetcher: Fetcher<number> = async () => ({ ok: false, reason: 'forbidden', status: 403, code: 'trade.no_book' });
    const fetch = vi.fn(fetcher);
    const source = poller.source('k', fetch, { intervalMs: 300_000 });
    const stop = source.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(1);
    expect(source.getSnapshot()).toEqual({ status: 'refused', code: 'trade.no_book' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(1); // a refusal is the answer: never retried early
    stop();
    poller.dispose();
  });

  it('shows an error with a working retry when there was never good data', async () => {
    const poller = createPoller({ visibility: visibility() });
    let fail = true;
    const fetcher: Fetcher<number> = vi.fn(async (): Promise<Outcome<number>> =>
      fail ? { ok: false, reason: 'unreachable', status: 502 } : ok(7),
    );
    const source = poller.source('k', fetcher, { intervalMs: 10_000 });
    const stop = source.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(1);
    const snap = source.getSnapshot();
    expect(snap.status).toBe('error');
    fail = false;
    if (snap.status === 'error') snap.retry();
    await vi.advanceTimersByTimeAsync(1);
    expect(source.getSnapshot()).toMatchObject({ status: 'ready', data: 7 });
    stop();
    poller.dispose();
  });

  it('retries a failed first read soon, not a whole slow interval later, and backs off from there', async () => {
    const poller = createPoller({ visibility: visibility() });
    let fails = 3;
    const fetcher: Fetcher<number> = vi.fn(async (): Promise<Outcome<number>> =>
      fails-- > 0 ? { ok: false, reason: 'unreachable', status: 502 } : ok(9),
    );
    const calls = () => vi.mocked(fetcher).mock.calls.length;
    const source = poller.source('markets', fetcher, { intervalMs: 300_000 });
    const stop = source.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(1);
    expect(source.getSnapshot().status).toBe('error');
    expect(calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_998);
    expect(calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls()).toBe(2); // 2 s after the first read
    await vi.advanceTimersByTimeAsync(3_999);
    expect(calls()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls()).toBe(3); // then 4 s
    await vi.advanceTimersByTimeAsync(8_000);
    expect(source.getSnapshot()).toMatchObject({ status: 'ready', data: 9 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls()).toBe(4); // once answered, back to the source's own interval
    stop();
    poller.dispose();
  });

  it('a rate limit (429) is never retried early: it waits the whole backoff', async () => {
    const poller = createPoller({ visibility: visibility() });
    const fetcher: Fetcher<number> = vi.fn(async (): Promise<Outcome<number>> => ({
      ok: false,
      reason: 'error',
      status: 429,
      code: 'edge.rate_limited',
    }));
    const source = poller.source('markets', fetcher, { intervalMs: 300_000 });
    const stop = source.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(599_999);
    expect(source.getSnapshot().status).toBe('error');
    expect(vi.mocked(fetcher).mock.calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.mocked(fetcher).mock.calls.length).toBe(2);
    stop();
    poller.dispose();
  });

  it('stops retrying early after three tries, then backs off as before', async () => {
    const poller = createPoller({ visibility: visibility() });
    const fetcher: Fetcher<number> = vi.fn(async (): Promise<Outcome<number>> => ({ ok: false, reason: 'unreachable', status: 503 }));
    const source = poller.source('parked', fetcher, { intervalMs: 60_000 });
    const stop = source.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(14_000); // reads at 0, 2, 6 and 14 s
    expect(vi.mocked(fetcher).mock.calls.length).toBe(4);
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    expect(vi.mocked(fetcher).mock.calls.length).toBe(5); // the fourth failure waits 8 intervals
    stop();
    poller.dispose();
  });

  it('a screen that went from stale to an error is retried early too', async () => {
    const poller = createPoller({ visibility: visibility(), minStaleMs: 30_000, staleIntervals: 3 });
    let good = true;
    const fetcher: Fetcher<number> = vi.fn(async (): Promise<Outcome<number>> =>
      good ? ok(5) : { ok: false, reason: 'unreachable', status: 502 },
    );
    const source = poller.source('markets', fetcher, { intervalMs: 300_000 });
    const stop = source.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(1);
    good = false;
    await vi.advanceTimersByTimeAsync(960_000); // fails at about 300 and 900 s: past the 900 s stale limit
    expect(source.getSnapshot().status).toBe('error');
    good = true;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(source.getSnapshot()).toMatchObject({ status: 'ready', data: 5 });
    stop();
    poller.dispose();
  });

  it('keeps the last good answer through a blip, then gives up honestly, and backs off', async () => {
    const poller = createPoller({ visibility: visibility(), minStaleMs: 30_000, staleIntervals: 3 });
    let good = true;
    const fetcher: Fetcher<number> = vi.fn(async (): Promise<Outcome<number>> =>
      good ? ok(5) : { ok: false, reason: 'unreachable', status: 502 },
    );
    const source = poller.source('k', fetcher, { intervalMs: 10_000 });
    const stop = source.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(1);
    expect(source.getSnapshot().status).toBe('ready');
    good = false;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(source.getSnapshot().status).toBe('ready'); // one dropped request is not an error
    await vi.advanceTimersByTimeAsync(120_000);
    expect(source.getSnapshot().status).toBe('error'); // stale for too long
    const calls = (fetcher as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    expect(calls).toBeLessThan(1 + 132_000 / 10_000); // backed off: fewer than one per interval
    stop();
    poller.dispose();
  });
});

describe('sources: combine and switchMap', () => {
  const fixed = <T>(snap: Loadable<T>): Source<T> => ({ subscribe: () => () => undefined, getSnapshot: () => snap });

  it('combine keeps its identity until an input changes', () => {
    const a = fixed<number>({ status: 'ready', data: 1, asOf: 1 });
    const b = fixed<number>({ status: 'ready', data: 2, asOf: 1 });
    const project = vi.fn(
      ([x, y]: [Loadable<number>, Loadable<number>]) => ({ status: 'ready', data: [x, y], asOf: 1 }) as Loadable<unknown>,
    );
    const both = combine([a, b] as const, project as never);
    const first = both.getSnapshot();
    expect(both.getSnapshot()).toBe(first);
    expect(project).toHaveBeenCalledTimes(1);
  });

  it('blockingState picks refusal over error over loading over empty', () => {
    const retry = vi.fn();
    expect(blockingState([{ status: 'loading' }, { status: 'refused', code: 'x' }])).toEqual({ status: 'refused', code: 'x' });
    expect(blockingState([{ status: 'loading' }, { status: 'error', retry }])?.status).toBe('error');
    expect(blockingState([{ status: 'empty' }, { status: 'loading' }])).toEqual({ status: 'loading' });
    expect(blockingState([{ status: 'empty' }])).toEqual({ status: 'empty' });
    expect(blockingState([{ status: 'ready', data: 1, asOf: 1 }])).toBeNull();
  });

  it('switchMap follows the outer source and rebuilds the inner one only when the key changes', async () => {
    const poller = createPoller({ visibility: visibility() });
    let list = ['BTC', 'ETH'];
    const outer = poller.source('list', async () => ok(list), { intervalMs: 10_000 });
    const built: string[] = [];
    const joined = switchMap(
      outer,
      (symbols) => symbols.join(','),
      (symbols) => {
        built.push(symbols.join(','));
        return poller.source(`inner:${symbols.join(',')}`, async () => ok(symbols.length), { intervalMs: 60_000 });
      },
    );
    expect(joined.getSnapshot()).toEqual({ status: 'loading' });
    const listener = vi.fn();
    const stop = joined.subscribe(listener);
    await vi.advanceTimersByTimeAsync(5);
    expect(joined.getSnapshot()).toMatchObject({ status: 'ready', data: 2 });
    await vi.advanceTimersByTimeAsync(12_000); // outer polls again, same list
    expect(built).toEqual(['BTC,ETH']);
    list = ['BTC', 'ETH', 'IFC'];
    await vi.advanceTimersByTimeAsync(12_000);
    await vi.advanceTimersByTimeAsync(5);
    expect(built).toEqual(['BTC,ETH', 'BTC,ETH,IFC']);
    expect(joined.getSnapshot()).toMatchObject({ status: 'ready', data: 3 });
    stop();
    poller.dispose();
  });
});

describe('poller: refresh after a save', () => {
  it('drops a read already in flight, so an answer from before the save never overwrites the newer one', async () => {
    const poller = createPoller({ visibility: visibility() });
    const pending: Array<(value: Outcome<string>) => void> = [];
    const fetcher = vi.fn(
      (signal: AbortSignal) =>
        new Promise<Outcome<string>>((resolve, reject) => {
          pending.push(resolve);
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    ) as unknown as Fetcher<string>;
    const source = poller.source('book', fetcher, { intervalMs: 60_000 });
    const stop = source.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(1);
    expect(pending).toHaveLength(1); // the read that started before the save
    poller.refresh('book'); // the save finished
    await vi.advanceTimersByTimeAsync(1);
    expect(pending).toHaveLength(2);
    pending[1]!(ok('after the save'));
    await vi.advanceTimersByTimeAsync(1);
    pending[0]!(ok('before the save'));
    await vi.advanceTimersByTimeAsync(1);
    expect(source.getSnapshot()).toMatchObject({ status: 'ready', data: 'after the save' });
    stop();
    poller.dispose();
  });
});
