/**
 * Live session / API-key check for `/private/stream`.
 *
 * JWT `exp` is not enough: a revoked credential still verifies until expiry.
 * Ownership snapshots are `{ id, userId, revoked }` only — no scopes, no flatten.
 * An API-key snapshot may also carry `ipAllowlist`, `originAllowlist`, `productAllowlist`, `expiresAt`, and `accountId` when identity sends them.
 * User freeze is identity `users.status` via `/internal/account/:id` — not a second store.
 * Transport / parse failure is `unavailable` (fail-closed). Never treat a
 * non-OK identity response (including 401) as live.
 */

import { accountStateSchema, apiKeyOwnershipSchema, sessionOwnershipSchema } from '@intafaced/contracts';
import { apiKeyIpAllowed } from './caller-ip.js';
import { apiKeyOriginAllowed } from './key-origin.js';
import { apiKeyProductAllowed, STREAM_PRODUCT } from './key-product.js';
import { assertKeyNotExpired, optionalExpiresAt, KeyExpiresError } from './key-expires.js';
import { assertApiKeyAccount, optionalAccountIdFromBody, KeyAccountError } from './key-account.js';
import { assertUserActive, UserStatusError, type UserStatus } from './user-status.js';
import {
  assertSessionPasskey,
  SessionPasskeyError,
  optionalLastVerifiedAt,
  optionalPasskeyCreds,
  optionalPasskeyVerified,
} from './session-passkey.js';

export { optionalExpiresAt } from './key-expires.js';
export { optionalAccountIdFromBody } from './key-account.js';
export { optionalUserStatusFromBody } from './user-status.js';

export type OwnershipSnapshot = {
  readonly id: string;
  readonly userId: string;
  readonly revoked: boolean;
  /** API-key only. Empty / omitted = open. Never invent CIDR. */
  readonly ipAllowlist?: readonly string[];
  /** API-key only. Empty / omitted = open. Never invent localhost. */
  readonly originAllowlist?: readonly string[];
  /** API-key only. Empty / omitted = open. Never invent `trade`. */
  readonly productAllowlist?: readonly string[];
  /** API-key only. Omitted = open. Never invent an expiry. */
  readonly expiresAt?: Date;
  /** API-key only. Omitted = unbound. Never invent a bind. */
  readonly accountId?: string;
};

export type AccountStatusSnapshot = {
  readonly userId: string;
  readonly status: UserStatus;
  /** Identity extras. Omitted means identity did not send them. Never invent. */
  readonly lastVerifiedAt?: string;
  readonly webauthnCreds?: unknown[];
  readonly passkeyVerified?: boolean;
};

export type LiveCredentialErrorCode =
  | 'unavailable'
  | 'auth.api_key_denied'
  | 'auth.api_key_revoked'
  | 'auth.ip_not_allowed'
  | 'auth.domain_not_allowed'
  | 'auth.product_not_allowed'
  | 'auth.api_key_expired'
  | 'auth.clock_missing'
  | 'auth.account_required'
  | 'auth.account_mismatch'
  | 'auth.account_frozen'
  | 'auth.session_denied'
  | 'auth.session_revoked'
  | 'auth.passkey_missing'
  | 'auth.passkey_verify_unavailable';

export class LiveCredentialError extends Error {
  constructor(
    message: string,
    readonly code: LiveCredentialErrorCode,
  ) {
    super(message);
    this.name = 'LiveCredentialError';
  }
}

export interface LiveCredentialPort {
  getSession(sessionId: string): Promise<OwnershipSnapshot | null>;
  getApiKey(keyId: string): Promise<OwnershipSnapshot | null>;
  /**
   * Identity `users.status` (`GET /internal/account/:userId`).
   * Production always wires this. Tests that omit it skip the freeze gate.
   */
  getAccount?(userId: string): Promise<AccountStatusSnapshot | null>;
}

export type LiveCredentialInput = {
  readonly userId: string;
  readonly sessionId: string;
  readonly apiKeyId?: string;
  /** Upgrade / live-check caller. Session seats ignore it. */
  readonly callerIp?: string | null;
  /** Upgrade Origin. Session seats ignore it. */
  readonly requestOrigin?: string | null;
  /** Comparison clock. Missing when the key has expiresAt refuses. */
  readonly now?: Date | string | number | null;
  /** Presented account (`x-account-id`). Session seats ignore it. */
  readonly accountId?: string | null;
};

function unavailable(cause?: unknown): LiveCredentialError {
  const err = new LiveCredentialError('Live credential source unavailable', 'unavailable');
  if (cause !== undefined) {
    (err as Error & { cause?: unknown }).cause = cause;
  }
  return err;
}

async function load<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof LiveCredentialError) throw err;
    throw unavailable(err);
  }
}

function denyKey(): never {
  throw new LiveCredentialError('API key not found', 'auth.api_key_denied');
}

function denySession(): never {
  throw new LiveCredentialError('Session not found', 'auth.session_denied');
}

/**
 * Kid present → API key. Otherwise session (`sid` is always on the token).
 * Missing / empty / unknown / user mismatch → denied. `revoked: true` → revoked.
 * Bound key + caller IP not on the list → `auth.ip_not_allowed`.
 * Bound key + Origin not on the list → `auth.domain_not_allowed`.
 * Bound key + product list without `trade` → `auth.product_not_allowed`.
 * Past expiresAt → `auth.api_key_expired`. Missing clock → `auth.clock_missing`.
 * Bound key + missing/wrong presented account → `auth.account_required` / `auth.account_mismatch`.
 * Frozen/closed/missing identity status → `auth.account_frozen`. Never invent `active`.
 * Session without enrolled+verified passkey extras → `auth.passkey_missing` / `auth.passkey_verify_unavailable`.
 * Port `unavailable` propagates (fail-closed).
 */
export async function assertLiveCredential(port: LiveCredentialPort, input: LiveCredentialInput): Promise<OwnershipSnapshot> {
  let snapshot: OwnershipSnapshot;
  if (input.apiKeyId !== undefined) {
    const id = typeof input.apiKeyId === 'string' ? input.apiKeyId.trim() : '';
    if (!id) denyKey();
    const row = await load(() => port.getApiKey(id));
    if (!row || row.id !== id || row.userId !== input.userId) denyKey();
    if (row.revoked) {
      throw new LiveCredentialError('API key is revoked', 'auth.api_key_revoked');
    }
    if (!apiKeyIpAllowed(row.ipAllowlist ?? [], input.callerIp)) {
      throw new LiveCredentialError('Caller IP is not on the API key', 'auth.ip_not_allowed');
    }
    if (!apiKeyOriginAllowed(row.originAllowlist ?? [], input.requestOrigin)) {
      throw new LiveCredentialError('API key is not allowed from this origin', 'auth.domain_not_allowed');
    }
    if (!apiKeyProductAllowed(row.productAllowlist ?? [], STREAM_PRODUCT)) {
      throw new LiveCredentialError('API key is not allowed for this product', 'auth.product_not_allowed');
    }
    try {
      assertKeyNotExpired(row.expiresAt, input.now === undefined ? new Date() : input.now);
    } catch (err) {
      if (err instanceof KeyExpiresError) {
        throw new LiveCredentialError(err.message, err.code);
      }
      throw err;
    }
    try {
      assertApiKeyAccount(row.accountId, input.accountId);
    } catch (err) {
      if (err instanceof KeyAccountError) {
        throw new LiveCredentialError(err.message, err.code);
      }
      throw err;
    }
    snapshot = { id: row.id, userId: row.userId, revoked: false };
  } else {
    const id = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
    if (!id) denySession();
    const row = await load(() => port.getSession(id));
    if (!row || row.id !== id || row.userId !== input.userId) denySession();
    if (row.revoked) {
      throw new LiveCredentialError('Session is revoked', 'auth.session_revoked');
    }
    snapshot = { id: row.id, userId: row.userId, revoked: false };
  }

  if (typeof port.getAccount === 'function') {
    const state = await load(() => port.getAccount!(input.userId));
    if (!state || state.userId !== input.userId) {
      throw new LiveCredentialError('Account is frozen', 'auth.account_frozen');
    }
    try {
      assertUserActive(state.status);
    } catch (err) {
      if (err instanceof UserStatusError) {
        throw new LiveCredentialError(err.message, err.code);
      }
      throw err;
    }
    if (input.apiKeyId === undefined) {
      try {
        assertSessionPasskey(state);
      } catch (err) {
        if (err instanceof SessionPasskeyError) {
          throw new LiveCredentialError(err.message, err.code);
        }
        throw err;
      }
    }
  }

  return snapshot;
}

export interface IdentityOwnershipClientOptions {
  readonly baseUrl: string;
  readonly headers: HeadersInit;
  readonly fetch?: typeof globalThis.fetch;
}

/** Read an optional string[] off the raw body. Schema-unknown — not invented. */
export function optionalIpAllowlist(body: unknown): readonly string[] | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const rec = body as Record<string, unknown>;
  const raw = rec.ipAllowlist ?? rec.ip_allowlist;
  if (!Array.isArray(raw)) return undefined;
  if (!raw.every((entry) => typeof entry === 'string')) return undefined;
  return raw;
}

/** Origin list on the key body. Omitted = open. Never invent localhost. */
export function optionalOriginAllowlist(body: unknown): readonly string[] | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const rec = body as Record<string, unknown>;
  const raw = rec.originAllowlist ?? rec.origin_allowlist ?? rec.domain_whitelist ?? rec.domainWhitelist;
  if (!Array.isArray(raw)) return undefined;
  if (!raw.every((entry) => typeof entry === 'string')) return undefined;
  return raw;
}

/** Product/module list on the key body. Omitted = open. Never invent `trade`. */
export function optionalProductAllowlist(body: unknown): readonly string[] | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const rec = body as Record<string, unknown>;
  const raw = rec.productAllowlist ?? rec.product_allowlist ?? rec.productScopes ?? rec.product_scopes;
  if (!Array.isArray(raw)) return undefined;
  if (!raw.every((entry) => typeof entry === 'string')) return undefined;
  return raw;
}

/**
 * GET `/internal/sessions/:id`, `/internal/api-keys/:id`, and `/internal/account/:id`.
 * 404 → null. Non-OK (including 401) / transport / parse → `unavailable`.
 * Body is parsed with the published ownership / account-state schemas — no invented fields.
 * A string[] `ipAllowlist` / `ip_allowlist` on the key body is kept locally.
 * A string[] `originAllowlist` / `origin_allowlist` / `domain_whitelist` on the key body is kept locally.
 * A string[] `productAllowlist` / `product_allowlist` / `productScopes` / `product_scopes` on the key body is kept locally.
 * An `expiresAt` / `expires_at` on the key body is kept locally.
 * An `accountId` / `account_id` on the key body is kept locally.
 * Account `status` is identity `users.status` — never a second freeze store.
 * Passkey extras (`lastVerifiedAt` / `webauthnCreds` / `passkeyVerified`) on the account body are kept locally.
 */
export function createIdentityOwnershipClient(options: IdentityOwnershipClientOptions): LiveCredentialPort {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function get<T>(path: string, parse: (body: unknown) => T): Promise<T | null> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, { headers: options.headers });
    } catch (err) {
      throw unavailable(err);
    }
    if (response.status === 404) return null;
    if (!response.ok) throw unavailable();
    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      throw unavailable(err);
    }
    try {
      return parse(body);
    } catch (err) {
      throw unavailable(err);
    }
  }

  return {
    getSession(sessionId) {
      return get(`/internal/sessions/${encodeURIComponent(sessionId)}`, (body) => {
        const parsed = sessionOwnershipSchema.parse(body);
        return { id: parsed.id, userId: parsed.userId, revoked: parsed.revoked };
      });
    },
    getApiKey(keyId) {
      return get(`/internal/api-keys/${encodeURIComponent(keyId)}`, (body) => {
        const parsed = apiKeyOwnershipSchema.parse(body);
        const ipAllowlist = optionalIpAllowlist(body);
        const originAllowlist = optionalOriginAllowlist(body);
        const productAllowlist = optionalProductAllowlist(body);
        const expiresAt = optionalExpiresAt(body);
        const accountId = optionalAccountIdFromBody(body);
        return {
          id: parsed.id,
          userId: parsed.userId,
          revoked: parsed.revoked,
          ...(ipAllowlist === undefined ? {} : { ipAllowlist }),
          ...(originAllowlist === undefined ? {} : { originAllowlist }),
          ...(productAllowlist === undefined ? {} : { productAllowlist }),
          ...(expiresAt === undefined ? {} : { expiresAt }),
          ...(accountId === undefined ? {} : { accountId }),
        };
      });
    },
    getAccount(userId) {
      return get(`/internal/account/${encodeURIComponent(userId)}`, (body) => {
        const parsed = accountStateSchema.parse(body);
        if (parsed.userId !== userId) {
          throw new Error('account userId mismatch');
        }
        const lastVerifiedAt = optionalLastVerifiedAt(body);
        const webauthnCreds = optionalPasskeyCreds(body);
        const passkeyVerified = optionalPasskeyVerified(body);
        return {
          userId: parsed.userId,
          status: parsed.status,
          ...(lastVerifiedAt === undefined ? {} : { lastVerifiedAt }),
          ...(webauthnCreds === undefined ? {} : { webauthnCreds }),
          ...(passkeyVerified === undefined ? {} : { passkeyVerified }),
        };
      });
    },
  };
}
