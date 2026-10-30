/**
 * BK-loan-07: per-asset pause of new borrow and new supply.
 * Enters through the router. Uses TEST_DATABASE_URL. Does not start Docker.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import type { Principal } from '@intafaced/auth';
import type { ActionApproval, ActionApprovalConsumeInput } from '@intafaced/contracts';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount, recipes, userAvailable } from '@intafaced/ledger-client';
import { ActionApprovalConsumeError, bankActionPayloadHash } from '../action-approval-consume.js';
import { createBankServices, memoryRecipientState, type BankServices } from '../bank-service.js';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { BankError } from '../errors.js';
import { DEFAULT_LIQUIDATION_POLICY } from '../loans/risk.js';
import { fixedPriceSource } from '../loans/prices.js';
import { createBankRouter } from '../router.js';
import { AssetPauseService, pauseChangeKey } from './asset-pause.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '../..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 'c'.repeat(32);
const OWNER = '11111111-1111-4111-8111-111111111111';
const OPERATOR = '77777777-7777-4777-8777-777777777777';
const APPROVER = '88888888-8888-4888-8888-888888888888';
const SID = '99999999-9999-4999-8999-999999999999';
const ACTION = 'bank.ops.setAssetPause';
const REASON = 'TEST: oracle incident on this asset';

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

/** Identity stand-in: an approval is bound to one asset, one new state and one revision. */
function deskApprovals() {
  const issued = new Map<string, string>();
  let consumed = 0;
  return {
    get consumed() {
      return consumed;
    },
    issue(assetId: string, borrowPaused: boolean, supplyPaused: boolean, revision: number) {
      const approvalId = randomUUID();
      issued.set(
        approvalId,
        bankActionPayloadHash(ACTION, {
          assetId,
          borrowPaused: String(borrowPaused),
          supplyPaused: String(supplyPaused),
          revision: String(revision),
        }),
      );
      return { approvalId, operationId: randomUUID() };
    },
    async consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> {
      if (issued.get(input.approvalId) !== input.payloadHash || input.targetId !== ACTION) {
        throw new ActionApprovalConsumeError('approval does not match this asset and state', 'action_approval.consume_failed');
      }
      consumed += 1;
      const now = new Date().toISOString();
      return {
        approvalId: input.approvalId,
        actionType: ACTION,
        targetService: 'svc-bank',
        targetId: ACTION,
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

describe('per-asset pause of new borrow and new supply (BK-loan-07)', () => {
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
      TRUNCATE bank.auto_invest_runs, bank.auto_invest_rules, bank.asset_pause_history, bank.asset_pauses, bank.earn_positions, bank.earn_pools, bank.loans, bank.loan_products
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
  });

  function services(): BankServices {
    return createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      nativeAssetId: 'IFC',
      recipients: memoryRecipientState(),
      loans: { originationFeeBps: '0', priceSource: fixedPriceSource({ BTC: { price: '1' } }) },
    });
  }

  async function pause(
    bank: BankServices,
    approvals: ReturnType<typeof deskApprovals>,
    assetId: string,
    borrowPaused: boolean,
    supplyPaused: boolean,
    expectedRevision: number,
    reason = REASON,
  ) {
    return caller(bank, OPERATOR, ['admin:treasury'], approvals).ops.setAssetPause({
      assetId,
      borrowPaused,
      supplyPaused,
      expectedRevision,
      reason,
      ...approvals.issue(assetId, borrowPaused, supplyPaused, expectedRevision + 1),
    });
  }

  it('desk read starts empty, names the three owners, and a read-only operator cannot change anything', async () => {
    const bank = services();
    const desk = caller(bank, OPERATOR, ['admin:read']);
    expect(await desk.ops.assetPauses()).toEqual({
      owners: { assetPause: 'svc-bank', postingFreeze: 'svc-ledger', accountFreeze: 'svc-identity' },
      assets: [],
      history: [],
    });
    await expect(
      desk.ops.setAssetPause({ assetId: 'BTC', borrowPaused: true, supplyPaused: false, expectedRevision: 0, reason: REASON }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller(bank, OWNER, ['bank:read']).ops.assetPauses()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a history read with no page size refuses rather than defaulting one', async () => {
    const desk = caller(services(), OPERATOR, ['admin:read']);
    await expect(desk.ops.assetPauses({ historyFor: 'BTC' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('a change with no second person is refused and writes nothing', async () => {
    const bank = services();
    const approvals = deskApprovals();
    await expect(
      caller(bank, OPERATOR, ['admin:treasury'], approvals).ops.setAssetPause({
        assetId: 'BTC',
        borrowPaused: true,
        supplyPaused: false,
        expectedRevision: 0,
        reason: REASON,
      }),
    ).rejects.toThrow();
    // An approval issued for a different state does not authorise this one.
    await expect(
      caller(bank, OPERATOR, ['admin:treasury'], approvals).ops.setAssetPause({
        assetId: 'BTC',
        borrowPaused: true,
        supplyPaused: true,
        expectedRevision: 0,
        reason: REASON,
        ...approvals.issue('BTC', true, false, 1),
      }),
    ).rejects.toThrow();
    expect(await sql`SELECT 1 FROM bank.asset_pauses`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM bank.asset_pause_history`).toHaveLength(0);
  });

  it('a reason shorter than 10 characters refuses before any approval is consumed', async () => {
    const approvals = deskApprovals();
    await expect(pause(services(), approvals, 'BTC', true, false, 0, 'short')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(approvals.consumed).toBe(0);
  });

  it('records the change with its approver and business key; a retry replays, a different change on the same revision conflicts', async () => {
    const bank = services();
    const approvals = deskApprovals();
    const first = await pause(bank, approvals, 'BTC', true, false, 0);
    expect(first).toMatchObject({
      assetId: 'BTC',
      borrowPaused: true,
      supplyPaused: false,
      revision: 1,
      approvedBy: APPROVER,
      replayed: false,
    });

    const again = await pause(bank, approvals, 'BTC', true, false, 0);
    expect(again).toMatchObject({ revision: 1, replayed: true });
    expect(approvals.consumed).toBe(1);

    await expect(pause(bank, approvals, 'BTC', true, true, 0)).rejects.toMatchObject({ code: 'CONFLICT' });
    // A stale revision is the loser of a concurrent toggle.
    await expect(pause(bank, approvals, 'BTC', false, false, 5)).rejects.toMatchObject({ code: 'CONFLICT' });

    const desk = await caller(bank, OPERATOR, ['admin:read']).ops.assetPauses({ historyFor: 'BTC', historyLimit: 10 });
    expect(desk.assets).toEqual([expect.objectContaining({ assetId: 'BTC', borrowPaused: true, revision: 1 })]);
    expect(desk.history).toEqual([expect.objectContaining({ revision: 1, changeKey: pauseChangeKey('BTC', 1), approvedBy: APPROVER })]);

    const second = await pause(bank, approvals, 'BTC', false, false, 1);
    expect(second).toMatchObject({ revision: 2, borrowPaused: false });
  });

  it('two operators toggling the same revision at once: one change, one ops_revision_conflict', async () => {
    const bank = services();
    const approvals = deskApprovals();
    const results = await Promise.allSettled([
      pause(bank, approvals, 'ETH', true, false, 0),
      pause(bank, approvals, 'ETH', false, true, 0),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: 'CONFLICT' });
    expect(await sql`SELECT 1 FROM bank.asset_pause_history WHERE asset_id = 'ETH'`).toHaveLength(1);
  });

  it('a borrow pause refuses loans.open before collateral is locked; lifting it lets the request reach the loan service', async () => {
    const bank = services();
    const approvals = deskApprovals();
    const product = await bank.loans.createProduct({
      name: 'TEST BTC-backed USDT',
      debtAssetId: 'USDT',
      collateralAssetId: 'BTC',
      quoteAssetId: 'USDT',
      aprBps: 1_000,
      maxLtvBps: 5_000,
      minPrincipal: 0n,
      policy: DEFAULT_LIQUIDATION_POLICY,
    });
    await ledger.post(recipes.deposit({ userId: OWNER, assetId: 'BTC', amount: parseAmount('3'), rail: 'test', railRef: randomUUID() }));
    const journal = ledger.journal().length;
    await pause(bank, approvals, 'BTC', true, false, 0);

    const owner = caller(bank, OWNER, ['bank:read', 'bank:write']);
    const open = { loanId: randomUUID(), productId: product.id, collateralAmount: '2', principal: '0.5' };
    await expect(owner.loans.open(open)).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('paused') });
    expect(await sql`SELECT 1 FROM bank.loans`).toHaveLength(0);
    expect(ledger.journal()).toHaveLength(journal);

    // A supply-only pause on the debt asset does not stop borrowing.
    await pause(bank, approvals, 'BTC', false, false, 1);
    await pause(bank, approvals, 'USDT', false, true, 0);
    const reached = await owner.loans.open(open).then(
      () => 'opened',
      (err: { message: string }) => err.message,
    );
    expect(reached).not.toContain('paused');
  });

  it('a supply pause refuses earn.deposit; a borrow-only pause does not', async () => {
    const bank = services();
    const approvals = deskApprovals();
    const pool = await bank.earn.createPool({ assetId: 'USDT', kind: 'flexible', name: 'TEST cash', aprBps: 100 });
    await ledger.post(recipes.deposit({ userId: OWNER, assetId: 'USDT', amount: parseAmount('10'), rail: 'test', railRef: randomUUID() }));
    const owner = caller(bank, OWNER, ['bank:read', 'bank:write']);

    await pause(bank, approvals, 'USDT', false, true, 0);
    await expect(owner.earn.deposit({ poolId: pool.id, amount: '1', positionId: randomUUID() })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(await sql`SELECT 1 FROM bank.earn_positions`).toHaveLength(0);

    await pause(bank, approvals, 'USDT', true, false, 1);
    const position = await owner.earn.deposit({ poolId: pool.id, amount: '1', positionId: randomUUID() });
    expect(position.positionId).toBeTruthy();
  });

  it('a supply pause refuses auto-invest deposits too (threshold sweep and card round-up); nothing is staked', async () => {
    const bank = services();
    const approvals = deskApprovals();
    const pool = await bank.earn.createPool({ assetId: 'USDT', kind: 'flexible', name: 'TEST cash', aprBps: 100 });
    await ledger.post(recipes.deposit({ userId: OWNER, assetId: 'USDT', amount: parseAmount('10'), rail: 'test', railRef: randomUUID() }));
    const sweep = await bank.autoInvest.createThresholdSweep({
      userId: OWNER,
      assetId: 'USDT',
      threshold: parseAmount('4'),
      targetPoolId: pool.id,
    });
    await bank.autoInvest.createCardRoundUp({ userId: OWNER, assetId: 'USDT', granularity: parseAmount('1'), targetPoolId: pool.id });

    await pause(bank, approvals, 'USDT', false, true, 0);

    const report = await bank.autoInvest.runDue({ limit: 10 });
    expect(report.settled).toBe(0);
    expect(report.rejected).toBe(1);
    const runs = await bank.autoInvest.runsOf(sweep.id);
    expect(runs.map((r) => r.status)).toEqual(['rejected']);
    expect(await sql`SELECT rejection_code FROM bank.auto_invest_runs WHERE rule_id = ${sweep.id}::uuid`).toEqual([
      { rejection_code: 'bank.asset_paused' },
    ]);

    const roundUp = await bank.autoInvest.applyRoundUp({
      userId: OWNER,
      assetId: 'USDT',
      authorizationId: randomUUID(),
      captured: parseAmount('2.5'),
    });
    expect(roundUp).toMatchObject({ status: 'refused', reason: 'bank.asset_paused' });

    expect(await sql`SELECT 1 FROM bank.earn_positions`).toHaveLength(0);
    expect((await ledger.balance(userAvailable(OWNER, 'USDT'))).amount).toBe(parseAmount('10'));
  });

  it('an unreadable pause state refuses the operation instead of assuming open', async () => {
    const broken = (() => Promise.reject(new Error('connection reset'))) as unknown as Sql;
    const pauses = new AssetPauseService(broken);
    await expect(pauses.assertBorrowOpen(['BTC'])).rejects.toMatchObject({ code: 'bank.asset_pause_unreadable' });
    await expect(pauses.assertSupplyOpen('USDT')).rejects.toBeInstanceOf(BankError);
  });
});
