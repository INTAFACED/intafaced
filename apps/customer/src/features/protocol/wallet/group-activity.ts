import { formatUnits } from 'viem';
import type { ExplorerAddressTxsPage } from '../explorer/explorer-api';
import { shortAddress } from './eip1193';

type IndexedRow = ExplorerAddressTxsPage['rows'][number];

export interface GroupMemberRead {
  /** The wallet's address and the name the group shows for it. */
  address: string;
  name: string;
  rows: readonly IndexedRow[];
}

export interface GroupActivityRow {
  hash: string;
  time: number;
  /** The group's wallets this transaction touched, in the group's order. */
  wallets: string[];
  what: string;
  status: 'confirmed' | 'failed';
}

/**
 * The group's combined activity (D-portfolio-wallet-03): every transaction our indexer read for any wallet of the group,
 * newest first. A transaction between two wallets of the group is one row naming both, never two. Each transfer says
 * which wallet of the group sent or received it, since "you" is several wallets here.
 */
export function groupActivityRows(
  reads: readonly GroupMemberRead[],
  words: { sent: (wallet: string) => string; received: (wallet: string) => string; call: string },
): GroupActivityRow[] {
  const byHash = new Map<string, { row: IndexedRow; wallets: string[]; transfers: string[] }>();
  for (const read of reads) {
    for (const row of read.rows) {
      const key = row.hash.toLowerCase();
      const entry = byHash.get(key) ?? { row, wallets: [], transfers: [] };
      if (!entry.wallets.includes(read.name)) entry.wallets.push(read.name);
      for (const transfer of row.transfers) {
        const amount = transfer.token.decimals === null ? transfer.amount : formatUnits(BigInt(transfer.amount), transfer.token.decimals);
        const token = transfer.token.symbol ?? shortAddress(transfer.token.address);
        const who = transfer.direction === 'in' ? words.received(read.name) : words.sent(read.name);
        entry.transfers.push(`${who} ${amount} ${token}`);
      }
      byHash.set(key, entry);
    }
  }
  return [...byHash.entries()]
    .map(([hash, { row, wallets, transfers }]) => ({
      hash,
      time: row.timestamp,
      wallets,
      what: transfers.length > 0 ? transfers.join('; ') : words.call,
      status: row.status === 'success' ? ('confirmed' as const) : ('failed' as const),
    }))
    .sort((a, b) => b.time - a.time || (a.hash < b.hash ? -1 : 1));
}
