import { REASON_MAX, REASON_MIN, UUID } from '@/lib/desk/approval-packet';

/**
 * A founder's step on a deposit held for the inbound travel rule (W-deposit-07, J-wallet-03 #2-#3), as this console asks for it.
 *
 * `wait` records that compliance is waiting on the sending platform, for the owner's pending wait limit; nothing is released when
 * it runs out. `release` lets a declared deposit through: svc-pay credits it once under its usual deposit key. Each is one founder
 * with a reason. Pure, so the browser builds the request with the same rules the server checks.
 */

export const TRAVEL_RULE_ACTIONS = ['wait', 'release'] as const;
export type TravelRuleAction = (typeof TRAVEL_RULE_ACTIONS)[number];

export interface TravelRuleRequest {
  readonly action: TravelRuleAction;
  readonly depositId: string;
  readonly reason: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** Strict reader. The reason is trimmed the way svc-pay keeps it; anything off-shape is null. */
export function readTravelRuleRequest(raw: unknown): TravelRuleRequest | null {
  if (!isRecord(raw) || Object.keys(raw).sort().join(',') !== 'action,depositId,reason') return null;
  if (typeof raw.action !== 'string' || !(TRAVEL_RULE_ACTIONS as readonly string[]).includes(raw.action)) return null;
  if (typeof raw.depositId !== 'string' || !UUID.test(raw.depositId)) return null;
  if (typeof raw.reason !== 'string') return null;
  const reason = raw.reason.trim();
  if (reason.length < REASON_MIN || reason.length > REASON_MAX) return null;
  return { action: raw.action as TravelRuleAction, depositId: raw.depositId, reason };
}

/** Which steps a record in `state` takes. Release also needs the depositor's declaration. */
export function travelRuleSteps(state: string | null, declared: boolean): { wait: boolean; release: boolean } {
  return {
    wait: state === 'awaiting_declaration' || state === 'under_review' || state === 'blocking_time_expired',
    release: declared && (state === 'under_review' || state === 'counterparty_pending' || state === 'blocking_time_expired'),
  };
}

export interface HeldAnswer {
  readonly depositId: string;
  readonly state: string;
  readonly waitDeadline: string | null;
}

function readHeld(raw: unknown): HeldAnswer | null {
  if (!isRecord(raw)) return null;
  const { depositId, state, waitDeadline } = raw;
  if (typeof depositId !== 'string' || typeof state !== 'string') return null;
  if (waitDeadline !== null && typeof waitDeadline !== 'string') return null;
  return { depositId, state, waitDeadline };
}

/** svc-pay's `founderAdmin.depositTravelRule.markCounterpartyPending` answer, or null when it is not that shape. */
export function readWaitAnswer(raw: unknown): HeldAnswer | null {
  const held = readHeld(raw);
  return held && held.state === 'counterparty_pending' && held.waitDeadline !== null ? held : null;
}

/** svc-pay's `founderAdmin.depositTravelRule.release` answer, or null when it is not that shape. */
export function readReleaseAnswer(raw: unknown): (HeldAnswer & { credited: boolean }) | null {
  if (!isRecord(raw) || typeof raw.credited !== 'boolean') return null;
  const held = readHeld(raw.deposit);
  return held && held.state === 'released' ? { ...held, credited: raw.credited } : null;
}

/** What the founder reads after the step ran. */
export function travelRuleDetail(action: TravelRuleAction, answer: HeldAnswer & { credited?: boolean }): string {
  if (action === 'wait') {
    return `svc-pay recorded that compliance is waiting on the sending platform until ${answer.waitDeadline}. The deposit stays held; when the wait runs out it is still held, and only a release lets it through.`;
  }
  return answer.credited
    ? 'svc-pay released the deposit and credited it once, under the same key as any deposit.'
    : 'svc-pay released the deposit. It is not credited yet (it still waits for confirmations, or the ledger did not answer); the next pass credits it once under the same key.';
}
