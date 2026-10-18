import type { Dispute } from '../schemas';
import { plainCode } from '../ui/plain-code';

export type Countdown =
  | { kind: 'none' }
  | { kind: 'closed' }
  | { kind: 'overdue'; days: number }
  | { kind: 'today' }
  | { kind: 'soon'; days: number }
  | { kind: 'later'; days: number };

const DAY = 86_400_000;
/** How long is left to answer. A dispute with no published deadline says so; it is never given a made-up one. */
export function countdown(dispute: Pick<Dispute, 'status' | 'responseDueAt'>, now: number): Countdown {
  if (dispute.status !== 'open' && dispute.status !== 'contested') return { kind: 'closed' };
  if (!dispute.responseDueAt) return { kind: 'none' };
  const left = Date.parse(dispute.responseDueAt) - now;
  if (!Number.isFinite(left)) return { kind: 'none' };
  if (left < 0) return { kind: 'overdue', days: Math.max(1, Math.ceil(-left / DAY)) };
  const days = Math.floor(left / DAY);
  if (days === 0) return { kind: 'today' };
  return days <= 3 ? { kind: 'soon', days } : { kind: 'later', days };
}

/** Soonest deadline first; disputes with no deadline follow, in the order they came. Sorting is on the rows shown, not the whole account. */
export function bySoonestDue<T extends Pick<Dispute, 'responseDueAt'>>(rows: readonly T[]): T[] {
  const dated = rows.filter((r) => r.responseDueAt).sort((a, b) => Date.parse(a.responseDueAt!) - Date.parse(b.responseDueAt!));
  return [...dated, ...rows.filter((r) => !r.responseDueAt)];
}

/** Evidence files the service accepts as bytes, and the ceiling it stores. */
export const EVIDENCE_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/plain'] as const;
export const EVIDENCE_MAX_BYTES = 1_048_576;
export type FileProblem = 'type' | 'size' | 'empty';
export function fileProblem(file: { contentType: string; sizeBytes: number }): FileProblem | null {
  if (file.sizeBytes === 0) return 'empty';
  if (file.sizeBytes > EVIDENCE_MAX_BYTES) return 'size';
  if (!(EVIDENCE_TYPES as readonly string[]).includes(file.contentType.toLowerCase())) return 'type';
  return null;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

const REASONS: Record<string, string> = {
  fraudulent: 'Fraud',
  product_not_received: 'Item not received',
  product_unacceptable: 'Item not as described',
  duplicate: 'Duplicate charge',
  subscription_canceled: 'Subscription cancelled',
  unrecognized: 'Charge not recognised',
  credit_not_processed: 'Refund not received',
  general: 'General dispute',
};
/** A dispute reason said as a person would say it. A code not on the list is turned into words, and a bank's own number is shown as it came. */
export const disputeReason = (code: string): string => REASONS[code.toLowerCase()] ?? plainCode(code);
