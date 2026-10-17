import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ActionApproval, ActionApprovalConsumeInput } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount as amt } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ActionApprovalConsumer } from './action-approval-consume.js';
import { MerchantPayoutDestinationStore } from './merchant-payout-destination.js';
import { PayService } from './payment-service.js';
import {
  PAY_DESTINATION_STEP_UP,
  PayoutDestinationChange,
  roleOnMerchantForDestination,
  verifyDestinationStepUp,
} from './payout-destination-change.js';
import { truncatePayForTest } from './payment-events-test-reset.js';
import { CryptoNativeAdapter } from './rails/crypto-native.js';
import { MemoryChain } from './rails/chain-port.js';
import { RailRegistry } from './rails/registry.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));

const SECRET = 'svc-pay-payout-dest-lock-secret-at-least-32';
const A = '0x0000000000000000000000000000000000000f01';
const B = '0x0000000000000000000000000000000000000f02';
const RAIL = 'crypto-native';

function openAdmin(): { url: string; stop: () => Promise<void> } {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) throw new Error('TEST_DATABASE_URL is required');
  return { url, stop: async () => undefined };
}

function acceptingApprovals(): ActionApprovalConsumer {
  return {
    async consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> {
      const userId = input.principalUserId ?? 'missing';
      return {
        approvalId: input.approvalId,
        actionType: PAY_DESTINATION_STEP_UP,
        targetService: 'svc-pay',
        targetId: PAY_DESTINATION_STEP_UP,
        expectedVersion: '1',
        payloadHash: input.payloadHash,
        requesterId: userId,
        approverId: userId,
        policyVersion: '1',
        createdAt: '2026-10-17T00:00:00.000Z',
        expiresAt: '2026-10-17T00:05:00.000Z',
        status: 'CONSUMED',
        operationId: input.operationId,
        kind: 'same_person',
      };
    },
  };
}

describe('payout destination lock', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let chain: MemoryChain;
  let pay: PayService;
  let book: MerchantPayoutDestinationStore;
  let now = new Date('2026-10-17T00:00:00.000Z');

  beforeAll(async () => {
    const admin = openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
  }, 180_000);

  beforeEach(async () => {
    await truncatePayForTest(sql, 'pay', 'TRUNCATE pay.merchants RESTART IDENTITY CASCADE');
    now = new Date('2026-10-17T00:00:00.000Z');
    ledger = new MemoryLedger();
    chain = new MemoryChain();
    const rails = new RailRegistry([new CryptoNativeAdapter({ chain, secret: SECRET, minConfirmations: 6, toleranceSeconds: 300 })]);
    book = new MerchantPayoutDestinationStore(sql, () => now);
    pay = new PayService(sql, ledger, rails, {
      payoutDestinations: book,
      checkoutRiskBand: 'low',
      linkDefaultTtlDays: 30,
      linkMaxTtlDays: 365,
      checkoutSessionTtlSeconds: 900,
      maxOpenSessionsPerLink: 25,
    });
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 60_000);

  async function settled(userId: string, window: string) {
    const merchant = await pay.createMerchant({ userId, pricing: { feeBps: 0 } });
    const payment = await pay.createPayment({
      merchantId: merchant.id,
      amount: amt('10'),
      assetId: 'USDT',
      method: 'crypto',
      railAdapter: RAIL,
    });
    const address = await chain.acceptanceAddress(payment.id, 'USDT');
    chain.credit({ address, assetId: 'USDT', amount: amt('10'), from: '0xbuyer', confirmations: 12 });
    await pay.authorize(payment.id);
    await pay.capture(payment.id);
    const settlement = await pay.settleWindow({
      merchantId: merchant.id,
      window,
      assetId: 'USDT',
      from: new Date(0),
      to: new Date('2030-01-01T00:00:00.000Z'),
    });
    return { merchant, settlement };
  }

  function holds() {
    return ledger.journal().filter((tx) => tx.idempotencyKey.includes('payout'));
  }

  it('refuses a named destination and leaves the stored one unchanged', async () => {
    const owner = randomUUID();
    const { merchant, settlement } = await settled(owner, 'w-named');
    await book.seedVerified({ merchantId: merchant.id, railId: RAIL, kind: 'crypto', ref: A });
    await expect(
      pay.payoutSettlement({ settlementId: settlement.id, railId: RAIL, destination: { kind: 'crypto', ref: B } }),
    ).rejects.toMatchObject({ code: 'pay.payout_destination_not_allowed' });
    expect((await book.read({ merchantId: merchant.id, railId: RAIL }))?.ref).toBe(A);
    expect(await sql`SELECT 1 FROM pay.payout_admissions`).toHaveLength(0);
    expect(holds()).toEqual([]);
    const paid = await pay.payoutSettlement({ settlementId: settlement.id, railId: RAIL });
    expect(paid.status).toBe('paid_out');
    expect(chain.outboundTransfers().map((send) => send.to)).toEqual([A]);
  });

  it('refuses a payout when nothing verified is stored and posts nothing', async () => {
    const owner = randomUUID();
    const { merchant, settlement } = await settled(owner, 'w-missing');
    await book.persist({ merchantId: merchant.id, railId: RAIL, kind: 'crypto', ref: A });
    await expect(pay.payoutSettlement({ settlementId: settlement.id, railId: RAIL })).rejects.toMatchObject({
      code: 'pay.payout_destination_missing',
    });
    const [row] = await sql<Array<{ verified: boolean; ref: string }>>`
      SELECT verified, ref FROM pay.merchant_payout_destinations WHERE merchant_id = ${merchant.id}
    `;
    expect(row).toMatchObject({ verified: false, ref: A });
    const [count] = await sql<Array<{ unverified: number }>>`
      SELECT count(*)::int AS unverified FROM pay.merchant_payout_destinations WHERE verified = false
    `;
    expect(count?.unverified).toBe(1);
    expect(await sql`SELECT 1 FROM pay.payout_admissions`).toHaveLength(0);
    expect(holds()).toEqual([]);
  });

  it('stages a step-up change until the hold passes, then pays the new destination', async () => {
    const owner = randomUUID();
    const finance = randomUUID();
    const { merchant, settlement } = await settled(owner, 'w-hold');
    await sql`
      INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by, activated_at)
      VALUES (${merchant.id}, ${finance}, 'finance', 'active', ${owner}, now())
    `;
    const change = new PayoutDestinationChange(
      book,
      (userId, merchantId) => roleOnMerchantForDestination(sql, userId, merchantId),
      verifyDestinationStepUp,
      acceptingApprovals(),
      3600,
      async () => undefined,
      () => now,
    );
    const person = { userId: owner, sessionId: randomUUID(), viaApiKey: false, interactive: true };
    await expect(change.set({ caller: person, merchantId: merchant.id, railId: RAIL, kind: 'crypto', ref: A })).rejects.toMatchObject({
      code: 'pay.destination_step_up_required',
    });
    await expect(
      change.set({
        caller: { ...person, viaApiKey: true },
        merchantId: merchant.id,
        railId: RAIL,
        kind: 'crypto',
        ref: A,
        stepUpApprovalId: 'ok',
      }),
    ).rejects.toMatchObject({ code: 'pay.destination_api_key_refused' });
    await expect(
      change.set({
        caller: { ...person, userId: finance },
        merchantId: merchant.id,
        railId: RAIL,
        kind: 'crypto',
        ref: A,
        stepUpApprovalId: 'ok',
      }),
    ).rejects.toMatchObject({ code: 'pay.destination_role_forbidden' });
    expect(await book.read({ merchantId: merchant.id, railId: RAIL })).toBeNull();

    const added = await change.set({
      caller: person,
      merchantId: merchant.id,
      railId: RAIL,
      kind: 'crypto',
      ref: A,
      stepUpApprovalId: 'ok',
    });
    expect(added.status).toBe('active');
    const pending = await change.set({
      caller: person,
      merchantId: merchant.id,
      railId: RAIL,
      kind: 'crypto',
      ref: B,
      stepUpApprovalId: 'ok-2',
    });
    expect(pending.status).toBe('pending');
    expect((await book.require({ merchantId: merchant.id, railId: RAIL })).ref).toBe(A);
    const paidOld = await pay.payoutSettlement({ settlementId: settlement.id, railId: RAIL });
    expect(paidOld.status).toBe('paid_out');
    expect(chain.outboundTransfers().at(-1)?.to).toBe(A);

    const again = await pay.createPayment({
      merchantId: merchant.id,
      amount: amt('10'),
      assetId: 'USDT',
      method: 'crypto',
      railAdapter: RAIL,
    });
    const againAddress = await chain.acceptanceAddress(again.id, 'USDT');
    chain.credit({ address: againAddress, assetId: 'USDT', amount: amt('10'), from: '0xbuyer', confirmations: 12 });
    await pay.authorize(again.id);
    await pay.capture(again.id);
    now = new Date('2026-10-17T01:00:00.000Z');
    const second = await pay.settleWindow({
      merchantId: merchant.id,
      window: 'w-hold-2',
      assetId: 'USDT',
      from: new Date(0),
      to: new Date('2030-01-01T00:00:00.000Z'),
    });
    expect((await book.require({ merchantId: merchant.id, railId: RAIL })).ref).toBe(B);
    const paidNew = await pay.payoutSettlement({ settlementId: second.id, railId: RAIL });
    expect(paidNew.status).toBe('paid_out');
    expect(chain.outboundTransfers().at(-1)?.to).toBe(B);
  });
});
