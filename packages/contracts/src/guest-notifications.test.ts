import { describe, expect, it } from 'vitest';
import { guestNotificationReceiptSchema, guestNotificationSendInputSchema } from './guest-notifications.js';

const id = '11111111-1111-4111-8111-111111111111';
const send = {
  businessKey: 'acknowledgement:' + id,
  contactId: id,
  submissionId: id,
  recipientEmail: 'prospect@example.test',
  message: { kind: 'enquiry_acknowledgement' },
};
const pending = {
  notificationId: id,
  businessKey: send.businessKey,
  status: 'queued',
  attemptedAt: null,
  acceptedAt: null,
  code: null,
  reference: null,
};

describe('guest notification boundary', () => {
  it('accepts saved prospect facts without platform identity or continuation access', () => {
    expect(guestNotificationSendInputSchema.safeParse(send).success).toBe(true);
    for (const extra of [{ userId: id }, { continuationToken: 'secret' }, { subject: 'arbitrary' }, { href: 'https://example.test' }])
      expect(guestNotificationSendInputSchema.safeParse({ ...send, ...extra }).success).toBe(false);
    expect(guestNotificationSendInputSchema.safeParse({ ...send, message: { kind: 'marketing', staffText: 'news' } }).success).toBe(false);
    expect(
      guestNotificationSendInputSchema.safeParse({ ...send, message: { kind: 'call_invitation', staffText: 'Join a call' } }).success,
    ).toBe(false);
  });
  it('requires recorded staff evidence for reviewed follow-up messages', () => {
    expect(
      guestNotificationSendInputSchema.safeParse({
        ...send,
        message: { kind: 'call_invitation', activityId: id, staffText: 'Please reply with your availability.' },
      }).success,
    ).toBe(true);
  });
  it('distinguishes queued, uncertain and actually accepted outcomes', () => {
    expect(guestNotificationReceiptSchema.safeParse(pending).success).toBe(true);
    expect(guestNotificationReceiptSchema.safeParse({ ...pending, status: 'accepted' }).success).toBe(false);
    expect(guestNotificationReceiptSchema.safeParse({ ...pending, status: 'delivered' }).success).toBe(false);
    expect(guestNotificationReceiptSchema.safeParse({ ...pending, status: 'unresolved', code: 'guest.acceptance_unknown' }).success).toBe(
      false,
    );
    const attemptedAt = '2026-10-10T12:00:00.000Z',
      acceptedAt = '2026-10-10T12:00:01.000Z';
    expect(
      guestNotificationReceiptSchema.safeParse({ ...pending, status: 'unresolved', attemptedAt, code: 'guest.acceptance_unknown' }).success,
    ).toBe(true);
    expect(
      guestNotificationReceiptSchema.safeParse({ ...pending, status: 'accepted', attemptedAt, acceptedAt, reference: 'gateway-42' })
        .success,
    ).toBe(true);
    expect(
      guestNotificationReceiptSchema.safeParse({ ...pending, status: 'accepted', attemptedAt, acceptedAt: '2026-10-10T11:00:00.000Z' })
        .success,
    ).toBe(false);
  });
});
