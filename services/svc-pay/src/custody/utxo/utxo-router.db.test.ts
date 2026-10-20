import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSION_SCOPES, type Principal } from '@intafaced/auth';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MerchantControlError } from '../../merchant-account-controls.js';
import { createPayNamespaces } from '../../namespaces/index.js';
import type { UtxoNode } from './service.js';

/** `founderAdmin.custody.utxo.*` through the real router: founder gate, strict parsing, rail.crypto with no node. */
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
    .withDatabase('intafaced_utxo_router_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

type Err = { code: string; message?: string };
async function refused(p: Promise<unknown>): Promise<Err> {
  try {
    await p;
  } catch (e) {
    return e as Err;
  }
  throw new Error('expected the call to be refused');
}

describe('custody utxo router (real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let founderOk = true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let bare: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let wired: any;
  let WALLET = '';
  const node: UtxoNode = {
    list: async () => [{ txid: 'aa', vout: 0, amount: '0.5', confirmations: 6 }],
    consolidate: async () => ({ txid: 'bb' }),
  };

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    await db.sql`INSERT INTO pay.network_registry (network_id, display_name, asset_codes, confirmations_required, enabled, updated_by)
      VALUES ('btc-test', 'btc-test', ${db.sql.json(['BTC'])}, 3, true, 'seed')`;
    await db.sql`INSERT INTO pay.custody_entities (entity_id, display_name, ownership, environment, created_by)
      VALUES ('house', 'House', 'entity_owned', 'testnet', 'seed')`;
    const [v] = await db.sql<Array<{ vault_id: string }>>`
      INSERT INTO pay.custody_vaults (entity_id, client_ref, name, created_by, updated_by)
      VALUES ('house', 'v-1', 'Main', 'seed', 'seed') RETURNING vault_id`;
    const [w] = await db.sql<Array<{ wallet_id: string }>>`
      INSERT INTO pay.custody_wallets (vault_id, network_id, asset_code, address, created_by)
      VALUES (${v!.vault_id}::uuid, 'btc-test', 'BTC', 'bc1qtestaddress0001', 'seed') RETURNING wallet_id`;
    WALLET = w!.wallet_id;
    const founderAuthority = async () => {
      if (!founderOk) throw new MerchantControlError('operator.denied');
      return 'founder-a';
    };
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
    const ctx = { principal, service: null, region: 'DE', requestId: 'r' };
    bare = createPayNamespaces({ founderAuthority, custody: { sql: db.sql } }).createCaller(ctx);
    wired = createPayNamespaces({ founderAuthority, custody: { sql: db.sql, utxoNode: node } }).createCaller(ctx);
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  beforeEach(async () => {
    founderOk = true;
    await db.sql`TRUNCATE pay.utxo_trigger_events, pay.utxo_records RESTART IDENTITY CASCADE`;
  });

  it('refuses every call for a caller who is not the founder', async () => {
    founderOk = false;
    expect((await refused(wired.founderAdmin.custody.utxo.list({ walletId: WALLET }))).code).toBe('FORBIDDEN');
    expect((await refused(wired.founderAdmin.custody.utxo.triggers({ networkId: 'btc-test' }))).code).toBe('FORBIDDEN');
    expect(
      (await refused(wired.founderAdmin.custody.utxo.setTriggers({ networkId: 'btc-test', minUtxoCount: 5, reason: 'TEST' }))).code,
    ).toBe('FORBIDDEN');
  });

  it('parses strictly: unknown keys, a count below two, a fee level without its unit, and nothing set are all parse errors', async () => {
    const u = () => wired.founderAdmin.custody.utxo;
    expect((await refused(u().list({ walletId: WALLET, extra: 1 }))).code).toBe('BAD_REQUEST');
    expect((await refused(u().list({ walletId: 'not-a-uuid' }))).code).toBe('BAD_REQUEST');
    expect((await refused(u().setTriggers({ networkId: 'btc-test', minUtxoCount: 1, reason: 'TEST' }))).code).toBe('BAD_REQUEST');
    expect((await refused(u().setTriggers({ networkId: 'btc-test', feeBelow: '5', reason: 'TEST' }))).code).toBe('BAD_REQUEST');
    expect((await refused(u().setTriggers({ networkId: 'btc-test', reason: 'TEST' }))).code).toBe('BAD_REQUEST');
    expect((await refused(u().setTriggers({ networkId: 'btc-test', feeBelow: '0', feeUnit: 'sat/vB', reason: 'TEST' }))).code).toBe(
      'BAD_REQUEST',
    );
    expect((await refused(u().consolidate({ walletId: WALLET }))).code).toBe('BAD_REQUEST');
  });

  it('with no node wired, list, due and consolidate answer rail.crypto and a blank trigger reads unset', async () => {
    const u = () => bare.founderAdmin.custody.utxo;
    const blank = await u().triggers({ networkId: 'btc-test' });
    expect(blank.configured).toBe(false);
    expect(blank.minUtxoCount).toBeNull();
    expect(blank.feeBelow).toBeNull();
    const set = await u().setTriggers({ networkId: 'btc-test', minUtxoCount: 5, reason: 'TEST' });
    expect(set.configured).toBe(true);
    expect(set.minUtxoCount).toBe(5);
    expect((await refused(u().list({ walletId: WALLET }))).message).toContain('rail.crypto');
    expect((await refused(u().due({ walletId: WALLET }))).message).toContain('rail.crypto');
    expect((await refused(u().consolidate({ walletId: WALLET, intentRef: 'c-1' }))).message).toContain('rail.crypto');
  });

  it('with a node wired the founder lists the inventory and a consolidation refuses until the owner sets a trigger', async () => {
    const u = () => wired.founderAdmin.custody.utxo;
    const list = await u().list({ walletId: WALLET });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ txid: 'aa', amount: '0.5', state: 'available' });
    expect((await refused(u().consolidate({ walletId: WALLET, intentRef: 'c-1' }))).message).toContain('utxo.triggers_unset');
  });
});
