/**
 * Extra deposit addresses (W-deposit-02, J-wallet-02 #4) through the mounted router, against a real Postgres.
 *
 * The owner's cap and expiry window are TEST values passed in; blank refuses by name before custody is asked. Custody is a
 * memory port that issues one address per number and keeps the expiry it was first given, as svc-pay does.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader, type RegistryAsset } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { stubApprovalConsumer } from '../action-approval-consume.js';
import { memoryAssetRegistry } from '../assets/supported-assets.js';
import { createBankServices } from '../bank-service.js';
import { createBankRouter } from '../router.js';
import type { CustodyDepositAddressRequest, CustodyDepositPort } from './custody-port.js';

const SECRET = 'bank-deposit-addresses-edge-secret';
const HOLDER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CONFIRM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const NOW = new Date('2026-10-24T12:00:00.000Z');

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

function registryRow(id: string, extra: Partial<Pick<RegistryAsset, 'state'>> = {}): RegistryAsset {
  return {
    id,
    kind: 'crypto',
    precision: 6,
    networks: [{ networkId: 'testnet', label: 'Test testnet' }],
    defaultNetworkId: 'testnet',
    allowedActions: ['deposit', 'withdraw', 'trade', 'transfer'],
    state: extra.state ?? 'active',
    revision: 1,
    updatedAt: '2026-10-24T00:00:00.000Z',
  };
}

/** A memory custody: one address per user, asset, network and number, the expiry kept from the first ask. */
function memoryCustody(opts: { halted?: boolean; refuse?: boolean } = {}) {
  const asked: CustodyDepositAddressRequest[] = [];
  const stored = new Map<string, { address: string; expiresAt: string | null }>();
  const port: CustodyDepositPort = {
    async catalogue() {
      const network = { id: 'testnet', label: 'Test network', minimumDeposit: '10', confirmationsRequired: 6, estimatedArrivalMinutes: 5 };
      return opts.halted
        ? { assets: [], halted: [{ assetId: 'USDT', networkId: 'testnet', label: 'Test network', haltNote: null }] }
        : { assets: [{ assetId: 'USDT', networks: [network] }], halted: [] };
    },
    async listAssets() {
      return (await port.catalogue!())!.assets;
    },
    async address(input) {
      asked.push(input);
      if (opts.refuse) return null;
      const index = input.addressIndex ?? 0;
      const key = `${input.userId}:${input.assetId}:${input.networkId}:${index}`;
      const row = stored.get(key) ?? { address: `test-addr-${input.userId.slice(0, 4)}-${index}`, expiresAt: input.expiresAt ?? null };
      stored.set(key, row);
      return { address: row.address, memo: null, qrPayload: null, expiresAt: row.expiresAt };
    },
    async pending() {
      return [];
    },
  };
  return { port, asked };
}

describe('extra deposit addresses (real Postgres)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });

  beforeAll(async () => {
    const raw = process.env.TEST_DATABASE_URL?.trim();
    if (!raw) throw new Error('TEST_DATABASE_URL is unset. This suite does not start Docker.');
    const url = new URL(raw);
    if (url.pathname === '/test') url.pathname = '/intafaced_test';
    db = await createTestDatabase({ service: 'bank', url: url.toString(), migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    await sql`TRUNCATE bank.deposit_addresses`;
  });

  function caller(
    custody: CustodyDepositPort,
    userId = HOLDER,
    owner: { cap?: string; days?: string } = { cap: '3', days: '30' },
    registry = memoryAssetRegistry([registryRow('USDT')]),
  ) {
    const ledger = new MemoryLedger();
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      deposits: { custody, addressCap: () => owner.cap, addressExpiryDays: () => owner.days, now: () => NOW },
      assetRegistry: registry,
    });
    const actor = {
      sub: userId,
      userId,
      sid: randomUUID(),
      scopes: ['bank:read', 'bank:write'],
      tier: 'full',
      mfa: true,
      expiresAt: new Date(Date.now() + 60_000),
    } as Principal;
    const raw = encodePrincipal(actor);
    return createBankRouter(bank, { approvals: stubApprovalConsumer(CONFIRM) }).createCaller(
      edgeContext({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: `req-${randomUUID()}`,
      }),
    );
  }

  const pair = { assetId: 'USDT', networkId: 'testnet' };
  const count = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM bank.deposit_addresses`)[0]!.n;

  it('a blank cap or expiry window refuses by name before custody is asked, and the list says both are unpublished', async () => {
    const { port, asked } = memoryCustody();
    for (const [owner, code] of [
      [{ days: '30' }, 'bank.deposit_address_cap_unset'],
      [{ cap: ' ', days: '30' }, 'bank.deposit_address_cap_unset'],
      [{ cap: '0', days: '30' }, 'bank.deposit_address_cap_unset'],
      [{ cap: '3' }, 'bank.deposit_address_expiry_unset'],
      [{ cap: '3', days: '1.5' }, 'bank.deposit_address_expiry_unset'],
    ] as const) {
      await expect(caller(port, HOLDER, owner).deposits.addresses.create({ ...pair, label: 'Savings' })).rejects.toMatchObject({
        cause: { code },
      });
    }
    expect(asked).toHaveLength(0);
    expect(await count()).toBe(0);
    expect(await caller(port, HOLDER, {}).deposits.addresses.list()).toEqual({ items: [], cap: null, expiryDays: null });
  });

  it('lists the first address and each extra one with its label and expiry, numbered without reuse', async () => {
    const { port, asked } = memoryCustody();
    const user = caller(port);
    await user.deposits.address(pair);
    const savings = await user.deposits.addresses.create({ ...pair, label: '  Savings ' });
    expect(savings).toMatchObject({
      addressIndex: 1,
      address: 'test-addr-1111-1',
      label: 'Savings',
      expiresAt: '2026-11-23T12:00:00.000Z',
      state: 'active',
    });
    // Custody was asked for number 1 with the owner's window from now.
    expect(asked.at(-1)).toEqual({ userId: HOLDER, ...pair, addressIndex: 1, expiresAt: '2026-11-23T12:00:00.000Z' });
    await user.deposits.addresses.create(pair);
    const list = await user.deposits.addresses.list({ assetId: 'USDT' });
    expect(list.cap).toBe(3);
    expect(list.expiryDays).toBe(30);
    // The first address, then the newest first.
    expect(list.items.map((row) => [row.addressIndex, row.label, row.expiresAt, row.state])).toEqual([
      [0, null, null, 'active'],
      [2, null, '2026-11-23T12:00:00.000Z', 'active'],
      [1, 'Savings', '2026-11-23T12:00:00.000Z', 'active'],
    ]);
    // The first address door still returns the first address, never an extra one.
    expect((await user.deposits.address(pair)).address).toBe('test-addr-1111-0');
    expect(await caller(port, OTHER).deposits.addresses.list()).toMatchObject({ items: [] });
  });

  it('refuses beyond the cap with the cap named, asks custody for nothing, and an expired address frees a place', async () => {
    const { port, asked } = memoryCustody();
    const user = caller(port);
    await user.deposits.address(pair);
    await user.deposits.addresses.create(pair);
    await user.deposits.addresses.create(pair);
    const before = asked.length;
    await expect(user.deposits.addresses.create(pair)).rejects.toMatchObject({
      cause: { code: 'bank.deposit_address_cap_reached', message: expect.stringContaining('at most 3') },
    });
    expect(asked).toHaveLength(before);
    expect(await count()).toBe(3);

    // Number 1 expires: it stays listed as expired, and the next address is number 3, never 1 again.
    await sql`UPDATE bank.deposit_addresses SET expires_at = now() - interval '1 minute' WHERE address_index = 1`;
    const third = await user.deposits.addresses.create(pair);
    expect(third.addressIndex).toBe(3);
    const states = (await user.deposits.addresses.list()).items.map((row) => [row.addressIndex, row.state]);
    expect(states).toEqual([
      [0, 'active'],
      [3, 'active'],
      [2, 'active'],
      [1, 'expired'],
    ]);
  });

  it('counts the first address in the cap even before it is asked for, and refuses once every number is used', async () => {
    const { port } = memoryCustody();
    const user = caller(port);
    await user.deposits.addresses.create(pair);
    await user.deposits.addresses.create(pair);
    await expect(user.deposits.addresses.create(pair)).rejects.toMatchObject({ cause: { code: 'bank.deposit_address_cap_reached' } });
    // Asking for the first address afterwards fills its reserved place: three open, the cap.
    await user.deposits.address(pair);
    expect((await user.deposits.addresses.list()).items.filter((row) => row.state === 'active')).toHaveLength(3);

    await sql`TRUNCATE bank.deposit_addresses`;
    await sql`
      INSERT INTO bank.deposit_addresses (user_id, asset_id, network_id, address_index, address, expires_at)
      VALUES (${HOLDER}, 'USDT', 'testnet', 0, 'first', NULL), (${HOLDER}, 'USDT', 'testnet', 9999, 'last', now() - interval '1 day')`;
    await expect(user.deposits.addresses.create(pair)).rejects.toMatchObject({ cause: { code: 'bank.deposit_address_numbers_used' } });
  });

  it('makes at most the cap under concurrent requests', async () => {
    const { port } = memoryCustody();
    const user = caller(port);
    await user.deposits.address(pair);
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => user.deposits.addresses.create(pair)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(await count()).toBe(3);
  });

  it('gives no extra address for a switched-off pair, one the supported list does not allow, or when custody will not issue', async () => {
    const off = memoryCustody({ halted: true });
    await expect(caller(off.port).deposits.addresses.create(pair)).rejects.toMatchObject({
      cause: { code: 'bank.deposit_network_halted' },
    });
    const retired = memoryCustody();
    await expect(
      caller(
        retired.port,
        HOLDER,
        { cap: '3', days: '30' },
        memoryAssetRegistry([registryRow('USDT', { state: 'retired' })]),
      ).deposits.addresses.create(pair),
    ).rejects.toMatchObject({ cause: { code: 'bank.deposit_asset_unpublished' } });
    const refusing = memoryCustody({ refuse: true });
    await expect(caller(refusing.port).deposits.addresses.create(pair)).rejects.toMatchObject({
      cause: { code: 'bank.deposit_custody_unset' },
    });
    expect(off.asked).toHaveLength(0);
    expect(retired.asked).toHaveLength(0);
    expect(await count()).toBe(0);
  });

  it('a custody answer with no expiry for an extra address is not stored', async () => {
    const { port } = memoryCustody();
    const noExpiry: CustodyDepositPort = { ...port, address: async (input) => ({ ...(await port.address(input))!, expiresAt: null }) };
    await expect(caller(noExpiry).deposits.addresses.create(pair)).rejects.toMatchObject({
      cause: { code: 'bank.deposit_catalogue_invalid' },
    });
    expect(await count()).toBe(0);
  });

  it('sets, keeps and clears a label; refuses a bad one and anyone else’s address', async () => {
    const { port } = memoryCustody();
    const user = caller(port);
    await user.deposits.address(pair);
    await user.deposits.addresses.create({ ...pair, label: 'Savings' });
    const named = await user.deposits.addresses.label({ ...pair, addressIndex: 1, label: 'Exchange payouts' });
    expect(named.label).toBe('Exchange payouts');
    expect((await user.deposits.addresses.label({ ...pair, addressIndex: 1, label: 'Exchange payouts' })).label).toBe('Exchange payouts');
    expect((await user.deposits.addresses.label({ ...pair, addressIndex: 0, label: 'Main' })).label).toBe('Main');
    expect((await user.deposits.addresses.label({ ...pair, addressIndex: 1, label: '' })).label).toBeNull();
    await expect(user.deposits.addresses.label({ ...pair, addressIndex: 1, label: 'x'.repeat(41) })).rejects.toMatchObject({
      cause: { code: 'bank.deposit_address_label_invalid' },
    });
    await expect(user.deposits.addresses.create({ ...pair, label: 'tab\there' })).rejects.toMatchObject({
      cause: { code: 'bank.deposit_address_label_invalid' },
    });
    await expect(caller(port, OTHER).deposits.addresses.label({ ...pair, addressIndex: 1, label: 'Mine now' })).rejects.toMatchObject({
      cause: { code: 'bank.deposit_address_not_found' },
    });
    await expect(user.deposits.addresses.label({ ...pair, addressIndex: 7, label: 'Nowhere' })).rejects.toMatchObject({
      cause: { code: 'bank.deposit_address_not_found' },
    });
    const rows = await sql<{ address_index: number; label: string | null }[]>`
      SELECT address_index, label FROM bank.deposit_addresses ORDER BY address_index`;
    expect(rows).toEqual([
      { address_index: 0, label: 'Main' },
      { address_index: 1, label: null },
    ]);
  });

  it('refuses at the table an index outside 0 to 9999, an expiry that does not match the index and an untrimmed label', async () => {
    const insert = (index: number, expires: string | null, label: string | null = null) => sql`
      INSERT INTO bank.deposit_addresses (user_id, asset_id, network_id, address_index, address, expires_at, label)
      VALUES (${HOLDER}, 'USDT', 'testnet', ${index}, ${`addr-${index}`}, ${expires}, ${label})`;
    await expect(insert(10000, '2026-11-24T00:00:00Z')).rejects.toThrow();
    await expect(insert(1, null)).rejects.toThrow();
    await expect(insert(0, '2026-11-24T00:00:00Z')).rejects.toThrow();
    await expect(insert(0, null, ' padded')).rejects.toThrow();
    await expect(insert(0, null, 'y'.repeat(41))).rejects.toThrow();
  });
});
