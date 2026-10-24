import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import {
  AFFILIATE_PRODUCER_PATH,
  affiliateLegsAfterFill,
  createAffiliateAccrueClient,
  fireAffiliateAccrue,
  NoopAffiliateAccrue,
  type AffiliateFeeLeg,
} from './affiliate-accrue.js';
import { tradeServiceSource } from './trade-service/source.testkit.js';

const HOUSE = '11111111-1111-4111-8111-111111111111';
const MAKER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TAKER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SECRET = 'test-internal-service-secret-32ch!!';

const baseLegs = {
  fillId: 'fill-1',
  makerUserId: MAKER,
  takerUserId: TAKER,
  makerFee: parseAmount('1'),
  takerFee: parseAmount('2'),
  makerFeeAsset: 'USDT',
  takerFeeAsset: 'BTC',
  houseMmUserId: HOUSE,
};

describe('D26-P1-O2 trade affiliate accrue legs', () => {
  it('emits maker+taker fee-events with deterministic ids', () => {
    expect(affiliateLegsAfterFill(baseLegs)).toEqual([
      { userId: MAKER, feeAmount: parseAmount('1'), feeAsset: 'USDT', feeEventId: 'fill-1:maker' },
      { userId: TAKER, feeAmount: parseAmount('2'), feeAsset: 'BTC', feeEventId: 'fill-1:taker' },
    ]);
  });

  it('skips zero fees', () => {
    expect(affiliateLegsAfterFill({ ...baseLegs, makerFee: 0n, takerFee: parseAmount('2') }).map((l) => l.feeEventId)).toEqual([
      'fill-1:taker',
    ]);
  });

  it('skips house MM maker (seed path)', () => {
    expect(affiliateLegsAfterFill({ ...baseLegs, makerUserId: HOUSE }).map((l) => l.userId)).toEqual([TAKER]);
  });
});

describe('fireAffiliateAccrue', () => {
  it('records every leg then swallows a throw so the fill stays posted', async () => {
    const seen: string[] = [];
    const port = {
      accrueTradeFee: async (leg: AffiliateFeeLeg) => {
        seen.push(leg.feeEventId);
        if (leg.feeEventId.endsWith('taker')) throw new Error('identity down');
      },
    };
    await expect(fireAffiliateAccrue(port, affiliateLegsAfterFill(baseLegs))).resolves.toBeUndefined();
    expect(seen).toEqual(['fill-1:maker', 'fill-1:taker']);
  });

  it('Noop never throws', async () => {
    await expect(fireAffiliateAccrue(new NoopAffiliateAccrue(), affiliateLegsAfterFill(baseLegs))).resolves.toBeUndefined();
  });
});

describe('createAffiliateAccrueClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs v2-bound JSON to identity producer path; 412 is success', async () => {
    const calls: Array<{ url: string; body: string; status: number }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const body = String(init.body);
      calls.push({ url: String(url), body, status: 412 });
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({ 'content-type': 'application/json' });
      expect(JSON.parse(body)).toEqual({
        feeEventId: 'fill-1:taker',
        userId: TAKER,
        feeAmount: '2',
        asset: 'BTC',
        sourceModule: 'trade',
      });
      return new Response('{"code":"affiliate.accrual.rates_unset"}', { status: 412 });
    });
    const client = createAffiliateAccrueClient('http://identity.example', SECRET);
    await expect(
      client.accrueTradeFee({
        userId: TAKER,
        feeAmount: parseAmount('2'),
        feeAsset: 'BTC',
        feeEventId: 'fill-1:taker',
      }),
    ).resolves.toBeUndefined();
    expect(calls[0]!.url).toBe(`http://identity.example${AFFILIATE_PRODUCER_PATH}`);
  });

  it('throws on 500 so fireAffiliateAccrue can swallow without unwinding', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }));
    const client = createAffiliateAccrueClient('http://identity.example', SECRET);
    await expect(
      client.accrueTradeFee({
        userId: TAKER,
        feeAmount: parseAmount('2'),
        feeAsset: 'BTC',
        feeEventId: 'fill-1:taker',
      }),
    ).rejects.toThrow(/500/);
  });
});

describe('settleFill wires accrue after ledger post (D26-P1-O2)', () => {
  it('classic tradeFill and MM fill both call notifyAffiliateAccrue after post', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = tradeServiceSource();
    expect(src).toMatch(/notifyAffiliateAccrue/);
    const posts = [...src.matchAll(/await (?:this|svc)\.ledger\.post\(/g)];
    expect(posts.length).toBeGreaterThanOrEqual(2);
    expect(src).toMatch(/recipes\.tradeFill/);
    expect(src).toMatch(/recipes\.marketMakerMakerFill/);
    expect(src).toMatch(/affiliateAccrue/);
    const idx = readFileSync(join(here, '..', 'index.ts'), 'utf8');
    expect(idx).toMatch(/createAffiliateAccrueClient/);
  });
});
