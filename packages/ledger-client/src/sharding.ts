import { createHash } from 'node:crypto';
import { formatAmount, type Amount } from './money.js';
import type { LedgerTx, PostedEntry } from './types.js';

/** The socket is deliberately opt-in until the durable service path is ready. */
export class LedgerShardUnwiredError extends Error {
  readonly code = 'ledger.shard_unwired';

  constructor() {
    super('Per-asset ledger hash-chain sharding is not wired in this deployment');
    this.name = 'LedgerShardUnwiredError';
  }
}

export function assertLedgerShardingEnabled(enabled = false): void {
  if (!enabled) throw new LedgerShardUnwiredError();
}

export interface AssetHashInput {
  readonly id: string;
  readonly module: string;
  readonly reason: string;
  readonly postedAt: Date;
  readonly entries: readonly PostedEntry[];
}

/** Hash only one asset's entries. Asset IDs are part of the domain separator. */
export function hashAssetTx(tx: AssetHashInput, assetId: string, previousHash: string | null): string {
  const entries = tx.entries
    .filter((entry) => entry.assetId === assetId)
    .map((entry) => ({
      accountId: entry.accountId,
      assetId: entry.assetId,
      direction: entry.direction,
      amount: formatAmount(entry.amount as Amount),
      balanceAfter: formatAmount(entry.balanceAfter as Amount),
    }));
  const canonical = JSON.stringify({
    assetId,
    id: tx.id,
    module: tx.module,
    reason: tx.reason,
    postedAt: tx.postedAt.toISOString(),
    entries,
  });
  return createHash('sha256')
    .update('ledger-asset-shard\0')
    .update(previousHash ?? '')
    .update('\0')
    .update(canonical)
    .digest('hex');
}

/** Golden, order-independent anchor for all shard tips at one commit point. */
export function crossShardAnchor(tips: Readonly<Record<string, string>>): string {
  const canonical = JSON.stringify(
    Object.keys(tips)
      .sort()
      .map((assetId) => [assetId, tips[assetId]]),
  );
  return createHash('sha256').update('ledger-cross-shard-anchor\0').update(canonical).digest('hex');
}

export function assetIds(tx: Pick<LedgerTx, 'entries'>): string[] {
  return [...new Set(tx.entries.map((entry) => entry.assetId))].sort();
}
