import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import {
  AFFILIATE_PRODUCER_PATH,
  affiliateLegAfterPaySettlement,
  createAffiliateAccrueClient,
  fireAffiliateAccrue,
  NoopAffiliateAccrue,
  type AffiliatePayFeeLeg,
} from './affiliate-accrue.js';

const MERCHANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECRET = 'test-internal-service-secret-32ch!!';
const SETTLEMENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('D26-P1-O2 pay affiliate accrue legs', () => {
  it('emits one fee-event keyed by settlement id', () => {
    expect(
      affiliateLegAfterPaySettlement({
        settlementId: SETTLEMENT,
        merchantUserId: MERCHANT,
        feeAmount: parseAmount('2.50'),
        feeAsset: 'USDT',
      }),
    ).toEqual([
      {
        userId: MERCHANT,
        feeAmount: parseAmount('2.50'),
        feeAsset: 'USDT',
        feeEventId: `pay.settle:${SETTLEMENT}`,
      },
    ]);
  });

  it('skips zero fees', () => {
    expect(
      affiliateLegAfterPaySettlement({
        settlementId: SETTLEMENT,
        merchantUserId: MERCHANT,
        feeAmount: 0n,
        feeAsset: 'USDT',
      }),
    ).toEqual([]);
  });
});

describe('fireAffiliateAccrue', () => {
  it('swallows a throw so the settlement stays posted', async () => {
    const port = {
      accruePayFee: async () => {
        throw new Error('identity down');
      },
    };
    await expect(
      fireAffiliateAccrue(port, [
        {
          userId: MERCHANT,
          feeAmount: parseAmount('1'),
          feeAsset: 'USDT',
          feeEventId: `pay.settle:${SETTLEMENT}`,
        },
      ]),
    ).resolves.toBeUndefined();
  });

  it('Noop never throws', async () => {
    await expect(fireAffiliateAccrue(new NoopAffiliateAccrue(), [])).resolves.toBeUndefined();
  });
});

describe('createAffiliateAccrueClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs v2-bound JSON with sourceModule pay; 412 is success', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const body = String(init.body);
      calls.push(body);
      expect(init.method).toBe('POST');
      expect(JSON.parse(body)).toEqual({
        feeEventId: `pay.settle:${SETTLEMENT}`,
        userId: MERCHANT,
        feeAmount: '1',
        asset: 'USDT',
        sourceModule: 'pay',
      });
      expect(String(url)).toBe(`http://identity.example${AFFILIATE_PRODUCER_PATH}`);
      return new Response('{"code":"affiliate.accrual.rates_unset"}', { status: 412 });
    });
    const client = createAffiliateAccrueClient('http://identity.example', SECRET);
    await expect(
      client.accruePayFee({
        userId: MERCHANT,
        feeAmount: parseAmount('1'),
        feeAsset: 'USDT',
        feeEventId: `pay.settle:${SETTLEMENT}`,
      }),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('throws on 500 so fireAffiliateAccrue can swallow without unwinding', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }));
    const client = createAffiliateAccrueClient('http://identity.example', SECRET);
    await expect(
      client.accruePayFee({
        userId: MERCHANT,
        feeAmount: parseAmount('1'),
        feeAsset: 'USDT',
        feeEventId: `pay.settle:${SETTLEMENT}`,
      } satisfies AffiliatePayFeeLeg),
    ).rejects.toThrow(/500/);
  });
});

describe('postPendingSettlement wires accrue after ledger post (D26-P1-O2)', () => {
  it('fires accrue after merchantSettlement, not before', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    // postPendingSettlement lives in payment-service/settlement.ts since the split by area.
    const src = readFileSync(join(here, 'payment-service', 'settlement.ts'), 'utf8');
    expect(src).toMatch(/notifyPayAffiliateAccrue/);
    expect(src).toMatch(/recipes\.merchantSettlement/);
    expect(src.indexOf('recipes.merchantSettlement')).toBeLessThan(src.indexOf('notifyPayAffiliateAccrue'));
    const idx = readFileSync(join(here, 'index.ts'), 'utf8');
    expect(idx).toMatch(/createAffiliateAccrueClient/);
  });
});
