import type { Sql } from 'postgres';
import {
  houseFees,
  merchantClearing,
  merchantProceeds,
  userAvailable,
  type AccountRef,
  type Amount,
  type LedgerTx,
} from '@intafaced/ledger-client';

/**
 * Which pot a settlement key credited.
 *
 * Decided from that settlement's own ledger transaction
 * (`settlement:<merchant>:<window>:<asset>`), never from a global cutover flag.
 * `legacy` means the net debit is `userAvailable`. `proceeds` means the net
 * debit is `merchantProceeds`.
 */
export type SettlementBook = 'legacy' | 'proceeds';

export type SettlementBookReader = {
  balance(ref: AccountRef): Promise<{ accountId: string }>;
  getTxByKey(idempotencyKey: string): Promise<LedgerTx | null>;
};

export function settlementIdempotencyKey(merchantId: string, window: string, assetId: string): string {
  return `settlement:${merchantId}:${window}:${assetId}`;
}

async function accountId(ledger: SettlementBookReader, ref: AccountRef): Promise<string> {
  return (await ledger.balance(ref)).accountId;
}

function debits(tx: LedgerTx, id: string, amount?: Amount): boolean {
  if (!id) return false;
  return tx.entries.some(
    (entry) => entry.direction === 'debit' && entry.accountId === id && (amount === undefined || entry.amount === amount),
  );
}

function credits(tx: LedgerTx, id: string, amount: Amount): boolean {
  if (!id) return false;
  return tx.entries.some((entry) => entry.direction === 'credit' && entry.accountId === id && entry.amount === amount);
}

export async function classifySettlementTx(
  ledger: SettlementBookReader,
  tx: LedgerTx,
  input: { merchantId: string; merchantUserId: string; assetId: string },
): Promise<SettlementBook | 'unrecognised'> {
  if (tx.module !== 'pay' || tx.reason !== 'pay.settled') return 'unrecognised';
  const personal = await accountId(ledger, userAvailable(input.merchantUserId, input.assetId));
  if (debits(tx, personal)) return 'legacy';
  const proceeds = await accountId(ledger, merchantProceeds(input.merchantId, input.assetId));
  if (debits(tx, proceeds)) return 'proceeds';
  return 'unrecognised';
}

export async function readSettlementBook(
  ledger: SettlementBookReader,
  input: { merchantId: string; merchantUserId: string; window: string; assetId: string },
): Promise<SettlementBook | 'absent' | 'unrecognised'> {
  const tx = await ledger.getTxByKey(settlementIdempotencyKey(input.merchantId, input.window, input.assetId));
  if (!tx) return 'absent';
  return classifySettlementTx(ledger, tx, input);
}

/**
 * The historical post is the one the old recipe wrote: clearing credited for
 * gross, `userAvailable` debited for net, house fees debited for a positive fee.
 * Anything else is not safe to adopt.
 */
export async function legacyPostMatchesFrozen(
  ledger: SettlementBookReader,
  tx: LedgerTx,
  input: { merchantId: string; merchantUserId: string; assetId: string; gross: Amount; fee: Amount },
): Promise<boolean> {
  if ((await classifySettlementTx(ledger, tx, input)) !== 'legacy') return false;
  const net = input.gross - input.fee;
  if (net <= 0n) return false;
  const clearing = await accountId(ledger, merchantClearing(input.merchantId, input.assetId));
  const personal = await accountId(ledger, userAvailable(input.merchantUserId, input.assetId));
  const feeAccount = input.fee > 0n ? await accountId(ledger, houseFees('pay', input.assetId)) : '';
  const feeLeg = input.fee > 0n ? debits(tx, feeAccount, input.fee) : true;
  return credits(tx, clearing, input.gross) && debits(tx, personal, net) && feeLeg && tx.entries.length === (input.fee > 0n ? 3 : 2);
}

/**
 * Merchants whose windows still have legacy settled net.
 *
 * `pending` is included. A freeze can sit in SQL while the ledger key was
 * already posted; `readSettlementBook` returns `absent` when that key was
 * never posted, so a bare pending row is not a false positive.
 *
 * No ledger reader means a pending, posted, paid-out, or failed window cannot
 * be proved clear of `userAvailable`, so it counts (fail closed). An
 * unrecognised post counts for the same reason. A missing key does not:
 * nothing was credited.
 */
export async function merchantIdsWithLegacySettlement(
  conn: Sql,
  ledger: SettlementBookReader | undefined,
  userId: string,
  assetId?: string,
): Promise<string[]> {
  const rows = assetId
    ? await conn<Array<{ merchant_id: string; window: string; asset_id: string; user_id: string }>>`
        SELECT s.merchant_id, s."window", s.asset_id, m.user_id
          FROM pay.settlements s
          JOIN pay.merchants m ON m.id = s.merchant_id
         WHERE m.user_id = ${userId}
           AND s.asset_id = ${assetId}
           AND s.status IN ('pending', 'posted', 'paid_out', 'failed')
         ORDER BY s.merchant_id, s."window", s.asset_id
      `
    : await conn<Array<{ merchant_id: string; window: string; asset_id: string; user_id: string }>>`
        SELECT s.merchant_id, s."window", s.asset_id, m.user_id
          FROM pay.settlements s
          JOIN pay.merchants m ON m.id = s.merchant_id
         WHERE m.user_id = ${userId}
           AND s.status IN ('pending', 'posted', 'paid_out', 'failed')
         ORDER BY s.merchant_id, s."window", s.asset_id
      `;
  if (!ledger) return [...new Set(rows.map((row) => row.merchant_id.toLowerCase()))].sort();
  const legacy = new Set<string>();
  for (const row of rows) {
    const id = row.merchant_id.toLowerCase();
    if (legacy.has(id)) continue;
    const book = await readSettlementBook(ledger, {
      merchantId: row.merchant_id,
      merchantUserId: row.user_id,
      window: row.window,
      assetId: row.asset_id,
    });
    if (book === 'legacy' || book === 'unrecognised') legacy.add(id);
  }
  return [...legacy].sort();
}
