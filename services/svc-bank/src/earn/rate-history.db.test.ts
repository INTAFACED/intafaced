/**
 * BK-earn-05 (J-bank-08 #1): a pool's rate history. Opening a pool records its first rate; an approved change moves the
 * pool's rate and appends a record in one transaction; nothing is invented for a pool opened before the table; the
 * table refuses edits. Enters through the router for the operator doors and the customer read.
 *
 * Postgres (TEST_DATABASE_URL) and a MemoryLedger. Does not start Docker.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import type { ActionApproval, ActionApprovalConsumeInput } from '@intafaced/contracts';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { ActionApprovalConsumeError, bankActionPayloadHash } from '../action-approval-consume.js';
import { createBankServices, memoryRecipientState, type BankServices } from '../bank-service.js';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankRouter } from '../router.js';
import {
  CREATE_EARN_POOL_ACTION,
  SET_EARN_POOL_RATE_ACTION,
  createEarnPoolFields,
  setEarnPoolRateFields,
  type CreateEarnPoolInput,
  type SetEarnPoolRateInput,
} from '../ops/earn-pools.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '../..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 'c'.repeat(32);
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const OPERATOR = '77777777-7777-4777-8777-777777777777';
const APPROVER = '88888888-8888-4888-8888-888888888888';
const PAYER = '59999999-9999-4999-8999-999999999999';
const SID = '99999999-9999-4999-8999-999999999999';

function principal(userId: string, scopes: string[]): Principal {
  return { sub: userId, userId, sid: SID, scopes, tier: 'full', mfa: true, expiresAt: new Date(Date.now() + 60_000) } as Principal;
}

function caller(bank: BankServices, userId: string, scopes: string[], approvals?: ReturnType<typeof deskApprovals>) {
  const raw = encodePrincipal(principal(userId, scopes));
  const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });
  return createBankRouter(bank, approvals ? { approvals } : {}).createCaller(
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

/** Identity stand-in: an approval is bound to one action and one set of fields, and is consumed once. */
function deskApprovals() {
  const issued = new Map<string, { action: string; hash: string }>();
  const used = new Set<string>();
  let consumed = 0;
  const issue = (action: string, fields: Record<string, string>) => {
    const approvalId = randomUUID();
    issued.set(approvalId, { action, hash: bankActionPayloadHash(action, fields) });
    return { approvalId, operationId: randomUUID() };
  };
  return {
    get consumed() {
      return consumed;
    },
    pool: (input: CreateEarnPoolInput) => issue(CREATE_EARN_POOL_ACTION, createEarnPoolFields(input)),
    rate: (input: SetEarnPoolRateInput) => issue(SET_EARN_POOL_RATE_ACTION, setEarnPoolRateFields(input)),
    async consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> {
      const bound = issued.get(input.approvalId);
      if (!bound || bound.hash !== input.payloadHash || input.targetId !== bound.action || used.has(input.approvalId)) {
        throw new ActionApprovalConsumeError('approval does not match these terms', 'action_approval.consume_failed');
      }
      used.add(input.approvalId);
      consumed += 1;
      const now = new Date().toISOString();
      return {
        approvalId: input.approvalId,
        actionType: bound.action,
        targetService: 'svc-bank',
        targetId: bound.action,
        expectedVersion: '1',
        payloadHash: input.payloadHash,
        requesterId: OPERATOR,
        approverId: APPROVER,
        requesterIsFounder: true,
        approverIsFounder: true,
        policyVersion: 'v1',
        createdAt: now,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        status: 'CONSUMED',
        operationId: input.operationId,
      };
    },
  };
}

/** TEST terms only; not an owner value. */
function flexible(over: Partial<CreateEarnPoolInput> = {}): CreateEarnPoolInput {
  return {
    poolId: randomUUID(),
    assetId: 'USDT',
    kind: 'flexible',
    name: 'TEST flexible',
    aprBps: 150,
    termDays: null,
    minDeposit: '10',
    ...over,
  };
}

describe('earn rate history (BK-earn-05)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;

  beforeAll(async () => {
    const raw = process.env.TEST_DATABASE_URL?.trim();
    if (!raw) throw new Error('TEST_DATABASE_URL is unset. This suite does not start Docker.');
    const url = new URL(raw);
    if (url.pathname === '/test') url.pathname = '/intafaced_test';
    db = await createTestDatabase({ service: 'bank', url: url.toString(), migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    await sql`TRUNCATE bank.earn_rate_changes, bank.interest_accruals, bank.earn_positions, bank.earn_pools RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
  });

  function services(): BankServices {
    return createBankServices(sql, ledger, memoryLedgerHistory(ledger), { nativeAssetId: 'IFC', recipients: memoryRecipientState() });
  }
  const treasury = (bank: BankServices, approvals: ReturnType<typeof deskApprovals>) =>
    caller(bank, OPERATOR, ['admin:treasury'], approvals);
  const customer = (bank: BankServices) => caller(bank, CUSTOMER, ['bank:read', 'bank:write']);

  it('opening a pool records its first rate, and the customer reads it with the pool’s facts', async () => {
    const bank = services();
    const approvals = deskApprovals();
    const input = flexible();
    const created = await treasury(bank, approvals).ops.createEarnPool({ ...input, ...approvals.pool(input) });
    expect(created).toMatchObject({
      poolId: input.poolId,
      aprBps: 150,
      termDays: null,
      minDeposit: '10',
      status: 'open',
      approvedBy: APPROVER,
    });

    const history = await customer(bank).earn.rateHistory({ poolId: input.poolId, limit: 10 });
    expect(history.currentBps).toBe(150);
    expect(history.earlier).toBe(false);
    expect(history.changes).toHaveLength(1);
    expect(history.changes[0]).toMatchObject({ rateBps: 150, reason: null });

    const page = await customer(bank).earn.pool({ poolId: input.poolId });
    expect(page).toMatchObject({
      id: input.poolId,
      status: 'open',
      payoutEvery: 'day',
      compounding: 'simple',
      rewardAssetId: 'USDT',
      yieldSource: 'pool_reserve',
      rateBands: null,
      commissionBps: null,
      capacity: null,
    });
    const [listed] = await customer(bank).earn.pools({ limit: 10 });
    expect(listed).toMatchObject({ id: input.poolId, rateBands: null, commissionBps: null, capacity: null });
  });

  it('an approved change moves the rate and appends one record; interest pays it from the next full day', async () => {
    const bank = services();
    const approvals = deskApprovals();
    const input = flexible({ aprBps: 3650 });
    await treasury(bank, approvals).ops.createEarnPool({ ...input, ...approvals.pool(input) });
    const change = { poolId: input.poolId, rateBps: 7300, reason: 'TEST rate rise' };
    const moved = await treasury(bank, approvals).ops.setEarnPoolRate({ ...change, ...approvals.rate(change) });
    expect(moved).toMatchObject({ poolId: input.poolId, rateBps: 7300, previousBps: 3650, approvedBy: APPROVER });

    const history = await customer(bank).earn.rateHistory({ poolId: input.poolId, limit: 10 });
    expect(history.currentBps).toBe(7300);
    expect(history.changes.map((c) => [c.rateBps, c.reason])).toEqual([
      [3650, null],
      [7300, 'TEST rate rise'],
    ]);
    expect(Date.parse(history.changes[1]!.effectiveAt)).toBeGreaterThan(Date.parse(history.changes[0]!.effectiveAt));
    expect((await bank.earn.pool(input.poolId)).aprBps).toBe(7300);

    // 1000 saved since yesterday. Today began before the change, so today pays the old 36.5% (exactly 1); tomorrow is
    // the first full day at 73% (exactly 2). Each day's record names the rate it paid.
    await ledger.post(recipes.deposit({ userId: CUSTOMER, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: randomUUID() }));
    await ledger.post(recipes.deposit({ userId: PAYER, assetId: 'USDT', amount: amt('100'), rail: 'test', railRef: randomUUID() }));
    await ledger.post(
      recipes.feeCharge({
        chargeId: `bank:${randomUUID()}`,
        userId: PAYER,
        module: 'bank',
        mode: 'asset',
        assetId: 'USDT',
        amount: amt('100'),
      }),
    );
    await bank.earn.fundPool({ poolId: input.poolId, fundingId: 'seed-1', amount: amt('100') });
    const DAY = 24 * 60 * 60 * 1000;
    await bank.earn.deposit({
      poolId: input.poolId,
      userId: CUSTOMER,
      amount: amt('1000'),
      positionId: randomUUID(),
      now: new Date(Date.now() - DAY),
    });
    expect((await bank.earn.accrue({ poolId: input.poolId, at: new Date() })).paid).toBe(amt('1'));
    expect((await bank.earn.accrue({ poolId: input.poolId, at: new Date(Date.now() + DAY) })).paid).toBe(amt('2'));
    const rows = await sql<Array<{ rate_bps: string }>>`
      SELECT rate_bps FROM bank.interest_accruals WHERE pool_id = ${input.poolId} ORDER BY accrual_date
    `;
    expect(rows.map((row) => Number(row.rate_bps))).toEqual([3650, 7300]);
    expect(await bank.earn.interestPaid(input.poolId)).toBe(amt('3'));
  });

  it('a position shows the rate its pool had recorded when it opened, and one pool’s positions read alone', async () => {
    const bank = services();
    const approvals = deskApprovals();
    const input = flexible({ aprBps: 3650, minDeposit: '0' });
    await treasury(bank, approvals).ops.createEarnPool({ ...input, ...approvals.pool(input) });
    const other = flexible({ aprBps: 100, minDeposit: '0' });
    await treasury(bank, approvals).ops.createEarnPool({ ...other, ...approvals.pool(other) });
    await ledger.post(recipes.deposit({ userId: CUSTOMER, assetId: 'USDT', amount: amt('100'), rail: 'test', railRef: randomUUID() }));
    const first = randomUUID();
    await bank.earn.deposit({ poolId: input.poolId, userId: CUSTOMER, amount: amt('10'), positionId: first });
    const change = { poolId: input.poolId, rateBps: 7300, reason: 'TEST rate rise' };
    await treasury(bank, approvals).ops.setEarnPoolRate({ ...change, ...approvals.rate(change) });
    const second = randomUUID();
    await bank.earn.deposit({ poolId: input.poolId, userId: CUSTOMER, amount: amt('10'), positionId: second });
    // Opened before the pool's first record: the bank has no record of the rate then, and says so.
    const early = randomUUID();
    await bank.earn.deposit({
      poolId: other.poolId,
      userId: CUSTOMER,
      amount: amt('10'),
      positionId: early,
      now: new Date(Date.now() - 60_000),
    });

    const mine = await customer(bank).earn.positions({ limit: 10, poolId: input.poolId });
    expect(mine.map((p) => [p.id, p.rateAtOpenBps]).sort()).toEqual(
      [
        [first, 3650],
        [second, 7300],
      ].sort(),
    );
    const all = await customer(bank).earn.positions({ limit: 10 });
    expect(all.find((p) => p.id === early)?.rateAtOpenBps).toBeNull();
    // Someone else's pool filter shows them nothing of this person's.
    expect(await caller(bank, PAYER, ['bank:read']).earn.positions({ limit: 10, poolId: input.poolId })).toEqual([]);
  });

  it('refuses a fixed pool’s change, the rate already in force, an unknown pool, and spends no approval doing it', async () => {
    const bank = services();
    const approvals = deskApprovals();
    const fixed = flexible({ kind: 'fixed', termDays: 30, aprBps: 600 });
    await treasury(bank, approvals).ops.createEarnPool({ ...fixed, ...approvals.pool(fixed) });
    const spent = approvals.consumed;

    const onFixed = { poolId: fixed.poolId, rateBps: 700, reason: 'TEST rise' };
    await expect(treasury(bank, approvals).ops.setEarnPoolRate({ ...onFixed, ...approvals.rate(onFixed) })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const flex = flexible();
    await treasury(bank, approvals).ops.createEarnPool({ ...flex, ...approvals.pool(flex) });
    const same = { poolId: flex.poolId, rateBps: 150, reason: 'TEST same' };
    await expect(treasury(bank, approvals).ops.setEarnPoolRate({ ...same, ...approvals.rate(same) })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const unknown = { poolId: randomUUID(), rateBps: 200, reason: 'TEST nobody' };
    await expect(treasury(bank, approvals).ops.setEarnPoolRate({ ...unknown, ...approvals.rate(unknown) })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(approvals.consumed).toBe(spent + 1);
    expect(await sql`SELECT 1 FROM bank.earn_rate_changes`).toHaveLength(2);
    expect((await bank.earn.pool(fixed.poolId)).aprBps).toBe(600);
  });

  it('refuses a change with no approval or one bound to another rate, and records nothing', async () => {
    const bank = services();
    const approvals = deskApprovals();
    const input = flexible();
    await treasury(bank, approvals).ops.createEarnPool({ ...input, ...approvals.pool(input) });
    const change = { poolId: input.poolId, rateBps: 175, reason: 'TEST rise' };
    await expect(treasury(bank, approvals).ops.setEarnPoolRate(change)).rejects.toThrow();
    await expect(
      treasury(bank, approvals).ops.setEarnPoolRate({ ...change, ...approvals.rate({ ...change, rateBps: 9000 }) }),
    ).rejects.toThrow();
    await expect(
      caller(bank, CUSTOMER, ['bank:read', 'bank:write']).ops.setEarnPoolRate({ ...change, ...approvals.rate(change) }),
    ).rejects.toThrow();
    expect(await sql`SELECT 1 FROM bank.earn_rate_changes`).toHaveLength(1);
    expect((await bank.earn.pool(input.poolId)).aprBps).toBe(150);
  });

  it('one approval writes one record: the service replays the record it already wrote', async () => {
    const bank = services();
    const approvals = deskApprovals();
    const input = flexible();
    await treasury(bank, approvals).ops.createEarnPool({ ...input, ...approvals.pool(input) });
    const approvalId = randomUUID();
    const first = await bank.earn.setPoolRate({ poolId: input.poolId, rateBps: 175, reason: 'TEST rise', approvalId });
    const again = await bank.earn.setPoolRate({ poolId: input.poolId, rateBps: 175, reason: 'TEST rise', approvalId });
    expect(again).toEqual(first);
    expect(first.previousBps).toBe(150);
    await expect(bank.earn.setPoolRate({ poolId: input.poolId, rateBps: 200, reason: 'TEST other', approvalId })).rejects.toMatchObject({
      code: 'bank.pool_conflict',
    });
    expect(await sql`SELECT 1 FROM bank.earn_rate_changes`).toHaveLength(2);
  });

  it('a retried create with the same id and terms is the same pool; other terms conflict', async () => {
    const bank = services();
    const approvals = deskApprovals();
    const input = flexible();
    await treasury(bank, approvals).ops.createEarnPool({ ...input, ...approvals.pool(input) });
    const again = await treasury(bank, approvals).ops.createEarnPool({ ...input, ...approvals.pool(input) });
    expect(again.poolId).toBe(input.poolId);
    const other = { ...input, aprBps: 999 };
    await expect(treasury(bank, approvals).ops.createEarnPool({ ...other, ...approvals.pool(other) })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const badTerm = flexible({ termDays: 30 });
    await expect(treasury(bank, approvals).ops.createEarnPool({ ...badTerm, ...approvals.pool(badTerm) })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(await sql`SELECT 1 FROM bank.earn_pools`).toHaveLength(1);
    expect(await sql`SELECT 1 FROM bank.earn_rate_changes`).toHaveLength(1);
  });

  it('a pool opened before the table has no history; nothing is filled in', async () => {
    const bank = services();
    const [legacy] = await sql<Array<{ id: string }>>`
      INSERT INTO bank.earn_pools (asset_id, kind, name, apr_bps, min_deposit) VALUES ('USDT', 'flexible', 'TEST old', 400, 0) RETURNING id
    `;
    const history = await customer(bank).earn.rateHistory({ poolId: legacy!.id, limit: 10 });
    expect(history).toEqual({ poolId: legacy!.id, currentBps: 400, changes: [], earlier: false });
    await expect(customer(bank).earn.rateHistory({ poolId: randomUUID(), limit: 10 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(customer(bank).earn.rateHistory({ poolId: legacy!.id })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('a pre-table pool’s first change records the rate it was paying first, so the day of the change still pays it', async () => {
    const bank = services();
    const [legacy] = await sql<Array<{ id: string }>>`
      INSERT INTO bank.earn_pools (asset_id, kind, name, apr_bps, min_deposit) VALUES ('USDT', 'flexible', 'TEST old', 3650, 0) RETURNING id
    `;
    const poolId = legacy!.id;
    await bank.earn.setPoolRate({ poolId, rateBps: 7300, reason: 'TEST first change', approvalId: randomUUID() });
    const history = await customer(bank).earn.rateHistory({ poolId, limit: 10 });
    expect(history.changes.map((c) => [c.rateBps, c.reason])).toEqual([
      [3650, null],
      [7300, 'TEST first change'],
    ]);
    expect(history.earlier).toBe(false);

    await ledger.post(recipes.deposit({ userId: CUSTOMER, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: randomUUID() }));
    await ledger.post(recipes.deposit({ userId: PAYER, assetId: 'USDT', amount: amt('100'), rail: 'test', railRef: randomUUID() }));
    await ledger.post(
      recipes.feeCharge({
        chargeId: `bank:${randomUUID()}`,
        userId: PAYER,
        module: 'bank',
        mode: 'asset',
        assetId: 'USDT',
        amount: amt('100'),
      }),
    );
    await bank.earn.fundPool({ poolId, fundingId: 'seed-legacy', amount: amt('100') });
    const DAY = 24 * 60 * 60 * 1000;
    await bank.earn.deposit({ poolId, userId: CUSTOMER, amount: amt('1000'), positionId: randomUUID(), now: new Date(Date.now() - DAY) });
    // Today began before the change: it pays the 36.5% the pool was paying (exactly 1), not the new 73%.
    expect((await bank.earn.accrue({ poolId, at: new Date() })).paid).toBe(amt('1'));
    expect((await bank.earn.accrue({ poolId, at: new Date(Date.now() + DAY) })).paid).toBe(amt('2'));
  });

  it('pages back: the newest records oldest first, and says older ones exist', async () => {
    const bank = services();
    const pool = await bank.earn.createPool({ assetId: 'USDT', kind: 'flexible', name: 'TEST paged', aprBps: 100 });
    for (const [i, rate] of [110, 120, 130].entries()) {
      await bank.earn.setPoolRate({
        poolId: pool.id,
        rateBps: rate,
        reason: `TEST step ${i}`,
        approvalId: randomUUID(),
        now: new Date(Date.now() + (i + 1) * 1000),
      });
    }
    const page = await bank.earn.rateHistory(pool.id, 2);
    expect(page.changes.map((c) => c.rateBps)).toEqual([120, 130]);
    expect(page.earlier).toBe(true);
    expect((await bank.earn.rateHistory(pool.id, 10)).earlier).toBe(false);
  });

  it('the table is append-only: an edit or a delete raises', async () => {
    const bank = services();
    const pool = await bank.earn.createPool({ assetId: 'USDT', kind: 'flexible', name: 'TEST frozen', aprBps: 100 });
    await expect(sql`UPDATE bank.earn_rate_changes SET rate_bps = 999 WHERE pool_id = ${pool.id}`).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM bank.earn_rate_changes WHERE pool_id = ${pool.id}`).rejects.toThrow(/append-only/);
  });
});
