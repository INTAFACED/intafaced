/**
 * DIRECTION:33 listing gate — empty fund → no real-money futures list.
 * Does not invent a capitalisation target; any positive balance passes.
 */
import { describe, expect, it } from 'vitest';
import { MemoryLedger, insuranceFund, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { checkInsuranceFundedForListing, INSURANCE_FUND_EMPTY, presentInsuranceListingPolicy } from './insurance-listing-gate.js';
import { formatAccountRef } from './profit-source.js';

const USER = '11111111-1111-4111-8111-111111111111';

async function ledgerWithInsurance(amount: string) {
  const ledger = new MemoryLedger();
  if (amount === '0') return ledger;
  const seed = amt(amount);
  const pos = 'seed-pos';
  await ledger.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: seed, rail: 'test', railRef: `d-${amount}` }));
  await ledger.post(recipes.futuresMarginLock({ positionId: pos, userId: USER, assetId: 'USDT', amount: seed }));
  await ledger.post(
    recipes.futuresRealizeLoss({
      positionId: pos,
      userId: USER,
      assetId: 'USDT',
      fromMargin: seed,
      fromInsurance: 0n,
      lossId: `seed-loss-${amount}`,
    }),
  );
  await ledger.post(recipes.futuresInsuranceTopup({ topupId: `top-${amount}`, assetId: 'USDT', amount: seed }));
  expect((await ledger.balance(insuranceFund('USDT'))).amount).toBe(seed);
  return ledger;
}

describe('checkInsuranceFundedForListing', () => {
  it('skips the pot for spot listings', async () => {
    const ledger = new MemoryLedger();
    const check = await checkInsuranceFundedForListing({
      kind: 'spot',
      status: 'active',
      paper: false,
      quoteAsset: 'USDT',
      balance: (ref) => ledger.balance(ref),
    });
    expect(check.ok).toBe(true);
  });

  it('allows paper futures with an empty fund', async () => {
    const ledger = new MemoryLedger();
    const check = await checkInsuranceFundedForListing({
      kind: 'futures',
      status: 'active',
      paper: true,
      quoteAsset: 'USDT',
      balance: (ref) => ledger.balance(ref),
    });
    expect(check.ok).toBe(true);
  });

  it('allows pending futures with an empty fund (model without open risk)', async () => {
    const ledger = new MemoryLedger();
    const check = await checkInsuranceFundedForListing({
      kind: 'futures',
      status: 'pending',
      paper: false,
      quoteAsset: 'USDT',
      balance: (ref) => ledger.balance(ref),
    });
    expect(check.ok).toBe(true);
  });

  it('refuses active real-money futures when the fund is empty', async () => {
    const ledger = new MemoryLedger();
    const check = await checkInsuranceFundedForListing({
      kind: 'futures',
      status: 'active',
      paper: false,
      quoteAsset: 'USDT',
      balance: (ref) => ledger.balance(ref),
    });
    expect(check.ok).toBe(false);
    if (check.ok) throw new Error('expected refuse');
    expect(check.code).toBe(INSURANCE_FUND_EMPTY);
    expect(check.available).toBe(0n);
    expect(check.reason).toContain(formatAccountRef(insuranceFund('USDT')));
    expect(check.reason).toContain('positive balance');
  });

  it('passes when the fund holds any positive balance — no invented target size', async () => {
    const ledger = await ledgerWithInsurance('0.000000000000000001');
    const check = await checkInsuranceFundedForListing({
      kind: 'futures',
      status: 'active',
      paper: false,
      quoteAsset: 'USDT',
      balance: (ref) => ledger.balance(ref),
    });
    expect(check.ok).toBe(true);
    if (!check.ok) throw new Error('expected ok');
    expect(check.available).toBe(1n);
  });

  it('exports a stable refuse code distinct from shortfall underfunded', () => {
    expect(INSURANCE_FUND_EMPTY).toBe('trade.insurance_fund_empty');
    expect(INSURANCE_FUND_EMPTY).not.toBe('trade.insurance_underfunded');
  });

  it('policy note never invents a target size and always blocks empty live list', () => {
    const p = presentInsuranceListingPolicy();
    expect(p.emptyPotBlocksLiveList).toBe(true);
    expect(p.targetSize).toBe('owner_unset');
  });
});
