import type { AuthorityRefusalCode } from './live-authority.js';
import { AUTH_ERRORS_DOCS } from './reply-envelope.js';
import { userCopy } from './user-copy.js';

/**
 * A platform API key (`ifc_…`) the edge could not open (DV-errors-02).
 *
 * A refused interactive JWT still goes upstream as anonymous: that is what lets
 * an expired session reach `auth.refresh` (README, "A bad token lands as
 * anonymous"). A key has no refresh path. Forwarding a refused key as anonymous
 * only meant the service answered "authentication required", the same words
 * as sending no key at all, so a bot with a dead key could not tell it from a
 * missing header. The edge now refuses a presented key it cannot open, here,
 * and forwards nothing. That is stricter than before, never looser: no request
 * that was refused upstream is let through, and one less reaches a service.
 *
 * The codes say only what the key holder needs and no more:
 *
 *   · `edge.api_key_denied`: no live key matches, OR the key matched and a
 *     restriction on it refused this call (origin, IP, product, account,
 *     signature). Identity deliberately answers those in one shape "so a
 *     caller never learns which half of the credential was right"
 *     (svc-identity `router.ts`, `auth.ip_allowlist_required`); the edge keeps
 *     that posture and does not split them. Splitting them is DV-auth-01's
 *     decision, in its own PR.
 *   · `edge.api_key_revoked` / `edge.api_key_expired`: only when identity says
 *     so for this exact key. Saying it to the person holding the key reveals
 *     nothing they could use: the key is dead either way. TODAY identity's
 *     exchange doors do not say so: they look a key up only among live,
 *     unexpired rows and answer `auth.invalid_credentials` for a revoked or
 *     expired one (svc-identity `auth-service.ts` `verifyApiKey`), so the
 *     exchange gives `edge.api_key_denied`. The mapping is in place for the
 *     day identity names them (pending svc-identity change). What fires now:
 *     `edge.api_key_expired` from the edge's own expiry check on an opened key,
 *     and `edge.api_key_revoked` when the current-authority read, after an
 *     exchange, names the credential revoked.
 *   · `account_frozen`: identity says the account behind the key is frozen
 *     (the exchange's `auth.account_frozen`, the opened key's status, or the
 *     current-authority read's denial). A freeze also revokes the account's
 *     keys, and identity's exchange checks the key before the account, so a
 *     frozen account's key reads `edge.api_key_denied` until that order changes
 *     in svc-identity.
 *     Not `edge.`-prefixed on purpose: the freeze is svc-identity's state, not
 *     a gateway policy, and the catalogue names it the same wherever it comes
 *     from. The edge only reports which state applies; it never invents one.
 *
 * The identity code each one came from stays in `intafacedCode`, so nothing
 * that branched on `auth.*` loses it.
 */

export type ApiKeyRefusalCode = 'edge.api_key_denied' | 'edge.api_key_revoked' | 'edge.api_key_expired' | 'account_frozen';

export interface ApiKeyRefusal {
  readonly status: 401 | 403;
  readonly code: ApiKeyRefusalCode;
  /** The `auth.*` code the decision came from. */
  readonly intafacedCode: string;
}

export const API_KEY_DENIED: ApiKeyRefusal = { status: 401, code: 'edge.api_key_denied', intafacedCode: 'auth.api_key_denied' };
export const API_KEY_REVOKED: ApiKeyRefusal = { status: 401, code: 'edge.api_key_revoked', intafacedCode: 'auth.api_key_revoked' };
export const API_KEY_EXPIRED: ApiKeyRefusal = { status: 401, code: 'edge.api_key_expired', intafacedCode: 'auth.api_key_expired' };
export const ACCOUNT_FROZEN: ApiKeyRefusal = { status: 403, code: 'account_frozen', intafacedCode: 'auth.account_frozen' };

/**
 * The codes that are identity's verdict on the presented key: the key itself, the account behind it, or a
 * restriction on the key (origin, IP, product, account binding, the merchant's request signature). Only these
 * make a refused exchange a key refusal. Anything else identity refuses with (a 404 for a path, a 400 for a body
 * the edge built, no code at all) is the edge's own setup failing, and is answered 503, not "your key is bad".
 *
 * `auth.request_*` are here on purpose: identity raises them when it checks the caller's own request signature
 * (`x-intafaced-request-*`, DV-auth-01), so they are a verdict on what the key holder sent, and retrying a
 * tampered request cannot help. A failed service authentication of the edge itself does not reach these codes:
 * identity answers it `auth.invalid_credentials` (`assertEdgeSignedRequest`), which no edge can tell apart.
 */
const IDENTITY_KEY_VERDICTS: ReadonlySet<string> = new Set([
  'auth.invalid_credentials',
  'auth.api_key_denied',
  'auth.api_key_revoked',
  'auth.api_key_expired',
  'auth.account_frozen',
  'auth.not_found',
  'auth.domain_not_allowed',
  'auth.ip_not_allowed',
  'auth.ip_allowlist_required',
  'auth.product_outside',
  'auth.account_required',
  'auth.account_mismatch',
  'auth.account_denied',
  'auth.account_revoked',
  'auth.sub_account_denied',
  'auth.request_unsigned',
  'auth.request_stale',
  'auth.request_tampered',
  'auth.request_replay',
]);

export function isIdentityKeyVerdict(code: string): boolean {
  return IDENTITY_KEY_VERDICTS.has(code);
}

/**
 * Identity's own code for a refused exchange → the refusal. Only these three are told apart; every
 * other code, and anything unrecognised, is the one denied answer. Never echoes an upstream string.
 */
export function apiKeyRefusalFromIdentityCode(code: string | undefined): ApiKeyRefusal {
  switch (code) {
    case 'auth.api_key_revoked':
      return API_KEY_REVOKED;
    case 'auth.api_key_expired':
      return API_KEY_EXPIRED;
    case 'auth.account_frozen':
      return ACCOUNT_FROZEN;
    default:
      return API_KEY_DENIED;
  }
}

/**
 * The current-authority read's refusal → the refusal, for a key identity had already opened. A frozen or closed
 * account is `account_frozen`; a revoked credential is `edge.api_key_revoked`; an expired one
 * `edge.api_key_expired`; anything else (or no code: a refusal of the edge's own) is the one denied answer.
 */
export function apiKeyRefusalFromAuthorityCode(code: AuthorityRefusalCode | undefined): ApiKeyRefusal {
  switch (code) {
    case 'auth.account_frozen':
      return ACCOUNT_FROZEN;
    case 'auth.credential_revoked':
    case 'auth.api_key_revoked':
      return API_KEY_REVOKED;
    case 'auth.credential_expired':
      return API_KEY_EXPIRED;
    default:
      return API_KEY_DENIED;
  }
}

/** The identity code inside a refused tRPC answer, plain or `{ json }`-wrapped. Undefined when there is none. */
export function identityErrorCode(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return undefined;
  const shape = ((error as { json?: unknown }).json ?? error) as { data?: unknown };
  const data = shape.data;
  if (!data || typeof data !== 'object') return undefined;
  const direct = (data as { intafacedCode?: unknown }).intafacedCode;
  if (typeof direct === 'string') return direct;
  const cause = (data as { cause?: unknown }).cause;
  const nested = cause && typeof cause === 'object' ? (cause as { code?: unknown }).code : undefined;
  return typeof nested === 'string' ? nested : undefined;
}

/** The body for a refused key. `requestId` is added on the way out (`reply-envelope.ts`). */
export function apiKeyRefusalBody(refusal: ApiKeyRefusal): Record<string, unknown> {
  const copy = userCopy(refusal.code);
  return {
    code: refusal.code,
    message: copy,
    error: copy,
    intafacedCode: refusal.intafacedCode,
    docs: `${AUTH_ERRORS_DOCS}#${refusal.code}`,
  };
}

/**
 * The exchange input identity's schema accepts, mirrored exactly (svc-identity `router.ts` `apiKeys.exchange`
 * and the account/product doors: `key` 8 to 200 characters; `requestSignWireSchema` in
 * `auth/api-key-request-sign.ts`). Identity answers anything else with a 400 that carries no code, which the edge
 * must read as its own setup failing (503), so a caller could have forced a 503 "identity unavailable" at will
 * with `Bearer ifc_x`. Checked here instead, before identity is called: a bad shape is a key that cannot open,
 * `edge.api_key_denied`, and identity is never asked.
 *
 * The key charset is what identity mints (`ifc_` or `ifc_test_` + base64url, `passwords.ts` `generateApiKey`);
 * a key outside it matches no stored hash, so refusing it here answers exactly what identity would.
 */
const API_KEY_SHAPE = /^ifc_[A-Za-z0-9_-]+$/;
const HEX_64 = /^[0-9a-f]{64}$/i;

export function apiKeyShapeOk(key: string): boolean {
  return key.length >= 8 && key.length <= 200 && API_KEY_SHAPE.test(key);
}

/** zod's `guid()` pattern, as identity's `exchangeApiKeyForAccount` checks `accountId` with it. */
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * The account id and product a caller presents, as identity's account and product doors accept them
 * (`accountId: z.string().guid()`, `product: z.string().min(1).max(64)`). Absent is fine: no door is asked for it.
 */
export function presentedScopeShapeOk(accountId: string | undefined, product: string | undefined): boolean {
  if (accountId !== undefined && !GUID.test(accountId)) return false;
  if (product !== undefined && (product.length < 1 || product.length > 64)) return false;
  return true;
}

/** `requestSignWireSchema`, field for field. Checked only when the edge will send the signed request. */
export function requestSignShapeOk(material: {
  readonly method: string;
  readonly path: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly bodyHash: string;
  readonly signature: string;
}): boolean {
  return (
    material.method.length >= 1 &&
    material.method.length <= 16 &&
    material.path.length >= 1 &&
    material.path.length <= 2048 &&
    material.timestamp.length >= 1 &&
    material.timestamp.length <= 32 &&
    material.nonce.length >= 8 &&
    material.nonce.length <= 128 &&
    HEX_64.test(material.bodyHash) &&
    HEX_64.test(material.signature)
  );
}
