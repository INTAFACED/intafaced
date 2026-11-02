import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import {
  matchedVerificationCount,
  SUPPORT_DISCLOSURE_OWNER,
  SUPPORT_VERIFICATION_CHECK_OWNER,
  SUPPORT_VERIFICATION_CHECKS_REQUIRED,
  supportVerificationCheckSchema,
  type SupportDisclosureKind,
  type SupportRecordVerificationCheckInput,
  type SupportTicket,
  type SupportVerificationCheck,
  type SupportVerificationCheckKind,
  type SupportVerificationChecks,
  type SupportVerificationErrorCode,
} from '@intafaced/contracts';
import { SupportError } from './support-service.js';

/**
 * BALANCE DISCLOSURE GATE (RC-support-public-01, ACC-0189, SUP-0004; J-support-public-20 #2).
 *
 * Someone who writes in saying "my withdrawal is missing" may not be the account holder. So the desk may not read the
 * customer's balance, fills or withdrawal destination from a request until the request holds two matched checks the
 * customer can confirm: an email equal to their registered email, and one id of a record of their own.
 *
 * A check is proved by the service that owns the fact, never by the operator ticking a box, and the customer comes off the
 * ticket, never from the operator's input. svc-support never reads that service's tables; it asks a `VerificationAnswer`:
 *
 *   · email → svc-identity. Its one account door (`/internal/account/:userId`, the port in `account-state.ts`) carries no
 *     email and no comparison, so there is no answer to wire: an email check refuses `support.disclosure_unwired` naming
 *     svc-identity.
 *   · client_order_id → svc-trade, which serves no lookup by a customer's own order id (the desk's order read in
 *     `ticket-order.ts` takes svc-trade's order uuid, a different id). Refuses naming svc-trade.
 *   · withdrawal_id, deposit_id → svc-pay, which does not serve its ownership door (`support-record-ownership.ts`).
 *     Refuses naming svc-pay.
 *
 * Nothing is stored for a check that got no answer. A check that got one is stored as a sha256 digest of the value bound to
 * the ticket and kind, with whether it matched: never the value. A mismatch is stored unmatched and refuses
 * `support.verification_mismatch` without saying which part failed. The same value again counts once and asks nothing.
 *
 * With the gate held, each read still refuses `support.disclosure_unwired` naming its owner (svc-ledger for a balance,
 * svc-trade for fills, svc-pay for a destination): the desk has no read door, and this module adds none. Nothing here
 * moves, posts or reads money.
 *
 * Attempts per request are capped by an owner value (`SUPPORT_VERIFICATION_ATTEMPTS`). Blank, every check refuses
 * `support.verification_attempts_unset`; it is never defaulted. Every check attempt and every read is an audit row with the
 * operator. A closed request takes no check and opens no read. Checks stay on the request they were recorded on.
 */

/** Whether a value is the customer's, from the service that owns the fact. */
export interface VerificationAnswer {
  /** True or false from a verified answer for exactly this question; null when the service gave none. */
  matches(input: { kind: SupportVerificationCheckKind; value: string; userId: string }): Promise<boolean | null>;
}

/** Which owners this deployment can ask. Absent means the owner serves the desk no door yet; none is wired on main. */
export type VerificationOwners = Partial<Record<'svc-identity' | 'svc-trade' | 'svc-pay', VerificationAnswer>>;

export type StoredCheck = SupportVerificationCheck & { valueDigest: string };

export type VerificationAuditRow = {
  ticketId: string;
  action: 'record_attempt' | 'record' | 'disclosure';
  kind: SupportVerificationCheckKind | SupportDisclosureKind;
  /** `matched`, `already_recorded`, a refusal code, or `attempted` for the reserved attempt. */
  outcome: string;
  operator: string;
  at: string;
};

/** Where checks and their audit are kept. */
export interface CheckBook {
  list(ticketId: string): Promise<SupportVerificationCheck[]>;
  find(ticketId: string, kind: SupportVerificationCheckKind, valueDigest: string): Promise<SupportVerificationCheck | null>;
  /** Writes a check once per (ticket, kind, digest); the same again returns the first. */
  put(check: StoredCheck): Promise<SupportVerificationCheck>;
  attemptsUsed(ticketId: string): Promise<number>;
  /** Takes one attempt if fewer than `cap` are used, atomically, writing its `record_attempt` audit row. */
  reserveAttempt(row: VerificationAuditRow & { action: 'record_attempt' }, cap: number): Promise<boolean>;
  audit(row: VerificationAuditRow): Promise<void>;
}

/** The value as compared: an email folds case, a uuid folds case, a client order id is kept as the customer has it. */
export function normalizeCheckValue(kind: SupportVerificationCheckKind, value: string): string {
  const v = value.trim();
  return kind === 'client_order_id' ? v : v.toLowerCase();
}

/** sha256 over the ticket, kind and value, so one digest never matches across requests (`verify:<ticket>:<kind>:<value>`). */
export function checkDigest(ticketId: string, kind: SupportVerificationCheckKind, value: string): string {
  return createHash('sha256')
    .update(`verify:${ticketId.toLowerCase()}:${kind}:${normalizeCheckValue(kind, value)}`)
    .digest('hex');
}

const publicCheck = ({ valueDigest: _digest, ...check }: StoredCheck): SupportVerificationCheck => check;

export class MemoryCheckBook implements CheckBook {
  readonly rows: StoredCheck[] = [];
  readonly trail: VerificationAuditRow[] = [];

  async list(ticketId: string): Promise<SupportVerificationCheck[]> {
    return this.rows.filter((row) => row.ticketId === ticketId).map(publicCheck);
  }

  async find(ticketId: string, kind: SupportVerificationCheckKind, valueDigest: string): Promise<SupportVerificationCheck | null> {
    const row = this.rows.find((r) => r.ticketId === ticketId && r.kind === kind && r.valueDigest === valueDigest);
    return row ? publicCheck(row) : null;
  }

  async put(check: StoredCheck): Promise<SupportVerificationCheck> {
    const existing = await this.find(check.ticketId, check.kind, check.valueDigest);
    if (existing) return existing;
    this.rows.push({ ...check });
    return publicCheck(check);
  }

  async attemptsUsed(ticketId: string): Promise<number> {
    return this.trail.filter((row) => row.ticketId === ticketId && row.action === 'record_attempt').length;
  }

  async reserveAttempt(row: VerificationAuditRow & { action: 'record_attempt' }, cap: number): Promise<boolean> {
    if ((await this.attemptsUsed(row.ticketId)) >= cap) return false;
    this.trail.push({ ...row });
    return true;
  }

  async audit(row: VerificationAuditRow): Promise<void> {
    this.trail.push({ ...row });
  }
}

type PgCheck = {
  ticket_id: string;
  kind: SupportVerificationCheckKind;
  matched: boolean;
  checked_by: string;
  checked_at: Date;
};

function fromRow(row: PgCheck): SupportVerificationCheck {
  return supportVerificationCheckSchema.parse({
    ticketId: row.ticket_id,
    kind: row.kind,
    matched: row.matched,
    checkedBy: row.checked_by,
    checkedAt: row.checked_at.toISOString(),
  });
}

export class SqlCheckBook implements CheckBook {
  constructor(private readonly sql: Sql) {}

  async list(ticketId: string): Promise<SupportVerificationCheck[]> {
    const rows = await this.sql<PgCheck[]>`
      SELECT ticket_id, kind, matched, checked_by, checked_at FROM support.ticket_verification_checks
      WHERE ticket_id = ${ticketId} ORDER BY checked_at, kind, value_digest
    `;
    return rows.map(fromRow);
  }

  async find(ticketId: string, kind: SupportVerificationCheckKind, valueDigest: string): Promise<SupportVerificationCheck | null> {
    const rows = await this.sql<PgCheck[]>`
      SELECT ticket_id, kind, matched, checked_by, checked_at FROM support.ticket_verification_checks
      WHERE ticket_id = ${ticketId} AND kind = ${kind} AND value_digest = ${valueDigest}
    `;
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async put(check: StoredCheck): Promise<SupportVerificationCheck> {
    // The (ticket, kind, digest) key decides a race: the loser inserts nothing and reads the winner's row.
    await this.sql`
      INSERT INTO support.ticket_verification_checks (ticket_id, kind, value_digest, matched, checked_by, checked_at)
      VALUES (${check.ticketId}, ${check.kind}, ${check.valueDigest}, ${check.matched}, ${check.checkedBy}, ${check.checkedAt})
      ON CONFLICT (ticket_id, kind, value_digest) DO NOTHING
    `;
    const found = await this.find(check.ticketId, check.kind, check.valueDigest);
    if (!found) throw new Error('support.ticket_verification_checks: the check was neither written nor found');
    return found;
  }

  async attemptsUsed(ticketId: string): Promise<number> {
    const [row] = await this.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM support.verification_audit WHERE ticket_id = ${ticketId} AND action = 'record_attempt'
    `;
    return row?.n ?? 0;
  }

  async reserveAttempt(row: VerificationAuditRow & { action: 'record_attempt' }, cap: number): Promise<boolean> {
    // One request's attempts are counted and taken under one lock, so two operators at once cannot pass the cap together.
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`support.verification_attempts:${row.ticketId}`}, 0))`;
      const [used] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM support.verification_audit WHERE ticket_id = ${row.ticketId} AND action = 'record_attempt'
      `;
      if ((used?.n ?? 0) >= cap) return false;
      await tx`
        INSERT INTO support.verification_audit (ticket_id, action, kind, outcome, operator, at)
        VALUES (${row.ticketId}, ${row.action}, ${row.kind}, ${row.outcome}, ${row.operator}, ${row.at})
      `;
      return true;
    }) as Promise<boolean>;
  }

  async audit(row: VerificationAuditRow): Promise<void> {
    await this.sql`
      INSERT INTO support.verification_audit (ticket_id, action, kind, outcome, operator, at)
      VALUES (${row.ticketId}, ${row.action}, ${row.kind}, ${row.outcome}, ${row.operator}, ${row.at})
    `;
  }
}

function refuse(code: SupportVerificationErrorCode | 'support.ticket_closed', message: string, detail?: string): SupportError {
  return new SupportError(message, code, detail);
}

type TicketReader = {
  /** The ticket for an operator: a ticket outside their desk scope, or none, answers `support.not_found`. */
  getTicket(input: { userId: string; ticketId: string; asOperator?: boolean }): Promise<SupportTicket>;
};

export class VerificationChecks {
  constructor(
    private readonly book: CheckBook,
    private readonly support: TicketReader,
    /** The owner's cap on check attempts per request. Null is unset, and every check refuses. Never defaulted. */
    private readonly attemptsAllowed: number | null,
    /** None is wired on main: no owner serves the desk a door yet. */
    private readonly owners: VerificationOwners = {},
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async openTicket(operatorId: string, ticketId: string, closed: string): Promise<SupportTicket> {
    const ticket = await this.support.getTicket({ userId: operatorId, ticketId, asOperator: true });
    if (ticket.status === 'closed') throw refuse('support.ticket_closed', closed);
    return ticket;
  }

  /** Record one check, from what the customer says. Matched, it is returned; otherwise a typed refusal. */
  async record(operatorId: string, input: SupportRecordVerificationCheckInput): Promise<SupportVerificationCheck> {
    const ticket = await this.openTicket(operatorId, input.ticketId, 'a closed request takes no further checks');
    const at = this.now().toISOString();
    const trail = (outcome: string) =>
      this.book.audit({ ticketId: ticket.id, action: 'record', kind: input.kind, outcome, operator: operatorId, at });
    const fail = async (code: SupportVerificationErrorCode, message: string, detail?: string): Promise<never> => {
      await trail(code);
      throw refuse(code, message, detail);
    };

    if (this.attemptsAllowed === null)
      return fail('support.verification_attempts_unset', 'the owner has not set how many checks a request may take');

    const valueDigest = checkDigest(ticket.id, input.kind, input.value);
    // The same value again counts once: it asks nothing and takes no attempt.
    const existing = await this.book.find(ticket.id, input.kind, valueDigest);
    if (existing) {
      if (existing.matched) {
        await trail('already_recorded');
        return existing;
      }
      return fail('support.verification_mismatch', 'the check does not match');
    }

    // An owner with no door gives no answer to guess against, so asking it takes no attempt.
    const ownerName = SUPPORT_VERIFICATION_CHECK_OWNER[input.kind];
    const owner = this.owners[ownerName];
    if (!owner) return fail('support.disclosure_unwired', `${ownerName} serves the desk no door for this check yet`, ownerName);

    const taken = await this.book.reserveAttempt(
      { ticketId: ticket.id, action: 'record_attempt', kind: input.kind, outcome: 'attempted', operator: operatorId, at },
      this.attemptsAllowed,
    );
    if (!taken)
      return fail(
        'support.verification_attempts_exhausted',
        'this request has taken every check attempt allowed',
        `${this.attemptsAllowed}`,
      );

    const matched = await owner.matches({ kind: input.kind, value: normalizeCheckValue(input.kind, input.value), userId: ticket.userId });
    // No answer stores nothing: a failed owner read never writes a match.
    if (matched === null) return fail('support.disclosure_unwired', `${ownerName} gave no verified answer`, ownerName);

    const check = await this.book.put({
      ticketId: ticket.id,
      kind: input.kind,
      valueDigest,
      matched,
      checkedBy: operatorId,
      checkedAt: at,
    });
    if (!check.matched) return fail('support.verification_mismatch', 'the check does not match');
    await trail('matched');
    return check;
  }

  /** The checks on the request, oldest first, how many of the two are matched, and the attempts. Desk only. */
  async list(operatorId: string, ticketId: string): Promise<SupportVerificationChecks> {
    const ticket = await this.support.getTicket({ userId: operatorId, ticketId, asOperator: true });
    const checks = await this.book.list(ticket.id);
    return {
      required: SUPPORT_VERIFICATION_CHECKS_REQUIRED,
      matched: matchedVerificationCount(checks),
      attemptsAllowed: this.attemptsAllowed,
      attemptsUsed: await this.book.attemptsUsed(ticket.id),
      checks,
    };
  }

  /**
   * One read behind the gate. Always refuses: before the gate for want of the two matched checks, after it for want of the
   * owner's read door. Every call is an audit row with the operator.
   */
  async disclose(operatorId: string, ticketId: string, kind: SupportDisclosureKind): Promise<never> {
    const ticket = await this.openTicket(operatorId, ticketId, 'a closed request opens no read');
    const at = this.now().toISOString();
    const fail = async (code: SupportVerificationErrorCode, message: string, detail: string): Promise<never> => {
      await this.book.audit({ ticketId: ticket.id, action: 'disclosure', kind, outcome: code, operator: operatorId, at });
      throw refuse(code, message, detail);
    };
    const matched = matchedVerificationCount(await this.book.list(ticket.id));
    if (matched < SUPPORT_VERIFICATION_CHECKS_REQUIRED)
      return fail(
        'support.verification_checks_required',
        'an email and a record id the customer confirms are needed first',
        `${matched} of ${SUPPORT_VERIFICATION_CHECKS_REQUIRED} matched`,
      );
    const ownerName = SUPPORT_DISCLOSURE_OWNER[kind];
    return fail('support.disclosure_unwired', `${ownerName} serves the desk no read door yet`, ownerName);
  }
}
