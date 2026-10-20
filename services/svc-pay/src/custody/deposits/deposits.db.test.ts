import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { serviceAuthHeadersForBody, type PayCustodyDepositCatalogue } from '@intafaced/contracts';
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
  async function setting(asset = 'USDT', net = 'ethereum', over: { minimum?: string; enabled?: boolean } = {}) {
    await db.sql`
      INSERT INTO pay.custody_deposit_settings (asset_id, network_id, label, minimum_deposit, estimated_arrival_minutes, enabled, set_by)
      VALUES (${asset}, ${net}, 'Ethereum', ${over.minimum ?? '10'}, 5, ${over.enabled ?? true}, 'test-profile')`;
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
    await db.sql`TRUNCATE pay.custody_deposit_settings, pay.custody_deposit_addresses`;
  }, 30_000);

  describe('catalogue', () => {
    it('is empty with no owner setting, and lists a pair once its setting and a routable network exist', async () => {
      expect(await service().catalogue()).toEqual({ entries: [] });
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

    it('leaves out a pair whose network is not routable, has no confirmation count or does not list the asset, and a disabled setting', async () => {
      await setting();
      await setting('DAI', 'ethereum', { enabled: false });
      for (const nets of [[], [network({ confirmationsRequired: null })], [network({ assetCodes: ['DAI'] })]]) {
        networks = nets;
        expect(await service().catalogue()).toEqual({ entries: [] });
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
      expect((await a.inject(post('/internal/custody-deposits/catalogue', { x: 1 }))).statusCode).toBe(400);
      expect((await a.inject(post('/internal/custody-deposits/catalogue', {}, 'svc-identity'))).statusCode).toBe(403);
      await a.close();
    });
  });
});
