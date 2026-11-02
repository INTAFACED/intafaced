import { describe, expect, it } from 'vitest';
import {
  matchedVerificationCount,
  SUPPORT_DISCLOSURE_OWNER,
  SUPPORT_VERIFICATION_CHECK_KINDS,
  SUPPORT_VERIFICATION_CHECK_OWNER,
  SUPPORT_VERIFICATION_CHECKS_REQUIRED,
  SUPPORT_VERIFICATION_ERROR_CODES,
  supportDisclosureReadInputSchema,
  supportRecordVerificationCheckInputSchema,
  supportTicketOnlyInputSchema,
  supportVerificationChecksSchema,
  supportVerificationCheckSchema,
} from './support-verification-checks.js';
import * as root from './index.js';

const TICKET = '11111111-1111-4111-8111-111111111111';
const RECORD = '22222222-2222-4222-8222-222222222222';
const check = { ticketId: TICKET, kind: 'email', matched: true, checkedBy: 'op-1', checkedAt: '2026-11-02T02:00:00.000Z' };

describe('the balance disclosure gate (RC-support-public-01)', () => {
  it('has the four kinds the spec names, each answered by the service that owns the fact', () => {
    expect(SUPPORT_VERIFICATION_CHECKS_REQUIRED).toBe(2);
    expect(SUPPORT_VERIFICATION_CHECK_KINDS).toEqual(['email', 'client_order_id', 'withdrawal_id', 'deposit_id']);
    expect(SUPPORT_VERIFICATION_CHECK_OWNER).toEqual({
      email: 'svc-identity',
      client_order_id: 'svc-trade',
      withdrawal_id: 'svc-pay',
      deposit_id: 'svc-pay',
    });
    expect(SUPPORT_DISCLOSURE_OWNER).toEqual({ balance: 'svc-ledger', fills: 'svc-trade', destination: 'svc-pay' });
    expect(SUPPORT_VERIFICATION_ERROR_CODES).toContain('support.verification_checks_required');
  });

  it('a check takes a ticket, a kind and a value of that kind, and never a user id', () => {
    const ok = (input: unknown) => supportRecordVerificationCheckInputSchema.safeParse(input).success;
    expect(ok({ ticketId: TICKET, kind: 'email', value: ' Ann@Example.com ' })).toBe(true);
    expect(ok({ ticketId: TICKET, kind: 'email', value: 'not an email' })).toBe(false);
    expect(ok({ ticketId: TICKET, kind: 'client_order_id', value: 'my-order-7' })).toBe(true);
    expect(ok({ ticketId: TICKET, kind: 'client_order_id', value: 'has space' })).toBe(false);
    expect(ok({ ticketId: TICKET, kind: 'withdrawal_id', value: RECORD })).toBe(true);
    expect(ok({ ticketId: TICKET, kind: 'deposit_id', value: 'abc' })).toBe(false);
    expect(ok({ ticketId: TICKET, kind: 'code_word', value: 'x' })).toBe(false);
    expect(ok({ ticketId: TICKET, kind: 'withdrawal_id', value: RECORD, userId: RECORD })).toBe(false);
    expect(supportTicketOnlyInputSchema.safeParse({ ticketId: TICKET, userId: RECORD }).success).toBe(false);
    expect(supportDisclosureReadInputSchema.safeParse({ ticketId: TICKET, kind: 'fills' }).success).toBe(true);
    expect(supportDisclosureReadInputSchema.safeParse({ ticketId: TICKET, kind: 'card' }).success).toBe(false);
  });

  it('a stored check holds no value and no digest', () => {
    expect(supportVerificationCheckSchema.safeParse(check).success).toBe(true);
    expect(supportVerificationCheckSchema.safeParse({ ...check, value: 'ann@example.com' }).success).toBe(false);
    expect(supportVerificationCheckSchema.safeParse({ ...check, valueDigest: 'ab' }).success).toBe(false);
    expect(supportVerificationCheckSchema.safeParse({ ...check, checkedBy: 'x'.repeat(129) }).success).toBe(false);
    expect(
      supportVerificationChecksSchema.safeParse({ required: 2, matched: 1, attemptsAllowed: null, attemptsUsed: 0, checks: [check] })
        .success,
    ).toBe(true);
  });

  it('counts the email and any one record id; two record ids, or unmatched checks, are not two', () => {
    const c = (kind: (typeof SUPPORT_VERIFICATION_CHECK_KINDS)[number], matched = true) => ({ kind, matched });
    expect(matchedVerificationCount([])).toBe(0);
    expect(matchedVerificationCount([c('email')])).toBe(1);
    expect(matchedVerificationCount([c('withdrawal_id'), c('deposit_id')])).toBe(1);
    expect(matchedVerificationCount([c('email'), c('deposit_id', false)])).toBe(1);
    expect(matchedVerificationCount([c('email'), c('client_order_id')])).toBe(2);
    expect(matchedVerificationCount([c('email'), c('email'), c('withdrawal_id'), c('deposit_id')])).toBe(2);
  });

  it('is exported from the package root', () => {
    expect(root.matchedVerificationCount).toBe(matchedVerificationCount);
  });
});
