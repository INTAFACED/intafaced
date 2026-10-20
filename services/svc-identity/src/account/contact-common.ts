/**
 * Shared rules for email and phone changes.
 *
 * The code TTL and the attempt cap are owner-published. Blank, zero, or a
 * value past the ceiling is unwired (`auth.change_unwired`). Nothing here
 * invents 900 seconds or 5 attempts. The ceiling on the cap is 5, and the
 * ceiling on the lifetime is one day.
 */
import { timingSafeEqual } from 'node:crypto';
import type { ActionApprovalConsumeInput } from '@intafaced/contracts';
import { customerStepUpPayloadHash } from '@intafaced/contracts';
import { transaction } from '@intafaced/db';
import type { Sql } from 'postgres';
import { ActionApprovalError } from '../auth/action-approval-service.js';
import type { PasswordResetMail } from '../auth/password-reset.js';
import { generateToken, hashToken } from '../auth/passwords.js';
import { userCopy } from '../user-copy.js';

/** Structural match for `PhoneCodeSender` in phone-change.ts. Kept here so the two files do not import each other. */
export type PhoneSenderPort = {
  send(message: {
    readonly phone: string;
    readonly code: string;
    readonly expiresAt: Date;
    readonly purpose: 'phone-change' | 'phone-notice';
  }): Promise<void>;
};

/** One day. Longer than that is not a contact-change proof. */
const MAX_TTL_SECONDS = 86_400;
/** The brief's ceiling. A published cap above this is unwired, not clamped. */
const MAX_ATTEMPTS = 5;

export const CONTACT_TTL_KEY = 'IDENTITY_CONTACT_CHANGE_TTL_SECONDS';
export const CONTACT_ATTEMPTS_KEY = 'IDENTITY_CONTACT_CHANGE_MAX_ATTEMPTS';
export const MAIL_PORT_KEY = 'IDENTITY_MAIL_TRANSPORT';

export type ContactChannel = 'email' | 'phone';

export type ContactCode =
  | 'auth.change_unwired'
  | 'auth.session_invalid'
  | 'identity.contact_code_invalid'
  | 'identity.email_invalid'
  | 'identity.phone_invalid'
  | 'identity.phone_missing'
  | 'identity.step_up_required'
  | 'identity.step_up_expired'
  | 'identity.step_up_used'
  | 'identity.step_up_not_yours'
  | 'identity.step_up_target'
  | 'identity.delegated_refused'
  | 'identity.account_unwired';

export class ContactError extends Error {
  constructor(
    readonly code: ContactCode,
    message = userCopy(code),
  ) {
    super(message);
    this.name = 'ContactError';
  }
}

export type ContactLog = { warn(obj: Record<string, unknown>, msg: string): void };

export type ApprovalConsumer = {
  consume(callerService: string, input: ActionApprovalConsumeInput): Promise<unknown>;
};

export type ContactDeps = {
  readonly sql: Sql;
  readonly approvals: ApprovalConsumer;
  mail: PasswordResetMail | undefined;
  phone: PhoneSenderPort | undefined;
  ttlSeconds: number | undefined;
  maxAttempts: number | undefined;
  now: () => Date;
  log: ContactLog;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+[1-9][0-9]{7,14}$/;
const DUMMY_HASH = hashToken('contact-change-compare-dummy');

export function publishedContactChangeTtlSeconds(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > MAX_TTL_SECONDS) return undefined;
  return value;
}

/** 1 to 5. Blank and anything above the ceiling stay unpublished. */
export function publishedContactChangeMaxAttempts(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > MAX_ATTEMPTS) return undefined;
  return value;
}

export function normaliseContactEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > 320 || !EMAIL.test(email)) return null;
  return email;
}

/** Trimmed E.164. Spaces and dashes are not rewritten into a number. */
export function normaliseContactPhone(raw: string): string | null {
  const phone = raw.trim();
  return PHONE.test(phone) ? phone : null;
}

export function contactPayloadHash(scope: string, userId: string, field: string, value: string): string {
  return customerStepUpPayloadHash(scope, { actor: userId, [field]: value });
}

function hashesEqual(storedHex: string, presentedHex: string): boolean {
  const left = Buffer.from(storedHex, 'hex');
  const right = Buffer.from(presentedHex, 'hex');
  const dummy = Buffer.from(DUMMY_HASH, 'hex');
  if (left.length !== right.length || left.length !== dummy.length) {
    timingSafeEqual(dummy, dummy);
    return false;
  }
  return timingSafeEqual(left, right);
}

export function postgresCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object' || !('code' in err)) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function unwired(message: string): ContactError {
  return new ContactError('auth.change_unwired', message);
}

/** TTL and attempt cap. The port is checked by the caller, which names its own key. */
export function requirePublishedBudget(deps: ContactDeps): { ttlSeconds: number; maxAttempts: number } {
  const ttlSeconds = publishedContactChangeTtlSeconds(deps.ttlSeconds);
  if (ttlSeconds === undefined) {
    deps.log.warn({ reason: 'ttl', key: CONTACT_TTL_KEY }, 'auth.change_unwired');
    throw unwired(`Changing this contact is not available yet. ${CONTACT_TTL_KEY} is not set.`);
  }
  const maxAttempts = publishedContactChangeMaxAttempts(deps.maxAttempts);
  if (maxAttempts === undefined) {
    deps.log.warn({ reason: 'attempts', key: CONTACT_ATTEMPTS_KEY }, 'auth.change_unwired');
    throw unwired(`Changing this contact is not available yet. ${CONTACT_ATTEMPTS_KEY} is not set.`);
  }
  return { ttlSeconds, maxAttempts };
}

export function mapStepUpError(err: unknown): never {
  if (err instanceof ActionApprovalError) {
    const code =
      err.code === 'action_approval.expired'
        ? 'identity.step_up_expired'
        : err.code === 'action_approval.consumed'
          ? 'identity.step_up_used'
          : err.code === 'action_approval.not_requester'
            ? 'identity.step_up_not_yours'
            : err.code === 'action_approval.payload_mismatch' || err.code === 'action_approval.target_mismatch'
              ? 'identity.step_up_target'
              : 'identity.step_up_required';
    throw new ContactError(code);
  }
  throw err;
}

const INVALID = () => new ContactError('identity.contact_code_invalid');

type ProofRow = {
  id: string;
  target: string;
  code_hash: string;
  attempts: number;
  expires_at: Date | string;
  consumed_at: Date | string | null;
};

export async function consumeStepUp(
  deps: ContactDeps,
  input: { userId: string; sessionId: string; scope: string; field: string; value: string; stepUpApprovalId: string },
): Promise<void> {
  try {
    await deps.approvals.consume('svc-identity', {
      approvalId: input.stepUpApprovalId,
      operationId: input.stepUpApprovalId,
      payloadHash: contactPayloadHash(input.scope, input.userId, input.field, input.value),
      targetService: 'svc-identity',
      targetId: input.scope,
      expectedVersion: '1',
      principalUserId: input.userId,
      principalSessionId: input.sessionId,
    });
  } catch (err) {
    // The payload hash includes the actor, so another person's approval misses the hash
    // before the principal check. Say it is not theirs, not that the address differs.
    if (err instanceof ActionApprovalError && err.code === 'action_approval.payload_mismatch') {
      const rows = await deps.sql<Array<{ requester_id: string }>>`
        SELECT requester_id FROM action_approvals WHERE approval_id = ${input.stepUpApprovalId}
      `;
      if (rows[0] && rows[0].requester_id !== input.userId) throw new ContactError('identity.step_up_not_yours');
    }
    mapStepUpError(err);
  }
}

export async function insertProof(
  deps: ContactDeps,
  input: { userId: string; sessionId: string; channel: ContactChannel; target: string; ttlSeconds: number },
): Promise<{ code: string; expiresAt: Date }> {
  const code = generateToken(32);
  const codeHash = hashToken(code);
  const expiresAt = new Date(deps.now().getTime() + input.ttlSeconds * 1000);
  await deps.sql`
    INSERT INTO contact_change_proofs (user_id, channel, target, code_hash, expires_at)
    VALUES (${input.userId}, ${input.channel}, ${input.target}, ${codeHash}, ${expiresAt})
  `;
  await deps.sql`
    INSERT INTO contact_change_audit (user_id, session_id, channel, event, new_target)
    VALUES (${input.userId}, ${input.sessionId}, ${input.channel}, ${'begin'}, ${input.target})
  `;
  return { code, expiresAt };
}

async function bumpNewest(deps: ContactDeps, userId: string, channel: ContactChannel, maxAttempts: number): Promise<void> {
  const now = deps.now();
  await deps.sql`
    UPDATE contact_change_proofs
    SET attempts = attempts + 1
    WHERE id = (
      SELECT id FROM contact_change_proofs
      WHERE user_id = ${userId}
        AND channel = ${channel}
        AND consumed_at IS NULL
        AND expires_at > ${now}
        AND attempts < ${maxAttempts}
      ORDER BY created_at DESC
      LIMIT 1
    )
  `;
}

/**
 * Match the presented code to one open proof. A miss, an expiry, a lock, and
 * a replay all answer the same invalid code and write nothing about the secret.
 */
export async function takeMatchingProof(
  deps: ContactDeps,
  input: { userId: string; channel: ContactChannel; code: string; maxAttempts: number },
): Promise<ProofRow> {
  const presented = hashToken(input.code.trim());
  const now = deps.now();
  const rows = await deps.sql<ProofRow[]>`
    SELECT id, target, code_hash, attempts, expires_at, consumed_at
    FROM contact_change_proofs
    WHERE user_id = ${input.userId}
      AND channel = ${input.channel}
      AND consumed_at IS NULL
      AND expires_at > ${now}
      AND attempts < ${input.maxAttempts}
    ORDER BY created_at DESC
  `;
  const match = rows.find((row) => hashesEqual(row.code_hash, presented));
  if (!match) {
    await bumpNewest(deps, input.userId, input.channel, input.maxAttempts);
    throw INVALID();
  }
  return match;
}

export async function assertLiveSession(tx: Sql, userId: string, sessionId: string): Promise<void> {
  const live = await tx<Array<{ id: string }>>`
    SELECT id FROM sessions
    WHERE id = ${sessionId} AND user_id = ${userId} AND revoked = false AND expires_at > now()
  `;
  if (!live[0]) throw new ContactError('auth.session_invalid');
}

export async function revokeOtherSessions(tx: Sql, userId: string, sessionId: string): Promise<string[]> {
  const revoked = await tx<Array<{ id: string }>>`
    UPDATE sessions SET revoked = true
    WHERE user_id = ${userId} AND revoked = false AND id <> ${sessionId}
    RETURNING id
  `;
  return revoked.map((row) => row.id);
}

export async function killPasswordResetProofs(tx: Sql, userId: string, now: Date): Promise<void> {
  await tx`
    UPDATE password_reset_proofs SET consumed_at = ${now}
    WHERE user_id = ${userId} AND consumed_at IS NULL
  `;
  await tx`
    UPDATE auth_flows SET status = 'consumed', consumed_at = ${now}
    WHERE user_id = ${userId} AND kind = 'password_reset' AND consumed_at IS NULL
  `;
}

export async function writeAudit(
  tx: Sql,
  input: {
    userId: string;
    sessionId: string;
    channel: ContactChannel;
    event: 'confirm' | 'remove';
    oldTarget: string | null;
    newTarget: string | null;
    oldNotice: 'sent' | 'failed' | 'unsent';
  },
): Promise<string> {
  const rows = await tx<Array<{ id: string }>>`
    INSERT INTO contact_change_audit (user_id, session_id, channel, event, old_target, new_target, old_notice)
    VALUES (
      ${input.userId}, ${input.sessionId}, ${input.channel}, ${input.event},
      ${input.oldTarget}, ${input.newTarget}, ${input.oldNotice}
    )
    RETURNING id
  `;
  return rows[0]!.id;
}

export async function markNotice(sql: Sql, auditId: string, oldNotice: 'sent' | 'failed' | 'unsent'): Promise<void> {
  await sql`UPDATE contact_change_audit SET old_notice = ${oldNotice} WHERE id = ${auditId}`;
}

/** Delivery failures are recorded. The thrown error's text is not logged: it may contain the code. */
export async function deliver(deps: ContactDeps, input: { userId: string; run: () => Promise<void> }): Promise<'sent' | 'failed'> {
  try {
    await input.run();
    return 'sent';
  } catch {
    deps.log.warn({ userId: input.userId, reason: 'delivery' }, 'identity.contact_change_notice_failed');
    return 'failed';
  }
}

export { transaction, INVALID as invalidCode };
