import { describe, expect, it } from 'vitest';
import { isAppId, isReviewStatus, readReviewRequest, reviewGate, statusAfter } from './model';

const APP = '44444444-4444-4444-8444-444444444444';
const REASON = 'Checked the redirect addresses and the scopes.';

describe('oauth decision request', () => {
  it('takes one app, one decision and a trimmed reason', () => {
    expect(readReviewRequest({ action: 'review', appId: APP, decision: 'approve', reason: `  ${REASON}  ` })).toEqual({
      appId: APP,
      decision: 'approve',
      reason: REASON,
    });
  });

  it.each([
    { action: 'claim', appId: APP, decision: 'approve', reason: REASON },
    { action: 'review', appId: 'not-an-id', decision: 'approve', reason: REASON },
    { action: 'review', appId: APP, decision: 'reject', reason: REASON },
    { action: 'review', appId: APP, decision: 'approve', reason: 'too short' },
    { action: 'review', appId: APP, decision: 'approve', reason: 'x'.repeat(501) },
    { action: 'review', appId: APP, decision: 'approve' },
  ])('refuses a request that is not exactly that: %j', (raw) => {
    expect(readReviewRequest(raw)).toBeNull();
  });

  it('knows an app id and a status, and the status a decision ends in', () => {
    expect(isAppId(APP)).toBe(true);
    expect(isAppId('x')).toBe(false);
    expect(isReviewStatus('pending')).toBe(true);
    expect(isReviewStatus('rejected')).toBe(false);
    expect(statusAfter('approve')).toBe('approved');
    expect(statusAfter('suspend')).toBe('suspended');
  });
});

describe('oauth decision gate', () => {
  const base = { appName: 'Ledger sync', reason: REASON, typed: '', busy: false };

  it('needs a written reason for either decision', () => {
    expect(reviewGate({ ...base, decision: 'suspend', reason: 'short' })).toMatchObject({ ok: false });
    expect(reviewGate({ ...base, decision: 'suspend' })).toEqual({ ok: true });
  });

  it('needs the app name typed back to approve, and not to suspend', () => {
    expect(reviewGate({ ...base, decision: 'approve' })).toMatchObject({ ok: false });
    expect(reviewGate({ ...base, decision: 'approve', typed: 'ledger sync' })).toMatchObject({ ok: false });
    expect(reviewGate({ ...base, decision: 'approve', typed: ' Ledger sync ' })).toEqual({ ok: true });
  });

  it('does not send twice while a send is under way', () => {
    expect(reviewGate({ ...base, decision: 'suspend', busy: true })).toMatchObject({ ok: false });
  });
});
