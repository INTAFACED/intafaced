import { describe, expect, it } from 'vitest';
import { consoleModeApprovalFields } from '@intafaced/contracts/ops-console-mode';
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

/** Maintenance mode's two requests. The hash is pinned to svc-ops' own function over the contract's fields. */
const on: DeskRequest = { kind: 'ops.console_mode.on', reason: 'TEST database maintenance window' };
const off: DeskRequest = { kind: 'ops.console_mode.off' };

describe('maintenance mode requests', () => {
  it('hash exactly what svc-ops hashes when it consumes the approval', () => {
    expect(payloadHashFor(on)).toBe(
      approvalPayloadHash('ops.console_mode.on', consoleModeApprovalFields('ops.console_mode.on', on.reason)),
    );
    expect(payloadHashFor(off)).toBe(approvalPayloadHash('ops.console_mode.off', consoleModeApprovalFields('ops.console_mode.off', null)));
    expect(payloadHashFor(on)).not.toBe(payloadHashFor({ kind: 'ops.console_mode.on', reason: 'TEST another maintenance reason' }));
    expect(payloadHashFor(on)).not.toBe(payloadHashFor(off));
  });

  it('propose against svc-ops and the console itself, so identity needs both founders', () => {
    for (const request of [on, off])
      expect(proposeInputFor(request)).toMatchObject({
        actionType: request.kind,
        targetService: 'svc-ops',
        targetId: 'console',
        expectedVersion: '1',
        payloadHash: payloadHashFor(request),
      });
  });

  it('read back only in their exact shape', () => {
    expect(readDeskRequest(on)).toEqual(on);
    expect(readDeskRequest(off)).toEqual(off);
    expect(readDeskRequest({ kind: 'ops.console_mode.on', reason: 'too short' })).toBeNull();
    expect(readDeskRequest({ kind: 'ops.console_mode.on', reason: ' TEST padded maintenance reason' })).toBeNull();
    expect(readDeskRequest({ kind: 'ops.console_mode.off', reason: 'TEST database maintenance window' })).toBeNull();
    expect(readDeskRequest({ kind: 'ops.console_mode.on' })).toBeNull();
    const packet = { request: on, approvalId: 'appr_1', operationId: 'op_1', expiresAt: new Date().toISOString(), requesterId: 'u1' };
    const read = decodePacket(encodePacket(packet));
    expect(read).toMatchObject({ ok: true, packet: { request: on } });
  });

  it('say what they do in words, with a phrase to type and the reason only when turning on', () => {
    expect(confirmPhrase(on)).toBe('CONSOLE READ ONLY');
    expect(confirmPhrase(off)).toBe('CONSOLE WRITABLE');
    expect(describeRequest(on)).toContain('read-only');
    expect(describeRequest(on)).toContain('posting freeze');
    expect(requestReason(on)).toBe(on.reason);
    expect(requestReason(off)).toBeNull();
  });
});
