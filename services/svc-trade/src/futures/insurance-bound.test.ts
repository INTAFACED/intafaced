/**
 * Insurance shortfall bound — the MECHANISM, not fund capitalisation policy.
 *
 * Proves: recipe-derived account, zero shortfall always ok, underfunded refuses
 * with the account named, funded shortfall passes. No target size is invented.
 */
import { describe, expect, it } from 'vitest';
import { MemoryLedger, insuranceFund, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { INSURANCE_UNDERFUNDED, checkInsuranceBound, recipeInsuranceAccount } from './insurance-bound.js';
import { formatAccountRef } from './profit-source.js';

const USER = '11111111-1111-4111-8111-111111111111';

describe('recipeInsuranceAccount', () => {
  it('reads the insurance credit leg off futuresRealizeLoss rather than restating it', () => {
    const derived = recipeInsuranceAccount('USDT');
    expect(derived).toEqual(insuranceFund('USDT'));
    const probe = recipes.futuresRealizeLoss({
      positionId: '00000000-0000-4000-8000-000000000000',
      userId: USER,
      assetId: 'USDT',
      fromMargin: 0n,
      fromInsurance: amt('1'),
      lossId: 'probe',
    });
    const credit = probe.entries.find((e) => e.direction === 'credit' && e.account.ownerId === 'insurance-fund')!;
    expect(derived).toEqual(credit.account);
  });
});

describe('checkInsuranceBound', () => {
  /** Fund insurance via futuresInsuranceTopup after seeding the trade fees pot. */
  async function ledgerWithInsurance(amount: string) {
    const ledger = new MemoryLedger();
    if (amount === '0') return ledger;
    const seed = amt(amount);
    await ledger.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: seed, rail: 'test', railRef: `d-${amount}` }));
    await ledger.post(
      recipes.feeCharge({
        chargeId: `fee-${amount}`,
        userId: USER,
        module: 'trade',
        mode: 'asset',
        assetId: 'USDT',
        amount: seed,
      }),
    );
    await ledger.post(recipes.futuresInsuranceTopup({ topupId: `top-${amount}`, assetId: 'USDT', amount: seed }));
    expect((await ledger.balance(insuranceFund('USDT'))).amount).toBe(seed);
    return ledger;
  }

  it('passes when fromInsurance is zero without caring about the pot', async () => {
    const ledger = new MemoryLedger();
    const check = await checkInsuranceBound({
      assetId: 'USDT',
      fromInsurance: 0n,
      balance: (ref) => ledger.balance(ref),
    });
    expect(check.ok).toBe(true);
  });

  it('refuses when the shortfall exceeds the named fund balance', async () => {
    const ledger = await ledgerWithInsurance('0');
    const check = await checkInsuranceBound({
      assetId: 'USDT',
      fromInsurance: amt('1'),
      balance: (ref) => ledger.balance(ref),
    });
    expect(check.ok).toBe(false);
    expect(check.available).toBe(0n);
    expect(check.reason).toContain(formatAccountRef(insuranceFund('USDT')));
    expect(check.reason).toContain('refusing rather than overdrawing');
  });

  it('passes when the fund covers the shortfall exactly', async () => {
    const ledger = await ledgerWithInsurance('10');
    const check = await checkInsuranceBound({
      assetId: 'USDT',
      fromInsurance: amt('10'),
      balance: (ref) => ledger.balance(ref),
    });
    expect(check.ok).toBe(true);
    expect(check.available).toBe(amt('10'));
  });

  it('refuses a shortfall one unit past the fund', async () => {
    const ledger = await ledgerWithInsurance('10');
    const check = await checkInsuranceBound({
      assetId: 'USDT',
      fromInsurance: amt('10') + 1n,
      balance: (ref) => ledger.balance(ref),
    });
    expect(check.ok).toBe(false);
  });

  it('exports a stable refuse code for tick + close', () => {
    expect(INSURANCE_UNDERFUNDED).toBe('trade.insurance_underfunded');
  });
});
