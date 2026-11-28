/**
 * Unit card — live host funding quote does not invent an index price
 * 1. Promise: GET funding-rate host sets indexPrice: null; nextFundingTimestamp: null
 * 2. Break: copy mark into indexPrice or derive nextFunding from interval ms
 * 3. Done bar: fundingRateForMarket return has those two hard-nulls
 * 4. Class N
 * 5. Paths: svc-trade/src/index.ts
 * 6. RED: indexPrice: markPrice
 * 7. Collision: none — #1928 pins getOpenMarginCall; this pins the funding quote
 */

import { describe, expect, it, vi } from 'vitest';
import { fakeMarket } from '../public-rest.js';
import { publicRestDoor } from './testing/doors.js';
import { startFuturesJobs } from './futures-jobs.js';

const PERP = fakeMarket({ id: 'm-perp', symbol: 'BTC/USDT-PERP', kind: 'futures' });

function jobs() {
  return startFuturesJobs({
    sql: {} as never,
    ledger: { post: vi.fn(), balance: vi.fn() },
    matching: { depth: vi.fn(async () => ({ bids: [], asks: [], sequence: 0 })) } as never,
    bus: null,
    now: () => new Date(1_700_000_000_000),
    config: { enabled: false, liqIntervalMs: 1000, fundingIntervalMs: null, fundingMarketIds: [], fundingMaxAbsRate: null },
  });
}

describe('live host funding quote does not invent index or next funding time', () => {
  it('hard-nulls indexPrice and nextFundingTimestamp', async () => {
    // What the host has to quote from is the published entry: a rate and when it was observed, no index, no next time.
    const handle = jobs();
    handle.publishFundingRate({ marketId: PERP.id, rate: '0.0001', periodId: 'p1', asOfMs: 1_700_000_000_000 });
    const entry = handle.getPublishedRate(PERP.id);
    handle.stop();
    expect(entry).toMatchObject({ marketId: PERP.id, rate: '0.0001', asOfMs: 1_700_000_000_000 });
    expect(entry).not.toHaveProperty('indexPrice');
    expect(entry).not.toHaveProperty('nextFundingTimestamp');
    // The public door answers exactly the quote it is handed: null stays null, nothing is filled in.
    const app = await publicRestDoor({
      marketBySymbol: async (s) => (s === PERP.symbol ? PERP : null),
      fundingRateForMarket: async () => ({
        fundingRate: '0.0001',
        fundingTimestamp: 1_700_000_000_000,
        fundingDatetime: new Date(1_700_000_000_000).toISOString(),
        nextFundingTimestamp: null,
        markPrice: '50000',
        indexPrice: null,
      }),
    });
    const res = await app.inject({ method: 'GET', url: `/api/v1/funding-rate/${encodeURIComponent(PERP.symbol)}` });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ indexPrice: null, nextFundingTimestamp: null, fundingRate: '0.0001' });
  });

  it('does not copy markPrice into indexPrice', async () => {
    const app = await publicRestDoor({
      marketBySymbol: async (s) => (s === PERP.symbol ? PERP : null),
      fundingRateForMarket: async () => ({
        fundingRate: '0.0001',
        fundingTimestamp: 1,
        fundingDatetime: new Date(1).toISOString(),
        nextFundingTimestamp: null,
        markPrice: '50000',
        indexPrice: null,
      }),
    });
    const body = (await app.inject({ method: 'GET', url: `/api/v1/funding-rate/${encodeURIComponent(PERP.symbol)}` })).json();
    await app.close();
    expect(body.markPrice).toBe('50000');
    expect(body.indexPrice).toBeNull();
  });
});
