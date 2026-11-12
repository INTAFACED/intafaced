import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { assertSelf } from '../assert-self.js';
import { BankError } from '../errors.js';
import { amountString, partnerFiguresOutput } from '../router/shared.js';
import type { BankServices } from '../bank-service.js';
import { NO_PARTNER_BANK_CODE, partnerPayoutsAccount } from './partner-bank.js';
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
export function createTestPartnerRouter(bank: Pick<BankServices, 'testPartner' | 'cards' | 'partnerCustody'>, guard: Guard) {
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
