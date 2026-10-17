import { LedgerError, type RecipeName } from '@intafaced/ledger-client';
import { SERVICE_HEADER, headerValue, verifyServiceHeaders, type ServiceVerifyOptions } from '@intafaced/contracts';
import { grantFor, modulesFor, LEDGER_CALLER_SERVICES, callerSecretEnvName } from './caller-allowlist.js';
import { identifyRecipePost } from './recipe-gate.js';

/**
 * OPS-0001. The key id is `x-intafaced-service` (the header callers already
 * send). That name selects one HMAC secret. A signature that matches THAT
 * secret is a bound caller. A signature that matches only the fleet-wide
 * `INTERNAL_SERVICE_SECRET` is not: any of the services that hold it can mint
 * any other service's header.
 *
 * `LEDGER_CALLER_BINDING=report` (the default) still accepts the shared secret
 * and still posts. It counts and logs a body whose recipe or module is outside
 * the claimed service's allowlist. `enforce` refuses the shared secret and
 * refuses a bound caller outside its allowlist.
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

const violationCounts = new Map<string, number>();

export function resetCallerBindingViolations(): void {
  violationCounts.clear();
}

export function callerBindingViolationCount(): number {
  let total = 0;
  for (const count of violationCounts.values()) total += count;
  return total;
}

export function readCallerBindingMode(env: NodeJS.ProcessEnv = process.env): CallerBindingMode {
  const raw = env.LEDGER_CALLER_BINDING?.trim() ?? '';
  if (raw === '' || raw === 'report') return 'report';
  if (raw === 'enforce') return 'enforce';
  throw new Error(`LEDGER_CALLER_BINDING must be report or enforce, got ${raw}`);
}

/** Secrets configured for allowlisted callers. Blank values are unset. A short value refuses. */
export function callerSecretsFromEnv(env: NodeJS.ProcessEnv = process.env): Map<string, string> {
  const secrets = new Map<string, string>();
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
  }
  return secrets;
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
 * A legacy (shared-secret) caller is judged by the service name it claimed.
 * That name is not proven. Report mode still uses it so an honest caller is
 * quiet and a claim that does not match the body is visible. Enforce mode
 * never accepts a legacy caller: there is no verified identity.
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

  const recipe = identifyRecipePost(body);
  if (recipe) {
    const grant = grantFor(service, recipe);
    if (!grant) return fail(CALLER_FORBIDDEN, 'recipe', service, body.module, recipe);
    if (body.module !== grant.module) return fail(CALLER_FORBIDDEN, 'module', service, body.module, recipe);
    return { ok: true, recipe };
  }

  if (!modulesFor(service).has(body.module)) {
    return fail(CALLER_FORBIDDEN, 'module', service, body.module, null);
  }
  return { ok: true, recipe: null };
}

export function applyCallerBinding(caller: PostCaller, body: WirePost, options: CallerBindingOptions = {}): void {
  const mode = options.mode ?? readCallerBindingMode();
  const judgment = judgeCallerPost(caller, body, mode);
  if (judgment.ok) return;

  const key = `${judgment.violation.reason}:${judgment.violation.service ?? ''}:${judgment.violation.module}:${judgment.violation.recipe ?? ''}`;
  violationCounts.set(key, (violationCounts.get(key) ?? 0) + 1);
  options.onViolation?.(judgment.violation);
  if (mode === 'enforce') throw new LedgerError(violationMessage(judgment.violation), judgment.violation.code);
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
  }

  const shared = verifyServiceHeaders(headers, sharedSecret, verify);
  if (shared.service) return { kind: 'legacy', claimed: shared.service };

  const reason = shared.rejected ?? 'missing';
  throw new LedgerError(`Service credentials are required on the internal ledger API (§2): ${reason}`, 'ledger.unauthenticated');
}
