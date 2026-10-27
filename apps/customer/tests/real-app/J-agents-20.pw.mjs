import { test, expect } from '@playwright/test';
import { UNBUILT } from './agents.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';

// J-agents-20, in the founder console (docs/roadmap/journeys.json): change the model routing table with an audit. One
// test per step, titled "J-agents-20 #<n>", run in order by the stack's two LOCAL TEST founders on More modules
// (/more-ops), whose Agents part shows "Task routes and prices". A change takes two distinct founders and writes one
// audit row naming both; rate changes affect only future windows. #2 and #3 change the output ceiling of index.embed,
// the route no journey runs, and #3 puts it back the same way, so the stack's other journeys meet the table as it was.
// What is built: the routes table (task, capability, output ceiling, input and output price per million, billed in) with
// its CSV export. Steps not built yet fail at their first missing part, quickly (UNBUILT):
// - the table names no provider or model alias, and a route cannot be changed, confirmed or swapped (AG-usage-02,
//   RC-agents-05).
// - #3's "sessions open at the time keep their copied guardrail" needs a customer session held open across the change,
//   which a standard account cannot open on the stack ("agents:execute"); its title names only what it checks.
// - #4's provider swap is a configuration change the journey cannot make on the running stack; it checks that the table
//   reads each route's provider from configuration.
const J = 'J-agents-20';
const ROUTE = 'index.embed';

test.describe.configure({ mode: 'default' });

/** Both founders' handles, as the console signs them in: A in the step's page, B in a browser of its own. */
const founders = [];

const routes = (page) => page.getByTestId('read-agents.routes');
const row = (page, task = ROUTE) => routes(page).getByRole('row').filter({ hasText: task });

async function openRoutes(page, key = 'a') {
  const { handle } = await founderSignIn(page, key);
  if (!founders.includes(handle)) founders.push(handle);
  await page.goto(`${ADMIN}/more-ops`);
  await expect(routes(page).getByRole('table')).toBeVisible();
}

/** Founder A proposes `ceiling` as ROUTE's output ceiling, and founder B confirms it on their own console. */
async function changeCeiling(browser, page, ceiling) {
  await row(page).getByRole('button', { name: 'Change route' }).click(UNBUILT);
  const sheet = page.getByRole('dialog', { name: `Change ${ROUTE}` });
  await sheet.getByRole('textbox', { name: /^Output ceiling/ }).fill(ceiling);
  await sheet.getByRole('button', { name: 'Ask a second founder' }).click();
  await expect(row(page)).toContainText('Pending a second founder');
  const other = await browser.newContext();
  try {
    const b = await other.newPage();
    await openRoutes(b, 'b');
    await row(b).getByRole('button', { name: 'Confirm change' }).click();
    await expect(row(b).getByRole('cell').nth(2)).toHaveText(ceiling);
  } finally {
    await other.close();
  }
}

test(`${J} #1 opens the routing table: each task with provider alias, model alias and rate, or "not set"`, async ({ page }) => {
  await openRoutes(page);
  for (const column of ['Task', 'Provider', 'Model', 'Input per million', 'Output per million'])
    await expect(routes(page).getByRole('columnheader', { name: column })).toBeVisible(UNBUILT);
  await expect(routes(page).getByTestId('route-provider')).not.toHaveCount(0);
  await expect(routes(page).getByTestId('route-provider').filter({ hasNotText: /\S/ })).toHaveCount(0);
});

test(`${J} #2 changes a route as the only founder: it stays pending`, async ({ page }) => {
  await openRoutes(page);
  const before = await row(page).getByRole('cell').nth(2).innerText();
  await row(page).getByRole('button', { name: 'Change route' }).click(UNBUILT);
  const sheet = page.getByRole('dialog', { name: `Change ${ROUTE}` });
  await sheet.getByRole('textbox', { name: /^Output ceiling/ }).fill(String(Number(before) + 1));
  await sheet.getByRole('button', { name: 'Ask a second founder' }).click();
  await expect(row(page)).toContainText('Pending a second founder');
  await expect(row(page).getByRole('cell').nth(2)).toHaveText(before);
  // Withdraw it, so #3 starts from the table as it was.
  await row(page).getByRole('button', { name: 'Withdraw change' }).click();
});

test(`${J} #3 a second founder confirms: the table changes once with an audit row naming both founders`, async ({ browser, page }) => {
  await openRoutes(page);
  const before = await row(page).getByRole('cell').nth(2).innerText();
  try {
    await changeCeiling(browser, page, String(Number(before) + 1));
    await page.reload();
    await expect(row(page).getByRole('cell').nth(2)).toHaveText(String(Number(before) + 1));
    const audit = row(page).getByTestId('route-audit');
    for (const handle of founders) await expect(audit).toContainText(handle);
  } finally {
    // Put the route back the same way, so the stack's other journeys meet the table as it was.
    await page.reload();
    if ((await row(page).getByRole('cell').nth(2).innerText()) !== before) await changeCeiling(browser, page, before);
  }
});

test(`${J} #4 swaps the provider in configuration: new runs use the new provider with the source unchanged`, async ({ page }) => {
  await openRoutes(page);
  await expect(routes(page).getByTestId('route-provider-source').first()).toBeVisible(UNBUILT);
  await expect(
    routes(page)
      .getByTestId('route-provider-source')
      .filter({ hasNotText: /^From configuration$/ }),
  ).toHaveCount(0);
});
