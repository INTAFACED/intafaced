import { createHash } from 'node:crypto';
import { CONSOLE_MODE_TARGET_ID, CONSOLE_MODE_TARGET_SERVICE, consoleModeApprovalFields } from '@intafaced/contracts/ops-console-mode';
import { OPS_ALERT_ACCEPT_ACTION, opsAlertAcceptFields } from '@intafaced/contracts/ops-reconciliation-alerts';
import { marketTargetId, poolTargetId } from '@intafaced/contracts/protocol-ops';
import {
  STAFF_HOLD_TARGET_SERVICE,
  normaliseStaffHoldAmount,
  staffHoldConfirmFields,
  staffHoldReleaseFields,
  staffHoldTargetId,
} from '@intafaced/contracts/ops-staff-holds';
import { normaliseCostAmount } from '@/lib/venue-economics/model';
import type { DeskRequest } from './approval-packet';
import { staffExpectedVersion, staffSubjectFor, type StaffDeskRequest } from './approval-staff';

/** The verb svc-identity binds a waitlist wave release to (`waitlist.waves.release`). */
export const WAVE_RELEASE_TARGET = 'waitlist.wave.release';
/** svc-pay's action type for lifting a deposit address freeze (`DEPOSIT_ADDRESS_UNFREEZE_ACTION`). */
export const DEPOSIT_ADDRESS_UNFREEZE = 'pay.deposit_address_unfreeze';
/** svc-token governance founder doors (`services/svc-token/src/router.ts`, MC-token-02). */
export const GOVERNANCE_SETTINGS_SET = 'token.governance.settings.set';
export const GOVERNANCE_ROLE_SET = 'token.governance.role.set';
/** svc-token launch founder doors (`services/svc-token/src/launch/router.ts`). */
export const LAUNCH_ISSUER_SET = 'token.launch.issuer.set';
export const LAUNCH_EVENT_CREATE = 'token.launch.event.create';
export const LAUNCH_EVENT_MOVE = 'token.launch.event.move';
/** The verb svc-identity binds a KYC document read to (`kyc.getDocument`). */
export const KYC_DOCUMENT_GET = 'kyc.doc.get';
/** The verb svc-identity binds a selfie decision to (`kyc.selfie.decide`). */
export const KYC_SELFIE_DECIDE = 'kyc.selfie.decide';

/**
 * How a console request becomes an identity approval, and how the target service recomputes the same hash.
 *
 * The hash is the whole binding between "what the approver read" and "what the service will do". It must equal,
 * byte for byte, what the target computes at consume time:
 *   - svc-edge   `edgeActionPayloadHash('edge.kill', { module, disabled: 'true'|'false', reason })`
 *   - svc-ledger `ledgerActionPayloadHash('ledger.freeze', { reason })` / `('ledger.unfreeze', {})`,
 *     and `('ledger.reconciliation_control.run', { controlId, asOf, margin, reason })`,
 *     and `('ledger.reconciliation_control.lifecycle', { controlId, lifecycle, reason })`
 *   - svc-market `marketActionPayloadHash('market.vendor.vet', { vendorId, decision, reason })`
 *   - svc-academy `academyActionPayloadHash('academy.ambassador.freeze', { userId, reason })` / `.unfreeze` / `.appoint` `{ userId }`,
 *     and `('academy.residency.decide', { id, decision })`
 *   - svc-market takedown `marketActionPayloadHash('market.takedown', { listingId, reason })`
 *   - svc-identity key rotation `identityActionPayloadHash('identity.auth_key_rotate', { keyId })` / `('identity.auth_key_remove_old', { keyIds })`;
 *     waitlist wave release `identityActionPayloadHash('waitlist.wave.release', { wave, size })`;
 *     account unfreeze `identityUnfreezePayloadHash` = `identityActionPayloadHash(userId, { reason })`
 *     (`{ targetId, ...fields }`: the first key is `targetId`)
 *   - svc-pay deposit address unfreeze `payActionPayloadHash('pay.deposit_address_unfreeze', { freezeId, userId, networkId, address, reason })`
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

/**
 * A staff change (OPS-admin-access-03): identity's own form, `{ targetId, ...fields }`, over the contract's
 * `staffChangeApprovalSubject` (fields already normalised: trimmed, emails lower-cased, lists sorted, a new role's version
 * null). Some fields are lists, so the values are not all strings; the serialisation is the same `JSON.stringify`.
 */
export function staffPayloadHash(request: StaffDeskRequest): string {
  const subject = staffSubjectFor(request);
  return `sha256:${createHash('sha256')
    .update(JSON.stringify({ targetId: subject.targetId, ...subject.fields }))
    .digest('hex')}`;
}

export function payloadHashFor(request: DeskRequest): string {
  switch (request.kind) {
    case 'identity.staff.invite':
    case 'identity.staff.disable':
    case 'identity.staff.remove':
    case 'identity.roles.define':
    case 'identity.roles.assign':
    case 'identity.roles.unassign':
      return staffPayloadHash(request);
    case 'edge.kill':
      return sha('edge.kill', { module: request.module, disabled: request.disabled ? 'true' : 'false', reason: request.reason });
    case 'ledger.freeze':
      return sha('ledger.freeze', { reason: request.reason });
    case 'ledger.unfreeze':
      return sha('ledger.unfreeze', {});
    case 'ledger.reconciliation_control.run':
      return sha('ledger.reconciliation_control.run', {
        controlId: request.controlId,
        asOf: request.asOf,
        margin: request.margin,
        reason: request.reason,
      });
    case 'ledger.reconciliation_control.lifecycle':
      return sha('ledger.reconciliation_control.lifecycle', {
        controlId: request.controlId,
        lifecycle: request.lifecycle,
        reason: request.reason,
      });
    // svc-ledger `ledgerActionPayloadHash('ledger.account_metadata.delete', { accountId, key, reason })`.
    case 'ledger.account_metadata.delete':
      return sha('ledger.account_metadata.delete', { accountId: request.accountId, key: request.key, reason: request.reason });
    case 'market.vendor.vet':
      return sha('market.vendor.vet', { vendorId: request.vendorId, decision: request.decision, reason: request.reason });
    case 'academy.ambassador.freeze':
      return sha('academy.ambassador.freeze', { userId: request.userId, reason: request.reason });
    case 'academy.ambassador.unfreeze':
      return sha('academy.ambassador.unfreeze', { userId: request.userId });
    case 'identity.account.unfreeze':
      return shaIdentity(request.userId, { reason: request.reason });
    // svc-token `governanceSettingsPayload` and `governanceRolePayload`, in their order.
    case 'token.governance.settings.set':
      return sha(GOVERNANCE_SETTINGS_SET, {
        votingDelayMs: request.votingDelayMs,
        votingPeriodMs: request.votingPeriodMs,
        expectedRevision: request.revision,
      });
    case 'token.governance.role.set':
      return sha(GOVERNANCE_ROLE_SET, { userId: request.userId, role: request.role, expectedRevision: request.revision });
    // svc-token `tokenActionPayloadHash(actionType, fields)`, with the fields its launch router binds, in its order.
    case 'token.launch.issuer.set':
      return sha(LAUNCH_ISSUER_SET, {
        issuerId: request.issuerId,
        name: request.name,
        state: request.state,
        expectedRevision: request.revision,
      });
    case 'token.launch.event.create':
      return sha(LAUNCH_EVENT_CREATE, { event: request.event });
    case 'token.launch.event.move':
      return sha(LAUNCH_EVENT_MOVE, { eventId: request.eventId, to: request.to, expectedRevision: request.revision });
    // svc-pay `payActionPayloadHash('pay.deposit_address_unfreeze', unfreezeApprovalFields(...))`: ids and address lower-cased.
    case 'pay.deposit_address.unfreeze':
      return sha(DEPOSIT_ADDRESS_UNFREEZE, {
        freezeId: request.freezeId.toLowerCase(),
        userId: request.userId,
        networkId: request.networkId,
        address: request.address.toLowerCase(),
        reason: request.reason,
      });
    // svc-identity `identityClosurePayloadHash`: { targetId, action, reasonCode (close only), reason }, in this order.
    case 'identity.account.close':
      return shaIdentity(request.userId, { action: 'close', reasonCode: request.reasonCode, reason: request.reason });
    case 'identity.account.reopen':
      return shaIdentity(request.userId, { action: 'reopen', reason: request.reason });
    // svc-identity `identityArchivePayloadHash`: { targetId, action: 'archive', reasonCode, reason }, in this order.
    case 'identity.account.archive':
      return shaIdentity(request.userId, { action: 'archive', reasonCode: request.reasonCode, reason: request.reason });
    // svc-identity `identityTierPayloadHash`: { targetId, action: 'tier_move', tierId, reason }, in this order.
    case 'identity.account.tier_move':
      return shaIdentity(request.userId, { action: 'tier_move', tierId: request.tierId, reason: request.reason });
    // svc-identity `identityLimitPayloadHash`: { targetId, action: 'limit_override', rail, assetId, perTx, rolling24h, expiresAt,
    // reason }, in this order, a null figure as ''.
    case 'identity.account.limit_override':
      return shaIdentity(request.userId, {
        action: 'limit_override',
        rail: request.rail,
        assetId: request.assetId,
        perTx: request.perTx ?? '',
        rolling24h: request.rolling24h ?? '',
        expiresAt: request.expiresAt,
        reason: request.reason,
      });
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
    // svc-identity `consumePrivileged(…, 'kyc.doc.get', { documentId })`: { targetId: 'kyc.doc.get', documentId }.
    case 'identity.kyc_document.open':
      return shaIdentity(KYC_DOCUMENT_GET, { documentId: request.documentId });
    // svc-identity `consumePrivileged(…, 'kyc.selfie.decide', { selfieId, decision })`, in this order.
    case 'identity.kyc_selfie.decide':
      return shaIdentity(KYC_SELFIE_DECIDE, { selfieId: request.selfieId, decision: request.decision });
    // svc-identity `waitlist.waves.release`: { targetId: 'waitlist.wave.release', wave, size }, in this order.
    case 'campaigns.waitlist.wave_release':
      return shaIdentity(WAVE_RELEASE_TARGET, { wave: request.wave, size: request.size });
    // svc-ops `approvalPayloadHash(action, consoleModeApprovalFields(action, reason))`: { targetId: 'console', reason } on, { targetId } off.
    case 'ops.console_mode.on':
      return sha(request.kind, consoleModeApprovalFields(request.kind, request.reason));
    case 'ops.console_mode.off':
      return sha(request.kind, consoleModeApprovalFields(request.kind, null));
    // svc-ops `approvalPayloadHash('ops.hold.release', staffHoldReleaseFields(holdNo, amount))`: { targetId: 'hold:<n>', amount }.
    case 'ops.hold.release':
      return sha(request.kind, staffHoldReleaseFields(request.holdNo, normaliseStaffHoldAmount(request.amount)));
    // svc-ops `approvalPayloadHash('ops.hold.confirm', staffHoldConfirmFields(holdNo))`: { targetId: 'hold:<n>' }.
    case 'ops.hold.confirm':
      return sha(request.kind, staffHoldConfirmFields(request.holdNo));
    // svc-ops `approvalPayloadHash('ops.reconciliation_alert.accept', opsAlertAcceptFields(alertId, note, evidenceHash))`.
    case 'ops.reconciliation_alert.accept':
      return sha(OPS_ALERT_ACCEPT_ACTION, opsAlertAcceptFields(request.alertId, request.reason, request.evidenceHash));
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
    // svc-ops `approvalPayloadHash('ops.restore.record', parseWatermarkInput(...))`: { service, kind, watermark }, in this order.
    case 'ops.restore.record':
      return sha(request.kind, { service: request.service, kind: request.stampKind, watermark: request.watermark });
    // svc-ops' restore desk binds the run: `approvalPayloadHash('ops.restore.finalize', { restoreNo, cutOff })`.
    case 'ops.restore.finalize':
      return sha(request.kind, { restoreNo: request.restoreNo, cutOff: request.cutOff });
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
    // svc-identity binds a staff change to the contract's target (`invite:<email>`, `staff:<id>`, `role:<id>` or
    // `role:new:<name>`) at the record or role version read, and 0 for something new. The action type is the request kind.
    case 'identity.staff.invite':
    case 'identity.staff.disable':
    case 'identity.staff.remove':
    case 'identity.roles.define':
    case 'identity.roles.assign':
    case 'identity.roles.unassign': {
      const subject = staffSubjectFor(request);
      return {
        actionType: subject.actionType,
        targetService: subject.targetService,
        targetId: subject.targetId,
        expectedVersion: staffExpectedVersion(request),
        payloadHash,
        policyVersion: 'v1',
      };
    }
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
    // svc-ledger consumes a control run at the control version it reads, against `posting_reconciliation_control.run`.
    case 'ledger.reconciliation_control.run':
      return {
        actionType: 'ledger.reconciliation_control.run',
        targetService: 'svc-ledger',
        targetId: 'posting_reconciliation_control.run',
        expectedVersion: request.version,
        payloadHash,
        policyVersion: 'v1',
      };
    // svc-ledger consumes a lifecycle move at the control version it reads under the row lock.
    case 'ledger.reconciliation_control.lifecycle':
      return {
        actionType: 'ledger.reconciliation_control.lifecycle',
        targetService: 'svc-ledger',
        targetId: 'posting_reconciliation_control.lifecycle',
        expectedVersion: request.version,
        payloadHash,
        policyVersion: 'v1',
      };
    // svc-ledger consumes a metadata delete at the key's revision it reads, against `posting_account_metadata.delete`.
    case 'ledger.account_metadata.delete':
      return {
        actionType: 'ledger.account_metadata.delete',
        targetService: 'svc-ledger',
        targetId: 'posting_account_metadata.delete',
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
    case 'identity.account.archive':
      return {
        actionType:
          request.kind === 'identity.account.close'
            ? 'identity.account_close'
            : request.kind === 'identity.account.reopen'
              ? 'identity.account_reopen'
              : 'identity.account_archive',
        targetService: 'svc-identity',
        targetId: request.userId,
        expectedVersion: request.version,
        payloadHash,
        policyVersion: 'v1',
      };
    // svc-identity's tier move is bound to the account, at the tier version the founder read. Founder-only at identity.
    case 'identity.account.tier_move':
      return {
        actionType: 'identity.account_tier_move',
        targetService: 'svc-identity',
        targetId: request.userId,
        expectedVersion: request.version,
        payloadHash,
        policyVersion: 'v1',
      };
    // svc-identity's limit override is bound to the account, at the override version the founder read. Founder-only at identity.
    case 'identity.account.limit_override':
      return {
        actionType: 'identity.change_limit',
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
    // svc-identity consumes a document read against its own verb as the target id, at version 1. Operator-level at identity.
    case 'identity.kyc_document.open':
      return {
        actionType: KYC_DOCUMENT_GET,
        targetService: 'svc-identity',
        targetId: KYC_DOCUMENT_GET,
        expectedVersion: '1',
        payloadHash,
        policyVersion: 'v1',
      };
    // svc-identity consumes a selfie decision against its own verb as the target id, at version 1.
    case 'identity.kyc_selfie.decide':
      return {
        actionType: KYC_SELFIE_DECIDE,
        targetService: 'svc-identity',
        targetId: KYC_SELFIE_DECIDE,
        expectedVersion: '1',
        payloadHash,
        policyVersion: 'v1',
      };
    // svc-identity consumes a wave release against its own verb as the target id, at version 1.
    case 'campaigns.waitlist.wave_release':
      return {
        actionType: WAVE_RELEASE_TARGET,
        targetService: 'svc-identity',
        targetId: WAVE_RELEASE_TARGET,
        expectedVersion: '1',
        payloadHash,
        policyVersion: 'v1',
      };
    // svc-token consumes against its own verb as the target id, at the revision read.
    case 'token.governance.settings.set':
    case 'token.governance.role.set': {
      const actionType = request.kind === 'token.governance.settings.set' ? GOVERNANCE_SETTINGS_SET : GOVERNANCE_ROLE_SET;
      return {
        actionType,
        targetService: 'svc-token',
        targetId: actionType,
        expectedVersion: request.revision,
        payloadHash,
        policyVersion: 'v1',
      };
    }
    // svc-token consumes against its own verb as the target id, at the revision read; a new issuer or launch is at 0.
    case 'token.launch.issuer.set':
    case 'token.launch.event.move':
    case 'token.launch.event.create': {
      const actionType =
        request.kind === 'token.launch.issuer.set'
          ? LAUNCH_ISSUER_SET
          : request.kind === 'token.launch.event.move'
            ? LAUNCH_EVENT_MOVE
            : LAUNCH_EVENT_CREATE;
      return {
        actionType,
        targetService: 'svc-token',
        targetId: actionType,
        expectedVersion: request.kind === 'token.launch.event.create' ? '0' : request.revision,
        payloadHash,
        policyVersion: 'v1',
      };
    }
    // svc-pay consumes against its own verb as the target id, at version 1 (`consumePayApproval`). The freeze id is in the hash.
    case 'pay.deposit_address.unfreeze':
      return {
        actionType: DEPOSIT_ADDRESS_UNFREEZE,
        targetService: 'svc-pay',
        targetId: DEPOSIT_ADDRESS_UNFREEZE,
        expectedVersion: '1',
        payloadHash,
        policyVersion: 'v1',
      };
    // svc-ops consumes against the console itself; its target service is not on identity's operator list, so both founders are needed.
    case 'ops.console_mode.on':
    case 'ops.console_mode.off':
      return {
        actionType: request.kind,
        targetService: CONSOLE_MODE_TARGET_SERVICE,
        targetId: CONSOLE_MODE_TARGET_ID,
        expectedVersion: '1',
        payloadHash,
        policyVersion: 'v1',
      };
    // svc-ops consumes against the hold itself. Its target service is not on identity's operator list, so both founders are needed.
    case 'ops.hold.release':
    case 'ops.hold.confirm':
      return {
        actionType: request.kind,
        targetService: STAFF_HOLD_TARGET_SERVICE,
        targetId: staffHoldTargetId(request.holdNo),
        expectedVersion: '1',
        payloadHash,
        policyVersion: 'v1',
      };
    // svc-ops consumes against the alert itself. Its target service is not on identity's operator list, so both founders are needed.
    case 'ops.reconciliation_alert.accept':
      return {
        actionType: OPS_ALERT_ACCEPT_ACTION,
        targetService: 'svc-ops',
        targetId: opsAlertAcceptFields(request.alertId, request.reason, request.evidenceHash).targetId,
        expectedVersion: '1',
        payloadHash,
        policyVersion: 'v1',
      };
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
    // svc-ops consumes a stamp against the service and kind, and finalize against the run; both founders are needed.
    case 'ops.restore.record':
      return {
        actionType: request.kind,
        targetService: 'svc-ops',
        targetId: `watermark:${request.service}:${request.stampKind}`,
        expectedVersion: '1',
        payloadHash,
        policyVersion: 'v1',
      };
    case 'ops.restore.finalize':
      return {
        actionType: request.kind,
        targetService: 'svc-ops',
        targetId: `restore:${request.restoreNo}`,
        expectedVersion: '1',
        payloadHash,
        policyVersion: 'v1',
      };
  }
}
