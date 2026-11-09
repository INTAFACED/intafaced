import type { Sql } from 'postgres';
import {
  serviceCallSigner,
  SUPPORT_RECORD_OWNERSHIP_PATH,
  supportRecordOwnershipResultSchema,
  type ServiceAuthMode,
  type ServiceSigner,
  type SupportTicket,
} from '@intafaced/contracts';
import { SupportError } from './support-service.js';
import type { TicketOrderSource } from './ticket-order.js';
import { identitySecretSet } from './identity-grounding-honesty.js';

/**
 * A REQUEST'S LINKS TO THE CUSTOMER'S OWN RECORDS (J-support-public-20 #1, SUP-0007).
 *
 * The desk links a request to a related order, withdrawal or deposit by the record's id. It is linked only when the
 * service that owns the record says it belongs to the ticket's customer: svc-trade for an order (its support order read,
 * comparing the owner here), svc-pay for a withdrawal or a deposit (its one-boolean ownership door). The customer comes off
 * the ticket, never from the operator's input. svc-support never reads those services' tables.
 *
 * Another customer's record and a record that doesn't exist refuse the same way, `support.link_record_not_owned`, so a link
 * attempt tells the desk nothing about an id that isn't the customer's. An owner that gives no answer (not wired, down)
 * refuses `support.link_record_unverifiable` and links nothing. Linking again is the same link.
 *
 * A request linked to an order that svc-trade reports as `recovery_required` ranks above a withdrawal request of the same
 * age in the desk's queue (`RECOVERY_LINK_WEIGHT`). Nothing here moves, posts or reads money.
 */

export const TICKET_LINK_KINDS = ['order', 'withdrawal', 'deposit'] as const;
export type TicketLinkKind = (typeof TICKET_LINK_KINDS)[number];

export const LINK_RECORD_NOT_OWNED = 'support.link_record_not_owned' as const;
export const LINK_RECORD_UNVERIFIABLE = 'support.link_record_unverifiable' as const;

export interface TicketLink {
  readonly ticketId: string;
  readonly kind: TicketLinkKind;
  readonly recordId: string;
  /** The order's status as svc-trade read it when it was linked; false for a withdrawal or a deposit. */
  readonly recoveryRequired: boolean;
  readonly linkedBy: string;
  readonly linkedAt: string;
}

/** Whether svc-pay says a withdrawal or deposit is the customer's: true or false, or null when it gave no answer. */
export interface PayOwnership {
  owned(input: { kind: 'withdrawal' | 'deposit'; recordId: string; userId: string }): Promise<boolean | null>;
}

/** Where links are kept. */
export interface LinkBook {
  list(ticketId: string): Promise<TicketLink[]>;
  /** Writes the link once per (ticket, kind, record); the same link again returns the first. */
  put(link: TicketLink): Promise<TicketLink>;
  /** The requests that hold a link to a `recovery_required` order. */
  recoveryTickets(): Promise<Set<string>>;
}

type TicketReader = {
  getTicket(input: { userId: string; ticketId: string; asOperator?: boolean }): Promise<SupportTicket>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TicketLinks {
  constructor(
    private readonly book: LinkBook,
    private readonly support: TicketReader,
    private readonly orders: TicketOrderSource | null,
    private readonly pay: PayOwnership | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(operatorId: string, ticketId: string): Promise<TicketLink[]> {
    const ticket = await this.support.getTicket({ userId: operatorId, ticketId, asOperator: true });
    return this.book.list(ticket.id);
  }

  async link(operatorId: string, input: { ticketId: string; kind: TicketLinkKind; recordId: string }): Promise<TicketLink> {
    const ticket = await this.support.getTicket({ userId: operatorId, ticketId: input.ticketId, asOperator: true });
    if (ticket.status === 'closed') throw new SupportError('a closed request takes no links', 'support.ticket_closed');
    if (!UUID.test(input.recordId)) throw notOwned();
    const recordId = input.recordId.toLowerCase();
    let recoveryRequired = false;
    if (input.kind === 'order') {
      if (!this.orders) throw unverifiable('svc-trade');
      const read = await this.orders.read(recordId);
      // An id svc-trade holds no order for refuses as another customer's order does; a trade that gave no answer links nothing.
      if (read.kind === 'missing') throw notOwned();
      if (read.kind === 'unknown') throw unverifiable('svc-trade');
      if (read.order.orderId !== recordId || read.order.userId !== ticket.userId) throw notOwned();
      recoveryRequired = read.order.status === 'recovery_required';
    } else {
      if (!this.pay) throw unverifiable('svc-pay');
      const owned = await this.pay.owned({ kind: input.kind, recordId, userId: ticket.userId });
      if (owned === null) throw unverifiable('svc-pay');
      if (!owned) throw notOwned();
    }
    return this.book.put({
      ticketId: ticket.id,
      kind: input.kind,
      recordId,
      recoveryRequired,
      linkedBy: operatorId,
      linkedAt: this.now().toISOString(),
    });
  }

  recoveryTickets(): Promise<Set<string>> {
    return this.book.recoveryTickets();
  }
}

function notOwned(): SupportError {
  return new SupportError("that record is not one of this request's customer's records", LINK_RECORD_NOT_OWNED);
}
function unverifiable(owner: string): SupportError {
  return new SupportError(`${owner} gave no answer, so nothing was linked`, LINK_RECORD_UNVERIFIABLE, owner);
}

interface LinkRow {
  ticket_id: string;
  kind: TicketLinkKind;
  record_id: string;
  recovery_required: boolean;
  linked_by: string;
  linked_at: Date;
}
const fromRow = (row: LinkRow): TicketLink => ({
  ticketId: row.ticket_id,
  kind: row.kind,
  recordId: row.record_id,
  recoveryRequired: row.recovery_required,
  linkedBy: row.linked_by,
  linkedAt: row.linked_at.toISOString(),
});

export class SqlLinkBook implements LinkBook {
  constructor(private readonly sql: Sql) {}

  async list(ticketId: string): Promise<TicketLink[]> {
    const rows = await this.sql<LinkRow[]>`
      SELECT ticket_id, kind, record_id, recovery_required, linked_by, linked_at FROM support.ticket_links
       WHERE ticket_id = ${ticketId} ORDER BY linked_at, kind, record_id
    `;
    return rows.map(fromRow);
  }

  async put(link: TicketLink): Promise<TicketLink> {
    await this.sql`
      INSERT INTO support.ticket_links (ticket_id, kind, record_id, recovery_required, linked_by, linked_at)
      VALUES (${link.ticketId}, ${link.kind}, ${link.recordId}, ${link.recoveryRequired}, ${link.linkedBy}, ${link.linkedAt})
      ON CONFLICT (ticket_id, kind, record_id) DO NOTHING
    `;
    const rows = await this.sql<LinkRow[]>`
      SELECT ticket_id, kind, record_id, recovery_required, linked_by, linked_at FROM support.ticket_links
       WHERE ticket_id = ${link.ticketId} AND kind = ${link.kind} AND record_id = ${link.recordId}
    `;
    return fromRow(rows[0]!);
  }

  async recoveryTickets(): Promise<Set<string>> {
    const rows = await this.sql<{ ticket_id: string }[]>`SELECT DISTINCT ticket_id FROM support.ticket_links WHERE recovery_required`;
    return new Set(rows.map((row) => row.ticket_id));
  }
}

export class MemoryLinkBook implements LinkBook {
  private readonly rows = new Map<string, TicketLink>();
  async list(ticketId: string): Promise<TicketLink[]> {
    return [...this.rows.values()].filter((row) => row.ticketId === ticketId);
  }
  async put(link: TicketLink): Promise<TicketLink> {
    const key = `${link.ticketId}:${link.kind}:${link.recordId}`;
    const held = this.rows.get(key);
    if (held) return held;
    this.rows.set(key, link);
    return link;
  }
  async recoveryTickets(): Promise<Set<string>> {
    return new Set([...this.rows.values()].filter((row) => row.recoveryRequired).map((row) => row.ticketId));
  }
}

/**
 * svc-pay's ownership door (`packages/contracts/src/support-record-ownership.ts`), signed as svc-support. Any answer but a
 * verified `{ owned }` is no answer (null), never a guess.
 */
export function createPayOwnershipClient(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): PayOwnership | null {
  if (!baseUrl || !identitySecretSet(internalSecret)) return null;
  const target = new URL(`${baseUrl.replace(/\/$/, '')}${SUPPORT_RECORD_OWNERSHIP_PATH}`);
  const sign = serviceCallSigner({ service: 'svc-support', audience: 'svc-pay', legacySecret: internalSecret, s2s });
  return {
    async owned(input) {
      const body = JSON.stringify(input);
      try {
        const res = await fetch(target, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            ...sign(body, { method: 'POST', url: target, contentType: 'application/json' }),
          },
          body,
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) return null;
        const parsed = supportRecordOwnershipResultSchema.safeParse(await res.json());
        return parsed.success ? parsed.data.owned : null;
      } catch {
        return null;
      }
    },
  };
}
