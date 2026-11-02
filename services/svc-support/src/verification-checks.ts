import type { Sql } from 'postgres';
import {
  SUPPORT_CHECK_RECORD_OWNER,
  SUPPORT_VERIFICATION_CHECKS_REQUIRED,
  supportVerificationCheckSchema,
  type SupportCheckRecordKind,
  type SupportRecordVerificationCheckInput,
  type SupportTicket,
  type SupportVerificationCheck,
  type SupportVerificationChecks,
  type SupportVerificationErrorCode,
} from '@intafaced/contracts';
import { SupportError } from './support-service.js';
import type { TicketOrderSource } from './ticket-order.js';

/**
 * BALANCE DISCLOSURE GATE (RC-support-public-01, J-support-public-20 #2).
 *
 * Someone who writes in saying "my withdrawal is missing" may not be the account holder. So the desk may not read the
 * customer's balance or withdrawal destination from a request until two checks the customer can confirm are recorded on
 * that request.
 *
 * A check is proved by the service that owns the fact, never by the operator ticking a box. The one kind is `owned_record`:
 * an order, withdrawal or deposit id the customer quotes, which counts only when its owning service says it is the ticket
 * customer's. The customer comes off the ticket, never from the operator's input. svc-support never reads that service's
 * tables, so it asks through a `RecordOwnershipAnswer`:
 *
 *   · svc-pay answers for a withdrawal or a deposit through its signed ownership door (`SUPPORT_RECORD_OWNERSHIP_PATH` in
 *     `packages/contracts`). svc-pay does not serve that door yet, so the desk has no answer wired: recording the check
 *     refuses `support.verification_check_owner_unwired` naming svc-pay, and no check is written.
 *   · svc-trade answers for an order through the order read the desk already makes (`ticket-order.ts`, GET
 *     `/internal/orders/:id`): the order's own userId is compared with the ticket customer's. svc-trade does not serve that
 *     read yet, so a configured TRADE_URL answers nothing and the check refuses `support.verification_check_owner_unreachable`
 *     naming svc-trade; with TRADE_URL unset it refuses `support.verification_check_owner_unwired`.
 *
 * With two checks on two different records recorded, the gate opens and the read still refuses
 * (`support.balance_read_unwired`, `support.withdrawal_destination_read_unwired`): the desk has no read of a balance or a
 * destination, and this module adds none. Nothing here moves, posts or reads money.
 *
 * A closed request takes no check and opens no read (`support.ticket_closed`): a request reopened later is not proved by
 * checks recorded before it closed. Checks stay on the request they were recorded on; a merge does not carry them.
 *
 * Checks are append-only (a database trigger refuses update and delete), once per (ticket, record kind, record id).
 */

/** Whether a record belongs to a customer, from the service that owns it. */
export interface RecordOwnershipAnswer {
  /** True or false from a verified answer for exactly this question; null when the service gave none. */
  owns(input: { recordKind: SupportCheckRecordKind; recordId: string; userId: string }): Promise<boolean | null>;
}

/**
 * svc-trade's answer for an order, from the order read svc-support already makes. Only a parsed snapshot for exactly that
 * order is an answer; anything else (route unserved, trade silent, matcher down, a reply that does not parse) is none.
 * A missing order is therefore no answer rather than a "no": the desk never infers ownership from a silence.
 */
export function tradeOrderOwnership(orders: TicketOrderSource): RecordOwnershipAnswer {
  return {
    async owns({ recordKind, recordId, userId }) {
      if (recordKind !== 'order') return null;
      const read = await orders.read(recordId);
      if (read.kind !== 'order' || read.order.orderId.toLowerCase() !== recordId.toLowerCase()) return null;
      return read.order.userId.toLowerCase() === userId.toLowerCase();
    },
  };
}

/** Which owners this deployment can ask. Absent means the owner gives the desk no answer yet. */
export type RecordOwners = Partial<Record<'svc-pay' | 'svc-trade', RecordOwnershipAnswer>>;

/** Where checks are kept. `put` writes a check once; the same (ticket, record kind, record id) again returns the first. */
export interface CheckBook {
  list(ticketId: string): Promise<SupportVerificationCheck[]>;
  put(check: SupportVerificationCheck): Promise<SupportVerificationCheck>;
}

const sameRecord = (a: Pick<SupportVerificationCheck, 'ticketId' | 'recordKind' | 'recordId'>, b: typeof a) =>
  a.ticketId === b.ticketId && a.recordKind === b.recordKind && a.recordId.toLowerCase() === b.recordId.toLowerCase();

export class MemoryCheckBook implements CheckBook {
  private readonly rows: SupportVerificationCheck[] = [];

  async list(ticketId: string): Promise<SupportVerificationCheck[]> {
    return this.rows.filter((row) => row.ticketId === ticketId).map((row) => ({ ...row }));
  }

  async put(check: SupportVerificationCheck): Promise<SupportVerificationCheck> {
    const existing = this.rows.find((row) => sameRecord(row, check));
    if (existing) return { ...existing };
    this.rows.push({ ...check });
    return { ...check };
  }
}

type PgCheck = {
  ticket_id: string;
  kind: 'owned_record';
  record_kind: SupportCheckRecordKind;
  record_id: string;
  recorded_by: string;
  recorded_at: Date;
};

function fromRow(row: PgCheck): SupportVerificationCheck {
  return supportVerificationCheckSchema.parse({
    ticketId: row.ticket_id,
    kind: row.kind,
    recordKind: row.record_kind,
    recordId: row.record_id,
    recordedBy: row.recorded_by,
    recordedAt: row.recorded_at.toISOString(),
  });
}

const COLUMNS = 'ticket_id, kind, record_kind, record_id, recorded_by, recorded_at';

export class SqlCheckBook implements CheckBook {
  constructor(private readonly sql: Sql) {}

  async list(ticketId: string): Promise<SupportVerificationCheck[]> {
    const rows = await this.sql<PgCheck[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM support.ticket_verification_checks
      WHERE ticket_id = ${ticketId} ORDER BY recorded_at, record_kind, record_id
    `;
    return rows.map(fromRow);
  }

  async put(check: SupportVerificationCheck): Promise<SupportVerificationCheck> {
    // The (ticket, record kind, record id) key decides a race: the loser inserts nothing and reads the winner's row.
    await this.sql`
      INSERT INTO support.ticket_verification_checks (ticket_id, kind, record_kind, record_id, recorded_by, recorded_at)
      VALUES (${check.ticketId}, ${check.kind}, ${check.recordKind}, ${check.recordId}, ${check.recordedBy}, ${check.recordedAt})
      ON CONFLICT (ticket_id, record_kind, record_id) DO NOTHING
    `;
    const rows = await this.sql<PgCheck[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM support.ticket_verification_checks
      WHERE ticket_id = ${check.ticketId} AND record_kind = ${check.recordKind} AND record_id = ${check.recordId}
    `;
    if (!rows[0]) throw new Error('support.ticket_verification_checks: the check was neither written nor found');
    return fromRow(rows[0]);
  }
}

function refuse(code: SupportVerificationErrorCode | 'support.ticket_closed', message: string, detail?: string): SupportError {
  return new SupportError(message, code, detail);
}

export class VerificationChecks {
  constructor(
    private readonly book: CheckBook,
    private readonly support: {
      /** The ticket for an operator: a ticket outside their desk scope, or none, answers `support.not_found`. */
      getTicket(input: { userId: string; ticketId: string; asOperator?: boolean }): Promise<SupportTicket>;
    },
    /** Absent owners give no answer: svc-pay does not serve its ownership door; svc-trade answers through its order read. */
    private readonly owners: RecordOwners = {},
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Record one check, if the owning service says the quoted record is the ticket customer's. Refused, nothing is written. */
  async record(operatorId: string, input: SupportRecordVerificationCheckInput): Promise<SupportVerificationCheck> {
    const ticket = await this.support.getTicket({ userId: operatorId, ticketId: input.ticketId, asOperator: true });
    if (ticket.status === 'closed') throw refuse('support.ticket_closed', 'a closed request takes no further checks');
    const recordId = input.recordId.toLowerCase();
    // A record already checked was proved the customer's when it was recorded; recording it again changes nothing.
    const existing = (await this.book.list(ticket.id)).find((row) =>
      sameRecord(row, { ticketId: ticket.id, recordKind: input.recordKind, recordId }),
    );
    if (existing) return existing;

    const ownerName = SUPPORT_CHECK_RECORD_OWNER[input.recordKind];
    const owner = this.owners[ownerName];
    if (!owner) throw refuse('support.verification_check_owner_unwired', `${ownerName} gives the desk no ownership answer yet`, ownerName);
    const owned = await owner.owns({ recordKind: input.recordKind, recordId, userId: ticket.userId });
    if (owned === null)
      throw refuse('support.verification_check_owner_unreachable', `${ownerName} gave no verified ownership answer`, ownerName);
    // A missing record and another customer's answer the same way: the refusal says nothing about which ids exist.
    if (!owned) throw refuse('support.verification_check_not_owned', "the record is not the ticket customer's");

    return this.book.put({
      ticketId: ticket.id,
      kind: input.kind,
      recordKind: input.recordKind,
      recordId,
      recordedBy: operatorId,
      recordedAt: this.now().toISOString(),
    });
  }

  /** The checks on the request, oldest first, and how many the gate needs. Desk only. */
  async list(operatorId: string, ticketId: string): Promise<SupportVerificationChecks> {
    const ticket = await this.support.getTicket({ userId: operatorId, ticketId, asOperator: true });
    return { required: SUPPORT_VERIFICATION_CHECKS_REQUIRED, checks: await this.book.list(ticket.id) };
  }

  /** The customer's balance, behind the gate. Always refuses: before the checks for want of them, after for want of a read. */
  async customerBalance(operatorId: string, ticketId: string): Promise<never> {
    await this.gate(operatorId, ticketId);
    throw refuse('support.balance_read_unwired', 'the desk has no read of a balance');
  }

  /** The customer's withdrawal destination, behind the same gate. Always refuses, as `customerBalance` does. */
  async customerWithdrawalDestination(operatorId: string, ticketId: string): Promise<never> {
    await this.gate(operatorId, ticketId);
    throw refuse('support.withdrawal_destination_read_unwired', 'the desk has no read of a withdrawal destination');
  }

  private async gate(operatorId: string, ticketId: string): Promise<void> {
    const ticket = await this.support.getTicket({ userId: operatorId, ticketId, asOperator: true });
    if (ticket.status === 'closed') throw refuse('support.ticket_closed', 'a closed request opens no read');
    const checks = await this.book.list(ticket.id);
    const required = SUPPORT_VERIFICATION_CHECKS_REQUIRED;
    if (checks.length < required)
      throw refuse(
        'support.verification_checks_required',
        'two checks the customer can confirm are needed first',
        `${checks.length} of ${required} recorded`,
      );
  }
}
