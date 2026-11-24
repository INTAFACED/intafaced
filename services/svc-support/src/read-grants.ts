import type { Sql } from 'postgres';
import { z } from 'zod';
import type {
  ServiceAuthMode,
  ServiceSigner,
  SupportCustomerBalances,
  SupportDisclosure,
  SupportDisclosureKind,
  SupportReadAccess,
  SupportReadGrant,
  SupportReadRow,
  SupportTicket,
  SupportWithdrawalDestination,
} from '@intafaced/contracts';
import { callHttpRecord } from '@intafaced/contracts/procedure-http';
import { serviceCallSigner } from '@intafaced/contracts/service-auth-http';
import {
  SUPPORT_CUSTOMER_BALANCE_READ,
  SUPPORT_READ_DESTINATIONS_MAX,
  SUPPORT_READ_LIST_MAX,
  SUPPORT_WITHDRAWAL_DESTINATIONS_READ,
} from '@intafaced/contracts/support-read-grants';
import { SUPPORT_DISCLOSURE_KINDS, SUPPORT_DISCLOSURE_OWNER } from '@intafaced/contracts/support-verification-checks';
import { identitySecretSet } from './identity-grounding-honesty.js';
import { SupportError } from './support-service.js';
import type { VerificationAuditRow } from './verification-checks.js';

/**
 * A CUSTOMER'S GRANT FOR SUPPORT TO READ (J-support-public-20 #2, RC-support-public-01; owner row d115, 17 Nov 2026).
 *
 * The desk may not read a customer's balance or withdrawal destination from a request until the customer, on their own
 * request, grants support a read for a set time. The newest grant is the one that counts: it ends at its own time, and
 * a new grant replaces it. Without a live grant every read refuses `support.read_grant_required` (`none` or `expired`)
 * and nothing is asked of any owner.
 *
 * Under a live grant the figure comes from its owner, asked for the request's own customer (never one the agent names):
 * the balance from svc-trade, the destination of each withdrawal linked to the request from svc-pay. An owner that is
 * not wired, or gave no answer, refuses `support.disclosure_unwired` naming it. Fills have no door yet and refuse the
 * same way. svc-support stores no figure.
 *
 * Each answered read is one append-only row the customer reads on their request (what, who, when), written before the
 * answer leaves: a read that cannot be listed is not answered. Every ask, answered or refused, is also a row of the
 * desk's own audit with the operator. A closed request takes no grant and opens no read. Nothing here moves or posts
 * money.
 */

const READ_GRANT_REQUIRED = 'support.read_grant_required' as const;
const READ_WITHDRAWAL_UNLINKED = 'support.read_withdrawal_unlinked' as const;

/** The figures' owners, asked as svc-support. Each answers null when it gave no verified answer. */
export interface ReadOwners {
  balance?: (userId: string) => Promise<SupportCustomerBalances | null>;
  destinations?: (input: { userId: string; withdrawalIds: string[] }) => Promise<SupportWithdrawalDestination[] | null>;
}

type StoredGrant = { grantedAt: string; expiresAt: string };

/** Where grants and the customer's list of reads are kept. Both only ever grow. */
export interface ReadGrantBook {
  grant(row: { ticketId: string; userId: string } & StoredGrant): Promise<void>;
  /** The newest grant on the request, or null when the customer gave none. */
  latest(ticketId: string): Promise<StoredGrant | null>;
  recordRead(row: { ticketId: string } & SupportReadRow): Promise<void>;
  /** The request's reads, newest first. */
  reads(ticketId: string, limit: number): Promise<SupportReadRow[]>;
}

export class MemoryReadGrantBook implements ReadGrantBook {
  readonly grants: Array<{ ticketId: string; userId: string } & StoredGrant> = [];
  readonly rows: Array<{ ticketId: string } & SupportReadRow> = [];

  async grant(row: { ticketId: string; userId: string } & StoredGrant): Promise<void> {
    this.grants.push({ ...row });
  }
  async latest(ticketId: string): Promise<StoredGrant | null> {
    const found = this.grants.filter((g) => g.ticketId === ticketId).at(-1);
    return found ? { grantedAt: found.grantedAt, expiresAt: found.expiresAt } : null;
  }
  async recordRead(row: { ticketId: string } & SupportReadRow): Promise<void> {
    this.rows.push({ ...row });
  }
  async reads(ticketId: string, limit: number): Promise<SupportReadRow[]> {
    return this.rows
      .filter((r) => r.ticketId === ticketId)
      .map(({ ticketId: _ticket, ...row }) => row)
      .reverse()
      .slice(0, limit);
  }
}

const GrantRow = z.object({ granted_at: z.date(), expires_at: z.date() });
const ReadRow = z.object({ kind: z.enum(SUPPORT_DISCLOSURE_KINDS), read_by: z.string(), read_at: z.date() });

export class SqlReadGrantBook implements ReadGrantBook {
  constructor(private readonly sql: Sql) {}

  async grant(row: { ticketId: string; userId: string } & StoredGrant): Promise<void> {
    await this.sql`
      INSERT INTO support.read_grants (ticket_id, user_id, granted_at, expires_at)
      VALUES (${row.ticketId}, ${row.userId}, ${row.grantedAt}, ${row.expiresAt})
    `;
  }
  async latest(ticketId: string): Promise<StoredGrant | null> {
    const [row] = GrantRow.array().parse(
      await this.sql`SELECT granted_at, expires_at FROM support.read_grants WHERE ticket_id = ${ticketId} ORDER BY id DESC LIMIT 1`,
    );
    return row ? { grantedAt: row.granted_at.toISOString(), expiresAt: row.expires_at.toISOString() } : null;
  }
  async recordRead(row: { ticketId: string } & SupportReadRow): Promise<void> {
    await this.sql`
      INSERT INTO support.read_grant_reads (ticket_id, kind, read_by, read_at)
      VALUES (${row.ticketId}, ${row.kind}, ${row.readBy}, ${row.readAt})
    `;
  }
  async reads(ticketId: string, limit: number): Promise<SupportReadRow[]> {
    const rows = ReadRow.array().parse(
      await this.sql`
        SELECT kind, read_by, read_at FROM support.read_grant_reads WHERE ticket_id = ${ticketId} ORDER BY id DESC LIMIT ${limit}
      `,
    );
    return rows.map((row) => ({ kind: row.kind, readBy: row.read_by, readAt: row.read_at.toISOString() }));
  }
}

type TicketReader = {
  /** The ticket for its owner, or for an operator: one outside their sight answers `support.not_found`. */
  getTicket(input: { userId: string; ticketId: string; asOperator?: boolean }): Promise<SupportTicket>;
};

export interface ReadGrantParts {
  readonly book: ReadGrantBook;
  readonly support: TicketReader;
  /** The ids of the withdrawals linked to a request (`ticket-links.ts`). */
  readonly linkedWithdrawals: (ticketId: string) => Promise<string[]>;
  /** Left out, none is wired: every read under a grant refuses naming its owner. */
  readonly owners?: ReadOwners;
  /** The desk's own audit of every ask (`support.verification_audit`). */
  readonly audit?: (row: VerificationAuditRow) => Promise<void>;
  readonly now?: () => Date;
}

export class ReadGrants {
  private readonly book: ReadGrantBook;
  private readonly support: TicketReader;
  private readonly linkedWithdrawals: (ticketId: string) => Promise<string[]>;
  private readonly owners: ReadOwners;
  private readonly audit: (row: VerificationAuditRow) => Promise<void>;
  private readonly now: () => Date;

  constructor(parts: ReadGrantParts) {
    this.book = parts.book;
    this.support = parts.support;
    this.linkedWithdrawals = parts.linkedWithdrawals;
    this.owners = parts.owners ?? {};
    this.audit = parts.audit ?? (async () => undefined);
    this.now = parts.now ?? (() => new Date());
  }

  private view(ticketId: string, grant: StoredGrant, at: Date): SupportReadGrant {
    return { ticketId, grantedAt: grant.grantedAt, expiresAt: grant.expiresAt, active: Date.parse(grant.expiresAt) > at.getTime() };
  }

  /** The customer, on their own request, grants support a read for `seconds`. Someone else's request is not found. */
  async grant(userId: string, input: { ticketId: string; seconds: number }): Promise<SupportReadGrant> {
    const ticket = await this.support.getTicket({ userId, ticketId: input.ticketId });
    // Only the request's own customer grants: an operator reading as staff is never the one who gives permission.
    if (ticket.userId !== userId) throw new SupportError('ticket not found', 'support.not_found');
    if (ticket.status === 'closed') throw new SupportError('a closed request takes no grant', 'support.ticket_closed');
    const at = this.now();
    const grant = { grantedAt: at.toISOString(), expiresAt: new Date(at.getTime() + input.seconds * 1000).toISOString() };
    await this.book.grant({ ticketId: ticket.id, userId, ...grant });
    return this.view(ticket.id, grant, at);
  }

  /** The customer's own view: the newest grant on their request and each read the desk was answered. */
  async access(userId: string, ticketId: string): Promise<SupportReadAccess> {
    const ticket = await this.support.getTicket({ userId, ticketId });
    if (ticket.userId !== userId) throw new SupportError('ticket not found', 'support.not_found');
    const grant = await this.book.latest(ticket.id);
    return {
      ticketId: ticket.id,
      grant: grant ? this.view(ticket.id, grant, this.now()) : null,
      reads: await this.book.reads(ticket.id, SUPPORT_READ_LIST_MAX),
    };
  }

  /** One read by the desk. Refused without the customer's live grant; answered from the owner, and listed, with one. */
  async read(operatorId: string, ticketId: string, kind: SupportDisclosureKind): Promise<SupportDisclosure> {
    const ticket = await this.support.getTicket({ userId: operatorId, ticketId, asOperator: true });
    const at = this.now();
    const readAt = at.toISOString();
    const trail = (outcome: string) =>
      this.audit({ ticketId: ticket.id, action: 'disclosure', kind, outcome, operator: operatorId, at: readAt });
    const fail = async (code: string, message: string, detail?: string): Promise<never> => {
      await trail(code);
      throw new SupportError(message, code, detail);
    };
    if (ticket.status === 'closed') return fail('support.ticket_closed', 'a closed request opens no read');
    const grant = await this.book.latest(ticket.id);
    if (!grant) return fail(READ_GRANT_REQUIRED, 'the customer has not granted support a read on this request', 'none');
    if (Date.parse(grant.expiresAt) <= at.getTime()) return fail(READ_GRANT_REQUIRED, "the customer's grant has ended", 'expired');

    const ownerName = SUPPORT_DISCLOSURE_OWNER[kind];
    const unwired = (why: string) => fail('support.disclosure_unwired', `${ownerName} ${why}`, ownerName);
    let answer: SupportDisclosure;
    if (kind === 'balance') {
      if (!this.owners.balance) return unwired('serves the desk no read door here');
      const balances = await this.owners.balance(ticket.userId).catch(() => null);
      if (balances === null) return unwired('gave no verified answer');
      answer = { kind, readAt, grantExpiresAt: grant.expiresAt, balances };
    } else if (kind === 'destination') {
      const withdrawalIds = (await this.linkedWithdrawals(ticket.id)).slice(0, SUPPORT_READ_DESTINATIONS_MAX);
      if (withdrawalIds.length === 0) return fail(READ_WITHDRAWAL_UNLINKED, 'no withdrawal is linked to this request');
      if (!this.owners.destinations) return unwired('serves the desk no read door here');
      const withdrawals = await this.owners.destinations({ userId: ticket.userId, withdrawalIds }).catch(() => null);
      // Only the linked withdrawals are an answer: anything else is no answer at all.
      if (withdrawals === null || withdrawals.some((row) => !withdrawalIds.includes(row.withdrawalId)))
        return unwired('gave no verified answer');
      answer = { kind, readAt, grantExpiresAt: grant.expiresAt, withdrawals };
    } else {
      return unwired('serves the desk no read door yet');
    }
    // Listed to the customer before the answer leaves: a read that cannot be listed is not answered.
    await this.book.recordRead({ ticketId: ticket.id, kind, readBy: operatorId, readAt });
    await trail('read');
    return answer;
  }
}

type S2s = { signer: ServiceSigner; mode: ServiceAuthMode };

/** svc-trade's balance door and svc-pay's destination door, each signed as svc-support. Any failure is no answer (null). */
export function createReadOwners(input: { tradeUrl?: string; payUrl?: string; internalSecret: string; s2s?: S2s }): ReadOwners {
  if (!identitySecretSet(input.internalSecret)) return {};
  const refusal = (path: string, status: number) => new Error(`${path} refused (${status})`);
  const within =
    (ms: number): typeof fetch =>
    (target, init) =>
      fetch(target, { ...init, signal: AbortSignal.timeout(ms) });
  const owners: ReadOwners = {};
  if (input.tradeUrl) {
    const baseUrl = input.tradeUrl;
    const sign = serviceCallSigner({ service: 'svc-support', audience: 'svc-trade', legacySecret: input.internalSecret, s2s: input.s2s });
    owners.balance = async (userId) => {
      try {
        const reply = await callHttpRecord(SUPPORT_CUSTOMER_BALANCE_READ, {
          baseUrl,
          input: { userId },
          sign,
          errorOf: refusal,
          fetcher: within(5_000),
        });
        return reply.balances;
      } catch {
        return null;
      }
    };
  }
  if (input.payUrl) {
    const baseUrl = input.payUrl;
    const sign = serviceCallSigner({ service: 'svc-support', audience: 'svc-pay', legacySecret: input.internalSecret, s2s: input.s2s });
    owners.destinations = async (ask) => {
      try {
        const reply = await callHttpRecord(SUPPORT_WITHDRAWAL_DESTINATIONS_READ, {
          baseUrl,
          input: ask,
          sign,
          errorOf: refusal,
          fetcher: within(5_000),
        });
        return reply.withdrawals;
      } catch {
        return null;
      }
    };
  }
  return owners;
}
