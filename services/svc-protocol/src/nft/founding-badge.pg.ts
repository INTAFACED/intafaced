import type { Sql } from 'postgres';
import { getAddress as toChecksum } from 'viem';
import type { Address, Hex } from 'viem';
import type { BadgeClaimRecord, BadgeStore } from './founding-badge.js';

/** Postgres `BadgeStore` over `protocol.founding_badge_list` and `protocol.founding_badge_claims` (0001). */
type Row = { key: string; account_id: string; chain_id: number; to_address: string; tx_hash: string | null };

function toRecord(r: Row): BadgeClaimRecord {
  return {
    key: r.key,
    accountId: r.account_id,
    chainId: r.chain_id,
    to: toChecksum(r.to_address),
    txHash: (r.tx_hash as Hex | null) ?? null,
  };
}

export class PostgresBadgeStore implements BadgeStore {
  constructor(private readonly sql: Sql) {}

  async isListed(accountId: string): Promise<boolean> {
    const rows = await this.sql`SELECT 1 FROM protocol.founding_badge_list WHERE account_id = ${accountId} LIMIT 1`;
    return rows.length > 0;
  }

  async findClaim(key: string): Promise<BadgeClaimRecord | null> {
    const rows = await this.sql<Row[]>`
      SELECT key, account_id, chain_id, to_address, tx_hash FROM protocol.founding_badge_claims WHERE key = ${key}`;
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findClaimByAddress(chainId: number, to: Address): Promise<BadgeClaimRecord | null> {
    const rows = await this.sql<Row[]>`
      SELECT key, account_id, chain_id, to_address, tx_hash FROM protocol.founding_badge_claims
      WHERE chain_id = ${chainId} AND to_address = ${toChecksum(to)}`;
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async putClaim(record: BadgeClaimRecord): Promise<BadgeClaimRecord> {
    await this.sql`
      INSERT INTO protocol.founding_badge_claims (key, account_id, chain_id, to_address, tx_hash)
      VALUES (${record.key}, ${record.accountId}, ${record.chainId}, ${toChecksum(record.to)}, ${record.txHash})
      ON CONFLICT (key) DO NOTHING`;
    const stored = await this.findClaim(record.key);
    if (!stored) throw new Error('protocol.founding_badge_claims insert returned no row');
    return stored;
  }

  async setTxHash(key: string, txHash: Hex): Promise<BadgeClaimRecord> {
    const rows = await this.sql<Row[]>`
      UPDATE protocol.founding_badge_claims SET tx_hash = COALESCE(tx_hash, ${txHash}), updated_at = now()
      WHERE key = ${key} RETURNING key, account_id, chain_id, to_address, tx_hash`;
    if (!rows[0]) throw new Error('protocol.founding_badge_claims update found no row');
    return toRecord(rows[0]);
  }
}
