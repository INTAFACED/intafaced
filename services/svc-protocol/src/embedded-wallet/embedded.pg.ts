import type { Sql } from 'postgres';
import type { EmbeddedWalletProviderId } from '@intafaced/contracts/protocol-embedded-wallet';
import { getAddress } from 'viem';
import type { EmbeddedWalletRow, EmbeddedWalletStore } from './embedded.js';

/**
 * Postgres `EmbeddedWalletStore` over `protocol.embedded_wallets` (20261109084145). The business key
 * `wallet:embedded:<personId>` is the primary key: a second insert for the same person writes nothing and the first row
 * comes back. The table has no key and no passkey column.
 */
type Row = {
  user_id: string;
  idempotency_key: string;
  provider: string;
  provider_wallet_id: string;
  address: string;
  test: boolean;
  created_at: Date | string;
};

const toRow = (r: Row): EmbeddedWalletRow => ({
  userId: r.user_id,
  idempotencyKey: r.idempotency_key,
  provider: r.provider as EmbeddedWalletProviderId,
  providerWalletId: r.provider_wallet_id,
  address: getAddress(r.address),
  test: r.test,
  createdAt: new Date(r.created_at),
});

export class PostgresEmbeddedWalletStore implements EmbeddedWalletStore {
  constructor(private readonly sql: Sql) {}

  async find(userId: string): Promise<EmbeddedWalletRow | null> {
    const [row] = await this.sql<Row[]>`
      SELECT user_id, idempotency_key, provider, provider_wallet_id, address, test, created_at
      FROM protocol.embedded_wallets WHERE user_id = ${userId}`;
    return row ? toRow(row) : null;
  }

  async insert(input: EmbeddedWalletRow): Promise<{ row: EmbeddedWalletRow; created: boolean }> {
    const [inserted] = await this.sql<Row[]>`
      INSERT INTO protocol.embedded_wallets (idempotency_key, user_id, provider, provider_wallet_id, address, test, created_at)
      VALUES (${input.idempotencyKey}, ${input.userId}, ${input.provider}, ${input.providerWalletId}, ${getAddress(input.address)},
              ${input.test}, ${input.createdAt.toISOString()})
      ON CONFLICT DO NOTHING
      RETURNING user_id, idempotency_key, provider, provider_wallet_id, address, test, created_at`;
    if (inserted) return { row: toRow(inserted), created: true };
    const existing = await this.find(input.userId);
    if (!existing) throw new Error('protocol.embedded_wallets refused the row but holds none for this person');
    return { row: existing, created: false };
  }
}
