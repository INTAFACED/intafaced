/**
 * Limit-increase requests for personal transfers (BK-acct-04, accounts-insights-027).
 *
 * A customer asks for a higher per-transfer or daily limit on one asset with a
 * reason. Compliance approves with a granted amount (typed by the decider, never
 * defaulted to the requested one) or declines. The request id is the customer's
 * own business key: a retry with the same terms replays, other terms refuse
 * `bank.limit_request_conflict`. One open request per customer, asset and kind
 * (`bank.limit_request_open`). The latest approved grant replaces the published
 * limit of that kind for that customer, read by `quote` and by the transfer
 * check; with no published terms for the asset nothing changes.
 */
import { router, scopedProcedure } from '@intafaced/contracts';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { Sql, TransactionSql } from 'postgres';
import { z } from 'zod';
import { BankError } from '../errors.js';

export type LimitKind = 'per_transfer' | 'daily';

export interface LimitRequest {
  id: string;
  assetId: string;
  kind: LimitKind;
  requested: string;
  reason: string;
  status: 'open' | 'approved' | 'declined';
  granted: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
  createdAt: string;
  decidedAt: string | null;
}

interface Row {
  id: string;
  user_id: string;
  asset_id: string;
  kind: LimitKind;
  requested: string;
  reason: string;
  status: 'open' | 'approved' | 'declined';
  granted: string | null;
  decided_by: string | null;
  decision_note: string | null;
  created_at: Date;
  decided_at: Date | null;
}

function toRequest(row: Row): LimitRequest {
  return {
    id: row.id,
    assetId: row.asset_id,
    kind: row.kind,
    requested: formatAmount(parseAmount(row.requested)),
    reason: row.reason,
    status: row.status,
    granted: row.granted === null ? null : formatAmount(parseAmount(row.granted)),
    decidedBy: row.decided_by,
    decisionNote: row.decision_note,
    createdAt: row.created_at.toISOString(),
    decidedAt: row.decided_at?.toISOString() ?? null,
  };
}

const COLUMNS =
  'id, user_id, asset_id, kind, requested::text, reason, status, granted::text, decided_by, decision_note, created_at, decided_at';

/** Latest approved grant per kind for this customer and asset. Absent kind = no grant. */
export async function grantedLimits(
  sql: Sql | TransactionSql,
  userId: string,
  assetId: string,
): Promise<{ perTransfer: Amount | null; daily: Amount | null }> {
  const rows = await sql<Array<{ kind: LimitKind; granted: string }>>`
    SELECT DISTINCT ON (kind) kind, granted::text
      FROM bank.limit_increase_requests
     WHERE user_id = ${userId} AND asset_id = ${assetId} AND status = 'approved'
     ORDER BY kind, decided_at DESC
  `;
  const byKind = new Map(rows.map((r) => [r.kind, parseAmount(r.granted)]));
  return { perTransfer: byKind.get('per_transfer') ?? null, daily: byKind.get('daily') ?? null };
}

export class LimitRequestService {
  constructor(private readonly sql: Sql) {}

  async request(
    userId: string,
    input: { requestId: string; assetId: string; kind: LimitKind; requested: Amount; reason: string },
  ): Promise<LimitRequest & { replayed: boolean }> {
    const reason = input.reason.trim();
    if (reason.length < 10) {
      throw new BankError('A limit increase request needs a reason of at least 10 characters', 'bank.limit_request_reason_too_short');
    }
    if (input.requested <= 0n) throw new BankError('The requested limit must be positive', 'bank.validation_failed');
    const terms = await this.sql`SELECT 1 FROM bank.personal_transfer_terms WHERE asset_id = ${input.assetId}`;
    if (terms.length === 0) {
      throw new BankError(
        `No limits are published for ${input.assetId}, so there is nothing to raise (bank.personal_transfer_terms_unset)`,
        'bank.personal_transfer_terms_unset',
      );
    }
    let inserted: Row[];
    try {
      inserted = await this.sql<Row[]>`
        INSERT INTO bank.limit_increase_requests (id, user_id, asset_id, kind, requested, reason)
        VALUES (${input.requestId}, ${userId}, ${input.assetId}, ${input.kind}, ${formatAmount(input.requested)}::numeric, ${reason})
        ON CONFLICT (id) DO NOTHING
        RETURNING ${this.sql.unsafe(COLUMNS)}
      `;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new BankError(`A ${input.kind} limit request for ${input.assetId} is already open`, 'bank.limit_request_open');
      }
      throw err;
    }
    if (inserted[0]) return { ...toRequest(inserted[0]), replayed: false };
    const prior = (
      await this.sql<Row[]>`SELECT ${this.sql.unsafe(COLUMNS)} FROM bank.limit_increase_requests WHERE id = ${input.requestId}`
    )[0];
    if (
      !prior ||
      prior.user_id !== userId ||
      prior.asset_id !== input.assetId ||
      prior.kind !== input.kind ||
      parseAmount(prior.requested) !== input.requested ||
      prior.reason !== reason
    ) {
      throw new BankError('That request id was already used for a different request', 'bank.limit_request_conflict');
    }
    return { ...toRequest(prior), replayed: true };
  }

  async mine(userId: string, limit: number | undefined): Promise<LimitRequest[]> {
    if (limit === undefined)
      throw new BankError('Limit request page size is required; blank is not 50', 'bank.limit_request_list_limit_unset');
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM bank.limit_increase_requests WHERE user_id = ${userId}
       ORDER BY created_at DESC, id DESC LIMIT ${limit}
    `;
    return rows.map(toRequest);
  }

  async queue(limit: number | undefined): Promise<Array<LimitRequest & { userId: string }>> {
    if (limit === undefined)
      throw new BankError('Limit request page size is required; blank is not 50', 'bank.limit_request_list_limit_unset');
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM bank.limit_increase_requests WHERE status = 'open'
       ORDER BY created_at ASC, id ASC LIMIT ${limit}
    `;
    return rows.map((row) => ({ ...toRequest(row), userId: row.user_id }));
  }

  async decide(input: {
    requestId: string;
    decision: 'approve' | 'decline';
    granted?: Amount;
    note: string;
    deciderId: string;
  }): Promise<LimitRequest & { replayed: boolean }> {
    const note = input.note.trim();
    if (note.length < 10) {
      throw new BankError(
        'A limit decision needs a note of at least 10 characters (bank.ops_reason_too_short)',
        'bank.ops_reason_too_short',
      );
    }
    if (input.decision === 'approve' && (input.granted === undefined || input.granted <= 0n)) {
      throw new BankError('An approval names the granted limit; it is never defaulted to the requested one', 'bank.limit_grant_unset');
    }
    if (input.decision === 'decline' && input.granted !== undefined) {
      throw new BankError('A decline grants nothing', 'bank.validation_failed');
    }
    const status = input.decision === 'approve' ? 'approved' : 'declined';
    const granted = input.granted === undefined ? null : formatAmount(input.granted);
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM bank.limit_increase_requests WHERE id = ${input.requestId}
    `;
    const row = rows[0];
    if (!row) throw new BankError('No such limit request', 'bank.limit_request_not_found');
    if (row.user_id === input.deciderId) {
      throw new BankError('A customer cannot decide their own limit request', 'bank.limit_request_self_decision');
    }
    if (row.status !== 'open') {
      const same =
        row.status === status &&
        (row.granted === null ? granted === null : granted !== null && parseAmount(row.granted) === parseAmount(granted)) &&
        row.decision_note === note;
      if (same) return { ...toRequest(row), replayed: true };
      throw new BankError('This limit request was already decided differently', 'bank.limit_request_decided');
    }
    const updated = await this.sql<Row[]>`
      UPDATE bank.limit_increase_requests
         SET status = ${status}, granted = ${granted}::numeric, decided_by = ${input.deciderId},
             decision_note = ${note}, decided_at = now()
       WHERE id = ${input.requestId} AND status = 'open'
       RETURNING ${this.sql.unsafe(COLUMNS)}
    `;
    if (!updated[0]) throw new BankError('This limit request was decided by someone else first', 'bank.limit_request_decided');
    return { ...toRequest(updated[0]), replayed: false };
  }
}

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amount must be an unsigned decimal string (max 18dp)');
const requestOut = z.object({
  id: z.string().guid(),
  assetId: z.string(),
  kind: z.enum(['per_transfer', 'daily']),
  requested: amountString,
  reason: z.string(),
  status: z.enum(['open', 'approved', 'declined']),
  granted: amountString.nullable(),
  decidedBy: z.string().nullable(),
  decisionNote: z.string().nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
});

export function createLimitsRouter(service: () => LimitRequestService, guard: Guard) {
  return router({
    requestIncrease: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z
          .object({
            requestId: z.string().guid(),
            assetId: z.string().min(1).max(16),
            kind: z.enum(['per_transfer', 'daily']),
            requested: amountString,
            reason: z.string().max(500),
          })
          .strict(),
      )
      .output(requestOut.extend({ replayed: z.boolean() }))
      .mutation(({ ctx, input }) =>
        guard(() => service().request(ctx.principal.userId, { ...input, requested: parseAmount(input.requested) })),
      ),
    myRequests: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ limit: z.number().int().min(1).max(200).optional() }).strict())
      .output(z.array(requestOut))
      .query(({ ctx, input }) => guard(() => service().mine(ctx.principal.userId, input.limit))),
  });
}

export function limitRequestQueueProcedure(service: () => LimitRequestService, guard: Guard) {
  return scopedProcedure('admin:compliance')
    .input(z.object({ limit: z.number().int().min(1).max(200).optional() }).strict())
    .output(z.array(requestOut.extend({ userId: z.string().guid() })))
    .query(({ input }) => guard(() => service().queue(input.limit)));
}

export function decideLimitRequestProcedure(service: () => LimitRequestService, guard: Guard) {
  return scopedProcedure('admin:compliance')
    .input(
      z
        .object({
          requestId: z.string().guid(),
          decision: z.enum(['approve', 'decline']),
          granted: amountString.optional(),
          note: z.string().max(500),
        })
        .strict(),
    )
    .output(requestOut.extend({ replayed: z.boolean() }))
    .mutation(({ ctx, input }) =>
      guard(() =>
        service().decide({
          requestId: input.requestId,
          decision: input.decision,
          ...(input.granted !== undefined ? { granted: parseAmount(input.granted) } : {}),
          note: input.note,
          deciderId: ctx.principal.userId,
        }),
      ),
    );
}
