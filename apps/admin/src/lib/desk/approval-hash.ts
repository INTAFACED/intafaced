import { createHash } from 'node:crypto';
import type { DeskRequest } from './approval-packet';

/**
 * How a console request becomes an identity approval, and how the target service recomputes the same hash.
 *
 * The hash is the whole binding between "what the approver read" and "what the service will do". It must equal,
 * byte for byte, what the target computes at consume time:
 *   - svc-edge   `edgeActionPayloadHash('edge.kill', { module, disabled: 'true'|'false', reason })`
 *   - svc-ledger `ledgerActionPayloadHash('ledger.freeze', { reason })` / `('ledger.unfreeze', {})`
 *   - svc-market `marketActionPayloadHash('market.vendor.vet', { vendorId, decision, reason })`
 *   - svc-academy `academyActionPayloadHash('academy.ambassador.freeze', { userId, reason })` / `.unfreeze` `{ userId }`
 * Both are `sha256(JSON.stringify({ actionType, ...fields }))` with fields in the order shown. Key order is part
 * of the hash, so do not reorder anything here. `approval-hash.test.ts` pins this against the services' own
 * functions so drift fails a test instead of silently making every approval unconsumable.
 *
 * The version a ledger approval is bound to (`expectedVersion`) is NOT in the hash; identity stores it on the row
 * and the ledger passes its current `changedAtPrecise` at consume. A freeze state that changed since the proposal
 * therefore refuses at consume (`action_approval.target_mismatch`) instead of acting on stale intent.
 */

function sha(actionType: string, fields: Record<string, string>): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify({ actionType, ...fields }))
    .digest('hex')}`;
}

export function payloadHashFor(request: DeskRequest): string {
  switch (request.kind) {
    case 'edge.kill':
      return sha('edge.kill', { module: request.module, disabled: request.disabled ? 'true' : 'false', reason: request.reason });
    case 'ledger.freeze':
      return sha('ledger.freeze', { reason: request.reason });
    case 'ledger.unfreeze':
      return sha('ledger.unfreeze', {});
    case 'market.vendor.vet':
      return sha('market.vendor.vet', { vendorId: request.vendorId, decision: request.decision, reason: request.reason });
    case 'academy.ambassador.freeze':
      return sha('academy.ambassador.freeze', { userId: request.userId, reason: request.reason });
    case 'academy.ambassador.unfreeze':
      return sha('academy.ambassador.unfreeze', { userId: request.userId });
  }
}

export interface ProposeInput {
  readonly actionType: string;
  readonly targetService: string;
  readonly targetId: string;
  readonly expectedVersion: string;
  readonly payloadHash: string;
  readonly policyVersion: string;
}

/** The identity `actionApproval.propose` input for a request. Targets are the ones the services consume against. */
export function proposeInputFor(request: DeskRequest): ProposeInput {
  const payloadHash = payloadHashFor(request);
  switch (request.kind) {
    case 'edge.kill':
      return {
        actionType: 'edge.kill',
        targetService: 'svc-edge',
        targetId: `kill:${request.module}`,
        expectedVersion: '1',
        payloadHash,
        policyVersion: 'v1',
      };
    case 'ledger.freeze':
      return {
        actionType: 'ledger.freeze',
        targetService: 'svc-ledger',
        targetId: 'posting_freeze',
        expectedVersion: request.version,
        payloadHash,
        policyVersion: 'v1',
      };
    case 'ledger.unfreeze':
      return {
        actionType: 'ledger.unfreeze',
        targetService: 'svc-ledger',
        targetId: 'posting_unfreeze',
        expectedVersion: request.version,
        payloadHash,
        policyVersion: 'v1',
      };
    // Market and Academy consume against their own verb as the target id, at version 1. Both are operator-level at
    // identity (not money), so the console's founders qualify.
    case 'market.vendor.vet':
      return {
        actionType: request.kind,
        targetService: 'svc-market',
        targetId: request.kind,
        expectedVersion: '1',
        payloadHash,
        policyVersion: 'v1',
      };
    case 'academy.ambassador.freeze':
    case 'academy.ambassador.unfreeze':
      return {
        actionType: request.kind,
        targetService: 'svc-academy',
        targetId: request.kind,
        expectedVersion: '1',
        payloadHash,
        policyVersion: 'v1',
      };
  }
}
