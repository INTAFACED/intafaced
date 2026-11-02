import type { Sql } from 'postgres';
import {
  SUPPORT_LINKED_RECORD_OWNER,
  SUPPORT_RECORD_OWNERSHIP_PATH,
  serviceCallSigner,
  supportLinkedRecordSchema,
  supportRecordOwnershipInputSchema,
  supportRecordOwnershipResultSchema,
  type ServiceAuthMode,
  type ServiceSigner,
  type SupportLinkableRecordKind,
  type SupportLinkedRecord,
  type SupportLinkRecordErrorCode,
  type SupportLinkRecordInput,
  type SupportOwnedRecordKind,
  type SupportTicket,
} from '@intafaced/contracts';
import { SupportError } from './support-service.js';

/**
 * RECORDS LINKED TO A REQUEST (J-support-public-20 #1).
 *
 * The desk links a related order, withdrawal or deposit to a ticket by its id. Only a record that already belongs to the
 * ticket's customer is linked, and the customer comes off the ticket, never from the operator's input.
 *
 * This desk cannot see whose a record is: the record lives in the service that owns it, and svc-support never reads that
 * service's tables. So it asks: svc-pay answers for a withdrawal or a deposit through its signed ownership door
 * (`SUPPORT_RECORD_OWNERSHIP_PATH`), one boolean for (kind, id, customer). Three answers are possible and each stays itself:
 *
 *   · owned: the link is written, once (a second link of the same record returns the first).
 *   · not owned: `support.link_record_not_owned`. svc-pay answers a missing id and another customer's id the same way, so
 *     neither does this desk: the refusal says nothing about whether the id exists.
 *   · no verified answer (no address, no credential, transport failure, no such door, a shape that is not the contract's):
 *     `support.link_record_owner_unwired` or `support.link_record_owner_unreachable`, naming the service. Never read as
 *     "not owned" and never as "owned".
 *
 * Orders refuse `support.link_record_owner_unwired` naming svc-trade: svc-trade has no ownership answer for an order. The
 * desk's order read (`ticket-order.ts`) is not one: it folds a missing order into the same "silent" answer as a dark plane,
 * so using it would refuse another customer's order and a missing order differently, telling the desk which ids exist.
 *
 * Nothing is moved, copied or posted. A link holds the record's kind and id, who linked it and when; no amount, status,
 * asset or address is stored here. Links are append-only (a database trigger refuses update and delete).
 */

/** svc-pay's ownership door, as the desk calls it. */
export interface RecordOwnershipDoor {
  /** False with no svc-pay address or no credential: every withdrawal or deposit link refuses naming svc-pay. */
  readonly configured: boolean;
  /** True or false from a verified answer for exactly this question; null when no such answer came back. */
  owns(input: { kind: SupportOwnedRecordKind; recordId: string; userId: string }): Promise<boolean | null>;
}

export const UNWIRED_RECORD_OWNERSHIP: RecordOwnershipDoor = { configured: false, owns: async () => null };

/** A signed POST to svc-pay's door, the body bound to the signature, bounded in time. Every failure is null. */
export function createRecordOwnershipClient(options: {
  payUrl?: string;
  /** The shared internal secret (the legacy S2S form); with `s2s` in keypair mode it is not sent. */
  secret?: string;
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode };
  timeoutMs?: number;
  fetcher?: typeof fetch;
}): RecordOwnershipDoor {
  let base: string | null = null;
  try {
    const url = new URL(options.payUrl ?? '');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    base = url.href.replace(/\/$/, '');
  } catch {
    /* No address: unconfigured. */
  }
  const credentialed = Boolean(options.secret && options.secret.length >= 32) || options.s2s?.mode === 'keypair';
  if (base === null || !credentialed) return UNWIRED_RECORD_OWNERSHIP;
  const target = `${base}${SUPPORT_RECORD_OWNERSHIP_PATH}`;
  const sign = serviceCallSigner({ service: 'svc-support', audience: 'svc-pay', legacySecret: options.secret ?? '', s2s: options.s2s });

  return {
    configured: true,
    async owns(raw) {
      const input = supportRecordOwnershipInputSchema.parse(raw);
      const body = JSON.stringify(input);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
      try {
        const response = await (options.fetcher ?? fetch)(target, {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            ...sign(body, { method: 'POST', url: new URL(target), contentType: 'application/json' }),
          },
          body,
        });
        // Only a 200 carrying exactly the contract's answer counts. A 404 is a svc-pay without the door, not "no record".
        if (response.status !== 200) return null;
        const parsed = supportRecordOwnershipResultSchema.safeParse(await response.json());
        return parsed.success ? parsed.data.owned : null;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Where links are kept. `put` writes a link once; the same (ticket, kind, id) again returns the first. */
export interface LinkBook {
  list(ticketId: string): Promise<SupportLinkedRecord[]>;
  put(link: SupportLinkedRecord): Promise<SupportLinkedRecord>;
}

const sameRecord = (a: Pick<SupportLinkedRecord, 'ticketId' | 'kind' | 'recordId'>, b: typeof a) =>
  a.ticketId === b.ticketId && a.kind === b.kind && a.recordId.toLowerCase() === b.recordId.toLowerCase();

export class MemoryLinkBook implements LinkBook {
  private readonly rows: SupportLinkedRecord[] = [];

  async list(ticketId: string): Promise<SupportLinkedRecord[]> {
    return this.rows.filter((row) => row.ticketId === ticketId).map((row) => ({ ...row }));
  }

  async put(link: SupportLinkedRecord): Promise<SupportLinkedRecord> {
    const existing = this.rows.find((row) => sameRecord(row, link));
    if (existing) return { ...existing };
    this.rows.push({ ...link });
    return { ...link };
  }
}

type PgLink = { ticket_id: string; kind: SupportLinkableRecordKind; record_id: string; linked_by: string; linked_at: Date };

function fromRow(row: PgLink): SupportLinkedRecord {
  return supportLinkedRecordSchema.parse({
    ticketId: row.ticket_id,
    kind: row.kind,
    recordId: row.record_id,
    linkedBy: row.linked_by,
    linkedAt: row.linked_at.toISOString(),
  });
}

export class SqlLinkBook implements LinkBook {
  constructor(private readonly sql: Sql) {}

  async list(ticketId: string): Promise<SupportLinkedRecord[]> {
    const rows = await this.sql<PgLink[]>`
      SELECT ticket_id, kind, record_id, linked_by, linked_at FROM support.ticket_record_links
      WHERE ticket_id = ${ticketId} ORDER BY linked_at, kind, record_id
    `;
    return rows.map(fromRow);
  }

  async put(link: SupportLinkedRecord): Promise<SupportLinkedRecord> {
    // The unique (ticket, kind, record) key decides a race: the loser inserts nothing and reads the winner's row.
    await this.sql`
      INSERT INTO support.ticket_record_links (ticket_id, kind, record_id, linked_by, linked_at)
      VALUES (${link.ticketId}, ${link.kind}, ${link.recordId}, ${link.linkedBy}, ${link.linkedAt})
      ON CONFLICT (ticket_id, kind, record_id) DO NOTHING
    `;
    const rows = await this.sql<PgLink[]>`
      SELECT ticket_id, kind, record_id, linked_by, linked_at FROM support.ticket_record_links
      WHERE ticket_id = ${link.ticketId} AND kind = ${link.kind} AND record_id = ${link.recordId}
    `;
    if (!rows[0]) throw new Error('support.ticket_record_links: the link was neither written nor found');
    return fromRow(rows[0]);
  }
}

function refuse(code: SupportLinkRecordErrorCode, message: string, owner?: string): SupportError {
  return new SupportError(message, code, owner);
}

export class LinkedRecords {
  constructor(
    private readonly book: LinkBook,
    private readonly support: {
      /** The ticket for an operator: a ticket outside their desk scope, or none, answers `support.not_found`. */
      getTicket(input: { userId: string; ticketId: string; asOperator?: boolean }): Promise<SupportTicket>;
    },
    private readonly pay: RecordOwnershipDoor = UNWIRED_RECORD_OWNERSHIP,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Link one record to the request, if the owning service says it is the request's customer's. */
  async link(operatorId: string, input: SupportLinkRecordInput): Promise<SupportLinkedRecord> {
    const ticket = await this.support.getTicket({ userId: operatorId, ticketId: input.ticketId, asOperator: true });
    const recordId = input.recordId.toLowerCase();
    // A record already linked was proved the customer's when it was linked; linking it again changes nothing.
    const existing = (await this.book.list(ticket.id)).find((row) => sameRecord(row, { ticketId: ticket.id, kind: input.kind, recordId }));
    if (existing) return existing;

    const owner = SUPPORT_LINKED_RECORD_OWNER[input.kind];
    if (input.kind === 'order') throw refuse('support.link_record_owner_unwired', 'svc-trade has no ownership answer for an order', owner);
    if (!this.pay.configured) throw refuse('support.link_record_owner_unwired', 'no svc-pay address or credential is set', owner);
    const owned = await this.pay.owns({ kind: input.kind, recordId, userId: ticket.userId });
    if (owned === null) throw refuse('support.link_record_owner_unreachable', 'svc-pay gave no verified ownership answer', owner);
    if (!owned) throw refuse('support.link_record_not_owned', "the record is not the ticket customer's");

    return this.book.put({
      ticketId: ticket.id,
      kind: input.kind,
      recordId,
      linkedBy: operatorId,
      linkedAt: this.now().toISOString(),
    });
  }

  /** The records linked to the request, oldest first. Desk only: the customer's own read of a ticket never carries them. */
  async list(operatorId: string, ticketId: string): Promise<SupportLinkedRecord[]> {
    const ticket = await this.support.getTicket({ userId: operatorId, ticketId, asOperator: true });
    return this.book.list(ticket.id);
  }
}
