import type { Sql, TransactionSql } from 'postgres';
import { z } from 'zod';
import { OPS_REVERSAL_STATES, type OpsReversalState } from '@intafaced/contracts/ops-ledger-reversals';

/**
 * Reversal requests (OPS-ledger-desk-02): the intent row written before anything else, and what the ledger answered. The
 * reversing transaction itself is in the ledger; a row here records what svc-ops asked for, who approved it, and the
 * answer, so a lost reply is sent again under the same key and body and never under a new one.
 */

export interface ReversalRow {
  readonly requestNo: string;
  readonly originalTxId: string;
  readonly ordinal: string;
  readonly reason: string;
  readonly caseRef: string;
  readonly state: OpsReversalState;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly approvalId: string | null;
  readonly approverId: string | null;
  readonly approvedAt: string | null;
  readonly ledgerKey: string;
  readonly reversingTxId: string | null;
  readonly code: string | null;
  readonly reversedBy: string | null;
  readonly attempts: number;
  readonly lastAttemptAt: string | null;
  readonly settledAt: string | null;
}

/** The reversal of an original already known: one of ours that posted, or the one the ledger named refusing ours. */
export interface FirstReversal {
  readonly requestNo: string;
  readonly reversingTxId: string;
}

/** What may change on a row once written. Every other column is the request as asked and approved. */
export type ReversalPatch = Partial<
  Pick<
    ReversalRow,
    | 'state'
    | 'approvalId'
    | 'approverId'
    | 'approvedAt'
    | 'attempts'
    | 'lastAttemptAt'
    | 'reversingTxId'
    | 'code'
    | 'reversedBy'
    | 'settledAt'
  >
>;

export interface NewReversal {
  readonly originalTxId: string;
  readonly reason: string;
  readonly caseRef: string;
  readonly requestedBy: string;
  readonly at: string;
}

export type RequestOutcome =
  { readonly kind: 'created' | 'replayed'; readonly row: ReversalRow } | { readonly kind: 'reversed'; readonly first: FirstReversal };

export interface ReversalStore {
  /**
   * Under one lock per original: refuses when a reversal of it is known (`reversed`), returns this requester's own open
   * intent with the same words (`replayed`), or writes a new intent with the next ordinal for the original (`created`).
   */
  request(input: NewReversal): Promise<RequestOutcome>;
  get(requestNo: string): Promise<ReversalRow | null>;
  list(originalTxId: string, limit: number): Promise<ReversalRow[]>;
  /** Runs `fn` with the row locked; a returned patch is written before the lock is let go. Null when there is no such row. */
  update<T>(
    requestNo: string,
    fn: (row: ReversalRow, first: FirstReversal | null) => Promise<{ patch?: ReversalPatch; result: T }>,
  ): Promise<{ result: T } | null>;
  /** Open requests (`posting`, `pending_retry`) last sent before `before`, longest waiting first. */
  due(before: string, limit: number): Promise<string[]>;
}

export const reversalKey = (originalTxId: string, ordinal: string) => `ops:reversal:${originalTxId}:${ordinal}`;

const firstOf = (rows: readonly ReversalRow[], originalTxId: string, except?: string): FirstReversal | null => {
  const mine = rows.filter((r) => r.originalTxId === originalTxId && r.requestNo !== except);
  const posted = mine.find((r) => r.state === 'posted');
  if (posted?.reversingTxId) return { requestNo: posted.requestNo, reversingTxId: posted.reversingTxId };
  for (const r of mine) if (r.state === 'refused' && r.reversedBy !== null) return { requestNo: r.requestNo, reversingTxId: r.reversedBy };
  return null;
};

/** In memory, for tests: one lock for the whole store. */
export class MemoryReversalStore implements ReversalStore {
  private readonly rows: ReversalRow[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  all(): readonly ReversalRow[] {
    return this.rows;
  }

  request(input: NewReversal): Promise<RequestOutcome> {
    return this.serial(async () => {
      const first = firstOf(this.rows, input.originalTxId);
      if (first) return { kind: 'reversed', first };
      const same = this.rows.find(
        (r) =>
          r.originalTxId === input.originalTxId &&
          r.state === 'intent' &&
          r.requestedBy === input.requestedBy &&
          r.reason === input.reason &&
          r.caseRef === input.caseRef,
      );
      if (same) return { kind: 'replayed', row: same };
      const ordinal = String(this.rows.filter((r) => r.originalTxId === input.originalTxId).length + 1);
      const row: ReversalRow = {
        requestNo: String(this.rows.length + 1),
        originalTxId: input.originalTxId,
        ordinal,
        reason: input.reason,
        caseRef: input.caseRef,
        state: 'intent',
        requestedBy: input.requestedBy,
        requestedAt: input.at,
        approvalId: null,
        approverId: null,
        approvedAt: null,
        ledgerKey: reversalKey(input.originalTxId, ordinal),
        reversingTxId: null,
        code: null,
        reversedBy: null,
        attempts: 0,
        lastAttemptAt: null,
        settledAt: null,
      };
      this.rows.push(row);
      return { kind: 'created', row };
    });
  }

  async get(requestNo: string) {
    return this.rows.find((r) => r.requestNo === requestNo) ?? null;
  }

  async list(originalTxId: string, limit: number) {
    return this.rows
      .filter((r) => r.originalTxId === originalTxId)
      .reverse()
      .slice(0, limit);
  }

  update<T>(requestNo: string, fn: (row: ReversalRow, first: FirstReversal | null) => Promise<{ patch?: ReversalPatch; result: T }>) {
    return this.serial(async () => {
      const i = this.rows.findIndex((r) => r.requestNo === requestNo);
      const row = this.rows[i];
      if (!row) return null;
      const { patch, result } = await fn(row, firstOf(this.rows, row.originalTxId, row.requestNo));
      if (patch) {
        if (row.state === 'posted' || row.state === 'refused') throw new Error('a settled reversal request never changes');
        this.rows[i] = { ...row, ...patch };
      }
      return { result };
    });
  }

  async due(before: string, limit: number) {
    return this.rows
      .filter((r) => (r.state === 'posting' || r.state === 'pending_retry') && (r.lastAttemptAt ?? r.requestedAt) <= before)
      .sort((a, b) => (a.lastAttemptAt ?? '').localeCompare(b.lastAttemptAt ?? ''))
      .slice(0, limit)
      .map((r) => r.requestNo);
  }
}

const when = z.union([z.date(), z.string()]).transform((v) => new Date(v).toISOString());
const bigintText = z.union([z.string(), z.number(), z.bigint()]).transform(String);

/** One stored row, parsed where it is read: a column that changes fails here, not later. */
const ReversalDb = z
  .object({
    request_no: bigintText,
    original_tx_id: z.string(),
    ordinal: bigintText,
    reason: z.string(),
    case_ref: z.string(),
    state: z.enum(OPS_REVERSAL_STATES),
    requested_by: z.string(),
    requested_at: when,
    approval_id: z.string().nullable(),
    approver_id: z.string().nullable(),
    approved_at: when.nullable(),
    ledger_key: z.string(),
    reversing_tx_id: z.string().nullable(),
    code: z.string().nullable(),
    reversed_by: z.string().nullable(),
    attempts: z.number().int(),
    last_attempt_at: when.nullable(),
    settled_at: when.nullable(),
  })
  .transform((r): ReversalRow => ({
    requestNo: r.request_no,
    originalTxId: r.original_tx_id,
    ordinal: r.ordinal,
    reason: r.reason,
    caseRef: r.case_ref,
    state: r.state,
    requestedBy: r.requested_by,
    requestedAt: r.requested_at,
    approvalId: r.approval_id,
    approverId: r.approver_id,
    approvedAt: r.approved_at,
    ledgerKey: r.ledger_key,
    reversingTxId: r.reversing_tx_id,
    code: r.code,
    reversedBy: r.reversed_by,
    attempts: r.attempts,
    lastAttemptAt: r.last_attempt_at,
    settledAt: r.settled_at,
  }));
const rowsOf = (rows: readonly unknown[]): ReversalRow[] => ReversalDb.array().parse(rows);
const FirstDb = z.object({ request_no: z.string(), tx: z.string() });
const NumberDb = z.object({ n: z.string() });
const RequestNoDb = z.object({ request_no: z.string() });

async function firstIn(tx: TransactionSql, originalTxId: string, except: string | null): Promise<FirstReversal | null> {
  const [row] = FirstDb.array().parse(
    await tx`
    SELECT request_no::text AS request_no, coalesce(reversing_tx_id, reversed_by) AS tx FROM ops.ledger_reversals
    WHERE original_tx_id = ${originalTxId} AND request_no IS DISTINCT FROM ${except}::bigint
      AND (state = 'posted' OR (state = 'refused' AND reversed_by IS NOT NULL))
    ORDER BY (state = 'posted') DESC, request_no
    LIMIT 1
  `,
  );
  return row ? { requestNo: row.request_no, reversingTxId: row.tx } : null;
}

const COLUMNS: Record<keyof ReversalPatch, string> = {
  state: 'state',
  approvalId: 'approval_id',
  approverId: 'approver_id',
  approvedAt: 'approved_at',
  attempts: 'attempts',
  lastAttemptAt: 'last_attempt_at',
  reversingTxId: 'reversing_tx_id',
  code: 'code',
  reversedBy: 'reversed_by',
  settledAt: 'settled_at',
};
const PATCH_KEYS = Object.keys(COLUMNS).filter((k): k is keyof ReversalPatch => k in COLUMNS);

export class SqlReversalStore implements ReversalStore {
  constructor(private readonly sql: Sql) {}

  async request(input: NewReversal): Promise<RequestOutcome> {
    const outcome: RequestOutcome = await this.sql.begin(async (tx): Promise<RequestOutcome> => {
      // One request at a time per original: the ordinal is the next one, and a known reversal is seen.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`ops.ledger_reversal:${input.originalTxId}`}))`;
      const first = await firstIn(tx, input.originalTxId, null);
      if (first) return { kind: 'reversed', first };
      const [same] = rowsOf(
        await tx`
        SELECT * FROM ops.ledger_reversals
        WHERE original_tx_id = ${input.originalTxId} AND state = 'intent' AND requested_by = ${input.requestedBy}
          AND reason = ${input.reason} AND case_ref = ${input.caseRef}
        ORDER BY request_no LIMIT 1
      `,
      );
      if (same) return { kind: 'replayed', row: same };
      const [next] = NumberDb.array()
        .length(1)
        .parse(
          await tx`
        SELECT (coalesce(max(ordinal), 0) + 1)::text AS n FROM ops.ledger_reversals WHERE original_tx_id = ${input.originalTxId}
      `,
        );
      const ordinal = next?.n ?? '1';
      const [row] = rowsOf(
        await tx`
        INSERT INTO ops.ledger_reversals (original_tx_id, ordinal, reason, case_ref, requested_by, requested_at, state, ledger_key)
        VALUES (${input.originalTxId}, ${ordinal}, ${input.reason}, ${input.caseRef}, ${input.requestedBy}, ${input.at}, 'intent',
          ${reversalKey(input.originalTxId, ordinal)})
        RETURNING *
      `,
      );
      if (!row) throw new Error('the reversal intent insert returned no row');
      return { kind: 'created', row };
    });
    return outcome;
  }

  async get(requestNo: string) {
    const [row] = rowsOf(await this.sql`SELECT * FROM ops.ledger_reversals WHERE request_no = ${requestNo}`);
    return row ?? null;
  }

  async list(originalTxId: string, limit: number) {
    return rowsOf(
      await this.sql`
      SELECT * FROM ops.ledger_reversals WHERE original_tx_id = ${originalTxId} ORDER BY request_no DESC LIMIT ${limit}
    `,
    );
  }

  /**
   * The row is locked FOR UPDATE for the whole callback, including the call to identity that spends an approval (bounded by
   * the approval client's timeout). The ledger call itself runs outside the lock, between two of these.
   */
  async update<T>(
    requestNo: string,
    fn: (row: ReversalRow, first: FirstReversal | null) => Promise<{ patch?: ReversalPatch; result: T }>,
  ): Promise<{ result: T } | null> {
    const answer: { result: T } | null = await this.sql.begin(async (tx): Promise<{ result: T } | null> => {
      const [row] = rowsOf(await tx`SELECT * FROM ops.ledger_reversals WHERE request_no = ${requestNo} FOR UPDATE`);
      if (!row) return null;
      const { patch, result } = await fn(row, await firstIn(tx, row.originalTxId, row.requestNo));
      const set: Record<string, unknown> = {};
      for (const key of PATCH_KEYS) if (patch && key in patch) set[COLUMNS[key]] = patch[key];
      if (Object.keys(set).length > 0) await tx`UPDATE ops.ledger_reversals SET ${tx(set)} WHERE request_no = ${requestNo}`;
      return { result };
    });
    return answer;
  }

  async due(before: string, limit: number) {
    const rows = RequestNoDb.array().parse(
      await this.sql`
      SELECT request_no::text AS request_no FROM ops.ledger_reversals
      WHERE state IN ('posting', 'pending_retry') AND coalesce(last_attempt_at, requested_at) <= ${before}
      ORDER BY last_attempt_at NULLS FIRST, request_no
      LIMIT ${limit}
    `,
    );
    return rows.map((r) => r.request_no);
  }
}
