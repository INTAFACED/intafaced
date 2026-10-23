import { createHash } from 'node:crypto';
import { marketTargetId, poolTargetId } from '@intafaced/contracts/protocol-ops';
import { normaliseCostAmount } from '@/lib/venue-economics/model';
import type { DeskRequest } from './approval-packet';

/**
 * How a console request becomes an identity approval, and how the target service recomputes the same hash.
 *
 * The hash is the whole binding between "what the approver read" and "what the service will do". It must equal,
 * byte for byte, what the target computes at consume time:
 *   - svc-edge   `edgeActionPayloadHash('edge.kill', { module, disabled: 'true'|'false', reason })`
 *   - svc-ledger `ledgerActionPayloadHash('ledger.freeze', { reason })` / `('ledger.unfreeze', {})`
 *   - svc-market `marketActionPayloadHash('market.vendor.vet', { vendorId, decision, reason })`
 *   - svc-academy `academyActionPayloadHash('academy.ambassador.freeze', { userId, reason })` / `.unfreeze` / `.appoint` `{ userId }`,
 *     and `('academy.residency.decide', { id, decision })`
 *   - svc-market takedown `marketActionPayloadHash('market.takedown', { listingId, reason })`
 *   - svc-identity key rotation `identityActionPayloadHash('identity.auth_key_rotate', { keyId })` / `('identity.auth_key_remove_old', { keyIds })`;
 *     account unfreeze `identityUnfreezePayloadHash` = `identityActionPayloadHash(userId, { reason })`
 *     (`{ targetId, ...fields }`: the first key is `targetId`)
 *   - svc-bank card freeze `bankActionPayloadHash('bank.ops.setCardStatus', { cardId, status })` (sorted fields, nested under `fields`;
 *     the reason is NOT in this hash)
 * Both are `sha256(JSON.stringify({ actionType, ...fields }))` with fields in the order shown. Key order is part
 * of the hash, so do not reorder anything here. `approval-hash.test.ts` pins this against the services' own
 * functions so drift fails a test instead of silently making every approval unconsumable.
 *
 * The version a ledger approval is bound to (`expectedVersion`) is NOT in the hash; identity stores it on the row
 * and the ledger passes its current `changedAtPrecise` at consume. A freeze state that changed since the proposal
 * therefore refuses at consume (`action_approval.target_mismatch`) instead of acting on stale intent.
 */

/** svc-bank hashes `{ actionType, fields }` with the field names sorted (`bankActionPayloadHash`). */
function shaBank(actionType: string, fields: Record<string, string>): string {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(fields).sort()) sorted[key] = fields[key]!;
  return `sha256:${createHash('sha256')
    .update(JSON.stringify({ actionType, fields: sorted }))
    .digest('hex')}`;
}

function sha(actionType: string, fields: Record<string, string>): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify({ actionType, ...fields }))
    .digest('hex')}`;
}

/** svc-identity hashes `{ targetId, ...fields }` (`identityActionPayloadHash`): the key is `targetId`, not `actionType`. */
function shaIdentity(targetId: string, fields: Record<string, string>): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify({ targetId, ...fields }))
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
    case 'identity.account.unfreeze':
      return shaIdentity(request.userId, { reason: request.reason });
    // svc-identity `identityClosurePayloadHash`: { targetId, action, reasonCode (close only), reason }, in this order.
    case 'identity.account.close':
      return shaIdentity(request.userId, { action: 'close', reasonCode: request.reasonCode, reason: request.reason });
    case 'identity.account.reopen':
      return shaIdentity(request.userId, { action: 'reopen', reason: request.reason });
    case 'academy.ambassador.appoint':
      return sha('academy.ambassador.appoint', { userId: request.userId });
    case 'academy.residency.decide':
      return sha('academy.residency.decide', { id: request.id, decision: request.decision });
    case 'bank.card.status':
      return shaBank('bank.ops.setCardStatus', { cardId: request.cardId, status: request.status });
    case 'market.listing.takedown':
      return sha('market.takedown', { listingId: request.listingId, reason: request.reason });
    case 'identity.auth_key.rotate':
      return shaIdentity('identity.auth_key_rotate', { keyId: request.keyId });
    case 'identity.auth_key.remove_old':
      return shaIdentity('identity.auth_key_remove_old', { keyIds: request.keyIds });
    // svc-ops `approvalPayloadHash('ops.venue_cost.record', { period, category, amount, asset, sourceNote })`, fields in this order.
    case 'ops.venue_cost.record':
      return sha('ops.venue_cost.record', {
        period: request.period,
        category: request.category,
        amount: normaliseCostAmount(request.amount),
        asset: request.asset,
        sourceNote: request.reason,
      });
    // svc-ops `approvalPayloadHash(action, { targetId, reasonCode, reason })` for a hide or delist, `{ targetId }` for a restore.
    case 'protocol.pool.hide':
      return sha(request.kind, {
        targetId: poolTargetId(request.chainId, request.poolAddress),
        reasonCode: request.reasonCode,
        reason: request.reason,
      });
    case 'protocol.pool.restore':
      return sha(request.kind, { targetId: poolTargetId(request.chainId, request.poolAddress) });
    case 'protocol.market.delist':
      return sha(request.kind, { targetId: marketTargetId(request.symbol), reasonCode: request.reasonCode, reason: request.reason });
    case 'protocol.market.restore':
      return sha(request.kind, { targetId: marketTargetId(request.symbol) });
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
    case 'academy.ambassador.appoint':
    case 'academy.residency.decide':
      return {
        actionType: request.kind,
        targetService: 'svc-academy',
        targetId: request.kind,
        expectedVersion: '1',
        payloadHash,
        policyVersion: 'v1',
      };
    // svc-bank consumes against its own verb as the target id (a founder-level action: identity wants both founders live).
    case 'bank.card.status':
      return {
        actionType: 'bank.ops.setCardStatus',
        targetService: 'svc-bank',
        targetId: 'bank.ops.setCardStatus',
        expectedVersion: '1',
        payloadHash,
        policyVersion: 'v1',
      };
    // svc-market's takedown is bound to the listing itself: the target id is the listing id.
    case 'market.listing.takedown':
      return {
        actionType: 'market.takedown',
        targetService: 'svc-market',
        targetId: request.listingId,
        expectedVersion: '1',
        payloadHash,
        policyVersion: 'v1',
      };
    // svc-identity's staff close and reopen are bound to the account itself, at the control version the founder read.
    case 'identity.account.close':
    case 'identity.account.reopen':
      return {
        actionType: request.kind === 'identity.account.close' ? 'identity.account_close' : 'identity.account_reopen',
        targetService: 'svc-identity',
        targetId: request.userId,
        expectedVersion: request.version,
        payloadHash,
        policyVersion: 'v1',
      };
    // svc-identity's restore is bound to the account itself, at the control version the founder read.
    case 'identity.account.unfreeze':
      return {
        actionType: 'identity.account_unfreeze',
        targetService: 'svc-identity',
        targetId: request.userId,
        expectedVersion: request.version,
        payloadHash,
        policyVersion: 'v1',
      };
    // svc-identity consumes against its own verb as the target id. Both are founder-only action types at identity.
    case 'identity.auth_key.rotate':
    case 'identity.auth_key.remove_old': {
      const verb = request.kind === 'identity.auth_key.rotate' ? 'identity.auth_key_rotate' : 'identity.auth_key_remove_old';
      return { actionType: verb, targetService: 'svc-identity', targetId: verb, expectedVersion: '1', payloadHash, policyVersion: 'v1' };
    }
    // svc-ops consumes against the month and line. Its target service is not on identity's operator list, so both founders are needed.
    case 'ops.venue_cost.record':
      return {
        actionType: 'ops.venue_cost.record',
        targetService: 'svc-ops',
        targetId: `venue-cost:${request.period}:${request.category}`,
        expectedVersion: '1',
        payloadHash,
        policyVersion: 'v1',
      };
    // svc-ops consumes against the pool or market itself; its target service is not on identity's operator list, so both founders are needed.
    case 'protocol.pool.hide':
    case 'protocol.pool.restore':
      return {
        actionType: request.kind,
        targetService: 'svc-ops',
        targetId: poolTargetId(request.chainId, request.poolAddress),
        expectedVersion: '1',
        payloadHash,
        policyVersion: 'v1',
      };
    case 'protocol.market.delist':
    case 'protocol.market.restore':
      return {
        actionType: request.kind,
        targetService: 'svc-ops',
        targetId: marketTargetId(request.symbol),
        expectedVersion: '1',
        payloadHash,
        policyVersion: 'v1',
      };
  }
}
