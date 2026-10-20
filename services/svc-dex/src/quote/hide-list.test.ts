import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SANCTIONS_REGIONS_ENV, SANCTIONS_SOURCE_ENV, SCREENING_REVIEWED_EMPTY } from '@intafaced/config';
import { createEdgeContext } from '@intafaced/contracts';
import { parseAmount as amt, type Amount } from '@intafaced/ledger-client/money';
import { createDexRouter } from '../router.js';
import { externalVenueConfigSchema, ExternalQuoteVenue } from './external-venue.js';
import {
  assertMarketListed,
  createHideListReader,
  HIDE_LIST_UNAVAILABLE,
  HIDE_LIST_UNSET,
  MARKET_HIDDEN,
  POOL_HIDDEN,
  withoutHiddenPools,
  type HideListReader,
} from './hide-list.js';
import { MarketDataSource } from './market-data-source.js';
import type { TimestampedBook, VenueKind } from './venue.js';

const NOW = new Date('2026-10-20T12:00:00.000Z');
const SECRET = 'a-dex-hide-list-test-edge-secret-long-enough';

const priorRegions = process.env[SANCTIONS_REGIONS_ENV];
const priorSource = process.env[SANCTIONS_SOURCE_ENV];
beforeAll(() => {
  process.env[SANCTIONS_REGIONS_ENV] = SCREENING_REVIEWED_EMPTY;
  process.env[SANCTIONS_SOURCE_ENV] = 'counsel-memo-ref';
});
afterAll(() => {
  if (priorRegions === undefined) delete process.env[SANCTIONS_REGIONS_ENV];
  else process.env[SANCTIONS_REGIONS_ENV] = priorRegions;
  if (priorSource === undefined) delete process.env[SANCTIONS_SOURCE_ENV];
  else process.env[SANCTIONS_SOURCE_ENV] = priorSource;
});

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-dex' });
const anonymous = () => edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });

class LiveVenue extends MarketDataSource {
  readonly id: string;
  readonly pool?: { chainId: number; address: string };
  readonly kind: VenueKind = 'external-dex';
  readonly feeBps = 0;
  readonly settlementCost: Amount = 0n;
  calls = 0;
  constructor(id = 'intachain-clob', pool?: { chainId: number; address: string }) {
    super({ quoteTtlMs: 2_000 });
    this.id = id;
    if (pool) this.pool = pool;
  }
  protected async fetchDepth(symbol: string): Promise<TimestampedBook> {
    this.calls += 1;
    return {
      venueId: this.id,
      symbol,
      bids: [[amt('99'), amt('10')]],
      asks: [[amt('101'), amt('10')]],
      observedAt: NOW,
      sequence: 1,
      chainFinality: 'finalized',
    };
  }
}

const list = (markets: string[]) => ({
  asOf: NOW.toISOString(),
  pools: [],
  markets: markets.map((symbol) => ({ symbol })),
});
const reading = (markets: string[]): HideListReader => ({ read: async () => list(markets) });
const envelope = (data: unknown) => ({ result: { data } });
const respond = (body: unknown, init?: ResponseInit) => async () => new Response(JSON.stringify(body), init);

describe('hide list reader — fail closed', () => {
  const base = { baseUrl: 'http://svc-ops:4022/', timeoutMs: 500 };

  it('reads the list from svc-ops without credentials and refuses redirects', async () => {
    const fetch = vi.fn(respond(envelope(list(['IFC-USD']))));
    const out = await createHideListReader({ ...base, fetch }).read();
    expect(out.markets).toEqual([{ symbol: 'IFC-USD' }]);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://svc-ops:4022/trpc/protocolListing.hidden');
    expect(init.redirect).toBe('error');
    expect(JSON.stringify(init.headers)).not.toMatch(/secret|authorization|principal/i);
  });

  it.each([
    ['unreachable', async () => Promise.reject(new Error('ECONNREFUSED'))],
    ['non-OK', respond({}, { status: 503 })],
    ['not JSON', async () => new Response('<html>', { status: 200 })],
    ['not a hide list', respond(envelope({ pools: 'none' }))],
    ['extra keys', respond(envelope({ ...list([]), secret: 'x' }))],
    ['redirect', async () => Promise.reject(new TypeError('redirect mode is set to error'))],
  ])('%s is HIDE_LIST_UNAVAILABLE, never an empty list', async (_name, fetch) => {
    await expect(createHideListReader({ ...base, fetch }).read()).rejects.toMatchObject({ code: HIDE_LIST_UNAVAILABLE });
  });
});

describe('assertMarketListed', () => {
  it('refuses with hide_list_unset when no source is published', async () => {
    await expect(assertMarketListed(undefined, 'IFC-USD')).rejects.toMatchObject({ code: HIDE_LIST_UNSET });
  });

  it('passes a listed market and refuses a hidden one, ignoring case and spaces', async () => {
    await expect(assertMarketListed(reading(['BTC-USD']), 'IFC-USD')).resolves.toMatchObject({ markets: [{ symbol: 'BTC-USD' }] });
    await expect(assertMarketListed(reading(['IFC-USD']), ' ifc-usd ')).rejects.toMatchObject({ code: MARKET_HIDDEN });
  });
});

describe('quote honours the hide list', () => {
  const buy = { symbol: 'IFC-USD', side: 'buy' as const, qty: '1' };
  const mount = (
    hideList: HideListReader | undefined,
    venue = new LiveVenue(),
    owner: { maxAgeMs?: number; depth?: number } = { maxAgeMs: 2_000, depth: 50 },
  ) => ({ venue, router: createDexRouter({ venues: () => [venue], ...owner, ...(hideList ? { hideList } : {}), now: () => NOW }) });

  it('quotes a market that was read as listed', async () => {
    const { router } = mount(reading(['OTHER-USD']));
    expect((await router.createCaller(anonymous()).quote(buy)).route.filledQty).toBe('1');
  });

  it('refuses a hidden market with NOT_FOUND before any venue is read', async () => {
    const { router, venue } = mount(reading([' ifc-usd']));
    await expect(router.createCaller(anonymous()).quote(buy)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining(MARKET_HIDDEN),
    });
    expect(venue.calls).toBe(0);
  });

  it('refuses with PRECONDITION_FAILED when no hide list source is published', async () => {
    const { router, venue } = mount(undefined);
    await expect(router.createCaller(anonymous()).quote(buy)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining(HIDE_LIST_UNSET),
    });
    expect(venue.calls).toBe(0);
  });

  it('refuses with SERVICE_UNAVAILABLE when the list cannot be read', async () => {
    const down = createHideListReader({
      baseUrl: 'http://svc-ops:4022',
      timeoutMs: 100,
      fetch: async () => Promise.reject(new Error('down')),
    });
    const { router, venue } = mount(down);
    await expect(router.createCaller(anonymous()).quote(buy)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: expect.stringContaining(HIDE_LIST_UNAVAILABLE),
    });
    expect(venue.calls).toBe(0);
  });

  it('keeps the blank-owner-setting refusal first', async () => {
    const { router } = mount(undefined, new LiveVenue(), { depth: 50 });
    await expect(router.createCaller(anonymous()).quote(buy)).rejects.toMatchObject({
      message: expect.stringContaining('dex.quote.max_age_unset'),
    });
  });
});

describe('hidden pools leave routing', () => {
  const POOL_A = { chainId: 84532, address: '0xAbCdEf0123456789aBcDeF0123456789abCDef01' };
  const POOL_B = { chainId: 84532, address: '0x0000000000000000000000000000000000000002' };
  const hiddenPools = (...pools: { chainId: number; address: string }[]) => ({
    read: async () => ({
      asOf: NOW.toISOString(),
      pools: pools.map((p) => ({ chainId: p.chainId, poolAddress: p.address.toLowerCase() })),
      markets: [],
    }),
  });
  const buy = { symbol: 'IFC-USD', side: 'buy' as const, qty: '1' };
  const mount = (hideList: HideListReader, venues: LiveVenue[]) =>
    createDexRouter({ venues: () => venues, maxAgeMs: 2_000, depth: 50, hideList, now: () => NOW });

  it('drops a venue whose pool is hidden, matching the address in any case, and keeps the rest', async () => {
    const a = new LiveVenue('amm-a', POOL_A);
    const b = new LiveVenue('amm-b', POOL_B);
    const quoted = await mount(hiddenPools(POOL_A), [a, b]).createCaller(anonymous()).quote(buy);
    expect(quoted.venues.map((v) => v.venueId)).toEqual(['amm-b']);
    expect(a.calls).toBe(0);
  });

  it('keeps a venue that names no pool: it cannot be hidden by pool', () => {
    const open = new LiveVenue('clob');
    expect(
      withoutHiddenPools([open], { asOf: NOW.toISOString(), pools: [{ chainId: 1, poolAddress: POOL_A.address }], markets: [] }),
    ).toEqual([open]);
  });

  it('a pool on another chain with the same address is not hidden', () => {
    const a = new LiveVenue('amm-a', { ...POOL_A, chainId: 1 });
    expect(
      withoutHiddenPools([a], { asOf: NOW.toISOString(), pools: [{ chainId: 84532, poolAddress: POOL_A.address }], markets: [] }),
    ).toEqual([a]);
  });

  it('refuses pool_hidden, not "nothing wired", when every venue was a hidden pool', async () => {
    const a = new LiveVenue('amm-a', POOL_A);
    await expect(mount(hiddenPools(POOL_A), [a]).createCaller(anonymous()).quote(buy)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining(POOL_HIDDEN),
    });
    expect(a.calls).toBe(0);
  });

  it('still refuses no_venue_configured when no venue was built at all', async () => {
    await expect(mount(hiddenPools(POOL_A), []).createCaller(anonymous()).quote(buy)).rejects.toMatchObject({
      message: expect.stringContaining('dex.quote.no_venue_configured'),
    });
  });

  it('an external venue row can name its pool, and a bad address is refused at boot', () => {
    const row = { id: 'amm-a', kind: 'amm', depthUrl: 'https://example.invalid/d', feeBps: 30, settlementCost: '0' };
    const pool = { chainId: 84532, address: POOL_A.address };
    const parsed = externalVenueConfigSchema.safeParse({ ...row, pool });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const venue = new ExternalQuoteVenue({ config: parsed.data, baseUrl: parsed.data.depthUrl, timeoutMs: 500, quoteTtlMs: 500 });
      expect(venue.pool).toEqual(pool);
    }
    expect(externalVenueConfigSchema.safeParse({ ...row, pool: { chainId: 84532, address: '0x12' } }).success).toBe(false);
    expect(externalVenueConfigSchema.safeParse({ ...row, pool: { ...pool, extra: 1 } }).success).toBe(false);
  });
});
