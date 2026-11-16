/**
 * J-bank-19 through the real router (BK-biz-01 to BK-biz-04): a business bank team and its approval rules, with the
 * business's money at the TEST partner bank. Roles grant only what their maker holds; an advisor waits for the owner;
 * invites expire, are sent again and are revoked; a TEST 6000.00 payment under rules over 1000.00 (one approver) and over
 * 5000.00 (two) needs two distinct approvers, the maker is refused, and the second approval sends one instruction to the
 * partner, once, even when the partner's answer is lost; the ledger posts nothing; team spend equals the partner's lines.
 * Uses TEST_DATABASE_URL. Does not start Docker.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import { createBankServices, memoryRecipientState } from '../bank-service.js';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankRouter } from '../router.js';
import { testPartner, type TestPartner } from '../partner/test-partner.js';
import { memoryBusinessDirectory, type DirectoryPerson } from './business-directory.js';
import { businessPaymentKey, pickRule, fittedRole } from './business-team.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 'c'.repeat(32);
const SID = '99999999-9999-4999-8999-999999999999';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OWNER = id(1);
const BOOK = id(2);
const OFFICE = id(3);
const A1 = id(4);
const A2 = id(5);
const ADVISOR = id(6);
const NEWCOMER = id(7);
const PEOPLE: DirectoryPerson[] = [
  [OWNER, 'owner'],
  [BOOK, 'book'],
  [OFFICE, 'office'],
  [A1, 'approver1'],
  [A2, 'approver2'],
  [ADVISOR, 'advisor'],
  [NEWCOMER, 'newcomer'],
].map(([userId, handle]) => ({ userId: userId!, handle: handle!, email: `${handle}@example.test`, status: 'active' as const }));

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
async function refused(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    return codeOf(err);
  }
  throw new Error('expected a refusal');
}

describe('business bank team and approval rules (J-bank-19)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let partner: TestPartner;
  let inviteMinutes: string | undefined;

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
    await sql`
      TRUNCATE bank.business_payment_approvals, bank.business_payments, bank.business_payment_rules, bank.business_invites,
               bank.business_advisors, bank.business_members, bank.business_custom_roles, bank.business_departments,
               bank.business_accounts, bank.spaces
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
    partner = testPartner();
    inviteMinutes = '2';
  });

  function as(userId: string) {
    const raw = encodePrincipal(principal(userId));
    const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });
    return createBankRouter(services()).createCaller(
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

  function services() {
    return createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      nativeAssetId: 'IFC',
      recipients: memoryRecipientState(),
      testPartner: partner,
      postingFreeze: { postingEnabled: async () => true },
      directory: memoryBusinessDirectory(PEOPLE),
      get businessInviteMinutes() {
        return inviteMinutes;
      },
    });
  }

  /** The owner's business with its money at the TEST partner: TEST 10000 USDT in the business's own partner account. */
  async function business() {
    const owner = as(OWNER);
    await owner.testPartner.set({ custody: 'off' });
    const accountId = randomUUID();
    await owner.business.create({ accountId, name: 'TEST Team Ltd', assetId: 'USDT', spendThreshold: '1' });
    await owner.testPartner.fundBusiness({ accountId, fundId: `fund-${accountId}`, amount: '10000' });
    return { accountId, owner };
  }

  async function join(accountId: string, owner: ReturnType<typeof as>, userId: string, invite: { role?: string; roleId?: string }) {
    const made = await owner.businessTeam.invite({
      accountId,
      inviteId: randomUUID(),
      email: null,
      role: (invite.role ?? null) as never,
      roleId: invite.roleId ?? null,
    });
    await as(userId).businessTeam.acceptInvite({ token: made.token! });
  }

  it('#1 a Bookkeeper with view and export is refused approvals; a role beyond its maker is refused', async () => {
    const { accountId, owner } = await business();
    const book = await owner.businessTeam.createRole({
      accountId,
      roleId: randomUUID(),
      name: 'Bookkeeper',
      permissions: ['view', 'export'],
    });
    expect(book.permissions).toEqual(['view', 'export']);
    const office = await owner.businessTeam.createRole({
      accountId,
      roleId: randomUUID(),
      name: 'Office',
      permissions: ['view', 'manage_team'],
    });
    await join(accountId, owner, BOOK, { roleId: book.id });
    await join(accountId, owner, OFFICE, { roleId: office.id });
    await join(accountId, owner, A1, { role: 'checker' });
    await join(accountId, owner, A2, { role: 'checker' });
    // The office manager holds manage_team but not approve: a role granting approve is refused, and nothing is created.
    expect(
      await refused(
        as(OFFICE).businessTeam.createRole({ accountId, roleId: randomUUID(), name: 'Approver', permissions: ['view', 'approve'] }),
      ),
    ).toBe('bank.business_role_grant_exceeds');
    expect((await owner.businessTeam.roles({ accountId })).map((r) => r.name)).toEqual(['Bookkeeper', 'Office']);
    // The bookkeeper sees the waiting payment and cannot approve it.
    const paymentId = randomUUID();
    await owner.businessTeam.addRule({ accountId, ruleId: randomUUID(), overAmount: '1000', payee: null, paymentType: null, approvals: 1 });
    await owner.businessTeam.propose({ accountId, paymentId, payee: 'TEST Supplier', paymentType: 'domestic', amount: '1500' });
    expect((await as(BOOK).businessTeam.payment({ paymentId })).status).toBe('pending');
    expect(await refused(as(BOOK).businessTeam.approve({ paymentId }))).toBe('bank.business_role_forbidden');
    expect(
      await refused(
        as(BOOK).businessTeam.propose({ accountId, paymentId: randomUUID(), payee: 'x', paymentType: 'domestic', amount: '1' }),
      ),
    ).toBe('bank.business_role_forbidden');
  });

  it('a named role narrows the older business doors too: a checker made Bookkeeper cannot approve or propose there', async () => {
    const { accountId, owner } = await business();
    const book = await owner.businessTeam.createRole({
      accountId,
      roleId: randomUUID(),
      name: 'Bookkeeper',
      permissions: ['view', 'export'],
    });
    await join(accountId, owner, A1, { role: 'checker' });
    await join(accountId, owner, A2, { role: 'admin' });
    const bank = services();
    expect(await bank.business.approverEligibility(accountId, A1)).toMatchObject({ state: 'eligible' });
    await owner.businessTeam.assignRole({ accountId, userId: A1, roleId: book.id });
    await owner.businessTeam.assignRole({ accountId, userId: A2, roleId: book.id });
    // svc-pay's withdrawal approver check and the transfer doors read the same row: both are viewers there now.
    expect(await bank.business.approverEligibility(accountId, A1)).toMatchObject({ state: 'role_cannot_approve', role: 'viewer' });
    expect(await as(A1).business.myRole({ accountId })).toEqual({ role: 'viewer' });
    expect(await as(A2).business.myRole({ accountId })).toEqual({ role: 'viewer' });
    expect(
      await refused(
        as(A2).business.proposeTransfer({
          accountId,
          fromSpaceId: randomUUID(),
          toSpaceId: randomUUID(),
          amount: '1',
          clientId: randomUUID(),
        }),
      ),
    ).toBe('bank.business_role_forbidden');
    expect(await refused(as(A2).business.addMember({ accountId, userId: BOOK, role: 'admin' }))).toBe('bank.business_role_forbidden');
    // A role the inviter names seats the newcomer on the role it fits, never wider.
    const pay = await owner.businessTeam.createRole({ accountId, roleId: randomUUID(), name: 'Payer', permissions: ['view', 'propose'] });
    await join(accountId, owner, BOOK, { roleId: pay.id });
    expect(await as(BOOK).business.myRole({ accountId })).toEqual({ role: 'maker' });
    expect(await bank.business.approverEligibility(accountId, BOOK)).toMatchObject({ state: 'role_cannot_approve' });
    // A role without view is refused: every member reads the business.
    expect(await refused(owner.businessTeam.createRole({ accountId, roleId: randomUUID(), name: 'Export', permissions: ['export'] }))).toBe(
      'bank.business_role_invalid',
    );
    // Setting a built-in role through the member door is the member's whole role again.
    await owner.business.setMemberRole({ accountId, userId: A1, role: 'checker', requestId: randomUUID() });
    expect((await owner.businessTeam.members({ accountId })).find((m) => m.userId === A1)).toMatchObject({
      role: 'checker',
      customRole: null,
      permissions: ['view', 'approve'],
    });
  });

  it('the roles a named role fits', () => {
    expect(fittedRole(['view', 'export'])).toBe('viewer');
    expect(fittedRole(['view', 'approve'])).toBe('checker');
    expect(fittedRole(['view', 'propose', 'export'])).toBe('maker');
    expect(fittedRole(['view', 'propose', 'approve', 'manage_team'])).toBe('non_signing_admin');
    expect(fittedRole(['view', 'export', 'propose', 'approve', 'manage_team', 'team_spend'])).toBe('non_signing_admin');
  });

  it('#2 an advisor added by anyone but the owner waits, and only the owner approves; then they only read', async () => {
    const { accountId, owner } = await business();
    const office = await owner.businessTeam.createRole({
      accountId,
      roleId: randomUUID(),
      name: 'Office',
      permissions: ['view', 'manage_team'],
    });
    await join(accountId, owner, OFFICE, { roleId: office.id });
    const added = await as(OFFICE).businessTeam.addAdvisor({ accountId, handle: '@advisor' });
    expect(added).toMatchObject({ status: 'pending', addedByHandle: 'office' });
    expect(await refused(as(ADVISOR).businessTeam.overview({ accountId }))).toBe('bank.business_not_member');
    expect(await refused(as(OFFICE).businessTeam.approveAdvisor({ accountId, userId: ADVISOR }))).toBe('bank.business_owner_only');
    expect(await owner.businessTeam.approveAdvisor({ accountId, userId: ADVISOR })).toMatchObject({ status: 'approved' });
    const seen = await as(ADVISOR).businessTeam.overview({ accountId });
    expect(seen.me).toMatchObject({ advisor: true, permissions: ['view'] });
    expect(
      await refused(
        as(ADVISOR).businessTeam.addRule({
          accountId,
          ruleId: randomUUID(),
          overAmount: '1',
          payee: null,
          paymentType: null,
          approvals: 1,
        }),
      ),
    ).toBe('bank.business_role_forbidden');
  });

  it('#3 an email invite is for that email; an expired invite refuses and can be sent again; a revoked one refuses', async () => {
    const { accountId, owner } = await business();
    const toNew = await owner.businessTeam.invite({
      accountId,
      inviteId: randomUUID(),
      email: 'Newcomer@example.test',
      role: 'viewer',
      roleId: null,
    });
    expect(toNew.invite).toMatchObject({ kind: 'email', email: 'newcomer@example.test', status: 'open' });
    expect(await refused(as(A1).businessTeam.acceptInvite({ token: toNew.token! }))).toBe('bank.business_invite_wrong_person');
    expect((await as(NEWCOMER).businessTeam.acceptInvite({ token: toNew.token! })).member.role).toBe('viewer');

    const link = await owner.businessTeam.invite({ accountId, inviteId: randomUUID(), email: null, role: 'checker', roleId: null });
    await sql`UPDATE bank.business_invites SET expires_at = now() - interval '1 second' WHERE id = ${link.invite.id}::uuid`;
    expect(await refused(as(A1).businessTeam.acceptInvite({ token: link.token! }))).toBe('bank.business_invite_expired');
    expect((await owner.businessTeam.invites({ accountId })).find((i) => i.id === link.invite.id)?.status).toBe('expired');
    const again = await owner.businessTeam.resendInvite({ accountId, inviteId: link.invite.id, newInviteId: randomUUID() });
    expect(await refused(as(A1).businessTeam.acceptInvite({ token: link.token! }))).toBe('bank.business_invite_replaced');
    expect((await as(A1).businessTeam.acceptInvite({ token: again.token! })).member.role).toBe('checker');

    const revoked = await owner.businessTeam.invite({ accountId, inviteId: randomUUID(), email: null, role: 'viewer', roleId: null });
    await owner.businessTeam.revokeInvite({ accountId, inviteId: revoked.invite.id });
    expect(await refused(as(A2).businessTeam.acceptInvite({ token: revoked.token! }))).toBe('bank.business_invite_revoked');

    inviteMinutes = undefined;
    expect(await refused(owner.businessTeam.invite({ accountId, inviteId: randomUUID(), email: null, role: 'viewer', roleId: null }))).toBe(
      'bank.business_invite_lifetime_unset',
    );
  });

  it('#4 a member of two businesses reads each by its own id, and a business they are not on refuses', async () => {
    const { accountId, owner } = await business();
    await join(accountId, owner, A1, { role: 'checker' });
    const second = randomUUID();
    await as(A1).business.create({ accountId: second, name: 'TEST Second Ltd', assetId: 'USDT', spendThreshold: '1' });
    expect((await as(A1).businessTeam.overview({ accountId })).account.name).toBe('TEST Team Ltd');
    expect((await as(A1).businessTeam.overview({ accountId: second })).account.name).toBe('TEST Second Ltd');
    expect((await as(A1).businessTeam.members({ accountId: second })).map((m) => m.handle)).toEqual(['approver1']);
    expect(await refused(owner.businessTeam.overview({ accountId: second }))).toBe('bank.business_not_member');
  });

  it('#5 #6 6000.00 under the TEST rules needs two distinct approvers; the second sends one partner instruction, once', async () => {
    const { accountId, owner } = await business();
    await join(accountId, owner, A1, { role: 'checker' });
    await join(accountId, owner, A2, { role: 'checker' });
    await owner.businessTeam.addRule({ accountId, ruleId: randomUUID(), overAmount: '1000', payee: null, paymentType: null, approvals: 1 });
    const two = await owner.businessTeam.addRule({
      accountId,
      ruleId: randomUUID(),
      overAmount: '5000',
      payee: null,
      paymentType: null,
      approvals: 2,
    });
    const paymentId = randomUUID();
    const proposed = await owner.businessTeam.propose({
      accountId,
      paymentId,
      payee: 'TEST Supplier',
      paymentType: 'domestic',
      amount: '6000.00',
    });
    expect(proposed).toMatchObject({
      status: 'pending',
      approvalsNeeded: 2,
      rule: { id: two.id, overAmount: '5000' },
      partnerMoveId: null,
    });
    // The owner holds approve and is in the pool, but proposed it.
    expect(await refused(owner.businessTeam.approve({ paymentId }))).toBe('bank.business_self_approve');
    expect((await as(A1).businessTeam.approve({ paymentId })).status).toBe('pending');
    expect(await refused(as(A1).businessTeam.approve({ paymentId }))).toBe('bank.business_already_approved');
    expect(await partner.bank.moveByKey(businessPaymentKey(paymentId))).toBeNull();
    // The partner loses its answer to the second approval: the move is made, and its outcome is not known.
    partner.set(`business:${accountId}`, { nextReply: 'lost' });
    expect(await refused(as(A2).businessTeam.approve({ paymentId }))).toBe('bank.partner_reply_lost');
    expect((await owner.businessTeam.payment({ paymentId })).status).toBe('sending');
    const sent = await as(A2).businessTeam.approve({ paymentId });
    expect(sent).toMatchObject({ status: 'sent', approvals: [{ handle: 'approver1' }, { handle: 'approver2' }] });
    const moves = await partner.bank.moves(`business:${accountId}`, { limit: 50 });
    expect(moves.filter((m) => m.key === businessPaymentKey(paymentId))).toHaveLength(1);
    expect(sent.partnerMoveId).toBe(moves[0]!.id);
    expect((await partner.bank.balance({ userId: `business:${accountId}`, assetId: 'USDT', spaceId: null })).amount).toBe(
      parseAmount('4000'),
    );
    // Again by anyone: nothing more moves.
    expect(await refused(as(A1).businessTeam.approve({ paymentId }))).toBe('bank.business_approval_inactive');
    await owner.businessTeam.resend({ paymentId });
    expect(await partner.bank.moves(`business:${accountId}`, { limit: 50 })).toHaveLength(1);
    // The ledger posted nothing.
    expect(ledger.journal()).toEqual([]);
  });

  it('the rule that applies is the one asking the most approvals, by payee and payment type', () => {
    const rules = [
      { over_amount: '1000', payee: null, payment_type: null, approvals: 1 },
      { over_amount: '5000', payee: null, payment_type: null, approvals: 2 },
      { over_amount: '100', payee: 'TEST Lawyer', payment_type: 'international' as const, approvals: 3 },
    ];
    expect(pickRule(rules, { amount: parseAmount('6000'), payee: 'x', paymentType: 'domestic' })?.approvals).toBe(2);
    expect(pickRule(rules, { amount: parseAmount('1000'), payee: 'x', paymentType: 'domestic' })).toBeNull();
    expect(pickRule(rules, { amount: parseAmount('200'), payee: 'test lawyer', paymentType: 'international' })?.approvals).toBe(3);
    expect(pickRule(rules, { amount: parseAmount('200'), payee: 'test lawyer', paymentType: 'domestic' })).toBeNull();
  });

  it('a rule asking more approvers than the business has besides the maker refuses before anything is proposed', async () => {
    const { accountId, owner } = await business();
    await join(accountId, owner, A1, { role: 'checker' });
    await owner.businessTeam.addRule({ accountId, ruleId: randomUUID(), overAmount: '5000', payee: null, paymentType: null, approvals: 2 });
    expect(
      await refused(
        owner.businessTeam.propose({ accountId, paymentId: randomUUID(), payee: 'TEST Supplier', paymentType: 'domestic', amount: '6000' }),
      ),
    ).toBe('bank.business_approvers_short');
    expect(await owner.businessTeam.payments({ accountId })).toEqual([]);
  });

  it('a payment sent at once whose partner answer is lost, pressed again with the same id, moves once', async () => {
    const { accountId, owner } = await business();
    const paymentId = randomUUID();
    const input = { accountId, paymentId, payee: 'TEST Supplier', paymentType: 'domestic' as const, amount: '700' };
    partner.set(`business:${accountId}`, { nextReply: 'lost' });
    expect(await refused(owner.businessTeam.propose(input))).toBe('bank.partner_reply_lost');
    // The form sends the same id again (held-id.ts): the bank reads the move back by its key.
    const again = await owner.businessTeam.propose(input);
    expect(again).toMatchObject({ status: 'sent', approvalsNeeded: 0 });
    const moves = await partner.bank.moves(`business:${accountId}`, { limit: 50 });
    expect(moves.filter((m) => m.key === businessPaymentKey(paymentId))).toHaveLength(1);
    expect(await owner.businessTeam.propose(input)).toMatchObject({ status: 'sent', partnerMoveId: again.partnerMoveId });
    expect(await partner.bank.moves(`business:${accountId}`, { limit: 50 })).toHaveLength(1);
    // The same id on other terms is refused, never a second payment.
    expect(await refused(owner.businessTeam.propose({ ...input, amount: '701' }))).toBe('bank.business_request_conflict');
    expect(ledger.journal()).toEqual([]);
  });

  it('a partner refusal that moved nothing closes the payment as refused', async () => {
    const { accountId, owner } = await business();
    const paymentId = randomUUID();
    expect(
      await refused(owner.businessTeam.propose({ accountId, paymentId, payee: 'TEST Supplier', paymentType: 'domestic', amount: '20000' })),
    ).toBe('bank.partner_insufficient_funds');
    expect(await owner.businessTeam.payment({ paymentId })).toMatchObject({
      status: 'refused',
      refusalCode: 'bank.partner_insufficient_funds',
      partnerMoveId: null,
    });
  });

  it('#7 team spend by member equals the partner lines; without the grant a member sees only themselves; a blank budget is not set', async () => {
    const { accountId, owner } = await business();
    await join(accountId, owner, A1, { role: 'checker' });
    const sales = await owner.businessTeam.addDepartment({ accountId, departmentId: randomUUID(), name: 'Sales', budget: null });
    expect(sales.budget).toBeNull();
    await owner.businessTeam.setDepartment({ accountId, userId: OWNER, departmentId: sales.id });
    await owner.businessTeam.propose({ accountId, paymentId: randomUUID(), payee: 'TEST Cafe', paymentType: 'domestic', amount: '12.50' });
    await owner.businessTeam.propose({ accountId, paymentId: randomUUID(), payee: 'TEST Cab', paymentType: 'domestic', amount: '7.50' });
    const team = await owner.businessTeam.spend({ accountId });
    expect(team.scope).toBe('team');
    const ownerLine = team.members.find((m) => m.handle === 'owner')!;
    expect(ownerLine).toMatchObject({ partnerTotal: '20', recordTotal: '20', partnerLines: 2 });
    expect(team.members.find((m) => m.handle === 'approver1')).toMatchObject({ partnerTotal: '0', partnerLines: 0 });
    expect(team.departments).toEqual([{ id: sales.id, name: 'Sales', budget: null, spent: '20', members: [OWNER] }]);
    const self = await as(A1).businessTeam.spend({ accountId });
    expect(self).toMatchObject({ scope: 'self', departments: [] });
    expect(self.members.map((m) => m.handle)).toEqual(['approver1']);
  });
});
