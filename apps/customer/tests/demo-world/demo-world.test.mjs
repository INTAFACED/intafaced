import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  asOf,
  venueAccountModeSchema,
  venueAccountSummarySchema,
  venueBalanceSchema,
  venueBestPricesReadSchema,
  venueBookReadSchema,
  venueCandlesReadSchema,
  venueConvertHistorySchema,
  venueFeeTierSchema,
  venuePublicFeesSchema,
  venueFillSchema,
  venueHistoryPageSchema,
  venueLeverageSchema,
  venueOrderSchema,
  venuePositionSchema,
  venueStatusSchema,
  venueTradesReadSchema,
} from '@intafaced/contracts/trade-venue-door';
import { tradingSessionStatusSchema } from '@intafaced/contracts/protocol-trading-session';
import { privateKeyToAccount } from 'viem/accounts';
import { demoChain } from './chain.mjs';
import { DEMO_NOW, RECORDING, callKey, demoAnswer, recordedAnswer } from './index.mjs';
import { demoWalletKey } from './seed.mjs';
import { verificationStatus } from '../../src/features/account/verification-guards';
import { owner } from '../../src/screens/account/account.fixtures.mjs';

// The demo world is only worth its pictures while the app reads it: every answer a desk draws from is parsed here with
// the app's own schemas, so a schema change that would leave a picture's panel empty fails here first.
const read = (href) => demoAnswer(`http://x${href}`, 'GET', null, { signedIn: true, now: DEMO_NOW });
const SYMBOLS = RECORDING.calls.signedIn['GET /api/v1/venue/market-states'].json.value.markets.map((m) => m.symbol);

describe('the demo world', () => {
  it('is TEST, recorded with the venue on, and lists the venue markets it has a feed for', () => {
    expect(RECORDING.label).toBe('TEST');
    expect(Number.isFinite(DEMO_NOW)).toBe(true);
    expect(venueStatusSchema.parse(read('/api/v1/venue/status').json)).toMatchObject({ enabled: true, available: true, test: true });
    expect(SYMBOLS).toEqual(expect.arrayContaining(['BTC-PERP', 'ETH-PERP']));
  });

  it("answers every listed market's book, best prices, prints and candles in the door's own shape", () => {
    for (const symbol of SYMBOLS) {
      const book = venueBookReadSchema.parse(read(`/api/v1/venue/book?symbol=${symbol}&depth=10`).json);
      expect(book.value.symbol).toBe(symbol);
      venueBestPricesReadSchema.parse(read(`/api/v1/venue/best-prices?symbol=${symbol}`).json);
      venueTradesReadSchema.parse(read(`/api/v1/venue/trades?symbol=${symbol}&limit=30`).json);
      venueCandlesReadSchema.parse(read(`/api/v1/venue/candles?symbol=${symbol}&interval=15m&limit=240`).json);
    }
    for (const symbol of ['BTC-PERP', 'ETH-PERP']) {
      expect(read(`/api/v1/venue/book?symbol=${symbol}&depth=10`).json.value.bids.length).toBeGreaterThan(0);
      expect(read(`/api/v1/venue/trades?symbol=${symbol}&limit=30`).json.value.length).toBeGreaterThan(0);
      expect(read(`/api/v1/venue/candles?symbol=${symbol}&interval=15m&limit=240`).json.value.length).toBeGreaterThan(100);
    }
  });

  it("seeds the trader's balances, positions, orders, fills and history, and their marks agree with the recorded book", () => {
    const owner = '?owner=0x0000000000000000000000000000000000000001';
    expect(asOf(z.array(venueBalanceSchema)).parse(read(`/api/v1/venue/balances${owner}`).json).value.length).toBeGreaterThan(0);
    const positions = asOf(z.array(venuePositionSchema)).parse(read(`/api/v1/venue/positions${owner}`).json).value;
    expect(positions.map((p) => p.symbol)).toEqual(['BTC-PERP', 'ETH-PERP']);
    const best = read('/api/v1/venue/best-prices?symbol=BTC-PERP').json.value;
    const mark = Number(positions[0].markPrice);
    expect(mark).toBeGreaterThanOrEqual(Math.floor(Number(best.bid)));
    expect(mark).toBeLessThanOrEqual(Math.ceil(Number(best.ask)));
    expect(asOf(z.array(venueOrderSchema)).parse(read(`/api/v1/venue/orders/open${owner}`).json).value.length).toBe(3);
    expect(asOf(z.array(venueFillSchema)).parse(read(`/api/v1/venue/fills${owner}&since=2026-01-01T00:00:00Z`).json).value.length).toBe(5);
    expect(venueHistoryPageSchema.parse(read(`/api/v1/venue/orders/history${owner}`).json).orders.length).toBe(8);
    asOf(venueAccountSummarySchema).parse(read(`/api/v1/venue/account-summary${owner}`).json);
    asOf(venueAccountModeSchema).parse(read(`/api/v1/venue/account-mode${owner}`).json);
    expect(asOf(venueLeverageSchema.nullable()).parse(read(`/api/v1/venue/leverage${owner}&symbol=ETH-PERP`).json).value?.leverageBps).toBe(
      50_000,
    );
  });

  it("tells one story of the person's verification: the level, the ladder's held level and the case history agree (#10995)", () => {
    const trpc = (procedure, input) =>
      read(`/api/identity/trpc/${procedure}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`)?.json
        .result.data;
    const status = trpc('kyc.status', { limit: 50 });
    // The room's own check on the reply: every record is the signed-in person's.
    expect(verificationStatus(owner, 50).safeParse(status).success).toBe(true);
    const level = status.tier;
    expect(trpc('kyc.levels.describe', {}).held).toBe(level);
    expect(trpc('kyc.levels.describe', {}).levels.find((l) => l.current)?.level).toBe(level);
    const approved = trpc('kyc.history', { limit: 10 }).cases.filter((c) => c.state === 'approved');
    expect(approved.map((c) => c.tier)).toContain(level);
  });

  it('answers a read asked at another depth from the same market, and nothing for a market it never saw', () => {
    expect(callKey('GET', '/api/v1/venue/book?symbol=BTC-PERP&depth=10')).toBe('GET /api/v1/venue/book?depth=10&symbol=BTC-PERP');
    expect(recordedAnswer('/api/v1/venue/book?symbol=BTC-PERP&depth=7', 'GET', { signedIn: true })?.json.value.symbol).toBe('BTC-PERP');
    expect(recordedAnswer('/api/v1/venue/book?symbol=DOGE-PERP&depth=10', 'GET', { signedIn: true })).toBeNull();
    expect(recordedAnswer('/api/v1/venue/book?symbol=BTC-PERP&depth=10', 'POST', { signedIn: true })).toBeNull();
  });

  it("answers the trader's fee tier, trading session and the venue's fees, a read naming the recorded venue included", () => {
    const owner = '0x31ab745d6806e512dfff8b1c30b5ec53eabbe157';
    expect(venueFeeTierSchema.parse(read(`/api/v1/venue/fee-tier?owner=${owner}`).json).value.schedule).not.toBeNull();
    expect(tradingSessionStatusSchema.parse(read(`/api/v1/venue/session?owner=${owner}`).json)).toMatchObject({ owner, current: null });
    const venueId = RECORDING.calls.signedIn['GET /api/v1/venue/status'].json.venue.id;
    expect(
      venuePublicFeesSchema.parse(recordedAnswer(`/api/v1/venue/fees?venueId=${venueId}`, 'GET', { signedIn: true }).json),
    ).toBeTruthy();
    expect(recordedAnswer('/api/v1/venue/fees?venueId=another-venue', 'GET', { signedIn: true })).toBeNull();
  });

  it('answers the Convert room with no conversions yet, never a failed read', () => {
    expect(venueConvertHistorySchema.parse(read('/api/v1/venue/convert/history?owner=0xabc').json).conversions).toEqual([]);
  });

  it('keeps nothing about the tester the recording was made with', () => {
    const text = JSON.stringify(RECORDING);
    expect(text).not.toMatch(/local-test\.invalid|zenyoda/i);
    expect(Object.keys(RECORDING.calls.signedIn).every((k) => k.startsWith('GET /api/v1/'))).toBe(true);
    // A module read is kept only when it is no sign-in, session, key or device call, and carries no token.
    const trpc = Object.keys(RECORDING.trpc);
    expect(trpc.length).toBeGreaterThan(0);
    for (const k of trpc) expect(k).not.toMatch(/auth\.|session|apikey|webauthn|passkey|token|secret|recover|device|password/i);
    expect(JSON.stringify(RECORDING.trpc)).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
  });
});

describe("the demo world's chain", () => {
  it("answers the wallet read Home and Assets make: the venue network's own gas at one block, at the recording's time", async () => {
    const { readWallet } = await import('../../src/screens/money/where-it-sits.ts');
    const { nativeCurrency } = await import('../../src/features/protocol/wallet/transfer.ts');
    const chainId = read('/api/v1/venue/status').json.chainId;
    const owner = privateKeyToAccount(demoWalletKey()).address;
    const node = async (method, params) => {
      const answer = demoChain(method, params, { chainId, now: DEMO_NOW });
      if (answer.error) throw Object.assign(new Error(answer.error.message), answer.error);
      return answer.result;
    };
    const native = nativeCurrency(chainId);
    expect(native).toEqual({ symbol: 'ETH', decimals: 18 });
    const wallet = await readWallet(node, chainId, owner, [{ address: null, ...native }]);
    expect(wallet).toMatchObject({ ok: true, asOf: new Date(Math.floor(DEMO_NOW / 1000) * 1000).toISOString(), unread: [] });
    expect(wallet.rows).toEqual([{ symbol: 'ETH', token: null, amount: '0.42' }]);
  });

  it('holds nothing for any other address and invents no token balance', () => {
    const chainId = read('/api/v1/venue/status').json.chainId;
    const other = demoChain('eth_getBalance', ['0x0000000000000000000000000000000000000001', 'latest'], { chainId, now: DEMO_NOW });
    expect(BigInt(other.result)).toBe(0n);
    expect(demoChain('eth_call', [{ to: '0x1', data: '0x70a08231' }], { chainId, now: DEMO_NOW }).error).toBeTruthy();
    expect(demoChain('eth_sendRawTransaction', ['0x'], { chainId, now: DEMO_NOW }).error).toBeTruthy();
  });
});
