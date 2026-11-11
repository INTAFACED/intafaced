/**
 * Budgets, left to spend and month comparison (BK-acct-08, J-bank-16 #4, #5), against Postgres.
 *
 * PG-hard: a missing database fails the suite. CI uses TEST_DATABASE_URL; without it, Testcontainers `postgres:16-alpine`.
 * Spend comes from a stand-in for the ledger fold (`SpendAnalytics.spendSummary`, tested on its own in
 * spend-categorise.test.ts), so each case states the month's outflow it reads.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BudgetService } from './budgets.js';
import { SPEND_CATEGORIES, type SpendAnalytics, type SpendSummary } from './spend.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

/** A month's outflow by category, as the ledger fold would report it; months not listed moved nothing. */
function fold(byMonth: Record<string, Partial<Record<string, string>>>): SpendAnalytics {
  return {
    async spendSummary({ userId, assetId, range }) {
      const month = range.from.toISOString().slice(0, 7);
      const out = byMonth[month] ?? {};
      const outflowByCategory = Object.fromEntries(SPEND_CATEGORIES.map((c) => [c, out[c] ?? '0'])) as SpendSummary['outflowByCategory'];
      return {
        userId,
        assetId,
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        outflowByCategory,
        totalOutflow: out.total ?? '0',
        totalInflow: out.inflow ?? '0',
        net: '0',
        movements: 0,
      };
    },
  } as SpendAnalytics;
}

describe('budgets by category (J-bank-16 #4 #5, PG-hard)', () => {
  let stop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;
  let user: string;
  const now = new Date('2026-11-20T12:00:00Z');

  beforeAll(async () => {
    const admin = await openAdmin();
    stop = admin.stop;
    db = await createTestDatabase({ service: 'bank', url: admin.url, migrations });
  }, 180_000);
  afterAll(async () => {
    await db?.drop();
    await stop();
  }, 60_000);
  beforeEach(() => {
    user = randomUUID();
  });

  const service = (spend: Record<string, Partial<Record<string, string>>>, at = now) => new BudgetService(db.sql, fold(spend), () => at);

  it('reads 80 percent for a spend of 80 on a budget of 100, and the alert is new once, then seen for the rest of the month', async () => {
    const budgets = service({ '2026-11': { transfers: '80', deposits: '150.25', total: '80' } });
    const set = await budgets.set({ userId: user, assetId: 'USDT', category: 'transfers', target: '100', alertBps: 8_000 });
    expect(set).toMatchObject({ target: '100', spent: '80', progressBps: 8_000, alert: 'new', period: '2026-11' });
    const shown = await budgets.alertShown({ userId: user, assetId: 'USDT', category: 'transfers' });
    expect(shown.alert).toBe('seen');
    const again = await budgets.alertShown({ userId: user, assetId: 'USDT', category: 'transfers' });
    expect(again.alertShownAt?.getTime()).toBe(shown.alertShownAt?.getTime());
    expect((await budgets.list(user, 'USDT'))[0]!.alert).toBe('seen');
    // A new month is a new period: the alert is new again once the share is reached.
    const december = service({ '2026-12': { transfers: '90', total: '90' } }, new Date('2026-12-02T00:00:00Z'));
    expect((await december.list(user, 'USDT'))[0]).toMatchObject({ period: '2026-12', alert: 'new' });
  });

  it('shows no alert below the share the person chose', async () => {
    const budgets = service({ '2026-11': { transfers: '79.99', total: '79.99' } });
    const set = await budgets.set({ userId: user, assetId: 'USDT', category: 'transfers', target: '100', alertBps: 8_000 });
    expect(set).toMatchObject({ progressBps: 7_999, alert: null });
  });

  it('refuses a budget on deposits, a zero target or an alert share out of range', async () => {
    const budgets = service({});
    const base = { userId: user, assetId: 'USDT', target: '100', alertBps: 8_000 };
    await expect(budgets.set({ ...base, category: 'deposits' })).rejects.toMatchObject({ code: 'bank.budget_invalid' });
    await expect(budgets.set({ ...base, category: 'transfers', target: '0' })).rejects.toMatchObject({ code: 'bank.budget_invalid' });
    await expect(budgets.set({ ...base, category: 'transfers', alertBps: 0 })).rejects.toMatchObject({ code: 'bank.budget_invalid' });
  });

  it('left to spend is the targets less the spend, and refuses bank.budget_unset with no budget', async () => {
    const budgets = service({ '2026-11': { transfers: '80', fees: '2.5', total: '82.5' } });
    await expect(budgets.leftToSpend(user, 'USDT')).rejects.toMatchObject({ code: 'bank.budget_unset' });
    await budgets.set({ userId: user, assetId: 'USDT', category: 'transfers', target: '100', alertBps: 8_000 });
    await budgets.set({ userId: user, assetId: 'USDT', category: 'fees', target: '10', alertBps: 9_000 });
    expect(await budgets.leftToSpend(user, 'USDT')).toEqual({
      assetId: 'USDT',
      period: '2026-11',
      target: '110',
      spent: '82.5',
      left: '27.5',
    });
  });

  it('compares months side by side, a month with no movement is zero, and refuses a future or single month', async () => {
    const budgets = service({ '2026-11': { transfers: '80', total: '80' } });
    const c = await budgets.compare(user, 'USDT', ['2026-10', '2026-11']);
    expect(c.months).toEqual(['2026-10', '2026-11']);
    expect(c.categories.find((r) => r.category === 'transfers')).toEqual({ category: 'transfers', byMonth: ['0', '80'], change: '80' });
    expect(c.categories.find((r) => r.category === 'fees')).toEqual({ category: 'fees', byMonth: ['0', '0'], change: '0' });
    expect(c.categories.some((r) => r.category === 'deposits')).toBe(false);
    await expect(budgets.compare(user, 'USDT', ['2026-11'])).rejects.toMatchObject({ code: 'bank.compare_months' });
    await expect(budgets.compare(user, 'USDT', ['2026-11', '2026-12'])).rejects.toMatchObject({ code: 'bank.compare_months' });
  });
});
