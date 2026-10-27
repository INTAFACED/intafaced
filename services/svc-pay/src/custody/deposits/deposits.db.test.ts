import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { payCustodyDepositCatalogueSchema, serviceAuthHeadersForBody, type PayCustodyDepositCatalogue } from '@intafaced/contracts';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryChain, UnconfiguredChain } from '../../rails/chain-port.js';
import type { NetworkState } from '../../registries/policy.js';
import { CustodyDepositService } from './service.js';
import { registerCustodyDepositRoutes } from './routes.js';

/** Customer deposit addresses against a real Postgres, and through the signed routes. TEST figures only. */
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_custody_deposits_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const SECRET = 'svc-pay-custody-deposit-secret-at-least-32-chars';
const ALICE = 'user-alice';
const BOB = 'user-bob';

const network = (over: Partial<NetworkState> = {}): NetworkState =>
  ({
    networkId: 'ethereum',
    displayName: 'Ethereum',
    assetCodes: ['USDT'],
    confirmationsRequired: 12,
    enabled: true,
    feeEstimateSource: 'fixed',
    feeEstimateAmount: '1',
    ...over,
  }) as NetworkState;

describe('custody deposit addresses (real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let networks: NetworkState[] = [];
  let chain: MemoryChain | UnconfiguredChain = new MemoryChain();

  const service = () => new CustodyDepositService({ sql: db.sql, chain, registries: { listRoutableNetworks: async () => networks } });
  async function setting(asset = 'USDT', net = 'ethereum', over: { minimum?: string; enabled?: boolean; haltNote?: string } = {}) {
    await db.sql`
      INSERT INTO pay.custody_deposit_settings (asset_id, network_id, label, minimum_deposit, estimated_arrival_minutes, enabled, halt_note, set_by)
      VALUES (${asset}, ${net}, 'Ethereum', ${over.minimum ?? '10'}, 5, ${over.enabled ?? true}, ${over.haltNote ?? null}, 'test-profile')`;
  }

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);
  beforeEach(async () => {
    networks = [network()];
    chain = new MemoryChain();
    await db.sql`TRUNCATE pay.custody_deposit_settings, pay.custody_deposit_addresses, pay.custody_deposit_setting_events`;
  }, 30_000);

  describe('catalogue', () => {
    it('is empty with no owner setting, and lists a pair once its setting and a routable network exist', async () => {
      expect(await service().catalogue()).toEqual({ entries: [], halted: [] });
      await setting();
      expect((await service().catalogue()).entries).toEqual([
        {
          assetId: 'USDT',
          networkId: 'ethereum',
          label: 'Ethereum',
          minimumDeposit: '10',
          confirmationsRequired: 12,
          estimatedArrivalMinutes: 5,
          memoRequired: false,
          sharedAddressGroup: null,
        },
      ]);
    });

    it('carries the owner’s unsupported-case list on its entry, as written, and leaves the key out when none is published', async () => {
      networks = [network({ assetCodes: ['USDT', 'USDC'] })];
      await setting();
      await setting('USDC');
      const cases = ['TEST: a send from a smart contract', 'TEST: a send of an NFT'];
      await db.sql`UPDATE pay.custody_deposit_settings SET unsupported_cases = ${db.sql.array(cases)}::text[] WHERE asset_id = 'USDT'`;
      const catalogue = await service().catalogue();
      expect(payCustodyDepositCatalogueSchema.parse(catalogue)).toEqual(catalogue);
      const byAsset = new Map(catalogue.entries.map((entry) => [entry.assetId, entry]));
      expect(byAsset.get('USDT')?.unsupported).toEqual(cases);
      expect(byAsset.get('USDC')).not.toHaveProperty('unsupported');
      // The table holds at most 20 cases and no null one.
      await expect(
        db.sql`UPDATE pay.custody_deposit_settings SET unsupported_cases = ${db.sql.array(Array.from({ length: 21 }, (_, i) => `TEST ${i}`))}::text[]`,
      ).rejects.toThrow();
      // Nor a null, blank, padded, overlong or repeated case: the catalogue svc-bank parses can never be broken by a row.
      for (const bad of [
        'ARRAY[NULL]::text[]',
        "ARRAY['']",
        "ARRAY['   ']",
        "ARRAY[' padded']",
        `ARRAY['${'x'.repeat(281)}']`,
        "ARRAY['TEST a', 'TEST a']",
      ]) {
        await expect(db.sql.unsafe(`UPDATE pay.custody_deposit_settings SET unsupported_cases = ${bad}`)).rejects.toThrow();
      }
    });

    it('leaves out a pair whose network is not routable, has no confirmation count or does not list the asset, and a disabled setting', async () => {
      await setting();
      await setting('DAI', 'ethereum', { enabled: false });
      for (const nets of [[], [network({ confirmationsRequired: null })], [network({ assetCodes: ['DAI'] })]]) {
        networks = nets;
        expect((await service().catalogue()).entries).toEqual([]);
      }
    });

    it('names a pair the owner switched off, with the note, only where its network would otherwise take it, and issues it no address', async () => {
      await setting();
      await setting('DAI', 'ethereum', { enabled: false, haltNote: 'TEST maintenance' });
      // Switched on once (its audit says so), then off with no note.
      await setting('USDC', 'ethereum', { enabled: false });
      await db.sql`
        INSERT INTO pay.custody_deposit_setting_events (asset_id, network_id, action, actor_id, approver_id, dual_control, before, after, reason)
        VALUES ('USDC', 'ethereum', 'update', 'test-founder-a', 'test-founder-b', true, ${db.sql.json({ enabled: false })},
                ${db.sql.json({ enabled: true })}, 'TEST switch on')`;
      // Created off and never switched on: not launched, so not mentioned.
      await setting('EURC', 'ethereum', { enabled: false });
      networks = [network({ assetCodes: ['USDT', 'DAI', 'USDC', 'EURC'] })];
      const catalogue = await service().catalogue();
      expect(catalogue.entries.map((e) => e.assetId)).toEqual(['USDT']);
      expect(catalogue.halted).toEqual([
        { assetId: 'DAI', networkId: 'ethereum', label: 'Ethereum', haltNote: 'TEST maintenance' },
        { assetId: 'USDC', networkId: 'ethereum', label: 'Ethereum', haltNote: null },
      ]);
      expect(await service().address({ userId: ALICE, assetId: 'DAI', networkId: 'ethereum' })).toEqual({
        state: 'refused',
        code: 'pay.deposit_pair_unpublished',
      });
      // A switched-off pair on a network that is not routable, or does not list the asset, is not named at all.
      for (const nets of [[], [network({ enabled: false, confirmationsRequired: null })], [network({ assetCodes: ['USDT'] })]]) {
        networks = nets;
        expect((await service().catalogue()).halted).toEqual([]);
      }
    });

    it('refuses a blank, zero or malformed minimum at the table', async () => {
      for (const minimum of ['', '0', '-5', '1e3', ' 5']) await expect(setting('USDT', 'ethereum', { minimum })).rejects.toThrow();
    });
  });

  describe('address', () => {
    it('issues one durable address per user, asset and network and returns it on every call', async () => {
      await setting();
      const first = await service().address({ userId: ALICE, assetId: 'USDT', networkId: 'ethereum' });
      expect(first.state).toBe('issued');
      const again = await new CustodyDepositService({
        sql: db.sql,
        chain: new MemoryChain(),
        registries: { listRoutableNetworks: async () => networks },
      }).address({ userId: ALICE, assetId: 'USDT', networkId: 'ethereum' });
      expect(again).toEqual(first);
      const other = await service().address({ userId: BOB, assetId: 'USDT', networkId: 'ethereum' });
      expect(other).not.toEqual(first);
      expect(await db.sql`SELECT 1 FROM pay.custody_deposit_addresses`).toHaveLength(2);
    });

    it('returns the stored address even if the chain would now derive another, and does not call the chain', async () => {
      await setting();
      const first = await service().address({ userId: ALICE, assetId: 'USDT', networkId: 'ethereum' });
      chain = new UnconfiguredChain();
      expect(await service().address({ userId: ALICE, assetId: 'USDT', networkId: 'ethereum' })).toEqual(first);
    });

    it('is one row under concurrent first calls', async () => {
      await setting();
      const calls = await Promise.all(
        Array.from({ length: 8 }, () => service().address({ userId: ALICE, assetId: 'USDT', networkId: 'ethereum' })),
      );
      expect(new Set(calls.map((c) => JSON.stringify(c))).size).toBe(1);
      expect(await db.sql`SELECT 1 FROM pay.custody_deposit_addresses`).toHaveLength(1);
    });

    it('refuses a pair that is not published, and issues nothing', async () => {
      await setting();
      expect(await service().address({ userId: ALICE, assetId: 'USDT', networkId: 'tron' })).toEqual({
        state: 'refused',
        code: 'pay.deposit_pair_unpublished',
      });
      expect(await service().address({ userId: ALICE, assetId: 'BTC', networkId: 'ethereum' })).toMatchObject({ state: 'refused' });
      expect(await db.sql`SELECT 1 FROM pay.custody_deposit_addresses`).toHaveLength(0);
    });

    it('refuses with no chain behind the port and stores nothing', async () => {
      await setting();
      chain = new UnconfiguredChain();
      expect(await service().address({ userId: ALICE, assetId: 'USDT', networkId: 'ethereum' })).toEqual({
        state: 'refused',
        code: 'pay.deposit_source_unset',
      });
      expect(await db.sql`SELECT 1 FROM pay.custody_deposit_addresses`).toHaveLength(0);
    });

    it('never gives one address to two people: a clash is thrown and the second row is not written', async () => {
      await setting();
      const clash = {
        async acceptanceAddress() {
          return 'addr_shared';
        },
        posture: 'sandbox' as const,
      };
      const svc = new CustodyDepositService({ sql: db.sql, chain: clash, registries: { listRoutableNetworks: async () => networks } });
      await svc.address({ userId: ALICE, assetId: 'USDT', networkId: 'ethereum' });
      await expect(svc.address({ userId: BOB, assetId: 'USDT', networkId: 'ethereum' })).rejects.toThrow();
      const rows = await db.sql<Array<{ user_id: string }>>`SELECT user_id FROM pay.custody_deposit_addresses`;
      expect(rows.map((r) => r.user_id)).toEqual([ALICE]);
    });

    it('keeps the first address in the reference and reply shape it had before extras: no index, no expiry', async () => {
      await setting();
      expect(await service().address({ userId: ALICE, assetId: 'USDT', networkId: 'ethereum' })).toEqual({
        state: 'issued',
        address: { address: 'addr_usdt_deposit-user:user-alice', memo: null, qrPayload: null },
      });
      expect(await db.sql`SELECT address_index, expires_at FROM pay.custody_deposit_addresses`).toEqual([
        { address_index: 0, expires_at: null },
      ]);
    });

    it('stores an extra address per index with the expiry it was first asked with, and keeps that expiry', async () => {
      await setting();
      const first = await service().address({ userId: ALICE, assetId: 'USDT', networkId: 'ethereum' });
      const expiresAt = '2099-11-24T00:00:00.000Z';
      const extra = await service().address({ userId: ALICE, assetId: 'USDT', networkId: 'ethereum', addressIndex: 1, expiresAt });
      expect(extra).toEqual({
        state: 'issued',
        address: { address: 'addr_usdt_deposit-user-extra:1:user-alice', memo: null, qrPayload: null, addressIndex: 1, expiresAt },
      });
      // A later call with another expiry returns the stored one: an address's expiry is set once.
      expect(
        await service().address({
          userId: ALICE,
          assetId: 'USDT',
          networkId: 'ethereum',
          addressIndex: 1,
          expiresAt: '2099-12-01T00:00:00.000Z',
        }),
      ).toEqual(extra);
      const second = await service().address({ userId: ALICE, assetId: 'USDT', networkId: 'ethereum', addressIndex: 2, expiresAt });
      expect(second.state === 'issued' && second.address.address).toBe('addr_usdt_deposit-user-extra:2:user-alice');
      // Asking for index 0 again still returns the first address, untouched.
      expect(await service().address({ userId: ALICE, assetId: 'USDT', networkId: 'ethereum' })).toEqual(first);
      expect(await db.sql`SELECT 1 FROM pay.custody_deposit_addresses`).toHaveLength(3);
    });

    it('throws and stores nothing when an extra address has no expiry or the first one has one (the route refuses both first)', async () => {
      await setting();
      await expect(service().address({ userId: ALICE, assetId: 'USDT', networkId: 'ethereum', addressIndex: 1 })).rejects.toThrow(
        'pay.deposit_address_expiry_mismatch',
      );
      await expect(
        service().address({ userId: ALICE, assetId: 'USDT', networkId: 'ethereum', expiresAt: '2099-11-24T00:00:00.000Z' }),
      ).rejects.toThrow('pay.deposit_address_expiry_mismatch');
      expect(await db.sql`SELECT 1 FROM pay.custody_deposit_addresses`).toHaveLength(0);
    });

    it('refuses a new extra address whose expiry has passed, and still returns a stored one that has since expired', async () => {
      await setting();
      const past = new Date(Date.now() - 60_000).toISOString();
      expect(await service().address({ userId: ALICE, assetId: 'USDT', networkId: 'ethereum', addressIndex: 1, expiresAt: past })).toEqual({
        state: 'refused',
        code: 'pay.deposit_address_expiry_past',
      });
      expect(await db.sql`SELECT 1 FROM pay.custody_deposit_addresses`).toHaveLength(0);
      const soon = new Date(Date.now() + 60_000).toISOString();
      await service().address({ userId: ALICE, assetId: 'USDT', networkId: 'ethereum', addressIndex: 1, expiresAt: soon });
      await db.sql`UPDATE pay.custody_deposit_addresses SET expires_at = now() - interval '1 hour' WHERE address_index = 1`;
      // The caller sees the stored expiry and decides; the address is still watched, and a deposit to it is held for release.
      expect(
        await service().address({ userId: ALICE, assetId: 'USDT', networkId: 'ethereum', addressIndex: 1, expiresAt: soon }),
      ).toMatchObject({ state: 'issued', address: { addressIndex: 1 } });
    });

    it('never derives one reference for two people, whatever their ids hold', async () => {
      await setting();
      // 'u' at index 1 and 'u:1' or '1:u' at index 0 would collide under a joined reference; they do not here.
      for (const userId of ['u:1', '1:u']) await service().address({ userId, assetId: 'USDT', networkId: 'ethereum' });
      const extra = await service().address({
        userId: 'u',
        assetId: 'USDT',
        networkId: 'ethereum',
        addressIndex: 1,
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      expect(extra.state).toBe('issued');
      expect(await db.sql`SELECT 1 FROM pay.custody_deposit_addresses`).toHaveLength(3);
    });

    it('refuses at the table an index outside 0 to 9999, an extra address with no expiry and a first address with one', async () => {
      const insert = (index: number, expires: string | null) => db.sql`
        INSERT INTO pay.custody_deposit_addresses (user_id, asset_id, network_id, address_index, address, expires_at)
        VALUES (${ALICE}, 'USDT', 'ethereum', ${index}, ${`addr_${index}`}, ${expires})`;
      await expect(insert(10000, '2026-11-24T00:00:00Z')).rejects.toThrow();
      await expect(insert(-1, '2026-11-24T00:00:00Z')).rejects.toThrow();
      await expect(insert(1, null)).rejects.toThrow();
      await expect(insert(0, '2026-11-24T00:00:00Z')).rejects.toThrow();
    });

    it('treats addresses that differ only by case as one on a network', async () => {
      await setting();
      let n = 0;
      const casey = {
        async acceptanceAddress() {
          n += 1;
          return n === 1 ? '0xAbC' : '0xabc';
        },
        posture: 'sandbox' as const,
      };
      const svc = new CustodyDepositService({ sql: db.sql, chain: casey, registries: { listRoutableNetworks: async () => networks } });
      await svc.address({ userId: ALICE, assetId: 'USDT', networkId: 'ethereum' });
      await expect(svc.address({ userId: BOB, assetId: 'USDT', networkId: 'ethereum' })).rejects.toThrow();
    });
  });

  describe('signed routes', () => {
    const post = (url: string, body: unknown, service: 'svc-bank' | 'svc-identity' = 'svc-bank') => {
      const payload = JSON.stringify(body);
      return {
        method: 'POST' as const,
        url,
        payload,
        headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody(service, SECRET, payload) },
      };
    };
    async function app(fail = false) {
      const a = Fastify();
      const svc = service();
      registerCustodyDepositRoutes(a, {
        internalSecret: SECRET,
        catalogue: async () => {
          if (fail) throw new Error('database down');
          return svc.catalogue();
        },
        address: async (input) => {
          if (fail) throw new Error('database down');
          return svc.address(input);
        },
        records: async () => {
          if (fail) throw new Error('database down');
          return { items: [], total: 0 };
        },
      });
      await a.ready();
      return a;
    }

    it('answers svc-bank the catalogue and an address', async () => {
      await setting();
      const a = await app();
      const cat = await a.inject(post('/internal/custody-deposits/catalogue', {}));
      expect(cat.statusCode).toBe(200);
      expect((cat.json() as PayCustodyDepositCatalogue).entries).toHaveLength(1);
      const adr = await a.inject(post('/internal/custody-deposits/address', { userId: ALICE, assetId: 'USDT', networkId: 'ethereum' }));
      expect(adr.statusCode).toBe(200);
      expect(adr.json().state).toBe('issued');
      await a.close();
    });

    it('answers records to svc-bank only, refuses a bad page and is 503 when the read fails', async () => {
      const a = await app();
      const ok = await a.inject(post('/internal/custody-deposits/records', { userId: ALICE }));
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ items: [], total: 0 });
      expect((await a.inject(post('/internal/custody-deposits/records', { userId: ALICE, limit: 5000 }))).statusCode).toBe(400);
      expect((await a.inject(post('/internal/custody-deposits/records', { userId: ALICE }, 'svc-identity'))).statusCode).toBe(403);
      await a.close();
      const down = await app(true);
      expect((await down.inject(post('/internal/custody-deposits/records', { userId: ALICE }))).statusCode).toBe(503);
      await down.close();
    });

    it('is 503, never an empty catalogue or an address, when a read fails', async () => {
      const a = await app(true);
      const cat = await a.inject(post('/internal/custody-deposits/catalogue', {}));
      expect(cat.statusCode).toBe(503);
      expect(cat.json().entries).toBeUndefined();
      expect(
        (await a.inject(post('/internal/custody-deposits/address', { userId: ALICE, assetId: 'USDT', networkId: 'ethereum' }))).statusCode,
      ).toBe(503);
      await a.close();
    });

    it('refuses an unsigned caller, any other service, and a body that is not the contract', async () => {
      const a = await app();
      const path = '/internal/custody-deposits/address';
      expect((await a.inject({ method: 'POST', url: path, payload: { userId: ALICE } })).statusCode).toBe(401);
      expect((await a.inject(post(path, { userId: ALICE, assetId: 'USDT', networkId: 'ethereum' }, 'svc-identity'))).statusCode).toBe(403);
      expect((await a.inject(post(path, { userId: ALICE, assetId: 'USDT' }))).statusCode).toBe(400);
      expect((await a.inject(post(path, { userId: ALICE, assetId: 'USDT', networkId: 'ethereum', extra: 1 }))).statusCode).toBe(400);
      // An extra address without an expiry, a first address with one, and an index past the cap are not the contract.
      expect((await a.inject(post(path, { userId: ALICE, assetId: 'USDT', networkId: 'ethereum', addressIndex: 1 }))).statusCode).toBe(400);
      const expiresAt = '2099-11-24T00:00:00.000Z';
      expect((await a.inject(post(path, { userId: ALICE, assetId: 'USDT', networkId: 'ethereum', expiresAt }))).statusCode).toBe(400);
      expect(
        (await a.inject(post(path, { userId: ALICE, assetId: 'USDT', networkId: 'ethereum', addressIndex: 10000, expiresAt }))).statusCode,
      ).toBe(400);
      expect((await a.inject(post('/internal/custody-deposits/catalogue', { x: 1 }))).statusCode).toBe(400);
      expect((await a.inject(post('/internal/custody-deposits/catalogue', {}, 'svc-identity'))).statusCode).toBe(403);
      await a.close();
    });
  });
});
