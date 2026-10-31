import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, expect } from './journey.mjs';
import { confirm, fundedTrader, openDesk, previewed, reviewSheet, signIn } from './desk.mjs';
import { api, ORIGIN } from './stack.mjs';

// J-portfolio-11, in the running app (docs/roadmap/journeys.json): I download statements and exports. One test per step,
// titled "J-portfolio-11 #<n>". One TEST trader, verified and funded with TEST USDT through the real ledger, buys BTC at
// market on the desk, so the ledger holds a deposit, a trade and its fee for the exports to list. #1-#3 and #6 are
// PF-statements-01 (svc-bank `bank.statements.export`, the room at /bank/statements); #4 and #5 are PF-statements-02
// (background export jobs and a document centre), which is not built: they run last and fail at once on the missing job door.
const J = 'J-portfolio-11';

test.describe.configure({ mode: 'serial' });

let who;

const centre = (page) => page.getByTestId('statement-centre');
const NOT_TAX_FORM = 'This is not a tax form. It lists what happened and works out no gain, loss or tax.';

/** The statement and export centre, signed in. */
async function openCentre(page) {
  await signIn(page, who);
  await page.goto('/bank/statements');
  await expect(centre(page)).toBeVisible();
}

/** A UTC day as the date fields hold it. */
const utcDay = (at) => at.toISOString().slice(0, 10);

/** The last month that is over, as "YYYY-MM" in UTC. */
function lastFullMonth(now = new Date()) {
  const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return at.toISOString().slice(0, 7);
}

/** Clicks Download and returns the saved file's name and bytes. */
async function downloaded(page) {
  const [file] = await Promise.all([page.waitForEvent('download'), centre(page).getByRole('button', { name: 'Download' }).click()]);
  return { name: file.suggestedFilename(), bytes: readFileSync(await file.path()) };
}

/** RFC 4180 rows of a CSV the bank wrote (a BOM first, CRLF lines, quoted cells where needed). */
function csvRows(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const body = text.replace(/^﻿/, '');
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && body[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) rows.push([...row, cell]);
  return rows;
}

/** Every activity line in [from, to], newest first, as `bank.activity.list` pages it to this person. */
async function activityLines(from, to) {
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

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  const page = await browser.newPage({ baseURL: ORIGIN });
  who = await fundedTrader(page, 'pf11', '1000');
  await openDesk(page, who);
  await page.locator('[role=tab]', { hasText: /^Market$/ }).click();
  await previewed(page, () => page.getByRole('textbox', { name: 'Amount' }).first().fill('0.001'));
  await page.getByRole('button', { name: 'Buy BTC' }).click();
  await expect(reviewSheet(page)).toBeVisible();
  await confirm(page, 'buy');
  await expect
    .poll(
      async () => (await (await api(who)).get('/api/v1/account/trades?limit=100')).body.filter((fill) => fill.symbol === 'BTC/USDT').length,
      { timeout: 20_000 },
    )
    .toBe(1);
  await page.close();
});

test(`${J} #1 opens the statement and export centre: account statement, trades, ledgers and balances as export kinds`, async ({ page }) => {
  await signIn(page, who);
  // Reached from the bank's Analytics room.
  await page.goto('/bank/analytics');
  await page.getByRole('link', { name: 'Statements and exports' }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/bank/statements');
  await expect(centre(page)).toBeVisible();
  const kinds = centre(page).getByRole('radiogroup', { name: 'What to export' });
  expect(await kinds.locator('label strong').allInnerTexts()).toEqual(['Account statement', 'Ledger', 'Trades', 'Balances']);
  await expect(kinds.getByRole('radio', { name: /Account statement/ })).toBeChecked();
  for (const name of [/Ledger/, /Trades/, /Balances/]) await expect(kinds.getByRole('radio', { name })).toBeEnabled();
  await expect(page.getByText(NOT_TAX_FORM)).toBeVisible();
});

test(`${J} #2 downloads a signed statement for a finished month: a file with its fingerprint; this month is not offered`, async ({
  page,
}) => {
  await openCentre(page);
  const month = centre(page).getByLabel('Month', { exact: true });
  // This month is not offered: the field stops at the last month that is over, and this month refuses in words.
  await expect(month).toHaveAttribute('max', lastFullMonth());
  await month.fill(new Date().toISOString().slice(0, 7));
  await expect(page.getByTestId('statement-centre-status')).toHaveText(
    'This month is still running, so it is not offered. Pick a month that is over.',
  );
  await expect(centre(page).getByRole('button', { name: 'Download' })).toBeDisabled();
  // The last finished month, as a signed PDF.
  await month.fill(lastFullMonth());
  await centre(page).getByRole('combobox', { name: 'Format' }).selectOption('pdf');
  const { name, bytes } = await downloaded(page);
  expect(name).toBe(`intafaced-statement-${lastFullMonth()}.pdf`);
  expect(bytes.subarray(0, 8).toString('utf8')).toBe('%PDF-1.4');
  expect(bytes.toString('utf8')).toContain('INTAFACED account statement');
  // The fingerprint shown is the first 12 characters of the file's own SHA-256.
  const sha = createHash('sha256').update(bytes).digest('hex');
  const fingerprint = sha.slice(0, 12).match(/.{4}/g).join(' ');
  await expect(page.getByTestId('statement-centre-status')).toHaveText(
    new RegExp(`^Downloaded ${name}: \\d+ lines\\. Fingerprint ${fingerprint};`),
  );
});

test(`${J} #3 exports 30 days of transactions as CSV: newest first in UTC, equal to the activity list for the range, no balance column, and the not-a-tax-form sentence`, async ({
  page,
}) => {
  await openCentre(page);
  await centre(page)
    .getByRole('radio', { name: /Ledger/ })
    .check();
  // The last 30 UTC days, today included, are the dates offered.
  const now = new Date();
  const fromDay = utcDay(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 29)));
  const toDay = utcDay(now);
  await expect(centre(page).getByLabel('From (UTC)', { exact: true })).toHaveValue(fromDay);
  await expect(centre(page).getByLabel('To (UTC)', { exact: true })).toHaveValue(toDay);
  await centre(page).getByRole('combobox', { name: 'Format' }).selectOption('csv');
  const { name, bytes } = await downloaded(page);
  expect(name).toMatch(/^intafaced-activity-\d{4}-\d{2}-\d{2}\.csv$/);
  const [header, ...rows] = csvRows(bytes.toString('utf8'));
  expect(header.some((cell) => /balance/i.test(cell))).toBe(false);
  // Equal to the activity list for the same range: the same records, in the same order.
  const lines = await activityLines(`${fromDay}T00:00:00.000Z`, `${toDay}T23:59:59.999Z`);
  expect(lines.length).toBeGreaterThan(0);
  const record = header.indexOf('Record');
  const date = header.indexOf('Date (UTC)');
  const type = header.indexOf('Type');
  const amount = header.indexOf('Amount');
  expect(rows.map((row) => row[record])).toEqual(lines.map((line) => line.id));
  for (const [i, line] of lines.entries()) {
    expect(rows[i][type]).toBe(line.kind);
    expect(rows[i][amount]).toBe(line.direction === 'out' ? `-${line.amount}` : line.amount);
  }
  // In UTC, newest first.
  const times = rows.map((row) => row[date]);
  for (const at of times) expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  expect([...times].sort().reverse()).toEqual(times);
  // The buy is in it, as the trade line the ledger posted.
  expect(
    rows.some((row) => row[type] === 'trade'),
    'a trade line',
  ).toBe(true);
  await expect(page.getByText(NOT_TAX_FORM)).toBeVisible();
  await expect(page.getByTestId('statement-centre-status')).toHaveText(new RegExp(`^Downloaded ${name}: ${rows.length} lines\\.`));
});

// #6 runs before #4 and #5: the run is serial, and those two wait on PF-statements-02.
test(`${J} #6 asks for a range that crosses months as a PDF: refused with the reason (one month per PDF)`, async ({ page }) => {
  await openCentre(page);
  await centre(page)
    .getByRole('radio', { name: /Ledger/ })
    .check();
  const now = new Date();
  const lastMonthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  await centre(page)
    .getByLabel('From (UTC)', { exact: true })
    .fill(utcDay(new Date(Date.UTC(lastMonthEnd.getUTCFullYear(), lastMonthEnd.getUTCMonth(), 20))));
  await centre(page)
    .getByLabel('To (UTC)', { exact: true })
    .fill(utcDay(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))));
  await centre(page).getByRole('combobox', { name: 'Format' }).selectOption('pdf');
  let saved = false;
  page.on('download', () => (saved = true));
  await centre(page).getByRole('button', { name: 'Download' }).click();
  const refusal = centre(page).getByRole('alert');
  await expect(refusal).toHaveText('A PDF covers one calendar month (UTC). Pick dates inside one month, or choose CSV.');
  await expect(refusal).toHaveAttribute('data-code', 'bank.statement_pdf_one_month');
  expect(saved).toBe(false);
});

test(`${J} #4 requests an export for a long range: a job row exists first, the same request returns the same job, and the document centre lists it`, async ({
  page,
}) => {
  const client = await api(who);
  const now = new Date();
  const request = {
    report: 'ledger',
    format: 'csv',
    from: new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), now.getUTCDate() + 1)).toISOString(),
    to: now.toISOString(),
  };
  const first = await client.post('/api/bank/trpc/statements.jobs.create', request);
  expect(first.status, `bank.statements.jobs.create: ${JSON.stringify(first.body).slice(0, 300)}`).toBe(200);
  const job = first.body.result.data;
  const again = await client.post('/api/bank/trpc/statements.jobs.create', request);
  expect(again.body.result.data.id).toBe(job.id);
  await openCentre(page);
  await expect(page.getByTestId('statement-documents').locator(`[data-job="${job.id}"]`)).toBeVisible({ timeout: 5_000 });
});

test(`${J} #5 a worker dies mid-render: the job re-queues on the same key and the second file has the same content`, async () => {
  const client = await api(who);
  const jobs = await client.get('/api/bank/trpc/statements.jobs.list');
  expect(jobs.status, `bank.statements.jobs.list: ${JSON.stringify(jobs.body).slice(0, 300)}`).toBe(200);
  throw new Error('PF-statements-02: no worker restart proof is wired until background export jobs exist');
});
