/**
 * Futures ADR slice 4: the operator door that tops up the insurance fund.
 * Real Postgres via TEST_DATABASE_URL for the request and audit tables; the ledger is the in-memory reference.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import {
  MemoryLedger,
  formatAmount,
  houseFees,
  insuranceFund,
  parseAmount as amt,
  recipes,
  type PostRequest,
} from '@intafaced/ledger-client';
import { principalFor } from '../spot/testing.js';
import { MemoryApprovalBook, payloadHash } from './common.js';
import { InsuranceTopupAdmin, insuranceAdminRouter } from './insurance-topup.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

const rawUrl = process.env.TEST_DATABASE_URL?.trim();
if (!rawUrl) throw new Error('TEST_DATABASE_URL is unset; this suite does not start Docker');
const url = (() => {
  const parsed = new URL(rawUrl);
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (name.endsWith('_test')) return rawUrl;
  parsed.pathname = '/intafaced_test';
  return parsed.toString();
})();

const USER = '11111111-1111-4111-8111-111111111111';
const OP = '33333333-3333-4333-8333-333333333333';
const APPROVER = '44444444-4444-4444-8444-444444444444';
const writer = () => principalFor(OP, ['admin:read', 'admin:write']);

describe('insurance fund top-up door', () => {
  let db: TestDatabase;
  let ledger: MemoryLedger;
  let book: MemoryApprovalBook;
  let admin: InsuranceTopupAdmin;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url, migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  }, 60_000);

  /** Seed `amount` of house trade fees the way a real fee lands: a deposit, then a fee charge. */
  async function seedFees(target: MemoryLedger, amount: string, tag: string): Promise<void> {
    const seed = amt(amount);
    await target.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: seed, rail: 'test', railRef: `d-${tag}` }));
    await target.post(
      recipes.feeCharge({ chargeId: `fee-${tag}`, userId: USER, module: 'trade', mode: 'asset', assetId: 'USDT', amount: seed }),
    );
  }

  function approve(approvalId: string, input: { assetId: string; amount: string; reason: string }): void {
    book.put({
      approvalId,
      actionType: 'trade.insurance_topup',
      targetService: 'svc-trade',
      targetId: input.assetId,
      expectedVersion: '0',
      payloadHash: payloadHash({ actionType: 'trade.insurance_topup', ...input }),
      requesterId: OP,
      approverId: APPROVER,
    });
  }

  const request = (over: Partial<Parameters<InsuranceTopupAdmin['topup']>[1]> = {}) => ({
    assetId: 'USDT',
    amount: '80',
    reason: 'seed the test fund',
    approvalId: 'ap-1',
    clientRequestId: 'topup-1',
    ...over,
  });

  const fund = async () => formatAmount((await ledger.balance(insuranceFund('USDT'))).amount);
  const fees = async () => formatAmount((await ledger.balance(houseFees('trade', 'USDT'))).amount);

  beforeEach(async () => {
    await db.sql`TRUNCATE trade.operator_audit, trade.operator_requests RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
    book = new MemoryApprovalBook();
    admin = new InsuranceTopupAdmin({ sql: db.sql, approvals: book, ledger });
    await seedFees(ledger, '200', 'a');
  });

  it('moves house trade fees into the fund, audits it with both people, and stores the request', async () => {
    approve('ap-1', { assetId: 'USDT', amount: '80', reason: 'seed the test fund' });
    const result = await admin.topup(writer(), request());
    expect(result).toMatchObject({ assetId: 'USDT', amount: '80', topupId: 'topup-1' });
    expect(await fund()).toBe('80');
    expect(await fees()).toBe('120');
    expect(ledger.reconcile()).toEqual({ ok: true });

    const audit = await db.sql<Array<{ kind: string; operator_id: string; approver_id: string; object_id: string }>>`
      SELECT kind, operator_id::text, approver_id::text, object_id FROM trade.operator_audit`;
    expect(audit).toEqual([{ kind: 'insurance.topup', operator_id: OP, approver_id: APPROVER, object_id: 'USDT' }]);
    const stored = await db.sql`SELECT kind FROM trade.operator_requests WHERE client_request_id = 'topup-1'`;
    expect(stored).toHaveLength(1);
  });

  it('a retry of the same request returns the same answer and posts once', async () => {
    approve('ap-1', { assetId: 'USDT', amount: '80', reason: 'seed the test fund' });
    const first = await admin.topup(writer(), request());
    const second = await admin.topup(writer(), request());
    expect(second).toEqual(first);
    expect(await fund()).toBe('80');
    expect(await db.sql`SELECT 1 FROM trade.operator_audit`).toHaveLength(1);
  });

  it('refuses the same clientRequestId for a different amount', async () => {
    approve('ap-1', { assetId: 'USDT', amount: '80', reason: 'seed the test fund' });
    await admin.topup(writer(), request());
    approve('ap-2', { assetId: 'USDT', amount: '90', reason: 'seed the test fund' });
    await expect(admin.topup(writer(), request({ amount: '90', approvalId: 'ap-2' }))).rejects.toMatchObject({
      code: 'client_request_conflict',
    });
    expect(await fund()).toBe('80');
  });

  it('needs the write scope', async () => {
    approve('ap-1', { assetId: 'USDT', amount: '80', reason: 'seed the test fund' });
    await expect(admin.topup(principalFor(OP, ['admin:read']), request())).rejects.toThrow();
    await expect(admin.topup(principalFor(USER, ['trade:write']), request())).rejects.toThrow();
    expect(await fund()).toBe('0');
  });

  it('refuses a missing approval, a second operator mismatch and a different amount, and moves nothing', async () => {
    await expect(admin.topup(writer(), request({ approvalId: 'none' }))).rejects.toMatchObject({ code: 'approval_missing' });
    approve('ap-1', { assetId: 'USDT', amount: '80', reason: 'seed the test fund' });
    await expect(admin.topup(writer(), request({ amount: '81' }))).rejects.toMatchObject({ code: 'approval_mismatch' });
    book.put({
      approvalId: 'self',
      actionType: 'trade.insurance_topup',
      targetService: 'svc-trade',
      targetId: 'USDT',
      expectedVersion: '0',
      payloadHash: payloadHash({ actionType: 'trade.insurance_topup', assetId: 'USDT', amount: '80', reason: 'seed the test fund' }),
      requesterId: OP,
      approverId: OP,
    });
    await expect(admin.topup(writer(), request({ approvalId: 'self' }))).rejects.toMatchObject({ code: 'approval_mismatch' });
    expect(await fund()).toBe('0');
    expect(await db.sql`SELECT 1 FROM trade.operator_requests`).toHaveLength(0);
  });

  it('refuses a bad amount, asset or reason before any approval is spent', async () => {
    approve('ap-1', { assetId: 'USDT', amount: '80', reason: 'seed the test fund' });
    for (const amount of ['0', '-5', '1e3', '1.5555555555555555555', '', ' ', 'abc', '0.0']) {
      await expect(admin.topup(writer(), request({ amount }))).rejects.toMatchObject({ code: 'insurance_topup_amount_invalid' });
    }
    await expect(admin.topup(writer(), request({ assetId: '' }))).rejects.toMatchObject({ code: 'insurance_topup_asset_invalid' });
    await expect(admin.topup(writer(), request({ reason: 'x' }))).rejects.toMatchObject({ code: 'reason_required' });
    // The approval is still unspent: the same approval now works.
    await expect(admin.topup(writer(), request())).resolves.toMatchObject({ amount: '80' });
  });

  it('refuses with a typed code when the fees pot is short, and does not spend the approval', async () => {
    approve('ap-1', { assetId: 'USDT', amount: '500', reason: 'seed the test fund' });
    await expect(admin.topup(writer(), request({ amount: '500' }))).rejects.toMatchObject({ code: 'insurance_topup_source_short' });
    expect(await fund()).toBe('0');
    expect(await fees()).toBe('200');
    await seedFees(ledger, '300', 'b');
    await expect(admin.topup(writer(), request({ amount: '500' }))).resolves.toMatchObject({ amount: '500' });
  });

  it('refuses when no ledger is wired', async () => {
    const unwired = new InsuranceTopupAdmin({ sql: db.sql, approvals: book, ledger: null });
    approve('ap-1', { assetId: 'USDT', amount: '80', reason: 'seed the test fund' });
    await expect(unwired.topup(writer(), request())).rejects.toMatchObject({ code: 'insurance_topup_unwired' });
  });

  it('a crash after the post and before the record is recovered on retry without a second posting', async () => {
    approve('ap-1', { assetId: 'USDT', amount: '80', reason: 'seed the test fund' });
    let posts = 0;
    // The ledger commits, then the reply is lost: the caller sees an error although the money moved.
    const lossy = {
      balance: ledger.balance.bind(ledger),
      getTxByKey: ledger.getTxByKey.bind(ledger),
      post: async (req: PostRequest) => {
        posts += 1;
        await ledger.post(req);
        throw new Error('socket hang up');
      },
    };
    const crashing = new InsuranceTopupAdmin({ sql: db.sql, approvals: book, ledger: lossy });
    await expect(crashing.topup(writer(), request())).rejects.toThrow('socket hang up');
    expect(await fund()).toBe('80');
    expect(await db.sql`SELECT 1 FROM trade.operator_requests`).toHaveLength(0);

    // The approval is spent, but the booked top-up is found under the request's key and amount.
    const result = await admin.topup(writer(), request());
    expect(result).toMatchObject({ amount: '80', topupId: 'topup-1' });
    expect(posts).toBe(1);
    expect(await fund()).toBe('80');
    expect(await fees()).toBe('120');
    expect(await db.sql`SELECT 1 FROM trade.operator_requests`).toHaveLength(1);
    expect(await db.sql`SELECT 1 FROM trade.operator_audit`).toHaveLength(1);
  });

  it('a spent approval does not let a different request through', async () => {
    approve('ap-1', { assetId: 'USDT', amount: '80', reason: 'seed the test fund' });
    await admin.topup(writer(), request());
    // Same approval, new request id: nothing booked under the new key, so the spent approval stays refused.
    await expect(admin.topup(writer(), request({ clientRequestId: 'topup-2' }))).rejects.toMatchObject({ code: 'approval_reused' });
    expect(await fund()).toBe('80');
  });

  it('serves admin.insurance.topup over the router and refuses it on the read scope', async () => {
    const ctx = (scopes: string[]) => ({ principal: principalFor(OP, scopes), region: 'XX', service: null, requestId: randomUUID() });
    approve('ap-r', { assetId: 'USDT', amount: '25', reason: 'router top-up' });
    const body = { assetId: 'USDT', amount: '25', reason: 'router top-up', approvalId: 'ap-r', clientRequestId: 'topup-r' };
    await expect(
      insuranceAdminRouter(admin)
        .createCaller(ctx(['admin:read']))
        .insurance.topup(body),
    ).rejects.toThrow();
    const out = await insuranceAdminRouter(admin)
      .createCaller(ctx(['admin:read', 'admin:write']))
      .insurance.topup(body);
    expect(out).toMatchObject({ amount: '25' });
    await expect(
      insuranceAdminRouter(undefined)
        .createCaller(ctx(['admin:write']))
        .insurance.topup(body),
    ).rejects.toThrow(/unconfigured/);
    expect(await fund()).toBe('25');
  });
});
