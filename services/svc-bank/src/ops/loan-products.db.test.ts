/**
 * BK-loan-02: operator loan product creation with two-person approval.
 * Enters through the router. Uses TEST_DATABASE_URL. Does not start Docker.
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
import { MemoryLedger, parseAmount, recipes, userAvailable } from '@intafaced/ledger-client';
import { ActionApprovalConsumeError, bankActionPayloadHash } from '../action-approval-consume.js';
import { createBankServices, memoryRecipientState, type BankServices } from '../bank-service.js';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { fixedPriceSource } from '../loans/prices.js';
import { createBankRouter } from '../router.js';
import { CREATE_LOAN_PRODUCT_ACTION, createLoanProductFields, type CreateLoanProductInput } from './loan-products.js';

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
const ACTION = CREATE_LOAN_PRODUCT_ACTION;

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
    issue(input: CreateLoanProductInput) {
      const approvalId = randomUUID();
      issued.set(approvalId, bankActionPayloadHash(ACTION, createLoanProductFields(input)));
      return { approvalId, operationId: randomUUID() };
    },
    async consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> {
      if (issued.get(input.approvalId) !== input.payloadHash || input.targetId !== ACTION) {
        throw new ActionApprovalConsumeError('approval does not match these terms', 'action_approval.consume_failed');
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

/** TEST terms only; not an owner value. */
function terms(over: Partial<CreateLoanProductInput> = {}): CreateLoanProductInput {
  return {
    productId: randomUUID(),
    name: 'TEST BTC-backed USDT',
    debtAssetId: 'USDT',
    collateralAssetId: 'BTC',
    quoteAssetId: 'USDT',
    aprBps: 900,
    maxLtvBps: 5_000,
    minPrincipal: '0',
    marginCallLtvBps: 7_000,
    liquidationLtvBps: 8_000,
    insolvencyLtvBps: 9_000,
    targetLtvBps: 6_000,
    penaltyBps: 500,
    maxTrancheBps: 5_000,
    graceSeconds: 3_600,
    ...over,
  };
}

describe('ops.createLoanProduct (BK-loan-02)', () => {
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
    await sql`TRUNCATE bank.loans, bank.loan_products RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
  });

  function services(): BankServices {
    return createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      nativeAssetId: 'IFC',
      recipients: memoryRecipientState(),
      loans: { priceSource: fixedPriceSource({ BTC: { price: '1' } }) },
    });
  }

  function treasury(bank: BankServices, approvals: ReturnType<typeof deskApprovals>) {
    return caller(bank, OPERATOR, ['admin:treasury'], approvals);
  }

  it('creates the product with every term, names the approver, and lists it to customers', async () => {
    const bank = services();
    const approvals = deskApprovals();
    const input = terms();
    const created = await treasury(bank, approvals).ops.createLoanProduct({ ...input, ...approvals.issue(input) });
    expect(created).toEqual({
      productId: input.productId,
      status: 'open',
      aprBps: 900,
      maxLtvBps: 5_000,
      minPrincipal: '0',
      replayed: false,
      approvedBy: APPROVER,
    });
    const stored = await bank.loans.product(input.productId);
    expect(stored.policy).toEqual({
      marginCallLtvBps: 7_000,
      liquidationLtvBps: 8_000,
      insolvencyLtvBps: 9_000,
      targetLtvBps: 6_000,
      penaltyBps: 500,
      maxTrancheBps: 5_000,
      graceSeconds: 3_600,
    });
  });

  it('a retry with the same id and terms replays; the same id with other terms conflicts', async () => {
    const bank = services();
    const approvals = deskApprovals();
    const input = terms();
    await treasury(bank, approvals).ops.createLoanProduct({ ...input, ...approvals.issue(input) });
    const again = await treasury(bank, approvals).ops.createLoanProduct({ ...input, ...approvals.issue(input) });
    expect(again.replayed).toBe(true);
    const changed = { ...input, aprBps: 1_000 };
    await expect(treasury(bank, approvals).ops.createLoanProduct({ ...changed, ...approvals.issue(changed) })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(await sql`SELECT 1 FROM bank.loan_products`).toHaveLength(1);
  });

  it('refuses with no approval, or an approval bound to other terms, and writes nothing', async () => {
    const bank = services();
    const approvals = deskApprovals();
    const input = terms();
    await expect(treasury(bank, approvals).ops.createLoanProduct(input)).rejects.toThrow();
    await expect(
      treasury(bank, approvals).ops.createLoanProduct({ ...input, ...approvals.issue({ ...input, aprBps: 0 }) }),
    ).rejects.toThrow();
    expect(await sql`SELECT 1 FROM bank.loan_products`).toHaveLength(0);
  });

  it.each([
    ['LTV out of order', { marginCallLtvBps: 4_000 }],
    ['target at or above margin call', { targetLtvBps: 7_000 }],
    ['same debt and collateral asset', { collateralAssetId: 'USDT' }],
    ['blank name', { name: '   ' }],
    ['negative apr', { aprBps: -1 }],
    ['apr above 100%', { aprBps: 10_001 }],
    ['zero max LTV', { maxLtvBps: 0 }],
    ['penalty of 100% or more', { penaltyBps: 10_000 }],
    ['insolvency above 100%', { insolvencyLtvBps: 10_001 }],
    ['zero tranche', { maxTrancheBps: 0 }],
    ['negative grace', { graceSeconds: -1 }],
  ])('refuses %s with bank.loan_params_invalid before consuming an approval', async (_label, over) => {
    const bank = services();
    const approvals = deskApprovals();
    const input = terms(over as Partial<CreateLoanProductInput>);
    await expect(treasury(bank, approvals).ops.createLoanProduct({ ...input, ...approvals.issue(input) })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('Loan product terms are invalid'),
    });
    expect(approvals.consumed).toBe(0);
    expect(await sql`SELECT 1 FROM bank.loan_products`).toHaveLength(0);
  });

  it('a blank minimum principal is refused, not defaulted', async () => {
    const approvals = deskApprovals();
    const input = terms();
    const { minPrincipal: _omitted, ...rest } = input;
    await expect(
      treasury(services(), approvals).ops.createLoanProduct({ ...(rest as CreateLoanProductInput), ...approvals.issue(input) }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      treasury(services(), approvals).ops.createLoanProduct({ ...input, minPrincipal: '', ...approvals.issue(input) }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('a read-only operator and a customer cannot create a product', async () => {
    const bank = services();
    const approvals = deskApprovals();
    const input = terms();
    await expect(
      caller(bank, OPERATOR, ['admin:read'], approvals).ops.createLoanProduct({ ...input, ...approvals.issue(input) }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller(bank, OWNER, ['bank:read', 'bank:write'], approvals).ops.createLoanProduct({ ...input, ...approvals.issue(input) }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('ops.reconcileLoanReserve answers a reserve that holds more than was recorded as funded: drift is signed, never a 500', async () => {
    const bank = services();
    // Value reaches the reserve without the bank's funding row (as a ledger-only post does): funded 0, reserve 5.
    await ledger.post(
      recipes.deposit({ userId: OWNER, assetId: 'USDC', amount: parseAmount('5'), rail: 'test', railRef: `r:${randomUUID()}` }),
    );
    await ledger.post(
      recipes.loanReserveFund({
        fundingId: `f:${randomUUID()}`,
        debtAssetId: 'USDC',
        amount: parseAmount('5'),
        from: userAvailable(OWNER, 'USDC'),
      }),
    );
    const read = await caller(bank, OPERATOR, ['admin:treasury']).ops.reconcileLoanReserve({ debtAssetId: 'USDC' });
    expect(read).toMatchObject({ reserveBalance: '5', funded: '0', outstandingPrincipal: '0', drift: '-5' });
  });
});
