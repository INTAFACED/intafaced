import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import {
  assertPostingEnabled,
  NO_PARTNER_BANK_CODE,
  type NoteRefusal,
  type PartnerAccountRef,
  type PartnerBank,
  type PartnerCustody,
  type PostingFreeze,
} from '../partner/partner-bank.js';
import { TEST_PARTNER_MERCHANT } from '../partner/test-partner.js';
import { businessPartnerAccount, type BusinessPermission, type BusinessTeamService } from './business-team.js';

/**
 * A BUSINESS GIVES ITS TEAM CARDS AND HANDLES THEIR EXPENSES (J-bank-22; BK-bcard-01, BK-bexp-01, BK-bexp-02).
 *
 * The business's money is the partner bank's (OWNER 226; docs/adr/2026-11-10-launch-money-model.md), in its own account
 * at the partner, `business:<account id>`. INTAFACED's ledger posts nothing for any of this.
 *
 *   cards           A member with `manage_team` issues a card to a member of the business with a per-purchase limit. The
 *                   card is a TEST card on the TEST card network: `rail.card` is not connected, and no card number, CVC or
 *                   PIN exists anywhere (the last four digits are derived from the card id).
 *   purchases       A purchase over the card's limit is declined `over_limit`, moves nothing, and opens one request to the
 *                   business's admins. One within it is captured as one partner move from the business's account to the
 *                   TEST merchant, under `bank.business.card-capture:<purchase id>`, stored before it is sent and sent
 *                   once; a lost answer is read back by its key. The partner's no (not enough money) declines it.
 *   receipts        The business sets its own receipt rule. A captured purchase over it with no receipt "needs receipt",
 *                   and exactly one reminder is queued for it, never a second. Giving the receipt clears it. Anyone with
 *                   `export` downloads every receipt of the business in one ZIP file.
 *   reimbursements  A member claims back what they paid themselves, with a receipt. Someone else holding `approve`
 *                   approves and pays it: one partner move from the business's account to the member's own, under
 *                   `bank.business.reimbursement:<claim id>`. The member's balance at the partner is read just before and
 *                   just after, as the partner reports it.
 */

export const MAX_RECEIPT_BYTES = 524_288;
export const RECEIPT_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'text/plain'] as const;
export type ReceiptType = (typeof RECEIPT_TYPES)[number];

export const CARD_PURCHASE_STATUSES = ['declined', 'capturing', 'captured'] as const;
export type CardPurchaseStatus = (typeof CARD_PURCHASE_STATUSES)[number];
export const CARD_DECLINE_REASONS = ['over_limit', 'insufficient_funds', 'account_restricted'] as const;
export type CardDeclineReason = (typeof CARD_DECLINE_REASONS)[number];
export const LIMIT_REQUEST_STATUSES = ['open', 'approved', 'declined'] as const;
export type LimitRequestStatus = (typeof LIMIT_REQUEST_STATUSES)[number];
export const CLAIM_STATUSES = ['submitted', 'paying', 'paid', 'declined'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const cardCaptureKey = (purchaseId: string): string => `bank.business.card-capture:${purchaseId}`;
export const reimbursementKey = (claimId: string): string => `bank.business.reimbursement:${claimId}`;

/** The partner's answers that say nothing moved, and the decline each is on the card. */
const DEFINITE_DECLINES: Readonly<Record<string, CardDeclineReason>> = {
  'bank.partner_insufficient_funds': 'insufficient_funds',
  'bank.account_restricted': 'account_restricted',
};
const DEFINITE_REFUSALS = new Set(['bank.partner_insufficient_funds', 'bank.account_restricted', 'bank.partner_move_conflict']);

const MERCHANT_RE = /^[^\p{Cc}]{1,80}$/u;
const DESCRIPTION_RE = /^[^\p{Cc}]{1,200}$/u;
const FILE_NAME_RE = /^[^\p{Cc}/\\]{1,120}$/u;
const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const conflict = (what: string) => new BankError(`This ${what} id is already used on different terms.`, 'bank.business_request_conflict');

/** The last four digits of a TEST card: from its id, so stable, and the tail of no card number anyone issued. */
export function testCardTail(cardId: string): string {
  return String(Number.parseInt(sha256(`business-card:${cardId}`).slice(0, 8), 16) % 10_000).padStart(4, '0');
}

export interface BusinessCard {
  id: string;
  accountId: string;
  memberUserId: string;
  memberHandle: string | null;
  assetId: string;
  perPurchaseLimit: Amount;
  panTail: string;
  status: 'active' | 'frozen';
  test: true;
  issuedBy: string;
  createdAt: Date;
}

export interface CardPurchase {
  id: string;
  cardId: string;
  panTail: string;
  memberUserId: string;
  merchant: string;
  assetId: string;
  amount: Amount;
  status: CardPurchaseStatus;
  declineReason: string | null;
  partnerKey: string;
  partnerMoveId: string | null;
  receiptOver: Amount | null;
  /** Captured over the receipt rule with no receipt given. */
  needsReceipt: boolean;
  receiptId: string | null;
  /** How many reminders are queued for it: one at most. */
  reminders: number;
  limitRequest: LimitRequest | null;
  createdAt: Date;
  capturedAt: Date | null;
}

export interface LimitRequest {
  purchaseId: string;
  cardId: string;
  memberUserId: string;
  amount: Amount;
  status: LimitRequestStatus;
  decidedBy: string | null;
  createdAt: Date;
}

export interface ExpensePolicy {
  receiptOver: Amount | null;
}

export interface ReceiptInfo {
  id: string;
  fileName: string;
  contentType: string;
  size: number;
  sha256: string;
  uploadedBy: string;
  createdAt: Date;
}

export interface ReimbursementClaim {
  id: string;
  accountId: string;
  memberUserId: string;
  assetId: string;
  amount: Amount;
  description: string;
  receipt: ReceiptInfo;
  status: ClaimStatus;
  approvedBy: string | null;
  partnerKey: string;
  partnerMoveId: string | null;
  memberBefore: Amount | null;
  memberAfter: Amount | null;
  refusalCode: string | null;
  createdAt: Date;
  paidAt: Date | null;
}

export interface ExpensesOverview {
  policy: ExpensePolicy;
  /** The caller's permissions here, so a page offers only what the bank will take. */
  permissions: BusinessPermission[];
  cards: BusinessCard[];
  purchases: CardPurchase[];
  limitRequests: LimitRequest[];
  claims: ReimbursementClaim[];
  /** The caller's own balance at the partner in the business's currency, as the partner reports it; null when not known. */
  myBalance: { label: string; amount: Amount | null } | null;
}

export interface BusinessCardsOptions {
  readonly postingFreeze: PostingFreeze;
  readonly noteRefusal?: NoteRefusal;
  /** Who holds each person's bank money: a reimbursement pays the member's own account at the partner. */
  readonly custody: PartnerCustody;
  /** True only on a stack that runs the TEST card network (the TEST partner): purchases are refused anywhere else. */
  readonly testNetwork: boolean;
}

interface AccountRow {
  id: string;
  name: string;
  asset_id: string;
  status: 'active' | 'closed';
}
interface CardRow {
  id: string;
  account_id: string;
  member_user_id: string;
  asset_id: string;
  per_purchase_limit: string;
  pan_tail: string;
  status: 'active' | 'frozen';
  issued_by: string;
  created_at: Date;
}
interface PurchaseRow {
  id: string;
  card_id: string;
  account_id: string;
  member_user_id: string;
  merchant: string;
  asset_id: string;
  amount: string;
  status: CardPurchaseStatus;
  decline_reason: string | null;
  partner_key: string;
  partner_move_id: string | null;
  receipt_over: string | null;
  created_at: Date;
  captured_at: Date | null;
}
interface RequestRow {
  purchase_id: string;
  card_id: string;
  account_id: string;
  member_user_id: string;
  amount: string;
  status: LimitRequestStatus;
  decided_by: string | null;
  created_at: Date;
}
interface ReceiptRow {
  id: string;
  account_id: string;
  uploaded_by: string;
  file_name: string;
  content_type: string;
  size: number;
  sha256: string;
  created_at: Date;
}
interface ClaimRow {
  id: string;
  account_id: string;
  member_user_id: string;
  asset_id: string;
  amount: string;
  description: string;
  receipt_id: string;
  status: ClaimStatus;
  approved_by: string | null;
  partner_key: string;
  partner_move_id: string | null;
  member_before: string | null;
  member_after: string | null;
  refusal_code: string | null;
  created_at: Date;
  paid_at: Date | null;
}

const memberAccount = (userId: string, assetId: string): PartnerAccountRef => ({ userId, assetId, spaceId: null });
const testMerchantAccount = (assetId: string): PartnerAccountRef => ({ userId: TEST_PARTNER_MERCHANT, assetId, spaceId: null });

function positive(raw: string, what: string): Amount {
  let amount: Amount;
  try {
    amount = parseAmount(raw);
  } catch {
    throw new BankError(`The ${what} is not an amount.`, 'bank.business_card_field_invalid');
  }
  if (amount <= 0n) throw new BankError(`The ${what} must be above zero.`, 'bank.business_card_field_invalid');
  return amount;
}

export class BusinessCardsService {
  constructor(
    private readonly sql: Sql,
    private readonly team: BusinessTeamService,
    private readonly options: BusinessCardsOptions,
  ) {}

  // ── Reads ──────────────────────────────────────────────────────────────────

  /**
   * Everything the caller may see: an admin (`manage_team`) or an approver sees the whole business; any other member sees
   * their own cards, purchases and claims.
   */
  async overview(accountId: string, userId: string): Promise<ExpensesOverview> {
    const seat = await this.team.seat(accountId, userId);
    const all = seat.permissions.includes('manage_team') || seat.permissions.includes('approve');
    const policy = await this.policyOf(this.sql, accountId);
    const cards = all
      ? await this.sql<CardRow[]>`SELECT * FROM bank.business_cards WHERE account_id = ${accountId}::uuid ORDER BY created_at DESC`
      : await this.sql<CardRow[]>`
          SELECT * FROM bank.business_cards WHERE account_id = ${accountId}::uuid AND member_user_id = ${userId} ORDER BY created_at DESC
        `;
    const purchases = all
      ? await this.sql<PurchaseRow[]>`
          SELECT * FROM bank.business_card_purchases WHERE account_id = ${accountId}::uuid ORDER BY created_at DESC LIMIT 200
        `
      : await this.sql<PurchaseRow[]>`
          SELECT * FROM bank.business_card_purchases WHERE account_id = ${accountId}::uuid AND member_user_id = ${userId}
           ORDER BY created_at DESC LIMIT 200
        `;
    const claims = all
      ? await this.sql<ClaimRow[]>`
          SELECT * FROM bank.business_reimbursements WHERE account_id = ${accountId}::uuid ORDER BY created_at DESC LIMIT 200
        `
      : await this.sql<ClaimRow[]>`
          SELECT * FROM bank.business_reimbursements WHERE account_id = ${accountId}::uuid AND member_user_id = ${userId}
           ORDER BY created_at DESC LIMIT 200
        `;
    const requests = seat.permissions.includes('manage_team')
      ? await this.sql<RequestRow[]>`
          SELECT * FROM bank.business_card_limit_requests WHERE account_id = ${accountId}::uuid ORDER BY created_at DESC LIMIT 200
        `
      : await this.sql<RequestRow[]>`
          SELECT * FROM bank.business_card_limit_requests WHERE account_id = ${accountId}::uuid AND member_user_id = ${userId}
           ORDER BY created_at DESC LIMIT 200
        `;
    const handles = await this.team.handlesOf([...new Set(cards.map((c) => c.member_user_id))]).catch(() => new Map<string, string>());
    let myBalance: ExpensesOverview['myBalance'] = null;
    const mine = this.options.custody.bankFor(userId);
    if (mine) {
      const b = await mine.balance(memberAccount(userId, seat.account.assetId)).catch(() => null);
      myBalance = { label: mine.label, amount: b && !b.unavailable ? b.amount : null };
    }
    return {
      policy,
      permissions: seat.permissions,
      cards: cards.map((c) => toCard(c, handles)),
      purchases: await Promise.all(purchases.map((p) => this.purchaseView(p))),
      limitRequests: requests.map(toRequest),
      claims: await Promise.all(claims.map((c) => this.claimView(c))),
      myBalance,
    };
  }

  // ── Cards (BK-bcard-01) ────────────────────────────────────────────────────

  /** Issues a TEST card to a member of the business with a per-purchase limit. The same id on the same terms is the same card. */
  async issueCard(input: {
    accountId: string;
    userId: string;
    cardId: string;
    memberUserId: string;
    perPurchaseLimit: string;
  }): Promise<BusinessCard> {
    const seat = await this.team.seat(input.accountId, input.userId);
    this.need(seat.permissions, 'manage_team');
    if (seat.account.status !== 'active') throw closed();
    const limit = positive(input.perPurchaseLimit, 'per-purchase limit');
    const member = await this.sql`
      SELECT 1 FROM bank.business_members WHERE account_id = ${input.accountId}::uuid AND user_id = ${input.memberUserId}
    `;
    if (member.length === 0) {
      throw new BankError('That person is not a member of this business, so no card was issued.', 'bank.business_not_member');
    }
    const rows = await this.sql<CardRow[]>`
      INSERT INTO bank.business_cards (id, account_id, member_user_id, asset_id, per_purchase_limit, pan_tail, issued_by)
      VALUES (${input.cardId}::uuid, ${input.accountId}::uuid, ${input.memberUserId}, ${seat.account.assetId},
              ${formatAmount(limit)}::numeric, ${testCardTail(input.cardId)}, ${input.userId})
      ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
      RETURNING *
    `;
    const row = rows[0]!;
    if (row.account_id !== input.accountId || row.member_user_id !== input.memberUserId || parseAmount(row.per_purchase_limit) !== limit) {
      throw conflict('card');
    }
    return toCard(row, await this.team.handlesOf([row.member_user_id]).catch(() => new Map<string, string>()));
  }

  /**
   * One purchase on the TEST card network (the `rail.card` stand-in): the card's holder spends at a merchant. Over the
   * card's limit it is declined `over_limit` with one request to the admins; within it, one partner move captures it.
   * The same purchase id is the same purchase: a retry reads back what was decided.
   */
  async testPurchase(input: {
    cardId: string;
    userId: string;
    purchaseId: string;
    merchant: string;
    amount: string;
  }): Promise<CardPurchase> {
    if (!this.options.testNetwork) {
      throw new BankError('The TEST card network exists only on a stack that runs the TEST partner bank.', 'bank.test_partner_off');
    }
    const card = await this.cardRow(this.sql, input.cardId);
    if (card.member_user_id !== input.userId) {
      throw new BankError('This card is not yours, so nothing was spent on it.', 'bank.business_card_not_found');
    }
    const merchant = input.merchant.trim();
    if (!MERCHANT_RE.test(merchant)) throw new BankError('A merchant name is 1 to 80 characters.', 'bank.business_card_field_invalid');
    const amount = positive(input.amount, 'amount');
    const prior = await this.purchaseRowOrNull(this.sql, input.purchaseId);
    if (prior) {
      if (prior.card_id !== card.id || prior.merchant !== merchant || parseAmount(prior.amount) !== amount) throw conflict('purchase');
      if (prior.status === 'capturing') await this.capture(prior);
      return this.purchaseView(await this.purchaseRow(this.sql, prior.id));
    }
    const seat = await this.team.seat(card.account_id, input.userId);
    if (seat.account.status !== 'active') throw closed();
    if (card.status !== 'active') throw new BankError('This card is frozen, so nothing was spent on it.', 'bank.business_card_frozen');
    const limit = parseAmount(card.per_purchase_limit);
    if (amount > limit) {
      await transaction(this.sql, async (tx) => {
        await this.insertPurchase(tx, card, input.purchaseId, merchant, amount, 'declined', 'over_limit', null);
        await tx`
          INSERT INTO bank.business_card_limit_requests (purchase_id, card_id, account_id, member_user_id, amount)
          VALUES (${input.purchaseId}::uuid, ${card.id}::uuid, ${card.account_id}::uuid, ${card.member_user_id}, ${formatAmount(amount)}::numeric)
          ON CONFLICT (purchase_id) DO NOTHING
        `;
      });
      return this.purchaseView(await this.purchaseRow(this.sql, input.purchaseId));
    }
    if (!seat.partner) throw noPartner();
    await this.moneyMayMove();
    const policy = await this.policyOf(this.sql, card.account_id);
    await this.insertPurchase(this.sql, card, input.purchaseId, merchant, amount, 'capturing', null, policy.receiptOver);
    await this.capture(await this.purchaseRow(this.sql, input.purchaseId));
    return this.purchaseView(await this.purchaseRow(this.sql, input.purchaseId));
  }

  /** An admin's answer to an over-limit request: approved, the card's limit becomes the requested amount. */
  async decideLimitRequest(input: { purchaseId: string; userId: string; approve: boolean }): Promise<LimitRequest> {
    const req = (
      await this.sql<RequestRow[]>`SELECT * FROM bank.business_card_limit_requests WHERE purchase_id = ${input.purchaseId}::uuid`
    )[0];
    if (!req) throw new BankError('No over-limit request has that id.', 'bank.limit_request_not_found');
    const seat = await this.team.seat(req.account_id, input.userId);
    this.need(seat.permissions, 'manage_team');
    return transaction(this.sql, async (tx) => {
      const locked = (
        await tx<RequestRow[]>`SELECT * FROM bank.business_card_limit_requests WHERE purchase_id = ${req.purchase_id}::uuid FOR UPDATE`
      )[0]!;
      if (locked.status !== 'open') return toRequest(locked);
      const status: LimitRequestStatus = input.approve ? 'approved' : 'declined';
      if (input.approve) {
        await tx`
          UPDATE bank.business_cards SET per_purchase_limit = GREATEST(per_purchase_limit, ${locked.amount}::numeric)
           WHERE id = ${locked.card_id}::uuid
        `;
      }
      const rows = await tx<RequestRow[]>`
        UPDATE bank.business_card_limit_requests SET status = ${status}, decided_by = ${input.userId}, decided_at = now()
         WHERE purchase_id = ${locked.purchase_id}::uuid RETURNING *
      `;
      return toRequest(rows[0]!);
    });
  }

  // ── Receipts (BK-bexp-01) ──────────────────────────────────────────────────

  /** The business's own receipt rule: a captured purchase over this amount needs a receipt. */
  async setPolicy(input: { accountId: string; userId: string; receiptOver: string }): Promise<ExpensePolicy> {
    const seat = await this.team.seat(input.accountId, input.userId);
    this.need(seat.permissions, 'manage_team');
    let over: Amount;
    try {
      over = parseAmount(input.receiptOver);
    } catch {
      throw new BankError('The receipt rule is not an amount.', 'bank.business_card_field_invalid');
    }
    if (over < 0n) throw new BankError('The receipt rule cannot be below zero.', 'bank.business_card_field_invalid');
    await this.sql`
      INSERT INTO bank.business_expense_policies (account_id, receipt_over, set_by)
      VALUES (${input.accountId}::uuid, ${formatAmount(over)}::numeric, ${input.userId})
      ON CONFLICT (account_id) DO UPDATE SET receipt_over = EXCLUDED.receipt_over, set_by = EXCLUDED.set_by, set_at = now()
    `;
    return this.policyOf(this.sql, input.accountId);
  }

  /** The card's holder gives the receipt for one of their captured purchases; its reminder is cleared. */
  async attachReceipt(input: {
    purchaseId: string;
    userId: string;
    receiptId: string;
    fileName: string;
    contentType: string;
    contentBase64: string;
  }): Promise<CardPurchase> {
    const purchase = await this.purchaseRow(this.sql, input.purchaseId);
    if (purchase.member_user_id !== input.userId) {
      throw new BankError('Only the cardholder gives the receipt for their purchase.', 'bank.business_card_not_found');
    }
    if (purchase.status !== 'captured') {
      throw new BankError('Only a captured purchase takes a receipt.', 'bank.business_card_field_invalid');
    }
    await transaction(this.sql, async (tx) => {
      await this.insertReceipt(tx, purchase.account_id, input);
      const attached = await tx<Array<{ receipt_id: string }>>`
        INSERT INTO bank.business_purchase_receipts (purchase_id, receipt_id) VALUES (${purchase.id}::uuid, ${input.receiptId}::uuid)
        ON CONFLICT (purchase_id) DO UPDATE SET purchase_id = EXCLUDED.purchase_id
        RETURNING receipt_id
      `;
      if (attached[0]!.receipt_id !== input.receiptId) throw conflict('receipt');
      await tx`UPDATE bank.business_receipt_reminders SET status = 'cleared' WHERE purchase_id = ${purchase.id}::uuid`;
    });
    return this.purchaseView(await this.purchaseRow(this.sql, purchase.id));
  }

  /** Every receipt of the business, purchases' and claims', in one ZIP file. */
  async receiptsZip(accountId: string, userId: string): Promise<{ fileName: string; count: number; zip: Buffer }> {
    const seat = await this.team.seat(accountId, userId);
    this.need(seat.permissions, 'export');
    const rows = await this.sql<Array<{ id: string; file_name: string; bytes: Buffer; created_at: Date }>>`
      SELECT id, file_name, bytes, created_at FROM bank.business_receipts WHERE account_id = ${accountId}::uuid ORDER BY created_at, id LIMIT 500
    `;
    const files = rows.map((r) => ({ name: `${r.id.slice(0, 8)}-${r.file_name}`, data: Buffer.from(r.bytes), at: r.created_at }));
    return { fileName: `receipts-${accountId.slice(0, 8)}.zip`, count: files.length, zip: zipStore(files) };
  }

  // ── Reimbursements (BK-bexp-02) ────────────────────────────────────────────

  /** A member's claim for what they paid themselves, with its receipt. The same id on the same terms is the same claim. */
  async submitClaim(input: {
    accountId: string;
    userId: string;
    claimId: string;
    amount: string;
    description: string;
    receiptId: string;
    fileName: string;
    contentType: string;
    contentBase64: string;
  }): Promise<ReimbursementClaim> {
    const seat = await this.team.seat(input.accountId, input.userId);
    if (seat.account.status !== 'active') throw closed();
    const amount = positive(input.amount, 'amount');
    const description = input.description.trim();
    if (!DESCRIPTION_RE.test(description)) throw new BankError('A description is 1 to 200 characters.', 'bank.business_card_field_invalid');
    const row = await transaction(this.sql, async (tx) => {
      await this.insertReceipt(tx, input.accountId, input);
      const rows = await tx<ClaimRow[]>`
        INSERT INTO bank.business_reimbursements (id, account_id, member_user_id, asset_id, amount, description, receipt_id, partner_key)
        VALUES (${input.claimId}::uuid, ${input.accountId}::uuid, ${input.userId}, ${seat.account.assetId}, ${formatAmount(amount)}::numeric,
                ${description}, ${input.receiptId}::uuid, ${reimbursementKey(input.claimId)})
        ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
        RETURNING *
      `;
      return rows[0]!;
    });
    if (
      row.account_id !== input.accountId ||
      row.member_user_id !== input.userId ||
      parseAmount(row.amount) !== amount ||
      row.description !== description ||
      row.receipt_id !== input.receiptId
    ) {
      throw conflict('claim');
    }
    return this.claimView(row);
  }

  /**
   * Someone holding `approve` other than the claimant approves and pays: one partner move from the business's account to
   * the member's own, under the claim's key, sent once. A retry of a claim whose answer was lost reads it back by its key.
   */
  async approveAndPay(input: { claimId: string; userId: string }): Promise<ReimbursementClaim> {
    const prior = await this.claimRow(this.sql, input.claimId);
    const seat = await this.team.seat(prior.account_id, input.userId);
    if (prior.member_user_id === input.userId) {
      throw new BankError('This is your own claim, so you cannot approve it. Another approver must.', 'bank.business_self_approve');
    }
    this.need(seat.permissions, 'approve');
    if (prior.status === 'paid' || prior.status === 'declined') return this.claimView(prior);
    if (!seat.partner) throw noPartner();
    const memberBank = this.options.custody.bankFor(prior.member_user_id);
    if (!memberBank) {
      throw new BankError(
        'The member’s own bank money is not held at the partner bank, so it cannot pay them there. Nothing was sent.',
        NO_PARTNER_BANK_CODE,
      );
    }
    await this.moneyMayMove();
    const row = await transaction(this.sql, async (tx) => {
      const locked = (await tx<ClaimRow[]>`SELECT * FROM bank.business_reimbursements WHERE id = ${prior.id}::uuid FOR UPDATE`)[0]!;
      if (locked.status !== 'submitted') return locked;
      return (
        await tx<ClaimRow[]>`
          UPDATE bank.business_reimbursements SET status = 'paying', approved_by = ${input.userId}
           WHERE id = ${locked.id}::uuid RETURNING *
        `
      )[0]!;
    });
    if (row.status === 'paying') await this.pay(row, seat.partner);
    return this.claimView(await this.claimRow(this.sql, row.id));
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async capture(row: PurchaseRow): Promise<void> {
    const seat = await this.team.seat(row.account_id, row.member_user_id);
    if (!seat.partner) throw noPartner();
    const amount = parseAmount(row.amount);
    try {
      const move =
        (await seat.partner.moveByKey(row.partner_key)) ??
        (await seat.partner.move({
          key: row.partner_key,
          from: businessPartnerAccount(row.account_id, row.asset_id),
          to: testMerchantAccount(row.asset_id),
          amount,
        }));
      await transaction(this.sql, async (tx) => {
        const done = await tx<PurchaseRow[]>`
          UPDATE bank.business_card_purchases SET status = 'captured', partner_move_id = ${move.id}, captured_at = ${move.movedAt}
           WHERE id = ${row.id}::uuid AND status = 'capturing' RETURNING *
        `;
        const captured = done[0];
        if (captured && captured.receipt_over !== null && amount > parseAmount(captured.receipt_over)) {
          // One reminder for the purchase, never a second: the purchase id is the reminder's key.
          await tx`
            INSERT INTO bank.business_receipt_reminders (purchase_id, account_id, member_user_id)
            VALUES (${row.id}::uuid, ${row.account_id}::uuid, ${row.member_user_id})
            ON CONFLICT (purchase_id) DO NOTHING
          `;
        }
      });
    } catch (err) {
      const reason = err instanceof BankError ? DEFINITE_DECLINES[err.code] : undefined;
      if (!reason) throw err;
      await this.sql`
        UPDATE bank.business_card_purchases SET status = 'declined', decline_reason = ${reason}
         WHERE id = ${row.id}::uuid AND status = 'capturing'
      `;
    }
  }

  private async pay(row: ClaimRow, partner: PartnerBank): Promise<void> {
    const to = memberAccount(row.member_user_id, row.asset_id);
    const amount = parseAmount(row.amount);
    const already = await partner.moveByKey(row.partner_key);
    const before = already ? null : await partner.balance(to).catch(() => null);
    try {
      const move =
        already ?? (await partner.move({ key: row.partner_key, from: businessPartnerAccount(row.account_id, row.asset_id), to, amount }));
      const after = await partner.balance(to).catch(() => null);
      await this.sql`
        UPDATE bank.business_reimbursements
           SET status = 'paid', partner_move_id = ${move.id}, paid_at = ${move.movedAt},
               member_before = COALESCE(member_before, ${before && !before.unavailable && before.amount !== null ? formatAmount(before.amount) : null}::numeric),
               member_after = ${after && !after.unavailable && after.amount !== null ? formatAmount(after.amount) : null}::numeric
         WHERE id = ${row.id}::uuid AND status = 'paying'
      `;
    } catch (err) {
      if (err instanceof BankError && DEFINITE_REFUSALS.has(err.code)) {
        await this.sql`
          UPDATE bank.business_reimbursements SET status = 'submitted', approved_by = NULL, refusal_code = ${err.code}
           WHERE id = ${row.id}::uuid AND status = 'paying'
        `;
        throw err;
      }
      throw err;
    }
  }

  private async insertPurchase(
    sql: Sql,
    card: CardRow,
    purchaseId: string,
    merchant: string,
    amount: Amount,
    status: CardPurchaseStatus,
    declineReason: CardDeclineReason | null,
    receiptOver: Amount | null,
  ): Promise<void> {
    await sql`
      INSERT INTO bank.business_card_purchases
        (id, card_id, account_id, member_user_id, merchant, asset_id, amount, status, decline_reason, partner_key, receipt_over)
      VALUES (${purchaseId}::uuid, ${card.id}::uuid, ${card.account_id}::uuid, ${card.member_user_id}, ${merchant}, ${card.asset_id},
              ${formatAmount(amount)}::numeric, ${status}, ${declineReason}, ${cardCaptureKey(purchaseId)},
              ${receiptOver === null ? null : formatAmount(receiptOver)}::numeric)
      ON CONFLICT (id) DO NOTHING
    `;
  }

  private async insertReceipt(
    sql: Sql,
    accountId: string,
    input: { userId: string; receiptId: string; fileName: string; contentType: string; contentBase64: string },
  ): Promise<void> {
    const fileName = input.fileName.trim();
    if (!FILE_NAME_RE.test(fileName)) throw new BankError('A receipt’s file name is 1 to 120 characters.', 'bank.receipt_invalid');
    if (!(RECEIPT_TYPES as readonly string[]).includes(input.contentType)) {
      throw new BankError('A receipt is a PDF, PNG, JPEG or text file.', 'bank.receipt_invalid');
    }
    const bytes = Buffer.from(input.contentBase64, 'base64');
    if (bytes.length === 0 || bytes.length > MAX_RECEIPT_BYTES) {
      throw new BankError('A receipt is between 1 byte and 512 KiB.', 'bank.receipt_invalid');
    }
    const digest = sha256(bytes);
    const rows = await sql<Array<{ account_id: string; sha256: string; uploaded_by: string }>>`
      INSERT INTO bank.business_receipts (id, account_id, uploaded_by, file_name, content_type, bytes, sha256)
      VALUES (${input.receiptId}::uuid, ${accountId}::uuid, ${input.userId}, ${fileName}, ${input.contentType}, ${bytes}, ${digest})
      ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
      RETURNING account_id, sha256, uploaded_by
    `;
    const r = rows[0]!;
    if (r.account_id !== accountId || r.sha256 !== digest || r.uploaded_by !== input.userId) throw conflict('receipt');
  }

  private async purchaseView(row: PurchaseRow): Promise<CardPurchase> {
    const receipt = (
      await this.sql<
        Array<{ receipt_id: string }>
      >`SELECT receipt_id FROM bank.business_purchase_receipts WHERE purchase_id = ${row.id}::uuid`
    )[0];
    const reminders = Number(
      (
        await this.sql<Array<{ n: string }>>`
          SELECT count(*)::text AS n FROM bank.business_receipt_reminders WHERE purchase_id = ${row.id}::uuid AND status = 'queued'
        `
      )[0]!.n,
    );
    const req = (await this.sql<RequestRow[]>`SELECT * FROM bank.business_card_limit_requests WHERE purchase_id = ${row.id}::uuid`)[0];
    const tail = (
      await this.sql<Array<{ pan_tail: string }>>`SELECT pan_tail FROM bank.business_cards WHERE id = ${row.card_id}::uuid`
    )[0]!;
    const amount = parseAmount(row.amount);
    const over = row.receipt_over === null ? null : parseAmount(row.receipt_over);
    return {
      id: row.id,
      cardId: row.card_id,
      panTail: tail.pan_tail,
      memberUserId: row.member_user_id,
      merchant: row.merchant,
      assetId: row.asset_id,
      amount,
      status: row.status,
      declineReason: row.decline_reason,
      partnerKey: row.partner_key,
      partnerMoveId: row.partner_move_id,
      receiptOver: over,
      needsReceipt: row.status === 'captured' && over !== null && amount > over && !receipt,
      receiptId: receipt?.receipt_id ?? null,
      reminders,
      limitRequest: req ? toRequest(req) : null,
      createdAt: row.created_at,
      capturedAt: row.captured_at,
    };
  }

  private async claimView(row: ClaimRow): Promise<ReimbursementClaim> {
    const r = (
      await this.sql<ReceiptRow[]>`
        SELECT id, account_id, uploaded_by, file_name, content_type, octet_length(bytes) AS size, sha256, created_at
          FROM bank.business_receipts WHERE id = ${row.receipt_id}::uuid
      `
    )[0]!;
    const opt = (v: string | null) => (v === null ? null : parseAmount(v));
    return {
      id: row.id,
      accountId: row.account_id,
      memberUserId: row.member_user_id,
      assetId: row.asset_id,
      amount: parseAmount(row.amount),
      description: row.description,
      receipt: {
        id: r.id,
        fileName: r.file_name,
        contentType: r.content_type,
        size: Number(r.size),
        sha256: r.sha256,
        uploadedBy: r.uploaded_by,
        createdAt: r.created_at,
      },
      status: row.status,
      approvedBy: row.approved_by,
      partnerKey: row.partner_key,
      partnerMoveId: row.partner_move_id,
      memberBefore: opt(row.member_before),
      memberAfter: opt(row.member_after),
      refusalCode: row.refusal_code,
      createdAt: row.created_at,
      paidAt: row.paid_at,
    };
  }

  private async policyOf(sql: Sql, accountId: string): Promise<ExpensePolicy> {
    const row = (
      await sql<
        Array<{ receipt_over: string }>
      >`SELECT receipt_over FROM bank.business_expense_policies WHERE account_id = ${accountId}::uuid`
    )[0];
    return { receiptOver: row ? parseAmount(row.receipt_over) : null };
  }

  private async cardRow(sql: Sql, cardId: string): Promise<CardRow> {
    const row = (await sql<CardRow[]>`SELECT * FROM bank.business_cards WHERE id = ${cardId}::uuid`)[0];
    if (!row) throw new BankError('No business card has that id.', 'bank.business_card_not_found');
    return row;
  }

  private async purchaseRowOrNull(sql: Sql, id: string): Promise<PurchaseRow | null> {
    return (await sql<PurchaseRow[]>`SELECT * FROM bank.business_card_purchases WHERE id = ${id}::uuid`)[0] ?? null;
  }

  private async purchaseRow(sql: Sql, id: string): Promise<PurchaseRow> {
    const row = await this.purchaseRowOrNull(sql, id);
    if (!row) throw new BankError('No card purchase has that id.', 'bank.business_card_not_found');
    return row;
  }

  private async claimRow(sql: Sql, id: string): Promise<ClaimRow> {
    const row = (await sql<ClaimRow[]>`SELECT * FROM bank.business_reimbursements WHERE id = ${id}::uuid`)[0];
    if (!row) throw new BankError('No reimbursement claim has that id.', 'bank.reimbursement_not_found');
    return row;
  }

  private async moneyMayMove(): Promise<void> {
    await assertPostingEnabled(this.options.postingFreeze, 'bank_move', this.options.noteRefusal);
  }

  private need(permissions: readonly BusinessPermission[], permission: BusinessPermission): void {
    if (!permissions.includes(permission)) {
      throw new BankError(
        `Your role on this business does not include ${permission.replace('_', ' ')}, so this was refused. Nothing changed.`,
        'bank.business_role_forbidden',
      );
    }
  }
}

function toCard(row: CardRow, handles: Map<string, string>): BusinessCard {
  return {
    id: row.id,
    accountId: row.account_id,
    memberUserId: row.member_user_id,
    memberHandle: handles.get(row.member_user_id) ?? null,
    assetId: row.asset_id,
    perPurchaseLimit: parseAmount(row.per_purchase_limit),
    panTail: row.pan_tail,
    status: row.status,
    test: true,
    issuedBy: row.issued_by,
    createdAt: row.created_at,
  };
}

function toRequest(row: RequestRow): LimitRequest {
  return {
    purchaseId: row.purchase_id,
    cardId: row.card_id,
    memberUserId: row.member_user_id,
    amount: parseAmount(row.amount),
    status: row.status,
    decidedBy: row.decided_by,
    createdAt: row.created_at,
  };
}

function closed(): BankError {
  return new BankError('This business account is closed.', 'bank.business_closed');
}

function noPartner(): BankError {
  return new BankError('This business’s money is not held at a partner bank, so nothing can move.', NO_PARTNER_BANK_CODE);
}

// ── A ZIP file with stored (uncompressed) entries ───────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/** A ZIP of the files as they are (method 0, stored), with UTF-8 names. */
export function zipStore(files: ReadonlyArray<{ name: string; data: Buffer; at: Date }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const { time, date } = dosTime(f.at);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(f.data.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, f.data);
    centrals.push(central, name);
    offset += local.length + name.length + f.data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}
