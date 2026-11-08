import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { amountString } from '../router/shared.js';
import type { BankServices } from '../bank-service.js';
import { PARTNER_FEATURES, partnerReserve, type TestPartner, type TestPartnerSwitches } from './test-partner.js';

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

const switches = z
  .object({
    notOffered: z.array(z.enum(PARTNER_FEATURES)).max(PARTNER_FEATURES.length),
    fee: z.enum(['known', 'unknown']),
    reserve: z.enum(['none', 'required']),
    down: z.boolean(),
    rampQuote: z.enum(['live', 'expired']),
    rampFee: z.enum(['known', 'unknown']),
    custody: z.enum(['on', 'off']),
    nextReply: z.enum(['answered', 'lost']),
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
export function createTestPartnerRouter(bank: Pick<BankServices, 'testPartner'>, guard: Guard) {
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
          return { label: now.label, assetId: input.assetId, balance: formatAmount(now.amount!), asOf: now.asOf.toISOString() };
        }),
      ),
  });
}
