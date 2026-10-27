import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { BankInternalWithdrawalInput, BankInternalWithdrawalPort, BankInternalWithdrawalResult } from '@intafaced/contracts';
import { MemoryLedger, parseAmount as amt } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCustodyPolicyGuards } from '../custody/policy/guards.js';
import { CardSandboxAdapter } from '../rails/card-sandbox.js';
import { RailRegistry } from '../rails/registry.js';
import { composeGuards, PayGuardRefusal, type GuardReplay, type PartialPayGuards } from '../seams/guards.js';
import { assetExposure, UNWIRED_CONVERSION_INVENTORY } from '../treasury/exposure.js';
import { createTreasuryGuards } from '../treasury/guards.js';
import { UserMoneyService } from '../user-money-service.js';
import { INTERNAL_RAIL } from './internal.js';

/**
 * Internal settlement (W-withdraw-14, J-wallet-07 #3-#5) against a real Postgres. svc-bank's door is a fake that keeps
 * svc-bank's one promise: one send per key, posted at most once (its own behaviour is proven in svc-bank's db test).
 * TEST figures only.
 */
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_withdrawal_internal_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const USER = '11111111-1111-4111-8111-111111111111';
const FRIEND = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';
const FRIEND_ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OWN_ADDRESS = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const OUTSIDE_ADDRESS = '0xcccccccccccccccccccccccccccccccccccccccc';
const to = (ref: string) => ({ kind: 'crypto', ref });
const UNKNOWN: BankInternalWithdrawalResult = { state: 'unknown', code: 'bank.internal_withdrawal_unknown' };

type Step = 'post' | 'refuse' | 'lose' | 'post-then-lose';

/** svc-bank as the contract promises it: one send per key, posted once; `lose` drops the answer (the send may or may not land). */
function fakeBank() {
  const posted = new Map<string, string>();
  const calls: BankInternalWithdrawalInput[] = [];
  const script: Step[] = [];
  const port: BankInternalWithdrawalPort = {
    async settle(input) {
      calls.push(input);
      const step = script.shift() ?? 'post';
      if (step === 'refuse')
        return posted.has(input.transferId)
          ? { state: 'posted', transferId: input.transferId, ledgerTxId: posted.get(input.transferId)! }
          : { state: 'refused', code: 'ledger.insufficient_funds' };
      if (step === 'lose') return UNKNOWN;
      if (!posted.has(input.transferId)) posted.set(input.transferId, `bank-tx-${posted.size + 1}`);
      if (step === 'post-then-lose') return UNKNOWN;
      return { state: 'posted', transferId: input.transferId, ledgerTxId: posted.get(input.transferId)! };
    },
  };
  return { port, posted, calls, next: (...steps: Step[]) => script.push(...steps) };
}

describe('internal withdrawal settlement (real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let bank: ReturnType<typeof fakeBank>;
  let seen: Array<{ rail: string; replay: GuardReplay['kind'] }>;
  let money: UserMoneyService;
  const rails = new RailRegistry([new CardSandboxAdapter({ secret: 'svc-pay-internal-withdrawal-secret-32+', toleranceSeconds: 300 })]);

  /** Every claim's guard context is recorded, so a test can say which rail and which replay kind the guards saw. */
  const recorder: PartialPayGuards = {
    beforeUserMoneyWithdrawal: async (ctx) => void seen.push({ rail: ctx.rail, replay: ctx.replay.kind }),
  };
  const service = (options: { guards?: PartialPayGuards; port?: BankInternalWithdrawalPort | null } = {}) =>
    new UserMoneyService(db.sql, new MemoryLedger(), rails, {
      operatorCreditRails: [],
      claimGuards: options.guards ? composeGuards(recorder, options.guards) : recorder,
      internalSettlement: options.port === null ? undefined : (options.port ?? bank.port),
    });

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  async function address(userId: string, ref: string, o: { network?: string; expiresAt?: Date } = {}) {
    await db.sql`
      INSERT INTO pay.custody_deposit_addresses (user_id, asset_id, network_id, address, address_index, expires_at)
      VALUES (${userId}, 'USDT', ${o.network ?? 'ethereum'}, ${ref}, ${o.expiresAt ? 1 : 0}, ${o.expiresAt ?? null})`;
  }

  beforeEach(async () => {
    await db.sql`TRUNCATE pay.withdrawals, pay.custody_deposit_addresses, pay.custody_deposit_address_freezes RESTART IDENTITY CASCADE`;
    bank = fakeBank();
    seen = [];
    money = service();
    await address(FRIEND, FRIEND_ADDRESS);
    await address(USER, OWN_ADDRESS);
  });

  const send = (o: { ref?: string; clientRef?: string; amount?: string; svc?: UserMoneyService } = {}) =>
    (o.svc ?? money).withdrawInternal({
      userId: USER,
      assetId: 'USDT',
      amount: amt(o.amount ?? '25'),
      destination: to(o.ref ?? FRIEND_ADDRESS),
      clientRef: o.clientRef ?? 'w-internal-1',
    });
  const rows = () =>
    db.sql<Array<{ id: string; status: string; rail: string; rail_ref: string | null; failure_code: string | null; attempts: number }>>`
      SELECT id, status, rail, rail_ref, failure_code, attempts FROM pay.withdrawals ORDER BY created_at`;
  const journal = (id: string) =>
    db.sql<Array<{ attempt: number; outcome: string; rail_ref: string | null }>>`
      SELECT attempt, outcome, rail_ref FROM pay.withdrawal_rail_attempts WHERE withdrawal_id = ${id} ORDER BY attempt`;

  it('settles a withdrawal to a friend on the platform as one send keyed on the withdrawal, and a retry is the same send', async () => {
    const out = await send();
    expect(out).toMatchObject({ status: 'sent', rail: INTERNAL_RAIL, railRef: 'bank-tx-1' });
    expect(bank.calls).toEqual([{ transferId: `withdraw:${out.id}`, fromUserId: USER, toUserId: FRIEND, assetId: 'USDT', amount: '25' }]);
    const [row] = await rows();
    expect(row).toMatchObject({ status: 'sent', rail: INTERNAL_RAIL, rail_ref: 'bank-tx-1', failure_code: null });
    expect(await journal(out.id)).toEqual([{ attempt: 0, outcome: 'accepted', rail_ref: 'bank-tx-1' }]);
    // Every withdrawal guard ran on the claim, for the internal rail.
    expect(seen).toEqual([{ rail: INTERNAL_RAIL, replay: 'fresh' }]);

    const again = await send();
    expect(again).toMatchObject({ id: out.id, status: 'sent', railRef: 'bank-tx-1' });
    expect(bank.calls).toHaveLength(1);
    expect(bank.posted.size).toBe(1);
  });

  it('refuses a send to one of your own addresses before anything is claimed, whatever the letter case', async () => {
    for (const ref of [OWN_ADDRESS, OWN_ADDRESS.toUpperCase().replace('0X', '0x')]) {
      await expect(send({ ref })).rejects.toMatchObject({ code: 'pay.withdrawal_self_send' });
    }
    expect(await rows()).toEqual([]);
    expect(bank.calls).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('refuses an internal send to an address no account holds, and the read says external', async () => {
    await expect(send({ ref: OUTSIDE_ADDRESS })).rejects.toMatchObject({ code: 'pay.internal_destination_external' });
    expect(await money.platformDestination(USER, to(OUTSIDE_ADDRESS))).toEqual({ kind: 'external' });
    expect(await money.platformDestination(USER, { kind: 'bank', ref: FRIEND_ADDRESS })).toEqual({ kind: 'external' });
    expect(await money.platformDestination(USER, to(FRIEND_ADDRESS))).toEqual({ kind: 'internal' });
    expect(await money.platformDestination(USER, to(OWN_ADDRESS))).toEqual({ kind: 'self' });
    expect(await rows()).toEqual([]);
    expect(bank.calls).toEqual([]);
  });

  it('refuses a frozen, an expired and an ambiguous platform address before anything is claimed, never disclosing a freeze', async () => {
    await db.sql`
      INSERT INTO pay.custody_deposit_address_freezes (user_id, network_id, address, reason, frozen_by)
      VALUES (${FRIEND}, 'ethereum', ${FRIEND_ADDRESS}, 'TEST freeze', 'founder-a')`;
    await expect(send()).rejects.toMatchObject({ code: 'pay.internal_destination_unavailable', detail: { reason: 'unavailable' } });
    expect(await money.platformDestination(USER, to(FRIEND_ADDRESS))).toEqual({ kind: 'unavailable', reason: 'unavailable' });

    const expired = '0xdddddddddddddddddddddddddddddddddddddddd';
    await address(FRIEND, expired, { expiresAt: new Date(Date.now() - 60_000) });
    await expect(send({ ref: expired })).rejects.toMatchObject({ detail: { reason: 'expired' } });

    const shared = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    await address(FRIEND, shared, { network: 'polygon' });
    await address(STRANGER, shared, { network: 'base' });
    await expect(send({ ref: shared })).rejects.toMatchObject({ detail: { reason: 'unavailable' } });
    expect(await money.platformDestination(USER, to(shared))).toEqual({ kind: 'unavailable', reason: 'unavailable' });

    expect(await rows()).toEqual([]);
    expect(bank.calls).toEqual([]);
  });

  it('matches an EVM address in any case and every other address exactly, and an address is expired only when every row is', async () => {
    const base58 = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    await address(FRIEND, base58, { network: 'solana' });
    expect(await money.platformDestination(USER, to(base58))).toEqual({ kind: 'internal' });
    // A differently cased base58 address is a different address, so it is someone outside.
    expect(await money.platformDestination(USER, to(base58.toLowerCase()))).toEqual({ kind: 'external' });
    expect(await money.platformDestination(USER, to(FRIEND_ADDRESS.toUpperCase().replace('0X', '0x')))).toEqual({ kind: 'internal' });

    // One EVM address on two networks: past its expiry on one, still live on the other, so it can take a transfer.
    const rotated = '0x1111111111111111111111111111111111111111';
    await address(FRIEND, rotated, { expiresAt: new Date(Date.now() - 60_000) });
    await address(FRIEND, rotated, { network: 'polygon' });
    expect(await money.platformDestination(USER, to(rotated))).toEqual({ kind: 'internal' });
  });

  it('a claim that crashed before its journal asked nothing, so a freeze since then refuses it like a new send', async () => {
    await db.sql`
      INSERT INTO pay.withdrawals (user_id, asset_id, amount, rail, destination, client_ref, status)
      VALUES (${USER}, 'USDT', 25, ${INTERNAL_RAIL}, ${db.sql.json(to(FRIEND_ADDRESS))}, 'w-internal-1', 'pending')`;
    await db.sql`
      INSERT INTO pay.custody_deposit_address_freezes (user_id, network_id, address, reason, frozen_by)
      VALUES (${FRIEND}, 'ethereum', ${FRIEND_ADDRESS}, 'TEST freeze', 'founder-a')`;
    await expect(send()).rejects.toMatchObject({ code: 'pay.internal_destination_unavailable' });
    expect(bank.calls).toEqual([]);
  });

  it('names an asset svc-bank would never take, before anything is claimed', async () => {
    await expect(
      money.withdrawInternal({ userId: USER, assetId: 'USD-T', amount: amt('25'), destination: to(FRIEND_ADDRESS), clientRef: 'w-asset' }),
    ).rejects.toMatchObject({ code: 'pay.internal_asset_unsupported' });
    expect(await rows()).toEqual([]);
  });

  it('the chain door refuses an address on the platform, so an approval request never sends it out to come back', async () => {
    const ask = (ref: string) =>
      money.preflightWithdrawal({
        userId: USER,
        assetId: 'USDT',
        amount: amt('25'),
        rail: 'card-sandbox',
        destination: to(ref),
        clientRef: 'w-chain',
      });
    for (const ref of [FRIEND_ADDRESS, OWN_ADDRESS]) {
      await expect(ask(ref)).rejects.toMatchObject({ code: 'pay.withdrawal_platform_address' });
    }
    await expect(ask(OUTSIDE_ADDRESS)).rejects.not.toMatchObject({ code: 'pay.withdrawal_platform_address' });
  });

  it('refuses before a claim when svc-bank is not connected, and when a guard refuses', async () => {
    await expect(send({ svc: service({ port: null }) })).rejects.toMatchObject({ code: 'pay.internal_settlement_unwired' });
    const refusing: PartialPayGuards = {
      beforeUserMoneyWithdrawal: async () => {
        throw new PayGuardRefusal('pay.guard_withdrawal_limit_exceeded', 'refused');
      },
    };
    await expect(send({ svc: service({ guards: refusing }) })).rejects.toMatchObject({ code: 'pay.guard_withdrawal_limit_exceeded' });
    expect(await rows()).toEqual([]);
    expect(bank.calls).toEqual([]);
  });

  it('a refusal from svc-bank fails the withdrawal with its code, puts nothing back, and the same reference may ask again', async () => {
    bank.next('refuse');
    await expect(send()).rejects.toMatchObject({
      code: 'pay.internal_settlement_refused',
      detail: { failureCode: 'ledger.insufficient_funds' },
    });
    const [failed] = await rows();
    expect(failed).toMatchObject({ status: 'failed', failure_code: 'ledger.insufficient_funds', attempts: 1, rail_ref: null });
    expect(await journal(failed!.id)).toEqual([{ attempt: 0, outcome: 'refused', rail_ref: null }]);
    expect(bank.posted.size).toBe(0);

    // The same reference reopens the same withdrawal and asks under the same key.
    const out = await send();
    expect(out).toMatchObject({ id: failed!.id, status: 'sent', railRef: 'bank-tx-1' });
    expect(bank.calls.map((c) => c.transferId)).toEqual([`withdraw:${failed!.id}`, `withdraw:${failed!.id}`]);
    expect(await journal(failed!.id)).toEqual([
      { attempt: 0, outcome: 'refused', rail_ref: null },
      { attempt: 1, outcome: 'accepted', rail_ref: 'bank-tx-1' },
    ]);
  });

  it('a lost answer keeps the withdrawal open and not cancellable, and the retry finishes it under the same key with one send', async () => {
    bank.next('post-then-lose');
    await expect(send()).rejects.toMatchObject({ code: 'pay.rail_outcome_unknown', detail: { state: 'requested' } });
    const [open] = await rows();
    expect(open).toMatchObject({ status: 'pending', rail_ref: null, attempts: 0 });
    expect(await journal(open!.id)).toEqual([{ attempt: 0, outcome: 'requested', rail_ref: null }]);
    // The send may have posted (here it did), so the customer cannot cancel it.
    await expect(money.cancelWithdrawal({ userId: USER, withdrawalId: open!.id })).rejects.toMatchObject({
      code: 'pay.withdrawal_not_cancellable',
    });

    const out = await send();
    expect(out).toMatchObject({ id: open!.id, status: 'sent', railRef: 'bank-tx-1' });
    expect(bank.calls.map((c) => c.transferId)).toEqual([`withdraw:${open!.id}`, `withdraw:${open!.id}`]);
    expect(bank.posted.size).toBe(1);
    // The retry finishes work already asked for: the guards see a recovery, not a new withdrawal.
    expect(seen.map((s) => s.replay)).toEqual(['fresh', 'recovery']);
  });

  it('a send asked before the address was frozen still finishes on retry; a new one there is refused', async () => {
    bank.next('lose');
    await expect(send()).rejects.toMatchObject({ code: 'pay.rail_outcome_unknown' });
    await db.sql`
      INSERT INTO pay.custody_deposit_address_freezes (user_id, network_id, address, reason, frozen_by)
      VALUES (${FRIEND}, 'ethereum', ${FRIEND_ADDRESS}, 'TEST freeze', 'founder-a')`;
    await expect(send()).resolves.toMatchObject({ status: 'sent' });
    await expect(send({ clientRef: 'w-internal-2' })).rejects.toMatchObject({ code: 'pay.internal_destination_unavailable' });
    expect(bank.posted.size).toBe(1);
  });

  it('a claim that crashed before its send was journalled asked nothing: it can be cancelled and posts nothing', async () => {
    const [row] = await db.sql<Array<{ id: string }>>`
      INSERT INTO pay.withdrawals (user_id, asset_id, amount, rail, destination, client_ref, status)
      VALUES (${USER}, 'USDT', 25, ${INTERNAL_RAIL}, ${db.sql.json(to(FRIEND_ADDRESS))}, 'w-crashed', 'pending')
      RETURNING id`;
    await expect(money.cancelWithdrawal({ userId: USER, withdrawalId: row!.id })).resolves.toMatchObject({ status: 'failed' });
    await expect(send({ clientRef: 'w-crashed' })).rejects.toMatchObject({ code: 'pay.withdrawal_canceled' });
    expect(bank.calls).toEqual([]);
  });

  it('the custody policy and the treasury limit, which govern value leaving custody, let an internal send through and do not count it', async () => {
    const guards = composeGuards(
      createCustodyPolicyGuards({ sql: db.sql, mode: 'required' }),
      createTreasuryGuards({ mode: 'required', limits: { byAsset: new Map(), invalid: [] }, inventory: UNWIRED_CONVERSION_INVENTORY }),
    );
    // Nothing is published and no limit is set, so both would refuse a chain withdrawal (fail closed); the internal send
    // is still asked of svc-bank...
    bank.next('lose');
    await expect(send({ svc: service({ guards }) })).rejects.toMatchObject({ code: 'pay.rail_outcome_unknown' });
    // ...and an open internal withdrawal is not exposure: it never leaves custody.
    const exposure = await assetExposure(db.sql, 'USDT', { byAsset: new Map(), invalid: [] }, UNWIRED_CONVERSION_INVENTORY);
    expect(exposure.pendingPayouts).toBe(0n);
  });

  it('invariant: one send per withdrawal, never two, across refusals, lost answers and retries', async () => {
    bank.next('refuse', 'lose', 'post-then-lose');
    for (let i = 0; i < 4; i += 1) await send().catch(() => undefined);
    await send({ clientRef: 'w-internal-2', amount: '5' });
    const all = await rows();
    expect(all.map((r) => r.status)).toEqual(['sent', 'sent']);
    expect(bank.posted.size).toBe(2);
    expect([...bank.posted.keys()].sort()).toEqual(all.map((r) => `withdraw:${r.id}`).sort());
  });
});
