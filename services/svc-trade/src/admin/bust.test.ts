import { describe, expect, it } from 'vitest';
import { payloadHash } from './common.js';
import { BUST_ACTION_TYPE, bustApprovalBody, bustAuditId, parseSweepLimit, parseSweepMinAgeSeconds } from './bust.js';

describe('trade bust approval body (J-cex-spot-18 #4)', () => {
  it('binds the action, the order, its fill count and the reason, and nothing else', () => {
    const body = bustApprovalBody({ orderId: 'o-1', expectedVersion: '2', reason: 'TEST reason' });
    expect(body).toEqual({ actionType: BUST_ACTION_TYPE, orderId: 'o-1', expectedVersion: '2', reason: 'TEST reason' });
    // The console computes this same hash (apps/admin/src/lib/trade-ops/bust-hash.ts, its test pins the same value).
    expect(payloadHash(body)).toBe(payloadHash({ reason: 'TEST reason', orderId: 'o-1', expectedVersion: '2', actionType: 'trade.bust' }));
    expect(payloadHash(body)).toBe('sha256:5a55acd3ceadb94c2709f3dadb3416acd8f7bf6d9cdd9208d9f2382fc1bf6def');
    expect(payloadHash(bustApprovalBody({ orderId: 'o-1', expectedVersion: '3', reason: 'TEST reason' }))).not.toBe(payloadHash(body));
  });

  it('gives one audit id per request', () => {
    expect(bustAuditId('req-1')).toBe(bustAuditId('req-1'));
    expect(bustAuditId('req-1')).not.toBe(bustAuditId('req-2'));
    expect(bustAuditId('req-1')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('sweep owner values (J-cex-spot-18 #3)', () => {
  it('reads a whole number in range, and anything else as unset', () => {
    expect(parseSweepLimit('500')).toBe(500);
    expect(parseSweepLimit('10000')).toBe(10_000);
    for (const raw of [undefined, '', ' ', '0', '-1', '1.5', '10001', 'abc', '05']) expect(parseSweepLimit(raw)).toBeNull();
    expect(parseSweepMinAgeSeconds('15')).toBe(15);
    expect(parseSweepMinAgeSeconds('86400')).toBe(86_400);
    for (const raw of [undefined, '', '0', '86401', '1e3']) expect(parseSweepMinAgeSeconds(raw)).toBeNull();
  });
});
