import type { BankRoot } from '../bank-root.js';
import type { SpaceService } from '../spaces/space-service.js';
import { BudgetService } from './budgets.js';
import { SpendAnalytics } from './spend.js';

/** Spend analytics and budgets: reads only. An area of svc-bank (`area-chain.ts`). */
export interface AnalyticsServices {
  /** A READ port over the ledger and no writer at all. */
  readonly analytics: SpendAnalytics;
  /** BK-acct-08: budgets by category (policy rows), left to spend and month comparison, every figure a fold of the person's lines. */
  readonly budgets: BudgetService;
}

export function composeAnalyticsArea(root: BankRoot, made: { readonly spaces: SpaceService }): AnalyticsServices {
  const analytics = new SpendAnalytics(made.spaces, root.history, root.custody);
  return { analytics, budgets: new BudgetService(root.sql, analytics) };
}
