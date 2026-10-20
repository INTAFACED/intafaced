import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMatchingClient, MATCHING_FETCH_MS, MatchingUnavailableError } from './matching-client.js';
import { createMatchingClient as createMatchingClientWithClose } from './matching-close.js';

const SECRET = 'matching-client-timeout-test-secret-32-chars';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** An engine that never answers: the promise ends only when the caller's signal aborts it, as a real fetch does. */
function hangingEngine() {
  const signals: Array<AbortSignal | null | undefined> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          signals.push(init?.signal);
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')));
        }),
    ),
  );
  return signals;
}

const calls: Array<[string, (c: ReturnType<typeof createMatchingClientWithClose>) => Promise<unknown>]> = [
  ['submit', (c) => c.submit('m-1', { orderId: 'o-1' } as never)],
  ['cancel', (c) => c.cancel('m-1', 'o-1')],
  ['massCancel', (c) => c.massCancel('m-1', { accountId: 'u-1' } as never)],
  ['amend', (c) => c.amend('m-1', 'o-1', { qty: '1' } as never)],
  ['depth', (c) => c.depth('m-1', 10)],
  ['listOrders', (c) => c.listOrders('m-1')],
  ['listMarkets', (c) => c.listMarkets()],
  ['reconcile', (c) => c.reconcile([])],
  ['markTrailingStops', (c) => c.markTrailingStops('m-1', '100')],
  ['closePosition', (c) => c.closePosition('m-1', { accountId: 'u-1' } as never)],
];

describe('svc-trade -> svc-matching: a hung engine ends as unreachable', () => {
  it.each(calls)(
    '%s gives up and throws MatchingUnavailableError',
    async (_name, call) => {
      hangingEngine();
      const client = createMatchingClientWithClose('http://matching.test', SECRET, undefined, { timeoutMs: 25 });
      await expect(call(client)).rejects.toBeInstanceOf(MatchingUnavailableError);
    },
    3_000,
  );

  it('every call carries a signal, and the default bound is finite', async () => {
    const signals = hangingEngine();
    const client = createMatchingClient('http://matching.test', SECRET);
    const pending = calls.slice(0, 8).map(([, call]) => call(client as never).catch(() => undefined));
    await new Promise((r) => setTimeout(r, 10));
    expect(signals).toHaveLength(8);
    expect(signals.every((s) => s instanceof AbortSignal && !s.aborted)).toBe(true);
    expect(Number.isFinite(MATCHING_FETCH_MS) && MATCHING_FETCH_MS > 0).toBe(true);
    void pending;
  });
});
