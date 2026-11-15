import { describe, expect, it } from 'vitest';
import { bustPayloadHash } from './bust-hash';

describe('trade bust approval hash (J-cex-spot-18 #4)', () => {
  it('is the hash svc-trade checks (services/svc-trade/src/admin/bust.test.ts pins the same value)', () => {
    expect(bustPayloadHash({ orderId: 'o-1', expectedVersion: '2', reason: 'TEST reason' })).toBe(
      'sha256:5a55acd3ceadb94c2709f3dadb3416acd8f7bf6d9cdd9208d9f2382fc1bf6def',
    );
  });

  it('changes with the fill count and with the reason', () => {
    const base = bustPayloadHash({ orderId: 'o-1', expectedVersion: '2', reason: 'TEST reason' });
    expect(bustPayloadHash({ orderId: 'o-1', expectedVersion: '3', reason: 'TEST reason' })).not.toBe(base);
    expect(bustPayloadHash({ orderId: 'o-1', expectedVersion: '2', reason: 'TEST other' })).not.toBe(base);
  });
});
