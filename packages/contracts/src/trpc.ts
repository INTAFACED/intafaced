import { initTRPC, TRPCError } from '@trpc/server';
import type { Principal, Scope } from '@intafaced/auth';
import { requireScope, requireTier, AuthError, hasScope } from '@intafaced/auth';
import type { AccessDecision, KycTier, ModuleId, Plane } from '@intafaced/config';
import { checkAccess } from '@intafaced/config';
import { P2P_DELIST_REASONS, type P2pDelistReason } from './p2p-delist.js';
import { P2P_FIELD_KEY, P2P_RULE_CLASS } from './p2p-rule-class.js';
import { isPreviewRefusal, type PreviewRefusal } from './preview-refusal.js';
import { requireServiceCaller } from './service-auth.js';

/**
 * The tRPC foundation every internal router builds on.
 *
 * §2: cross-service calls go through packages/contracts. A service exports its
 * router type from here; callers import the TYPE only and get end-to-end
 * inference without importing the implementation — or, critically, its tables.
 */

/**
 * A refusal that came from the JURISDICTION_MATRIX rather than from the token.
 *
 * It exists to carry `AccessDecision.code` — `denied.kyc_required`,
 * `denied.region_blocked`, `denied.region_unknown`, `denied.screening_unconfigured`,
 * `denied.module_blocked`, `denied.plane_unsupported` — out to the caller. Before it, a matrix refusal
 * was thrown as a bare TRPCError with prose and no `cause`, so `intafacedCode`
 * came back undefined and the only machine-readable fact about the densest
 * gate in the OS was "403". A user short of KYC and a user in a blocked region
 * were the same event to every client, dashboard and metric.
 *
 * `requiredTier` is the actionable half: it is what lets a screen say "verify
 * to tier full" rather than "refused".
 */
export class JurisdictionError extends Error {
  readonly code: AccessDecision['code'];
  readonly requiredTier: KycTier | undefined;

  constructor(readonly decision: AccessDecision) {
    super(decision.reason);
    this.name = 'JurisdictionError';
    this.code = decision.code;
    this.requiredTier = decision.requiredTier;
  }
}

export interface Context {
  /** Null for anonymous calls. */
  principal: Principal | null;
  /**
   * The calling SERVICE, when one authenticated itself (§2).
   *
   * Orthogonal to `principal`: a service call carries no user. `ledger.post` is
   * the case that matters — it moves value on behalf of a module's own
   * decision, which is why there is no `ledger:write` scope for a user to hold.
   * Null when the caller did not present service credentials.
   */
  service: string | null;
  /**
   * How `service` was authenticated, when the verifier can tell.
   *
   * `dedicated` means the HMAC matched that service's own secret, so the name
   * is a verified key id. `shared` means only the fleet-wide internal secret
   * matched, so the header name is a claim. Omit when the context was not
   * produced by a verifier that distinguishes them. svc-ledger post treats
   * anything other than `dedicated` as a claim.
   */
  serviceAuth?: 'dedicated' | 'shared' | 'keypair';
  /** Resolved at the edge from IP / account region. Drives the matrix. */
  region: string;
  /**
   * The exact principal header, signature and region the edge signed for this request. Set only
   * when `principal` was verified. Services pass it on unchanged (`forwardedPrincipalHeaders`);
   * they cannot produce or alter one.
   */
  forwardedPrincipal?: { readonly raw: string; readonly signature: string; readonly region: string };
  /** W3C traceparent so a call keeps its trace across services (§9). */
  traceparent?: string;
  requestId: string;
  /**
   * Optional recheck of an owner's `pay:read` / `pay:write` / `pay:onboard`
   * against the live merchant. Installed only by svc-pay production context.
   * Callers who own no merchant (team members) are not refused here.
   */
  ownerPayGrant?: OwnerPayGrantRecheck;
}

/**
 * Owner scopes a later merchant change can withdraw: the two acquiring scopes an API key can carry, and
 * `pay:onboard`, which a session keeps until it expires after its business is suspended or closed.
 */
export type OwnerPayScope = 'pay:read' | 'pay:write' | 'pay:onboard';

export interface OwnerPayGrantRecheck {
  assertStillGranted(principal: Principal, scope: OwnerPayScope): Promise<void>;
}

function causeCode(cause: unknown): string | undefined {
  if (cause instanceof AuthError || cause instanceof JurisdictionError) return cause.code;
  if (cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string') {
    return cause.code;
  }
  return undefined;
}

/** The refusals that carry the seconds to wait. No other error changes shape. */
const RETRY_AFTER_CODES = new Set([
  'auth.too_many_attempts',
  'auth.email_confirm_rate_limited',
  'kyc.attempts_exhausted',
  'identity.self_freeze_lift_too_soon',
  'identity.resend_too_soon',
]);

/**
 * `retryAfterSeconds` of a refusal in `RETRY_AFTER_CODES` (`auth.too_many_attempts`, `auth.email_confirm_rate_limited`,
 * `kyc.attempts_exhausted`, `identity.self_freeze_lift_too_soon`, `identity.resend_too_soon` from both the sign-up and
 * the code sign-in resend), so a client can show "try again in N minutes".
 */
export function retryAfterSecondsOf(cause: unknown): number | undefined {
  if (!cause || typeof cause !== 'object' || !('code' in cause) || typeof cause.code !== 'string' || !RETRY_AFTER_CODES.has(cause.code)) {
    return undefined;
  }
  const details = 'details' in cause ? cause.details : undefined;
  if (!details || typeof details !== 'object' || !('retryAfterSeconds' in details)) return undefined;
  const seconds = details.retryAfterSeconds;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : undefined;
}

/**
 * `accountState` of an `auth.account_frozen` refusal: `frozen` (staff can lift it) or `closed` (final). svc-identity
 * sets it on sign-in only after the password verified. Any other value, or any other code, is dropped.
 */
export function accountStateOf(cause: unknown): 'frozen' | 'closed' | undefined {
  if (!cause || typeof cause !== 'object' || !('code' in cause) || cause.code !== 'auth.account_frozen') return undefined;
  const details = 'details' in cause ? cause.details : undefined;
  if (!details || typeof details !== 'object' || !('accountState' in details)) return undefined;
  const state = details.accountState;
  return state === 'frozen' || state === 'closed' ? state : undefined;
}

/**
 * The waiting sign-in of an `auth.device_authorisation_required` refusal (I-signin-sessions-07): its flow id, the secret
 * only the browser that signed in holds, when it expires, and whether a code was mailed. It goes only to the requester
 * who just passed every factor, so it names nothing they did not already prove. When that sign-in's second step spent a
 * recovery code, `recoveryCodesLeft` says how many the account has left (I-signin-sessions-12).
 */
export function deviceAuthorisationOf(
  cause: unknown,
): { flowId: string; secret: string; expiresAt: string; mailed: boolean; recoveryCodesLeft?: number } | undefined {
  if (!cause || typeof cause !== 'object' || !('code' in cause) || cause.code !== 'auth.device_authorisation_required') return undefined;
  const details = 'details' in cause ? cause.details : undefined;
  if (!details || typeof details !== 'object' || !('deviceAuthorisation' in details)) return undefined;
  const d = details.deviceAuthorisation as Record<string, unknown> | null;
  if (
    !d ||
    typeof d.flowId !== 'string' ||
    typeof d.secret !== 'string' ||
    typeof d.expiresAt !== 'string' ||
    typeof d.mailed !== 'boolean'
  ) {
    return undefined;
  }
  const left = d.recoveryCodesLeft;
  const recovery = typeof left === 'number' && Number.isSafeInteger(left) && left >= 0 ? { recoveryCodesLeft: left } : {};
  return { flowId: d.flowId, secret: d.secret, expiresAt: d.expiresAt, mailed: d.mailed, ...recovery };
}

export type SecondStepPasskeyOptions = {
  challenge: string;
  timeout?: number;
  rpId?: string;
  allowCredentials: Array<{ id: string; type: 'public-key'; transports?: string[] }>;
  userVerification?: 'required' | 'preferred' | 'discouraged';
};

const B64URL = /^[A-Za-z0-9_-]{1,1400}$/;

/**
 * The second steps an `auth.mfa_required` sign-in may answer with (I-signin-sessions-10): `totp` when the account has an
 * authenticator, and `passkey`, the options for a single-use challenge bound to the account whose password just
 * verified, when it has a passkey for sign-in. Sent only after the password verified, so the credential ids go to
 * someone who already proved the first factor. Any other shape, or any other code, is dropped.
 */
export function secondStepOf(cause: unknown): { totp: boolean; passkey: SecondStepPasskeyOptions | null } | undefined {
  if (!cause || typeof cause !== 'object' || !('code' in cause) || cause.code !== 'auth.mfa_required') return undefined;
  const details = 'details' in cause ? cause.details : undefined;
  if (!details || typeof details !== 'object' || !('secondStep' in details)) return undefined;
  const d = details.secondStep as Record<string, unknown> | null;
  if (!d || typeof d.totp !== 'boolean') return undefined;
  const raw = d.passkey as Record<string, unknown> | null | undefined;
  if (raw === null || raw === undefined) return { totp: d.totp, passkey: null };
  if (typeof raw.challenge !== 'string' || !B64URL.test(raw.challenge) || !Array.isArray(raw.allowCredentials)) return undefined;
  const allowCredentials: SecondStepPasskeyOptions['allowCredentials'] = [];
  for (const item of raw.allowCredentials as Array<Record<string, unknown>>) {
    if (!item || typeof item.id !== 'string' || !B64URL.test(item.id) || item.type !== 'public-key') return undefined;
    const transports = Array.isArray(item.transports) ? item.transports.filter((t): t is string => typeof t === 'string') : undefined;
    allowCredentials.push({ id: item.id, type: 'public-key', ...(transports ? { transports } : {}) });
  }
  if (allowCredentials.length === 0) return undefined;
  const uv = raw.userVerification;
  return {
    totp: d.totp,
    passkey: {
      challenge: raw.challenge,
      allowCredentials,
      ...(typeof raw.timeout === 'number' && Number.isFinite(raw.timeout) ? { timeout: raw.timeout } : {}),
      ...(typeof raw.rpId === 'string' ? { rpId: raw.rpId } : {}),
      ...(uv === 'required' || uv === 'preferred' || uv === 'discouraged' ? { userVerification: uv } : {}),
    },
  };
}

const BLOCKER_CODE = /^[a-z][a-z0-9_.]*$/;

const ALGO_MONEY_CODES = new Set(['trade.algo_insufficient_balance', 'trade.algo_balance_unreadable']);
const ALGO_MONEY_KEYS = ['asset', 'required', 'available', 'fee', 'feeAsset', 'sliceQty'] as const;
const ALGO_ASSET = /^[A-Z][A-Z0-9]{0,15}$/;
const ALGO_DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/;

/**
 * Amounts on an algo creation refusal. Decimal strings and asset codes only.
 * Any other key, or a value that is not that shape, is dropped so a sentence
 * cannot ride out on this field.
 */
/**
 * Only on `preview.engine_not_built`. The cause may arrive wrapped by tRPC,
 * so the five fields are picked and re-checked against the schema; anything
 * else on the cause is dropped.
 */
export function previewRefusalOf(cause: unknown): PreviewRefusal | undefined {
  if (!cause || typeof cause !== 'object') return undefined;
  const c = cause as Record<string, unknown>;
  const picked = { kind: c.kind, code: c.code, engine: c.engine, action: c.action, label: c.label };
  return isPreviewRefusal(picked) ? picked : undefined;
}

export function algoRefusalDetails(cause: unknown): Record<string, string> | undefined {
  if (!cause || typeof cause !== 'object' || !('code' in cause) || !('data' in cause)) return undefined;
  const code = (cause as { code?: unknown }).code;
  if (typeof code !== 'string' || !ALGO_MONEY_CODES.has(code)) return undefined;
  const raw = (cause as { data?: unknown }).data;
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const key of ALGO_MONEY_KEYS) {
    if (!(key in raw)) continue;
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value !== 'string') return undefined;
    const ok = key === 'asset' || key === 'feeAsset' ? ALGO_ASSET.test(value) : ALGO_DECIMAL.test(value);
    if (!ok) return undefined;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const ALLOWANCE_KEYS = ['perTx', 'rolling24h'] as const;

/**
 * Remaining withdrawal allowance on a `pay.guard_withdrawal_limit_exceeded`
 * refusal (D-148), so a customer can be told what they may still send. Decimal
 * strings only; any other key is dropped and a malformed value drops the lot,
 * so a sentence cannot ride out on this field.
 */
export function withdrawalAllowanceOf(cause: unknown): { perTx: string; rolling24h: string } | undefined {
  if (!cause || typeof cause !== 'object' || !('code' in cause) || cause.code !== 'pay.guard_withdrawal_limit_exceeded') return undefined;
  const raw = 'remaining' in cause ? cause.remaining : undefined;
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const key of ALLOWANCE_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value !== 'string' || !ALGO_DECIMAL.test(value)) return undefined;
    out[key] = value;
  }
  return out as { perTx: string; rolling24h: string };
}

/**
 * The protocol blocker on `token.delegation_unavailable` only.
 * Any other string is dropped, so a sentence cannot ride out on this field.
 */
export function delegationBlockerOf(cause: unknown): 'no_chain_service' | undefined {
  if (!cause || typeof cause !== 'object' || !('code' in cause) || cause.code !== 'token.delegation_unavailable') return undefined;
  if (!('blocker' in cause) || cause.blocker !== 'no_chain_service') return undefined;
  return 'no_chain_service';
}

/** Codes copied onto a tRPC error. Sentences and extra keys are dropped. */
export function errorBlockersOf(cause: unknown): { code: string }[] | undefined {
  if (!cause || typeof cause !== 'object' || !('blockers' in cause)) return undefined;
  const raw = (cause as { blockers?: unknown }).blockers;
  if (!Array.isArray(raw)) return undefined;
  const blockers: { code: string }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || !('code' in item)) return undefined;
    const code = (item as { code?: unknown }).code;
    if (typeof code !== 'string' || !BLOCKER_CODE.test(code)) return undefined;
    blockers.push({ code });
  }
  return blockers.length > 0 ? blockers : undefined;
}

/** The current profile row on `identity.profile_version_conflict` only. */
export function conflictProfile(
  cause: unknown,
): { displayName: string | null; locale: string; region: string | null; version: number } | undefined {
  if (!cause || typeof cause !== 'object' || !('code' in cause) || cause.code !== 'identity.profile_version_conflict') return undefined;
  if (!('profile' in cause) || !cause.profile || typeof cause.profile !== 'object') return undefined;
  const row = cause.profile as Record<string, unknown>;
  const { displayName, locale, region, version } = row;
  if (!(displayName === null || typeof displayName === 'string')) return undefined;
  if (typeof locale !== 'string') return undefined;
  if (!(region === null || typeof region === 'string')) return undefined;
  if (typeof version !== 'number' || !Number.isInteger(version)) return undefined;
  return { displayName, locale, region, version };
}

const SPEND_DECIMAL = /^-?\d{1,40}(\.\d{1,18})?$/;
const SPEND_ASSET = /^[A-Z0-9._-]{1,16}$/;

/**
 * Figures on `bank.insufficient_funds` (RC-wallet-09): the caller's own
 * available, held and in-Earn amounts for the refused asset. Decimal strings
 * only; `inEarn` may be null (earn read failed, unknown rather than zero). Any
 * malformed field drops the lot, so a sentence cannot ride out on this field.
 */
export function spendFiguresOf(cause: unknown): { assetId: string; available: string; onHold: string; inEarn: string | null } | undefined {
  if (!cause || typeof cause !== 'object' || !('code' in cause) || cause.code !== 'bank.insufficient_funds') return undefined;
  const raw = (cause as { data?: unknown }).data;
  if (!raw || typeof raw !== 'object') return undefined;
  const { assetId, available, onHold, inEarn } = raw as Record<string, unknown>;
  if (typeof assetId !== 'string' || !SPEND_ASSET.test(assetId)) return undefined;
  if (typeof available !== 'string' || !SPEND_DECIMAL.test(available)) return undefined;
  if (typeof onHold !== 'string' || !SPEND_DECIMAL.test(onHold)) return undefined;
  if (!(inEarn === null || (typeof inEarn === 'string' && SPEND_DECIMAL.test(inEarn)))) return undefined;
  return { assetId, available, onHold, inEarn };
}

/** P2P refusals about one field of a payment destination: the answer names the field's key (never its value). */
const P2P_FIELD_CODES = ['p2p.account_format_invalid', 'p2p.instrument_field_missing', 'p2p.instrument_field_invalid'] as const;
const P2P_LIMIT_CODES = new Set<string>([
  'p2p.active_order_cap',
  'p2p.pair_limit_exceeded',
  'p2p.verification_order_min',
  'p2p.verification_order_max',
  'p2p.verification_daily_limit',
  'p2p.verification_lifetime_limit',
  'p2p.method_delisted',
  'p2p.buying_restricted',
  'p2p.insufficient_balance',
  'p2p.remind_too_early',
  'p2p.remind_rate_limited',
  'p2p.content_rule_violation',
  // P-ads-merchant-06: closing an ad that still has open orders (how many, and which), and the daily edit cap.
  'p2p.offer_has_open_trades',
  'p2p.edit_quota_reached',
  ...P2P_FIELD_CODES,
]);
const DELIST_REASONS: ReadonlySet<string> = new Set(P2P_DELIST_REASONS);
const P2P_LIMIT_DECIMALS = ['cap', 'min', 'max', 'remaining', 'windowHours', 'available', 'shortBy', 'openTrades'] as const;
const P2P_LIMIT_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const P2P_LIMIT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface P2pLimitDetails {
  /** When the refusal stops applying, as an ISO instant; `null` when it has no end time. */
  until: string | null;
  cap?: string;
  min?: string;
  max?: string;
  remaining?: string;
  /** On `p2p.buying_restricted`: the hours the cancelled orders (`cap` of them) are counted over. */
  windowHours?: string;
  /** On `p2p.insufficient_balance`: the seller's free balance of the order's coin, and how much more the order needs. */
  available?: string;
  shortBy?: string;
  currency?: string;
  openTradeIds?: string[];
  /** On `p2p.offer_has_open_trades` only: how many orders on the ad are open (`openTradeIds` lists the first 50). */
  openTrades?: string;
  /** On `p2p.method_delisted` only: why the method was retired. */
  reason?: P2pDelistReason;
  /** On `p2p.content_rule_violation` only: the content rule class an ad's terms broke, never the phrase. */
  ruleClass?: string;
  /** On a payment destination's field refusal (format, missing, invalid) only: the method field's key, never its value. */
  field?: string;
}

/**
 * The figures behind a P2P take limit (P-trade-orders-03, -05, P-disputes-security-15): when it ends, the published
 * bounds, what is left, and the caller's own open orders on the order cap. Decimal strings, an ISO instant, a
 * currency code and trade ids only; any malformed field drops the lot, so a sentence cannot ride out on it.
 */
export function p2pLimitOf(cause: unknown): P2pLimitDetails | undefined {
  if (!cause || typeof cause !== 'object' || !('code' in cause) || typeof cause.code !== 'string') return undefined;
  if (!P2P_LIMIT_CODES.has(cause.code) || !('limit' in cause)) return undefined;
  const raw = cause.limit;
  if (!raw || typeof raw !== 'object') return undefined;
  const row = raw as Record<string, unknown>;
  const until = row.until;
  if (!(until === null || (typeof until === 'string' && P2P_LIMIT_INSTANT.test(until)))) return undefined;
  const out: P2pLimitDetails = { until };
  for (const key of P2P_LIMIT_DECIMALS) {
    const value = row[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !ALGO_DECIMAL.test(value)) return undefined;
    out[key] = value;
  }
  if (row.currency !== undefined) {
    if (typeof row.currency !== 'string' || !/^[A-Z]{3}$/.test(row.currency)) return undefined;
    out.currency = row.currency;
  }
  if (row.reason !== undefined) {
    if (cause.code !== 'p2p.method_delisted' || typeof row.reason !== 'string' || !DELIST_REASONS.has(row.reason)) return undefined;
    out.reason = row.reason as P2pDelistReason;
  }
  if (row.ruleClass !== undefined) {
    if (cause.code !== 'p2p.content_rule_violation' || typeof row.ruleClass !== 'string' || !P2P_RULE_CLASS.test(row.ruleClass)) {
      return undefined;
    }
    out.ruleClass = row.ruleClass;
  }
  if (row.field !== undefined) {
    if (!(P2P_FIELD_CODES as readonly string[]).includes(cause.code) || typeof row.field !== 'string' || !P2P_FIELD_KEY.test(row.field)) {
      return undefined;
    }
    out.field = row.field;
  }
  if (row.openTradeIds !== undefined) {
    const ids = row.openTradeIds;
    if (!Array.isArray(ids) || ids.length > 50) return undefined;
    if (!ids.every((id): id is string => typeof id === 'string' && P2P_LIMIT_UUID.test(id))) return undefined;
    out.openTradeIds = [...ids];
  }
  return out;
}

const t = initTRPC.context<Context>().create({
  errorFormatter({ shape, error, ctx }) {
    const cause = error.cause;
    const code = causeCode(cause);
    const requestId = ctx && typeof ctx.requestId === 'string' && ctx.requestId.length > 0 ? ctx.requestId : undefined;
    const blockers = errorBlockersOf(cause);
    const delegationBlocker = delegationBlockerOf(cause);
    const algo = algoRefusalDetails(cause);
    const allowance = withdrawalAllowanceOf(cause);
    const preview = previewRefusalOf(cause);
    const spend = spendFiguresOf(cause);
    const accountState = accountStateOf(cause);
    const deviceAuthorisation = deviceAuthorisationOf(cause);
    const secondStep = secondStepOf(cause);
    const p2pLimit = p2pLimitOf(cause);
    return {
      ...shape,
      data: {
        ...shape.data,
        ...(requestId ? { requestId } : {}),
        // Surface our own error codes so clients can branch on
        // 'ledger.insufficient_funds' rather than parsing prose.
        intafacedCode: cause instanceof AuthError || cause instanceof JurisdictionError ? cause.code : undefined,
        // Only ever set on 'denied.kyc_required'. A client that reads this can
        // name the step the user has to take; one that ignores it is no worse
        // off than before.
        requiredTier: cause instanceof JurisdictionError ? cause.requiredTier : undefined,
        // tRPC strips `cause` in production. Copy the named code so a public
        // door can assert `token.buyback_tokens_unmoved` instead of prose.
        // `blocker` is only `no_chain_service` on `token.delegation_unavailable`.
        ...(code ? { cause: delegationBlocker ? { code, blocker: delegationBlocker } : { code } } : {}),
        // Only on a stale profile.compare-and-set, so the client can show the row
        // that won. No other error grows a profile field.
        ...(conflictProfile(cause) ? { profile: conflictProfile(cause) } : {}),
        // Only on `auth.too_many_attempts`, `auth.email_confirm_rate_limited`, `kyc.attempts_exhausted` and
        // `identity.self_freeze_lift_too_soon`.
        ...(retryAfterSecondsOf(cause) !== undefined ? { retryAfterSeconds: retryAfterSecondsOf(cause) } : {}),
        // Only on sign-in's `auth.account_frozen`: `frozen` or `closed`.
        ...(accountState ? { accountState } : {}),
        // Only on `auth.device_authorisation_required`: the waiting new-device sign-in.
        ...(deviceAuthorisation ? { deviceAuthorisation } : {}),
        // Only on sign-in's `auth.mfa_required`: which second steps answer it, with a passkey challenge when one does.
        ...(secondStep ? { secondStep } : {}),
        ...(blockers ? { blockers } : {}),
        ...(algo ? { algo } : {}),
        // Only on `pay.guard_withdrawal_limit_exceeded`.
        ...(allowance ? { allowance } : {}),
        // Only on `preview.engine_not_built`: kind, code, engine, action, label.
        ...(preview ? { preview } : {}),
        // Only on `bank.insufficient_funds`.
        ...(spend ? { spend } : {}),
        // Only on the P2P take limits: active order cap, pair limit, verification-level limits.
        ...(p2pLimit ? { p2pLimit } : {}),
      },
    };
  },
});

export const router = t.router;
export const middleware = t.middleware;
export const mergeRouters = t.mergeRouters;

/** Open to anyone. Use sparingly — most things need a principal. */
export const publicProcedure = t.procedure;

const authed = middleware(({ ctx, next }) => {
  if (!ctx.principal) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
  }
  return next({ ctx: { ...ctx, principal: ctx.principal } });
});

/** Requires a verified principal. */
export const protectedProcedure = t.procedure.use(authed);

export interface GuardOptions {
  /** Minimum verification tier. */
  tier?: KycTier;
  /** Gate on the JURISDICTION_MATRIX for this module (§9). */
  module?: ModuleId;
  /** Which plane the call runs on. Drives the §22 sovereignty branch. */
  plane?: Plane;
  /**
   * The signed-in person is the caller. A service may forward that person's
   * principal on the same request; scope checks do not notice. Set this so the
   * service is refused here, instead of a service file comparing the caller name.
   */
  person?: boolean;
}

/**
 * The one authorisation guard. Scope, tier, and jurisdiction are checked in a
 * single middleware so a procedure declares everything it requires in one
 * place — and so nothing can accidentally skip the matrix.
 *
 * Throws FORBIDDEN, or UNAUTHORIZED when the real problem is a missing second
 * factor: the client needs to tell "you may not" apart from "prove it again".
 */
function isOwnerGrantWithdrawn(err: unknown): err is TRPCError {
  return err instanceof TRPCError && err.message === 'pay.owner_grant_withdrawn';
}

async function assertLiveOwnerPayScope(ctx: Context & { principal: Principal }, scope: Scope): Promise<void> {
  if (scope !== 'pay:read' && scope !== 'pay:write' && scope !== 'pay:onboard') return;
  if (!ctx.ownerPayGrant) return;
  await ctx.ownerPayGrant.assertStillGranted(ctx.principal, scope);
}

function refuseGuard(err: unknown): never {
  if (err instanceof AuthError && err.code === 'mfa.required') {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: err.message, cause: err });
  }
  throw new TRPCError({ code: 'FORBIDDEN', message: (err as Error).message, cause: err });
}

function refuseActingService(ctx: Context, guards: GuardOptions): void {
  if (guards.person && ctx.service) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'A signed-in user session is required' });
  }
}

function refuseJurisdiction(ctx: Context & { principal: Principal }, guards: GuardOptions): void {
  if (!guards.module) return;
  const decision = checkAccess({
    module: guards.module,
    plane: guards.plane ?? 'fiat',
    region: ctx.region,
    kycTier: ctx.principal.tier,
  });
  if (!decision.allowed) {
    const cause = new JurisdictionError(decision);
    throw new TRPCError({ code: 'FORBIDDEN', message: decision.reason, cause });
  }
}

export function scopedProcedure(scope: Scope, guards: GuardOptions = {}) {
  return protectedProcedure.use(async ({ ctx, next }) => {
    refuseActingService(ctx, guards);
    try {
      requireScope(ctx.principal, scope);
      if (guards.tier) requireTier(ctx.principal, guards.tier);
    } catch (err) {
      refuseGuard(err);
    }

    await assertLiveOwnerPayScope(ctx, scope);
    refuseJurisdiction(ctx, guards);

    return next({ ctx });
  });
}

/**
 * Accepts the first scope the caller still holds. `pay:read` and `pay:write`
 * are rechecked against the live owner grant when the context installs one;
 * a withdrawn grant tries the next scope instead of failing the call.
 * List `pay:onboard` before `pay:read` so a stale read does not hide a live
 * onboarding session.
 */
export function anyScopeProcedure(scopes: readonly [Scope, ...Scope[]], guards: GuardOptions = {}) {
  return protectedProcedure.use(async ({ ctx, next }) => {
    refuseActingService(ctx, guards);
    let accepted = false;
    let sawMfa = false;
    let withdrawn: TRPCError | null = null;
    for (const scope of scopes) {
      if (!hasScope(ctx.principal.scopes, scope)) continue;
      try {
        requireScope(ctx.principal, scope);
      } catch (err) {
        if (err instanceof AuthError && err.code === 'mfa.required') {
          sawMfa = true;
          continue;
        }
        continue;
      }
      try {
        await assertLiveOwnerPayScope(ctx, scope);
      } catch (err) {
        if (isOwnerGrantWithdrawn(err)) {
          withdrawn = err;
          continue;
        }
        throw err;
      }
      accepted = true;
      if (guards.tier) {
        try {
          requireTier(ctx.principal, guards.tier);
        } catch (err) {
          refuseGuard(err);
        }
      }
      break;
    }
    if (!accepted) {
      if (withdrawn) throw withdrawn;
      if (sawMfa) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'A second factor is required' });
      }
      throw new TRPCError({ code: 'FORBIDDEN', message: `One of ${scopes.join(', ')} is required` });
    }
    refuseJurisdiction(ctx, guards);
    return next({ ctx });
  });
}

/**
 * A procedure only another INTAFACED service may call (§2).
 *
 * Carries no principal and checks no scope, because a service call is not made
 * on behalf of a user — `ledger.post` moves value because svc-trade decided a
 * fill was legal, not because a token said so. That is exactly why there is no
 * `ledger:write` scope for anyone to hold.
 *
 * What it replaces is `publicProcedure`, which checked nothing at all and left
 * every mounted money endpoint open to whoever could reach the port.
 */
export const serviceProcedure = t.procedure.use(({ ctx, next }) => {
  requireServiceCaller(ctx.service);
  return next({ ctx });
});

/**
 * A procedure only the listed services may call. No caller is UNAUTHORIZED; a
 * caller that is not listed is FORBIDDEN. When the caller was verified by its own
 * key (`serviceAuth: 'keypair'`) the name is proven; under the shared secret it is
 * a claim, which is why the list is still enforced either way.
 */
export function serviceProcedureFor(callers: readonly string[]) {
  return t.procedure.use(({ ctx, next }) => {
    requireServiceCaller(ctx.service);
    if (!callers.includes(ctx.service)) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'This service is not allowed to call this procedure',
        cause: Object.assign(new Error('s2s.caller_forbidden'), { code: 's2s.caller_forbidden' }),
      });
    }
    return next({ ctx });
  });
}

/**
 * Jurisdiction gate for procedures with no principal — public checkout pages,
 * hosted Lane A surfaces, marketing endpoints. Authenticated procedures use
 * `scopedProcedure(scope, { module })` instead.
 */
export function publicJurisdictionProcedure(module: ModuleId, plane: Plane = 'fiat') {
  return t.procedure.use(({ ctx, next }) => {
    const decision = checkAccess({ module, plane, region: ctx.region, kycTier: ctx.principal?.tier ?? 'none' });
    if (!decision.allowed) {
      throw new TRPCError({ code: 'FORBIDDEN', message: decision.reason, cause: new JurisdictionError(decision) });
    }
    return next({ ctx });
  });
}

export { TRPCError };
