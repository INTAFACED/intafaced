import { createHash } from 'node:crypto';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { DisputeCaseError, type DisputeCase, type DisputeCaseStatus, type DisputeCaseStore } from '../fraud/dispute-case.js';
import { MerchantOpsError } from './errors.js';
import { money } from './money.js';
import { decodeCursor, encodeCursor, requireLimit, toPage } from './pagination.js';
import { assertPermission, type MerchantCaller } from './roles.js';

/**
 * Merchant-facing disputes, over the EXISTING dispute case mechanism
 * (`src/fraud/dispute-case.ts`). There is no second dispute model: the case
 * (status, amount, reason, ledger wire) is read from and moved through the
 * `DisputeCaseStore` the fraud code already owns. This file adds only what a
 * merchant contributes: evidence metadata and a recorded decision, in
 * `pay.merchant_dispute_evidence` / `pay.merchant_dispute_responses`.
 *
 * SCOPING (M1/M2). Every read starts from `store.listForMerchant(caller)` or
 * checks `case.merchantId === caller.merchantId` before answering. A case
 * that belongs to someone else gets the SAME refusal as one that never existed.
 *
 * WHAT THIS DOES NOT DO. It never posts to the ledger: the chargeback ledger
 * wire stays the named refuse in the case (`ledgerWire`, `ledgerRefuse*`). It
 * invents no response deadline: the case carries none, so `responseDueAt` is
 * `null` rather than a made-up date.
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
  /** The case carries no deadline today; never a placeholder. */
  readonly responseDueAt: null;
  readonly ledgerWire: 'posted' | 'refused';
  readonly ledgerRefuseCode: string | null;
}

const view = (c: DisputeCase): DisputeView => ({
  disputeId: c.disputeId,
  paymentId: c.paymentId,
  amount: money(c.amount),
  assetId: c.assetId,
  reasonCode: c.reasonCode,
  status: c.status,
  openedAt: c.openedAt,
  contestedAt: c.contestedAt,
  closedAt: c.closedAt,
  responseDueAt: null,
  ledgerWire: c.ledgerWire,
  ledgerRefuseCode: c.ledgerRefuse?.code ?? null,
});

const MICRO = (d: string) => d.replace(/Z$/, '000Z'); // ISO ms -> the 6-digit form the cursor format wants

export class DisputeOpsService {
  constructor(
    private readonly sql: Sql,
    private readonly store: DisputeCaseStore,
  ) {}

  private owned(caller: MerchantCaller, disputeId: string): DisputeCase {
    const c = this.store.get(disputeId);
    if (!c || c.merchantId !== caller.merchantId) throw notFound();
    return c;
  }

  list(caller: MerchantCaller, input: { limit?: number | undefined; cursor?: string; status?: DisputeCaseStatus; paymentId?: string }) {
    assertPermission(caller, 'disputes.read');
    const limit = requireLimit(input.limit);
    const after = decodeCursor(input.cursor);
    // Newest first. The in-memory store keys by ISO millisecond timestamps, so the cursor does too.
    const all = this.store
      .listForMerchant(caller.merchantId)
      .filter((c) => (input.status ? c.status === input.status : true))
      .filter((c) => (input.paymentId ? c.paymentId === input.paymentId : true))
      .slice()
      .reverse();
    const startAt = after ? all.findIndex((c) => MICRO(c.openedAt) === after.ts && c.disputeId === after.key) + 1 : 0;
    const rows = all.slice(startAt, startAt + limit + 1);
    return toPage(rows, limit, view, (c) => encodeCursor(MICRO(c.openedAt), c.disputeId));
  }

  /** Counts for the KPI strip: open, won, lost ... and amount at risk per asset. Decimal strings. */
  summary(caller: MerchantCaller) {
    assertPermission(caller, 'disputes.read');
    const cases = this.store.listForMerchant(caller.merchantId);
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
    const c = this.owned(caller, disputeId);
    const sql = this.sql;
    const evidence = await sql<EvidenceRow[]>`
      SELECT id, kind, file_name, content_type, size_bytes::text, sha256, note, added_by, created_at
        FROM pay.merchant_dispute_evidence
       WHERE merchant_id = ${caller.merchantId} AND dispute_id = ${c.disputeId}
       ORDER BY created_at, id`;
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
      ...view(c),
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
    const c = this.owned(caller, input.disputeId);
    if (!OPEN.has(c.status)) throw new MerchantOpsError('pay.dispute_closed', 'conflict');
    const rows = await this.sql<EvidenceRow[]>`
      INSERT INTO pay.merchant_dispute_evidence (merchant_id, dispute_id, kind, file_name, content_type, size_bytes, sha256, note, added_by)
      VALUES (${caller.merchantId}, ${c.disputeId}, ${input.kind}, ${input.fileName}, ${input.contentType}, ${input.sizeBytes}, ${input.sha256.toLowerCase()},
              ${input.note ?? null}, ${caller.userId})
      RETURNING id, kind, file_name, content_type, size_bytes::text, sha256, note, added_by, created_at`;
    return evidenceView(rows[0]!);
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
    const c = this.owned(caller, input.disputeId);
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
        if (input.action === 'contest') this.store.contest(c.disputeId);
        else this.store.accept(c.disputeId);
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
});

/** Stable digest helper for tests and callers that hash evidence client-side the same way. */
export const sha256Hex = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
