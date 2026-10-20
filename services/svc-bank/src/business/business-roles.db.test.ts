import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount, recipes, type Amount } from '@intafaced/ledger-client';
import { createBankServices, memoryRecipientState, type BankServices } from '../bank-service.js';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import {
  BUSINESS_CAPABILITIES,
  BUSINESS_ROLES,
  BUSINESS_ROLE_CAPABILITIES,
  dutyClash,
  roleCan,
  type BusinessMemberRole,
} from './business-policy.js';

/**
 * W-security-accounts-04: custody roles and separation of duties.
 * What each role may do is the table in business-policy.ts; the server asks for a capability, never a role name.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '../..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const ADMIN = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const amt = (v: string): Amount => parseAmount(v);

describe('role table', () => {
  it('has a capability row for every role, and the enum in the schema matches', () => {
    expect(Object.keys(BUSINESS_ROLE_CAPABILITIES).sort()).toEqual([...BUSINESS_ROLES].sort());
    for (const role of BUSINESS_ROLES) {
      expect(BUSINESS_ROLE_CAPABILITIES[role].every((c) => (BUSINESS_CAPABILITIES as readonly string[]).includes(c))).toBe(true);
    }
  });

  it.each([
    ['admin', ['view', 'propose', 'approve', 'sign', 'manage_team']],
    ['non_signing_admin', ['view', 'propose', 'approve', 'manage_team']],
    ['maker', ['view', 'propose']],
    ['editor', ['view', 'propose']],
    ['checker', ['view', 'approve']],
    ['signer', ['view', 'sign']],
    ['viewer', ['view']],
    ['security_auditor', ['view']],
  ] as const)('%s may %j and nothing else', (role, allowed) => {
    for (const capability of BUSINESS_CAPABILITIES) {
      expect(roleCan(role, capability)).toBe((allowed as readonly string[]).includes(capability));
    }
  });

  it('only admin may sign among the administrators', () => {
    expect(roleCan('admin', 'sign')).toBe(true);
    expect(roleCan('non_signing_admin', 'sign')).toBe(false);
  });
});

describe('separation of duties', () => {
  it('refuses one person holding two duties on the same request', () => {
    expect(dutyClash({ initiator: 'a', approver: 'a' })).toBe('initiator_approver');
    expect(dutyClash({ initiator: 'a', signer: 'a' })).toBe('initiator_signer');
    expect(dutyClash({ approver: 'b', signer: 'b' })).toBe('approver_signer');
    expect(dutyClash({ initiator: 'a', approver: 'b', signer: 'c' })).toBeNull();
  });

  it('does not compare a duty nobody holds yet', () => {
    expect(dutyClash({ initiator: 'a' })).toBeNull();
    expect(dutyClash({ initiator: 'a', approver: null, signer: null })).toBeNull();
    expect(dutyClash({})).toBeNull();
  });
});

describe('roles on a business account', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let bank: BankServices;

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL?.trim();
    if (!url) throw new Error('TEST_DATABASE_URL is unset');
    adminStop = async () => undefined;
    db = await createTestDatabase({ service: 'bank', url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await sql`
      TRUNCATE bank.business_payroll_lines, bank.business_payroll_runs,
               bank.business_approvals, bank.business_members, bank.business_accounts,
               bank.business_member_commands, bank.transfer_executions, bank.scheduled_transfers, bank.spaces
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
    bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), { nativeAssetId: 'IFC', recipients: memoryRecipientState() });
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  async function openAccount(threshold = '100') {
    const account = await bank.business.createAccount({
      accountId: randomUUID(),
      name: 'Roles Co',
      assetId: 'USDT',
      spendThreshold: amt(threshold),
      creatorUserId: ADMIN,
    });
    const primary = await bank.spaces.ensurePrimary(ADMIN, 'USDT');
    const pot = await bank.spaces.create({ userId: ADMIN, assetId: 'USDT', name: 'Vendor' });
    await ledger.post(recipes.deposit({ userId: ADMIN, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: randomUUID() }));
    return { account, primary, pot };
  }

  /** A proposer must own the space the money leaves, so a teammate who starts a payment brings a funded one. */
  async function ownSpace(userId: string) {
    const space = await bank.spaces.ensurePrimary(userId, 'USDT');
    await ledger.post(recipes.deposit({ userId, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: randomUUID() }));
    return space;
  }

  const member = (userId: string, role: BusinessMemberRole) => ({ userId, role });
  async function seat(accountId: string, who: Array<{ userId: string; role: BusinessMemberRole }>) {
    for (const m of who) await bank.business.addMember({ accountId, actorUserId: ADMIN, userId: m.userId, role: m.role });
  }
  const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  it('a viewer, a signer and a security auditor cannot start a payment; an editor can', async () => {
    const { account, primary, pot } = await openAccount();
    await seat(account.id, [
      member(uid(1), 'viewer'),
      member(uid(2), 'signer'),
      member(uid(3), 'security_auditor'),
      member(uid(4), 'editor'),
    ]);
    const propose = (makerUserId: string, fromSpaceId = primary.id) =>
      bank.business.proposeTransfer({
        clientId: randomUUID(),
        accountId: account.id,
        makerUserId,
        fromSpaceId,
        toSpaceId: pot.id,
        amount: amt('250'),
      });
    for (const n of [1, 2, 3]) {
      await expect(propose(uid(n))).rejects.toMatchObject({ code: 'bank.business_role_forbidden' });
    }
    expect((await propose(uid(4), (await ownSpace(uid(4))).id)).kind).toBe('pending');
  });

  it('a viewer, a signer, an editor and a security auditor cannot decide a waiting payment', async () => {
    const { account, primary, pot } = await openAccount();
    await seat(account.id, [
      member(uid(1), 'viewer'),
      member(uid(2), 'signer'),
      member(uid(3), 'security_auditor'),
      member(uid(4), 'editor'),
      member(PEER, 'checker'),
    ]);
    const proposed = await bank.business.proposeTransfer({
      clientId: randomUUID(),
      accountId: account.id,
      makerUserId: ADMIN,
      fromSpaceId: primary.id,
      toSpaceId: pot.id,
      amount: amt('250'),
    });
    if (proposed.kind !== 'pending') throw new Error('expected pending');
    for (const n of [1, 2, 3, 4]) {
      await expect(bank.business.approve({ approvalId: proposed.approval.id, checkerUserId: uid(n) })).rejects.toMatchObject({
        code: 'bank.business_role_forbidden',
      });
      await expect(bank.business.reject({ approvalId: proposed.approval.id, checkerUserId: uid(n) })).rejects.toMatchObject({
        code: 'bank.business_role_forbidden',
      });
    }
    // The payment is still waiting and a real approver settles it.
    const posted = await bank.business.approve({ approvalId: proposed.approval.id, checkerUserId: PEER });
    expect(posted.ledgerTxId).toBeTruthy();
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('an initiator cannot decide their own payment, even a non-signing administrator', async () => {
    const { account, primary, pot } = await openAccount();
    await seat(account.id, [member(PEER, 'non_signing_admin')]);
    const peerSpace = await ownSpace(PEER);
    const proposed = await bank.business.proposeTransfer({
      clientId: randomUUID(),
      accountId: account.id,
      makerUserId: PEER,
      fromSpaceId: peerSpace.id,
      toSpaceId: pot.id,
      amount: amt('250'),
    });
    if (proposed.kind !== 'pending') throw new Error('expected pending');
    await expect(bank.business.approve({ approvalId: proposed.approval.id, checkerUserId: PEER })).rejects.toMatchObject({
      code: 'bank.business_self_approve',
    });
    await expect(bank.business.reject({ approvalId: proposed.approval.id, checkerUserId: PEER })).rejects.toMatchObject({
      code: 'bank.business_self_approve',
    });
    // A different administrator decides it.
    expect((await bank.business.approve({ approvalId: proposed.approval.id, checkerUserId: ADMIN })).ledgerTxId).toBeTruthy();
  });

  it('a removed approver can no longer decide anything', async () => {
    const { account, primary, pot } = await openAccount();
    await seat(account.id, [member(PEER, 'checker')]);
    const proposed = await bank.business.proposeTransfer({
      clientId: randomUUID(),
      accountId: account.id,
      makerUserId: ADMIN,
      fromSpaceId: primary.id,
      toSpaceId: pot.id,
      amount: amt('250'),
    });
    if (proposed.kind !== 'pending') throw new Error('expected pending');
    await bank.business.removeMember({ accountId: account.id, actorUserId: ADMIN, userId: PEER, requestId: randomUUID() });
    await expect(bank.business.approve({ approvalId: proposed.approval.id, checkerUserId: PEER })).rejects.toMatchObject({
      code: 'bank.business_not_member',
    });
  });

  it('a removed initiator cannot leave a payment waiting: removal is refused until it is decided', async () => {
    const { account, primary, pot } = await openAccount();
    await seat(account.id, [member(PEER, 'editor')]);
    const peerSpace = await ownSpace(PEER);
    const proposed = await bank.business.proposeTransfer({
      clientId: randomUUID(),
      accountId: account.id,
      makerUserId: PEER,
      fromSpaceId: peerSpace.id,
      toSpaceId: pot.id,
      amount: amt('250'),
    });
    if (proposed.kind !== 'pending') throw new Error('expected pending');
    await expect(
      bank.business.removeMember({ accountId: account.id, actorUserId: ADMIN, userId: PEER, requestId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'bank.business_member_has_pending' });
  });

  it('only an administrator role manages the team; a non-signing administrator does', async () => {
    const { account } = await openAccount();
    await seat(account.id, [member(PEER, 'non_signing_admin'), member(uid(1), 'editor')]);
    await expect(
      bank.business.addMember({ accountId: account.id, actorUserId: uid(1), userId: uid(2), role: 'viewer' }),
    ).rejects.toMatchObject({ code: 'bank.business_role_forbidden' });
    await expect(
      bank.business.addMember({ accountId: account.id, actorUserId: PEER, userId: uid(2), role: 'viewer' }),
    ).resolves.toMatchObject({
      role: 'viewer',
    });
    expect(await bank.business.myRole(account.id, uid(2))).toBe('viewer');
  });

  it('keeps one administrator: neither re-adding nor re-roling demotes the last one', async () => {
    const { account } = await openAccount();
    await expect(
      bank.business.addMember({ accountId: account.id, actorUserId: ADMIN, userId: ADMIN, role: 'viewer' }),
    ).rejects.toMatchObject({ code: 'bank.business_last_admin' });
    await expect(
      bank.business.setMemberRole({ accountId: account.id, actorUserId: ADMIN, userId: ADMIN, role: 'maker', requestId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'bank.business_last_admin' });
    // A non-signing administrator counts as an administrator, so the first can step down once there are two.
    await seat(account.id, [member(PEER, 'non_signing_admin')]);
    await bank.business.setMemberRole({ accountId: account.id, actorUserId: ADMIN, userId: ADMIN, role: 'maker', requestId: randomUUID() });
    await expect(
      bank.business.setMemberRole({ accountId: account.id, actorUserId: PEER, userId: PEER, role: 'viewer', requestId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'bank.business_last_admin' });
  });

  it('a security auditor and a viewer read the team but change nothing', async () => {
    const { account } = await openAccount();
    await seat(account.id, [member(uid(1), 'security_auditor'), member(uid(2), 'viewer')]);
    for (const n of [1, 2]) {
      expect((await bank.business.listMembers(account.id, uid(n))).length).toBe(3);
      await expect(
        bank.business.removeMember({ accountId: account.id, actorUserId: uid(n), userId: ADMIN, requestId: randomUUID() }),
      ).rejects.toMatchObject({ code: 'bank.business_role_forbidden' });
    }
  });
});
