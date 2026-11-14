// World: none
import { test, expect } from './journey.mjs';
import { UNBUILT, agentsRun, openNavigatorSession, tableIn } from './agents.mjs';
import { signIn, signUp } from './desk.mjs';
import { api } from './stack.mjs';

// J-agents-06, in the running app (docs/roadmap/journeys.json): run an agent in the background, pause or stop it, and
// get the result later. One test per step, titled "J-agents-06 #<n>", run in order on one verified TEST account with a
// metered session open. Stop settles open windows once and releases the reservation; a stop sent twice returns the first
// result. Email, SMS and push show their vendor notice (vendor.email, vendor.sms, vendor.push); the inbox row is written.
// Two background runs: #1 starts a short one that #2 reads when it has finished; #3 starts a long one (many steps) that
// #3 to #6 pause, resume and stop while it is still going. #7 is another person trying the first run's id.
// A background run takes at most the steps the person sets; each step is one metered engine call on the session, shown
// "Call in progress" from its start until its reply is stored. The run's page (/agents/runs/<id>) reads it again every
// second while it is still going.
const J = 'J-agents-06';
const agents = agentsRun(J);

test.describe.configure({ mode: 'default' });

const main = (page) => page.getByRole('main');
const workspace = (page) => main(page).getByRole('region', { name: 'Session workspace' });
const runPage = (page) => main(page).getByRole('region', { name: 'Run' });

/** One of svc-agents' background run reads through Edge, as `who` on a sign-in of its own: the status and answer. */
async function runRead(who, runId) {
  const res = await (await api(who)).get(`/api/agents/trpc/run.background.get?input=${encodeURIComponent(JSON.stringify({ runId }))}`);
  return { status: res.status, run: res.body?.result?.data ?? null, body: res.body };
}
/** The person's own run, read from svc-agents: its stored state, steps and stop result. */
async function ownRun(key) {
  const read = await runRead(agents.account(), agents.run.read()[key]);
  expect(read.status, JSON.stringify(read.body).slice(0, 300)).toBe(200);
  return read.run;
}
/** The text of every row of the run page's Steps table, header included. */
const stepRows = (page) => tableIn(runPage(page), 'Steps').getByRole('row').allInnerTexts();

/** Starts a background run of at most `steps` steps in a new session, telling the person by `notice`, and keeps its id in
 * the run file under `key`. */
async function startInBackground(page, key, question, { steps = '1', notice = 'In the app only' } = {}) {
  await openNavigatorSession(page, agents);
  await workspace(page)
    .getByRole('textbox', { name: /^Ask the agent/ })
    .fill(question);
  await workspace(page).getByRole('checkbox', { name: 'Run in the background' }).check();
  await workspace(page).getByRole('textbox', { name: 'Most steps' }).fill(steps);
  await workspace(page).getByRole('combobox', { name: 'Tell me when it finishes' }).selectOption({ label: notice });
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
  // Email is chosen: the stack has no mail vendor, so #2 sees its notice and the inbox row still appears.
  await startInBackground(page, 'shortRun', 'TEST: list the markets', { notice: 'By email too' });
  await expect(workspace(page).getByTestId('run-status')).toHaveText(/Queued|Running/);
  await page.goto('/home');
  // Away from the page, the run still moves on: with no page of it open, svc-agents takes its step and completes it.
  await expect.poll(async () => (await ownRun('shortRun')).state, { timeout: 30_000 }).toBe('completed');
  const stored = await ownRun('shortRun');
  expect(stored.steps.map((step) => step.state)).toEqual(['done']);
  expect(stored.steps[0].reply).toBeTruthy();
  await openRun(page, 'shortRun');
  await expect(runPage(page).getByTestId('run-status')).toHaveText('Completed');
  await expect(tableIn(runPage(page), 'Steps').getByRole('row').nth(1)).toContainText('Done');
});

test(`${J} #2 receives the finish notice: an inbox row and a run page with the result; with email chosen and no mail vendor the notice shows its vendor text`, async ({
  page,
}) => {
  await signIn(page, agents.account());
  // The notice is written once the run has finished; the inbox is opened afresh until its row is there.
  await expect(async () => {
    await page.goto('/home');
    await page.getByRole('button', { name: /^Notifications/ }).click();
    await expect(page.getByRole('dialog', { name: /Notifications/ }).getByRole('link', { name: /Your agent run finished/ })).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 30_000 });
  await page
    .getByRole('dialog', { name: /Notifications/ })
    .getByRole('link', { name: /Your agent run finished/ })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`/agents/runs/${agents.run.read().shortRun}$`));
  await expect(runPage(page).getByTestId('run-status')).toHaveText('Completed');
  // The result shown is the run's stored reply, the one its last step got back.
  const stored = await ownRun('shortRun');
  expect(stored.reply).toBe(stored.steps.at(-1).reply);
  await expect(runPage(page).getByRole('region', { name: 'Reply' }).getByRole('paragraph')).toHaveText(stored.reply);
  await expect(runPage(page).getByRole('note').filter({ hasText: 'vendor.email' })).toBeVisible();
  // svc-notify's own record: exactly one notice for this run, and the email asked for was refused for its unset vendor.
  const notifyRead = async (procedure, input) => {
    const res = await (await api(agents.account())).get(`/api/notify/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`);
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    return res.body.result.data;
  };
  const notices = (await notifyRead('notify.list', { limit: 100 })).items.filter(
    ({ kind, params }) => kind === 'agents.run.completed' && params.runId === agents.run.read().shortRun,
  );
  expect(notices).toHaveLength(1);
  const deliveries = await notifyRead('notify.deliveries', { notificationId: notices[0].id });
  expect(deliveries.filter(({ channel }) => channel === 'email').map(({ status, refusalCode }) => ({ status, refusalCode }))).toEqual([
    { status: 'refused', refusalCode: 'channel.not_configured' },
  ]);
});

test(`${J} #3 pauses a running run: no further step starts and a new request gets the paused code`, async ({ page }) => {
  // Long enough to still be going while #3 to #5 pause, resume and stop it.
  await startInBackground(page, 'longRun', 'TEST: check every market one by one and summarise each', { steps: '60' });
  await openRun(page, 'longRun');
  await runPage(page).getByRole('button', { name: 'Pause' }).click();
  await expect(runPage(page).getByTestId('run-status')).toHaveText('Paused');
  const steps = await tableIn(runPage(page), 'Steps').getByRole('row').count();
  await page.waitForTimeout(5_000);
  await expect(tableIn(runPage(page), 'Steps').getByRole('row')).toHaveCount(steps);
  await runPage(page).getByRole('textbox', { name: 'Ask the run more' }).fill('TEST: and the next market');
  await runPage(page).getByRole('button', { name: 'Ask more' }).click();
  await expect(runPage(page).getByRole('alert')).toContainText('agents.run.paused');
});

test(`${J} #4 resumes it: it continues from the stored state`, async ({ page }) => {
  await openRun(page, 'longRun');
  const before = await ownRun('longRun');
  const shown = await stepRows(page);
  await runPage(page).getByRole('button', { name: 'Resume' }).click();
  await expect(runPage(page).getByTestId('run-status')).toHaveText('Running');
  await expect(runPage(page)).toContainText('Resumed from the stored state');
  // It picks up where it stopped: new steps follow, numbered on from the stored ones.
  await expect
    .poll(async () => (await ownRun('longRun')).steps.filter((step) => step.state === 'done').length)
    .toBeGreaterThan(before.steps.length);
  const after = await ownRun('longRun');
  expect(after.steps.map((step) => step.n)).toEqual(after.steps.map((_, i) => i + 1));
  // The steps taken before the pause are kept as they were, with the same replies and costs: none was run again.
  expect(after.steps.slice(0, before.steps.length)).toEqual(before.steps);
  await expect.poll(async () => (await stepRows(page)).length).toBeGreaterThan(shown.length);
  expect((await stepRows(page)).slice(0, shown.length)).toEqual(shown);
});

test(`${J} #5 stops a run while a tool call is in flight: the call finishes and is stored, nothing more runs, completed actions are not undone`, async ({
  page,
}) => {
  await openRun(page, 'longRun');
  await expect(tableIn(runPage(page), 'Steps').getByRole('row').last()).toContainText('Call in progress');
  await runPage(page).getByRole('button', { name: 'Stop' }).click();
  await expect(runPage(page).getByTestId('run-status')).toHaveText('Stopped');
  await expect(tableIn(runPage(page), 'Steps').getByRole('row').last()).toContainText('Finished after stop');
  await expect(runPage(page)).toContainText('Actions already completed are not undone.');
  // The call that was in flight finished and its result is stored: a reply and its metered cost.
  const stopped = await ownRun('longRun');
  const last = stopped.steps.at(-1);
  expect(stopped.state).toBe('stopped');
  expect(last.state).toBe('done_after_stop');
  expect(last.reply).toBeTruthy();
  expect(last.cost).toMatch(/^\d+(\.\d+)?$/);
  // Nothing further runs: no step is in flight, and none is added while we wait.
  expect(stopped.steps.filter((step) => step.state === 'in_flight')).toEqual([]);
  await page.waitForTimeout(5_000);
  expect((await ownRun('longRun')).steps).toEqual(stopped.steps);
  agents.run.write({ stopResult: stopped.stop, stoppedSteps: stopped.steps.length });
});

test(`${J} #6 presses Stop again: the first result is returned`, async ({ page }) => {
  const { stopResult, stoppedSteps } = agents.run.read();
  if (!stopResult) throw new Error(`${J} #5 kept no stop result, so there is nothing to compare the second stop with`);
  const door = await api(agents.account());
  const balancesBefore = await door.balances();
  await openRun(page, 'longRun');
  // The second Stop goes to svc-agents, which answers with the first stop's result and says it is a repeat.
  const answer = page.waitForResponse(
    (res) => res.url().includes('/api/agents/trpc/run.background.stop') && res.request().method() === 'POST',
  );
  await runPage(page).getByRole('button', { name: 'Stop' }).click();
  const second = await answer;
  expect(second.status()).toBe(200);
  const { repeated, run } = (await second.json()).result.data;
  expect(repeated).toBe(true);
  expect(run.state).toBe('stopped');
  expect(run.stop).toEqual(stopResult);
  expect(run.steps).toHaveLength(stoppedSteps);
  await expect(runPage(page).getByRole('status')).toContainText('Already stopped: the first result is shown.');
  // The first stop's result, exactly: the same settlement, nothing settled or charged again, no step run.
  const again = await ownRun('longRun');
  expect(again.stop).toEqual(stopResult);
  expect(again.steps).toHaveLength(stoppedSteps);
  expect(await door.balances()).toEqual(balancesBefore);
});

test(`${J} #7 tries to stop another person's run id: not found`, async ({ browser }) => {
  test.setTimeout(240_000);
  const { shortRun, longRun } = agents.run.read();
  if (!shortRun || !longRun) throw new Error(`${J} #1 started no background run, so there is no run of this person's to try`);
  // Another TEST person, in their own browser, opens this person's run.
  const other = await browser.newContext();
  try {
    const stranger = await other.newPage();
    const who = await signUp(stranger, 'ag06x');
    await signIn(stranger, who);
    await stranger.goto(`/agents/runs/${shortRun}`);
    await expect(stranger.getByRole('main').getByRole('heading', { name: 'Run not found' })).toBeVisible(UNBUILT);
    await expect(stranger.getByRole('main').getByRole('button', { name: 'Stop' })).toHaveCount(0);
    // A stop sent straight to the service for the person's run is refused as not found, as is a read of it.
    const theirs = await api(who);
    const stop = await theirs.post('/api/agents/trpc/run.background.stop', { runId: longRun });
    expect(stop.status).toBe(404);
    expect(JSON.stringify(stop.body)).toContain('agents.run_not_found');
    expect((await runRead(who, shortRun)).status).toBe(404);
    // The person's runs are as they were.
    expect((await ownRun('shortRun')).state).toBe('completed');
    expect((await ownRun('longRun')).stop).toEqual(agents.run.read().stopResult);
  } finally {
    await other.close();
  }
});
