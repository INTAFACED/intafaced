import { z } from 'zod';
import { ASSET_ACTIONS, ASSET_STATES, REGISTRY_ASSET_KINDS } from '@intafaced/contracts/asset-registry';
import { router, publicProcedure, scopedProcedure } from '@intafaced/contracts/trpc';
import {
  BANK_DEPOSITS_ADDRESS,
  BANK_DEPOSITS_ADDRESSES_CREATE,
  BANK_DEPOSITS_ADDRESSES_LABEL,
  BANK_DEPOSITS_ADDRESSES_LIST,
  BANK_DEPOSITS_ASSETS,
  BANK_DEPOSITS_LIST,
  BANK_DEPOSITS_PENDING,
} from '@intafaced/contracts/bank-deposit-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { requireBankJobService } from './ops-job-hmac.js';
import type { BankServices } from './bank-service.js';
import { createLimitsRouter } from './transfers/limit-requests.js';
import { createActivityRouter } from './activity/activity.router.js';
import { createStatementsRouter } from './statements/statement.router.js';
import { createAccountDetailsRouter, createEligibilityRouter } from './account-details/account-details.router.js';
import { createSalaryRouter } from './salary/salary.router.js';
import { createPayYourselfRouter } from './pay-yourself/pay-yourself.router.js';
import { createOwnMovesRouter } from './own-moves/own-moves.router.js';
import { createAccountsRouter, createCurrenciesRouter } from './account-home/account-home.router.js';
import { createAddMoneyRouter } from './ramps/add-money.router.js';
import { createLinkedAccountsRouter } from './linked-accounts/linked-accounts.router.js';
import { createCashOutRouter } from './cash-out/cash-out.router.js';
import { createRailSendsRouter } from './rail-sends/rail-sends.router.js';
import { createSafetyRouter } from './safety/safety.router.js';
import { createBankAccountRouter } from './onboarding/bank-account.router.js';
import { createWorkItemsRouter } from './home/work-items.js';
import { createCreditCardPreviewRouter } from './loans/credit-card-preview.router.js';
import { createCreditPreviewsRouter } from './loans/credit-previews.js';
import { createBillsRouter, createGlobalRouter } from './personal-pay/router.js';
import { createPersonalRequestRouter } from './transfers/personal-request.router.js';
import { createDirectDebitsRouter } from './direct-debits/direct-debits.router.js';
import { createCalendarRouter } from './calendar/calendar.router.js';
import { createRulesRouter } from './rules/rules.router.js';
import { amountString, type BankRouterOptions } from './router/shared.js';
import { bankRefusal, guard } from './router/errors.js';
import { createRouterContext } from './router/context.js';
import { createSpacesRouter } from './router/spaces.router.js';
import { createTransfersRouter } from './router/transfers.router.js';
import { createEarnRouter } from './router/earn.router.js';
import { createAnalyticsRouter } from './router/analytics.router.js';
import { createLimitsRouters } from './router/limits.router.js';
import { createPortfolioRouter } from './router/portfolio.router.js';
import { createLoansRouter } from './router/loans.router.js';
import { createCardsRouter } from './router/cards.router.js';
import { createOpsRouter } from './router/ops.router.js';
import { createAutoInvestRouter } from './router/auto-invest.router.js';
import { createSorterRouter } from './sorter/sorter.router.js';
import { createTestPartnerRouter } from './partner/test-partner.router.js';
import { createHoldsRouter } from './holds/holds.router.js';
import { createSharedPotsRouter } from './spaces/shared-pots.router.js';
import { createRecoveryRouter } from './recovery/recovery.router.js';
import { createRampsRouter } from './router/ramps.router.js';
import { createBusinessRouter } from './router/business.router.js';
import { createBusinessTeamRouter } from './router/business-team.router.js';
import { createBusinessBillsRouter } from './router/business-bills.router.js';
import { createBusinessPayoutsRouter } from './router/business-payouts.router.js';
import { createBusinessCardsRouter } from './router/business-cards.router.js';
import { createBusinessBooksRouter } from './router/business-books.router.js';
import { createBankApiRouter } from './router/bank-api.router.js';
import { BANK_CASH_LEG_CARRY, BANK_CASH_LEG_OFFERS, BANK_CASH_LEG_READ } from '@intafaced/contracts/bank-cash-leg-procedures';
import { presentCashLeg, presentCashLegOffers } from './partner/cash-leg.js';
import { parseAmount as parseCashAmount } from '@intafaced/ledger-client';

/**
 * svc-bank's API.
 *
 * Two things to notice about what is NOT here.
 *
 * First, there is no procedure that writes a balance, because there is no
 * balance to write. `spaces.list` returns figures it just read from the ledger;
 * they are outputs, never inputs.
 *
 * Second, the scheduled jobs (standing-order runner, accrual, risk sweep,
 * auto-invest, pending resume) are NOT user-callable and not treasury-session
 * callable. They are HMAC as `svc-bank`, matching POST /internal/jobs/*. A
 * user able to trigger "run every due transfer" is a user able to choose when
 * other people's money moves.
 */

export type { BankRouterOptions } from './router/shared.js';

/** HTTP job twin: HMAC as svc-bank. Session admin:treasury is 401 unsigned. */
const jobProcedure = publicProcedure.use(({ ctx, next }) => {
  requireBankJobService(ctx.service);
  return next({ ctx });
});
export type JobProcedure = typeof jobProcedure;

export function createBankRouter(bank: BankServices, options: BankRouterOptions = {}) {
  const c = createRouterContext(bank, options, { jobProcedure });
  const { limitRequests, stepUp } = c;
  const spaces = createSpacesRouter(c);
  const transfers = createTransfersRouter(c);
  const earn = createEarnRouter(c);
  const analytics = createAnalyticsRouter(c);
  const limitsTables = createLimitsRouters(c);
  const portfolio = createPortfolioRouter(c);
  const loans = createLoansRouter(c);
  const cards = createCardsRouter(c);
  const ops = createOpsRouter(c);
  const autoInvest = createAutoInvestRouter(c);
  const ramps = createRampsRouter(c);
  const business = createBusinessRouter(c);
  const businessTeam = createBusinessTeamRouter(c);
  const businessBills = createBusinessBillsRouter(c);
  const businessPayouts = createBusinessPayoutsRouter(c);
  const businessCards = createBusinessCardsRouter(c);
  const businessBooks = createBusinessBooksRouter(c);
  const bankApi = createBankApiRouter(c);

  return router({
    health: publicProcedure
      .output(z.object({ ok: z.boolean(), service: z.literal('svc-bank') }))
      .query(() => ({ ok: true, service: 'svc-bank' as const })),
    /**
     * Paycheck deposit into the bank. Refuses until a paycheck rail exists.
     * The amount is not credited. Business payroll is a different action.
     */
    directDeposit: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ amount: amountString.optional() }).optional())
      .output(z.object({ deposit: z.null() }))
      .mutation(() =>
        guard(async () => {
          bank.spaces.directDeposit();
          return { deposit: null };
        }),
      ),
    spaces,
    transfers,
    /**
     * PP-money-balance-04: the published personal-send fee schedule. No rows → `published: false`
     * (the page says no schedule is published); a published zero is `free`, never inferred from blank.
     */
    fees: router({
      /** BK-acct-04 (J-bank-16 #6): the owner's account fee table; none published says "not set". */
      account: limitsTables.accountFees,
      partner: limitsTables.partnerLimits,
      schedule: router({
        get: scopedProcedure('bank:read', { module: 'bank' })
          .output(
            z.object({
              published: z.boolean(),
              entries: z.array(
                z.object({
                  assetId: z.string(),
                  fee: amountString,
                  free: z.boolean(),
                  feeBlocker: z.literal('bank.personal_transfer_fee_unwired').nullable(),
                  publishedAt: z.string(),
                }),
              ),
            }),
          )
          .query(() => guard(() => bank.personalPay.feeSchedule())),
      }),
    }),
    earn,
    loans,
    cards,
    ramps,
    assets: router({
      /**
       * W-balances-05: svc-ledger's supported asset and network list, every state, retired included, so history that
       * names a retired asset still resolves. The same rows the address book offers and the deposit catalogue is narrowed
       * to. No registry, or an unreadable one, refuses `bank.asset_registry_unavailable`; never an empty list.
       */
      list: scopedProcedure('bank:read', { module: 'bank' })
        .output(
          z.object({
            assets: z.array(
              z
                .object({
                  assetId: z.string(),
                  kind: z.enum(REGISTRY_ASSET_KINDS),
                  precision: z.number().int().nonnegative(),
                  networks: z.array(
                    z
                      .object({
                        networkId: z.string(),
                        label: z.string(),
                        contract: z.string().nullable(),
                        links: z.array(z.object({ label: z.string(), url: z.string() }).strict()),
                      })
                      .strict(),
                  ),
                  defaultNetworkId: z.string().nullable(),
                  allowedActions: z.array(z.enum(ASSET_ACTIONS)),
                  state: z.enum(ASSET_STATES),
                })
                .strict(),
            ),
          }),
        )
        .query(() => guard(async () => ({ assets: await bank.supportedAssets.list() }))),
    }),
    // The partner's cash leg of a cash-through-a-coin convert (J-cex-spot-11 #11), asked by svc-trade as the person.
    convertCash: router({
      offers: mountRecord(
        BANK_CASH_LEG_OFFERS,
        ({ ctx }) => guard(async () => presentCashLegOffers(await bank.cashLegs.offers(ctx.principal.userId))),
        bankRefusal,
      ),
      carry: mountRecord(
        BANK_CASH_LEG_CARRY,
        ({ ctx, input }) =>
          guard(async () =>
            presentCashLeg(
              await bank.cashLegs.carry(ctx.principal.userId, {
                key: input.legKey,
                cash: input.cash,
                coin: input.coin,
                spend: parseCashAmount(input.spend),
                least: parseCashAmount(input.least),
                venue: { venueId: input.venue.venueId, owner: input.venue.owner.toLowerCase() },
              }),
            ),
          ),
        bankRefusal,
      ),
      leg: mountRecord(
        BANK_CASH_LEG_READ,
        ({ ctx, input }) =>
          guard(async () => {
            const leg = await bank.cashLegs.leg(ctx.principal.userId, input.legKey);
            return { leg: leg ? presentCashLeg(leg) : null };
          }),
        bankRefusal,
      ),
    }),
    deposits: router({
      assets: mountRecord(BANK_DEPOSITS_ASSETS, () => guard(async () => bank.deposits.assets()), bankRefusal),
      address: mountRecord(
        BANK_DEPOSITS_ADDRESS,
        ({ ctx, input }) =>
          guard(async () => bank.deposits.address({ userId: ctx.principal.userId, assetId: input.assetId, networkId: input.networkId })),
        bankRefusal,
      ),
      addresses: router({
        list: mountRecord(
          BANK_DEPOSITS_ADDRESSES_LIST,
          ({ ctx, input }) => guard(async () => bank.deposits.addresses(ctx.principal.userId, input)),
          bankRefusal,
        ),
        create: mountRecord(
          BANK_DEPOSITS_ADDRESSES_CREATE,
          ({ ctx, input }) => guard(async () => bank.deposits.createAddress({ userId: ctx.principal.userId, ...input })),
          bankRefusal,
        ),
        label: mountRecord(
          BANK_DEPOSITS_ADDRESSES_LABEL,
          ({ ctx, input }) => guard(async () => bank.deposits.labelAddress({ userId: ctx.principal.userId, ...input })),
          bankRefusal,
        ),
      }),
      pending: mountRecord(BANK_DEPOSITS_PENDING, ({ ctx }) => guard(async () => bank.deposits.pending(ctx.principal.userId)), bankRefusal),
      list: mountRecord(
        BANK_DEPOSITS_LIST,
        ({ ctx, input }) => guard(async () => bank.deposits.list(ctx.principal.userId, input)),
        bankRefusal,
      ),
    }),
    autoInvest,
    business,
    businessTeam,
    businessBills,
    businessPayouts,
    businessCards,
    businessBooks,
    bankApi,
    analytics,
    plans: limitsTables.plans,
    partnerHolds: limitsTables.partnerHolds,
    dormancy: limitsTables.dormancy,
    portfolio,
    activity: createActivityRouter(bank),
    statements: createStatementsRouter(bank),
    accountDetails: createAccountDetailsRouter(bank, guard),
    /** J-bank-30: salary paid in by direct deposit, at the partner bank. `rail.bank` while no payroll network is wired. */
    salary: createSalaryRouter(bank, guard),
    /** J-bank-31: pay yourself from your trading, one venue withdrawal to your own partner account. */
    payYourself: createPayYourselfRouter(bank, guard),
    /** J-derivatives-25: moves between the person's own spending and trading accounts, each leg sent once. */
    ownMoves: createOwnMovesRouter(c),
    accounts: createAccountsRouter(bank, guard),
    currencies: createCurrenciesRouter(bank, guard),
    addMoney: createAddMoneyRouter(bank, guard),
    /** Home's work list (HM-dashboard-03): the bank's own kinds for the signed person. */
    workItems: createWorkItemsRouter(() => bank.transferOps.sql, guard),
    eligibility: createEligibilityRouter(bank, guard),
    linkedAccounts: createLinkedAccountsRouter(bank, guard),
    cashOut: createCashOutRouter(bank, guard),
    /** BK-xfer-02: send to a bank account over a bank rail. Kept refused with `rail.bank`; nothing is held or posted. */
    railSends: createRailSendsRouter(bank, guard),
    /** BK-safe-01: why a blocked region's transfer refuses, in the owner's wording. Public, outside the region gate. */
    safety: createSafetyRouter({
      blockedRegionNotice: () => bank.blockedRegionNotice,
      transferSent: (userId, transferId) => bank.personalPay.sentBy(userId, transferId),
      guard,
    }),
    /** BK-loan-10 credit card preview: TEST rows and typed Preview refusals only. */
    creditCard: createCreditCardPreviewRouter(),
    /** J-bank-12 overdraft, personal and business term loan, bureau, loan schedule and revolving credit previews: TEST rows and typed Preview refusals only. */
    creditPreviews: createCreditPreviewsRouter(),
    bills: createBillsRouter(bank, stepUp),
    global: createGlobalRouter(bank, stepUp),
    personalRequest: createPersonalRequestRouter(bank, guard),
    /** BK-xfer-11: Direct Debit mandates, block and unblock, refund requests. `rail.bank` while no scheme is wired. */
    directDebits: createDirectDebitsRouter(bank, guard),
    /** BK-acct-10: the money calendar. Read only. */
    calendar: createCalendarRouter(bank, guard),
    /** BK-acct-10: the payment reminder rule; money-moving rules refuse `bank.rule_terms_unset`. */
    rules: createRulesRouter(bank, guard),
    /** BK-pots-03: the income sorter; blank owner terms refuse `bank.sorter_terms_unset`. */
    sorter: createSorterRouter(bank, guard),
    /** CUSTODY-DELTA §4: the person's own TEST partner bank and ramp switches; refuses `bank.test_partner_off` off the TEST stack. */
    testPartner: createTestPartnerRouter(bank, guard),
    /** BK-acct-05, BK-acct-06 (J-bank-17): onboarding, information requests, reviews, closure and data rights at the partner. */
    bankAccount: createBankAccountRouter(bank, guard),
    /** PP-money-balance-05: payments from strangers held for the person to accept; a blank period refuses holding. */
    holds: createHoldsRouter(bank, guard),
    /** BK-acct-09: pots shared with viewers and contributors; blank owner values refuse `bank.joint_unset`. */
    sharedPots: createSharedPotsRouter(bank, guard),
    recovery: createRecoveryRouter(bank, guard),
    limits: createLimitsRouter(limitRequests, guard),
    ops,
  });
}

export type BankRouter = ReturnType<typeof createBankRouter>;
