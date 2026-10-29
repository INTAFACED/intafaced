/**
 * BK-earn-04 (J-bank-08 #6): a staking-style pool. A saving taken back first unbonds (no money moves, no more days
 * earned), then the bank releases it through the withdraw recipe. A pool closed to new savings by a four-eyes status
 * change refuses deposits while the savings it holds keep accruing and can be taken back. The slashing wording is the
 * owner's: blank refuses. Enters through the router for the operator doors, the jobs and the customer.
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
import { MemoryLedger, formatAmount, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import { ActionApprovalConsumeError, bankActionPayloadHash } from '../action-approval-consume.js';
import { createBankServices, memoryRecipientState, type BankServices } from '../bank-service.js';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankRouter } from '../router.js';
import {
  CREATE_EARN_POOL_ACTION,
  SET_EARN_POOL_STATUS_ACTION,
  createEarnPoolFields,
  setEarnPoolStatusFields,
  type CreateEarnPoolInput,
  type SetEarnPoolStatusInput,
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
/** TEST wording only; not an owner value. */
const TEST_WORDING = JSON.stringify({
  slashing: 'TEST: a slashing event can reduce what you get back.',
  ownership: 'TEST: the saving stays yours while it is staked.',
});

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

function principal(userId: string, scopes: string[]): Principal {
  return { sub: userId, userId, sid: SID, scopes, tier: 'full', mfa: true, expiresAt: new Date(Date.now() + 60_000) } as Principal;
}

function caller(
  bank: BankServices,
  userId: string,
  scopes: string[],
  options: { approvals?: ReturnType<typeof deskApprovals>; service?: 'svc-bank' } = {},
) {
  const raw = encodePrincipal(principal(userId, scopes));
  const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });
  const ctx = edge({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: `req-${randomUUID()}`,
  });
  // The ops jobs answer only the bank's own scheduler, signed as svc-bank.
  return createBankRouter(bank, options.approvals ? { approvals: options.approvals } : {}).createCaller(
    options.service ? { ...ctx, service: options.service } : ctx,
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
    status: (input: SetEarnPoolStatusInput) => issue(SET_EARN_POOL_STATUS_ACTION, setEarnPoolStatusFields(input)),
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

/** TEST terms only; not an owner value. 36.5% so 1000 earns exactly 1 a day. */
function staking(over: Partial<CreateEarnPoolInput> = {}): CreateEarnPoolInput {
  return {
    poolId: randomUUID(),
    assetId: 'USDT',
    kind: 'flexible',
    name: 'TEST staking',
    aprBps: 3650,
    termDays: null,
    minDeposit: '10',
    unbondingDays: 7,
    ...over,
  };
}

describe('staking-style earn pool and pool status (BK-earn-04)', () => {
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
    await sql`
      TRUNCATE bank.earn_pool_status_changes, bank.earn_rate_changes, bank.interest_accruals, bank.earn_positions,
        bank.earn_pools RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
  });

  function services(riskWording: string | undefined): BankServices {
    return createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      nativeAssetId: 'IFC',
      recipients: memoryRecipientState(),
      earnRiskWording: riskWording,
    });
  }
  const treasury = (bank: BankServices, approvals: ReturnType<typeof deskApprovals>) =>
    caller(bank, OPERATOR, ['admin:treasury'], { approvals });
  const jobs = (bank: BankServices) => caller(bank, PAYER, ['admin:treasury'], { service: 'svc-bank' });
  const customer = (bank: BankServices) => caller(bank, CUSTOMER, ['bank:read', 'bank:write']);
  const main = async () => formatAmount((await ledger.balance(userAvailable(CUSTOMER, 'USDT'))).amount);

  /** A staking pool through the four-eyes door, its reserve funded and the customer's TEST balance seeded. */
  async function openStaking(bank: BankServices, approvals: ReturnType<typeof deskApprovals>) {
    const input = staking();
    await treasury(bank, approvals).ops.createEarnPool({ ...input, ...approvals.pool(input) });
    await ledger.post(recipes.deposit({ userId: CUSTOMER, assetId: 'USDT', amount: amt('2000'), rail: 'test', railRef: 'seed-customer' }));
    await ledger.post(recipes.deposit({ userId: PAYER, assetId: 'USDT', amount: amt('200'), rail: 'test', railRef: 'seed-payer' }));
    await ledger.post(
      recipes.feeCharge({ chargeId: 'bank:seed', userId: PAYER, module: 'bank', mode: 'asset', assetId: 'USDT', amount: amt('100') }),
    );
    await bank.earn.fundPool({ poolId: input.poolId, fundingId: 'seed-1', amount: amt('100') });
    return input.poolId;
  }

  async function close(bank: BankServices, approvals: ReturnType<typeof deskApprovals>, poolId: string, revision: number) {
    const change: SetEarnPoolStatusInput = { poolId, status: 'closed', reason: 'TEST closed to new savings', revision };
    return treasury(bank, approvals).ops.setEarnPoolStatus({ ...change, ...approvals.status(change) });
  }

  it('opens a staking pool through the door; a fixed pool cannot unbond, and other pools hash as before', async () => {
    const bank = services(TEST_WORDING);
    const approvals = deskApprovals();
    const poolId = await openStaking(bank, approvals);
    expect(await customer(bank).earn.pool({ poolId })).toMatchObject({ unbondingDays: 7, status: 'open', statusRevision: 0 });

    const fixed = staking({ kind: 'fixed', termDays: 30 });
    await expect(treasury(bank, approvals).ops.createEarnPool({ ...fixed, ...approvals.pool(fixed) })).rejects.toMatchObject({
      cause: { code: 'bank.pool_terms_invalid' },
    });
    // Refused before the second person was spent: only the staking pool's approval is used.
    expect(approvals.consumed).toBe(1);
    expect(Object.keys(createEarnPoolFields(staking({ unbondingDays: null })))).not.toContain('unbondingDays');
  });

  it('a closed pool refuses a deposit with bank.pool_closed and nothing changes; the change is recorded once', async () => {
    const bank = services(TEST_WORDING);
    const approvals = deskApprovals();
    const poolId = await openStaking(bank, approvals);
    const held = randomUUID();
    await customer(bank).earn.deposit({ poolId, positionId: held, amount: '100' });

    expect(await close(bank, approvals, poolId, 1)).toEqual({
      poolId,
      status: 'closed',
      previousStatus: 'open',
      revision: 1,
      approvedBy: APPROVER,
    });
    expect(await customer(bank).earn.pool({ poolId })).toMatchObject({ status: 'closed', statusRevision: 1 });

    const before = await main();
    await expect(customer(bank).earn.deposit({ poolId, positionId: randomUUID(), amount: '50' })).rejects.toMatchObject({
      cause: { code: 'bank.pool_closed' },
    });
    // Re-read after the refusal: still one saving, the main balance untouched.
    expect((await customer(bank).earn.positions({ limit: 10, poolId })).map((p) => p.id)).toEqual([held]);
    expect(await main()).toBe(before);

    const rows = await sql<Array<{ revision: number; status: string; previous_status: string; requested_by: string; approved_by: string }>>`
      SELECT revision, status, previous_status, requested_by, approved_by FROM bank.earn_pool_status_changes WHERE pool_id = ${poolId}
    `;
    expect(rows).toHaveLength(1);
    // Both people are on the record: the proposer and the second person.
    expect(rows[0]).toMatchObject({
      revision: 1,
      status: 'closed',
      previous_status: 'open',
      requested_by: OPERATOR,
      approved_by: APPROVER,
    });
    // The record is append-only.
    await expect(sql`UPDATE bank.earn_pool_status_changes SET reason = 'edited' WHERE pool_id = ${poolId}`).rejects.toThrow(/append-only/);
  });

  it('an unchanged status and a stale revision refuse before the second person is spent', async () => {
    const bank = services(TEST_WORDING);
    const approvals = deskApprovals();
    const poolId = await openStaking(bank, approvals);
    await close(bank, approvals, poolId, 1);
    const spent = approvals.consumed;

    await expect(close(bank, approvals, poolId, 2)).rejects.toMatchObject({ cause: { code: 'bank.pool_status_unchanged' } });
    const reopenStale: SetEarnPoolStatusInput = { poolId, status: 'open', reason: 'TEST reopen', revision: 5 };
    await expect(
      treasury(bank, approvals).ops.setEarnPoolStatus({ ...reopenStale, ...approvals.status(reopenStale) }),
    ).rejects.toMatchObject({ cause: { code: 'bank.pool_status_stale' } });
    expect(approvals.consumed).toBe(spent);
    expect(await customer(bank).earn.pool({ poolId })).toMatchObject({ status: 'closed', statusRevision: 1 });
  });

  it('two status changes sent at once make one change and spend one approval', async () => {
    const bank = services(TEST_WORDING);
    const approvals = deskApprovals();
    const poolId = await openStaking(bank, approvals);
    const spent = approvals.consumed;
    // The same change under the same key, twice at once: one is recorded, the other reads it back.
    const same = await Promise.all([close(bank, approvals, poolId, 1), close(bank, approvals, poolId, 1)]);
    expect(same[0]).toEqual({ poolId, status: 'closed', previousStatus: 'open', revision: 1, approvedBy: APPROVER });
    expect(same[1]).toEqual(same[0]);
    expect(approvals.consumed).toBe(spent + 1);

    // Two different changes at once for the same next revision: one lands, the other is stale and spends nothing.
    const reopen = (reason: string): SetEarnPoolStatusInput => ({ poolId, status: 'open', reason, revision: 2 });
    const outcomes = await Promise.allSettled(
      [reopen('TEST reopen one'), reopen('TEST reopen two')].map((change) =>
        treasury(bank, approvals).ops.setEarnPoolStatus({ ...change, ...approvals.status(change) }),
      ),
    );
    expect(outcomes.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected']);
    const refused = outcomes.find((o): o is PromiseRejectedResult => o.status === 'rejected')!;
    expect(refused.reason).toMatchObject({ cause: { code: 'bank.pool_status_unchanged' } });
    expect(approvals.consumed).toBe(spent + 2);
    const rows = await sql`SELECT revision FROM bank.earn_pool_status_changes WHERE pool_id = ${poolId} ORDER BY revision`;
    expect(rows.map((r) => r.revision)).toEqual([1, 2]);
  });

  it('a change sent again after its answer was lost reads back the recorded change and spends no approval', async () => {
    const bank = services(TEST_WORDING);
    const approvals = deskApprovals();
    const poolId = await openStaking(bank, approvals);
    const first = await close(bank, approvals, poolId, 1);
    const spent = approvals.consumed;
    expect(await close(bank, approvals, poolId, 1)).toEqual(first);
    expect(approvals.consumed).toBe(spent);
    // The same revision with another reason is not the same change: it is stale.
    const other: SetEarnPoolStatusInput = { poolId, status: 'closed', reason: 'TEST another reason', revision: 1 };
    await expect(treasury(bank, approvals).ops.setEarnPoolStatus({ ...other, ...approvals.status(other) })).rejects.toMatchObject({
      cause: { code: 'bank.pool_status_unchanged' },
    });
    expect(approvals.consumed).toBe(spent);
    expect(await sql`SELECT revision FROM bank.earn_pool_status_changes WHERE pool_id = ${poolId}`).toHaveLength(1);
  });

  it('a held saving keeps accruing in a closed pool, unbonds once, earns no later day, and is released once', async () => {
    const bank = services(TEST_WORDING);
    const approvals = deskApprovals();
    const poolId = await openStaking(bank, approvals);
    const positionId = randomUUID();
    const opened = new Date(Date.now() - 3 * DAY);
    await bank.earn.deposit({ poolId, userId: CUSTOMER, amount: amt('1000'), positionId, now: opened });
    await close(bank, approvals, poolId, 1);
    const [staked] = await customer(bank).earn.positions({ limit: 10, poolId });
    expect(staked).toMatchObject({ accrual: 'accruing', staking: 'staked', unbondsAt: null, unbondingDays: 7 });

    // The closed pool pays its first day.
    const firstDay = new Date(staked!.accruesFrom);
    expect(await bank.earn.accrue({ poolId, at: new Date(firstDay.getTime() + HOUR) })).toMatchObject({ paid: amt('1'), recipients: 1 });

    // A take back without confirming the unbonding refuses; nothing changes.
    const afterInterest = await main();
    await expect(customer(bank).earn.withdraw({ positionId })).rejects.toMatchObject({ cause: { code: 'bank.unbond_not_confirmed' } });
    const [unchanged] = await customer(bank).earn.positions({ limit: 10, poolId });
    expect(unchanged).toMatchObject({ staking: 'staked', unbondsAt: null });

    // Confirmed: unbonding for the pool's 7 days by the bank's clock, no money moved.
    const asked = Date.now();
    const unbonding = await customer(bank).earn.withdraw({ positionId, unbond: true });
    expect(unbonding).toMatchObject({ positionId, principal: '1000', status: 'unbonding' });
    const unbondsAt = Date.parse(unbonding.unbondsAt!);
    expect(unbondsAt - asked).toBeGreaterThanOrEqual(7 * DAY);
    expect(unbondsAt - Date.now()).toBeLessThanOrEqual(7 * DAY);
    expect(await main()).toBe(afterInterest);

    // The same request again is the same request; a plain take back waits for the end.
    expect(await customer(bank).earn.withdraw({ positionId, unbond: true })).toEqual(unbonding);
    await expect(customer(bank).earn.withdraw({ positionId })).rejects.toMatchObject({ cause: { code: 'bank.position_unbonding' } });
    const [waiting] = await customer(bank).earn.positions({ limit: 10, poolId });
    // The day it was asked began staked, so that day is its last payout.
    expect(waiting).toMatchObject({
      accrual: 'unbonding',
      staking: 'unbonding',
      unbondsAt: unbonding.unbondsAt,
      nextPayoutOn: new Date(asked).toISOString().slice(0, 10),
    });

    // The day after it was asked pays it nothing.
    const nextDay = new Date(Date.parse(`${new Date(asked).toISOString().slice(0, 10)}T00:00:00Z`) + DAY + HOUR);
    expect(await bank.earn.accrue({ poolId, at: nextDay })).toMatchObject({ paid: 0n, recipients: 0 });

    // The release job: nothing before the end by the bank's clock, whatever time a caller names.
    const lateClock = { limit: 10, at: new Date(unbondsAt + DAY).toISOString() } as unknown as { limit: number };
    expect(await jobs(bank).ops.releaseUnbondedEarn(lateClock)).toEqual({ released: [], skipped: [], next: null });
    expect(await main()).toBe(afterInterest);
    // The unbonding ends (moved back in time, as the bank's clock passing it would).
    await sql`
      UPDATE bank.earn_positions
         SET unbonding_started_at = unbonding_started_at - interval '7 days 1 minute', unbonds_at = unbonds_at - interval '7 days 1 minute'
       WHERE id = ${positionId}
    `;
    expect(await jobs(bank).ops.releaseUnbondedEarn({ limit: 10 })).toEqual({
      released: [{ positionId, principal: '1000' }],
      skipped: [],
      next: null,
    });
    expect(await main()).toBe(formatAmount(amt(afterInterest) + amt('1000')));
    expect(await jobs(bank).ops.releaseUnbondedEarn({ limit: 10 })).toEqual({ released: [], skipped: [], next: null });
    expect(await main()).toBe(formatAmount(amt(afterInterest) + amt('1000')));
    expect(await customer(bank).earn.positions({ limit: 10, poolId })).toEqual([]);
  });

  it('a saving in a pool without unbonding is taken back at once, with or without the flag', async () => {
    const bank = services(TEST_WORDING);
    const approvals = deskApprovals();
    await openStaking(bank, approvals);
    const plain = staking({ unbondingDays: null, name: 'TEST flexible' });
    await treasury(bank, approvals).ops.createEarnPool({ ...plain, ...approvals.pool(plain) });
    const positionId = randomUUID();
    await customer(bank).earn.deposit({ poolId: plain.poolId, positionId, amount: '100' });
    const [position] = await customer(bank).earn.positions({ limit: 10, poolId: plain.poolId });
    expect(position).toMatchObject({ staking: null, unbondsAt: null });
    expect(await customer(bank).earn.withdraw({ positionId })).toEqual({ positionId, principal: '100', status: 'closed', unbondsAt: null });
  });

  it('the release job pages by cursor, so the savings at the front never hold the rest back', async () => {
    const bank = services(TEST_WORDING);
    const approvals = deskApprovals();
    const poolId = await openStaking(bank, approvals);
    const ids = [randomUUID(), randomUUID()].sort();
    for (const positionId of ids) {
      await customer(bank).earn.deposit({ poolId, positionId, amount: '100' });
      await customer(bank).earn.withdraw({ positionId, unbond: true });
    }
    await sql`
      UPDATE bank.earn_positions
         SET unbonding_started_at = unbonding_started_at - interval '8 days', unbonds_at = unbonds_at - interval '8 days'
       WHERE pool_id = ${poolId}
    `;
    const first = await jobs(bank).ops.releaseUnbondedEarn({ limit: 1, poolId });
    expect(first).toEqual({ released: [{ positionId: ids[0], principal: '100' }], skipped: [], next: ids[0] });
    expect(await jobs(bank).ops.releaseUnbondedEarn({ limit: 1, poolId, after: first.next! })).toEqual({
      released: [{ positionId: ids[1], principal: '100' }],
      skipped: [],
      next: ids[1],
    });
    expect(await jobs(bank).ops.releaseUnbondedEarn({ limit: 1, poolId, after: ids[1] })).toEqual({
      released: [],
      skipped: [],
      next: null,
    });
  });

  it('the release job refuses a blank batch size', async () => {
    const bank = services(TEST_WORDING);
    await expect(jobs(bank).ops.releaseUnbondedEarn({})).rejects.toMatchObject({ cause: { code: 'bank.earn_release_batch_limit_unset' } });
  });

  it('the slashing wording is the owner’s: published it reads back, blank or out of shape it refuses', async () => {
    expect(await customer(services(TEST_WORDING)).earn.riskDisclosure()).toEqual(JSON.parse(TEST_WORDING));
    const halves = [JSON.stringify({ slashing: 'TEST only' }), JSON.stringify({ slashing: 'TEST', ownership: '  ' })];
    for (const wording of [undefined, '', '   ', 'not json', '{}', '{"slashing":3,"ownership":"x"}', ...halves]) {
      await expect(customer(services(wording)).earn.riskDisclosure()).rejects.toMatchObject({
        cause: { code: 'bank.earn_risk_wording_unset' },
      });
    }
  });
});
