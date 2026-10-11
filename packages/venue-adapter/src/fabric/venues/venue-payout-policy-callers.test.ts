/**
 * Unit card — remaining payout-policy callers share the caller's floor
 *
 * 1. Promise: OKX and Bybit snapshotBook, the market-data factory, and the
 *    trade gate refuse a two-sided book when the floor is omitted (MoneyError
 *    'payout floor is missing'). An explicit fixture decimal returns a thick
 *    book and refuses dust with VenueUnavailableError no_depth.
 * 2. Break: a hidden production floor, or a constructor / gate that drops the
 *    caller's floor.
 * 3. Done bar: the call argument wins when passed. Otherwise the stored
 *    constructor policy is used. No production floor is applied here.
 * 4. Class M
 * 5. Paths: okx-spot.ts, bybit-spot.ts, factory.ts, trade-payout-gate.ts,
 *    binance-spot-trade.ts, bybit-spot-trade.ts, okx-spot-trade.ts
 * 6. RED: a two-sided book with no floor is returned, or dust under the
 *    fixture decimal is served.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MoneyError, parseAmount } from '@intafaced/ledger-client/money';
import { VenueUnavailableError } from '@intafaced/venue-contracts';
import type { PayoutGradePolicy } from '../payout-grade.js';
import { assertTradeBookPayoutGradeBeforePlace } from '../trade-payout-gate.js';
import type { HttpPort, HttpResponse } from '../transport.js';
import { BybitSpotMarketData } from './bybit-spot.js';
import { createVenueMarketDataAdapter } from './factory.js';
import { OkxSpotMarketData } from './okx-spot.js';

/** Fixture floor. Not a production magnitude. */
const FIXTURE_FLOOR = '250';
const POLICY: PayoutGradePolicy = { minBestLevelNotional: FIXTURE_FLOOR };

const missingFloor = {
  name: 'MoneyError',
  message: 'payout floor is missing',
} satisfies Partial<MoneyError>;

const THICK = {
  bids: [['30000.00', '2.00']],
  asks: [['30002.00', '1.00']],
};
const DUST = {
  bids: [['1.00', '1.00']],
  asks: [['1.01', '1.00']],
};
const AT_HUNDRED = {
  bids: [['100.00', '1.00']],
  asks: [['100.00', '1.00']],
};

class FakeHttp implements HttpPort {
  constructor(private readonly body: unknown) {}

  async get(): Promise<HttpResponse> {
    return { status: 200, body: this.body, header: () => null };
  }
}

function okxBody(levels: { bids: string[][]; asks: string[][] }, seqId = 7): unknown {
  return {
    code: '0',
    msg: '',
    data: [{ bids: levels.bids, asks: levels.asks, ts: '1', seqId }],
  };
}

function bybitBody(levels: { bids: string[][]; asks: string[][] }, seq = 13): unknown {
  return {
    retCode: 0,
    retMsg: 'OK',
    result: {
      s: 'BTCUSDT',
      b: levels.bids,
      a: levels.asks,
      ts: 1,
      u: seq,
      seq,
      cts: 1,
    },
    retExtInfo: {},
    time: 1,
  };
}

function binanceBody(levels: { bids: string[][]; asks: string[][] }, lastUpdateId = 7): unknown {
  return { lastUpdateId, bids: levels.bids, asks: levels.asks };
}

function okx(body: unknown, payoutPolicy?: PayoutGradePolicy | null): OkxSpotMarketData {
  return new OkxSpotMarketData({
    http: new FakeHttp(body),
    clock: () => 0,
    restBase: 'https://rest.test',
    heartbeatMs: 0,
    ...(payoutPolicy !== undefined ? { payoutPolicy } : {}),
  });
}

function bybit(body: unknown, payoutPolicy?: PayoutGradePolicy | null): BybitSpotMarketData {
  return new BybitSpotMarketData({
    http: new FakeHttp(body),
    clock: () => 0,
    restBase: 'https://rest.test',
    heartbeatMs: 0,
    ...(payoutPolicy !== undefined ? { payoutPolicy } : {}),
  });
}

describe('OKX and Bybit snapshotBook payout policy', () => {
  it('refuses a two-sided book when the floor is omitted', async () => {
    await expect(okx(okxBody(THICK)).snapshotBook('BTC/USDT', 5)).rejects.toBeInstanceOf(MoneyError);
    await expect(okx(okxBody(THICK)).snapshotBook('BTC/USDT', 5)).rejects.toMatchObject(missingFloor);
    await expect(bybit(bybitBody(THICK)).snapshotBook('BTC/USDT', 5)).rejects.toBeInstanceOf(MoneyError);
    await expect(bybit(bybitBody(THICK)).snapshotBook('BTC/USDT', 5)).rejects.toMatchObject(missingFloor);
  });

  it('returns a thick book and refuses dust when the caller passes the fixture floor', async () => {
    const okxBook = await okx(okxBody(THICK)).snapshotBook('BTC/USDT', 5, POLICY);
    expect(okxBook.venueId).toBe('okx-spot');
    expect(okxBook.symbol).toBe('BTC/USDT');
    expect(okxBook.sequence).toBe(7);
    expect(okxBook.bids).toEqual([[parseAmount('30000.00'), parseAmount('2.00')]]);
    expect(okxBook.asks).toEqual([[parseAmount('30002.00'), parseAmount('1.00')]]);

    const bybitBook = await bybit(bybitBody(THICK)).snapshotBook('BTC/USDT', 5, POLICY);
    expect(bybitBook.venueId).toBe('bybit-spot');
    expect(bybitBook.symbol).toBe('BTC/USDT');
    expect(bybitBook.sequence).toBe(13);
    expect(bybitBook.bids).toEqual([[parseAmount('30000.00'), parseAmount('2.00')]]);
    expect(bybitBook.asks).toEqual([[parseAmount('30002.00'), parseAmount('1.00')]]);

    await expect(okx(okxBody(DUST)).snapshotBook('BTC/USDT', 5, POLICY)).rejects.toBeInstanceOf(VenueUnavailableError);
    await expect(okx(okxBody(DUST)).snapshotBook('BTC/USDT', 5, POLICY)).rejects.toMatchObject({ reason: 'no_depth' });
    await expect(bybit(bybitBody(DUST)).snapshotBook('BTC/USDT', 5, POLICY)).rejects.toMatchObject({ reason: 'no_depth' });
    // Notional 100 clears a floor of 100 and fails this fixture. The passed string is the floor.
    await expect(okx(okxBody(AT_HUNDRED)).snapshotBook('BTC/USDT', 5, POLICY)).rejects.toMatchObject({
      reason: 'no_depth',
    });
    await expect(bybit(bybitBody(AT_HUNDRED)).snapshotBook('BTC/USDT', 5, POLICY)).rejects.toMatchObject({
      reason: 'no_depth',
    });
  });

  it('uses a passed argument instead of the constructor policy', async () => {
    await expect(okx(okxBody(THICK), POLICY).snapshotBook('BTC/USDT', 5, null)).rejects.toMatchObject(missingFloor);
    await expect(bybit(bybitBody(DUST), { minBestLevelNotional: '1' }).snapshotBook('BTC/USDT', 5, POLICY)).rejects.toMatchObject({
      reason: 'no_depth',
    });
  });
});

describe('createVenueMarketDataAdapter payoutPolicy', () => {
  it('uses the constructor floor when snapshotBook is called with no third argument', async () => {
    const okxAdapter = createVenueMarketDataAdapter('okx-spot', {
      http: new FakeHttp(okxBody(THICK)),
      clock: () => 0,
      restBase: 'https://rest.test',
      heartbeatMs: 0,
      payoutPolicy: POLICY,
    });
    const okxBook = await okxAdapter!.snapshotBook('BTC/USDT', 5);
    expect(okxBook.venueId).toBe('okx-spot');
    expect(okxBook.sequence).toBe(7);
    expect(okxBook.bids).toEqual([[parseAmount('30000.00'), parseAmount('2.00')]]);

    const bybitAdapter = createVenueMarketDataAdapter('bybit-spot', {
      http: new FakeHttp(bybitBody(THICK)),
      clock: () => 0,
      restBase: 'https://rest.test',
      heartbeatMs: 0,
      payoutPolicy: POLICY,
    });
    const bybitBook = await bybitAdapter!.snapshotBook('BTC/USDT', 5);
    expect(bybitBook.venueId).toBe('bybit-spot');
    expect(bybitBook.sequence).toBe(13);
    expect(bybitBook.asks).toEqual([[parseAmount('30002.00'), parseAmount('1.00')]]);

    await expect(
      createVenueMarketDataAdapter('okx-spot', {
        http: new FakeHttp(okxBody(DUST)),
        clock: () => 0,
        restBase: 'https://rest.test',
        heartbeatMs: 0,
        payoutPolicy: POLICY,
      })!.snapshotBook('BTC/USDT', 5),
    ).rejects.toMatchObject({ reason: 'no_depth' });
    await expect(
      createVenueMarketDataAdapter('bybit-spot', {
        http: new FakeHttp(bybitBody(AT_HUNDRED)),
        clock: () => 0,
        restBase: 'https://rest.test',
        heartbeatMs: 0,
        payoutPolicy: POLICY,
      })!.snapshotBook('BTC/USDT', 5),
    ).rejects.toMatchObject({ reason: 'no_depth' });
  });

  it('refuses a two-sided book when the constructor floor is omitted', async () => {
    await expect(
      createVenueMarketDataAdapter('okx-spot', {
        http: new FakeHttp(okxBody(THICK)),
        clock: () => 0,
        restBase: 'https://rest.test',
        heartbeatMs: 0,
      })!.snapshotBook('BTC/USDT', 5),
    ).rejects.toMatchObject(missingFloor);
    await expect(
      createVenueMarketDataAdapter('bybit-spot', {
        http: new FakeHttp(bybitBody(THICK)),
        clock: () => 0,
        restBase: 'https://rest.test',
        heartbeatMs: 0,
      })!.snapshotBook('BTC/USDT', 5),
    ).rejects.toBeInstanceOf(MoneyError);
    await expect(
      createVenueMarketDataAdapter('bybit-spot', {
        http: new FakeHttp(bybitBody(THICK)),
        clock: () => 0,
        restBase: 'https://rest.test',
        heartbeatMs: 0,
      })!.snapshotBook('BTC/USDT', 5),
    ).rejects.toMatchObject(missingFloor);
  });
});

describe('assertTradeBookPayoutGradeBeforePlace payout policy', () => {
  it('refuses a two-sided book when the floor is omitted', async () => {
    await expect(
      assertTradeBookPayoutGradeBeforePlace('binance-spot', 'BTC/USDT', {
        http: new FakeHttp(binanceBody(THICK)),
        clock: () => 1,
        limit: 5,
      }),
    ).rejects.toBeInstanceOf(MoneyError);
    await expect(
      assertTradeBookPayoutGradeBeforePlace('binance-spot', 'BTC/USDT', {
        http: new FakeHttp(binanceBody(THICK)),
        clock: () => 1,
        limit: 5,
      }),
    ).rejects.toMatchObject(missingFloor);
  });

  it('accepts a thick book and refuses dust when the caller passes the fixture floor', async () => {
    await expect(
      assertTradeBookPayoutGradeBeforePlace('binance-spot', 'BTC/USDT', {
        http: new FakeHttp(binanceBody(THICK)),
        clock: () => 1,
        limit: 5,
        payoutPolicy: POLICY,
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertTradeBookPayoutGradeBeforePlace('binance-spot', 'BTC/USDT', {
        http: new FakeHttp(binanceBody(DUST)),
        clock: () => 1,
        limit: 5,
        payoutPolicy: POLICY,
      }),
    ).rejects.toBeInstanceOf(VenueUnavailableError);
    await expect(
      assertTradeBookPayoutGradeBeforePlace('binance-spot', 'BTC/USDT', {
        http: new FakeHttp(binanceBody(DUST)),
        clock: () => 1,
        limit: 5,
        payoutPolicy: POLICY,
      }),
    ).rejects.toMatchObject({ reason: 'no_depth' });
    await expect(
      assertTradeBookPayoutGradeBeforePlace('binance-spot', 'BTC/USDT', {
        http: new FakeHttp(binanceBody(AT_HUNDRED)),
        clock: () => 1,
        limit: 5,
        payoutPolicy: POLICY,
      }),
    ).rejects.toMatchObject({ reason: 'no_depth' });
  });
});

describe('trade constructors forward payoutPolicy and do not hardcode a floor', () => {
  it('passes the stored policy into the gate and installs no decimal floor', () => {
    const root = dirname(fileURLToPath(import.meta.url));
    for (const file of ['binance-spot-trade.ts', 'bybit-spot-trade.ts', 'okx-spot-trade.ts']) {
      const src = readFileSync(join(root, file), 'utf8');
      expect(src, file).toContain('readonly payoutPolicy?: PayoutGradePolicy | null');
      expect(src, file).toMatch(/assertTradeBookPayoutGradeBeforePlace\([\s\S]*payoutPolicy: this\.#payoutPolicy/);
      expect(src, file).not.toContain('DEFAULT_MIN_BEST_LEVEL_NOTIONAL');
      expect(src, file).not.toMatch(/minBestLevelNotional:\s*['"]\d/);
    }
  });
});
