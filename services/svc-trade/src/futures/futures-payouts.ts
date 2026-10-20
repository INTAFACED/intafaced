/**
 * PAYING A WINNER FROM THE CLEARING POT, OR OWING IT UNTIL THE POT HOLDS IT.
 *
 * docs/adr/2026-10-20-futures-matched-traders.md section 4. Futures match trader
 * against trader, so every unit of profit is a unit another trader lost, and
 * `futuresRealizeProfit` pays it out of the clearing pot that realised losses
 * fill (`futuresLossSink`). The pot can be short for a while: losers still hold
 * their losses as unrealised, or a bankruptcy has not been booked yet. That is
 * not a reason to keep a winner in the trade, and it is never a reason to pay
 * from house money. So:
 *
 *   · the pot covers it → post `futuresRealizeProfit` now, row `paid`;
 *   · it does not → the close goes ahead, the profit is an intent row
 *     `pending` with `trade.clearing_pot_short`, and the payout tick posts the
 *     SAME recipe under the SAME key once the pot holds it.
 *
 * The row is an intent to post one recipe with one key. It is never a balance:
 * nothing reads it to let money leave, and the ledger posting under
 * `profit_id` is the money. Replays are safe in both directions because the
 * ledger posts a key once: a close retried after its profit already posted
 * returns the original transaction, and the tick does the same.
 */
import {
  InsufficientFundsError,
  LedgerError,
  formatAmount,
  parseAmount,
  recipes,
  type Amount,
  type LedgerClient,
  type PostRequest,
} from '@intafaced/ledger-client';
import type { Sql, TransactionSql } from 'postgres';

export const CLEARING_POT_SHORT = 'trade.clearing_pot_short' as const;

export type PayoutState = 'pending' | 'paid';

export interface FuturesPayout {
  readonly profitId: string;
  readonly positionId: string;
  readonly assetId: string;
  readonly amount: string;
  readonly state: PayoutState;
  /** `trade.clearing_pot_short` while pending; null once paid. */
  readonly refusalCode: string | null;
  readonly createdAt: string;
  readonly paidAt: string | null;
}

interface PayoutRow {
  profit_id: string;
  position_id: string;
  user_id: string;
  asset_id: string;
  amount: string;
  state: PayoutState;
  refusal_code: string | null;
  created_at: Date;
  paid_at: Date | null;
}

type Db = Sql | TransactionSql;

/** The profit leg of a close plan, if it has one. */
export function profitLegOf(posts: readonly PostRequest[]): PostRequest | undefined {
  return posts.find((p) => p.reason === 'futures.profit.realized');
}

/** True when the ledger refused a post because an account would go below zero. */
export function isInsufficientFunds(err: unknown): boolean {
  return err instanceof InsufficientFundsError || (err instanceof LedgerError && err.code === 'ledger.insufficient_funds');
}

/** `futuresRealizeProfit` exactly as the payout row describes it, so a retry posts the identical body. */
export function payoutRecipe(row: { profitId: string; positionId: string; userId: string; assetId: string; amount: Amount }): PostRequest {
  return recipes.futuresRealizeProfit({
    positionId: row.positionId,
    userId: row.userId,
    assetId: row.assetId,
    amount: row.amount,
    profitId: row.profitId,
  });
}

/**
 * Post the profit leg if the clearing pot holds it, otherwise record it as owed.
 *
 * Called inside the close transaction, under the position row lock, BEFORE the
 * close's other posts. The intent row is written first, then the profit is
 * posted, and the ledger is the bound: an insufficient-funds answer (a short
 * pot, or two winners racing for one) leaves the profit owed, never an error
 * after margin has moved. A replay of a profit that already posted is
 * recognised by its key and marked paid.
 */
export async function payOrOweProfit(input: {
  tx: Db;
  ledger: Pick<LedgerClient, 'post' | 'balance'>;
  profitId: string;
  positionId: string;
  userId: string;
  assetId: string;
  amount: Amount;
}): Promise<PayoutState> {
  const recipe = payoutRecipe(input);
  // The intent row goes in first, in the close's transaction, so the close never
  // commits without it; it only turns `paid` once the ledger has taken the post.
  await input.tx`
    INSERT INTO trade.futures_payouts
      (profit_id, position_id, user_id, asset_id, amount, state, refusal_code, attempts, last_attempt_at)
    VALUES (
      ${input.profitId}, ${input.positionId}, ${input.userId}, ${input.assetId}, ${formatAmount(input.amount)},
      'pending', ${CLEARING_POT_SHORT}, 1, now()
    )
    ON CONFLICT (profit_id) DO NOTHING
  `;
  // No balance pre-check: the ledger answers. A replay of a profit that already
  // posted must reach the ledger to be recognised by its key, and the pot is a
  // house account the ledger never lets go below zero.
  try {
    await input.ledger.post(recipe);
  } catch (err) {
    if (isInsufficientFunds(err)) return 'pending';
    throw err;
  }
  await input.tx`
    UPDATE trade.futures_payouts
    SET state = 'paid', paid_at = now(), refusal_code = NULL
    WHERE profit_id = ${input.profitId} AND state = 'pending'
  `;
  return 'paid';
}

export interface PayoutTickResult {
  readonly paid: readonly string[];
  readonly stillPending: readonly string[];
  readonly errored: readonly { profitId: string; message: string }[];
}

/**
 * Pay every owed profit the clearing pot can now cover, oldest first.
 *
 * One row at a time, each in its own transaction with `FOR UPDATE SKIP LOCKED`,
 * so two replicas never post the same row and one row's failure is never the
 * book's (engine spec X-4). A row the pot cannot cover stays pending; a later,
 * smaller row that fits is still paid.
 */
export async function runPayoutTick(input: {
  sql: Sql;
  ledger: Pick<LedgerClient, 'post' | 'balance'>;
  limit?: number;
}): Promise<PayoutTickResult> {
  const ids = await input.sql<{ profit_id: string }[]>`
    SELECT profit_id FROM trade.futures_payouts
    WHERE state = 'pending'
    ORDER BY created_at, profit_id
    LIMIT ${input.limit ?? 200}
  `;
  const paid: string[] = [];
  const stillPending: string[] = [];
  const errored: { profitId: string; message: string }[] = [];
  for (const { profit_id } of ids) {
    try {
      const outcome = await input.sql.begin(async (tx) => {
        const [row] = await tx<PayoutRow[]>`
          SELECT * FROM trade.futures_payouts
          WHERE profit_id = ${profit_id} AND state = 'pending'
          FOR UPDATE SKIP LOCKED
        `;
        if (!row) return 'skipped' as const;
        const amount = parseAmount(row.amount);
        let posted = false;
        try {
          await input.ledger.post(
            payoutRecipe({ profitId: row.profit_id, positionId: row.position_id, userId: row.user_id, assetId: row.asset_id, amount }),
          );
          posted = true;
        } catch (err) {
          if (!isInsufficientFunds(err)) throw err;
        }
        if (posted) {
          await tx`
            UPDATE trade.futures_payouts
            SET state = 'paid', paid_at = now(), refusal_code = NULL, attempts = attempts + 1, last_attempt_at = now()
            WHERE profit_id = ${profit_id}
          `;
          return 'paid' as const;
        }
        await tx`
          UPDATE trade.futures_payouts
          SET attempts = attempts + 1, last_attempt_at = now()
          WHERE profit_id = ${profit_id}
        `;
        return 'pending' as const;
      });
      if (outcome === 'paid') paid.push(profit_id);
      else if (outcome === 'pending') stillPending.push(profit_id);
    } catch (err) {
      errored.push({ profitId: profit_id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { paid, stillPending, errored };
}

function present(row: PayoutRow): FuturesPayout {
  return {
    profitId: row.profit_id,
    positionId: row.position_id,
    assetId: row.asset_id,
    amount: formatAmount(parseAmount(row.amount)),
    state: row.state,
    refusalCode: row.refusal_code,
    createdAt: row.created_at.toISOString(),
    paidAt: row.paid_at ? row.paid_at.toISOString() : null,
  };
}

/** A trader's own payouts, newest first: what was paid and what is still owed. */
export async function listPayoutsForUser(sql: Db, userId: string, limit = 100): Promise<readonly FuturesPayout[]> {
  const rows = await sql<PayoutRow[]>`
    SELECT * FROM trade.futures_payouts
    WHERE user_id = ${userId}
    ORDER BY created_at DESC, profit_id
    LIMIT ${limit}
  `;
  return rows.map(present);
}

/**
 * What the platform owes winners, per asset, to show beside the clearing pot's
 * ledger balance (ADR section 4 item 5). The ledger alone cannot show it.
 */
export async function pendingPayoutTotals(sql: Db): Promise<readonly { assetId: string; owed: string; count: number }[]> {
  const rows = await sql<{ asset_id: string; owed: string; n: string }[]>`
    SELECT asset_id, sum(amount)::text AS owed, count(*)::text AS n
    FROM trade.futures_payouts
    WHERE state = 'pending'
    GROUP BY asset_id
    ORDER BY asset_id
  `;
  return rows.map((r) => ({ assetId: r.asset_id, owed: formatAmount(parseAmount(r.owed)), count: Number(r.n) }));
}
