import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../shared/api';
import { submitWatchlist } from './alerts-actions';
import type { PriceAlert, WatchlistIntent } from './notify-api';

const USER = 'user-1';
const trpc = (data: unknown, status = 200) => new Response(JSON.stringify({ result: { data } }), { status });
const trpcError = (status: number, message: string, code: string) =>
  new Response(JSON.stringify({ error: { message, code: -32600, data: { code } } }), { status });
const client = (fetch: typeof globalThis.fetch) => createApiClient({ fetch, token: () => 'tok' });
const intent: WatchlistIntent = { marketIds: ['m1', 'm2'], direction: 'above', condition: 'greater_than', targetPrice: '100' };
const row = (marketId: string, patch: Partial<PriceAlert> = {}): PriceAlert => ({
  id: marketId === 'm1' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222',
  userId: USER,
  marketId,
  kind: 'price',
  direction: 'above',
  targetPrice: '100',
  status: 'active',
  firedAt: null,
  createdAt: '2026-10-20T12:00:00.000Z',
  condition: 'greater_than',
  ...patch,
});
const dark = { markSource: 'dark', canFire: false, code: 'alert.price_unavailable' };

describe('list alert', () => {
  it('sends every market with one rule, price as text, once', async () => {
    const fetch = vi.fn(async () => trpc({ alerts: [row('m1'), row('m2')], evaluation: dark }));
    const outcome = await submitWatchlist(client(fetch), intent, USER);
    expect(outcome).toMatchObject({ kind: 'saved' });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/notify/trpc/notify.createAlerts');
    expect(JSON.parse(String(init.body))).toEqual({
      marketIds: ['m1', 'm2'],
      direction: 'above',
      condition: 'greater_than',
      targetPrice: '100',
    });
  });
  it('accepts the same price spelled differently, and the markets in any order', async () => {
    const fetch = async () => trpc({ alerts: [row('m2', { targetPrice: '100.0' }), row('m1')], evaluation: dark });
    expect((await submitWatchlist(client(fetch), intent, USER)).kind).toBe('saved');
  });
  it('does not believe an answer for other markets, another price, another person, or a fired alert', async () => {
    const bad: PriceAlert[][] = [
      [row('m1')],
      [row('m1'), row('m3')],
      [row('m1'), row('m2', { targetPrice: '101' })],
      [row('m1'), row('m2', { userId: 'someone-else' })],
      [row('m1'), row('m2', { status: 'fired', firedAt: '2026-10-20T12:01:00.000Z' })],
      [row('m1'), row('m2', { condition: 'less_than' })],
    ];
    for (const alerts of bad) {
      const outcome = await submitWatchlist(
        client(async () => trpc({ alerts, evaluation: dark })),
        intent,
        USER,
      );
      expect(outcome.kind, JSON.stringify(alerts.map((a) => a.marketId))).toBe('unknown');
    }
  });
  it('names a batch refused for the cap, and one with the cap not set, and reports a dropped connection as unknown', async () => {
    const send = (response: Response) =>
      submitWatchlist(
        client(async () => response),
        intent,
        USER,
      );
    expect(
      await send(
        trpcError(412, 'alert.quota_reached: a person may hold 3 open price alerts; 2 are open and 2 more', 'PRECONDITION_FAILED'),
      ),
    ).toEqual({
      kind: 'refused',
      refusal: 'quotaReached',
    });
    expect(await send(trpcError(412, 'notify.alert_quota_unset: not set', 'PRECONDITION_FAILED'))).toEqual({
      kind: 'refused',
      refusal: 'quotaOff',
    });
    const down = async () => {
      throw new TypeError('network down');
    };
    expect((await submitWatchlist(client(down), intent, USER)).kind).toBe('unknown');
  });
});
