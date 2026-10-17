/**
 * Customer procedures for business team, recipient spaces, approval history,
 * and dual-controlled close / threshold. Enters through the router.
 *
 * H8a: uses TEST_DATABASE_URL. This file does not start Docker.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import {
  createEdgeContext,
  encodePrincipal,
  signPrincipalHeader,
  type ActionApproval,
  type ActionApprovalConsumeInput,
} from '@intafaced/contracts';
import { MemoryLedger, formatAmount, parseAmount, recipes, userAvailable } from '@intafaced/ledger-client';
import { ActionApprovalConsumeError, bankActionPayloadHash } from '../action-approval-consume.js';
import { createBankServices, memoryRecipientState, type BankServices } from '../bank-service.js';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankRouter } from '../router.js';
import { createStepUpGate } from '../step-up/step-up-gate.js';
import { BusinessLookupLimiter, memoryBusinessDirectory, type DirectoryPerson } from './business-directory.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '../..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 'c'.repeat(32);
const ADMIN = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const MAKER = '33333333-3333-4333-8333-333333333333';
const CHECKER = '44444444-4444-4444-8444-444444444444';
const PAYEE = '55555555-5555-4555-8555-555555555555';
const FROZEN = '66666666-6666-4666-8666-666666666666';
const SID = '77777777-7777-4777-8777-777777777777';

const PEOPLE: DirectoryPerson[] = [
  { userId: ADMIN, handle: 'Ada_Admin', email: 'ada@example.com', status: 'active' },
  { userId: SECOND, handle: 'Bea_Admin', email: 'bea@example.com', status: 'active' },
  { userId: MAKER, handle: 'Max_Maker', email: 'max@example.com', status: 'active' },
  { userId: CHECKER, handle: 'Cara_Check', email: 'cara@example.com', status: 'active' },
  { userId: PAYEE, handle: 'Pat_Payee', email: 'pat@example.com', status: 'active' },
  { userId: FROZEN, handle: 'Fro_Zen', email: 'fro@example.com', status: 'frozen' },
];

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

function caller(bank: BankServices, userId: string, stepUp?: ReturnType<typeof createStepUpGate>) {
  const raw = encodePrincipal(principal(userId));
  const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });
  return createBankRouter(bank, stepUp ? { stepUp } : {}).createCaller(
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

function approvingIdentity() {
  const rows = new Map<string, { hash: string; userId: string; actionType: string }>();
  return {
    approve(actionType: string, fields: Record<string, string>, userId: string) {
      const id = randomUUID();
      rows.set(id, { hash: bankActionPayloadHash(actionType, fields), userId, actionType });
      return id;
    },
    async consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> {
      const row = rows.get(input.approvalId);
      const refuse = (code: string): never => {
        throw new ActionApprovalConsumeError(`refused [action_approval.${code}]`, 'action_approval.consume_failed');
      };
      if (!row || row.hash !== input.payloadHash || row.actionType !== input.targetId) return refuse('payload_mismatch');
      if (row.userId !== input.principalUserId || input.principalSessionId !== SID) return refuse('not_requester');
      const now = new Date().toISOString();
      return {
        approvalId: input.approvalId,
        actionType: row.actionType,
        targetService: 'svc-bank',
        targetId: input.targetId,
        expectedVersion: '1',
        payloadHash: input.payloadHash,
        requesterId: row.userId,
        approverId: row.userId,
        policyVersion: 'step-up-v1',
        createdAt: now,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        status: 'CONSUMED',
        operationId: input.approvalId,
        kind: 'same_person',
      };
    },
  };
}

describe('business team, history and dual control', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let bank: BankServices;

  beforeAll(async () => {
    const raw = process.env.TEST_DATABASE_URL?.trim();
    if (!raw) throw new Error('TEST_DATABASE_URL is unset. This suite does not start Docker.');
    // createTestDatabase only creates a per-run database from an admin database
    // whose name ends in _test. The shared server's published name is "test";
    // intafaced_test on that same server is the admin database.
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
      TRUNCATE bank.business_control_requests, bank.business_member_commands,
               bank.business_payroll_lines, bank.business_payroll_runs,
               bank.business_approvals, bank.business_members, bank.business_accounts,
               bank.transfer_executions, bank.scheduled_transfers, bank.spaces
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
    bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      nativeAssetId: 'IFC',
      recipients: memoryRecipientState(),
      directory: memoryBusinessDirectory(PEOPLE),
    });
  });

  async function openTeam() {
    const admin = caller(bank, ADMIN);
    const account = await admin.business.create({ name: 'Northwind', assetId: 'USDT', spendThreshold: '100' });
    await admin.business.addMember({ accountId: account.id, userId: SECOND, role: 'admin' });
    await admin.business.addMember({ accountId: account.id, userId: MAKER, role: 'maker' });
    await admin.business.addMember({ accountId: account.id, userId: CHECKER, role: 'checker' });
    return account;
  }

  it('lists teammates by handle and lets an admin remove or change a role', async () => {
    const account = await openTeam();
    const listed = await caller(bank, MAKER).business.members({ accountId: account.id });
    expect(listed.members.map((row) => [row.handle, row.role])).toEqual([
      ['Ada_Admin', 'admin'],
      ['Bea_Admin', 'admin'],
      ['Max_Maker', 'maker'],
      ['Cara_Check', 'checker'],
    ]);
    expect(listed.pendingControls).toEqual([]);

    await expect(
      caller(bank, MAKER).business.removeMember({ accountId: account.id, userId: CHECKER, requestId: randomUUID() }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      cause: { code: 'bank.business_role_forbidden' },
    });
    const requestId = randomUUID();
    const removed = await caller(bank, ADMIN).business.removeMember({ accountId: account.id, userId: MAKER, requestId });
    expect(removed).toEqual({ accountId: account.id, userId: MAKER, removed: true });
    expect(await caller(bank, ADMIN).business.removeMember({ accountId: account.id, userId: MAKER, requestId })).toEqual(removed);
    await expect(caller(bank, ADMIN).business.removeMember({ accountId: account.id, userId: CHECKER, requestId })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const roleId = randomUUID();
    expect(
      await caller(bank, ADMIN).business.setMemberRole({ accountId: account.id, userId: CHECKER, role: 'maker', requestId: roleId }),
    ).toMatchObject({
      role: 'maker',
    });
    expect(
      await caller(bank, ADMIN).business.setMemberRole({ accountId: account.id, userId: CHECKER, role: 'maker', requestId: roleId }),
    ).toMatchObject({
      role: 'maker',
    });
    await caller(bank, ADMIN).business.removeMember({ accountId: account.id, userId: SECOND, requestId: randomUUID() });
    await expect(
      caller(bank, ADMIN).business.setMemberRole({ accountId: account.id, userId: ADMIN, role: 'maker', requestId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: expect.stringContaining('bank.business_last_admin') });
  });

  it('requires a fresh confirmation to remove a teammate when step-up is on', async () => {
    const identity = approvingIdentity();
    const gated = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      nativeAssetId: 'IFC',
      recipients: memoryRecipientState(),
      directory: memoryBusinessDirectory(PEOPLE),
    });
    const account = await caller(gated, ADMIN).business.create({ name: 'Northwind', assetId: 'USDT', spendThreshold: '100' });
    await caller(gated, ADMIN).business.addMember({ accountId: account.id, userId: MAKER, role: 'maker' });
    const stepUp = createStepUpGate({ mode: 'required', approvals: identity });
    const admin = caller(gated, ADMIN, stepUp);
    const requestId = randomUUID();
    await expect(admin.business.removeMember({ accountId: account.id, userId: MAKER, requestId })).rejects.toMatchObject({
      message: expect.stringContaining('bank.step_up_required'),
    });
    const approvalId = identity.approve(
      'bank.step_up.business.removeMember',
      { actor: ADMIN, accountId: account.id, userId: MAKER, requestId },
      ADMIN,
    );
    expect(
      await admin.business.removeMember({ accountId: account.id, userId: MAKER, requestId, stepUpApprovalId: approvalId }),
    ).toMatchObject({
      removed: true,
    });
  });

  it('resolves a receiving space by handle or email and gives one miss for the rest', async () => {
    const account = await openTeam();
    const space = await bank.spaces.ensurePrimary(PAYEE, 'USDT');
    const admin = caller(bank, ADMIN);
    expect(await admin.business.resolveRecipientSpace({ accountId: account.id, assetId: 'USDT', handle: ' @pat_payee ' })).toEqual({
      found: true,
      handle: 'Pat_Payee',
      assetId: 'USDT',
      spaceId: space.id,
    });
    expect(await admin.business.resolveRecipientSpace({ accountId: account.id, assetId: 'USDT', email: 'PAT@example.com' })).toEqual({
      found: true,
      handle: 'Pat_Payee',
      assetId: 'USDT',
      spaceId: space.id,
    });
    expect(await admin.business.resolveRecipientSpace({ accountId: account.id, assetId: 'EUR', handle: 'Pat_Payee' })).toEqual({
      found: true,
      handle: 'Pat_Payee',
      assetId: 'EUR',
      spaceId: null,
    });
    expect(await admin.business.resolveRecipientSpace({ accountId: account.id, assetId: 'USDT', handle: 'Fro_Zen' })).toEqual({
      found: false,
    });
    expect(await admin.business.resolveRecipientSpace({ accountId: account.id, assetId: 'USDT', handle: 'nobody_here' })).toEqual({
      found: false,
    });
    expect(await admin.business.resolveRecipientSpace({ accountId: account.id, assetId: 'USDT', email: 'nope' })).toEqual({ found: false });
    await expect(
      admin.business.resolveRecipientSpace({ accountId: account.id, assetId: 'USDT', handle: 'Pat_Payee', email: 'pat@example.com' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('bank.business_recipient_query') });
  });

  it('stops recipient lookup after the caller budget', async () => {
    const limited = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      nativeAssetId: 'IFC',
      recipients: memoryRecipientState(),
      directory: memoryBusinessDirectory(PEOPLE),
      directoryLookups: new BusinessLookupLimiter({ max: 2, windowMs: 60_000 }),
    });
    const account = await caller(limited, ADMIN).business.create({ name: 'Northwind', assetId: 'USDT', spendThreshold: '100' });
    const admin = caller(limited, ADMIN);
    await admin.business.resolveRecipientSpace({ accountId: account.id, assetId: 'USDT', handle: 'nobody_here' });
    await admin.business.resolveRecipientSpace({ accountId: account.id, assetId: 'USDT', handle: 'nobody_here' });
    await expect(
      admin.business.resolveRecipientSpace({ accountId: account.id, assetId: 'USDT', handle: 'Pat_Payee' }),
    ).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: expect.stringContaining('bank.business_directory_rate_limited'),
    });
  });

  it('refuses handle reads when the directory is not connected', async () => {
    const bare = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      nativeAssetId: 'IFC',
      recipients: memoryRecipientState(),
    });
    const account = await caller(bare, ADMIN).business.create({ name: 'Northwind', assetId: 'USDT', spendThreshold: '100' });
    const admin = caller(bare, ADMIN);
    await expect(admin.business.members({ accountId: account.id })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('bank.business_directory_unset'),
    });
    await expect(admin.business.approvals({ accountId: account.id, limit: 20 })).rejects.toMatchObject({
      message: expect.stringContaining('bank.business_directory_unset'),
    });
    await expect(
      admin.business.resolveRecipientSpace({ accountId: account.id, assetId: 'USDT', handle: 'Pat_Payee' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('IDENTITY_URL is unset'),
    });
  });

  it('pages approval history by handle and keeps pending as the waiting queue', async () => {
    const account = await openTeam();
    const from = await bank.spaces.ensurePrimary(MAKER, 'USDT');
    const to = await bank.spaces.ensurePrimary(PAYEE, 'USDT');
    await ledger.post(recipes.deposit({ userId: MAKER, assetId: 'USDT', amount: parseAmount('500'), rail: 'test', railRef: randomUUID() }));
    const maker = caller(bank, MAKER);
    const posted = await maker.business.proposeTransfer({
      accountId: account.id,
      fromSpaceId: from.id,
      toSpaceId: to.id,
      amount: '10',
      clientId: randomUUID(),
    });
    expect(posted.kind).toBe('posted');
    const pending = await maker.business.proposeTransfer({
      accountId: account.id,
      fromSpaceId: from.id,
      toSpaceId: to.id,
      amount: '100',
      clientId: randomUUID(),
    });
    expect(pending.kind).toBe('pending');
    const waiting = await maker.business.pending({ accountId: account.id, limit: 20 });
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ makerUserId: MAKER, status: 'pending' });

    const history = await caller(bank, CHECKER).business.approvals({ accountId: account.id, limit: 1 });
    expect(history.items).toHaveLength(1);
    expect(history.nextCursor).toEqual(expect.any(String));
    expect(history.items[0]).not.toHaveProperty('makerUserId');
    expect(history.items[0]).not.toHaveProperty('checkerUserId');
    const rest = await caller(bank, CHECKER).business.approvals({ accountId: account.id, limit: 10, cursor: history.nextCursor! });
    const handles = [...history.items, ...rest.items].map((row) => [row.status, row.makerHandle, row.checkerHandle]);
    expect(handles).toHaveLength(2);
    expect(handles).toEqual(
      expect.arrayContaining([
        ['pending', 'Max_Maker', null],
        ['approved', 'Max_Maker', null],
      ]),
    );
    const decided = await caller(bank, CHECKER).business.approvals({ accountId: account.id, status: 'approved', limit: 10 });
    expect(decided.items.map((row) => row.status)).toEqual(['approved']);
    await expect(caller(bank, CHECKER).business.approvals({ accountId: account.id })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      cause: { code: 'bank.business_approvals_list_limit_unset' },
    });
  });

  it('changes the threshold and closes only when a second administrator confirms', async () => {
    const account = await openTeam();
    const requestId = randomUUID();
    const first = await caller(bank, ADMIN).business.setThreshold({ accountId: account.id, spendThreshold: '40', requestId });
    expect(first.status).toBe('pending');
    expect(first.account.spendThreshold).toBe('100');
    expect(await caller(bank, ADMIN).business.setThreshold({ accountId: account.id, spendThreshold: '40', requestId })).toMatchObject({
      status: 'pending',
    });
    await expect(
      caller(bank, ADMIN).business.setThreshold({ accountId: account.id, spendThreshold: '41', requestId }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(
      caller(bank, SECOND).business.setThreshold({ accountId: account.id, spendThreshold: '80', requestId: randomUUID() }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('bank.business_change_pending'),
    });
    const applied = await caller(bank, SECOND).business.setThreshold({ accountId: account.id, spendThreshold: '40.00', requestId });
    expect(applied).toMatchObject({ status: 'applied', account: { spendThreshold: '40' } });
    const team = await caller(bank, ADMIN).business.members({ accountId: account.id });
    expect(team.pendingControls).toEqual([]);

    const closeId = randomUUID();
    expect(await caller(bank, ADMIN).business.close({ accountId: account.id, requestId: closeId })).toMatchObject({
      status: 'pending',
      account: { status: 'active' },
    });
    const closed = await caller(bank, SECOND).business.close({ accountId: account.id, requestId: closeId });
    expect(closed).toMatchObject({ status: 'applied', account: { status: 'closed' } });
    const visible = await caller(bank, ADMIN).business.list({ limit: 20 });
    expect(visible.map((row) => row.status)).toEqual(['closed']);
    await expect(caller(bank, ADMIN).business.close({ accountId: account.id, requestId: randomUUID() })).rejects.toMatchObject({
      code: 'CONFLICT',
      cause: { code: 'bank.business_closed' },
    });
  });

  it('will not close while a payment is still waiting', async () => {
    const account = await openTeam();
    const from = await bank.spaces.ensurePrimary(MAKER, 'USDT');
    const to = await bank.spaces.ensurePrimary(PAYEE, 'USDT');
    await ledger.post(recipes.deposit({ userId: MAKER, assetId: 'USDT', amount: parseAmount('500'), rail: 'test', railRef: randomUUID() }));
    await caller(bank, MAKER).business.proposeTransfer({
      accountId: account.id,
      fromSpaceId: from.id,
      toSpaceId: to.id,
      amount: '100',
      clientId: randomUUID(),
    });
    await expect(caller(bank, ADMIN).business.close({ accountId: account.id, requestId: randomUUID() })).rejects.toMatchObject({
      message: expect.stringContaining('bank.business_close_blocked'),
    });
    expect(formatAmount((await ledger.balance(userAvailable(MAKER, 'USDT'))).amount)).toBe('400');
  });

  it('refuses to remove a maker who still holds their own payment, and that maker can cancel after the membership row is gone', async () => {
    const account = await openTeam();
    const from = await bank.spaces.ensurePrimary(MAKER, 'USDT');
    const to = await bank.spaces.ensurePrimary(PAYEE, 'USDT');
    await ledger.post(recipes.deposit({ userId: MAKER, assetId: 'USDT', amount: parseAmount('500'), rail: 'test', railRef: randomUUID() }));
    const pending = await caller(bank, MAKER).business.proposeTransfer({
      accountId: account.id,
      fromSpaceId: from.id,
      toSpaceId: to.id,
      amount: '100',
      clientId: randomUUID(),
    });
    expect(pending.kind).toBe('pending');
    if (pending.kind !== 'pending') throw new Error('proposal must wait');
    await expect(
      caller(bank, ADMIN).business.removeMember({ accountId: account.id, userId: MAKER, requestId: randomUUID() }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'bank.business_member_has_pending' },
    });
    const listed = await caller(bank, ADMIN).business.members({ accountId: account.id });
    expect(listed.members.map((row) => row.userId)).toContain(MAKER);
    await sql`
      DELETE FROM bank.business_members
       WHERE account_id = ${account.id}::uuid AND user_id = ${MAKER}
    `;
    await caller(bank, MAKER).business.cancel({ approvalId: pending.approval.id });
    expect(formatAmount((await ledger.balance(userAvailable(MAKER, 'USDT'))).amount)).toBe('500');
  });

  it('lets an administrator withdraw a pending threshold so another proposal can start', async () => {
    const account = await openTeam();
    const requestId = randomUUID();
    const first = await caller(bank, ADMIN).business.setThreshold({ accountId: account.id, spendThreshold: '40', requestId });
    expect(first).toMatchObject({ status: 'pending', account: { spendThreshold: '100' } });
    await expect(
      caller(bank, SECOND).business.setThreshold({ accountId: account.id, spendThreshold: '80', requestId: randomUUID() }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      cause: { code: 'bank.business_change_pending' },
    });
    const cancelled = await caller(bank, ADMIN).business.cancelControl({ accountId: account.id, requestId });
    expect(cancelled).toMatchObject({ status: 'cancelled', requestId, account: { spendThreshold: '100' } });
    expect(await caller(bank, ADMIN).business.cancelControl({ accountId: account.id, requestId })).toMatchObject({
      status: 'cancelled',
      requestId,
    });
    await expect(
      caller(bank, SECOND).business.setThreshold({ accountId: account.id, spendThreshold: '40', requestId }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      cause: { code: 'bank.business_approval_inactive' },
    });
    const still = await caller(bank, ADMIN).business.list({ limit: 20 });
    expect(still.find((row) => row.id === account.id)?.spendThreshold).toBe('100');
    const nextId = randomUUID();
    const next = await caller(bank, SECOND).business.setThreshold({
      accountId: account.id,
      spendThreshold: '80',
      requestId: nextId,
    });
    expect(next).toMatchObject({ status: 'pending', requestId: nextId, account: { spendThreshold: '100' } });
    const team = await caller(bank, ADMIN).business.members({ accountId: account.id });
    expect(team.pendingControls.map((row) => row.requestId)).toEqual([nextId]);
  });
});
