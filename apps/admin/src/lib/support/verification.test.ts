import { describe, expect, it } from 'vitest';
import { detailAfter, explainVerificationFailure, readVerificationRequest } from './verification';

const T1 = '22222222-2222-4222-8222-222222222222';
const W1 = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';

const refused = (message: string, status = 412) =>
  ({ kind: 'refused', refusal: { message, code: null, status }, requestId: null }) as unknown as Parameters<
    typeof explainVerificationFailure
  >[0];

describe('the gate, as the console sends and reads it', () => {
  it('sends a check of one of the four kinds or one of the three reads, and nothing else', () => {
    expect(readVerificationRequest({ action: 'check', ticketId: T1, kind: 'withdrawal_id', value: ` ${W1} ` })).toEqual({
      action: 'check',
      ticketId: T1,
      kind: 'withdrawal_id',
      value: W1,
    });
    expect(readVerificationRequest({ action: 'check', ticketId: T1, kind: 'email', value: 'ann@example.com' })).toMatchObject({
      kind: 'email',
    });
    expect(readVerificationRequest({ action: 'check', ticketId: T1, kind: 'client_order_id', value: 'my-order-7' })).toMatchObject({
      kind: 'client_order_id',
    });
    expect(readVerificationRequest({ action: 'disclosure', ticketId: T1, what: 'fills' })).toEqual({
      action: 'disclosure',
      ticketId: T1,
      what: 'fills',
    });
    for (const bad of [
      { action: 'check', ticketId: T1, kind: 'code_word', value: 'x' },
      { action: 'check', ticketId: T1, kind: 'deposit_id', value: 'w-1' },
      { action: 'check', ticketId: T1, kind: 'email', value: 'not-an-email' },
      { action: 'disclosure', ticketId: T1, what: 'ledger' },
      { action: 'disclosure', ticketId: 'x', what: 'balance' },
      { action: 'verify', ticketId: T1 },
    ])
      expect(readVerificationRequest(bad)).toBeNull();
  });

  it('reads the detail svc-support put after its code', () => {
    expect(detailAfter('support.verification_checks_required', 'support.verification_checks_required 0 of 2 matched')).toBe(
      '0 of 2 matched',
    );
    const view = explainVerificationFailure(refused('support.verification_checks_required 1 of 2 matched'));
    expect(view).toMatchObject({ code: 'support.verification_checks_required', changed: 'no' });
    expect(view.body).toContain('1 of 2 matched');
    expect(explainVerificationFailure(refused('support.disclosure_unwired svc-identity')).title).toBe(
      'svc-identity serves the desk no door for this yet',
    );
    const mismatch = explainVerificationFailure(refused('support.verification_mismatch', 400));
    expect(mismatch.title).toBe('That does not match');
    expect(explainVerificationFailure(refused('support.verification_attempts_unset')).body).toContain('SUPPORT_VERIFICATION_ATTEMPTS');
  });
});
