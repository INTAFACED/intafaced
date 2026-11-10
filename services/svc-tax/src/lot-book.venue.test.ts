import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import {
  createEdgeContext,
  encodePrincipal,
  signPrincipalHeader,
  type TradeVenueActivityPort,
  type TradeVenueActivityResult,
} from '@intafaced/contracts';
import { TAX_DATA_LAKE_UNAVAILABLE, TAX_INDEXER_UNAVAILABLE } from './codes.js';
import { createTaxRouter } from './router.js';
import { TaxService } from './tax-service.js';

// J-cex-spot-01 #11 through svc-tax's own door: tax.lotBook adds the caller's own venue account, read through svc-trade
// (`venue.ownActivity`), beside their ledger book. TEST figures; the ledger here holds nothing and posts nothing.
const SECRET = 'a-tax-venue-test-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const OWNER = '0x00000000000000000000000000000000000000a1';
const NOW = new Date('2026-11-11T00:00:00.000Z');
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-tax' });

function signed() {
  const raw = encodePrincipal({
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['tax:read'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-venue',
  });
}

const bought: TradeVenueActivityResult = {
  state: 'read',
  test: true,
  accounts: [
    {
      venueId: 'test-venue',
      owner: OWNER,
      subAccount: null,
      balances: [
        { asset: 'USDC', total: '400' },
        { asset: 'BTC', total: '0.00999' },
      ],
      fills: [
        {
          fillId: 'f1',
          symbol: 'BTC-USDC',
          base: 'BTC',
          quote: 'USDC',
          side: 'buy',
          price: '60000',
          amount: '0.01',
          fee: '0.00001',
          feeAsset: 'BTC',
          filledAt: '2026-11-10T03:00:00.000Z',
        },
      ],
      asOf: '2026-11-10T03:00:01.000Z',
    },
  ],
};

function service(answer: TradeVenueActivityResult | undefined) {
  const asked: string[] = [];
  const venue: TradeVenueActivityPort = {
    async read(input) {
      asked.push(input.userId);
      return answer!;
    },
  };
  const tax = new TaxService({
    mapRaw: '',
    reads: {
      balances: async () => [],
      history: async () => [],
      tradeFills: async () => ({ fills: [], truncated: false, outsideInflows: new Set<string>() }),
    },
    lake: { status: 'absent', code: TAX_DATA_LAKE_UNAVAILABLE },
    indexer: { status: 'absent', code: TAX_INDEXER_UNAVAILABLE },
    now: () => NOW,
    closes: { closes: async () => null },
    ...(answer === undefined ? {} : { venue }),
  });
  return { tax, asked };
}

describe('tax.lotBook with the caller’s own venue account', () => {
  it('asks svc-trade for the caller only, and shows the bought lot at its cost through the door', async () => {
    const { tax, asked } = service(bought);
    const book = await createTaxRouter(tax)
      .createCaller(await signed())
      .lotBook();
    expect(asked).toEqual([USER]);
    expect(book.lots).toEqual([
      expect.objectContaining({
        id: `lot:venue:test-venue:${OWNER}:f1:BTC`,
        venueAccount: `venue:test-venue:${OWNER}`,
        source: 'trade',
        qty: '0.00999',
        remaining: '0.00999',
        costUsd: '600',
        daysHeld: 0,
      }),
    ]);
    expect(book.venue).toMatchObject({ status: 'read', test: true });
    expect(book.realizedUsd).toBeNull();
    expect(book.indicator).toBe('indicator_not_tax_advice');
  });

  it('names the venue unread, and shows neither a venue figure nor a realised total', async () => {
    const { tax } = service({ state: 'unavailable', code: 'trade.venue_activity_unavailable' });
    const book = await createTaxRouter(tax)
      .createCaller(await signed())
      .lotBook();
    expect(book.venue).toEqual({ status: 'unavailable', code: 'tax.venue_unavailable' });
    expect(book.residuals).toContain('tax.venue_unavailable');
    expect(book.lots).toEqual([]);
    expect(book.realizedUsd).toBeNull();
  });

  it('with no svc-trade to ask, the book is the ledger’s and says so', async () => {
    const { tax } = service(undefined);
    const book = await tax.lotBook({ userId: USER });
    expect(book.venue).toEqual({ status: 'unwired', code: 'tax.venue_unwired' });
  });

  it('the result over time stays the ledger book’s and does not read the venue', async () => {
    const { tax, asked } = service(bought);
    await tax.pnlOverTime({ userId: USER, from: '2026-11-09T00:00:00.000Z', utcOffsetMinutes: 0 });
    expect(asked).toEqual([]);
  });
});
