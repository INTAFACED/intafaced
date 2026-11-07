// World: none
import { readFileSync } from 'node:fs';
import { test, expect } from './journey.mjs';
import { agentsRun, createOwnAgent, openAgents, openNavigatorSession, openOwnAgent, tableIn } from './agents.mjs';
import { signIn } from './desk.mjs';
import { api, toUnits } from './stack.mjs';

// J-agents-13, in the running app (docs/roadmap/journeys.json): review what my agents did: analytics, a run trace and my
// activity log. One test per step, titled "J-agents-13 #<n>", run in order on one verified TEST account.
// The start: a metered Navigator session that ran once in the app and was closed (its usage window sealed and settled),
// 600 refused requests in it through Edge (a task the Navigator may not run, refused before any engine call and billed
// nothing), so the log holds more than the 500 rows a screen loads; and one test run of an agent of the person's own
// (never billed), so the dashboard has a test run to leave out.
// Every figure the screens show is checked against the service's own stored rows, read through Edge as the person.
// Stack limit: one run makes one UTC day's rows, so "sessions across several days" is one day here; the by-day table is
// still checked row for row against the stored rows. Money: read only; displayed spend equals the sum of sealed windows.
const J = 'J-agents-13';
const agents = agentsRun(J);
const REFUSED = 600;
const ASK = 'TEST: list the markets';

test.describe.configure({ mode: 'default' });

const main = (page) => page.getByRole('main');
const dashboard = (page) => main(page).getByRole('region', { name: 'Agent dashboard' });

/** Sums decimal USDT cells such as "0.0001234 USDT" as scaled bigints, never floats. */
const sum = (cells) => cells.reduce((total, cell) => total + toUnits(cell.replace(/[^\d.]/g, '') || '0'), 0n);

/** One svc-agents procedure through Edge as the run's person. */
async function agentsCall(procedure, input, method = 'GET') {
  const door = await api(agents.account());
  return method === 'GET'
    ? door.get(`/api/agents/trpc/${procedure}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`)
    : door.post(`/api/agents/trpc/${procedure}`, input);
}
async function agentsRead(procedure, input) {
  const res = await agentsCall(procedure, input);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

/** Every stored log row of the person, of one outcome or all, read page by page through the export read. */
async function storedLog(outcome) {
  const rows = [];
  let cursor;
  do {
    const page = await agentsRead('log.export', { limit: 500, ...(outcome ? { outcome } : {}), ...(cursor ? { cursor } : {}) });
    rows.push(...page.rows);
    cursor = page.nextCursor;
  } while (cursor);
  return rows;
}

/** The session the start ran, from the run file; a later step after a failed start says so. */
function ranSession() {
  const { sessionId } = agents.run.read();
  if (!sessionId) throw new Error(`${J} start ran no session, so this step has no session to read`);
  return sessionId;
}

/** The stored sealed windows of the run's session, and their sum. */
async function sealedWindows() {
  const detail = await agentsRead('session.detail', { sessionId: ranSession() });
  const sealed = detail.windows.filter((window) => window.state !== 'open');
  return { detail, sealed, total: sealed.reduce((total, window) => total + toUnits(window.amount), 0n) };
}

test(`${J} starts: a verified TEST account with a metered Navigator session that ran, 600 refusals and a test run`, async ({ page }) => {
  test.setTimeout(420_000);
  await agents.start(page, 'ag13', '20');
  const sessionId = await openNavigatorSession(page, agents);
  agents.run.write({ ...agents.run.read(), sessionId });
  const workspace = main(page).getByRole('region', { name: 'Session workspace' });
  await workspace.getByRole('textbox', { name: /^Ask the agent/ }).fill(ASK);
  const answered = page.waitForResponse((res) => res.url().endsWith('/api/agents/trpc/run.complete'));
  await workspace.getByRole('button', { name: 'Run' }).click();
  await page
    .getByRole('dialog', { name: 'Confirm the spend ceiling' })
    .getByRole('button', { name: /^Run up to/ })
    .click();
  const ran = await answered;
  expect(ran.status()).toBe(200);
  const { requestId } = JSON.parse(ran.request().postData());
  agents.run.write({ ...agents.run.read(), requestId, cost: (await ran.json()).result.data.cost });

  // 600 requests the Navigator may not run, each refused and logged before the engine, billing nothing.
  const door = await api(agents.account());
  for (let start = 0; start < REFUSED; start += 20) {
    const answers = await Promise.all(
      Array.from({ length: Math.min(20, REFUSED - start) }, (_, i) =>
        door.post('/api/agents/trpc/run.complete', {
          sessionId,
          requestId: `${sessionId}:refused:${start + i}`,
          task: 'support.reply',
          messages: [{ role: 'user', content: 'TEST: a task this agent may not run' }],
        }),
      ),
    );
    for (const answer of answers) expect(answer.status, JSON.stringify(answer.body).slice(0, 300)).toBe(403);
  }
  // Closed: its open window settles once, so it is sealed.
  const closed = await door.post('/api/agents/trpc/session.close', { sessionId });
  expect(closed.status, JSON.stringify(closed.body).slice(0, 300)).toBe(200);
  const { sealed } = await sealedWindows();
  expect(sealed).toHaveLength(1);
  expect(sealed[0].state).toBe('settled');

  // One test run of an agent of the person's own, on its Test panel: labelled TEST and never billed.
  await signIn(page, agents.account());
  await createOwnAgent(page);
  await openOwnAgent(page, agents, 'Test');
  const panel = main(page).getByRole('region', { name: 'Test' });
  await panel.getByRole('textbox', { name: /^Ask the agent/ }).fill('TEST question');
  await panel.getByRole('button', { name: 'Run a test' }).click();
  await expect(panel.getByRole('region', { name: 'Engine run' })).toBeVisible();
});

test(`${J} #1 opens the dashboard for a date range: counts, outcomes by day and spend equal to the stored rows; test and dry runs out unless the filter includes them; a blank range value refuses`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openAgents(page, agents, 'Dashboard');
  const today = new Date().toISOString().slice(0, 10);
  const from = dashboard(page).getByRole('textbox', { name: /^From/ });
  const to = dashboard(page).getByRole('textbox', { name: /^To/ });
  const show = dashboard(page).getByRole('button', { name: 'Show' });

  // A blank range value refuses, naming the value, and shows no figures.
  await from.fill(today);
  await to.fill('');
  await show.click();
  await expect(dashboard(page).getByRole('alert')).toContainText('To is not set');
  await expect(tableIn(dashboard(page), 'Outcomes by day')).toHaveCount(0);
  await from.fill('');
  await to.fill(today);
  await show.click();
  await expect(dashboard(page).getByRole('alert')).toContainText('From is not set');
  await expect(tableIn(dashboard(page), 'Outcomes by day')).toHaveCount(0);

  // The stored rows: every log row of the person, the sessions they opened, and the run session's sealed windows.
  const log = await storedLog();
  const count = (status) => log.filter((row) => row.status === status).length;
  const sessions = (await agentsRead('session.mine', { limit: 100 })).items;
  const { total: sealedTotal } = await sealedWindows();
  expect(log.length).toBeGreaterThan(REFUSED);
  expect(sealedTotal).toBeGreaterThan(0n);
  const tests = await (async () => {
    const own = await agentsRead('own.list', { limit: 50 });
    let n = 0;
    for (const agent of own) n += (await agentsRead('own.testRuns', { id: agent.id, limit: 50 })).length;
    return n;
  })();
  expect(tests).toBeGreaterThan(0);

  // Live only, by default: the filter says so and the test runs are left out.
  await from.fill(today);
  await to.fill(today);
  const include = dashboard(page).getByRole('checkbox', { name: 'Include test and dry runs' });
  await expect(include).not.toBeChecked();
  await show.click();
  await expect(dashboard(page).getByRole('status').filter({ hasText: 'Filter in force' })).toContainText('Test and dry runs are left out');
  const figure = (key) => dashboard(page).getByTestId(`dashboard-${key}`);
  await expect(figure('sessions')).toHaveText(String(sessions.length));
  await expect(figure('actions')).toHaveText(String(log.length));
  await expect(figure('executed')).toHaveText(String(count('executed')));
  await expect(figure('refused')).toHaveText(String(count('refused')));
  await expect(figure('failed')).toHaveText(String(count('failed')));
  await expect(figure('test-runs')).toHaveText('Left out');
  // Displayed spend equals the sum of the sealed windows.
  expect(sum([await figure('spend').innerText()])).toBe(sealedTotal);

  // Outcomes by day: one row per day that holds stored rows, each the sum of that day's rows.
  const byDay = tableIn(dashboard(page), 'Outcomes by day');
  const days = [...new Set([...log.map((row) => row.occurredAt.slice(0, 10)), ...sessions.map((row) => row.openedAt.slice(0, 10))])].sort();
  await expect(byDay.locator('tbody tr')).toHaveCount(days.length);
  for (const day of days) {
    const row = byDay.locator('tbody tr').filter({ has: page.getByRole('cell', { name: day, exact: true }) });
    const of = (status) => log.filter((r) => r.occurredAt.slice(0, 10) === day && (!status || r.status === status)).length;
    await expect(row.getByTestId('day-sessions')).toHaveText(String(sessions.filter((s) => s.openedAt.slice(0, 10) === day).length));
    await expect(row.getByTestId('day-actions')).toHaveText(String(of()));
    await expect(row.getByTestId('day-executed')).toHaveText(String(of('executed')));
    await expect(row.getByTestId('day-refused')).toHaveText(String(of('refused')));
    await expect(row.getByTestId('day-failed')).toHaveText(String(of('failed')));
  }
  expect(sum(await byDay.getByTestId('day-spend').allInnerTexts())).toBe(sealedTotal);

  // With the filter including them, the test runs are counted, and nothing else changes: they are never billed.
  await include.check();
  await show.click();
  await expect(dashboard(page).getByRole('status').filter({ hasText: 'Filter in force' })).toContainText('plus test and dry runs');
  await expect(figure('test-runs')).toHaveText(String(tests));
  await expect(figure('sessions')).toHaveText(String(sessions.length));
  await expect(figure('actions')).toHaveText(String(log.length));
  expect(sum([await figure('spend').innerText()])).toBe(sealedTotal);
  expect((await byDay.getByTestId('day-test-runs').allInnerTexts()).reduce((n, cell) => n + Number(cell), 0)).toBe(tests);
});

test(`${J} #2 opens one run's trace: tool calls, timing, cost and the plan as timed steps`, async ({ page }) => {
  const { requestId, cost } = agents.run.read();
  if (!requestId) throw new Error(`${J} start ran no run, so there is no trace to open`);
  await openAgents(page, agents, 'Sessions');
  const records = main(page).getByRole('region', { name: 'Recorded sessions' });
  await records.getByRole('row').filter({ hasText: ranSession() }).getByRole('button', { name: 'Inspect session' }).click();
  const selected = main(page).getByRole('region', { name: 'Selected session' });
  await tableIn(selected, 'Runs in this session')
    .getByRole('row')
    .filter({ hasText: requestId })
    .getByRole('button', { name: 'Open trace' })
    .click();
  const trace = tableIn(selected, 'Run trace');
  for (const column of ['Step', 'Tool', 'Started', 'Took', 'Tokens', 'Cost'])
    await expect(trace.getByRole('columnheader', { name: column, exact: true })).toBeVisible();

  // The plan as timed steps: the run's stored events, in order, each with when it started and how long it took.
  const runs = await agentsRead('run.list', { sessionId: ranSession(), limit: 500 });
  const run = runs.find((row) => row.requestId === requestId);
  const { events } = await agentsRead('run.events', { runId: run.runId, limit: 50 });
  const plan = trace.getByTestId('trace-plan-step');
  await expect(plan).toHaveCount(events.length);
  expect(events.map((event) => event.state)).toEqual(['admitted', 'running', 'completed']);
  for (const [index, event] of events.entries()) {
    const step = plan.nth(index);
    await expect(step).toContainText(`Plan ${event.sequence}: ${event.state}`);
    await expect(step).toContainText(`${event.occurredAt.slice(11, 23)} UTC`);
    const next = events[index + 1];
    await expect(step.getByTestId('trace-took')).toHaveText(
      next ? `${Date.parse(next.occurredAt) - Date.parse(event.occurredAt)} ms` : 'the run ended here',
    );
  }

  // The tool calls: the engine call the run made, for its task, timed, with its tokens and its exact cost.
  const stored = (await storedLog('executed')).find((row) => row.kind === 'completion' && row.sessionId === ranSession());
  const call = trace.getByTestId('trace-call');
  await expect(call).toHaveCount(1);
  await expect(call).toContainText(`Call ${stored.sequence}: engine call, executed`);
  await expect(call.getByRole('cell').nth(1)).toHaveText(stored.task);
  await expect(call.getByTestId('trace-took')).toHaveText(/^\d+ ms$/);
  await expect(call).toContainText(`${stored.inputTokens} in, ${stored.outputTokens} out`);
  expect(sum([await call.getByTestId('trace-cost').innerText()])).toBe(toUnits(stored.cost));
  expect(toUnits(stored.cost)).toBe(toUnits(cost));
  expect(sum([await selected.getByTestId('trace-run-cost').innerText()])).toBe(toUnits(cost));
});

test(`${J} #3 opens Activity and filters to refused: only refused rows, the refusal code as words, no prompt text`, async ({ page }) => {
  await openAgents(page, agents, 'Activity');
  await expect(main(page).getByRole('heading', { name: 'Your agent action log' })).toBeVisible();
  await main(page).getByRole('combobox', { name: 'Outcome' }).selectOption({ label: 'Refused' });
  const refused = await storedLog('refused');
  expect(refused.length).toBeGreaterThanOrEqual(REFUSED);
  await expect(main(page).getByTestId('log-total')).toHaveText(String(refused.length));
  const log = tableIn(main(page), 'Agent actions');
  const outcomes = log.getByTestId('action-outcome');
  await expect(outcomes).toHaveCount(50);
  await expect(outcomes.filter({ hasNotText: /^Refused$/ })).toHaveCount(0);
  // Each refusal reads as words: no reason cell is a bare code, and no code is shown in it.
  const reasons = await log.getByTestId('action-reason').allInnerTexts();
  expect(reasons).toHaveLength(50);
  for (const reason of reasons) {
    expect(reason).not.toMatch(/agents\.[a-z_.]+/);
    expect(reason.trim().split(/\s+/).length).toBeGreaterThan(2);
  }
  // No prompt text: neither the asked question nor a refused request's text appears.
  await expect(log).not.toContainText(ASK);
  await expect(log).not.toContainText('a task this agent may not run');
});

test(`${J} #4 presses Export on a log of 600 actions with 500 loaded: the file has every row and the same filter applies, in two formats`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openAgents(page, agents, 'Activity');
  const outcome = main(page).getByRole('combobox', { name: 'Outcome' });
  await outcome.selectOption({ label: 'All' });
  await main(page).getByRole('combobox', { name: 'Rows to load' }).selectOption('500');
  const all = await storedLog();
  expect(all.length).toBeGreaterThan(REFUSED);
  await expect(main(page).getByTestId('log-total')).toHaveText(String(all.length));
  await expect(tableIn(main(page), 'Agent actions').locator('tbody tr')).toHaveCount(500);
  const format = main(page).getByRole('combobox', { name: 'Export format' });
  await expect(format.getByRole('option')).toHaveText(['CSV', 'JSON']);

  const exportFile = async () => {
    const download = page.waitForEvent('download');
    await main(page).getByRole('button', { name: 'Export' }).click();
    return readFileSync(await (await download).path(), 'utf8');
  };
  // CSV: a header and one line per stored row, more than the 500 loaded.
  const csv = (await exportFile()).trim().split(/\r?\n/);
  expect(csv[0]).toBe('occurred_at,agent,session,sequence,kind,status,tool_or_task,input_tokens,output_tokens,cost,refusal_code');
  expect(csv.length - 1).toBe(all.length);
  expect(new Set(csv.slice(1).map((line) => `${line.split(',')[2]}:${line.split(',')[3]}`))).toEqual(
    new Set(all.map((row) => `${row.sessionId}:${row.sequence}`)),
  );
  await expect(main(page).getByRole('status').filter({ hasText: 'Exported' })).toHaveText(`Exported ${all.length} rows.`);

  // JSON, filtered to refused: one object per stored refused row, and only refused rows.
  await outcome.selectOption({ label: 'Refused' });
  await format.selectOption({ label: 'JSON' });
  const refused = await storedLog('refused');
  const lines = (await exportFile())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(lines).toHaveLength(refused.length);
  expect(lines.every((row) => row.status === 'refused')).toBe(true);
  expect(new Set(lines.map((row) => row.id))).toEqual(new Set(refused.map((row) => row.id)));
});

test(`${J} #5 opens usage by agent, user and task: totals match the sum of the windows`, async ({ page }) => {
  await openAgents(page, agents, 'Usage');
  const usage = main(page).getByRole('region', { name: 'Usage' });
  const windows = tableIn(usage, 'Usage windows');
  const { sealed, total } = await sealedWindows();
  // The windows are the stored sealed windows, each at its stored amount.
  await expect(windows.locator('tbody tr')).toHaveCount(sealed.length);
  for (const window of sealed) {
    const row = windows.locator('tbody tr').filter({ hasText: window.windowId });
    expect(sum([await row.getByTestId('window-cost').innerText()])).toBe(toUnits(window.amount));
  }
  const windowSum = sum(await windows.getByTestId('window-cost').allInnerTexts());
  expect(windowSum).toBe(total);
  expect(windowSum).toBeGreaterThan(0n);
  // Each breakdown adds up to the windows, and so does the total shown.
  for (const breakdown of ['By agent', 'By user', 'By task']) {
    const table = tableIn(usage, breakdown);
    await expect(table.locator('tbody tr')).not.toHaveCount(0);
    expect(sum(await table.getByTestId('usage-cost').allInnerTexts())).toBe(windowSum);
  }
  await expect(tableIn(usage, 'By agent').locator('tbody tr').filter({ hasText: 'navigator' })).toHaveCount(1);
  // A personal account: the only user is the person, whose sessions every window belongs to.
  await expect(tableIn(usage, 'By user').locator('tbody tr')).toHaveCount(1);
  expect(sum([await usage.getByTestId('usage-total').innerText()])).toBe(windowSum);
});
