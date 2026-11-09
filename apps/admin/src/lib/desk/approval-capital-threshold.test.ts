import { describe, expect, it } from 'vitest';
import { approvalPayloadHash } from '../../../../../services/svc-ops/src/operator-desks';
import { opsCapitalThresholdFields } from '@intafaced/contracts/ops-capital';
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

const request: DeskRequest = {
  kind: 'ops.capital.threshold.set',
  assetId: 'USDT',
  minimum: '150.25',
  contact: 'TEST treasury on-call',
  reason: 'TEST buffer policy for the capital monitor',
};
const clear: DeskRequest = { ...request, minimum: '', contact: '' } as DeskRequest;

describe('capital threshold request (J-ops-console-24 #1)', () => {
  it('hashes exactly what svc-ops hashes', () => {
    expect(payloadHashFor(request)).toBe(
      approvalPayloadHash(
        'ops.capital.threshold.set',
        opsCapitalThresholdFields('USDT', '150.25', 'TEST treasury on-call', request.reason),
      ),
    );
  });

  it('a changed asset, minimum, contact or reason is a different request', () => {
    const base = payloadHashFor(request);
    for (const change of [{ assetId: 'BTC' }, { minimum: '150.26' }, { contact: 'TEST other' }, { reason: 'TEST another buffer policy' }]) {
      expect(payloadHashFor({ ...request, ...change } as DeskRequest)).not.toBe(base);
    }
  });

  it('is proposed against svc-ops for the asset’s threshold', () => {
    expect(proposeInputFor(request)).toMatchObject({
      actionType: 'ops.capital.threshold.set',
      targetService: 'svc-ops',
      targetId: 'capital-threshold:USDT',
      expectedVersion: '1',
    });
  });

  it('says what it does and names the asset in its confirm phrase', () => {
    expect(confirmPhrase(request)).toBe('SET THRESHOLD USDT');
    expect(confirmPhrase(clear)).toBe('CLEAR THRESHOLD USDT');
    expect(describeRequest(request)).toContain('escalated to TEST treasury on-call');
    expect(describeRequest(clear)).toContain('not monitored');
    expect(requestReason(request)).toBe(request.reason);
  });

  it('survives a packet round trip and is read strictly', () => {
    expect(readDeskRequest(request)).toEqual(request);
    expect(readDeskRequest(clear)).toEqual(clear);
    const read = decodePacket(
      encodePacket({ request, approvalId: 'appr_1', operationId: 'op_1', expiresAt: '2026-11-09T11:00:00.000Z', requesterId: 'u1' }),
    );
    expect(read).toMatchObject({ ok: true, packet: { request } });
    expect(readDeskRequest({ ...request, minimum: '-1' })).toBeNull();
    expect(readDeskRequest({ ...request, minimum: '007' })).toBeNull();
    expect(readDeskRequest({ ...request, assetId: 'usdt' })).toBeNull();
    expect(readDeskRequest({ ...request, contact: '' })).toBeNull();
    expect(readDeskRequest({ ...clear, contact: 'someone' })).toBeNull();
    expect(readDeskRequest({ ...request, reason: 'short' })).toBeNull();
    expect(readDeskRequest({ ...request, extra: 1 })).toBeNull();
  });
});
