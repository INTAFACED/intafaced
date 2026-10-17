import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { merchantControlProfileSchema } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, formatAmount, merchantProceeds, parseAmount as amt } from '@intafaced/ledger-client';
import { PayService } from '../payment-service.js';
import { MerchantPayoutDestinationStore } from '../merchant-payout-destination.js';
import { RailRegistry } from '../rails/registry.js';
import { CardSandboxAdapter } from '../rails/card-sandbox.js';
import { CryptoNativeAdapter } from '../rails/crypto-native.js';
import { BankPayoutAbsentAdapter } from '../rails/bank-payout.js';
import { MemoryChain } from '../rails/chain-port.js';
import { REFERENCE_RAIL_ROUTING_PROFILES } from '../routing/decide.js';
import { ChangeService } from './changes.js';
import { ControlService } from './service.js';
import { ownerAccessPorts } from './access.js';
import { RESERVE_NOT_ENFORCED } from './reserve.js';
import { applyChange, FOUNDER_1, migrations, openAdmin, OWNER_A, resetControl, SECRET } from './control.testkit.js';

const DEST = { kind: 'crypto', ref: '0x0000000000000000000000000000000000000f01' };

/**
 * Rolling reserve is not booked. A non-null reserve cannot be saved, an existing
 * one cannot be paid out in full, a cleared one pays the same net as before, and
 * the founder read says the percentage is not enforced.
 */
describe('rolling reserve fails closed until a ledger recipe exists', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let chain: MemoryChain;
  let pay!: PayService;
  let changes!: ChangeService;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
    changes = new ChangeService(sql);
  }, 120_000);

  beforeEach(async () => {
    await resetControl(sql);
    ledger = new MemoryLedger();
    chain = new MemoryChain();
    pay = new PayService(
      sql,
      ledger,
      new RailRegistry([
        new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 }),
        new CryptoNativeAdapter({ chain, secret: SECRET, minConfirmations: 6, toleranceSeconds: 300 }),
        new BankPayoutAbsentAdapter(),
      ]),
      {
        payoutDestinations: new MerchantPayoutDestinationStore(sql),
        checkoutRiskBand: 'low',
        routingProfiles: REFERENCE_RAIL_ROUTING_PROFILES.map((p) => ({ ...p })),
        linkDefaultTtlDays: 30,
        linkMaxTtlDays: 365,
        checkoutSessionTtlSeconds: 900,
        maxOpenSessionsPerLink: 25,
      },
    );
  }, 30_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  async function merchant() {
    return pay.createMerchant({ userId: OWNER_A, pricing: { feeBps: 0 } });
  }

  async function settled(merchantId: string, window: string) {
    const created = await pay.createPayment({
      requestId: randomUUID(),
      merchantId,
      amount: amt('10'),
      assetId: 'USDT',
      method: 'crypto',
      railAdapter: 'crypto-native',
    });
    const address = await chain.acceptanceAddress(created.id, 'USDT');
    chain.credit({ address, assetId: 'USDT', amount: amt('10'), from: '0xbuyer', confirmations: 12 });
    await pay.authorize(created.id);
    await pay.capture(created.id);
    return pay.settleWindow({
      merchantId,
      window,
      assetId: 'USDT',
      from: new Date(Date.now() - 86_400_000),
      to: new Date(Date.now() + 86_400_000),
    });
  }

  const proceeds = (merchantId: string) => ledger.balance(merchantProceeds(merchantId, 'USDT')).then((b) => formatAmount(b.amount));

  it('refuses a non-null reserve and writes nothing', async () => {
    const m = await merchant();
    const requestId = randomUUID();
    await expect(
      changes.submit(FOUNDER_1, {
        requestId,
        target: {
          scope: 'merchant',
          merchantId: m.id,
          change: { kind: 'set_reserve', reserve: { rollingReserveBps: 1000, holdDays: 7 } },
        },
        reason: 'hold ten percent',
        expectedVersion: '0',
      }),
    ).rejects.toMatchObject({ code: 'pay.reserve_ledger_unwired' });
    await expect(
      changes.submit(FOUNDER_1, {
        requestId: randomUUID(),
        target: {
          scope: 'merchant',
          merchantId: m.id,
          change: { kind: 'set_reserve', reserve: { rollingReserveBps: 0, holdDays: 0 } },
        },
        reason: 'zero is still a reserve',
        expectedVersion: '0',
      }),
    ).rejects.toMatchObject({ code: 'pay.reserve_ledger_unwired' });
    expect((await sql`SELECT 1 FROM pay.control_changes WHERE request_id = ${requestId}`).length).toBe(0);
    expect((await sql`SELECT 1 FROM pay.control_merchant_profiles WHERE merchant_id = ${m.id}`).length).toBe(0);
    expect((await sql`SELECT 1 FROM pay.control_audit WHERE merchant_id = ${m.id}`).length).toBe(0);
  });

  it('still clears a reserve, and the read does not call that held', async () => {
    const m = await merchant();
    await applyChange(changes, sql, {
      scope: 'merchant',
      merchantId: m.id,
      change: { kind: 'set_reserve', reserve: { rollingReserveBps: null, holdDays: null } },
    });
    const profile = await new ControlService(sql, ownerAccessPorts(sql)).profile(m.id);
    expect(profile.reserve).toEqual({ rollingReserveBps: null, holdDays: null });
    expect(merchantControlProfileSchema.safeParse(profile).success).toBe(true);
  });

  it('refuses payout of a reserve already on the merchant and does not pay the net', async () => {
    const m = await merchant();
    await sql`
      INSERT INTO pay.control_merchant_profiles (merchant_id, reserve_override)
      VALUES (${m.id}, ${sql.json({ rollingReserveBps: 1000, holdDays: 7 })})
    `;
    const before = await sql<Array<{ reserve_override: unknown }>>`
      SELECT reserve_override FROM pay.control_merchant_profiles WHERE merchant_id = ${m.id}
    `;
    const profile = await new ControlService(sql, ownerAccessPorts(sql)).profile(m.id);
    expect(profile.reserve).toEqual({ rollingReserveBps: 1000, holdDays: 7, enforcement: RESERVE_NOT_ENFORCED });
    expect(merchantControlProfileSchema.safeParse(profile).success).toBe(true);

    const settlement = await settled(m.id, 'w-reserved');
    expect(formatAmount(settlement.net)).toBe('10');
    expect(await proceeds(m.id)).toBe('10');
    await expect(pay.payoutSettlement({ settlementId: settlement.id, railId: 'crypto-native', destination: DEST })).rejects.toMatchObject({
      code: 'pay.reserve_ledger_unwired',
    });

    expect((await pay.getSettlement(settlement.id)).status).toBe('posted');
    expect(await proceeds(m.id)).toBe('10');
    expect((await sql`SELECT 1 FROM pay.payout_admissions WHERE settlement_id = ${settlement.id}`).length).toBe(0);
    expect(chain.totalSent('USDT')).toBe('0');
    const after = await sql<Array<{ reserve_override: unknown }>>`
      SELECT reserve_override FROM pay.control_merchant_profiles WHERE merchant_id = ${m.id}
    `;
    expect(after[0]?.reserve_override).toEqual(before[0]?.reserve_override);
  });

  it('pays the full net when the reserve is null', async () => {
    const m = await merchant();
    await sql`
      INSERT INTO pay.control_merchant_profiles (merchant_id, reserve_override)
      VALUES (${m.id}, ${sql.json({ rollingReserveBps: null, holdDays: null })})
    `;
    const profile = await new ControlService(sql, ownerAccessPorts(sql)).profile(m.id);
    expect(profile.reserve).toEqual({ rollingReserveBps: null, holdDays: null });
    expect(merchantControlProfileSchema.safeParse(profile).success).toBe(true);

    const settlement = await settled(m.id, 'w-clear');
    const paid = await pay.payoutSettlement({ settlementId: settlement.id, railId: 'crypto-native', destination: DEST });
    expect(paid.status).toBe('paid_out');
    expect(formatAmount(paid.net)).toBe(formatAmount(settlement.net));
    expect(formatAmount(paid.net)).toBe('10');
    expect(await proceeds(m.id)).toBe('0');
    expect(chain.totalSent('USDT')).toBe('10');
  });
});
