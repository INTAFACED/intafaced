import type { Sql } from 'postgres';
import { getAddress as toChecksum } from 'viem';
import type { Address, Hex } from 'viem';
import {
  BADGE_ALREADY_CLAIMED,
  BadgeRefusedError,
  type BadgeClaimRecord,
  type BadgeStore,
  type BadgeStuckMintEvidence,
} from './founding-badge.js';

/** Postgres `BadgeStore` over `protocol.founding_badge_list` and `protocol.founding_badge_claims` (0001). */
type Row = { key: string; account_id: string; chain_id: number; to_address: string; tx_hash: string | null; minting_at: Date | null };

function toRecord(r: Row): BadgeClaimRecord {
  return {
    key: r.key,
    accountId: r.account_id,
    chainId: r.chain_id,
    to: toChecksum(r.to_address),
    txHash: (r.tx_hash as Hex | null) ?? null,
    mintingSince: r.minting_at ?? null,
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
      SELECT key, account_id, chain_id, to_address, tx_hash, minting_at FROM protocol.founding_badge_claims WHERE key = ${key}`;
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findClaimByAddress(chainId: number, to: Address): Promise<BadgeClaimRecord | null> {
    const rows = await this.sql<Row[]>`
      SELECT key, account_id, chain_id, to_address, tx_hash, minting_at FROM protocol.founding_badge_claims
      WHERE chain_id = ${chainId} AND to_address = ${toChecksum(to)}`;
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async putClaim(record: BadgeClaimRecord): Promise<BadgeClaimRecord> {
    try {
      await this.sql`
        INSERT INTO protocol.founding_badge_claims (key, account_id, chain_id, to_address, tx_hash)
        VALUES (${record.key}, ${record.accountId}, ${record.chainId}, ${toChecksum(record.to)}, ${record.txHash})
        ON CONFLICT (key) DO NOTHING`;
    } catch (err) {
      // Two accounts racing to one address: the loser hits the unique address index; that is already_claimed, not a 500.
      const e = err as { code?: string; constraint_name?: string };
      if (e.code === '23505' && e.constraint_name === 'founding_badge_claims_chain_address_idx') {
        throw new BadgeRefusedError(BADGE_ALREADY_CLAIMED, 'a founding badge was already claimed to this address');
      }
      throw err;
    }
    const stored = await this.findClaim(record.key);
    if (!stored) throw new Error('protocol.founding_badge_claims insert returned no row');
    return stored;
  }

  async claimMintSlot(key: string): Promise<boolean> {
    const rows = await this.sql`
      UPDATE protocol.founding_badge_claims SET minting_at = now(), updated_at = now()
      WHERE key = ${key} AND tx_hash IS NULL AND minting_at IS NULL RETURNING key`;
    return rows.length === 1;
  }

  async releaseMintSlot(key: string): Promise<void> {
    await this.sql`
      UPDATE protocol.founding_badge_claims SET minting_at = NULL, updated_at = now()
      WHERE key = ${key} AND tx_hash IS NULL`;
  }

  async clearStuckMint(key: string, evidence: BadgeStuckMintEvidence): Promise<BadgeClaimRecord | null> {
    const rows =
      evidence.kind === 'minted'
        ? await this.sql<Row[]>`
            UPDATE protocol.founding_badge_claims SET tx_hash = ${evidence.txHash}, minting_at = NULL, updated_at = now()
            WHERE key = ${key} AND tx_hash IS NULL AND minting_at IS NOT NULL
            RETURNING key, account_id, chain_id, to_address, tx_hash, minting_at`
        : await this.sql<Row[]>`
            UPDATE protocol.founding_badge_claims SET minting_at = NULL, updated_at = now()
            WHERE key = ${key} AND tx_hash IS NULL AND minting_at IS NOT NULL
            RETURNING key, account_id, chain_id, to_address, tx_hash, minting_at`;
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async setTxHash(key: string, txHash: Hex): Promise<BadgeClaimRecord> {
    const rows = await this.sql<Row[]>`
      UPDATE protocol.founding_badge_claims SET tx_hash = COALESCE(tx_hash, ${txHash}), minting_at = NULL, updated_at = now()
      WHERE key = ${key} RETURNING key, account_id, chain_id, to_address, tx_hash, minting_at`;
    if (!rows[0]) throw new Error('protocol.founding_badge_claims update found no row');
    return toRecord(rows[0]);
  }
}
