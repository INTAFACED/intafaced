import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger } from '@intafaced/ledger-client';
import { PayService } from '../payment-service.js';
import { RailRegistry } from '../rails/registry.js';
import type { ControlAccessPorts } from './access.js';
import { ApprovalService } from './approvals.js';
import { ChangeService } from './changes.js';
import { ControlService } from './service.js';
import {
  applyChange,
  DEST_A,
  FINANCE,
  MAKER,
  migrations,
  openAdmin,
  OWNER_A,
  principal,
  resetControl,
  TEST_TIER,
} from './control.testkit.js';
import { setBeforeDailyPayoutLock } from './payout-daily-limit.js';

/**
 * TEST VALUES. The 965.55 / 200 pair is the shape from the merchant audit, not a live balance.
 * Approval starts at 1 USDT. Founders are not in this tier, so a merchant approve is the whole decision.
 */
const LIMIT_TIER = {
  ...TEST_TIER,
  id: 'test-payout-daily',
  name: 'TEST VALUE payout limit',
  caps: TEST_TIER.caps.map((cap) => (cap.kind === 'daily_payout' ? { ...cap, limit: '200' } : cap)),
  approvalThresholds: [{ assetCode: 'USDT', amount: '1' }],
  founderThresholds: [{ assetCode: 'USDT', amount: '1000000' }],
};

const BLANK_TIER = {
  ...LIMIT_TIER,
  id: 'test-payout-blank',
  name: 'TEST VALUE no daily payout cap',
  caps: TEST_TIER.caps.filter((cap) => cap.kind !== 'daily_payout'),
};

const CLOCK = new Date('2026-10-17T04:00:00.000Z');
const DAY = '2026-10-17';

describe('payout approval stays inside the remaining daily limit', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let sql!: TestDatabase['sql'];
  let changes!: ChangeService;
  let approvals!: ApprovalService;
  let control!: ControlService;
  let merchantId = '';

  const access = (): ControlAccessPorts => ({
    canViewMerchant: async (p: Principal, m: string) => m === merchantId && [OWNER_A, MAKER, FINANCE].includes(p.userId),
    canApprovePayout: async (p: Principal, m: string) => m === merchantId && [OWNER_A, FINANCE].includes(p.userId),
  });
  const maker = () => principal(MAKER);
  const finance = () => principal(FINANCE);
  const decideInput = (a: { approvalId: string; payloadHash: string }, decision: 'approve' | 'reject' = 'approve') => ({
    approvalId: a.approvalId,
    decision,
    expectedPayloadHash: a.payloadHash,
    reason: 'checked the invoice',
  });

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
    changes = new ChangeService(sql, { now: () => CLOCK });
  }, 120_000);

  beforeEach(async () => {
    setBeforeDailyPayoutLock(undefined);
    await resetControl(sql);
    const pay = new PayService(sql, new MemoryLedger(), new RailRegistry([]), {});
    merchantId = (await pay.createMerchant({ userId: OWNER_A, pricing: { feeBps: 0 } })).id;
    await applyChange(changes, sql, { scope: 'tier', change: { kind: 'upsert_tier', tier: LIMIT_TIER } });
    await applyChange(changes, sql, { scope: 'tier', change: { kind: 'upsert_tier', tier: BLANK_TIER } });
    await applyChange(changes, sql, {
      scope: 'merchant',
      merchantId,
      change: { kind: 'set_tier', tierId: LIMIT_TIER.id, archetypeId: null },
    });
    // A verified, active destination: an unverified one is refused before any request (J-merchant-02 #5).
    await sql`INSERT INTO pay.merchant_payout_destinations (merchant_id, rail_id, kind, ref, verified, verified_at) VALUES (${merchantId}, 'crypto-native', ${DEST_A.kind}, ${DEST_A.ref}, true, now())`;
    const ports = access();
    approvals = new ApprovalService(sql, { access: ports, now: () => CLOCK });
    control = new ControlService(sql, ports, { now: () => CLOCK });
  }, 30_000);

  afterAll(async () => {
    setBeforeDailyPayoutLock(undefined);
    await db?.drop();
    await adminStop();
  }, 30_000);

  async function settlement(net: string, window: string): Promise<string> {
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO pay.settlements (merchant_id, "window", asset_id, gross, fees, net, status)
      VALUES (${merchantId}, ${window}, 'USDT', ${net}, 0, ${net}, 'posted')
      RETURNING id
    `;
    return rows[0]!.id;
  }

  async function request(net: string, window: string) {
    const settlementId = await settlement(net, window);
    return approvals.request(maker(), { merchantId, settlementId, railId: 'crypto-native' });
  }

  async function approvalRow(approvalId: string) {
    const rows = await sql<Array<{ status: string; checker_user_id: string | null }>>`
      SELECT status, checker_user_id FROM pay.control_payout_approvals WHERE id = ${approvalId}
    `;
    return rows[0]!;
  }

  async function decisionAudits(approvalId: string) {
    return sql<Array<{ kind: string }>>`
      SELECT kind FROM pay.control_audit WHERE scope_id = ${approvalId} AND kind = 'payout.approval_decided'
    `;
  }

  async function settlementStatus(settlementId: string) {
    const rows = await sql<Array<{ status: string; payout_ref: string | null }>>`
      SELECT status, payout_ref FROM pay.settlements WHERE id = ${settlementId}
    `;
    return rows[0]!;
  }

  async function capUsed() {
    const rows = await sql<Array<{ used: string }>>`
      SELECT used::text FROM pay.control_cap_usage
       WHERE merchant_id = ${merchantId} AND cap_kind = 'daily_payout' AND asset_code = 'USDT' AND period_key = ${DAY}
    `;
    return rows[0]?.used ?? null;
  }

  async function remainingOnList() {
    const page = await approvals.list(finance(), { merchantId, limit: 20 });
    return page.dailyPayoutRemaining;
  }

  async function remainingOnUsage() {
    const usage = await control.usage(merchantId);
    return usage.rows.find((row) => row.kind === 'daily_payout' && row.assetCode === 'USDT');
  }

  it('refuses an approval above the remaining daily limit and posts nothing', async () => {
    const req = await request('965.55', 'w-over');
    await expect(approvals.decide(finance(), decideInput(req))).rejects.toMatchObject({
      code: 'pay.payout_daily_limit_exceeded',
      remaining: '200',
    });
    expect(await remainingOnList()).toEqual([{ assetCode: 'USDT', remaining: '200' }]);
    expect(await remainingOnUsage()).toMatchObject({ limit: '200', used: '0', remaining: '200' });

    expect(await approvalRow(req.approvalId)).toEqual({ status: 'pending', checker_user_id: null });
    expect(await decisionAudits(req.approvalId)).toEqual([]);
    expect(await settlementStatus(req.settlementId)).toEqual({ status: 'posted', payout_ref: null });
    expect(await capUsed()).toBeNull();
    expect(await remainingOnList()).toEqual([{ assetCode: 'USDT', remaining: '200' }]);

    expect((await approvals.decide(finance(), decideInput(req, 'reject'))).status).toBe('rejected');
    expect(await settlementStatus(req.settlementId)).toEqual({ status: 'posted', payout_ref: null });
  });

  it('approves an amount equal to the remaining limit, then refuses the next one', async () => {
    await sql`
      INSERT INTO pay.control_cap_usage (merchant_id, cap_kind, asset_code, period_key, used)
      VALUES (${merchantId}, 'daily_payout', 'USDT', ${DAY}, 0.25)
    `;
    const exact = await request('199.75', 'w-exact');
    expect((await approvals.decide(finance(), decideInput(exact))).status).toBe('approved');
    expect(await capUsed()).toBe('0.250000000000000000');
    expect(await remainingOnList()).toEqual([{ assetCode: 'USDT', remaining: '0' }]);
    expect(await remainingOnUsage()).toMatchObject({ limit: '200', used: '0.25', remaining: '0' });

    const over = await request('1', 'w-after-exact');
    await expect(approvals.decide(finance(), decideInput(over))).rejects.toMatchObject({
      code: 'pay.payout_daily_limit_exceeded',
      remaining: '0',
    });
    expect(await approvalRow(over.approvalId)).toEqual({ status: 'pending', checker_user_id: null });
    expect(await settlementStatus(over.settlementId)).toEqual({ status: 'posted', payout_ref: null });
  });

  it('lets only one of two concurrent approvals through when together they exceed the limit', async () => {
    const first = await request('120', 'w-race-a');
    const second = await request('120', 'w-race-b');
    let arrived = 0;
    let open!: () => void;
    const bothArrived = new Promise<void>((resolve) => {
      open = resolve;
    });
    setBeforeDailyPayoutLock(async () => {
      arrived += 1;
      if (arrived === 2) open();
      await bothArrived;
    });

    const [a, b] = await Promise.allSettled([
      approvals.decide(finance(), decideInput(first)),
      approvals.decide(finance(), decideInput(second)),
    ]);
    const fulfilled = [a, b].filter((result) => result.status === 'fulfilled');
    const rejected = [a, b].filter((result) => result.status === 'rejected');
    expect(arrived).toBe(2);
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'pay.payout_daily_limit_exceeded',
      remaining: '80',
    });

    const rows = await sql<Array<{ status: string }>>`
      SELECT status FROM pay.control_payout_approvals WHERE id IN (${first.approvalId}, ${second.approvalId}) ORDER BY status
    `;
    expect(rows.map((row) => row.status)).toEqual(['approved', 'pending']);
    expect(await remainingOnList()).toEqual([{ assetCode: 'USDT', remaining: '80' }]);
    expect(await capUsed()).toBe('0.000000000000000000');
  });

  it('refuses when no daily payout limit is configured', async () => {
    await applyChange(changes, sql, {
      scope: 'merchant',
      merchantId,
      change: { kind: 'set_tier', tierId: BLANK_TIER.id, archetypeId: null },
    });
    const req = await request('10', 'w-blank');
    await expect(approvals.decide(finance(), decideInput(req))).rejects.toMatchObject({ code: 'pay.caps_unconfigured' });
    expect(await approvalRow(req.approvalId)).toEqual({ status: 'pending', checker_user_id: null });
    expect(await decisionAudits(req.approvalId)).toEqual([]);
    expect(await settlementStatus(req.settlementId)).toEqual({ status: 'posted', payout_ref: null });
    expect(await remainingOnList()).toEqual([{ assetCode: 'USDT', remaining: null }]);
  });
});
