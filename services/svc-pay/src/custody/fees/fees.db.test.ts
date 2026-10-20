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
import type { FeeEstimate, FeeEstimator } from './service.js';

/**
 * Network fees, managed nonce and gas policy (W-custody-ops-10) through the real founderAdmin router against a real
 * Postgres. Figures are TEST values from a fake estimator; nothing here is a balance or a live price.
 */
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
    .withDatabase('intafaced_custody_fees_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const FOUNDER = 'founder-a';
type Err = { code: string; message?: string };
async function refused(p: Promise<unknown>): Promise<Err> {
  try {
    await p;
  } catch (e) {
    return e as Err;
  }
  throw new Error('expected the call to be refused');
}

const ESTIMATE: FeeEstimate = { unit: 'TESTUNIT', low: '10', medium: '20', high: '40', asOf: '2026-10-20T10:00:00.000Z' };

describe('custody fees and gas policy (real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let founderOk = true;
  let estimate: FeeEstimate | 'down' = ESTIMATE;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let api: any;
  let apiNoEstimator: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const fees = () => api.founderAdmin.custody.fees;
  const gas = () => api.founderAdmin.custody.gas;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    const founderAuthority = async () => {
      if (!founderOk) throw new MerchantControlError('operator.denied');
      return FOUNDER;
    };
    const estimator: FeeEstimator = {
      estimate: async () => {
        if (estimate === 'down') throw new Error('rpc down');
        return estimate;
      },
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
    api = createPayNamespaces({ founderAuthority, custody: { sql: db.sql, feeEstimator: estimator } }).createCaller(ctx);
    apiNoEstimator = createPayNamespaces({ founderAuthority, custody: { sql: db.sql } }).createCaller(ctx);
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  beforeEach(async () => {
    founderOk = true;
    estimate = ESTIMATE;
    await db.sql.unsafe(`TRUNCATE pay.network_fee_settings_events, pay.gas_policy_events, pay.gas_refuels RESTART IDENTITY`);
    await db.sql.unsafe(`DELETE FROM pay.wallet_routes`);
    await db.sql.unsafe(`DELETE FROM pay.network_registry`);
    await db.sql`INSERT INTO pay.network_registry (network_id, display_name, asset_codes, updated_by)
                 VALUES ('testnet-evm', 'Test network', ${db.sql.json(['USDT'] as never)}, 'seed')`;
  }, 30_000);

  const feeBody = (o: Record<string, unknown> = {}) => ({
    networkId: 'testnet-evm',
    feeLevel: 'medium',
    feeCap: '25',
    feeUnit: 'TESTUNIT',
    managedNonce: true,
    reason: 'Set for the test network',
    ...o,
  });
  const gasBody = (o: Record<string, unknown> = {}) => ({
    networkId: 'testnet-evm',
    feePayer: 'station',
    gasThreshold: '5',
    gasCap: '50',
    maxGasPrice: '100',
    autoTopUp: false,
    reason: 'Initial gas policy',
    ...o,
  });

  describe('fee settings', () => {
    it('shows every registered network as unconfigured until a founder sets it, with no invented figure', async () => {
      const [row] = await fees().list({ limit: 10 });
      expect(row).toMatchObject({ networkId: 'testnet-evm', configured: false, feeLevel: null, feeCap: null, managedNonce: null });
      expect((await fees().get({ networkId: 'testnet-evm' })).configured).toBe(false);
    });

    it('sets the level, cap, unit and nonce switch; the latest row is the setting and the history keeps the rest', async () => {
      await fees().set(feeBody());
      const second = await fees().set(feeBody({ feeLevel: 'high', feeCap: '30', managedNonce: false }));
      expect(second).toMatchObject({ configured: true, feeLevel: 'high', managedNonce: false, setBy: FOUNDER });
      expect(second.feeCap).toBe('30.000000000000000000');
      expect((await fees().history({ networkId: 'testnet-evm', limit: 10 })).map((r: { feeLevel: string }) => r.feeLevel)).toEqual([
        'high',
        'medium',
      ]);
    });

    it('refuses an unknown network, and parses strictly: no blank cap, no number cap, no extra field', async () => {
      expect((await refused(fees().set(feeBody({ networkId: 'nowhere' })))).message).toContain('custody_fees.network_unknown');
      expect((await refused(fees().get({ networkId: 'nowhere' }))).message).toContain('custody_fees.network_unknown');
      expect((await refused(fees().set(feeBody({ feeCap: '' })))).code).toBe('BAD_REQUEST');
      expect((await refused(fees().set(feeBody({ feeCap: '0x1' })))).code).toBe('BAD_REQUEST');
      expect((await refused(fees().set(feeBody({ feeCap: 25 })))).code).toBe('BAD_REQUEST');
      expect((await refused(fees().set(feeBody({ feeLevel: 'urgent' })))).code).toBe('BAD_REQUEST');
      expect((await refused(fees().set({ ...feeBody(), extra: 1 }))).code).toBe('BAD_REQUEST');
      expect((await refused(fees().set(feeBody({ feeCap: '0.000' })))).code).toBe('BAD_REQUEST');
    });
  });

  describe('estimate and the send check', () => {
    it('refuses the estimate and the check while no estimator is wired, never inventing a figure', async () => {
      const out = await refused(apiNoEstimator.founderAdmin.custody.fees.estimate({ networkId: 'testnet-evm' }));
      expect(out.code).toBe('PRECONDITION_FAILED');
      expect(out.message).toContain('custody_fees.estimator_unwired');
    });

    it('reads the tiers and marks each inside or outside the cap', async () => {
      await fees().set(feeBody());
      expect(await fees().estimate({ networkId: 'testnet-evm' })).toEqual({
        networkId: 'testnet-evm',
        unit: 'TESTUNIT',
        asOf: ESTIMATE.asOf,
        tiers: { low: '10', medium: '20', high: '40' },
        withinCap: { low: true, medium: true, high: false },
      });
    });

    it('marks the tiers unknown, not fine, when no cap is set or the cap is in another unit', async () => {
      expect((await fees().estimate({ networkId: 'testnet-evm' })).withinCap).toEqual({ low: null, medium: null, high: null });
      await fees().set(feeBody({ feeUnit: 'OTHER' }));
      expect((await fees().estimate({ networkId: 'testnet-evm' })).withinCap.low).toBeNull();
    });

    it('a send passes inside the cap and reports the level, fee and nonce switch', async () => {
      await fees().set(feeBody());
      expect(await fees().check({ networkId: 'testnet-evm' })).toMatchObject({
        level: 'medium',
        fee: '20',
        unit: 'TESTUNIT',
        managedNonce: true,
      });
      expect((await fees().check({ networkId: 'testnet-evm', level: 'low' })).fee).toBe('10');
    });

    it('a fee above the cap is refused', async () => {
      await fees().set(feeBody());
      const out = await refused(fees().check({ networkId: 'testnet-evm', level: 'high' }));
      expect(out.code).toBe('PRECONDITION_FAILED');
      expect(out.message).toContain('custody_fees.fee_above_cap');
      // A cap exactly equal to the fee is allowed; one unit below is not.
      await fees().set(feeBody({ feeCap: '40' }));
      expect((await fees().check({ networkId: 'testnet-evm', level: 'high' })).fee).toBe('40');
      await fees().set(feeBody({ feeCap: '39.999999999999999999' }));
      expect((await refused(fees().check({ networkId: 'testnet-evm', level: 'high' }))).message).toContain('custody_fees.fee_above_cap');
    });

    it('a blank cap refuses the send, and so does an estimate in another unit or a down estimator', async () => {
      expect((await refused(fees().check({ networkId: 'testnet-evm' }))).message).toContain('custody_fees.cap_unset');
      await fees().set(feeBody());
      estimate = { ...ESTIMATE, unit: 'OTHER' };
      expect((await refused(fees().check({ networkId: 'testnet-evm' }))).message).toContain('custody_fees.unit_mismatch');
      estimate = 'down';
      expect((await refused(fees().check({ networkId: 'testnet-evm' }))).message).toContain('custody_fees.estimate_failed');
    });
  });

  describe('gas policy and refuels', () => {
    it('reads unconfigured with the execution blocker named, then sets and updates the policy', async () => {
      expect(await gas().policy.get({ networkId: 'testnet-evm' })).toMatchObject({
        configured: false,
        feePayer: null,
        gasCap: null,
        executionBlocker: 'rail.crypto',
      });
      const set = await gas().policy.set(gasBody());
      expect(set).toMatchObject({
        configured: true,
        feePayer: 'station',
        autoTopUp: false,
        setBy: FOUNDER,
        executionBlocker: 'rail.crypto',
      });
      const next = await gas().policy.set(gasBody({ feePayer: 'relay', autoTopUp: true }));
      expect(next).toMatchObject({ feePayer: 'relay', autoTopUp: true });
    });

    it('needs every figure: a blank, zero or unknown payer is a parse error', async () => {
      for (const bad of [{ gasThreshold: '' }, { gasCap: '' }, { maxGasPrice: '' }, { feePayer: 'sponsor' }, { autoTopUp: undefined }]) {
        expect((await refused(gas().policy.set(gasBody(bad)))).code).toBe('BAD_REQUEST');
      }
      expect((await refused(gas().policy.set(gasBody({ networkId: 'nowhere' })))).message).toContain('custody_fees.network_unknown');
    });

    it('records a refuel once per reference, lists it, and refuses a different refuel under the same reference', async () => {
      const first = await gas().refuels.record({
        refuelRef: 'refuel:1',
        networkId: 'testnet-evm',
        amount: '2',
        txRef: 'tx-1',
        reason: 'Topped up the fee payer',
      });
      expect(first).toMatchObject({ refuelRef: 'refuel:1', recordedBy: FOUNDER });
      expect(
        await gas().refuels.record({
          refuelRef: 'refuel:1',
          networkId: 'testnet-evm',
          amount: '2',
          txRef: 'tx-1',
          reason: 'Topped up the fee payer',
        }),
      ).toEqual(first);
      const out = await refused(
        gas().refuels.record({
          refuelRef: 'refuel:1',
          networkId: 'testnet-evm',
          amount: '3',
          txRef: 'tx-1',
          reason: 'Topped up the fee payer',
        }),
      );
      expect(out.message).toContain('custody_fees.refuel_differs');
      expect(await gas().refuels.list({ limit: 10 })).toHaveLength(1);
    });
  });

  it('is founder-only everywhere, and no row is ever edited or deleted', async () => {
    await fees().set(feeBody());
    await gas().policy.set(gasBody());
    await gas().refuels.record({ refuelRef: 'refuel:1', networkId: 'testnet-evm', amount: '2', txRef: 'tx-1', reason: 'Topped up' });
    await expect(db.sql`UPDATE pay.network_fee_settings_events SET fee_unit = 'X'`).rejects.toThrow(/not permitted/);
    await expect(db.sql`DELETE FROM pay.gas_policy_events`).rejects.toThrow(/not permitted/);
    await expect(db.sql`DELETE FROM pay.gas_refuels`).rejects.toThrow(/not permitted/);

    founderOk = false;
    expect((await refused(fees().get({ networkId: 'testnet-evm' }))).code).toBe('FORBIDDEN');
    expect((await refused(fees().set(feeBody()))).code).toBe('FORBIDDEN');
    expect((await refused(fees().check({ networkId: 'testnet-evm' }))).code).toBe('FORBIDDEN');
    expect((await refused(gas().policy.set(gasBody()))).code).toBe('FORBIDDEN');
    expect((await refused(gas().refuels.list({ limit: 10 }))).code).toBe('FORBIDDEN');
  });
});
