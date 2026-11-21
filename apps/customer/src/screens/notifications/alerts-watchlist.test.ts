import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../shared/api';
import { submitWatchlist } from './alerts-actions';
import { createWatchRule, stopWatchRule, type FollowIntent, type PriceAlert, type WatchlistIntent } from './notify-api';

const USER = 'user-1';
const trpc = (data: unknown, status = 200) => new Response(JSON.stringify({ result: { data } }), { status });
const trpcError = (status: number, message: string, code: string) =>
  new Response(JSON.stringify({ error: { message, code: -32600, data: { code } } }), { status });
const client = (fetch: typeof globalThis.fetch) => createApiClient({ fetch, token: () => 'tok' });
const intent: WatchlistIntent = { marketIds: ['m1', 'm2'], direction: 'above', condition: 'greater_than', targetPrice: '100' };
// The fields svc-notify sends on every alert (`priceAlertOutput`), at what a plain one-shot alert holds; a test's own
// fields override them.
const SENT = {
  condition: 'crossing',
  name: null,
  message: null,
  expiresAt: null,
  updatedAt: '2026-10-17T08:00:00.000Z',
  extras: [],
  frequency: 'once',
  source: 'mark',
  fireCount: 0,
  stopReason: null,
  lastFiredAt: null,
  channels: null,
  webhookUrl: null,
} satisfies Partial<PriceAlert>;
const row = (marketId: string, patch: Partial<PriceAlert> = {}): PriceAlert => ({
  ...SENT,
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

describe('follow a list', () => {
  const RULE_ID = '33333333-3333-4333-8333-333333333333';
  const follow: FollowIntent = { listId: 'list-1', condition: 'greater_than', targetPrice: '100' };
  const rule = (patch: Record<string, unknown> = {}) => ({
    id: RULE_ID,
    listId: 'list-1',
    listName: 'Majors',
    condition: 'greater_than',
    targetPrice: '100',
    status: 'active',
    markets: ['m1', 'm2'],
    createdAt: '2026-10-20T12:00:00.000Z',
    lastSyncAt: null,
    lastSyncCode: null,
    ...patch,
  });
  const reply = (data: unknown) => client(async () => trpc(data));

  it('believes the rule and one alert per market it covers', async () => {
    const result = await createWatchRule(reply({ rule: rule(), alerts: [row('m2'), row('m1')] }), follow, USER);
    expect(result.ok).toBe(true);
  });

  it('does not believe a rule or alerts that are not what was asked for, or another person alert', async () => {
    for (const [label, data] of [
      ['another list', { rule: rule({ listId: 'list-2' }), alerts: [row('m1'), row('m2')] }],
      ['another condition', { rule: rule({ condition: 'less_than' }), alerts: [row('m1'), row('m2')] }],
      ['another price', { rule: rule({ targetPrice: '101' }), alerts: [row('m1'), row('m2')] }],
      ['another person', { rule: rule(), alerts: [row('m1', { userId: 'someone-else' }), row('m2')] }],
      ['a stopped alert', { rule: rule(), alerts: [row('m1', { status: 'stopped' }), row('m2')] }],
      ['an alert at another price', { rule: rule(), alerts: [row('m1', { targetPrice: '99' }), row('m2')] }],
      ['a market missing', { rule: rule(), alerts: [row('m1')] }],
    ] as const) {
      const result = await createWatchRule(reply(data), follow, USER);
      expect(result.ok, label).toBe(false);
    }
  });

  it('believes a stop only for this rule, stopped, or for none', async () => {
    expect((await stopWatchRule(reply({ rule: rule({ status: 'stopped' }) }), RULE_ID)).ok).toBe(true);
    expect((await stopWatchRule(reply({ rule: null }), RULE_ID)).ok).toBe(true);
    expect((await stopWatchRule(reply({ rule: rule() }), RULE_ID)).ok).toBe(false);
    expect(
      (await stopWatchRule(reply({ rule: rule({ id: '44444444-4444-4444-8444-444444444444', status: 'stopped' }) }), RULE_ID)).ok,
    ).toBe(false);
  });
});
