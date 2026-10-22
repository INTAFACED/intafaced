import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../shared/api';
import { settleFailure } from './alerts-model';
import { submitCreate } from './alerts-actions';
import { isCrossing, isIntent, type AlertIntent } from './notify-api';

const USER = 'user-1';
const ID = '11111111-1111-4111-8111-111111111111';
const repeating: AlertIntent = {
  marketId: 'market-btc',
  direction: 'above',
  condition: 'crossing',
  targetPrice: '65000.50',
  frequency: 'every_crossing',
};
const row = (patch: Record<string, unknown> = {}) => ({
  id: ID,
  userId: USER,
  marketId: 'market-btc',
  kind: 'price',
  direction: 'above',
  condition: 'crossing',
  targetPrice: '65000.50',
  status: 'active',
  firedAt: null,
  createdAt: '2026-10-17T08:00:00.000Z',
  frequency: 'every_crossing',
  fireCount: 0,
  lastFiredAt: null,
  ...patch,
});
const dark = { markSource: 'dark', canFire: false, code: 'alert.price_unavailable' };
const trpc = (data: unknown, status = 200) => new Response(JSON.stringify({ result: { data } }), { status });
const trpcError = (status: number, message: string, code: string) =>
  new Response(JSON.stringify({ error: { message, code: -32600, data: { code } } }), { status });
const client = (fetch: typeof globalThis.fetch) => createApiClient({ fetch, token: () => 'tok' });

describe('a repeating alert', () => {
  it('sends the frequency only when it repeats, and believes the answer only if it repeats too', async () => {
    const fetch = vi.fn(async () => trpc({ alert: row(), evaluation: dark }));
    const outcome = await submitCreate(client(fetch), repeating, USER);
    expect(outcome.kind).toBe('saved');
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ condition: 'crossing', frequency: 'every_crossing' });

    const once = vi.fn(async () => trpc({ alert: row(), evaluation: dark }));
    await submitCreate(client(once), { ...repeating, frequency: undefined }, USER);
    const [, onceInit] = once.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(onceInit.body))).not.toHaveProperty('frequency');
  });
  it('does not accept a one-shot alert as the answer to a repeating one, or the other way round', async () => {
    const wrong = await submitCreate(
      client(vi.fn(async () => trpc({ alert: row({ frequency: 'once' }), evaluation: dark }))),
      repeating,
      USER,
    );
    expect(wrong.kind).toBe('unknown');
    const wrongWay = await submitCreate(
      client(vi.fn(async () => trpc({ alert: row({ frequency: 'every_crossing' }), evaluation: dark }))),
      { ...repeating, frequency: undefined },
      USER,
    );
    expect(wrongWay.kind).toBe('unknown');
  });
  it('reads a service that sends no frequency as once', () => {
    const stored = {
      kind: 'price' as const,
      marketId: 'market-btc',
      direction: 'above' as const,
      targetPrice: '1',
      condition: 'crossing' as const,
    };
    expect(isIntent(stored, { marketId: 'market-btc', direction: 'above', condition: 'crossing', targetPrice: '1' })).toBe(true);
    expect(
      isIntent(stored, {
        marketId: 'market-btc',
        direction: 'above',
        condition: 'crossing',
        targetPrice: '1',
        frequency: 'every_crossing',
      }),
    ).toBe(false);
  });
  it('names the two refusals, ahead of the generic bad request', async () => {
    const off = await submitCreate(
      client(
        vi.fn(async () => trpcError(412, 'notify.alert_frequency_unset: a repeating alert needs the owner list', 'PRECONDITION_FAILED')),
      ),
      repeating,
      USER,
    );
    expect(off).toEqual({ kind: 'refused', refusal: 'repeatOff' });
    const wrongKind = await submitCreate(
      client(vi.fn(async () => trpcError(400, 'alert.frequency_needs_crossing: only a crossing alert can repeat', 'BAD_REQUEST'))),
      repeating,
      USER,
    );
    expect(wrongKind).toEqual({ kind: 'refused', refusal: 'repeatRejected' });
    expect(
      settleFailure({
        ok: false,
        reason: 'bad_request',
        status: 400,
        code: 'BAD_REQUEST',
        message: 'alert.frequency_not_allowed: x',
      } as never),
    ).toEqual({
      kind: 'refused',
      refusal: 'repeatRejected',
    });
  });
  it('only a crossing can repeat', () => {
    expect(['crossing', 'crossing_up', 'crossing_down'].every((c) => isCrossing(c as never))).toBe(true);
    expect(isCrossing('greater_than')).toBe(false);
    expect(isCrossing('less_than')).toBe(false);
  });
});
