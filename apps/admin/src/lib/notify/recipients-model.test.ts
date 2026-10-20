import { describe, expect, it } from 'vitest';
import { checkReleaseReason, readRecipients, readReleased, releaseKey } from './recipients-model';

const item = (over: Record<string, unknown> = {}) => ({
  userId: '11111111-1111-4111-8111-111111111111',
  channel: 'email',
  address: 'a***@example.com',
  state: 'quarantined',
  consecutiveFailures: 3,
  lastFailureAt: '2026-10-20T10:00:00.000Z',
  lastFailureCode: 'channel.provider_rejected',
  quarantinedAt: '2026-10-20T10:00:01.000Z',
  quarantineReason: 'consecutive_failures',
  ...over,
});
const page = (items: unknown[], over: Record<string, unknown> = {}) => ({ threshold: 3, thresholdCode: null, items, ...over });

describe('recipient reader', () => {
  it('reads a page and keeps the owner threshold', () => {
    const read = readRecipients(page([item()]), 'quarantined', 200);
    expect(read?.items).toHaveLength(1);
    expect(read?.threshold).toBe(3);
  });
  it('a blank threshold stays blank with its code', () => {
    const read = readRecipients(page([], { threshold: null, thresholdCode: 'notify.quarantine_threshold_unset' }), 'quarantined', 200);
    expect(read).toMatchObject({ threshold: null, thresholdCode: 'notify.quarantine_threshold_unset', items: [] });
  });
  it('refuses a malformed or mismatched row rather than dropping it', () => {
    for (const bad of [
      null,
      item({ channel: 'inapp' }),
      item({ state: 'active' }),
      item({ consecutiveFailures: -1 }),
      item({ consecutiveFailures: 1.5 }),
      item({ lastFailureAt: 'x' }),
      item({ address: 5 }),
      item({ userId: '' }),
    ]) {
      expect(readRecipients(page([item(), bad]), 'quarantined', 200)).toBeNull();
    }
    expect(readRecipients('nope', 'quarantined', 200)).toBeNull();
    expect(readRecipients(page([], { threshold: 0 }), 'quarantined', 200)).toBeNull();
  });
});

describe('release', () => {
  it('reads only a real release answer', () => {
    expect(readReleased({ released: true, replayed: false })).toEqual({ replayed: false });
    expect(readReleased({ released: true })).toBeNull();
    expect(readReleased({ released: false, replayed: false })).toBeNull();
  });
  it('the key is the same for the same quarantine and differs for a later one', () => {
    const base = { userId: 'u1', channel: 'sms' as const, quarantinedAt: '2026-10-20T10:00:01.000Z' };
    expect(releaseKey(base)).toBe(releaseKey({ ...base }));
    expect(releaseKey(base)).not.toBe(releaseKey({ ...base, quarantinedAt: '2026-10-21T10:00:01.000Z' }));
  });
  it('wants a real reason', () => {
    expect(checkReleaseReason('too short').ok).toBe(false);
    expect(checkReleaseReason('x'.repeat(501)).ok).toBe(false);
    expect(checkReleaseReason('  mailbox fixed by the user  ')).toEqual({ ok: true, reason: 'mailbox fixed by the user' });
  });
});
