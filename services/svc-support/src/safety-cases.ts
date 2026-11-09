import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import {
  SUPPORT_BEREAVEMENT_DATE_INVALID,
  SUPPORT_SAFETY_KEY_REUSED,
  supportSafetyAcknowledgementSchema,
  type SupportBereavementInput,
  type SupportComplaintInput,
  type SupportSafetyAcknowledgement,
  type SupportSafetyCaseKind,
  type SupportTicket,
} from '@intafaced/contracts';
import { SupportError } from './support-service.js';

/**
 * COMPLAINTS AND BEREAVEMENT REPORTS (BK-safe-03; J-bank-18 #5 and #6).
 *
 * Each is a request on the support desk (category `complaint` or `bereavement`), so the desk works it like any other,
 * with one acknowledgement kept beside it. The acknowledgement is made once per (person, kind, request key):
 *
 *   1. The same key with the same words answers with the stored acknowledgement: same reference, same time, same deadline.
 *      The same key with different words is refused `support.safety_key_reused`; nothing new is made.
 *   2. The request is made through `SupportService.createTicket` with the key `safety:<kind>:<key>`, which stores its own
 *      receipt, so a crash between the request and the acknowledgement is mended by the retry: the request comes back
 *      the same and the acknowledgement is written once.
 *   3. A complaint's final-response deadline is fixed when it is acknowledged, from the owner's limit then
 *      (`SUPPORT_COMPLAINT_RESPONSE_DAYS`, calendar days). Blank, the complaint is taken and acknowledged, and its deadline
 *      reads `not_set`: no limit is ever made up. A limit published later never moves a stored deadline.
 *
 * A bereavement report says nothing back about whether the named customer has an account here: every report gets the
 * same acknowledgement. Nothing here reads, moves or posts money; releasing or closing an account is the desk's later
 * work through the account-close sweep (BK-acct-06), not this module's.
 */

export type StoredSafetyCase = {
  id: string;
  userId: string;
  kind: SupportSafetyCaseKind;
  requestKey: string;
  ticketId: string;
  reference: string;
  fingerprint: string;
  responseLimitDays: number | null;
  responseDueAt: string | null;
  acknowledgedAt: string;
};

/** Where acknowledgements are kept. */
export interface SafetyBook {
  find(userId: string, kind: SupportSafetyCaseKind, requestKey: string): Promise<StoredSafetyCase | null>;
  /** Writes the case once per (person, kind, key); a second write of the same key returns the first, unchanged. */
  put(row: StoredSafetyCase): Promise<StoredSafetyCase>;
  listByUser(userId: string, limit: number): Promise<StoredSafetyCase[]>;
}

export class MemorySafetyBook implements SafetyBook {
  readonly rows: StoredSafetyCase[] = [];

  async find(userId: string, kind: SupportSafetyCaseKind, requestKey: string): Promise<StoredSafetyCase | null> {
    return this.rows.find((r) => r.userId === userId && r.kind === kind && r.requestKey === requestKey) ?? null;
  }

  async put(row: StoredSafetyCase): Promise<StoredSafetyCase> {
    const prior = await this.find(row.userId, row.kind, row.requestKey);
    if (prior) return prior;
    const sameTicket = this.rows.find((r) => r.ticketId === row.ticketId);
    if (sameTicket) return sameTicket;
    this.rows.push({ ...row });
    return row;
  }

  async listByUser(userId: string, limit: number): Promise<StoredSafetyCase[]> {
    return this.rows
      .filter((r) => r.userId === userId)
      .sort((a, b) => b.acknowledgedAt.localeCompare(a.acknowledgedAt))
      .slice(0, limit);
  }
}

type PgSafetyCase = {
  id: string;
  user_id: string;
  kind: SupportSafetyCaseKind;
  request_key: string;
  ticket_id: string;
  reference: string;
  fingerprint: string;
  response_limit_days: number | null;
  response_due_at: Date | null;
  acknowledged_at: Date;
};

function fromRow(row: PgSafetyCase): StoredSafetyCase {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    requestKey: row.request_key,
    ticketId: row.ticket_id,
    reference: row.reference,
    fingerprint: row.fingerprint,
    responseLimitDays: row.response_limit_days,
    responseDueAt: row.response_due_at ? row.response_due_at.toISOString() : null,
    acknowledgedAt: row.acknowledged_at.toISOString(),
  };
}

export class SqlSafetyBook implements SafetyBook {
  constructor(private readonly sql: Sql) {}

  async find(userId: string, kind: SupportSafetyCaseKind, requestKey: string): Promise<StoredSafetyCase | null> {
    const rows = await this.sql<PgSafetyCase[]>`
      SELECT * FROM support.safety_cases WHERE user_id = ${userId} AND kind = ${kind} AND request_key = ${requestKey}
    `;
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async put(row: StoredSafetyCase): Promise<StoredSafetyCase> {
    // Two sends of one key at once: the unique (person, kind, key) and (ticket) keys keep one row, and both read it back.
    await this.sql`
      INSERT INTO support.safety_cases (id, user_id, kind, request_key, ticket_id, reference, fingerprint,
        response_limit_days, response_due_at, acknowledged_at)
      VALUES (${row.id}, ${row.userId}, ${row.kind}, ${row.requestKey}, ${row.ticketId}, ${row.reference}, ${row.fingerprint},
        ${row.responseLimitDays}, ${row.responseDueAt}, ${row.acknowledgedAt})
      ON CONFLICT DO NOTHING
    `;
    const rows = await this.sql<PgSafetyCase[]>`
      SELECT * FROM support.safety_cases
      WHERE (user_id = ${row.userId} AND kind = ${row.kind} AND request_key = ${row.requestKey}) OR ticket_id = ${row.ticketId}
      ORDER BY acknowledged_at LIMIT 1
    `;
    if (!rows[0]) throw new Error('support.safety_cases: the acknowledgement was neither written nor found');
    return fromRow(rows[0]);
  }

  async listByUser(userId: string, limit: number): Promise<StoredSafetyCase[]> {
    const rows = await this.sql<PgSafetyCase[]>`
      SELECT * FROM support.safety_cases WHERE user_id = ${userId} ORDER BY acknowledged_at DESC LIMIT ${limit}
    `;
    return rows.map(fromRow);
  }
}

/** The one door this module needs from the desk: make a request, once per key. */
export type SafetyDesk = {
  createTicket(input: {
    userId: string;
    category: 'complaint' | 'bereavement';
    subject: string;
    body: string;
    clientRequestId: string;
  }): Promise<SupportTicket>;
};

const DAY_MS = 86_400_000;
/** The most acknowledgements one read returns. */
export const SAFETY_LIST_MAX = 50;

const REFERENCE_PREFIX: Record<SupportSafetyCaseKind, string> = { complaint: 'CP', bereavement: 'BR' };

/** sha256 over the kind and the words sent, so a key sent again with different words is caught. */
function fingerprintOf(kind: SupportSafetyCaseKind, fields: Record<string, string | undefined>): string {
  const ordered = Object.keys(fields)
    .sort()
    .map((k) => [k, fields[k] ?? null]);
  return createHash('sha256')
    .update(JSON.stringify([kind, ordered]))
    .digest('hex');
}

/** The reference the person quotes, from the request it made: `CP-` or `BR-` and eight hex digits. */
export function referenceOf(kind: SupportSafetyCaseKind, ticketId: string): string {
  const digest = createHash('sha256').update(`safety-reference:${ticketId.toLowerCase()}`).digest('hex');
  return `${REFERENCE_PREFIX[kind]}-${digest.slice(0, 8).toUpperCase()}`;
}

export function acknowledgementOf(row: StoredSafetyCase): SupportSafetyAcknowledgement {
  return supportSafetyAcknowledgementSchema.parse({
    id: row.id,
    kind: row.kind,
    ticketId: row.ticketId,
    reference: row.reference,
    acknowledgedAt: row.acknowledgedAt,
    responseDeadline:
      row.kind !== 'complaint'
        ? null
        : row.responseLimitDays !== null && row.responseDueAt !== null
          ? { status: 'set', dueAt: row.responseDueAt, limitDays: row.responseLimitDays }
          : { status: 'not_set' },
  });
}

const TOPIC_WORDS: Record<SupportComplaintInput['topic'], string> = {
  account: 'my account',
  cards: 'cards',
  payments: 'payments and transfers',
  trading: 'trading',
  support: 'the support I got',
  other: 'something else',
};

export class SafetyCases {
  constructor(
    private readonly book: SafetyBook,
    private readonly desk: SafetyDesk,
    /** The owner's `SUPPORT_COMPLAINT_RESPONSE_DAYS`; null (blank) leaves every new complaint's deadline not set. */
    private readonly complaintResponseDays: number | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async complain(userId: string, input: SupportComplaintInput): Promise<SupportSafetyAcknowledgement> {
    const outcome = input.outcome?.trim() || undefined;
    const fingerprint = fingerprintOf('complaint', { topic: input.topic, details: input.details, outcome });
    const subject = `Complaint about ${TOPIC_WORDS[input.topic]}`;
    const body = [
      `Complaint about ${TOPIC_WORDS[input.topic]}.`,
      '',
      input.details,
      ...(outcome ? ['', `What I want done: ${outcome}`] : []),
    ].join('\n');
    return this.acknowledge(userId, 'complaint', input.requestKey, fingerprint, subject, body);
  }

  async reportBereavement(userId: string, input: SupportBereavementInput): Promise<SupportSafetyAcknowledgement> {
    const day = Date.parse(`${input.dateOfDeath}T00:00:00Z`);
    if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== input.dateOfDeath || day > this.now().getTime()) {
      throw new SupportError('the date of death must be a real date that is not in the future', SUPPORT_BEREAVEMENT_DATE_INVALID);
    }
    const fields = {
      deceasedName: input.deceasedName,
      deceasedContact: input.deceasedContact?.trim() || undefined,
      dateOfDeath: input.dateOfDeath,
      relation: input.relation,
      reporterName: input.reporterName,
      reporterContact: input.reporterContact,
      details: input.details?.trim() || undefined,
    };
    const fingerprint = fingerprintOf('bereavement', fields);
    const body = [
      'A death is reported.',
      '',
      `Customer who died: ${fields.deceasedName}`,
      ...(fields.deceasedContact ? [`Email or handle they used: ${fields.deceasedContact}`] : []),
      `Date of death: ${fields.dateOfDeath}`,
      `Reported by: ${fields.reporterName} (${fields.relation.replace(/_/g, ' ')})`,
      `Reach the reporter at: ${fields.reporterContact}`,
      ...(fields.details ? ['', fields.details] : []),
    ].join('\n');
    return this.acknowledge(userId, 'bereavement', input.requestKey, fingerprint, 'Bereavement report', body);
  }

  async mine(userId: string): Promise<SupportSafetyAcknowledgement[]> {
    return (await this.book.listByUser(userId, SAFETY_LIST_MAX)).map(acknowledgementOf);
  }

  private async acknowledge(
    userId: string,
    kind: SupportSafetyCaseKind,
    requestKey: string,
    fingerprint: string,
    subject: string,
    body: string,
  ): Promise<SupportSafetyAcknowledgement> {
    const prior = await this.book.find(userId, kind, requestKey);
    if (prior) return this.same(prior, fingerprint);
    let ticket: SupportTicket;
    try {
      ticket = await this.desk.createTicket({ userId, category: kind, subject, body, clientRequestId: `safety:${kind}:${requestKey}` });
    } catch (err) {
      // The desk's own receipt holds other words under this key: the same refusal as a reused key here.
      if (err instanceof SupportError && err.code === 'support.idempotency_conflict')
        throw new SupportError('this request key was already used with different words', SUPPORT_SAFETY_KEY_REUSED);
      throw err;
    }
    const at = this.now();
    const days = kind === 'complaint' ? this.complaintResponseDays : null;
    const written = await this.book.put({
      id: randomUUID(),
      userId,
      kind,
      requestKey,
      ticketId: ticket.id,
      reference: referenceOf(kind, ticket.id),
      fingerprint,
      responseLimitDays: days,
      responseDueAt: days === null ? null : new Date(at.getTime() + days * DAY_MS).toISOString(),
      acknowledgedAt: at.toISOString(),
    });
    return this.same(written, fingerprint);
  }

  private same(row: StoredSafetyCase, fingerprint: string): SupportSafetyAcknowledgement {
    if (row.fingerprint !== fingerprint)
      throw new SupportError('this request key was already used with different words', SUPPORT_SAFETY_KEY_REUSED);
    return acknowledgementOf(row);
  }
}
