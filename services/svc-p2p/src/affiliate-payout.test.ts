import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { loadP2pEnv } from './testing/env-load-fixture.js';
import {
  AFFILIATE_PRODUCER_PAYOUT_PATH,
  createAffiliatePayoutClient,
  fireAffiliatePayout,
  NoopAffiliatePayout,
} from './affiliate-payout.js';

const SELLER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECRET = 'test-internal-service-secret-32ch!!';
const TRADE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FEE = `p2p.release:${TRADE}`;

const leg = {
  userId: SELLER,
  feeAmount: parseAmount('1'),
  feeAsset: 'USDT',
  feeEventId: FEE,
};

describe('fireAffiliatePayout', () => {
  it('swallows a throw so the release stays posted', async () => {
    const port = {
      payoutP2pFee: async () => {
        throw new Error('identity down');
      },
    };
    await expect(fireAffiliatePayout(port, [leg])).resolves.toBeUndefined();
  });

  it('Noop never throws', async () => {
    await expect(fireAffiliatePayout(new NoopAffiliatePayout(), [leg])).resolves.toBeUndefined();
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
      expect(JSON.parse(body)).toEqual({ feeEventId: FEE });
      expect(Object.keys(JSON.parse(body))).toEqual(['feeEventId']);
      expect(String(url)).toBe(`http://identity.example${AFFILIATE_PRODUCER_PAYOUT_PATH}`);
      return new Response('{"posted":true}', { status: 200 });
    });
    const client = createAffiliatePayoutClient('http://identity.example', SECRET);
    await expect(client.payoutP2pFee(FEE)).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('412 is success (rates unset / unpublished / frozen / nothing accrued)', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"code":"affiliate.payout.rates_unset"}', { status: 412 }));
    const client = createAffiliatePayoutClient('http://identity.example', SECRET);
    await expect(client.payoutP2pFee(FEE)).resolves.toBeUndefined();
  });

  it('throws on 500 so fireAffiliatePayout can swallow without unwinding', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }));
    const client = createAffiliatePayoutClient('http://identity.example', SECRET);
    await expect(client.payoutP2pFee(FEE)).rejects.toThrow(/500/);
  });
});

describe('compose fleet IDENTITY_URL for svc-p2p', () => {
  it('names fleet identity, does not bake P2P_FEE_BPS, does not restamp JWT', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const compose = readFileSync(join(here, '../../../docker-compose.apps.yml'), 'utf8');
    const start = compose.indexOf('\n  svc-p2p:');
    const rest = compose.slice(start + 1);
    const next = rest.search(/\n  svc-[a-z]+:/);
    const block = next === -1 ? rest : rest.slice(0, next);
    expect(block).toMatch(/IDENTITY_URL:\s*http:\/\/svc-identity:4002/);
    expect(block).not.toMatch(/IDENTITY_URL:\s*http:\/\/localhost/);
    expect(block).toMatch(/P2P_FEE_BPS:\s*\$\{P2P_FEE_BPS:-\}/);
    expect(block).not.toMatch(/P2P_FEE_BPS:\s*\$\{P2P_FEE_BPS:-30\}/);
    // env.ts: unset IDENTITY_URL stays unset (the no-op payout port), never a localhost default; a set one must be a URL.
    expect((await loadP2pEnv()).IDENTITY_URL).toBeUndefined();
    expect((await loadP2pEnv({ IDENTITY_URL: 'http://svc-identity:4002' })).IDENTITY_URL).toBe('http://svc-identity:4002');
    await expect(loadP2pEnv({ IDENTITY_URL: 'svc-identity' })).rejects.toThrow(/IDENTITY_URL/);
  });
});
