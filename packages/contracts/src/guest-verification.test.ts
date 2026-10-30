import { describe, expect, it } from 'vitest';
import {
  GUEST_VERIFICATION_CALLERS,
  GUEST_VERIFICATION_PROCEDURES,
  guestVerificationEraseInputSchema,
  guestVerificationGetInputSchema,
  guestVerificationKey,
  guestVerificationReceiptSchema,
  guestVerificationSendInputSchema,
} from './guest-verification.js';
import { guestNotificationCodeSchema } from './guest-notifications.js';
import { SERVICE_NAMES } from './service-keys.js';
import * as root from './index.js';

const REQUEST = '11111111-1111-4111-8111-111111111111';
const send = {
  businessKey: guestVerificationKey(REQUEST, 1),
  guestRequestId: REQUEST,
  recipientEmail: 'guest@example.org',
  link: 'https://app.example.org/support/guest/verify?token=abc',
  tokenId: 'tok_12345678',
  expiresAt: '2026-10-31T12:00:00.000Z',
};

describe('guest verification door (ADR 2026-10-22 §3.5)', () => {
  it('names svc-support as its only caller, a real service', () => {
    expect(GUEST_VERIFICATION_CALLERS).toEqual(['svc-support']);
    for (const caller of GUEST_VERIFICATION_CALLERS) expect(SERVICE_NAMES).toContain(caller);
    expect(Object.values(GUEST_VERIFICATION_PROCEDURES)).toEqual([
      'guestVerification.send',
      'guestVerification.get',
      'guestVerification.erase',
    ]);
  });

  it('takes one key per request and ordinal, for that request only', () => {
    expect(guestVerificationSendInputSchema.parse(send)).toEqual(send);
    expect(guestVerificationSendInputSchema.safeParse({ ...send, businessKey: guestVerificationKey(REQUEST, 0) }).success).toBe(false);
    expect(
      guestVerificationSendInputSchema.safeParse({ ...send, businessKey: guestVerificationKey('22222222-2222-4222-8222-222222222222', 1) })
        .success,
    ).toBe(false);
    expect(guestVerificationSendInputSchema.safeParse({ ...send, businessKey: `guest:${REQUEST}` }).success).toBe(false);
  });

  it('refuses a link that is not a web address, an extra field and a bad token id', () => {
    expect(guestVerificationSendInputSchema.safeParse({ ...send, link: 'javascript:alert(1)' }).success).toBe(false);
    expect(guestVerificationSendInputSchema.safeParse({ ...send, token: 'raw' }).success).toBe(false);
    expect(guestVerificationSendInputSchema.safeParse({ ...send, tokenId: 'a b' }).success).toBe(false);
    expect(guestVerificationGetInputSchema.safeParse({ businessKey: send.businessKey }).success).toBe(true);
    expect(guestVerificationEraseInputSchema.safeParse({ guestRequestId: 'x' }).success).toBe(false);
  });

  it('answers the guest route receipt, with the origin refusals typed', () => {
    expect(guestNotificationCodeSchema.options).toEqual(expect.arrayContaining(['guest.link_origin_unset', 'guest.link_origin_mismatch']));
    expect(
      guestVerificationReceiptSchema.safeParse({
        notificationId: '33333333-3333-4333-8333-333333333333',
        businessKey: send.businessKey,
        status: 'refused',
        attemptedAt: null,
        acceptedAt: null,
        code: 'guest.notification_unconfigured',
        reference: null,
      }).success,
    ).toBe(true);
  });

  it('is exported from the package root', () => {
    expect(root.GUEST_VERIFICATION_CALLERS).toBe(GUEST_VERIFICATION_CALLERS);
  });
});
