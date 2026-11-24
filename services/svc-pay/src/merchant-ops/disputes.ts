import { createHash } from 'node:crypto';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { DisputeCaseError, type DisputeCase, type DisputeCaseStatus, type DisputeCaseStore } from '../fraud/dispute-case.js';
import {
  EVIDENCE_UPLOAD_OFF,
  assertEvidenceContentType,
  assertEvidenceFileName,
  decodeEvidenceContent,
  type DisputeEvidenceGate,
} from './dispute-evidence-policy.js';
import { MerchantOpsError } from './errors.js';
import { money } from './money.js';
import { decodeCursor, encodeCursor, requireLimit, toPage } from './pagination.js';
import { assertPermission, type MerchantCaller } from './roles.js';

/**
 * Merchant-facing disputes, over the EXISTING dispute case mechanism
 * (`src/fraud/dispute-case.ts`). There is no second dispute model: the case
 * (status, amount, reason, ledger wire) is read from and moved through the
 * `DisputeCaseStore` the fraud code already owns. This file adds only what a
 * merchant contributes: evidence and a recorded decision, in
 * `pay.merchant_dispute_evidence` / `pay.merchant_dispute_responses`.
 *
 * SCOPING (M1/M2). Every read starts from `store.listForMerchant(caller)` or
 * checks `case.merchantId === caller.merchantId` before answering. A case
 * that belongs to someone else gets the SAME refusal as one that never existed.
 *
 * WHAT THIS DOES NOT DO. It never posts to the ledger. The opening result on
 * the detail is whatever the case already recorded (`posted` with a tx id, or
 * a named refuse). Outcome posts are the pay service's. A response deadline
 * is the rail event's due date or null. This file does not invent one.
 */

export const EVIDENCE_KINDS = ['receipt', 'shipping_proof', 'customer_communication', 'terms_accepted', 'identity_check', 'other'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

const notFound = () => new MerchantOpsError('pay.dispute_not_found', 'not_found');
const OPEN: ReadonlySet<DisputeCaseStatus> = new Set(['open', 'contested']);

export interface DisputeView {
  readonly disputeId: string;
  readonly paymentId: string;
  readonly amount: string;
  readonly assetId: string;
  readonly reasonCode: string | null;
  readonly status: DisputeCaseStatus;
  readonly openedAt: string;
  readonly contestedAt: string | null;
  readonly closedAt: string | null;
  /** ISO time from the rail event, or null when the rail did not send one. */
  readonly responseDueAt: string | null;
  /** `rail_event` when responseDueAt is set. Null means no deadline from the network. */
  readonly responseDueSource: 'rail_event' | null;
  readonly ledgerWire: 'posted' | 'refused';
  readonly ledgerRefuseCode: string | null;
  /** The opening the case recorded. Not a shortfall or won settlement. */
  readonly openingLedger: {
    readonly wire: 'posted' | 'refused';
    readonly txId: string | null;
    readonly refuseCode: string | null;
    readonly refuseSocket: string | null;
  };
}

const view = (c: DisputeCase, due: Date | null): DisputeView => ({
  disputeId: c.disputeId,
  paymentId: c.paymentId,
  amount: money(c.amount),
  assetId: c.assetId,
  reasonCode: c.reasonCode,
  status: c.status,
  openedAt: c.openedAt,
  contestedAt: c.contestedAt,
  closedAt: c.closedAt,
  responseDueAt: due ? due.toISOString() : null,
  responseDueSource: due ? 'rail_event' : null,
  ledgerWire: c.ledgerWire,
  ledgerRefuseCode: c.ledgerRefuse?.code ?? null,
  openingLedger: {
    wire: c.ledgerWire,
    txId: c.ledgerTxId,
    refuseCode: c.ledgerRefuse?.code ?? null,
    refuseSocket: c.ledgerRefuse?.socket ?? null,
  },
});

const MICRO = (d: string) => d.replace(/Z$/, '000Z'); // ISO ms -> the 6-digit form the cursor format wants

export interface DisputeListFilter {
  limit?: number | undefined;
  cursor?: string;
  status?: DisputeCaseStatus;
  paymentId?: string;
  search?: string;
  from?: string;
  to?: string;
  /** Inclusive. Rows with no rail due date are excluded. */
  dueAfter?: string;
  /** Inclusive. Rows with no rail due date are excluded. */
  dueBefore?: string;
  deadline?: 'set' | 'unset';
}

export class DisputeOpsService {
  constructor(
    private readonly sql: Sql,
    private readonly store: DisputeCaseStore,
    private readonly evidenceGate: DisputeEvidenceGate = EVIDENCE_UPLOAD_OFF,
  ) {}

  private async owned(caller: MerchantCaller, disputeId: string): Promise<DisputeCase> {
    const c = await this.store.get(disputeId);
    if (!c || c.merchantId !== caller.merchantId) throw notFound();
    return c;
  }

  async list(caller: MerchantCaller, input: DisputeListFilter) {
    assertPermission(caller, 'disputes.read');
    const limit = requireLimit(input.limit);
    const after = decodeCursor(input.cursor);
    if (input.from && input.to && Date.parse(input.from) > Date.parse(input.to)) {
      throw new MerchantOpsError('pay.cursor_invalid', 'bad_request');
    }
    const { afterMs, beforeMs } = deadlineBounds(input);
    // Newest first. The store keys by ISO millisecond timestamps, so the cursor does too.
    const all = (await this.store.listForMerchant(caller.merchantId))
      .filter((c) => (input.status ? c.status === input.status : true))
      .filter((c) => (input.paymentId ? c.paymentId === input.paymentId : true))
      .filter((c) => (input.search ? c.disputeId === input.search || c.paymentId === input.search : true))
      .filter((c) => (input.from ? c.openedAt >= input.from : true))
      .filter((c) => (input.to ? c.openedAt < input.to : true))
      .slice()
      .reverse();
    const dues = await this.dueByDispute(
      caller.merchantId,
      all.map((c) => c.disputeId),
    );
    const filtered = all.filter((c) => dueMatches(dues.get(c.disputeId) ?? null, input.deadline, afterMs, beforeMs));
    const startAt = after ? filtered.findIndex((c) => MICRO(c.openedAt) === after.ts && c.disputeId === after.key) + 1 : 0;
    const rows = filtered.slice(startAt, startAt + limit + 1);
    return toPage(
      rows,
      limit,
      (c) => view(c, dues.get(c.disputeId) ?? null),
      (c) => encodeCursor(MICRO(c.openedAt), c.disputeId),
    );
  }

  /**
   * The same case fields and deadline rules as `list`, across merchants.
   * Pages in SQL so a founder queue does not load every case first.
   * The founder router is the only caller.
   */
  async listAcross(input: DisputeListFilter) {
    const limit = requireLimit(input.limit);
    const after = decodeCursor(input.cursor);
    if (input.from && input.to && Date.parse(input.from) > Date.parse(input.to)) {
      throw new MerchantOpsError('pay.cursor_invalid', 'bad_request');
    }
    deadlineBounds(input);
    const sql = this.sql;
    const rows = await sql<
      Array<{
        dispute_id: string;
        payment_id: string;
        merchant_id: string;
        amount: string;
        asset_id: string;
        reason_code: string | null;
        status: DisputeCaseStatus;
        opened_at: Date;
        updated_at: Date;
        contested_at: Date | null;
        closed_at: Date | null;
        payment_marked_disputed: boolean;
        ledger_wire: 'posted' | 'refused';
        ledger_tx_id: string | null;
        ledger_refuse: DisputeCase['ledgerRefuse'];
        response_due_at: Date | null;
        cursor_ts: string;
      }>
    >`
      SELECT c.dispute_id, c.payment_id, c.merchant_id::text AS merchant_id, c.amount, c.asset_id, c.reason_code,
             c.status, c.opened_at, c.updated_at, c.contested_at, c.closed_at, c.payment_marked_disputed,
             c.ledger_wire, c.ledger_tx_id, c.ledger_refuse, d.response_due_at,
             to_char(c.opened_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts
        FROM pay.dispute_cases c
        LEFT JOIN pay.dispute_response_deadlines d
          ON d.dispute_id = c.dispute_id AND d.merchant_id = c.merchant_id
       WHERE true
         ${input.status ? sql`AND c.status = ${input.status}` : sql``}
         ${input.paymentId ? sql`AND c.payment_id = ${input.paymentId}` : sql``}
         ${input.search ? sql`AND (c.dispute_id = ${input.search} OR c.payment_id = ${input.search})` : sql``}
         ${input.from ? sql`AND c.opened_at >= (${input.from}::text)::timestamptz` : sql``}
         ${input.to ? sql`AND c.opened_at < (${input.to}::text)::timestamptz` : sql``}
         ${input.deadline === 'set' ? sql`AND d.response_due_at IS NOT NULL` : sql``}
         ${input.deadline === 'unset' ? sql`AND d.response_due_at IS NULL` : sql``}
         ${input.dueAfter ? sql`AND d.response_due_at >= (${input.dueAfter}::text)::timestamptz` : sql``}
         ${input.dueBefore ? sql`AND d.response_due_at <= (${input.dueBefore}::text)::timestamptz` : sql``}
         ${after ? sql`AND (c.opened_at, c.dispute_id) < ((${after.ts}::text)::timestamptz, ${after.key})` : sql``}
       ORDER BY c.opened_at DESC, c.dispute_id DESC
       LIMIT ${limit + 1}`;
    return toPage(
      rows,
      limit,
      (row) => ({
        merchantId: row.merchant_id,
        ...view(
          {
            disputeId: row.dispute_id,
            paymentId: row.payment_id,
            merchantId: row.merchant_id,
            amount: row.amount,
            assetId: row.asset_id,
            reasonCode: row.reason_code,
            status: row.status,
            openedAt: row.opened_at.toISOString(),
            updatedAt: row.updated_at.toISOString(),
            contestedAt: row.contested_at ? row.contested_at.toISOString() : null,
            closedAt: row.closed_at ? row.closed_at.toISOString() : null,
            paymentMarkedDisputed: row.payment_marked_disputed,
            ledgerWire: row.ledger_wire,
            ledgerRefuse: row.ledger_wire === 'posted' ? null : row.ledger_refuse,
            ledgerTxId: row.ledger_tx_id,
          },
          row.response_due_at,
        ),
      }),
      (row) => encodeCursor(row.cursor_ts, row.dispute_id),
    );
  }

  /** Counts for the KPI strip: open, won, lost ... and amount at risk per asset. Decimal strings. */
  async summary(caller: MerchantCaller) {
    assertPermission(caller, 'disputes.read');
    const cases = await this.store.listForMerchant(caller.merchantId);
    const byStatus: Record<DisputeCaseStatus, number> = { open: 0, contested: 0, accepted: 0, won: 0, lost: 0 };
    const risk = new Map<string, bigint>();
    for (const c of cases) {
      byStatus[c.status] += 1;
      if (OPEN.has(c.status)) risk.set(c.assetId, (risk.get(c.assetId) ?? 0n) + parseAmount(c.amount));
    }
    return {
      total: cases.length,
      byStatus,
      amountAtRisk: [...risk].map(([assetId, amount]) => ({ assetId, amount: formatAmount(amount) })),
    };
  }

  async get(caller: MerchantCaller, disputeId: string) {
    assertPermission(caller, 'disputes.read');
    const c = await this.owned(caller, disputeId);
    const sql = this.sql;
    const dues = await this.dueByDispute(caller.merchantId, [c.disputeId]);
    const evidence = await sql<EvidenceRow[]>`
      SELECT e.id, e.kind, e.file_name, e.content_type, e.size_bytes::text, e.sha256, e.note, e.added_by, e.created_at,
             (c.evidence_id IS NOT NULL) AS has_content
        FROM pay.merchant_dispute_evidence e
        LEFT JOIN pay.merchant_dispute_evidence_content c
          ON c.evidence_id = e.id AND c.merchant_id = e.merchant_id
       WHERE e.merchant_id = ${caller.merchantId} AND e.dispute_id = ${c.disputeId}
       ORDER BY e.created_at, e.id`;
    const responses = await sql<
      Array<{
        id: string;
        action: string;
        note: string | null;
        resulting_status: string;
        evidence_count: number;
        responded_by: string;
        created_at: Date;
      }>
    >`
      SELECT id, action, note, resulting_status, evidence_count, responded_by, created_at
        FROM pay.merchant_dispute_responses
       WHERE merchant_id = ${caller.merchantId} AND dispute_id = ${c.disputeId}
       ORDER BY created_at, id`;
    const payment = await sql<Array<{ id: string; status: string; currency: string; amount: string; created_at: Date }>>`
      SELECT id, status, currency, amount::text, created_at FROM pay.payments
       WHERE id = ${c.paymentId}::uuid AND merchant_id = ${caller.merchantId}`;
    return {
      ...view(c, dues.get(c.disputeId) ?? null),
      canRespond: OPEN.has(c.status),
      evidence: evidence.map(evidenceView),
      responses: responses.map((r) => ({
        responseId: r.id,
        action: r.action as 'contest' | 'accept_liability',
        note: r.note,
        resultingStatus: r.resulting_status,
        evidenceCount: r.evidence_count,
        respondedBy: r.responded_by,
        createdAt: r.created_at.toISOString(),
      })),
      payment: payment[0]
        ? {
            paymentId: payment[0].id,
            status: payment[0].status,
            assetId: payment[0].currency,
            amount: money(payment[0].amount),
            createdAt: payment[0].created_at.toISOString(),
          }
        : null,
    };
  }

  /** Attach evidence METADATA (name, type, size, sha256). No file bytes are stored. */
  async addEvidence(
    caller: MerchantCaller,
    input: {
      disputeId: string;
      kind: EvidenceKind;
      fileName: string;
      contentType: string;
      sizeBytes: number;
      sha256: string;
      note?: string;
    },
  ) {
    assertPermission(caller, 'disputes.respond');
    const c = await this.owned(caller, input.disputeId);
    if (!OPEN.has(c.status)) throw new MerchantOpsError('pay.dispute_closed', 'conflict');
    const rows = await this.sql<EvidenceRow[]>`
      INSERT INTO pay.merchant_dispute_evidence (merchant_id, dispute_id, kind, file_name, content_type, size_bytes, sha256, note, added_by)
      VALUES (${caller.merchantId}, ${c.disputeId}, ${input.kind}, ${input.fileName}, ${input.contentType}, ${input.sizeBytes}, ${input.sha256.toLowerCase()},
              ${input.note ?? null}, ${caller.userId})
      RETURNING id, kind, file_name, content_type, size_bytes::text, sha256, note, added_by, created_at`;
    return evidenceView(rows[0]!);
  }

  /**
   * Store evidence bytes for an open dispute. Off until
   * PAY_DISPUTE_EVIDENCE_UPLOAD=on, and refused again until a scan hook is
   * configured (PAY_DISPUTE_EVIDENCE_SCAN=on plus a scanner). A foreign dispute
   * is not_found before either switch is consulted.
   */
  async uploadEvidence(
    caller: MerchantCaller,
    input: {
      disputeId: string;
      kind: EvidenceKind;
      fileName: string;
      contentType: string;
      contentBase64: string;
      sha256?: string;
      note?: string;
    },
  ) {
    assertPermission(caller, 'disputes.respond');
    const c = await this.owned(caller, input.disputeId);
    if (!OPEN.has(c.status)) throw new MerchantOpsError('pay.dispute_closed', 'conflict');
    if (!this.evidenceGate.uploadEnabled) throw new MerchantOpsError('pay.dispute_evidence_upload_off', 'unavailable');
    const scanner = this.evidenceGate.scanner;
    if (!this.evidenceGate.scanEnabled || !scanner) throw new MerchantOpsError('pay.dispute_evidence_scan_unconfigured', 'unavailable');
    const fileName = assertEvidenceFileName(input.fileName);
    const contentType = assertEvidenceContentType(input.contentType);
    const bytes = decodeEvidenceContent(input.contentBase64);
    const sha256 = sha256Hex(bytes);
    if (input.sha256 !== undefined && input.sha256.toLowerCase() !== sha256) {
      throw new MerchantOpsError('pay.dispute_evidence_hash_mismatch', 'bad_request');
    }
    await this.scan(scanner, { content: bytes, contentType, sha256 });
    const row = await this.sql.begin(async (tx) => {
      const inserted = await tx<EvidenceRow[]>`
        INSERT INTO pay.merchant_dispute_evidence (merchant_id, dispute_id, kind, file_name, content_type, size_bytes, sha256, note, added_by)
        VALUES (${caller.merchantId}, ${c.disputeId}, ${input.kind}, ${fileName}, ${contentType}, ${bytes.length}, ${sha256},
                ${input.note ?? null}, ${caller.userId})
        RETURNING id, kind, file_name, content_type, size_bytes::text, sha256, note, added_by, created_at`;
      const evidence = inserted[0];
      if (!evidence) throw new MerchantOpsError('pay.dispute_evidence_not_found', 'unavailable');
      await tx`
        INSERT INTO pay.merchant_dispute_evidence_content (evidence_id, merchant_id, content)
        VALUES (${evidence.id}, ${caller.merchantId}, ${bytes})`;
      return evidence;
    });
    return evidenceView({ ...row, has_content: true });
  }

  /**
   * Bytes for one evidence row this merchant owns. Another merchant's id matches a missing id.
   * Download is a respond action: owner, admin, or finance, and only from an interactive session.
   * An API key with the role still cannot read the bytes.
   */
  async getEvidence(caller: MerchantCaller, evidenceId: string) {
    assertPermission(caller, 'disputes.respond');
    if (!caller.interactive) throw new MerchantOpsError('pay.dispute_evidence_interactive_only', 'forbidden');
    const rows = await this.sql<Array<EvidenceRow & { dispute_id: string; content: Buffer | null }>>`
      SELECT e.id, e.dispute_id, e.kind, e.file_name, e.content_type, e.size_bytes::text, e.sha256, e.note, e.added_by, e.created_at,
             (c.evidence_id IS NOT NULL) AS has_content, c.content
        FROM pay.merchant_dispute_evidence e
        LEFT JOIN pay.merchant_dispute_evidence_content c
          ON c.evidence_id = e.id AND c.merchant_id = e.merchant_id
       WHERE e.merchant_id = ${caller.merchantId} AND e.id = ${evidenceId}::uuid`;
    const row = rows[0];
    const dispute = row ? await this.store.get(row.dispute_id) : null;
    if (!row || !dispute || dispute.merchantId !== caller.merchantId) {
      throw new MerchantOpsError('pay.dispute_evidence_not_found', 'not_found');
    }
    if (!row.content) throw new MerchantOpsError('pay.dispute_evidence_content_absent', 'conflict');
    const bytes = Buffer.from(row.content);
    const actual = sha256Hex(bytes);
    if (actual !== row.sha256) throw new MerchantOpsError('pay.dispute_evidence_hash_mismatch', 'conflict');
    return { ...evidenceView(row), contentBase64: bytes.toString('base64') };
  }

  /**
   * Contest (with evidence) or accept liability. One `requestId` = one decision:
   * a retried click replays the first answer. Contesting needs at least one
   * evidence item; accepting liability closes the case and moves NO value
   * (the chargeback ledger wire stays its named refuse).
   */
  async respond(
    caller: MerchantCaller,
    input: { requestId: string; disputeId: string; action: 'contest' | 'accept_liability'; note?: string },
  ) {
    assertPermission(caller, 'disputes.respond');
    const sql = this.sql;
    const prior = await sql<Array<{ dispute_id: string; action: string }>>`
      SELECT dispute_id, action FROM pay.merchant_dispute_responses WHERE merchant_id = ${caller.merchantId} AND request_id = ${input.requestId}::uuid`;
    if (prior[0]) {
      if (prior[0].dispute_id !== input.disputeId || prior[0].action !== input.action)
        throw new MerchantOpsError('pay.request_id_reused', 'conflict');
      return this.get(caller, input.disputeId);
    }
    const c = await this.owned(caller, input.disputeId);
    if (!OPEN.has(c.status)) throw new MerchantOpsError('pay.dispute_closed', 'conflict');
    if (input.action === 'contest' && c.status !== 'open') throw new MerchantOpsError('pay.dispute_invalid_transition', 'conflict');
    await sql.begin(async (tx) => {
      const n = await tx<Array<{ n: string }>>`
        SELECT count(*)::text AS n FROM pay.merchant_dispute_evidence WHERE merchant_id = ${caller.merchantId} AND dispute_id = ${c.disputeId}`;
      const evidenceCount = Number(n[0]?.n ?? '0');
      if (input.action === 'contest' && evidenceCount === 0) throw new MerchantOpsError('pay.dispute_evidence_required', 'precondition');
      // Record first inside the transaction, then move the case: if the case refuses, the record rolls back.
      const inserted = await tx<Array<{ id: string }>>`
        INSERT INTO pay.merchant_dispute_responses (merchant_id, dispute_id, request_id, action, note, resulting_status, evidence_count, responded_by)
        VALUES (${caller.merchantId}, ${c.disputeId}, ${input.requestId}::uuid, ${input.action}, ${input.note ?? null},
                ${input.action === 'contest' ? 'contested' : 'accepted'}, ${evidenceCount}, ${caller.userId})
        ON CONFLICT (merchant_id, request_id) DO NOTHING
        RETURNING id`;
      if (!inserted[0]) throw new MerchantOpsError('pay.request_id_reused', 'conflict');
      try {
        if (input.action === 'contest') await this.store.contest(c.disputeId, undefined, tx);
        else await this.store.accept(c.disputeId, undefined, tx);
      } catch (error) {
        if (error instanceof DisputeCaseError) {
          throw new MerchantOpsError(
            error.code === 'pay.dispute_not_found' ? 'pay.dispute_not_found' : 'pay.dispute_closed',
            error.code === 'pay.dispute_not_found' ? 'not_found' : 'conflict',
          );
        }
        throw error;
      }
    });
    return this.get(caller, input.disputeId);
  }

  private async dueByDispute(merchantId: string, disputeIds: readonly string[]): Promise<Map<string, Date | null>> {
    const out = new Map<string, Date | null>();
    if (disputeIds.length === 0) return out;
    const rows = await this.sql<Array<{ dispute_id: string; response_due_at: Date | null }>>`
      SELECT dispute_id, response_due_at
        FROM pay.dispute_response_deadlines
       WHERE merchant_id = ${merchantId} AND dispute_id = ANY(${this.sql.array([...disputeIds])}::text[])`;
    for (const row of rows) out.set(row.dispute_id, row.response_due_at);
    return out;
  }

  private async scan(
    scanner: DisputeEvidenceGate['scanner'],
    input: { content: Buffer; contentType: string; sha256: string },
  ): Promise<void> {
    if (!scanner) throw new MerchantOpsError('pay.dispute_evidence_scan_unconfigured', 'unavailable');
    let verdict: 'clean' | 'rejected';
    try {
      verdict = await scanner.scan(input);
    } catch (error) {
      if (error instanceof MerchantOpsError) throw error;
      throw new MerchantOpsError('pay.dispute_evidence_scan_failed', 'unavailable');
    }
    if (verdict !== 'clean') throw new MerchantOpsError('pay.dispute_evidence_rejected', 'precondition');
  }
}

/** Inclusive deadline window. A missing due date never matches a bound. Shared by the in-memory and SQL lists. */
function deadlineBounds(input: DisputeListFilter): { afterMs: number | null; beforeMs: number | null } {
  if (input.deadline === 'unset' && (input.dueAfter !== undefined || input.dueBefore !== undefined)) {
    throw new MerchantOpsError('pay.dispute_deadline_filter_invalid', 'bad_request');
  }
  const afterMs = input.dueAfter === undefined ? null : Date.parse(input.dueAfter);
  const beforeMs = input.dueBefore === undefined ? null : Date.parse(input.dueBefore);
  if ((input.dueAfter !== undefined && Number.isNaN(afterMs)) || (input.dueBefore !== undefined && Number.isNaN(beforeMs))) {
    throw new MerchantOpsError('pay.dispute_deadline_filter_invalid', 'bad_request');
  }
  if (afterMs !== null && beforeMs !== null && afterMs > beforeMs) {
    throw new MerchantOpsError('pay.dispute_deadline_filter_invalid', 'bad_request');
  }
  return { afterMs, beforeMs };
}

function dueMatches(due: Date | null, deadline: 'set' | 'unset' | undefined, afterMs: number | null, beforeMs: number | null): boolean {
  if (deadline === 'set' && due === null) return false;
  if (deadline === 'unset' && due !== null) return false;
  if ((afterMs !== null || beforeMs !== null) && due === null) return false;
  if (due !== null && afterMs !== null && due.getTime() < afterMs) return false;
  if (due !== null && beforeMs !== null && due.getTime() > beforeMs) return false;
  return true;
}

interface EvidenceRow {
  id: string;
  kind: string;
  file_name: string;
  content_type: string;
  size_bytes: string;
  sha256: string;
  note: string | null;
  added_by: string;
  created_at: Date;
  has_content?: boolean;
}

const evidenceView = (r: EvidenceRow) => ({
  evidenceId: r.id,
  kind: r.kind as EvidenceKind,
  fileName: r.file_name,
  contentType: r.content_type,
  sizeBytes: r.size_bytes,
  sha256: r.sha256,
  note: r.note,
  addedBy: r.added_by,
  createdAt: r.created_at.toISOString(),
  hasContent: r.has_content === true,
});

/** Stable digest helper for tests and callers that hash evidence client-side the same way. */
export const sha256Hex = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
