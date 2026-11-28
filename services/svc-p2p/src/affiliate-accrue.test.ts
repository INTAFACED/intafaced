import { describe, expect, it, vi, afterEach } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import {
  AFFILIATE_PRODUCER_PATH,
  affiliateLegAfterP2pRelease,
  createAffiliateAccrueClient,
  fireAffiliateAccrue,
  NoopAffiliateAccrue,
  type AffiliateP2pFeeLeg,
} from './affiliate-accrue.js';

const SELLER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECRET = 'test-internal-service-secret-32ch!!';
const TRADE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('p2p affiliate accrue legs', () => {
  it('emits one fee-event keyed by trade id; userId is seller', () => {
    expect(
      affiliateLegAfterP2pRelease({
        tradeId: TRADE,
        sellerId: SELLER,
        feeAmount: parseAmount('2.50'),
        feeAsset: 'USDT',
      }),
    ).toEqual([
      {
        userId: SELLER,
        feeAmount: parseAmount('2.50'),
        feeAsset: 'USDT',
        feeEventId: `p2p.release:${TRADE}`,
      },
    ]);
  });

  it('skips zero fees', () => {
    expect(
      affiliateLegAfterP2pRelease({
        tradeId: TRADE,
        sellerId: SELLER,
        feeAmount: 0n,
        feeAsset: 'USDT',
      }),
    ).toEqual([]);
  });
});

describe('fireAffiliateAccrue', () => {
  it('swallows a throw so the release stays posted', async () => {
    const port = {
      accrueP2pFee: async () => {
        throw new Error('identity down');
      },
    };
    await expect(
      fireAffiliateAccrue(port, [
        {
          userId: SELLER,
          feeAmount: parseAmount('1'),
          feeAsset: 'USDT',
          feeEventId: `p2p.release:${TRADE}`,
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

  it('POSTs JSON with sourceModule p2p; 412 is success', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const body = String(init.body);
      calls.push(body);
      expect(init.method).toBe('POST');
      expect(JSON.parse(body)).toEqual({
        feeEventId: `p2p.release:${TRADE}`,
        userId: SELLER,
        feeAmount: '1',
        asset: 'USDT',
        sourceModule: 'p2p',
      });
      expect(String(url)).toBe(`http://identity.example${AFFILIATE_PRODUCER_PATH}`);
      return new Response('{"code":"affiliate.accrual.rates_unset"}', { status: 412 });
    });
    const client = createAffiliateAccrueClient('http://identity.example', SECRET);
    await expect(
      client.accrueP2pFee({
        userId: SELLER,
        feeAmount: parseAmount('1'),
        feeAsset: 'USDT',
        feeEventId: `p2p.release:${TRADE}`,
      }),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('throws on 500 so fireAffiliateAccrue can swallow without unwinding', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }));
    const client = createAffiliateAccrueClient('http://identity.example', SECRET);
    await expect(
      client.accrueP2pFee({
        userId: SELLER,
        feeAmount: parseAmount('1'),
        feeAsset: 'USDT',
        feeEventId: `p2p.release:${TRADE}`,
      } satisfies AffiliateP2pFeeLeg),
    ).rejects.toThrow(/500/);
  });
});
