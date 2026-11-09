import type { Sql } from 'postgres';
import { getAddress as toChecksum, type Address } from 'viem';
import { venueConnectKey, type NewVenueConnection, type VenueConnectionRecord, type VenueConnectionStore } from './connection.js';

/**
 * Postgres `VenueConnectionStore` over `protocol.venue_wallet_connections` and `protocol.venue_wallet_nonces`
 * (20261108194447). Opening spends the nonce under its business key and writes the connection in one transaction: a nonce
 * already spent writes nothing, and the unique index on person, chain and wallet makes a second connect renew the row.
 */
type Row = {
  user_id: string;
  chain_id: number;
  address: string;
  connected_at: Date | string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
};

// The service's client is shared with drizzle, which reads timestamps back as text and takes them as text.
const at = (value: Date | string) => new Date(value);
const toRecord = (r: Row): VenueConnectionRecord => ({
  userId: r.user_id,
  chainId: r.chain_id,
  address: toChecksum(r.address),
  connectedAt: at(r.connected_at),
  expiresAt: at(r.expires_at),
  revokedAt: r.revoked_at === null ? null : at(r.revoked_at),
});

export class PostgresVenueConnectionStore implements VenueConnectionStore {
  constructor(private readonly sql: Sql) {}

  async open(input: NewVenueConnection): Promise<VenueConnectionRecord | null> {
    const address = toChecksum(input.address.toLowerCase() as Address);
    return this.sql.begin(async (tx) => {
      const spent = await tx<Array<{ idempotency_key: string }>>`
        INSERT INTO protocol.venue_wallet_nonces (idempotency_key, user_id, address)
        VALUES (${venueConnectKey(input.chainId, input.nonce)}, ${input.userId}, ${address})
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING idempotency_key`;
      if (spent.length === 0) return null;
      const [row] = await tx<Row[]>`
        INSERT INTO protocol.venue_wallet_connections (user_id, chain_id, address, connected_at, expires_at, nonce)
        VALUES (${input.userId}, ${input.chainId}, ${address}, ${input.connectedAt.toISOString()}, ${input.expiresAt.toISOString()}, ${input.nonce})
        ON CONFLICT (user_id, chain_id, lower(address)) DO UPDATE SET
          address = EXCLUDED.address,
          connected_at = EXCLUDED.connected_at,
          expires_at = EXCLUDED.expires_at,
          nonce = EXCLUDED.nonce,
          revoked_at = NULL,
          updated_at = now()
        RETURNING user_id, chain_id, address, connected_at, expires_at, revoked_at`;
      if (!row) throw new Error('protocol.venue_wallet_connections upsert returned no row');
      return toRecord(row);
    });
  }

  async list(userId: string, chainId: number): Promise<VenueConnectionRecord[]> {
    const rows = await this.sql<Row[]>`
      SELECT user_id, chain_id, address, connected_at, expires_at, revoked_at FROM protocol.venue_wallet_connections
      WHERE user_id = ${userId} AND chain_id = ${chainId} AND revoked_at IS NULL ORDER BY connected_at DESC`;
    return rows.map(toRecord);
  }

  async find(userId: string, chainId: number, address: Address): Promise<VenueConnectionRecord | null> {
    const [row] = await this.sql<Row[]>`
      SELECT user_id, chain_id, address, connected_at, expires_at, revoked_at FROM protocol.venue_wallet_connections
      WHERE user_id = ${userId} AND chain_id = ${chainId} AND lower(address) = ${address.toLowerCase()}`;
    return row ? toRecord(row) : null;
  }

  async revoke(userId: string, chainId: number, address: Address, when: Date): Promise<boolean> {
    const rows = await this.sql<Array<{ id: string }>>`
      UPDATE protocol.venue_wallet_connections SET revoked_at = ${when.toISOString()}, updated_at = now()
      WHERE user_id = ${userId} AND chain_id = ${chainId} AND lower(address) = ${address.toLowerCase()} AND revoked_at IS NULL
      RETURNING id`;
    return rows.length > 0;
  }
}
