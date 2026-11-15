import { describe, expect, it, vi } from 'vitest';
import {
  TRADE_VENUE_ACTIVITY_CALLERS,
  TRADE_VENUE_ACTIVITY_PROCEDURE,
  createTradeVenueActivityClient,
  tradeVenueActivityInputSchema,
  tradeVenueActivitySchema,
  verifyServiceHeaders,
} from './index.js';
import { SERVICE_NAMES } from './service-keys.js';

const SECRET = 'venue-activity-secret-long-enough-32';
const input = { userId: 'user-ada' };
const OWNER = '0x1111111111111111111111111111111111111111';
const fill = {
  fillId: 'sim-fill-1',
  symbol: 'BTC-USDC',
  base: 'BTC',
  quote: 'USDC',
  side: 'buy' as const,
  price: '60000',
  amount: '0.01',
  fee: '0.00001',
  feeAsset: 'BTC',
  filledAt: '2026-11-10T03:00:00.000Z',
};
const read = {
  state: 'read' as const,
  test: true,
  accounts: [
    {
      venueId: 'test-venue',
      owner: OWNER,
      subAccount: null,
      balances: [{ asset: 'BTC', total: '0.00999' }],
      fills: [fill],
      asOf: '2026-11-10T03:00:01.000Z',
    },
  ],
};
const UNAVAILABLE = { state: 'unavailable', code: 'trade.venue_activity_unavailable' };

const reply = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify({ result: { data } }), { status, headers: { 'content-type': 'application/json' } });

describe('trade venue activity contract', () => {
  it('names one procedure and one caller, and the caller is a real service', () => {
    expect(TRADE_VENUE_ACTIVITY_PROCEDURE).toBe('venue.ownActivity');
    expect(TRADE_VENUE_ACTIVITY_CALLERS).toEqual(['svc-tax']);
    for (const caller of TRADE_VENUE_ACTIVITY_CALLERS) expect(SERVICE_NAMES).toContain(caller);
  });

  it('refuses a field it does not name and a blank user', () => {
    expect(tradeVenueActivityInputSchema.safeParse({ ...input, owner: OWNER }).success).toBe(false);
    expect(tradeVenueActivityInputSchema.safeParse({ userId: '' }).success).toBe(false);
    expect(tradeVenueActivityInputSchema.safeParse(input).success).toBe(true);
  });

  it('parses the venue figures as decimal strings and refuses a number, an uppercase owner or an unknown field', () => {
    expect(tradeVenueActivitySchema.parse(read)).toEqual(read);
    expect(tradeVenueActivitySchema.parse({ state: 'off' })).toEqual({ state: 'off' });
    const account = read.accounts[0]!;
    const withFill = (f: unknown) => ({ ...read, accounts: [{ ...account, fills: [f] }] });
    expect(tradeVenueActivitySchema.safeParse(withFill({ ...fill, amount: 0.01 })).success).toBe(false);
    expect(tradeVenueActivitySchema.safeParse(withFill({ ...fill, price: '6e4' })).success).toBe(false);
    expect(tradeVenueActivitySchema.safeParse(withFill({ ...fill, ledgerTx: 'x' })).success).toBe(false);
    expect(
      tradeVenueActivitySchema.safeParse({ ...read, accounts: [{ ...account, owner: '0xABCDEF1111111111111111111111111111111111' }] })
        .success,
    ).toBe(false);
  });
});

describe('trade venue activity client', () => {
  it('signs the body as svc-tax and returns the parsed answer', async () => {
    const fetcher = vi.fn(async () => reply(read));
    const client = createTradeVenueActivityClient({ tradeUrl: 'http://trade.internal:4002/', secret: SECRET, fetcher });
    await expect(client.read(input)).resolves.toEqual(read);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://trade.internal:4002/trpc/venue.ownActivity');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify(input));
    const headers = init.headers as Record<string, string>;
    expect(
      verifyServiceHeaders(headers, SECRET, { rawBody: { retained: true, bytes: Buffer.from(String(init.body)) }, mode: 'require' })
        .service,
    ).toBe('svc-tax');
  });

  it('returns the door off and an empty account list as answers, not as unavailable', async () => {
    const off = createTradeVenueActivityClient({
      tradeUrl: 'http://trade.internal',
      secret: SECRET,
      fetcher: (async () => reply({ state: 'off' })) as unknown as typeof fetch,
    });
    await expect(off.read(input)).resolves.toEqual({ state: 'off' });
    const none = createTradeVenueActivityClient({
      tradeUrl: 'http://trade.internal',
      secret: SECRET,
      fetcher: (async () => reply({ state: 'read', test: true, accounts: [] })) as unknown as typeof fetch,
    });
    await expect(none.read(input)).resolves.toEqual({ state: 'read', test: true, accounts: [] });
  });

  it.each([
    ['no url', { secret: SECRET }],
    ['a url with credentials', { tradeUrl: 'http://u:p@trade.internal', secret: SECRET }],
    ['a url with a query', { tradeUrl: 'http://trade.internal?x=1', secret: SECRET }],
    ['a non-http url', { tradeUrl: 'ftp://trade.internal', secret: SECRET }],
    ['no secret', { tradeUrl: 'http://trade.internal' }],
    ['a short secret', { tradeUrl: 'http://trade.internal', secret: 'short' }],
  ])('answers unavailable without fetching for %s', async (_name, options) => {
    const fetcher = vi.fn();
    const client = createTradeVenueActivityClient({ ...options, fetcher: fetcher as unknown as typeof fetch });
    await expect(client.read(input)).resolves.toEqual(UNAVAILABLE);
    await expect(client.read({ userId: '' })).resolves.toEqual(UNAVAILABLE);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['the venue down (503)', async () => reply(read, 503)],
    ['a reply that does not parse', async () => reply({ state: 'read', accounts: [{ owner: OWNER }] })],
    ['an envelope with no result', async () => new Response(JSON.stringify({ error: {} }), { status: 200 })],
    ['a thrown fetch', async () => Promise.reject(new Error('down'))],
  ])('answers unavailable for %s, never "no trades"', async (_name, fetcher) => {
    const client = createTradeVenueActivityClient({
      tradeUrl: 'http://trade.internal',
      secret: SECRET,
      fetcher: fetcher as unknown as typeof fetch,
    });
    await expect(client.read(input)).resolves.toEqual(UNAVAILABLE);
  });

  it('answers unavailable when svc-trade does not reply in time', async () => {
    const fetcher = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
    );
    const client = createTradeVenueActivityClient({
      tradeUrl: 'http://trade.internal',
      secret: SECRET,
      timeoutMs: 20,
      fetcher: fetcher as unknown as typeof fetch,
    });
    await expect(client.read(input)).resolves.toEqual(UNAVAILABLE);
  });
});
