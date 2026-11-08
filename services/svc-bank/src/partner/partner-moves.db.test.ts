/**
 * Partner-held bank money through the real router (OWNER 226; J-bank-01 #5, J-bank-07 #3): with the person's TEST
 * switch `custody: 'off'`, `transfers.create` is one move at the TEST partner bank under the transfer's business key,
 * both balances change by exactly the amount as the partner reports them, the move is in History, and the ledger posts
 * nothing. A locked source refuses before any partner request. Without the switch, the custodial layer posts as before.
 * Uses TEST_DATABASE_URL. Does not start Docker.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, bankTransferKey, parseAmount, recipes } from '@intafaced/ledger-client';
import { createBankServices, memoryRecipientState, type BankServiceOptions } from '../bank-service.js';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankRouter } from '../router.js';
import { TEST_PARTNER_LABEL, testPartner, type TestPartner } from './test-partner.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 'c'.repeat(32);
const ADA = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const SID = '99999999-9999-4999-8999-999999999999';
const DAY = 24 * 3600 * 1000;

function principal(userId: string): Principal {
  return {
    sub: userId,
    userId,
    sid: SID,
    scopes: ['bank:read', 'bank:write'],
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}

const codeOf = (err: unknown) => (err as { cause?: { code?: string } }).cause?.code;

describe('partner-held bank moves (OWNER 226)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let partner: TestPartner;

  beforeAll(async () => {
    const raw = process.env.TEST_DATABASE_URL?.trim();
    if (!raw) throw new Error('TEST_DATABASE_URL is unset. This suite does not start Docker.');
    const url = new URL(raw);
    if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
    db = await createTestDatabase({ service: 'bank', url: url.toString(), migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    await sql`TRUNCATE bank.spaces RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
    partner = testPartner();
  });

  function as(userId: string, options: BankServiceOptions = {}) {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      nativeAssetId: 'IFC',
      recipients: memoryRecipientState(),
      spaceLimit: '5',
      scheduleEditCutoffMinutes: '60',
      spaceUnlockWaitHours: '24',
      testPartner: partner,
      ...options,
    });
    const raw = encodePrincipal(principal(userId));
    const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });
    const api = createBankRouter(bank).createCaller(
      edge({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: `req-${randomUUID()}`,
      }),
    );
    return { bank, api };
  }

  /** A person held at the TEST partner with TEST 100 in their main balance and a named space "Trip TEST". */
  async function partnerHeld(userId: string) {
    const { bank, api } = as(userId);
    await api.testPartner.set({ custody: 'off' });
    await api.testPartner.fund({ fundId: `fund-${userId}`, assetId: 'USDT', amount: '100' });
    const trip = await api.spaces.create({ assetId: 'USDT', name: 'Trip TEST' });
    const spaces = await api.spaces.list({ limit: 50 });
    const mainSpace = spaces.find((s) => s.kind === 'primary')!;
    return { bank, api, trip, mainSpace };
  }

  const byName = async (api: ReturnType<typeof as>['api'], name: string) =>
    (await api.spaces.list({ limit: 50 })).find((s) => s.name === name)!;
  const mainOf = async (api: ReturnType<typeof as>['api']) => (await api.spaces.list({ limit: 50 })).find((s) => s.kind === 'primary')!;

  it('J-bank-01 #5 (planted): moves TEST 20 at the partner once; both balances change by exactly 20 as it reports them; the ledger posts nothing', async () => {
    const { api, trip, mainSpace } = await partnerHeld(ADA);
    // The ledger also holds money for this person, so a ledger post planted back on this path would succeed and be seen.
    await ledger.post(recipes.deposit({ userId: ADA, assetId: 'USDT', amount: parseAmount('100'), rail: 'test', railRef: 'r-ada' }));
    const journal = ledger.journal().length;
    const post = vi.spyOn(ledger, 'post');

    const moved = await api.transfers.create({ transferId: 'move-ada-0001', fromSpaceId: mainSpace.id, toSpaceId: trip.id, amount: '20' });

    expect(moved).toMatchObject({ ledgerTxId: null, amount: '20', partnerMove: { label: TEST_PARTNER_LABEL } });
    // The ledger posts nothing: no post at all, and nothing under the business key.
    expect(post).not.toHaveBeenCalled();
    expect(ledger.journal()).toHaveLength(journal);
    expect(await ledger.getTxByKey(bankTransferKey('own', 'move-ada-0001', 0))).toBeNull();
    // One partner move under the key.
    const made = await partner.bank.moveByKey(bankTransferKey('own', 'move-ada-0001', 0));
    expect(made).toMatchObject({ id: moved.partnerMove!.id, amount: parseAmount('20') });
    expect(await partner.bank.moves(ADA, { limit: 10 })).toHaveLength(1);
    // Both balances as the partner reports them, labelled TEST with a report time, and no ledger account named.
    const main = await mainOf(api);
    const space = await byName(api, 'Trip TEST');
    expect(main).toMatchObject({ balance: '80', ledgerAccount: null, heldAt: { label: TEST_PARTNER_LABEL } });
    expect(space).toMatchObject({ balance: '20', ledgerAccount: null, heldAt: { label: TEST_PARTNER_LABEL } });
    expect(Number.isNaN(Date.parse(space.heldAt!.asOf))).toBe(false);
    // The spaces plus the main balance shown are the partner's total.
    expect(parseAmount(main.balance) + parseAmount(space.balance)).toBe(parseAmount('100'));
  });

  it('the move is in History, labelled as the partner record, on the space it went to and the balance it left', async () => {
    const { api, trip, mainSpace } = await partnerHeld(ADA);
    const moved = await api.transfers.create({ transferId: 'move-ada-0002', fromSpaceId: mainSpace.id, toSpaceId: trip.id, amount: '20' });
    const feed = await api.activity.list({ limit: 50 });
    expect(feed.items).toEqual([
      expect.objectContaining({
        kind: 'space_move',
        direction: 'out',
        amount: '20',
        asset: 'USDT',
        spaceName: null,
        txId: moved.partnerMove!.id,
        heldAt: { label: TEST_PARTNER_LABEL },
      }),
      expect.objectContaining({
        kind: 'space_move',
        direction: 'in',
        amount: '20',
        spaceName: 'Trip TEST',
        heldAt: { label: TEST_PARTNER_LABEL },
      }),
    ]);
    expect(feed.nextCursor).toBeNull();
    const history = await api.transfers.list({ limit: 50 });
    expect(history.items.map((i) => [i.kind, i.direction, i.spaceName, i.status])).toEqual([
      ['space_move', 'out', null, 'completed'],
      ['space_move', 'in', 'Trip TEST', 'completed'],
    ]);
    const one = await api.activity.get({ id: feed.items[1]!.id });
    expect(one.item).toMatchObject({ spaceName: 'Trip TEST', direction: 'in' });
    expect(one.lines).toHaveLength(2);
    // A filter the partner record cannot answer is refused, never silently ignored.
    await expect(api.activity.list({ limit: 50, q: 'trip' })).rejects.toSatisfy(
      (err) => codeOf(err) === 'bank.partner_history_filter_unsupported',
    );
  });

  it('a retry after a lost partner reply makes one move, never two', async () => {
    const { api, trip, mainSpace } = await partnerHeld(ADA);
    await api.testPartner.set({ nextReply: 'lost' });
    const ask = { transferId: 'move-ada-lost', fromSpaceId: mainSpace.id, toSpaceId: trip.id, amount: '20' };
    const lost = await api.transfers.create(ask).catch((e: unknown) => e);
    expect(codeOf(lost)).toBe('bank.partner_reply_lost');
    const retried = await api.transfers.create(ask);
    expect(retried.partnerMove).not.toBeNull();
    expect(await partner.bank.moves(ADA, { limit: 10 })).toHaveLength(1);
    expect((await mainOf(api)).balance).toBe('80');
    expect((await byName(api, 'Trip TEST')).balance).toBe('20');
    expect(ledger.journal()).toEqual([]);
  });

  it('a locked source refuses bank.space_locked before any partner request', async () => {
    const { api, trip } = await partnerHeld(ADA);
    const locked = await api.spaces.create({
      assetId: 'USDT',
      name: 'Locked TEST',
      lockedUntil: new Date(Date.now() + 365 * DAY).toISOString(),
    });
    const move = vi.spyOn(partner.bank, 'move');
    const err = await api.transfers
      .create({ transferId: 'move-ada-lock', fromSpaceId: locked.id, toSpaceId: trip.id, amount: '1' })
      .catch((e: unknown) => e);
    expect(codeOf(err)).toBe('bank.space_locked');
    expect(move).not.toHaveBeenCalled();
    expect(ledger.journal()).toEqual([]);
  });

  it('the partner with no spaces refuses "not offered by the partner" and moves nothing', async () => {
    const { api, trip, mainSpace } = await partnerHeld(ADA);
    await api.testPartner.set({ notOffered: ['spaces'] });
    const err = await api.transfers
      .create({ transferId: 'move-ada-none', fromSpaceId: mainSpace.id, toSpaceId: trip.id, amount: '20' })
      .catch((e: unknown) => e);
    expect(codeOf(err)).toBe('bank.not_offered_by_partner');
    expect(await partner.bank.moves(ADA, { limit: 10 })).toEqual([]);
  });

  it('more than the partner reports in the source refuses bank.partner_insufficient_funds and moves nothing', async () => {
    const { api, trip, mainSpace } = await partnerHeld(ADA);
    const err = await api.transfers
      .create({ transferId: 'move-ada-over', fromSpaceId: mainSpace.id, toSpaceId: trip.id, amount: '100.01' })
      .catch((e: unknown) => e);
    expect(codeOf(err)).toBe('bank.partner_insufficient_funds');
    expect((await mainOf(api)).balance).toBe('100');
  });

  it('a move between a partner-held person and one on the custodial layer is refused, nothing moved anywhere', async () => {
    const { api, mainSpace } = await partnerHeld(ADA);
    const bob = as(BOB);
    const bobMain = await bob.bank.spaces.ensurePrimary(BOB, 'USDT');
    const err = await api.transfers
      .create({ transferId: 'move-ada-bob', fromSpaceId: mainSpace.id, toSpaceId: bobMain.id, amount: '1' })
      .catch((e: unknown) => e);
    expect(codeOf(err)).toBe('bank.partner_custody_mismatch');
    expect(await partner.bank.moves(ADA, { limit: 10 })).toEqual([]);
    expect(ledger.journal()).toEqual([]);
  });

  it('the currencies list reads the main balance as the partner reports it, and a currency it reports money in cannot be removed', async () => {
    const { api } = await partnerHeld(ADA);
    const set = await api.currencies.list();
    expect(set.currencies).toEqual([expect.objectContaining({ assetId: 'USDT', balance: '100' })]);
    await expect(api.currencies.remove({ assetId: 'USDT' })).rejects.toSatisfy((err) => codeOf(err) === 'bank.currency_in_use');
  });

  it('a partner-held person who still has money on the ledger in a currency cannot remove it', async () => {
    const { api } = await partnerHeld(ADA);
    await api.transfers.create({
      transferId: 'empty-main-01',
      fromSpaceId: (await mainOf(api)).id,
      toSpaceId: (await byName(api, 'Trip TEST')).id,
      amount: '100',
    });
    await api.spaces.archive({ spaceId: (await byName(api, 'Trip TEST')).id });
    await ledger.post(recipes.deposit({ userId: ADA, assetId: 'USDT', amount: parseAmount('1'), rail: 'test', railRef: 'r-left' }));
    await expect(api.currencies.remove({ assetId: 'USDT' })).rejects.toSatisfy((err) => codeOf(err) === 'bank.currency_in_use');
  });

  it('J-bank-07 #3: a standing order between own spaces is one partner move per occurrence, recorded with its reference, nothing on the ledger', async () => {
    const { bank, trip, mainSpace } = await partnerHeld(ADA);
    const startsAt = new Date(Date.now() + DAY);
    const order = await bank.transfers.schedule({
      userId: ADA,
      fromSpaceId: mainSpace.id,
      toSpaceId: trip.id,
      amount: parseAmount('15'),
      cadence: 'once',
      startsAt,
      scheduleId: randomUUID(),
    });
    const due = new Date(startsAt.getTime() + 60_000);
    const run = await bank.transfers.runDueTransfers({ now: due, limit: 10 });
    expect(run, JSON.stringify(run)).toMatchObject({ settled: 1, rejected: 0 });
    // Run again: the occurrence is claimed; nothing more moves.
    await bank.transfers.runDueTransfers({ now: new Date(due.getTime() + DAY), limit: 10 });
    const moves = await partner.bank.moves(ADA, { limit: 10 });
    expect(moves).toHaveLength(1);
    expect(moves[0]!.key).toBe(bankTransferKey('sched', order.id, 0));
    expect(await bank.transfers.executions(order.id, 10)).toEqual([
      { occurrence: 0, amount: '15', status: 'settled', ledgerTxId: null, partnerMoveId: moves[0]!.id, rejectionCode: null },
    ]);
    expect(ledger.journal()).toEqual([]);
  });

  it('a standing order the partner cannot cover is recorded as refused with the partner reason, nothing moved', async () => {
    const { bank, trip, mainSpace } = await partnerHeld(ADA);
    const startsAt = new Date(Date.now() + DAY);
    const order = await bank.transfers.schedule({
      userId: ADA,
      fromSpaceId: mainSpace.id,
      toSpaceId: trip.id,
      amount: parseAmount('150'),
      cadence: 'once',
      startsAt,
      scheduleId: randomUUID(),
    });
    expect(await bank.transfers.runDueTransfers({ now: new Date(startsAt.getTime() + 60_000), limit: 10 })).toMatchObject({
      settled: 0,
      rejected: 1,
    });
    expect(await bank.transfers.executions(order.id, 10)).toEqual([
      expect.objectContaining({ status: 'rejected', partnerMoveId: null, rejectionCode: 'bank.partner_insufficient_funds' }),
    ]);
    expect(await partner.bank.moves(ADA, { limit: 10 })).toEqual([]);
  });

  it('a bills pot with the fallback on is topped up from the main balance at the partner, once, then the bill is paid', async () => {
    const { bank, api, mainSpace } = await partnerHeld(ADA);
    const bob = as(BOB);
    await bob.api.testPartner.set({ custody: 'off' });
    const payee = await bob.bank.spaces.ensurePrimary(BOB, 'USDT');
    const pot = await api.spaces.create({ assetId: 'USDT', name: 'Bills TEST' });
    await api.transfers.create({ transferId: 'fill-bills-01', fromSpaceId: mainSpace.id, toSpaceId: pot.id, amount: '5' });
    await bank.billsPots.set(ADA, pot.id, true);
    const startsAt = new Date(Date.now() + DAY);
    const order = await bank.transfers.schedule({
      userId: ADA,
      fromSpaceId: pot.id,
      toSpaceId: payee.id,
      amount: parseAmount('8'),
      cadence: 'once',
      startsAt,
      scheduleId: randomUUID(),
    });
    const due = new Date(startsAt.getTime() + 60_000);
    expect(await bank.transfers.runDueTransfers({ now: due, limit: 10 })).toMatchObject({ settled: 1, rejected: 0 });
    await bank.transfers.runDueTransfers({ now: new Date(due.getTime() + DAY), limit: 10 });
    expect((await partner.bank.balance({ userId: BOB, assetId: 'USDT', spaceId: null })).amount).toBe(parseAmount('8'));
    expect((await byName(api, 'Bills TEST')).balance).toBe('0');
    // TEST 100 less the 5 filled and the shortfall of 3, moved once.
    expect((await mainOf(api)).balance).toBe('92');
    expect((await partner.bank.moves(ADA, { limit: 10 })).filter((m) => m.key.includes(':bills-fallback:'))).toHaveLength(1);
    expect(await bank.transfers.executions(order.id, 10)).toEqual([expect.objectContaining({ status: 'settled', ledgerTxId: null })]);
    expect(ledger.journal()).toEqual([]);
  });

  it('a settled run must name exactly one movement: neither, or both a ledger transaction and a partner move, is refused', async () => {
    const { bank, trip, mainSpace } = await partnerHeld(ADA);
    const order = await bank.transfers.schedule({
      userId: ADA,
      fromSpaceId: mainSpace.id,
      toSpaceId: trip.id,
      amount: parseAmount('1'),
      cadence: 'once',
      startsAt: new Date(Date.now() + DAY),
      scheduleId: randomUUID(),
    });
    const insert = (ledgerTx: string | null, partnerMove: string | null) =>
      sql`
        INSERT INTO bank.transfer_executions (schedule_id, occurrence, amount, status, ledger_tx_id, partner_move_id, settled_at)
        VALUES (${order.id}, 0, 1, 'settled', ${ledgerTx}, ${partnerMove}, now())
      `.catch((e: unknown) => (e as { constraint_name?: string }).constraint_name);
    expect(await insert(null, null)).toBe('transfer_executions_settled_has_tx_ck');
    expect(await insert('ledger-tx-1', 'partner-move-1')).toBe('transfer_executions_one_movement_ck');
  });

  it('without the switch (the default), transfers.create posts to the ledger exactly as before, and the partner moves nothing', async () => {
    const { bank, api } = as(ADA);
    await ledger.post(recipes.deposit({ userId: ADA, assetId: 'USDT', amount: parseAmount('100'), rail: 'test', railRef: 'r-ada' }));
    const mainSpace = await bank.spaces.ensurePrimary(ADA, 'USDT');
    const trip = await api.spaces.create({ assetId: 'USDT', name: 'Trip TEST' });
    const moved = await api.transfers.create({
      transferId: 'move-ada-ledger',
      fromSpaceId: mainSpace.id,
      toSpaceId: trip.id,
      amount: '20',
    });
    expect(moved.partnerMove).toBeNull();
    expect(moved.ledgerTxId).toBe((await ledger.getTxByKey(bankTransferKey('own', 'move-ada-ledger', 0)))!.id);
    const space = await byName(api, 'Trip TEST');
    expect(space).toMatchObject({ balance: '20', heldAt: null, ledgerAccount: expect.objectContaining({ ownerId: trip.id }) });
    expect(await partner.bank.moves(ADA, { limit: 10 })).toEqual([]);
  });

  it('with the custodial layer off and no partner holding the money, a move refuses bank.no_partner_bank before the ledger is asked', async () => {
    const { bank, api } = as(ADA, { custodyLayer: 'off', testPartner: null });
    const mainSpace = await bank.spaces.ensurePrimary(ADA, 'USDT');
    const trip = await api.spaces.create({ assetId: 'USDT', name: 'Trip TEST' });
    const post = vi.spyOn(ledger, 'post');
    const err = await api.transfers
      .create({ transferId: 'move-ada-nopartner', fromSpaceId: mainSpace.id, toSpaceId: trip.id, amount: '1' })
      .catch((e: unknown) => e);
    expect(codeOf(err)).toBe('bank.no_partner_bank');
    expect(post).not.toHaveBeenCalled();
  });
});
