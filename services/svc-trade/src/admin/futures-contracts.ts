/**
 * Operator writes for futures contract families, expiry tenors and pre-market (D-instruments-03).
 *
 *   admin.futuresListing.create    lists a dated futures market through the existing listing path
 *   admin.futuresSchedule.get/set  the owner's expiry-tenor table (versioned, nothing auto-lists from it)
 *   admin.futuresPremarket.get/set the owner's flat funding rate and mark clamp band per market
 *   admin.futuresPremarket.convert moves a prelaunch futures market to active
 *
 * Every write is four-eyes: `approvalId` names a second operator's approval, bound to the action, the target
 * and the exact payload, and consumed once. Every write records an operator audit row and is idempotent on
 * `clientRequestId`. No ledger posting happens here, and no ledger write recipe is imported.
 */
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import type { Principal } from '@intafaced/auth';
import { formatAmount, parseAmount, type Amount, type AccountRef } from '@intafaced/ledger-client';
import { assertDatedFuturesTradable, datedFuturesStyleOf } from '../futures/dated-futures.js';
import { checkInsuranceFundedForListing } from '../futures/insurance-listing-gate.js';
import { isPremarket, readPremarketParams, requirePremarketParams, type PremarketParams } from '../futures/premarket.js';
import { assertProductionUnsettledAssetClassListing } from '../spot/forex-settlement.js';
import { TradeError, type Market } from '../spot/types.js';
import type { ListMarketInput } from '../spot/trade-service.js';
import {
  consumeApproval,
  loadRequest,
  payloadHash,
  requireClientRequestId,
  requireOperator,
  requireOperatorWrite,
  requireReason,
  storeRequest,
  TradeOpsError,
  writeOperatorAudit,
} from './common.js';
import { recordMarketStatusTransition } from './status-history.js';

export interface FuturesContractsDeps {
  readonly sql: Sql;
  readonly approvals: Parameters<typeof consumeApproval>[0];
  readonly ledger: { balance(ref: AccountRef): Promise<{ accountId: string; amount: bigint }> } | null;
  /** The existing `TradeService.listMarket`. Absent: the create door answers `futures_listing_unconfigured`. */
  readonly listMarket?: (input: ListMarketInput) => Promise<Market>;
  readonly now: () => Date;
}

export const NO_SCHEDULE_PUBLISHED = 'no_schedule_published' as const;
export const TENOR_LABELS = ['weekly', 'monthly', 'quarterly'] as const;
export type TenorLabel = (typeof TENOR_LABELS)[number];

export interface TenorRow {
  readonly tenor: TenorLabel;
  readonly enabled: boolean;
}

export type FuturesSchedule =
  | { readonly version: null; readonly tenors: readonly []; readonly reason: typeof NO_SCHEDULE_PUBLISHED }
  | {
      readonly version: string;
      readonly tenors: readonly TenorRow[];
      readonly reason: null;
      readonly publishedAt: string;
      readonly operatorId: string;
      readonly approverId: string;
    };

export interface FuturesMarketView {
  readonly id: string;
  readonly symbol: string;
  readonly base: string;
  readonly quote: string;
  readonly status: Market['status'];
  readonly futuresContractStyle: 'perpetual' | 'dated' | null;
  readonly futuresExpiryAt: string | null;
  readonly family: 'linear' | 'inverse' | null;
  readonly settleAsset: string | null;
  readonly premarket: boolean;
}

export interface FuturesListingResult {
  /** False when the symbol was already listed: the first listing is returned and nothing was changed. */
  readonly created: boolean;
  readonly market: FuturesMarketView;
}

export interface PremarketParamsView {
  readonly market: string;
  readonly version: string | null;
  readonly flatFundingRate: string | null;
  readonly markClampBps: number | null;
  readonly reason: 'trade.premarket_params_unset' | null;
}

export interface PremarketConvertResult {
  readonly market: FuturesMarketView;
  readonly fromStatus: 'pending';
  readonly toStatus: 'active';
  readonly paramsVersion: string;
}

interface MarketLockRow {
  id: string;
  symbol: string;
  base_asset: string;
  quote_asset: string;
  kind: Market['kind'];
  status: Market['status'];
  asset_class: Market['assetClass'];
  paper: boolean;
  futures_contract_style: 'perpetual' | 'dated' | null;
  futures_expiry_at: Date | null;
  futures_settlement_fixing: string | null;
  futures_family: 'linear' | 'inverse' | null;
  futures_settle_asset: string | null;
}

function viewOf(row: MarketLockRow): FuturesMarketView {
  const futures = row.kind === 'futures';
  return {
    id: row.id,
    symbol: row.symbol,
    base: row.base_asset,
    quote: row.quote_asset,
    status: row.status,
    futuresContractStyle: futures ? (row.futures_contract_style === 'dated' ? 'dated' : 'perpetual') : null,
    futuresExpiryAt: row.futures_expiry_at?.toISOString() ?? null,
    family: futures ? row.futures_family : null,
    settleAsset: futures ? row.futures_settle_asset : null,
    premarket: isPremarket(row),
  };
}

const MARKET_COLUMNS = `id, symbol, base_asset, quote_asset, kind, status, asset_class, paper,
  futures_contract_style, futures_expiry_at, futures_settlement_fixing, futures_family, futures_settle_asset`;

async function loadMarketRow(sql: Sql, by: { id: string } | { symbol: string }, lock = false): Promise<MarketLockRow | null> {
  const where = 'id' in by ? sql`id = ${by.id}` : sql`symbol = ${by.symbol}`;
  const rows = await sql<MarketLockRow[]>`
    SELECT ${sql.unsafe(MARKET_COLUMNS)} FROM trade.markets WHERE ${where} ${lock ? sql`FOR UPDATE` : sql``}`;
  return rows[0] ?? null;
}

function requireApprovalId(value: string | undefined): string {
  const trimmed = (value ?? '').trim();
  if (trimmed.length < 1 || trimmed.length > 128) {
    throw new TradeOpsError('approval_required', 'approvalId is required: this write needs a second operator (1-128 chars)');
  }
  return trimmed;
}

/** A refusal from the listing or trade path keeps its typed code on the operator wire. */
function carryTradeError(error: unknown): never {
  if (error instanceof TradeError) throw new TradeOpsError(error.code, error.message);
  throw error;
}

function parseListingAmount(value: string, label: string): Amount {
  try {
    const parsed = parseAmount(value);
    if (parsed < 0n) throw new Error('negative');
    return parsed;
  } catch {
    throw new TradeOpsError('listing_terms_invalid', `${label} must be an exact unsigned decimal string`);
  }
}

function parseBps(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new TradeOpsError('listing_terms_invalid', `${label} must be a non-negative integer`);
  }
  return value;
}

export interface FuturesListingCreateInput {
  readonly symbol: string;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly tickSize: string;
  readonly lotSize: string;
  readonly minQty: string;
  readonly maxQty: string | null;
  readonly minNotional: string;
  readonly makerBps: number;
  readonly takerBps: number;
  /** ISO instant of last trade / expiry. */
  readonly expiryAt: string;
  /** `pending` lists it as pre-market. Omitted means `active`, as `listMarket` does. */
  readonly status?: 'pending' | 'active';
  readonly family?: 'linear' | 'inverse' | null;
  readonly settleAsset?: string | null;
  readonly displayName?: string | null;
  readonly reason: string;
  readonly approvalId: string;
  readonly clientRequestId: string;
}

export class FuturesContractsAdmin {
  constructor(private readonly deps: FuturesContractsDeps) {}

  // ── Listing ────────────────────────────────────────────────────────────────

  async listingCreate(principal: Principal, input: FuturesListingCreateInput): Promise<FuturesListingResult> {
    requireOperatorWrite(principal);
    const approvalId = requireApprovalId(input.approvalId);
    const clientRequestId = requireClientRequestId(input.clientRequestId);
    const reason = requireReason(input.reason);
    const symbol = input.symbol.trim();
    const baseAsset = input.baseAsset.trim();
    const quoteAsset = input.quoteAsset.trim();
    if (!symbol || !baseAsset || !quoteAsset) {
      throw new TradeOpsError('listing_terms_invalid', 'symbol, baseAsset and quoteAsset are required');
    }
    const expiry = new Date(input.expiryAt);
    if (Number.isNaN(expiry.getTime())) throw new TradeOpsError('listing_terms_invalid', 'expiryAt must be an ISO instant');
    if (expiry.getTime() <= this.deps.now().getTime()) {
      throw new TradeOpsError('futures_expiry_in_past', 'expiryAt has already passed; a dated market is listed before it expires');
    }
    const status = input.status ?? 'active';
    if (status !== 'pending' && status !== 'active') {
      throw new TradeOpsError('listing_terms_invalid', 'status must be pending (pre-market) or active');
    }
    const terms = {
      symbol,
      baseAsset,
      quoteAsset,
      tickSize: formatAmount(parseListingAmount(input.tickSize, 'tickSize')),
      lotSize: formatAmount(parseListingAmount(input.lotSize, 'lotSize')),
      minQty: formatAmount(parseListingAmount(input.minQty, 'minQty')),
      maxQty: input.maxQty == null ? null : formatAmount(parseListingAmount(input.maxQty, 'maxQty')),
      minNotional: formatAmount(parseListingAmount(input.minNotional, 'minNotional')),
      makerBps: parseBps(input.makerBps, 'makerBps'),
      takerBps: parseBps(input.takerBps, 'takerBps'),
      expiryAt: expiry.toISOString(),
      status,
      family: input.family ?? null,
      settleAsset: input.settleAsset?.trim() || null,
      displayName: input.displayName?.trim() || null,
    };
    const fingerprint = payloadHash({ kind: 'futures_listing_create', ...terms });
    const prior = await loadRequest(this.deps.sql, clientRequestId, 'futures_listing_create', fingerprint);
    if (prior) return prior as FuturesListingResult;

    // Idempotent on the market: a symbol that is already listed as a dated future is returned as it stands.
    // Nothing is written to it, so no open position can be touched.
    const existing = await loadMarketRow(this.deps.sql, { symbol });
    if (existing) {
      if (existing.kind !== 'futures' || existing.futures_contract_style !== 'dated') {
        throw new TradeOpsError(
          'futures_listing_symbol_conflict',
          `${symbol} is already listed as something other than a dated futures market`,
        );
      }
      const result: FuturesListingResult = { created: false, market: viewOf(existing) };
      await storeRequest(this.deps.sql, clientRequestId, 'futures_listing_create', fingerprint, result);
      return result;
    }

    const listMarket = this.deps.listMarket;
    if (!listMarket) throw new TradeOpsError('futures_listing_unconfigured', 'the listing path is not wired on this desk');
    const consumed = await consumeApproval(this.deps.approvals, {
      approvalId,
      actionType: 'trade.futures_listing_create',
      targetId: symbol,
      expectedVersion: '0',
      payloadHash: payloadHash({ actionType: 'trade.futures_listing_create', ...terms, reason }),
      operationId: clientRequestId,
    });
    let listed: Market;
    try {
      listed = await listMarket({
        symbol,
        baseAsset,
        quoteAsset,
        tickSize: parseAmount(terms.tickSize),
        lotSize: parseAmount(terms.lotSize),
        minQty: parseAmount(terms.minQty),
        maxQty: terms.maxQty === null ? null : parseAmount(terms.maxQty),
        minNotional: parseAmount(terms.minNotional),
        makerBps: terms.makerBps,
        takerBps: terms.takerBps,
        status,
        kind: 'futures',
        futuresContractStyle: 'dated',
        futuresExpiryAt: expiry,
        futuresFamily: terms.family,
        futuresSettleAsset: terms.settleAsset,
        ...(terms.displayName ? { displayName: terms.displayName } : {}),
      });
    } catch (error) {
      carryTradeError(error);
    }
    const row = await loadMarketRow(this.deps.sql, { id: listed.id });
    if (!row) throw new TradeOpsError('market_not_found', 'listed market was not readable after write');
    const result: FuturesListingResult = { created: true, market: viewOf(row) };
    await storeRequest(this.deps.sql, clientRequestId, 'futures_listing_create', fingerprint, result);
    await writeOperatorAudit(
      this.deps.sql,
      {
        kind: 'futures_listing.create',
        operatorId: principal.userId,
        accountId: null,
        objectId: row.id,
        approverId: consumed.approverId,
        reason,
        detail: {
          symbol,
          status,
          expiryAt: terms.expiryAt,
          family: row.futures_family,
          settleAsset: row.futures_settle_asset,
        },
      },
      this.deps.now(),
    );
    return result;
  }

  // ── Expiry-tenor table ─────────────────────────────────────────────────────

  async scheduleGet(principal: Principal): Promise<FuturesSchedule> {
    requireOperator(principal);
    return readSchedule(this.deps.sql);
  }

  async scheduleSet(
    principal: Principal,
    input: {
      readonly tenors: ReadonlyArray<{ readonly tenor: TenorLabel; readonly enabled: boolean }>;
      readonly expectedVersion: string;
      readonly reason: string;
      readonly approvalId: string;
      readonly clientRequestId: string;
    },
  ): Promise<FuturesSchedule> {
    requireOperatorWrite(principal);
    const approvalId = requireApprovalId(input.approvalId);
    const clientRequestId = requireClientRequestId(input.clientRequestId);
    const reason = requireReason(input.reason);
    const tenors = validateTenors(input.tenors);
    const fingerprint = payloadHash({ kind: 'futures_schedule_set', tenors, expectedVersion: input.expectedVersion });
    const prior = await loadRequest(this.deps.sql, clientRequestId, 'futures_schedule_set', fingerprint);
    if (prior) return prior as FuturesSchedule;
    const current = await readSchedule(this.deps.sql);
    const version = current.version ?? '0';
    if (version !== input.expectedVersion) {
      throw new TradeOpsError('futures_schedule_stale', `expectedVersion ${input.expectedVersion} is stale; current is ${version}`);
    }
    const consumed = await consumeApproval(this.deps.approvals, {
      approvalId,
      actionType: 'trade.futures_schedule_set',
      targetId: 'futures_expiry_schedule',
      expectedVersion: version,
      payloadHash: payloadHash({ actionType: 'trade.futures_schedule_set', tenors, expectedVersion: version, reason }),
      operationId: clientRequestId,
    });
    const next = (BigInt(version) + 1n).toString();
    const at = this.deps.now();
    try {
      await this.deps.sql.begin(async (tx) => {
        await tx`INSERT INTO trade.futures_expiry_schedule (
          version, tenors, operator_id, approver_id, approval_id, reason, created_at
        ) VALUES (
          ${next}::bigint, ${tx.json(tenors as never)}, ${principal.userId}, ${consumed.approverId}, ${approvalId}, ${reason}, ${at.toISOString()}
        )`;
        const written = await readSchedule(tx as unknown as Sql);
        await storeRequest(tx as unknown as Sql, clientRequestId, 'futures_schedule_set', fingerprint, written);
        await writeOperatorAudit(
          tx as unknown as Sql,
          {
            kind: 'futures_schedule.set',
            operatorId: principal.userId,
            accountId: null,
            objectId: 'futures_expiry_schedule',
            approverId: consumed.approverId,
            reason,
            detail: { version: next, tenors },
          },
          at,
        );
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new TradeOpsError('futures_schedule_stale', 'another operator published a newer schedule first');
      }
      throw error;
    }
    return readSchedule(this.deps.sql);
  }

  // ── Pre-market ─────────────────────────────────────────────────────────────

  async premarketGet(principal: Principal, marketId: string): Promise<PremarketParamsView> {
    requireOperator(principal);
    const market = await loadMarketRow(this.deps.sql, { id: marketId });
    if (!market) throw new TradeOpsError('market_not_found', `market ${marketId} not found`);
    return premarketView(marketId, await readPremarketParams(this.deps.sql, marketId));
  }

  async premarketSet(
    principal: Principal,
    input: {
      readonly market: string;
      /** Signed exact decimal per funding period. Null leaves it blank. */
      readonly flatFundingRate: string | null;
      /** Positive whole basis points. Null leaves it blank. */
      readonly markClampBps: number | null;
      readonly expectedVersion: string;
      readonly reason: string;
      readonly approvalId: string;
      readonly clientRequestId: string;
    },
  ): Promise<PremarketParamsView> {
    requireOperatorWrite(principal);
    const approvalId = requireApprovalId(input.approvalId);
    const clientRequestId = requireClientRequestId(input.clientRequestId);
    const reason = requireReason(input.reason);
    const rate = validateFlatFundingRate(input.flatFundingRate);
    const clamp = validateMarkClampBps(input.markClampBps);
    const fingerprint = payloadHash({
      kind: 'premarket_params_set',
      market: input.market,
      flatFundingRate: rate,
      markClampBps: clamp,
      expectedVersion: input.expectedVersion,
    });
    const prior = await loadRequest(this.deps.sql, clientRequestId, 'premarket_params_set', fingerprint);
    if (prior) return prior as PremarketParamsView;
    const market = await requirePremarketMarket(this.deps.sql, input.market);
    const current = await readPremarketParams(this.deps.sql, input.market);
    const version = current?.version ?? '0';
    if (version !== input.expectedVersion) {
      throw new TradeOpsError('premarket_params_stale', `expectedVersion ${input.expectedVersion} is stale; current is ${version}`);
    }
    const consumed = await consumeApproval(this.deps.approvals, {
      approvalId,
      actionType: 'trade.premarket_params_set',
      targetId: input.market,
      expectedVersion: version,
      payloadHash: payloadHash({
        actionType: 'trade.premarket_params_set',
        market: input.market,
        flatFundingRate: rate,
        markClampBps: clamp,
        expectedVersion: version,
        reason,
      }),
      operationId: clientRequestId,
    });
    const next = (BigInt(version) + 1n).toString();
    const at = this.deps.now();
    try {
      await this.deps.sql.begin(async (tx) => {
        await tx`INSERT INTO trade.operator_premarket_params (
          id, market_id, version, flat_funding_rate, mark_clamp_bps, operator_id, approver_id, approval_id, reason, created_at
        ) VALUES (
          ${randomUUID()}, ${input.market}, ${next}::bigint, ${rate}::numeric, ${clamp},
          ${principal.userId}, ${consumed.approverId}, ${approvalId}, ${reason}, ${at.toISOString()}
        )`;
        const written = premarketView(input.market, await readPremarketParams(tx as unknown as Sql, input.market));
        await storeRequest(tx as unknown as Sql, clientRequestId, 'premarket_params_set', fingerprint, written);
        await writeOperatorAudit(
          tx as unknown as Sql,
          {
            kind: 'futures_premarket.set',
            operatorId: principal.userId,
            accountId: null,
            objectId: input.market,
            approverId: consumed.approverId,
            reason,
            detail: { symbol: market.symbol, version: next, flatFundingRate: rate, markClampBps: clamp },
          },
          at,
        );
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new TradeOpsError('premarket_params_stale', 'another operator set newer params first');
      }
      throw error;
    }
    return premarketView(input.market, await readPremarketParams(this.deps.sql, input.market));
  }

  /**
   * Prelaunch -> active, one transaction on the market row. Blank owner params refuse
   * `trade.premarket_params_unset` before the approval is spent, and the row is left as it was. A crash
   * anywhere inside the transaction rolls back to `pending`.
   */
  async premarketConvert(
    principal: Principal,
    input: { readonly market: string; readonly reason: string; readonly approvalId: string; readonly clientRequestId: string },
  ): Promise<PremarketConvertResult> {
    requireOperatorWrite(principal);
    const approvalId = requireApprovalId(input.approvalId);
    const clientRequestId = requireClientRequestId(input.clientRequestId);
    const reason = requireReason(input.reason);
    const fingerprint = payloadHash({ kind: 'premarket_convert', market: input.market });
    const prior = await loadRequest(this.deps.sql, clientRequestId, 'premarket_convert', fingerprint);
    if (prior) return prior as PremarketConvertResult;

    const market = await requirePremarketMarket(this.deps.sql, input.market);
    const params = await this.requireParams(input.market, market.symbol);
    await this.assertMayGoActive(market);

    const consumed = await consumeApproval(this.deps.approvals, {
      approvalId,
      actionType: 'trade.premarket_convert',
      targetId: input.market,
      expectedVersion: params.version,
      payloadHash: payloadHash({
        actionType: 'trade.premarket_convert',
        market: input.market,
        paramsVersion: params.version,
        flatFundingRate: params.flatFundingRate,
        markClampBps: params.markClampBps,
        reason,
      }),
      operationId: clientRequestId,
    });

    const at = this.deps.now();
    const result = await this.deps.sql.begin(async (tx) => {
      const sql = tx as unknown as Sql;
      const locked = await loadMarketRow(sql, { id: input.market }, true);
      if (!locked || !isPremarket(locked)) {
        throw new TradeOpsError('premarket_not_pending', `market ${input.market} is no longer a prelaunch futures market`);
      }
      const latest = await readPremarketParams(sql, input.market);
      let approved: ReturnType<typeof requirePremarketParams>;
      try {
        approved = requirePremarketParams(latest, locked.symbol);
      } catch (error) {
        return carryTradeError(error);
      }
      if (approved.version !== params.version) {
        throw new TradeOpsError('premarket_params_changed', 'pre-market params changed after this conversion was approved');
      }
      const updated = await sql`
        UPDATE trade.markets SET status = 'active', updated_at = now()
         WHERE id = ${input.market} AND status = 'pending'`;
      if (updated.count !== 1) throw new TradeOpsError('premarket_not_pending', `market ${input.market} is no longer pending`);
      await recordMarketStatusTransition(sql, {
        marketId: input.market,
        fromStatus: 'pending',
        toStatus: 'active',
        operatorId: principal.userId,
        approverId: consumed.approverId,
        reason,
      });
      const after = await loadMarketRow(sql, { id: input.market });
      if (!after) throw new TradeOpsError('market_not_found', 'market was not readable after conversion');
      const converted: PremarketConvertResult = {
        market: viewOf(after),
        fromStatus: 'pending',
        toStatus: 'active',
        paramsVersion: approved.version,
      };
      await storeRequest(sql, clientRequestId, 'premarket_convert', fingerprint, converted);
      await writeOperatorAudit(
        sql,
        {
          kind: 'futures_premarket.convert',
          operatorId: principal.userId,
          accountId: null,
          objectId: input.market,
          approverId: consumed.approverId,
          reason,
          detail: {
            symbol: locked.symbol,
            paramsVersion: approved.version,
            flatFundingRate: approved.flatFundingRate,
            markClampBps: approved.markClampBps,
          },
        },
        at,
      );
      return converted;
    });
    return result;
  }

  private async requireParams(marketId: string, symbol: string) {
    try {
      return requirePremarketParams(await readPremarketParams(this.deps.sql, marketId), symbol);
    } catch (error) {
      return carryTradeError(error);
    }
  }

  /** The same gates `setMarketStatus` applies before a market goes active. */
  private async assertMayGoActive(market: MarketLockRow): Promise<void> {
    try {
      assertProductionUnsettledAssetClassListing({ assetClass: market.asset_class, status: 'active', paper: market.paper });
      if (datedFuturesStyleOf({ kind: market.kind, futuresContractStyle: market.futures_contract_style }) === 'dated') {
        assertDatedFuturesTradable(
          {
            kind: market.kind,
            symbol: market.symbol,
            futuresContractStyle: market.futures_contract_style,
            futuresExpiryAt: market.futures_expiry_at,
            futuresSettlementFixing: market.futures_settlement_fixing,
          },
          { now: this.deps.now() },
        );
      }
      if (!market.paper) {
        const ledger = this.deps.ledger;
        if (!ledger) throw new TradeOpsError('ledger_unconfigured', 'the insurance fund cannot be read: no ledger is wired on this desk');
        const gate = await checkInsuranceFundedForListing({
          kind: market.kind,
          status: 'active',
          paper: market.paper,
          quoteAsset: market.quote_asset,
          balance: async (ref) => ({ account: ref, ...(await ledger.balance(ref)) }),
        });
        if (!gate.ok) throw new TradeError(gate.reason, gate.code);
      }
    } catch (error) {
      carryTradeError(error);
    }
  }
}

async function requirePremarketMarket(sql: Sql, marketId: string): Promise<MarketLockRow> {
  const market = await loadMarketRow(sql, { id: marketId });
  if (!market) throw new TradeOpsError('market_not_found', `market ${marketId} not found`);
  if (!isPremarket(market)) {
    throw new TradeOpsError('premarket_not_pending', `${market.symbol} is not a prelaunch futures market`);
  }
  return market;
}

function premarketView(market: string, params: PremarketParams | null): PremarketParamsView {
  const blank = params === null || params.flatFundingRate === null || params.markClampBps === null;
  return {
    market,
    version: params?.version ?? null,
    flatFundingRate: params?.flatFundingRate ?? null,
    markClampBps: params?.markClampBps ?? null,
    reason: blank ? 'trade.premarket_params_unset' : null,
  };
}

const SIGNED_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d{1,18})?$/;

function validateFlatFundingRate(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!SIGNED_DECIMAL.test(trimmed)) {
    throw new TradeOpsError('premarket_param_invalid', 'flatFundingRate must be an exact signed decimal string');
  }
  try {
    return formatAmount(parseAmount(trimmed));
  } catch {
    throw new TradeOpsError('premarket_param_invalid', 'flatFundingRate does not fit the ledger decimal range');
  }
}

function validateMarkClampBps(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new TradeOpsError('premarket_param_invalid', 'markClampBps must be a positive whole number of basis points');
  }
  return value;
}

function validateTenors(input: ReadonlyArray<{ tenor: string; enabled: boolean }>): TenorRow[] {
  if (!Array.isArray(input) || input.length < 1) {
    throw new TradeOpsError('futures_schedule_invalid', 'a schedule needs at least one tenor row');
  }
  const seen = new Set<string>();
  const rows: TenorRow[] = [];
  for (const row of input) {
    if (!(TENOR_LABELS as readonly string[]).includes(row.tenor) || typeof row.enabled !== 'boolean') {
      throw new TradeOpsError('futures_schedule_invalid', 'each tenor row is {tenor: weekly|monthly|quarterly, enabled: boolean}');
    }
    if (seen.has(row.tenor)) throw new TradeOpsError('futures_schedule_invalid', `tenor ${row.tenor} appears twice`);
    seen.add(row.tenor);
    rows.push({ tenor: row.tenor as TenorLabel, enabled: row.enabled });
  }
  // Canonical order, so the same table always hashes and reads the same.
  return rows.sort((a, b) => TENOR_LABELS.indexOf(a.tenor) - TENOR_LABELS.indexOf(b.tenor));
}

async function readSchedule(sql: Sql): Promise<FuturesSchedule> {
  const [row] = await sql<
    Array<{ version: string; tenors: unknown; operator_id: string; approver_id: string; created_at: Date }>
  >`SELECT version::text AS version, tenors, operator_id, approver_id, created_at
      FROM trade.futures_expiry_schedule ORDER BY futures_expiry_schedule.version DESC LIMIT 1`;
  if (!row) return { version: null, tenors: [], reason: NO_SCHEDULE_PUBLISHED };
  const tenors = (typeof row.tenors === 'string' ? JSON.parse(row.tenors) : row.tenors) as TenorRow[];
  return {
    version: row.version,
    tenors,
    reason: null,
    publishedAt: row.created_at.toISOString(),
    operatorId: row.operator_id,
    approverId: row.approver_id,
  };
}
