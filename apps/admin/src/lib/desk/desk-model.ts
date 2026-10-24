import { REASON_MAX, REASON_MIN, confirmPhrase, packetExpired, type ApprovalPacket, type DeskRequest } from './approval-packet';
import type { StepName } from './approval-types';

/**
 * Which buttons a founder may press right now, and why not. Pure, so every disabled state is a test.
 *
 * These gates are friction and clarity, not authority: identity and the target service decide who may do what,
 * and the BFF re-checks the typed phrase. A button that is enabled here can still be refused there.
 */

export type Role = 'requester' | 'approver' | 'unknown';

/** The founder who made the request is the requester; anyone else holding the packet is the second founder. */
export function roleFor(packet: ApprovalPacket, userId: string): Role {
  if (userId.trim() === '') return 'unknown';
  return packet.requesterId.toLowerCase() === userId.toLowerCase() ? 'requester' : 'approver';
}

export interface RequestGateInput {
  readonly reason: string;
  readonly needsReason: boolean;
  readonly confirm: string;
  readonly phrase: string;
  readonly blockedReason: string | null;
  readonly busy: boolean;
}

export type Gate = { readonly ok: true } | { readonly ok: false; readonly why: string };

export function requestGate(input: RequestGateInput): Gate {
  if (input.blockedReason) return { ok: false, why: input.blockedReason };
  if (input.busy) return { ok: false, why: 'A step is already in progress.' };
  if (input.needsReason) {
    const reason = input.reason.trim();
    if (reason.length < REASON_MIN) return { ok: false, why: `Write the reason first (at least ${REASON_MIN} characters).` };
    if (reason.length > REASON_MAX) return { ok: false, why: `The reason is too long (at most ${REASON_MAX} characters).` };
  }
  if (input.confirm !== input.phrase) return { ok: false, why: `Type ${input.phrase} exactly to confirm.` };
  return { ok: true };
}

export interface StepGateInput {
  readonly step: Exclude<StepName, 'propose'>;
  readonly packet: ApprovalPacket;
  readonly userId: string;
  readonly confirm: string;
  readonly blockedReason: string | null;
  readonly busy: boolean;
  readonly now: Date;
}

/**
 * Approve and reject are the second founder's; withdraw is the requester's undo. Execute is open to either
 * (identity decides whether the approval exists), except opening a KYC document, which only its requester runs. Reject and withdraw never need the typed phrase: undoing must
 * never be harder than doing.
 */
export function stepGate(input: StepGateInput): Gate {
  const { step, packet, userId } = input;
  const role = roleFor(packet, userId);
  if (input.busy) return { ok: false, why: 'A step is already in progress.' };
  if (step === 'revoke')
    return role === 'requester' ? { ok: true } : { ok: false, why: 'Only the founder who made the request can withdraw it.' };
  if (step === 'reject') {
    return role === 'requester' ? { ok: false, why: 'You made this request. Withdraw it instead.' } : { ok: true };
  }
  if (input.blockedReason) return { ok: false, why: input.blockedReason };
  if (packetExpired(packet, input.now)) return { ok: false, why: 'This approval has expired. Start a new request.' };
  if (step === 'approve' && role === 'requester')
    return { ok: false, why: 'You made this request. A different founder has to approve it.' };
  // A document opens on the console of the founder who asked for it, never on the approver's (identity refuses that too).
  if (step === 'execute' && packet.request.kind === 'identity.kyc_document.open' && role !== 'requester')
    return { ok: false, why: 'Only the founder who asked to open this document can open it.' };
  if (input.confirm !== confirmPhrase(packet.request))
    return { ok: false, why: `Type ${confirmPhrase(packet.request)} exactly to confirm.` };
  return { ok: true };
}

/** Short, non-identifying form of an identity user id for display. */
export function shortId(id: string | null): string {
  if (!id) return 'nobody yet';
  return id.length > 13 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

export function describePacketStatus(role: Role): string {
  if (role === 'requester') return 'You made this request. It runs only after a different founder approves it.';
  if (role === 'approver') return 'Another founder made this request. Read it, and approve it only if it is what you want.';
  return 'Your signed-in identity is not known here, so the console cannot tell which side you are.';
}

/** Re-exported so views import one place. */
export type { DeskRequest };
