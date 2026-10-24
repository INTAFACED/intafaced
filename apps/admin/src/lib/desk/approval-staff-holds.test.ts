import { describe, expect, it } from 'vitest';
import { staffHoldConfirmFields, staffHoldReleaseFields } from '@intafaced/contracts/ops-staff-holds';
import { approvalPayloadHash } from '../../../../../services/svc-ops/src/operator-desks';
import { confirmPhrase, decodePacket, describeRequest, encodePacket, readDeskRequest, type DeskRequest } from './approval-packet';
import { payloadHashFor, proposeInputFor } from './approval-hash';

/** A staff hold's release and confirm (J-ops-console-04 #3-#5). The hash is pinned to svc-ops' own function over the contract's fields. */
const USER = '0b6f7a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const release: DeskRequest = {
  kind: 'ops.hold.release',
  holdNo: '3',
  userId: USER,
  assetId: 'USDT',
  amount: '15.00',
  reason: 'TEST customer proved the funds',
};
const confirm: DeskRequest = { kind: 'ops.hold.confirm', holdNo: '3', userId: USER, assetId: 'USDT', reason: 'TEST fraud confirmed' };

describe('staff hold requests', () => {
  it('hash exactly what svc-ops hashes when it spends the approval: the hold and the amount as svc-ops spells it', () => {
    expect(payloadHashFor(release)).toBe(approvalPayloadHash('ops.hold.release', staffHoldReleaseFields('3', '15')));
    expect(payloadHashFor({ ...release, amount: '15' } as DeskRequest)).toBe(payloadHashFor(release));
    expect(payloadHashFor({ ...release, amount: '16' } as DeskRequest)).not.toBe(payloadHashFor(release));
    expect(payloadHashFor({ ...release, holdNo: '4' } as DeskRequest)).not.toBe(payloadHashFor(release));
    expect(payloadHashFor(confirm)).toBe(approvalPayloadHash('ops.hold.confirm', staffHoldConfirmFields('3')));
  });

  it('propose against svc-ops and the hold itself, so identity needs both founders', () => {
    for (const request of [release, confirm])
      expect(proposeInputFor(request)).toEqual({
        actionType: request.kind,
        targetService: 'svc-ops',
        targetId: 'hold:3',
        expectedVersion: '1',
        payloadHash: payloadHashFor(request),
        policyVersion: 'v1',
      });
  });

  it('read back only in their exact shape, and survive the packet', () => {
    expect(readDeskRequest(release)).toEqual(release);
    expect(readDeskRequest(confirm)).toEqual(confirm);
    expect(readDeskRequest({ ...release, amount: '0' })).toBeNull();
    expect(readDeskRequest({ ...release, amount: '-1' })).toBeNull();
    expect(readDeskRequest({ ...release, holdNo: '0' })).toBeNull();
    expect(readDeskRequest({ ...release, userId: USER.toUpperCase() })).toBeNull();
    expect(readDeskRequest({ ...confirm, amount: '1' })).toBeNull();
    expect(readDeskRequest({ ...release, extra: true })).toBeNull();
    const packet = encodePacket({
      request: release,
      approvalId: 'ap_1',
      operationId: 'op_1',
      expiresAt: '2026-10-24T10:00:00.000Z',
      requesterId: '11111111-1111-4111-8111-111111111111',
    });
    expect(decodePacket(packet)).toMatchObject({ ok: true, packet: { request: release } });
  });

  it('name the hold in the phrase, and say what moves in words', () => {
    expect(confirmPhrase(release)).toBe('RELEASE HOLD 3');
    expect(confirmPhrase(confirm)).toBe('CONFIRM HOLD 3');
    expect(describeRequest(release)).toContain('Release 15.00 USDT of staff hold 3 back to customer');
    expect(describeRequest(confirm)).toContain('owner-named account');
  });
});
