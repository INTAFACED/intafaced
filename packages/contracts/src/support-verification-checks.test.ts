import { describe, expect, it } from 'vitest';
import {
  SUPPORT_CHECK_RECORD_OWNER,
  SUPPORT_VERIFICATION_CHECK_KINDS,
  SUPPORT_VERIFICATION_CHECKS_REQUIRED,
  SUPPORT_VERIFICATION_ERROR_CODES,
  supportRecordVerificationCheckInputSchema,
  supportTicketOnlyInputSchema,
  supportVerificationChecksSchema,
  supportVerificationCheckSchema,
} from './support-verification-checks.js';
import { SUPPORT_OWNED_RECORD_KINDS } from './support-record-ownership.js';
import * as root from './index.js';

const TICKET = '11111111-1111-4111-8111-111111111111';
const RECORD = '22222222-2222-4222-8222-222222222222';
const check = {
  ticketId: TICKET,
  kind: 'owned_record',
  recordKind: 'withdrawal',
  recordId: RECORD,
  recordedBy: 'op-1',
  recordedAt: '2026-11-02T02:00:00.000Z',
};

describe('the balance disclosure gate', () => {
  it('needs two checks, of the one kind a service can prove', () => {
    expect(SUPPORT_VERIFICATION_CHECKS_REQUIRED).toBe(2);
    expect(SUPPORT_VERIFICATION_CHECK_KINDS).toEqual(['owned_record']);
    expect(SUPPORT_CHECK_RECORD_OWNER).toEqual({ order: 'svc-trade', withdrawal: 'svc-pay', deposit: 'svc-pay' });
    // Every svc-pay record kind is one svc-pay's ownership door answers.
    for (const [kind, owner] of Object.entries(SUPPORT_CHECK_RECORD_OWNER))
      if (owner === 'svc-pay') expect(SUPPORT_OWNED_RECORD_KINDS).toContain(kind);
  });

  it('a disclosure read takes a ticket and nothing else', () => {
    expect(supportTicketOnlyInputSchema.parse({ ticketId: TICKET })).toEqual({ ticketId: TICKET });
    expect(supportTicketOnlyInputSchema.safeParse({ ticketId: TICKET, userId: RECORD }).success).toBe(false);
  });

  it('a check names a record and never a customer, an amount or an operator-chosen verdict', () => {
    const input = { ticketId: TICKET, kind: 'owned_record', recordKind: 'deposit', recordId: RECORD };
    expect(supportRecordVerificationCheckInputSchema.parse(input)).toEqual(input);
    for (const extra of [{ userId: RECORD }, { verified: true }, { amount: '1' }])
      expect(supportRecordVerificationCheckInputSchema.safeParse({ ...input, ...extra }).success).toBe(false);
    expect(supportRecordVerificationCheckInputSchema.safeParse({ ...input, kind: 'operator_says_so' }).success).toBe(false);
    expect(supportRecordVerificationCheckInputSchema.safeParse({ ...input, recordId: 'w-1' }).success).toBe(false);
    expect(supportVerificationCheckSchema.parse(check)).toEqual(check);
    expect(supportVerificationCheckSchema.safeParse({ ...check, amount: '1' }).success).toBe(false);
    expect(supportVerificationChecksSchema.parse({ required: 2, checks: [check] }).checks).toHaveLength(1);
    expect(supportVerificationChecksSchema.safeParse({ required: 1, checks: [] }).success).toBe(false);
  });

  it('names its refusals, and exports from the package root', () => {
    expect(SUPPORT_VERIFICATION_ERROR_CODES).toContain('support.verification_checks_required');
    expect(SUPPORT_VERIFICATION_ERROR_CODES).toContain('support.balance_read_unwired');
    expect(root.supportTicketOnlyInputSchema).toBe(supportTicketOnlyInputSchema);
  });
});
