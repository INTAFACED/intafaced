import type { PayHaltScope, PayHaltState, PayHaltTarget } from '@intafaced/contracts';

/**
 * Pay halts: the pure rules behind the form. Every disabled state is a test.
 *
 * What svc-pay decides, and this file only mirrors for clarity:
 *   - SET (halt) is one founder and immediate: the fast stop.
 *   - CLEAR is two distinct founders. The first call answers `pending_confirmation`; a different founder repeating
 *     the same call (same request id, scope, target and version) applies it.
 *   - A user or rail halt only exists for payout; the service refuses it on any other scope.
 *   - `expectedVersion` must equal the halt's current version (`0` when it was never set), or the answer is `conflict`.
 */

export const HALT_SCOPES: readonly PayHaltScope[] = ['intake', 'conversion', 'payout', 'settlement'];
export const TARGET_LEVELS = ['global', 'merchant', 'user', 'rail'] as const;
export type TargetLevel = (typeof TARGET_LEVELS)[number];
export const HALT_REASON_MIN = 12;
export const HALT_REASON_MAX = 500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RAIL = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function targetFrom(level: TargetLevel, id: string): PayHaltTarget | null {
  const value = id.trim();
  if (level === 'global') return { level: 'global' };
  if (level === 'merchant') return UUID.test(value) ? { level: 'merchant', merchantId: value.toLowerCase() } : null;
  if (level === 'user') return UUID.test(value) ? { level: 'user', userId: value.toLowerCase() } : null;
  return RAIL.test(value) ? { level: 'rail', railId: value } : null;
}

export function targetKey(scope: string, target: PayHaltTarget): string {
  if (target.level === 'global') return `${scope}:global`;
  if (target.level === 'merchant') return `${scope}:merchant:${target.merchantId}`;
  if (target.level === 'user') return `${scope}:user:${target.userId}`;
  return `${scope}:rail:${target.railId}`;
}

export function describeTarget(target: PayHaltTarget): string {
  if (target.level === 'global') return 'Everyone (global)';
  if (target.level === 'merchant') return `Merchant ${target.merchantId}`;
  if (target.level === 'user') return `User ${target.userId} (their withdrawal exit)`;
  return `Rail ${target.railId} (every merchant’s sends on it)`;
}

/** Why this scope and target cannot be combined, or null. The service refuses it too. */
export function scopeTargetProblem(scope: PayHaltScope, target: PayHaltTarget): string | null {
  if ((target.level === 'user' || target.level === 'rail') && scope !== 'payout') {
    return 'A user or rail halt only works on payouts. Pick the payout operation, or pick a global or merchant target.';
  }
  return null;
}

/** The version a write must carry: the halt's current version, or `0` for one that was never set. */
export function versionFor(states: readonly PayHaltState[], scope: PayHaltScope, target: PayHaltTarget): string {
  const key = targetKey(scope, target);
  return states.find((s) => targetKey(s.scope, s.target) === key)?.version ?? '0';
}

export function stateFor(states: readonly PayHaltState[], scope: PayHaltScope, target: PayHaltTarget): PayHaltState | null {
  const key = targetKey(scope, target);
  return states.find((s) => targetKey(s.scope, s.target) === key) ?? null;
}

/** The exact phrase to type. It names the operation, so a wrong click on a neighbouring row does not pass. */
export function haltPhrase(scope: PayHaltScope, halted: boolean): string {
  return `${halted ? 'HALT' : 'CLEAR'} ${scope}`;
}

export type Gate = { readonly ok: true } | { readonly ok: false; readonly why: string };

export function setGate(input: {
  scope: PayHaltScope;
  target: PayHaltTarget | null;
  halted: boolean;
  reason: string;
  confirm: string;
  busy: boolean;
}): Gate {
  if (input.busy) return { ok: false, why: 'A step is already in progress.' };
  if (!input.target) return { ok: false, why: 'Name the target: a merchant or user id (a UUID), or a rail id.' };
  const problem = scopeTargetProblem(input.scope, input.target);
  if (problem) return { ok: false, why: problem };
  const reason = input.reason.trim();
  if (reason.length < HALT_REASON_MIN) return { ok: false, why: `Write the reason first (at least ${HALT_REASON_MIN} characters).` };
  if (reason.length > HALT_REASON_MAX) return { ok: false, why: `The reason is too long (at most ${HALT_REASON_MAX} characters).` };
  const phrase = haltPhrase(input.scope, input.halted);
  if (input.confirm !== phrase) return { ok: false, why: `Type ${phrase} exactly to confirm.` };
  return { ok: true };
}

/** A pending clear can be confirmed by anyone but the founder who proposed it. The service enforces the same rule. */
export function canConfirmClear(proposedBy: string, userId: string): boolean {
  return userId.trim() !== '' && proposedBy.toLowerCase() !== userId.toLowerCase();
}

export type Outcome = 'changed' | 'noop' | 'conflict' | 'pending_confirmation';

/** Plain words for what the service answered. `applied` is true only for `changed`. */
export function explainOutcome(outcome: Outcome, halted: boolean): { title: string; body: string; applied: boolean } {
  switch (outcome) {
    case 'changed':
      return {
        title: halted ? 'Halt applied' : 'Halt cleared',
        body: 'svc-pay says it applied the change. The state below was read again from svc-pay.',
        applied: true,
      };
    case 'pending_confirmation':
      return {
        title: 'Recorded, waiting for a second founder',
        body: 'Clearing a halt takes two different founders. The halt is STILL ON. A different founder confirms it from the pending list below.',
        applied: false,
      };
    case 'noop':
      return {
        title: 'No change',
        body: halted ? 'It was already halted.' : 'It was not halted, or this request was already used. Nothing changed.',
        applied: false,
      };
    case 'conflict':
      return {
        title: 'Not applied: the halt moved on',
        body: 'Someone changed it after you looked, or this request id was used for a different change. Read the state again and decide again.',
        applied: false,
      };
  }
}
