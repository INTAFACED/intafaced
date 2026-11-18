/**
 * J-bank-22 through the real router (BK-bcard-01, BK-bexp-01, BK-bexp-02): a business gives its team cards and handles
 * their expenses from its account at the TEST partner bank. A purchase over the card's limit declines `over_limit`,
 * moves nothing and opens one request to the admins; one within it is one partner move under its purchase key, sent once.
 * A capture over the business's receipt rule with no receipt needs one, with exactly one reminder queued; the receipts
 * download as one ZIP. A reimbursement is approved by someone other than the claimant and paid as one partner move to
 * the member's own account, sent once even when the partner's answer is lost; the member's balance rises by exactly the
 * claim. The ledger posts nothing. Uses TEST_DATABASE_URL. Does not start Docker.
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
import { testPartner, TEST_PARTNER_MERCHANT, type TestPartner } from '../partner/test-partner.js';
import { memoryBusinessDirectory, type DirectoryPerson } from './business-directory.js';
import { cardCaptureKey, crc32, reimbursementKey, testCardTail } from './business-cards.js';

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
const MEMBER = id(2);
const APPROVER = id(3);
const PEOPLE: DirectoryPerson[] = [
  [OWNER, 'owner'],
  [MEMBER, 'member'],
  [APPROVER, 'approver'],
].map(([userId, handle]) => ({ userId: userId!, handle: handle!, email: `${handle}@example.test`, status: 'active' as const }));

const RECEIPT = {
  fileName: 'receipt.txt',
  contentType: 'text/plain' as const,
  contentBase64: Buffer.from('TEST receipt 80.00').toString('base64'),
};

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

const codeOf = (err: unknown) => (err as { cause?: { code?: string }; code?: string }).cause?.code ?? (err as { code?: string }).code;
async function refused(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    return codeOf(err);
  }
  throw new Error('expected a refusal');
}

describe('business cards and expenses (J-bank-22)', () => {
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
    await sql`
      TRUNCATE bank.business_reimbursements, bank.business_receipt_reminders, bank.business_purchase_receipts,
               bank.business_receipts, bank.business_expense_policies, bank.business_card_limit_requests,
               bank.business_card_purchases, bank.business_cards,
               bank.business_payment_approvals, bank.business_payments, bank.business_payment_rules, bank.business_invites,
               bank.business_advisors, bank.business_members, bank.business_custom_roles, bank.business_departments,
               bank.business_accounts, bank.spaces
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
    partner = testPartner();
  });

  function as(userId: string, testNetwork = true) {
    const raw = encodePrincipal(principal(userId));
    const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });
    return createBankRouter(
      createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
        nativeAssetId: 'IFC',
        recipients: memoryRecipientState(),
        testPartner: testNetwork ? partner : null,
        postingFreeze: { postingEnabled: async () => true },
        directory: memoryBusinessDirectory(PEOPLE),
        businessInviteMinutes: '2',
      }),
    ).createCaller(
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

  async function join(owner: ReturnType<typeof as>, accountId: string, who: string, role: string) {
    const made = await owner.businessTeam.invite({ accountId, inviteId: randomUUID(), email: null, role: role as never, roleId: null });
    await as(who).businessTeam.acceptInvite({ token: made.token! });
  }

  /** The owner's business with TEST 1000 USDT at the partner, a member and an approver, and the member's money at the partner. */
  async function business() {
    const owner = as(OWNER);
    await owner.testPartner.set({ custody: 'off' });
    await as(MEMBER).testPartner.set({ custody: 'off' });
    const accountId = randomUUID();
    await owner.business.create({ accountId, name: 'TEST Cards Ltd', assetId: 'USDT', spendThreshold: '500' });
    await owner.testPartner.fundBusiness({ accountId, fundId: `fund-${accountId}`, amount: '1000' });
    await join(owner, accountId, MEMBER, 'viewer');
    await join(owner, accountId, APPROVER, 'checker');
    return { accountId, owner, member: as(MEMBER) };
  }

  const BUSINESS = (accountId: string) => ({ userId: `business:${accountId}`, assetId: 'USDT', spaceId: null });
  const held = async (accountId: string) => (await partner.bank.balance(BUSINESS(accountId))).amount;
  const memberHeld = async () => (await partner.bank.balance({ userId: MEMBER, assetId: 'USDT', spaceId: null })).amount;

  it('#1 a card issued to a member with a limit of 100 is in the member’s view; only an admin issues one, only to a member', async () => {
    const { accountId, owner, member } = await business();
    const cardId = randomUUID();
    const card = await owner.businessCards.issueCard({ accountId, cardId, memberUserId: MEMBER, perPurchaseLimit: '100.00' });
    expect(card).toMatchObject({
      memberUserId: MEMBER,
      perPurchaseLimit: '100',
      test: true,
      panTail: testCardTail(cardId),
      status: 'active',
    });
    // The same id on the same terms is the same card; on other terms it is a conflict.
    expect((await owner.businessCards.issueCard({ accountId, cardId, memberUserId: MEMBER, perPurchaseLimit: '100' })).id).toBe(cardId);
    expect(await refused(owner.businessCards.issueCard({ accountId, cardId, memberUserId: MEMBER, perPurchaseLimit: '200' }))).toBe(
      'bank.business_request_conflict',
    );
    const mine = await member.businessCards.overview({ accountId });
    expect(mine.cards.map((c) => c.id)).toEqual([cardId]);
    expect(
      await refused(member.businessCards.issueCard({ accountId, cardId: randomUUID(), memberUserId: MEMBER, perPurchaseLimit: '1' })),
    ).toBe('bank.business_role_forbidden');
    expect(
      await refused(owner.businessCards.issueCard({ accountId, cardId: randomUUID(), memberUserId: id(9), perPurchaseLimit: '1' })),
    ).toBe('bank.business_not_member');
    expect(
      await refused(owner.businessCards.issueCard({ accountId, cardId: randomUUID(), memberUserId: MEMBER, perPurchaseLimit: '0' })),
    ).toBe('bank.business_card_field_invalid');
  });

  it('#2 spending 120 on a 100 card declines over_limit, moves nothing and opens one request to the admin', async () => {
    const { accountId, owner, member } = await business();
    const cardId = randomUUID();
    await owner.businessCards.issueCard({ accountId, cardId, memberUserId: MEMBER, perPurchaseLimit: '100' });
    const purchaseId = randomUUID();
    const p = await member.businessCards.testPurchase({ cardId, purchaseId, merchant: 'TEST Shop', amount: '120.00' });
    expect(p).toMatchObject({ status: 'declined', declineReason: 'over_limit', partnerMoveId: null });
    expect(p.limitRequest).toMatchObject({ status: 'open', amount: '120' });
    // Asked again: the same purchase, still one request, still nothing moved.
    await member.businessCards.testPurchase({ cardId, purchaseId, merchant: 'TEST Shop', amount: '120.00' });
    expect(await held(accountId)).toBe(parseAmount('1000'));
    expect(await partner.bank.moveByKey(cardCaptureKey(purchaseId))).toBeNull();
    const admin = await owner.businessCards.overview({ accountId });
    expect(admin.limitRequests).toHaveLength(1);
    expect(admin.limitRequests[0]).toMatchObject({ purchaseId, memberUserId: MEMBER, status: 'open' });
    // Only the cardholder spends on the card; another member cannot decide the request.
    expect(await refused(as(APPROVER).businessCards.testPurchase({ cardId, purchaseId: randomUUID(), merchant: 'x', amount: '1' }))).toBe(
      'bank.business_card_not_found',
    );
    expect(await refused(member.businessCards.decideLimitRequest({ purchaseId, approve: true }))).toBe('bank.business_role_forbidden');
    // The admin approves: the card's limit becomes the requested amount.
    expect((await owner.businessCards.decideLimitRequest({ purchaseId, approve: true })).status).toBe('approved');
    expect((await owner.businessCards.overview({ accountId })).cards[0]!.perPurchaseLimit).toBe('120');
    // Off the TEST stack there is no card network to spend on.
    expect(
      await refused(as(MEMBER, false).businessCards.testPurchase({ cardId, purchaseId: randomUUID(), merchant: 'x', amount: '1' })),
    ).toBe('bank.test_partner_off');
  });

  it('#3 a capture of 80 over the 50 rule needs a receipt with one reminder; the receipt clears it; receipts download as a ZIP', async () => {
    const { accountId, owner, member } = await business();
    await owner.businessCards.setPolicy({ accountId, receiptOver: '50.00' });
    const cardId = randomUUID();
    await owner.businessCards.issueCard({ accountId, cardId, memberUserId: MEMBER, perPurchaseLimit: '100' });
    const purchaseId = randomUUID();
    const p = await member.businessCards.testPurchase({ cardId, purchaseId, merchant: 'TEST Hotel', amount: '80.00' });
    expect(p).toMatchObject({
      status: 'captured',
      needsReceipt: true,
      reminders: 1,
      receiptOver: '50',
      partnerKey: cardCaptureKey(purchaseId),
    });
    // One partner move, from the business's account to the TEST merchant, sent once.
    expect(await held(accountId)).toBe(parseAmount('920'));
    await member.businessCards.testPurchase({ cardId, purchaseId, merchant: 'TEST Hotel', amount: '80.00' });
    expect(await held(accountId)).toBe(parseAmount('920'));
    const move = await partner.bank.moveByKey(cardCaptureKey(purchaseId));
    expect(move).toMatchObject({ amount: parseAmount('80'), to: { userId: TEST_PARTNER_MERCHANT } });
    // Still exactly one reminder.
    const n = await sql<
      Array<{ n: string }>
    >`SELECT count(*)::text AS n FROM bank.business_receipt_reminders WHERE purchase_id = ${purchaseId}::uuid`;
    expect(n[0]!.n).toBe('1');
    // Under the rule no receipt is needed.
    const small = await member.businessCards.testPurchase({ cardId, purchaseId: randomUUID(), merchant: 'TEST Cafe', amount: '20' });
    expect(small).toMatchObject({ status: 'captured', needsReceipt: false, reminders: 0 });

    const zip0 = await owner.businessCards.receiptsZip({ accountId });
    expect(zip0.count).toBe(0);
    const done = await member.businessCards.attachReceipt({ purchaseId, receiptId: randomUUID(), ...RECEIPT });
    expect(done).toMatchObject({ needsReceipt: false, reminders: 0 });
    const zip = await owner.businessCards.receiptsZip({ accountId });
    expect(zip.count).toBe(1);
    const bytes = Buffer.from(zip.zipBase64, 'base64');
    expect(bytes.readUInt32LE(0)).toBe(0x04034b50);
    const content = Buffer.from(RECEIPT.contentBase64, 'base64');
    expect(bytes.readUInt32LE(14)).toBe(crc32(content));
    expect(bytes.includes(content)).toBe(true);
    // Only someone with export downloads them.
    expect(await refused(member.businessCards.receiptsZip({ accountId }))).toBe('bank.business_role_forbidden');
    expect(
      await refused(
        member.businessCards.attachReceipt({ purchaseId, receiptId: randomUUID(), ...RECEIPT, contentType: 'text/html' as never }),
      ),
    ).toBeDefined();
  });

  it('#4 #5 a claim of 42.50 with a receipt is approved and paid as one partner move; the member’s balance rises by exactly 42.50', async () => {
    const { accountId, owner, member } = await business();
    const claimId = randomUUID();
    const claim = await member.businessCards.submitClaim({
      accountId,
      claimId,
      amount: '42.50',
      description: 'TEST taxi to client',
      receiptId: randomUUID(),
      ...RECEIPT,
    });
    expect(claim).toMatchObject({ status: 'submitted', amount: '42.5', partnerKey: reimbursementKey(claimId), partnerMoveId: null });
    expect((await owner.businessCards.overview({ accountId })).claims.map((c) => c.id)).toEqual([claimId]);
    // The claimant never approves their own claim; a viewer cannot approve.
    expect(await refused(member.businessCards.approveAndPay({ claimId }))).toBe('bank.business_self_approve');

    const before = (await memberHeld()) ?? 0n;
    // The partner's answer is lost once: the claim stays paying, and the retry reads the move back by its key.
    partner.set(`business:${accountId}`, { nextReply: 'lost' });
    expect(await refused(owner.businessCards.approveAndPay({ claimId }))).toBe('bank.partner_reply_lost');
    const paid = await owner.businessCards.approveAndPay({ claimId });
    expect(paid.status).toBe('paid');
    expect(paid.approvedBy).toBe(OWNER);
    expect((await memberHeld())! - before).toBe(parseAmount('42.5'));
    expect(await held(accountId)).toBe(parseAmount('957.5'));
    const moves = (await partner.bank.moves(MEMBER, { limit: 50 })).filter((m) => m.key === reimbursementKey(claimId));
    expect(moves).toHaveLength(1);
    // Paid again: the same claim, no second move.
    await owner.businessCards.approveAndPay({ claimId });
    expect((await partner.bank.moves(MEMBER, { limit: 50 })).filter((m) => m.key === reimbursementKey(claimId))).toHaveLength(1);
    const mine = await member.businessCards.overview({ accountId });
    expect(mine.myBalance?.amount).toBe('42.5');
    // The ledger posted nothing for any of it.
    expect(ledger.journal()).toEqual([]);
  });

  it('a claim the business cannot cover is refused by the partner, moves nothing and stays open', async () => {
    const { accountId, owner, member } = await business();
    const claimId = randomUUID();
    await member.businessCards.submitClaim({
      accountId,
      claimId,
      amount: '5000',
      description: 'TEST big',
      receiptId: randomUUID(),
      ...RECEIPT,
    });
    expect(await refused(as(APPROVER).businessCards.approveAndPay({ claimId }))).toBe('bank.partner_insufficient_funds');
    const c = (await owner.businessCards.overview({ accountId })).claims[0]!;
    expect(c).toMatchObject({ status: 'submitted', refusalCode: 'bank.partner_insufficient_funds', partnerMoveId: null });
    expect(await held(accountId)).toBe(parseAmount('1000'));
  });
});
