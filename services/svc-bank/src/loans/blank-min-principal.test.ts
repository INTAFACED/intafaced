/**
 * A blank loan-product floor refuses. It is not stored as 0.
 * An explicit 0n is a real floor. A stored number is read back as that number.
 * A stored blank is a typed refusal, not a generic amount error and not 0.
 */
import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { MemoryLedger, MoneyError, parseAmount, type Amount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { LoanService, assertLoanParams } from './loan-service.js';
import { fixedPriceSource } from './prices.js';
import { DEFAULT_LIQUIDATION_POLICY } from './risk.js';

const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';

const terms = {
  name: 'BTC-backed USDT',
  debtAssetId: 'USDT',
  collateralAssetId: 'BTC',
  quoteAssetId: 'USDT',
  aprBps: 1_000,
  maxLtvBps: 5_000,
  policy: DEFAULT_LIQUIDATION_POLICY,
};

function productRow(minPrincipal: unknown): Record<string, unknown> {
  return {
    id: PRODUCT_ID,
    name: terms.name,
    debt_asset_id: terms.debtAssetId,
    collateral_asset_id: terms.collateralAssetId,
    quote_asset_id: terms.quoteAssetId,
    apr_bps: terms.aprBps,
    max_ltv_bps: terms.maxLtvBps,
    min_principal: minPrincipal,
    margin_call_ltv_bps: terms.policy.marginCallLtvBps,
    liquidation_ltv_bps: terms.policy.liquidationLtvBps,
    insolvency_ltv_bps: terms.policy.insolvencyLtvBps,
    target_ltv_bps: terms.policy.targetLtvBps,
    penalty_bps: terms.policy.penaltyBps,
    max_tranche_bps: terms.policy.maxTrancheBps,
    grace_seconds: terms.policy.graceSeconds,
    status: 'open',
  };
}

function recordingSql(rows: Array<Record<string, unknown>>, calls: unknown[][]): Sql {
  const fn = (_strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push(values);
    return Promise.resolve(rows);
  };
  return fn as unknown as Sql;
}

function service(rows: Array<Record<string, unknown>>, calls: unknown[][]): LoanService {
  return new LoanService(recordingSql(rows, calls), new MemoryLedger(), {
    priceSource: fixedPriceSource({ BTC: { price: '10000' } }),
  });
}

describe('blank loan minPrincipal refuses and is not stored as 0', () => {
  it.each([undefined, null, '', '   '])('createProduct refuses %j before any insert', async (minPrincipal) => {
    const calls: unknown[][] = [];
    const loans = service([], calls);
    const input = { ...terms, ...(minPrincipal === undefined ? {} : { minPrincipal: minPrincipal as unknown as Amount }) };
    const err = await loans.createProduct(input).then(
      () => {
        throw new Error('expected a blank minPrincipal to refuse');
      },
      (caught: unknown) => caught,
    );
    expect(err).toBeInstanceOf(BankError);
    expect(err).toMatchObject({ code: 'bank.loan_params_invalid' });
    expect(calls, 'a blank floor must not be written, including as 0').toEqual([]);
  });

  it('createProduct stores an explicit 0n', async () => {
    const calls: unknown[][] = [];
    const loans = service([productRow('0')], calls);
    const product = await loans.createProduct({ ...terms, minPrincipal: 0n });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('0');
    expect(product.minPrincipal).toBe(0n);
  });

  it('createProductOnce refuses a blank floor before any insert and still accepts 0n', async () => {
    const calls: unknown[][] = [];
    const loans = service([productRow('0')], calls);
    await expect(
      loans.createProductOnce({
        productId: PRODUCT_ID,
        ...terms,
        minPrincipal: undefined as unknown as Amount,
      }),
    ).rejects.toMatchObject({ code: 'bank.loan_params_invalid' });
    expect(calls).toEqual([]);

    const created = await loans.createProductOnce({ productId: PRODUCT_ID, ...terms, minPrincipal: 0n });
    expect(created.replayed).toBe(false);
    expect(created.product.minPrincipal).toBe(0n);
    expect(calls[0]).toContain('0');
  });

  it('assertLoanParams names a blank floor and still allows 0n', () => {
    for (const minPrincipal of [undefined, null, '', '   ']) {
      expect(() => assertLoanParams({ ...terms, minPrincipal: minPrincipal as unknown as Amount })).toThrow(BankError);
      try {
        assertLoanParams({ ...terms, minPrincipal: minPrincipal as unknown as Amount });
      } catch (err) {
        expect(err).toMatchObject({ code: 'bank.loan_params_invalid' });
        expect((err as BankError).message).toContain('minPrincipal is blank');
      }
    }
    expect(() => assertLoanParams({ ...terms, minPrincipal: 0n })).not.toThrow();
    expect(() => assertLoanParams({ ...terms, minPrincipal: -1n })).toThrow(/cannot be negative/);
  });

  it.each([null, undefined, '', '   '])('reading a stored blank floor (%j) is a typed refusal, not 0', async (stored) => {
    const loans = service([productRow(stored)], []);
    const err = await loans.product(PRODUCT_ID).then(
      () => {
        throw new Error('expected a blank stored floor to refuse');
      },
      (caught: unknown) => caught,
    );
    expect(err).toBeInstanceOf(BankError);
    expect(err).not.toBeInstanceOf(MoneyError);
    expect(err).toMatchObject({ code: 'bank.loan_params_invalid' });
  });

  it('reading a stored number keeps that number, including 0', async () => {
    const zero = await service([productRow('0')], []).product(PRODUCT_ID);
    expect(zero.minPrincipal).toBe(0n);
    const floor = await service([productRow('12.5')], []).product(PRODUCT_ID);
    expect(floor.minPrincipal).toBe(parseAmount('12.5'));
  });
});
