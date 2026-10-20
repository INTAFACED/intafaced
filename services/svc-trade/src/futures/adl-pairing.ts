/**
 * ADL AS A PAIR: BOTH SIDES SHRINK, AT THE BANKRUPTCY PRICE.
 *
 * docs/adr/2026-10-20-futures-matched-traders.md section 6. When the insurance
 * fund cannot cover a bankrupt position, ADL closes part of it against an
 * opposite-side position at the bankruptcy price, so the bankrupt trader loses
 * exactly their margin and the insurance fund pays nothing. Before this, the
 * reducer port shrank only the candidate and left the bankrupt side parked.
 *
 * For a pair of `size`:
 *   · the bankrupt side pays its margin share into the clearing pot
 *     (`futuresRealizeLoss`, fromMargin only, never insurance) — FIRST;
 *   · the candidate's margin share is released to them (`futuresMarginRelease`);
 *   · the candidate's profit at the bankruptcy price goes through the payout
 *     bound (`payOrOweProfit`): paid if the pot holds it, otherwise owed.
 *     ADL never fails because a payout is short.
 *
 * THE PLAN IS COMMITTED BEFORE ANYTHING POSTS. `trade.futures_adl_pairs` holds
 * every amount the three legs are built from, under both row locks taken in
 * position-id order. Posting and applying then replay from that row, so a crash
 * anywhere re-posts the same bodies under the same keys and the rows catch up
 * once. A planned pair blocks every trader change on both positions, top-ups
 * included (`assertLiquidationHold`), as well as funding, dated settlement and new
 * liquidation rungs. The liquidation tick (which still lists the pair after a dated
 * expiry) drives it before deciding anything else for either position. A funding
 * period frozen before the plan can still post against the rows; the driver then
 * abandons a pair whose loss the ledger refuses for funds (nothing posted), and
 * releases what the candidate actually holds once the loss has posted (`drive`).
 *
 * Keys: `futures.adl:<bankruptPositionId>:<ordinal>:<candidatePositionId>` with
 * `:loss` and `:profit` legs. The ordinal is the bankrupt position's ADL count
 * (the ADR's rung id): a business key, never a random id.
 *
 * Ranking is the owner's formula and stays blank on live (`trade.adl_unconfigured`).
 * `TEST_ADL_RANKING` exists for the test rig and says so in its label.
 */
import {
  div,
  formatAmount,
  mul,
  parseAmount,
  positionCollateralAccount,
  recipes,
  type Amount,
  type LedgerClient,
} from '@intafaced/ledger-client';
import type { Sql, TransactionSql } from 'postgres';
import type { AdlBankruptPosition, AdlCandidate, AdlReducePort } from './adl-last-resort.js';
import { unrealizedPnl } from './liquidation-planner.js';
import { isInsufficientFunds, payOrOweProfit } from './futures-payouts.js';

export const ADL_PAIR_REPLAYED = 'trade.adl_pair_replayed' as const;

type Side = 'long' | 'short';

/** A candidate as the ranking sees it, at the bankruptcy price. */
export interface AdlRankInput {
  readonly positionId: string;
  readonly size: Amount;
  readonly entryPrice: Amount;
  readonly margin: Amount;
  /** Profit of the whole candidate at the bankruptcy price. Always > 0 here. */
  readonly profitAtBankruptcy: Amount;
}

/** The owner's ADL ranking formula. Higher score is reduced first. */
export interface AdlRanking {
  readonly label: string;
  score(candidate: AdlRankInput): Amount;
}

/**
 * TEST ranking: profit percentage times leverage, highest first.
 * Not the owner's formula. It exists so the test rig can exercise ADL; live
 * passes no ranking and refuses `trade.adl_unconfigured`.
 */
export const TEST_ADL_RANKING: AdlRanking = {
  label: 'TEST',
  score(c) {
    if (c.margin <= 0n) return 0n;
    const profitPct = div(c.profitAtBankruptcy, c.margin, 'floor');
    const leverage = div(mul(c.size, c.entryPrice, 'floor'), c.margin, 'floor');
    return mul(profitPct, leverage, 'floor');
  },
};

/**
 * The price at which a position's loss equals its margin. Null when there is no
 * such positive price (a long whose margin covers its whole notional).
 */
export function bankruptcyPrice(side: Side, size: Amount, entryPrice: Amount, margin: Amount): Amount | null {
  if (size <= 0n || margin < 0n) return null;
  const perUnit = div(margin, size, 'floor');
  const price = side === 'long' ? entryPrice - perUnit : entryPrice + perUnit;
  return price > 0n ? price : null;
}

/** `amount × part / whole`, floored; the whole amount when the part is the whole. */
function share(amount: Amount, part: Amount, whole: Amount): Amount {
  if (part >= whole) return amount;
  return (amount * part) / whole;
}

/** Nothing else is moving this position (`p`): no live or abandoned rung, no old claim, no planned pair. */
function holdFree(db: Sql | TransactionSql) {
  return db`
    NOT EXISTS (SELECT 1 FROM trade.liquidation_rungs r WHERE r.position_id = p.id::text AND r.state IN ('planned', 'posted'))
    AND COALESCE((SELECT r.state FROM trade.liquidation_rungs r WHERE r.position_id = p.id::text
                  ORDER BY r.created_at DESC, r.rung_id DESC LIMIT 1), '') <> 'abandoned'
    AND NOT EXISTS (SELECT 1 FROM trade.liquidation_attempts a WHERE a.liquidation_id = 'liq:' || p.id::text)
    AND NOT EXISTS (SELECT 1 FROM trade.futures_adl_pairs q
                     WHERE q.state = 'planned' AND (q.bankrupt_position_id = p.id OR q.candidate_position_id = p.id))
    -- a matched fill still being recorded has posted into the pot ahead of the row (matched-orders.ts)
    AND NOT EXISTS (SELECT 1 FROM trade.futures_order_fills f WHERE f.position_id = p.id AND f.state = 'pending')
  `;
}

interface PositionRow {
  id: string;
  user_id: string;
  market_id: string;
  side: Side;
  status: string;
  size: string;
  entry_price: string;
  margin_current: string;
  margin_initial: string;
  margin_asset: string;
  margin_adjust_seq: number;
  margin_adjust_request: string | null;
  hold_free: boolean;
}

interface PairRow {
  pair_id: string;
  bankrupt_position_id: string;
  bankrupt_user_id: string;
  candidate_position_id: string;
  candidate_user_id: string;
  asset_id: string;
  size: string;
  bankrupt_margin_taken: string;
  bankrupt_initial_taken: string;
  candidate_margin_released: string;
  candidate_initial_released: string;
  candidate_release_sequence: number;
  candidate_profit: string;
  state: 'planned' | 'applied';
}

/**
 * Opposite-side candidates for one bankrupt position, ranked. Same market and
 * margin asset, another user, open with nothing in flight, and in profit at
 * the bankruptcy price. Disclosure acks are checked by `runAdlLastResort`.
 */
export function sqlAdlCandidates(sql: Sql, ranking: AdlRanking): (bankrupt: AdlBankruptPosition) => Promise<readonly AdlCandidate[]> {
  return async (bankrupt) => {
    const [b] = await sql<PositionRow[]>`
      SELECT id, user_id, market_id, side, status, size, entry_price, margin_current, margin_initial, margin_asset,
             margin_adjust_seq, margin_adjust_request, true AS hold_free
        FROM trade.positions WHERE id = ${bankrupt.positionId}
    `;
    if (!b || b.status !== 'open') return [];
    const price = bankruptcyPrice(b.side, parseAmount(b.size), parseAmount(b.entry_price), parseAmount(b.margin_current));
    if (price == null) return [];
    const opposite: Side = b.side === 'long' ? 'short' : 'long';
    const rows = await sql<PositionRow[]>`
      SELECT p.id, p.user_id, p.market_id, p.side, p.status, p.size, p.entry_price, p.margin_current, p.margin_initial,
             p.margin_asset, p.margin_adjust_seq, p.margin_adjust_request, true AS hold_free
        FROM trade.positions p
       WHERE p.market_id = ${b.market_id} AND p.side = ${opposite} AND p.status = 'open'
         AND p.user_id <> ${b.user_id} AND p.margin_asset = ${b.margin_asset}
         AND p.size > 0 AND p.margin_adjust_request IS NULL
         AND ${holdFree(sql)}
    `;
    const ranked: { candidate: AdlCandidate; score: Amount }[] = [];
    for (const row of rows) {
      const size = parseAmount(row.size);
      const entryPrice = parseAmount(row.entry_price);
      const profitAtBankruptcy = unrealizedPnl(row.side, size, entryPrice, price);
      if (profitAtBankruptcy <= 0n) continue;
      const score = ranking.score({ positionId: row.id, size, entryPrice, margin: parseAmount(row.margin_current), profitAtBankruptcy });
      ranked.push({ candidate: { positionId: row.id, userId: row.user_id, marketId: row.market_id, side: row.side, size }, score });
    }
    ranked.sort((x, y) => (x.score === y.score ? (x.candidate.positionId < y.candidate.positionId ? -1 : 1) : x.score > y.score ? -1 : 1));
    return ranked.map((r) => r.candidate);
  };
}

export interface AdlPairReducer extends AdlReducePort {
  /** Drive any planned pair touching this position. True when one was driven. */
  replayPlanned(positionId: string): Promise<boolean>;
}

/**
 * The ADL reducer on Postgres and the ledger: plan the pair under both row
 * locks, post its legs, then apply both rows. See the header.
 */
export function sqlAdlPairReducer(sql: Sql, ledger: Pick<LedgerClient, 'post' | 'balance' | 'getTxByKey'>): AdlPairReducer {
  async function lockPair(tx: TransactionSql, a: string, b: string): Promise<Map<string, PositionRow>> {
    await tx`SELECT p.id FROM trade.positions p WHERE p.id IN (${a}, ${b}) ORDER BY p.id FOR UPDATE OF p`;
    // Read the rows and their holds in a second statement, after the locks. Under READ COMMITTED a statement's
    // subqueries see the snapshot taken before its lock wait, so a rung or claim the lock holder committed
    // meanwhile would be missed if hold_free were read in the locking statement itself.
    const rows = await tx<PositionRow[]>`
      SELECT p.id, p.user_id, p.market_id, p.side, p.status, p.size, p.entry_price, p.margin_current, p.margin_initial,
             p.margin_asset, p.margin_adjust_seq, p.margin_adjust_request,
             (${holdFree(tx)}) AS hold_free
        FROM trade.positions p
       WHERE p.id IN (${a}, ${b})
    `;
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** Plan one pair. Null when the rows no longer allow one (nothing is written). */
  async function plan(input: { bankruptPositionId: string; candidatePositionId: string; maxSize: Amount; disclosureEventId: string }) {
    return sql.begin(async (tx) => {
      const rows = await lockPair(tx, input.bankruptPositionId, input.candidatePositionId);
      const b = rows.get(input.bankruptPositionId);
      const c = rows.get(input.candidatePositionId);
      if (!b || !c) return null;
      if (b.status !== 'open' || c.status !== 'open' || !b.hold_free || !c.hold_free) return null;
      if (b.margin_adjust_request != null || c.margin_adjust_request != null) return null;
      if (b.market_id !== c.market_id || b.margin_asset !== c.margin_asset || b.side === c.side || b.user_id === c.user_id) return null;

      const bSize = parseAmount(b.size);
      const cSize = parseAmount(c.size);
      const bMargin = parseAmount(b.margin_current);
      const cMargin = parseAmount(c.margin_current);
      const price = bankruptcyPrice(b.side, bSize, parseAmount(b.entry_price), bMargin);
      if (price == null) return null;
      let size = input.maxSize;
      if (size > bSize) size = bSize;
      if (size > cSize) size = cSize;
      if (size <= 0n) return null;
      const profit = unrealizedPnl(c.side, size, parseAmount(c.entry_price), price);
      if (profit <= 0n) return null;

      const [counted] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM trade.futures_adl_pairs WHERE bankrupt_position_id = ${b.id}
      `;
      const ordinal = (counted?.n ?? 0) + 1;
      const pairId = `futures.adl:${b.id}:${ordinal}:${c.id}`;
      await tx`
        INSERT INTO trade.futures_adl_pairs (
          pair_id, ordinal, bankrupt_position_id, bankrupt_user_id, candidate_position_id, candidate_user_id, asset_id,
          size, bankruptcy_price, bankrupt_margin_taken, bankrupt_initial_taken, candidate_margin_released,
          candidate_initial_released, candidate_release_sequence, candidate_profit, disclosure_event_id
        ) VALUES (
          ${pairId}, ${ordinal}, ${b.id}, ${b.user_id}, ${c.id}, ${c.user_id}, ${b.margin_asset},
          ${formatAmount(size)}, ${formatAmount(price)},
          ${formatAmount(share(bMargin, size, bSize))}, ${formatAmount(share(parseAmount(b.margin_initial), size, bSize))},
          ${formatAmount(share(cMargin, size, cSize))}, ${formatAmount(share(parseAmount(c.margin_initial), size, cSize))},
          ${Number(c.margin_adjust_seq) + 1}, ${formatAmount(profit)}, ${input.disclosureEventId}
        )
      `;
      const [row] = await tx<PairRow[]>`SELECT * FROM trade.futures_adl_pairs WHERE pair_id = ${pairId}`;
      return row!;
    });
  }

  /** What the ledger holds as a position's collateral right now. */
  async function collateral(userId: string, assetId: string, positionId: string): Promise<Amount> {
    return (await ledger.balance(positionCollateralAccount(userId, assetId, positionId))).amount;
  }

  /**
   * Post the pair's legs (loss first) and move both rows, all under the pair row lock. Safe to run again:
   * each leg is looked up by its key before it posts.
   *
   * The plan fixed its amounts from the rows. A funding period frozen before the plan can still post
   * against either position afterwards. If it leaves the bankrupt short of the planned loss, the ledger
   * refuses the loss for funds; a refusal for funds means the key had not posted, so (after one more
   * look, for an earlier attempt that may have landed meanwhile) the pair is abandoned with nothing
   * posted and the next tick plans afresh from the moved rows. Once the loss has posted the pair goes
   * ahead, and the candidate's release is the collateral it actually holds (all of it on a full close,
   * never more than planned on a partial one), read back from the ledger on a replay.
   *
   * Not covered: funding that pays the bankrupt after the plan stays in its collateral when the pair
   * closes it, as it does for any position a frozen period pays after its close.
   */
  async function drive(pair: PairRow): Promise<'applied' | 'abandoned' | 'gone'> {
    const size = parseAmount(pair.size);
    const taken = parseAmount(pair.bankrupt_margin_taken);
    const loss = recipes.futuresRealizeLoss({
      positionId: pair.bankrupt_position_id,
      userId: pair.bankrupt_user_id,
      assetId: pair.asset_id,
      fromMargin: taken,
      fromInsurance: 0n,
      lossId: `${pair.pair_id}:loss`,
    });
    const release = (amount: Amount) =>
      recipes.futuresMarginRelease({
        positionId: pair.candidate_position_id,
        userId: pair.candidate_user_id,
        assetId: pair.asset_id,
        amount,
        sequence: pair.candidate_release_sequence,
      });
    return sql.begin(async (tx) => {
      const [still] = await tx<{ state: string }[]>`
        SELECT state FROM trade.futures_adl_pairs WHERE pair_id = ${pair.pair_id} FOR UPDATE
      `;
      if (still?.state !== 'planned') return 'gone';
      const rows = await lockPair(tx, pair.bankrupt_position_id, pair.candidate_position_id);
      const fullCandidate = parseAmount(rows.get(pair.candidate_position_id)?.size ?? '0') === size;
      let released = parseAmount(pair.candidate_margin_released);

      if (taken > 0n && !(await ledger.getTxByKey(loss.idempotencyKey))) {
        try {
          await ledger.post(loss);
        } catch (err) {
          if (!isInsufficientFunds(err)) throw err;
          // The ledger checks the key before the funds, so a refusal for funds means this key had not
          // posted when it checked. An earlier attempt whose outcome was unknown may have landed since,
          // so look once more: only a loss that is still unposted abandons the pair.
          if (!(await ledger.getTxByKey(loss.idempotencyKey))) {
            await tx`
              UPDATE trade.futures_adl_pairs SET state = 'abandoned', abandoned_at = now() WHERE pair_id = ${pair.pair_id}
            `;
            return 'abandoned';
          }
        }
      }

      const posted = await ledger.getTxByKey(release(1n).idempotencyKey);
      if (posted) {
        // Posted on an earlier run whose row writes rolled back: the amount that posted is the ledger's,
        // not the column's (an adjusted amount is written in the same transaction and may not have committed).
        released = posted.entries[0]!.amount;
      } else {
        const held = await collateral(pair.candidate_user_id, pair.asset_id, pair.candidate_position_id);
        released = fullCandidate || held < released ? held : released;
        if (released > 0n) await ledger.post(release(released));
      }
      await tx`
        UPDATE trade.futures_adl_pairs SET candidate_margin_released = ${formatAmount(released)}::numeric
         WHERE pair_id = ${pair.pair_id} AND candidate_margin_released <> ${formatAmount(released)}::numeric
      `;

      await payOrOweProfit({
        tx,
        ledger,
        profitId: `${pair.pair_id}:profit`,
        positionId: pair.candidate_position_id,
        userId: pair.candidate_user_id,
        assetId: pair.asset_id,
        amount: parseAmount(pair.candidate_profit),
      });
      // A full close keeps the row's size and margins as they were and only closes it, as
      // every other close does (`positions_size_positive_ck`); a partial pair subtracts.
      const moved = await tx`
        UPDATE trade.positions
           SET size = CASE WHEN size = ${formatAmount(size)}::numeric THEN size ELSE size - ${formatAmount(size)}::numeric END,
               margin_current = CASE WHEN size = ${formatAmount(size)}::numeric THEN margin_current
                                     ELSE margin_current - ${pair.bankrupt_margin_taken}::numeric END,
               margin_initial = CASE WHEN size = ${formatAmount(size)}::numeric THEN margin_initial
                                     ELSE margin_initial - ${pair.bankrupt_initial_taken}::numeric END,
               status = CASE WHEN size = ${formatAmount(size)}::numeric THEN 'closed' ELSE status END,
               closed_at = CASE WHEN size = ${formatAmount(size)}::numeric THEN now() ELSE closed_at END,
               updated_at = now()
         WHERE id = ${pair.bankrupt_position_id} AND status = 'open'
           AND size >= ${formatAmount(size)}::numeric AND margin_current >= ${pair.bankrupt_margin_taken}::numeric
      `;
      const movedCandidate = await tx`
        UPDATE trade.positions
           SET size = CASE WHEN size = ${formatAmount(size)}::numeric THEN size ELSE size - ${formatAmount(size)}::numeric END,
               margin_current = CASE WHEN size = ${formatAmount(size)}::numeric THEN margin_current
                                     ELSE margin_current - ${formatAmount(released)}::numeric END,
               margin_initial = CASE WHEN size = ${formatAmount(size)}::numeric THEN margin_initial
                                     ELSE margin_initial - ${pair.candidate_initial_released}::numeric END,
               margin_adjust_seq = GREATEST(margin_adjust_seq, ${pair.candidate_release_sequence}),
               status = CASE WHEN size = ${formatAmount(size)}::numeric THEN 'closed' ELSE status END,
               closed_at = CASE WHEN size = ${formatAmount(size)}::numeric THEN now() ELSE closed_at END,
               updated_at = now()
         WHERE id = ${pair.candidate_position_id} AND status = 'open'
           AND size >= ${formatAmount(size)}::numeric AND margin_current >= ${formatAmount(released)}::numeric
      `;
      if (moved.count !== 1 || movedCandidate.count !== 1) {
        // A leg posted and a row no longer holds what the plan took from it. Throwing rolls the row
        // moves back and keeps the pair planned (and both positions held) for the next tick and the operator.
        throw new Error(`ADL pair ${pair.pair_id} posted but a position row no longer matches its plan`);
      }
      await tx`
        UPDATE trade.futures_adl_pairs SET state = 'applied', applied_at = now() WHERE pair_id = ${pair.pair_id}
      `;
      return 'applied';
    });
  }

  async function replayPlanned(positionId: string): Promise<boolean> {
    const planned = await sql<PairRow[]>`
      SELECT * FROM trade.futures_adl_pairs
       WHERE state = 'planned' AND (bankrupt_position_id = ${positionId} OR candidate_position_id = ${positionId})
       ORDER BY created_at, pair_id
    `;
    for (const pair of planned) await drive(pair);
    return planned.length > 0;
  }

  return {
    replayPlanned,
    async reduce(input) {
      if (!input.bankruptPositionId) throw new Error('ADL pair reducer needs the bankrupt position');
      await replayPlanned(input.bankruptPositionId);
      await replayPlanned(input.positionId);
      const pair = await plan({
        bankruptPositionId: input.bankruptPositionId,
        candidatePositionId: input.positionId,
        maxSize: input.sizeClosed,
        disclosureEventId: input.disclosureEventId,
      });
      if (!pair) return { sizeClosed: 0n };
      // An abandoned pair moved nothing; the next tick plans again from the moved rows.
      return { sizeClosed: (await drive(pair)) === 'applied' ? parseAmount(pair.size) : 0n };
    },
  };
}
