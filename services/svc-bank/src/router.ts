import { z } from 'zod';
import {
  router,
  publicProcedure,
  scopedProcedure,
  PAY_CUSTODY_DEPOSIT_RECORDS_MAX_LIMIT,
  PAY_CUSTODY_DEPOSIT_STATUSES,
  payCustodyDepositRecordSchema,
} from '@intafaced/contracts';
import { requireBankJobService } from './ops-job-hmac.js';
import type { BankServices } from './bank-service.js';
import { createLimitsRouter } from './transfers/limit-requests.js';
import { createActivityRouter } from './activity/activity.router.js';
import { createStatementsRouter } from './statements/statement.router.js';
import { createAccountDetailsRouter, createEligibilityRouter } from './account-details/account-details.router.js';
import { createAccountsRouter, createCurrenciesRouter } from './account-home/account-home.router.js';
import { createAddMoneyRouter } from './ramps/add-money.router.js';
import { createLinkedAccountsRouter } from './linked-accounts/linked-accounts.router.js';
import { createCashOutRouter } from './cash-out/cash-out.router.js';
import { createRailSendsRouter } from './rail-sends/rail-sends.router.js';
import { createWorkItemsRouter } from './home/work-items.js';
import { createCreditCardPreviewRouter } from './loans/credit-card-preview.router.js';
import { createBillsRouter, createGlobalRouter } from './personal-pay/router.js';
import { createPersonalRequestRouter } from './transfers/personal-request.router.js';
import { amountString, type BankRouterOptions } from './router/shared.js';
import { guard } from './router/errors.js';
import { createRouterContext } from './router/context.js';
import { createSpacesRouter } from './router/spaces.router.js';
import { createTransfersRouter } from './router/transfers.router.js';
import { createEarnRouter } from './router/earn.router.js';
import { createAnalyticsRouter } from './router/analytics.router.js';
import { createPortfolioRouter } from './router/portfolio.router.js';
import { createLoansRouter } from './router/loans.router.js';
import { createCardsRouter } from './router/cards.router.js';
import { createOpsRouter } from './router/ops.router.js';
import { createAutoInvestRouter } from './router/auto-invest.router.js';
import { createRampsRouter } from './router/ramps.router.js';
import { createBusinessRouter } from './router/business.router.js';

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
  const portfolio = createPortfolioRouter(c);
  const loans = createLoansRouter(c);
  const cards = createCardsRouter(c);
  const ops = createOpsRouter(c);
  const autoInvest = createAutoInvestRouter(c);
  const ramps = createRampsRouter(c);
  const business = createBusinessRouter(c);

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
    deposits: router({
      /**
       * Assets custody says can be paid in. A blank port refuses
       * `bank.deposit_custody_unset`. Minimums are the port's decimals.
       */
      assets: scopedProcedure('bank:read', { module: 'bank' })
        .output(
          z.object({
            assets: z.array(
              z.object({
                assetId: z.string(),
                networks: z.array(
                  z.object({
                    id: z.string(),
                    label: z.string(),
                    minimumDeposit: amountString,
                    confirmationsRequired: z.number().int().nonnegative(),
                    estimatedArrivalMinutes: z.number().int().nonnegative(),
                  }),
                ),
              }),
            ),
          }),
        )
        .query(() => guard(async () => bank.deposits.assets())),

      /**
       * Idempotent on (asset, network). The address is the one custody issued.
       * A blank port refuses before any row.
       */
      address: scopedProcedure('bank:write', { module: 'bank' })
        .input(z.object({ assetId: z.string().min(1).max(16), networkId: z.string().min(1).max(32) }))
        .output(
          z.object({
            assetId: z.string(),
            networkId: z.string(),
            address: z.string(),
            memo: z.string().nullable(),
            qrPayload: z.string().nullable(),
          }),
        )
        .mutation(async ({ ctx, input }) =>
          guard(async () => bank.deposits.address({ userId: ctx.principal.userId, assetId: input.assetId, networkId: input.networkId })),
        ),

      /**
       * Incoming deposits custody is still confirming. A blank port refuses.
       * An empty list means custody is connected and nothing is incoming.
       */
      pending: scopedProcedure('bank:read', { module: 'bank' })
        .output(
          z.object({
            items: z.array(
              z.object({
                id: z.string(),
                assetId: z.string(),
                networkId: z.string(),
                amount: amountString,
                confirmations: z.number().int().nonnegative(),
                confirmationsRequired: z.number().int().nonnegative().nullable(),
              }),
            ),
          }),
        )
        .query(async ({ ctx }) => guard(async () => bank.deposits.pending(ctx.principal.userId))),

      /**
       * The customer's own deposit history with its state and reason (W-deposit-05). Filters: coin, network, status, tx id,
       * address. A page with the true total. A blank port refuses `bank.deposit_custody_unset`.
       */
      list: scopedProcedure('bank:read', { module: 'bank' })
        .input(
          z
            .object({
              assetId: z.string().min(1).max(16).optional(),
              networkId: z.string().min(1).max(32).optional(),
              status: z.enum(PAY_CUSTODY_DEPOSIT_STATUSES).optional(),
              txId: z.string().min(1).max(128).optional(),
              address: z.string().min(1).max(256).optional(),
              offset: z.number().int().min(0).max(1_000_000).default(0),
              limit: z.number().int().min(1).max(PAY_CUSTODY_DEPOSIT_RECORDS_MAX_LIMIT).default(50),
            })
            .prefault({}),
        )
        .output(z.object({ items: z.array(payCustodyDepositRecordSchema), total: z.number().int().nonnegative() }))
        .query(async ({ ctx, input }) => guard(async () => bank.deposits.list(ctx.principal.userId, input))),
    }),
    autoInvest,
    business,
    analytics,
    portfolio,
    activity: createActivityRouter(bank),
    statements: createStatementsRouter(bank),
    accountDetails: createAccountDetailsRouter(bank, guard),
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
    /** BK-loan-10 credit card preview: TEST rows and typed Preview refusals only. */
    creditCard: createCreditCardPreviewRouter(),
    bills: createBillsRouter(bank, stepUp),
    global: createGlobalRouter(bank, stepUp),
    personalRequest: createPersonalRequestRouter(bank, guard),
    limits: createLimitsRouter(limitRequests, guard),
    ops,
  });
}

export type BankRouter = ReturnType<typeof createBankRouter>;
