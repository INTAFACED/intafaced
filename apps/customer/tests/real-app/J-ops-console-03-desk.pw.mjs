import { expect, test } from './journey.mjs';
import { randomBytes } from 'node:crypto';
import { ADMIN, founderSignIn } from './admin.mjs';
import { unconfirmedAccount } from './p2p.mjs';
import { fund } from './stack.mjs';

// J-ops-console-03 #1-#5 (find a transaction on the ledger and trace it to its business key, OPS-ledger-desk-01). A fresh
// TEST customer is funded through the real ledger one more time than the desk's page holds, in an asset no other journey
// funds (XAG, TEST amounts), so the filters, the ledger's total and the next page are exact. Founder A signs in with their
// own sign-in and second factor and, on Ledger ops: lists those deposits by asset and time with a next page, opens one
// (every posting with where the value came from and went and the balances before and after it, the reference, the request
// and ledger times), traces its business key to its log sequence and audit entry, finds the customer's account by address
// prefix with its volumes and balance, and counts the book. Every number on the desk is the ledger's.

const PAGE = 50;
const DEPOSITS = PAGE + 1;
const ASSET = 'XAG';

test.use({ timezoneId: 'UTC' });

/**
 * A UTC instant as the `datetime-local` value the founder types (the browser runs in UTC here). The browser drops a
 * zero seconds field, so a whole minute is typed without one.
 */
const typed = (iso) => (iso.slice(17, 19) === '00' ? iso.slice(0, 16) : iso.slice(0, 19));

let funded = null;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  const who = await unconfirmedAccount('jdsk');
  const since = new Date(Date.now() - 2_000).toISOString();
  const tag = randomBytes(3).toString('hex');
  const txs = [];
  let userId = null;
  for (let i = 0; i < DEPOSITS; i++) {
    const out = fund(who.email, ASSET, '1', `desk-${tag}-${i}`);
    expect(out.tx, out.out).toBeTruthy();
    txs.push({ tx: out.tx, key: `deposit:local-test:LOCAL-TEST-desk-${tag}-${i}` });
    userId ??= /\(([0-9a-f-]{36})\)/.exec(out.out)?.[1] ?? null;
  }
  expect(userId).toBeTruthy();
  funded = { who, userId, since, until: new Date(Date.now() + 60_000).toISOString(), txs, newest: txs.at(-1) };
});

async function desk(page) {
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/ledger`, { waitUntil: 'load' });
  const section = page.getByTestId('ledger-desk');
  await expect(section).toBeVisible();
  return section;
}

/** Filters the list to this test's deposits and answers the list section and the ledger's own JSON for that page. */
async function listDeposits(page, section) {
  const list = section.getByTestId('ledger-desk-transactions');
  await list.getByLabel('Asset').fill(ASSET);
  await list.getByLabel('From (inclusive)').fill(typed(funded.since));
  await list.getByLabel('To (exclusive)').fill(typed(funded.until));
  const answered = page.waitForResponse((res) => res.url().includes('/api/ledger-desk/transactions'));
  await list.getByRole('button', { name: 'Show transactions' }).click();
  const body = await (await answered).json();
  return { list, body };
}

test('J-ops-console-03 #1 the ledger list filters by asset and time, with the ledger’s total and a next page', async ({ page }) => {
  test.setTimeout(240_000);
  const section = await desk(page);
  const { list, body } = await listDeposits(page, section);
  // The total is the ledger's: the page shows exactly what svc-ledger counted.
  expect(body.read).toBe('transactions');
  expect(body.page.total).toBe(String(DEPOSITS));
  await expect(list.getByTestId('ledger-desk-total')).toContainText(`${DEPOSITS} transactions match, counted by the ledger`);
  const rows = list.getByTestId('ledger-desk-transactions-table').locator('tbody tr');
  await expect(rows).toHaveCount(PAGE);
  // Newest first: the last deposit leads the first page.
  await expect(rows.first()).toContainText(funded.newest.key);
  await expect(rows.first()).toContainText(ASSET);

  await list.getByRole('button', { name: 'Next page' }).click();
  await expect(list.getByTestId('ledger-desk-total')).toContainText('Page 2');
  await expect(rows).toHaveCount(DEPOSITS - PAGE);
  await expect(rows.first()).toContainText(funded.txs[0].key);
  await expect(list.getByRole('button', { name: 'Next page' })).toHaveCount(0);
  await list.getByRole('button', { name: 'Previous page' }).click();
  await expect(rows).toHaveCount(PAGE);

  // A window long before the book began matches nothing, said in words.
  await list.getByLabel('From (inclusive)').fill('2000-01-01T00:00');
  await list.getByLabel('To (exclusive)').fill('2000-01-02T00:00');
  await list.getByRole('button', { name: 'Show transactions' }).click();
  await expect(list.getByTestId('ledger-desk-transactions-empty')).toBeVisible({ timeout: 30_000 });
  await expect(list.getByTestId('ledger-desk-total')).toContainText('0 transactions match');
});

test('J-ops-console-03 #2 opening a transaction shows each posting’s source and destination, before and after, reference and times', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const section = await desk(page);
  const { list } = await listDeposits(page, section);
  await list.getByRole('link', { name: funded.newest.key }).click();
  const lookup = page.getByTestId('ledger-lookup');
  await expect(lookup.getByTestId('ledger-lookup-tx-id')).toHaveText(funded.newest.tx, { timeout: 30_000 });
  await expect(lookup.getByTestId('ledger-lookup-business-key')).toHaveText(funded.newest.key);
  await expect(lookup.getByTestId('ledger-lookup-reference')).not.toBeEmpty();
  await expect(lookup.getByTestId('ledger-lookup-request-time')).toContainText('took the request');
  await expect(lookup.getByTestId('ledger-lookup-ledger-time')).toContainText('database transaction began');
  const postings = lookup.getByTestId('ledger-lookup-postings');
  // The fifty-first TEST deposit of 1 XAG: the rail is the source, the customer's account the destination, 50 before and 51 after.
  const source = postings.locator('tr[data-side="source"]');
  const destination = postings.locator('tr[data-side="destination"]');
  await expect(source).toHaveCount(1);
  await expect(destination).toHaveCount(1);
  await expect(source).toContainText('credit');
  await expect(destination).toContainText('debit');
  const cells = async (row) => (await row.locator('td').allInnerTexts()).map((t) => t.trim());
  expect((await cells(destination)).slice(-3)).toEqual(['1', '50', '51']);
  const rail = await cells(source);
  expect(rail.at(-3)).toBe('1');
  expect(BigInt(rail.at(-2)) - BigInt(rail.at(-1))).toBe(1n);
});

test('J-ops-console-03 #3 tracing a business key shows its transaction, log sequence and audit entry; a key with none says no record', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await desk(page);
  const lookup = page.getByTestId('ledger-lookup');
  await lookup.getByLabel('Look up by').selectOption('businessKey');
  await lookup.getByLabel('Business key', { exact: true }).fill(funded.newest.key);
  const answered = page.waitForResponse((res) => res.url().includes('/api/ledger-lookup'));
  await lookup.getByRole('button', { name: 'Look up' }).click();
  const body = await (await answered).json();
  expect(body.transaction.txId).toBe(funded.newest.tx);
  await expect(lookup.getByTestId('ledger-lookup-tx-id')).toHaveText(funded.newest.tx);
  await expect(lookup.getByTestId('ledger-lookup-seq')).toHaveText(body.transaction.booking.seq);
  expect(body.transaction.booking.seq).toMatch(/^\d+$/);
  await expect(lookup.getByTestId('ledger-lookup-event')).toContainText('intafaced.ledger.tx.posted');
  await expect(lookup.getByTestId('ledger-lookup-event')).toContainText(body.transaction.booking.event.id);

  const never = `deposit:local-test:never-${randomBytes(4).toString('hex')}`;
  await lookup.getByLabel('Business key', { exact: true }).fill(never);
  await lookup.getByRole('button', { name: 'Look up' }).click();
  await expect(lookup.getByTestId('ledger-lookup-not-found')).toContainText(never, { timeout: 30_000 });
  await expect(lookup.getByTestId('ledger-lookup-not-found')).toContainText('No record');
});

test('J-ops-console-03 #4 an account address prefix finds the account with its volumes and derived balance as decimal strings', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const section = await desk(page);
  const accounts = section.getByTestId('ledger-desk-accounts');
  await accounts.getByLabel('Address prefix').fill(`user:${funded.userId.slice(0, 13)}`);
  const answered = page.waitForResponse((res) => res.url().includes('/api/ledger-desk/accounts'));
  await accounts.getByRole('button', { name: 'Search accounts' }).click();
  const body = await (await answered).json();
  const mine = body.page.accounts.find((row) => row.ownerId === funded.userId && row.assetId === ASSET);
  expect(mine).toMatchObject({ address: `user:${funded.userId}`, debits: String(DEPOSITS), credits: '0', balance: String(DEPOSITS) });
  const row = accounts.locator(`tr[data-account="${mine.accountId}"]`);
  await expect(row).toContainText(`user:${funded.userId}`);
  expect((await row.locator('td').allInnerTexts()).map((t) => t.trim())).toEqual([
    `user:${funded.userId}`,
    ASSET,
    'available',
    '—',
    String(DEPOSITS),
    '0',
    String(DEPOSITS),
    String(DEPOSITS),
    'Metadata',
  ]);

  // A prefix that names no owner type is refused before anything is sent.
  await accounts.getByLabel('Address prefix').fill('fees');
  await expect(accounts.getByRole('button', { name: 'Search accounts' })).toBeDisabled();
});

test('J-ops-console-03 #5 the statistics are the ledger’s counts', async ({ page }) => {
  test.setTimeout(240_000);
  const section = await desk(page);
  const stats = section.getByTestId('ledger-desk-stats');
  const answered = page.waitForResponse((res) => res.url().includes('/api/ledger-desk/stats'));
  await stats.getByRole('button', { name: 'Count the book' }).click();
  const body = await (await answered).json();
  expect(body.read).toBe('stats');
  await expect(stats.getByTestId('ledger-desk-stat-transactions')).toHaveText(body.stats.transactions);
  await expect(stats.getByTestId('ledger-desk-stat-postings')).toHaveText(body.stats.postings);
  await expect(stats.getByTestId('ledger-desk-stat-accounts')).toHaveText(body.stats.accounts);
  // This test's own deposits are in the count.
  expect(BigInt(body.stats.transactions)).toBeGreaterThanOrEqual(BigInt(DEPOSITS));
  expect(BigInt(body.stats.postings)).toBeGreaterThanOrEqual(BigInt(2 * DEPOSITS));
  await expect(stats).toContainText('Counted by the ledger at');
});
