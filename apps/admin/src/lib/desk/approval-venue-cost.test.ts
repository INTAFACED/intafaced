import { describe, expect, it } from 'vitest';
import { approvalPayloadHash } from '../../../../../services/svc-ops/src/operator-desks';
import {
  confirmPhrase,
  decodePacket,
  describeRequest,
  encodePacket,
  readDeskRequest,
  requestReason,
  type DeskRequest,
} from './approval-packet';
import { payloadHashFor, proposeInputFor } from './approval-hash';

/** The hash is pinned to svc-ops' own function, so drift fails here instead of making every approval unusable. */
const request: DeskRequest = {
  kind: 'ops.venue_cost.record',
  period: '2026-10',
  category: 'custody',
  amount: '1250.50',
  asset: 'USD',
  reason: 'TEST invoice 4471 from the custodian',
};

describe('venue cost request', () => {
  it('hashes exactly what svc-ops hashes, with the amount in its stored form', () => {
    expect(payloadHashFor(request)).toBe(
      approvalPayloadHash('ops.venue_cost.record', {
        period: '2026-10',
        category: 'custody',
        amount: '1250.5',
        asset: 'USD',
        sourceNote: 'TEST invoice 4471 from the custodian',
      }),
    );
  });

  it('a changed figure, line, month or note is a different request', () => {
    const base = payloadHashFor(request);
    for (const change of [
      { amount: '1250.51' },
      { category: 'data' },
      { period: '2026-09' },
      { reason: 'TEST invoice 4472 from the custodian' },
    ]) {
      expect(payloadHashFor({ ...request, ...change } as DeskRequest)).not.toBe(base);
    }
  });

  it('is proposed against svc-ops for the month and line', () => {
    expect(proposeInputFor(request)).toMatchObject({
      actionType: 'ops.venue_cost.record',
      targetService: 'svc-ops',
      targetId: 'venue-cost:2026-10:custody',
      expectedVersion: '1',
    });
  });

  it('survives a packet round trip and is read strictly', () => {
    expect(readDeskRequest(request)).toEqual(request);
    const read = decodePacket(
      encodePacket({ request, approvalId: 'appr_1', operationId: 'op_1', expiresAt: '2026-10-20T11:00:00.000Z', requesterId: 'u1' }),
    );
    expect(read).toMatchObject({ ok: true, packet: { request } });
    expect(readDeskRequest({ ...request, amount: '-1' })).toBeNull();
    expect(readDeskRequest({ ...request, category: 'rent' })).toBeNull();
    expect(readDeskRequest({ ...request, period: '2026-13' })).toBeNull();
    expect(readDeskRequest({ ...request, asset: 'usd' })).toBeNull();
    expect(readDeskRequest({ ...request, reason: 'short' })).toBeNull();
    expect(readDeskRequest({ ...request, extra: 1 })).toBeNull();
  });

  it('names the month and line to type, and says in words that no money moves', () => {
    expect(confirmPhrase(request)).toBe('RECORD COST custody 2026-10');
    expect(describeRequest(request)).toContain('No money moves');
    expect(describeRequest(request)).toContain('1250.50 USD');
    expect(requestReason(request)).toBe('TEST invoice 4471 from the custodian');
  });
});
