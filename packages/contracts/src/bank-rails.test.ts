import { describe, expect, it } from 'vitest';
import { BANK_RAIL_STATES, BANK_RAILS, bankAliasRegisterInputSchema, bankRailSendInputSchema } from './bank-rails.js';

const send = {
  rail: 'ach',
  draftSeq: 0,
  fromSpaceId: '00000000-0000-4000-8000-000000000001',
  amount: '10',
  destinationId: 'dest-1',
};

describe('BK-xfer-02 bank rails contracts', () => {
  it('names the four rails and the five states', () => {
    expect(BANK_RAILS).toEqual(['ach', 'wire', 'instant', 'sepa']);
    expect(BANK_RAIL_STATES).toEqual(['pending', 'confirmed', 'auto_cancelled', 'failed', 'returned']);
  });
  it('accepts a send and refuses a zero amount, an unknown rail, and a client-sent key', () => {
    expect(bankRailSendInputSchema.safeParse(send).success).toBe(true);
    expect(bankRailSendInputSchema.safeParse({ ...send, amount: '0' }).success).toBe(false);
    expect(bankRailSendInputSchema.safeParse({ ...send, rail: 'swift' }).success).toBe(false);
    expect(bankRailSendInputSchema.safeParse({ ...send, idempotencyKey: 'x' }).success).toBe(false);
  });
  it('alias kinds are phone, email and handle only', () => {
    expect(bankAliasRegisterInputSchema.safeParse({ kind: 'email', value: 'a@b.c', idempotencyKey: 'k' }).success).toBe(true);
    expect(bankAliasRegisterInputSchema.safeParse({ kind: 'iban', value: 'x', idempotencyKey: 'k' }).success).toBe(false);
  });
});
