import { describe, expect, it } from 'vitest';
import { edgeActionPayloadHash } from '../../../../../services/svc-edge/src/action-approval-consume';
import { academyActionPayloadHash } from '../../../../../services/svc-academy/src/action-approval-consume';
import { marketActionPayloadHash } from '../../../../../services/svc-market/src/action-approval-consume';
import { ledgerActionPayloadHash } from '../../../../../services/svc-ledger/src/ledger/action-approval-consume';
import { payloadHashFor, proposeInputFor } from './approval-hash';

/**
 * The hash is the whole binding between what the approver read and what the service will do. If it drifts from the
 * services' own functions every approval becomes unusable (safe but broken), so it is pinned to THEIR code, not to a
 * copy of ours.
 */
describe('payload hash equals the owning service’s own function', () => {
  it('edge.kill: kill and re-enable, with the reason as typed', () => {
    for (const disabled of [true, false]) {
      expect(payloadHashFor({ kind: 'edge.kill', module: 'trade', disabled, reason: 'market integrity incident' })).toBe(
        edgeActionPayloadHash('edge.kill', { module: 'trade', disabled: disabled ? 'true' : 'false', reason: 'market integrity incident' }),
      );
    }
  });
  it('ledger.freeze and ledger.unfreeze', () => {
    expect(payloadHashFor({ kind: 'ledger.freeze', reason: 'reconciliation mismatch on USD', version: 'v' })).toBe(
      ledgerActionPayloadHash('ledger.freeze', { reason: 'reconciliation mismatch on USD' }),
    );
    expect(payloadHashFor({ kind: 'ledger.unfreeze', version: 'v' })).toBe(ledgerActionPayloadHash('ledger.unfreeze', {}));
  });
  it('market.vendor.vet and the academy ambassador verbs', () => {
    const vendorId = '5a3b9c10-1111-4222-8333-444455556666';
    const userId = '9f8e7d6c-1111-4222-8333-444455556666';
    for (const decision of ['approved', 'rejected', 'suspended'] as const) {
      expect(payloadHashFor({ kind: 'market.vendor.vet', vendorId, decision, reason: 'documents checked fully' })).toBe(
        marketActionPayloadHash('market.vendor.vet', { vendorId, decision, reason: 'documents checked fully' }),
      );
    }
    expect(payloadHashFor({ kind: 'academy.ambassador.freeze', userId, reason: 'conduct complaint review' })).toBe(
      academyActionPayloadHash('academy.ambassador.freeze', { userId, reason: 'conduct complaint review' }),
    );
    expect(payloadHashFor({ kind: 'academy.ambassador.unfreeze', userId })).toBe(
      academyActionPayloadHash('academy.ambassador.unfreeze', { userId }),
    );
  });
  it('the decision is part of the vendor hash: approve and reject never share one', () => {
    const base = {
      kind: 'market.vendor.vet',
      vendorId: '5a3b9c10-1111-4222-8333-444455556666',
      reason: 'documents checked fully',
    } as const;
    expect(payloadHashFor({ ...base, decision: 'approved' })).not.toBe(payloadHashFor({ ...base, decision: 'rejected' }));
  });
  it('the reason is part of the hash: a different reason is a different request', () => {
    const a = payloadHashFor({ kind: 'edge.kill', module: 'trade', disabled: true, reason: 'market integrity incident' });
    const b = payloadHashFor({ kind: 'edge.kill', module: 'trade', disabled: true, reason: 'market integrity incident!' });
    expect(a).not.toBe(b);
  });
  it('kill and re-enable of the same module never share a hash', () => {
    const kill = payloadHashFor({ kind: 'edge.kill', module: 'pay', disabled: true, reason: 'twelve chars!' });
    const resume = payloadHashFor({ kind: 'edge.kill', module: 'pay', disabled: false, reason: 'twelve chars!' });
    expect(kill).not.toBe(resume);
  });
});

describe('the identity approval is proposed against the target the service consumes', () => {
  it('market vet and academy ambassador verbs target their own service and verb at version 1', () => {
    const vendorId = '5a3b9c10-1111-4222-8333-444455556666';
    const userId = '9f8e7d6c-1111-4222-8333-444455556666';
    expect(proposeInputFor({ kind: 'market.vendor.vet', vendorId, decision: 'approved', reason: 'documents checked fully' })).toMatchObject(
      {
        actionType: 'market.vendor.vet',
        targetService: 'svc-market',
        targetId: 'market.vendor.vet',
        expectedVersion: '1',
        policyVersion: 'v1',
      },
    );
    expect(proposeInputFor({ kind: 'academy.ambassador.freeze', userId, reason: 'conduct complaint review' })).toMatchObject({
      targetService: 'svc-academy',
      targetId: 'academy.ambassador.freeze',
    });
    expect(proposeInputFor({ kind: 'academy.ambassador.unfreeze', userId })).toMatchObject({
      targetService: 'svc-academy',
      targetId: 'academy.ambassador.unfreeze',
    });
  });
  it('edge kill targets svc-edge kill:<module> at version 1', () => {
    expect(proposeInputFor({ kind: 'edge.kill', module: 'pay', disabled: true, reason: 'twelve chars!' })).toMatchObject({
      actionType: 'edge.kill',
      targetService: 'svc-edge',
      targetId: 'kill:pay',
      expectedVersion: '1',
      policyVersion: 'v1',
    });
  });
  it('ledger freeze and unfreeze target the ledger verbs, bound to the ledger’s own version', () => {
    const version = '2026-10-17 03:00:00.123456+00';
    expect(proposeInputFor({ kind: 'ledger.freeze', reason: 'reconciliation mismatch', version })).toMatchObject({
      actionType: 'ledger.freeze',
      targetService: 'svc-ledger',
      targetId: 'posting_freeze',
      expectedVersion: version,
    });
    expect(proposeInputFor({ kind: 'ledger.unfreeze', version })).toMatchObject({
      actionType: 'ledger.unfreeze',
      targetService: 'svc-ledger',
      targetId: 'posting_unfreeze',
      expectedVersion: version,
    });
  });
});
