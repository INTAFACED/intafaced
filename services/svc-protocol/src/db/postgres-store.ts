import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { getAddress as toChecksum } from 'viem';
import type { Address, Hex } from 'viem';
import { smartAccounts, type SmartAccountRow } from './schema.js';
import { assertMyAccountsListLimit } from '../accounts/my-accounts-list-limit.js';
import type { AccountRecord, AccountStore, AccountUpsert } from '../accounts/registry.js';

/**
 * The read model, in Postgres.
 *
 * Thin on purpose: every decision this registry makes lives in
 * `accounts/registry.ts`, which is testable without a database. What is left
 * here is storage.
 */
type Schema = { smartAccounts: typeof smartAccounts };

function toRecord(row: SmartAccountRow): AccountRecord {
  return {
    id: row.id,
    userId: row.userId,
    chainId: row.chainId,
    address: toChecksum(row.address),
    owner: toChecksum(row.owner),
    userSalt: row.userSalt as Hex,
    deployed: row.deployed,
    deployedGenesisHash: (row.deployedGenesisHash as Hex | null) ?? null,
    verifiedAt: row.verifiedAt ?? null,
  };
}

export class PostgresAccountStore implements AccountStore {
  constructor(private readonly db: PostgresJsDatabase<Schema>) {}

  async upsert(record: AccountUpsert): Promise<AccountRecord> {
    const [row] = await this.db
      .insert(smartAccounts)
      .values({
        userId: record.userId,
        chainId: record.chainId,
        address: record.address,
        owner: record.owner,
        userSalt: record.userSalt,
        deployed: record.deployed,
        deployedGenesisHash: record.deployed ? (record.deployedGenesisHash ?? null) : null,
        verifiedAt: record.verifiedAt,
      })
      .onConflictDoUpdate({
        target: [smartAccounts.chainId, smartAccounts.address],
        set: {
          userId: record.userId,
          deployed: record.deployed,
          deployedGenesisHash: record.deployed ? (record.deployedGenesisHash ?? null) : null,
          verifiedAt: record.verifiedAt,
          updatedAt: new Date(),
        },
      })
      .returning();

    if (!row) throw new Error('protocol.smart_accounts upsert returned no row');
    return toRecord(row);
  }

  async findByUser(userId: string, chainId: number, limit: number): Promise<AccountRecord[]> {
    const published = assertMyAccountsListLimit(limit);
    const rows = await this.db
      .select()
      .from(smartAccounts)
      .where(and(eq(smartAccounts.userId, userId), eq(smartAccounts.chainId, chainId)))
      .limit(published);
    return rows.map(toRecord);
  }

  async findByAddress(chainId: number, address: Address): Promise<AccountRecord | null> {
    const [row] = await this.db
      .select()
      .from(smartAccounts)
      .where(and(eq(smartAccounts.chainId, chainId), eq(smartAccounts.address, toChecksum(address))))
      .limit(1);
    return row ? toRecord(row) : null;
  }

  async markDeployed(chainId: number, address: Address, at: Date, genesisHash: Hex | null): Promise<void> {
    await this.db
      .update(smartAccounts)
      .set({ deployed: true, deployedAt: at, deployedGenesisHash: genesisHash, updatedAt: new Date() })
      .where(and(eq(smartAccounts.chainId, chainId), eq(smartAccounts.address, toChecksum(address))));
  }
}
