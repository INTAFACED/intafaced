import { test, expect } from './journey.mjs';
import { UNBUILT, agentsRun, createOwnAgent, openAgents, openOwnAgent, tableIn } from './agents.mjs';
import { signIn } from './desk.mjs';

// J-agents-09, in the running app (docs/roadmap/journeys.json): control what my agents remember and keep about me. One
// test per step, titled "J-agents-09 #<n>", run in order on one verified TEST account with an agent of its own that has
// run. Memory is visible, clearable and switchable off; Privacy shows what is kept and for how long, and a period with
// no stored value reads "not set" and refuses a write that needs it.
// Every step is written; none is built yet, so each fails at its first missing part, quickly (UNBUILT):
// - the person cannot create an agent yet (no builder at /agents/new), so there are no Memory, Privacy or Sharing pages
//   (AG-builder-02, AG-guardrails-04).
const J = 'J-agents-09';
const agents = agentsRun(J);

test.describe.configure({ mode: 'default' });

const main = (page) => page.getByRole('main');
const memory = (page) => tableIn(main(page), 'Remembered items');
const testPanel = (page) => main(page).getByRole('region', { name: 'Test' });

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
});

test(`${J} #1 opens the agent's Memory page after a run that remembered an item: the item with its source run`, async ({ page }) => {
  await openOwnAgent(page, agents, 'Memory');
  const item = memory(page).getByRole('row').filter({ hasText: 'limit orders' });
  await expect(item).toHaveCount(1, UNBUILT);
  await expect(item.getByRole('link', { name: /^Source run/ })).toBeVisible();
});

test(`${J} #2 clears one item: only that item goes and the action log row stays`, async ({ page }) => {
  await openOwnAgent(page, agents, 'Memory');
  const rows = await memory(page).getByRole('row').count();
  await memory(page).getByRole('row').filter({ hasText: 'limit orders' }).getByRole('button', { name: 'Clear' }).click(UNBUILT);
  await expect(memory(page).getByRole('row')).toHaveCount(rows - 1);
  // The run that remembered it is still in the person's action log.
  await openAgents(page, agents, 'Activity');
  await expect(main(page).getByRole('heading', { name: 'No agent actions have been recorded' })).toHaveCount(0);
});

test(`${J} #3 switches memory off: no item is written and the run says so`, async ({ page }) => {
  await openOwnAgent(page, agents, 'Memory');
  await main(page).getByRole('switch', { name: 'Remember between runs' }).setChecked(false, UNBUILT);
  const rows = await memory(page).getByRole('row').count();
  await runOnce(page, 'TEST: remember that I trade on Mondays');
  await expect(testPanel(page).getByRole('status')).toContainText('Memory is off: nothing was remembered.');
  await openOwnAgent(page, agents, 'Memory');
  await expect(memory(page).getByRole('row')).toHaveCount(rows);
});

test(`${J} #4 asks the agent to remember an account number: the item is refused`, async ({ page }) => {
  await openOwnAgent(page, agents, 'Memory');
  // Memory on, so a refusal is the sensitive-data rule and never memory being off.
  await main(page).getByRole('switch', { name: 'Remember between runs' }).setChecked(true, UNBUILT);
  await runOnce(page, 'TEST: remember my account number DE89 3704 0044 0532 0130 00');
  await expect(testPanel(page).getByRole('alert')).toContainText('agents.memory.sensitive_refused');
  await openOwnAgent(page, agents, 'Memory');
  await expect(memory(page)).not.toContainText('DE89');
});

test(`${J} #5 opens Privacy with no retention value stored: each period reads "not set" and a write needing one refuses`, async ({
  page,
}) => {
  await openOwnAgent(page, agents, 'Privacy');
  const retention = tableIn(main(page), 'What is kept and for how long');
  await expect(retention.getByRole('row').nth(1)).toBeVisible(UNBUILT);
  await expect(retention.getByTestId('retention-period')).not.toHaveCount(0);
  await expect(retention.getByTestId('retention-period').filter({ hasNotText: /^not set$/ })).toHaveCount(0);
  await main(page).getByRole('switch', { name: 'Keep transcripts' }).click();
  await expect(main(page).getByRole('alert')).toContainText('agents.retention.unset');
});

test(`${J} #6 shares the agent in a way that would expose a transcript: the privacy check lists it and waits for a confirmation`, async ({
  page,
}) => {
  await openOwnAgent(page, agents, 'Sharing');
  await main(page).getByRole('checkbox', { name: 'Include past transcripts' }).check(UNBUILT);
  await main(page).getByRole('button', { name: 'Share' }).click();
  const check = page.getByRole('dialog', { name: 'Privacy check' });
  await expect(check.getByRole('listitem').filter({ hasText: 'Transcripts' })).toBeVisible();
  await expect(check.getByRole('button', { name: 'Confirm and share' })).toBeEnabled();
  // Nothing is shared until the person confirms.
  await check.getByRole('button', { name: 'Cancel' }).click();
  await expect(main(page).getByTestId('share-state')).toHaveText('Not shared');
});
