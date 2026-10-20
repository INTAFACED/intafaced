/**
 * Liquidation and insurance fund desk reads (D-ops-06). Read-only: nothing here posts or moves a row.
 *
 * Every figure comes from a row this service wrote or from a ledger balance. A figure that cannot be
 * known is null with a reason, never 0: a missing mark is not a distance of zero, and an insurance
 * top-up this service never books (it has no writer for one yet) is not an empty history.
 */
import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type AccountRef } from '@intafaced/ledger-client';
import { recipeInsuranceAccount } from '../futures/insurance-bound.js';
import { pendingPayoutTotals } from '../futures/futures-payouts.js';

export const INSURANCE_TOPUPS_NOT_BOOKED_HERE = 'insurance_topups_not_booked_here' as const;
export const MARK_NOT_ACCEPTED = 'mark_not_accepted' as const;
export const LIQ_PRICE_NOT_RECORDED = 'liq_price_not_recorded' as const;

export interface DeskRung {
  readonly rungId: string;
  readonly positionId: string;
  readonly liquidationId: string;
  readonly kind: string;
  readonly state: string;
  readonly fromSize: string;
  readonly fromMargin: string;
  readonly fromInsurance: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DeskNearThreshold {
  readonly positionId: string;
  readonly userId: string;
  readonly marketId: string;
  readonly side: string;
  readonly size: string;
  readonly markPrice: string | null;
  readonly liqPrice: string | null;
  /** |mark − liq| / mark in basis points, floored. Null with a reason when either price is missing. */
  readonly distanceBps: number | null;
  readonly reason: string | null;
}

export interface DeskAdlPair {
  readonly pairId: string;
  readonly bankruptPositionId: string;
  readonly candidatePositionId: string;
  readonly size: string;
  readonly bankruptcyPrice: string;
  readonly candidateProfit: string;
  readonly state: string;
  readonly createdAt: string;
  readonly appliedAt: string | null;
}

export interface LiquidationDesk {
  /** Rungs newest first; live (planned, posted) and parked (abandoned) rows are the ones to act on. */
  readonly rungs: readonly DeskRung[];
  /** Open positions whose latest rung was abandoned, or that still carry an old-style claim. */
  readonly parked: readonly string[];
  /** Open positions ordered by how close their accepted mark is to their liquidation price. */
  readonly nearThreshold: readonly DeskNearThreshold[];
  readonly adlPairs: readonly DeskAdlPair[];
  /** What the clearing pot owes winners, per asset (futures ADR section 4). */
  readonly owedPayouts: readonly { assetId: string; owed: string; count: number }[];
}

function plain(raw: string | null): string | null {
  return raw == null ? null : formatAmount(parseAmount(raw));
}

/** One page of the liquidation desk. `market` narrows positions and rungs to one market. */
export async function readLiquidationDesk(sql: Sql, input: { market: string | null; limit: number }): Promise<LiquidationDesk> {
  const market = input.market;
  const rungs = await sql<
    {
      rung_id: string;
      position_id: string;
      liquidation_id: string;
      kind: string;
      state: string;
      from_size: string;
      from_margin: string;
      from_insurance: string | null;
      created_at: Date;
      updated_at: Date;
    }[]
  >`
    SELECT r.rung_id::text, r.position_id, r.liquidation_id, r.kind, r.state, r.from_size::text, r.from_margin::text,
           r.plan->>'fromInsurance' AS from_insurance, r.created_at, r.updated_at
      FROM trade.liquidation_rungs r
     ${market ? sql`JOIN trade.positions p ON p.id::text = r.position_id AND p.market_id = ${market}` : sql``}
     ORDER BY (r.state IN ('planned', 'posted', 'abandoned')) DESC, r.created_at DESC, r.rung_id DESC
     LIMIT ${input.limit}
  `;
  const parked = await sql<{ id: string }[]>`
    SELECT p.id FROM trade.positions p
     WHERE p.status = 'open'
       ${market ? sql`AND p.market_id = ${market}` : sql``}
       AND (
         COALESCE((SELECT r.state FROM trade.liquidation_rungs r WHERE r.position_id = p.id::text
                   ORDER BY r.created_at DESC, r.rung_id DESC LIMIT 1), '') = 'abandoned'
         OR EXISTS (SELECT 1 FROM trade.liquidation_attempts a WHERE a.liquidation_id = 'liq:' || p.id::text)
       )
     ORDER BY p.opened_at, p.id
     LIMIT ${input.limit}
  `;
  const open = await sql<
    { id: string; user_id: string; market_id: string; side: string; size: string; accepted_mark: string | null; liq_price: string | null }[]
  >`
    SELECT id, user_id, market_id, side::text, size::text, accepted_mark::text, liq_price::text
      FROM trade.positions
     WHERE status = 'open' ${market ? sql`AND market_id = ${market}` : sql``}
  `;
  const nearThreshold = open
    .map((row): DeskNearThreshold => {
      const markPrice = plain(row.accepted_mark);
      const liqPrice = plain(row.liq_price);
      let distanceBps: number | null = null;
      let reason: string | null = null;
      if (row.accepted_mark == null) reason = MARK_NOT_ACCEPTED;
      else if (row.liq_price == null) reason = LIQ_PRICE_NOT_RECORDED;
      else {
        const mark = parseAmount(row.accepted_mark);
        const liq = parseAmount(row.liq_price);
        const gap = mark > liq ? mark - liq : liq - mark;
        distanceBps = Number((gap * 10_000n) / mark);
      }
      return {
        positionId: row.id,
        userId: row.user_id,
        marketId: row.market_id,
        side: row.side,
        size: formatAmount(parseAmount(row.size)),
        markPrice,
        liqPrice,
        distanceBps,
        reason,
      };
    })
    // Known distances first, closest first; unknown ones after, never ranked as zero.
    .sort((a, b) =>
      a.distanceBps === b.distanceBps
        ? a.positionId.localeCompare(b.positionId)
        : a.distanceBps === null
          ? 1
          : b.distanceBps === null
            ? -1
            : a.distanceBps - b.distanceBps,
    )
    .slice(0, input.limit);
  const pairs = await sql<
    {
      pair_id: string;
      bankrupt_position_id: string;
      candidate_position_id: string;
      size: string;
      bankruptcy_price: string;
      candidate_profit: string;
      state: string;
      created_at: Date;
      applied_at: Date | null;
    }[]
  >`
    SELECT q.pair_id, q.bankrupt_position_id::text, q.candidate_position_id::text, q.size::text, q.bankruptcy_price::text,
           q.candidate_profit::text, q.state, q.created_at, q.applied_at
      FROM trade.futures_adl_pairs q
     ${market ? sql`JOIN trade.positions p ON p.id = q.bankrupt_position_id AND p.market_id = ${market}` : sql``}
     ORDER BY (q.state = 'planned') DESC, q.created_at DESC, q.pair_id
     LIMIT ${input.limit}
  `;
  return {
    rungs: rungs.map((r) => ({
      rungId: r.rung_id,
      positionId: r.position_id,
      liquidationId: r.liquidation_id,
      kind: r.kind,
      state: r.state,
      fromSize: formatAmount(parseAmount(r.from_size)),
      fromMargin: formatAmount(parseAmount(r.from_margin)),
      fromInsurance: r.from_insurance == null ? null : formatAmount(BigInt(r.from_insurance)),
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    })),
    parked: parked.map((p) => p.id),
    nearThreshold,
    adlPairs: pairs.map((q) => ({
      pairId: q.pair_id,
      bankruptPositionId: q.bankrupt_position_id,
      candidatePositionId: q.candidate_position_id,
      size: formatAmount(parseAmount(q.size)),
      bankruptcyPrice: formatAmount(parseAmount(q.bankruptcy_price)),
      candidateProfit: formatAmount(parseAmount(q.candidate_profit)),
      state: q.state,
      createdAt: q.created_at.toISOString(),
      appliedAt: q.applied_at ? q.applied_at.toISOString() : null,
    })),
    owedPayouts: await pendingPayoutTotals(sql),
  };
}

export interface InsuranceHistory {
  readonly asset: string;
  readonly balance: { value: string | null; reason: string | null };
  /** Insurance draws this service booked: applied liquidation rungs with an insurance leg, newest first. */
  readonly draws: readonly { rungId: string; positionId: string; amount: string; at: string }[];
  /** Top-ups are booked outside this service; their history is not readable here. */
  readonly topUps: { value: null; reason: typeof INSURANCE_TOPUPS_NOT_BOOKED_HERE };
}

export async function readInsuranceHistory(
  sql: Sql,
  ledger: { balance(ref: AccountRef): Promise<{ accountId: string; amount: bigint }> } | null,
  input: { asset: string; limit: number },
): Promise<InsuranceHistory> {
  let balance: InsuranceHistory['balance'];
  if (!ledger) balance = { value: null, reason: 'insurance_fund_unconfigured' };
  else {
    // A failed read throws: the desk shows an error, never 0.
    const read = await ledger.balance(recipeInsuranceAccount(input.asset));
    // Same rule as the futures snapshot: an account that was never created is not a configured fund.
    balance = read.accountId ? { value: formatAmount(read.amount), reason: null } : { value: null, reason: 'insurance_fund_unconfigured' };
  }
  const draws = await sql<{ rung_id: string; position_id: string; from_insurance: string; updated_at: Date }[]>`
    SELECT rung_id::text, position_id, plan->>'fromInsurance' AS from_insurance, updated_at
      FROM trade.liquidation_rungs
     WHERE state = 'applied' AND plan->>'marginAsset' = ${input.asset}
       AND COALESCE((plan->>'fromInsurance')::numeric, 0) > 0
     ORDER BY updated_at DESC, rung_id DESC
     LIMIT ${input.limit}
  `;
  return {
    asset: input.asset,
    balance,
    draws: draws.map((d) => ({
      rungId: d.rung_id,
      positionId: d.position_id,
      amount: formatAmount(BigInt(d.from_insurance)),
      at: d.updated_at.toISOString(),
    })),
    topUps: { value: null, reason: INSURANCE_TOPUPS_NOT_BOOKED_HERE },
  };
}
