import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { checkAccess } from '@intafaced/config';
import { transaction } from '@intafaced/db';
import type { Sql } from 'postgres';
import { flowSubjectHash, type PasswordResetMail } from './password-reset.js';
import { assertPasswordNotBreached, assertPasswordNotIdentity, assertPasswordShape, hashPassword, WeakPasswordError } from './passwords.js';

/**
 * Sign-up by email, with the code before the first session (I-signin-sessions-18) and the eligibility check
 * at the door (I-kyc-compliance-06).
 *
 * `start` checks, in this order: age (owner `IDENTITY_SIGNUP_MIN_AGE_YEARS`), then the country of residence and
 * the optional nationality (a real ISO country, not switched off by the owner, not on the screening list), then
 * the password. Nothing is written on a refusal. A good record writes one `auth_flows` row, one `signup_drafts`
 * row and one `mail_outbox` row, and answers `{ accepted, next: 'confirm_email', flowId }` with no session.
 *
 * A new address and an address that already has an account get the same answer and the same work: the
 * password is hashed, the three rows are written. The new address is mailed a six-digit code; the known one is
 * mailed a "someone tried to sign up with your address" notice, and its flow is `suppressed`, so no code
 * finishes it. `confirm` makes the account only when the right code is entered, inside one transaction with
 * the flow consumed and the draft (and its password hash) deleted.
 *
 * Blank owner numbers refuse every caller the same way (`identity.signup_unwired`, `identity.age_rule_unset`);
 * nothing here invents a lifetime, a cap or an age. The date of birth is used for the age check and is not
 * stored: verification collects it with the document.
 */

export const ACCOUNT_TYPES = ['individual', 'business'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** One day. Longer than that is not a sign-up code. */
const MAX_TTL_SECONDS = 86_400;
/** The oldest age an owner could publish; anything above is not a published rule. */
const MAX_MIN_AGE = 25;
/** Region codes that name no country (EU, UN, the pseudo and unknown regions). */
const NOT_COUNTRIES = new Set(['EU', 'EZ', 'UN', 'QO', 'XA', 'XB', 'ZZ']);
const REGION_NAMES = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'code' });

export type SignUpErrorCode =
  | 'identity.signup_unwired'
  | 'identity.age_rule_unset'
  | 'identity.date_of_birth_invalid'
  | 'identity.underage'
  | 'identity.country_invalid'
  | 'identity.region_blocked'
  | 'identity.screening_unset'
  | 'identity.signup_expired'
  | 'identity.signup_code_invalid'
  | 'identity.signup_code_used'
  | 'identity.resend_too_soon'
  | 'auth.too_many_attempts'
  | 'auth.password_policy'
  | 'auth.password_breached'
  | 'auth.handle_taken'
  | 'auth.email_taken'
  | 'vendor.email'
  | 'vendor.sms';

export class SignUpError extends Error {
  constructor(
    message: string,
    readonly code: SignUpErrorCode,
    /** `retryAfterSeconds` on `auth.too_many_attempts` and `identity.resend_too_soon`. */
    readonly details?: { readonly retryAfterSeconds?: number },
  ) {
    super(message);
    this.name = 'SignUpError';
  }
}

export interface SignUpPolicy {
  readonly minAgeYears?: number | undefined;
  readonly codeTtlSeconds?: number | undefined;
  /** Wrong codes allowed per sign-up. The ceiling is 5. */
  readonly maxAttempts?: number | undefined;
  /** Seconds before another code may be sent for the same sign-up. */
  readonly resendSeconds?: number | undefined;
  /** Sign-ups (and resends) per address inside the window. */
  readonly requestMax?: number | undefined;
  readonly requestWindowSeconds?: number | undefined;
  /** The owner's per-country off switch for sign-up. Blank closes none: sign-up is open where screening allows. */
  readonly closedCountries?: readonly string[] | undefined;
}

export interface SignUpDeps extends SignUpPolicy {
  readonly sql: Sql;
  readonly mail: PasswordResetMail | undefined;
  /** HMAC key for the address identifier and the code hash. Same key as the recovery flows. */
  readonly subjectKey: string | undefined;
  readonly now: () => Date;
  readonly log: { warn(obj: Record<string, unknown>, msg: string): void };
  /** Starts the mail relay after a sign-up commits. */
  readonly afterCommit?: (() => void | Promise<void>) | undefined;
}

export interface SignUpStart {
  readonly handle: string;
  readonly email: string;
  readonly password: string;
  /** ISO 3166-1 alpha-2 country of residence. */
  readonly country: string;
  readonly nationality?: string | undefined;
  /** `YYYY-MM-DD`. Checked against the owner's minimum age, never stored. */
  readonly dateOfBirth: string;
  readonly accountType: AccountType;
  readonly referrerId?: string | undefined;
}

export interface SignUpAccepted {
  readonly accepted: true;
  readonly next: 'confirm_email';
  readonly flowId: string;
  readonly resendAfterSeconds: number;
}

/** The account a confirmed sign-up makes. The password hash never leaves the service. */
export interface SignUpDraft {
  readonly flowId: string;
  readonly handle: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly country: string;
  readonly accountType: AccountType;
  readonly referrerId: string | null;
}

type Budget = {
  readonly ttlSeconds: number;
  readonly maxAttempts: number;
  readonly resendSeconds: number;
  readonly requestMax: number;
  readonly requestWindowSeconds: number;
  readonly subjectKey: string;
  readonly mail: PasswordResetMail;
};

function intIn(value: number | undefined, min: number, max: number): number | undefined {
  if (value === undefined || !Number.isInteger(value) || value < min || value > max) return undefined;
  return value;
}

/** Every owner number, the key and a mail transport, or one refusal. Which one is missing goes to the log only. */
function requireBudget(deps: SignUpDeps): Budget {
  if (!deps.mail) throw new SignUpError('Email delivery is switched off in this build, so a sign-up code cannot be sent.', 'vendor.email');
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
    deps.log.warn({ missing }, 'identity.signup_unwired');
    throw new SignUpError('Sign-up is not available yet.', 'identity.signup_unwired');
  }
  return {
    ttlSeconds: ttlSeconds!,
    maxAttempts: maxAttempts!,
    resendSeconds: resendSeconds!,
    requestMax: requestMax!,
    requestWindowSeconds: requestWindowSeconds!,
    subjectKey: subjectKey!,
    mail: deps.mail,
  };
}

/** A real ISO 3166-1 alpha-2 country, upper-cased, or undefined. */
export function countryCode(value: string): string | undefined {
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code) || NOT_COUNTRIES.has(code)) return undefined;
  return REGION_NAMES.of(code) === code ? undefined : code;
}

/** Whole years between a `YYYY-MM-DD` birth date and `now` (UTC), or undefined for a date that is not real or is in the future. */
export function ageOn(dateOfBirth: string, now: Date): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth.trim());
  if (!match) return undefined;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const born = new Date(Date.UTC(y, m - 1, d));
  if (born.getUTCFullYear() !== y || born.getUTCMonth() !== m - 1 || born.getUTCDate() !== d) return undefined;
  if (born.getTime() > now.getTime() || y < 1900) return undefined;
  let age = now.getUTCFullYear() - y;
  if (now.getUTCMonth() < m - 1 || (now.getUTCMonth() === m - 1 && now.getUTCDate() < d)) age -= 1;
  return age;
}

function codeHash(subjectKey: string, flowId: string, code: string): string {
  return createHmac('sha256', subjectKey).update(`signup:${flowId}:${code}`).digest('hex');
}

function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function secondsUntil(at: Date, now: Date): number {
  return Math.max(1, Math.ceil((at.getTime() - now.getTime()) / 1000));
}

/** Age, then country and nationality. Throws the first refusal; nothing has been written yet. */
function assertEligible(deps: SignUpDeps, input: SignUpStart, now: Date): string {
  const minAge = intIn(deps.minAgeYears, 1, MAX_MIN_AGE);
  if (minAge === undefined)
    throw new SignUpError('Sign-up is not available yet. The minimum age is not published.', 'identity.age_rule_unset');
  const age = ageOn(input.dateOfBirth, now);
  if (age === undefined) throw new SignUpError('Enter a real date of birth.', 'identity.date_of_birth_invalid');
  if (age < minAge) throw new SignUpError(`You must be at least ${minAge} to open an account.`, 'identity.underage');

  const country = countryCode(input.country);
  if (!country) throw new SignUpError('Choose the country you live in from the list.', 'identity.country_invalid');
  const nationality = input.nationality === undefined || input.nationality === '' ? undefined : countryCode(input.nationality);
  if (input.nationality && !nationality) throw new SignUpError('Choose your nationality from the list.', 'identity.country_invalid');

  const closed = new Set((deps.closedCountries ?? []).map((c) => c.trim().toUpperCase()));
  for (const region of [country, nationality]) {
    if (!region) continue;
    if (closed.has(region)) throw new SignUpError('We cannot open accounts for this country right now.', 'identity.region_blocked');
    const decision = checkAccess({ module: 'identity', region, plane: 'fiat', kycTier: 'none' });
    if (decision.allowed) continue;
    if (decision.code === 'denied.screening_unconfigured' || decision.code === 'denied.screening_fixture') {
      throw new SignUpError('Sign-up is paused: the sanctions screening list is not set.', 'identity.screening_unset');
    }
    throw new SignUpError('We cannot open accounts for this country right now.', 'identity.region_blocked');
  }
  return country;
}

/**
 * Step 1. Eligibility, then the password, then one flow, one draft and one mail for either kind of address.
 * Over the per-address cap nothing is written and the answer says when to try again (the same for both kinds).
 */
export async function startSignUp(deps: SignUpDeps, input: SignUpStart): Promise<SignUpAccepted> {
  const now = deps.now();
  const country = assertEligible(deps, input, now);
  const budget = requireBudget(deps);
  const email = input.email.trim();
  try {
    assertPasswordShape(input.password);
    assertPasswordNotIdentity(input.password, { handle: input.handle, email });
    assertPasswordNotBreached(input.password);
  } catch (err) {
    if (err instanceof WeakPasswordError) throw new SignUpError(err.message, err.code);
    throw err;
  }
  // Handles are public, so a taken one may be said out loud. An address is never confirmed this way.
  const taken = await deps.sql<Array<{ id: string }>>`SELECT id FROM users WHERE lower(handle) = lower(${input.handle}) LIMIT 1`;
  if (taken[0]) throw new SignUpError('That handle is taken', 'auth.handle_taken');

  const passwordHash = await hashPassword(input.password);
  const subjectHash = flowSubjectHash(budget.subjectKey, email);
  const code = newCode();
  const expiresAt = new Date(now.getTime() + budget.ttlSeconds * 1000);
  const since = new Date(now.getTime() - budget.requestWindowSeconds * 1000);

  const flowId = await transaction(
    deps.sql,
    async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${subjectHash}))`;
      const recent = await tx<Array<{ n: number; oldest: Date | null }>>`
        SELECT count(*)::int AS n, min(created_at) AS oldest FROM auth_flows
        WHERE subject_hash = ${subjectHash} AND kind = 'signup' AND created_at > ${since}
      `;
      if ((recent[0]?.n ?? 0) >= budget.requestMax) {
        const oldest = recent[0]!.oldest ? new Date(recent[0]!.oldest) : now;
        throw new SignUpError('Too many sign-ups for this address. Try again later.', 'auth.too_many_attempts', {
          retryAfterSeconds: secondsUntil(new Date(oldest.getTime() + budget.requestWindowSeconds * 1000), now),
        });
      }
      // Abandoned drafts hold a password hash; drop them once their code can no longer be used.
      await tx`DELETE FROM signup_drafts d USING auth_flows f WHERE d.flow_id = f.id AND f.expires_at <= ${now}`;
      const known = await tx<Array<{ email: string }>>`SELECT email FROM users WHERE lower(email) = lower(${email}) LIMIT 1`;
      const owner = known[0];
      const flow = await tx<Array<{ id: string }>>`
        INSERT INTO auth_flows (kind, subject_hash, user_id, code_hash, status, expires_at, created_at)
        VALUES ('signup', ${subjectHash}, NULL, ${'0'.repeat(64)}, ${owner ? 'suppressed' : 'code_sent'}, ${expiresAt}, ${now})
        RETURNING id
      `;
      const id = flow[0]!.id;
      // The known address's flow hashes a code nobody holds, so it can never be finished.
      await tx`
        UPDATE auth_flows SET code_hash = ${codeHash(budget.subjectKey, id, owner ? randomBytes(16).toString('hex') : code)}
        WHERE id = ${id}
      `;
      await tx`
        INSERT INTO signup_drafts (flow_id, handle, email, password_hash, country, account_type, referrer_id, last_sent_at)
        VALUES (${id}, ${input.handle}, ${email}, ${passwordHash}, ${country}, ${input.accountType}, ${input.referrerId ?? null}, ${now})
      `;
      await tx`
        INSERT INTO mail_outbox (flow_id, purpose, recipient, code, handle, expires_at, status)
        VALUES (${id}, ${owner ? 'signup-existing' : 'signup-code'}, ${owner ? owner.email : email}, ${owner ? null : code}, NULL, ${expiresAt}, 'pending')
      `;
      return id;
    },
    { isolation: 'read committed' },
  );
  await deps.afterCommit?.();
  return { accepted: true, next: 'confirm_email', flowId, resendAfterSeconds: budget.resendSeconds };
}

type OpenSignUp = {
  id: string;
  created_at: Date;
  subject_hash: string;
  code_hash: string;
  status: string;
  attempts: number;
  expires_at: Date;
  consumed_at: Date | null;
  email: string | null;
  last_sent_at: Date | null;
};

/** One sign-up flow and its draft. `lock` holds the flow row until the caller's transaction ends. */
async function readFlow(sql: Sql, flowId: string, lock = false): Promise<OpenSignUp | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(flowId)) return undefined;
  const rows = lock
    ? await sql<OpenSignUp[]>`
        SELECT f.id, f.created_at, f.subject_hash, f.code_hash, f.status, f.attempts, f.expires_at, f.consumed_at, d.email, d.last_sent_at
        FROM auth_flows f LEFT JOIN signup_drafts d ON d.flow_id = f.id
        WHERE f.id = ${flowId} AND f.kind = 'signup'
        FOR UPDATE OF f
      `
    : await sql<OpenSignUp[]>`
        SELECT f.id, f.created_at, f.subject_hash, f.code_hash, f.status, f.attempts, f.expires_at, f.consumed_at, d.email, d.last_sent_at
        FROM auth_flows f LEFT JOIN signup_drafts d ON d.flow_id = f.id
        WHERE f.id = ${flowId} AND f.kind = 'signup'
      `;
  return rows[0];
}

const EXPIRED = 'This sign-up has expired. Start again.';

/** Step 1b. A new code for the same sign-up, once the resend interval has passed. A known address gets the notice again. */
export async function resendSignUp(deps: SignUpDeps, input: { flowId: string }): Promise<SignUpAccepted> {
  const budget = requireBudget(deps);
  const now = deps.now();
  const since = new Date(now.getTime() - budget.requestWindowSeconds * 1000);
  const code = newCode();
  await transaction(
    deps.sql,
    async (tx) => {
      // Locked, so two resends at once cannot both pass the interval and leave the first mail's code dead.
      const flow = await readFlow(tx, input.flowId, true);
      if (!flow || flow.consumed_at || new Date(flow.expires_at) <= now) throw new SignUpError(EXPIRED, 'identity.signup_expired');
      if (flow.status === 'locked') {
        throw new SignUpError('Too many wrong codes. Start again later.', 'auth.too_many_attempts', {
          retryAfterSeconds: secondsUntil(new Date(flow.expires_at), now),
        });
      }
      if (!flow.email || !flow.last_sent_at) throw new SignUpError(EXPIRED, 'identity.signup_expired');
      const due = new Date(new Date(flow.last_sent_at).getTime() + budget.resendSeconds * 1000);
      if (due > now) {
        throw new SignUpError('A code was sent a moment ago.', 'identity.resend_too_soon', { retryAfterSeconds: secondsUntil(due, now) });
      }
      await tx`SELECT pg_advisory_xact_lock(hashtext(${flow.subject_hash}))`;
      const recent = await tx<Array<{ n: number; oldest: Date | null }>>`
        SELECT count(*)::int AS n, min(m.created_at) AS oldest FROM mail_outbox m JOIN auth_flows f ON f.id = m.flow_id
        WHERE f.subject_hash = ${flow.subject_hash} AND f.kind = 'signup' AND m.created_at > ${since}
      `;
      if ((recent[0]?.n ?? 0) >= budget.requestMax) {
        const oldest = recent[0]!.oldest ? new Date(recent[0]!.oldest) : now;
        throw new SignUpError('Too many codes for this address. Try again later.', 'auth.too_many_attempts', {
          retryAfterSeconds: secondsUntil(new Date(oldest.getTime() + budget.requestWindowSeconds * 1000), now),
        });
      }
      // A resend renews the code's lifetime, never past one day from the sign-up's start, so a draft cannot be kept alive.
      const expiresAt = new Date(
        Math.min(now.getTime() + budget.ttlSeconds * 1000, new Date(flow.created_at).getTime() + MAX_TTL_SECONDS * 1000),
      );
      const known = flow.status === 'suppressed';
      await tx`
        UPDATE auth_flows
        SET code_hash = ${codeHash(budget.subjectKey, flow.id, known ? randomBytes(16).toString('hex') : code)}, expires_at = ${expiresAt}
        WHERE id = ${flow.id}
      `;
      await tx`UPDATE signup_drafts SET last_sent_at = ${now} WHERE flow_id = ${flow.id}`;
      const owner = known
        ? (await tx<Array<{ email: string }>>`SELECT email FROM users WHERE lower(email) = lower(${flow.email}) LIMIT 1`)[0]
        : undefined;
      await tx`
        INSERT INTO mail_outbox (flow_id, purpose, recipient, code, handle, expires_at, status)
        VALUES (${flow.id}, ${known ? 'signup-existing' : 'signup-code'}, ${owner?.email ?? flow.email}, ${known ? null : code}, NULL, ${expiresAt}, 'pending')
      `;
    },
    { isolation: 'read committed' },
  );
  await deps.afterCommit?.();
  return { accepted: true, next: 'confirm_email', flowId: input.flowId, resendAfterSeconds: budget.resendSeconds };
}

/**
 * Step 2. The right code makes the account: `create` inserts it inside the same transaction that consumes the
 * flow and deletes the draft, so a crash leaves either no account and a usable code, or an account and a spent
 * code. A wrong code counts; the owner's count locks the sign-up until it expires.
 */
export async function confirmSignUp(
  deps: SignUpDeps,
  input: { flowId: string; code: string },
  create: (tx: Sql, draft: SignUpDraft) => Promise<string>,
): Promise<{ userId: string; draft: SignUpDraft }> {
  const budget = requireBudget(deps);
  const now = deps.now();
  // One locked read decides everything: the count, the compare and the account. Guesses on the same sign-up queue on
  // the row, so a burst of codes is checked one at a time against the count, never against a stale read.
  const outcome = await transaction(
    deps.sql,
    async (tx): Promise<{ userId: string; draft: SignUpDraft } | SignUpError> => {
      const flow = await readFlow(tx, input.flowId, true);
      if (flow && (flow.consumed_at || flow.status === 'consumed')) {
        return new SignUpError('That code was already used. Sign in instead.', 'identity.signup_code_used');
      }
      if (!flow || new Date(flow.expires_at) <= now) return new SignUpError(EXPIRED, 'identity.signup_expired');
      const tooMany = () =>
        new SignUpError('Too many wrong codes. Start again later.', 'auth.too_many_attempts', {
          retryAfterSeconds: secondsUntil(new Date(flow.expires_at), now),
        });
      if (flow.status === 'locked' || flow.attempts >= budget.maxAttempts) return tooMany();
      const presented = Buffer.from(codeHash(budget.subjectKey, flow.id, input.code.trim()), 'hex');
      const stored = Buffer.from(flow.code_hash, 'hex');
      const right = presented.length === stored.length && timingSafeEqual(presented, stored) && flow.status === 'code_sent';
      if (!right) {
        const attempts = flow.attempts + 1;
        const lock = attempts >= budget.maxAttempts;
        await tx`UPDATE auth_flows SET attempts = ${attempts}, status = ${lock ? 'locked' : flow.status} WHERE id = ${flow.id}`;
        if (lock) {
          await tx`DELETE FROM signup_drafts WHERE flow_id = ${flow.id}`;
          return tooMany();
        }
        return new SignUpError('That code is not right. Check the email and try again.', 'identity.signup_code_invalid');
      }
      const rows = await tx<
        Array<{
          handle: string;
          email: string;
          password_hash: string;
          country: string;
          account_type: AccountType;
          referrer_id: string | null;
        }>
      >`SELECT handle, email, password_hash, country, account_type, referrer_id FROM signup_drafts WHERE flow_id = ${flow.id}`;
      const row = rows[0];
      if (!row) return new SignUpError(EXPIRED, 'identity.signup_expired');
      const draft: SignUpDraft = {
        flowId: flow.id,
        handle: row.handle,
        email: row.email,
        passwordHash: row.password_hash,
        country: row.country,
        accountType: row.account_type,
        referrerId: row.referrer_id,
      };
      const userId = await create(tx, draft);
      await tx`UPDATE users SET email_verified_at = ${now} WHERE id = ${userId}`;
      await tx`UPDATE profiles SET account_type = ${draft.accountType} WHERE user_id = ${userId}`;
      await tx`UPDATE auth_flows SET status = 'consumed', consumed_at = ${now}, user_id = ${userId} WHERE id = ${flow.id}`;
      await tx`DELETE FROM signup_drafts WHERE flow_id = ${flow.id}`;
      return { userId, draft };
    },
    { isolation: 'read committed' },
  );
  if (outcome instanceof SignUpError) throw outcome;
  return outcome;
}
