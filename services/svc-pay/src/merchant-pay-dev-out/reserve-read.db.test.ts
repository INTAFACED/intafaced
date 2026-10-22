import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger } from '@intafaced/ledger-client';
import type { Context } from '@intafaced/contracts';
import { PayService } from '../payment-service.js';
import { RailRegistry } from '../rails/registry.js';
import { ChangeService } from '../control/changes.js';
import { ControlService } from '../control/service.js';
import { ownerAccessPorts } from '../control/access.js';
import {
  applyChange,
  migrations,
  openAdmin,
  OWNER_A,
  OWNER_B,
  principal,
  resetControl,
  TEST_GLOBAL_RULE,
  TEST_TIER,
} from '../control/control.testkit.js';
import { createPayNamespaces } from '../namespaces/index.js';
import { readMerchantReserve, RESERVE_HOLDING } from './reserve-read.js';

/**
 * M-money-out-01 reserve read. Every amount here is a TEST VALUE.
 * The reserve is recorded on settlement snapshots and never held on the ledger.
 */
describe('merchantControl.reserve (recorded, not withheld)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let sql!: TestDatabase['sql'];
  let pay!: PayService;
  let ledger!: MemoryLedger;
  let merchantA = '';
  let ruleId = '';
  const NOW = new Date('2026-10-22T00:00:00.000Z');

  const ctxOf = (userId: string): Context => ({ principal: principal(userId), service: null, region: 'DE', requestId: randomUUID() });
  const caller = (userId: string) =>
    createPayNamespaces({
      founderAuthority: async () => {
        throw new Error('no founder in this suite');
      },
      control: new ControlService(sql, ownerAccessPorts(sql), { now: () => NOW }),
    }).createCaller(ctxOf(userId)) as unknown as {
      merchantControl: { reserve: (input: { merchantId: string }) => Promise<Awaited<ReturnType<typeof readMerchantReserve>>> };
    };

  async function snapshot(over: {
    kind?: 'payment' | 'settlement';
    asset?: string;
    amount: string | null;
    releaseAt: string | null;
    status?: 'unwired' | 'booked' | null;
    merchantId?: string;
  }) {
    const status = over.status === undefined ? (over.amount === null ? null : 'unwired') : over.status;
    await sql`
      INSERT INTO pay.control_pricing_snapshots (
        subject_kind, subject_id, merchant_id, asset_code, applied_layer, rule_id, rule_chain,
        base_amount, monthly_volume_before, band_from, fee_bps, rounding_beneficiary, rounding_mode,
        bps_fee, fee_before_clamp, fee, reserve_bps, reserve_hold_days, reserve_amount, reserve_release_at, reserve_ledger_status
      ) VALUES (
        ${over.kind ?? 'settlement'}, ${randomUUID()}, ${over.merchantId ?? merchantA}, ${over.asset ?? 'USDT'}, 'global', ${ruleId}, ${sql.json([])},
        '100', '0', '0', 250, 'platform', 'ceil', '2.5', '2.8', '2.8',
        ${over.amount === null ? null : 1000}, ${over.amount === null ? null : 7}, ${over.amount}::numeric, ${over.releaseAt}, ${status}
      )`;
  }

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await resetControl(sql);
    ledger = new MemoryLedger();
    pay = new PayService(sql, ledger, new RailRegistry([]), {});
    merchantA = (await pay.createMerchant({ userId: OWNER_A, pricing: { feeBps: 0 } })).id;
    const changes = new ChangeService(sql);
    await applyChange(changes, sql, { scope: 'tier', change: { kind: 'upsert_tier', tier: TEST_TIER } });
    await applyChange(changes, sql, {
      scope: 'pricing',
      change: { kind: 'set_pricing_layer', layer: 'global', scopeId: null, rules: [TEST_GLOBAL_RULE] },
    });
    ruleId = (await sql<Array<{ id: string }>>`SELECT id FROM pay.control_pricing_rules LIMIT 1`)[0]!.id;
  }, 30_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  it('a merchant with no rule and no recorded reserve reads empty, not refused', async () => {
    const view = await caller(OWNER_A).merchantControl.reserve({ merchantId: merchantA });
    expect(view).toEqual({
      merchantId: merchantA,
      rule: null,
      holding: RESERVE_HOLDING,
      payoutsRefused: false,
      assets: [],
      readAt: NOW.toISOString(),
    });
  });

  it('sums recorded reserve per asset inside its window, labels it not withheld, and says payouts are refused', async () => {
    await applyChange(new ChangeService(sql), sql, {
      scope: 'merchant',
      merchantId: merchantA,
      change: { kind: 'set_tier', tierId: TEST_TIER.id, archetypeId: null },
    });
    await snapshot({ amount: '7.5', releaseAt: '2026-10-25T00:00:00Z' });
    await snapshot({ amount: '2.500000000000000001', releaseAt: '2026-10-28T00:00:00Z' });
    await snapshot({ asset: 'USDC', amount: '10', releaseAt: '2026-10-24T00:00:00Z' });

    const view = await caller(OWNER_A).merchantControl.reserve({ merchantId: merchantA });
    expect(view.rule).toEqual({ rollingReserveBps: 1000, holdDays: 7 });
    expect(view.holding).toBe('recorded_not_withheld');
    expect(view.payoutsRefused).toBe(true);
    expect(view.assets).toEqual([
      {
        assetCode: 'USDC',
        recordedAmount: '10',
        entries: 1,
        nextReleaseAt: '2026-10-24T00:00:00.000Z',
        lastReleaseAt: '2026-10-24T00:00:00.000Z',
      },
      {
        assetCode: 'USDT',
        recordedAmount: '10.000000000000000001',
        entries: 2,
        nextReleaseAt: '2026-10-25T00:00:00.000Z',
        lastReleaseAt: '2026-10-28T00:00:00.000Z',
      },
    ]);
    expect(typeof view.assets[0]!.recordedAmount).toBe('string');
  });

  it('leaves out released, booked, payment-side, empty and other merchants’ rows', async () => {
    const merchantB = (await pay.createMerchant({ userId: OWNER_B, pricing: { feeBps: 0 } })).id;
    await snapshot({ amount: '1', releaseAt: '2026-10-21T00:00:00Z' }); // window already over
    await snapshot({ amount: '1', releaseAt: NOW.toISOString() }); // ends exactly now
    await snapshot({ amount: '1', releaseAt: '2026-10-30T00:00:00Z', status: 'booked' });
    await snapshot({ kind: 'payment', amount: '1', releaseAt: '2026-10-30T00:00:00Z' });
    await snapshot({ amount: null, releaseAt: null });
    await snapshot({ merchantId: merchantB, amount: '99', releaseAt: '2026-10-30T00:00:00Z' });
    await snapshot({ amount: '3', releaseAt: null });

    const view = await readMerchantReserve(sql, merchantA, NOW);
    expect(view.assets).toEqual([{ assetCode: 'USDT', recordedAmount: '3', entries: 1, nextReleaseAt: null, lastReleaseAt: null }]);
  });

  it('never touches the ledger: balances are the same before and after the read', async () => {
    await snapshot({ amount: '5', releaseAt: '2026-10-30T00:00:00Z' });
    const before = await pay.merchantBalance(merchantA, 'USDT');
    await caller(OWNER_A).merchantControl.reserve({ merchantId: merchantA });
    expect(await pay.merchantBalance(merchantA, 'USDT')).toBe(before);
  });

  it('another owner and an unknown merchant get the same not-found', async () => {
    await expect(caller(OWNER_B).merchantControl.reserve({ merchantId: merchantA })).rejects.toMatchObject({
      message: 'pay.merchant_not_found',
    });
    await expect(caller(OWNER_A).merchantControl.reserve({ merchantId: randomUUID() })).rejects.toMatchObject({
      message: 'pay.merchant_not_found',
    });
  });

  it('an unreadable control row refuses as unavailable instead of reading as no reserve', async () => {
    await sql`INSERT INTO pay.control_merchant_profiles (merchant_id, reserve_override) VALUES (${merchantA}, ${sql.json({ rollingReserveBps: 'x' } as never)})`;
    await expect(readMerchantReserve(sql, merchantA, NOW)).rejects.toMatchObject({ code: 'pay.control_unreadable' });
  });
});
