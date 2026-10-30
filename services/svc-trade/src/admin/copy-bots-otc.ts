/**
 * Copy, bots and OTC operator reads (CB-ops-05, CB-ops-04): module counts, one customer's follows, bots and quotes, and
 * the quote desk's list and settlement exceptions. Read only: nothing here posts, settles or changes a follow or a bot.
 *
 * COUNTS. Each count is read on its own. One that fails to read is `null` with its code (`trade.ops_metric_unavailable`),
 * never 0, and the others still show. The window the RFQ counts cover is an owner value
 * (TRADE_OPS_METRICS_WINDOW_SECONDS): blank refuses `trade.ops_metrics_window_not_set`, it is never filled in.
 *
 * LOOKUP. Needs `COPY_LOOKUP_SCOPE` on top of the desk read scope. Each lookup writes one operator audit row, in the same
 * transaction as the reads and before anything is returned; its id is derived from the read, never random. The rows
 * carry ids, states, pairs and times only: no follower region, caps, exposure or leader's account id.
 *
 * EXCEPTIONS. A quote accepted (bound) and never settled once its settle deadline (`otcSettleDeadline`) has passed: its
 * settle now refuses `trade.rfq_window_passed`. It is listed with the settle saga's key (`otc.settle:<quoteId>`) so an
 * operator can find the saga's ledger keys. Listing it moves nothing.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { requireScope, type Principal, type Scope } from '@intafaced/auth';
import { otcSettleDeadline } from '../otc/otc-service.js';
import type { OtcDeskLaw } from '../otc/desk-law.js';
import { requireOperator, TradeOpsError, writeOperatorAudit } from './common.js';

/** The scope a customer lookup needs, on top of the desk read scope (J-copy-bots-otc-13 #3). */
export const COPY_LOOKUP_SCOPE = 'support:lookup' satisfies Scope;
export const COPY_LOOKUP_AUDIT_KIND = 'copy_bots_otc.lookup' as const;
export const METRICS_WINDOW_KEY = 'TRADE_OPS_METRICS_WINDOW_SECONDS';
const METRIC_UNAVAILABLE = 'trade.ops_metric_unavailable';
const LIST_LIMIT = 200;

/** A count, or null with the code that says why it could not be read. Never 0 for a failed read. */
export interface OpsMetric {
  readonly value: number | null;
  readonly unavailable: string | null;
}

export interface OpsMetrics {
  readonly asOf: string;
  readonly window: { readonly seconds: number; readonly from: string; readonly to: string };
  readonly activeCopiers: OpsMetric;
  readonly activeBots: OpsMetric;
  readonly rfqsRequested: OpsMetric;
  readonly rfqsSettled: OpsMetric;
}

export interface LookupFollow {
  readonly followId: string;
  readonly leader: string;
  readonly state: string;
  readonly startedAt: string;
}
export interface LookupBot {
  readonly botId: string;
  readonly kind: string;
  readonly symbol: string;
  readonly side: string;
  readonly status: string;
  readonly createdAt: string;
}
export interface DeskQuote {
  readonly quoteId: string;
  readonly userId: string;
  readonly lifecycle: string;
  readonly side: string;
  readonly pair: string;
  readonly qty: string;
  readonly createdAt: string;
  readonly settledAt: string | null;
}
export interface SettlementException {
  readonly quoteId: string;
  readonly userId: string;
  readonly sagaKey: string;
  readonly reason: 'not_settled_by_deadline';
  readonly acceptedAt: string;
  readonly deadline: string;
}

/** Parses the owner's metrics window in whole seconds (1 s to 366 days). Blank or anything else is unset: null. */
export function parseMetricsWindowSeconds(raw: string | undefined): number | null {
  const text = raw?.trim() ?? '';
  if (!/^[1-9]\d{0,7}$/.test(text)) return null;
  const seconds = Number(text);
  return seconds <= 366 * 86_400 ? seconds : null;
}

/** The audit id of one lookup: a UUID derived from operator, customer and the read's instant. */
export function copyLookupAuditId(input: { operatorId: string; userId: string; readAt: string }): string {
  const key = [COPY_LOOKUP_AUDIT_KIND, input.operatorId, input.userId, input.readAt].join('|');
  const bytes = createHash('sha256').update(key).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const FOLLOW_STATE: Record<string, string> = { ACTIVE: 'Active', PAUSED: 'Paused', STOPPING: 'Stopping', DETACHED: 'Detached' };
const iso = (at: Date | string): string => (at instanceof Date ? at : new Date(at)).toISOString();

export interface CopyBotsOtcDeps {
  readonly sql: Sql;
  /** The quote desk law (TRADE_OTC_DESK_LAW). Unpublished: the exceptions list refuses, since it has no deadline. */
  readonly otcLaw: OtcDeskLaw;
  /** TRADE_OPS_METRICS_WINDOW_SECONDS, parsed. Null: metrics refuse. */
  readonly metricsWindowSeconds: number | null;
  readonly now: () => Date;
}

export class CopyBotsOtcAdmin {
  constructor(private readonly deps: CopyBotsOtcDeps) {}

  async metrics(principal: Principal): Promise<OpsMetrics> {
    requireOperator(principal);
    const seconds = this.deps.metricsWindowSeconds;
    if (seconds === null) {
      throw new TradeOpsError(
        'trade.ops_metrics_window_not_set',
        `The metrics window (${METRICS_WINDOW_KEY}) is not set, so no count is shown rather than one over a guessed window`,
      );
    }
    const now = this.deps.now();
    const from = new Date(now.getTime() - seconds * 1000);
    const sql = this.deps.sql;
    const count = async (read: () => Promise<Array<{ n: string | number }>>): Promise<OpsMetric> => {
      try {
        const [row] = await read();
        return { value: Number(row?.n ?? 0), unavailable: null };
      } catch {
        return { value: null, unavailable: METRIC_UNAVAILABLE };
      }
    };
    const [activeCopiers, activeBots, rfqsRequested, rfqsSettled] = await Promise.all([
      count(
        () => sql`SELECT count(DISTINCT follower_id) AS n FROM trade.copy_follows
          WHERE relationship_state = 'ACTIVE' AND expires_at > ${now.toISOString()}`,
      ),
      count(() => sql`SELECT count(*) AS n FROM trade.algo_parents WHERE status = 'active'`),
      count(
        () => sql`SELECT count(*) AS n FROM trade.otc_desk_quotes
          WHERE created_at > ${from.toISOString()} AND created_at <= ${now.toISOString()}`,
      ),
      count(
        () => sql`SELECT count(*) AS n FROM trade.otc_desk_quotes
          WHERE lifecycle = 'settled' AND settled_at > ${from.toISOString()} AND settled_at <= ${now.toISOString()}`,
      ),
    ]);
    return {
      asOf: now.toISOString(),
      window: { seconds, from: from.toISOString(), to: now.toISOString() },
      activeCopiers,
      activeBots,
      rfqsRequested,
      rfqsSettled,
    };
  }

  /** One customer's follows, bots and quotes. Audited; a failed audit write serves nothing. */
  async lookup(
    principal: Principal,
    input: { userId: string },
  ): Promise<{ userId: string; readAt: string; follows: LookupFollow[]; bots: LookupBot[]; quotes: DeskQuote[] }> {
    requireOperator(principal);
    requireScope(principal, COPY_LOOKUP_SCOPE);
    const readAt = this.deps.now();
    const auditId = copyLookupAuditId({ operatorId: principal.userId, userId: input.userId, readAt: readAt.toISOString() });
    return this.deps.sql.begin('isolation level repeatable read', async (tx) => {
      const follows = await tx<
        Array<{ follow_id: string; leader: string; relationship_state: string; created_at: Date; expires_at: Date }>
      >`
        SELECT f.follow_id, COALESCE(l.display_name, 'Unlisted leader') AS leader, f.relationship_state, f.created_at, f.expires_at
          FROM trade.copy_follows f
          LEFT JOIN trade.copy_leader_listings l ON l.leader_user_id = f.leader_id
         WHERE f.follower_id = ${input.userId}
         ORDER BY f.created_at DESC, f.follow_id DESC
         LIMIT ${LIST_LIMIT}`;
      const bots = await tx<Array<{ id: string; kind: string; symbol: string; side: string; status: string; created_at: Date }>>`
        SELECT id, kind::text AS kind, symbol, side::text AS side, status::text AS status, created_at
          FROM trade.algo_parents
         WHERE user_id = ${input.userId}
         ORDER BY created_at DESC, id DESC
         LIMIT ${LIST_LIMIT}`;
      const quotes = await tx<QuoteRow[]>`
        SELECT quote_id, user_id, lifecycle::text AS lifecycle, side, base_asset, quote_asset, qty::text AS qty, created_at, settled_at, expires_at
          FROM trade.otc_desk_quotes
         WHERE user_id = ${input.userId}
         ORDER BY created_at DESC, quote_id DESC
         LIMIT ${LIST_LIMIT}`;
      await writeOperatorAudit(
        tx as unknown as Sql,
        {
          id: auditId,
          kind: COPY_LOOKUP_AUDIT_KIND,
          operatorId: principal.userId,
          accountId: input.userId,
          objectId: input.userId,
          approverId: null,
          reason: null,
          detail: { follows: follows.length, bots: bots.length, quotes: quotes.length },
        },
        readAt,
      );
      return {
        userId: input.userId,
        readAt: readAt.toISOString(),
        follows: follows.map((row) => ({
          followId: row.follow_id,
          leader: row.leader,
          // Past its expiry the copy driver no longer copies it, whatever the stored state says.
          state:
            row.relationship_state === 'ACTIVE' && new Date(row.expires_at).getTime() <= readAt.getTime()
              ? 'Expired'
              : (FOLLOW_STATE[row.relationship_state] ?? row.relationship_state),
          startedAt: iso(row.created_at),
        })),
        bots: bots.map((row) => ({
          botId: row.id,
          kind: row.kind,
          symbol: row.symbol,
          side: row.side,
          status: row.status,
          createdAt: iso(row.created_at),
        })),
        quotes: quotes.map((row) => toDeskQuote(row, readAt)),
      };
    });
  }

  /** Open, accepted and settled quotes, and the settlement exceptions (accepted, never settled by the deadline). */
  async quoteDesk(principal: Principal): Promise<{ asOf: string; quotes: DeskQuote[]; exceptions: SettlementException[] }> {
    requireOperator(principal);
    const law = this.deps.otcLaw;
    if (!law.published) {
      throw new TradeOpsError('trade.otc_desk_law_unset', 'The quote desk law is not published, so no settle deadline can be read');
    }
    const now = this.deps.now();
    const quotes = await this.deps.sql<QuoteRow[]>`
      SELECT quote_id, user_id, lifecycle::text AS lifecycle, side, base_asset, quote_asset, qty::text AS qty, created_at, settled_at, expires_at
        FROM trade.otc_desk_quotes
       WHERE lifecycle IN ('open', 'bound', 'settled')
       ORDER BY created_at DESC, quote_id DESC
       LIMIT ${LIST_LIMIT}`;
    // The deadline as `otcSettleDeadline` reads it: the owner window from the accept, or the quote's expiry when blank.
    const windowMs = law.settleWindowMs ?? null;
    const sql = this.deps.sql;
    const bound = await sql<Array<{ quote_id: string; user_id: string; expires_at: Date; accepted_at: Date }>>`
      SELECT quote_id, user_id, expires_at, accepted_at
        FROM trade.otc_desk_quotes
       WHERE lifecycle = 'bound'
         AND ${
           windowMs === null
             ? sql`expires_at < ${now.toISOString()}`
             : sql`accepted_at + (${windowMs} * interval '1 millisecond') < ${now.toISOString()}`
         }
       ORDER BY accepted_at ASC, quote_id ASC
       LIMIT ${LIST_LIMIT}`;
    const exceptions: SettlementException[] = [];
    for (const row of bound) {
      // otcSettleDeadline reads only the quote's expiry and the accept time of a stored bound quote.
      const stored = { lifecycle: 'bound', quote: { expiresAt: iso(row.expires_at) }, bound: { acceptedAt: iso(row.accepted_at) } };
      const deadline = otcSettleDeadline(law, stored as unknown as Parameters<typeof otcSettleDeadline>[1]);
      if (now.getTime() <= deadline) continue;
      exceptions.push({
        quoteId: row.quote_id,
        userId: row.user_id,
        sagaKey: `otc.settle:${row.quote_id}`,
        reason: 'not_settled_by_deadline',
        acceptedAt: iso(row.accepted_at),
        deadline: new Date(deadline).toISOString(),
      });
    }
    return { asOf: now.toISOString(), quotes: quotes.map((row) => toDeskQuote(row, now)), exceptions };
  }
}

interface QuoteRow {
  quote_id: string;
  user_id: string;
  lifecycle: string;
  side: string;
  base_asset: string;
  quote_asset: string;
  qty: string;
  created_at: Date;
  settled_at: Date | null;
  expires_at: Date;
}

function toDeskQuote(row: QuoteRow, now: Date): DeskQuote {
  return {
    quoteId: row.quote_id,
    userId: row.user_id,
    // Only an explicit expire writes 'expired'; an open quote past its expiry can no longer be accepted.
    lifecycle: row.lifecycle === 'open' && new Date(row.expires_at).getTime() < now.getTime() ? 'expired' : row.lifecycle,
    side: row.side,
    pair: `${row.base_asset}/${row.quote_asset}`,
    qty: formatAmount(parseAmount(row.qty)),
    createdAt: iso(row.created_at),
    settledAt: row.settled_at ? iso(row.settled_at) : null,
  };
}
