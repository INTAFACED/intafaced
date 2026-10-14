import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import type { AccountState } from '@intafaced/contracts';
import { assertDelegatableScopes, issueAccessToken, SESSION_SCOPES, type Scope, type TokenConfig } from '@intafaced/auth';
import type { EventBus } from '@intafaced/events';
import {
  assertPasswordShape,
  dummyPasswordHash,
  generateApiKey,
  generateToken,
  hashPassword,
  hashToken,
  needsRehash,
  verifyPassword,
  WeakPasswordError,
} from './passwords.js';
import { accountHasSecondFactor, assertMayAddFactor, assertMayRemoveFactor, checkMayAddFactor, type FactorActor } from './factor-gate.js';
import { generateRecoveryCodes, generateSecret, matchTotpStep, totpUri } from './totp.js';
import { encryptTotpSecret, materializeTotpSecret, parseTotpSecretKey } from './totp-crypto.js';
import { apiKeyOriginAllowed } from './api-key-origin.js';
import { recordSuccess, reserveAttempt, type AttemptKind } from './attempt-lockout.js';
import { matchInvite, type FounderEnrolmentConfig } from './founder-enrolment.js';
import { SqlPendingTotpEnrolmentStore, type PendingTotpEnrolmentStore } from './pending-totp-store.js';
import {
  b64urlDecode,
  b64urlEncode,
  SqlChallengeStore,
  createAuthenticationOptions,
  createRegistrationOptions,
  generateChallenge,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  WebAuthnError,
} from './webauthn.js';
import type {
  AuthenticationOptionsJSON,
  AuthenticationResponseJSON,
  ChallengeStorePort,
  RegistrationOptionsJSON,
  RegistrationResponseJSON,
  StoredWebAuthnCredential,
  WebAuthnConfig,
} from './webauthn.js';
import {
  syncNavigatorSessionClosed,
  syncNavigatorSessionOpen,
  syncNavigatorSessionsClosedForUser,
} from '../agents/navigator-session-projection-sync.js';
import type { RankService } from '../rank/rank-service.js';

/**
 * AUTH (§4.1, §9).
 *
 * Sovereignty means owning this. No third-party auth dependency, which also
 * means no third party to blame — every decision here is ours to get right.
 *
 * Schema: SQL is search_path-relative (not hard-coded `identity.*`). Production
 * connects with `search_path = identity,public` (see `src/index.ts`). Tests use
 * `createTestDb`, which allocates a unique schema per suite so parallel
 * worktrees cannot TRUNCATE each other into a poisoned KYC queue.
 */

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'auth.invalid_credentials'
      | 'auth.account_frozen'
      | 'auth.handle_taken'
      | 'auth.email_taken'
      | 'auth.mfa_required'
      | 'auth.privileged_enrolment_requires_invite'
      | 'auth.mfa_invalid'
      | 'auth.mfa_already_enrolled'
      | 'auth.session_invalid'
      | 'auth.session_reused'
      | 'auth.not_found'
      | 'auth.kyc_not_pending'
      | 'auth.kyc_agent_refused'
      | 'auth.mfa_not_enrolled'
      | 'auth.webauthn_invalid'
      | 'auth.webauthn_not_enrolled'
      | 'auth.domain_not_allowed'
      | 'auth.sub_account_required'
      | 'auth.sub_account_denied'
      | 'auth.sub_account_revoked'
      | 'auth.sub_account_same'
      | 'auth.sub_account_limit'
      | 'auth.sub_account_cap_unset'
      | 'auth.api_key_denied'
      | 'auth.api_key_revoked'
      | 'auth.session_denied'
      | 'auth.session_revoked'
      | 'auth.totp_key_missing'
      | 'auth.delegate_cannot_grant'
      | 'auth.password_unchanged'
      | 'auth.password_policy'
      | 'auth.too_many_attempts'
      | 'auth.invite_invalid'
      | 'auth.invite_used'
      | 'auth.invite_expired'
      | 'auth.founder_enrolment_closed',
    /** Optional machine-readable extras. `retryAfterSeconds`: set by `auth.too_many_attempts` only. */
    readonly details?: { readonly retryAfterSeconds?: number },
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/** Blank / non-integer / out of 1..200 KYC pending queue limit. Never invent 50. */
export const IDENTITY_KYC_PENDING_LIMIT_UNSET = 'identity.kyc_pending_limit_unset' as const;
export const KYC_PENDING_LIMIT_MAX = 200;

export class KycPendingLimitUnsetError extends Error {
  constructor(
    message: string,
    readonly code: typeof IDENTITY_KYC_PENDING_LIMIT_UNSET,
  ) {
    super(message);
    this.name = 'KycPendingLimitUnsetError';
  }
}

/** Owner-published KYC queue window. Missing / null / non-int / out of 1..max refuses. Never invent 50. */
export function publishedKycPendingLimit(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isInteger(value) || value < 1 || value > KYC_PENDING_LIMIT_MAX) {
    throw new KycPendingLimitUnsetError('KYC pending limit is unset — refuse to invent 50', IDENTITY_KYC_PENDING_LIMIT_UNSET);
  }
  return value;
}

/** Blank / non-integer / out of 1..200 API-key list window. Never invent 50. */
export const IDENTITY_API_KEYS_LIST_LIMIT_UNSET = 'identity.api_keys_list_limit_unset' as const;
export const API_KEYS_LIST_LIMIT_MAX = 200;

export class ApiKeysListLimitUnsetError extends Error {
  constructor(
    message: string,
    readonly code: typeof IDENTITY_API_KEYS_LIST_LIMIT_UNSET,
  ) {
    super(message);
    this.name = 'ApiKeysListLimitUnsetError';
  }
}

/** Owner-published API-key list window. Missing / null / non-int / out of 1..max refuses. Never invent 50. */
export function publishedApiKeysListLimit(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isInteger(value) || value < 1 || value > API_KEYS_LIST_LIMIT_MAX) {
    throw new ApiKeysListLimitUnsetError('API keys list limit is unset — refuse to invent 50', IDENTITY_API_KEYS_LIST_LIMIT_UNSET);
  }
  return value;
}

/** Blank / non-integer / out of 1..200 sub-account list window. Never invent 50. */
export const IDENTITY_SUB_ACCOUNTS_LIST_LIMIT_UNSET = 'identity.sub_accounts_list_limit_unset' as const;
export const SUB_ACCOUNTS_LIST_LIMIT_MAX = 200;

export class SubAccountsListLimitUnsetError extends Error {
  constructor(
    message: string,
    readonly code: typeof IDENTITY_SUB_ACCOUNTS_LIST_LIMIT_UNSET,
  ) {
    super(message);
    this.name = 'SubAccountsListLimitUnsetError';
  }
}

/** Owner-published sub-account list window. Missing / null / non-int / out of 1..max refuses. Never invent 50. */
export function publishedSubAccountsListLimit(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isInteger(value) || value < 1 || value > SUB_ACCOUNTS_LIST_LIMIT_MAX) {
    throw new SubAccountsListLimitUnsetError(
      'Sub-accounts list limit is unset — refuse to invent 50',
      IDENTITY_SUB_ACCOUNTS_LIST_LIMIT_UNSET,
    );
  }
  return value;
}

/** Blank / non-integer / out of 1..200 KYC status-records window. Never invent 50. */
export const IDENTITY_KYC_RECORDS_LIST_LIMIT_UNSET = 'identity.kyc_records_list_limit_unset' as const;
export const KYC_RECORDS_LIST_LIMIT_MAX = 200;

export class KycRecordsListLimitUnsetError extends Error {
  constructor(
    message: string,
    readonly code: typeof IDENTITY_KYC_RECORDS_LIST_LIMIT_UNSET,
  ) {
    super(message);
    this.name = 'KycRecordsListLimitUnsetError';
  }
}

/** Owner-published KYC status-records window. Missing / null / non-int / out of 1..max refuses. Never invent 50. */
export function publishedKycRecordsListLimit(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isInteger(value) || value < 1 || value > KYC_RECORDS_LIST_LIMIT_MAX) {
    throw new KycRecordsListLimitUnsetError('KYC records list limit is unset — refuse to invent 50', IDENTITY_KYC_RECORDS_LIST_LIMIT_UNSET);
  }
  return value;
}

/** Blank / non-integer / out of 1..200 WebAuthn credential list window. Never invent 50. */
export const IDENTITY_WEBAUTHN_LIST_LIMIT_UNSET = 'identity.webauthn_list_limit_unset' as const;
export const WEBAUTHN_LIST_LIMIT_MAX = 200;

export class WebauthnListLimitUnsetError extends Error {
  constructor(
    message: string,
    readonly code: typeof IDENTITY_WEBAUTHN_LIST_LIMIT_UNSET,
  ) {
    super(message);
    this.name = 'WebauthnListLimitUnsetError';
  }
}

/** Owner-published WebAuthn list window. Missing / null / non-int / out of 1..max refuses. Never invent 50. */
export function publishedWebauthnListLimit(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isInteger(value) || value < 1 || value > WEBAUTHN_LIST_LIMIT_MAX) {
    throw new WebauthnListLimitUnsetError('WebAuthn list limit is unset — refuse to invent 50', IDENTITY_WEBAUTHN_LIST_LIMIT_UNSET);
  }
  return value;
}

export type { WebAuthnConfig, StoredWebAuthnCredential };

export function assertOperatorKycReview(input: { service?: string | null; kid?: string | null }): void {
  if (input.service || input.kid) {
    throw new AuthError('KYC review is an operator action — an agent must never write reviewed_by', 'auth.kyc_agent_refused');
  }
}

/** An API key is a delegate. Intersection-only: it cannot mint or bind a further grant. */
export function assertDelegateCannotGrant(kid?: string | null): void {
  if (kid) {
    throw new AuthError('A delegate cannot grant further', 'auth.delegate_cannot_grant');
  }
}

export type KycTier = 'none' | 'basic' | 'full' | 'institutional';
export type SubmittableKycTier = Exclude<KycTier, 'none'>;

export interface KycRecordView {
  id: string;
  userId: string;
  tier: KycTier;
  jurisdiction: string;
  providerRef: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  reviewedBy: string | null;
  reviewedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

interface KycRow {
  id: string;
  user_id: string;
  tier: KycTier;
  jurisdiction: string;
  provider_ref: string | null;
  status: KycRecordView['status'];
  reviewed_by: string | null;
  reviewed_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
}

function toKycRecord(row: KycRow): KycRecordView {
  return {
    id: row.id,
    userId: row.user_id,
    tier: row.tier,
    jurisdiction: row.jurisdiction,
    providerRef: row.provider_ref,
    status: row.status,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

const TIER_ORDER: Readonly<Record<KycTier, number>> = { none: 0, basic: 1, full: 2, institutional: 3 };
const STEP_UP_TTL_SECONDS = 300;
const STEP_UP_SCOPES: readonly Scope[] = ['trade:withdraw'];

export interface RegisterInput {
  handle: string;
  email: string;
  password: string;
  region?: string;
  device?: string;
  ip?: string;
}

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  sessionId: string;
  userId: string;
  mfaRequired: boolean;
}

const DEFAULT_WEBAUTHN: WebAuthnConfig = {
  rpID: 'localhost',
  rpName: 'INTAFACED',
  origin: 'http://localhost:3000',
};

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

function uniqueConstraintName(err: unknown): string {
  const name = (err as { constraint_name?: unknown }).constraint_name;
  return typeof name === 'string' ? name : '';
}

export class AuthService {
  private readonly pendingTotp: PendingTotpEnrolmentStore;
  private readonly challenges: ChallengeStorePort;
  private readonly webauthn: WebAuthnConfig;
  private readonly totpSecretKey: Buffer | null;
  /** Owner-published live cap. Undefined = unpublished — create refuses, never invents 25. */
  private readonly maxSubAccounts: number | undefined;

  constructor(
    private readonly sql: Sql,
    private readonly bus: EventBus,
    private readonly rank: RankService,
    private readonly tokens: TokenConfig & { refreshTtlSeconds: number },
    webauthn: WebAuthnConfig = DEFAULT_WEBAUTHN,
    totpSecretKeyMaterial?: string,
    challenges?: ChallengeStorePort,
    pendingTotp?: PendingTotpEnrolmentStore,
    maxSubAccounts?: number,
  ) {
    this.webauthn = webauthn;
    this.totpSecretKey = parseTotpSecretKey(totpSecretKeyMaterial);
    this.challenges = challenges ?? new SqlChallengeStore(sql, webauthn.challengeTtlMs);
    this.pendingTotp = pendingTotp ?? new SqlPendingTotpEnrolmentStore(sql);
    this.maxSubAccounts =
      maxSubAccounts !== undefined && Number.isFinite(maxSubAccounts) && maxSubAccounts >= 1 ? Math.floor(maxSubAccounts) : undefined;
  }

  /** Structured warn sink. Defaults to one JSON line on stderr; index.ts swaps in the Fastify logger. */
  private log: { warn(obj: Record<string, unknown>, msg: string): void } = {
    warn: (obj, msg) => process.stderr.write(`${JSON.stringify({ level: 'warn', ...obj, msg })}\n`),
  };

  useLogger(log: { warn(obj: Record<string, unknown>, msg: string): void }): void {
    this.log = log;
  }

  /** Count a sign-in attempt (see attempt-lockout.ts); log once when this attempt is the one that sets a lock. */
  private async reserve(userId: string, kind: AttemptKind): Promise<void> {
    const { lockedForSeconds } = await reserveAttempt(this.sql, userId, kind);
    if (lockedForSeconds !== null) this.log.warn({ userId, kind, lockedForSeconds }, 'identity.account_locked');
  }

  /**
   * The user's TOTP secret in the clear, or null when the stored value cannot be
   * opened (key lost / rotated, corrupt ciphertext). Null makes the caller fall
   * through to recovery codes, so a lost key does not make the account
   * unrecoverable. The caller still answers `auth.mfa_invalid` on failure, so
   * nothing about the stored value reaches the client. One warn line, id only.
   */
  private tryOpenTotpSecret(userId: string, stored: string): string | null {
    try {
      return materializeTotpSecret(this.totpSecretKey, stored);
    } catch {
      this.log.warn({ userId }, 'identity.totp_secret_undecryptable');
      return null;
    }
  }

  /**
   * Check a TOTP or recovery code for a user whose `mfa` attempt is already
   * reserved. Throws `auth.mfa_invalid` when neither matches.
   */
  private async verifyMfaCode(userId: string, storedSecret: string, code: string): Promise<void> {
    const secret = this.tryOpenTotpSecret(userId, storedSecret);
    if (secret !== null && matchTotpStep(secret, code) !== null) {
      await this.consumeTotpCode(userId, secret, code);
      return;
    }
    if (!(await this.tryRedeemRecoveryCode(userId, code))) throw new AuthError('Invalid two-factor code', 'auth.mfa_invalid');
  }

  async register(input: RegisterInput): Promise<SessionTokens> {
    const passwordHash = await hashPassword(input.password);
    const userId = await transaction(this.sql, (tx) => this.insertNewUser(tx, input, passwordHash));
    return this.finishRegistration(userId, input);
  }

  /** The user, profile and rank rows of a new account, inside the caller's transaction. */
  private async insertNewUser(tx: Sql, input: RegisterInput, passwordHash: string): Promise<string> {
    const clash = await tx<
      Array<{ handle: string; email: string }>
    >`SELECT handle, email FROM users WHERE handle = ${input.handle} OR email = ${input.email}`;
    for (const row of clash) {
      if (row.handle.toLowerCase() === input.handle.toLowerCase()) {
        throw new AuthError('That handle is taken', 'auth.handle_taken');
      }
      throw new AuthError('An account with that email already exists', 'auth.email_taken');
    }
    const inserted = await tx<
      Array<{ id: string }>
    >`INSERT INTO users (handle, email, password_hash) VALUES (${input.handle}, ${input.email}, ${passwordHash}) RETURNING id`;
    const id = inserted[0]!.id;
    await tx`INSERT INTO profiles (user_id, display_name, region) VALUES (${id}, ${input.handle}, ${input.region ?? null})`;
    await tx`INSERT INTO rank_state (user_id) VALUES (${id})`;
    return id;
  }

  /** After the account is committed: announce it, award the first XP, open a (non-MFA) session. */
  private async finishRegistration(userId: string, input: RegisterInput): Promise<SessionTokens> {
    await this.bus.publish(
      'userCreated',
      { userId, handle: input.handle, ...(input.region ? { region: input.region } : {}) },
      { idempotencyKey: `user.created:${userId}` },
    );
    await this.rank.awardXp({
      userId,
      sourceModule: 'identity',
      action: 'identity.registered',
      xpDelta: 50,
      idempotencyKey: `identity.registered:${userId}`,
    });
    return this.issueSession(userId, { device: input.device, ip: input.ip, mfa: false });
  }

  /**
   * FOUNDER ENROLMENT (`auth.registerFounder`, src/auth/founder-enrolment.ts).
   *
   * Creates an ordinary account, exactly like `register`, but gated by a
   * single-use invite instead of REGISTRATION_OPEN. The new account is NOT
   * privileged until the founder pair is pinned to its id, so the session may
   * enrol its first factor the normal way (factor-gate.ts is untouched).
   *
   * Order matters. The cheap refusals come first, before the argon2 hash that an
   * attacker could otherwise make us pay for with a bad code:
   *   closed (not configured, or the pair is pinned) → invalid → expired → used.
   * The invite is then consumed in the SAME transaction as the user insert,
   * behind a per-invite advisory lock, with the primary key as the backstop: one
   * invite makes one account and a race has exactly one winner. The losing
   * transaction rolls back its user row.
   *
   * Logging: one audit line, `founder.enrolled {userId}`. The invite, its hash
   * and the password are never logged, and the hash is never put next to an
   * email. The durable record is the `founder_invites_used` row (hash → user,
   * time), which is immutable.
   */
  async registerFounder(
    input: RegisterInput & { invite: string },
    config: FounderEnrolmentConfig | undefined,
    now: Date = new Date(),
  ): Promise<SessionTokens> {
    const closed = () => new AuthError('Founder enrolment is closed', 'auth.founder_enrolment_closed');
    if (!config) throw closed();
    if (await this.founderPairPinned(this.sql)) throw closed();
    const hash = matchInvite(input.invite, config.hashes);
    if (hash === null) throw new AuthError('That invite code is not valid', 'auth.invite_invalid');
    if (now.getTime() >= config.expiresAt.getTime()) throw new AuthError('That invite code has expired', 'auth.invite_expired');
    const usedError = () => new AuthError('That invite code has already been used', 'auth.invite_used');
    if (await this.founderInviteSpent(this.sql, hash)) throw usedError();

    const passwordHash = await hashPassword(input.password);
    let userId: string;
    try {
      userId = await transaction(
        this.sql,
        async (tx) => {
          // Serialise every attempt on this invite, so the loser of a race gets
          // `invite_used` (not a unique-violation 500) and never half-creates a user.
          await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`founder-invite:${hash}`}, 0))`;
          // Re-read under the lock: the pair may have been pinned, the invite spent, while we hashed.
          if (await this.founderPairPinned(tx)) throw closed();
          if (await this.founderInviteSpent(tx, hash)) throw usedError();
          const id = await this.insertNewUser(tx, input, passwordHash);
          const claimed = await tx<
            Array<{ hash: string }>
          >`INSERT INTO founder_invites_used (hash, user_id) VALUES (${hash}, ${id}) ON CONFLICT (hash) DO NOTHING RETURNING hash`;
          if (claimed.length !== 1) throw usedError();
          return id;
        },
        { isolation: 'read committed' },
      );
    } catch (err) {
      // Two founders racing different invites for the same handle/email: the unique index decides.
      if (isUniqueViolation(err)) {
        if (/founder_invites_used/.test(uniqueConstraintName(err))) throw usedError();
        throw new AuthError(
          /email/i.test(uniqueConstraintName(err)) ? 'An account with that email already exists' : 'That handle is taken',
          /email/i.test(uniqueConstraintName(err)) ? 'auth.email_taken' : 'auth.handle_taken',
        );
      }
      throw err;
    }
    this.log.warn({ audit: 'founder.enrolled', userId }, 'founder.enrolled');
    return this.finishRegistration(userId, input);
  }

  /**
   * Is founder enrolment open right now? True only while ALL hold: the invites
   * are configured (hashes and expiry), the founder pair is not pinned, the
   * expiry has not passed, and at least one invite is unspent. Reveals nothing else.
   */
  async founderEnrolmentOpen(config: FounderEnrolmentConfig | undefined, now: Date = new Date()): Promise<boolean> {
    if (!config) return false;
    if (now.getTime() >= config.expiresAt.getTime()) return false;
    if (await this.founderPairPinned(this.sql)) return false;
    const spent = await this.sql<
      Array<{ n: number }>
    >`SELECT count(*)::int AS n FROM founder_invites_used WHERE hash IN ${this.sql(config.hashes as string[])}`;
    return (spent[0]?.n ?? 0) < config.hashes.length;
  }

  /** The founder pair is pinned permanently by the first verified boot (founder-controls.ts). */
  private async founderPairPinned(q: Sql): Promise<boolean> {
    const rows = await q<Array<{ pinned: boolean }>>`SELECT true AS pinned FROM founder_control_configuration LIMIT 1`;
    return rows.length > 0;
  }

  private async founderInviteSpent(q: Sql, hash: string): Promise<boolean> {
    const rows = await q<Array<{ hash: string }>>`SELECT hash FROM founder_invites_used WHERE hash = ${hash}`;
    return rows.length > 0;
  }

  async login(input: { identifier: string; password: string; totpCode?: string; device?: string; ip?: string }): Promise<SessionTokens> {
    const rows = await this.sql<
      Array<{ id: string; password_hash: string; status: string; totp_secret: string | null }>
    >`SELECT id, password_hash, status, totp_secret FROM users WHERE handle = ${input.identifier} OR email = ${input.identifier}`;
    const user = rows[0];
    // Reserve the password guess BEFORE verifying it (see attempt-lockout.ts). Unknown
    // identifiers have no row and keep answering `invalid_credentials`. A locked
    // account still pays the password-hash cost (against the dummy hash) so timing
    // does not separate locked from wrong from unknown.
    let locked: AuthError | undefined;
    if (user) {
      try {
        await this.reserve(user.id, 'password');
      } catch (err) {
        if (!(err instanceof AuthError) || err.code !== 'auth.too_many_attempts') throw err;
        locked = err;
      }
    }
    const storedHash = user && !locked ? user.password_hash : await dummyPasswordHash();
    const passwordOk = await verifyPassword(storedHash, input.password);
    if (locked) throw locked;
    if (!user || !passwordOk) throw new AuthError('Invalid credentials', 'auth.invalid_credentials');
    if (user.status !== 'active') throw new AuthError(`Account is ${user.status}`, 'auth.account_frozen');
    // The password verified: it is no longer a guess. Clear its counter NOW, before the
    // two-step TOTP flow (password first, code second), so a correct password is never
    // left counting against the owner. The mfa counter is separate and stays.
    await recordSuccess(this.sql, user.id, 'password');
    let mfa = false;
    if (user.totp_secret) {
      if (!input.totpCode) throw new AuthError('Two-factor code required', 'auth.mfa_required');
      // Counted before the code is looked at; a locked account is refused here without consuming a step or a recovery code.
      await this.reserve(user.id, 'mfa');
      await this.verifyMfaCode(user.id, user.totp_secret, input.totpCode);
      mfa = true;
      await recordSuccess(this.sql, user.id, 'mfa');
    }
    if (await needsRehash(user.password_hash)) {
      const upgraded = await hashPassword(input.password);
      await this.sql`UPDATE users SET password_hash = ${upgraded}, updated_at = now() WHERE id = ${user.id}`;
    }
    return this.issueSession(user.id, { device: input.device, ip: input.ip, mfa });
  }

  private async issueSession(
    userId: string,
    options: { device?: string | undefined; ip?: string | undefined; mfa: boolean },
  ): Promise<SessionTokens> {
    const refreshToken = generateToken(48);
    const expiresAt = new Date(Date.now() + this.tokens.refreshTtlSeconds * 1000);
    const inserted = await transaction(
      this.sql,
      async (tx) => {
        const [user] = await tx<Array<{ status: string }>>`SELECT status FROM users WHERE id = ${userId} FOR UPDATE`;
        if (!user || user.status !== 'active') throw new AuthError('Account is unavailable', 'auth.account_frozen');
        return tx<
          Array<{ id: string }>
        >`INSERT INTO sessions (user_id, refresh_hash, device, ip, mfa, expires_at) VALUES (${userId}, ${hashToken(refreshToken)}, ${options.device ?? null}, ${options.ip ?? null}, ${options.mfa}, ${expiresAt}) RETURNING id`;
      },
      { isolation: 'read committed' },
    );
    const sessionId = inserted[0]!.id;
    void syncNavigatorSessionOpen(this.sql, sessionId, userId);
    const tier = await this.kycTier(userId);
    const { token: accessToken, expiresAt: accessExpiresAt } = await issueAccessToken(
      { userId, sessionId, scopes: this.defaultScopes(), tier, mfa: options.mfa },
      this.tokens,
    );
    return { accessToken, refreshToken, expiresAt: accessExpiresAt, sessionId, userId, mfaRequired: false };
  }

  async refresh(refreshToken: string, options: { device?: string; ip?: string } = {}): Promise<SessionTokens> {
    const hash = hashToken(refreshToken);
    type RefreshOutcome =
      | { kind: 'reuse'; userId: string; sessionId: string }
      | { kind: 'frozen'; userId: string; sessionId: string; status: string }
      | { kind: 'expired'; sessionId: string }
      | { kind: 'rotated'; previousSessionId: string; tokens: SessionTokens };
    const result = await transaction<RefreshOutcome>(this.sql, async (tx) => {
      const rows = await tx<
        Array<{ id: string; user_id: string; revoked: boolean; mfa: boolean; expires_at: Date; user_status: string }>
      >`SELECT s.id, s.user_id, s.revoked, s.mfa, s.expires_at, u.status AS user_status FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.refresh_hash = ${hash} FOR UPDATE OF s, u`;
      const session = rows[0];
      if (!session) throw new AuthError('Session not found', 'auth.session_invalid');
      if (session.revoked) return { kind: 'reuse', userId: session.user_id, sessionId: session.id };
      if (session.expires_at.getTime() < Date.now()) {
        await tx`UPDATE sessions SET revoked = true WHERE id = ${session.id}`;
        return { kind: 'expired', sessionId: session.id };
      }
      if (session.user_status !== 'active') {
        await tx`UPDATE sessions SET revoked = true WHERE id = ${session.id}`;
        return { kind: 'frozen', userId: session.user_id, sessionId: session.id, status: session.user_status };
      }
      await tx`UPDATE sessions SET revoked = true, last_used_at = now() WHERE id = ${session.id}`;
      const nextToken = generateToken(48);
      const expiresAt = new Date(Date.now() + this.tokens.refreshTtlSeconds * 1000);
      const nextSession = await tx<
        Array<{ id: string }>
      >`INSERT INTO sessions (user_id, refresh_hash, device, ip, mfa, expires_at) VALUES (${session.user_id}, ${hashToken(nextToken)}, ${options.device ?? null}, ${options.ip ?? null}, ${session.mfa}, ${expiresAt}) RETURNING id`;
      const sessionId = nextSession[0]!.id;
      const tier = await this.kycTier(session.user_id, tx);
      const { token: accessToken, expiresAt: accessExpiresAt } = await issueAccessToken(
        { userId: session.user_id, sessionId, scopes: this.defaultScopes(), tier, mfa: session.mfa },
        this.tokens,
      );
      return {
        kind: 'rotated',
        previousSessionId: session.id,
        tokens: {
          accessToken,
          refreshToken: nextToken,
          expiresAt: accessExpiresAt,
          sessionId,
          userId: session.user_id,
          mfaRequired: false,
        },
      };
    });
    if (result.kind === 'reuse') {
      await this.sql`UPDATE sessions SET revoked = true, reuse_detected_at = now() WHERE user_id = ${result.userId} AND revoked = false`;
      await this.sql`UPDATE sessions SET reuse_detected_at = now() WHERE id = ${result.sessionId}`;
      await syncNavigatorSessionsClosedForUser(this.sql, result.userId);
      throw new AuthError('Refresh token reuse detected — all sessions revoked', 'auth.session_reused');
    }
    if (result.kind === 'frozen') {
      await this.sql`UPDATE sessions SET revoked = true WHERE id = ${result.sessionId}`;
      await syncNavigatorSessionClosed(this.sql, result.sessionId);
      throw new AuthError(`Account is ${result.status}`, 'auth.account_frozen');
    }
    if (result.kind === 'expired') {
      await syncNavigatorSessionClosed(this.sql, result.sessionId);
      throw new AuthError('Session expired', 'auth.session_invalid');
    }
    await syncNavigatorSessionClosed(this.sql, result.previousSessionId);
    void syncNavigatorSessionOpen(this.sql, result.tokens.sessionId, result.tokens.userId);
    return result.tokens;
  }

  async logout(refreshToken: string): Promise<void> {
    const hash = hashToken(refreshToken);
    const rows = await this.sql<Array<{ id: string }>>`SELECT id FROM sessions WHERE refresh_hash = ${hash} LIMIT 1`;
    await this.sql`UPDATE sessions SET revoked = true WHERE refresh_hash = ${hash}`;
    const sessionId = rows[0]?.id;
    if (sessionId) await syncNavigatorSessionClosed(this.sql, sessionId);
  }

  async logoutAll(userId: string): Promise<number> {
    const result = await this.sql`UPDATE sessions SET revoked = true WHERE user_id = ${userId} AND revoked = false`;
    if (result.count > 0) await syncNavigatorSessionsClosedForUser(this.sql, userId);
    return result.count;
  }

  /**
   * CHANGE PASSWORD (signed-in user).
   *
   * Failures this prevents:
   *  - a stolen session (or a leaked API key) taking the account over by setting a
   *    new password: it needs the CURRENT password, and an API key / sub-account
   *    principal is refused outright (it is not a person at a keyboard);
   *  - a stolen password plus a non-MFA session doing the same on an account that
   *    has a second factor: any TOTP / passkey on the account requires the `mfa`
   *    claim (TOTP or passkey login, or a fresh `auth.stepUp` token). An account
   *    with NO second factor may change the password with the current one alone;
   *  - the current password being brute-forced through this door: the guess is
   *    reserved on the same per-account `password` counter as login BEFORE it is
   *    verified, so the two doors share one budget;
   *  - the old password living on in other devices: every OTHER session is revoked
   *    in the same transaction as the hash update. The calling session stays.
   *
   * Order: gate (delegated / MFA) → reserve → verify current → policy → not-the-same
   * → one transaction (re-check the hash we verified, write, revoke others, clear
   * the counter). A wrong current password answers `auth.invalid_credentials`,
   * identical to login. Entitlements (`operatorStatus`) are not touched: this writes
   * only `users.password_hash` and `sessions`.
   *
   * AUDIT: no durable auth-audit table or password-changed bus event exists yet, so
   * the record is the service's structured log line `auth.password_changed`
   * (same sink as `identity.account_locked`). User id and counts only, never a secret.
   */
  async changePassword(input: {
    userId: string;
    sessionId: string;
    actor: FactorActor;
    currentPassword: string;
    newPassword: string;
  }): Promise<void> {
    const { userId, sessionId, actor } = input;
    // Delegated principals first: refused before any lookup, so it cannot probe ids.
    if (actor.delegated) {
      throw new AuthError('Sign in yourself to change your password; an API key or sub-account cannot', 'auth.mfa_required');
    }
    const rows = await this.sql<
      Array<{ password_hash: string; status: string; totp_secret: string | null; webauthn_creds: unknown }>
    >`SELECT password_hash, status, totp_secret, webauthn_creds FROM users WHERE id = ${userId}`;
    const user = rows[0];
    if (!user) throw new AuthError('User not found', 'auth.not_found');
    if (user.status !== 'active') throw new AuthError(`Account is ${user.status}`, 'auth.account_frozen');
    // Second factor on the account, or a privileged identity (founder pair / `admin:*`
    // scope, which never gets the no-factor exception): the session must have passed it. Checked before the
    // reservation so a missing step-up never spends the password budget.
    if ((accountHasSecondFactor(user) || actor.privileged) && !actor.mfa) {
      throw new AuthError('Verify with your second factor before changing your password', 'auth.mfa_required');
    }
    // Count the guess BEFORE verifying it (see attempt-lockout.ts); a locked account is refused here.
    await this.reserve(userId, 'password');
    if (!(await verifyPassword(user.password_hash, input.currentPassword))) {
      throw new AuthError('Invalid credentials', 'auth.invalid_credentials');
    }
    // The current password verified, so it is no longer a guess: a policy or same-password
    // refusal below must not count toward the lock.
    await recordSuccess(this.sql, userId, 'password');
    try {
      assertPasswordShape(input.newPassword);
    } catch (err) {
      if (err instanceof WeakPasswordError) throw new AuthError(err.message, 'auth.password_policy');
      throw err;
    }
    if (input.newPassword === input.currentPassword) {
      throw new AuthError('The new password must differ from the current one', 'auth.password_unchanged');
    }
    const nextHash = await hashPassword(input.newPassword);
    const revokedIds = await transaction(this.sql, async (tx) => {
      const locked = await tx<
        Array<{ password_hash: string; status: string }>
      >`SELECT password_hash, status FROM users WHERE id = ${userId} FOR UPDATE`;
      // A parallel change already moved the hash: the password we verified is no longer the current one.
      if (!locked[0] || locked[0].password_hash !== user.password_hash) {
        throw new AuthError('Invalid credentials', 'auth.invalid_credentials');
      }
      if (locked[0].status !== 'active') throw new AuthError(`Account is ${locked[0].status}`, 'auth.account_frozen');
      const live = await tx<
        Array<{ id: string }>
      >`SELECT id FROM sessions WHERE id = ${sessionId} AND user_id = ${userId} AND revoked = false AND expires_at > now()`;
      if (!live[0]) throw new AuthError('Session is no longer valid', 'auth.session_invalid');
      await tx`UPDATE users SET password_hash = ${nextHash}, updated_at = now() WHERE id = ${userId}`;
      const revoked = await tx<
        Array<{ id: string }>
      >`UPDATE sessions SET revoked = true WHERE user_id = ${userId} AND revoked = false AND id <> ${sessionId} RETURNING id`;
      await recordSuccess(tx, userId, 'password');
      return revoked.map((r) => r.id);
    });
    for (const id of revokedIds) await syncNavigatorSessionClosed(this.sql, id);
    this.log.warn({ userId, sessionId, otherSessionsRevoked: revokedIds.length }, 'auth.password_changed');
  }

  async getSessionOwnership(sessionId: string): Promise<{ id: string; userId: string; revoked: boolean } | null> {
    const rows = await this.sql<
      Array<{ id: string; user_id: string; revoked: boolean }>
    >`SELECT id, user_id, revoked FROM sessions WHERE id = ${sessionId} LIMIT 1`;
    const row = rows[0];
    if (!row) return null;
    return { id: row.id, userId: row.user_id, revoked: row.revoked };
  }

  async assertSessionLive(sessionId: string): Promise<{ id: string; userId: string }> {
    const id = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!id) {
      throw new AuthError('Session not found', 'auth.session_denied');
    }
    const rows = await this.sql<
      Array<{ id: string; user_id: string; revoked: boolean; expires_at: Date }>
    >`SELECT id, user_id, revoked, expires_at FROM sessions WHERE id = ${id} LIMIT 1`;
    const row = rows[0];
    if (!row) {
      throw new AuthError('Session not found', 'auth.session_denied');
    }
    if (row.revoked || row.expires_at.getTime() < Date.now()) {
      throw new AuthError('Session is revoked', 'auth.session_revoked');
    }
    return { id: row.id, userId: row.user_id };
  }

  private async tryRedeemRecoveryCode(userId: string, code: string): Promise<boolean> {
    const hash = hashToken(code.trim());
    return transaction(this.sql, async (tx) => {
      const rows = await tx<
        Array<{ recovery_code_hashes: unknown }>
      >`SELECT recovery_code_hashes FROM users WHERE id = ${userId} FOR UPDATE`;
      const hashes = asStringList(rows[0]?.recovery_code_hashes);
      const idx = hashes.indexOf(hash);
      if (idx < 0) return false;
      const next = hashes.slice(0, idx).concat(hashes.slice(idx + 1));
      await tx`UPDATE users SET recovery_code_hashes = ${tx.json(next as never)}, updated_at = now() WHERE id = ${userId}`;
      return true;
    });
  }

  private async consumeTotpCode(userId: string, secret: string, code: string, at?: Date): Promise<void> {
    const matched = matchTotpStep(secret, code, at ? { at } : {});
    if (matched === null) {
      throw new AuthError('Invalid two-factor code', 'auth.mfa_invalid');
    }
    await transaction(this.sql, async (tx) => {
      const rows = await tx<
        Array<{ totp_last_step: string | number | bigint | null }>
      >`SELECT totp_last_step FROM users WHERE id = ${userId} FOR UPDATE`;
      if (!rows[0]) throw new AuthError('User not found', 'auth.not_found');
      const lastRaw = rows[0].totp_last_step;
      const lastStep = lastRaw === null || lastRaw === undefined ? null : BigInt(lastRaw);
      if (lastStep !== null && matched <= lastStep) {
        throw new AuthError('Invalid two-factor code', 'auth.mfa_invalid');
      }
      await tx`UPDATE users SET totp_last_step = ${matched.toString()}, updated_at = now() WHERE id = ${userId}`;
    });
  }

  async startTotpEnrolment(userId: string, actor: FactorActor): Promise<{ secret: string; uri: string; recoveryCodes: string[] }> {
    if (!this.totpSecretKey) {
      throw new AuthError(
        'IDENTITY_TOTP_SECRET_KEY is not set to a 32-byte key (base64 or hex) — cannot enrol TOTP',
        'auth.totp_key_missing',
      );
    }
    const rows = await this.sql<
      Array<{ email: string; totp_secret: string | null; webauthn_creds: unknown }>
    >`SELECT email, totp_secret, webauthn_creds FROM users WHERE id = ${userId}`;
    const user = rows[0];
    if (!user) throw new AuthError('User not found', 'auth.not_found');
    // Gate first (a refused caller learns nothing about TOTP state), then the
    // already-enrolled conflict. Unlocked: nothing is written here.
    checkMayAddFactor(user, actor);
    if (user.totp_secret) throw new AuthError('Two-factor is already enrolled', 'auth.mfa_already_enrolled');
    const secret = generateSecret();
    const recoveryCodes = generateRecoveryCodes();
    await this.pendingTotp.put(
      userId,
      hashToken(secret),
      recoveryCodes.map((c) => hashToken(c)),
    );
    return { secret, uri: totpUri(secret, user.email), recoveryCodes };
  }

  async confirmTotpEnrolment(userId: string, actor: FactorActor, secret: string, code: string): Promise<void> {
    const matched = matchTotpStep(secret, code);
    if (matched === null) throw new AuthError('Invalid two-factor code', 'auth.mfa_invalid');
    if (!this.totpSecretKey) {
      throw new AuthError(
        'IDENTITY_TOTP_SECRET_KEY is not set to a 32-byte key (base64 or hex) — cannot enrol TOTP',
        'auth.totp_key_missing',
      );
    }
    // Same transaction, same row lock as the write: "has no factor" cannot change
    // between the check and the UPDATE (a parallel first-factor enrolment waits).
    const sealed = encryptTotpSecret(this.totpSecretKey, secret);
    await transaction(this.sql, async (tx) => {
      await assertMayAddFactor(tx, userId, actor, true);
      const pending = await this.pendingTotp.takeIfSecretHash(userId, hashToken(secret));
      if (!pending) {
        throw new AuthError('TOTP enrolment session expired or secret mismatch — start enrolment again', 'auth.mfa_invalid');
      }
      await tx`UPDATE users SET totp_secret = ${sealed}, totp_enrolled_at = now(), totp_last_step = ${matched.toString()}, recovery_code_hashes = ${tx.json(pending.recoveryHashes as never)}, updated_at = now() WHERE id = ${userId} AND totp_secret IS NULL`;
    });
    await this.rank.awardXp({
      userId,
      sourceModule: 'identity',
      action: 'identity.totp.enrolled',
      xpDelta: 100,
      idempotencyKey: `identity.totp.enrolled:${userId}`,
    });
  }

  async startWebauthnRegistration(userId: string, actor: FactorActor): Promise<RegistrationOptionsJSON> {
    const rows = await this.sql<
      Array<{ email: string; handle: string; totp_secret: string | null; webauthn_creds: StoredWebAuthnCredential[] }>
    >`SELECT email, handle, totp_secret, webauthn_creds FROM users WHERE id = ${userId}`;
    const user = rows[0];
    if (!user) throw new AuthError('User not found', 'auth.not_found');
    checkMayAddFactor(user, actor);
    const existing = asCredentialList(user.webauthn_creds);
    const challenge = generateChallenge();
    await this.challenges.put('registration', challenge, userId);
    return createRegistrationOptions(this.webauthn, { id: userId, name: user.email, displayName: user.handle }, existing, challenge);
  }

  async confirmWebauthnRegistration(
    userId: string,
    actor: FactorActor,
    response: RegistrationResponseJSON,
  ): Promise<{ credentialId: string }> {
    const rows = await this.sql<
      Array<{ webauthn_creds: StoredWebAuthnCredential[] }>
    >`SELECT webauthn_creds FROM users WHERE id = ${userId}`;
    const user = rows[0];
    if (!user) throw new AuthError('User not found', 'auth.not_found');
    const clientChallenge = readClientChallenge(response.response.clientDataJSON);
    if (!clientChallenge) throw new AuthError('Invalid WebAuthn response', 'auth.webauthn_invalid');
    const held = await this.challenges.take(clientChallenge, 'registration');
    if (!held || held.userId !== userId) {
      throw new AuthError('WebAuthn challenge expired or already used', 'auth.webauthn_invalid');
    }
    let stored: StoredWebAuthnCredential;
    try {
      stored = verifyRegistrationResponse(this.webauthn, held.challenge, response);
    } catch (err) {
      throw mapWebAuthnError(err);
    }
    // Re-read under a row lock so this enrolment and a login's counter write in
    // this service cannot overwrite each other's credential list. The writers in
    // enroll-passkey.ts, verify-passkey.ts and unenroll-passkey.ts take the same
    // lock, so the guarantee holds between all of them.
    const existingCount = await transaction(this.sql, async (tx) => {
      // Locks the user row and applies the factor rule in the same transaction as the write.
      await assertMayAddFactor(tx, userId, actor, true);
      const locked = await tx<Array<{ webauthn_creds: unknown }>>`SELECT webauthn_creds FROM users WHERE id = ${userId}`;
      if (!locked[0]) throw new AuthError('User not found', 'auth.not_found');
      const existing = asCredentialList(locked[0].webauthn_creds);
      if (existing.some((c) => c.credentialId === stored.credentialId)) {
        throw new AuthError('That authenticator is already registered', 'auth.webauthn_invalid');
      }
      const next = [...existing, stored];
      await tx`UPDATE users SET webauthn_creds = ${tx.json(next as never)}, updated_at = now() WHERE id = ${userId}`;
      return existing.length;
    });
    if (existingCount === 0) {
      await this.rank.awardXp({
        userId,
        sourceModule: 'identity',
        action: 'identity.webauthn.enrolled',
        xpDelta: 100,
        idempotencyKey: `identity.webauthn.enrolled:${userId}`,
      });
    }
    return { credentialId: stored.credentialId };
  }

  async startWebauthnAuthentication(identifier: string): Promise<AuthenticationOptionsJSON> {
    const rows = await this.sql<
      Array<{ id: string; status: string; webauthn_creds: StoredWebAuthnCredential[] }>
    >`SELECT id, status, webauthn_creds FROM users WHERE handle = ${identifier} OR email = ${identifier}`;
    const user = rows[0];
    const challenge = generateChallenge();
    const creds = user && user.status === 'active' ? asCredentialList(user.webauthn_creds) : [];
    await this.challenges.put('authentication', challenge, user?.status === 'active' ? user.id : null);
    return createAuthenticationOptions(this.webauthn, creds, challenge);
  }

  async confirmWebauthnAuthentication(
    identifier: string,
    response: AuthenticationResponseJSON,
    options: { device?: string; ip?: string } = {},
  ): Promise<SessionTokens> {
    const rows = await this.sql<
      Array<{ id: string; status: string; webauthn_creds: StoredWebAuthnCredential[] }>
    >`SELECT id, status, webauthn_creds FROM users WHERE handle = ${identifier} OR email = ${identifier}`;
    const user = rows[0];
    if (!user) throw new AuthError('Invalid credentials', 'auth.invalid_credentials');
    if (user.status !== 'active') throw new AuthError(`Account is ${user.status}`, 'auth.account_frozen');
    const clientChallenge = readClientChallenge(response.response.clientDataJSON);
    if (!clientChallenge) throw new AuthError('Invalid credentials', 'auth.invalid_credentials');
    const held = await this.challenges.take(clientChallenge, 'authentication');
    if (!held || held.userId !== user.id) {
      throw new AuthError('Invalid credentials', 'auth.invalid_credentials');
    }
    if (asCredentialList(user.webauthn_creds).length === 0) throw new AuthError('No security key enrolled', 'auth.webauthn_not_enrolled');
    await this.verifyAssertionAndAdvanceCounter(user.id, held.challenge, response, () => {
      throw new AuthError('Invalid credentials', 'auth.invalid_credentials');
    });
    return this.issueSession(user.id, { device: options.device, ip: options.ip, mfa: true });
  }

  /**
   * Verify a passkey assertion and advance that credential's signature counter.
   *
   * Runs in one transaction under `SELECT … FOR UPDATE` on the user row, so two
   * concurrent assertions (or a locked enrolment racing a login) cannot read the
   * same counter and both succeed, and cannot overwrite each other's credential
   * list. The writers in enroll-passkey.ts, verify-passkey.ts and
   * unenroll-passkey.ts take the same lock. `refuse` throws the caller's own AuthError for any refusal.
   */
  private async verifyAssertionAndAdvanceCounter(
    userId: string,
    challenge: string,
    response: AuthenticationResponseJSON,
    refuse: () => never,
  ): Promise<void> {
    await transaction(this.sql, async (tx) => {
      const rows = await tx<Array<{ webauthn_creds: unknown }>>`SELECT webauthn_creds FROM users WHERE id = ${userId} FOR UPDATE`;
      if (!rows[0]) return refuse();
      const creds = asCredentialList(rows[0].webauthn_creds);
      const responseId = normalizeCredId(response.id);
      const credential = creds.find((c) => c.credentialId === responseId);
      if (!credential) return refuse();
      let newCounter: number;
      try {
        ({ newCounter } = await verifyAuthenticationResponse(this.webauthn, challenge, credential, response));
      } catch (err) {
        if (err instanceof WebAuthnError) return refuse();
        throw err;
      }
      const next = creds.map((c) => (c.credentialId === credential.credentialId ? { ...c, counter: newCounter } : c));
      await tx`UPDATE users SET webauthn_creds = ${tx.json(next as never)}, updated_at = now() WHERE id = ${userId}`;
    });
  }

  async listWebauthnCredentials(
    userId: string,
    limit: number,
  ): Promise<Array<{ credentialId: string; createdAt: string; transports?: string[] }>> {
    const published = publishedWebauthnListLimit(limit);
    const rows = await this.sql<
      Array<{ webauthn_creds: StoredWebAuthnCredential[] }>
    >`SELECT webauthn_creds FROM users WHERE id = ${userId}`;
    if (!rows[0]) throw new AuthError('User not found', 'auth.not_found');
    return asCredentialList(rows[0].webauthn_creds)
      .map((c) => ({
        credentialId: c.credentialId,
        createdAt: c.createdAt,
        ...(c.transports ? { transports: c.transports } : {}),
      }))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, published);
  }

  async removeWebauthnCredential(userId: string, actor: FactorActor, credentialId: string): Promise<boolean> {
    assertMayRemoveFactor(actor);
    const target = normalizeCredId(credentialId);
    return transaction(this.sql, async (tx) => {
      const rows = await tx<Array<{ webauthn_creds: unknown }>>`SELECT webauthn_creds FROM users WHERE id = ${userId} FOR UPDATE`;
      if (!rows[0]) throw new AuthError('User not found', 'auth.not_found');
      const creds = asCredentialList(rows[0].webauthn_creds);
      const next = creds.filter((c) => c.credentialId !== target);
      if (next.length === creds.length) return false;
      await tx`UPDATE users SET webauthn_creds = ${tx.json(next as never)}, updated_at = now() WHERE id = ${userId}`;
      return true;
    });
  }

  async startWebauthnStepUp(userId: string) {
    const rows = await this.sql<
      Array<{ id: string; status: string; webauthn_creds: StoredWebAuthnCredential[] }>
    >`SELECT id, status, webauthn_creds FROM users WHERE id = ${userId}`;
    const user = rows[0];
    if (!user) throw new AuthError('User not found', 'auth.not_found');
    if (user.status !== 'active') throw new AuthError(`Account is ${user.status}`, 'auth.account_frozen');
    const creds = asCredentialList(user.webauthn_creds);
    if (creds.length === 0) {
      throw new AuthError('No security key enrolled', 'auth.webauthn_not_enrolled');
    }
    const challenge = generateChallenge();
    await this.challenges.put('step-up', challenge, userId);
    return createAuthenticationOptions(this.webauthn, creds, challenge);
  }

  async createApiKey(input: {
    userId: string;
    name: string;
    scopes: string[];
    grantorScopes: readonly string[];
    grantorKid?: string | null;
    domainWhitelist?: string[];
    expiresAt?: Date;
    mode?: 'live' | 'sandbox';
  }): Promise<{ id: string; key: string; prefix: string; mode: 'live' | 'sandbox' }> {
    assertDelegateCannotGrant(input.grantorKid);
    assertDelegatableScopes(input.scopes, input.grantorScopes);
    const mode = input.mode === 'sandbox' ? 'sandbox' : 'live';
    const { key, hash, prefix } = generateApiKey(mode);
    const rows = await transaction(
      this.sql,
      async (tx) => {
        const [user] = await tx<Array<{ status: string }>>`SELECT status FROM users WHERE id = ${input.userId} FOR UPDATE`;
        if (!user || user.status !== 'active') throw new AuthError('Account is unavailable', 'auth.account_frozen');
        return tx<
          Array<{ id: string }>
        >`INSERT INTO api_keys (user_id, name, key_hash, key_prefix, scopes, domain_whitelist, expires_at, mode) VALUES (${input.userId}, ${input.name}, ${hash}, ${prefix}, ${input.scopes}, ${input.domainWhitelist ?? []}, ${input.expiresAt ?? null}, ${mode}) RETURNING id`;
      },
      { isolation: 'read committed' },
    );
    return { id: rows[0]!.id, key, prefix, mode };
  }

  async verifyApiKey(
    key: string,
  ): Promise<{ userId: string; scopes: string[]; keyId: string; mode: 'live' | 'sandbox'; domainWhitelist: string[] } | null> {
    const rows = await this.sql<
      Array<{
        id: string;
        user_id: string;
        scopes: string[];
        expires_at: Date | null;
        mode: string | null;
        domain_whitelist: string[] | null;
      }>
    >`SELECT id, user_id, scopes, expires_at, mode, domain_whitelist FROM api_keys WHERE key_hash = ${hashToken(key)} AND revoked = false`;
    const row = rows[0];
    if (!row) return null;
    if (row.expires_at && row.expires_at.getTime() < Date.now()) return null;
    await this.sql`UPDATE api_keys SET last_used_at = now() WHERE id = ${row.id}`;
    const mode: 'live' | 'sandbox' = row.mode === 'sandbox' ? 'sandbox' : 'live';
    return { userId: row.user_id, scopes: row.scopes, keyId: row.id, mode, domainWhitelist: row.domain_whitelist ?? [] };
  }

  async exchangeApiKey(
    key: string,
    requestOrigin?: string | null,
  ): Promise<{ accessToken: string; expiresAt: Date; userId: string; keyId: string; scopes: string[]; mode: 'live' | 'sandbox' }> {
    const verified = await this.verifyApiKey(key);
    if (!verified) throw new AuthError('Invalid credentials', 'auth.invalid_credentials');
    if (!apiKeyOriginAllowed(verified.domainWhitelist, requestOrigin)) {
      throw new AuthError('API key is not allowed from this origin', 'auth.domain_not_allowed');
    }
    const users = await this.sql<Array<{ status: string }>>`SELECT status FROM users WHERE id = ${verified.userId}`;
    const user = users[0];
    if (!user) throw new AuthError('Account not found', 'auth.not_found');
    if (user.status !== 'active') throw new AuthError(`Account is ${user.status}`, 'auth.account_frozen');
    const tier = await this.kycTier(verified.userId);
    const { token: accessToken, expiresAt } = await issueAccessToken(
      {
        userId: verified.userId,
        sessionId: verified.keyId,
        scopes: verified.scopes,
        tier,
        mfa: false,
        apiKeyId: verified.keyId,
        keyEnv: verified.mode,
      },
      this.tokens,
    );
    return { accessToken, expiresAt, userId: verified.userId, keyId: verified.keyId, scopes: verified.scopes, mode: verified.mode };
  }

  async revokeApiKey(userId: string, keyId: string): Promise<boolean> {
    const result = await this.sql`UPDATE api_keys SET revoked = true WHERE id = ${keyId} AND user_id = ${userId} AND revoked = false`;
    return result.count > 0;
  }

  async getApiKeyOwnership(keyId: string): Promise<{ id: string; userId: string; revoked: boolean } | null> {
    const rows = await this.sql<
      Array<{ id: string; user_id: string; revoked: boolean }>
    >`SELECT id, user_id, revoked FROM api_keys WHERE id = ${keyId} LIMIT 1`;
    const row = rows[0];
    if (!row) return null;
    return { id: row.id, userId: row.user_id, revoked: row.revoked };
  }

  async assertApiKeyLive(keyId: string): Promise<{ id: string; userId: string }> {
    const id = typeof keyId === 'string' ? keyId.trim() : '';
    if (!id) {
      throw new AuthError('API key not found', 'auth.api_key_denied');
    }
    const row = await this.getApiKeyOwnership(id);
    if (!row) {
      throw new AuthError('API key not found', 'auth.api_key_denied');
    }
    if (row.revoked) {
      throw new AuthError('API key is revoked', 'auth.api_key_revoked');
    }
    return { id: row.id, userId: row.userId };
  }

  async listApiKeys(userId: string, limit: number) {
    const published = publishedApiKeysListLimit(limit);
    return this.sql<
      Array<{ id: string; name: string; key_prefix: string; scopes: string[]; last_used_at: Date | null; revoked: boolean; mode: string }>
    >`SELECT id, name, key_prefix, scopes, last_used_at, revoked, mode FROM api_keys WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT ${published}`;
  }

  async kycTier(userId: string, sql: Sql = this.sql): Promise<'none' | 'basic' | 'full' | 'institutional'> {
    const rows = await sql<
      Array<{ tier: 'basic' | 'full' | 'institutional' }>
    >`SELECT tier FROM kyc_records WHERE user_id = ${userId} AND status = 'approved' AND (expires_at IS NULL OR expires_at > now())`;
    const order = { basic: 1, full: 2, institutional: 3 } as const;
    let best: 'none' | 'basic' | 'full' | 'institutional' = 'none';
    for (const row of rows) {
      if (best === 'none' || order[row.tier] > order[best as 'basic' | 'full' | 'institutional']) best = row.tier;
    }
    return best;
  }

  async accountState(userId: string): Promise<AccountState | null> {
    const rows = await this.sql<
      Array<{ id: string; status: 'active' | 'frozen' | 'closed' }>
    >`SELECT id, status FROM users WHERE id = ${userId} LIMIT 1`;
    const user = rows[0];
    if (!user) return null;
    return { userId: user.id, status: user.status, kycTier: await this.kycTier(user.id) };
  }

  /**
   * The caller's own handle, for `identity.me`. Null only when the account row
   * is gone, which a live session should not be able to reach.
   */
  async handleOf(userId: string): Promise<string | null> {
    const rows = await this.sql<Array<{ handle: string }>>`SELECT handle FROM users WHERE id = ${userId} LIMIT 1`;
    return rows[0]?.handle ?? null;
  }

  /**
   * Exact handle match for pay-by-@handle. `handle` is citext, so `=` is
   * case-insensitive and there is no LIKE, prefix or list path here.
   *
   * Only `active` accounts come back. Frozen, closed and missing rows are the
   * same null: the caller must not learn which handles belong to restricted
   * accounts. Returns the stored handle and nothing else about the account.
   */
  async findActiveByHandle(handle: string): Promise<{ userId: string; handle: string } | null> {
    const rows = await this.sql<Array<{ id: string; handle: string }>>`
      SELECT id, handle FROM users WHERE handle = ${handle} AND status = 'active' LIMIT 1`;
    const row = rows[0];
    return row ? { userId: row.id, handle: row.handle } : null;
  }

  async submitKyc(input: { userId: string; tier: SubmittableKycTier; jurisdiction: string; providerRef?: string }): Promise<KycRecordView> {
    return transaction(this.sql, async (tx) => {
      const users = await tx<Array<{ id: string }>>`SELECT id FROM users WHERE id = ${input.userId} FOR UPDATE`;
      if (!users[0]) throw new AuthError('User not found', 'auth.not_found');
      const existing = await tx<
        KycRow[]
      >`SELECT id, user_id, tier, jurisdiction, provider_ref, status, reviewed_by, reviewed_at, expires_at, created_at FROM kyc_records WHERE user_id = ${input.userId} AND ((status = 'approved' AND (expires_at IS NULL OR expires_at > now())) OR (status = 'pending' AND tier = ${input.tier})) ORDER BY created_at DESC`;
      const approved = existing.find((r) => r.status === 'approved' && TIER_ORDER[r.tier] >= TIER_ORDER[input.tier]);
      if (approved) return toKycRecord(approved);
      const pending = existing.find((r) => r.status === 'pending');
      if (pending) return toKycRecord(pending);
      const inserted = await tx<
        KycRow[]
      >`INSERT INTO kyc_records (user_id, tier, jurisdiction, provider_ref, status) VALUES (${input.userId}, ${input.tier}, ${input.jurisdiction}, ${input.providerRef ?? null}, 'pending') RETURNING id, user_id, tier, jurisdiction, provider_ref, status, reviewed_by, reviewed_at, expires_at, created_at`;
      return toKycRecord(inserted[0]!);
    });
  }

  async listKycRecords(userId: string, limit: number): Promise<KycRecordView[]> {
    const published = publishedKycRecordsListLimit(limit);
    const rows = await this.sql<
      KycRow[]
    >`SELECT id, user_id, tier, jurisdiction, provider_ref, status, reviewed_by, reviewed_at, expires_at, created_at FROM kyc_records WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT ${published}`;
    return rows.map(toKycRecord);
  }

  async listPendingKyc(limit: number): Promise<KycRecordView[]> {
    const published = publishedKycPendingLimit(limit);
    const rows = await this.sql<
      KycRow[]
    >`SELECT id, user_id, tier, jurisdiction, provider_ref, status, reviewed_by, reviewed_at, expires_at, created_at FROM kyc_records WHERE status = 'pending' ORDER BY created_at ASC LIMIT ${published}`;
    return rows.map(toKycRecord);
  }

  async getKycRecord(recordId: string): Promise<KycRecordView | null> {
    const rows = await this.sql<
      KycRow[]
    >`SELECT id, user_id, tier, jurisdiction, provider_ref, status, reviewed_by, reviewed_at, expires_at, created_at FROM kyc_records WHERE id = ${recordId}`;
    return rows[0] ? toKycRecord(rows[0]) : null;
  }

  async approveKycRecord(input: {
    recordId: string;
    reviewerId: string;
    expiresAt?: Date | null;
    service?: string | null;
    kid?: string | null;
    /** Threaded from the wire mill field so boot dual-control wrap can see the second actor. */
    confirmActorId?: string | null;
    approvalId?: string | null;
    operationId?: string | null;
  }): Promise<KycRecordView> {
    assertOperatorKycReview({ service: input.service, kid: input.kid });
    const outcome = await transaction(this.sql, async (tx) => {
      const rows = await tx<
        KycRow[]
      >`SELECT id, user_id, tier, jurisdiction, provider_ref, status, reviewed_by, reviewed_at, expires_at, created_at FROM kyc_records WHERE id = ${input.recordId} FOR UPDATE`;
      const row = rows[0];
      if (!row) throw new AuthError('KYC record not found', 'auth.not_found');
      if (row.status === 'approved') return { record: toKycRecord(row), granted: false };
      if (row.status !== 'pending') {
        throw new AuthError(`KYC record is ${row.status}; only a pending record can be approved`, 'auth.kyc_not_pending');
      }
      const updated = await tx<
        KycRow[]
      >`UPDATE kyc_records SET status = 'approved', reviewed_at = now(), reviewed_by = ${input.reviewerId}, expires_at = ${input.expiresAt ?? null} WHERE id = ${row.id} RETURNING id, user_id, tier, jurisdiction, provider_ref, status, reviewed_by, reviewed_at, expires_at, created_at`;
      return { record: toKycRecord(updated[0]!), granted: true };
    });
    if (outcome.granted) await this.announceKycApproval(outcome.record);
    return outcome.record;
  }

  async rejectKycRecord(input: {
    recordId: string;
    reviewerId: string;
    service?: string | null;
    kid?: string | null;
    /** Threaded from the wire mill field so boot dual-control wrap can see the second actor. */
    confirmActorId?: string | null;
    approvalId?: string | null;
    operationId?: string | null;
  }): Promise<KycRecordView> {
    assertOperatorKycReview({ service: input.service, kid: input.kid });
    return transaction(this.sql, async (tx) => {
      const rows = await tx<
        KycRow[]
      >`SELECT id, user_id, tier, jurisdiction, provider_ref, status, reviewed_by, reviewed_at, expires_at, created_at FROM kyc_records WHERE id = ${input.recordId} FOR UPDATE`;
      const row = rows[0];
      if (!row) throw new AuthError('KYC record not found', 'auth.not_found');
      if (row.status === 'rejected') return toKycRecord(row);
      if (row.status !== 'pending') {
        throw new AuthError(`KYC record is ${row.status}; only a pending record can be rejected`, 'auth.kyc_not_pending');
      }
      const updated = await tx<
        KycRow[]
      >`UPDATE kyc_records SET status = 'rejected', reviewed_at = now(), reviewed_by = ${input.reviewerId} WHERE id = ${row.id} RETURNING id, user_id, tier, jurisdiction, provider_ref, status, reviewed_by, reviewed_at, expires_at, created_at`;
      return toKycRecord(updated[0]!);
    });
  }

  async approveKyc(input: { userId: string; tier: SubmittableKycTier; jurisdiction: string; providerRef?: string }): Promise<void> {
    await this
      .sql`INSERT INTO kyc_records (user_id, tier, jurisdiction, provider_ref, status, reviewed_at) VALUES (${input.userId}, ${input.tier}, ${input.jurisdiction}, ${input.providerRef ?? null}, 'approved', now())`;
    await this.announceKycApproval({ userId: input.userId, tier: input.tier, jurisdiction: input.jurisdiction });
  }

  private async announceKycApproval(record: { userId: string; tier: KycTier; jurisdiction: string }): Promise<void> {
    if (record.tier === 'none') return;
    await this.bus.publish(
      'kycApproved',
      { userId: record.userId, tier: record.tier, jurisdiction: record.jurisdiction },
      { idempotencyKey: `kyc.approved:${record.userId}:${record.tier}` },
    );
    await this.rank.awardXp({
      userId: record.userId,
      sourceModule: 'identity',
      action: 'identity.kyc.approved',
      xpDelta: 200,
      idempotencyKey: `identity.kyc.approved:${record.userId}:${record.tier}`,
    });
  }

  async stepUp(input: {
    userId: string;
    sessionId: string;
    totpCode?: string;
    webauthn?: AuthenticationResponseJSON;
  }): Promise<{ accessToken: string; expiresAt: Date; scopes: Scope[] }> {
    const hasTotp = typeof input.totpCode === 'string' && input.totpCode.length > 0;
    const hasWebauthn = input.webauthn !== undefined && input.webauthn !== null;
    if (hasTotp === hasWebauthn) {
      throw new AuthError('Provide either a TOTP code or a WebAuthn assertion', 'auth.mfa_invalid');
    }
    const users = await this.sql<
      Array<{ totp_secret: string | null; status: string; webauthn_creds: StoredWebAuthnCredential[] }>
    >`SELECT totp_secret, status, webauthn_creds FROM users WHERE id = ${input.userId}`;
    const user = users[0];
    if (!user) throw new AuthError('User not found', 'auth.not_found');
    if (user.status !== 'active') throw new AuthError(`Account is ${user.status}`, 'auth.account_frozen');
    const sessions = await this.sql<
      Array<{ id: string }>
    >`SELECT id FROM sessions WHERE id = ${input.sessionId} AND user_id = ${input.userId} AND revoked = false AND expires_at > now()`;
    if (!sessions[0]) throw new AuthError('Session is no longer valid', 'auth.session_invalid');
    if (hasTotp) {
      if (!user.totp_secret) {
        throw new AuthError('Enrol two-factor authentication before withdrawing', 'auth.mfa_not_enrolled');
      }
      // Same reserve-then-verify as login; the counter is shared with login's MFA step.
      await this.reserve(input.userId, 'mfa');
      await this.verifyMfaCode(input.userId, user.totp_secret, input.totpCode!);
      await recordSuccess(this.sql, input.userId, 'mfa');
    } else {
      if (asCredentialList(user.webauthn_creds).length === 0) {
        throw new AuthError('Enrol a security key before withdrawing with passkey step-up', 'auth.webauthn_not_enrolled');
      }
      const response = input.webauthn!;
      const clientChallenge = readClientChallenge(response.response.clientDataJSON);
      if (!clientChallenge) throw new AuthError('Invalid two-factor assertion', 'auth.webauthn_invalid');
      const held = await this.challenges.take(clientChallenge, 'step-up');
      if (!held || held.userId !== input.userId) {
        throw new AuthError('Invalid two-factor assertion', 'auth.webauthn_invalid');
      }
      await this.verifyAssertionAndAdvanceCounter(input.userId, held.challenge, response, () => {
        throw new AuthError('Invalid two-factor assertion', 'auth.webauthn_invalid');
      });
    }
    const scopes: Scope[] = [...this.defaultScopes(), ...STEP_UP_SCOPES];
    const tier = await this.kycTier(input.userId);
    const { token, expiresAt } = await issueAccessToken(
      { userId: input.userId, sessionId: input.sessionId, scopes, tier, mfa: true },
      { ...this.tokens, accessTtlSeconds: Math.min(this.tokens.accessTtlSeconds, STEP_UP_TTL_SECONDS) },
    );
    return { accessToken: token, expiresAt, scopes };
  }

  async freezeIdentity(userId: string): Promise<{ userId: string; status: 'frozen'; subAccountsRevoked: number; apiKeysRevoked: number }> {
    const result = await transaction(this.sql, async (tx) => {
      const users = await tx<Array<{ id: string; status: string }>>`SELECT id, status FROM users WHERE id = ${userId} LIMIT 1 FOR UPDATE`;
      if (!users[0]) throw new AuthError('User not found', 'auth.not_found');
      await tx`UPDATE users SET status = 'frozen', updated_at = now() WHERE id = ${userId}`;
      await tx`UPDATE sessions SET revoked = true WHERE user_id = ${userId} AND revoked = false`;
      const revokedRows = await tx<
        Array<{ id: string }>
      >`UPDATE sub_accounts SET revoked = true WHERE parent_user_id = ${userId} AND revoked = false RETURNING id`;
      const revokedKeys = await tx<
        Array<{ id: string }>
      >`UPDATE api_keys SET revoked = true WHERE user_id = ${userId} AND revoked = false RETURNING id`;
      return { userId, status: 'frozen' as const, subAccountsRevoked: revokedRows.length, apiKeysRevoked: revokedKeys.length };
    });
    await syncNavigatorSessionsClosedForUser(this.sql, userId);
    return result;
  }

  async unfreezeIdentity(userId: string): Promise<{ userId: string; status: 'active' }> {
    const users = await this.sql<Array<{ id: string; status: string }>>`SELECT id, status FROM users WHERE id = ${userId} LIMIT 1`;
    if (!users[0]) throw new AuthError('User not found', 'auth.not_found');
    if (users[0].status === 'closed') {
      throw new AuthError('Closed accounts cannot be unfrozen', 'auth.account_frozen');
    }
    await this.sql`UPDATE users SET status = 'active', updated_at = now() WHERE id = ${userId}`;
    return { userId, status: 'active' };
  }

  async createSubAccount(userId: string, label: string, purpose?: string): Promise<{ id: string }> {
    const users = await this.sql<Array<{ status: string }>>`SELECT status FROM users WHERE id = ${userId} LIMIT 1`;
    if (!users[0]) throw new AuthError('User not found', 'auth.not_found');
    if (users[0].status !== 'active') {
      throw new AuthError(`Account is ${users[0].status}`, 'auth.account_frozen');
    }
    const cap = this.maxSubAccounts;
    if (cap === undefined) {
      throw new AuthError('IDENTITY_MAX_SUB_ACCOUNTS is unset — owner must publish a live-partition cap', 'auth.sub_account_cap_unset');
    }
    return transaction(this.sql, async (tx) => {
      const locked = await tx<Array<{ id: string; status: string }>>`SELECT id, status FROM users WHERE id = ${userId} LIMIT 1 FOR UPDATE`;
      if (!locked[0]) throw new AuthError('User not found', 'auth.not_found');
      if (locked[0].status !== 'active') throw new AuthError('Account is unavailable', 'auth.account_frozen');
      const live = await tx<
        Array<{ n: string }>
      >`SELECT count(*)::text AS n FROM sub_accounts WHERE parent_user_id = ${userId} AND revoked = false`;
      const count = Number(live[0]?.n ?? '0');
      if (count >= cap) {
        throw new AuthError(
          `Sub-account limit reached (${cap}). Retire a live partition or raise IDENTITY_MAX_SUB_ACCOUNTS.`,
          'auth.sub_account_limit',
        );
      }
      const rows = await tx<
        Array<{ id: string }>
      >`INSERT INTO sub_accounts (parent_user_id, label, purpose) VALUES (${userId}, ${label}, ${purpose ?? null}) RETURNING id`;
      return rows[0]!;
    });
  }

  async listSubAccounts(
    userId: string,
    limit: number,
  ): Promise<Array<{ id: string; label: string; purpose: string | null; revoked: boolean; createdAt: Date }>> {
    const published = publishedSubAccountsListLimit(limit);
    const rows = await this.sql<
      Array<{ id: string; label: string; purpose: string | null; revoked: boolean; created_at: Date }>
    >`SELECT id, label, purpose, revoked, created_at FROM sub_accounts WHERE parent_user_id = ${userId} ORDER BY created_at DESC LIMIT ${published}`;
    return rows.map((r) => ({ id: r.id, label: r.label, purpose: r.purpose, revoked: r.revoked, createdAt: r.created_at }));
  }

  async revokeSubAccount(userId: string, subAccountId: string): Promise<boolean> {
    const result = await this
      .sql`UPDATE sub_accounts SET revoked = true WHERE id = ${subAccountId} AND parent_user_id = ${userId} AND revoked = false`;
    return result.count > 0;
  }

  async getSubAccountOwnership(subAccountId: string): Promise<{ id: string; parentUserId: string; revoked: boolean } | null> {
    const rows = await this.sql<
      Array<{ id: string; parent_user_id: string; revoked: boolean }>
    >`SELECT id, parent_user_id, revoked FROM sub_accounts WHERE id = ${subAccountId} LIMIT 1`;
    const row = rows[0];
    if (!row) return null;
    return { id: row.id, parentUserId: row.parent_user_id, revoked: row.revoked };
  }

  async assertSubAccountOwned(userId: string, subAccountId: string | null | undefined): Promise<{ id: string; parentUserId: string }> {
    const id = typeof subAccountId === 'string' ? subAccountId.trim() : '';
    if (!id) {
      throw new AuthError(
        'Sub-account id is required — a missing id is a refusal, never a default to primary',
        'auth.sub_account_required',
      );
    }
    const row = await this.getSubAccountOwnership(id);
    if (!row || row.parentUserId !== userId) {
      throw new AuthError('Sub-account not found or not owned by caller', 'auth.sub_account_denied');
    }
    if (row.revoked) {
      throw new AuthError('Sub-account is revoked', 'auth.sub_account_revoked');
    }
    return { id: row.id, parentUserId: row.parentUserId };
  }

  async assertSubAccountTransferDoor(
    userId: string,
    fromSubAccountId: string | null | undefined,
    toSubAccountId: string | null | undefined,
  ): Promise<{ fromId: string; toId: string }> {
    const fromId = typeof fromSubAccountId === 'string' ? fromSubAccountId.trim() : '';
    const toId = typeof toSubAccountId === 'string' ? toSubAccountId.trim() : '';
    if (!fromId || !toId) {
      throw new AuthError(
        'Both from and to sub-account ids are required — a missing id is a refusal, never a default to primary',
        'auth.sub_account_required',
      );
    }
    if (fromId === toId) {
      throw new AuthError('A transfer needs two different sub-accounts', 'auth.sub_account_same');
    }
    const from = await this.assertSubAccountOwned(userId, fromId);
    const to = await this.assertSubAccountOwned(userId, toId);
    return { fromId: from.id, toId: to.id };
  }

  private defaultScopes(): Scope[] {
    return [...SESSION_SCOPES];
  }
}

function asCredentialList(raw: unknown): StoredWebAuthnCredential[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (c): c is StoredWebAuthnCredential =>
      !!c &&
      typeof c === 'object' &&
      typeof (c as StoredWebAuthnCredential).credentialId === 'string' &&
      typeof (c as StoredWebAuthnCredential).publicKey === 'string' &&
      typeof (c as StoredWebAuthnCredential).counter === 'number',
  );
}

function asStringList(raw: unknown): string[] {
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === 'string');
}

function normalizeCredId(id: string): string {
  try {
    return b64urlEncode(b64urlDecode(id));
  } catch {
    return id;
  }
}

function readClientChallenge(clientDataJSONB64: string): string | null {
  try {
    const parsed = JSON.parse(b64urlDecode(clientDataJSONB64).toString('utf8')) as { challenge?: string };
    return typeof parsed.challenge === 'string' ? parsed.challenge : null;
  } catch {
    return null;
  }
}

function mapWebAuthnError(err: unknown): AuthError {
  if (err instanceof WebAuthnError) {
    return new AuthError(err.message, 'auth.webauthn_invalid');
  }
  return new AuthError('Invalid WebAuthn response', 'auth.webauthn_invalid');
}
