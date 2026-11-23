// World: none
import { test, expect } from './journey.mjs';
import { UNBUILT, agentsRun, createOwnAgent, openOwnAgent, tableIn } from './agents.mjs';
import { signIn } from './desk.mjs';

// J-agents-09, in the running app (docs/roadmap/journeys.json): control what my agents remember and keep about me. One
// test per step, titled "J-agents-09 #<n>", run in order on one verified TEST account with an agent of its own that has
// run. Memory is visible, clearable and switchable off; Privacy shows what is kept and for how long, and a period with
// no stored value reads "not set" and refuses a write that needs it.
// Every step is built (AG-builder-02, AG-guardrails-04). A run on the Test page writes a remembered item only when asked
// to ("remember that ..."), with a `remember` row in its own log; the Memory page lists each item with a link to its
// source run, clears one item, and switches memory off. Clearing an item leaves the run that remembered it, and that log
// row, on the Runs page's test runs: a test run is never in the person's live action log (Activity), which holds
// sessions only, so the run's own log is the action log this step keeps. Privacy reads every retention period from the
// owner's values, none of which the stack stores, and Sharing runs the privacy check before anything is shared.
const J = 'J-agents-09';
const agents = agentsRun(J);

test.describe.configure({ mode: 'default' });

const main = (page) => page.getByRole('main');
const memory = (page) => tableIn(main(page), 'Remembered items');
const testPanel = (page) => main(page).getByRole('region', { name: 'Test' });
const memorySwitch = (page) => main(page).getByRole('switch', { name: 'Remember between runs' });
/** What the last run did with a request to remember. */
const memoryOutcome = (page) => testPanel(page).getByTestId('memory-outcome');
/** The Runs page's test runs, each with its own log. */
async function openTestRuns(page) {
  await openOwnAgent(page, agents, 'Runs');
  await main(page).getByRole('tab', { name: 'Test runs' }).click();
  return tableIn(main(page), 'Test runs');
}

/** Runs the own agent once from its Test page with `question`. */
async function runOnce(page, question) {
  await openOwnAgent(page, agents, 'Test');
  await testPanel(page)
    .getByRole('textbox', { name: /^Ask the agent/ })
    .fill(question, UNBUILT);
  await testPanel(page).getByRole('button', { name: 'Run a test' }).click();
}

test(`${J} starts: a verified TEST account with an agent of its own that has run and remembered an item`, async ({ page }) => {
  test.setTimeout(240_000);
  await agents.start(page, 'ag09', '10');
  await signIn(page, agents.account());
  await createOwnAgent(page);
  await runOnce(page, 'TEST: remember that I prefer limit orders');
  await expect(memoryOutcome(page)).toHaveText(
    'Remembered “I prefer limit orders”. It is on the Memory page, with this run as its source.',
  );
});

test(`${J} #1 opens the agent's Memory page after a run that remembered an item: the item with its source run`, async ({ page }) => {
  await openOwnAgent(page, agents, 'Memory');
  const item = memory(page).getByRole('row').filter({ hasText: 'limit orders' });
  await expect(item).toHaveCount(1, UNBUILT);
  await expect(item.getByRole('cell').first()).toHaveText('I prefer limit orders');
  const source = item.getByRole('link', { name: /^Source run/ });
  await expect(source).toBeVisible();
  // The source is the run that remembered it: following it opens that test run, whose log holds the remember step.
  const runId = await source.getAttribute('data-run-id');
  await source.click();
  const run = tableIn(main(page), 'Test runs').locator(`tr[data-run-id="${runId}"]`);
  await expect(run).toHaveAttribute('aria-current', 'true');
  await expect(run).toContainText('remember that I prefer limit orders');
  await expect(run.getByTestId('test-run-log')).toContainText('Remembered: I prefer limit orders');
});

test(`${J} #2 clears one item: only that item goes and the action log row stays`, async ({ page }) => {
  await openOwnAgent(page, agents, 'Memory');
  // A second item, so "only that item goes" is seen: the other one stays.
  await runOnce(page, 'TEST: remember that I trade BTC and ETH');
  await expect(memoryOutcome(page)).toContainText('Remembered “I trade BTC and ETH”');
  await openOwnAgent(page, agents, 'Memory');
  await expect(memory(page).getByRole('row').filter({ hasText: 'BTC and ETH' })).toHaveCount(1);
  const rows = await memory(page).getByRole('row').count();
  const item = memory(page).getByRole('row').filter({ hasText: 'limit orders' });
  const runId = await item.getByRole('link', { name: /^Source run/ }).getAttribute('data-run-id');
  await item.getByRole('button', { name: 'Clear' }).click(UNBUILT);
  await expect(main(page).getByRole('status').filter({ hasText: 'Cleared.' })).toHaveText(
    'Cleared. The run that remembered it keeps its log.',
  );
  await expect(memory(page).getByRole('row')).toHaveCount(rows - 1);
  await expect(memory(page).getByRole('row').filter({ hasText: 'limit orders' })).toHaveCount(0);
  await expect(memory(page).getByRole('row').filter({ hasText: 'BTC and ETH' })).toHaveCount(1);
  // Read again from svc-agents, the item is gone for good.
  await page.reload();
  await openOwnAgent(page, agents, 'Memory');
  await expect(memory(page).getByRole('row').filter({ hasText: 'BTC and ETH' })).toHaveCount(1);
  await expect(memory(page).getByRole('row').filter({ hasText: 'limit orders' })).toHaveCount(0);
  // The run that remembered it, and its log row of the remember step, stay.
  const runs = await openTestRuns(page);
  await expect(runs.locator(`tr[data-run-id="${runId}"]`).getByTestId('test-run-log')).toContainText('Remembered: I prefer limit orders');
});

test(`${J} #3 switches memory off: no item is written and the run says so`, async ({ page }) => {
  await openOwnAgent(page, agents, 'Memory');
  await memorySwitch(page).setChecked(false, UNBUILT);
  await expect(memorySwitch(page)).not.toBeChecked();
  await expect(main(page).getByTestId('memory-state')).toHaveText('Memory is off for this agent.');
  const rows = await memory(page).getByRole('row').count();
  await runOnce(page, 'TEST: remember that I trade on Mondays');
  await expect(memoryOutcome(page)).toHaveText('Memory is off: nothing was remembered.');
  await expect(memoryOutcome(page)).toHaveRole('status');
  await openOwnAgent(page, agents, 'Memory');
  await expect(memorySwitch(page)).not.toBeChecked();
  await expect(memory(page).getByRole('row')).toHaveCount(rows);
  await expect(memory(page)).not.toContainText('Mondays');
});

test(`${J} #4 asks the agent to remember an account number: the item is refused`, async ({ page }) => {
  await openOwnAgent(page, agents, 'Memory');
  // Memory on, so a refusal is the sensitive-data rule and never memory being off.
  await memorySwitch(page).setChecked(true, UNBUILT);
  await expect(memorySwitch(page)).toBeChecked();
  const rows = await memory(page).getByRole('row').count();
  await runOnce(page, 'TEST: remember my account number DE89 3704 0044 0532 0130 00');
  await expect(memoryOutcome(page)).toHaveRole('alert');
  await expect(memoryOutcome(page)).toContainText('agents.memory_item_refused');
  await expect(memoryOutcome(page)).not.toContainText('DE89');
  // Nor is it kept as the run's question or log.
  await expect(testPanel(page)).not.toContainText('DE89');
  await openOwnAgent(page, agents, 'Memory');
  await expect(memory(page).getByRole('row')).toHaveCount(rows);
  await expect(memory(page)).not.toContainText('DE89');
});

test(`${J} #5 opens Privacy with no retention value stored: each period reads "not set" and a write needing one refuses`, async ({
  page,
}) => {
  await openOwnAgent(page, agents, 'Privacy');
  const retention = tableIn(main(page), 'What is kept and for how long');
  await expect(retention.getByRole('row').nth(1)).toBeVisible(UNBUILT);
  // Every kind kept is listed, each with its period as svc-agents reads it: none stored, so each reads "not set".
  for (const kind of ['Action log', 'Remembered items', 'Transcripts', 'Approval requests', 'Usage records'])
    await expect(retention.getByRole('row').filter({ hasText: kind }).getByTestId('retention-period')).toHaveText('not set');
  await expect(retention.getByTestId('retention-period')).toHaveCount(5);
  // Keeping transcripts needs the transcript period: refused with the retention-unset code, and nothing is stored.
  const keep = main(page).getByRole('switch', { name: 'Keep transcripts' });
  await expect(keep).not.toBeChecked();
  await keep.click();
  await expect(main(page).getByRole('alert')).toContainText('agents.retention_unset');
  await expect(keep).not.toBeChecked();
  await page.reload();
  await openOwnAgent(page, agents, 'Privacy');
  await expect(main(page).getByRole('switch', { name: 'Keep transcripts' })).not.toBeChecked();
});

test(`${J} #6 shares the agent in a way that would expose a transcript: the privacy check lists it and waits for a confirmation`, async ({
  page,
}) => {
  await openOwnAgent(page, agents, 'Sharing');
  await main(page).getByRole('checkbox', { name: 'Include past transcripts' }).check(UNBUILT);
  await expect(main(page).getByTestId('share-state')).toHaveText('Not shared');
  await main(page).getByRole('button', { name: 'Share', exact: true }).click();
  const check = page.getByRole('dialog', { name: 'Privacy check' });
  await expect(check.getByRole('listitem')).toHaveCount(1);
  await expect(check.getByRole('listitem').filter({ hasText: 'Transcripts' })).toBeVisible();
  // The check waits: confirming is the person's act, offered and not taken.
  await expect(check.getByRole('button', { name: 'Confirm and share' })).toBeEnabled();
  await page.waitForTimeout(1_000);
  await expect(check).toBeVisible();
  // Nothing is shared until the person confirms: cancelled, it reads not shared, and so after reading it again.
  await check.getByRole('button', { name: 'Cancel' }).click();
  await expect(check).toHaveCount(0);
  await expect(main(page).getByTestId('share-state')).toHaveText('Not shared');
  await page.reload();
  await openOwnAgent(page, agents, 'Sharing');
  await expect(main(page).getByTestId('share-state')).toHaveText('Not shared');
});
