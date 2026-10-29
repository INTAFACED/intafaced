import type { Sql } from 'postgres';
import { getAddress as toChecksum, type Address } from 'viem';
import type { ListingChallenge, ListingStore, OwnershipProof } from './ownership.js';

/** Postgres `ListingStore` over `protocol.listing_challenges` and `protocol.listing_ownership_proofs` (20261029070000). */
type ChallengeRow = {
  nonce: string;
  chain_id: number;
  token: string;
  message: string;
  issued_at: Date | string;
  expires_at: Date | string;
  used_at: Date | string | null;
};

export class PostgresListingStore implements ListingStore {
  constructor(private readonly sql: Sql) {}

  async putChallenge(challenge: Omit<ListingChallenge, 'usedAt'>): Promise<void> {
    await this.sql`
      INSERT INTO protocol.listing_challenges (nonce, chain_id, token, message, issued_at, expires_at)
      VALUES (${challenge.nonce}, ${challenge.chainId}, ${toChecksum(challenge.token)}, ${challenge.message},
              ${challenge.issuedAt.toISOString()}, ${challenge.expiresAt.toISOString()})`;
  }

  async findChallenge(nonce: string): Promise<ListingChallenge | null> {
    const rows = await this.sql<ChallengeRow[]>`
      SELECT nonce, chain_id, token, message, issued_at, expires_at, used_at FROM protocol.listing_challenges
      WHERE nonce = ${nonce}`;
    const r = rows[0];
    if (!r) return null;
    // The service's client is shared with drizzle, which reads timestamps back as text.
    return {
      nonce: r.nonce,
      chainId: r.chain_id,
      token: toChecksum(r.token) as Address,
      message: r.message,
      issuedAt: new Date(r.issued_at),
      expiresAt: new Date(r.expires_at),
      usedAt: r.used_at === null ? null : new Date(r.used_at),
    };
  }

  async consume(nonce: string, usedAt: Date, proof: Omit<OwnershipProof, 'verifiedAt'>): Promise<boolean> {
    // One transaction: the nonce is spent and the proof stored together, and only by the first verify to spend it.
    return this.sql.begin(async (tx) => {
      const spent = await tx`
        UPDATE protocol.listing_challenges SET used_at = ${usedAt.toISOString()}
        WHERE nonce = ${nonce} AND used_at IS NULL
        RETURNING nonce`;
      if (spent.length === 0) return false;
      await tx`
        INSERT INTO protocol.listing_ownership_proofs
          (nonce, chain_id, token, signer, message_hash, signature, block_number, verified_at)
        VALUES (${proof.nonce}, ${proof.chainId}, ${toChecksum(proof.token)}, ${toChecksum(proof.signer)}, ${proof.messageHash},
                ${proof.signature}, ${proof.blockNumber.toString()}, ${usedAt.toISOString()})`;
      return true;
    });
  }
}
