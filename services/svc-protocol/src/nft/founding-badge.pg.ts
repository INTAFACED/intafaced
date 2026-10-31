import type { Sql } from 'postgres';
import { getAddress as toChecksum } from 'viem';
import type { Address, Hex } from 'viem';
import type { ChainIdentity } from '../chain/identity.js';
import {
  BADGE_ALREADY_CLAIMED,
  BadgeRefusedError,
  type BadgeClaimRecord,
  type BadgeStore,
  type BadgeStuckMintAudit,
  type BadgeStuckMintEvidence,
} from './founding-badge.js';

/** Postgres `BadgeStore` over `protocol.founding_badge_list` and `protocol.founding_badge_claims` (0001, 0002, 20261031001739). */
type Row = {
  key: string;
  account_id: string;
  chain_id: number;
  genesis_hash: string | null;
  to_address: string;
  tx_hash: string | null;
  minting_at: Date | null;
};

function toRecord(r: Row): BadgeClaimRecord {
  return {
    key: r.key,
    accountId: r.account_id,
    chainId: r.chain_id,
    genesisHash: (r.genesis_hash as Hex | null) ?? null,
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
      SELECT key, account_id, chain_id, genesis_hash, to_address, tx_hash, minting_at FROM protocol.founding_badge_claims WHERE key = ${key}`;
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findClaimByAddress(chain: ChainIdentity, to: Address): Promise<BadgeClaimRecord | null> {
    // This chain's claim, or one stored before the genesis column (it cannot be placed, so it keeps its meaning).
    const rows = await this.sql<Row[]>`
      SELECT key, account_id, chain_id, genesis_hash, to_address, tx_hash, minting_at FROM protocol.founding_badge_claims
      WHERE chain_id = ${chain.chainId} AND to_address = ${toChecksum(to)}
        AND (genesis_hash IS NULL OR genesis_hash = ${chain.genesisHash})`;
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async putClaim(record: BadgeClaimRecord): Promise<BadgeClaimRecord> {
    try {
      await this.sql`
        INSERT INTO protocol.founding_badge_claims (key, account_id, chain_id, genesis_hash, to_address, tx_hash)
        VALUES (${record.key}, ${record.accountId}, ${record.chainId}, ${record.genesisHash ?? null}, ${toChecksum(record.to)},
                ${record.txHash})
        ON CONFLICT (key) DO UPDATE SET
          chain_id = EXCLUDED.chain_id, genesis_hash = EXCLUDED.genesis_hash, to_address = EXCLUDED.to_address,
          tx_hash = NULL, minting_at = NULL, updated_at = now()
        -- Only a claim from another genesis is replaced: its mint did not happen on this chain. This chain's claim, and one
        -- stored before the column, are kept as they are.
        WHERE founding_badge_claims.genesis_hash IS NOT NULL AND EXCLUDED.genesis_hash IS NOT NULL
          AND founding_badge_claims.genesis_hash <> EXCLUDED.genesis_hash`;
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

  async clearStuckMint(
    key: string,
    evidence: BadgeStuckMintEvidence,
    audit: BadgeStuckMintAudit,
    staleBefore: Date,
  ): Promise<BadgeClaimRecord | null> {
    // One transaction: the clear and its audit row (0002) land together or not at all.
    return this.sql.begin(async (tx) => {
      const txHash = evidence.kind === 'minted' ? evidence.txHash : null;
      const rows = await tx<Row[]>`
        UPDATE protocol.founding_badge_claims SET tx_hash = COALESCE(${txHash}, tx_hash), minting_at = NULL, updated_at = now()
        WHERE key = ${key} AND tx_hash IS NULL AND minting_at IS NOT NULL AND minting_at <= ${staleBefore}
        RETURNING key, account_id, chain_id, genesis_hash, to_address, tx_hash, minting_at`;
      if (!rows[0]) return null;
      await tx`
        INSERT INTO protocol.founding_badge_mint_clears
          (key, evidence_kind, tx_hash, attested_by, checked_at, reason, actor_id, requester_id, approver_id, approval_id)
        VALUES (${key}, ${evidence.kind}, ${txHash}, ${evidence.kind === 'not_minted' ? evidence.attestedBy.trim() : null},
          ${evidence.kind === 'not_minted' ? evidence.checkedAt : null}, ${audit.reason}, ${audit.actorId}, ${audit.requesterId},
          ${audit.approverId}, ${audit.approvalId})`;
      return toRecord(rows[0]);
    }) as Promise<BadgeClaimRecord | null>;
  }

  async setTxHash(key: string, txHash: Hex): Promise<BadgeClaimRecord> {
    const rows = await this.sql<Row[]>`
      UPDATE protocol.founding_badge_claims SET tx_hash = COALESCE(tx_hash, ${txHash}), minting_at = NULL, updated_at = now()
      WHERE key = ${key} RETURNING key, account_id, chain_id, genesis_hash, to_address, tx_hash, minting_at`;
    if (!rows[0]) throw new Error('protocol.founding_badge_claims update found no row');
    return toRecord(rows[0]);
  }
}
