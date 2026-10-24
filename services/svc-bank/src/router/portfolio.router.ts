import { z } from 'zod';
import { bankValueOverTimeInputSchema, bankValueOverTimeSchema, router, scopedProcedure } from '@intafaced/contracts';
import { activityFailure } from '../activity/activity.router.js';
import { BALANCE_ENTRIES_DEFAULT_LIMIT, BALANCE_ENTRIES_MAX_LIMIT } from '../portfolio/portfolio-service.js';
import { portfolioSummaryOutput, balanceAccountsOutput, balanceBreakdownOutput, balanceEntriesOutput, allocationOutput } from './shared.js';
import { guard } from './errors.js';
import type { BankRouterContext } from './context.js';

export function createPortfolioRouter(c: BankRouterContext) {
  const { bank } = c;
  /**
   * PORTFOLIO (UI-SPEC §1.2, U3) — the one server-computed "Est. total value".
   *
   * Self-only: the owner is `ctx.principal.userId`, there is no input to name
   * anyone else. The rule (stablecoins at $1, last price of asset/USDT else
   * asset/USDC, `unpriced` otherwise, change as a price move on current holdings
   * and not P&L) is written once in `portfolio/valuation.ts`.
   */
  return router({
    summary: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z
          // Not strict: a smuggled owner id is stripped here, as it always was (portfolio.router.test.ts).
          .object({
            assetId: z.string().min(1).max(16).optional(),
            valueIn: z.enum(['usd', 'btc']).optional(),
            /** The customer's display currency (PF-overview-03). USD and BTC only; any other code refuses `bank.fx_rate_unset`. */
            displayCurrency: z.string().min(2).max(8).optional(),
            /** `combined` (default), `main`, or the id of one of the caller's named spaces. */
            scope: z.string().min(1).max(64).optional(),
          })
          .optional(),
      )
      .output(portfolioSummaryOutput)
      .query(async ({ ctx, input }) => guard(async () => bank.portfolio.summary(ctx.principal.userId, input ?? {}))),
    /** The priced holdings by asset class and by available / locked (PF-balances-02). Same prices and refusals as `summary`. */
    allocation: scopedProcedure('bank:read', { module: 'bank' })
      .output(allocationOutput)
      .query(async ({ ctx }) => guard(async () => bank.portfolio.allocation(ctx.principal.userId))),
    /**
     * What the caller's holdings were worth over a range, and the change-in-value bridge between its ends (J-portfolio-05
     * #6-#7). Read-only, self-only: the main account and the caller's own named Spaces, replayed from the ledger's holdings
     * history. A moment with a coin held and no price is missing, never zero.
     */
    valueOverTime: scopedProcedure('bank:read', { module: 'bank' })
      .input(bankValueOverTimeInputSchema)
      .output(bankValueOverTimeSchema)
      .query(async ({ ctx, input }) =>
        guard(async () =>
          bank.portfolio.valueOverTime(ctx.principal.userId, { from: input.from, ...(input.to === undefined ? {} : { to: input.to }) }),
        ),
      ),
    /** The wallet selector: `main` and each named Space the caller can narrow `balanceBreakdown` to. */
    balanceAccounts: scopedProcedure('bank:read', { module: 'bank' })
      .output(balanceAccountsOutput)
      .query(async ({ ctx }) => guard(async () => bank.portfolio.accounts(ctx.principal.userId))),
    /**
     * Each asset split into spendable and every lock kind with the claim behind it (PF-balances-01). Read-only, self-only,
     * ledger reads only; the parts add up to the total exactly.
     */
    balanceBreakdown: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z
          .object({
            scope: z.enum(['all', 'main']).optional(),
            /** `main` or the id of one named Space. Wins over `scope`. */
            accountId: z.union([z.literal('main'), z.string().guid()]).optional(),
            assetId: z.string().min(1).max(16).optional(),
          })
          .strict()
          .optional(),
      )
      .output(balanceBreakdownOutput)
      .query(async ({ ctx, input }) =>
        guard(async () =>
          bank.portfolio.balanceBreakdown(ctx.principal.userId, input?.scope ?? 'all', {
            ...(input?.accountId === undefined ? {} : { accountId: input.accountId }),
            ...(input?.assetId === undefined ? {} : { assetId: input.assetId }),
          }),
        ),
      ),
    /**
     * Every ledger entry behind one asset's spendable balance, with the sum check on top (PF-balances-01). Read-only,
     * self-only. A sum that differs from the live balance refuses `portfolio.entries_do_not_sum` with the gap.
     */
    balanceEntries: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z
          .object({
            assetId: z.string().min(1).max(16),
            /** `main` or the id of one named Space; absent = main and every Space. */
            accountId: z.union([z.literal('main'), z.string().guid()]).optional(),
            cursor: z.string().min(1).max(16).optional(),
            limit: z.number().int().min(1).max(BALANCE_ENTRIES_MAX_LIMIT).default(BALANCE_ENTRIES_DEFAULT_LIMIT),
          })
          .strict(),
      )
      .output(balanceEntriesOutput)
      .query(async ({ ctx, input }) => {
        try {
          return await bank.portfolio.balanceEntries(ctx.principal.userId, {
            assetId: input.assetId,
            ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
            limit: input.limit,
          });
        } catch (err) {
          return activityFailure(err);
        }
      }),
  });
}
