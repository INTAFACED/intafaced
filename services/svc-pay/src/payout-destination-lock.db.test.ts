import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { ActionApproval, ActionApprovalConsumeInput, Context } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount as amt } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ActionApprovalConsumer } from './action-approval-consume.js';
import { MerchantPayoutDestinationStore } from './merchant-payout-destination.js';
import { PayService } from './payment-service.js';
import { createPayRouter } from './router.js';
import { UserMoneyService } from './user-money-service.js';
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
const authConfig = {
  secret: 'a-test-signing-secret-that-is-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const A = '0x0000000000000000000000000000000000000f01';
const B = '0x0000000000000000000000000000000000000f02';
const RAIL = 'crypto-native';

function openAdmin(): { url: string; stop: () => Promise<void> } {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) throw new Error('TEST_DATABASE_URL is required');
  return { url, stop: async () => undefined };
}

async function ownerContext(userId: string): Promise<Context> {
  const { token } = await issueAccessToken(
    { userId, sessionId: randomUUID(), scopes: ['pay:read', 'pay:write'], tier: 'full', mfa: true },
    authConfig,
  );
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: randomUUID() };
}

async function refused(run: Promise<unknown>): Promise<{ trpc?: string; pay?: string; value?: unknown }> {
  try {
    return { value: await run };
  } catch (err) {
    const error = err as { code?: string; message?: string };
    return { trpc: error.code, pay: /pay\.[a-z0-9_.]+/.exec(error.message ?? '')?.[0] };
  }
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
    await expect(pay.payoutSettlement({ settlementId: settlement.id, railId: RAIL })).rejects.toMatchObject({
      code: 'pay.payout_destination_missing',
    });
    await book.persist({ merchantId: merchant.id, railId: RAIL, kind: 'crypto', ref: A });
    // J-merchant-02 #5: a saved, unverified destination refuses with its own code.
    await expect(pay.payoutSettlement({ settlementId: settlement.id, railId: RAIL })).rejects.toMatchObject({
      code: 'pay.payout_destination_unverified',
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
    expect(added).toEqual({ status: 'held', railId: RAIL, kind: 'crypto', ref: A, activatesAt: '2026-10-17T01:00:00.000Z' });
    // Held: refused before any admission or hold; nothing moves.
    await expect(pay.payoutSettlement({ settlementId: settlement.id, railId: RAIL })).rejects.toMatchObject({
      code: 'pay.payout_destination_held',
      detail: { activatesAt: '2026-10-17T01:00:00.000Z' },
    });
    expect(await sql`SELECT 1 FROM pay.payout_admissions`).toHaveLength(0);
    expect(holds()).toEqual([]);
    expect(chain.outboundTransfers()).toEqual([]);
    now = new Date('2026-10-17T01:00:00.000Z');
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
    now = new Date('2026-10-17T02:00:00.000Z');
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

  it('refuses to remove a verified destination, and a blank hold still refuses the replacement', async () => {
    const previousHold = process.env.PAY_DESTINATION_HOLD_SECONDS;
    delete process.env.PAY_DESTINATION_HOLD_SECONDS;
    try {
      const owner = randomUUID();
      const merchant = await pay.createMerchant({ userId: owner, pricing: { feeBps: 0 } });
      await book.seedVerified({ merchantId: merchant.id, railId: RAIL, kind: 'crypto', ref: A });
      const [row] = await sql<Array<{ id: string; ref: string; verified: boolean }>>`
        SELECT id, ref, verified FROM pay.merchant_payout_destinations WHERE merchant_id = ${merchant.id}
      `;
      expect(row).toMatchObject({ ref: A, verified: true });
      const rails = new RailRegistry([new CryptoNativeAdapter({ chain, secret: SECRET, minConfirmations: 6, toleranceSeconds: 300 })]);
      const caller = createPayRouter(
        pay,
        rails,
        new UserMoneyService(sql, ledger, rails, { operatorCreditRails: [] }),
        null,
        book,
        acceptingApprovals(),
        null,
        undefined,
        sql,
      ).createCaller(await ownerContext(owner));

      const removal = await refused(caller.merchant.payoutDestinations.remove({ merchantId: merchant.id, destinationId: row!.id }));
      expect(removal).toEqual({ trpc: 'CONFLICT', pay: 'pay.payout_destination_verified_locked' });
      const [kept] = await sql<Array<{ ref: string; verified: boolean }>>`
        SELECT ref, verified FROM pay.merchant_payout_destinations WHERE id = ${row!.id}
      `;
      expect(kept).toEqual({ ref: A, verified: true });

      const change = await refused(
        caller.merchant.setPayoutDestination({
          merchantId: merchant.id,
          railId: RAIL,
          kind: 'crypto',
          ref: B,
          stepUpApprovalId: 'ok',
        }),
      );
      expect(change).toEqual({ trpc: 'PRECONDITION_FAILED', pay: 'pay.destination_hold_unset' });
      expect((await book.require({ merchantId: merchant.id, railId: RAIL })).ref).toBe(A);
    } finally {
      if (previousHold === undefined) delete process.env.PAY_DESTINATION_HOLD_SECONDS;
      else process.env.PAY_DESTINATION_HOLD_SECONDS = previousHold;
    }
  });

  it('still removes an unverified destination', async () => {
    const owner = randomUUID();
    const merchant = await pay.createMerchant({ userId: owner, pricing: { feeBps: 0 } });
    await book.persist({ merchantId: merchant.id, railId: RAIL, kind: 'crypto', ref: A });
    const [row] = await sql<Array<{ id: string; verified: boolean }>>`
      SELECT id, verified FROM pay.merchant_payout_destinations WHERE merchant_id = ${merchant.id}
    `;
    expect(row?.verified).toBe(false);
    const rails = new RailRegistry([new CryptoNativeAdapter({ chain, secret: SECRET, minConfirmations: 6, toleranceSeconds: 300 })]);
    const caller = createPayRouter(
      pay,
      rails,
      new UserMoneyService(sql, ledger, rails, { operatorCreditRails: [] }),
      null,
      book,
      acceptingApprovals(),
      null,
      undefined,
      sql,
    ).createCaller(await ownerContext(owner));
    expect(await caller.merchant.payoutDestinations.remove({ merchantId: merchant.id, destinationId: row!.id })).toEqual({
      removed: true,
    });
    expect(await sql`SELECT id FROM pay.merchant_payout_destinations WHERE id = ${row!.id}`).toHaveLength(0);
  });

  it('J-merchant-02 #5 through the router: saved Unverified, verified into the hold, Active at activatesAt, one row throughout', async () => {
    const previousHold = process.env.PAY_DESTINATION_HOLD_SECONDS;
    process.env.PAY_DESTINATION_HOLD_SECONDS = '45';
    try {
      // The router's change door runs on the wall clock, so the store and the list read share it here.
      now = new Date();
      const clocked = new PayService(
        sql,
        ledger,
        new RailRegistry([new CryptoNativeAdapter({ chain, secret: SECRET, minConfirmations: 6, toleranceSeconds: 300 })]),
        {
          payoutDestinations: book,
          checkoutRiskBand: 'low',
          linkDefaultTtlDays: 30,
          linkMaxTtlDays: 365,
          checkoutSessionTtlSeconds: 900,
          maxOpenSessionsPerLink: 25,
          now: () => now,
        },
      );
      const owner = randomUUID();
      const merchant = await clocked.createMerchant({ userId: owner, pricing: { feeBps: 0 } });
      const rails = new RailRegistry([new CryptoNativeAdapter({ chain, secret: SECRET, minConfirmations: 6, toleranceSeconds: 300 })]);
      const caller = createPayRouter(
        clocked,
        rails,
        new UserMoneyService(sql, ledger, rails, { operatorCreditRails: [] }),
        null,
        book,
        acceptingApprovals(),
        null,
        undefined,
        sql,
      ).createCaller(await ownerContext(owner));
      const list = async () => (await caller.merchant.payoutDestinations.list({ merchantId: merchant.id, limit: 10 })).items;

      const saved = await caller.merchant.payoutDestinations.add({ merchantId: merchant.id, railId: RAIL, kind: 'crypto', ref: A });
      expect(saved).toEqual({ status: 'unverified', railId: RAIL, kind: 'crypto', ref: A, activatesAt: null });
      const [unverified] = await list();
      expect(unverified).toMatchObject({ railId: RAIL, kind: 'crypto', state: 'unverified', activatesAt: null });
      await expect(book.require({ merchantId: merchant.id, railId: RAIL })).rejects.toMatchObject({
        code: 'pay.payout_destination_unverified',
      });

      const verified = await caller.merchant.setPayoutDestination({
        merchantId: merchant.id,
        railId: RAIL,
        kind: 'crypto',
        ref: A,
        stepUpApprovalId: 'ok',
      });
      expect(verified.status).toBe('held');
      const stored = async () =>
        (
          await sql<Array<{ verified: boolean; verified_at: Date; activates_at: Date }>>`
            SELECT verified, verified_at, activates_at FROM pay.merchant_payout_destinations WHERE merchant_id = ${merchant.id}
          `
        )[0]!;
      const verifiedAt = await stored();
      expect(verifiedAt.activates_at.getTime() - verifiedAt.verified_at.getTime()).toBe(45_000);
      // Fail closed: while held the row is stored verified = false, so code that reads only `verified` never pays it.
      expect(verifiedAt.verified).toBe(false);
      expect(verified.activatesAt).toBe(verifiedAt.activates_at.toISOString());
      const [held] = await list();
      expect(held).toEqual({ ...unverified, state: 'held', activatesAt: verified.activatesAt });
      // Verifying again keeps the first end.
      expect(
        await caller.merchant.setPayoutDestination({
          merchantId: merchant.id,
          railId: RAIL,
          kind: 'crypto',
          ref: A,
          stepUpApprovalId: 'ok-2',
        }),
      ).toEqual(verified);
      // A save over a verified destination is refused and changes nothing.
      expect(
        await refused(caller.merchant.payoutDestinations.add({ merchantId: merchant.id, railId: RAIL, kind: 'crypto', ref: B })),
      ).toEqual({
        trpc: 'CONFLICT',
        pay: 'pay.payout_destination_verified_locked',
      });

      // A held row is locked like an active one: remove (the unverified-only door) refuses it and deletes nothing.
      const [heldRow] = await list();
      expect(await refused(caller.merchant.payoutDestinations.remove({ merchantId: merchant.id, destinationId: heldRow!.id }))).toEqual({
        trpc: 'CONFLICT',
        pay: 'pay.payout_destination_verified_locked',
      });
      now = new Date(Date.parse(verified.activatesAt!) - 1);
      expect((await list())[0]?.state).toBe('held');
      expect((await stored()).verified).toBe(false);
      now = new Date(verified.activatesAt!);
      const [active] = await list();
      expect(active).toEqual({ ...unverified, state: 'active', activatesAt: null });
      // The list promoted it under the row lock: only now is it stored verified.
      expect((await stored()).verified).toBe(true);
      expect(await book.require({ merchantId: merchant.id, railId: RAIL })).toEqual({ kind: 'crypto', ref: A });
    } finally {
      if (previousHold === undefined) delete process.env.PAY_DESTINATION_HOLD_SECONDS;
      else process.env.PAY_DESTINATION_HOLD_SECONDS = previousHold;
    }
  });

  it('an unverified save never replaces a destination a payout still names, and clears the old default mark', async () => {
    const owner = randomUUID();
    const { merchant, settlement } = await settled(owner, 'w-replace');
    await book.persist({ merchantId: merchant.id, railId: RAIL, kind: 'crypto', ref: A });
    const rails = new RailRegistry([new CryptoNativeAdapter({ chain, secret: SECRET, minConfirmations: 6, toleranceSeconds: 300 })]);
    const caller = createPayRouter(
      pay,
      rails,
      new UserMoneyService(sql, ledger, rails, { operatorCreditRails: [] }),
      null,
      book,
      acceptingApprovals(),
      null,
      undefined,
      sql,
    ).createCaller(await ownerContext(owner));
    const [row] = await sql<Array<{ id: string }>>`SELECT id FROM pay.merchant_payout_destinations WHERE merchant_id = ${merchant.id}`;
    await caller.merchant.payoutDestinations.setDefault({ merchantId: merchant.id, destinationId: row!.id });
    await sql`
      INSERT INTO pay.control_payout_approvals (
        merchant_id, settlement_id, asset_code, amount, rail_id, destination_kind, destination_ref,
        payload_hash, status, founder_required, maker_user_id, expires_at
      ) VALUES (
        ${merchant.id}, ${settlement.id}, 'USDT', 1, ${RAIL}, 'crypto', ${A},
        ${'sha256:' + 'cd'.repeat(32)}, 'pending', false, ${owner}, ${new Date(Date.now() + 3_600_000)}
      )`;
    expect(
      await refused(caller.merchant.payoutDestinations.add({ merchantId: merchant.id, railId: RAIL, kind: 'crypto', ref: B })),
    ).toEqual({
      trpc: 'CONFLICT',
      pay: 'pay.payout_destination_in_flight',
    });
    expect(await sql`SELECT ref, is_default FROM pay.merchant_payout_destinations WHERE id = ${row!.id}`).toEqual([
      { ref: A, is_default: true },
    ]);
    await sql`UPDATE pay.control_payout_approvals SET status = 'voided' WHERE merchant_id = ${merchant.id}`;
    expect(await caller.merchant.payoutDestinations.add({ merchantId: merchant.id, railId: RAIL, kind: 'crypto', ref: B })).toMatchObject({
      status: 'unverified',
      ref: B,
    });
    const [after] = (await caller.merchant.payoutDestinations.list({ merchantId: merchant.id, limit: 10 })).items;
    expect(after).toMatchObject({ id: row!.id, state: 'unverified', defaultFlag: 'unset' });
  });

  it('a held row is promoted lazily by require, and the down migration refuses while any row is inside its hold', async () => {
    const owner = randomUUID();
    const merchant = await pay.createMerchant({ userId: owner, pricing: { feeBps: 0 } });
    await book.transaction(merchant.id, RAIL, async (_row, write) =>
      write.insertVerified({ kind: 'crypto', ref: A, verifiedAt: now, activatesAt: new Date(now.getTime() + 45_000) }),
    );
    const verifiedColumn = async () =>
      (await sql<Array<{ verified: boolean }>>`SELECT verified FROM pay.merchant_payout_destinations WHERE merchant_id = ${merchant.id}`)[0]
        ?.verified;
    expect(await verifiedColumn()).toBe(false);
    await expect(book.require({ merchantId: merchant.id, railId: RAIL })).rejects.toMatchObject({ code: 'pay.payout_destination_held' });
    expect(await verifiedColumn()).toBe(false);

    // The reversal refuses while the hold runs (wall clock: the row's end is set ahead of now()).
    const down = readFileSync(join(drizzleDir, '20261030184034_pay_payout_destination_activates_at.down.sql'), 'utf8');
    await sql`UPDATE pay.merchant_payout_destinations SET activates_at = now() + interval '1 hour' WHERE merchant_id = ${merchant.id}`;
    const ROLLBACK = new Error('rollback');
    await expect(sql.begin(async (tx) => tx.unsafe(down))).rejects.toThrow(/inside their hold/);
    // Once every hold has passed it promotes the due row (active, never unverified) and drops the column.
    await sql`UPDATE pay.merchant_payout_destinations SET activates_at = now() - interval '1 second' WHERE merchant_id = ${merchant.id}`;
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe(down);
        const [row] = await tx<
          Array<{ verified: boolean }>
        >`SELECT verified FROM pay.merchant_payout_destinations WHERE merchant_id = ${merchant.id}`;
        expect(row?.verified).toBe(true);
        const cols = await tx`
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'pay' AND table_name = 'merchant_payout_destinations' AND column_name = 'activates_at'`;
        expect(cols).toHaveLength(0);
        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);

    // Back in the hold's terms (test clock): require at the end promotes it under the row lock and pays it.
    await sql`UPDATE pay.merchant_payout_destinations SET activates_at = ${new Date(now.getTime() + 45_000)} WHERE merchant_id = ${merchant.id}`;
    now = new Date(now.getTime() + 45_000);
    expect(await book.require({ merchantId: merchant.id, railId: RAIL })).toEqual({ kind: 'crypto', ref: A });
    expect(await verifiedColumn()).toBe(true);
  });
});
