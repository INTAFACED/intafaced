import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryBroadcastStore } from '../../rails/broadcast-store.js';
import { TestnetDepositAddresses } from '../../rails/deposit-source.js';
import { parseEvmAssets } from '../../rails/evm-assets.js';
import { EvmLiveChain } from '../../rails/evm-chain.js';
import { TestnetSigner } from '../../rails/evm-signer.js';
import { restoreOpenDepositWatches } from '../../rails/watch-restore.js';
import { CustodyDepositService } from './service.js';
import { listIssuedDepositWatches } from './watches.js';

/** A restart must keep watching the addresses already issued to customers. Real Postgres; TEST chain and phrase only. */
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));
const MNEMONIC = 'test test test test test test test test test test test junk';
const HOT_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const mk = () =>
  new EvmLiveChain({
    rpcUrl: 'http://127.0.0.1:9',
    chainId: 31337,
    deposits: TestnetDepositAddresses.fromFixturePhrase(MNEMONIC),
    signer: TestnetSigner.fromFixtureKey(HOT_KEY),
    assets: parseEvmAssets('ETH:native'),
    broadcasts: new MemoryBroadcastStore(),
    minConfirmations: 1,
  });

describe('issued deposit addresses are watched again after a restart', () => {
  let db!: TestDatabase;
  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL?.trim();
    if (!url) throw new Error('TEST_DATABASE_URL is required');
    db = await createTestDatabase({ service: 'pay', url, migrations });
  }, 120_000);
  afterAll(async () => void (await db?.drop()), 30_000);
  beforeEach(async () => {
    await db.sql`TRUNCATE pay.custody_deposit_settings, pay.custody_deposit_addresses`;
  });

  it('lists one watch per issued address, in the reference the address was derived from', async () => {
    expect(await listIssuedDepositWatches(db.sql)).toEqual([]);
    await db.sql`INSERT INTO pay.custody_deposit_addresses (user_id, asset_id, network_id, address) VALUES ('user-a', 'ETH', 'ethereum', '0xaa')`;
    expect(await listIssuedDepositWatches(db.sql)).toEqual([{ paymentId: 'deposit-user:user-a', assetId: 'ETH' }]);
  });

  it('watches each extra address in its own reference, an expired one included', async () => {
    await db.sql`
      INSERT INTO pay.custody_deposit_addresses (user_id, asset_id, network_id, address_index, address, expires_at, issued_at)
      VALUES ('user-a', 'ETH', 'ethereum', 0, '0xaa', NULL, now() - interval '3 minutes'),
             ('user-a', 'ETH', 'ethereum', 1, '0xab', now() - interval '1 day', now() - interval '2 minutes'),
             ('user-a', 'ETH', 'ethereum', 2, '0xac', now() + interval '30 days', now() - interval '1 minute')`;
    expect(await listIssuedDepositWatches(db.sql)).toEqual([
      { paymentId: 'deposit-user:user-a', assetId: 'ETH' },
      { paymentId: 'deposit-user-extra:1:user-a', assetId: 'ETH' },
      { paymentId: 'deposit-user-extra:2:user-a', assetId: 'ETH' },
    ]);
  });

  it('a restarted chain sees a deposit to an issued address only after the watches are restored, and restores the stored address', async () => {
    await db.sql`
      INSERT INTO pay.custody_deposit_settings (asset_id, network_id, label, minimum_deposit, estimated_arrival_minutes, set_by)
      VALUES ('ETH', 'ethereum', 'Ethereum', '0.01', 5, 'test-profile')`;
    const before = mk();
    const issued = await new CustodyDepositService({
      sql: db.sql,
      chain: before,
      registries: {
        listRoutableNetworks: async () => [
          { networkId: 'ethereum', assetCodes: ['ETH'], confirmationsRequired: 1, enabled: true } as never,
        ],
      },
    }).address({ userId: 'user-a', assetId: 'ETH', networkId: 'ethereum' });
    expect(issued.state).toBe('issued');
    const address = issued.state === 'issued' ? issued.address.address : '';

    const restarted = mk();
    const hash = `0x${'ab'.repeat(32)}` as const;
    (restarted as unknown as { public: unknown }).public = {
      getBlockNumber: async () => 3n,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
        number: blockNumber,
        transactions:
          blockNumber === 1n
            ? [{ to: address, from: '0x0000000000000000000000000000000000000001', value: 10n ** 16n, hash, transactionIndex: 0 }]
            : [],
      }),
      getLogs: async () => [],
      getTransactionReceipt: async () => ({ status: 'success', transactionHash: hash, blockNumber: 1n, logs: [] }),
    };
    const log = vi.fn();
    expect(await restoreOpenDepositWatches(restarted, () => listIssuedDepositWatches(db.sql), log)).toBe(1);
    expect(log).not.toHaveBeenCalled();
    expect(await restarted.acceptanceAddress('deposit-user:user-a', 'ETH')).toBe(address);
    await restarted.refresh();
    expect(await restarted.inboundTransfer(address)).toMatchObject({ txHash: hash });
  });
});
