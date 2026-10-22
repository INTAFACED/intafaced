import { describe, expect, it } from 'vitest';
import { bankCardBalancesSchema, bankCardFundsViewInputSchema, bankCardFundsViewSchema } from './bank-card-funds.js';

const uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const readAt = '2026-10-22T03:00:00Z';
const fundsRow = {
  assetCode: 'USD',
  held: '120.00',
  heldCount: 3,
  captured: '80.00',
  capturedCount: 2,
  ledgerTotal: '200.00',
  difference: '0',
};

describe('card funds contracts (BK-cops-04 read part)', () => {
  it('scopes to programme, business or individual', () => {
    for (const scope of [{ kind: 'programme' }, { kind: 'business', businessId: uuid }, { kind: 'individual', userId: uuid }])
      expect(bankCardFundsViewInputSchema.safeParse({ scope }).success).toBe(true);
    expect(bankCardFundsViewInputSchema.safeParse({ scope: { kind: 'business' } }).success).toBe(false);
    expect(bankCardFundsViewInputSchema.safeParse({ scope: { kind: 'card', cardId: uuid } }).success).toBe(false);
  });
  it('funds view carries decimal strings and a signed difference', () => {
    expect(bankCardFundsViewSchema.parse({ scope: { kind: 'programme' }, readAt, rows: [fundsRow] }).rows[0]).toEqual(fundsRow);
    expect(
      bankCardFundsViewSchema.safeParse({ scope: { kind: 'programme' }, readAt, rows: [{ ...fundsRow, difference: '-1.00' }] }).success,
    ).toBe(true);
  });
  it('refuses JSON numbers, negative amounts, duplicate assets and extra fields', () => {
    for (const row of [
      { ...fundsRow, held: 120 },
      { ...fundsRow, captured: '-1' },
      { ...fundsRow, cardBalance: '1' },
      { ...fundsRow, difference: '1e3' },
    ])
      expect(bankCardFundsViewSchema.safeParse({ scope: { kind: 'programme' }, readAt, rows: [row] }).success).toBe(false);
    expect(bankCardFundsViewSchema.safeParse({ scope: { kind: 'programme' }, readAt, rows: [fundsRow, fundsRow] }).success).toBe(false);
  });
  it('empty rows are an honest empty view', () => {
    expect(bankCardFundsViewSchema.safeParse({ scope: { kind: 'programme' }, readAt, rows: [] }).success).toBe(true);
  });
  it('balances carry ledger, available and pending as decimal strings', () => {
    const row = { assetCode: 'USD', ledger: '200.00', available: '80.00', pending: '120.00' };
    expect(bankCardBalancesSchema.safeParse({ scope: { kind: 'individual', userId: uuid }, readAt, rows: [row] }).success).toBe(true);
    expect(bankCardBalancesSchema.safeParse({ scope: { kind: 'programme' }, readAt, rows: [{ ...row, pending: 1 }] }).success).toBe(false);
    const { available: _a, ...missing } = row;
    expect(bankCardBalancesSchema.safeParse({ scope: { kind: 'programme' }, readAt, rows: [missing] }).success).toBe(false);
    expect(bankCardBalancesSchema.safeParse({ scope: { kind: 'programme' }, readAt, rows: [row, row] }).success).toBe(false);
  });
});
