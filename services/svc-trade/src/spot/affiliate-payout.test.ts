import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import {
  AFFILIATE_PRODUCER_PAYOUT_PATH,
  createAffiliatePayoutClient,
  fireAffiliatePayout,
  NoopAffiliatePayout,
} from './affiliate-payout.js';
import { affiliateLegsAfterFill } from './affiliate-accrue.js';
import { tradeServiceSource } from './trade-service/source.testkit.js';

const HOUSE = '11111111-1111-4111-8111-111111111111';
const MAKER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TAKER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SECRET = 'test-internal-service-secret-32ch!!';
const FILL = 'fill-1';

const baseLegs = {
  fillId: FILL,
  makerUserId: MAKER,
  takerUserId: TAKER,
  makerFee: parseAmount('1'),
  takerFee: parseAmount('2'),
  makerFeeAsset: 'USDT',
  takerFeeAsset: 'BTC',
  houseMmUserId: HOUSE,
};

const legs = affiliateLegsAfterFill(baseLegs);

describe('fireAffiliatePayout', () => {
  it('swallows a throw so the fill stays posted', async () => {
    const port = {
      payoutTradeFee: async () => {
        throw new Error('identity down');
      },
    };
    await expect(fireAffiliatePayout(port, legs)).resolves.toBeUndefined();
  });

  it('Noop never throws', async () => {
    await expect(fireAffiliatePayout(new NoopAffiliatePayout(), legs)).resolves.toBeUndefined();
  });
});

describe('createAffiliatePayoutClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs { feeEventId } only — no amount, no rate', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const body = String(init.body);
      calls.push(body);
      expect(init.method).toBe('POST');
      expect(JSON.parse(body)).toEqual({ feeEventId: 'fill-1:taker' });
      expect(Object.keys(JSON.parse(body))).toEqual(['feeEventId']);
      expect(String(url)).toBe(`http://identity.example${AFFILIATE_PRODUCER_PAYOUT_PATH}`);
      return new Response('{"posted":true}', { status: 200 });
    });
    const client = createAffiliatePayoutClient('http://identity.example', SECRET);
    await expect(client.payoutTradeFee('fill-1:taker')).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('412 is success (rates unset / unpublished / frozen / nothing accrued)', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"code":"affiliate.payout.rates_unset"}', { status: 412 }));
    const client = createAffiliatePayoutClient('http://identity.example', SECRET);
    await expect(client.payoutTradeFee('fill-1:taker')).resolves.toBeUndefined();
  });

  it('throws on 500 so fireAffiliatePayout can swallow without unwinding', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }));
    const client = createAffiliatePayoutClient('http://identity.example', SECRET);
    await expect(client.payoutTradeFee('fill-1:taker')).rejects.toThrow(/500/);
  });
});

/** Pin: fill posts first, accrue second, payout third. */
describe('settleFill wires payout after accrue after ledger post', () => {
  it('fires payout after accrue, after tradeFill and marketMakerMakerFill', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = tradeServiceSource();
    expect(src).toMatch(/notifyAffiliatePayout/);
    expect(src).toMatch(/notifyAffiliateAccrue/);
    expect(src).toMatch(/recipes\.tradeFill/);
    expect(src).toMatch(/recipes\.marketMakerMakerFill/);
    expect(src.indexOf('notifyAffiliateAccrue')).toBeLessThan(src.indexOf('notifyAffiliatePayout'));
    expect((src.match(/notifyAffiliatePayout/g) ?? []).length).toBeGreaterThanOrEqual(3);
    const idx = readFileSync(join(here, '..', 'index.ts'), 'utf8');
    expect(idx).toMatch(/createAffiliatePayoutClient/);
  });
});
