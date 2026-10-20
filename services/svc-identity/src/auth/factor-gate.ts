/**
 * Who may add or remove a second factor (TOTP, passkey).
 *
 * THE HOLE THIS CLOSES. `totp.enrol`, `totp.confirm`, `webauthn.registerOptions`,
 * `webauthn.registerVerify` (and the top-level passkey routes) only needed a live
 * session. A stolen PASSWORD gives a live, non-MFA session on any account whose
 * only factor is a passkey (password login sets `mfa` only for a TOTP code). That
 * session could register the attacker's own passkey, then sign in with it (a
 * passkey login is always `mfa: true`) and pass every step-up and founder check.
 *
 * THE RULE.
 *   · The account already has any second factor (TOTP enrolled or >= 1 passkey):
 *     adding, replacing or removing a factor needs an MFA session — the session's
 *     `mfa` claim is true, which is what a TOTP login, a passkey login or a fresh
 *     `auth.stepUp` token (five minutes, `mfa: true`) all carry.
 *   · The account has none: a password session may enrol the FIRST factor, so a
 *     new customer can turn two-factor on — EXCEPT for privileged identities
 *     (founders, anything carrying an `admin:*` scope), which refuse with
 *     `auth.privileged_enrolment_requires_invite`. Their first factor must come
 *     through an invite-gated path, not a password.
 *   · Removing a factor always needs an MFA session (the account has one by
 *     definition), refused before any lookup so it cannot be used to probe ids.
 *   · An API-key (`kid`) or sub-account (`sub_account`) principal may never add
 *     or remove a factor, not even the first one: it is not a person at a
 *     keyboard, and a leaked key must not be able to mint a sign-in factor.
 *
 * "Has no factor" is read here under `SELECT … FOR UPDATE` on the user row, in
 * the SAME transaction as the write, so two parallel first-factor enrolments
 * serialise: the second sees the first's factor and now needs MFA.
 */
import type { Sql } from 'postgres';
import { TRPCError } from '@intafaced/contracts';
import { userCopy } from '../user-copy.js';
import { AuthError } from './auth-service.js';

export interface FactorActor {
  /** The session's `mfa` claim: passed a second factor, or holds a fresh step-up token. */
  readonly mfa: boolean;
  /** Founder / admin-scope identity: password-only first-factor enrolment is refused. */
  readonly privileged: boolean;
  /** API-key or sub-account principal: every factor change is refused. */
  readonly delegated?: boolean;
  /** The session doing the enrolling. Kept alive when TOTP enrolment revokes the account's other sessions. */
  readonly sessionId?: string | undefined;
}

/** Derive the actor from a verified principal. `privilegedUserIds` is the founder pair. */
export function factorActor(
  principal: {
    readonly userId: string;
    readonly mfa: boolean;
    readonly scopes: readonly string[];
    readonly kid?: string | undefined;
    readonly sub_account?: string | undefined;
    /** The access token's session claim. */
    readonly sid?: string | undefined;
  },
  privilegedUserIds: readonly string[] = [],
): FactorActor {
  const id = principal.userId.toLowerCase();
  return {
    mfa: principal.mfa === true,
    privileged: privilegedUserIds.some((p) => p.toLowerCase() === id) || principal.scopes.some((s) => s.startsWith('admin:')),
    delegated: Boolean(principal.kid) || Boolean(principal.sub_account),
    sessionId: principal.sid,
  };
}

export function accountHasSecondFactor(row: { totp_secret: string | null; webauthn_creds: unknown }): boolean {
  return Boolean(row.totp_secret) || (Array.isArray(row.webauthn_creds) && row.webauthn_creds.length > 0);
}

function refuseMfa(): never {
  throw new AuthError('Verify with your second factor before changing two-factor settings', 'auth.mfa_required');
}

function refuseDelegated(actor: FactorActor): void {
  if (actor.delegated) {
    throw new AuthError('Sign in yourself to change two-factor settings; an API key or sub-account cannot', 'auth.mfa_required');
  }
}

/**
 * Throws unless `actor` may add a factor to `userId`. With `lock`, takes the row
 * lock the caller's write then relies on; `sql` MUST then be the writer's own
 * transaction, or the lock is released before the write.
 */
export async function assertMayAddFactor(sql: Sql, userId: string, actor: FactorActor, lock: boolean): Promise<void> {
  const rows = lock
    ? await sql<
        Array<{ totp_secret: string | null; webauthn_creds: unknown }>
      >`SELECT totp_secret, webauthn_creds FROM users WHERE id = ${userId} FOR UPDATE`
    : await sql<
        Array<{ totp_secret: string | null; webauthn_creds: unknown }>
      >`SELECT totp_secret, webauthn_creds FROM users WHERE id = ${userId}`;
  if (!rows[0]) throw new AuthError('User not found', 'auth.not_found');
  checkMayAddFactor(rows[0], actor);
}

/** The rule itself, on a row the caller already read (and, for writes, locked). */
export function checkMayAddFactor(row: { totp_secret: string | null; webauthn_creds: unknown }, actor: FactorActor): void {
  refuseDelegated(actor);
  if (actor.mfa) return;
  if (accountHasSecondFactor(row)) refuseMfa();
  if (actor.privileged) {
    throw new AuthError('This account needs an invite to enrol its first two-factor method', 'auth.privileged_enrolment_requires_invite');
  }
}

/** Removing any factor needs an interactive MFA session. Call before touching the row. */
export function assertMayRemoveFactor(actor: FactorActor): void {
  refuseDelegated(actor);
  if (!actor.mfa) refuseMfa();
}

/**
 * The two factor-gate refusals as tRPC errors, or null for anything else.
 *
 * Both are 403, never 401: the customer app treats every 401 as "session
 * expired" and signs the person out, but a missing second factor is "prove it
 * again", not "you are logged out". The typed code travels in `cause.code`.
 */
export function factorGateTrpcError(err: unknown): TRPCError | null {
  if (!(err instanceof AuthError)) return null;
  if (err.code !== 'auth.mfa_required' && err.code !== 'auth.privileged_enrolment_requires_invite') return null;
  return new TRPCError({ code: 'FORBIDDEN', message: userCopy(err.code), cause: err });
}
