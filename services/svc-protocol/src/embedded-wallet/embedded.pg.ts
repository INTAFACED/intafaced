import type { Sql } from 'postgres';
import type { EmbeddedWalletProviderId } from '@intafaced/contracts/protocol-embedded-wallet';
import { getAddress } from 'viem';
import { EMBEDDED_WALLET_MISMATCH, EmbeddedWalletRefusedError, type EmbeddedWalletRow, type EmbeddedWalletStore } from './embedded.js';

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
    // Only the person's own key is a replay. The same provider wallet already recorded for someone else is a unique
    // violation on (provider, provider_wallet_id), refused by name: it is never another person's wallet to record.
    let inserted: Row | undefined;
    try {
      [inserted] = await this.sql<Row[]>`
      INSERT INTO protocol.embedded_wallets (idempotency_key, user_id, provider, provider_wallet_id, address, test, created_at)
      VALUES (${input.idempotencyKey}, ${input.userId}, ${input.provider}, ${input.providerWalletId}, ${getAddress(input.address)},
              ${input.test}, ${input.createdAt.toISOString()})
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING user_id, idempotency_key, provider, provider_wallet_id, address, test, created_at`;
    } catch (err) {
      if ((err as { code?: string; constraint_name?: string }).constraint_name === 'embedded_wallets_provider_wallet_idx')
        throw new EmbeddedWalletRefusedError(
          EMBEDDED_WALLET_MISMATCH,
          'Your wallet provider returned a wallet already recorded for someone else, so nothing was recorded.',
        );
      throw err;
    }
    if (inserted) return { row: toRow(inserted), created: true };
    const existing = await this.find(input.userId);
    if (!existing) throw new Error('protocol.embedded_wallets refused the row but holds none for this person');
    return { row: existing, created: false };
  }
}
