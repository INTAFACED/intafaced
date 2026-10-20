import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../shared/api';
import { submitCancel, submitCreate } from './alerts-actions';
import { listAlerts, type AlertIntent } from './notify-api';

const USER = 'user-1';
const ID = '11111111-1111-4111-8111-111111111111';
const intent: AlertIntent = { marketId: 'market-btc', direction: 'above', targetPrice: '65000.50' };
const row = (patch: Record<string, unknown> = {}) => ({
  id: ID,
  userId: USER,
  marketId: 'market-btc',
  kind: 'price',
  direction: 'above',
  targetPrice: '65000.50',
  status: 'active',
  firedAt: null,
  createdAt: '2026-10-17T08:00:00.000Z',
  ...patch,
});
const dark = { markSource: 'dark', canFire: false, code: 'alert.price_unavailable' };
const trpc = (data: unknown, status = 200) => new Response(JSON.stringify({ result: { data } }), { status });
const trpcError = (status: number, message: string, code: string, cause?: string) =>
  new Response(JSON.stringify({ error: { message, code: -32600, data: { code, ...(cause ? { cause: { code: cause } } : {}) } } }), {
    status,
  });
const client = (fetch: typeof globalThis.fetch) => createApiClient({ fetch, token: () => 'tok' });

describe('save an alert', () => {
  it('sends exactly what was reviewed, price as a string, once', async () => {
    const fetch = vi.fn(async () => trpc({ alert: row(), evaluation: dark }));
    const outcome = await submitCreate(client(fetch), intent, USER);
    expect(outcome).toEqual({ kind: 'saved', alert: row(), evaluation: dark });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/notify/trpc/notify.createAlert');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ kind: 'price', marketId: 'market-btc', direction: 'above', targetPrice: '65000.50' });
  });

  it('sends the condition, name, message and expiry only when they were reviewed', async () => {
    const full: AlertIntent = {
      marketId: 'market-btc',
      direction: 'above',
      condition: 'crossing_up',
      targetPrice: '65000.50',
      name: 'Breakout',
      message: '{market} crossed {price}',
      expiresAt: '2026-11-01T09:30:00.000Z',
    };
    const fetch = vi.fn(async () =>
      trpc({
        alert: row({
          condition: 'crossing_up',
          name: 'Breakout',
          message: '{market} crossed {price}',
          expiresAt: '2026-11-01T09:30:00.000Z',
        }),
        evaluation: dark,
      }),
    );
    const outcome = await submitCreate(client(fetch), full, USER);
    expect(outcome.kind).toBe('saved');
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      kind: 'price',
      marketId: 'market-btc',
      direction: 'above',
      condition: 'crossing_up',
      targetPrice: '65000.50',
      name: 'Breakout',
      message: '{market} crossed {price}',
      expiresAt: '2026-11-01T09:30:00.000Z',
    });
  });

  it('does not believe an answer that is not the alert that was asked for', async () => {
    for (const wrong of [
      { targetPrice: '65001' },
      { direction: 'below' },
      { marketId: 'other' },
      { status: 'cancelled' },
      { userId: 'someone-else' },
    ]) {
      const outcome = await submitCreate(
        client(async () => trpc({ alert: row(wrong), evaluation: dark })),
        intent,
        USER,
      );
      expect(outcome, JSON.stringify(wrong)).toEqual({ kind: 'unknown' });
    }
  });

  it('accepts the same price spelled differently by the service', async () => {
    const outcome = await submitCreate(
      client(async () => trpc({ alert: row({ targetPrice: '65000.5' }), evaluation: dark })),
      intent,
      USER,
    );
    expect(outcome.kind).toBe('saved');
  });

  it('maps the service refusals to plain ones', async () => {
    const cases: [Response, string][] = [
      [trpcError(412, 'alert.price_unavailable', 'PRECONDITION_FAILED'), 'notOn'],
      [
        trpcError(412, 'A price alert is refused. The missing piece is price.', 'PRECONDITION_FAILED', 'notify.price_unset'),
        'priceMissing',
      ],
      [trpcError(403, 'forbidden', 'FORBIDDEN'), 'notAllowed'],
      [trpcError(401, 'unauthorized', 'UNAUTHORIZED'), 'signedOut'],
      [trpcError(400, 'Invalid input', 'BAD_REQUEST'), 'badRequest'],
      [trpcError(429, 'Too many requests', 'TOO_MANY_REQUESTS'), 'tooMany'],
    ];
    for (const [response, refusal] of cases) {
      expect(
        await submitCreate(
          client(async () => response),
          intent,
          USER,
        ),
      ).toEqual({ kind: 'refused', refusal });
    }
  });

  it('reports a dropped connection, a server error and an unreadable answer as unknown, never failed or done', async () => {
    expect(
      await submitCreate(
        client(async () => Promise.reject(new TypeError('network'))),
        intent,
        USER,
      ),
    ).toEqual({ kind: 'unknown' });
    expect(
      await submitCreate(
        client(async () => trpcError(500, 'boom', 'INTERNAL_SERVER_ERROR')),
        intent,
        USER,
      ),
    ).toEqual({ kind: 'unknown' });
    expect(
      await submitCreate(
        client(async () => new Response('<html>', { status: 200 })),
        intent,
        USER,
      ),
    ).toEqual({ kind: 'unknown' });
  });
});

describe('cancel an alert', () => {
  it('cancels and says so', async () => {
    const cancelled = row({ status: 'cancelled' });
    const fetch = vi.fn(async () => trpc({ cancelled: true, alert: cancelled }));
    const outcome = await submitCancel(client(fetch), ID, USER);
    expect(outcome).toEqual({ kind: 'done', words: 'cancelled', alert: cancelled });
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ id: ID });
  });

  it('does not call an already-fired alert cancelled', async () => {
    const fired = row({ status: 'fired', firedAt: '2026-10-17T09:00:00.000Z' });
    expect(
      await submitCancel(
        client(async () => trpc({ cancelled: false, alert: fired })),
        ID,
        USER,
      ),
    ).toEqual({
      kind: 'done',
      words: 'alreadyFired',
      alert: fired,
    });
  });

  it('says not found when the service has no such alert', async () => {
    expect(
      await submitCancel(
        client(async () => trpc({ cancelled: false, alert: null })),
        ID,
        USER,
      ),
    ).toEqual({
      kind: 'done',
      words: 'notFound',
      alert: null,
    });
  });

  it('treats a contradictory or foreign answer, and a lost one, as unknown', async () => {
    expect(
      await submitCancel(
        client(async () => trpc({ cancelled: true, alert: row({ status: 'active' }) })),
        ID,
        USER,
      ),
    ).toEqual({ kind: 'unknown' });
    expect(
      await submitCancel(
        client(async () => trpc({ cancelled: true, alert: row({ id: '22222222-2222-4222-8222-222222222222', status: 'cancelled' }) })),
        ID,
        USER,
      ),
    ).toEqual({ kind: 'unknown' });
    expect(
      await submitCancel(
        client(async () => Promise.reject(new Error('offline'))),
        ID,
        USER,
      ),
    ).toEqual({ kind: 'unknown' });
  });

  it('maps a refusal', async () => {
    expect(
      await submitCancel(
        client(async () => trpcError(403, 'forbidden', 'FORBIDDEN')),
        ID,
        USER,
      ),
    ).toEqual({ kind: 'refused', refusal: 'notAllowed' });
  });
});

describe('read the alerts', () => {
  it('always sends a page size and reads the decimal price as text', async () => {
    const fetch = vi.fn(async () => trpc({ items: [row({ targetPrice: '0.000000000000000001' })], evaluation: dark }));
    const result = await listAlerts(client(fetch));
    expect(result.ok && result.data.items[0]?.targetPrice).toBe('0.000000000000000001');
    const [url] = fetch.mock.calls[0] as unknown as [string];
    expect(decodeURIComponent(url)).toBe('/api/notify/trpc/notify.alerts?input={"limit":100}');
  });

  it('refuses an answer in an unknown shape instead of showing it', async () => {
    const result = await listAlerts(client(async () => trpc({ items: [{ id: 'not-a-uuid' }], evaluation: dark })));
    expect(result.ok).toBe(false);
  });
});
