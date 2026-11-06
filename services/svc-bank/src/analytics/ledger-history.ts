import type { AccountRef, Amount, LedgerTx, MemoryLedger } from '@intafaced/ledger-client';

/**
 * READ PORT over the ledger's transaction history.
 *
 * Spend analytics is a PROJECTION. §8.1 gives svc-bank "views + rails", and a
 * spend breakdown is the clearest case of a view: it is derived, on demand,
 * from movements that already exist in the book. The alternative — svc-bank
 * maintaining its own `spent_this_month` counters, updated on every event —
 * would be a second source of truth for money in everything but name, and would
 * be wrong the first time an event was replayed or missed.
 *
 * The `LedgerClient` interface does not expose history (it exposes balances and
 * single-transaction lookups), so svc-bank declares the narrow read it needs
 * here rather than widening a shared interface every service would then have to
 * implement.
 *
 * §13 SOCKET: the production adapter needs a `ledger.history` procedure on
 * svc-ledger, which is a `packages/contracts` + svc-ledger change (it may land
 * in the journey's PR; AGENTS.md "Services and events" 1).
 * `HttpLedgerHistory` in `../ledger-client.ts` is written against that shape and
 * fails loudly rather than returning an empty answer if it is not there yet — an
 * analytics view that silently reports zero spending is worse than one that is
 * unavailable.
 */

export interface LedgerEntryRecord {
  readonly txId: string;
  readonly module: string;
  /** e.g. 'trade.fill', 'bank.transfer.scheduled', 'fee.charged'. */
  readonly reason: string;
  /** Debit increases the account, credit decreases it (§4.2). */
  readonly direction: 'debit' | 'credit';
  readonly amount: Amount;
  readonly postedAt: Date;
}

export interface HistoryRange {
  readonly from: Date;
  /** Exclusive, so consecutive windows neither overlap nor drop a movement. */
  readonly to: Date;
}

export interface LedgerHistory {
  entriesFor(account: AccountRef, range: HistoryRange): Promise<LedgerEntryRecord[]>;
}

/**
 * Reference adapter over `MemoryLedger`.
 *
 * The same reasoning that makes `MemoryLedger` legitimate in svc-token's tests
 * applies here: it is the executable specification of §4.2, proven equivalent to
 * svc-ledger's Postgres engine by the conformance suite. An adapter over its
 * journal is therefore a real implementation of this port, not a stub.
 */
export function memoryLedgerHistory(ledger: MemoryLedger): LedgerHistory {
  return {
    async entriesFor(account: AccountRef, range: HistoryRange): Promise<LedgerEntryRecord[]> {
      // Resolve the account id once. `balance()` is the only way to get it
      // without reaching into the ledger's internals, which is correct — the
      // account id is svc-ledger's, not ours.
      const { accountId } = await ledger.balance(account);
      const out: LedgerEntryRecord[] = [];

      for (const tx of ledger.journal() as LedgerTx[]) {
        if (tx.postedAt < range.from || tx.postedAt >= range.to) continue;
        for (const entry of tx.entries) {
          if (entry.accountId !== accountId) continue;
          out.push({
            txId: tx.id,
            module: tx.module,
            reason: tx.reason,
            direction: entry.direction,
            amount: entry.amount,
            postedAt: tx.postedAt,
          });
        }
      }

      return out;
    },
  };
}
