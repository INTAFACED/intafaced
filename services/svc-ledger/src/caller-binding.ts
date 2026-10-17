import { LedgerError, type RecipeName } from '@intafaced/ledger-client';
import { SERVICE_HEADER, headerValue, verifyServiceHeaders, type ServiceVerifyOptions } from '@intafaced/contracts';
import { assertDistinctCallerSecrets, grantFor, modulesFor, LEDGER_CALLER_SERVICES, callerSecretEnvName } from './caller-allowlist.js';
import { recipeCandidates } from './recipe-gate.js';

/**
 * OPS-0001. The key id is `x-intafaced-service` (the header callers already
 * send). That name selects one HMAC secret. A signature that matches THAT
 * secret is a bound caller. A signature that matches only the fleet-wide
 * `INTERNAL_SERVICE_SECRET` is not: any of the services that hold it can mint
 * any other service's header.
 *
 * `LEDGER_CALLER_BINDING=report` (the default) still accepts the shared secret
 * and still posts. Every shared-secret post is counted as unbound, under the
 * name the caller claimed. A body outside that claim is counted as well.
 * `enforce` refuses the shared secret and refuses a bound caller outside its
 * allowlist.
 */

export const CALLER_BINDING_MODES = ['report', 'enforce'] as const;
export type CallerBindingMode = (typeof CALLER_BINDING_MODES)[number];

export const CALLER_UNBOUND = 'ledger.caller_unbound';
export const CALLER_FORBIDDEN = 'ledger.caller_forbidden';

/** Key id header. Same bytes as the existing service header. */
export const LEDGER_CALLER_KEY_HEADER = SERVICE_HEADER;

const MIN_SECRET_LENGTH = 32;

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
  readonly mode?: CallerBindingMode;
  readonly onViolation?: (violation: BindingViolation) => void;
}

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

export function readCallerBindingMode(env: NodeJS.ProcessEnv = process.env): CallerBindingMode {
  const raw = env.LEDGER_CALLER_BINDING?.trim() ?? '';
  if (raw === '' || raw === 'report') return 'report';
  if (raw === 'enforce') return 'enforce';
  throw new Error(`LEDGER_CALLER_BINDING must be report or enforce, got ${raw}`);
}

/** Secrets configured for allowlisted callers. Blank values are unset. A short value refuses. */
export function callerSecretsFromEnv(env: NodeJS.ProcessEnv, sharedSecret: string): Map<string, string> {
  const secrets = new Map<string, string>();
  const named: Array<readonly [string, string]> = [];
  for (const service of LEDGER_CALLER_SERVICES) {
    const name = callerSecretEnvName(service);
    const raw = env[name];
    if (typeof raw !== 'string') continue;
    const secret = raw.trim();
    if (secret.length === 0) continue;
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new Error(`${name} must be at least ${MIN_SECRET_LENGTH} characters`);
    }
    secrets.set(service, secret);
    named.push([name, secret]);
  }
  assertDistinctCallerSecrets(named, sharedSecret);
  return secrets;
}

/** Same distinctness rule for secrets passed into `registerS2sHttp` instead of env. */
export function callerSecretsFromRecord(record: Readonly<Record<string, string>>, sharedSecret: string): Map<string, string> {
  assertDistinctCallerSecrets(
    Object.entries(record).map(([service, secret]) => [callerSecretEnvName(service), secret]),
    sharedSecret,
  );
  return new Map(Object.entries(record));
}

function violationMessage(violation: BindingViolation): string {
  if (violation.code === CALLER_UNBOUND) {
    return 'Ledger post requires a per-service key. The shared internal secret is accepted only while LEDGER_CALLER_BINDING=report.';
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
 * That name is not proven. Enforce mode never accepts a legacy caller.
 */
export function judgeCallerPost(
  caller: PostCaller,
  body: WirePost,
  mode: CallerBindingMode,
): { ok: true; recipe: RecipeName | null } | { ok: false; violation: BindingViolation } {
  if (caller.kind === 'legacy' && mode === 'enforce') {
    return fail(CALLER_UNBOUND, 'unbound', caller.claimed, body.module, null);
  }

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
  const mode = options.mode ?? readCallerBindingMode();
  const judgment = judgeCallerPost(caller, body, mode);
  const observations: BindingViolation[] = [];

  // Report mode must show what enforce would refuse. A shared-secret post is
  // unbound even when the claimed service is allowed to send this body.
  if (mode === 'report' && caller.kind === 'legacy') {
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
  if (observations.length === 0) return;

  for (const violation of observations) {
    addCallerBindingCount(violation);
    options.onViolation?.(violation);
  }
  if (!judgment.ok && mode === 'enforce') throw new LedgerError(violationMessage(judgment.violation), judgment.violation.code);
}

/**
 * Prove which service signed this post.
 *
 * The key id picks at most one dedicated secret. Matching it binds that
 * service. Falling through to the shared secret does not: the header name is
 * then only a claim. Enforce refuses that claim before the body is posted.
 */
export function authenticatePostCaller(
  headers: Record<string, string | string[] | undefined>,
  sharedSecret: string,
  secrets: ReadonlyMap<string, string>,
  verify: ServiceVerifyOptions,
): PostCaller {
  const keyId = headerValue(headers, LEDGER_CALLER_KEY_HEADER);
  const dedicated = keyId ? secrets.get(keyId) : undefined;
  if (dedicated) {
    const bound = verifyServiceHeaders(headers, dedicated, verify);
    if (bound.service) return { kind: 'bound', service: bound.service };
    // A dedicated secret that matched the signature and then failed the body,
    // or a call that is already stale, must not be reported as the shared
    // secret's bad-signature.
    if (bound.rejected === 'stale' || bound.rejected === 'body-mismatch') {
      throw new LedgerError(
        `Service credentials are required on the internal ledger API (§2): ${bound.rejected}`,
        'ledger.unauthenticated',
      );
    }
  }

  const shared = verifyServiceHeaders(headers, sharedSecret, verify);
  if (shared.service) return { kind: 'legacy', claimed: shared.service };

  const reason = shared.rejected ?? 'missing';
  throw new LedgerError(`Service credentials are required on the internal ledger API (§2): ${reason}`, 'ledger.unauthenticated');
}
