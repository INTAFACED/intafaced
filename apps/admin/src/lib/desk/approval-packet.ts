import { isModuleId, type ModuleId } from '@intafaced/config';
import { COST_AMOUNT, COST_ASSET, PERIOD, isCategory, type CostCategory } from '@/lib/venue-economics/model';

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

export const PACKET_PREFIX = 'ifa1.';
export const REASON_MIN = 12;
export const REASON_MAX = 500;
const MAX_PACKET_CHARS = 6_000;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const VERSION = /^[\x20-\x7e]{1,128}$/;

export type DeskRequest =
  | { readonly kind: 'edge.kill'; readonly module: ModuleId; readonly disabled: boolean; readonly reason: string }
  | { readonly kind: 'ledger.freeze'; readonly reason: string; readonly version: string }
  | { readonly kind: 'ledger.unfreeze'; readonly version: string }
  | { readonly kind: 'market.vendor.vet'; readonly vendorId: string; readonly decision: VendorDecision; readonly reason: string }
  | { readonly kind: 'academy.ambassador.freeze'; readonly userId: string; readonly reason: string }
  | { readonly kind: 'academy.ambassador.unfreeze'; readonly userId: string }
  | { readonly kind: 'academy.ambassador.appoint'; readonly userId: string }
  | { readonly kind: 'academy.residency.decide'; readonly id: string; readonly decision: ResidencyDecision }
  | { readonly kind: 'bank.card.status'; readonly cardId: string; readonly status: CardStatus; readonly reason: string }
  | { readonly kind: 'market.listing.takedown'; readonly listingId: string; readonly reason: string }
  /** One venue cost note (svc-ops `recordVenueCost`). `reason` is the source note the service stores and the approver signs. */
  | {
      readonly kind: 'ops.venue_cost.record';
      readonly period: string;
      readonly category: CostCategory;
      readonly amount: string;
      readonly asset: string;
      readonly reason: string;
    };

export const VENDOR_DECISIONS = ['approved', 'rejected', 'suspended'] as const;
export type VendorDecision = (typeof VENDOR_DECISIONS)[number];
export const CARD_STATUSES = ['frozen', 'active'] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];
export const RESIDENCY_DECISIONS = ['accepted', 'rejected'] as const;
export type ResidencyDecision = (typeof RESIDENCY_DECISIONS)[number];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
  return null;
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
    case 'ops.venue_cost.record':
      return `RECORD COST ${request.category} ${request.period}`;
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
    case 'ops.venue_cost.record':
      return `Record a venue cost for ${request.period}: ${request.category.replace(/_/g, ' ')} is ${request.amount} ${request.asset}, from "${request.reason}". It becomes the figure the unit-economics report uses for that line; an earlier figure stays in the history. No money moves.`;
  }
}

export function requestReason(request: DeskRequest): string | null {
  switch (request.kind) {
    case 'ledger.unfreeze':
    case 'academy.ambassador.unfreeze':
    case 'academy.ambassador.appoint':
    case 'academy.residency.decide':
      return null;
    default:
      return request.reason;
  }
}

/** True when this packet's approval is already past the time identity gave it. Advisory: identity is the authority. */
export function packetExpired(packet: ApprovalPacket, now: Date): boolean {
  return Date.parse(packet.expiresAt) <= now.getTime();
}
