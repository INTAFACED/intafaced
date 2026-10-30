import { LedgerError, type RecipeName } from '@intafaced/ledger-client';
import { grantFor, modulesFor } from './caller-allowlist.js';
import { recipeCandidates } from './recipe-gate.js';

/**
 * Who may post what. The caller is the owner of the key that verified the
 * request (S2S v3), never a header it claimed. A bound caller outside its
 * allowlist is refused in every mode. A call signed only with the shared
 * `INTERNAL_SERVICE_SECRET` is a claim: it still posts while the service runs in
 * `dual` mode, and every such post is counted as unbound under the name claimed,
 * which is the signal that the caller has not moved to its key yet. The one
 * exception is `KEY_REQUIRED_RECIPES`: once keys are configured, a claim is
 * counted and then refused for those. `keypair` mode refuses the shared secret
 * before this code runs.
 */

export const CALLER_UNBOUND = 'ledger.caller_unbound';
export const CALLER_FORBIDDEN = 'ledger.caller_forbidden';

export type PostCaller =
  { readonly kind: 'bound'; readonly service: string } | { readonly kind: 'legacy'; readonly claimed: string | null };

export interface BindingViolation {
  readonly code: typeof CALLER_UNBOUND | typeof CALLER_FORBIDDEN;
  readonly reason: 'unbound' | 'recipe' | 'module';
  readonly service: string | null;
  readonly module: string;
  readonly recipe: string | null;
}

export interface CallerBindingOptions {
  readonly onViolation?: (violation: BindingViolation) => void;
  /**
   * True when the service runs with per-service keys (`dual` or `keypair`). Then a shared-secret post of a
   * `KEY_REQUIRED_RECIPES` body is counted and then refused. Unset (S2S off) every recipe stays count-only.
   */
  readonly keysConfigured?: boolean;
}

/**
 * Recipes that only a proven key may post once keys exist. The token buyback moves the rewards engine's quote into
 * and out of an order hold and pays a customer from it; a claimed name under the shared secret must not do that.
 */
export const KEY_REQUIRED_RECIPES: ReadonlySet<RecipeName> = new Set<RecipeName>([
  'buybackOrderHold',
  'buybackOrderHoldRelease',
  'buybackTakerFill',
]);

type WirePost = {
  module: string;
  reason: string;
  entries: readonly {
    account: { ownerType: string; kind: string; ownerId?: string; purpose?: string };
    direction: string;
  }[];
};

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

function fail(
  code: BindingViolation['code'],
  reason: BindingViolation['reason'],
  service: string | null,
  module: string,
  recipe: string | null,
): { ok: false; violation: BindingViolation } {
  return { ok: false, violation: { code, reason, service, module, recipe } };
}

/**
 * Allowlist decision for one post body.
 *
 * A body can match more than one recipe. The post is allowed when any
 * candidate is granted to this caller and the body module is that grant's
 * module. A refusal names the first candidate.
 *
 * A legacy (shared-secret) caller is judged by the service name it claimed.
 * That name is not proven.
 */
export function judgeCallerPost(
  caller: PostCaller,
  body: WirePost,
): { ok: true; recipe: RecipeName | null } | { ok: false; violation: BindingViolation } {
  const service = caller.kind === 'bound' ? caller.service : caller.claimed;
  if (!service) return fail(CALLER_UNBOUND, 'unbound', null, body.module, null);

  const candidates = recipeCandidates(body);
  if (candidates.length === 0) {
    if (!modulesFor(service).has(body.module)) {
      return fail(CALLER_FORBIDDEN, 'module', service, body.module, null);
    }
    return { ok: true, recipe: null };
  }

  let firstForbidden: { ok: false; violation: BindingViolation } | undefined;
  for (const recipe of candidates) {
    const grant = grantFor(service, recipe);
    if (!grant) {
      firstForbidden ??= fail(CALLER_FORBIDDEN, 'recipe', service, body.module, recipe);
      continue;
    }
    if (body.module !== grant.module) {
      firstForbidden ??= fail(CALLER_FORBIDDEN, 'module', service, body.module, recipe);
      continue;
    }
    return { ok: true, recipe };
  }
  return firstForbidden ?? fail(CALLER_FORBIDDEN, 'recipe', service, body.module, candidates[0] ?? null);
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
