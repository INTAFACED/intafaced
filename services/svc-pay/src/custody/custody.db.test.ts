import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSION_SCOPES, type Principal } from '@intafaced/auth';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MerchantControlError } from '../merchant-account-controls.js';
import { createPayNamespaces } from '../namespaces/index.js';

/**
 * The custody account model (W-custody-ops-01) against a real Postgres with every forward migration and the real
 * founderAdmin router. Names and references are TEST values; nothing here is a balance.
 */
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_custody_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const FOUNDER = 'founder-a';
type Err = { code: string; cause?: { code?: string } };
async function refused(p: Promise<unknown>): Promise<Err> {
  try {
    await p;
  } catch (e) {
    return e as Err;
  }
  throw new Error('expected the call to be refused');
}

describe('custody account model (real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let founderOk = true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let api: any;
  const c = () => api.founderAdmin.custody;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    const ns = createPayNamespaces({
      founderAuthority: async () => {
        if (!founderOk) throw new MerchantControlError('operator.denied');
        return FOUNDER;
      },
      custody: { sql: db.sql },
    });
    const userId = randomUUID();
    const principal: Principal = {
      userId,
      sub: userId,
      sid: randomUUID(),
      scopes: [...SESSION_SCOPES],
      mfa: true,
      tier: 'full',
      expiresAt: new Date(Date.now() + 3_600_000),
    };
    api = ns.createCaller({ principal, service: null, region: 'DE', requestId: 'r' });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });

  beforeEach(async () => {
    founderOk = true;
    await db.sql.unsafe(`ALTER TABLE pay.custody_events DISABLE TRIGGER custody_events_append_only_trg`);
    await db.sql.unsafe(`ALTER TABLE pay.custody_vaults DISABLE TRIGGER custody_vaults_no_delete_trg`);
    await db.sql.unsafe(`TRUNCATE pay.custody_events, pay.custody_wallets, pay.custody_vaults, pay.custody_entities CASCADE`);
    await db.sql.unsafe(`ALTER TABLE pay.custody_vaults ENABLE TRIGGER custody_vaults_no_delete_trg`);
    await db.sql.unsafe(`ALTER TABLE pay.custody_events ENABLE TRIGGER custody_events_append_only_trg`);
    await db.sql.unsafe(`DELETE FROM pay.wallet_routes`);
    await db.sql.unsafe(`DELETE FROM pay.network_registry`);
  }, 30_000);

  const entity = (o: Record<string, unknown> = {}) => ({
    entityId: 'house',
    displayName: 'House',
    ownership: 'entity_owned',
    environment: 'testnet',
    ...o,
  });
  const vault = (o: Record<string, unknown> = {}) => ({ entityId: 'house', clientRef: 'vault:ops-1', name: 'Operations', ...o });
  const page = { limit: 50 };

  async function seedNetwork(id = 'testnet-evm', assets: string[] = ['USDT']) {
    await db.sql`INSERT INTO pay.network_registry (network_id, display_name, asset_codes, updated_by)
                 VALUES (${id}, 'Test network', ${db.sql.json(assets as never)}, 'seed')`;
  }

  describe('empty and refusing states', () => {
    it('shows empty lists, never invented rows', async () => {
      expect(await c().walletTypes.list()).toEqual([]);
      expect(await c().entities.list(page)).toEqual([]);
      expect(await c().accounts.list(page)).toEqual([]);
      expect(await c().vaults.reconciliation(page)).toEqual([]);
    });

    it('refuses a blank entity, environment, name or reference, a list without a page size, and an extra field', async () => {
      for (const bad of [
        entity({ entityId: '' }),
        entity({ environment: '' }),
        entity({ environment: 'prod' }),
        entity({ displayName: '   ' }),
        entity({ ownership: 'customer_attributed' }),
        entity({ apiKey: 'x' }),
      ]) {
        expect((await refused(c().entities.create(bad))).code).toBeDefined();
      }
      await c().entities.create(entity());
      expect((await refused(c().entities.create(entity({ customerRef: 'cust-1' })))).cause?.code).toBe('custody.entity_differs');
      expect((await refused(c().vaults.create(vault({ name: '' })))).code).toBeDefined();
      expect((await refused(c().vaults.create(vault({ clientRef: '' })))).code).toBeDefined();
      expect((await refused(c().entities.list({}))).code).toBeDefined();
      expect((await refused(c().vaults.list({ entityId: 'house', visibility: 'all' }))).code).toBeDefined();
    });

    it('is founder-only: a caller who is not a founder is refused everywhere', async () => {
      founderOk = false;
      expect((await refused(c().entities.list(page))).code).toBe('FORBIDDEN');
      expect((await refused(c().entities.create(entity()))).code).toBe('FORBIDDEN');
      expect((await refused(c().vaults.reconciliation(page))).code).toBe('FORBIDDEN');
    });
  });

  describe('entities and accounts', () => {
    it('creates once per key; the same details are the same entity, other details conflict', async () => {
      const first = await c().entities.create(entity());
      expect(first).toMatchObject({
        entityId: 'house',
        ownership: 'entity_owned',
        environment: 'testnet',
        testBadge: true,
        customerRef: null,
      });
      expect(await c().entities.create(entity())).toEqual(first);
      expect((await refused(c().entities.create(entity({ displayName: 'Other' })))).cause?.code).toBe('custody.entity_differs');
      expect(await c().entities.list(page)).toHaveLength(1);
    });

    it('marks every environment but mainnet with the test badge', async () => {
      await c().entities.create(entity({ entityId: 'sbx', environment: 'sandbox' }));
      await c().entities.create(entity({ entityId: 'main', environment: 'mainnet' }));
      const list = await c().entities.list(page);
      expect(Object.fromEntries(list.map((e: { entityId: string; testBadge: boolean }) => [e.entityId, e.testBadge]))).toEqual({
        main: false,
        sbx: true,
      });
    });

    it('tells entity-owned from customer-attributed, one entity per customer per environment, with counts and no balance', async () => {
      await c().entities.create(entity());
      await c().entities.create(
        entity({ entityId: 'cust-1-test', displayName: 'Customer 1', ownership: 'customer_attributed', customerRef: 'cust-1' }),
      );
      expect(
        (await refused(c().entities.create(entity({ entityId: 'cust-1-again', ownership: 'customer_attributed', customerRef: 'cust-1' }))))
          .cause?.code,
      ).toBe('custody.customer_already_has_entity');
      await c().vaults.create(vault());
      const accounts = await c().accounts.list(page);
      expect(accounts.map((a: { entityId: string; ownership: string }) => [a.entityId, a.ownership])).toEqual([
        ['cust-1-test', 'customer_attributed'],
        ['house', 'entity_owned'],
      ]);
      expect(await c().accounts.get({ entityId: 'house' })).toMatchObject({ vaults: 1, hiddenVaults: 0, wallets: 0 });
      expect(JSON.stringify(accounts)).not.toMatch(/balance/i);
      expect((await refused(c().accounts.get({ entityId: 'nobody' }))).cause?.code).toBe('custody.entity_not_found');
    });
  });

  describe('vaults', () => {
    beforeEach(async () => {
      await c().entities.create(entity());
    });

    it('shows an empty state with nothing to list yet', async () => {
      expect(await c().vaults.list({ entityId: 'house', visibility: 'all', ...page })).toEqual([]);
    });

    it('creating twice with the same key is one vault; the same key with another name conflicts', async () => {
      const first = await c().vaults.create(vault());
      expect(await c().vaults.create(vault())).toEqual(first);
      expect((await refused(c().vaults.create(vault({ name: 'Other' })))).cause?.code).toBe('custody.vault_differs');
      expect(await c().vaults.list({ entityId: 'house', visibility: 'all', ...page })).toHaveLength(1);
      const counted = await db.sql<Array<{ n: string }>>`SELECT count(*) AS n FROM pay.custody_vaults`;
      expect(Number(counted[0]?.n)).toBe(1);
    });

    it('refuses a name another vault of the entity already has, ignoring case', async () => {
      await c().vaults.create(vault());
      expect((await refused(c().vaults.create(vault({ clientRef: 'vault:ops-2', name: ' operations ' })))).cause?.code).toBe(
        'custody.name_taken',
      );
      expect((await refused(c().vaults.create(vault({ entityId: 'nobody' })))).cause?.code).toBe('custody.entity_not_found');
    });

    it('renames with the version it loaded; a stale version conflicts and a taken name is refused', async () => {
      const v = await c().vaults.create(vault());
      const b = await c().vaults.create(vault({ clientRef: 'vault:ops-2', name: 'Reserve' }));
      const renamed = await c().vaults.rename({ vaultId: v.vaultId, name: 'Ops', expectedVersion: 1 });
      expect(renamed).toMatchObject({ name: 'Ops', version: 2, updatedBy: FOUNDER });
      expect((await refused(c().vaults.rename({ vaultId: v.vaultId, name: 'Again', expectedVersion: 1 }))).cause?.code).toBe(
        'custody.version_conflict',
      );
      expect((await refused(c().vaults.rename({ vaultId: v.vaultId, name: 'reserve', expectedVersion: 2 }))).cause?.code).toBe(
        'custody.name_taken',
      );
      expect(b.name).toBe('Reserve');
    });

    it('hides a vault from the default list, lists it with the filter, and the reconciliation read always has it', async () => {
      const v = await c().vaults.create(vault());
      await c().vaults.create(vault({ clientRef: 'vault:ops-2', name: 'Reserve' }));
      const hidden = await c().vaults.setVisibility({ vaultId: v.vaultId, hidden: true, expectedVersion: 1 });
      expect(hidden).toMatchObject({ hidden: true, version: 2 });
      const names = async (visibility: string) =>
        (await c().vaults.list({ entityId: 'house', visibility, ...page })).map((x: { name: string }) => x.name).sort();
      expect(await names('visible')).toEqual(['Reserve']);
      expect(await names('hidden')).toEqual(['Operations']);
      expect(await names('all')).toEqual(['Operations', 'Reserve']);
      const recon = await c().vaults.reconciliation(page);
      expect(recon.map((x: { name: string }) => x.name).sort()).toEqual(['Operations', 'Reserve']);
      expect(recon.find((x: { name: string }) => x.name === 'Operations').hidden).toBe(true);
      expect(await c().accounts.get({ entityId: 'house' })).toMatchObject({ vaults: 2, hiddenVaults: 1 });
      // Unhide, and a repeat of the same state changes nothing.
      const shown = await c().vaults.setVisibility({ vaultId: v.vaultId, hidden: false, expectedVersion: 2 });
      expect(shown).toMatchObject({ hidden: false, version: 3 });
      expect(await c().vaults.setVisibility({ vaultId: v.vaultId, hidden: false, expectedVersion: 3 })).toMatchObject({ version: 3 });
    });

    it('pages with a cursor', async () => {
      for (const n of [1, 2, 3]) await c().vaults.create(vault({ clientRef: `v:${n}`, name: `Vault ${n}` }));
      const first = await c().vaults.reconciliation({ limit: 2 });
      expect(first).toHaveLength(2);
      const rest = await c().vaults.reconciliation({ limit: 2, after: first[1].vaultId });
      expect(rest).toHaveLength(1);
    });

    it('never deletes a vault and never edits its history', async () => {
      const v = await c().vaults.create(vault());
      await c().vaults.rename({ vaultId: v.vaultId, name: 'Ops', expectedVersion: 1 });
      await expect(db.sql`DELETE FROM pay.custody_vaults WHERE vault_id = ${v.vaultId}`).rejects.toThrow(/never deleted/);
      await expect(db.sql`UPDATE pay.custody_events SET actor_id = 'x'`).rejects.toThrow(/append-only/);
      await expect(db.sql`DELETE FROM pay.custody_events`).rejects.toThrow(/append-only/);
      const events = await db.sql<Array<{ action: string; actor_id: string }>>`
        SELECT action, actor_id FROM pay.custody_events WHERE subject_kind = 'vault' ORDER BY seq`;
      expect(events).toEqual([
        { action: 'create', actor_id: FOUNDER },
        { action: 'rename', actor_id: FOUNDER },
      ]);
    });
  });

  describe('wallet types and wallets', () => {
    it('lists the network registry as the wallet types, and nothing when it is empty', async () => {
      expect(await c().walletTypes.list()).toEqual([]);
      await seedNetwork('testnet-evm', ['USDT', 'ETH']);
      expect(await c().walletTypes.list()).toEqual([
        { networkId: 'testnet-evm', displayName: 'Test network', enabled: false, assetCodes: ['USDT', 'ETH'] },
      ]);
    });

    it('adds a wallet only for a network and asset the registry lists, once, with no address yet', async () => {
      await c().entities.create(entity());
      const v = await c().vaults.create(vault());
      expect((await refused(c().wallets.add({ vaultId: v.vaultId, networkId: 'testnet-evm', assetCode: 'USDT' }))).cause?.code).toBe(
        'custody.network_unknown',
      );
      await seedNetwork();
      expect((await refused(c().wallets.add({ vaultId: v.vaultId, networkId: 'testnet-evm', assetCode: 'BTC' }))).cause?.code).toBe(
        'custody.asset_not_on_network',
      );
      expect((await refused(c().wallets.add({ vaultId: randomUUID(), networkId: 'testnet-evm', assetCode: 'USDT' }))).cause?.code).toBe(
        'custody.vault_not_found',
      );
      const w = await c().wallets.add({ vaultId: v.vaultId, networkId: 'testnet-evm', assetCode: 'USDT' });
      expect(w).toMatchObject({ vaultId: v.vaultId, entityId: 'house', networkId: 'testnet-evm', assetCode: 'USDT', address: null });
      expect(await c().wallets.add({ vaultId: v.vaultId, networkId: 'testnet-evm', assetCode: 'USDT' })).toEqual(w);
      expect(await c().wallets.list({ vaultId: v.vaultId, ...page })).toEqual([w]);
      expect(await c().wallets.get({ walletId: w.walletId })).toEqual(w);
      expect(await c().accounts.get({ entityId: 'house' })).toMatchObject({ wallets: 1 });
      expect((await refused(c().wallets.get({ walletId: randomUUID() }))).cause?.code).toBe('custody.wallet_not_found');
    });

    it('looks an address up to its wallet, vault and entity, or a typed not-found', async () => {
      await c().entities.create(entity());
      const v = await c().vaults.create(vault());
      await seedNetwork();
      const w = await c().wallets.add({ vaultId: v.vaultId, networkId: 'testnet-evm', assetCode: 'USDT' });
      expect((await refused(c().wallets.lookupByAddress({ networkId: 'testnet-evm', address: '0xabc' }))).cause?.code).toBe(
        'custody.address_not_found',
      );
      await db.sql`UPDATE pay.custody_wallets SET address = '0xabc' WHERE wallet_id = ${w.walletId}`;
      const found = await c().wallets.lookupByAddress({ networkId: 'testnet-evm', address: '0xabc' });
      expect(found.wallet.walletId).toBe(w.walletId);
      expect(found.vault.vaultId).toBe(v.vaultId);
      expect(found.entity).toMatchObject({ entityId: 'house', testBadge: true });
      expect((await refused(c().wallets.lookupByAddress({ networkId: 'other', address: '0xabc' }))).cause?.code).toBe(
        'custody.address_not_found',
      );
      // One address belongs to one wallet on a network.
      const v2 = await c().vaults.create(vault({ clientRef: 'v:2', name: 'Second' }));
      const w2 = await c().wallets.add({ vaultId: v2.vaultId, networkId: 'testnet-evm', assetCode: 'USDT' });
      await expect(db.sql`UPDATE pay.custody_wallets SET address = '0xabc' WHERE wallet_id = ${w2.walletId}`).rejects.toThrow(
        /unique|duplicate/i,
      );
    });
  });
});
