// World: none
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, expect } from './journey.mjs';
import { api, fromUnits, fund, journeyState, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-bank-16, in the running app (docs/roadmap/journeys.json): I see where my money goes: statements, insights, limits
// and fees. One TEST account, signed up, verified and funded on this stack with TEST USDT in two deposits this month, is
// the person. The stack posts every line now, so the month with the person's activity is this month: for #1 the
// browser's clock is set to the first minute of next month, so this month is a month that is over to the person, as it
// would be to anyone downloading it then. The bank reads the lines as they stand.
// Steps 1 to 3 (BK-acct-07): a month's PDF statement with every posted line, its hash proof and the same per-coin total
// the activity list shows for those days, and a range across months refused; a search of the activity, and a bank
// letter refused `rail.bank` (no banking partner); tax statements refused `vendor.tax` (no tax provider).
// Steps 4 and 5 (BK-acct-08): after a TEST payment of 80 USDT to a second TEST person, a budget of 100 on transfers with
// an alert at 80 percent reads 80 percent with the alert once per month, deposits count as money in, and two months
// compare side by side with left to spend. Steps 6 (BK-acct-04) and 7 (RC-bank-01) are not built yet: each fails fast.
const J = 'J-bank-16';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

function person() {
  const { who } = run.read();
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

const utcDay = (at) => at.toISOString().slice(0, 10);
const thisMonth = () => new Date().toISOString().slice(0, 7);
const monthStart = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const nextMonthStart = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

/** Every activity line of the person's between two times, as the bank lists them. */
async function activityLines(who, from, to) {
  const client = await api(who);
  const items = [];
  let cursor;
  for (let page = 0; page < 50; page += 1) {
    const input = { from, to, limit: 100, ...(cursor ? { cursor } : {}) };
    const res = await client.get(`/api/bank/trpc/activity.list?input=${encodeURIComponent(JSON.stringify(input))}`);
    const data = res.body?.result?.data;
    if (!data) throw new Error(`activity.list refused (${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`);
    items.push(...data.items);
    if (!data.nextCursor) return items;
    cursor = data.nextCursor;
  }
  throw new Error('activity.list paged past 5000 lines');
}

const centre = (page) => page.getByTestId('statement-centre');

/** The person's USDT lines folded as a reader would: money in minus money out, and how many lines. */
function usdtNet(lines) {
  const usdt = lines.filter((line) => line.asset === 'USDT');
  const net = usdt.reduce((sum, line) => sum + (line.direction === 'out' ? -toUnits(line.amount) : toUnits(line.amount)), 0n);
  return { net: fromUnits(net), count: usdt.length };
}

test(`${J} #1 exports a month as PDF: every posted line, a hash proof and the same total as the activity list; a range across months is refused`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const who = await signUp(page, 'bk16');
  await verify(page, who);
  run.reset({ who });
  expect(fund(who.email, 'USDT', '100').tx).toBeTruthy();
  expect(fund(who.email, 'USDT', '50.25').tx).toBeTruthy();
  await signIn(page, who);

  // This month's posted lines, as the bank lists them: the two TEST deposits, and whatever else the stack posted.
  const lines = await activityLines(who, monthStart().toISOString(), new Date(nextMonthStart().getTime() - 1).toISOString());
  expect(
    lines
      .filter((line) => line.kind === 'deposit')
      .map((line) => line.amount)
      .sort(),
  ).toEqual(['100', '50.25']);
  const usdt = usdtNet(lines);
  const totalWords = `USDT: ${usdt.net} (${usdt.count} lines)`;

  // The activity list's total for this month's days, as the person reads it on Activity.
  const from = utcDay(monthStart());
  const today = utcDay(new Date());
  await page.goto('/money/activity');
  const search = page.getByRole('search', { name: 'Search activity' });
  await search.getByLabel('From date').fill(from);
  await search.getByLabel('To date').fill(today);
  await expect(page.getByTestId('money-period-totals').locator('li[data-asset="USDT"]')).toHaveText(totalWords);

  // This month's statement, downloaded when the month is over.
  await page.clock.install({ time: new Date(nextMonthStart().getTime() + 60_000) });
  await page.goto('/bank/statements');
  await centre(page).getByLabel('Month', { exact: true }).fill(thisMonth());
  await centre(page).getByRole('combobox', { name: 'Format' }).selectOption('pdf');
  const [file] = await Promise.all([page.waitForEvent('download'), centre(page).getByRole('button', { name: 'Download' }).click()]);
  const bytes = readFileSync(await file.path());
  const text = bytes.toString('utf8');
  expect(file.suggestedFilename()).toBe(`intafaced-statement-${thisMonth()}.pdf`);
  expect(bytes.subarray(0, 8).toString('utf8')).toBe('%PDF-1.4');

  // Every posted line of the month is in the file, by its ledger reference.
  expect(text).toContain(`Rows: ${lines.length}`);
  for (const line of lines) expect(text).toContain(line.txId);
  // The same total as the activity list, in the file and beside it.
  expect(text).toContain(`Total USDT: ${usdt.net} \\(${usdt.count} lines\\)`);
  await expect(page.getByTestId('statement-centre-totals').locator('li[data-asset="USDT"]')).toHaveText(totalWords);
  // The hash proof: the fingerprint shown is the start of the file's own SHA-256.
  const sha = createHash('sha256').update(bytes).digest('hex');
  const fingerprint = sha.slice(0, 12).match(/.{4}/g).join(' ');
  await expect(page.getByTestId('statement-centre-status')).toHaveText(
    `Downloaded ${file.suggestedFilename()}: ${lines.length} lines. Fingerprint ${fingerprint}; support can check it.`,
  );

  // A range that crosses months is refused, and nothing is saved.
  await centre(page)
    .getByRole('radio', { name: /Ledger/ })
    .check();
  await centre(page)
    .getByLabel('From (UTC)', { exact: true })
    .fill(utcDay(new Date(monthStart().getTime() - 86_400_000)));
  await centre(page).getByLabel('To (UTC)', { exact: true }).fill(today);
  await centre(page).getByRole('combobox', { name: 'Format' }).selectOption('pdf');
  let saved = false;
  page.on('download', () => (saved = true));
  await centre(page).getByRole('button', { name: 'Download' }).click();
  const refusal = centre(page).getByRole('alert');
  await expect(refusal).toHaveText('A PDF covers one calendar month (UTC). Pick dates inside one month, or choose CSV.');
  await expect(refusal).toHaveAttribute('data-code', 'bank.statement_pdf_one_month');
  expect(saved).toBe(false);
});

test(`${J} #2 searches transactions and asks for a letter: search results, and an honest "needs a banking partner"`, async ({ page }) => {
  const who = person();
  await signIn(page, who);
  await page.goto('/money/activity');
  const search = page.getByRole('search', { name: 'Search activity' });
  const rows = page.getByTestId('money-table').getByTestId('money-act');
  await expect(rows.first()).toBeVisible();
  // A search by amount finds the one line, and a search for nothing of the person's finds nothing.
  await search.getByRole('searchbox').fill('50.25');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('50.25');
  await search.getByRole('searchbox').fill('no-such-line-TEST');
  await expect(page.getByTestId('money-state')).toContainText('Nothing matches');

  // A bank letter needs a banking partner, and none is connected: refused in words, with its code, nothing made.
  await page.goto('/bank/statements');
  const letters = page.getByTestId('statement-letters');
  await letters.getByRole('button', { name: 'Ask for an ownership letter' }).click();
  const notice = letters.locator('[data-not-connected="rail.bank"]');
  await expect(notice).toContainText('A bank letter needs a banking partner. It is switched off in this build.');
  await expect(notice).toContainText('rail.bank');
});

test(`${J} #3 opens tax statements: "needs the tax vendor" with vendor.tax`, async ({ page }) => {
  await signIn(page, person());
  await page.goto('/bank/statements');
  const tax = page.getByTestId('tax-statements');
  await expect(tax.getByRole('combobox', { name: 'Tax year' })).toHaveValue(String(new Date().getUTCFullYear()));
  const notice = tax.locator('[data-not-connected="vendor.tax"]');
  await expect(notice).toContainText('A tax statement needs a tax calculation provider. It is switched off in this build.');
  await expect(notice).toContainText('vendor.tax');
});

/** One of the person's own svc-bank reads through Edge. */
async function bankRead(client, procedure, input) {
  const res = await client.get(`/api/bank/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`);
  return {
    status: res.status,
    data: res.body?.result?.data,
    code: res.body?.error?.data?.cause?.code ?? res.body?.error?.data?.intafacedCode,
    body: res.body,
  };
}

test(`${J} #4 opens Analytics with a budget of 100 and spend of 80: progress 80 percent, the alert once per period, deposits as money in`, async ({
  browser,
  page,
}) => {
  test.setTimeout(240_000);
  const who = person();
  const client = await api(who);
  // Spend of 80 this month: the person pays 80 TEST USDT to a second TEST person from their main account.
  const payeeContext = await browser.newContext();
  const payeePage = await payeeContext.newPage();
  const payee = await signUp(payeePage, 'bk16p');
  await payeeContext.close();
  const payeeId = (await (await api(payee)).get('/api/identity/trpc/rank.get')).body.result.data.userId;
  const spaces = await bankRead(client, 'spaces.list', { limit: 50 });
  const main = spaces.data.find((s) => s.kind === 'primary' && s.assetId === 'USDT');
  const sent = await client.post('/api/bank/trpc/transfers.toUser', {
    transferId: `${J}-spend-${who.email}`,
    fromSpaceId: main.id,
    toUserId: payeeId,
    amount: '80',
  });
  expect(sent.status, JSON.stringify(sent.body).slice(0, 300)).toBe(200);

  // No budget yet: left to spend is refused by name.
  expect(await bankRead(client, 'analytics.leftToSpend', { assetId: 'USDT' })).toMatchObject({ code: 'bank.budget_unset' });

  await signIn(page, who);
  await page.goto('/bank/analytics');
  const budgets = page.getByTestId('analytics-budgets');
  await expect(budgets.getByTestId('left-to-spend')).toHaveAttribute('data-code', 'bank.budget_unset');
  await budgets.getByLabel('Category').selectOption('transfers');
  await budgets.getByLabel('Monthly target (USDT)').fill('100');
  await budgets.getByLabel('Alert at (percent of target)').fill('80');
  await budgets.getByRole('button', { name: 'Save budget' }).click();

  // Progress 80 percent, from the bank's fold of this month's lines, and the alert shown.
  const row = budgets.getByTestId('budget-transfers');
  await expect(row).toHaveAttribute('data-progress-bps', '8000');
  await expect(row).toContainText('Transfers: 80 of 100 USDT spent this month · 80%');
  await expect(row.getByTestId('budget-alert')).toHaveText('You have used 80% of your Transfers budget this month.');
  await expect(budgets.getByTestId('left-to-spend')).toHaveAttribute('data-left', '20');
  await expect.poll(async () => (await bankRead(client, 'analytics.budgets', { assetId: 'USDT' })).data?.[0]?.alert).toBe('seen');
  const [budget] = (await bankRead(client, 'analytics.budgets', { assetId: 'USDT' })).data;
  expect(budget).toMatchObject({ category: 'transfers', target: '100', spent: '80', progressBps: 8000, alertBps: 8000, alert: 'seen' });

  // Once per period: the next visit this month shows no alert, only when it was shown.
  await page.reload();
  await expect(row).toHaveAttribute('data-progress-bps', '8000');
  await expect(row.getByTestId('budget-alert')).toHaveCount(0);
  await expect(row.getByTestId('budget-alert-seen')).toBeVisible();
  const still = (await bankRead(client, 'analytics.budgets', { assetId: 'USDT' })).data[0];
  expect(still.alertShownAt).toBe(budget.alertShownAt);

  // Deposits are money in, not outflow: this month's two TEST deposits are in the inflow, and the outflow is the 80.
  const now = new Date();
  const spend = await bankRead(client, 'analytics.spend', { assetId: 'USDT', from: monthStart(now).toISOString(), to: now.toISOString() });
  expect(spend.data.totalOutflow).toBe('80');
  expect(spend.data.outflowByCategory.transfers).toBe('80');
  expect(toUnits(spend.data.totalInflow)).toBeGreaterThanOrEqual(toUnits('150.25'));
  await expect(budgets.getByTestId('analytics-money-in')).toHaveAttribute('data-inflow', spend.data.totalInflow);
  run.write({ payeeId });
});

test(`${J} #5 compares two months and reads "left to spend": each category per month side by side`, async ({ page }) => {
  test.setTimeout(180_000);
  const who = person();
  const client = await api(who);
  const now = new Date();
  const thisM = thisMonth();
  const lastM = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  const read = await bankRead(client, 'analytics.compare', { assetId: 'USDT', months: [lastM, thisM] });
  expect(read.status, JSON.stringify(read.body).slice(0, 300)).toBe(200);
  expect(read.data.categories.find((r) => r.category === 'transfers')).toEqual({
    category: 'transfers',
    byMonth: ['0', '80'],
    change: '80',
  });

  await signIn(page, who);
  await page.goto('/bank/analytics');
  const compare = page.getByTestId('analytics-compare');
  await expect(compare.getByLabel('First month')).toHaveValue(lastM);
  await expect(compare.getByLabel('Second month')).toHaveValue(thisM);
  const table = compare.getByRole('table', { name: 'Spend by category per month' });
  await expect(table.getByRole('columnheader')).toHaveText(['Category', lastM, thisM, 'Change']);
  // Each category per month side by side, a month with no movement as 0, as the bank folded them.
  for (const row of read.data.categories) {
    await expect(table.locator(`tr[data-category="${row.category}"] td`)).toHaveText([...row.byMonth, row.change]);
  }
  await expect(table.locator('tr[data-category="transfers"]')).toContainText('Transfers');

  // Left to spend: the budget of 100 less this month's 80.
  const left = await bankRead(client, 'analytics.leftToSpend', { assetId: 'USDT' });
  expect(left.data).toMatchObject({ target: '100', spent: '80', left: '20', period: thisM });
  const tile = page.getByTestId('analytics-budgets').getByTestId('left-to-spend');
  await expect(tile).toHaveAttribute('data-left', '20');
  await expect(tile).toHaveText('Left to spend this month: 20 USDT of 100 USDT');
});

// Not built yet (BK-acct-04, RC-bank-01): each checks the room its step names and fails fast.

test(`${J} #6 opens Limits, fees and plan: daily send limit, used today and remaining; a blank fee table says "not set"; plan from the owner's table`, async ({
  page,
}) => {
  await signIn(page, person());
  await page.goto('/bank/limits');
  await expect(page.getByTestId('bank-limits')).toBeVisible({ timeout: 5_000 });
});

test(`${J} #7 receives a dormancy-fee notice: a pre-debit notice and no fee after a full withdrawal`, async ({ page }) => {
  await signIn(page, person());
  await page.goto('/money/activity');
  await expect(page.getByTestId('dormancy-notice')).toBeVisible({ timeout: 5_000 });
});
