import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import type { AccountState } from '@intafaced/contracts';
import { assertDelegatableScopes, issueAccessToken, SESSION_SCOPES, type Scope, type TokenConfig } from '@intafaced/auth';
import type { EventBus } from '@intafaced/events';
import { dummyPasswordHash, generateApiKey, generateToken, hashPassword, hashToken, needsRehash, verifyPassword } from './passwords.js';
import { generateRecoveryCodes, generateSecret, matchTotpStep, totpUri } from './totp.js';
import { encryptTotpSecret, materializeTotpSecret, parseTotpSecretKey } from './totp-crypto.js';
import { apiKeyOriginAllowed } from './api-key-origin.js';
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
      | 'auth.mfa_invalid'
      | 'auth.mfa_already_enrolled'
      | 'auth.session_invalid'
      | 'auth.session_reused'
      | 'auth.not_found'
      /** A KYC record exists but is not in a state an operator can act on. */
      | 'auth.kyc_not_pending'
      /**
       * KYC approve/reject tried to write `reviewed_by` from an agent principal
       * (service caller or API-key token). Approval is an operator action.
       */
      | 'auth.kyc_agent_refused'
      /** Step-up asked for on an account with no second factor to step up with. */
      | 'auth.mfa_not_enrolled'
      /** WebAuthn ceremony failed (bad signature, origin, challenge, counter). */
      | 'auth.webauthn_invalid'
      /** Account has no registered WebAuthn credential for assertion. */
      | 'auth.webauthn_not_enrolled'
      /**
       * API key has a domain whitelist and the request origin is missing or
       * not on it. Empty whitelist stays open (server bots).
       */
      | 'auth.domain_not_allowed'
      /**
       * Ownership / transfer door: a sub-account id was missing or empty.
       * SPEC-SUBACCOUNTS §2 — never default to primary.
       */
      | 'auth.sub_account_required'
      /** Ownership / transfer door: caller does not own the named partition. */
      | 'auth.sub_account_denied'
      /** Ownership / transfer door: partition is soft-revoked. */
      | 'auth.sub_account_revoked'
      /** Transfer door: from and to name the same partition. */
      | 'auth.sub_account_same'
      /**
       * Create refused — live partitions already at the owner-published max
       * (SPEC-SUBACCOUNTS §4 / §8). Unbounded books are an abuse surface.
       */
      | 'auth.sub_account_limit'
      /**
       * Place door: API key id was missing or unknown. Same answer as a
       * foreign guess — no existence oracle (pair with revoked).
       */
      | 'auth.api_key_denied'
      /** Place door: API key is hard-revoked (revoked=true). */
      | 'auth.api_key_revoked'
      /**
       * Place door: session id was missing or unknown. Same answer as a
       * foreign guess — no existence oracle (pair with revoked).
       */
      | 'auth.session_denied'
      /** Place door: session is revoked or expired. */
      | 'auth.session_revoked'
      /**
       * TOTP encrypt-at-rest key missing/invalid. Enrol refuses rather than
       * writing base32 plaintext to users.totp_secret (IDENTITY_TOTP_SECRET_KEY).
       */
      | 'auth.totp_key_missing',
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export type { WebAuthnConfig, StoredWebAuthnCredential };

/**
 * Pin: `reviewed_by` is an operator name. A service caller (`svc-agents`) or
 * an API-key principal (`kid`) is an agent, not a compliance operator — refuse
 * before the UPDATE. Interactive operator sessions omit both.
 */
export function assertOperatorKycReview(input: { service?: string | null; kid?: string | null }): void {
  if (input.service || input.kid) {
    throw new AuthError('KYC review is an operator action — an agent must never write reviewed_by', 'auth.kyc_agent_refused');
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
  /** The operator who granted it. Null on a record nobody has reviewed yet. */
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

/**
 * How long an elevated (step-up) access token lives.
 *
 * Five minutes, and deliberately far shorter than a normal access token: the
 * whole reason `trade:withdraw` is absent from a session's default scopes is so
 * that a stolen token cannot drain an account. An elevation that lasted the
 * full access TTL would hand the thief the same window as the owner.
 */
const STEP_UP_TTL_SECONDS = 300;

/** The only scopes a step-up may add. Not caller-supplied — an elevation endpoint that takes a scope list is a scope-granting endpoint. */
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

/** Conservative live-partition cap until owner publishes IDENTITY_MAX_SUB_ACCOUNTS. */
export const DEFAULT_MAX_SUB_ACCOUNTS = 25;

export class AuthService {
  /**
   * Pending TOTP enrolment (secret_hash + recovery hashes) until confirm (ID-P1-1).
   * Production: Postgres so multi-pod start/confirm works. Injectable for pure unit tests.
   */
  private readonly pendingTotp: PendingTotpEnrolmentStore;

  /** Durable when sql is present (production); injectable for pure unit tests. */
  private readonly challenges: ChallengeStorePort;
  private readonly webauthn: WebAuthnConfig;
  /** 32-byte AES key for totp_secret at rest; null if IDENTITY_TOTP_SECRET_KEY unset/invalid. */
  private readonly totpSecretKey: Buffer | null;

  /**
   * Owner-published live sub-account cap (SPEC-SUBACCOUNTS §4 / §8).
   * Counts non-revoked rows only. Default keeps abuse bounded without inventing
   * a product-tier ladder — ops override via IDENTITY_MAX_SUB_ACCOUNTS.
   */
  private readonly maxSubAccounts: number;

  constructor(
    private readonly sql: Sql,
    private readonly bus: EventBus,
    private readonly rank: RankService,
    private readonly tokens: TokenConfig & { refreshTtlSeconds: number },
    webauthn: WebAuthnConfig = DEFAULT_WEBAUTHN,
    /**
     * Raw env material for TOTP secret encrypt-at-rest (base64 or 64-char hex).
     * Optional so unit/router mocks stay thin; production passes env.IDENTITY_TOTP_SECRET_KEY.
     */
    totpSecretKeyMaterial?: string,
    challenges?: ChallengeStorePort,
    pendingTotp?: PendingTotpEnrolmentStore,
    maxSubAccounts: number = DEFAULT_MAX_SUB_ACCOUNTS,
  ) {
    this.webauthn = webauthn;
    this.totpSecretKey = parseTotpSecretKey(totpSecretKeyMaterial);
    // Production path: Postgres-backed so multi-pod ceremonies complete.
    // Tests may pass ChallengeStore (in-memory) when they do not need durability.
    this.challenges = challenges ?? new SqlChallengeStore(sql, webauthn.challengeTtlMs);
    this.pendingTotp = pendingTotp ?? new SqlPendingTotpEnrolmentStore(sql);
    this.maxSubAccounts = Number.isFinite(maxSubAccounts) && maxSubAccounts >= 1 ? Math.floor(maxSubAccounts) : DEFAULT_MAX_SUB_ACCOUNTS;
  }

  /**
   * Resolve column value to base32 for verifyTotp.
   * Dual-read: enc:v1: decrypts; unprefixed = legacy plaintext (one release).
   */
  private openTotpSecretColumn(stored: string): string {
    try {
      return materializeTotpSecret(this.totpSecretKey, stored);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'TOTP secret unreadable';
      throw new AuthError(msg, 'auth.mfa_invalid');
    }
  }

  // ── Registration ───────────────────────────────────────────────────────────

  async register(input: RegisterInput): Promise<SessionTokens> {
    const passwordHash = await hashPassword(input.password);

    const userId = await transaction(this.sql, async (tx) => {
      const clash = await tx<Array<{ handle: string; email: string }>>`
        SELECT handle, email FROM users WHERE handle = ${input.handle} OR email = ${input.email}
      `;
      for (const row of clash) {
        if (row.handle.toLowerCase() === input.handle.toLowerCase()) {
          throw new AuthError('That handle is taken', 'auth.handle_taken');
        }
        throw new AuthError('An account with that email already exists', 'auth.email_taken');
      }

      const inserted = await tx<Array<{ id: string }>>`
        INSERT INTO users (handle, email, password_hash)
        VALUES (${input.handle}, ${input.email}, ${passwordHash})
        RETURNING id
      `;
      const id = inserted[0]!.id;

      await tx`
        INSERT INTO profiles (user_id, display_name, region)
        VALUES (${id}, ${input.handle}, ${input.region ?? null})
      `;
      await tx`INSERT INTO rank_state (user_id) VALUES (${id})`;

      return id;
    });

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

  // ── Login ──────────────────────────────────────────────────────────────────

  async login(input: { identifier: string; password: string; totpCode?: string; device?: string; ip?: string }): Promise<SessionTokens> {
    const rows = await this.sql<Array<{ id: string; password_hash: string; status: string; totp_secret: string | null }>>`
      SELECT id, password_hash, status, totp_secret FROM users
       WHERE handle = ${input.identifier} OR email = ${input.identifier}
    `;
    const user = rows[0];

    // Do the hash comparison even when there is no user, against a REAL hash of
    // a random string, so an unknown account costs the same time as a wrong
    // password. A hand-written fake would return early and leak the difference.
    const storedHash = user?.password_hash ?? (await dummyPasswordHash());
    const passwordOk = await verifyPassword(storedHash, input.password);

    if (!user || !passwordOk) throw new AuthError('Invalid credentials', 'auth.invalid_credentials');
    if (user.status !== 'active') throw new AuthError(`Account is ${user.status}`, 'auth.account_frozen');

    let mfa = false;
    if (user.totp_secret) {
      if (!input.totpCode) throw new AuthError('Two-factor code required', 'auth.mfa_required');
      // Prefer TOTP (and burn the step). Only when the code is not a valid TOTP
      // do we try a recovery code — so a live TOTP never burns a recovery hash.
      // Column may be enc:v1: — open before matching.
      const secret = this.openTotpSecretColumn(user.totp_secret);
      const totpMatch = matchTotpStep(secret, input.totpCode);
      if (totpMatch !== null) {
        await this.consumeTotpCode(user.id, secret, input.totpCode);
        mfa = true;
      } else {
        const redeemed = await this.tryRedeemRecoveryCode(user.id, input.totpCode);
        if (!redeemed) throw new AuthError('Invalid two-factor code', 'auth.mfa_invalid');
        mfa = true;
      }
    }

    // Opportunistic upgrade: a scrypt hash becomes argon2id on next login, so
    // nobody has to reset a password to benefit from the stronger algorithm.
    if (await needsRehash(user.password_hash)) {
      const upgraded = await hashPassword(input.password);
      await this.sql`UPDATE users SET password_hash = ${upgraded}, updated_at = now() WHERE id = ${user.id}`;
    }

    return this.issueSession(user.id, { device: input.device, ip: input.ip, mfa });
  }

  // ── Sessions ───────────────────────────────────────────────────────────────

  private async issueSession(
    userId: string,
    options: { device?: string | undefined; ip?: string | undefined; mfa: boolean },
  ): Promise<SessionTokens> {
    const refreshToken = generateToken(48);
    const expiresAt = new Date(Date.now() + this.tokens.refreshTtlSeconds * 1000);

    const inserted = await this.sql<Array<{ id: string }>>`
      INSERT INTO sessions (user_id, refresh_hash, device, ip, mfa, expires_at)
      VALUES (${userId}, ${hashToken(refreshToken)}, ${options.device ?? null}, ${options.ip ?? null}, ${options.mfa}, ${expiresAt})
      RETURNING id
    `;
    const sessionId = inserted[0]!.id;
    void syncNavigatorSessionOpen(this.sql, sessionId, userId);

    const tier = await this.kycTier(userId);

    const { token: accessToken, expiresAt: accessExpiresAt } = await issueAccessToken(
      { userId, sessionId, scopes: this.defaultScopes(), tier, mfa: options.mfa },
      this.tokens,
    );

    return { accessToken, refreshToken, expiresAt: accessExpiresAt, sessionId, userId, mfaRequired: false };
  }

  /**
   * Refresh with rotation.
   *
   * The old token is invalidated the moment it is used. If a rotated token is
   * presented again, that means two parties hold it — the original holder and
   * a thief — so every session for that user is revoked immediately. Losing a
   * login is a far better outcome than an undetected account takeover.
   */
  async refresh(refreshToken: string, options: { device?: string; ip?: string } = {}): Promise<SessionTokens> {
    const hash = hashToken(refreshToken);

    /** Explicit, so `in` narrows rather than the generic collapsing the union. */
    type RefreshOutcome =
      | { kind: 'reuse'; userId: string; sessionId: string }
      | { kind: 'frozen'; userId: string; sessionId: string; status: string }
      | { kind: 'expired'; sessionId: string }
      | { kind: 'rotated'; previousSessionId: string; tokens: SessionTokens };

    const result = await transaction<RefreshOutcome>(this.sql, async (tx) => {
      // Join users so status is locked with the session row (ID-P1-2).
      const rows = await tx<Array<{ id: string; user_id: string; revoked: boolean; mfa: boolean; expires_at: Date; user_status: string }>>`
        SELECT s.id, s.user_id, s.revoked, s.mfa, s.expires_at, u.status AS user_status
          FROM sessions s
          JOIN users u ON u.id = s.user_id
         WHERE s.refresh_hash = ${hash}
         FOR UPDATE OF s, u
      `;
      const session = rows[0];
      if (!session) throw new AuthError('Session not found', 'auth.session_invalid');

      // Reuse of a rotated token.
      //
      // The revocation must NOT happen in this transaction: throwing from
      // inside would roll it back, so the thief's replay would revoke nothing.
      // Report it, commit, and burn the sessions outside.
      if (session.revoked) return { kind: 'reuse', userId: session.user_id, sessionId: session.id };

      if (session.expires_at.getTime() < Date.now()) {
        await tx`UPDATE sessions SET revoked = true WHERE id = ${session.id}`;
        return { kind: 'expired', sessionId: session.id };
      }

      // Mirror login / ifc_ exchange: frozen or closed accounts must not mint new
      // access tokens from a still-valid refresh (ID-P1-2).
      if (session.user_status !== 'active') {
        await tx`UPDATE sessions SET revoked = true WHERE id = ${session.id}`;
        // Throw AFTER the update, but AuthError inside sql.begin aborts the txn —
        // so return a dedicated outcome and revoke + throw outside, same as reuse.
        return { kind: 'frozen', userId: session.user_id, sessionId: session.id, status: session.user_status };
      }

      await tx`UPDATE sessions SET revoked = true, last_used_at = now() WHERE id = ${session.id}`;

      const nextToken = generateToken(48);
      const expiresAt = new Date(Date.now() + this.tokens.refreshTtlSeconds * 1000);
      const nextSession = await tx<Array<{ id: string }>>`
        INSERT INTO sessions (user_id, refresh_hash, device, ip, mfa, expires_at)
        VALUES (
          ${session.user_id}, ${hashToken(nextToken)}, ${options.device ?? null},
          ${options.ip ?? null}, ${session.mfa}, ${expiresAt}
        )
        RETURNING id
      `;
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
      // Committed separately, so it survives the error we are about to raise.
      // Losing every session is the correct outcome: two parties hold a token
      // that only one should, and we cannot tell which one is the owner.
      await this.sql`
        UPDATE sessions
           SET revoked = true, reuse_detected_at = now()
         WHERE user_id = ${result.userId} AND revoked = false
      `;
      await this.sql`UPDATE sessions SET reuse_detected_at = now() WHERE id = ${result.sessionId}`;
      await syncNavigatorSessionsClosedForUser(this.sql, result.userId);
      throw new AuthError('Refresh token reuse detected — all sessions revoked', 'auth.session_reused');
    }

    if (result.kind === 'frozen') {
      // Committed: presented session is dead so a thaw cannot reuse this refresh.
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
    const rows = await this.sql<Array<{ id: string }>>`
      SELECT id FROM sessions WHERE refresh_hash = ${hash} LIMIT 1
    `;
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
   * S2S ownership read for money services (place gate).
   *
   * Returns the row even when revoked so the caller can distinguish "missing"
   * from "revoked". No scopes, no jurisdiction or tier.
   */
  async getSessionOwnership(sessionId: string): Promise<{ id: string; userId: string; revoked: boolean } | null> {
    const rows = await this.sql<Array<{ id: string; user_id: string; revoked: boolean }>>`
      SELECT id, user_id, revoked
        FROM sessions
       WHERE id = ${sessionId}
       LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return { id: row.id, userId: row.user_id, revoked: row.revoked };
  }

  /**
   * PLACE DOOR for one session.
   *
   * A revoked or expired session must not pass — it cannot place, and its
   * private stream/COD must not keep firing as live. Fail-closed:
   *   - missing / empty / unknown id → denied (no existence oracle)
   *   - revoked or expired → revoked
   */
  async assertSessionLive(sessionId: string): Promise<{ id: string; userId: string }> {
    const id = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!id) {
      throw new AuthError('Session not found', 'auth.session_denied');
    }

    const rows = await this.sql<Array<{ id: string; user_id: string; revoked: boolean; expires_at: Date }>>`
      SELECT id, user_id, revoked, expires_at
        FROM sessions
       WHERE id = ${id}
       LIMIT 1
    `;
    const row = rows[0];
    if (!row) {
      throw new AuthError('Session not found', 'auth.session_denied');
    }
    if (row.revoked || row.expires_at.getTime() < Date.now()) {
      throw new AuthError('Session is revoked', 'auth.session_revoked');
    }

    return { id: row.id, userId: row.user_id };
  }

  // ── TOTP ───────────────────────────────────────────────────────────────────

  /**
   * Consume one recovery code if its hash is present. Returns true when burned.
   */
  private async tryRedeemRecoveryCode(userId: string, code: string): Promise<boolean> {
    const hash = hashToken(code.trim());
    return transaction(this.sql, async (tx) => {
      const rows = await tx<Array<{ recovery_code_hashes: unknown }>>`
        SELECT recovery_code_hashes FROM users WHERE id = ${userId} FOR UPDATE
      `;
      const hashes = asStringList(rows[0]?.recovery_code_hashes);
      const idx = hashes.indexOf(hash);
      if (idx < 0) return false;
      const next = hashes.slice(0, idx).concat(hashes.slice(idx + 1));
      await tx`
        UPDATE users
           SET recovery_code_hashes = ${tx.json(next as never)}, updated_at = now()
         WHERE id = ${userId}
      `;
      return true;
    });
  }

  /**
   * Verify a TOTP code and burn its counter step so it cannot be replayed.
   *
   * Under FOR UPDATE so two concurrent uses of the same code cannot both pass.
   * Same shape as recovery-code redeem: match → refuse if step ≤ last → advance.
   */
  private async consumeTotpCode(userId: string, secret: string, code: string, at?: Date): Promise<void> {
    const matched = matchTotpStep(secret, code, at ? { at } : {});
    if (matched === null) {
      throw new AuthError('Invalid two-factor code', 'auth.mfa_invalid');
    }

    await transaction(this.sql, async (tx) => {
      const rows = await tx<Array<{ totp_last_step: string | number | bigint | null }>>`
        SELECT totp_last_step FROM users WHERE id = ${userId} FOR UPDATE
      `;
      if (!rows[0]) throw new AuthError('User not found', 'auth.not_found');

      const lastRaw = rows[0].totp_last_step;
      const lastStep = lastRaw === null || lastRaw === undefined ? null : BigInt(lastRaw);
      if (lastStep !== null && matched <= lastStep) {
        throw new AuthError('Invalid two-factor code', 'auth.mfa_invalid');
      }

      await tx`
        UPDATE users
           SET totp_last_step = ${matched.toString()}, updated_at = now()
         WHERE id = ${userId}
      `;
    });
  }

  async startTotpEnrolment(userId: string): Promise<{ secret: string; uri: string; recoveryCodes: string[] }> {
    // Refuse before inventing a secret the confirm path cannot seal.
    if (!this.totpSecretKey) {
      throw new AuthError(
        'IDENTITY_TOTP_SECRET_KEY is not set to a 32-byte key (base64 or hex) — cannot enrol TOTP',
        'auth.totp_key_missing',
      );
    }

    const rows = await this.sql<Array<{ email: string; totp_secret: string | null }>>`
      SELECT email, totp_secret FROM users WHERE id = ${userId}
    `;
    const user = rows[0];
    if (!user) throw new AuthError('User not found', 'auth.not_found');
    if (user.totp_secret) throw new AuthError('Two-factor is already enrolled', 'auth.mfa_already_enrolled');

    const secret = generateSecret();
    const recoveryCodes = generateRecoveryCodes();
    // Hold secret_hash + recovery hashes until confirm (durable multi-pod store).
    // Plaintext codes return once; hashes land on the user only after a valid TOTP
    // proves enrolment (ID-P1-1). Base32 secret is never stored pending — only hashed.
    await this.pendingTotp.put(
      userId,
      hashToken(secret),
      recoveryCodes.map((c) => hashToken(c)),
    );

    // The secret is NOT written to users.totp_secret yet — only a confirmed code
    // proves the user actually scanned it. Storing it now would lock out anyone
    // who abandoned enrolment halfway.
    return { secret, uri: totpUri(secret, user.email), recoveryCodes };
  }

  async confirmTotpEnrolment(userId: string, secret: string, code: string): Promise<void> {
    const matched = matchTotpStep(secret, code);
    if (matched === null) throw new AuthError('Invalid two-factor code', 'auth.mfa_invalid');

    // Never write base32 plaintext to totp_secret — refuse enrol if key missing
    // (before take so a missing key does not burn a valid pending session).
    if (!this.totpSecretKey) {
      throw new AuthError(
        'IDENTITY_TOTP_SECRET_KEY is not set to a 32-byte key (base64 or hex) — cannot enrol TOTP',
        'auth.totp_key_missing',
      );
    }

    // Single-use take across pods; wrong secret leaves the row for a real confirm.
    const pending = await this.pendingTotp.takeIfSecretHash(userId, hashToken(secret));
    if (!pending) {
      throw new AuthError('TOTP enrolment session expired or secret mismatch — start enrolment again', 'auth.mfa_invalid');
    }
    const sealed = encryptTotpSecret(this.totpSecretKey, secret);

    // Seed totp_last_step with the confirm code so that same code cannot be
    // immediately reused for login / step-up inside the same window.
    await this.sql`
      UPDATE users
         SET totp_secret = ${sealed},
             totp_enrolled_at = now(),
             totp_last_step = ${matched.toString()},
             recovery_code_hashes = ${this.sql.json(pending.recoveryHashes as never)},
             updated_at = now()
       WHERE id = ${userId} AND totp_secret IS NULL
    `;

    await this.rank.awardXp({
      userId,
      sourceModule: 'identity',
      action: 'identity.totp.enrolled',
      xpDelta: 100,
      idempotencyKey: `identity.totp.enrolled:${userId}`,
    });
  }

  // ── WebAuthn ───────────────────────────────────────────────────────────────

  /**
   * Step 1 of enrolment: options for `navigator.credentials.create()`.
   *
   * The challenge is held in the durable challenge store until
   * `confirmWebauthnRegistration` consumes it (single-use, TTL). Mirrors TOTP —
   * nothing is persisted on the user until the ceremony proves the authenticator
   * holds the private key. Multi-pod: put/take share Postgres.
   */
  async startWebauthnRegistration(userId: string): Promise<RegistrationOptionsJSON> {
    const rows = await this.sql<Array<{ email: string; handle: string; webauthn_creds: StoredWebAuthnCredential[] }>>`
      SELECT email, handle, webauthn_creds FROM users WHERE id = ${userId}
    `;
    const user = rows[0];
    if (!user) throw new AuthError('User not found', 'auth.not_found');

    const existing = asCredentialList(user.webauthn_creds);
    const challenge = generateChallenge();
    await this.challenges.put('registration', challenge, userId);

    return createRegistrationOptions(this.webauthn, { id: userId, name: user.email, displayName: user.handle }, existing, challenge);
  }

  /**
   * Step 2 of enrolment: verify the authenticator attestation and persist the
   * public key. Attestation format is restricted to `none` (see webauthn.ts).
   */
  async confirmWebauthnRegistration(userId: string, response: RegistrationResponseJSON): Promise<{ credentialId: string }> {
    const rows = await this.sql<Array<{ webauthn_creds: StoredWebAuthnCredential[] }>>`
      SELECT webauthn_creds FROM users WHERE id = ${userId}
    `;
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

    const existing = asCredentialList(user.webauthn_creds);
    if (existing.some((c) => c.credentialId === stored.credentialId)) {
      throw new AuthError('That authenticator is already registered', 'auth.webauthn_invalid');
    }

    const next = [...existing, stored];
    await this.sql`
      UPDATE users
         SET webauthn_creds = ${this.sql.json(next as never)}, updated_at = now()
       WHERE id = ${userId}
    `;

    // First credential only — re-enrolling a second key must not re-pay XP.
    if (existing.length === 0) {
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

  /**
   * Step 1 of passwordless login: options for `navigator.credentials.get()`.
   *
   * Always returns options (with an empty allow list when the account has no
   * credentials) so the shape of the response does not enumerate who is
   * enrolled. The matching challenge is only redeemable for the user we found.
   */
  async startWebauthnAuthentication(identifier: string): Promise<AuthenticationOptionsJSON> {
    const rows = await this.sql<Array<{ id: string; status: string; webauthn_creds: StoredWebAuthnCredential[] }>>`
      SELECT id, status, webauthn_creds FROM users
       WHERE handle = ${identifier} OR email = ${identifier}
    `;
    const user = rows[0];
    const challenge = generateChallenge();
    const creds = user && user.status === 'active' ? asCredentialList(user.webauthn_creds) : [];

    // Challenge is bound to the user when we found one; otherwise it is stored
    // against null and can never issue a session. Durable store so another pod
    // can complete the assertion.
    await this.challenges.put('authentication', challenge, user?.status === 'active' ? user.id : null);

    return createAuthenticationOptions(this.webauthn, creds, challenge);
  }

  /**
   * Step 2 of passwordless login: verify the assertion and issue a session.
   *
   * A successful assertion is treated as MFA — the authenticator is the second
   * factor (and, when used passwordlessly, the only factor that mattered).
   */
  async confirmWebauthnAuthentication(
    identifier: string,
    response: AuthenticationResponseJSON,
    options: { device?: string; ip?: string } = {},
  ): Promise<SessionTokens> {
    const rows = await this.sql<Array<{ id: string; status: string; webauthn_creds: StoredWebAuthnCredential[] }>>`
      SELECT id, status, webauthn_creds FROM users
       WHERE handle = ${identifier} OR email = ${identifier}
    `;
    const user = rows[0];
    if (!user) throw new AuthError('Invalid credentials', 'auth.invalid_credentials');
    if (user.status !== 'active') throw new AuthError(`Account is ${user.status}`, 'auth.account_frozen');

    const clientChallenge = readClientChallenge(response.response.clientDataJSON);
    if (!clientChallenge) throw new AuthError('Invalid credentials', 'auth.invalid_credentials');

    const held = await this.challenges.take(clientChallenge, 'authentication');
    if (!held || held.userId !== user.id) {
      throw new AuthError('Invalid credentials', 'auth.invalid_credentials');
    }

    const creds = asCredentialList(user.webauthn_creds);
    if (creds.length === 0) throw new AuthError('No security key enrolled', 'auth.webauthn_not_enrolled');

    const responseId = normalizeCredId(response.id);
    const credential = creds.find((c) => c.credentialId === responseId);
    if (!credential) throw new AuthError('Invalid credentials', 'auth.invalid_credentials');

    let newCounter: number;
    try {
      ({ newCounter } = verifyAuthenticationResponse(this.webauthn, held.challenge, credential, response));
    } catch (err) {
      // Do not distinguish signature failures from unknown credentials on the
      // login path — same reason a wrong password and an unknown account share
      // one error code.
      if (err instanceof WebAuthnError) throw new AuthError('Invalid credentials', 'auth.invalid_credentials');
      throw err;
    }

    const next = creds.map((c) => (c.credentialId === credential.credentialId ? { ...c, counter: newCounter } : c));
    await this.sql`
      UPDATE users
         SET webauthn_creds = ${this.sql.json(next as never)}, updated_at = now()
       WHERE id = ${user.id}
    `;

    return this.issueSession(user.id, { device: options.device, ip: options.ip, mfa: true });
  }

  async listWebauthnCredentials(userId: string): Promise<Array<{ credentialId: string; createdAt: string; transports?: string[] }>> {
    const rows = await this.sql<Array<{ webauthn_creds: StoredWebAuthnCredential[] }>>`
      SELECT webauthn_creds FROM users WHERE id = ${userId}
    `;
    if (!rows[0]) throw new AuthError('User not found', 'auth.not_found');
    return asCredentialList(rows[0].webauthn_creds).map((c) => ({
      credentialId: c.credentialId,
      createdAt: c.createdAt,
      ...(c.transports ? { transports: c.transports } : {}),
    }));
  }

  /**
   * Drop one enrolled authenticator. Self-only; missing id → false (same shape
   * as revokeApiKey — never confirm whether a foreign id existed).
   *
   * Lost/stolen keys had no retire path; listing alone is not a lifecycle.
   */
  async removeWebauthnCredential(userId: string, credentialId: string): Promise<boolean> {
    const target = normalizeCredId(credentialId);
    return transaction(this.sql, async (tx) => {
      const rows = await tx<Array<{ webauthn_creds: unknown }>>`
        SELECT webauthn_creds FROM users WHERE id = ${userId} FOR UPDATE
      `;
      if (!rows[0]) throw new AuthError('User not found', 'auth.not_found');
      const creds = asCredentialList(rows[0].webauthn_creds);
      const next = creds.filter((c) => c.credentialId !== target);
      if (next.length === creds.length) return false;
      await tx`
        UPDATE users
           SET webauthn_creds = ${tx.json(next as never)}, updated_at = now()
         WHERE id = ${userId}
      `;
      return true;
    });
  }

  /**
   * WebAuthn ceremony for step-up (withdraw elevation). Bound to the live user;
   * challenge kind is `step-up` so a login assertion cannot be replayed here.
   */
  async startWebauthnStepUp(userId: string) {
    const rows = await this.sql<Array<{ id: string; status: string; webauthn_creds: StoredWebAuthnCredential[] }>>`
      SELECT id, status, webauthn_creds FROM users WHERE id = ${userId}
    `;
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

  // ── API keys ───────────────────────────────────────────────────────────────

  /**
   * Mint an API key on behalf of the session that asked for one.
   *
   * `grantorScopes` is required, and that is the whole point of this signature.
   * The scope array arrives from the request body, and before this it was only
   * checked against INTERACTIVE_ONLY_SCOPES and then stored verbatim — so any
   * logged-in account could ask for a key bearing `admin:compliance`, use it to
   * approve its own KYC record to `institutional`, and clear the tier gate on
   * every custodial module in the OS. Self-verification does not move value off
   * the platform, so the only check in the path had no reason to object.
   *
   * A key is a delegation. It cannot carry authority its grantor never held.
   */
  async createApiKey(input: {
    userId: string;
    name: string;
    scopes: string[];
    grantorScopes: readonly string[];
    domainWhitelist?: string[];
    expiresAt?: Date;
    /** pay.public-api step 4 — sandbox keys route to the sandbox rail. Default live. */
    mode?: 'live' | 'sandbox';
  }): Promise<{ id: string; key: string; prefix: string; mode: 'live' | 'sandbox' }> {
    // §9: a long-lived key must never move value off the platform, must name
    // real scopes, and must never exceed the session that created it.
    assertDelegatableScopes(input.scopes, input.grantorScopes);

    const mode = input.mode === 'sandbox' ? 'sandbox' : 'live';
    const { key, hash, prefix } = generateApiKey(mode);
    const rows = await this.sql<Array<{ id: string }>>`
      INSERT INTO api_keys (user_id, name, key_hash, key_prefix, scopes, domain_whitelist, expires_at, mode)
      VALUES (
        ${input.userId}, ${input.name}, ${hash}, ${prefix},
        ${input.scopes}, ${input.domainWhitelist ?? []}, ${input.expiresAt ?? null}, ${mode}
      )
      RETURNING id
    `;

    // Returned once. There is no endpoint that can retrieve it again.
    return { id: rows[0]!.id, key, prefix, mode };
  }

  async verifyApiKey(key: string): Promise<{
    userId: string;
    scopes: string[];
    keyId: string;
    mode: 'live' | 'sandbox';
    domainWhitelist: string[];
  } | null> {
    const rows = await this.sql<
      Array<{
        id: string;
        user_id: string;
        scopes: string[];
        expires_at: Date | null;
        mode: string | null;
        domain_whitelist: string[] | null;
      }>
    >`
      SELECT id, user_id, scopes, expires_at, mode, domain_whitelist FROM api_keys
       WHERE key_hash = ${hashToken(key)} AND revoked = false
    `;
    const row = rows[0];
    if (!row) return null;
    if (row.expires_at && row.expires_at.getTime() < Date.now()) return null;

    await this.sql`UPDATE api_keys SET last_used_at = now() WHERE id = ${row.id}`;
    const mode: 'live' | 'sandbox' = row.mode === 'sandbox' ? 'sandbox' : 'live';
    return {
      userId: row.user_id,
      scopes: row.scopes,
      keyId: row.id,
      mode,
      domainWhitelist: row.domain_whitelist ?? [],
    };
  }

  /**
   * Turn a long-lived API key into a short-lived access JWT the edge already
   * accepts (§9 Public API).
   *
   * Until this existed, `create`/`list`/`revoke` worked and `verifyApiKey` was
   * only called from tests — a key could be issued and never open a door.
   * Exchange is that door: bots call it, receive a bearer access token scoped
   * exactly as the key, then hit the rest of the platform through svc-edge.
   *
   * No refresh token. API keys are not interactive sessions; when the access
   * token expires the bot re-exchanges. `mfa` is always false — interactive-
   * only scopes (withdraw, treasury, …) remain unreachable from a key even if
   * someone smuggled them into the key row (create already refuses them via
   * assertDelegatableScopes + INTERACTIVE_ONLY).
   */
  async exchangeApiKey(
    key: string,
    /**
     * Browser `Origin` (or edge-forwarded equivalent). Required when the key
     * carries a non-empty domain_whitelist. Server bots leave the list empty.
     */
    requestOrigin?: string | null,
  ): Promise<{
    accessToken: string;
    expiresAt: Date;
    userId: string;
    keyId: string;
    scopes: string[];
    mode: 'live' | 'sandbox';
  }> {
    const verified = await this.verifyApiKey(key);
    if (!verified) throw new AuthError('Invalid credentials', 'auth.invalid_credentials');

    if (!apiKeyOriginAllowed(verified.domainWhitelist, requestOrigin)) {
      throw new AuthError('API key is not allowed from this origin', 'auth.domain_not_allowed');
    }

    const users = await this.sql<Array<{ status: string }>>`
      SELECT status FROM users WHERE id = ${verified.userId}
    `;
    const user = users[0];
    if (!user) throw new AuthError('Account not found', 'auth.not_found');
    if (user.status !== 'active') throw new AuthError(`Account is ${user.status}`, 'auth.account_frozen');

    const tier = await this.kycTier(verified.userId);
    // sessionId = key id: access tokens require a sid claim; there is no
    // refresh session row for API-key traffic.
    // key_env rides on the short JWT so pay.public-api can route sandbox vs
    // live without a second identity round-trip (ADR §2.5 step 4).
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

    return {
      accessToken,
      expiresAt,
      userId: verified.userId,
      keyId: verified.keyId,
      scopes: verified.scopes,
      mode: verified.mode,
    };
  }

  async revokeApiKey(userId: string, keyId: string): Promise<boolean> {
    const result = await this.sql`
      UPDATE api_keys SET revoked = true WHERE id = ${keyId} AND user_id = ${userId} AND revoked = false
    `;
    return result.count > 0;
  }

  /**
   * S2S ownership read for money services (place gate).
   *
   * Returns the row even when revoked so the caller can distinguish "missing"
   * from "revoked". Scopes are not in this snapshot — revoke is a hard flag,
   * not a flatten, and S2S must not leak them.
   */
  async getApiKeyOwnership(keyId: string): Promise<{ id: string; userId: string; revoked: boolean } | null> {
    const rows = await this.sql<Array<{ id: string; user_id: string; revoked: boolean }>>`
      SELECT id, user_id, revoked
        FROM api_keys
       WHERE id = ${keyId}
       LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return { id: row.id, userId: row.user_id, revoked: row.revoked };
  }

  /**
   * PLACE DOOR for one API key.
   *
   * A revoked key must not pass — it cannot be exchanged into a principal
   * that could place. Fail-closed:
   *   - missing / empty / unknown id → denied (no existence oracle)
   *   - revoked → revoked
   *
   * Does not write scopes. Revoke stays a hard flag.
   */
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

  async listApiKeys(userId: string) {
    return this.sql<
      Array<{
        id: string;
        name: string;
        key_prefix: string;
        scopes: string[];
        last_used_at: Date | null;
        revoked: boolean;
        mode: string;
      }>
    >`
      SELECT id, name, key_prefix, scopes, last_used_at, revoked, mode FROM api_keys
       WHERE user_id = ${userId} ORDER BY created_at DESC
    `;
  }

  // ── KYC ────────────────────────────────────────────────────────────────────

  /** Highest approved, unexpired tier. Anything else is `none`. */
  async kycTier(userId: string, sql: Sql = this.sql): Promise<'none' | 'basic' | 'full' | 'institutional'> {
    const rows = await sql<Array<{ tier: 'basic' | 'full' | 'institutional' }>>`
      SELECT tier FROM kyc_records
       WHERE user_id = ${userId} AND status = 'approved' AND (expires_at IS NULL OR expires_at > now())
    `;
    const order = { basic: 1, full: 2, institutional: 3 } as const;
    let best: 'none' | 'basic' | 'full' | 'institutional' = 'none';
    for (const row of rows) {
      if (best === 'none' || order[row.tier] > order[best as 'basic' | 'full' | 'institutional']) best = row.tier;
    }
    return best;
  }

  /**
   * ACCOUNT STATE for another service to READ (`accountStateSchema`).
   *
   * `users.status` has been read internally by nine call sites in this file
   * since the beginning and returned by none of them. That is why the support
   * desk had no way to know an account was frozen: the fact existed, was
   * authoritative, and was not reachable from outside this service — so the only
   * way for another service to have it was to keep a copy, which is the thing
   * that must not happen for a fact this consequential.
   *
   * THREE FIELDS, AND THE SHORTNESS IS THE POINT. `status` and the derived KYC
   * tier answer "can this person use the platform" and "how far are they
   * verified". Nothing else is returned, so this cannot become the seam through
   * which the encrypted KYC vault (a688e231) or a legal name leaks into a
   * support ticket. §10 keeps documents in one place; this keeps that true by
   * having nowhere to put one.
   *
   * `null` for an unknown user — the caller renders that as "not read", never as
   * an account in good standing.
   */
  async accountState(userId: string): Promise<AccountState | null> {
    const rows = await this.sql<Array<{ id: string; status: 'active' | 'frozen' | 'closed' }>>`
      SELECT id, status FROM users WHERE id = ${userId} LIMIT 1
    `;
    const user = rows[0];
    if (!user) return null;
    return { userId: user.id, status: user.status, kycTier: await this.kycTier(user.id) };
  }

  /**
   * A user asks to be verified at a tier. Nothing is granted here.
   *
   * The record lands `pending` and only an operator holding `admin:compliance`
   * can move it to `approved` — which is the whole point of splitting submit
   * from approve. A single "setKycTier" would be a procedure that grants its own
   * caller access to every custodial module, and no scope check makes that safe.
   *
   * Idempotent on (user, tier), serialised on the user row rather than on a
   * unique index: two taps on a slow "Verify me" button must not produce two
   * pending records for one operator to adjudicate, and `kyc_records` carries no
   * constraint that would stop them.
   */
  async submitKyc(input: { userId: string; tier: SubmittableKycTier; jurisdiction: string; providerRef?: string }): Promise<KycRecordView> {
    return transaction(this.sql, async (tx) => {
      const users = await tx<Array<{ id: string }>>`SELECT id FROM users WHERE id = ${input.userId} FOR UPDATE`;
      if (!users[0]) throw new AuthError('User not found', 'auth.not_found');

      // An approved, unexpired record at this tier or higher already answers the
      // request. Re-submitting must not reset anyone to `pending` — that would
      // let a user drop their own tier and, worse, make it look reviewable again.
      const existing = await tx<KycRow[]>`
        SELECT id, user_id, tier, jurisdiction, provider_ref, status, reviewed_by, reviewed_at, expires_at, created_at FROM kyc_records
         WHERE user_id = ${input.userId}
           AND (
             (status = 'approved' AND (expires_at IS NULL OR expires_at > now()))
             OR (status = 'pending' AND tier = ${input.tier})
           )
         ORDER BY created_at DESC
      `;

      const approved = existing.find((r) => r.status === 'approved' && TIER_ORDER[r.tier] >= TIER_ORDER[input.tier]);
      if (approved) return toKycRecord(approved);

      const pending = existing.find((r) => r.status === 'pending');
      if (pending) return toKycRecord(pending);

      const inserted = await tx<KycRow[]>`
        INSERT INTO kyc_records (user_id, tier, jurisdiction, provider_ref, status)
        VALUES (${input.userId}, ${input.tier}, ${input.jurisdiction}, ${input.providerRef ?? null}, 'pending')
        RETURNING id, user_id, tier, jurisdiction, provider_ref, status, reviewed_by, reviewed_at, expires_at, created_at
      `;
      return toKycRecord(inserted[0]!);
    });
  }

  /** Every record for one user, newest first. What `kyc.status` renders. */
  async listKycRecords(userId: string): Promise<KycRecordView[]> {
    const rows = await this.sql<KycRow[]>`
      SELECT id, user_id, tier, jurisdiction, provider_ref, status, reviewed_by, reviewed_at, expires_at, created_at FROM kyc_records
       WHERE user_id = ${userId} ORDER BY created_at DESC
    `;
    return rows.map(toKycRecord);
  }

  /** The operator review queue — oldest first, because a queue that is not FIFO is a backlog. */
  async listPendingKyc(limit = 50): Promise<KycRecordView[]> {
    const rows = await this.sql<KycRow[]>`
      SELECT id, user_id, tier, jurisdiction, provider_ref, status, reviewed_by, reviewed_at, expires_at, created_at
        FROM kyc_records
       WHERE status = 'pending' ORDER BY created_at ASC LIMIT ${limit}
    `;
    return rows.map(toKycRecord);
  }

  async getKycRecord(recordId: string): Promise<KycRecordView | null> {
    const rows = await this.sql<KycRow[]>`
      SELECT id, user_id, tier, jurisdiction, provider_ref, status, reviewed_by, reviewed_at, expires_at, created_at FROM kyc_records WHERE id = ${recordId}
    `;
    return rows[0] ? toKycRecord(rows[0]) : null;
  }

  /**
   * THE OPERATOR ACTION. A pending record becomes an approved tier.
   *
   * This is the single most consequential write in this service: the tier it
   * sets is what `checkAccess` reads, so approving a record is granting access
   * to every custodial module in the OS. `reviewed_by` is therefore not
   * decoration — it is the only record of who made that grant.
   *
   * Idempotent: approving an already-approved record returns it and re-announces
   * nothing new, because both the event and the XP award carry business keys.
   */
  async approveKycRecord(input: {
    recordId: string;
    reviewerId: string;
    expiresAt?: Date | null;
    service?: string | null;
    kid?: string | null;
  }): Promise<KycRecordView> {
    assertOperatorKycReview({ service: input.service, kid: input.kid });
    const outcome = await transaction(this.sql, async (tx) => {
      const rows = await tx<KycRow[]>`
        SELECT id, user_id, tier, jurisdiction, provider_ref, status, reviewed_by, reviewed_at, expires_at, created_at FROM kyc_records WHERE id = ${input.recordId} FOR UPDATE
      `;
      const row = rows[0];
      if (!row) throw new AuthError('KYC record not found', 'auth.not_found');
      if (row.status === 'approved') return { record: toKycRecord(row), granted: false };
      if (row.status !== 'pending') {
        throw new AuthError(`KYC record is ${row.status}; only a pending record can be approved`, 'auth.kyc_not_pending');
      }

      const updated = await tx<KycRow[]>`
        UPDATE kyc_records
           SET status = 'approved', reviewed_at = now(), reviewed_by = ${input.reviewerId},
               expires_at = ${input.expiresAt ?? null}
         WHERE id = ${row.id}
        RETURNING id, user_id, tier, jurisdiction, provider_ref, status, reviewed_by, reviewed_at, expires_at, created_at
      `;
      return { record: toKycRecord(updated[0]!), granted: true };
    });

    // Announced AFTER the transaction commits, and only when a grant actually
    // happened. Publishing from inside would emit "tier granted" from a
    // transaction that may still roll back; publishing on the no-op path would
    // re-announce a grant that is already old news, and the bus is at-least-once
    // in the other direction already.
    if (outcome.granted) await this.announceKycApproval(outcome.record);
    return outcome.record;
  }

  /** Reject a pending record. No tier is granted, nothing is announced. */
  async rejectKycRecord(input: {
    recordId: string;
    reviewerId: string;
    service?: string | null;
    kid?: string | null;
  }): Promise<KycRecordView> {
    assertOperatorKycReview({ service: input.service, kid: input.kid });
    return transaction(this.sql, async (tx) => {
      const rows = await tx<KycRow[]>`
        SELECT id, user_id, tier, jurisdiction, provider_ref, status, reviewed_by, reviewed_at, expires_at, created_at FROM kyc_records WHERE id = ${input.recordId} FOR UPDATE
      `;
      const row = rows[0];
      if (!row) throw new AuthError('KYC record not found', 'auth.not_found');
      if (row.status === 'rejected') return toKycRecord(row);
      if (row.status !== 'pending') {
        throw new AuthError(`KYC record is ${row.status}; only a pending record can be rejected`, 'auth.kyc_not_pending');
      }

      const updated = await tx<KycRow[]>`
        UPDATE kyc_records
           SET status = 'rejected', reviewed_at = now(), reviewed_by = ${input.reviewerId}
         WHERE id = ${row.id}
        RETURNING id, user_id, tier, jurisdiction, provider_ref, status, reviewed_by, reviewed_at, expires_at, created_at
      `;
      return toKycRecord(updated[0]!);
    });
  }

  /**
   * Direct grant, with no reviewable record in front of it.
   *
   * Kept for seeding and for tests that need a verified user without driving the
   * operator flow. It is exposed on NO route on purpose — the routed path is
   * `submitKyc` → `approveKycRecord`, so that every tier granted in production
   * carries a `reviewed_by`.
   */
  async approveKyc(input: { userId: string; tier: SubmittableKycTier; jurisdiction: string; providerRef?: string }): Promise<void> {
    await this.sql`
      INSERT INTO kyc_records (user_id, tier, jurisdiction, provider_ref, status, reviewed_at)
      VALUES (${input.userId}, ${input.tier}, ${input.jurisdiction}, ${input.providerRef ?? null}, 'approved', now())
    `;

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

  // ── Step-up ────────────────────────────────────────────────────────────────

  /**
   * Trade a live session plus a fresh TOTP (or single-use recovery) code for a
   * SHORT-LIVED token that carries `trade:withdraw`.
   *
   * This exists because `defaultScopes()` deliberately withholds
   * `trade:withdraw` — "added only after a step-up challenge" — and until now
   * there was no step-up challenge, which made every withdrawal surface in the
   * OS unreachable by any real session. A guard nothing can satisfy is not a
   * guard; it is an outage with a comment.
   *
   * Three things make the elevated token weaker than a normal one, and all three
   * matter: it lasts five minutes, it is bound to the session that asked for it,
   * and it is only issued to an account that actually has a second factor.
   *
   * Recovery codes (XXXXX-XXXXX) are accepted on the same `totpCode` field as
   * login: TOTP first so a live authenticator never burns a recovery hash;
   * else single-use redeem. Lost authenticator can still elevate withdraw.
   */
  async stepUp(input: { userId: string; sessionId: string; totpCode?: string; webauthn?: AuthenticationResponseJSON }): Promise<{
    accessToken: string;
    expiresAt: Date;
    scopes: Scope[];
  }> {
    const hasTotp = typeof input.totpCode === 'string' && input.totpCode.length > 0;
    const hasWebauthn = input.webauthn !== undefined && input.webauthn !== null;
    if (hasTotp === hasWebauthn) {
      // Exactly one factor proof per call — never both, never neither.
      throw new AuthError('Provide either a TOTP code or a WebAuthn assertion', 'auth.mfa_invalid');
    }

    const users = await this.sql<Array<{ totp_secret: string | null; status: string; webauthn_creds: StoredWebAuthnCredential[] }>>`
      SELECT totp_secret, status, webauthn_creds FROM users WHERE id = ${input.userId}
    `;
    const user = users[0];
    if (!user) throw new AuthError('User not found', 'auth.not_found');
    if (user.status !== 'active') throw new AuthError(`Account is ${user.status}`, 'auth.account_frozen');

    // The session must still be live. Elevating off a revoked session would let
    // a logout be undone by whoever still holds the old access token.
    const sessions = await this.sql<Array<{ id: string }>>`
      SELECT id FROM sessions
       WHERE id = ${input.sessionId} AND user_id = ${input.userId} AND revoked = false AND expires_at > now()
    `;
    if (!sessions[0]) throw new AuthError('Session is no longer valid', 'auth.session_invalid');

    if (hasTotp) {
      // §9: moving value off the platform requires a second factor.
      if (!user.totp_secret) {
        throw new AuthError('Enrol two-factor authentication before withdrawing', 'auth.mfa_not_enrolled');
      }
      // Same order as login: open enc:v1: → TOTP burn first, else recovery redeem.
      // Recovery never mints trade:withdraw without burning a second-factor proof.
      const secret = this.openTotpSecretColumn(user.totp_secret!);
      const matched = matchTotpStep(secret, input.totpCode!);
      if (matched !== null) {
        await this.consumeTotpCode(input.userId, secret, input.totpCode!);
      } else {
        const redeemed = await this.tryRedeemRecoveryCode(input.userId, input.totpCode!);
        if (!redeemed) throw new AuthError('Invalid two-factor code', 'auth.mfa_invalid');
      }
    } else {
      const creds = asCredentialList(user.webauthn_creds);
      if (creds.length === 0) {
        throw new AuthError('Enrol a security key before withdrawing with passkey step-up', 'auth.webauthn_not_enrolled');
      }
      const response = input.webauthn!;
      const clientChallenge = readClientChallenge(response.response.clientDataJSON);
      if (!clientChallenge) throw new AuthError('Invalid two-factor assertion', 'auth.webauthn_invalid');
      const held = await this.challenges.take(clientChallenge, 'step-up');
      if (!held || held.userId !== input.userId) {
        throw new AuthError('Invalid two-factor assertion', 'auth.webauthn_invalid');
      }
      const responseId = normalizeCredId(response.id);
      const credential = creds.find((c) => c.credentialId === responseId);
      if (!credential) throw new AuthError('Invalid two-factor assertion', 'auth.webauthn_invalid');
      let newCounter: number;
      try {
        ({ newCounter } = verifyAuthenticationResponse(this.webauthn, held.challenge, credential, response));
      } catch (err) {
        if (err instanceof WebAuthnError) throw new AuthError('Invalid two-factor assertion', 'auth.webauthn_invalid');
        throw err;
      }
      const next = creds.map((c) => (c.credentialId === credential.credentialId ? { ...c, counter: newCounter } : c));
      await this.sql`
        UPDATE users
           SET webauthn_creds = ${this.sql.json(next as never)}, updated_at = now()
         WHERE id = ${input.userId}
      `;
    }

    const scopes: Scope[] = [...this.defaultScopes(), ...STEP_UP_SCOPES];
    const tier = await this.kycTier(input.userId);

    const { token, expiresAt } = await issueAccessToken(
      { userId: input.userId, sessionId: input.sessionId, scopes, tier, mfa: true },
      { ...this.tokens, accessTtlSeconds: Math.min(this.tokens.accessTtlSeconds, STEP_UP_TTL_SECONDS) },
    );

    return { accessToken: token, expiresAt, scopes };
  }

  // ── Sub-accounts ───────────────────────────────────────────────────────────

  /**
   * Freeze identity + cascade revoke every sub-account and every API key
   * (SPEC-SUBACCOUNTS §3 + key kill-switch).
   *
   * Sub-accounts are bookkeeping partitions, not compliance boundaries —
   * freeze must not leave a live partition under a frozen parent.
   * API keys exchange already refuses non-active users, but bulk-revoking them
   * makes freeze visible on list/revoke surfaces and closes any path that only
   * checked `revoked` without re-reading user status.
   */
  async freezeIdentity(userId: string): Promise<{ userId: string; status: 'frozen'; subAccountsRevoked: number; apiKeysRevoked: number }> {
    const result = await transaction(this.sql, async (tx) => {
      const users = await tx<Array<{ id: string; status: string }>>`
        SELECT id, status FROM users WHERE id = ${userId} LIMIT 1 FOR UPDATE
      `;
      if (!users[0]) throw new AuthError('User not found', 'auth.not_found');
      await tx`
        UPDATE users SET status = 'frozen', updated_at = now() WHERE id = ${userId}
      `;
      // Revoke every open session so freeze is not delayed until token expiry.
      await tx`UPDATE sessions SET revoked = true WHERE user_id = ${userId} AND revoked = false`;
      const revokedRows = await tx<Array<{ id: string }>>`
        UPDATE sub_accounts SET revoked = true
         WHERE parent_user_id = ${userId} AND revoked = false
        RETURNING id
      `;
      const revokedKeys = await tx<Array<{ id: string }>>`
        UPDATE api_keys SET revoked = true
         WHERE user_id = ${userId} AND revoked = false
        RETURNING id
      `;
      return {
        userId,
        status: 'frozen' as const,
        subAccountsRevoked: revokedRows.length,
        apiKeysRevoked: revokedKeys.length,
      };
    });
    // Auth is authoritative if the projection write fails (ignore helper).
    await syncNavigatorSessionsClosedForUser(this.sql, userId);
    return result;
  }

  /**
   * Unfreeze identity only — does NOT un-revoke sub-accounts (explicit reopen).
   * Closing a partition is deliberate; freeze cascade is not a soft toggle for them.
   */
  async unfreezeIdentity(userId: string): Promise<{ userId: string; status: 'active' }> {
    const users = await this.sql<Array<{ id: string; status: string }>>`
      SELECT id, status FROM users WHERE id = ${userId} LIMIT 1
    `;
    if (!users[0]) throw new AuthError('User not found', 'auth.not_found');
    if (users[0].status === 'closed') {
      throw new AuthError('Closed accounts cannot be unfrozen', 'auth.account_frozen');
    }
    await this.sql`
      UPDATE users SET status = 'active', updated_at = now() WHERE id = ${userId}
    `;
    return { userId, status: 'active' };
  }

  async createSubAccount(userId: string, label: string, purpose?: string): Promise<{ id: string }> {
    const users = await this.sql<Array<{ status: string }>>`
      SELECT status FROM users WHERE id = ${userId} LIMIT 1
    `;
    if (!users[0]) throw new AuthError('User not found', 'auth.not_found');
    if (users[0].status !== 'active') {
      throw new AuthError(`Account is ${users[0].status}`, 'auth.account_frozen');
    }

    // Bound live partitions (SPEC-SUBACCOUNTS §4). Revoked rows do not count —
    // retirement frees a slot; freeze-cascade revokes without inventing a second cap.
    return transaction(this.sql, async (tx) => {
      // Serialize creates under one identity (user row lock) so two pods cannot
      // both read count=N-1 and insert past the owner-published max.
      const locked = await tx<Array<{ id: string }>>`
        SELECT id FROM users WHERE id = ${userId} LIMIT 1 FOR UPDATE
      `;
      if (!locked[0]) throw new AuthError('User not found', 'auth.not_found');

      const live = await tx<Array<{ n: string }>>`
        SELECT count(*)::text AS n FROM sub_accounts
         WHERE parent_user_id = ${userId} AND revoked = false
      `;
      const count = Number(live[0]?.n ?? '0');
      if (count >= this.maxSubAccounts) {
        throw new AuthError(
          `Sub-account limit reached (${this.maxSubAccounts}). Retire a live partition or raise IDENTITY_MAX_SUB_ACCOUNTS.`,
          'auth.sub_account_limit',
        );
      }
      const rows = await tx<Array<{ id: string }>>`
        INSERT INTO sub_accounts (parent_user_id, label, purpose)
        VALUES (${userId}, ${label}, ${purpose ?? null})
        RETURNING id
      `;
      return rows[0]!;
    });
  }

  async listSubAccounts(
    userId: string,
  ): Promise<Array<{ id: string; label: string; purpose: string | null; revoked: boolean; createdAt: Date }>> {
    const rows = await this.sql<Array<{ id: string; label: string; purpose: string | null; revoked: boolean; created_at: Date }>>`
      SELECT id, label, purpose, revoked, created_at FROM sub_accounts
       WHERE parent_user_id = ${userId}
       ORDER BY created_at DESC
    `;
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      purpose: r.purpose,
      revoked: r.revoked,
      createdAt: r.created_at,
    }));
  }

  /**
   * Soft-disable a sub-account the caller owns.
   *
   * Self-only: the UPDATE is gated on `parent_user_id = userId`, so a foreign
   * principal cannot retire another user's book (same shape as revokeApiKey).
   *
   * Does not move ledger balances. Identity holds no balances and posts no
   * ledger transactions — the row is a label the ledger keys on. Sweeping on
   * revoke would make a catalogue change move money (bank.spaces.archive rule).
   * Hard DELETE is refused by design: owner_type=subaccount accounts and any
   * trade.orders.sub_account_id still name this id.
   */
  async revokeSubAccount(userId: string, subAccountId: string): Promise<boolean> {
    const result = await this.sql`
      UPDATE sub_accounts
         SET revoked = true
       WHERE id = ${subAccountId}
         AND parent_user_id = ${userId}
         AND revoked = false
    `;
    return result.count > 0;
  }

  /**
   * S2S ownership read for money services (svc-trade placeOrder gate).
   *
   * Returns the row even when revoked so the caller can distinguish "not yours"
   * from "yours but retired". Missing id → null (same answer for a foreign
   * guess once the caller checks parentUserId).
   */
  async getSubAccountOwnership(subAccountId: string): Promise<{ id: string; parentUserId: string; revoked: boolean } | null> {
    const rows = await this.sql<Array<{ id: string; parent_user_id: string; revoked: boolean }>>`
      SELECT id, parent_user_id, revoked
        FROM sub_accounts
       WHERE id = ${subAccountId}
       LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return { id: row.id, parentUserId: row.parent_user_id, revoked: row.revoked };
  }

  /**
   * OWNERSHIP-AT-THE-DOOR for one sub-account (SPEC-SUBACCOUNTS §2).
   *
   * Money / trade ops that name a partition must call this (or the S2S snapshot
   * + the same checks) before acting. A valid scope says *what*; this says
   * *whose row*. Fail-closed:
   *   - missing / empty id → refuse (never invent primary)
   *   - unknown id → denied (same answer as foreign — no existence oracle)
   *   - parent_user_id ≠ caller → denied
   *   - revoked → revoked
   *
   * Does not post to the ledger. Identity holds no balances.
   */
  async assertSubAccountOwned(userId: string, subAccountId: string | null | undefined): Promise<{ id: string; parentUserId: string }> {
    const id = typeof subAccountId === 'string' ? subAccountId.trim() : '';
    if (!id) {
      throw new AuthError(
        'Sub-account id is required — a missing id is a refusal, never a default to primary',
        'auth.sub_account_required',
      );
    }

    const row = await this.getSubAccountOwnership(id);
    // Unknown and foreign both refuse as denied — do not confirm which.
    if (!row || row.parentUserId !== userId) {
      throw new AuthError('Sub-account not found or not owned by caller', 'auth.sub_account_denied');
    }
    if (row.revoked) {
      throw new AuthError('Sub-account is revoked', 'auth.sub_account_revoked');
    }

    return { id: row.id, parentUserId: row.parentUserId };
  }

  /**
   * OWNERSHIP-AT-THE-DOOR for a sub-account transfer (SPEC-SUBACCOUNTS §1–§2).
   *
   * The ledger recipe (`recipes.subAccountTransfer`) is pure and does not know
   * who owns which partition. Every money service that posts that recipe MUST
   * call this first — a valid scope is not ownership of a specific row.
   *
   * Composes {@link assertSubAccountOwned} on both legs so the single-row gate
   * and the transfer gate cannot drift. Same-id refuses before the second look-up.
   *
   * Does not post to the ledger. Identity holds no balances.
   */
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

  /**
   * Scopes granted to a normal interactive session.
   *
   * The list itself is SESSION_SCOPES in `@intafaced/auth`, next to the scope
   * definitions and to the table of what is withheld and why. It moved there
   * because it had drifted here, unread: `bank:*` and `blueprint:*` existed as
   * scopes, were required by every procedure in svc-bank and svc-blueprint, and
   * were issued to nobody — so both modules answered 403 to every user on the
   * platform. A list of what a session may do belongs beside the list of what
   * there is to do, where the gap is visible.
   *
   * `trade:withdraw` is still absent, as before: it is added only after a
   * step-up challenge, so an XSS-stolen access token cannot drain an account
   * (§9 withdrawal allow-lists + delay tiers).
   */
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

/** JSONB string arrays — driver may return array or JSON text. */
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
