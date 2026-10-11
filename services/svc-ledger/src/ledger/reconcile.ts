import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { formatAmount, LedgerError } from '@intafaced/ledger-client';
import { parseStoredAmount } from './live-money.js';
import { hashTx } from './postgres-ledger.js';

/**
 * RECONCILIATION (§4.2).
 *
 *   "Reconciliation job: snapshots vs. entry replay must match to 18 decimals;
 *    mismatch = page the operator, freeze the module that diverged."
 *
 * Three independent checks, each capable of catching a class of failure the
 * others cannot:
 *
 *   · `reconcileBalances` — the cached `accounts.balance` against a full replay
 *     of `ledger_entries`. Catches a bug in the posting path.
 *   · `verifyChain` — every hash recomputed from its predecessor, then
 *     `chain_tip.hash` against the last row. Catches tampering, including by
 *     someone with database access. A linked tail is not a healthy chain when
 *     the tip names a different hash.
 *   · `totalsByAsset` — every asset must net to zero across all accounts.
 *     Catches value being created or destroyed by any means at all.
 */

export interface Drift {
  readonly accountId: string;
  readonly assetId: string;
  readonly cached: string;
  readonly replayed: string;
  readonly difference: string;
}

export type ReconcileResult = { ok: true; accountsChecked: number } | { ok: false; drift: Drift[]; accountsChecked: number };

export async function reconcileBalances(sql: Sql): Promise<ReconcileResult> {
  // One pass, in the database: replaying millions of entries in Node would be
  // both slower and a memory problem.
  const rows = await sql<Array<{ account_id: string; asset_id: string; cached: string; replayed: string }>>`
    SELECT a.id                                        AS account_id,
           a.asset_id                                  AS asset_id,
           a.balance                                   AS cached,
           COALESCE(SUM(
             CASE WHEN e.direction = 'debit' THEN e.amount ELSE -e.amount END
           ), 0)                                       AS replayed
      FROM accounts a
      LEFT JOIN ledger_entries e ON e.account_id = a.id
     GROUP BY a.id, a.asset_id, a.balance
  `;

  const drift: Drift[] = [];
  for (const row of rows) {
    const cached = parseStoredAmount(row.cached, 'accounts.balance');
    const replayed = parseStoredAmount(row.replayed, 'ledger_entries.amount');
    if (cached !== replayed) {
      drift.push({
        accountId: row.account_id,
        assetId: row.asset_id,
        cached: formatAmount(cached),
        replayed: formatAmount(replayed),
        difference: formatAmount(cached - replayed),
      });
    }
  }

  return drift.length === 0 ? { ok: true, accountsChecked: rows.length } : { ok: false, drift, accountsChecked: rows.length };
}

export type ChainResult = { ok: true; length: number } | { ok: false; brokenAt: string; length: number };

/** One `ledger_entries` row as the chain proof reads it. Amounts stay decimal strings. */
interface ChainEntryRow {
  tx_id: string;
  account_id: string;
  asset_id: string;
  direction: 'debit' | 'credit';
  amount: string;
  balance_after: string;
}

export async function verifyChain(sql: Sql, batchSize = 1000): Promise<ChainResult> {
  let previous: string | null = null;
  let lastId: string | null = null;
  let afterSeq = '0';
  let length = 0;

  for (;;) {
    const txs = await sql<
      Array<{
        id: string;
        seq: string;
        module: string;
        reason: string;
        posted_at: Date;
        hash: string;
        previous_hash: string | null;
        idempotency_key: string;
        meta: unknown;
        claim_matches: boolean;
      }>
    >`
      SELECT t.id, t.seq, t.module, t.reason, t.posted_at, t.hash, t.previous_hash, t.idempotency_key, t.meta,
             (k.idempotency_key IS NOT DISTINCT FROM t.idempotency_key
              AND k.posted_hash IS NOT DISTINCT FROM t.hash
              AND k.posted_meta IS NOT DISTINCT FROM t.meta) AS claim_matches
        FROM ledger_tx t
        LEFT JOIN ledger_posted_keys k ON k.tx_id = t.id
       WHERE t.seq > ${afterSeq}
       ORDER BY t.seq ASC
       LIMIT ${batchSize}
    `;
    if (txs.length === 0) break;

    // One read for this page. The hourly proof used to ask for entries once
    // per transaction inside the seq loop.
    const pageEntries = await sql<ChainEntryRow[]>`
      SELECT tx_id, account_id, asset_id, direction, amount, balance_after
        FROM ledger_entries
       WHERE tx_id = ANY(${txs.map((tx) => tx.id)}::uuid[])
       ORDER BY id ASC
    `;
    const entriesByTx = new Map<string, ChainEntryRow[]>();
    for (const tx of txs) entriesByTx.set(tx.id, []);
    for (const row of pageEntries) {
      const bucket = entriesByTx.get(row.tx_id);
      if (bucket) bucket.push(row);
    }

    for (const tx of txs) {
      const entries: ChainEntryRow[] = entriesByTx.get(tx.id) ?? [];

      const posted = {
        id: tx.id,
        module: tx.module,
        reason: tx.reason,
        postedAt: tx.posted_at,
        entries: entries.map((e) => ({
          id: '',
          txId: tx.id,
          accountId: e.account_id,
          assetId: e.asset_id,
          direction: e.direction,
          amount: parseStoredAmount(e.amount, 'ledger_entries.amount'),
          balanceAfter: parseStoredAmount(e.balance_after, 'ledger_entries.balance_after'),
        })),
      };
      // Claims copy the actual key, hash, and metadata at insert or upgrade.
      // A missing or contradictory claim refuses even though the shared digest
      // intentionally does not cover key/metadata. Historical hashes stay intact.
      if (!tx.claim_matches) {
        return { ok: false, brokenAt: tx.id, length };
      }

      const legacy = hashTx(posted, previous);

      if (tx.previous_hash !== previous || tx.hash !== legacy) {
        return { ok: false, brokenAt: tx.id, length };
      }

      previous = tx.hash;
      lastId = tx.id;
      afterSeq = tx.seq;
      length++;
    }
  }

  // The singleton tip must name the last row by both sequence and hash.
  const tipRows = await sql<Array<{ hash: string | null; seq: string }>>`
    SELECT hash, seq::text AS seq FROM chain_tip WHERE id = true
  `;
  const tipHash = tipRows[0]?.hash ?? null;
  if (tipRows.length === 0 || tipHash !== previous || tipRows[0]?.seq !== afterSeq) {
    return { ok: false, brokenAt: lastId ?? 'chain_tip', length };
  }

  return { ok: true, length };
}

/** Every asset must sum to exactly zero across every account. */
export async function totalsByAsset(sql: Sql): Promise<Record<string, string>> {
  const rows = await sql<Array<{ asset_id: string; total: string }>>`
    SELECT asset_id, COALESCE(SUM(balance), 0) AS total FROM accounts GROUP BY asset_id
  `;
  return Object.fromEntries(rows.map((r) => [r.asset_id, formatAmount(parseStoredAmount(r.total, 'accounts.balance'))]));
}

/** Tip row locked the way `postgres-ledger` locks it: `FOR UPDATE OF t` only. */
interface LockedChainTip {
  readonly seq: string;
  readonly hash: string | null;
}

/**
 * Same lock shape as `PostgresLedger.post`: the singleton tip, joined to the
 * freeze row so the kill-switch is not itself locked, `FOR UPDATE OF t`.
 * Seq comes back as text so a JS number never becomes the anchor.
 */
async function lockChainTip(tx: Sql): Promise<LockedChainTip> {
  const tipRows = await tx<Array<{ hash: string | null; seq: string; frozen: boolean; reason: string | null }>>`
    SELECT t.hash, t.seq::text AS seq, f.frozen, f.reason
      FROM chain_tip t, posting_freeze f
     WHERE t.id = true AND f.id = true
       FOR UPDATE OF t
  `;
  const tip = tipRows[0];
  if (!tip) {
    throw new LedgerError('chain_tip / posting_freeze row is missing — the ledger is not initialised', 'ledger.uninitialised');
  }
  if (typeof tip.seq !== 'string') {
    throw new LedgerError('chain_tip.seq arrived as a non-text value — refusing to anchor a snapshot on it', 'ledger.uninitialised');
  }
  if (tip.hash !== null && typeof tip.hash !== 'string') {
    throw new LedgerError('chain_tip.hash arrived as a non-text value — refusing to anchor a snapshot on it', 'ledger.uninitialised');
  }
  return { seq: tip.seq, hash: tip.hash };
}

/**
 * Balances are copied from `accounts.balance`. as_of is this statement's
 * timestamp, which runs only after `lockChainTip`. `now()` would be the
 * transaction start, before that lock. A Date defaulted at the call is the
 * same class of early stamp.
 */
async function insertAnchoredSnapshots(tx: Sql, tip: LockedChainTip): Promise<number> {
  const result = await tx`
    INSERT INTO balance_snapshots (account_id, as_of, balance, chain_tip_seq, chain_tip_hash)
    SELECT id, statement_timestamp(), balance, ${tip.seq}::bigint, ${tip.hash}
      FROM accounts
  `;
  return result.count;
}

/**
 * Hourly anchor so a future replay does not have to start from genesis.
 * The tip lock is held from before the balance read until this transaction commits.
 */
export async function writeSnapshots(sql: Sql): Promise<number> {
  return transaction(
    sql,
    async (tx) => {
      const tip = await lockChainTip(tx);
      return insertAnchoredSnapshots(tx, tip);
    },
    { isolation: 'read committed' },
  );
}

export interface ReconciliationReport {
  readonly ok: boolean;
  readonly ranAt: Date;
  readonly balances: ReconcileResult;
  readonly chain: ChainResult;
  readonly totals: Record<string, string>;
  /** Assets that do not net to zero — the most serious failure possible. */
  readonly unbalancedAssets: string[];
}

/**
 * The full run. Scheduled hourly; also runnable on demand from apps/admin when
 * an operator wants to prove the book is intact before, say, a treasury move.
 */
export async function runReconciliation(sql: Sql): Promise<ReconciliationReport> {
  const [balances, chain, totals] = await Promise.all([reconcileBalances(sql), verifyChain(sql), totalsByAsset(sql)]);
  const unbalancedAssets = Object.entries(totals)
    .filter(([, total]) => total !== '0')
    .map(([asset]) => asset);

  return {
    ok: balances.ok && chain.ok && unbalancedAssets.length === 0,
    ranAt: new Date(),
    balances,
    chain,
    totals,
    unbalancedAssets,
  };
}

/**
 * Hourly job. Prove the book FIRST. A broken book is never snapshotted —
 * writing the drifted cache as an "anchor" would heal the break as success
 * the next time replay started from snapshots.
 *
 * The tip lock is taken before that proof and released only when this
 * transaction ends. On success that is after the snapshot insert commits, so
 * a post — which needs the same row — cannot land in the gap and be recorded
 * as the anchor. On failure the insert is skipped and the lock drops with
 * the transaction.
 */
export async function runScheduledReconciliation(
  sql: Sql,
  ledger: { reconcile(): Promise<ReconciliationReport> },
  snapshot: (tx: Sql, tip: LockedChainTip) => Promise<number> = insertAnchoredSnapshots,
): Promise<{ report: ReconciliationReport; snapshotted: boolean }> {
  return transaction(
    sql,
    async (tx) => {
      const tip = await lockChainTip(tx);
      const report = await ledger.reconcile();
      if (!report.ok) return { report, snapshotted: false };
      await snapshot(tx, tip);
      return { report, snapshotted: true };
    },
    { isolation: 'read committed' },
  );
}
