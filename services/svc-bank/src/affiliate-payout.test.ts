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
import { composeServiceBlock } from '@intafaced/config/compose';

const BORROWER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECRET = 'test-internal-service-secret-32ch!!';
const LOAN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const FEE = `bank.repay:${LOAN}:3`;

const leg = {
  userId: BORROWER,
  feeAmount: parseAmount('1'),
  feeAsset: 'USDT',
  feeEventId: FEE,
};

describe('fireAffiliatePayout', () => {
  it('swallows a throw so the loan post stays posted', async () => {
    const port = {
      payoutBankFee: async () => {
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
    await expect(client.payoutBankFee(FEE)).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('412 is success (rates unset / unpublished / frozen / nothing accrued)', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"code":"affiliate.payout.rates_unset"}', { status: 412 }));
    const client = createAffiliatePayoutClient('http://identity.example', SECRET);
    await expect(client.payoutBankFee(FEE)).resolves.toBeUndefined();
  });

  it('throws on 500 so fireAffiliatePayout can swallow without unwinding', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }));
    const client = createAffiliatePayoutClient('http://identity.example', SECRET);
    await expect(client.payoutBankFee(FEE)).rejects.toThrow(/500/);
  });
});

/** Pin: ledger posts first, accrue second, payout third. */
describe('LoanService wires payout after accrue after ledger post', () => {
  it('fires payout after accrue, after loanRepay and loanLiquidate', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'loans/loan-service.ts'), 'utf8');
    expect(src).toMatch(/notifyBankAffiliatePayout/);
    expect(src).toMatch(/notifyBankAffiliateAccrue/);
    expect(src).toMatch(/recipes\.loanRepay/);
    expect(src).toMatch(/recipes\.loanLiquidate/);
    expect(src.indexOf('recipes.loanRepay')).toBeLessThan(src.indexOf('notifyBankAffiliateAccrue'));
    expect(src.indexOf('notifyBankAffiliateAccrue')).toBeLessThan(src.indexOf('notifyBankAffiliatePayout'));
    expect(src.indexOf('recipes.loanLiquidate')).toBeLessThan(src.lastIndexOf('notifyBankAffiliateAccrue'));
    expect(src.lastIndexOf('notifyBankAffiliateAccrue')).toBeLessThan(src.lastIndexOf('notifyBankAffiliatePayout'));
    const idx = readFileSync(join(here, 'index.ts'), 'utf8');
    expect(idx).toMatch(/createAffiliatePayoutClient/);
  });
});

describe('compose fleet IDENTITY_URL for svc-bank', () => {
  it('names fleet identity, does not bake loan rates, does not restamp JWT or #2194 keys', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const compose = readFileSync(join(here, '../../../docker-compose.apps.yml'), 'utf8');
    const block = composeServiceBlock(compose, 'svc-bank');
    expect(block).toMatch(/SERVICE_NAME:\s*svc-bank/);
    expect(block).toMatch(/IDENTITY_URL:\s*http:\/\/svc-identity:4002/);
    expect(block).not.toMatch(/IDENTITY_URL:\s*http:\/\/localhost/);
    expect(block).not.toMatch(/P2P_FEE_BPS:/);
    expect(block).not.toMatch(/PAY_DEFAULT_FEE_BPS:/);
    const jwtTtl = block.match(/^\s+JWT_ACCESS_TTL_SECONDS:/gm) ?? [];
    expect(jwtTtl).toHaveLength(1);
    // #2194 already put these on the bank block. This pin must keep them
    // (host `.env` pass-through, no rates) — not forbid them as "restamp".
    expect(block).toMatch(/LOAN_QUOTE_ASSET_ID:\s*\$\{LOAN_QUOTE_ASSET_ID:-\}/);
    expect(block).not.toMatch(/LOAN_QUOTE_ASSET_ID:\s*\$\{LOAN_QUOTE_ASSET_ID:-USDT\}/);
    expect(block).toMatch(/LOAN_SWEEP_BATCH_SIZE:\s*\$\{LOAN_SWEEP_BATCH_SIZE:-\}/);
    expect(block.match(/^\s+LOAN_QUOTE_ASSET_ID:/gm) ?? []).toHaveLength(1);
    expect(block.match(/^\s+LOAN_SWEEP_BATCH_SIZE:/gm) ?? []).toHaveLength(1);
    const envTs = readFileSync(join(here, 'env.ts'), 'utf8');
    expect(envTs).toMatch(/IDENTITY_URL:\s*z\.string\(\)\.url\(\)\.optional\(\)/);
    expect(envTs).not.toMatch(/IDENTITY_URL:[\s\S]{0,80}\.default\(/);
  });
});
