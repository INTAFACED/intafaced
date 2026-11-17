import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import { formatAmount } from '@intafaced/ledger-client';
import type { BankServices } from '../bank-service.js';
import { profileField } from '../account-home/profile.js';
import { ACCOUNT_DETAIL_REQUEST_STATES } from '../account-details/account-details.js';
import type { SalaryCredit, SalaryRails } from './salary-service.js';

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * `bank.salary.*` (J-bank-30): the account details salary is paid to with the employer form (BK-salary-01), and the
 * person's salary credits with their split, returns and reversals (BK-salary-03). Reads only: the split is the income
 * sorter's (`bank.sorter.*`, BK-salary-02), and credits and reversals are the payroll network's signed job calls. While no
 * network is wired every call refuses `rail.bank`. Nothing here posts to the ledger.
 */

const detailSet = z.object({
  id: z.string(),
  accountNumber: z.string().nullable(),
  sortCode: z.string().nullable(),
  routingNumber: z.string().nullable(),
  bsb: z.string().nullable(),
  iban: z.string().nullable(),
  bic: z.string().nullable(),
  partnerBank: z.string(),
  restrictions: z.array(z.string()),
});

const legView = z.object({
  position: z.number().int(),
  spaceId: z.string(),
  amount: z.string(),
  status: z.enum(['pending', 'settled', 'rejected', 'unsplit']),
  moveId: z.string().nullable(),
  rejectionCode: z.string().nullable(),
  unsplitMoveId: z.string().nullable(),
});

export const salaryCreditView = z.object({
  networkId: z.string(),
  assetId: z.string(),
  amount: z.string(),
  originatorName: z.string(),
  state: z.enum(['pending', 'received', 'returned', 'reversed']),
  refusalCode: z.string().nullable(),
  creditMoveId: z.string().nullable(),
  reversalMoveId: z.string().nullable(),
  createdAt: z.string(),
  receivedAt: z.string().nullable(),
  reversedAt: z.string().nullable(),
  legs: z.array(legView),
});

export function creditView(credit: SalaryCredit): z.infer<typeof salaryCreditView> {
  return {
    networkId: credit.networkId,
    assetId: credit.assetId,
    amount: formatAmount(credit.amount),
    originatorName: credit.originatorName,
    state: credit.state,
    refusalCode: credit.refusalCode,
    creditMoveId: credit.creditMoveId,
    reversalMoveId: credit.reversalMoveId,
    createdAt: credit.createdAt.toISOString(),
    receivedAt: credit.receivedAt?.toISOString() ?? null,
    reversedAt: credit.reversedAt?.toISOString() ?? null,
    legs: credit.legs.map((leg) => ({
      position: leg.position,
      spaceId: leg.spaceId,
      amount: formatAmount(leg.amount),
      status: leg.status,
      moveId: leg.moveId,
      rejectionCode: leg.rejectionCode,
      unsplitMoveId: leg.unsplitMoveId,
    })),
  };
}

/** The job doors' answer: the credit as it now stands, and whether this call was a replay of the same network id. */
export function salaryView(result: { credit: SalaryCredit; replayed: boolean }) {
  return { credit: creditView(result.credit), replayed: result.replayed };
}

export const salaryRailsOutput = z.object({
  partner: z
    .object({
      label: z.string(),
      asOf: z.string(),
      lines: z.array(
        z.object({
          currency: z.string(),
          network: z.object({ credits: z.string(), reversals: z.string() }).nullable(),
          app: z.object({ credits: z.string(), reversals: z.string() }),
          matches: z.boolean().nullable(),
          difference: z.string().nullable(),
        }),
      ),
    })
    .nullable(),
});

export function railsView(rails: SalaryRails | null): z.infer<typeof salaryRailsOutput> {
  if (!rails) return { partner: null };
  return {
    partner: {
      label: rails.label,
      asOf: rails.asOf.toISOString(),
      lines: rails.lines.map((line) => ({
        currency: line.currency,
        network: line.network && { credits: formatAmount(line.network.credits), reversals: formatAmount(line.network.reversals) },
        app: { credits: formatAmount(line.app.credits), reversals: formatAmount(line.app.reversals) },
        matches: line.matches,
        difference: line.difference === null ? null : formatAmount(line.difference),
      })),
    },
  };
}

export function createSalaryRouter(bank: Pick<BankServices, 'salary' | 'profiles'>, guard: Guard) {
  return router({
    /** The details salary is paid to, per owner-listed currency, and the name the partner holds the account in. */
    details: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ profile: profileField }).strict().optional())
      .output(
        z.object({
          partnerBank: z.string(),
          network: z.string(),
          holderName: z.string().nullable(),
          currencies: z.array(
            z.object({
              currency: z.string(),
              state: z.enum(['unavailable', ...ACCOUNT_DETAIL_REQUEST_STATES]),
              blocker: z.literal('rail.bank').nullable(),
              sets: z.array(detailSet),
            }),
          ),
        }),
      )
      .query(({ ctx, input }) =>
        guard(async () => {
          await bank.profiles.personalOnly(ctx.principal.userId, input?.profile);
          const details = await bank.salary.details(ctx.principal.userId);
          return { ...details, currencies: [...details.currencies] };
        }),
      ),

    /** The employer form for one currency, as fields and as the text the person downloads. */
    form: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ currency: z.string().trim().length(3), profile: profileField }).strict())
      .output(
        z.object({
          currency: z.string(),
          holderName: z.string(),
          partnerBank: z.string(),
          accountNumber: z.string().nullable(),
          sortCode: z.string().nullable(),
          routingNumber: z.string().nullable(),
          iban: z.string().nullable(),
          bic: z.string().nullable(),
          reference: z.string(),
          text: z.string(),
        }),
      )
      .query(({ ctx, input }) =>
        guard(async () => {
          await bank.profiles.personalOnly(ctx.principal.userId, input.profile);
          return bank.salary.form(ctx.principal.userId, input.currency);
        }),
      ),

    /** The person's salary credits, newest first: received, returned or reversed, each with its split. */
    credits: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ limit: z.number().int().min(1).max(100) }).strict())
      .output(z.array(salaryCreditView))
      .query(({ ctx, input }) => guard(async () => (await bank.salary.list(ctx.principal.userId, input.limit)).map(creditView))),
  });
}
