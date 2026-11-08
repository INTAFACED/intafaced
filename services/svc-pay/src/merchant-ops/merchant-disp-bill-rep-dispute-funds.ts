import { formatAmount, parseAmount, type LedgerClient, type LedgerTx } from '@intafaced/ledger-client';
import { DISPUTE_FEE_NOTE } from '../chargeback-ledger.js';
import type { DisputeCase, DisputeCaseStatus, DisputeCaseStore } from '../fraud/dispute-case.js';
import { MerchantOpsError } from './errors.js';
import { assertPermission, type MerchantCaller } from './roles.js';

/**
 * M-disp-01 (spec group merchant-disp-bill-rep): where a dispute's money is.
 *
 * READ ONLY. This posts nothing and never retries a post. It reads the
 * chargeback transactions the ledger already holds, by the dispute-keyed
 * idempotency keys the recipes post under (`pay.chargeback.open:<disputeId>`,
 * `.shortfall:`, `.won:`, `.shortfall.recovered:`), and reports:
 *
 *   - takenAtOpening: what left the merchant's pots at `chargebackOpen`
 *     (clearing + settled legs, read from the booked entries; see `legs`). The money left
 *     then; it is not parked in a hold.
 *   - returned: what `chargebackWon` gave back (0 until it is booked).
 *   - shortfall: what the insurance fund covered; `null` ("not recorded")
 *     when there is no opening to measure against, never a guess.
 *   - notYetTaken: the part of the disputed amount no posting accounts for
 *     (a refused or partly booked opening).
 *
 * A ledger that is not wired, or a read that fails, refuses
 * `pay.dispute_funds_unavailable`: the screen shows "funds not available right
 * now" and never a zero that looks true.
 */

export type DisputeFundsLedger = Pick<LedgerClient, 'getTxByKey'>;

/** The full status set the case stores, in timeline order. */
export const DISPUTE_FUNDS_STATUSES = ['open', 'contested', 'accepted', 'won', 'lost'] as const satisfies readonly DisputeCaseStatus[];

export const disputeFundsKeys = (disputeId: string) =>
  ({
    open: `pay.chargeback.open:${disputeId}`,
    shortfall: `pay.chargeback.shortfall:${disputeId}`,
    won: `pay.chargeback.won:${disputeId}`,
    shortfallRecovered: `pay.chargeback.shortfall.recovered:${disputeId}`,
  }) as const;

export interface DisputeFundsTxs {
  readonly open: LedgerTx | null;
  readonly shortfall: LedgerTx | null;
  readonly won: LedgerTx | null;
  readonly shortfallRecovered: LedgerTx | null;
}

const unavailable = () => new MerchantOpsError('pay.dispute_funds_unavailable', 'unavailable');
const notFound = () => new MerchantOpsError('pay.dispute_not_found', 'not_found');

/** A scaled-bigint leg the recipe wrote into meta, or `null` when the meta did not come back. Anything else is a book we cannot read. */
function metaLeg(tx: LedgerTx, field: 'fromClearing' | 'fromMerchantBalance'): bigint | null {
  const raw = tx.meta[field];
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) throw unavailable();
  return BigInt(raw);
}

/**
 * What a chargeback opening took (`side: 'debit'`, the rail boundary's one debit) or a win gave back (`'credit'`, its one
 * credit), read from the entries the ledger booked. The ledger's `txById` door does not carry meta, so the entries are
 * the record; when the meta's two legs do come back they must add up to the same figure, or the book is unreadable.
 */
function legs(tx: LedgerTx, side: 'debit' | 'credit'): bigint {
  const total = tx.entries.filter((e) => e.direction === side).reduce((sum, e) => sum + e.amount, 0n);
  if (total <= 0n) throw unavailable();
  const clearing = metaLeg(tx, 'fromClearing');
  const balance = metaLeg(tx, 'fromMerchantBalance');
  if ((clearing === null) !== (balance === null)) throw unavailable();
  if (clearing !== null && balance !== null && clearing + balance !== total) throw unavailable();
  return total;
}

/** A two-entry fund movement: both entries carry the same amount. */
function fundAmount(tx: LedgerTx): bigint {
  const debits = tx.entries.filter((e) => e.direction === 'debit');
  if (debits.length === 0) throw unavailable();
  return debits.reduce((sum, e) => sum + e.amount, 0n);
}

/** Pure: the funds card from the case and the transactions found under its keys. */
export function disputeFunds(c: DisputeCase, txs: DisputeFundsTxs) {
  const disputed = parseAmount(c.amount);
  const taken = txs.open ? legs(txs.open, 'debit') : 0n;
  const shortfall = txs.open ? (txs.shortfall ? fundAmount(txs.shortfall) : 0n) : null;
  const returned = txs.won ? legs(txs.won, 'credit') : 0n;
  const recovered = txs.shortfallRecovered ? fundAmount(txs.shortfallRecovered) : 0n;
  const accounted = taken + (shortfall ?? 0n);
  const notYetTaken = disputed > accounted ? disputed - accounted : 0n;
  return {
    disputeId: c.disputeId,
    assetId: c.assetId,
    status: c.status,
    disputed: formatAmount(disputed),
    takenAtOpening: formatAmount(taken),
    openingBooked: txs.open !== null,
    notYetTaken: formatAmount(notYetTaken),
    returned: formatAmount(returned),
    shortfall: shortfall === null ? null : formatAmount(shortfall),
    shortfallRecovered: formatAmount(recovered),
    /** No dispute fee is configured on pay pricing: shown as not set, never a number. */
    fee: { state: 'not_set' as const, note: DISPUTE_FEE_NOTE },
    ledgerTxIds: {
      open: txs.open?.id ?? null,
      shortfall: txs.shortfall?.id ?? null,
      won: txs.won?.id ?? null,
      shortfallRecovered: txs.shortfallRecovered?.id ?? null,
    },
  };
}

export async function readDisputeFunds(
  caller: MerchantCaller,
  store: DisputeCaseStore,
  ledger: DisputeFundsLedger | undefined,
  disputeId: string,
) {
  assertPermission(caller, 'disputes.read');
  const c = await store.get(disputeId);
  if (!c || c.merchantId !== caller.merchantId) throw notFound();
  if (!ledger) throw unavailable();
  const keys = disputeFundsKeys(c.disputeId);
  let txs: DisputeFundsTxs;
  try {
    const [open, shortfall, won, shortfallRecovered] = await Promise.all([
      ledger.getTxByKey(keys.open),
      ledger.getTxByKey(keys.shortfall),
      ledger.getTxByKey(keys.won),
      ledger.getTxByKey(keys.shortfallRecovered),
    ]);
    txs = { open, shortfall, won, shortfallRecovered };
  } catch {
    throw unavailable();
  }
  return disputeFunds(c, txs);
}
