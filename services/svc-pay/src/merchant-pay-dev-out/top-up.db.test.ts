import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, formatAmount, parseAmount as amt } from '@intafaced/ledger-client';
import type { Context } from '@intafaced/contracts';
import { PayService } from '../payment-service.js';
import { RailRegistry } from '../rails/registry.js';
import { CardSandboxAdapter } from '../rails/card-sandbox.js';
import { memoryPayoutDestinations } from '../merchant-payout-destination.js';
import { ControlService } from '../control/service.js';
import { ownerAccessPorts } from '../control/access.js';
import { migrations, openAdmin, OWNER_A, OWNER_B, principal, resetControl } from '../control/control.testkit.js';
import { createPayNamespaces } from '../namespaces/index.js';

/**
 * M-money-out-02: with no top-up rail wired, the top-up read refuses with its own code after the ownership check,
 * returns nothing and moves nothing. Every amount here is a TEST VALUE.
 */
describe('merchantControl.topUp.options (no top-up rail)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let sql!: TestDatabase['sql'];
  let pay!: PayService;
  let ledger!: MemoryLedger;
  let merchantA = '';

  const SECRET = 'svc-pay-test-secret-at-least-32-characters';
  /** TEST VALUE: a settled 40 USDT card payment, so "unchanged" is a real balance staying put, not zero staying zero. */
  const settledForty = async () => {
    const created = await pay.createPayment({
      merchantId: merchantA,
      amount: amt('40'),
      assetId: 'USDT',
      method: 'card',
      railAdapter: 'card-sandbox',
      instrument: { kind: 'card', token: 'tok_ok' },
    });
    await pay.capture((await pay.authorize(created.id)).id);
    await pay.settleWindow({
      merchantId: merchantA,
      window: `w-top-up-${merchantA.slice(0, 8)}`,
      assetId: 'USDT',
      from: new Date(Date.now() - 24 * 3600_000),
      to: new Date(Date.now() + 24 * 3600_000),
    });
  };
  const ctxOf = (userId: string): Context => ({ principal: principal(userId), service: null, region: 'DE', requestId: randomUUID() });
  // Wired like the service: the same PayService and ledger the balance is read from, so a top-up path that ever
  // reached either would show in the invariant below.
  const caller = (userId: string) =>
    createPayNamespaces({
      founderAuthority: async () => {
        throw new Error('no founder in this suite');
      },
      control: new ControlService(sql, ownerAccessPorts(sql)),
      pay,
      ledger,
      sql,
    }).createCaller(ctxOf(userId)) as unknown as {
      merchantControl: { topUp: { options: (input: { merchantId: string }) => Promise<unknown> } };
    };
  const refusal = (promise: Promise<unknown>) =>
    promise.then(
      (data) => ({ data }),
      (e: { code: string; message: string; cause?: { code?: string } }) => ({ code: e.code, message: e.message, cause: e.cause?.code }),
    );

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await resetControl(sql);
    ledger = new MemoryLedger();
    pay = new PayService(sql, ledger, new RailRegistry([new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 })]), {
      payoutDestinations: memoryPayoutDestinations(),
      linkDefaultTtlDays: 30,
      linkMaxTtlDays: 365,
      checkoutSessionTtlSeconds: 900,
      maxOpenSessionsPerLink: 25,
    });
    merchantA = (await pay.createMerchant({ userId: OWNER_A, pricing: { feeBps: 0 } })).id;
  }, 30_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  it('the owner is refused pay.topup_unconfigured (412) and gets no instruction', async () => {
    expect(await refusal(caller(OWNER_A).merchantControl.topUp.options({ merchantId: merchantA }))).toEqual({
      code: 'PRECONDITION_FAILED',
      message: 'pay.topup_unconfigured',
      cause: 'pay.topup_unconfigured',
    });
  });

  it('never touches the ledger: no entry is posted and the balance reads the same after the refusal', async () => {
    await settledForty();
    const before = await pay.merchantBalance(merchantA, 'USDT');
    expect(formatAmount(before)).toBe('40');
    const journal = structuredClone(ledger.journal());
    expect(journal.length).toBeGreaterThan(0);
    expect(await refusal(caller(OWNER_A).merchantControl.topUp.options({ merchantId: merchantA }))).toMatchObject({
      message: 'pay.topup_unconfigured',
    });
    expect(ledger.journal()).toEqual(journal);
    expect(await pay.merchantBalance(merchantA, 'USDT')).toEqual(before);
  });

  it('another owner and an unknown business get the same not-found, never the rail refusal', async () => {
    const foreign = await refusal(caller(OWNER_B).merchantControl.topUp.options({ merchantId: merchantA }));
    const ghost = await refusal(caller(OWNER_A).merchantControl.topUp.options({ merchantId: randomUUID() }));
    expect(foreign).toMatchObject({ message: 'pay.merchant_not_found' });
    expect(ghost).toEqual(foreign);
  });
});
