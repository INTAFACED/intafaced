import { test, expect } from '@playwright/test';
import { UNBUILT, agentsRun, openNavigatorSession, tableIn } from './agents.mjs';
import { signIn, signUp } from './desk.mjs';

// J-agents-06, in the running app (docs/roadmap/journeys.json): run an agent in the background, pause or stop it, and
// get the result later. One test per step, titled "J-agents-06 #<n>", run in order on one verified TEST account with a
// metered session open. Stop settles open windows once and releases the reservation; a stop sent twice returns the first
// result. Email, SMS and push show their vendor notice (vendor.email, vendor.sms, vendor.push); the inbox row is written.
// Two background runs: #1 starts a short one that #2 reads when it has finished; #3 starts a long one (many steps) that
// #3 to #6 pause, resume and stop while it is still going. #7 is another person trying the first run's id.
// Every step is written; none is built yet, so each fails at its first missing part, quickly (UNBUILT):
// - opening a session is refused for a standard account ("agents:execute"), and there are no background runs, run
//   pages, pause, resume or stop (AG-sessions-04, AG-control-01).
const J = 'J-agents-06';
const agents = agentsRun(J);

test.describe.configure({ mode: 'default' });

const main = (page) => page.getByRole('main');
const workspace = (page) => main(page).getByRole('region', { name: 'Session workspace' });
const runPage = (page) => main(page).getByRole('region', { name: 'Run' });

/** Starts a background run in a new session and keeps its id in the run file under `key`. */
async function startInBackground(page, key, question) {
  await openNavigatorSession(page, agents);
  await workspace(page)
    .getByRole('textbox', { name: /^Ask the agent/ })
    .fill(question);
  await workspace(page).getByRole('checkbox', { name: 'Run in the background' }).check();
  await workspace(page).getByRole('button', { name: 'Run' }).click();
  const runId = await workspace(page).getByTestId('run-id').innerText();
  expect(runId).toMatch(/^[0-9a-f-]{36}$/);
  agents.run.write({ [key]: runId });
  return runId;
}

/** Opens the run kept under `key`, from the run file. */
async function openRun(page, key) {
  const runId = agents.run.read()[key];
  if (!runId) throw new Error(`${J} started no "${key}" background run, so this step has no run to open`);
  await signIn(page, agents.account());
  await page.goto(`/agents/runs/${runId}`);
  await expect(runPage(page)).toBeVisible(UNBUILT);
}

test(`${J} starts: a verified TEST account with a metered Navigator session open`, async ({ page }) => {
  test.setTimeout(240_000);
  await agents.start(page, 'ag06', '20');
  await openNavigatorSession(page, agents);
});

test(`${J} #1 starts a run as a background run and leaves the screen: a run id and a status; the run goes on without the page`, async ({
  page,
}) => {
  await startInBackground(page, 'shortRun', 'TEST: list the markets');
  await expect(workspace(page).getByTestId('run-status')).toHaveText(/Queued|Running/);
  await page.goto('/home');
  // Away from the page, the run still moves on.
  await openRun(page, 'shortRun');
  await expect(runPage(page).getByTestId('run-status')).toHaveText(/Running|Completed/);
});

test(`${J} #2 receives the finish notice: an inbox row and a run page with the result; with email chosen and no mail vendor the notice shows its vendor text`, async ({
  page,
}) => {
  await signIn(page, agents.account());
  await page.goto('/home');
  await page.getByRole('button', { name: /^Notifications/ }).click();
  await page
    .getByRole('dialog', { name: /Notifications/ })
    .getByRole('link', { name: /Your agent run finished/ })
    .click(UNBUILT);
  await expect(runPage(page).getByTestId('run-status')).toHaveText('Completed');
  await expect(runPage(page).getByRole('region', { name: 'Reply' })).not.toBeEmpty();
  await expect(runPage(page).getByRole('note').filter({ hasText: 'vendor.email' })).toBeVisible();
});

test(`${J} #3 pauses a running run: no further step starts and a new request gets the paused code`, async ({ page }) => {
  await startInBackground(page, 'longRun', 'TEST: check every market one by one and summarise each');
  await openRun(page, 'longRun');
  await runPage(page).getByRole('button', { name: 'Pause' }).click();
  await expect(runPage(page).getByTestId('run-status')).toHaveText('Paused');
  const steps = await tableIn(runPage(page), 'Steps').getByRole('row').count();
  await page.waitForTimeout(5_000);
  await expect(tableIn(runPage(page), 'Steps').getByRole('row')).toHaveCount(steps);
  await runPage(page).getByRole('button', { name: 'Ask more' }).click();
  await expect(runPage(page).getByRole('alert')).toContainText('agents.run.paused');
});

test(`${J} #4 resumes it: it continues from the stored state`, async ({ page }) => {
  await openRun(page, 'longRun');
  const steps = await tableIn(runPage(page), 'Steps').getByRole('row').count();
  await runPage(page).getByRole('button', { name: 'Resume' }).click();
  await expect(runPage(page).getByTestId('run-status')).toHaveText('Running');
  // It picks up where it stopped: the earlier steps are kept, not run again, and new ones follow.
  await expect.poll(() => tableIn(runPage(page), 'Steps').getByRole('row').count()).toBeGreaterThan(steps);
  await expect(runPage(page)).toContainText('Resumed from the stored state');
});

test(`${J} #5 stops a run while a tool call is in flight: the call finishes and is stored, nothing more runs, completed actions are not undone`, async ({
  page,
}) => {
  await openRun(page, 'longRun');
  await expect(tableIn(runPage(page), 'Steps').getByRole('row').last()).toContainText('Tool call in progress');
  await runPage(page).getByRole('button', { name: 'Stop' }).click();
  await expect(runPage(page).getByTestId('run-status')).toHaveText('Stopped');
  await expect(tableIn(runPage(page), 'Steps').getByRole('row').last()).toContainText('Finished after stop');
  await expect(runPage(page)).toContainText('Actions already completed are not undone.');
});

test(`${J} #6 presses Stop again: the first result is returned`, async ({ page }) => {
  await openRun(page, 'longRun');
  await runPage(page).getByRole('button', { name: 'Stop' }).click();
  await expect(runPage(page).getByRole('status')).toContainText('Already stopped: the first result is shown.');
});

test(`${J} #7 tries to stop another person's run id: not found`, async ({ browser }) => {
  test.setTimeout(240_000);
  const { shortRun } = agents.run.read();
  if (!shortRun) throw new Error(`${J} #1 started no background run, so there is no run of this person's to try`);
  // Another TEST person, in their own browser, opens this person's run.
  const other = await browser.newContext();
  try {
    const stranger = await other.newPage();
    const who = await signUp(stranger, 'ag06x');
    await signIn(stranger, who);
    await stranger.goto(`/agents/runs/${shortRun}`);
    await expect(stranger.getByRole('main').getByRole('heading', { name: 'Run not found' })).toBeVisible(UNBUILT);
    await expect(stranger.getByRole('main').getByRole('button', { name: 'Stop' })).toHaveCount(0);
  } finally {
    await other.close();
  }
});
