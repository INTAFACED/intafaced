import { LedgerError } from '@intafaced/ledger-client';
import {
  CALLER_UNBOUND,
  KEY_REQUIRED_RECIPES,
  judgeCallerPost,
  recipeCandidates,
  type BindingViolation,
  type CallerBindingOptions,
  type PostCaller,
  type WirePost,
} from '@intafaced/ledger-client/gate';

/**
 * The door's side of the caller binding: what a judged post does here (count, warn, refuse). The judgement itself, who
 * may post what, is `@intafaced/ledger-client/gate` (`caller-judge.ts`), the one table the Rust ledger is recorded from.
 */

export interface CallerBindingCount {
  readonly reason: BindingViolation['reason'];
  readonly service: string | null;
  readonly count: number;
}

const countRows = new Map<string, CallerBindingCount>();
const WARN_INTERVAL_MS = 60_000;
const lastWarnAt = new Map<string, number>();

function countKey(reason: BindingViolation['reason'], service: string | null): string {
  return `${reason}\0${service ?? ''}`;
}

export function resetCallerBindingViolations(): void {
  countRows.clear();
  lastWarnAt.clear();
}

export function callerBindingViolationCount(): number {
  let total = 0;
  for (const row of countRows.values()) total += row.count;
  return total;
}

/** Counts by reason and claimed or bound service. This is the enforce signal. */
export function callerBindingCounts(): readonly CallerBindingCount[] {
  return [...countRows.values()];
}

export function callerBindingCount(reason: BindingViolation['reason'], service: string | null): number {
  return countRows.get(countKey(reason, service))?.count ?? 0;
}

/**
 * First warning for a claimed service, then at most one per minute.
 * The count itself is not limited.
 */
export function callerBindingWarnAllowed(service: string | null, now = Date.now()): boolean {
  const key = service ?? '';
  const previous = lastWarnAt.get(key);
  if (previous !== undefined && now - previous < WARN_INTERVAL_MS) return false;
  lastWarnAt.set(key, now);
  return true;
}

function addCallerBindingCount(violation: BindingViolation): void {
  const key = countKey(violation.reason, violation.service);
  const existing = countRows.get(key);
  countRows.set(key, {
    reason: violation.reason,
    service: violation.service,
    count: (existing?.count ?? 0) + 1,
  });
}

function violationMessage(violation: BindingViolation): string {
  if (violation.code === CALLER_UNBOUND) {
    return 'Ledger post requires a per-service key.';
  }
  if (violation.reason === 'module') {
    const recipe = violation.recipe ? ` as ${violation.recipe}` : '';
    return `Caller ${violation.service} may not post module ${violation.module}${recipe}.`;
  }
  return `Caller ${violation.service} may not post recipe ${violation.recipe ?? 'unknown'} (module ${violation.module}).`;
}

export function applyCallerBinding(caller: PostCaller, body: WirePost, options: CallerBindingOptions = {}): void {
  const judgment = judgeCallerPost(caller, body);
  const observations: BindingViolation[] = [];

  // A shared-secret post is unbound even when the claimed service is allowed to
  // send this body. It still posts (refusing it is what `keypair` mode does),
  // except a key-required recipe once keys are configured, refused below.
  if (caller.kind === 'legacy') {
    const alreadyUnbound = !judgment.ok && judgment.violation.reason === 'unbound';
    if (!alreadyUnbound) {
      observations.push({
        code: CALLER_UNBOUND,
        reason: 'unbound',
        service: caller.claimed,
        module: body.module,
        recipe: null,
      });
    }
  }
  if (!judgment.ok) observations.push(judgment.violation);
  for (const violation of observations) {
    addCallerBindingCount(violation);
    options.onViolation?.(violation);
  }
  // Only a proven key is held to the allowlist; a claimed name cannot be refused on its own say-so.
  if (!judgment.ok && caller.kind === 'bound') throw new LedgerError(violationMessage(judgment.violation), judgment.violation.code);
  // With keys configured, a key-required recipe is never posted on a claimed name, granted or not.
  if (caller.kind === 'legacy' && options.keysConfigured === true && recipeCandidates(body).some((r) => KEY_REQUIRED_RECIPES.has(r))) {
    throw new LedgerError(
      violationMessage({ code: CALLER_UNBOUND, reason: 'unbound', service: caller.claimed, module: body.module, recipe: null }),
      CALLER_UNBOUND,
    );
  }
}
