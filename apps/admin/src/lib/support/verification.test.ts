import { describe, expect, it } from 'vitest';
import { detailAfter, explainVerificationFailure, readVerificationRequest } from './verification';

const T1 = '22222222-2222-4222-8222-222222222222';
const W1 = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';

const refused = (message: string, status = 403) =>
  ({ kind: 'refused', refusal: { message, code: null, status }, requestId: null }) as unknown as Parameters<
    typeof explainVerificationFailure
  >[0];

describe('the gate, as the console sends and reads it', () => {
  it('sends a check or a read, and nothing else', () => {
    expect(readVerificationRequest({ action: 'check', ticketId: T1, recordKind: 'withdrawal', recordId: W1 })).toEqual({
      action: 'check',
      ticketId: T1,
      recordKind: 'withdrawal',
      recordId: W1.toLowerCase(),
    });
    expect(readVerificationRequest({ action: 'disclosure', ticketId: T1, what: 'balance' })).toEqual({
      action: 'disclosure',
      ticketId: T1,
      what: 'balance',
    });
    for (const bad of [
      { action: 'check', ticketId: T1, recordKind: 'payment', recordId: W1 },
      { action: 'check', ticketId: T1, recordKind: 'deposit', recordId: 'w-1' },
      { action: 'disclosure', ticketId: T1, what: 'ledger' },
      { action: 'disclosure', ticketId: 'x', what: 'balance' },
      { action: 'verify', ticketId: T1 },
    ])
      expect(readVerificationRequest(bad)).toBeNull();
  });

  it('reads the detail svc-support put after its code', () => {
    expect(detailAfter('support.verification_checks_required', 'support.verification_checks_required 0 of 2 recorded')).toBe(
      '0 of 2 recorded',
    );
    const view = explainVerificationFailure(refused('support.verification_checks_required 1 of 2 recorded'));
    expect(view).toMatchObject({ code: 'support.verification_checks_required', changed: 'no' });
    expect(view.body).toContain('1 of 2 recorded');
    const owner = explainVerificationFailure(refused('support.verification_check_owner_unwired svc-pay', 412));
    expect(owner.title).toBe('svc-pay cannot confirm records yet');
    expect(explainVerificationFailure(refused('support.balance_read_unwired', 412)).title).toBe('The desk has no balance read');
  });
});
