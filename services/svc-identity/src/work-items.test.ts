import { describe, expect, it } from 'vitest';
import { workItemsOutputSchema } from '@intafaced/contracts';
import { verificationItem } from './work-items.js';

const USER = '11111111-1111-4111-8111-111111111111';
const RECORD = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-23T12:00:00.000Z');
const record = (status: 'pending' | 'approved' | 'rejected' | 'expired', expires: string | null = null) => ({
  id: RECORD,
  status,
  expires_at: expires ? new Date(expires) : null,
});

describe('identity verification work item', () => {
  it('asks the person to start when there is no record, keyed by the account', () => {
    expect(verificationItem(USER, null, NOW)).toEqual({
      id: `verification:${USER}`,
      kind: 'verification',
      source: 'identity',
      severity: 'action',
      titleKey: 'identity.verification.start',
      link: '/verification',
    });
  });

  it('waits on review, asks again after a rejection, and names a lapsed approval with its expiry', () => {
    expect(verificationItem(USER, record('pending'), NOW)).toMatchObject({
      id: `verification:${RECORD}`,
      severity: 'info',
      titleKey: 'identity.verification.pending',
    });
    expect(verificationItem(USER, record('rejected'), NOW)).toMatchObject({
      severity: 'action',
      titleKey: 'identity.verification.rejected',
    });
    expect(verificationItem(USER, record('approved', '2026-10-23T11:59:59.000Z'), NOW)).toMatchObject({
      severity: 'action',
      titleKey: 'identity.verification.expired',
      dueAt: '2026-10-23T11:59:59.000Z',
    });
    expect(verificationItem(USER, record('expired'), NOW)).toMatchObject({ titleKey: 'identity.verification.expired' });
    expect(verificationItem(USER, record('expired'), NOW)).not.toHaveProperty('dueAt');
  });

  it('owes nothing for a live approval, with or without an expiry', () => {
    expect(verificationItem(USER, record('approved'), NOW)).toBeNull();
    expect(verificationItem(USER, record('approved', '2027-01-01T00:00:00.000Z'), NOW)).toBeNull();
  });

  it('does not nag a person who still holds a live approval about a rejected or lapsed upgrade', () => {
    expect(verificationItem(USER, record('rejected'), NOW, true)).toBeNull();
    expect(verificationItem(USER, record('expired'), NOW, true)).toBeNull();
    expect(verificationItem(USER, record('pending'), NOW, true)).toMatchObject({ severity: 'info' });
  });

  it('every item it makes is one the Home contract accepts from identity', () => {
    for (const newest of [null, record('pending'), record('rejected'), record('expired'), record('approved', '2026-01-01T00:00:00.000Z')]) {
      const item = verificationItem(USER, newest, NOW);
      expect(workItemsOutputSchema.safeParse({ items: [item] }).success).toBe(true);
    }
  });
});
