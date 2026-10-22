import { describe, expect, it } from 'vitest';
import {
  BANK_PROGRAMME_REFUSAL_CODES,
  bankProgrammeFundingModelSetInputSchema,
  bankProgrammeFundingModelViewSchema,
  bankProgrammeTransferInputSchema,
  bankProgrammeTransferSchema,
} from './bank-programme-funding.js';

const uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const requestId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const at = '2026-10-22T09:00:00Z';
const transferIn = {
  from: { kind: 'programme' },
  to: { kind: 'business', businessId: uuid },
  assetCode: 'USD',
  amount: '25.00',
  requestId,
};

describe('programme funding contracts (BK-cops-04 second part)', () => {
  it('names the three refusal codes', () => {
    expect([...BANK_PROGRAMME_REFUSAL_CODES]).toEqual([
      'bank.programme_limit_unset',
      'bank.programme_transfer_asset_mismatch',
      'bank.funding_model_not_wired',
    ]);
  });

  it('funding model view: jit current and wired; the current model must be wired', () => {
    const view = {
      current: 'jit',
      explanation: 'Spend is held and captured from the customer balance.',
      wired: ['jit'],
      changedAt: null,
      changedBy: null,
    };
    expect(bankProgrammeFundingModelViewSchema.safeParse(view).success).toBe(true);
    expect(bankProgrammeFundingModelViewSchema.safeParse({ ...view, current: 'credit' }).success).toBe(false);
    expect(bankProgrammeFundingModelViewSchema.safeParse({ ...view, current: 'debit' }).success).toBe(false);
    expect(bankProgrammeFundingModelViewSchema.safeParse({ ...view, wired: [] }).success).toBe(false);
  });

  it('funding model set needs an approval, an operation and a reason', () => {
    const set = { model: 'prefunded_pooled', reason: 'TEST move to pooled funding', approvalId: 'appr-1', operationId: 'op-1' };
    expect(bankProgrammeFundingModelSetInputSchema.safeParse(set).success).toBe(true);
    for (const bad of [
      { ...set, approvalId: undefined },
      { ...set, operationId: '' },
      { ...set, reason: 'short' },
      { ...set, model: 'none' },
      { ...set, extra: 1 },
    ])
      expect(bankProgrammeFundingModelSetInputSchema.safeParse(bad).success).toBe(false);
  });

  it('programme transfer input: decimal string above zero, distinct sides, no extras', () => {
    expect(bankProgrammeTransferInputSchema.safeParse(transferIn).success).toBe(true);
    for (const bad of [
      { ...transferIn, amount: 25 },
      { ...transferIn, amount: '0' },
      { ...transferIn, amount: '0.000' },
      { ...transferIn, amount: '-1' },
      { ...transferIn, to: { kind: 'programme' } },
      { ...transferIn, requestId: 'not-a-uuid' },
      { ...transferIn, limit: '100' },
    ])
      expect(bankProgrammeTransferInputSchema.safeParse(bad).success).toBe(false);
  });

  it('a posted transfer has a ledger tx; an unknown one has none', () => {
    const t = { ...transferIn, status: 'posted', ledgerTxId: 'tx-1', createdAt: at };
    expect(bankProgrammeTransferSchema.safeParse(t).success).toBe(true);
    expect(bankProgrammeTransferSchema.safeParse({ ...t, status: 'unknown', ledgerTxId: null }).success).toBe(true);
    expect(bankProgrammeTransferSchema.safeParse({ ...t, ledgerTxId: null }).success).toBe(false);
    expect(bankProgrammeTransferSchema.safeParse({ ...t, status: 'unknown' }).success).toBe(false);
  });
});
