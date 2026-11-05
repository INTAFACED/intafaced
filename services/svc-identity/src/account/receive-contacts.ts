/**
 * RECEIVE BY EMAIL OR PHONE (PP-send-request-03, J-pay-03 #6): the signed-in person adds an extra email address or phone
 * number people can pay them by. It counts only once they prove they hold it: a six-digit code goes to the address,
 * and the person types it back. A payment to a proved address finds the account (`users.searchPayees`).
 *
 * - Owner settings, none invented: how many addresses an account may add (`IDENTITY_RECEIVE_CONTACT_MAX`), how long a
 *   code works (`IDENTITY_RECEIVE_CONTACT_CODE_TTL_SECONDS`) and how many wrong codes it takes
 *   (`IDENTITY_RECEIVE_CONTACT_CODE_MAX_ATTEMPTS`). Blank refuses adding with `identity.receive_contact_unset`.
 * - The sender: with no mail transport an email cannot be proved, and with no text sender a phone cannot. Adding then
 *   refuses `identity.receive_contact_mail_off` or `identity.receive_contact_sms_off` and stores nothing, so the screen
 *   can say the code cannot be sent.
 * - One mail per code life: adding an address again while its code still works sends nothing new, so the add button
 *   cannot flood someone else's inbox. An expired code is replaced by a new one on the next add.
 * - A proved address names one account. Proving an address another account already proved, or that is another
 *   account's own sign-in address, answers exactly like a wrong code, so the screen never says who holds it.
 * - The signed-in owner only, on a live session, never an API key or a sub-account, never while a security lock holds
 *   or the account is not active. Every add, proof and removal writes an audit row in the same transaction.
 */
import { randomInt, timingSafeEqual } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { assertNotSecurityLocked } from '../auth/security-lock.js';
import type { PasswordResetMail } from '../auth/password-reset.js';
import { hashToken } from '../auth/passwords.js';
import { normaliseContactEmail, normaliseContactPhone } from './contact-common.js';

export type ReceiveContactCode =
  | 'identity.receive_contact_invalid'
  | 'identity.receive_contact_unset'
  | 'identity.receive_contact_cap_reached'
  | 'identity.receive_contact_mail_off'
  | 'identity.receive_contact_sms_off'
  | 'identity.contact_code_invalid'
  | 'identity.delegated_refused'
  | 'identity.session_not_live'
  | 'auth.account_frozen'
  | 'auth.not_found';

export class ReceiveContactError extends Error {
  constructor(
    readonly code: ReceiveContactCode,
    message: string,
    /** Only on `identity.receive_contact_cap_reached`: the published cap. */
    readonly details?: { readonly cap: number },
  ) {
    super(`${message} [${code}]`);
    this.name = 'ReceiveContactError';
  }
}

export type ReceiveChannel = 'email' | 'phone';

/** The text sender for a phone's code. No provider is built in; absent, a phone cannot be added. */
export interface ReceiveContactTextPort {
  send(message: { readonly phone: string; readonly code: string; readonly expiresAt: Date }): Promise<void>;
}

export interface ReceiveContactSettings {
  /** Addresses per account, counting ones not yet proved. Null: unpublished. */
  readonly max: number | null;
  /** Life of a code in seconds. Null: unpublished. */
  readonly codeTtlSeconds: number | null;
  /** Wrong codes one code takes before it stops working. Null: unpublished. */
  readonly codeMaxAttempts: number | null;
}

export interface ReceiveContactDeps {
  readonly sql: Sql;
  readonly mail: PasswordResetMail | undefined;
  readonly text: ReceiveContactTextPort | undefined;
  readonly settings: ReceiveContactSettings;
  readonly now?: () => Date;
  readonly log: { warn(obj: Record<string, unknown>, msg: string): void };
  /** Test seam: the code a new proof sends. Defaults to six random digits. */
  readonly newCode?: () => string;
}

export interface ReceiveActor {
  readonly userId: string;
  readonly sessionId: string;
  readonly apiKey: boolean;
  readonly subAccount: boolean;
}

export interface ReceiveContact {
  readonly id: string;
  readonly channel: ReceiveChannel;
  /** The address as the owner added it. Only ever shown to its owner. */
  readonly target: string;
  readonly verified: boolean;
}

export interface ReceiveContactList {
  readonly contacts: ReceiveContact[];
  /** The published cap, or null while unpublished (adding refuses). */
  readonly max: number | null;
}

type Row = {
  id: string;
  channel: ReceiveChannel;
  target: string;
  code_hash: string | null;
  code_expires_at: Date | string | null;
  attempts: number;
  verified_at: Date | string | null;
};

const MAX_TTL_SECONDS = 86_400;
const MAX_ATTEMPTS = 10;
const MAX_CONTACTS = 20;

/** An owner number inside its ceiling, or null. Blank, zero, fractions and anything past the ceiling stay unpublished. */
export function publishedWithin(value: number | undefined | null, ceiling: number): number | null {
  if (value === undefined || value === null) return null;
  return Number.isInteger(value) && value >= 1 && value <= ceiling ? value : null;
}

export function receiveContactSettings(env: {
  max?: number | undefined;
  codeTtlSeconds?: number | undefined;
  codeMaxAttempts?: number | undefined;
}): ReceiveContactSettings {
  return {
    max: publishedWithin(env.max, MAX_CONTACTS),
    codeTtlSeconds: publishedWithin(env.codeTtlSeconds, MAX_TTL_SECONDS),
    codeMaxAttempts: publishedWithin(env.codeMaxAttempts, MAX_ATTEMPTS),
  };
}

function sameHash(storedHex: string, presentedHex: string): boolean {
  const left = Buffer.from(storedHex, 'hex');
  const right = Buffer.from(presentedHex, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

const invalid = () => new ReceiveContactError('identity.contact_code_invalid', 'That code is not right, or it has stopped working');

export class ReceiveContactService {
  private readonly now: () => Date;
  private readonly newCode: () => string;

  constructor(private readonly deps: ReceiveContactDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newCode = deps.newCode ?? (() => String(randomInt(0, 1_000_000)).padStart(6, '0'));
  }

  async list(actor: ReceiveActor): Promise<ReceiveContactList> {
    this.assertOwner(actor);
    await this.requireLive(this.deps.sql, actor);
    return { contacts: await this.rows(this.deps.sql, actor.userId), max: this.deps.settings.max };
  }

  /**
   * Add an address and send its code. Adding one already proved answers the list unchanged; adding one whose code
   * still works sends nothing new.
   */
  async add(actor: ReceiveActor, input: { readonly channel: ReceiveChannel; readonly target: string }): Promise<ReceiveContactList> {
    this.assertOwner(actor);
    const target = input.channel === 'email' ? normaliseContactEmail(input.target) : normaliseContactPhone(input.target);
    if (target === null) {
      throw new ReceiveContactError(
        'identity.receive_contact_invalid',
        input.channel === 'email' ? 'That is not an email address' : 'A phone number starts with + and the country code',
      );
    }
    const { max, codeTtlSeconds, codeMaxAttempts } = this.deps.settings;
    if (max === null || codeTtlSeconds === null || codeMaxAttempts === null) {
      throw new ReceiveContactError('identity.receive_contact_unset', 'Adding a way to receive is not available yet');
    }
    if (input.channel === 'email' && !this.deps.mail) {
      throw new ReceiveContactError('identity.receive_contact_mail_off', 'Email is switched off, so we cannot send the code');
    }
    if (input.channel === 'phone' && !this.deps.text) {
      throw new ReceiveContactError('identity.receive_contact_sms_off', 'Text messages are switched off, so we cannot send the code');
    }
    const code = this.newCode();
    const expiresAt = new Date(this.now().getTime() + codeTtlSeconds * 1000);
    const send = await transaction(this.deps.sql, async (tx) => {
      await this.requireActive(tx, actor);
      const existing = await tx<Row[]>`
        SELECT id, channel, target::text AS target, code_hash, code_expires_at, attempts, verified_at
          FROM receive_contacts
         WHERE user_id = ${actor.userId} AND channel = ${input.channel} AND target = ${target}
         FOR UPDATE
      `;
      const row = existing[0];
      if (row?.verified_at) return false;
      if (row && row.code_expires_at && new Date(row.code_expires_at) > this.now() && row.attempts < codeMaxAttempts) return false;
      if (!row) {
        const count = await tx<Array<{ n: number }>>`SELECT count(*)::int AS n FROM receive_contacts WHERE user_id = ${actor.userId}`;
        if ((count[0]?.n ?? 0) >= max) {
          throw new ReceiveContactError('identity.receive_contact_cap_reached', `You can add up to ${max} ways to receive`, { cap: max });
        }
        await tx`
          INSERT INTO receive_contacts (user_id, channel, target, code_hash, code_expires_at)
          VALUES (${actor.userId}, ${input.channel}, ${target}, ${hashToken(code)}, ${expiresAt})
        `;
        await tx`
          INSERT INTO receive_contact_audit (user_id, session_id, channel, event, target)
          VALUES (${actor.userId}, ${actor.sessionId}, ${input.channel}, 'added', ${target})
        `;
      } else {
        await tx`
          UPDATE receive_contacts
             SET code_hash = ${hashToken(code)}, code_expires_at = ${expiresAt}, attempts = 0, updated_at = now()
           WHERE id = ${row.id}
        `;
      }
      return true;
    });
    if (send) await this.deliver(actor.userId, input.channel, target, code, expiresAt);
    return this.list(actor);
  }

  /** Prove an address with the code sent to it. A miss, an expiry, a lock and an address someone else holds all read the same. */
  async verify(actor: ReceiveActor, input: { readonly id: string; readonly code: string }): Promise<ReceiveContactList> {
    this.assertOwner(actor);
    const maxAttempts = this.deps.settings.codeMaxAttempts;
    if (maxAttempts === null)
      throw new ReceiveContactError('identity.receive_contact_unset', 'Adding a way to receive is not available yet');
    const presented = hashToken(input.code.trim());
    let wrong = false;
    try {
      await transaction(this.deps.sql, async (tx) => {
        await this.requireActive(tx, actor);
        const rows = await tx<Row[]>`
          SELECT id, channel, target::text AS target, code_hash, code_expires_at, attempts, verified_at
            FROM receive_contacts WHERE id = ${input.id} AND user_id = ${actor.userId}
           FOR UPDATE
        `;
        const row = rows[0];
        if (!row) throw new ReceiveContactError('auth.not_found', 'No such way to receive');
        if (row.verified_at) return;
        const live = row.code_hash !== null && row.code_expires_at !== null && new Date(row.code_expires_at) > this.now();
        if (!live || row.attempts >= maxAttempts) throw invalid();
        if (!sameHash(row.code_hash!, presented)) {
          wrong = true;
          return;
        }
        // Someone else's own sign-in address is theirs to be paid by: it is never proved for a second account.
        const column = row.channel === 'email' ? 'email' : 'phone';
        const owned = await tx<Array<{ one: number }>>`
          SELECT 1 AS one FROM users WHERE ${tx(column)} = ${row.target} AND id <> ${actor.userId} LIMIT 1
        `;
        if (owned.length > 0) throw invalid();
        await tx`
          UPDATE receive_contacts
             SET verified_at = ${this.now()}, code_hash = NULL, code_expires_at = NULL, updated_at = now()
           WHERE id = ${row.id}
        `;
        await tx`
          INSERT INTO receive_contact_audit (user_id, session_id, channel, event, target)
          VALUES (${actor.userId}, ${actor.sessionId}, ${row.channel}, 'verified', ${row.target})
        `;
      });
    } catch (err) {
      // Another account proved the same address first: the unique index decides, and the loser hears a wrong code.
      if ((err as { code?: string }).code === '23505') throw invalid();
      throw err;
    }
    if (wrong) {
      // Counted outside the proving transaction, so the wrong try sticks even though the answer is a refusal.
      await this.deps.sql`
        UPDATE receive_contacts SET attempts = attempts + 1, updated_at = now()
         WHERE id = ${input.id} AND user_id = ${actor.userId} AND verified_at IS NULL
      `;
      throw invalid();
    }
    return this.list(actor);
  }

  /** Stop receiving by an address. Payments already received stay. */
  async remove(actor: ReceiveActor, input: { readonly id: string }): Promise<ReceiveContactList> {
    this.assertOwner(actor);
    await transaction(this.deps.sql, async (tx) => {
      await this.requireActive(tx, actor);
      const rows = await tx<Array<{ channel: ReceiveChannel; target: string }>>`
        DELETE FROM receive_contacts WHERE id = ${input.id} AND user_id = ${actor.userId}
        RETURNING channel, target::text AS target
      `;
      const row = rows[0];
      if (!row) throw new ReceiveContactError('auth.not_found', 'No such way to receive');
      await tx`
        INSERT INTO receive_contact_audit (user_id, session_id, channel, event, target)
        VALUES (${actor.userId}, ${actor.sessionId}, ${row.channel}, 'removed', ${row.target})
      `;
    });
    return this.list(actor);
  }

  private async deliver(userId: string, channel: ReceiveChannel, target: string, code: string, expiresAt: Date): Promise<void> {
    try {
      if (channel === 'email') await this.deps.mail!.send({ email: target, code, expiresAt, purpose: 'receive-contact-code' });
      else await this.deps.text!.send({ phone: target, code, expiresAt });
    } catch {
      // The code is a secret: the error's text may hold it, so only the fact is logged. The person can add again
      // once the code's life is over.
      this.deps.log.warn({ userId, channel, reason: 'delivery' }, 'identity.receive_contact_delivery_failed');
    }
  }

  private async rows(q: Sql, userId: string): Promise<ReceiveContact[]> {
    const rows = await q<Array<{ id: string; channel: ReceiveChannel; target: string; verified: boolean }>>`
      SELECT id, channel, target::text AS target, verified_at IS NOT NULL AS verified
        FROM receive_contacts WHERE user_id = ${userId} ORDER BY created_at, id
    `;
    return rows.map((row) => ({ id: row.id, channel: row.channel, target: row.target, verified: row.verified }));
  }

  private assertOwner(actor: ReceiveActor): void {
    if (actor.apiKey || actor.subAccount) {
      throw new ReceiveContactError('identity.delegated_refused', 'Sign in on this device. An API key or a sub-account cannot change this');
    }
  }

  private async requireLive(q: Sql, actor: ReceiveActor): Promise<void> {
    const rows = await q<Array<{ live: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM sessions
        WHERE id::text = ${actor.sessionId} AND user_id = ${actor.userId} AND revoked = false AND expires_at > now()
      ) AS live
    `;
    if (!rows[0]?.live) throw new ReceiveContactError('identity.session_not_live', 'This sign-in has ended. Sign in again');
  }

  /** A live session, no security lock, and an active account, with the account row held for the rest of the change. */
  private async requireActive(tx: Sql, actor: ReceiveActor): Promise<void> {
    await this.requireLive(tx, actor);
    await assertNotSecurityLocked(tx, actor.userId);
    const rows = await tx<Array<{ status: string }>>`SELECT status FROM users WHERE id = ${actor.userId} FOR UPDATE`;
    if (!rows[0]) throw new ReceiveContactError('auth.not_found', 'No such account');
    if (rows[0].status !== 'active') throw new ReceiveContactError('auth.account_frozen', 'Account is unavailable');
  }
}
