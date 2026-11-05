/**
 * Holds on received funds, the stranger class (PP-money-balance-05; J-pay-03 #5), against the shared test Postgres and
 * the in-memory ledger. The admin URL names database `test`, which assertTestDatabase refuses; this file rewrites that
 * name to `intafaced_test` on the same server, as the other bank suites do.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken, type Scope } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import {
  MemoryLedger,
  formatAmount,
  parseAmount,
  payReceivedHoldAccount,
  recipes,
  userAvailable,
  type LedgerClient,
  type PostRequest,
} from '@intafaced/ledger-client';
import { createBankRouter } from '../router.js';
import { createBankServices, memoryLedgerHistory, memoryRecipientState, type BankServices } from '../bank-service.js';
import { memoryPartyHandles } from '../transfers/party-handles.js';
import { RELEASE_DATE_ACTOR } from './received-holds.js';

const ADA = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const CY = '33333333-3333-4333-8333-333333333333';
const SID = '44444444-4444-4444-8444-444444444444';
const DAY_MS = 86_400_000;

const tokenConfig = {
  secret: 'recvhold-test-signing-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is unset');
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

describe('holds on received funds: a stranger’s payment waits, and is accepted or denied once (Postgres)', () => {
  let db: TestDatabase;
  let ledger: MemoryLedger;
  let bank: BankServices;
  let router: ReturnType<typeof createBankRouter>;
  /** When set, the next hold post fails before it reaches the ledger (a lost step the recovery timer must finish). */
  let failNextHold: boolean;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'bank', url: adminUrl(), migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  async function build(holdDays: number | null) {
    ledger = new MemoryLedger();
    failNextHold = false;
    // The bank's own client, with a switch that loses one hold post before it is sent.
    const client = new Proxy(ledger, {
      get(target, prop, receiver) {
        if (prop === 'post')
          return async (request: PostRequest) => {
            if (failNextHold && request.idempotencyKey.startsWith('pay.recv.hold:')) {
              failNextHold = false;
              throw new Error('connection reset before the hold was sent');
            }
            return target.post(request);
          };
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as LedgerClient;
    bank = createBankServices(db.sql, client as MemoryLedger, memoryLedgerHistory(ledger), {
      nativeAssetId: 'IFC',
      recipients: memoryRecipientState(),
      handles: memoryPartyHandles({ [ADA]: 'ada', [BOB]: 'bob', [CY]: 'cy' }),
      // LOCAL TEST release period: a held payment waits 30 days for an answer.
      strangerHoldDays: holdDays,
    });
    router = createBankRouter(bank);
    for (const who of [ADA, BOB, CY]) await bank.spaces.ensurePrimary(who, 'USDT');
    for (const who of [ADA, CY])
      await ledger.post(
        recipes.deposit({ userId: who, assetId: 'USDT', amount: parseAmount('100'), rail: 'test', railRef: `${who}-${Math.random()}` }),
      );
    await db.sql`
      INSERT INTO bank.personal_transfer_terms (asset_id, per_transfer_limit, daily_limit, fee) VALUES ('USDT', 1000, 10000, 0) ON CONFLICT DO NOTHING
    `;
  }

  beforeEach(async () => {
    await db.sql`
      TRUNCATE bank.received_holds, bank.receive_rules, bank.personal_transfers, bank.personal_requests,
               bank.personal_transfer_terms, bank.spaces
      RESTART IDENTITY CASCADE
    `;
    await build(30);
  });

  async function caller(userId: string, scopes: Scope[] = ['bank:read', 'bank:write']) {
    const { token } = await issueAccessToken({ userId, sessionId: SID, scopes, tier: 'full', mfa: true }, tokenConfig);
    const ctx: Context = { principal: await verifyAccessToken(token, tokenConfig), service: null, region: 'DE', requestId: 'recvhold' };
    return router.createCaller(ctx);
  }

  const available = async (userId: string) => formatAmount((await ledger.balance(userAvailable(userId, 'USDT'))).amount);
  const held = async (userId: string, transferId: string) =>
    formatAmount((await ledger.balance(payReceivedHoldAccount(userId, 'USDT', transferId))).amount);
  const posts = (prefix: string) => ledger.journal().filter((tx) => tx.idempotencyKey.startsWith(prefix));

  async function pay(from: string, to: string, transferId: string, amount: string) {
    const space = await bank.spaces.ensurePrimary(from, 'USDT');
    return (await caller(from)).transfers.toUser({ transferId, fromSpaceId: space.id, toUserId: to, amount });
  }

  it('pays a stranger in by default; with "hold", the payment is set aside, listed with its reason and date, and Accept releases it once', async () => {
    const bob = await caller(BOB);
    expect(await bob.holds.rule()).toEqual({ strangers: 'pay_in', holdDays: 30 });
    await pay(ADA, BOB, 'recv-default-1', '5');
    expect(await available(BOB)).toBe('5');
    expect(posts('pay.recv.hold:')).toHaveLength(0);

    expect(await bob.holds.setRule({ strangers: 'hold' })).toEqual({ strangers: 'hold', holdDays: 30 });
    expect(await bob.holds.rule()).toEqual({ strangers: 'hold', holdDays: 30 });
    const before = Date.now();
    await pay(CY, BOB, 'recv-held-1', '7');
    // Held: the sender paid, and the money is the recipient's but set aside, not available.
    expect(await available(CY)).toBe('93');
    expect(await available(BOB)).toBe('5');
    expect(await held(BOB, 'recv-held-1')).toBe('7');
    const [waiting, ...rest] = await bob.holds.waiting();
    expect(rest).toHaveLength(0);
    expect(waiting).toMatchObject({ transferId: 'recv-held-1', state: 'held', reasonClass: 'stranger', amount: '7', assetId: 'USDT', fromHandle: 'cy' });
    const releaseAt = Date.parse(waiting!.releaseAt);
    expect(releaseAt).toBeGreaterThanOrEqual(before + 30 * DAY_MS);
    expect(releaseAt).toBeLessThanOrEqual(Date.now() + 30 * DAY_MS);

    expect(await bob.holds.accept({ transferId: 'recv-held-1' })).toMatchObject({ state: 'released', amount: '7' });
    expect(await available(BOB)).toBe('12');
    expect(await held(BOB, 'recv-held-1')).toBe('0');
    // The same answer again is the same outcome, never a second post; the other answer is refused.
    expect(await bob.holds.accept({ transferId: 'recv-held-1' })).toMatchObject({ state: 'released' });
    await expect(bob.holds.deny({ transferId: 'recv-held-1' })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('bank.received_hold_decided'),
    });
    expect(posts('pay.recv.hold:')).toHaveLength(1);
    expect(posts('pay.recv.release:')).toHaveLength(1);
    expect(posts('pay.recv.return:')).toHaveLength(0);
    expect(await bob.holds.waiting()).toEqual([]);
    expect(await available(CY)).toBe('93');
  });

  it('Deny returns the whole payment to the sender once; Accept after it is refused', async () => {
    const bob = await caller(BOB);
    await bob.holds.setRule({ strangers: 'hold' });
    await pay(CY, BOB, 'recv-deny-1', '4');
    expect(await bob.holds.deny({ transferId: 'recv-deny-1' })).toMatchObject({ state: 'returned', amount: '4' });
    expect(await available(CY)).toBe('100');
    expect(await available(BOB)).toBe('0');
    expect(await held(BOB, 'recv-deny-1')).toBe('0');
    expect(await bob.holds.deny({ transferId: 'recv-deny-1' })).toMatchObject({ state: 'returned' });
    await expect(bob.holds.accept({ transferId: 'recv-deny-1' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(posts('pay.recv.return:')).toHaveLength(1);
    expect(posts('pay.recv.release:')).toHaveLength(0);
  });

  it('holds only strangers: someone the recipient has paid, and a payment of their own request, go straight in', async () => {
    const bob = await caller(BOB);
    await bob.holds.setRule({ strangers: 'hold' });
    // Bob receives from Ada (held, then accepted), then pays Ada: Ada is now someone Bob has paid.
    await pay(ADA, BOB, 'recv-known-0', '10');
    await bob.holds.accept({ transferId: 'recv-known-0' });
    await pay(BOB, ADA, 'recv-known-1', '1');
    await pay(ADA, BOB, 'recv-known-2', '3');
    expect(await available(BOB)).toBe('12');
    expect(posts('pay.recv.hold:')).toHaveLength(1);
    // Cy pays Bob's request: Bob asked, so it is not a stranger's payment.
    const request = await bob.personalRequest.create({
      payerUserId: CY,
      assetId: 'USDT',
      amount: '2',
      expiresAt: new Date(Date.now() + DAY_MS).toISOString(),
      idempotencyKey: 'recv-request-ask-1',
    });
    const cySpace = await bank.spaces.ensurePrimary(CY, 'USDT');
    await (await caller(CY)).transfers.toUser({
      transferId: 'recv-request-1',
      fromSpaceId: cySpace.id,
      toUserId: BOB,
      amount: '2',
      requestId: request.requestId,
    });
    expect(await available(BOB)).toBe('14');
    expect(posts('pay.recv.hold:')).toHaveLength(1);
  });

  it('only the recipient sees and answers a hold; anyone else reads the same not-found as a missing id', async () => {
    await (await caller(BOB)).holds.setRule({ strangers: 'hold' });
    await pay(CY, BOB, 'recv-own-1', '2');
    for (const who of [ADA, CY]) {
      const other = await caller(who);
      expect(await other.holds.waiting()).toEqual([]);
      for (const answer of ['accept', 'deny'] as const)
        await expect(other.holds[answer]({ transferId: 'recv-own-1' })).rejects.toMatchObject({
          code: 'NOT_FOUND',
          message: expect.stringContaining('bank.received_hold_not_found'),
        });
    }
    await expect((await caller(BOB)).holds.accept({ transferId: 'no-such-hold' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect((await caller(BOB, ['bank:read'])).holds.accept({ transferId: 'recv-own-1' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await held(BOB, 'recv-own-1')).toBe('2');
  });

  it('a blank release period refuses "hold" by its code, and a payment under an older choice is paid in, never held without a date', async () => {
    await (await caller(BOB)).holds.setRule({ strangers: 'hold' });
    await build(null);
    const bob = await caller(BOB);
    expect(await bob.holds.rule()).toEqual({ strangers: 'hold', holdDays: null });
    await expect(bob.holds.setRule({ strangers: 'hold' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('bank.stranger_hold_period_unset'),
    });
    await pay(CY, BOB, 'recv-blank-1', '3');
    expect(await available(BOB)).toBe('3');
    expect(posts('pay.recv.hold:')).toHaveLength(0);
    expect(await bob.holds.setRule({ strangers: 'pay_in' })).toEqual({ strangers: 'pay_in', holdDays: null });
  });

  it('a hold nobody answers goes back to the sender at its release date, once, by the recovery timer', async () => {
    const bob = await caller(BOB);
    await bob.holds.setRule({ strangers: 'hold' });
    await pay(CY, BOB, 'recv-expire-1', '6');
    expect(await bank.receivedHolds.sweep(10, new Date(Date.now() + 29 * DAY_MS))).toEqual([]);
    expect(await held(BOB, 'recv-expire-1')).toBe('6');
    const later = new Date(Date.now() + 31 * DAY_MS);
    expect(await bank.receivedHolds.sweep(10, later)).toEqual([{ outcome: 'completed' }]);
    expect(await bank.receivedHolds.sweep(10, later)).toEqual([]);
    expect(await available(CY)).toBe('100');
    expect(await held(BOB, 'recv-expire-1')).toBe('0');
    const [row] = await db.sql<Array<{ state: string; decided_by: string }>>`
      SELECT state, decided_by FROM bank.received_holds WHERE transfer_id = 'recv-expire-1'
    `;
    expect(row).toEqual({ state: 'returned', decided_by: RELEASE_DATE_ACTOR });
    expect(posts('pay.recv.return:')).toHaveLength(1);
  });

  it('a hold post lost after the send posted is finished by the recovery timer; the send’s answer stands and nothing is lost', async () => {
    const bob = await caller(BOB);
    await bob.holds.setRule({ strangers: 'hold' });
    failNextHold = true;
    await pay(CY, BOB, 'recv-lost-1', '5');
    // The send posted; the hold did not yet. The money is Bob's, and the hold row is the decision still owed.
    expect(await available(CY)).toBe('95');
    const [row] = await db.sql<Array<{ state: string }>>`SELECT state FROM bank.received_holds WHERE transfer_id = 'recv-lost-1'`;
    expect(row?.state).toBe('placing');
    // Accept before it is set aside is refused by its code, and moves nothing.
    await expect(bob.holds.accept({ transferId: 'recv-lost-1' })).rejects.toMatchObject({
      message: expect.stringContaining('bank.received_hold_not_ready'),
    });
    expect(await bank.receivedHolds.sweep(10)).toEqual([{ outcome: 'completed' }]);
    expect(await held(BOB, 'recv-lost-1')).toBe('5');
    expect(await available(BOB)).toBe('0');
    expect((await bob.holds.waiting()).map((h) => h.state)).toEqual(['held']);
    expect(posts('pay.recv.hold:')).toHaveLength(1);
  });

  it('invariant: across every outcome the recipient’s available plus held equals what they were paid, and the senders’ books balance', async () => {
    const bob = await caller(BOB);
    await bob.holds.setRule({ strangers: 'hold' });
    await pay(CY, BOB, 'recv-inv-1', '1');
    await pay(CY, BOB, 'recv-inv-2', '2');
    await pay(CY, BOB, 'recv-inv-3', '3');
    await bob.holds.accept({ transferId: 'recv-inv-1' });
    await bob.holds.deny({ transferId: 'recv-inv-2' });
    const bobTotal =
      parseAmount(await available(BOB)) +
      parseAmount(await held(BOB, 'recv-inv-1')) +
      parseAmount(await held(BOB, 'recv-inv-2')) +
      parseAmount(await held(BOB, 'recv-inv-3'));
    expect(formatAmount(bobTotal)).toBe('4');
    expect(await available(CY)).toBe('96');
    expect(formatAmount(parseAmount(await available(CY)) + bobTotal)).toBe('100');
  });
});
