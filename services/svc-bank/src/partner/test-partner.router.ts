import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { assertSelf } from '../assert-self.js';
import { BankError } from '../errors.js';
import { amountString, partnerFiguresOutput } from '../router/shared.js';
import type { BankServices } from '../bank-service.js';
import { NO_PARTNER_BANK_CODE, partnerPayoutsAccount } from './partner-bank.js';
import { businessPartnerAccount } from '../business/business-team.js';
import { PARTNER_FEATURES, TEST_PARTNER_MERCHANT, partnerReserve, type TestPartner, type TestPartnerSwitches } from './test-partner.js';

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

const switches = z
  .object({
    notOffered: z.array(z.enum(PARTNER_FEATURES)).max(PARTNER_FEATURES.length),
    fee: z.enum(['known', 'unknown']),
    reserve: z.enum(['none', 'required']),
    down: z.boolean(),
    figures: z.enum(['live', 'stale', 'unknown']),
    rampQuote: z.enum(['live', 'expired']),
    rampFee: z.enum(['known', 'unknown']),
    custody: z.enum(['on', 'off']),
    nextReply: z.enum(['answered', 'lost']),
    cardHold: z.enum(['live', 'expired']),
    cardDecline: z.enum(['none', 'unlisted']),
    accountDetails: z.enum(['none', 'issued']),
    purchaseHolds: z.enum(['reported', 'not_reported']),
    purchaseHold: z.enum(['live', 'expired']),
    legalHold: z.enum(['none', 'held']),
    identityCase: z.enum(['accepted', 'not_accepted']),
    bankRail: z.enum(['none', 'test']),
    /** The TEST account holder name (J-bank-30): it must say TEST, so it never reads as a real person's account. */
    holderName: z
      .string()
      .trim()
      .regex(/^TEST [^\u0000-\u001f]{1,120}$/)
      .nullable(),
  })
  .strict();

const view = switches.extend({
  label: z.string(),
  /** The reserve the partner requires of us as it reports it; an amount it has not given is null ("not known"). */
  partnerReserve: z.union([
    z.object({ required: z.literal(false) }).strict(),
    z.object({ required: z.literal(true), amount: z.null() }).strict(),
  ]),
});

function on(partner: TestPartner | null): TestPartner {
  if (!partner) {
    throw new BankError('The TEST partner switches exist only on a stack that runs the TEST partner bank.', 'bank.test_partner_off');
  }
  return partner;
}

function out(partner: TestPartner, userId: string, now: TestPartnerSwitches) {
  return { label: partner.label, ...now, notOffered: [...now.notOffered], partnerReserve: partnerReserve(partner, userId)! };
}

/**
 * The person's own TEST partner switches (CUSTODY-DELTA §4). Each is the partner's behaviour for this person only: what
 * it does not offer, what it does not say, and whether it answers. Off the TEST stack every call refuses
 * `bank.test_partner_off`, because there is no TEST partner to switch.
 */
export function createTestPartnerRouter(
  bank: Pick<BankServices, 'testPartner' | 'cards' | 'partnerCustody' | 'businessTeam' | 'bankApi'>,
  guard: Guard,
) {
  return router({
    switches: scopedProcedure('bank:read', { module: 'bank' })
      .output(view)
      .query(({ ctx }) =>
        guard(async () => {
          const partner = on(bank.testPartner);
          return out(partner, ctx.principal.userId, partner.switches(ctx.principal.userId));
        }),
      ),
    set: scopedProcedure('bank:write', { module: 'bank' })
      .input(switches.partial())
      .output(view)
      .mutation(({ ctx, input }) =>
        guard(async () => {
          const partner = on(bank.testPartner);
          return out(partner, ctx.principal.userId, partner.set(ctx.principal.userId, input));
        }),
      ),
    /**
     * The TEST partner reports one of the person's pending bank API payments completed (J-bank-24 #5), recorded as a
     * partner's report would be: one state change, one webhook delivery per endpoint. Asked again, the partner replays the
     * same report and nothing is recorded (`recorded: false`). Off the TEST stack it refuses.
     */
    settlePayment: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ paymentId: z.string().guid() }).strict())
      .output(z.object({ paymentId: z.string(), state: z.string(), version: z.number().int(), recorded: z.boolean() }))
      .mutation(({ ctx, input }) =>
        guard(async () => {
          on(bank.testPartner);
          const done = await bank.bankApi.settleTestPayment(ctx.principal.userId, input.paymentId);
          return { paymentId: done.payment.id, state: done.payment.state, version: done.payment.version, recorded: done.recorded };
        }),
      ),
    /**
     * TEST money paid into the person's main balance at the TEST partner bank, once per `fundId` (the journey's "a
     * partner account funded with TEST money"). It is the partner's figure, not a ledger post: nothing is posted.
     */
    fund: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ fundId: z.string().min(8).max(64), assetId: z.string().regex(/^[A-Z0-9]{2,16}$/), amount: amountString }).strict())
      .output(z.object({ label: z.string(), assetId: z.string(), balance: z.string(), asOf: z.string().datetime() }))
      .mutation(({ ctx, input }) =>
        guard(async () => {
          const partner = on(bank.testPartner);
          const now = partner.fund(ctx.principal.userId, {
            fundId: input.fundId,
            assetId: input.assetId,
            amount: parseAmount(input.amount),
          });
          return { label: now.label, assetId: input.assetId, balance: formatAmount(now.amount!), asOf: now.asOf!.toISOString() };
        }),
      ),
    /**
     * TEST money paid into a business's own account at the TEST partner bank, once per `fundId` (J-bank-19 Starts: the
     * business bank account holds TEST money at the partner). Only the business's owner may, and only while their own
     * bank money is the partner's (`custody: 'off'`). It is the partner's figure, not a ledger post: nothing is posted.
     */
    fundBusiness: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ accountId: z.string().guid(), fundId: z.string().min(8).max(64), amount: amountString }).strict())
      .output(z.object({ label: z.string(), assetId: z.string(), balance: z.string(), asOf: z.string().datetime() }))
      .mutation(({ ctx, input }) =>
        guard(async () => {
          const partner = on(bank.testPartner);
          const userId = ctx.principal.userId;
          const { assetId } = await bank.businessTeam.assertOwner(input.accountId, userId);
          if (!bank.partnerCustody.bankFor(userId)) {
            throw new BankError('This business’s money is not held at the TEST partner bank.', NO_PARTNER_BANK_CODE);
          }
          const account = businessPartnerAccount(input.accountId, assetId);
          const now = partner.fund(account.userId, { fundId: input.fundId, assetId, amount: parseAmount(input.amount) });
          return { label: now.label, assetId, balance: formatAmount(now.amount!), asOf: now.asOf!.toISOString() };
        }),
      ),
    /**
     * The TEST partner's own statement of the owner's business account over `[from, to)` (J-bank-23 #3), straight from its
     * book: what a statement file is checked against, for a test to compare the files with. Off the TEST stack it refuses.
     */
    businessStatement: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ accountId: z.string().guid(), from: z.string().datetime(), to: z.string().datetime() }).strict())
      .output(z.object({ label: z.string(), opening: z.string(), closing: z.string(), lines: z.number().int().nonnegative() }))
      .query(({ ctx, input }) =>
        guard(async () => {
          const partner = on(bank.testPartner);
          const { assetId } = await bank.businessTeam.assertOwner(input.accountId, ctx.principal.userId);
          const st = await partner.bank.statement!(businessPartnerAccount(input.accountId, assetId), {
            from: new Date(input.from),
            to: new Date(input.to),
          });
          return { label: st.label, opening: formatAmount(st.opening), closing: formatAmount(st.closing), lines: st.lines };
        }),
      ),
    /**
     * TEST money leaving the person's main balance at the TEST partner bank (J-bank-16 Starts: "a month of TEST activity
     * at the partner"), once per `spendId`: a TEST `payment` to a stand-in merchant, or a TEST `payout` to the partner's
     * outbound-payments account. A real send to a person at the partner is not built, and this door is not that: it is
     * refused off the TEST stack (`bank.test_partner_off`), obeys the posting freeze and partner stops, and posts nothing.
     */
    spend: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z
          .object({
            spendId: z.string().min(8).max(64),
            assetId: z.string().regex(/^[A-Z0-9]{2,16}$/),
            amount: amountString,
            kind: z.enum(['payment', 'payout']),
          })
          .strict(),
      )
      .output(z.object({ label: z.string(), moveId: z.string(), amount: amountString }))
      .mutation(({ ctx, input }) =>
        guard(async () => {
          on(bank.testPartner);
          const userId = ctx.principal.userId;
          // The guarded partner: the posting freeze and an operator's partner stop refuse this as they refuse any partner move.
          const held = bank.partnerCustody.bankFor(userId);
          if (!held)
            throw new BankError('This person has no money at the TEST partner bank, so nothing can leave it.', NO_PARTNER_BANK_CODE);
          const moved = await held.move({
            key: `test-spend:${userId}:${input.spendId}`,
            from: { userId, assetId: input.assetId, spaceId: null },
            to:
              input.kind === 'payout'
                ? partnerPayoutsAccount(input.assetId)
                : { userId: TEST_PARTNER_MERCHANT, assetId: input.assetId, spaceId: null },
            amount: parseAmount(input.amount),
          });
          return { label: moved.label, moveId: moved.id, amount: formatAmount(moved.amount) };
        }),
      ),
    /**
     * The TEST partner opens an information request or a periodic review for the person (J-bank-17 Starts: "with a
     * compliance request open"), once per id, due in `dueDays`. A real partner opens these itself; on the TEST stack the
     * person's own call stands in for it. Refused off the TEST stack (`bank.test_partner_off`).
     */
    openCompliance: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z
          .object({
            kind: z.enum(['request', 'review']),
            id: z.string().regex(/^[A-Za-z0-9:_-]{8,64}$/),
            dueDays: z.number().int().min(1).max(365),
          })
          .strict(),
      )
      .output(z.object({ label: z.string(), id: z.string(), dueAt: z.string().datetime() }).strict())
      .mutation(({ ctx, input }) =>
        guard(async () => {
          const partner = on(bank.testPartner);
          const userId = ctx.principal.userId;
          const id = `${userId}:${input.id}`;
          const row =
            input.kind === 'request'
              ? partner.compliance.openRequest(userId, id, input.dueDays)
              : partner.compliance.openReview(userId, id, input.dueDays);
          return { label: row.label, id: row.id, dueAt: row.dueAt.toISOString() };
        }),
      ),
    /**
     * The TEST partner reports the pending closure's balance paid out to its destination, and the account closes
     * (J-bank-17 #5: "closed once the partner reports it paid out"). Each balance leaves under its own closure payout key,
     * so a retry after a lost reply pays it once. Nothing posts to our ledger. Refused off the TEST stack.
     */
    closurePaidOut: scopedProcedure('bank:write', { module: 'bank' })
      .output(
        z
          .object({ label: z.string(), closureId: z.string(), payoutMoveIds: z.array(z.string()), closedAt: z.string().datetime() })
          .strict(),
      )
      .mutation(({ ctx }) =>
        guard(async () => {
          const partner = on(bank.testPartner);
          const closed = await partner.compliance.reportPaidOut(ctx.principal.userId);
          return {
            label: closed.label,
            closureId: closed.id,
            payoutMoveIds: [...closed.payoutMoveIds],
            closedAt: closed.closedAt!.toISOString(),
          };
        }),
      ),
    /**
     * THE MERCHANT REFUNDS A PURCHASE, on the TEST partner card (J-bank-14: "a refund seen"). A real refund arrives from
     * the card network through the partner; on the TEST stack the person's own call stands in for that merchant. The
     * partner gives the amount back to the partner balance, once per authorisation under `card.partner.refund:<id>`, and
     * our ledger posts nothing. Only a partner-held capture can be refunded; off the TEST stack this refuses
     * `bank.test_partner_off`.
     */
    cardRefund: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ cardId: z.string().guid(), authorizationRef: z.string().min(4).max(128), amount: amountString }).strict())
      .output(
        z.object({ authorizationId: z.string(), refunded: amountString, partnerRef: z.string(), figures: partnerFiguresOutput.nullable() }),
      )
      .mutation(({ ctx, input }) =>
        guard(async () => {
          on(bank.testPartner);
          const card = await bank.cards.card(input.cardId);
          assertSelf(ctx.principal.userId, card.userId);
          const done = await bank.cards.refund({
            cardId: input.cardId,
            authorizationRef: input.authorizationRef,
            amount: parseAmount(input.amount),
          });
          return { ...done, refunded: formatAmount(done.refunded) };
        }),
      ),
  });
}
