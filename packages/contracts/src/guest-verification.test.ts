import { describe, expect, it } from 'vitest';
import {
  GUEST_VERIFICATION_CALLERS,
  GUEST_VERIFICATION_PROCEDURES,
  guestVerificationCodeSchema,
  guestVerificationEraseInputSchema,
  guestVerificationGetInputSchema,
  guestVerificationKey,
  guestVerificationLinkMatches,
  guestVerificationReceiptSchema,
  guestVerificationSendInputSchema,
} from './guest-verification.js';
import { guestNotificationCodeSchema, guestNotificationReceiptSchema } from './guest-notifications.js';
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
const accepts = (link: string) => guestVerificationSendInputSchema.safeParse({ ...send, link }).success;

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
    expect(
      guestVerificationSendInputSchema.safeParse({ ...send, businessKey: guestVerificationKey('22222222-2222-4222-8222-222222222222', 1) })
        .success,
    ).toBe(false);
    expect(guestVerificationSendInputSchema.safeParse({ ...send, businessKey: `support:guest-verify:${REQUEST}:0` }).success).toBe(false);
    expect(guestVerificationSendInputSchema.safeParse({ ...send, businessKey: `guest:${REQUEST}` }).success).toBe(false);
  });

  it('builds a key only for an ordinal the key accepts', () => {
    expect(guestVerificationKey(REQUEST, 9999)).toBe(`support:guest-verify:${REQUEST}:9999`);
    for (const bad of [0, 10_000, 1.5, -1]) expect(() => guestVerificationKey(REQUEST, bad)).toThrow(RangeError);
  });

  it('mails a token only over https, or http on this machine, and never with a user part', () => {
    expect(accepts('https://app.example.org/verify?token=a')).toBe(true);
    expect(accepts('HTTPS://app.example.org/verify?token=a')).toBe(true);
    expect(accepts('http://127.0.0.1:3210/support/guest/verify?token=a')).toBe(true);
    expect(accepts('http://app.example.org/verify?token=a')).toBe(false);
    expect(accepts('https://app.example.org@evil.example/verify?token=a')).toBe(false);
    expect(accepts('javascript:alert(1)')).toBe(false);
    expect(accepts('not a link')).toBe(false);
  });

  it('matches the customer app origin exactly, never by prefix', () => {
    const origin = 'https://app.example.org';
    expect(guestVerificationLinkMatches('https://app.example.org/verify?token=a', origin)).toBe(true);
    expect(guestVerificationLinkMatches('https://APP.example.org/verify', origin)).toBe(true);
    expect(guestVerificationLinkMatches('https://app.example.org.evil.example/verify', origin)).toBe(false);
    expect(guestVerificationLinkMatches('https://app.example.org:8443/verify', origin)).toBe(false);
    expect(guestVerificationLinkMatches('http://app.example.org/verify', origin)).toBe(false);
    expect(guestVerificationLinkMatches('https://app.example.org/verify', '')).toBe(false);
    expect(guestVerificationLinkMatches('https://app.example.org/verify', null)).toBe(false);
  });

  it('refuses an extra field, a bad token id and a bad request id', () => {
    expect(guestVerificationSendInputSchema.safeParse({ ...send, token: 'raw' }).success).toBe(false);
    expect(guestVerificationSendInputSchema.safeParse({ ...send, tokenId: 'a b' }).success).toBe(false);
    expect(guestVerificationGetInputSchema.safeParse({ businessKey: send.businessKey }).success).toBe(true);
    expect(guestVerificationEraseInputSchema.safeParse({ guestRequestId: 'x' }).success).toBe(false);
  });

  it('answers with its own codes; the ops route keeps its own', () => {
    const receipt = {
      notificationId: '33333333-3333-4333-8333-333333333333',
      businessKey: send.businessKey,
      status: 'refused',
      attemptedAt: null,
      acceptedAt: null,
      code: 'guest.notification_unconfigured',
      reference: null,
    };
    expect(guestVerificationReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(guestVerificationReceiptSchema.safeParse({ ...receipt, code: 'guest.submission_erased' }).success).toBe(false);
    expect(guestVerificationReceiptSchema.safeParse({ ...receipt, code: null }).success).toBe(false);
    expect(guestVerificationCodeSchema.options).toEqual(
      expect.arrayContaining(['guest.link_origin_unset', 'guest.link_origin_mismatch', 'guest.link_expired', 'guest.request_erased']),
    );
    expect(guestNotificationCodeSchema.options).not.toContain('guest.link_origin_unset');
    expect(guestNotificationReceiptSchema.safeParse({ ...receipt, businessKey: 'ops:1', code: 'guest.link_expired' }).success).toBe(false);
  });

  it('is exported from the package root', () => {
    expect(root.GUEST_VERIFICATION_CALLERS).toBe(GUEST_VERIFICATION_CALLERS);
  });
});
