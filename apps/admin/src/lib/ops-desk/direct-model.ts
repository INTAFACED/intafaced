import { REASON_MAX, REASON_MIN } from '@/lib/desk/approval-packet';

/**
 * A desk action that one operator takes and that the owning service does NOT ask a second person for. Today that is one:
 * a moderator escalating an open P2P dispute (svc-p2p re-arms the deadline; no money moves). It still needs a reason and a
 * key that makes a lost reply safe to repeat.
 *
 * Pure, so the browser builds the request with the same rules the server checks.
 */

export const DIRECT_KINDS = ['p2p.dispute.escalate'] as const;
export type DirectKind = (typeof DIRECT_KINDS)[number];

export interface EscalateRequest {
  readonly action: 'p2p.dispute.escalate';
  readonly disputeId: string;
  readonly reason: string;
  /** Same key, same reason: the service returns the first result instead of escalating again. */
  readonly clientRequestId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9_-]{8,128}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** Strict reader. The reason is trimmed the way the service will keep it; anything off-shape is null. */
export function readDirectRequest(raw: unknown): EscalateRequest | null {
  if (!isRecord(raw) || Object.keys(raw).sort().join(',') !== 'action,clientRequestId,disputeId,reason') return null;
  if (raw.action !== 'p2p.dispute.escalate') return null;
  if (typeof raw.disputeId !== 'string' || !UUID.test(raw.disputeId)) return null;
  if (typeof raw.clientRequestId !== 'string' || !KEY.test(raw.clientRequestId)) return null;
  if (typeof raw.reason !== 'string') return null;
  const reason = raw.reason.trim();
  if (reason.length < REASON_MIN || reason.length > REASON_MAX) return null;
  return { action: 'p2p.dispute.escalate', disputeId: raw.disputeId, reason, clientRequestId: raw.clientRequestId };
}

export function describeDirect(request: EscalateRequest): string {
  return `Escalate dispute ${request.disputeId}: it is marked escalated and its trade deadline is re-armed the way the timeout sweep does. No money moves, and the dispute’s own deadline does not change.`;
}

/** A fresh key for one form. The form keeps it until the request succeeds, so a lost reply is safe to send again. */
export function newRequestKey(random: () => string = () => crypto.randomUUID()): string {
  return `console-${random()}`;
}
