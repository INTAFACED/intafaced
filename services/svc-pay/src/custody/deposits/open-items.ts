import type { Sql } from 'postgres';
import {
  router,
  TRPCError,
  PAY_CUSTODY_DEPOSIT_HELD_STATUSES,
  payCustodyOpenItemsInputSchema,
  payCustodyOpenItemsReplySchema,
  type PayCustodyDepositReason,
  type PayCustodyDepositStatus,
  type PayCustodyOpenItem,
  type PayCustodyOpenItemsInput,
  type PayCustodyOpenItemsReply,
} from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { founderProcedure } from '../../namespaces/founder-procedure.js';
import type { FounderAuthority } from '../../founder-authority.js';

/**
 * Open custody items across every customer (OPS-reconciliation-02, J-ops-console-27 #8): the deposits custody received but the
 * ledger has not credited (`held`), and the credited deposits the chain took back that no balance could cover
 * (`reversal_unfunded`). These are why custody and the ledger can differ for a while; a reconciliation reads them to see that
 * a difference is exactly these items and nothing else. Founder-only, read-only: it posts nothing and changes no row.
 *
 * `held` is a row in a held status that never started a credit, so the ledger has nothing for it (a positive item: custody
 * shows more). `reversal_unfunded` is a credited row the chain reversed, whose reversal posted nothing (a negative item: the
 * ledger shows more). A reversed row whose reversal posted, a credited row and a row still on its way are not items.
 *
 * Not every difference: a row under review for another reason (an amount mismatch, a reorg whose reversal is unsure or
 * never credited) is not listed here; it is read where review rows are read.
 */

const HELD = [...PAY_CUSTODY_DEPOSIT_HELD_STATUSES];

interface ItemRow {
  id: string;
  user_id: string;
  asset_id: string;
  network_id: string;
  tx_hash: string;
  output_index: number;
  amount: string;
  status: PayCustodyDepositStatus;
  reason: PayCustodyDepositReason | null;
  detected_at: Date;
  kind: 'held' | 'reversal_unfunded';
}

interface SumRow {
  network_id: string;
  asset_id: string;
  held: string;
  held_count: string;
  unfunded: string;
  unfunded_count: string;
}

/** One exact decimal, written the way the rest of svc-pay writes amounts. */
const exact = (value: string): string => formatAmount(parseAmount(value));

export class CustodyOpenItems {
  constructor(private readonly deps: { sql: Sql }) {}

  async list(raw: PayCustodyOpenItemsInput): Promise<PayCustodyOpenItemsReply> {
    const input = payCustodyOpenItemsInputSchema.parse(raw);
    const { sql } = this.deps;
    // One CASE names the kind, so the filter, the page and the sums can never disagree about what an item is.
    const kind = sql`CASE WHEN status IN ${sql(HELD)} AND credit_started_at IS NULL THEN 'held'
                          WHEN status = 'needs_review' AND reason = 'reversal_unfunded' AND credited_at IS NOT NULL THEN 'reversal_unfunded'
                     END`;
    const where = sql`(${kind}) IS NOT NULL
      ${input.networkId ? sql`AND network_id = ${input.networkId}` : sql``}
      ${input.assetId ? sql`AND asset_id = ${input.assetId}` : sql``}`;
    // One read-only snapshot, so a write between the statements can never make the page, the total and the sums disagree.
    const [rows, count, sums] = await sql.begin('isolation level repeatable read read only', (tx) => [
      tx<ItemRow[]>`
        SELECT id, user_id, asset_id, network_id, tx_hash, output_index, amount, status, reason, detected_at, ${kind} AS kind
          FROM pay.custody_deposits WHERE ${where}
         ORDER BY detected_at, id LIMIT ${input.limit} OFFSET ${input.offset}`,
      tx<Array<{ n: string }>>`SELECT count(*)::text AS n FROM pay.custody_deposits WHERE ${where}`,
      tx<SumRow[]>`
        SELECT network_id, asset_id,
               COALESCE(sum(amount::numeric) FILTER (WHERE ${kind} = 'held'), 0)::text AS held,
               count(*) FILTER (WHERE ${kind} = 'held')::text AS held_count,
               COALESCE(sum(amount::numeric) FILTER (WHERE ${kind} = 'reversal_unfunded'), 0)::text AS unfunded,
               count(*) FILTER (WHERE ${kind} = 'reversal_unfunded')::text AS unfunded_count
          FROM pay.custody_deposits WHERE ${where}
         GROUP BY network_id, asset_id ORDER BY network_id, asset_id`,
    ]);
    return payCustodyOpenItemsReplySchema.parse({
      items: rows.map(toItem),
      total: Number(count[0]?.n ?? '0'),
      sums: sums.map((s) => {
        const held = parseAmount(s.held);
        const unfunded = parseAmount(s.unfunded);
        return {
          networkId: s.network_id,
          assetId: s.asset_id,
          held: formatAmount(held),
          heldCount: Number(s.held_count),
          reversalUnfunded: formatAmount(unfunded),
          reversalUnfundedCount: Number(s.unfunded_count),
          net: formatAmount(held - unfunded),
        };
      }),
    });
  }
}

function toItem(row: ItemRow): PayCustodyOpenItem {
  const amount = exact(row.amount);
  return {
    depositId: row.id,
    kind: row.kind,
    userId: row.user_id,
    assetId: row.asset_id,
    networkId: row.network_id,
    txHash: row.tx_hash,
    outputIndex: row.output_index,
    amount,
    signedAmount: row.kind === 'held' ? amount : `-${amount}`,
    status: row.status,
    reason: row.reason,
    detectedAt: row.detected_at.toISOString(),
  };
}

export interface DepositOpenItemsMountDeps {
  readonly sql: Sql;
}

/** `founderAdmin.depositOpenItems.list`: founder-only. Anyone else is refused before the input is read. */
export function createDepositOpenItemsRouter(deps: DepositOpenItemsMountDeps & { founderAuthority: FounderAuthority }) {
  const founder = founderProcedure(deps.founderAuthority);
  const items = new CustodyOpenItems(deps);
  return router({
    list: founder
      .input(payCustodyOpenItemsInputSchema)
      .output(payCustodyOpenItemsReplySchema)
      .query(async ({ input }) => {
        try {
          return await items.list(input);
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'pay.custody_open_items_unavailable', cause: error });
        }
      }),
  });
}
