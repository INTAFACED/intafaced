/**
 * A market's trading mode (SP-developer-status-01; the state write SP-ops-01 names), set by two operators.
 *
 *   admin.marketMode.get   the market's current mode as the last applied transition left it (admin:read)
 *   admin.marketMode.set   one mode change, consuming a second operator's approval (admin:write)
 *
 * The write appends one APPLIED transition to the market lifecycle evidence (`trade.market_lifecycle_evidence`), the one
 * source of truth the public lifecycle read, the desk, `/status` and order admission already read. Nothing else keeps a
 * mode. The approval id is the business key: a retry of the same approved change writes nothing new and answers the
 * first record. A halt stays matching's own door (`local-test-gates.mjs halt`); delisting stays the listing write.
 * No ledger write recipe is imported here: a mode change never moves money.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import type { Principal } from '@intafaced/auth';
import { marketTransitionRecordSchema, type MarketLifecycleState, type MarketTransitionRecord } from '@intafaced/exchange-contract';
import { SqlMarketLifecycleEvidenceStore, lifecycleTransitionId } from '../market-lifecycle.js';
import {
  consumeApproval,
  payloadHash,
  requireOperator,
  requireOperatorWrite,
  requireReason,
  TradeOpsError,
  writeOperatorAudit,
  type ApprovalBook,
} from './common.js';

export const MARKET_MODE_SET_ACTION = 'trade.market_mode_set' as const;

/** The modes an operator may set here. Each is a lifecycle state with a stated effect on /status. */
export const SETTABLE_MARKET_MODES = ['OPEN', 'POST_ONLY', 'LIMIT_ONLY', 'CANCEL_ONLY'] as const;
export type SettableMarketMode = (typeof SETTABLE_MARKET_MODES)[number];

/** The refusal each mode gives an order it does not admit; OPEN admits every order. */
const MODE_REASON: Readonly<Record<SettableMarketMode, string>> = {
  OPEN: 'trade.lifecycle.ready',
  POST_ONLY: 'trade.mode_post_only',
  LIMIT_ONLY: 'trade.mode_limit_only',
  CANCEL_ONLY: 'trade.mode_cancel_only',
};

export interface MarketModeView {
  readonly symbol: string;
  readonly marketId: string;
  /** The listing's own status (active, halted, delisted, pending). A non-active listing wins over any mode. */
  readonly listingStatus: string;
  /** The mode the last applied transition left, or OPEN when none was ever written. */
  readonly mode: MarketLifecycleState;
  readonly transitionId: string | null;
  readonly effectiveAt: string | null;
}

export interface MarketModeSetInput {
  readonly symbol: string;
  readonly mode: SettableMarketMode;
  /** The mode the operators saw when they proposed: a change under someone else's refuses as stale. */
  readonly expectedMode: string;
  readonly reason: string;
  readonly approvalId: string;
  readonly operationId: string;
}

export interface MarketModeDeps {
  readonly sql: Sql;
  readonly approvals: ApprovalBook;
  readonly now: () => Date;
}

/** The hash an approval for one mode change binds; the proposer and the consume compute the same. */
export function marketModePayloadHash(input: { symbol: string; mode: string; expectedMode: string; reason: string }): string {
  return payloadHash({
    actionType: MARKET_MODE_SET_ACTION,
    symbol: input.symbol,
    mode: input.mode,
    expectedMode: input.expectedMode,
    reason: input.reason,
  });
}

/** A stable UUID for the audit row of one transition, so a retried write keeps one row. */
function auditIdFor(transitionId: string): string {
  const hex = createHash('sha256').update(`trade.market_mode.audit|${transitionId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

type Row = { id: string; symbol: string; kind: string; status: string };

export class MarketModeAdmin {
  constructor(private readonly deps: MarketModeDeps) {}

  private async market(sql: Sql, symbol: string, lock = false): Promise<Row> {
    const [row] = lock
      ? await sql<
          Row[]
        >`SELECT id, symbol, kind::text AS kind, status::text AS status FROM trade.markets WHERE symbol = ${symbol} FOR UPDATE`
      : await sql<Row[]>`SELECT id, symbol, kind::text AS kind, status::text AS status FROM trade.markets WHERE symbol = ${symbol} LIMIT 1`;
    if (!row) throw new TradeOpsError('trade.market_not_found', `market ${symbol} not found`);
    return row;
  }

  /**
   * The last transition, by the same order the lifecycle read uses. A latest row that does not parse, or one left
   * partial or unknown, is not read as OPEN: the lifecycle read refuses it as recovery-required, and so does this door.
   */
  private async latest(sql: Sql, marketId: string): Promise<MarketTransitionRecord | null> {
    const [row] = await sql<Array<{ transition: unknown }>>`
      SELECT transition FROM trade.market_lifecycle_evidence
       WHERE market_id = ${marketId} AND evidence_kind = 'TRANSITION'
       ORDER BY observed_at DESC LIMIT 1`;
    if (!row) return null;
    const parsed = marketTransitionRecordSchema.safeParse(row.transition);
    if (!parsed.success) throw new TradeOpsError('trade.market_mode_recovery_required', 'the last lifecycle transition does not parse');
    // A partial or unknown transition has no resolved state (the contract keeps it null), so it is never read as OPEN:
    // it needs its recovery evidence first, and a newer APPLIED row written here would hide it and reopen placement.
    if (parsed.data.outcome.outcome === 'PARTIAL' || parsed.data.outcome.outcome === 'OUTCOME_UNKNOWN') {
      throw new TradeOpsError(
        'trade.market_mode_recovery_required',
        `the last lifecycle transition is ${parsed.data.outcome.outcome}; it needs recovery evidence first`,
      );
    }
    return parsed.data;
  }

  private view(market: Row, last: MarketTransitionRecord | null): MarketModeView {
    return {
      symbol: market.symbol,
      marketId: market.id,
      listingStatus: market.status,
      mode: last?.resolvedState ?? 'OPEN',
      transitionId: last?.transitionId ?? null,
      effectiveAt: last?.effectiveAt ?? null,
    };
  }

  async get(principal: Principal, symbol: string): Promise<MarketModeView> {
    requireOperator(principal);
    const market = await this.market(this.deps.sql, symbol);
    return this.view(market, await this.latest(this.deps.sql, market.id));
  }

  async set(principal: Principal, input: MarketModeSetInput): Promise<MarketModeView> {
    requireOperatorWrite(principal);
    if (!(SETTABLE_MARKET_MODES as readonly string[]).includes(input.mode)) {
      throw new TradeOpsError('trade.market_mode_unsupported', `mode ${input.mode} is not set through this door`);
    }
    const reason = requireReason(input.reason);
    // One transaction, holding the market row: the stale check, the approval and the write see the same last state,
    // so two approved changes against the same mode cannot both land. If the write then fails, the approval is spent
    // and nothing changed; the operators approve again.
    return this.deps.sql.begin(async (txn) => {
      const tx = txn as unknown as Sql;
      const market = await this.market(tx, input.symbol, true);
      if (market.kind !== 'spot') {
        throw new TradeOpsError('trade.market_mode_unsupported', `${market.symbol} is a ${market.kind} market; this door sets spot modes`);
      }
      const idempotencyKey = `market-mode:${market.id}:${input.approvalId}`;
      const transitionId = lifecycleTransitionId(market.id, input.expectedMode, input.mode, idempotencyKey);
      // A retry of the approved change answers its own first record (the approval was consumed by that write).
      const [done] = await tx<Array<{ transition: unknown }>>`
        SELECT transition FROM trade.market_lifecycle_evidence WHERE evidence_id = ${transitionId} LIMIT 1`;
      if (done) return this.view(market, marketTransitionRecordSchema.parse(done.transition));

      // A halted, delisted or pending listing wins over any mode; a mode is set only on an active listing.
      if (market.status !== 'active') {
        throw new TradeOpsError('trade.market_mode_listing_not_active', `${market.symbol} is ${market.status}; its listing state wins`);
      }
      const last = await this.latest(tx, market.id);
      const current = last?.resolvedState ?? 'OPEN';
      // A state this door does not set (halted, reduce-only, expiring, an auction ...) is lifted only by its own door.
      if (!(SETTABLE_MARKET_MODES as readonly string[]).includes(current)) {
        throw new TradeOpsError('trade.market_mode_not_settable', `${market.symbol} is ${current}; this door does not lift that state`);
      }
      if (current !== input.expectedMode) {
        throw new TradeOpsError('trade.market_mode_stale', `expected mode ${input.expectedMode}; the market is ${current}`);
      }
      if (current === input.mode) throw new TradeOpsError('trade.market_mode_unchanged', `the market is already ${current}`);
      const consumed = await consumeApproval(this.deps.approvals, {
        approvalId: input.approvalId,
        actionType: MARKET_MODE_SET_ACTION,
        targetId: `market-mode:${market.symbol}`,
        expectedVersion: last?.transitionId ?? 'none',
        payloadHash: marketModePayloadHash({ symbol: market.symbol, mode: input.mode, expectedMode: input.expectedMode, reason }),
        operationId: input.operationId,
      });
      // The lifecycle read takes the latest transition by its time: a new one is never earlier than the one it follows.
      const nowMs = this.deps.now().getTime();
      const afterMs = last ? Date.parse(last.requestedAt) + 1 : nowMs;
      const at = new Date(Math.max(nowMs, afterMs)).toISOString();
      const record: MarketTransitionRecord = {
        transitionId,
        idempotencyKey,
        marketId: market.id,
        expectedState: input.expectedMode as MarketLifecycleState,
        expectedRuleVersion: '1',
        requestedState: input.mode,
        resolvedState: input.mode,
        reasonCategory: input.mode === 'OPEN' ? 'NORMAL' : 'OPERATOR',
        reasonCode: MODE_REASON[input.mode],
        actorId: principal.userId,
        authorityRef: `approval:${input.approvalId}`,
        approvalRefs: [`approval:${input.approvalId}`, `approver:${consumed.approverId}`],
        requestedAt: at,
        effectiveAt: at,
        expiresAt: null,
        recoveryEvidenceRefs: [],
        outcome: { outcome: 'APPLIED', appliedTargets: [`market:${market.id}`], unresolvedTargets: [] },
      };
      const stored = await new SqlMarketLifecycleEvidenceStore(tx).appendTransition(record);
      await writeOperatorAudit(
        tx,
        {
          id: auditIdFor(transitionId),
          kind: 'market_mode',
          operatorId: principal.userId,
          accountId: null,
          objectId: market.id,
          approverId: consumed.approverId,
          reason,
          detail: { symbol: market.symbol, from: input.expectedMode, to: input.mode, transitionId },
        },
        new Date(at),
      );
      return this.view(market, stored);
    }) as Promise<MarketModeView>;
  }
}
