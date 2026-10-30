import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { opsAlertAcceptFields, opsAlertEvidenceCanonical } from '@intafaced/contracts/ops-reconciliation-alerts';
import { approvalPayloadHash } from '../../../../../services/svc-ops/src/operator-desks';
import { ALERT, alertDetail } from '@/lib/recon-alerts/fixtures.test-util';
import { evidenceHash } from '@/lib/recon-alerts/treasury';
import { confirmPhrase, describeRequest, readDeskRequest, requestReason, type DeskRequest } from './approval-packet';
import { payloadHashFor, proposeInputFor } from './approval-hash';

/** Accepting a reconciliation discrepancy (OPS-reconciliation-04, J-ops-console-07 #9). The hash is pinned to svc-ops' own formula. */
const HASH = 'a'.repeat(64);
const accept: DeskRequest = {
  kind: 'ops.reconciliation_alert.accept',
  alertId: ALERT,
  evidenceHash: HASH,
  reason: 'TEST known rounding on the outside statement',
};

describe('reconciliation alert acceptance requests', () => {
  it('hash exactly what svc-ops hashes when it spends the approval: the alert, the note and the evidence hash', () => {
    const fields = opsAlertAcceptFields(ALERT, 'TEST known rounding on the outside statement', HASH);
    const expected = `sha256:${createHash('sha256')
      .update(JSON.stringify({ actionType: 'ops.reconciliation_alert.accept', ...fields }))
      .digest('hex')}`;
    expect(payloadHashFor(accept)).toBe(expected);
    expect(payloadHashFor(accept)).toBe(approvalPayloadHash('ops.reconciliation_alert.accept', fields));
    expect(payloadHashFor({ ...accept, reason: 'TEST a different note entirely' } as DeskRequest)).not.toBe(expected);
    expect(payloadHashFor({ ...accept, evidenceHash: 'b'.repeat(64) } as DeskRequest)).not.toBe(expected);
  });

  it('propose against svc-ops and the alert itself, so identity needs both founders', () => {
    expect(proposeInputFor(accept)).toEqual({
      actionType: 'ops.reconciliation_alert.accept',
      targetService: 'svc-ops',
      targetId: `reconciliation-alert:${ALERT}`,
      expectedVersion: '1',
      payloadHash: payloadHashFor(accept),
      policyVersion: 'v1',
    });
  });

  it('read back only in their exact shape; a blank note reads so the route can refuse it by name', () => {
    expect(readDeskRequest(accept)).toEqual(accept);
    expect(readDeskRequest({ ...accept, reason: '' })).toEqual({ ...accept, reason: '' });
    expect(readDeskRequest({ ...accept, reason: 'too short' })).toBeNull();
    expect(readDeskRequest({ ...accept, reason: 'x'.repeat(501) })).toBeNull();
    expect(readDeskRequest({ ...accept, evidenceHash: 'A'.repeat(64) })).toBeNull();
    expect(readDeskRequest({ ...accept, evidenceHash: 'a'.repeat(63) })).toBeNull();
    expect(readDeskRequest({ ...accept, alertId: 'not-an-alert' })).toBeNull();
    expect(readDeskRequest({ ...accept, extra: true })).toBeNull();
  });

  it('name the alert in the phrase, and say in words that no money moves', () => {
    expect(confirmPhrase(accept)).toBe('ACCEPT ALERT 22222222');
    expect(describeRequest(accept)).toContain(`frozen at hash ${HASH}`);
    expect(describeRequest(accept)).toContain('nothing is posted to the ledger');
    expect(requestReason(accept)).toBe(accept.reason);
  });

  it('the evidence hash is SHA-256 hex of the contract’s canonical evidence, whatever order the keys arrived in', () => {
    const { alert } = alertDetail();
    const hex = createHash('sha256').update(opsAlertEvidenceCanonical(alert.evidence)).digest('hex');
    expect(evidenceHash(alert)).toBe(hex);
    const reordered = JSON.parse(
      JSON.stringify({ asset: alert.evidence.asset, finishedAt: alert.evidence.finishedAt, run: alert.evidence.run }),
    );
    expect(evidenceHash({ evidence: reordered })).toBe(hex);
    expect(
      evidenceHash(alertDetail({ evidence: { ...alert.evidence, asset: { ...alert.evidence.asset!, observed: '6' } } }).alert),
    ).not.toBe(hex);
  });
});
