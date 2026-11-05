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
 * - Sending is budgeted: adding an address again while its code still works sends nothing new, and one account sends
 *   no more codes inside one code life than the address cap (`identity.receive_contact_wait`), whatever it added,
 *   removed or re-added, so the add button can neither flood someone else's inbox nor work through the code space. A
 *   handoff the sender refuses takes the code back and says so (`identity.receive_contact_send_failed`).
 * - Wrong codes are counted under the row lock in the same transaction, so tries made at the same time cannot all
 *   read the same count.
 * - A proved address names one account. Proving an address another account already proved, or that is another
 *   account's own sign-in address, answers exactly like a wrong code, so the screen never says who holds it. Should
 *   another account later take it as its sign-in address, a payee search by it names no one rather than guess
 *   (`AuthService.searchPayee`).
 * - The signed-in owner only, on a live session, never an API key or a sub-account, never while a security lock holds
 *   or the account is not active. Every add, proof and removal writes an audit row in the same transaction.
 */
import { randomInt, timingSafeEqual } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { assertNotSecurityLocked } from '../auth/security-lock.js';
import type { PasswordResetMail } from '../auth/password-reset.js';
import { hashToken } from '../auth/passwords.js';
import { normaliseContactEmail, normaliseContactPhone, postgresCode } from './contact-common.js';

export type ReceiveContactCode =
  | 'identity.receive_contact_invalid'
  | 'identity.receive_contact_unset'
  | 'identity.receive_contact_cap_reached'
  | 'identity.receive_contact_mail_off'
  | 'identity.receive_contact_sms_off'
  | 'identity.receive_contact_wait'
  | 'identity.receive_contact_send_failed'
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

/** An owner number, or null. Blank, zero and fractions stay unpublished; env.ts holds the ceilings and refuses past them at start. */
export function published(value: number | undefined | null): number | null {
  if (value === undefined || value === null) return null;
  return Number.isInteger(value) && value >= 1 ? value : null;
}

export function receiveContactSettings(env: {
  max?: number | undefined;
  codeTtlSeconds?: number | undefined;
  codeMaxAttempts?: number | undefined;
}): ReceiveContactSettings {
  return { max: published(env.max), codeTtlSeconds: published(env.codeTtlSeconds), codeMaxAttempts: published(env.codeMaxAttempts) };
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
    return this.view(this.deps.sql, actor.userId);
  }

  /**
   * Add an address and send its code. Adding one already proved answers the list unchanged; adding one whose code
   * still works sends nothing new. Codes sent by one account are budgeted: no more than the address cap inside one code
   * life, whatever was added, removed or re-added, so neither an inbox nor the code space can be worked by repetition.
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
    const codeHash = hashToken(code);
    const now = this.now();
    const expiresAt = new Date(now.getTime() + codeTtlSeconds * 1000);
    const outcome = await transaction(this.deps.sql, async (tx) => {
      await this.requireActive(tx, actor);
      const existing = await tx<Row[]>`
        SELECT id, channel, target::text AS target, code_hash, code_expires_at, attempts, verified_at
          FROM receive_contacts
         WHERE user_id = ${actor.userId} AND channel = ${input.channel} AND target = ${target}
         FOR UPDATE
      `;
      const row = existing[0];
      if (row?.verified_at) return { send: false as const, list: await this.view(tx, actor.userId) };
      if (row && row.code_expires_at && new Date(row.code_expires_at) > now && row.attempts < codeMaxAttempts) {
        return { send: false as const, list: await this.view(tx, actor.userId) };
      }
      let id: string;
      if (!row) {
        const count = await tx<Array<{ n: number }>>`SELECT count(*)::int AS n FROM receive_contacts WHERE user_id = ${actor.userId}`;
        if ((count[0]?.n ?? 0) >= max) {
          throw new ReceiveContactError('identity.receive_contact_cap_reached', `You can add up to ${max} ways to receive`, { cap: max });
        }
        await this.assertSendBudget(tx, actor.userId, max, codeTtlSeconds, now);
        const inserted = await tx<Array<{ id: string }>>`
          INSERT INTO receive_contacts (user_id, channel, target, code_hash, code_expires_at)
          VALUES (${actor.userId}, ${input.channel}, ${target}, ${codeHash}, ${expiresAt})
          RETURNING id
        `;
        id = inserted[0]!.id;
        await this.audit(tx, actor, input.channel, 'added', target, now);
      } else {
        await this.assertSendBudget(tx, actor.userId, max, codeTtlSeconds, now);
        id = row.id;
        await tx`
          UPDATE receive_contacts
             SET code_hash = ${codeHash}, code_expires_at = ${expiresAt}, attempts = 0, updated_at = now()
           WHERE id = ${row.id}
        `;
      }
      await this.audit(tx, actor, input.channel, 'code_sent', target, now);
      return { send: true as const, id, list: await this.view(tx, actor.userId) };
    });
    if (outcome.send) await this.deliver(actor.userId, outcome.id, codeHash, input.channel, target, code, expiresAt);
    return outcome.list;
  }

  /** Prove an address with the code sent to it. A miss, an expiry, a lock and an address someone else holds all read the same. */
  async verify(actor: ReceiveActor, input: { readonly id: string; readonly code: string }): Promise<ReceiveContactList> {
    this.assertOwner(actor);
    const maxAttempts = this.deps.settings.codeMaxAttempts;
    if (maxAttempts === null) {
      throw new ReceiveContactError('identity.receive_contact_unset', 'Adding a way to receive is not available yet');
    }
    const presented = hashToken(input.code.trim());
    let outcome: { wrong: true } | { wrong: false; list: ReceiveContactList };
    try {
      outcome = await transaction(this.deps.sql, async (tx) => {
        await this.requireActive(tx, actor);
        const rows = await tx<Row[]>`
          SELECT id, channel, target::text AS target, code_hash, code_expires_at, attempts, verified_at
            FROM receive_contacts WHERE id = ${input.id} AND user_id = ${actor.userId}
           FOR UPDATE
        `;
        const row = rows[0];
        if (!row) throw new ReceiveContactError('auth.not_found', 'No such way to receive');
        if (row.verified_at) return { wrong: false as const, list: await this.view(tx, actor.userId) };
        const live = row.code_hash !== null && row.code_expires_at !== null && new Date(row.code_expires_at) > this.now();
        if (!live || row.attempts >= maxAttempts) throw invalid();
        if (!sameHash(row.code_hash!, presented)) {
          // Counted under the row lock and committed with this transaction, so tries made at the same time queue
          // behind each other and each one sees the count the one before it left.
          await tx`UPDATE receive_contacts SET attempts = attempts + 1, updated_at = now() WHERE id = ${row.id}`;
          return { wrong: true as const };
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
        await this.audit(tx, actor, row.channel, 'verified', row.target, this.now());
        return { wrong: false as const, list: await this.view(tx, actor.userId) };
      });
    } catch (err) {
      // Another account proved the same address first: the unique index decides, and the loser hears a wrong code.
      if (postgresCode(err) === '23505') throw invalid();
      throw err;
    }
    if (outcome.wrong) throw invalid();
    return outcome.list;
  }

  /** Stop receiving by an address. Payments already received stay. */
  async remove(actor: ReceiveActor, input: { readonly id: string }): Promise<ReceiveContactList> {
    this.assertOwner(actor);
    return transaction(this.deps.sql, async (tx) => {
      await this.requireActive(tx, actor);
      const rows = await tx<Array<{ channel: ReceiveChannel; target: string }>>`
        DELETE FROM receive_contacts WHERE id = ${input.id} AND user_id = ${actor.userId}
        RETURNING channel, target::text AS target
      `;
      const row = rows[0];
      if (!row) throw new ReceiveContactError('auth.not_found', 'No such way to receive');
      await this.audit(tx, actor, row.channel, 'removed', row.target, this.now());
      return this.view(tx, actor.userId);
    });
  }

  /**
   * Hand the code to the sender. A failed handoff takes that code back (the row stays, unproved, with no live code), so
   * the person is told now and can ask for a new one, instead of waiting out a code that never arrived.
   */
  private async deliver(
    userId: string,
    id: string,
    codeHash: string,
    channel: ReceiveChannel,
    target: string,
    code: string,
    expiresAt: Date,
  ): Promise<void> {
    try {
      if (channel === 'email') await this.deps.mail!.send({ email: target, code, expiresAt, purpose: 'receive-contact-code' });
      else await this.deps.text!.send({ phone: target, code, expiresAt });
    } catch {
      // The code is a secret: the error's text may hold it, so only the fact is logged.
      this.deps.log.warn({ userId, channel, reason: 'delivery' }, 'identity.receive_contact_delivery_failed');
      await this.deps.sql`
        UPDATE receive_contacts SET code_hash = NULL, code_expires_at = NULL, updated_at = now()
         WHERE id = ${id} AND code_hash = ${codeHash}
      `;
      throw new ReceiveContactError('identity.receive_contact_send_failed', 'We could not send the code. Try again in a moment');
    }
  }

  /** No more codes inside one code life than the address cap, counted over every address the account touched. */
  private async assertSendBudget(tx: Sql, userId: string, max: number, codeTtlSeconds: number, now: Date): Promise<void> {
    const since = new Date(now.getTime() - codeTtlSeconds * 1000);
    const sent = await tx<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM receive_contact_audit
       WHERE user_id = ${userId} AND event = 'code_sent' AND created_at > ${since}
    `;
    if ((sent[0]?.n ?? 0) >= max) {
      throw new ReceiveContactError('identity.receive_contact_wait', 'Too many codes sent. Wait a few minutes, then add it again');
    }
  }

  private async audit(
    tx: Sql,
    actor: ReceiveActor,
    channel: ReceiveChannel,
    event: 'added' | 'code_sent' | 'verified' | 'removed',
    target: string,
    at: Date,
  ): Promise<void> {
    await tx`
      INSERT INTO receive_contact_audit (user_id, session_id, channel, event, target, created_at)
      VALUES (${actor.userId}, ${actor.sessionId}, ${channel}, ${event}, ${target}, ${at})
    `;
  }

  private async view(q: Sql, userId: string): Promise<ReceiveContactList> {
    const rows = await q<Array<{ id: string; channel: ReceiveChannel; target: string; verified: boolean }>>`
      SELECT id, channel, target::text AS target, verified_at IS NOT NULL AS verified
        FROM receive_contacts WHERE user_id = ${userId} ORDER BY created_at, id
    `;
    return {
      contacts: rows.map((row) => ({ id: row.id, channel: row.channel, target: row.target, verified: row.verified })),
      max: this.deps.settings.max,
    };
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
