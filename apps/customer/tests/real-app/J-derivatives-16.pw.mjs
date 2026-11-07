// World: book, gates
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { journeyState } from './stack.mjs';
import { bodyRows, tableIn } from './tables.mjs';

// J-derivatives-16, in the running app (docs/roadmap/journeys.json; the row in project-state
// operation-zero/modules/derivatives/acceptance/journeys.md): two risk operators run funding and mark price operations on
// the founder console's funding desk (/trade-ops/funding). One test per step, titled "J-derivatives-16 #<n>". Founders A
// and B are the stack's LOCAL TEST founder pair (admin.mjs): A asks, B approves, so every approved write has two people.
// Written by a test-writer from the step's words, before the feature (OWNER 212): a step whose room or control is not
// built fails at its first missing part, quickly (UNBUILT), and is listed in docs/runbooks/journey-baseline.json.
// World: the desk's writes change platform-wide funding parameters, index sources and a mark override at runtime (gates).
const J = 'J-derivatives-16';
const UNBUILT = { timeout: 5_000 };
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

/** Pages already signed in: each sign-in waits for a fresh one-time code (up to 30 s), so a page signs in once. */
const signedIn = new WeakSet();

async function openDesk(page, founder = 'a') {
  if (!signedIn.has(page)) await founderSignIn(page, founder);
  signedIn.add(page);
  await page.goto(`${ADMIN}/trade-ops/funding`);
  await expect(page.getByRole('heading', { name: 'Funding and mark price', level: 1 })).toBeVisible(UNBUILT);
}

const fundingTable = (page) => tableIn(page, 'Funding by market');
/** The market's name cell, drawn as a cell or a row header. */
const nameCell = (page, symbol) =>
  page.getByRole('rowheader', { name: symbol, exact: true }).or(page.getByRole('cell', { name: symbol, exact: true }));
const marketRow = (page, symbol) => bodyRows(fundingTable(page)).filter({ has: nameCell(page, symbol) });
/** The second-operator queue on the desk: what waits for a different operator's approval. */
const waiting = (page, what) => bodyRows(tableIn(page, 'Waiting for approval')).filter({ hasText: what });

/** The futures markets the markets desk lists, by symbol: the funding desk must show each of them, no more, no fewer. */
async function futuresSymbols(page) {
  await page.goto(`${ADMIN}/trade-ops/markets`);
  const markets = tableIn(page, 'Markets');
  await expect(bodyRows(markets).first()).toBeVisible();
  const symbols = [];
  for (const row of await bodyRows(markets).all()) {
    const cells = (await row.getByRole('cell').allTextContents()).map((c) => c.trim());
    if (/^futures$/i.test(cells[1] ?? '')) symbols.push(cells[0]);
  }
  return symbols;
}

/** The market every later step acts on, chosen once in #1 and kept in the run file. */
const chosen = () => run.read().symbol;

test(`${J} #1 opens funding and mark operations: parameters, index sources and the period status per market`, async ({ page }) => {
  await founderSignIn(page, 'a');
  signedIn.add(page);
  const symbols = await futuresSymbols(page);
  await openDesk(page);
  const table = fundingTable(page);
  await expect(table).toBeVisible();
  await expect(table.getByRole('columnheader')).toHaveText(['Market', 'Funding parameters', 'Index sources', 'Period status', ''], {
    useInnerText: true,
  });
  // One row per futures market the platform lists: none invented, none missing.
  expect(symbols.length, 'the stack lists at least one futures market').toBeGreaterThan(0);
  await expect(bodyRows(table)).toHaveCount(symbols.length);
  for (const symbol of symbols) await expect(marketRow(page, symbol)).toHaveCount(1);
  for (const symbol of symbols) {
    const row = marketRow(page, symbol);
    // Parameters: the interval and the cap, each a value or an honest "Unset", never a sample figure.
    await expect(row.getByTestId('funding-interval')).toHaveText(/^(Every \d+ h|Unset)$/);
    await expect(row.getByTestId('funding-cap')).toHaveText(/^(±\d+(\.\d+)?%|Unset)$/);
    // Index sources: each named source, or "None set".
    await expect(row.getByTestId('index-sources')).toHaveText(/\S/);
    // The period status: open, published, unset (no rate, a parameter blank) or waiting for approval.
    await expect(row.getByTestId('period-status')).toHaveText(/^(Open|Published|Unset|Waiting for approval)\b/);
  }
  run.reset({ symbol: symbols[0] });
});

test(`${J} #2 sets funding parameters and index sources: an approved, versioned write, and a blank cap records the period unset`, async ({
  browser,
}) => {
  const a = await (await browser.newContext()).newPage();
  await openDesk(a, 'a');
  const symbol = chosen();
  const row = marketRow(a, symbol);
  const versionBefore = Number((await row.getByTestId('funding-version').textContent(UNBUILT))?.match(/\d+/)?.[0]);
  expect(Number.isInteger(versionBefore), 'the row names its parameters version').toBe(true);

  // A asks for new parameters with a blank cap and one index source.
  await row.getByRole('button', { name: 'Change parameters' }).click(UNBUILT);
  const form = a.getByRole('form', { name: `Funding parameters for ${symbol}` });
  await form.getByRole('combobox', { name: 'Interval' }).selectOption({ label: 'Every 8 h' });
  await form.getByRole('textbox', { name: 'Cap' }).fill('');
  await form.getByRole('group', { name: 'Index sources' }).getByRole('checkbox').first().check();
  const source = (await form.getByRole('group', { name: 'Index sources' }).getByRole('checkbox').first().getAttribute('aria-label')) ?? '';
  await form.getByRole('button', { name: 'Ask for approval' }).click();
  // Not applied yet: the write waits for a second operator, and the live version is unchanged.
  await expect(row.getByTestId('period-status')).toHaveText(/^Waiting for approval/);
  await expect(row.getByTestId('funding-version')).toHaveText(new RegExp(`\\b${versionBefore}\\b`));

  // B approves it.
  const b = await (await browser.newContext()).newPage();
  await openDesk(b, 'b');
  const pending = waiting(b, `Funding parameters for ${symbol}`);
  await expect(pending).toHaveCount(1);
  await pending.getByRole('button', { name: 'Approve' }).click();
  await expect(b.getByRole('status')).toContainText('Approved');

  // The write is applied as a new version, the approver named; the blank cap records the period unset.
  await b.reload();
  const after = marketRow(b, symbol);
  await expect(after.getByTestId('funding-version')).toHaveText(new RegExp(`\\b${versionBefore + 1}\\b`));
  await expect(after.getByTestId('funding-interval')).toHaveText('Every 8 h');
  await expect(after.getByTestId('funding-cap')).toHaveText('Unset');
  await expect(after.getByTestId('index-sources')).toContainText(source);
  await expect(after.getByTestId('period-status')).toHaveText(/^Unset\b/);
  await expect(after.getByTestId('period-status')).toContainText('no rate is set while the cap is blank');
  // The version history shows both versions, the new one with who asked and who approved.
  await after.getByRole('button', { name: 'Versions' }).click();
  const versions = bodyRows(tableIn(b, `Funding parameter versions for ${symbol}`));
  await expect(versions.first()).toContainText(`v${versionBefore + 1}`);
  await expect(versions.first().getByTestId('approved-by')).toHaveText(/\S/);
  await expect(versions.filter({ hasText: `v${versionBefore}` })).toHaveCount(1);
});

test(`${J} #3 applies a mark override with a 10-minute box: the override, its box and its expiry in the audit`, async ({ page }) => {
  await openDesk(page, 'a');
  const symbol = chosen();
  const row = marketRow(page, symbol);
  await row.getByRole('button', { name: 'Override mark' }).click(UNBUILT);
  const form = page.getByRole('form', { name: `Mark override for ${symbol}` });
  await form.getByRole('textbox', { name: 'Mark price' }).fill('50000');
  await form.getByRole('combobox', { name: 'Box' }).selectOption({ label: '10 minutes' });
  await form.getByRole('textbox', { name: 'Reason' }).fill('TEST J-derivatives-16 #3 mark override');
  const appliedAt = Date.now();
  await form.getByRole('button', { name: 'Apply override' }).click();

  // The override shows on the row with its box and the time it expires: ten minutes after it was applied.
  const override = row.getByTestId('mark-override');
  await expect(override).toContainText('50,000');
  await expect(override).toContainText('10-minute box');
  const expires = Date.parse((await override.locator('time').getAttribute('datetime')) ?? '');
  expect(expires - appliedAt).toBeGreaterThan(9 * 60_000);
  expect(expires - appliedAt).toBeLessThan(11 * 60_000);

  // The audit records the override, its box and its expiry.
  await page.goto(`${ADMIN}/trade-ops/audit`);
  const entry = page
    .getByRole('row')
    .filter({ hasText: `Mark override ${symbol}` })
    .first();
  await expect(entry).toBeVisible();
  await expect(entry).toContainText('50,000');
  await expect(entry).toContainText('10 minutes');
  await expect(entry.locator('time')).toHaveAttribute('datetime', new Date(expires).toISOString());
});

test(`${J} #4 publishes a funding rate: two distinct operator approvals are required, and one approver is refused`, async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  await openDesk(a, 'a');
  const symbol = chosen();
  const row = marketRow(a, symbol);
  await row.getByRole('button', { name: 'Publish funding rate' }).click(UNBUILT);
  const form = a.getByRole('form', { name: `Publish funding rate for ${symbol}` });
  await form.getByRole('textbox', { name: 'Rate' }).fill('0.0001');
  await form.getByRole('button', { name: 'Ask to publish' }).click();
  await expect(row.getByTestId('period-status')).toHaveText(/^Waiting for approval/);
  await expect(row.getByTestId('publish-approvals')).toHaveText('0 of 2 approvals');

  // A approves once; that is one approval, and the rate is not published.
  const pendingA = waiting(a, `Funding rate for ${symbol}`);
  await pendingA.getByRole('button', { name: 'Approve' }).click();
  await expect(pendingA.getByTestId('approvals')).toHaveText('1 of 2 approvals');
  // The same operator approving again is refused: the second approval must come from a different operator.
  await pendingA.getByRole('button', { name: 'Approve' }).click();
  await expect(a.getByRole('alert')).toContainText('A second, different operator must approve');
  await expect(pendingA.getByTestId('approvals')).toHaveText('1 of 2 approvals');
  await a.reload();
  await expect(marketRow(a, symbol).getByTestId('period-status')).toHaveText(/^Waiting for approval/);

  // B, a second operator, approves: now two distinct approvals, and the rate is published.
  const b = await (await browser.newContext()).newPage();
  await openDesk(b, 'b');
  const pendingB = waiting(b, `Funding rate for ${symbol}`);
  await pendingB.getByRole('button', { name: 'Approve' }).click();
  await expect(b.getByRole('status')).toContainText('Published');
  await b.reload();
  const published = marketRow(b, symbol);
  await expect(published.getByTestId('period-status')).toHaveText(/^Published\b/);
  await expect(published.getByTestId('period-status')).toContainText('0.0001');
  await expect(published.getByTestId('publish-approvals')).toHaveText('2 of 2 approvals');
});

test(`${J} #5 reads the index venue feed state: source health, and an absent feed shows the notice and the index as unpublished`, async ({
  page,
}) => {
  await openDesk(page, 'a');
  const feed = page.getByRole('region', { name: 'Index venue feed' });
  await expect(feed).toBeVisible(UNBUILT);
  const sources = bodyRows(tableIn(feed, 'Index sources'));
  expect(await sources.count(), 'the feed lists its sources').toBeGreaterThan(0);
  const health = (await sources.getByTestId('source-health').allTextContents()).map((s) => s.trim());
  for (const h of health) expect(h).toMatch(/^(Healthy|Stale|Absent)\b/);
  // Each market's index: published from a healthy source, or unpublished (with no number) when its feed is absent.
  const indexes = bodyRows(tableIn(feed, 'Index by market'));
  for (const index of await indexes.all()) {
    const state = (await index.getByTestId('index-state').textContent())?.trim() ?? '';
    expect(state).toMatch(/^(Published|Unpublished)$/);
    if (state === 'Unpublished') await expect(index.getByTestId('index-value')).toHaveText('—');
  }
  if (health.some((h) => h.startsWith('Absent'))) {
    // An absent outside feed (`feed.market`) is said plainly; nothing stands in for its price.
    await expect(feed.getByRole('note')).toContainText('The index venue feed is not connected');
    await expect(feed.getByRole('note')).toContainText('the index is unpublished');
    await expect(indexes.getByTestId('index-state').filter({ hasText: 'Unpublished' }).first()).toBeVisible();
  }
});
