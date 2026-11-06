import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { SPEND_CATEGORIES, type SpendAnalytics, type SpendCategory, type SpendSummary } from './spend.js';

/**
 * BUDGETS AND MONTH COMPARISON (BK-acct-08, J-bank-16 #4, #5).
 *
 * A budget is a POLICY row: the person's monthly target for one spend category in one asset, and the share of it at
 * which they want an alert. What was spent is never stored here: every figure is the ledger fold `SpendAnalytics` makes
 * for the month, read each time. The alert shows once per month: the first read that finds the share reached returns
 * `new`, and once the page records it was shown (`budget-alert:<user>:<asset>:<category>:<YYYY-MM>`) every later read
 * that month returns `seen`.
 */

/** Deposits are money in, never spending, so no budget can be set on them. */
export const BUDGET_CATEGORIES = SPEND_CATEGORIES.filter((c) => c !== 'deposits') as Exclude<SpendCategory, 'deposits'>[];
export type BudgetCategory = (typeof BUDGET_CATEGORIES)[number];

export interface BudgetProgress {
  readonly assetId: string;
  readonly category: BudgetCategory;
  readonly period: string;
  readonly target: string;
  readonly spent: string;
  /** Spent over target, in basis points, floored. 8,000 is 80 percent. */
  readonly progressBps: number;
  readonly alertBps: number;
  /** `new` the first time this month the share is reached, `seen` once the page recorded it, `null` below the share. */
  readonly alert: 'new' | 'seen' | null;
  readonly alertShownAt: Date | null;
}

export interface MonthComparison {
  readonly assetId: string;
  readonly months: string[];
  readonly categories: Array<{
    category: SpendCategory;
    /** Outflow in each month, in the order asked. A month with no movement is "0". */
    byMonth: string[];
    /** Last month minus first month, signed. */
    change: string;
  }>;
  readonly totalOutflow: string[];
  readonly totalInflow: string[];
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const periodOf = (at: Date) => at.toISOString().slice(0, 7);
function monthRange(period: string): { from: Date; to: Date } {
  const [, y, m] = MONTH.exec(period)!;
  const from = new Date(Date.UTC(Number(y), Number(m) - 1, 1));
  // Exclusive, as every ledger history range is: the next month's first instant.
  const to = new Date(Date.UTC(Number(y), Number(m), 1));
  return { from, to };
}

export class BudgetService {
  constructor(
    private readonly sql: Sql,
    private readonly analytics: SpendAnalytics,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Sets (or changes) the person's budget for one category: a positive target and an alert share they chose. */
  async set(input: { userId: string; assetId: string; category: string; target: string; alertBps: number }): Promise<BudgetProgress> {
    if (!(BUDGET_CATEGORIES as readonly string[]).includes(input.category)) {
      throw new BankError(`${input.category} is not a spend category a budget can be set on`, 'bank.budget_invalid');
    }
    const target = parseAmount(input.target);
    if (target <= 0n) throw new BankError('A budget target is more than zero', 'bank.budget_invalid');
    if (!Number.isInteger(input.alertBps) || input.alertBps <= 0 || input.alertBps > 10_000) {
      throw new BankError('An alert share is between 1 and 10,000 basis points', 'bank.budget_invalid');
    }
    await this.sql`
      INSERT INTO bank.budgets (user_id, asset_id, category, target, alert_bps)
      VALUES (${input.userId}, ${input.assetId}, ${input.category}, ${formatAmount(target)}, ${input.alertBps})
      ON CONFLICT (user_id, asset_id, category)
      DO UPDATE SET target = EXCLUDED.target, alert_bps = EXCLUDED.alert_bps, updated_at = now()
    `;
    const all = await this.list(input.userId, input.assetId);
    return all.find((b) => b.category === input.category)!;
  }

  /** Every budget the person set in one asset, with this month's spend folded from the ledger. */
  async list(userId: string, assetId: string): Promise<BudgetProgress[]> {
    const period = periodOf(this.now());
    const rows = await this.sql<Array<{ category: BudgetCategory; target: string; alert_bps: number }>>`
      SELECT category, target::text AS target, alert_bps FROM bank.budgets
       WHERE user_id = ${userId} AND asset_id = ${assetId} ORDER BY category
    `;
    if (rows.length === 0) return [];
    const { from } = monthRange(period);
    const summary = await this.analytics.spendSummary({ userId, assetId, range: { from, to: this.now() } });
    const shown = await this.sql<Array<{ category: string; shown_at: Date }>>`
      SELECT category, shown_at FROM bank.budget_alert_notices
       WHERE user_id = ${userId} AND asset_id = ${assetId} AND period = ${period}
    `;
    return rows.map((row) => {
      const target = parseAmount(row.target);
      const spent: Amount = parseAmount(summary.outflowByCategory[row.category] ?? '0');
      const progressBps = Number((spent * 10_000n) / target);
      const seen = shown.find((s) => s.category === row.category) ?? null;
      const reached = progressBps >= row.alert_bps;
      return {
        assetId,
        category: row.category,
        period,
        target: formatAmount(target),
        spent: formatAmount(spent),
        progressBps,
        alertBps: row.alert_bps,
        alert: reached ? (seen ? 'seen' : 'new') : null,
        alertShownAt: seen?.shown_at ?? null,
      };
    });
  }

  /** Records that this month's alert for one budget was shown, once (`budget-alert:<user>:<asset>:<category>:<period>`). */
  async alertShown(input: { userId: string; assetId: string; category: string }): Promise<BudgetProgress> {
    const period = periodOf(this.now());
    const budget = (await this.list(input.userId, input.assetId)).find((b) => b.category === input.category);
    if (!budget) throw new BankError(`No budget is set for ${input.category}`, 'bank.budget_unset');
    if (budget.alert === null) return budget;
    await this.sql`
      INSERT INTO bank.budget_alert_notices (user_id, asset_id, category, period)
      VALUES (${input.userId}, ${input.assetId}, ${input.category}, ${period})
      ON CONFLICT (user_id, asset_id, category, period) DO NOTHING
    `;
    return (await this.list(input.userId, input.assetId)).find((b) => b.category === input.category)!;
  }

  /** This month's targets less this month's spend across the person's budgets in one asset. Refuses with none set. */
  async leftToSpend(
    userId: string,
    assetId: string,
  ): Promise<{ assetId: string; period: string; target: string; spent: string; left: string }> {
    const budgets = await this.list(userId, assetId);
    if (budgets.length === 0) throw new BankError('Left to spend needs a budget, and none is set', 'bank.budget_unset');
    const target = budgets.reduce((sum, b) => sum + parseAmount(b.target), 0n);
    const spent = budgets.reduce((sum, b) => sum + parseAmount(b.spent), 0n);
    const left = target - spent;
    return {
      assetId,
      period: budgets[0]!.period,
      target: formatAmount(target),
      spent: formatAmount(spent),
      left: left < 0n ? `-${formatAmount(-left)}` : formatAmount(left),
    };
  }

  /** Two to twelve months side by side, each category's outflow per month and its change, every figure from the ledger. */
  async compare(userId: string, assetId: string, months: readonly string[]): Promise<MonthComparison> {
    const current = periodOf(this.now());
    if (months.length < 2 || months.length > 12 || new Set(months).size !== months.length) {
      throw new BankError('A comparison takes two to twelve different months', 'bank.compare_months');
    }
    if (months.some((m) => !MONTH.test(m) || m > current)) {
      throw new BankError('Each month is YYYY-MM and none is in the future', 'bank.compare_months');
    }
    const summaries: SpendSummary[] = [];
    for (const month of months) {
      const { from, to } = monthRange(month);
      const end = month === current ? this.now() : to;
      summaries.push(await this.analytics.spendSummary({ userId, assetId, range: { from, to: end } }));
    }
    const signed = (v: Amount) => (v < 0n ? `-${formatAmount(-v)}` : formatAmount(v));
    return {
      assetId,
      months: [...months],
      categories: SPEND_CATEGORIES.filter((c) => c !== 'deposits').map((category) => {
        const byMonth = summaries.map((s) => s.outflowByCategory[category] ?? '0');
        return { category, byMonth, change: signed(parseAmount(byMonth[byMonth.length - 1]!) - parseAmount(byMonth[0]!)) };
      }),
      totalOutflow: summaries.map((s) => s.totalOutflow),
      totalInflow: summaries.map((s) => s.totalInflow),
    };
  }
}
