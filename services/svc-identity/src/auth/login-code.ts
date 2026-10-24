import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { transaction } from '@intafaced/db';
import type { Sql } from 'postgres';
import { flowSubjectHash, type PasswordResetMail } from './password-reset.js';

/**
 * Sign-in with a one-time code by email instead of a password (I-signin-sessions-19 with the code rules of
 * I-signin-sessions-20).
 *
 * `request` takes the email or handle the person typed and always answers `{ accepted, flowId, resendAfterSeconds }`.
 * An active account gets a six-digit code at its own address; an unknown name, or a frozen or closed account, gets a
 * `suppressed` flow whose code hash is of a value nobody holds, and only an unknown email address, and only when the
 * owner turned recovery notices on, gets a "no account" notice. Either way the same statements run (FLW-3), so the
 * answer says nothing about whether the account exists.
 *
 * `check` compares a code under the flow's row lock: a wrong one counts, and the owner's count locks the flow until it
 * expires. A right one is not spent here: the caller checks the second factor first (a code never signs in an account
 * that has one without it), then `consume` spends the code with a compare-and-swap, so only one session ever comes from
 * it. Resend voids the old code. Blank owner numbers refuse every caller the same way (`auth.codes_unwired`).
 */

/** One day. Longer than that is not a sign-in code. */
const MAX_TTL_SECONDS = 86_400;

export type LoginCodeErrorCode =
  | 'auth.codes_unwired'
  | 'auth.code_invalid'
  | 'auth.code_expired'
  | 'auth.too_many_attempts'
  | 'identity.resend_too_soon'
  | 'vendor.email'
  | 'vendor.sms';

export class LoginCodeError extends Error {
  constructor(
    message: string,
    readonly code: LoginCodeErrorCode,
    /** `retryAfterSeconds` on `auth.too_many_attempts` and `identity.resend_too_soon`. */
    readonly details?: { readonly retryAfterSeconds?: number },
  ) {
    super(message);
    this.name = 'LoginCodeError';
  }
}

export interface LoginCodePolicy {
  readonly codeTtlSeconds?: number | undefined;
  /** Wrong codes allowed per flow. The ceiling is 5. */
  readonly maxAttempts?: number | undefined;
  /** Seconds before another code may be sent for the same flow. */
  readonly resendSeconds?: number | undefined;
  /** Codes per identifier inside the window, first sends and resends together. */
  readonly requestMax?: number | undefined;
  readonly requestWindowSeconds?: number | undefined;
}

export interface LoginCodeDeps extends LoginCodePolicy {
  readonly sql: Sql;
  readonly mail: PasswordResetMail | undefined;
  /** HMAC key for the identifier and the code hash. Same key as the recovery flows. */
  readonly subjectKey: string | undefined;
  /** Mail an unknown email address a notice. Off unless the owner turned recovery notices on. */
  readonly notifyUnknown?: boolean | undefined;
  readonly now: () => Date;
  readonly log: { warn(obj: Record<string, unknown>, msg: string): void };
  readonly afterCommit?: (() => void | Promise<void>) | undefined;
}

export interface LoginCodeAccepted {
  readonly accepted: true;
  readonly flowId: string;
  readonly resendAfterSeconds: number;
}

type Budget = {
  readonly ttlSeconds: number;
  readonly maxAttempts: number;
  readonly resendSeconds: number;
  readonly requestMax: number;
  readonly requestWindowSeconds: number;
  readonly subjectKey: string;
};

function intIn(value: number | undefined, min: number, max: number): number | undefined {
  if (value === undefined || !Number.isInteger(value) || value < min || value > max) return undefined;
  return value;
}

/** Every owner number, the key and a mail transport, or one refusal. Which one is missing goes to the log only. */
function requireBudget(deps: LoginCodeDeps): Budget {
  const ttlSeconds = intIn(deps.codeTtlSeconds, 1, MAX_TTL_SECONDS);
  const maxAttempts = intIn(deps.maxAttempts, 1, 5);
  const resendSeconds = intIn(deps.resendSeconds, 1, MAX_TTL_SECONDS);
  const requestMax = intIn(deps.requestMax, 1, 1_000);
  const requestWindowSeconds = intIn(deps.requestWindowSeconds, 1, MAX_TTL_SECONDS);
  const subjectKey = deps.subjectKey && deps.subjectKey.length >= 32 ? deps.subjectKey : undefined;
  const missing = [
    ttlSeconds === undefined && 'code-ttl',
    maxAttempts === undefined && 'attempts',
    resendSeconds === undefined && 'resend',
    requestMax === undefined && 'request-max',
    requestWindowSeconds === undefined && 'request-window',
    subjectKey === undefined && 'subject-key',
  ].filter(Boolean);
  if (missing.length > 0) {
    deps.log.warn({ missing }, 'auth.login_codes_unwired');
    throw new LoginCodeError('Sign-in by code is not available: its settings are not published.', 'auth.codes_unwired');
  }
  if (!deps.mail)
    throw new LoginCodeError('Email delivery is switched off in this build, so a sign-in code cannot be sent.', 'vendor.email');
  return {
    ttlSeconds: ttlSeconds!,
    maxAttempts: maxAttempts!,
    resendSeconds: resendSeconds!,
    requestMax: requestMax!,
    requestWindowSeconds: requestWindowSeconds!,
    subjectKey: subjectKey!,
  };
}

function codeHash(subjectKey: string, flowId: string, code: string): string {
  return createHmac('sha256', subjectKey).update(`login:${flowId}:${code}`).digest('hex');
}

function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function secondsUntil(at: Date, now: Date): number {
  return Math.max(1, Math.ceil((at.getTime() - now.getTime()) / 1000));
}

const looksLikeEmail = (value: string) => /^[^\s@]+@[^\s@]+$/.test(value);
const looksLikePhone = (value: string) => /^\+?[\d\s().-]{7,}$/.test(value) && /\d{6,}/.test(value.replace(/\D/g, ''));

type Account = { id: string; email: string };

/** The active account this name signs in, or undefined. A frozen or closed account gets no code (FLW-4). */
async function activeAccount(sql: Sql, identifier: string): Promise<Account | undefined> {
  const rows = await sql<Array<{ id: string; email: string; status: string }>>`
    SELECT id, email, status FROM users WHERE handle = ${identifier} OR email = ${identifier}
  `;
  const user = rows[0];
  return user && user.status === 'active' ? { id: user.id, email: user.email } : undefined;
}

/**
 * One mail job for the flow: the code to the account, a notice to an unknown address (if on), else nothing sent. Its
 * time is the service clock's, because the resend interval and the per-name cap are counted from it.
 */
async function queueMail(
  tx: Sql,
  deps: LoginCodeDeps,
  flow: { id: string; identifier: string; account: Account | undefined; code: string; expiresAt: Date },
): Promise<boolean> {
  const notice = !flow.account && deps.notifyUnknown === true && looksLikeEmail(flow.identifier);
  const sendable = flow.account !== undefined || notice;
  await tx`
    INSERT INTO mail_outbox (flow_id, purpose, recipient, code, handle, expires_at, status, created_at)
    VALUES (
      ${flow.id}, ${flow.account ? 'login-code' : 'login-no-account'}, ${flow.account?.email ?? flow.identifier},
      ${flow.account ? flow.code : null}, NULL, ${flow.expiresAt}, ${sendable ? 'pending' : 'suppressed'}, ${deps.now()}
    )
  `;
  return sendable;
}

/** Codes sent for this identifier inside the window, and when the oldest of them was sent. */
async function recentSends(tx: Sql, subjectHash: string, since: Date): Promise<{ n: number; oldest: Date | null }> {
  const rows = await tx<Array<{ n: number; oldest: Date | null }>>`
    SELECT count(*)::int AS n, min(m.created_at) AS oldest FROM mail_outbox m JOIN auth_flows f ON f.id = m.flow_id
    WHERE f.subject_hash = ${subjectHash} AND f.kind = 'login_code' AND m.created_at > ${since}
  `;
  return { n: rows[0]?.n ?? 0, oldest: rows[0]?.oldest ? new Date(rows[0].oldest) : null };
}

function overCap(budget: Budget, oldest: Date | null, now: Date): LoginCodeError {
  return new LoginCodeError('Too many codes for this name. Try again later.', 'auth.too_many_attempts', {
    retryAfterSeconds: secondsUntil(new Date((oldest ?? now).getTime() + budget.requestWindowSeconds * 1000), now),
  });
}

/** Step 1. One flow and one mail job for any name under the cap; the same answer for every name. */
export async function requestLoginCode(deps: LoginCodeDeps, input: { identifier: string }): Promise<LoginCodeAccepted> {
  const identifier = input.identifier.trim();
  // A phone number needs a text-message provider. Refused for every number alike, before any lookup.
  if (!looksLikeEmail(identifier) && looksLikePhone(identifier)) {
    throw new LoginCodeError(
      'Codes by text message need a provider that is not connected in this build. Use your email or handle.',
      'vendor.sms',
    );
  }
  const budget = requireBudget(deps);
  const now = deps.now();
  const subjectHash = flowSubjectHash(budget.subjectKey, identifier);
  const account = await activeAccount(deps.sql, identifier);
  const code = newCode();
  const expiresAt = new Date(now.getTime() + budget.ttlSeconds * 1000);
  const since = new Date(now.getTime() - budget.requestWindowSeconds * 1000);

  const { flowId, sendable } = await transaction(
    deps.sql,
    async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${subjectHash}))`;
      const recent = await recentSends(tx, subjectHash, since);
      if (recent.n >= budget.requestMax) throw overCap(budget, recent.oldest, now);
      const flow = await tx<Array<{ id: string }>>`
        INSERT INTO auth_flows (kind, subject_hash, user_id, code_hash, status, expires_at, created_at)
        VALUES ('login_code', ${subjectHash}, ${account?.id ?? null}, ${'0'.repeat(64)}, ${account ? 'code_sent' : 'suppressed'}, ${expiresAt}, ${now})
        RETURNING id
      `;
      const id = flow[0]!.id;
      // An unknown name's flow hashes a code nobody holds, so no guess can finish it.
      await tx`
        UPDATE auth_flows SET code_hash = ${codeHash(budget.subjectKey, id, account ? code : randomBytes(16).toString('hex'))}
        WHERE id = ${id}
      `;
      return { flowId: id, sendable: await queueMail(tx, deps, { id, identifier, account, code, expiresAt }) };
    },
    { isolation: 'read committed' },
  );
  if (sendable) await deps.afterCommit?.();
  return { accepted: true, flowId, resendAfterSeconds: budget.resendSeconds };
}

type OpenFlow = {
  id: string;
  created_at: Date;
  subject_hash: string;
  user_id: string | null;
  code_hash: string;
  status: string;
  attempts: number;
  expires_at: Date;
  consumed_at: Date | null;
};

async function lockFlow(tx: Sql, flowId: string): Promise<OpenFlow | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(flowId)) return undefined;
  const rows = await tx<OpenFlow[]>`
    SELECT id, created_at, subject_hash, user_id, code_hash, status, attempts, expires_at, consumed_at
    FROM auth_flows WHERE id = ${flowId} AND kind = 'login_code'
    FOR UPDATE
  `;
  return rows[0];
}

const EXPIRED = 'This code has run out. Ask for a new one.';
const INVALID = 'That code is not valid. Check the newest email, or ask for a new code.';
const tooMany = (flow: OpenFlow, now: Date) =>
  new LoginCodeError('Too many wrong codes. Try again later.', 'auth.too_many_attempts', {
    retryAfterSeconds: secondsUntil(new Date(flow.expires_at), now),
  });

/** Step 1b. A new code for the same flow once the resend interval has passed; the old code stops working. */
export async function resendLoginCode(deps: LoginCodeDeps, input: { flowId: string }): Promise<LoginCodeAccepted> {
  const budget = requireBudget(deps);
  const now = deps.now();
  const since = new Date(now.getTime() - budget.requestWindowSeconds * 1000);
  const code = newCode();
  const sendable = await transaction(
    deps.sql,
    async (tx) => {
      // Locked, so two resends at once cannot both pass the interval.
      const flow = await lockFlow(tx, input.flowId);
      if (!flow || flow.consumed_at || flow.status === 'consumed' || new Date(flow.expires_at) <= now) {
        throw new LoginCodeError(EXPIRED, 'auth.code_expired');
      }
      if (flow.status === 'locked') throw tooMany(flow, now);
      const last = await tx<Array<{ at: Date | null }>>`SELECT max(created_at) AS at FROM mail_outbox WHERE flow_id = ${flow.id}`;
      const due = new Date(new Date(last[0]?.at ?? flow.created_at).getTime() + budget.resendSeconds * 1000);
      if (due > now) {
        throw new LoginCodeError('A code was sent a moment ago.', 'identity.resend_too_soon', {
          retryAfterSeconds: secondsUntil(due, now),
        });
      }
      await tx`SELECT pg_advisory_xact_lock(hashtext(${flow.subject_hash}))`;
      const recent = await recentSends(tx, flow.subject_hash, since);
      if (recent.n >= budget.requestMax) throw overCap(budget, recent.oldest, now);
      const account = flow.user_id
        ? (await tx<Array<{ id: string; email: string }>>`SELECT id, email FROM users WHERE id = ${flow.user_id} AND status = 'active'`)[0]
        : undefined;
      // A resend never keeps a flow alive past one day from its start.
      const expiresAt = new Date(
        Math.min(now.getTime() + budget.ttlSeconds * 1000, new Date(flow.created_at).getTime() + MAX_TTL_SECONDS * 1000),
      );
      const live = flow.status === 'code_sent' && account !== undefined;
      await tx`
        UPDATE auth_flows
        SET code_hash = ${codeHash(budget.subjectKey, flow.id, live ? code : randomBytes(16).toString('hex'))}, expires_at = ${expiresAt}
        WHERE id = ${flow.id}
      `;
      // The unknown name's notice is not repeated: the job is written, and stays unsent, so the work is the same.
      const recipient = live ? account : undefined;
      const prior = await tx<
        Array<{ recipient: string }>
      >`SELECT recipient FROM mail_outbox WHERE flow_id = ${flow.id} ORDER BY created_at LIMIT 1`;
      return queueMail(
        tx,
        { ...deps, notifyUnknown: false },
        {
          id: flow.id,
          identifier: prior[0]?.recipient ?? '',
          account: recipient,
          code,
          expiresAt,
        },
      );
    },
    { isolation: 'read committed' },
  );
  if (sendable) await deps.afterCommit?.();
  return { accepted: true, flowId: input.flowId, resendAfterSeconds: budget.resendSeconds };
}

/**
 * Step 2a. Is this the flow's code? A wrong code counts and the owner's count locks the flow. A right code is NOT
 * spent: the caller still checks the second factor, then calls `consumeLoginCode`.
 */
export async function checkLoginCode(deps: LoginCodeDeps, input: { flowId: string; code: string }): Promise<{ userId: string }> {
  const budget = requireBudget(deps);
  const now = deps.now();
  // One locked read decides the count and the compare, so a burst of guesses is checked one at a time.
  const outcome = await transaction(
    deps.sql,
    async (tx): Promise<{ userId: string } | LoginCodeError> => {
      const flow = await lockFlow(tx, input.flowId);
      if (flow && (flow.consumed_at || flow.status === 'consumed')) return new LoginCodeError(INVALID, 'auth.code_invalid');
      if (!flow || new Date(flow.expires_at) <= now) return new LoginCodeError(EXPIRED, 'auth.code_expired');
      if (flow.status === 'locked' || flow.attempts >= budget.maxAttempts) return tooMany(flow, now);
      const presented = Buffer.from(codeHash(budget.subjectKey, flow.id, input.code.trim()), 'hex');
      const stored = Buffer.from(flow.code_hash, 'hex');
      const right =
        presented.length === stored.length && timingSafeEqual(presented, stored) && flow.status === 'code_sent' && flow.user_id !== null;
      if (!right) {
        const attempts = flow.attempts + 1;
        const lock = attempts >= budget.maxAttempts;
        await tx`UPDATE auth_flows SET attempts = ${attempts}, status = ${lock ? 'locked' : flow.status} WHERE id = ${flow.id}`;
        return lock ? tooMany(flow, now) : new LoginCodeError(INVALID, 'auth.code_invalid');
      }
      return { userId: flow.user_id! };
    },
    { isolation: 'read committed' },
  );
  if (outcome instanceof LoginCodeError) throw outcome;
  return outcome;
}

/** Step 2b. Spend the code: a compare-and-swap from `code_sent`, so two right answers at once make one session. */
export async function consumeLoginCode(deps: LoginCodeDeps, input: { flowId: string }): Promise<void> {
  const spent = await deps.sql<Array<{ id: string }>>`
    UPDATE auth_flows SET status = 'consumed', consumed_at = ${deps.now()}
    WHERE id = ${input.flowId} AND kind = 'login_code' AND status = 'code_sent' AND consumed_at IS NULL AND expires_at > ${deps.now()}
    RETURNING id
  `;
  if (!spent[0]) throw new LoginCodeError(INVALID, 'auth.code_invalid');
}
