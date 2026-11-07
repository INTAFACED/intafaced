import type { Sql } from 'postgres';
import { getAddress, type Address, type Hex } from 'viem';
import type { EmbeddedExportStore } from './exports.js';

/** Postgres `EmbeddedExportStore` over `protocol.embedded_exports` (20261107093603). A repeat keeps the first row. */
export class PostgresEmbeddedExportStore implements EmbeddedExportStore {
  constructor(private readonly sql: Sql) {}

  async find(chainId: number, account: Address) {
    const rows = await this.sql<{ exported_at: Date | string }[]>`
      SELECT exported_at FROM protocol.embedded_exports WHERE chain_id = ${chainId} AND account = ${getAddress(account)}`;
    // The service's client is shared with drizzle, which reads timestamps back as text.
    return rows[0] ? { exportedAt: new Date(rows[0].exported_at) } : null;
  }

  async put(chainId: number, account: Address, signature: Hex) {
    await this.sql`
      INSERT INTO protocol.embedded_exports (chain_id, account, signature) VALUES (${chainId}, ${getAddress(account)}, ${signature})
      ON CONFLICT (chain_id, account) DO NOTHING`;
    const row = await this.find(chainId, account);
    if (!row) throw new Error('protocol.embedded_exports insert returned no row');
    return row;
  }
}
