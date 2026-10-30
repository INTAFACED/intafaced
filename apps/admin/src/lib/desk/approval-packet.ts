import { isModuleId, type ModuleId } from '@intafaced/config';
import {
  RECONCILIATION_LIFECYCLE,
  reconciliationDecimalSchema,
  type ReconciliationLifecycle,
} from '@intafaced/contracts/ledger-reconciliation';
import { COST_AMOUNT, COST_ASSET, PERIOD, isCategory, type CostCategory } from '@/lib/venue-economics/model';
import { METADATA_KEY } from '@/lib/ledger/account-metadata';
import {
  LAUNCH_ID,
  LAUNCH_ISSUER_STATES,
  LAUNCH_MOVE_TARGETS,
  readLaunchEventPayload,
  type LaunchIssuerState,
  type LaunchMoveTarget,
} from '@/lib/launch-issuers/model';
import { STAFF_HOLD_AMOUNT_PATTERN, STAFF_HOLD_ASSET_PATTERN } from '@intafaced/contracts/ops-staff-holds';
import { kycSelfieDecisionSchema, type KycSelfieDecision } from '@intafaced/contracts/identity-kyc-selfie';
import {
  accountLimitAmountSchema,
  accountLimitAssetIdSchema,
  ACCOUNT_LIMIT_RAILS,
  type AccountLimitRail,
} from '@intafaced/contracts/account-controls';

/**
 * The request a founder hands to the other founder.
 *
 * Identity can issue, approve and consume an approval but has no read for "which approvals are waiting for me"
 * or "was mine approved yet" (gap filed in admin-BACKEND-NEEDS.md). So the first founder's console shows a
 * REQUEST PACKET: the approval id, the operation id and the exact request, as one line of text. The second founder
 * pastes it, reads the decoded request in plain words, and approves THAT request.
 *
 * A packet is not authority. The approver's console recomputes the payload hash from the fields it DECODED and
 * identity refuses (`action_approval.payload_mismatch`) unless that equals the hash stored when the first founder
 * proposed. A packet edited in transit therefore cannot get a different request approved.
 *
 * Pure: no Node-only imports, so the browser and the server use the same parser.
 */

/** identity's staff close reason codes (`accountCloseReasonCodes` in contracts; a test keeps the two equal). */
export const CLOSE_REASON_CODES = ['fraud', 'negative_balance', 'bank_reason', 'customer_request', 'other'] as const;
export type AccountCloseReasonCode = (typeof CLOSE_REASON_CODES)[number];
/** Identity's archive reason codes (contracts `accountArchiveReasonCodes`, J-ops-console-04 #10). */
export const ARCHIVE_REASON_CODES = ['dormant', 'customer_request', 'duplicate', 'other'] as const;
export type AccountArchiveReasonCode = (typeof ARCHIVE_REASON_CODES)[number];

export const PACKET_PREFIX = 'ifa1.';
export const REASON_MIN = 12;
export const REASON_MAX = 500;
const MAX_PACKET_CHARS = 6_000;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const VERSION = /^[\x20-\x7e]{1,128}$/;
const WHOLE = /^[1-9][0-9]{0,8}$/;
const REVISION = /^(?:0|[1-9][0-9]{0,8})$/;

export type DeskRequest =
  | { readonly kind: 'edge.kill'; readonly module: ModuleId; readonly disabled: boolean; readonly reason: string }
  | { readonly kind: 'ledger.freeze'; readonly reason: string; readonly version: string }
  | { readonly kind: 'ledger.unfreeze'; readonly version: string }
  /**
   * Run one reconciliation control (svc-ledger OPS-reconciliation-01). `version` is the control version read; `asOf` is `now` or a
   * past instant as an ISO string; `margin` is the seconds read before that instant, or `unset` for a run now. All four are signed.
   */
  | {
      readonly kind: 'ledger.reconciliation_control.run';
      readonly controlId: string;
      readonly version: string;
      readonly asOf: string;
      readonly margin: string;
      readonly reason: string;
    }
  /**
   * Pause, resume or retire one reconciliation control (svc-ledger OPS-reconciliation-02). `version` is the control version
   * read; svc-ledger binds the control, the move and the reason to the approval at that version.
   */
  | {
      readonly kind: 'ledger.reconciliation_control.lifecycle';
      readonly controlId: string;
      readonly version: string;
      readonly lifecycle: ReconciliationLifecycle;
      readonly reason: string;
    }
  /**
   * Delete one operator metadata key on a ledger account (svc-ledger, J-ops-console-03 #6). `version` is the key's revision
   * read; svc-ledger binds the account, the key and the reason to the approval at that revision.
   */
  | {
      readonly kind: 'ledger.account_metadata.delete';
      readonly accountId: string;
      readonly key: string;
      readonly reason: string;
      readonly version: string;
    }
  | { readonly kind: 'market.vendor.vet'; readonly vendorId: string; readonly decision: VendorDecision; readonly reason: string }
  | { readonly kind: 'academy.ambassador.freeze'; readonly userId: string; readonly reason: string }
  | { readonly kind: 'academy.ambassador.unfreeze'; readonly userId: string }
  | { readonly kind: 'academy.ambassador.appoint'; readonly userId: string }
  | { readonly kind: 'academy.residency.decide'; readonly id: string; readonly decision: ResidencyDecision }
  | { readonly kind: 'bank.card.status'; readonly cardId: string; readonly status: CardStatus; readonly reason: string }
  | { readonly kind: 'market.listing.takedown'; readonly listingId: string; readonly reason: string }
  | { readonly kind: 'identity.auth_key.rotate'; readonly keyId: string }
  | { readonly kind: 'identity.auth_key.remove_old'; readonly keyIds: string }
  /** Release the next waitlist wave (svc-identity `waitlist.waves.release`, RC-campaigns-03). `size` is the owner's wave size read. */
  | { readonly kind: 'campaigns.waitlist.wave_release'; readonly wave: string; readonly size: string }
  /** Lift a staff freeze on one account (svc-identity `accountControls.change`, restore). `version` is the identity control version read. */
  | { readonly kind: 'identity.account.unfreeze'; readonly userId: string; readonly reason: string; readonly version: string }
  /**
   * Launch issuer lens (svc-token `launch.*`, J-more-catalogue-14). `revision` is the issuer's or the launch's revision read
   * (0 for a new issuer); `event` is svc-token's canonical launch payload, exactly the text the founders approve.
   */
  | {
      readonly kind: 'token.launch.issuer.set';
      readonly issuerId: string;
      readonly name: string;
      readonly state: LaunchIssuerState;
      readonly revision: string;
    }
  | { readonly kind: 'token.launch.event.create'; readonly event: string }
  | { readonly kind: 'token.launch.event.move'; readonly eventId: string; readonly to: LaunchMoveTarget; readonly revision: string }
  /** Lift a compliance freeze on one customer deposit address (svc-pay `founderAdmin.depositFreezes.unfreeze`). `freezeId` is the open freeze read. */
  | {
      readonly kind: 'pay.deposit_address.unfreeze';
      readonly userId: string;
      readonly networkId: string;
      readonly address: string;
      readonly freezeId: string;
      readonly reason: string;
    }
  /** Staff close and reopen of one account (J-ops-console-04 #7). A close carries a reason code from identity's list. */
  | {
      readonly kind: 'identity.account.close';
      readonly userId: string;
      readonly reasonCode: AccountCloseReasonCode;
      readonly reason: string;
      readonly version: string;
    }
  | { readonly kind: 'identity.account.reopen'; readonly userId: string; readonly reason: string; readonly version: string }
  /** Archive of one closed customer record (J-ops-console-04 #10). Irreversible; a reason code from identity's list. */
  | {
      readonly kind: 'identity.account.archive';
      readonly userId: string;
      readonly reasonCode: AccountArchiveReasonCode;
      readonly reason: string;
      readonly version: string;
    }
  /** Move one account onto another product tier (J-ops-console-04 #11). `version` is the account's tier version read. */
  | {
      readonly kind: 'identity.account.tier_move';
      readonly userId: string;
      readonly tierId: string;
      readonly reason: string;
      readonly version: string;
    }
  /**
   * A customer limit override above the owner ceiling (J-ops-console-04 #12): the figures (null keeps the base figure), the
   * stored end time and the override version read. Under the ceiling one founder sets it directly, with no packet.
   */
  | {
      readonly kind: 'identity.account.limit_override';
      readonly userId: string;
      readonly rail: AccountLimitRail;
      readonly assetId: string;
      readonly perTx: string | null;
      readonly rolling24h: string | null;
      readonly expiresAt: string;
      readonly reason: string;
      readonly version: string;
    }
  /**
   * Release part or all of one staff hold on a customer's funds back to them (svc-ops `staffHolds.release`, J-ops-console-04
   * #3, #4). svc-ops binds the hold and the amount; the customer and coin are shown so the approver knows whose money it is.
   */
  | {
      readonly kind: 'ops.hold.release';
      readonly holdNo: string;
      readonly userId: string;
      readonly assetId: string;
      readonly amount: string;
      readonly reason: string;
    }
  /** Confirm one staff hold: what is still held moves to the owner-named account (svc-ops `staffHolds.confirm`, #5). */
  | {
      readonly kind: 'ops.hold.confirm';
      readonly holdNo: string;
      readonly userId: string;
      readonly assetId: string;
      readonly reason: string;
    }
  /**
   * Accept one reconciliation discrepancy (svc-ops `alerts.accept`, OPS-reconciliation-04, J-ops-console-07 #9). svc-ops binds
   * the alert, the note and the hash of the evidence both founders read; a changed figure no longer matches and is refused.
   * The note is `reason`. A blank one parses so the route can refuse it by name before identity is asked.
   */
  | { readonly kind: 'ops.reconciliation_alert.accept'; readonly alertId: string; readonly evidenceHash: string; readonly reason: string }
  /** One venue cost note (svc-ops `recordVenueCost`). `reason` is the source note the service stores and the approver signs. */
  | {
      readonly kind: 'ops.venue_cost.record';
      readonly period: string;
      readonly category: CostCategory;
      readonly amount: string;
      readonly asset: string;
      readonly reason: string;
    }
  /**
   * Protocol listing decisions (svc-ops `protocolListing`). A hide or delist carries an owner-published reason code and a free-text
   * reason, both signed by the approver; a restore carries neither. A hide is a listing decision, not an on-chain pause.
   */
  | {
      readonly kind: 'protocol.pool.hide';
      readonly chainId: number;
      readonly poolAddress: string;
      readonly reasonCode: string;
      readonly reason: string;
    }
  | { readonly kind: 'protocol.pool.restore'; readonly chainId: number; readonly poolAddress: string }
  | { readonly kind: 'protocol.market.delist'; readonly symbol: string; readonly reasonCode: string; readonly reason: string }
  | { readonly kind: 'protocol.market.restore'; readonly symbol: string }
  /** Console maintenance mode (svc-ops `consoleMode.set`, OPS-admin-access-08): on with a reason, off with none. Both need a second founder. */
  | { readonly kind: 'ops.console_mode.on'; readonly reason: string }
  | { readonly kind: 'ops.console_mode.off' }
  /**
   * Open one KYC document from identity's encrypted vault (svc-identity `kyc.getDocument`, J-ops-console-02 #5). Identity binds
   * the approval to the document id alone and spends it on the read, so one approval opens it once.
   */
  | { readonly kind: 'identity.kyc_document.open'; readonly documentId: string }
  /**
   * Accept or reject one selfie a person sent for comparison with their ID photo (svc-identity `kyc.selfie.decide`,
   * I-kyc-compliance-09). Identity binds the selfie id and the decision to the approval; neither founder may be the person.
   */
  | { readonly kind: 'identity.kyc_selfie.decide'; readonly selfieId: string; readonly decision: SelfieDecision };

export const VENDOR_DECISIONS = ['approved', 'rejected', 'suspended'] as const;
export type VendorDecision = (typeof VENDOR_DECISIONS)[number];
export const CARD_STATUSES = ['frozen', 'active'] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];
export const RESIDENCY_DECISIONS = ['accepted', 'rejected'] as const;
export type ResidencyDecision = (typeof RESIDENCY_DECISIONS)[number];
/** The decisions identity takes on a selfie (`kycSelfieDecisionSchema`). */
export const SELFIE_DECISIONS = kycSelfieDecisionSchema.options;
export type SelfieDecision = KycSelfieDecision;
/** svc-identity's signing-key id, and the sorted comma list of ids a remove-old names (`auth-key-ring.ts`). */
const AUTH_KEY_ID = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const POOL_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const REASON_CODE = /^[A-Za-z0-9._:-]{1,64}$/;
/** A market symbol as the service keys it: no surrounding space, no lower case, so one market has one target id. */
const MARKET_SYMBOL = /^[A-Z0-9][A-Z0-9._/-]{0,63}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** svc-ops' reconciliation alert evidence hash: SHA-256 hex of the contract's canonical evidence. */
const EVIDENCE_HASH = /^[0-9a-f]{64}$/;
/** svc-ops' staff hold number: one global sequence. */
const HOLD_NO = /^[1-9][0-9]{0,18}$/;
/** svc-pay's network id and deposit address shapes (`custody/deposits/freezes.ts`), and the platform's user and freeze ids. */
export const NETWORK_ID = /^[A-Za-z0-9_-]{1,32}$/;
export const DEPOSIT_ADDRESS = /^\S{1,256}$/;
/** svc-ledger's control version. A margin is the contract's decimal (`reconciliationDecimalSchema`). */
const CONTROL_VERSION = /^[1-9]\d{0,15}$/;

/** `now`, or an instant exactly as `Date#toISOString` writes it: svc-ledger hashes that form, so no other spelling is signed. */
export function isRunInstant(value: unknown): value is string {
  if (value === 'now') return true;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return false;
  return new Date(value).toISOString() === value;
}

export type DeskRequestKind = DeskRequest['kind'];

export interface ApprovalPacket {
  readonly request: DeskRequest;
  readonly approvalId: string;
  readonly operationId: string;
  /** When identity will stop honouring the approval. Display only; identity decides. */
  readonly expiresAt: string;
  /** Who proposed it (identity user id). Display only; identity decides. */
  readonly requesterId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** Identity's tier ids: lowercase letters, digits, `_` and `-`, at most 32. */
const TIER_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Identity keeps a closure or tier reason to 255 characters. */
function validClosureReason(value: unknown): value is string {
  return validReason(value) && value.length <= 255;
}

export function validReason(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length >= REASON_MIN && value.length <= REASON_MAX;
}

/** Strict reader for one request. Anything that is not exactly a known shape is null. */
export function readDeskRequest(raw: unknown): DeskRequest | null {
  if (!isRecord(raw)) return null;
  const keys = Object.keys(raw).sort().join(',');
  if (raw.kind === 'edge.kill') {
    if (keys !== 'disabled,kind,module,reason') return null;
    if (typeof raw.module !== 'string' || !isModuleId(raw.module)) return null;
    if (typeof raw.disabled !== 'boolean' || !validReason(raw.reason)) return null;
    return { kind: 'edge.kill', module: raw.module, disabled: raw.disabled, reason: raw.reason };
  }
  if (raw.kind === 'ledger.freeze') {
    if (keys !== 'kind,reason,version') return null;
    if (!validReason(raw.reason) || typeof raw.version !== 'string' || !VERSION.test(raw.version)) return null;
    return { kind: 'ledger.freeze', reason: raw.reason, version: raw.version };
  }
  if (raw.kind === 'ledger.unfreeze') {
    if (keys !== 'kind,version') return null;
    if (typeof raw.version !== 'string' || !VERSION.test(raw.version)) return null;
    return { kind: 'ledger.unfreeze', version: raw.version };
  }
  // svc-ledger binds the control, the instant, the margin and the reason to the approval, at the control version read.
  if (raw.kind === 'ledger.reconciliation_control.run') {
    if (keys !== 'asOf,controlId,kind,margin,reason,version') return null;
    if (typeof raw.controlId !== 'string' || !UUID.test(raw.controlId) || !validReason(raw.reason)) return null;
    if (typeof raw.version !== 'string' || !CONTROL_VERSION.test(raw.version) || !isRunInstant(raw.asOf)) return null;
    if (typeof raw.margin !== 'string') return null;
    // A run now reads at its own instant, so it carries no margin; a past run always names the one it reads with.
    if (raw.asOf === 'now' ? raw.margin !== 'unset' : !reconciliationDecimalSchema.safeParse(raw.margin).success) return null;
    return {
      kind: 'ledger.reconciliation_control.run',
      controlId: raw.controlId,
      version: raw.version,
      asOf: raw.asOf,
      margin: raw.margin,
      reason: raw.reason,
    };
  }
  if (raw.kind === 'ledger.reconciliation_control.lifecycle') {
    if (keys !== 'controlId,kind,lifecycle,reason,version') return null;
    if (typeof raw.controlId !== 'string' || !UUID.test(raw.controlId) || !validReason(raw.reason)) return null;
    if (typeof raw.version !== 'string' || !CONTROL_VERSION.test(raw.version)) return null;
    if (typeof raw.lifecycle !== 'string' || !(RECONCILIATION_LIFECYCLE as readonly string[]).includes(raw.lifecycle)) return null;
    return {
      kind: 'ledger.reconciliation_control.lifecycle',
      controlId: raw.controlId,
      version: raw.version,
      lifecycle: raw.lifecycle as ReconciliationLifecycle,
      reason: raw.reason,
    };
  }
  if (raw.kind === 'ledger.account_metadata.delete') {
    if (keys !== 'accountId,key,kind,reason,version') return null;
    if (typeof raw.accountId !== 'string' || !UUID.test(raw.accountId) || !validReason(raw.reason)) return null;
    if (typeof raw.key !== 'string' || !METADATA_KEY.test(raw.key)) return null;
    if (typeof raw.version !== 'string' || !WHOLE.test(raw.version)) return null;
    return { kind: 'ledger.account_metadata.delete', accountId: raw.accountId, key: raw.key, reason: raw.reason, version: raw.version };
  }
  if (raw.kind === 'market.vendor.vet') {
    if (keys !== 'decision,kind,reason,vendorId') return null;
    if (typeof raw.vendorId !== 'string' || !UUID.test(raw.vendorId) || !validReason(raw.reason)) return null;
    if (typeof raw.decision !== 'string' || !(VENDOR_DECISIONS as readonly string[]).includes(raw.decision)) return null;
    return { kind: 'market.vendor.vet', vendorId: raw.vendorId, decision: raw.decision as VendorDecision, reason: raw.reason };
  }
  if (raw.kind === 'academy.ambassador.freeze') {
    if (keys !== 'kind,reason,userId') return null;
    if (typeof raw.userId !== 'string' || !UUID.test(raw.userId) || !validReason(raw.reason)) return null;
    return { kind: 'academy.ambassador.freeze', userId: raw.userId, reason: raw.reason };
  }
  if (raw.kind === 'academy.ambassador.unfreeze') {
    if (keys !== 'kind,userId') return null;
    if (typeof raw.userId !== 'string' || !UUID.test(raw.userId)) return null;
    return { kind: 'academy.ambassador.unfreeze', userId: raw.userId };
  }
  if (raw.kind === 'identity.account.unfreeze') {
    if (keys !== 'kind,reason,userId,version') return null;
    if (typeof raw.userId !== 'string' || !UUID.test(raw.userId) || !validReason(raw.reason)) return null;
    if (typeof raw.version !== 'string' || !/^(?:0|[1-9]\d{0,39})$/.test(raw.version)) return null;
    return { kind: 'identity.account.unfreeze', userId: raw.userId, reason: raw.reason, version: raw.version };
  }
  if (raw.kind === 'token.launch.issuer.set') {
    if (keys !== 'issuerId,kind,name,revision,state') return null;
    if (typeof raw.issuerId !== 'string' || !LAUNCH_ID.test(raw.issuerId) || typeof raw.name !== 'string') return null;
    const name = raw.name.trim();
    if (name !== raw.name || name.length < 1 || name.length > 120) return null;
    if (typeof raw.state !== 'string' || !(LAUNCH_ISSUER_STATES as readonly string[]).includes(raw.state)) return null;
    if (typeof raw.revision !== 'string' || !REVISION.test(raw.revision)) return null;
    return { kind: 'token.launch.issuer.set', issuerId: raw.issuerId, name, state: raw.state as LaunchIssuerState, revision: raw.revision };
  }
  if (raw.kind === 'token.launch.event.create') {
    if (keys !== 'event,kind' || typeof raw.event !== 'string' || readLaunchEventPayload(raw.event) === null) return null;
    return { kind: 'token.launch.event.create', event: raw.event };
  }
  if (raw.kind === 'token.launch.event.move') {
    if (keys !== 'eventId,kind,revision,to') return null;
    if (typeof raw.eventId !== 'string' || !LAUNCH_ID.test(raw.eventId)) return null;
    if (typeof raw.to !== 'string' || !(LAUNCH_MOVE_TARGETS as readonly string[]).includes(raw.to)) return null;
    if (typeof raw.revision !== 'string' || !REVISION.test(raw.revision)) return null;
    return { kind: 'token.launch.event.move', eventId: raw.eventId, to: raw.to as LaunchMoveTarget, revision: raw.revision };
  }
  if (raw.kind === 'pay.deposit_address.unfreeze') {
    if (keys !== 'address,freezeId,kind,networkId,reason,userId') return null;
    if (typeof raw.userId !== 'string' || !UUID.test(raw.userId) || !validReason(raw.reason)) return null;
    if (typeof raw.freezeId !== 'string' || !UUID.test(raw.freezeId)) return null;
    if (typeof raw.networkId !== 'string' || !NETWORK_ID.test(raw.networkId)) return null;
    if (typeof raw.address !== 'string' || !DEPOSIT_ADDRESS.test(raw.address)) return null;
    return {
      kind: 'pay.deposit_address.unfreeze',
      userId: raw.userId,
      networkId: raw.networkId,
      address: raw.address,
      freezeId: raw.freezeId,
      reason: raw.reason,
    };
  }
  if (raw.kind === 'identity.account.close') {
    if (keys !== 'kind,reason,reasonCode,userId,version') return null;
    if (typeof raw.userId !== 'string' || !UUID.test(raw.userId) || !validClosureReason(raw.reason)) return null;
    if (typeof raw.reasonCode !== 'string' || !(CLOSE_REASON_CODES as readonly string[]).includes(raw.reasonCode)) return null;
    if (typeof raw.version !== 'string' || !/^(?:0|[1-9]\d{0,39})$/.test(raw.version)) return null;
    return {
      kind: 'identity.account.close',
      userId: raw.userId,
      reasonCode: raw.reasonCode as AccountCloseReasonCode,
      reason: raw.reason,
      version: raw.version,
    };
  }
  if (raw.kind === 'identity.account.archive') {
    if (keys !== 'kind,reason,reasonCode,userId,version') return null;
    if (typeof raw.userId !== 'string' || !UUID.test(raw.userId) || !validClosureReason(raw.reason)) return null;
    if (typeof raw.reasonCode !== 'string' || !(ARCHIVE_REASON_CODES as readonly string[]).includes(raw.reasonCode)) return null;
    if (typeof raw.version !== 'string' || !/^(?:0|[1-9]\d{0,39})$/.test(raw.version)) return null;
    return {
      kind: 'identity.account.archive',
      userId: raw.userId,
      reasonCode: raw.reasonCode as AccountArchiveReasonCode,
      reason: raw.reason,
      version: raw.version,
    };
  }
  if (raw.kind === 'identity.account.reopen') {
    if (keys !== 'kind,reason,userId,version') return null;
    if (typeof raw.userId !== 'string' || !UUID.test(raw.userId) || !validClosureReason(raw.reason)) return null;
    if (typeof raw.version !== 'string' || !/^(?:0|[1-9]\d{0,39})$/.test(raw.version)) return null;
    return { kind: 'identity.account.reopen', userId: raw.userId, reason: raw.reason, version: raw.version };
  }
  if (raw.kind === 'identity.kyc_document.open') {
    if (keys !== 'documentId,kind') return null;
    if (typeof raw.documentId !== 'string' || !UUID.test(raw.documentId)) return null;
    return { kind: 'identity.kyc_document.open', documentId: raw.documentId };
  }
  if (raw.kind === 'identity.kyc_selfie.decide') {
    if (keys !== 'decision,kind,selfieId') return null;
    if (typeof raw.selfieId !== 'string' || !UUID.test(raw.selfieId)) return null;
    if (typeof raw.decision !== 'string' || !(SELFIE_DECISIONS as readonly string[]).includes(raw.decision)) return null;
    return { kind: 'identity.kyc_selfie.decide', selfieId: raw.selfieId, decision: raw.decision as SelfieDecision };
  }
  if (raw.kind === 'identity.account.tier_move') {
    if (keys !== 'kind,reason,tierId,userId,version') return null;
    if (typeof raw.userId !== 'string' || !UUID.test(raw.userId) || !validClosureReason(raw.reason)) return null;
    if (typeof raw.tierId !== 'string' || !TIER_ID.test(raw.tierId)) return null;
    if (typeof raw.version !== 'string' || !/^(?:0|[1-9]\d{0,39})$/.test(raw.version)) return null;
    return { kind: 'identity.account.tier_move', userId: raw.userId, tierId: raw.tierId, reason: raw.reason, version: raw.version };
  }
  if (raw.kind === 'identity.account.limit_override') {
    if (keys !== 'assetId,expiresAt,kind,perTx,rail,reason,rolling24h,userId,version') return null;
    if (typeof raw.userId !== 'string' || !UUID.test(raw.userId) || !validClosureReason(raw.reason)) return null;
    if (typeof raw.rail !== 'string' || !(ACCOUNT_LIMIT_RAILS as readonly string[]).includes(raw.rail)) return null;
    if (!accountLimitAssetIdSchema.safeParse(raw.assetId).success) return null;
    const figure = (value: unknown) => value === null || accountLimitAmountSchema.safeParse(value).success;
    if (!figure(raw.perTx) || !figure(raw.rolling24h) || (raw.perTx === null && raw.rolling24h === null)) return null;
    // The end time is bound into the approval hash as this exact instant, so only the canonical ISO form is read.
    if (
      typeof raw.expiresAt !== 'string' ||
      Number.isNaN(Date.parse(raw.expiresAt)) ||
      new Date(raw.expiresAt).toISOString() !== raw.expiresAt
    )
      return null;
    if (typeof raw.version !== 'string' || !/^(?:0|[1-9]\d{0,39})$/.test(raw.version)) return null;
    return {
      kind: 'identity.account.limit_override',
      userId: raw.userId,
      rail: raw.rail as AccountLimitRail,
      assetId: raw.assetId as string,
      perTx: raw.perTx as string | null,
      rolling24h: raw.rolling24h as string | null,
      expiresAt: raw.expiresAt,
      reason: raw.reason,
      version: raw.version,
    };
  }
  if (raw.kind === 'academy.ambassador.appoint') {
    if (keys !== 'kind,userId') return null;
    if (typeof raw.userId !== 'string' || !UUID.test(raw.userId)) return null;
    return { kind: 'academy.ambassador.appoint', userId: raw.userId };
  }
  // The service binds only the application id and the decision to the approval, so no free-text note rides along: a note could
  // be changed after the second founder approved and nothing would notice.
  if (raw.kind === 'academy.residency.decide') {
    if (keys !== 'decision,id,kind') return null;
    if (typeof raw.id !== 'string' || !UUID.test(raw.id)) return null;
    if (typeof raw.decision !== 'string' || !(RESIDENCY_DECISIONS as readonly string[]).includes(raw.decision)) return null;
    return { kind: 'academy.residency.decide', id: raw.id, decision: raw.decision as ResidencyDecision };
  }
  // svc-bank binds the card and the status to the approval; the reason is required by the service (10+ characters) and recorded
  // with the freeze, but it is not part of what the second founder signs. It is in the packet so they read it.
  if (raw.kind === 'bank.card.status') {
    if (keys !== 'cardId,kind,reason,status') return null;
    if (typeof raw.cardId !== 'string' || !UUID.test(raw.cardId) || !validReason(raw.reason)) return null;
    if (typeof raw.status !== 'string' || !(CARD_STATUSES as readonly string[]).includes(raw.status)) return null;
    return { kind: 'bank.card.status', cardId: raw.cardId, status: raw.status as CardStatus, reason: raw.reason };
  }
  // svc-market binds the listing AND the reason to the approval, so a changed reason cannot ride on an approved takedown.
  if (raw.kind === 'market.listing.takedown') {
    if (keys !== 'kind,listingId,reason') return null;
    if (typeof raw.listingId !== 'string' || !UUID.test(raw.listingId) || !validReason(raw.reason)) return null;
    return { kind: 'market.listing.takedown', listingId: raw.listingId, reason: raw.reason };
  }
  // svc-identity binds the new key id (rotate) or the exact verify-only ids (remove-old) to the approval. Key material is never in a request.
  if (raw.kind === 'identity.auth_key.rotate') {
    if (keys !== 'keyId,kind') return null;
    if (typeof raw.keyId !== 'string' || !AUTH_KEY_ID.test(raw.keyId) || raw.keyId === 'legacy') return null;
    return { kind: 'identity.auth_key.rotate', keyId: raw.keyId };
  }
  // svc-identity binds the wave number and the owner's wave size to the approval, both as whole-number strings.
  if (raw.kind === 'campaigns.waitlist.wave_release') {
    if (keys !== 'kind,size,wave') return null;
    if (typeof raw.wave !== 'string' || !WHOLE.test(raw.wave) || typeof raw.size !== 'string' || !WHOLE.test(raw.size)) return null;
    return { kind: 'campaigns.waitlist.wave_release', wave: raw.wave, size: raw.size };
  }
  if (raw.kind === 'identity.auth_key.remove_old') {
    if (keys !== 'keyIds,kind') return null;
    if (typeof raw.keyIds !== 'string') return null;
    const ids = raw.keyIds.split(',');
    if (!ids.every((id) => AUTH_KEY_ID.test(id)) || ids.join(',') !== [...ids].sort().join(',') || new Set(ids).size !== ids.length)
      return null;
    return { kind: 'identity.auth_key.remove_old', keyIds: raw.keyIds };
  }
  // svc-ops binds the reason to turning maintenance mode on, and nothing beyond the console itself to turning it off.
  if (raw.kind === 'ops.console_mode.on') {
    if (keys !== 'kind,reason' || !validReason(raw.reason)) return null;
    return { kind: 'ops.console_mode.on', reason: raw.reason };
  }
  if (raw.kind === 'ops.console_mode.off') {
    if (keys !== 'kind') return null;
    return { kind: 'ops.console_mode.off' };
  }
  // svc-ops binds the hold and the amount of a release, and the hold alone for a confirm (it moves whatever is left).
  if (raw.kind === 'ops.hold.release' || raw.kind === 'ops.hold.confirm') {
    const release = raw.kind === 'ops.hold.release';
    if (keys !== (release ? 'amount,assetId,holdNo,kind,reason,userId' : 'assetId,holdNo,kind,reason,userId')) return null;
    if (typeof raw.holdNo !== 'string' || !HOLD_NO.test(raw.holdNo)) return null;
    if (typeof raw.userId !== 'string' || !UUID.test(raw.userId)) return null;
    if (typeof raw.assetId !== 'string' || !STAFF_HOLD_ASSET_PATTERN.test(raw.assetId) || !validReason(raw.reason)) return null;
    if (!release) return { kind: 'ops.hold.confirm', holdNo: raw.holdNo, userId: raw.userId, assetId: raw.assetId, reason: raw.reason };
    if (typeof raw.amount !== 'string' || !STAFF_HOLD_AMOUNT_PATTERN.test(raw.amount) || !/[1-9]/.test(raw.amount)) return null;
    return {
      kind: 'ops.hold.release',
      holdNo: raw.holdNo,
      userId: raw.userId,
      assetId: raw.assetId,
      amount: raw.amount,
      reason: raw.reason,
    };
  }
  // svc-ops binds the alert, the note and the evidence hash. A blank note is read so the route refuses it as ops.resolve_note_required.
  if (raw.kind === 'ops.reconciliation_alert.accept') {
    if (keys !== 'alertId,evidenceHash,kind,reason') return null;
    if (typeof raw.alertId !== 'string' || !UUID.test(raw.alertId)) return null;
    if (typeof raw.evidenceHash !== 'string' || !EVIDENCE_HASH.test(raw.evidenceHash)) return null;
    if (raw.reason !== '' && !validReason(raw.reason)) return null;
    return { kind: 'ops.reconciliation_alert.accept', alertId: raw.alertId, evidenceHash: raw.evidenceHash, reason: raw.reason as string };
  }
  // svc-ops binds the month, line, amount, asset and source note to the approval: a changed figure is a different request.
  if (raw.kind === 'ops.venue_cost.record') {
    if (keys !== 'amount,asset,category,kind,period,reason') return null;
    if (typeof raw.period !== 'string' || !PERIOD.test(raw.period)) return null;
    if (!isCategory(raw.category)) return null;
    if (typeof raw.amount !== 'string' || !COST_AMOUNT.test(raw.amount)) return null;
    if (typeof raw.asset !== 'string' || !COST_ASSET.test(raw.asset) || !validReason(raw.reason)) return null;
    return {
      kind: 'ops.venue_cost.record',
      period: raw.period,
      category: raw.category,
      amount: raw.amount,
      asset: raw.asset,
      reason: raw.reason,
    };
  }
  if (raw.kind === 'protocol.pool.hide') {
    if (keys !== 'chainId,kind,poolAddress,reason,reasonCode') return null;
    if (!isChainId(raw.chainId) || typeof raw.poolAddress !== 'string' || !POOL_ADDRESS.test(raw.poolAddress)) return null;
    if (typeof raw.reasonCode !== 'string' || !REASON_CODE.test(raw.reasonCode) || !validReason(raw.reason)) return null;
    return {
      kind: 'protocol.pool.hide',
      chainId: raw.chainId,
      poolAddress: raw.poolAddress,
      reasonCode: raw.reasonCode,
      reason: raw.reason,
    };
  }
  if (raw.kind === 'protocol.pool.restore') {
    if (keys !== 'chainId,kind,poolAddress') return null;
    if (!isChainId(raw.chainId) || typeof raw.poolAddress !== 'string' || !POOL_ADDRESS.test(raw.poolAddress)) return null;
    return { kind: 'protocol.pool.restore', chainId: raw.chainId, poolAddress: raw.poolAddress };
  }
  if (raw.kind === 'protocol.market.delist') {
    if (keys !== 'kind,reason,reasonCode,symbol') return null;
    if (typeof raw.symbol !== 'string' || !MARKET_SYMBOL.test(raw.symbol)) return null;
    if (typeof raw.reasonCode !== 'string' || !REASON_CODE.test(raw.reasonCode) || !validReason(raw.reason)) return null;
    return { kind: 'protocol.market.delist', symbol: raw.symbol, reasonCode: raw.reasonCode, reason: raw.reason };
  }
  if (raw.kind === 'protocol.market.restore') {
    if (keys !== 'kind,symbol') return null;
    if (typeof raw.symbol !== 'string' || !MARKET_SYMBOL.test(raw.symbol)) return null;
    return { kind: 'protocol.market.restore', symbol: raw.symbol };
  }
  return null;
}

function isChainId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isApprovalId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function encodePacket(packet: ApprovalPacket): string {
  return PACKET_PREFIX + toBase64Url(JSON.stringify(packet));
}

export type PacketReading =
  { readonly ok: true; readonly packet: ApprovalPacket } | { readonly ok: false; readonly reason: 'empty' | 'not_a_packet' | 'damaged' };

/** Read what a founder pasted. Whitespace around it is ignored; anything else that is not exactly a packet is refused. */
export function decodePacket(text: string): PacketReading {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, reason: 'empty' };
  if (!trimmed.startsWith(PACKET_PREFIX) || trimmed.length > MAX_PACKET_CHARS) return { ok: false, reason: 'not_a_packet' };
  const json = fromBase64Url(trimmed.slice(PACKET_PREFIX.length));
  if (json === null) return { ok: false, reason: 'damaged' };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'damaged' };
  }
  if (!isRecord(raw) || Object.keys(raw).sort().join(',') !== 'approvalId,expiresAt,operationId,request,requesterId') {
    return { ok: false, reason: 'damaged' };
  }
  const request = readDeskRequest(raw.request);
  if (
    !request ||
    !isApprovalId(raw.approvalId) ||
    !isApprovalId(raw.operationId) ||
    !isApprovalId(raw.requesterId) ||
    typeof raw.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(raw.expiresAt))
  ) {
    return { ok: false, reason: 'damaged' };
  }
  return {
    ok: true,
    packet: { request, approvalId: raw.approvalId, operationId: raw.operationId, expiresAt: raw.expiresAt, requesterId: raw.requesterId },
  };
}

/** The exact phrase a founder types before any step on this request. It names the thing being changed. */
export function confirmPhrase(request: DeskRequest): string {
  switch (request.kind) {
    case 'edge.kill':
      return request.disabled ? `KILL ${request.module}` : `RE-ENABLE ${request.module}`;
    case 'ledger.freeze':
      return 'FREEZE LEDGER';
    case 'ledger.unfreeze':
      return 'UNFREEZE LEDGER';
    case 'ledger.reconciliation_control.run':
      return `RUN CONTROL ${request.controlId.slice(0, 8)}`;
    case 'ledger.reconciliation_control.lifecycle':
      return `${request.lifecycle.toUpperCase()} CONTROL ${request.controlId.slice(0, 8)}`;
    case 'ledger.account_metadata.delete':
      return `DELETE KEY ${request.key}`;
    case 'market.vendor.vet':
      return `${request.decision === 'approved' ? 'APPROVE' : request.decision === 'rejected' ? 'REJECT' : 'SUSPEND'} VENDOR ${request.vendorId.slice(0, 8)}`;
    case 'academy.ambassador.freeze':
      return `FREEZE AMBASSADOR ${request.userId.slice(0, 8)}`;
    case 'academy.ambassador.unfreeze':
      return `UNFREEZE AMBASSADOR ${request.userId.slice(0, 8)}`;
    case 'academy.ambassador.appoint':
      return `APPOINT AMBASSADOR ${request.userId.slice(0, 8)}`;
    case 'academy.residency.decide':
      return `${request.decision === 'accepted' ? 'ACCEPT' : 'REJECT'} RESIDENCY ${request.id.slice(0, 8)}`;
    case 'bank.card.status':
      return `${request.status === 'frozen' ? 'FREEZE' : 'UNFREEZE'} CARD ${request.cardId.slice(0, 8)}`;
    case 'market.listing.takedown':
      return `TAKE DOWN LISTING ${request.listingId.slice(0, 8)}`;
    case 'identity.auth_key.rotate':
      return `ROTATE KEY ${request.keyId}`;
    case 'identity.auth_key.remove_old':
      return 'REMOVE OLD KEYS';
    case 'campaigns.waitlist.wave_release':
      return `RELEASE WAVE ${request.wave}`;
    case 'identity.account.unfreeze':
      return `UNFREEZE ACCOUNT ${request.userId.slice(0, 8)}`;
    case 'token.launch.issuer.set':
      return `ISSUER ${request.issuerId} ${request.state.toUpperCase()}`;
    case 'token.launch.event.create':
      return `DRAFT LAUNCH ${readLaunchEventPayload(request.event)?.id ?? ''}`;
    case 'token.launch.event.move':
      return `LAUNCH ${request.eventId} ${request.to.toUpperCase()}`;
    case 'pay.deposit_address.unfreeze':
      return `UNFREEZE ADDRESS ${request.address.slice(0, 10)}`;
    case 'identity.account.close':
      return `CLOSE ACCOUNT ${request.userId.slice(0, 8)}`;
    case 'identity.account.reopen':
      return `REOPEN ACCOUNT ${request.userId.slice(0, 8)}`;
    case 'identity.account.archive':
      return `ARCHIVE CUSTOMER ${request.userId.slice(0, 8)}`;
    case 'identity.account.tier_move':
      return `MOVE TIER ${request.userId.slice(0, 8)}`;
    case 'identity.account.limit_override':
      return `RAISE LIMIT ${request.userId.slice(0, 8)}`;
    case 'ops.venue_cost.record':
      return `RECORD COST ${request.category} ${request.period}`;
    case 'ops.hold.release':
      return `RELEASE HOLD ${request.holdNo}`;
    case 'ops.hold.confirm':
      return `CONFIRM HOLD ${request.holdNo}`;
    case 'ops.reconciliation_alert.accept':
      return `ACCEPT ALERT ${request.alertId.slice(0, 8)}`;
    case 'protocol.pool.hide':
      return `HIDE POOL ${request.poolAddress.slice(0, 10)}`;
    case 'protocol.pool.restore':
      return `RESTORE POOL ${request.poolAddress.slice(0, 10)}`;
    case 'protocol.market.delist':
      return `DELIST ${request.symbol}`;
    case 'protocol.market.restore':
      return `RELIST ${request.symbol}`;
    case 'ops.console_mode.on':
      return 'CONSOLE READ ONLY';
    case 'ops.console_mode.off':
      return 'CONSOLE WRITABLE';
    case 'identity.kyc_document.open':
      return `OPEN DOCUMENT ${request.documentId.slice(0, 8)}`;
    case 'identity.kyc_selfie.decide':
      return `${request.decision === 'accepted' ? 'ACCEPT' : 'REJECT'} SELFIE ${request.selfieId.slice(0, 8)}`;
  }
}

/** Plain-words description of what the request does. Shown to BOTH founders before they act. */
export function describeRequest(request: DeskRequest): string {
  switch (request.kind) {
    case 'edge.kill':
      return request.disabled
        ? `Kill module "${request.module}": new commitments on it are refused (503) until it is re-enabled. Reads and cancels still pass.`
        : `Re-enable module "${request.module}": it accepts new commitments again.`;
    case 'ledger.freeze':
      return 'Freeze the ledger: ALL value movement on the platform stops until it is unfrozen.';
    case 'ledger.unfreeze':
      return 'Unfreeze the ledger: value movement resumes platform-wide.';
    case 'ledger.reconciliation_control.run':
      return request.asOf === 'now'
        ? `Run reconciliation control ${request.controlId} now ("${request.reason}"). svc-ledger stores a result row before it reads, then compares the book. Nothing posts and nothing freezes. It runs only if the control is still active at version ${request.version}.`
        : `Run reconciliation control ${request.controlId} as of ${request.asOf}, reading balances ${request.margin} seconds before that instant ("${request.reason}"). svc-ledger stores a result row before it reads, then compares the book. Nothing posts and nothing freezes. It runs only if the control is still active at version ${request.version}.`;
    case 'ledger.reconciliation_control.lifecycle':
      return request.lifecycle === 'pause'
        ? `Pause reconciliation control ${request.controlId} ("${request.reason}"): the scheduler and runs on demand skip it until it is resumed. Its policy, runs and history stay. It moves only if the control is still at version ${request.version}.`
        : request.lifecycle === 'resume'
          ? `Resume reconciliation control ${request.controlId} ("${request.reason}"): it runs on its schedule again from now; periods that fell due while it was paused are not caught up. It moves only if the control is still at version ${request.version}.`
          : `Retire reconciliation control ${request.controlId} ("${request.reason}"): it never runs again and cannot be edited or brought back. Its row, runs and history stay. It moves only if the control is still at version ${request.version}.`;
    case 'ledger.account_metadata.delete':
      return `Delete the metadata key "${request.key}" on ledger account ${request.accountId} ("${request.reason}"). svc-ledger records the value before and after with who asked and who approved. It is a label only: no posting, balance or transaction changes. It deletes only if the key is still at revision ${request.version}.`;
    case 'market.vendor.vet':
      return request.decision === 'approved'
        ? `Approve market vendor ${request.vendorId}: they may be listed and sell in the market.`
        : request.decision === 'rejected'
          ? `Reject the market vendor application ${request.vendorId}: they are not listed.`
          : `Suspend market vendor ${request.vendorId}: they are taken out of the market.`;
    case 'academy.ambassador.freeze':
      return `Freeze Academy ambassador ${request.userId}: they stop holding the ambassador role until it is lifted.`;
    case 'academy.ambassador.unfreeze':
      return `Lift the freeze on Academy ambassador ${request.userId}: they hold the ambassador role again.`;
    case 'academy.ambassador.appoint':
      return `Appoint ${request.userId} as an Academy ambassador: they hold the ambassador role and its badge. This is a status only; it pays nothing.`;
    case 'academy.residency.decide':
      return request.decision === 'accepted'
        ? `Accept residency application ${request.id}: the application is recorded as accepted.`
        : `Reject residency application ${request.id}: the application is recorded as rejected.`;
    case 'bank.card.status':
      return request.status === 'frozen'
        ? `Freeze card ${request.cardId} as an operator: the card is frozen and its owner cannot unfreeze it. Only an operator can lift it. The owner can still close it.`
        : `Lift the freeze on card ${request.cardId}, whoever set it: this includes a freeze the owner set themselves (for example after reporting the card lost). The card can be spent again at once. svc-bank does not show this console who froze it, so check with the owner first.`;
    case 'market.listing.takedown':
      return `Take down market listing ${request.listingId}: it leaves the market for good. Nobody can set it active again, and the vendor cannot restore it. Purchases already settled keep their access, and nothing is refunded.`;
    case 'identity.auth_key.rotate':
      return `Rotate the access-token signing key to "${request.keyId}": new sign-ins are signed with it from now on, and the key that signs today keeps verifying, so nobody is signed out. Every other service must already carry the same key, or its checks of new tokens fail.`;
    case 'identity.auth_key.remove_old':
      return `Remove the previous signing keys (${request.keyIds}): tokens signed with them stop working at once and their holders have to sign in again. Only do this after the overlap.`;
    case 'campaigns.waitlist.wave_release':
      return `Release waitlist wave ${request.wave}: the ${request.size} people highest in the queue (most friends invited, then who joined first) are invited, once. A release is a record, not an account: nobody is signed up and nothing moves value. The invitation email is not connected, so each person sees it on their waitlist page.`;
    case 'identity.account.unfreeze':
      return `Lift the staff freeze on account ${request.userId} ("${request.reason}"): its owner can sign in again. Sessions, API keys and sub-accounts revoked by the freeze stay revoked. Identity applies it only if the account is still at control version ${request.version}.`;
    case 'token.launch.issuer.set':
      return request.revision === '0'
        ? `Add issuer ${request.issuerId} ("${request.name}") as applied. It cannot announce a launch until it is reviewed and onboarded. No money moves.`
        : request.state === 'suspended'
          ? `Suspend issuer ${request.issuerId} ("${request.name}"). Each of its open launches closes in the same step, and every move is recorded with both founders. svc-token applies it only if the issuer is still at revision ${request.revision}. No money moves.`
          : `Move issuer ${request.issuerId} ("${request.name}") to ${request.state}. svc-token applies it only if the issuer is still at revision ${request.revision}. No money moves.`;
    case 'token.launch.event.create': {
      const e = readLaunchEventPayload(request.event);
      return `Save launch ${e?.id} ("${e?.projectName}", ${e?.symbol}) for issuer ${e?.issuerId} as a draft. A draft is not published: nobody outside this console sees it until it is announced. Price ${e?.price ?? 'not set'}, cap ${e?.perUserCap ?? 'not set'}. No money moves.`;
    }
    case 'token.launch.event.move':
      return `Move launch ${request.eventId} to ${request.to}. svc-token checks the period and that the issuer is onboarded, and applies it only if the launch is still at revision ${request.revision}. No money moves.`;
    case 'pay.deposit_address.unfreeze':
      return `Lift the compliance freeze on deposit address ${request.address} (${request.networkId}) of account ${request.userId} ("${request.reason}"). Deposits held by the freeze are judged again, and each one that has its confirmations is credited once, under the same key as any deposit. svc-pay lifts it only if freeze ${request.freezeId.slice(0, 8)} is still the open one, and refuses the founder who approved it as the one who runs it.`;
    case 'identity.account.close':
      return `Close account ${request.userId} (reason code ${request.reasonCode.replace(/_/g, ' ')}: "${request.reason}"). Its owner is signed out and cannot sign in; sessions, API keys and sub-accounts are revoked. Identity refuses while the account still has open products or balances, and applies it only if the account is still at control version ${request.version}. ${request.reasonCode === 'customer_request' ? 'Closed at the customer’s request, it can be reopened later.' : 'Closed for this reason, it cannot be reopened.'}`;
    case 'identity.account.reopen':
      return `Reopen account ${request.userId} ("${request.reason}"): its owner can sign in again with a new sign-in. Revoked sessions, API keys and sub-accounts stay revoked. Identity reopens only an account the customer closed, at control version ${request.version}.`;
    case 'identity.account.archive':
      return `Archive customer ${request.userId} for good (reason code ${request.reasonCode.replace(/_/g, ' ')}: "${request.reason}"). The record becomes read-only: it cannot be frozen, unfrozen or reopened again. Only a founder can approve it. Identity archives only a closed account, at control version ${request.version}.`;
    case 'identity.account.limit_override':
      return `Override the ${request.rail} limit of account ${request.userId} for ${request.assetId} until ${request.expiresAt} ("${request.reason}"): per transaction ${request.perTx ?? 'the base figure'}, over 24 hours ${request.rolling24h ?? 'the base figure'}. This goes above the owner’s ceiling, so both people must be founders. After the end time the base limit applies again. Identity sets it only if the override is still at version ${request.version}. No money moves.`;
    case 'identity.account.tier_move':
      return `Move account ${request.userId} onto tier "${request.tierId}" ("${request.reason}"). The account takes that tier's terms as identity holds them. Identity refuses a tier with any blank term, and applies it only if the account is still at tier version ${request.version}. Both people must be founders.`;
    case 'ops.hold.release':
      return `Release ${request.amount} ${request.assetId} of staff hold ${request.holdNo} back to customer ${request.userId} ("${request.reason}"). svc-ops posts it in the ledger under the hold's next release number; it refuses more than is still held, and does nothing while another action on the hold is settling.`;
    case 'ops.hold.confirm':
      return `Confirm staff hold ${request.holdNo} on customer ${request.userId} ("${request.reason}"): whatever ${request.assetId} is still held when it runs moves out of the customer's balance to the owner-named account. It cannot be undone from this console. svc-ops refuses while the owner has named no such account (owner.decision).`;
    case 'ops.reconciliation_alert.accept':
      return `Accept the discrepancy on reconciliation alert ${request.alertId} ("${request.reason}"). The alert closes as accepted and its evidence is frozen at hash ${request.evidenceHash}: a later failure with the same figures changes nothing, and different figures open a new alert. svc-ops refuses if the evidence no longer has that hash. No balance or freeze changes, and nothing is posted to the ledger.`;
    case 'ops.venue_cost.record':
      return `Record a venue cost for ${request.period}: ${request.category.replace(/_/g, ' ')} is ${request.amount} ${request.asset}, from "${request.reason}". It becomes the figure the unit-economics report uses for that line; an earlier figure stays in the history. No money moves.`;
    case 'protocol.pool.hide':
      return `Hide pool ${request.poolAddress} on chain ${request.chainId} (reason code ${request.reasonCode}: "${request.reason}"). It leaves INTAFACED's routing and default pool list and shows "Hidden by INTAFACED". This is a listing decision only: the pool has no admin and no pause, and stays usable by a direct call.`;
    case 'protocol.pool.restore':
      return `Restore pool ${request.poolAddress} on chain ${request.chainId}: it is listed and routed again. Nothing on chain changes.`;
    case 'protocol.market.delist':
      return `Delist market ${request.symbol} (reason code ${request.reasonCode}: "${request.reason}"). The DEX stops quoting it. This is a listing decision only; nothing on chain changes.`;
    case 'protocol.market.restore':
      return `Relist market ${request.symbol}: the DEX quotes it again.`;
    case 'ops.console_mode.on':
      return `Turn on maintenance mode ("${request.reason}"): this console becomes read-only. Every write refuses ops.console_read_only and a banner says so; reads still work. The halts (posting freeze, module kill, payment halts) and turning the mode off stay open. The posting freeze and every account stay as they are, and the platform keeps running.`;
    case 'ops.console_mode.off':
      return 'Turn off maintenance mode: this console takes writes again. Nothing else changes.';
    case 'identity.kyc_document.open':
      return `Open KYC document ${request.documentId} from identity's encrypted vault: its contents are decrypted and shown on the requester's console only, once. Identity's approval names who asked and who approved, and the read spends it. Nothing about the document or the account changes.`;
    case 'identity.kyc_selfie.decide':
      return request.decision === 'accepted'
        ? `Accept selfie ${request.selfieId}: the operator compared it with the account's ID photo and they match. Identity marks the selfie accepted and records when.`
        : `Reject selfie ${request.selfieId}: it does not match the account's ID photo or cannot be compared. Identity marks the selfie rejected and records when; the person can take a new one.`;
  }
}

export function requestReason(request: DeskRequest): string | null {
  switch (request.kind) {
    case 'ledger.unfreeze':
    case 'academy.ambassador.unfreeze':
    case 'academy.ambassador.appoint':
    case 'academy.residency.decide':
    case 'identity.auth_key.rotate':
    case 'identity.auth_key.remove_old':
    case 'campaigns.waitlist.wave_release':
    case 'protocol.pool.restore':
    case 'protocol.market.restore':
    case 'ops.console_mode.off':
    case 'identity.kyc_document.open':
    case 'identity.kyc_selfie.decide':
    case 'token.launch.issuer.set':
    case 'token.launch.event.create':
    case 'token.launch.event.move':
      return null;
    default:
      return request.reason;
  }
}

/** True when this packet's approval is already past the time identity gave it. Advisory: identity is the authority. */
export function packetExpired(packet: ApprovalPacket, now: Date): boolean {
  return Date.parse(packet.expiresAt) <= now.getTime();
}
