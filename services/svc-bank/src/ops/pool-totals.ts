/**
 * Operator pool totals.
 *
 * `earn_pools` is only the list of pools. The amount held is each active
 * position's ledger stake pot — the same `ledger.balance(earnStakeAccount)`
 * read `poolSize` uses. The principal column is not read, so an inflated table
 * row cannot change the figure. A failed ledger read is null with
 * `ledger_unavailable`, never zero and never a cached figure.
 *
 * No lent-out account exists for an earn pool, so utilisation is null with
 * `utilisation_not_recorded`. The output is counts and totals, never a per-user row.
 */
import { anyScopeProcedure } from '@intafaced/contracts';
import { earnStakeAccount, formatAmount, type Amount, type LedgerClient } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { z } from 'zod';

const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/);

export interface PoolTotal {
  poolId: string;
  assetId: string;
  amountHeld: string | null;
  amountReason: 'ledger_unavailable' | null;
  depositorCount: number;
  utilisation: null;
  utilisationReason: 'utilisation_not_recorded';
}

export async function readPoolTotals(sql: Sql, ledger: LedgerClient): Promise<{ asOf: string; pools: PoolTotal[] }> {
  const pools = await sql<Array<{ id: string; asset_id: string }>>`
    SELECT id, asset_id FROM bank.earn_pools ORDER BY created_at ASC, id ASC
  `;
  const asOf = new Date().toISOString();
  const out: PoolTotal[] = [];
  for (const pool of pools) {
    const positions = await sql<Array<{ id: string; user_id: string; asset_id: string }>>`
      SELECT id, user_id, asset_id FROM bank.earn_positions
       WHERE pool_id = ${pool.id} AND status = 'active'
       ORDER BY id ASC
    `;
    let amountHeld: string | null = null;
    let amountReason: PoolTotal['amountReason'] = null;
    try {
      let total: Amount = 0n;
      for (const row of positions) {
        const balance = await ledger.balance(earnStakeAccount(row.user_id, row.asset_id, row.id));
        total += balance.amount;
      }
      amountHeld = formatAmount(total);
    } catch {
      amountHeld = null;
      amountReason = 'ledger_unavailable';
    }
    out.push({
      poolId: pool.id,
      assetId: pool.asset_id,
      amountHeld,
      amountReason,
      depositorCount: positions.length,
      utilisation: null,
      utilisationReason: 'utilisation_not_recorded',
    });
  }
  return { asOf, pools: out };
}

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

export function poolTotalsProcedure(read: () => Promise<{ asOf: string; pools: PoolTotal[] }>, guard: Guard) {
  return anyScopeProcedure(['admin:read', 'admin:treasury'])
    .output(
      z.object({
        asOf: z.string(),
        pools: z.array(
          z.object({
            poolId: z.string(),
            assetId: z.string(),
            amountHeld: amountString.nullable(),
            amountReason: z.enum(['ledger_unavailable']).nullable(),
            depositorCount: z.number().int().nonnegative(),
            utilisation: z.null(),
            utilisationReason: z.literal('utilisation_not_recorded'),
          }),
        ),
      }),
    )
    .query(() => guard(() => read()));
}
