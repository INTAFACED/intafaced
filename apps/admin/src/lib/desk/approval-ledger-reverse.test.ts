import { describe, expect, it } from 'vitest';
import { opsReversalApprovalFields } from '@intafaced/contracts/ops-ledger-reversals';
import { approvalPayloadHash } from '../../../../../services/svc-ops/src/operator-desks';
import { confirmPhrase, describeRequest, readDeskRequest, requestReason, type DeskRequest } from './approval-packet';
import { payloadHashFor, proposeInputFor } from './approval-hash';

/** Reversing a posted ledger transaction (OPS-ledger-desk-02, J-ops-console-05 #1-#3). The hash is pinned to svc-ops' own formula. */
const ORIGINAL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const reverse: DeskRequest = {
  kind: 'ops.ledger.reverse',
  requestNo: '7',
  originalTxId: ORIGINAL,
  reason: 'LOCAL TEST posted to the wrong account',
  caseRef: 'CASE-7',
};

describe('ledger reversal requests', () => {
  it('hash exactly what svc-ops hashes when it spends the approval: the request, the original, the reason and the case', () => {
    const fields = opsReversalApprovalFields({
      requestNo: '7',
      originalTxId: ORIGINAL,
      reason: 'LOCAL TEST posted to the wrong account',
      caseRef: 'CASE-7',
    });
    expect(fields).toEqual({
      targetId: 'reversal:7',
      originalTxId: ORIGINAL,
      reason: 'LOCAL TEST posted to the wrong account',
      caseRef: 'CASE-7',
    });
    expect(payloadHashFor(reverse)).toBe(approvalPayloadHash('ops.ledger.reverse', fields));
    for (const change of [
      { requestNo: '8' },
      { caseRef: 'CASE-8' },
      { reason: 'LOCAL TEST another reason' },
      { originalTxId: ORIGINAL.replace('a', 'b') },
    ])
      expect(payloadHashFor({ ...reverse, ...change } as DeskRequest)).not.toBe(payloadHashFor(reverse));
  });

  it('propose the governed type against svc-ops, its applier, and the reversal request', () => {
    expect(proposeInputFor(reverse)).toEqual({
      actionType: 'ops.ledger.reverse',
      targetService: 'svc-ops',
      targetId: 'reversal:7',
      expectedVersion: '1',
      payloadHash: payloadHashFor(reverse),
      policyVersion: 'v1',
    });
  });

  it('read back only in their exact shape', () => {
    expect(readDeskRequest(reverse)).toEqual(reverse);
    expect(readDeskRequest({ ...reverse, requestNo: '0' })).toBeNull();
    expect(readDeskRequest({ ...reverse, originalTxId: ORIGINAL.toUpperCase() })).toBeNull();
    expect(readDeskRequest({ ...reverse, reason: 'too short' })).toBeNull();
    expect(readDeskRequest({ ...reverse, caseRef: '' })).toBeNull();
    expect(readDeskRequest({ ...reverse, caseRef: ' CASE-7' })).toBeNull();
    expect(readDeskRequest({ ...reverse, caseRef: 'c'.repeat(129) })).toBeNull();
    expect(readDeskRequest({ ...reverse, extra: true })).toBeNull();
  });

  it('name the request in the phrase, and say what posts and that a transaction is reversed once', () => {
    expect(confirmPhrase(reverse)).toBe('REVERSE REQUEST 7');
    expect(describeRequest(reverse)).toContain(ORIGINAL);
    expect(describeRequest(reverse)).toContain('nets to zero per asset');
    expect(describeRequest(reverse)).toContain('reversed once');
    expect(requestReason(reverse)).toBe(reverse.reason);
  });
});
