import { describe, expect, it } from 'vitest';
import { describeDirect, newRequestKey, readDirectRequest } from './direct-model';

const good = {
  action: 'p2p.dispute.escalate',
  disputeId: '5a3b9c10-1111-4222-8333-444455556666',
  reason: 'overdue and the seller is silent',
  clientRequestId: 'console-0f8e7d6c-1111-4222-8333-444455556666',
};

describe('one-operator desk request', () => {
  it('reads exactly an escalation and trims the reason the way the service will keep it', () => {
    expect(readDirectRequest(good)).toEqual(good);
    expect(readDirectRequest({ ...good, reason: '  overdue and the seller is silent  ' })).toEqual(good);
  });
  it('refuses another action, a short or long reason, a bad id or key, extra fields and non-objects', () => {
    for (const bad of [
      { ...good, action: 'p2p.dispute.resolve' },
      { ...good, reason: 'short' },
      { ...good, reason: 'x'.repeat(501) },
      { ...good, reason: 12 },
      { ...good, disputeId: 'trade-1' },
      { ...good, clientRequestId: 'k' },
      { ...good, clientRequestId: 'has spaces in it' },
      { ...good, extra: true },
      null,
      [],
      'text',
    ]) {
      expect(readDirectRequest(bad)).toBeNull();
    }
    const { clientRequestId: _k, ...noKey } = good;
    expect(readDirectRequest(noKey)).toBeNull();
  });
  it('says what it does and what it does not: no money moves', () => {
    const text = describeDirect({ ...good, action: 'p2p.dispute.escalate' });
    expect(text).toContain(good.disputeId);
    expect(text).toContain('No money moves');
  });
  it('makes a key the service accepts, and a different one each time', () => {
    const a = newRequestKey();
    const b = newRequestKey();
    expect(readDirectRequest({ ...good, clientRequestId: a })).not.toBeNull();
    expect(a).not.toBe(b);
  });
});
