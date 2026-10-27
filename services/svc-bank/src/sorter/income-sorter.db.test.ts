/**
 * BK-pots-03 (J-bank-07 #4): the income sorter over Postgres and a MemoryLedger. A payment from another person is split
 * across the person's own named spaces by percentage, once: a retried send, a second sweep and a re-drive move nothing
 * again. A sorter over 100% is refused by name, as is every target that is not the person's own live named space. A
 * refused split moves nothing and its share stays in the account; a split whose outcome is unknown stays pending and the
 * sweep settles it under the same key. Blank owner terms refuse a sorter and sort nothing. Enters through the router
 * where a customer would. Uses TEST_DATABASE_URL.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import {
  LedgerError,
  MemoryLedger,
  stampPostAttempts,
  formatAmount,
  parseAmount,
  recipes,
  subAccountAvailable,
  userAvailable,
  type LedgerClient,
} from '@intafaced/ledger-client';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankServices, memoryRecipientState, type BankServiceOptions, type BankServices } from '../bank-service.js';
import { createBankRouter } from '../router.js';
import { memoryPartyHandles } from '../transfers/party-handles.js';
import { accountForSpace } from '../spaces/space-service.js';
import { legShare, sorterTransferId } from './income-sorter.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 's'.repeat(32);
const ADA = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const SID = '99999999-9999-4999-8999-999999999999';

describe('income sorter (BK-pots-03)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let bank: BankServices;
  let options: BankServiceOptions;
  /** When set, a sorter split's post fails with no typed code: the reply was lost. */
  let loseSorterReplies = false;
  /** When set, a sorter split's post never answers: the ledger hangs. */
  let hangSorterPosts = false;
  /** When set, a sorter split's post fails with no typed code before it reaches the book: it may still land later. */
  let dropSorterPosts = false;
  /** When set, a sorter split's post fails with this error on its one attempt, and nothing reaches the book. */
  let failSorterPosts: (() => Error) | null = null;

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL?.trim();
    if (!url) throw new Error('TEST_DATABASE_URL is unset');
    db = await createTestDatabase({ service: 'bank', url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await sql`
      TRUNCATE bank.income_sorter_run_legs, bank.income_sorter_runs, bank.income_sorter_legs, bank.income_sorters,
               bank.personal_transfers, bank.personal_transfer_terms, bank.spaces
      RESTART IDENTITY CASCADE
    `;
    await sql`
      INSERT INTO bank.personal_transfer_terms (asset_id, per_transfer_limit, daily_limit, fee) VALUES ('USDT', 1000, 10000, 0)
    `;
    ledger = new MemoryLedger();
    loseSorterReplies = false;
    hangSorterPosts = false;
    dropSorterPosts = false;
    failSorterPosts = null;
    const flaky = new Proxy(ledger, {
      get(target, prop, receiver) {
        if (prop === 'post') {
          return async (req: Parameters<LedgerClient['post']>[0]) => {
            if (hangSorterPosts && req.idempotencyKey.includes(':sorter:')) return new Promise<never>(() => {});
            if (dropSorterPosts && req.idempotencyKey.includes(':sorter:')) throw new Error('socket hang up');
            if (failSorterPosts && req.idempotencyKey.includes(':sorter:')) {
              const err = failSorterPosts();
              stampPostAttempts(err, 1);
              throw err;
            }
            if (loseSorterReplies && req.idempotencyKey.includes(':sorter:')) {
              await target.post(req);
              throw new Error('socket hang up');
            }
            try {
              return await target.post(req);
            } catch (err) {
              // As the shared HTTP client does: one attempt, its count stamped on the error it gives up with.
              stampPostAttempts(err, 1);
              throw err;
            }
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as MemoryLedger;
    options = {
      nativeAssetId: 'IFC',
      recipients: memoryRecipientState(),
      spaceLimit: '5',
      handles: memoryPartyHandles({ [ADA]: 'ada', [BOB]: 'bob' }),
      incomeSorterMinCredit: '1',
    };
    bank = createBankServices(sql, flaky, memoryLedgerHistory(ledger), options);
  });

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  function caller(userId: string) {
    const principal = {
      sub: userId,
      userId,
      sid: SID,
      scopes: ['bank:read', 'bank:write'],
      tier: 'full',
      mfa: true,
    } as unknown as Principal;
    const raw = encodePrincipal({ ...principal, expiresAt: new Date(Date.now() + 60_000) } as Principal);
    const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });
    return createBankRouter(bank).createCaller(
      edge({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: `req-${randomUUID()}`,
      }),
    );
  }

  const pot = (name: string, userId = ADA, assetId = 'USDT') => bank.spaces.create({ userId, assetId, name, lockedUntil: null });
  const balanceOf = async (spaceId: string) => formatAmount((await ledger.balance(subAccountAvailable(spaceId, 'USDT'))).amount);
  const mainOf = async (userId = ADA) => formatAmount((await ledger.balance(userAvailable(userId, 'USDT'))).amount);
  /** A moment past the sweep's one-minute hands-off window. */
  const later = () => new Date(Date.now() + 120_000);
  /** The sorter as if made before every payment so far: those payments reached it, and no send sorted them (a crash). */
  const backdate = (sorterId: string) =>
    sql`UPDATE bank.income_sorters SET created_at = created_at - interval '1 hour' WHERE id = ${sorterId}::uuid`;
  const sorterMoves = () => ledger.journal().filter((tx) => tx.idempotencyKey.includes(':sorter:'));

  /** Bob pays Ada from his account, as the customer door does. */
  async function bobPays(amount: string, transferId = `pay-${randomUUID()}`) {
    const from = await bank.spaces.ensurePrimary(BOB, 'USDT');
    await ledger.post(recipes.deposit({ userId: BOB, assetId: 'USDT', amount: parseAmount(amount), rail: 'test', railRef: randomUUID() }));
    await bank.spaces.ensurePrimary(ADA, 'USDT');
    return caller(BOB).transfers.toUser({ transferId, fromSpaceId: from.id, toUserId: ADA, amount });
  }

  async function sixtyForty() {
    const bills = await pot('TEST bills');
    const savings = await pot('TEST savings');
    const sorter = await caller(ADA).sorter.create({
      sorterId: randomUUID(),
      assetId: 'USDT',
      legs: [
        { spaceId: bills.id, shareBp: 6000 },
        { spaceId: savings.id, shareBp: 4000 },
      ],
    });
    return { bills, savings, sorter };
  }

  it('says when the owner has published no terms, and then makes no sorter and sorts nothing', async () => {
    options.incomeSorterMinCredit = undefined;
    const bills = await pot('TEST bills');
    expect(await caller(ADA).sorter.list()).toEqual({ terms: { state: 'not_set', code: 'bank.sorter_terms_unset' }, sorters: [] });
    await expect(
      caller(ADA).sorter.create({ sorterId: randomUUID(), assetId: 'USDT', legs: [{ spaceId: bills.id, shareBp: 5000 }] }),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: 'bank.sorter_terms_unset' }) });
    await bobPays('100');
    expect(sorterMoves()).toHaveLength(0);
    expect(await mainOf()).toBe('100');
  });

  it('refuses a sorter over 100% and every target that is not the person’s own live named space', async () => {
    const bills = await pot('TEST bills');
    const savings = await pot('TEST savings');
    const main = await bank.spaces.ensurePrimary(ADA, 'USDT');
    const bobs = await pot('TEST bob', BOB);
    const old = await pot('TEST old');
    await bank.spaces.archive(old.id);
    const eurc = await pot('TEST eurc', ADA, 'EURC');
    const make = (legs: Array<{ spaceId: string; shareBp: number }>, sorterId = randomUUID()) =>
      caller(ADA).sorter.create({ sorterId, assetId: 'USDT', legs });
    const refused = (code: string) => ({ cause: expect.objectContaining({ code }) });

    await expect(
      make([
        { spaceId: bills.id, shareBp: 6000 },
        { spaceId: savings.id, shareBp: 4001 },
      ]),
    ).rejects.toMatchObject(refused('bank.sorter_invalid'));
    await expect(make([{ spaceId: bills.id, shareBp: 0 }])).rejects.toMatchObject(refused('bank.sorter_invalid'));
    await expect(make([{ spaceId: bills.id, shareBp: 10001 }])).rejects.toMatchObject(refused('bank.sorter_invalid'));
    await expect(
      make([
        { spaceId: bills.id, shareBp: 10 },
        { spaceId: bills.id, shareBp: 10 },
      ]),
    ).rejects.toMatchObject(refused('bank.sorter_invalid'));
    await expect(make([{ spaceId: main.id, shareBp: 5000 }])).rejects.toMatchObject(refused('bank.sorter_invalid'));
    await expect(make([{ spaceId: bobs.id, shareBp: 5000 }])).rejects.toMatchObject(refused('bank.space_not_found'));
    await expect(make([{ spaceId: old.id, shareBp: 5000 }])).rejects.toMatchObject(refused('bank.space_archived'));
    await expect(make([{ spaceId: eurc.id, shareBp: 5000 }])).rejects.toMatchObject(refused('bank.asset_mismatch'));
    expect((await caller(ADA).sorter.list()).sorters).toEqual([]);

    // Exactly 100% is a sorter; the same id sent again is the same sorter; a second live one for the asset is refused.
    const id = randomUUID();
    const legs = [
      { spaceId: bills.id, shareBp: 6000 },
      { spaceId: savings.id, shareBp: 4000 },
    ];
    const made = await make(legs, id);
    expect(made).toMatchObject({ id, assetId: 'USDT', status: 'active', legs });
    expect(await make(legs, id)).toEqual(made);
    await expect(make([{ spaceId: bills.id, shareBp: 5000 }], id)).rejects.toMatchObject(refused('bank.sorter_conflict'));
    await expect(make([{ spaceId: bills.id, shareBp: 5000 }])).rejects.toMatchObject(refused('bank.sorter_exists'));
    expect((await caller(ADA).sorter.list()).sorters).toEqual([
      {
        ...made,
        legs: [
          { spaceId: bills.id, shareBp: 6000, spaceName: bills.name, archived: false },
          { spaceId: savings.id, shareBp: 4000, spaceName: savings.name, archived: false },
        ],
      },
    ]);
    expect((await caller(BOB).sorter.list()).sorters).toEqual([]);
    await expect(caller(BOB).sorter.cancel({ sorterId: id })).rejects.toMatchObject(refused('bank.sorter_not_found'));
    await expect(caller(BOB).sorter.runs({ sorterId: id, limit: 10 })).rejects.toMatchObject(refused('bank.sorter_not_found'));
  });

  it('splits a TEST 100 payment 60 and 40, once, however often the send or the sweep runs', async () => {
    const { bills, savings, sorter } = await sixtyForty();
    const transferId = `pay-${randomUUID()}`;
    const paid = await bobPays('100', transferId);
    expect(await balanceOf(bills.id)).toBe('60');
    expect(await balanceOf(savings.id)).toBe('40');
    expect(await mainOf()).toBe('0');

    // Bob's retry of the same send, and two sweeps, move nothing more.
    const from = await bank.spaces.ensurePrimary(BOB, 'USDT');
    await ledger.post(recipes.deposit({ userId: BOB, assetId: 'USDT', amount: parseAmount('100'), rail: 'test', railRef: randomUUID() }));
    const again = await caller(BOB).transfers.toUser({ transferId, fromSpaceId: from.id, toUserId: ADA, amount: '100' });
    expect(again.ledgerTxId).toBe(paid.ledgerTxId);
    expect(await bank.sorter.sweep(10, later())).toEqual({ creditsRecorded: 0, runsDriven: 0, legsStillPending: 0 });
    expect(await bank.sorter.sweep(10, later())).toEqual({ creditsRecorded: 0, runsDriven: 0, legsStillPending: 0 });
    expect(sorterMoves()).toHaveLength(2);
    expect(await balanceOf(bills.id)).toBe('60');
    expect(await balanceOf(savings.id)).toBe('40');

    const runs = await caller(ADA).sorter.runs({ sorterId: sorter.id, limit: 10 });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ creditTransferId: transferId, creditTxId: paid.ledgerTxId, creditAmount: '100' });
    expect(runs[0]!.legs.map(({ spaceId, amount, status }) => ({ spaceId, amount, status }))).toEqual([
      { spaceId: bills.id, amount: '60', status: 'settled' },
      { spaceId: savings.id, amount: '40', status: 'settled' },
    ]);
    // Bob sees nothing of how Ada sorts.
    await expect(caller(BOB).sorter.runs({ sorterId: sorter.id, limit: 10 })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'bank.sorter_not_found' }),
    });
  });

  it('rounds each share down and leaves the rest in the account; a payment under the minimum is recorded and not split', async () => {
    const bills = await pot('TEST bills');
    await bobPays('50');
    const { id } = await caller(ADA).sorter.create({
      sorterId: randomUUID(),
      assetId: 'USDT',
      legs: [{ spaceId: bills.id, shareBp: 3333 }],
    });
    // A payment from before the sorter is never sorted, by the send or the sweep.
    expect(await bank.sorter.sweep(10, later())).toEqual({ creditsRecorded: 0, runsDriven: 0, legsStillPending: 0 });
    await bobPays('0.5');
    expect(await balanceOf(bills.id)).toBe('0');
    await bobPays('10.01');
    const share = legShare(parseAmount('10.01'), 3333);
    expect(formatAmount(share)).toBe('3.336333');
    expect(await balanceOf(bills.id)).toBe('3.336333');
    expect(await mainOf()).toBe(formatAmount(parseAmount('60.51') - share));
    const runs = await caller(ADA).sorter.runs({ sorterId: id, limit: 10 });
    expect(runs.map(({ creditAmount, skippedReason, legs }) => ({ creditAmount, skippedReason, legs: legs.length }))).toEqual([
      { creditAmount: '10.01', skippedReason: null, legs: 1 },
      { creditAmount: '0.5', skippedReason: 'below_minimum', legs: 0 },
    ]);
    // Recorded once, the small payment is never weighed again, so it cannot hold the sweep back.
    expect(await bank.sorter.sweep(10, later())).toEqual({ creditsRecorded: 0, runsDriven: 0, legsStillPending: 0 });
  });

  it('while the bank has no terms a payment is recorded unsorted, and publishing terms later never splits it', async () => {
    const { bills, savings, sorter } = await sixtyForty();
    options.incomeSorterMinCredit = undefined;
    await bobPays('100');
    options.incomeSorterMinCredit = '1';
    expect(await bank.sorter.sweep(10, later())).toEqual({ creditsRecorded: 0, runsDriven: 0, legsStillPending: 0 });
    expect(await mainOf()).toBe('100');
    expect(await balanceOf(bills.id)).toBe('0');
    expect(await balanceOf(savings.id)).toBe('0');
    const [run] = await caller(ADA).sorter.runs({ sorterId: sorter.id, limit: 10 });
    expect(run).toMatchObject({ creditAmount: '100', skippedReason: 'terms_unset', legs: [] });
  });

  it('a payment whose send never sorted it (a crash after the post) is sorted by the sweep, once', async () => {
    await bobPays('100');
    const { bills, savings, sorter } = await sixtyForty();
    await backdate(sorter.id);
    expect(await bank.sorter.sweep(10, later())).toEqual({ creditsRecorded: 1, runsDriven: 0, legsStillPending: 0 });
    expect(await bank.sorter.sweep(10, later())).toEqual({ creditsRecorded: 0, runsDriven: 0, legsStillPending: 0 });
    expect(await balanceOf(bills.id)).toBe('60');
    expect(await balanceOf(savings.id)).toBe('40');
    expect(sorterMoves()).toHaveLength(2);
  });

  it('a split whose reply was lost stays pending, and the sweep settles it under the same key without moving twice', async () => {
    const { bills, savings, sorter } = await sixtyForty();
    loseSorterReplies = true;
    await bobPays('100');
    const [pending] = await caller(ADA).sorter.runs({ sorterId: sorter.id, limit: 10 });
    expect(pending!.legs.map((leg) => leg.status)).toEqual(['pending', 'pending']);
    // A run younger than a minute is the send's; the sweep leaves it alone.
    expect(await bank.sorter.sweep(10)).toEqual({ creditsRecorded: 0, runsDriven: 0, legsStillPending: 0 });
    loseSorterReplies = false;
    expect(await bank.sorter.sweep(10, later())).toEqual({ creditsRecorded: 0, runsDriven: 1, legsStillPending: 0 });
    expect(await bank.sorter.sweep(10, later())).toEqual({ creditsRecorded: 0, runsDriven: 0, legsStillPending: 0 });
    expect(sorterMoves()).toHaveLength(2);
    expect(await balanceOf(bills.id)).toBe('60');
    expect(await balanceOf(savings.id)).toBe('40');
    const [settled] = await caller(ADA).sorter.runs({ sorterId: sorter.id, limit: 10 });
    expect(settled!.legs.map((leg) => leg.status)).toEqual(['settled', 'settled']);
  });

  it('a hanging ledger never holds the payer: the send answers within its bound and the splits wait for the sweep', async () => {
    const { sorter } = await sixtyForty();
    hangSorterPosts = true;
    const started = Date.now();
    const paid = await bobPays('100');
    expect(paid.amount).toBe('100');
    expect(Date.now() - started).toBeLessThan(9_000);
    const [run] = await caller(ADA).sorter.runs({ sorterId: sorter.id, limit: 10 });
    expect(run!.legs.map((leg) => leg.status)).toEqual(['pending', 'pending']);
  }, 20_000);

  it('a split that moved before its space was archived settles on its booking, never "not moved"', async () => {
    const { savings, sorter } = await sixtyForty();
    loseSorterReplies = true;
    await bobPays('100');
    loseSorterReplies = false;
    await caller(ADA).transfers.create({
      transferId: `own-${randomUUID()}`,
      fromSpaceId: savings.id,
      toSpaceId: (await bank.spaces.ensurePrimary(ADA, 'USDT')).id,
      amount: '40',
    });
    await bank.spaces.archive(savings.id);
    expect(await bank.sorter.sweep(10, later())).toEqual({ creditsRecorded: 0, runsDriven: 1, legsStillPending: 0 });
    const [run] = await caller(ADA).sorter.runs({ sorterId: sorter.id, limit: 10 });
    expect(run!.legs.map(({ status, rejectionCode }) => ({ status, rejectionCode }))).toEqual([
      { status: 'settled', rejectionCode: null },
      { status: 'settled', rejectionCode: null },
    ]);
    expect(sorterMoves()).toHaveLength(2);
  });

  it('a refused split moves nothing and is recorded with its code; the other split still lands', async () => {
    const { bills, savings, sorter } = await sixtyForty();
    await bank.spaces.archive(savings.id);
    await bobPays('100');
    expect(await balanceOf(bills.id)).toBe('60');
    expect(await mainOf()).toBe('40');
    const [run] = await caller(ADA).sorter.runs({ sorterId: sorter.id, limit: 10 });
    expect(run!.legs.map(({ status, rejectionCode }) => ({ status, rejectionCode }))).toEqual([
      { status: 'settled', rejectionCode: null },
      { status: 'rejected', rejectionCode: 'bank.space_archived' },
    ]);
    // The sorter still names the archived space and says so: its share stays in the account until the person changes it.
    const [listed] = (await caller(ADA).sorter.list()).sorters;
    expect(listed!.legs.map(({ spaceName, archived }) => ({ spaceName, archived }))).toEqual([
      { spaceName: bills.name, archived: false },
      { spaceName: savings.name, archived: true },
    ]);
    // A refused split is final: the sweep does not move it later.
    expect(await bank.sorter.sweep(10, later())).toEqual({ creditsRecorded: 0, runsDriven: 0, legsStillPending: 0 });
    expect(await mainOf()).toBe('40');
  });

  it('an account emptied before the sweep refuses each split by the ledger’s code and moves nothing', async () => {
    await bobPays('100');
    const main = await bank.spaces.ensurePrimary(ADA, 'USDT');
    const elsewhere = await pot('TEST elsewhere');
    await caller(ADA).transfers.create({ transferId: `own-${randomUUID()}`, fromSpaceId: main.id, toSpaceId: elsewhere.id, amount: '100' });
    const { bills, savings, sorter } = await sixtyForty();
    await backdate(sorter.id);
    expect(await bank.sorter.sweep(10, later())).toMatchObject({ creditsRecorded: 1 });
    const [run] = await caller(ADA).sorter.runs({ sorterId: sorter.id, limit: 10 });
    expect(run!.legs.map((leg) => leg.status)).toEqual(['rejected', 'rejected']);
    expect(run!.legs[0]!.rejectionCode).toBe('ledger.insufficient_funds');
    expect(await balanceOf(bills.id)).toBe('0');
    expect(await balanceOf(savings.id)).toBe('0');
    expect(sorterMoves()).toHaveLength(0);
  });

  it('an absent key is no proof while an earlier post may still land: the split waits out the in-flight bound', async () => {
    const { bills, savings, sorter } = await sixtyForty();
    dropSorterPosts = true;
    const paid = await bobPays('100');
    dropSorterPosts = false;
    // The account empties while both posts are still in flight: nothing under the keys, and nothing may be refused yet.
    const main = await bank.spaces.ensurePrimary(ADA, 'USDT');
    const elsewhere = await pot('TEST elsewhere');
    await caller(ADA).transfers.create({ transferId: `own-${randomUUID()}`, fromSpaceId: main.id, toSpaceId: elsewhere.id, amount: '100' });
    expect(await bank.sorter.sweep(10, later())).toEqual({ creditsRecorded: 0, runsDriven: 1, legsStillPending: 2 });
    const [waiting] = await caller(ADA).sorter.runs({ sorterId: sorter.id, limit: 10 });
    expect(waiting!.legs.map(({ status, rejectionCode }) => ({ status, rejectionCode }))).toEqual([
      { status: 'pending', rejectionCode: null },
      { status: 'pending', rejectionCode: null },
    ]);
    expect(sorterMoves()).toHaveLength(0);

    // The first split's post lands late; the next sweep finds it under its key and settles it.
    await caller(ADA).transfers.create({ transferId: `own-${randomUUID()}`, fromSpaceId: elsewhere.id, toSpaceId: main.id, amount: '60' });
    await ledger.post(
      recipes.bankTransfer({
        transferId: sorterTransferId(sorter.id, paid.ledgerTxId!),
        occurrence: 0,
        from: accountForSpace(main),
        to: accountForSpace(bills),
        amount: parseAmount('60'),
        kind: 'manual',
        keySpace: 'own',
      }),
    );
    expect(await bank.sorter.sweep(10, later())).toEqual({ creditsRecorded: 0, runsDriven: 1, legsStillPending: 1 });

    // Past the bound with nothing under its key, the second post is dead: the split posts again, and the empty account
    // refuses it by the ledger's code.
    await sql`UPDATE bank.income_sorter_run_legs SET attempted_at = attempted_at - interval '8 minutes'`;
    expect(await bank.sorter.sweep(10, later())).toEqual({ creditsRecorded: 0, runsDriven: 1, legsStillPending: 0 });
    const [run] = await caller(ADA).sorter.runs({ sorterId: sorter.id, limit: 10 });
    expect(run!.legs.map(({ status, rejectionCode }) => ({ status, rejectionCode }))).toEqual([
      { status: 'settled', rejectionCode: null },
      { status: 'rejected', rejectionCode: 'ledger.insufficient_funds' },
    ]);
    expect(await balanceOf(bills.id)).toBe('60');
    expect(await balanceOf(savings.id)).toBe('0');
    expect(sorterMoves()).toHaveLength(1);
  });

  it('a space archived while its split may still land waits out the bound before the split is refused', async () => {
    const { savings, sorter } = await sixtyForty();
    dropSorterPosts = true;
    await bobPays('100');
    dropSorterPosts = false;
    await bank.spaces.archive(savings.id);
    expect(await bank.sorter.sweep(10, later())).toMatchObject({ runsDriven: 1, legsStillPending: 2 });
    await sql`UPDATE bank.income_sorter_run_legs SET attempted_at = attempted_at - interval '8 minutes'`;
    expect(await bank.sorter.sweep(10, later())).toMatchObject({ runsDriven: 1, legsStillPending: 0 });
    const [run] = await caller(ADA).sorter.runs({ sorterId: sorter.id, limit: 10 });
    expect(run!.legs.map(({ status, rejectionCode }) => ({ status, rejectionCode }))).toEqual([
      { status: 'settled', rejectionCode: null },
      { status: 'rejected', rejectionCode: 'bank.space_archived' },
    ]);
  });

  it('a frozen or unreachable ledger never makes a split final: it stays pending and lands once the ledger answers', async () => {
    const { bills, savings, sorter } = await sixtyForty();
    const unreachable = () => Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    for (const failure of [() => new LedgerError('postings are frozen', 'ledger.frozen'), unreachable]) {
      failSorterPosts = failure;
      await sql`UPDATE bank.income_sorter_run_legs SET attempted_at = attempted_at - interval '8 minutes'`;
      if (failure === unreachable) {
        expect(await bank.sorter.sweep(10, later())).toMatchObject({ runsDriven: 1, legsStillPending: 2 });
      } else {
        await bobPays('100');
      }
      const [run] = await caller(ADA).sorter.runs({ sorterId: sorter.id, limit: 10 });
      expect(run!.legs.map(({ status, rejectionCode }) => ({ status, rejectionCode }))).toEqual([
        { status: 'pending', rejectionCode: null },
        { status: 'pending', rejectionCode: null },
      ]);
    }
    failSorterPosts = null;
    // Inside the bound the splits wait; past it they post and land, once.
    expect(await bank.sorter.sweep(10, later())).toMatchObject({ runsDriven: 1, legsStillPending: 2 });
    await sql`UPDATE bank.income_sorter_run_legs SET attempted_at = attempted_at - interval '8 minutes'`;
    expect(await bank.sorter.sweep(10, later())).toEqual({ creditsRecorded: 0, runsDriven: 1, legsStillPending: 0 });
    expect(await balanceOf(bills.id)).toBe('60');
    expect(await balanceOf(savings.id)).toBe('40');
    expect(sorterMoves()).toHaveLength(2);
  });

  it('a cancelled sorter sorts nothing new; what it sorted stays', async () => {
    const { bills, sorter } = await sixtyForty();
    await bobPays('100');
    const cancelled = await caller(ADA).sorter.cancel({ sorterId: sorter.id });
    expect(cancelled.status).toBe('cancelled');
    expect((await caller(ADA).sorter.list()).sorters).toEqual([]);
    await bobPays('100');
    expect(await bank.sorter.sweep(10, later())).toMatchObject({ creditsRecorded: 0 });
    expect(await balanceOf(bills.id)).toBe('60');
    expect(await mainOf()).toBe('100');
  });
});
