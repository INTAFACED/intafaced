import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger } from '@intafaced/ledger-client';
import type { Context } from '@intafaced/contracts';
import { PayService } from '../payment-service.js';
import { RailRegistry } from '../rails/registry.js';
import { ChangeService } from '../control/changes.js';
import { ControlService } from '../control/service.js';
import { teamAccessPorts } from '../control/access.js';
import {
  applyChange,
  migrations,
  openAdmin,
  OWNER_A,
  principal,
  resetControl,
  TEST_GLOBAL_RULE,
  TEST_TIER,
} from '../control/control.testkit.js';
import { createPayNamespaces } from '../namespaces/index.js';
import { effectiveRateBps, FEE_CHANNELS, type MerchantFeeSchedule } from './fee-schedule.js';

/** M-money-out-06 fee schedule and payout fee line. Every rate here is a TEST VALUE. */
describe('merchantControl.pricing.schedule and the preview payout line (M-money-out-06)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let sql!: TestDatabase['sql'];
  let merchantA = '';
  const finance = randomUUID();
  const viewer = randomUUID();
  const stranger = randomUUID();

  const ctxOf = (userId: string): Context => ({ principal: principal(userId), service: null, region: 'DE', requestId: randomUUID() });
  type Preview = { fee: string; net: string; effectiveRateBps: string | null; payoutFee: { status: string }; kind: string };
  const caller = (userId: string) =>
    createPayNamespaces({
      founderAuthority: async () => {
        throw new Error('no founder in this suite');
      },
      control: new ControlService(sql, teamAccessPorts(sql)),
    }).createCaller(ctxOf(userId)) as unknown as {
      merchantControl: {
        pricing: {
          schedule: (input: { merchantId: string }) => Promise<MerchantFeeSchedule>;
          preview: (input: { merchantId: string; assetCode: string; amount: string; monthlyVolume?: string }) => Promise<Preview>;
        };
      };
    };

  async function refusal(fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (e) {
      const err = e as { code: string; message: string; cause?: { code?: string } };
      return { code: err.code, cause: err.cause?.code ?? err.message };
    }
    throw new Error('expected a refusal');
  }

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await resetControl(sql);
    const pay = new PayService(sql, new MemoryLedger(), new RailRegistry([]), {});
    merchantA = (await pay.createMerchant({ userId: OWNER_A, pricing: { feeBps: 0 } })).id;
    for (const [user, role] of [
      [finance, 'finance'],
      [viewer, 'viewer'],
    ] as const) {
      await sql`
        INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by, activated_at)
        VALUES (${merchantA}, ${user}, ${role}, 'active', ${OWNER_A}, now())`;
    }
  }, 30_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  async function priceIt() {
    const changes = new ChangeService(sql);
    await applyChange(changes, sql, { scope: 'tier', change: { kind: 'upsert_tier', tier: TEST_TIER } });
    await applyChange(changes, sql, {
      scope: 'merchant',
      merchantId: merchantA,
      change: { kind: 'set_tier', tierId: TEST_TIER.id, archetypeId: null },
    });
    await applyChange(changes, sql, {
      scope: 'pricing',
      change: { kind: 'set_pricing_layer', layer: 'global', scopeId: null, rules: [TEST_GLOBAL_RULE] },
    });
  }

  it('no rule for any asset reads not_configured, with the payout line still "not charged"', async () => {
    expect(await caller(OWNER_A).merchantControl.pricing.schedule({ merchantId: merchantA })).toEqual({
      status: 'not_configured',
      merchantId: merchantA,
      payoutFee: { status: 'not_charged' },
    });
  });

  it('owner and finance see the full schedule, the same row for every channel', async () => {
    await priceIt();
    for (const user of [OWNER_A, finance]) {
      const view = await caller(user).merchantControl.pricing.schedule({ merchantId: merchantA });
      expect(view).toMatchObject({
        status: 'configured',
        view: 'full',
        channels: [...FEE_CHANNELS],
        samePricingForEveryChannel: true,
        payoutFee: { status: 'not_charged' },
      });
      if (view.status !== 'configured' || view.view !== 'full') throw new Error('expected the full view');
      expect(view.rows).toHaveLength(1);
      expect(view.rows[0]).toMatchObject({
        assetCode: 'USDT',
        layer: 'global',
        bands: [{ fromAmount: '0', feeBps: 250, flatFee: '0.3' }],
        minFee: null,
        maxFee: null,
        spreadBps: 40,
      });
    }
  });

  it('any other role sees the headline rate only', async () => {
    await priceIt();
    expect(await caller(viewer).merchantControl.pricing.schedule({ merchantId: merchantA })).toEqual({
      status: 'configured',
      merchantId: merchantA,
      view: 'headline',
      rows: [{ assetCode: 'USDT', headlineFeeBps: 250 }],
      payoutFee: { status: 'not_charged' },
    });
  });

  it('a stranger is refused like a missing merchant', async () => {
    await priceIt();
    expect(await refusal(() => caller(stranger).merchantControl.pricing.schedule({ merchantId: merchantA }))).toMatchObject({
      cause: 'pay.merchant_not_found',
    });
  });

  it('the preview is labelled a quote, shows the effective rate and a payout line that reads not charged', async () => {
    await priceIt();
    const q = await caller(OWNER_A).merchantControl.pricing.preview({
      merchantId: merchantA,
      assetCode: 'USDT',
      amount: '100',
      monthlyVolume: '0',
    });
    // 2.5% of 100 plus 0.3 flat = 2.8, i.e. 280 bps of the amount.
    expect(q).toMatchObject({ fee: '2.8', net: '97.2', effectiveRateBps: '280.0000', payoutFee: { status: 'not_charged' }, kind: 'quote' });
  });

  it('a blank fee for the asset refuses to quote', async () => {
    await priceIt();
    expect(
      await refusal(() => caller(OWNER_A).merchantControl.pricing.preview({ merchantId: merchantA, assetCode: 'USDC', amount: '100' })),
    ).toMatchObject({ cause: 'pay.pricing_unconfigured' });
  });

  it('effectiveRateBps rounds down to four places and has no rate for a zero amount', () => {
    expect(effectiveRateBps(1n, 3n)).toBe('3333.3333');
    expect(effectiveRateBps(0n, 5n)).toBe('0.0000');
    expect(effectiveRateBps(1n, 0n)).toBeNull();
  });
});
