/**
 * Operator procedures the trade desk calls. Reads are `admin:read`, the same
 * scope as GET /api/v1/admin/orders/open. Writes are `admin:write`. Every read
 * of an account writes one append-only audit row. Money figures stay exact
 * decimal strings.
 */
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import type { Principal } from '@intafaced/auth';
import { formatAmount, parseAmount, type AccountRef } from '@intafaced/ledger-client';
import { holdAccountOf } from '../spot/buyback-order.js';
import type { ListMarketInput } from '../spot/trade-service.js';
import type { Market, ReconcileResult } from '../spot/types.js';
import { HOLD_UNKNOWN_IN_FLIGHT_BOUND_SECONDS } from '../spot/hold-outcome.js';
import { parseConfiguredMaxLeverage, LEVERAGE_CAP_UNSET } from '../futures/initial-margin.js';
import { recipeInsuranceAccount } from '../futures/insurance-bound.js';
import { recipeProfitFundingAccount } from '../futures/profit-source.js';
import { pendingPayoutTotals } from '../futures/futures-payouts.js';
import { readInsuranceHistory, readLiquidationDesk, type InsuranceHistory, type LiquidationDesk } from './futures-desk.js';
import {
  consumeApproval,
  csvLine,
  decodeCursor,
  encodeCursor,
  exportExpiry,
  loadRequest,
  openExportRef,
  payloadHash,
  readExportCap,
  readExportSigningKey,
  requireClientRequestId,
  requireOperator,
  requireOperatorWrite,
  requireReason,
  signExportRef,
  storeRequest,
  TradeOpsError,
  writeOperatorAudit,
  type ApprovalBook,
} from './common.js';
import { AgreementsAdmin } from './agreements.js';
import {
  BUST_ACTION_TYPE,
  TRADE_BUST_RECIPE_MISSING,
  bustApprovalBody,
  bustAuditId,
  sweepLog,
  type SweepLists,
  type SweepResult,
} from './bust.js';
import { ChartOwnerValuesAdmin } from './chart-owner-values.js';
import { MarketModeAdmin } from './market-mode.js';
import { SeedConfigAdmin } from './seed-config.js';
import { FuturesContractsAdmin } from './futures-contracts.js';
import {
  assertPriceRangeWhole,
  carriedLimits,
  currentRisk,
  riskHistory,
  riskView,
  validateLimits,
  type RiskLimitsInput,
  type RiskVersion,
} from './risk.js';
import {
  assertMakerRebatesPayable,
  parseFeeScheduleJson,
  FeeScheduleError,
  UNPUBLISHED_FEE_SCHEDULE,
  type OwnerFeeSchedule,
} from '../spot/fee-schedule.js';
import { priceBandView, sqlPriceBandStore, type PriceBandView } from '../futures/dynamic-price-band.js';
import { feeScheduleAt, feeScheduleHistory, latestFeeScheduleVersion, type FeeScheduleVersionRow } from '../spot/fee-schedule-store.js';
import { VipReviewAdmin } from './vip-review.js';
import { readMarketStatusHistory } from './status-history.js';
import { FundingDesk } from './funding-desk.js';
import { CopyBotsOtcAdmin } from './copy-bots-otc.js';
import type { OtcDeskLaw } from '../otc/desk-law.js';
import { FeesConvertDesk, type ConvertOwnerValues } from './fees-convert-desk.js';

export interface TradeOpsDeps {
  readonly sql: Sql;
  readonly approvals: ApprovalBook;
  /** Existing cancel path. The adapter builds the order owner's principal. */
  readonly cancelOrder: (orderId: string, userId: string) => Promise<void>;
  /** Existing `TradeService.reconcileOrder`; the sweep passes `{ leaveLive: true }`. */
  readonly reconcileOrder: (orderId: string, opts?: { leaveLive?: boolean }) => Promise<ReconcileResult>;
  /** `TradeService.engineLiveOrderIds`: one market's resting order ids, from one engine list. Absent: the sweep reads no book. */
  readonly engineLiveOrderIds?: (marketId: string) => Promise<ReadonlySet<string>>;
  /** TRADE_OPERATOR_SWEEP_ENABLED: the sweep's kill switch, off unless set on. Off, the sweep refuses `reconcile_sweep_disabled`. */
  readonly sweepEnabled?: boolean;
  /**
   * TRADE_OPERATOR_SWEEP_LIMIT, parsed: the most orders one operator reconcile sweep looks at. An owner value; absent or
   * null, the sweep refuses `reconcile_sweep_unconfigured` and looks at nothing.
   */
  readonly sweepLimit?: number | null;
  /**
   * TRADE_OPERATOR_SWEEP_MIN_AGE_SECONDS, parsed. Two waits, the same length: an order must have gone unchanged that long
   * before a sweep looks at it, and its engine miss must have lasted that long, without the book listing it in between,
   * before a sweep releases its hold. Either way, a fill the book made but trade has not recorded yet is never read as
   * "never filled". Absent or null: the sweep refuses `reconcile_sweep_unconfigured`.
   */
  readonly sweepMinAgeSeconds?: number | null;
  readonly ledger: { balance(ref: AccountRef): Promise<{ accountId: string; amount: bigint }> } | null;
  /** Existing `TradeService.listMarket`, for `admin.futuresListing.create`. Absent: that door refuses unconfigured. */
  readonly listMarket?: (input: ListMarketInput) => Promise<Market>;
  /** The boot fee schedule (TRADE_FEE_SCHEDULE), for the VIP trial the owner publishes. Absent: none is published. */
  readonly feeSchedule?: OwnerFeeSchedule;
  /** The VIP proof key (TRADE_VIP_PROOF_KEY). Absent or null: proofs cannot be opened. */
  readonly vipProofKey?: Buffer | null;
  /** The quote desk law (TRADE_OTC_DESK_LAW), for settle deadlines. Absent: unpublished, so the quote desk read refuses. */
  readonly otcLaw?: OtcDeskLaw;
  /** TRADE_OPS_METRICS_WINDOW_SECONDS, parsed. Absent or null: the module counts refuse. */
  readonly metricsWindowSeconds?: number | null;
  /** Convert's owner values and what it offers now, for the finance read. Absent: that read refuses unwired. */
  readonly convert?: ConvertOwnerValues;
  readonly now?: () => Date;
}

const TERMINAL = ['filled', 'cancelled', 'rejected', 'expired', 'open', 'pending', 'recovery_required', 'hold_unknown'] as const;
const OPEN_FOR_CANCEL = ['open', 'pending', 'recovery_required', 'hold_unknown'] as const;

export interface OrderRow {
  id: string;
  user_id: string;
  market_id: string;
  status: string;
  side: string;
  type: string;
  price: string | null;
  qty: string;
  filled_qty: string;
  hold_asset: string;
  hold_amount: string;
  seeded: boolean;
  reject_code: string | null;
  created_at: Date;
}

function nowOf(deps: TradeOpsDeps): Date {
  return deps.now?.() ?? new Date();
}

function sumDecimals(values: readonly string[]): string {
  let total = 0n;
  for (const value of values) total += parseAmount(value);
  return formatAmount(total);
}

export class TradeOpsAdmin {
  /** Futures contract families, expiry tenors and pre-market (D-instruments-03). */
  readonly futuresContracts: FuturesContractsAdmin;
  /** Risk agreements, margin terms and derivatives eligibility rules (D-account-07). */
  readonly agreements: AgreementsAdmin;
  /** Charts module owner values and the per-market data class (C-ops-04, LD-14). */
  readonly chartOwnerValues: ChartOwnerValuesAdmin;
  /** A market's trading mode, set by two operators (SP-developer-status-01, J-cex-spot-14 #3 #4). */
  readonly marketMode: MarketModeAdmin;
  readonly seedConfig: SeedConfigAdmin;
  /** VIP application review and trial grants (SP-fees-vip-04, J-cex-spot-10 #7). */
  readonly vipApplications: VipReviewAdmin;
  /** Copy, bots and OTC counts, customer lookup and quote desk (CB-ops-05, CB-ops-04). */
  readonly copyBotsOtc: CopyBotsOtcAdmin;
  /** Fee tier snapshot runs, Convert's owner values and its quotes, read only (J-cex-spot-17). */
  readonly feesConvert: FeesConvertDesk;

  constructor(private readonly deps: TradeOpsDeps) {
    this.feesConvert = new FeesConvertDesk({ sql: deps.sql, ...(deps.convert ? { convert: deps.convert } : {}) });
    this.copyBotsOtc = new CopyBotsOtcAdmin({
      sql: deps.sql,
      otcLaw: deps.otcLaw ?? { published: false },
      metricsWindowSeconds: deps.metricsWindowSeconds ?? null,
      now: () => nowOf(deps),
    });
    this.vipApplications = new VipReviewAdmin({
      sql: deps.sql,
      approvals: deps.approvals,
      proofKey: deps.vipProofKey ?? null,
      scheduleAt: (at) => feeScheduleAt(deps.sql, deps.feeSchedule ?? UNPUBLISHED_FEE_SCHEDULE, at),
      now: () => nowOf(deps),
    });
    this.agreements = new AgreementsAdmin({ sql: deps.sql, approvals: deps.approvals, now: () => nowOf(deps) });
    this.chartOwnerValues = new ChartOwnerValuesAdmin({ sql: deps.sql, approvals: deps.approvals, now: () => nowOf(deps) });
    this.marketMode = new MarketModeAdmin({ sql: deps.sql, approvals: deps.approvals, now: () => nowOf(deps) });
    this.seedConfig = new SeedConfigAdmin({ sql: deps.sql, approvals: deps.approvals });
    this.futuresContracts = new FuturesContractsAdmin({
      sql: deps.sql,
      approvals: deps.approvals,
      ledger: deps.ledger,
      ...(deps.listMarket ? { listMarket: deps.listMarket } : {}),
      now: () => nowOf(deps),
    });
  }

  /** Funding parameters, index sources and computed periods (D-instruments-01). */
  get funding(): FundingDesk {
    return new FundingDesk({ sql: this.deps.sql, approvals: this.deps.approvals, ...(this.deps.now ? { now: this.deps.now } : {}) });
  }

  async massCancel(
    principal: Principal,
    input: { market?: string | null; accountId?: string | null; reason: string; approvalId: string; clientRequestId: string },
  ): Promise<{
    scope: string;
    results: Array<{ orderId: string; ok: true; status: 'cancelled' } | { orderId: string; ok: false; code: string }>;
  }> {
    requireOperatorWrite(principal);
    const reason = requireReason(input.reason);
    const clientRequestId = requireClientRequestId(input.clientRequestId);
    const market = input.market?.trim() || null;
    const accountId = input.accountId?.trim() || null;
    if (!market && !accountId) {
      throw new TradeOpsError('mass_cancel_venue_refused', 'a whole-venue cancel is refused here and stays on the kill-switch path');
    }
    const scope = `market:${market ?? ''}|account:${accountId ?? ''}`;
    const fingerprint = payloadHash({ kind: 'mass_cancel', market, accountId, reason });
    const prior = await loadRequest(this.deps.sql, clientRequestId, 'mass_cancel', fingerprint);
    if (prior) return prior as { scope: string; results: [] };
    const body = { actionType: 'trade.mass_cancel', scope, reason };
    const consumed = await consumeApproval(this.deps.approvals, {
      approvalId: input.approvalId,
      actionType: 'trade.mass_cancel',
      targetId: scope,
      expectedVersion: '0',
      payloadHash: payloadHash(body),
      operationId: clientRequestId,
    });
    const orders = await this.deps.sql<Array<{ id: string; user_id: string }>>`
      SELECT id, user_id::text FROM trade.orders
       WHERE status::text = ANY(${OPEN_FOR_CANCEL})
         ${market ? this.deps.sql`AND market_id = ${market}` : this.deps.sql``}
         ${accountId ? this.deps.sql`AND user_id = ${accountId}` : this.deps.sql``}
       ORDER BY created_at ASC, id ASC`;
    const results: Array<{ orderId: string; ok: true; status: 'cancelled' } | { orderId: string; ok: false; code: string }> = [];
    for (const order of orders) {
      try {
        await this.deps.cancelOrder(order.id, order.user_id);
        // A cancel can leave the order open with its hold while a fill the engine matched is still settling (#6874).
        const [after] = await this.deps.sql<
          Array<{ status: string }>
        >`SELECT status::text AS status FROM trade.orders WHERE id = ${order.id}`;
        if (after?.status === 'cancelled') results.push({ orderId: order.id, ok: true, status: 'cancelled' });
        else if (after?.status === 'open' || after?.status === 'pending' || after?.status === 'recovery_required')
          results.push({ orderId: order.id, ok: false, code: 'trade.cancel_ahead_of_fill' });
        else results.push({ orderId: order.id, ok: false, code: 'trade.order_not_open' });
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? String((error as { code: string }).code) : 'cancel_failed';
        results.push({ orderId: order.id, ok: false, code });
      }
    }
    const result = { scope, results };
    await storeRequest(this.deps.sql, clientRequestId, 'mass_cancel', fingerprint, result);
    await writeOperatorAudit(
      this.deps.sql,
      {
        kind: 'mass_cancel',
        operatorId: principal.userId,
        accountId,
        objectId: scope,
        approverId: consumed.approverId,
        reason,
        detail: { cancelled: results.filter((row) => row.ok).length, failed: results.filter((row) => !row.ok).length },
      },
      nowOf(this.deps),
    );
    return result;
  }

  async getOrder(
    principal: Principal,
    orderId: string,
  ): Promise<{
    order: OrderRow & { holdReference: { ownerId: string; assetId: string; purpose: string } };
    fills: Array<{ id: string; price: string; qty: string; quoteAmount: string; feeAmount: string }>;
  }> {
    requireOperator(principal);
    const [order] = await this.deps.sql<OrderRow[]>`
      SELECT id, user_id::text, market_id, status::text, side::text, type::text, price::text, qty::text,
             filled_qty::text, hold_asset, hold_amount::text, seeded, reject_code, created_at
        FROM trade.orders WHERE id = ${orderId}`;
    if (!order) throw new TradeOpsError('order_not_found', `order ${orderId} not found`);
    const fills = await this.deps.sql<Array<{ id: string; price: string; qty: string; quote_amount: string; fee_amount: string }>>`
      SELECT id, price::text, qty::text, quote_amount::text, fee_amount::text
        FROM trade.fills WHERE order_id = ${orderId} ORDER BY ts ASC, id ASC`;
    const hold = holdAccountOf({ id: order.id, userId: order.user_id, holdAsset: order.hold_asset });
    await writeOperatorAudit(this.deps.sql, {
      kind: 'orders.get',
      operatorId: principal.userId,
      accountId: order.user_id,
      objectId: order.id,
      approverId: null,
      reason: null,
    });
    return {
      order: {
        ...order,
        holdReference: { ownerId: hold.ownerId, assetId: hold.assetId, purpose: hold.purpose ?? '' },
      },
      fills: fills.map((fill) => ({
        id: fill.id,
        price: fill.price,
        qty: fill.qty,
        quoteAmount: fill.quote_amount,
        feeAmount: fill.fee_amount,
      })),
    };
  }

  async listOrders(
    principal: Principal,
    input: {
      status: string;
      market?: string | null;
      accountId?: string | null;
      from?: string | null;
      to?: string | null;
      cursor?: string | null;
      limit: number;
    },
  ): Promise<{ rows: OrderRow[]; nextCursor: string | null }> {
    requireOperator(principal);
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200) {
      throw new TradeOpsError('orders_list_limit_unset', 'limit is required (1–200); this list does not invent a page size');
    }
    if (!(TERMINAL as readonly string[]).includes(input.status)) {
      throw new TradeOpsError('orders_status_unknown', `status ${input.status} is not an order status`);
    }
    const page = decodeCursor(input.cursor);
    const market = input.market?.trim() || null;
    const accountId = input.accountId?.trim() || null;
    const rows = await this.deps.sql<OrderRow[]>`
      SELECT id, user_id::text, market_id, status::text, side::text, type::text, price::text, qty::text,
             filled_qty::text, hold_asset, hold_amount::text, seeded, reject_code, created_at
        FROM trade.orders
       WHERE status = ${input.status}
         ${market ? this.deps.sql`AND market_id = ${market}` : this.deps.sql``}
         ${accountId ? this.deps.sql`AND user_id = ${accountId}` : this.deps.sql``}
         ${input.from ? this.deps.sql`AND created_at >= ${input.from}` : this.deps.sql``}
         ${input.to ? this.deps.sql`AND created_at < ${input.to}` : this.deps.sql``}
         ${page ? this.deps.sql`AND (created_at, id) > (${page.at}::timestamptz, ${page.id}::uuid)` : this.deps.sql``}
       ORDER BY created_at ASC, id ASC
       LIMIT ${input.limit + 1}`;
    const more = rows.length > input.limit;
    const slice = more ? rows.slice(0, input.limit) : rows;
    const accounts = [...new Set(slice.map((row) => row.user_id))];
    await writeOperatorAudit(this.deps.sql, {
      kind: 'orders.list',
      operatorId: principal.userId,
      accountId: accounts.length === 1 ? accounts[0]! : null,
      objectId: input.status,
      approverId: null,
      reason: null,
      detail: { accounts, count: slice.length },
    });
    const last = slice[slice.length - 1];
    return {
      rows: slice,
      nextCursor: more && last ? encodeCursor(last.created_at.toISOString(), last.id) : null,
    };
  }

  async riskGet(principal: Principal, market: string): Promise<ReturnType<typeof riskView>> {
    requireOperator(principal);
    const row = await currentRisk(this.deps.sql, market);
    await writeOperatorAudit(this.deps.sql, {
      kind: 'risk_limit.get',
      operatorId: principal.userId,
      accountId: null,
      objectId: market,
      approverId: null,
      reason: null,
    });
    return riskView(market, row);
  }

  async riskHistory(principal: Principal, market: string): Promise<RiskVersion[]> {
    requireOperator(principal);
    return riskHistory(this.deps.sql, market);
  }

  /** The market's dynamic price band (D-instruments-08): the band the job last worked out, and each change to it. */
  async riskPriceBand(principal: Principal, market: string): Promise<PriceBandView> {
    requireOperator(principal);
    return priceBandView(sqlPriceBandStore(this.deps.sql), market);
  }

  async riskSet(
    principal: Principal,
    input: { market: string; limits: RiskLimitsInput; expectedVersion: string; reason: string; approvalId: string; operationId: string },
  ): Promise<RiskVersion> {
    requireOperatorWrite(principal);
    const reason = requireReason(input.reason);
    const limits = validateLimits(input.limits);
    const current = await currentRisk(this.deps.sql, input.market);
    const version = current?.version ?? '0';
    if (version !== input.expectedVersion) {
      throw new TradeOpsError('risk_limit_stale', `expectedVersion ${input.expectedVersion} is stale; current is ${version}`);
    }
    // A write that leaves out a carried field keeps the value of the version it was approved against (`expectedVersion`).
    // Checked before the approval is used, so a write that cannot stand leaves it unused.
    const carried = carriedLimits(limits, current);
    assertPriceRangeWhole(carried);
    const body = { actionType: 'trade.risk_set', market: input.market, limits, expectedVersion: input.expectedVersion, reason };
    const consumed = await consumeApproval(this.deps.approvals, {
      approvalId: input.approvalId,
      actionType: 'trade.risk_set',
      targetId: input.market,
      expectedVersion: input.expectedVersion,
      payloadHash: payloadHash(body),
      operationId: input.operationId,
    });
    const next = (BigInt(version) + 1n).toString();
    const id = randomUUID();
    const at = nowOf(this.deps);
    await this.deps.sql`INSERT INTO trade.operator_risk_limits (
      id, market_id, version, collar, fat_finger, slippage_cap, throttle, circuit_breaker, oi_limit, oi_share_bps,
      price_range_max, price_range_trigger, price_range_cadence_seconds,
      operator_id, approver_id, reason, approval_id, created_at
    ) VALUES (
      ${id}, ${input.market}, ${next}::bigint, ${limits.collar}, ${limits.fatFinger}, ${limits.slippageCap},
      ${limits.throttle}, ${limits.circuitBreaker}, ${carried.oiLimit}, ${carried.oiShareBps},
      ${carried.priceRangeMax}, ${carried.priceRangeTrigger}, ${carried.priceRangeCadenceSeconds},
      ${principal.userId}, ${consumed.approverId}, ${reason}, ${input.approvalId}, ${at.toISOString()}
    )`;
    await writeOperatorAudit(
      this.deps.sql,
      {
        kind: 'risk_limit.set',
        operatorId: principal.userId,
        accountId: null,
        objectId: input.market,
        approverId: consumed.approverId,
        reason,
        detail: { version: next },
      },
      at,
    );
    const written = await currentRisk(this.deps.sql, input.market);
    if (!written) throw new TradeOpsError('risk_limit_unreadable', 'risk limit row was not readable after write');
    return written;
  }

  async feeScheduleGet(principal: Principal): Promise<{ version: string; history: FeeScheduleVersionRow[] }> {
    requireOperator(principal);
    return { version: await latestFeeScheduleVersion(this.deps.sql), history: await feeScheduleHistory(this.deps.sql) };
  }

  /**
   * Two-person write of a new owner fee schedule version. The proposed schedule must parse as a published schedule
   * (a blank or malformed field refuses with the typed code and nothing is stored), and it takes effect from a stated
   * time that is not in the past, so no order already placed is re-priced.
   */
  async feeScheduleSet(
    principal: Principal,
    input: {
      schedule: Record<string, unknown>;
      effectiveAt: string;
      expectedVersion: string;
      reason: string;
      approvalId: string;
      operationId: string;
    },
  ): Promise<FeeScheduleVersionRow> {
    requireOperatorWrite(principal);
    const reason = requireReason(input.reason);
    const at = nowOf(this.deps);
    const effectiveAt = new Date(input.effectiveAt);
    if (Number.isNaN(effectiveAt.getTime())) {
      throw new TradeOpsError('trade.fee_schedule_blank', 'effectiveAt must be an ISO timestamp');
    }
    if (effectiveAt.getTime() < at.getTime()) {
      throw new TradeOpsError('fee_schedule_effective_in_past', 'a fee schedule version cannot take effect in the past');
    }
    // `version` is assigned here; a proposal that names one is refused rather than silently overwritten.
    if ('version' in input.schedule || 'published' in input.schedule) {
      throw new TradeOpsError('trade.fee_schedule_blank', 'a proposal carries rates only: version and published are set by the write');
    }
    try {
      const parsed = parseFeeScheduleJson(JSON.stringify({ ...input.schedule, published: true, version: 'proposal' }));
      if (parsed.published !== true) throw new TradeOpsError('trade.fee_schedule_blank', 'the proposed schedule is not published');
      assertMakerRebatesPayable(parsed);
    } catch (err) {
      if (err instanceof FeeScheduleError) throw new TradeOpsError(err.code, err.message);
      throw err;
    }
    // Versions take effect in order: a later version never starts before an earlier one, or the lookup would pick the older.
    const [latest] = await this.deps.sql<Array<{ at: Date | null }>>`SELECT max(effective_at) AS at FROM trade.fee_schedule_versions`;
    if (latest?.at && effectiveAt.getTime() < latest.at.getTime()) {
      throw new TradeOpsError('fee_schedule_effective_out_of_order', 'a new version cannot take effect before the latest stored version');
    }
    const version = await latestFeeScheduleVersion(this.deps.sql);
    if (version !== input.expectedVersion) {
      throw new TradeOpsError('fee_schedule_stale', `expectedVersion ${input.expectedVersion} is stale; current is ${version}`);
    }
    const body = {
      actionType: 'trade.fee_schedule_set',
      schedule: input.schedule,
      effectiveAt: effectiveAt.toISOString(),
      expectedVersion: input.expectedVersion,
      reason,
    };
    const consumed = await consumeApproval(this.deps.approvals, {
      approvalId: input.approvalId,
      actionType: 'trade.fee_schedule_set',
      targetId: 'spot-fee-schedule',
      expectedVersion: input.expectedVersion,
      payloadHash: payloadHash(body),
      // The id identity gave the approval's operation when it was proposed: consume refuses any other.
      operationId: input.operationId,
    });
    const next = (BigInt(version) + 1n).toString();
    try {
      await this.deps.sql`INSERT INTO trade.fee_schedule_versions (
        id, version, schedule, effective_at, operator_id, approver_id, reason, approval_id, created_at
      ) VALUES (
        ${randomUUID()}, ${next}::bigint, ${this.deps.sql.json(input.schedule as never)}, ${effectiveAt.toISOString()},
        ${principal.userId}, ${consumed.approverId}, ${reason}, ${input.approvalId}, ${at.toISOString()}
      )`;
    } catch (err) {
      // Two writers raced for the same next version: the loser is stale, not a second write.
      if ((err as { code?: string }).code === '23505') {
        throw new TradeOpsError('fee_schedule_stale', `version ${next} was written by another operator`);
      }
      throw err;
    }
    await writeOperatorAudit(
      this.deps.sql,
      {
        kind: 'fee_schedule.set',
        operatorId: principal.userId,
        accountId: null,
        objectId: 'spot-fee-schedule',
        approverId: consumed.approverId,
        reason,
        detail: { version: next, effectiveAt: effectiveAt.toISOString() },
      },
      at,
    );
    const written = (await feeScheduleHistory(this.deps.sql)).find((row) => row.version === next);
    if (!written) throw new TradeOpsError('fee_schedule_unreadable', 'fee schedule version was not readable after write');
    return written;
  }

  async listPositions(
    principal: Principal,
    input: { accountId?: string | null; market?: string | null; cursor?: string | null; limit: number },
  ): Promise<{ rows: Array<Record<string, string | null>>; nextCursor: string | null }> {
    requireOperator(principal);
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200) {
      throw new TradeOpsError('positions_list_limit_unset', 'limit is required (1–200); this list does not invent a page size');
    }
    const page = decodeCursor(input.cursor);
    const accountId = input.accountId?.trim() || null;
    const market = input.market?.trim() || null;
    const rows = await this.deps.sql<
      Array<{
        id: string;
        user_id: string;
        market_id: string;
        side: string;
        status: string;
        size: string;
        entry_price: string;
        opened_at: Date;
      }>
    >`
      SELECT id, user_id, market_id, side::text, status::text, size::text, entry_price::text, opened_at
        FROM trade.positions
       WHERE true
         ${accountId ? this.deps.sql`AND user_id = ${accountId}` : this.deps.sql``}
         ${market ? this.deps.sql`AND market_id = ${market}` : this.deps.sql``}
         ${page ? this.deps.sql`AND (opened_at, id) > (${page.at}::timestamptz, ${page.id}::uuid)` : this.deps.sql``}
       ORDER BY opened_at ASC, id ASC
       LIMIT ${input.limit + 1}`;
    const more = rows.length > input.limit;
    const slice = more ? rows.slice(0, input.limit) : rows;
    const accounts = [...new Set(slice.map((row) => row.user_id))];
    await writeOperatorAudit(this.deps.sql, {
      kind: 'positions.list',
      operatorId: principal.userId,
      accountId: accounts.length === 1 ? accounts[0]! : null,
      objectId: 'positions',
      approverId: null,
      reason: null,
      detail: { accounts, count: slice.length },
    });
    const last = slice[slice.length - 1];
    return {
      rows: slice.map((row) => ({
        id: row.id,
        userId: row.user_id,
        marketId: row.market_id,
        side: row.side,
        status: row.status,
        size: row.size,
        entryPrice: row.entry_price,
        openedAt: row.opened_at.toISOString(),
      })),
      nextCursor: more && last ? encodeCursor(last.opened_at.toISOString(), last.id) : null,
    };
  }

  async getPosition(principal: Principal, positionId: string): Promise<Record<string, string | null>> {
    requireOperator(principal);
    const [row] = await this.deps.sql<
      Array<{
        id: string;
        user_id: string;
        market_id: string;
        side: string;
        status: string;
        size: string;
        entry_price: string;
        opened_at: Date;
      }>
    >`
      SELECT id, user_id, market_id, side::text, status::text, size::text, entry_price::text, opened_at
        FROM trade.positions WHERE id = ${positionId}`;
    if (!row) throw new TradeOpsError('position_not_found', `position ${positionId} not found`);
    await writeOperatorAudit(this.deps.sql, {
      kind: 'positions.get',
      operatorId: principal.userId,
      accountId: row.user_id,
      objectId: row.id,
      approverId: null,
      reason: null,
    });
    return {
      id: row.id,
      userId: row.user_id,
      marketId: row.market_id,
      side: row.side,
      status: row.status,
      size: row.size,
      entryPrice: row.entry_price,
      openedAt: row.opened_at.toISOString(),
    };
  }

  async futuresSnapshot(
    principal: Principal,
    market: string,
  ): Promise<{
    marketId: string;
    status: string | null;
    leverageCap: { value: string | null; reason: string | null };
    adlEvents: { value: Array<{ eventId: string; at: string; sizeToReduce: string }> | null; reason: string | null };
    insuranceFund: { value: string | null; reason: string | null; asset: string };
    clearingPot: { value: string | null; reason: string | null; asset: string; owed: string; owedCount: number };
  }> {
    requireOperator(principal);
    const [row] = await this.deps.sql<Array<{ status: string; quote_asset: string }>>`
      SELECT status::text, quote_asset FROM trade.markets WHERE id = ${market}`;
    if (!row) throw new TradeOpsError('market_not_found', `market ${market} not found`);
    const cap = parseConfiguredMaxLeverage(process.env.TRADE_FUTURES_MAX_LEVERAGE ?? '');
    let adl: { value: Array<{ eventId: string; at: string; sizeToReduce: string }> | null; reason: string | null };
    try {
      const events = await this.deps.sql<Array<{ event_id: string; at: Date; size_to_reduce: string }>>`
        SELECT event_id, at, size_to_reduce::text FROM trade.adl_action_disclosures ORDER BY at ASC, event_id ASC LIMIT 200`;
      adl = {
        value: events.map((event) => ({
          eventId: event.event_id,
          at: event.at.toISOString(),
          sizeToReduce: event.size_to_reduce,
        })),
        reason: null,
      };
    } catch {
      adl = { value: null, reason: 'adl_events_unconfigured' };
    }
    let insurance: { value: string | null; reason: string | null };
    if (!this.deps.ledger) {
      insurance = { value: null, reason: 'insurance_fund_unconfigured' };
    } else {
      const ref = recipeInsuranceAccount(row.quote_asset);
      const balance = await this.deps.ledger.balance(ref);
      if (!balance.accountId) insurance = { value: null, reason: 'insurance_fund_unconfigured' };
      else insurance = { value: formatAmount(balance.amount), reason: null };
    }
    // The clearing pot and what it owes winners, side by side
    // (docs/adr/2026-10-20-futures-matched-traders.md section 4 item 5).
    let pot: { value: string | null; reason: string | null };
    if (!this.deps.ledger) {
      pot = { value: null, reason: 'clearing_pot_unconfigured' };
    } else {
      const balance = await this.deps.ledger.balance(recipeProfitFundingAccount(row.quote_asset));
      // No account yet means no loss has been booked: the pot is empty, not unconfigured.
      pot = { value: formatAmount(balance.amount), reason: null };
    }
    const owed = (await pendingPayoutTotals(this.deps.sql)).find((t) => t.assetId === row.quote_asset);
    await writeOperatorAudit(this.deps.sql, {
      kind: 'futures.snapshot',
      operatorId: principal.userId,
      accountId: null,
      objectId: market,
      approverId: null,
      reason: null,
    });
    return {
      marketId: market,
      status: row.status,
      leverageCap: cap == null ? { value: null, reason: LEVERAGE_CAP_UNSET } : { value: formatAmount(cap), reason: null },
      adlEvents: adl,
      insuranceFund: { ...insurance, asset: row.quote_asset },
      clearingPot: { ...pot, asset: row.quote_asset, owed: owed?.owed ?? '0', owedCount: owed?.count ?? 0 },
    };
  }

  /** The liquidation desk (D-ops-06): rungs, parked positions, nearest to liquidation, ADL pairs, owed payouts. */
  async futuresLiquidations(principal: Principal, input: { market?: string | null; limit: number }): Promise<LiquidationDesk> {
    requireOperator(principal);
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200) {
      throw new TradeOpsError('liquidations_limit_unset', 'limit is required (1–200); this desk does not invent a page size');
    }
    const market = input.market?.trim() || null;
    const desk = await readLiquidationDesk(this.deps.sql, { market, limit: input.limit });
    await writeOperatorAudit(this.deps.sql, {
      kind: 'futures.liquidations',
      operatorId: principal.userId,
      accountId: null,
      objectId: market ?? 'futures',
      approverId: null,
      reason: null,
    });
    return desk;
  }

  /** Insurance fund balance and the draws this service booked against it (D-ops-06). */
  async futuresInsuranceHistory(principal: Principal, input: { asset: string; limit: number }): Promise<InsuranceHistory> {
    requireOperator(principal);
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200) {
      throw new TradeOpsError('insurance_history_limit_unset', 'limit is required (1–200); this history does not invent a page size');
    }
    const history = await readInsuranceHistory(this.deps.sql, this.deps.ledger, { asset: input.asset, limit: input.limit });
    await writeOperatorAudit(this.deps.sql, {
      kind: 'futures.insurance_history',
      operatorId: principal.userId,
      accountId: null,
      objectId: input.asset,
      approverId: null,
      reason: null,
    });
    return history;
  }

  async createExport(
    principal: Principal,
    input: {
      kind: 'orders' | 'fills' | 'positions';
      filters: { market?: string | null; accountId?: string | null };
      clientRequestId: string;
    },
  ): Promise<{ id: string; kind: string; rowCount: number; downloadRef: string | null; refusal: string | null }> {
    requireOperator(principal);
    const clientRequestId = requireClientRequestId(input.clientRequestId);
    if (input.kind !== 'orders' && input.kind !== 'fills' && input.kind !== 'positions') {
      throw new TradeOpsError('export_kind_unknown', 'export kind must be orders, fills, or positions');
    }
    const fingerprint = payloadHash({ kind: input.kind, filters: input.filters });
    const prior = await loadRequest(this.deps.sql, clientRequestId, 'export', fingerprint);
    if (prior) return prior as { id: string; kind: string; rowCount: number; downloadRef: string | null; refusal: string | null };
    const cap = readExportCap();
    if (cap == null) {
      throw new TradeOpsError('export_cap_unset', 'TRADE_OPERATOR_EXPORT_CAP is unset');
    }
    const built = await this.buildCsv(input.kind, input.filters);
    if (built.rowCount > cap) {
      throw new TradeOpsError('export_over_cap', `export has ${built.rowCount} rows and TRADE_OPERATOR_EXPORT_CAP is ${cap}`);
    }
    const id = randomUUID();
    await this.deps.sql`INSERT INTO trade.operator_export_jobs (
      id, client_request_id, kind, filters, csv, row_count, operator_id
    ) VALUES (
      ${id}, ${clientRequestId}, ${input.kind}, ${this.deps.sql.json(input.filters)}, ${built.csv}, ${built.rowCount}, ${principal.userId}
    )`;
    const key = readExportSigningKey();
    const downloadRef = key ? signExportRef(id, exportExpiry(nowOf(this.deps)), key) : null;
    const result = { id, kind: input.kind, rowCount: built.rowCount, downloadRef, refusal: key ? null : 'export_signing_key_unset' };
    await storeRequest(this.deps.sql, clientRequestId, 'export', fingerprint, result);
    await writeOperatorAudit(this.deps.sql, {
      kind: 'exports.create',
      operatorId: principal.userId,
      accountId: input.filters.accountId ?? null,
      objectId: id,
      approverId: null,
      reason: null,
      detail: { kind: input.kind, rowCount: built.rowCount },
    });
    return result;
  }

  private async loadExportJob(id: string): Promise<{
    id: string;
    kind: string;
    rowCount: number;
    csv: string;
    createdAt: Date;
    operatorId: string;
  }> {
    const [row] = await this.deps.sql<
      Array<{ id: string; kind: string; row_count: number; csv: string; created_at: Date; operator_id: string }>
    >`
      SELECT id, kind, row_count, csv, created_at, operator_id FROM trade.operator_export_jobs WHERE id = ${id}`;
    if (!row) throw new TradeOpsError('export_not_found', `export ${id} not found`);
    return {
      id: row.id,
      kind: row.kind,
      rowCount: row.row_count,
      csv: row.csv,
      createdAt: row.created_at,
      operatorId: row.operator_id,
    };
  }

  async getExport(
    principal: Principal,
    id: string,
  ): Promise<{
    id: string;
    kind: string;
    rowCount: number;
    createdAt: string;
    downloadRef: string | null;
    refusal: string | null;
  }> {
    requireOperator(principal);
    const job = await this.loadExportJob(id);
    const key = readExportSigningKey();
    const downloadRef = key ? signExportRef(job.id, exportExpiry(nowOf(this.deps)), key) : null;
    await writeOperatorAudit(this.deps.sql, {
      kind: 'exports.get',
      operatorId: principal.userId,
      accountId: null,
      objectId: job.id,
      approverId: null,
      reason: null,
      detail: { kind: job.kind, rowCount: job.rowCount, signed: downloadRef != null },
    });
    return {
      id: job.id,
      kind: job.kind,
      rowCount: job.rowCount,
      createdAt: job.createdAt.toISOString(),
      downloadRef,
      refusal: key ? null : 'export_signing_key_unset',
    };
  }

  async downloadExport(principal: Principal, ref: string): Promise<{ id: string; csv: string }> {
    requireOperator(principal);
    const key = readExportSigningKey();
    if (!key) throw new TradeOpsError('export_signing_key_unset', 'TRADE_OPERATOR_EXPORT_SIGNING_KEY is unset');
    const opened = openExportRef(ref, key, nowOf(this.deps).getTime());
    const job = await this.loadExportJob(opened.id);
    await writeOperatorAudit(this.deps.sql, {
      kind: 'exports.download',
      operatorId: principal.userId,
      accountId: null,
      objectId: job.id,
      approverId: null,
      reason: null,
    });
    return { id: job.id, csv: job.csv };
  }

  private async buildCsv(
    kind: 'orders' | 'fills' | 'positions',
    filters: { market?: string | null; accountId?: string | null },
  ): Promise<{ csv: string; rowCount: number; total: string }> {
    const market = filters.market?.trim() || null;
    const accountId = filters.accountId?.trim() || null;
    if (kind === 'orders') {
      const rows = await this.deps.sql<Array<{ id: string; user_id: string; qty: string; reject_code: string | null }>>`
        SELECT id, user_id::text, qty::text, reject_code FROM trade.orders
         WHERE true
           ${market ? this.deps.sql`AND market_id = ${market}` : this.deps.sql``}
           ${accountId ? this.deps.sql`AND user_id = ${accountId}` : this.deps.sql``}
         ORDER BY created_at ASC, id ASC`;
      const lines = [
        csvLine(['id', 'user_id', 'qty', 'reject_code']),
        ...rows.map((row) => csvLine([row.id, row.user_id, row.qty, row.reject_code ?? ''])),
      ];
      return { csv: `${lines.join('\n')}\n`, rowCount: rows.length, total: sumDecimals(rows.map((row) => row.qty)) };
    }
    if (kind === 'fills') {
      const rows = await this.deps.sql<Array<{ id: string; user_id: string; qty: string }>>`
        SELECT id, user_id::text, qty::text FROM trade.fills
         WHERE true
           ${market ? this.deps.sql`AND market_id = ${market}` : this.deps.sql``}
           ${accountId ? this.deps.sql`AND user_id = ${accountId}` : this.deps.sql``}
         ORDER BY ts ASC, id ASC`;
      const lines = [csvLine(['id', 'user_id', 'qty']), ...rows.map((row) => csvLine([row.id, row.user_id, row.qty]))];
      return { csv: `${lines.join('\n')}\n`, rowCount: rows.length, total: sumDecimals(rows.map((row) => row.qty)) };
    }
    const rows = await this.deps.sql<Array<{ id: string; user_id: string; size: string }>>`
      SELECT id, user_id, size::text FROM trade.positions
       WHERE true
         ${market ? this.deps.sql`AND market_id = ${market}` : this.deps.sql``}
         ${accountId ? this.deps.sql`AND user_id = ${accountId}` : this.deps.sql``}
       ORDER BY opened_at ASC, id ASC`;
    const lines = [csvLine(['id', 'user_id', 'size']), ...rows.map((row) => csvLine([row.id, row.user_id, row.size]))];
    return { csv: `${lines.join('\n')}\n`, rowCount: rows.length, total: sumDecimals(rows.map((row) => row.size)) };
  }

  async auditFeed(
    principal: Principal,
    input: {
      cursor?: string | null;
      kind?: string | null;
      accountId?: string | null;
      from?: string | null;
      to?: string | null;
      limit: number;
    },
  ): Promise<{
    rows: Array<{
      id: string;
      kind: string;
      operatorId: string;
      accountId: string | null;
      objectId: string;
      approverId: string | null;
      reason: string | null;
      occurredAt: string;
    }>;
    nextCursor: string | null;
  }> {
    requireOperator(principal);
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200) {
      throw new TradeOpsError('audit_feed_limit_unset', 'limit is required (1–200); this feed does not invent a page size');
    }
    const page = decodeCursor(input.cursor);
    const kind = input.kind?.trim() || null;
    const accountId = input.accountId?.trim() || null;
    const rows = await this.deps.sql<
      Array<{
        id: string;
        kind: string;
        operator_id: string;
        account_id: string | null;
        object_id: string;
        approver_id: string | null;
        reason: string | null;
        occurred_at: Date;
      }>
    >`
      SELECT id, kind, operator_id, account_id, object_id, approver_id, reason, occurred_at
        FROM trade.operator_audit
       WHERE true
         ${kind ? this.deps.sql`AND kind = ${kind}` : this.deps.sql``}
         ${accountId ? this.deps.sql`AND account_id = ${accountId}` : this.deps.sql``}
         ${input.from ? this.deps.sql`AND occurred_at >= ${input.from}` : this.deps.sql``}
         ${input.to ? this.deps.sql`AND occurred_at < ${input.to}` : this.deps.sql``}
         ${page ? this.deps.sql`AND (occurred_at, id) > (${page.at}::timestamptz, ${page.id}::uuid)` : this.deps.sql``}
       ORDER BY occurred_at ASC, id ASC
       LIMIT ${input.limit + 1}`;
    const more = rows.length > input.limit;
    const slice = more ? rows.slice(0, input.limit) : rows;
    const last = slice[slice.length - 1];
    return {
      rows: slice.map((row) => ({
        id: row.id,
        kind: row.kind,
        operatorId: row.operator_id,
        accountId: row.account_id,
        objectId: row.object_id,
        approverId: row.approver_id,
        reason: row.reason,
        occurredAt: row.occurred_at.toISOString(),
      })),
      nextCursor: more && last ? encodeCursor(last.occurred_at.toISOString(), last.id) : null,
    };
  }

  async seedReport(
    principal: Principal,
    input: { market: string; from?: string | null; to?: string | null },
  ): Promise<{ market: string; orders: string; orderQty: string; fills: string; fillQty: string; enabled: boolean }> {
    requireOperator(principal);
    const [orders] = await this.deps.sql<Array<{ n: string; qty: string | null }>>`
      SELECT count(*)::text AS n, COALESCE(sum(qty), 0)::text AS qty FROM trade.orders
       WHERE market_id = ${input.market} AND seeded = true
         ${input.from ? this.deps.sql`AND created_at >= ${input.from}` : this.deps.sql``}
         ${input.to ? this.deps.sql`AND created_at < ${input.to}` : this.deps.sql``}`;
    const [fills] = await this.deps.sql<Array<{ n: string; qty: string | null }>>`
      SELECT count(*)::text AS n, COALESCE(sum(f.qty), 0)::text AS qty
        FROM trade.fills f
        JOIN trade.orders o ON o.id = f.order_id
       WHERE o.market_id = ${input.market} AND o.seeded = true
         ${input.from ? this.deps.sql`AND f.ts >= ${input.from}` : this.deps.sql``}
         ${input.to ? this.deps.sql`AND f.ts < ${input.to}` : this.deps.sql``}`;
    await writeOperatorAudit(this.deps.sql, {
      kind: 'market_maker.report',
      operatorId: principal.userId,
      accountId: null,
      objectId: input.market,
      approverId: null,
      reason: null,
    });
    return {
      market: input.market,
      orders: orders?.n ?? '0',
      orderQty: formatAmount(parseAmount(orders?.qty ?? '0')),
      fills: fills?.n ?? '0',
      fillQty: formatAmount(parseAmount(fills?.qty ?? '0')),
      enabled: await this.seedEnabled(input.market),
    };
  }

  async seedEnabled(market: string): Promise<boolean> {
    const [row] = await this.deps.sql<Array<{ enabled: boolean }>>`
      SELECT enabled FROM trade.operator_mm_seed WHERE market_id = ${market} ORDER BY version DESC LIMIT 1`;
    return row?.enabled === true;
  }

  async setSeed(
    principal: Principal,
    input: { market: string; enabled: boolean; approvalId: string; clientRequestId: string },
  ): Promise<{ market: string; enabled: boolean; version: string }> {
    requireOperatorWrite(principal);
    const clientRequestId = requireClientRequestId(input.clientRequestId);
    const fingerprint = payloadHash({ kind: 'mm_seed', market: input.market, enabled: input.enabled });
    const prior = await loadRequest(this.deps.sql, clientRequestId, 'mm_seed', fingerprint);
    if (prior) return prior as { market: string; enabled: boolean; version: string };
    const [versionRow] = await this.deps.sql<Array<{ version: string }>>`
      SELECT version::text FROM trade.operator_mm_seed WHERE market_id = ${input.market} ORDER BY operator_mm_seed.version DESC LIMIT 1`;
    const version = versionRow?.version ?? '0';
    const body = { actionType: 'trade.mm_seed', market: input.market, enabled: input.enabled, expectedVersion: version };
    const consumed = await consumeApproval(this.deps.approvals, {
      approvalId: input.approvalId,
      actionType: 'trade.mm_seed',
      targetId: input.market,
      expectedVersion: version,
      payloadHash: payloadHash(body),
      operationId: clientRequestId,
    });
    const next = (BigInt(version) + 1n).toString();
    // The on/off switch keeps the market's seeding configuration as the last version had it (J-cex-spot-20 #5): it
    // turns the seed on or off, never blanks the values an operator wrote.
    await this.deps.sql`INSERT INTO trade.operator_mm_seed (
      id, market_id, version, enabled, operator_id, approver_id, approval_id,
      half_spread_bps, step_bps, levels, qty_per_level, mid_source, configured_mid
    )
    SELECT ${randomUUID()}, ${input.market}, ${next}::bigint, ${input.enabled}, ${principal.userId}, ${consumed.approverId}, ${input.approvalId},
           p.half_spread_bps, p.step_bps, p.levels, p.qty_per_level, p.mid_source, p.configured_mid
      FROM (SELECT 1) AS one
      LEFT JOIN LATERAL (
        SELECT half_spread_bps, step_bps, levels, qty_per_level, mid_source, configured_mid
          FROM trade.operator_mm_seed WHERE market_id = ${input.market} ORDER BY version DESC LIMIT 1
      ) AS p ON true`;
    const result = { market: input.market, enabled: input.enabled, version: next };
    await storeRequest(this.deps.sql, clientRequestId, 'mm_seed', fingerprint, result);
    await writeOperatorAudit(this.deps.sql, {
      kind: 'market_maker.set',
      operatorId: principal.userId,
      accountId: null,
      objectId: input.market,
      approverId: consumed.approverId,
      reason: input.enabled ? 'seed on' : 'seed off',
      detail: { version: next, enabled: input.enabled },
    });
    return result;
  }

  async reconcile(principal: Principal, input: { orderId: string; clientRequestId: string }): Promise<ReconcileResult> {
    requireOperatorWrite(principal);
    const clientRequestId = requireClientRequestId(input.clientRequestId);
    const fingerprint = payloadHash({ kind: 'reconcile', orderId: input.orderId });
    const prior = await loadRequest(this.deps.sql, clientRequestId, 'reconcile', fingerprint);
    if (prior) return prior as ReconcileResult;
    const [live] = await this.deps.sql<Array<{ status: string; updated_at: Date; in_flight: boolean; seconds_left: string }>>`
      SELECT status::text AS status,
             updated_at,
             (updated_at > now() - make_interval(secs => ${HOLD_UNKNOWN_IN_FLIGHT_BOUND_SECONDS})) AS in_flight,
             GREATEST(0, CEIL(${HOLD_UNKNOWN_IN_FLIGHT_BOUND_SECONDS}::numeric - EXTRACT(EPOCH FROM (now() - updated_at))))::text AS seconds_left
        FROM trade.orders
       WHERE id = ${input.orderId}`;
    if (live && (live.status === 'pending' || live.status === 'hold_unknown') && live.in_flight) {
      const secondsLeft = live.seconds_left;
      await writeOperatorAudit(this.deps.sql, {
        kind: 'orders.reconcile_refused',
        operatorId: principal.userId,
        accountId: null,
        objectId: input.orderId,
        approverId: null,
        reason: `${secondsLeft}s left`,
        detail: { code: 'reconcile_order_in_flight', status: live.status, secondsLeft },
      });
      throw new TradeOpsError('reconcile_order_in_flight', `order ${input.orderId} hold may still be in flight; ${secondsLeft}s left`);
    }
    const verdict = await this.deps.reconcileOrder(input.orderId);
    await storeRequest(this.deps.sql, clientRequestId, 'reconcile', fingerprint, verdict);
    await writeOperatorAudit(this.deps.sql, {
      kind: 'orders.reconcile',
      operatorId: principal.userId,
      accountId: null,
      objectId: input.orderId,
      approverId: null,
      reason: verdict.detail,
      detail: { case: verdict.case, action: verdict.action },
    });
    return verdict;
  }

  /**
   * One operator reconcile sweep (J-cex-spot-18 #3). Off unless TRADE_OPERATOR_SWEEP_ENABLED is on (refuses
   * `reconcile_sweep_disabled`), and refuses `reconcile_sweep_unconfigured` while the owner's size or age floor is blank.
   *
   * It looks at plain resting limit orders that hold funds, oldest first, up to the owner's size: stop, OCO, bracket and
   * iceberg orders (their funds wait off the book), seeded orders and orders changed within the age floor are not looked
   * at. Each market's book is listed once; a full page is not read (absence cannot be proven from it). An order the book
   * lists is left exactly as it is and loses any earlier sighting. An order the book no longer has is released only on a
   * later sweep's SECOND sighting of that miss, at least the age floor after the first with no listing in between: a fill
   * the engine made reaches
   * trade.fills late (on the bus), so one look at an empty book and an empty trade.fills is not proof it never filled.
   * Even then the release is the single-order reconcile's: once, through the order's own cancel path, and only when
   * trade.fills prove no fill (otherwise the hold is kept).
   *
   * One sweep runs at a time (an advisory lock); a duplicate of a running request refuses `reconcile_sweep_in_flight`,
   * and a finished one returns its stored counts. A request id reused for a different reason refuses
   * `client_request_conflict`. The run, its stored answer and its summary audit row are written in one transaction.
   */
  async startReconcileSweep(principal: Principal, input: { clientRequestId: string; reason: string }): Promise<SweepResult> {
    requireOperatorWrite(principal);
    const clientRequestId = requireClientRequestId(input.clientRequestId);
    if (!this.deps.sweepEnabled) {
      throw new TradeOpsError('reconcile_sweep_disabled', 'TRADE_OPERATOR_SWEEP_ENABLED is off; no sweep runs');
    }
    const limit = this.deps.sweepLimit ?? null;
    const minAge = this.deps.sweepMinAgeSeconds ?? null;
    const readBook = this.deps.engineLiveOrderIds;
    if (limit === null || minAge === null || !readBook) {
      throw new TradeOpsError(
        'reconcile_sweep_unconfigured',
        `${limit === null ? 'TRADE_OPERATOR_SWEEP_LIMIT' : minAge === null ? 'TRADE_OPERATOR_SWEEP_MIN_AGE_SECONDS' : 'the engine book read'} is not set; no sweep runs without it`,
      );
    }
    const fingerprint = payloadHash({ kind: 'reconcile_sweep', reason: input.reason });
    const stored = await loadRequest(this.deps.sql, clientRequestId, 'reconcile_sweep', fingerprint);
    if (stored) return stored as SweepResult;
    const lock = await this.deps.sql.reserve();
    try {
      const [got] = await lock<
        Array<{ ok: boolean }>
      >`SELECT pg_try_advisory_lock(hashtextextended('trade.operator_reconcile_sweep', 0)) AS ok`;
      if (!got?.ok) throw new TradeOpsError('reconcile_sweep_in_flight', 'a reconcile sweep is running; ask again when it ends');
      try {
        // A duplicate that waited out the first run gets the first run's answer.
        const done = await loadRequest(this.deps.sql, clientRequestId, 'reconcile_sweep', fingerprint);
        if (done) return done as SweepResult;
        return await this.runSweep(principal, readBook, { clientRequestId, reason: input.reason, fingerprint, limit, minAge });
      } finally {
        await lock`SELECT pg_advisory_unlock(hashtextextended('trade.operator_reconcile_sweep', 0))`;
      }
    } finally {
      lock.release();
    }
  }

  private async runSweep(
    principal: Principal,
    readBook: (marketId: string) => Promise<ReadonlySet<string>>,
    run: { clientRequestId: string; reason: string; fingerprint: string; limit: number; minAge: number },
  ): Promise<SweepResult> {
    const candidates = await this.deps.sql<Array<{ id: string; market_id: string }>>`
      SELECT o.id, o.market_id::text
        FROM trade.orders o
       WHERE o.status = 'open'
         AND o.type = 'limit'
         AND o.hold_amount > 0
         AND NOT o.seeded
         AND o.updated_at <= now() - make_interval(secs => ${run.minAge})
         AND NOT EXISTS (SELECT 1 FROM trade.order_stop_trigger t WHERE t.order_id = o.id)
         AND NOT EXISTS (SELECT 1 FROM trade.order_oco_intent t WHERE t.order_id = o.id)
         AND NOT EXISTS (SELECT 1 FROM trade.order_bracket_intent t WHERE t.order_id = o.id)
         AND NOT EXISTS (SELECT 1 FROM trade.order_iceberg_display t WHERE t.order_id = o.id)
       ORDER BY o.updated_at ASC, o.id ASC
       LIMIT ${run.limit}`;
    const out: SweepLists = {
      released: [],
      firstSighted: [],
      waiting: [],
      keptUnprovenFills: [],
      terminalizedNoHold: [],
      otherActions: [],
      unreadable: [],
      erroredAfterActing: [],
    };
    const books = new Map<string, ReadonlySet<string> | null>();
    for (const { id: orderId, market_id: marketId } of candidates) {
      if (!books.has(marketId)) {
        try {
          books.set(marketId, await readBook(marketId));
        } catch (error) {
          sweepLog('book_unreadable', { marketId, sweep: run.clientRequestId, error });
          books.set(marketId, null);
        }
      }
      const live = books.get(marketId);
      if (live === null || live === undefined) {
        out.unreadable.push(orderId);
        continue;
      }
      if (live.has(orderId)) {
        // Listed again: whatever miss was seen before was not continuous. The next miss starts its wait from zero.
        await this.deps.sql`DELETE FROM trade.operator_sweep_sightings WHERE order_id = ${orderId}`;
        continue;
      }
      // Missing from the book. Released only on a later sighting, a floor after the first, with no listing in between.
      const [sighting] = await this.deps.sql<Array<{ due: boolean; mine: boolean }>>`
        INSERT INTO trade.operator_sweep_sightings (order_id, first_seen_at, sweep_request_id)
        VALUES (${orderId}, now(), ${run.clientRequestId})
        ON CONFLICT (order_id) DO UPDATE SET order_id = EXCLUDED.order_id
        RETURNING (first_seen_at <= now() - make_interval(secs => ${run.minAge})) AS due,
                  (sweep_request_id = ${run.clientRequestId}) AS mine`;
      if (!sighting) {
        out.unreadable.push(orderId);
        continue;
      }
      if (!sighting.due) {
        (sighting.mine ? out.firstSighted : out.waiting).push(orderId);
        continue;
      }
      let verdict: ReconcileResult;
      try {
        verdict = await this.deps.reconcileOrder(orderId, { leaveLive: true });
      } catch (error) {
        // Whether it acted is read from the row, not assumed: a thrown reconcile may have finalized first.
        const [row] = await this.deps.sql<Array<{ status: string }>>`SELECT status::text FROM trade.orders WHERE id = ${orderId}`;
        const acted = row?.status !== 'open';
        sweepLog(acted ? 'errored_after_acting' : 'not_read', { orderId, status: row?.status ?? null, sweep: run.clientRequestId, error });
        (acted ? out.erroredAfterActing : out.unreadable).push(orderId);
        continue;
      }
      if (verdict.case === 'open_engine_live_left') {
        // The reconcile's own list found it live: not a continuous miss either.
        await this.deps.sql`DELETE FROM trade.operator_sweep_sightings WHERE order_id = ${orderId}`;
      }
      if (verdict.action === 'released') out.released.push(orderId);
      else if (verdict.case === 'open_hold_no_engine_unknown') out.keptUnprovenFills.push(orderId);
      else if (verdict.case === 'open_engine_no_hold') out.terminalizedNoHold.push(orderId);
      else if (verdict.action !== 'none') out.otherActions.push(orderId);
      if (verdict.action !== 'none') {
        await writeOperatorAudit(this.deps.sql, {
          kind: 'orders.reconcile',
          operatorId: principal.userId,
          accountId: null,
          objectId: orderId,
          approverId: null,
          reason: verdict.detail,
          detail: { case: verdict.case, action: verdict.action, sweep: run.clientRequestId },
        });
      }
    }
    const at = nowOf(this.deps);
    const result: SweepResult = {
      checked: candidates.length,
      released: out.released.length,
      releasedOrderIds: out.released,
      firstSightedOrderIds: out.firstSighted,
      waitingOrderIds: out.waiting,
      failedClosedOrderIds: out.keptUnprovenFills,
      terminalizedNoHoldOrderIds: out.terminalizedNoHold,
      otherActionOrderIds: out.otherActions,
      unreadableOrderIds: out.unreadable,
      erroredAfterActingOrderIds: out.erroredAfterActing,
      limit: run.limit,
      minAgeSeconds: run.minAge,
      ranAt: at.toISOString(),
    };
    await this.deps.sql.begin(async (tx) => {
      const q = tx as unknown as Sql;
      await q`INSERT INTO trade.operator_reconcile_sweeps (id, client_request_id, occurred_at, result)
        VALUES (${randomUUID()}, ${run.clientRequestId}, ${at.toISOString()}, ${q.json(result as never)})`;
      await storeRequest(q, run.clientRequestId, 'reconcile_sweep', run.fingerprint, result);
      await writeOperatorAudit(q, {
        kind: 'orders.reconcile_sweep',
        operatorId: principal.userId,
        accountId: null,
        objectId: run.clientRequestId,
        approverId: null,
        reason: run.reason,
        detail: {
          checked: result.checked,
          released: result.released,
          firstSighted: out.firstSighted.length,
          kept: out.keptUnprovenFills.length,
          terminalizedNoHold: out.terminalizedNoHold.length,
          unreadable: out.unreadable.length,
          erroredAfterActing: out.erroredAfterActing.length,
        },
      });
    });
    return result;
  }

  /**
   * A trade bust (J-cex-spot-18 #4): two operators, then the reversal. The proposal is identity's action approval for
   * `trade.bust` on this order, bound to its fill count and the reason (`bustPayloadHash`). The approval book can only
   * consume (there is no read that validates without spending it), so the approval is consumed; the operator who carries
   * it out must not be the one who approved it (`approval_executor_is_approver`). Then the bust needs a ledger-client
   * reversal recipe for a fill, and none exists: it refuses `trade_bust_recipe_missing` and moves nothing. Either refusal
   * is audited once per request with the proposer, the approver and the executor.
   */
  async bust(
    principal: Principal,
    input: { orderId: string; approvalId: string; clientRequestId: string; reason: string },
  ): Promise<never> {
    requireOperatorWrite(principal);
    const clientRequestId = requireClientRequestId(input.clientRequestId);
    const [order] = await this.deps.sql<Array<{ user_id: string; fills: string }>>`
      SELECT o.user_id::text, (SELECT count(*) FROM trade.fills f WHERE f.order_id = o.id)::text AS fills
        FROM trade.orders o WHERE o.id = ${input.orderId}`;
    if (!order) throw new TradeOpsError('order_not_found', `order ${input.orderId} not found`);
    if (order.fills === '0') throw new TradeOpsError('trade_bust_no_fill', `order ${input.orderId} has no fill to bust`);
    const body = bustApprovalBody({ orderId: input.orderId, expectedVersion: order.fills, reason: input.reason });
    const consumed = await consumeApproval(this.deps.approvals, {
      approvalId: input.approvalId,
      actionType: BUST_ACTION_TYPE,
      targetId: input.orderId,
      expectedVersion: order.fills,
      payloadHash: payloadHash(body),
      operationId: clientRequestId,
    });
    const selfApproved = consumed.approverId.trim().toLowerCase() === principal.userId.trim().toLowerCase();
    const code = selfApproved ? 'approval_executor_is_approver' : TRADE_BUST_RECIPE_MISSING;
    await writeOperatorAudit(this.deps.sql, {
      id: bustAuditId(clientRequestId),
      kind: 'orders.bust_refused',
      operatorId: principal.userId,
      accountId: order.user_id,
      objectId: input.orderId,
      approverId: consumed.approverId,
      reason: input.reason,
      detail: { code, fills: order.fills, approvalId: input.approvalId, requesterId: consumed.requesterId },
    });
    if (selfApproved) {
      throw new TradeOpsError('approval_executor_is_approver', 'the operator who approved this bust cannot also carry it out');
    }
    throw new TradeOpsError(
      TRADE_BUST_RECIPE_MISSING,
      'no ledger-client recipe reverses a fill yet, so the approved bust moved nothing; the fill and both balances stand',
    );
  }

  async reconcileStatus(principal: Principal): Promise<{ lastSweepAt: string | null; result: unknown | null }> {
    requireOperator(principal);
    const [row] = await this.deps.sql<Array<{ occurred_at: Date; result: unknown }>>`
      SELECT occurred_at, result FROM trade.operator_reconcile_sweeps ORDER BY occurred_at DESC LIMIT 1`;
    if (!row) return { lastSweepAt: null, result: null };
    return { lastSweepAt: row.occurred_at.toISOString(), result: row.result };
  }

  async statusHistory(principal: Principal, input: { market: string; cursor?: string | null; limit: number }) {
    requireOperator(principal);
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200) {
      throw new TradeOpsError('status_history_limit_unset', 'limit is required (1–200); this history does not invent a page size');
    }
    const page = await readMarketStatusHistory(this.deps.sql, input.market, input.cursor ?? null, input.limit);
    await writeOperatorAudit(this.deps.sql, {
      kind: 'markets.status_history',
      operatorId: principal.userId,
      accountId: null,
      objectId: input.market,
      approverId: null,
      reason: null,
    });
    return page;
  }
}

/** Seed jobs consult this. No row, or the latest row off, means the switch is off. */
export async function operatorSeedAllows(sql: Sql, marketId: string): Promise<boolean> {
  const [row] = await sql<Array<{ enabled: boolean }>>`
    SELECT enabled FROM trade.operator_mm_seed WHERE market_id = ${marketId} ORDER BY version DESC LIMIT 1`;
  return row?.enabled === true;
}
