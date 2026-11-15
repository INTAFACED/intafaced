// World: restart, book
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { agentsRun } from './agents.mjs';
import { ROOT, api, restartWith } from './stack.mjs';

// J-agents-20, in the founder console (docs/roadmap/journeys.json): change the model routing table with an audit. One
// test per step, titled "J-agents-20 #<n>", run in order by the stack's two LOCAL TEST founders on More modules
// (/more-ops), whose Agents part shows "Task routes and prices". Each route's provider and model alias come from the
// stack's configuration (AGENTS_ROUTING_TABLE in tooling/profiles/test-owner-values/agents.json); founders change a
// route's output ceiling and rates, and a change takes two distinct founders and writes one audit row naming both
// (svc-agents `routes.propose`, `routes.confirm`). #2 and #3 change the output ceiling of index.embed, the route no
// journey runs, and #3 puts it back the same way, so the stack's other journeys meet the table as it was.
// #3 and #4 also act as a funded TEST customer the start makes, through Edge: #3 opens a Navigator session before the
// change and reads it after the confirm (the same guardrail version, still open, and a run in it answers); #4 runs the
// Navigator before the swap (the stand-in engine answers), after it (the run reaches the live adapter, which nothing
// answers on a test stack: agents.error.engine_unavailable) and after the stand-in engine is back (it answers again).
// #4 swaps the provider in configuration by restarting svc-agents with the live model adapter in place of the stand-in
// engine (LOCAL_STACK_AGENTS_SANDBOX_ENGINE=off), the same build: the table shows the new engine for new runs, the same
// provider and model aliases from configuration, and the founders' change kept. Then the stand-in engine comes back.
const J = 'J-agents-20';
const ROUTE = 'index.embed';
const agents = agentsRun(J);
/** The task the Navigator runs (its guardrail allows navigator.plan and navigator.tool_select). */
const RUN_TASK = 'navigator.plan';

/** One svc-agents call as the start's TEST customer, on their own sign-in through Edge. */
async function personCall(procedure, input, method = 'GET') {
  const door = await api(agents.account());
  const path = `/api/agents/trpc/${procedure}`;
  return method === 'GET'
    ? door.get(`${path}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`)
    : door.post(path, input);
}
const data = (answer) => {
  expect(answer.status, JSON.stringify(answer.body).slice(0, 300)).toBe(200);
  return answer.body.result.data;
};
/** A new Navigator session of the customer's, and one run in it: the raw answer. */
async function navigatorRun(label) {
  const session = data(await personCall('session.open', { agentId: 'navigator' }, 'POST'));
  const answer = await personCall(
    'run.complete',
    { sessionId: session.id, requestId: `${session.id}:${label}`, task: RUN_TASK, messages: [{ role: 'user', content: `TEST ${label}` }] },
    'POST',
  );
  return { session, answer };
}

test.describe.configure({ mode: 'default' });

const routes = (page) => page.getByTestId('read-agents.routes');
const row = (page, task = ROUTE) => routes(page).getByRole('row').filter({ hasText: task });
const ceilingOf = (page) => row(page).getByRole('cell').nth(2);
/** The routing table's audit log as the console lists it: one line per proposal, withdrawal and confirmation. */
const confirmations = (page) =>
  page
    .getByTestId('agents-routes-audit')
    .getByRole('listitem')
    .filter({ hasText: `Confirmed ${ROUTE}` });

/** The stack's routing table as configuration sets it: the profile's routes, then the Coach route the stack appends. */
function configured() {
  const { values } = JSON.parse(readFileSync(path.join(ROOT, 'tooling/profiles/test-owner-values/agents.json'), 'utf8'));
  return [...JSON.parse(values.AGENTS_ROUTING_TABLE.value).routes, JSON.parse(values.AGENTS_COACH_ROUTE.value)];
}
/** One route row's cells as the table holds them, by column name (text content: the console's headers render in capitals). */
async function cells(page, task) {
  const header = await routes(page).getByRole('columnheader').allTextContents();
  const values = await row(page, task).getByRole('cell').allTextContents();
  return Object.fromEntries(header.map((name, i) => [name.trim(), (values[i] ?? '').trim()]));
}

/**
 * Each founder's console, signed in once per worker in a browser context of its own, as J-agents-16 does: every sign-in
 * must send a TOTP step no earlier sign-in spent, so a fresh sign-in per step could wait a whole 30 s step inside the
 * step's own budget. The start signs both founders in; each step opens More modules by its URL.
 */
const consoles = {};
async function openRoutes(browser, key = 'a') {
  if (!consoles[key]) {
    const page = await (await browser.newContext()).newPage();
    const { handle } = await founderSignIn(page, key);
    consoles[key] = { page, handle };
  }
  const { page } = consoles[key];
  await page.goto(`${ADMIN}/more-ops`);
  await expect(routes(page).getByRole('table')).toBeVisible();
  return page;
}

/** Founder A asks for `ceiling` as ROUTE's output ceiling, and founder B confirms it on their own console. */
async function changeCeiling(browser, ceiling) {
  const a = await openRoutes(browser, 'a');
  await row(a).getByRole('button', { name: 'Change route' }).click();
  const sheet = a.getByRole('dialog', { name: `Change ${ROUTE}` });
  await sheet.getByRole('textbox', { name: /^Output ceiling/ }).fill(ceiling);
  await sheet.getByRole('button', { name: 'Ask a second founder' }).click();
  await expect(row(a)).toContainText('Pending a second founder');
  const b = await openRoutes(browser, 'b');
  await row(b).getByRole('button', { name: 'Confirm change' }).click();
  await expect(ceilingOf(b)).toHaveText(ceiling);
}

test(`${J} starts: both LOCAL TEST founders signed in to the console, and a funded TEST customer`, async ({ browser, page }) => {
  test.setTimeout(240_000);
  await agents.start(page, 'ag20', '10');
  await openRoutes(browser, 'a');
  await openRoutes(browser, 'b');
  expect(consoles.a.handle).not.toBe(consoles.b.handle);
});

test(`${J} #1 opens the routing table: each task with provider alias, model alias and rate, or "not set"`, async ({ browser }) => {
  const page = await openRoutes(browser);
  for (const column of ['Task', 'Provider', 'Model', 'Input per million', 'Output per million'])
    await expect(routes(page).getByRole('columnheader', { name: column })).toBeVisible();
  const config = configured();
  await expect(routes(page).getByRole('row')).toHaveCount(config.length + 1);
  // Each alias and rate is configuration's, and a rate configuration does not publish reads "not set".
  const shown = (value) => (value === undefined ? 'not set' : String(Number(value)));
  for (const route of config) {
    const c = await cells(page, route.task);
    expect(c, route.task).toMatchObject({
      Task: route.task,
      Provider: route.providerId,
      Model: route.model,
      'Input per million': shown(route.price?.inputPerMillion),
      'Output per million': shown(route.price?.outputPerMillion),
    });
  }
});

test(`${J} #2 changes a route as the only founder: it stays pending`, async ({ browser }) => {
  const page = await openRoutes(browser);
  const before = await ceilingOf(page).innerText();
  await row(page).getByRole('button', { name: 'Change route' }).click();
  const sheet = page.getByRole('dialog', { name: `Change ${ROUTE}` });
  await sheet.getByRole('textbox', { name: /^Output ceiling/ }).fill(String(Number(before) + 1));
  await sheet.getByRole('button', { name: 'Ask a second founder' }).click();
  await expect(row(page)).toContainText('Pending a second founder');
  await expect(ceilingOf(page)).toHaveText(before);
  // Read again from svc-agents: still pending, the table as it was, and its own founder cannot confirm it.
  await page.reload();
  await expect(row(page).getByTestId('route-pending')).toContainText(`ceiling ${Number(before) + 1}`);
  await expect(ceilingOf(page)).toHaveText(before);
  await expect(row(page).getByRole('button', { name: 'Confirm change' })).toHaveCount(0);
  // Withdraw it, so #3 starts from the table as it was.
  await row(page).getByRole('button', { name: 'Withdraw change' }).click();
  await expect(row(page).getByRole('button', { name: 'Change route' })).toBeVisible();
  await expect(ceilingOf(page)).toHaveText(before);
});

test(`${J} #3 a second founder confirms: the table changes once with an audit row naming both founders`, async ({ browser }) => {
  const page = await openRoutes(browser);
  const before = await ceilingOf(page).innerText();
  const confirmedBefore = await confirmations(page).count();
  const changed = String(Number(before) + 1);
  // A customer's Navigator session, open at the time of the change.
  const open = data(await personCall('session.open', { agentId: 'navigator' }, 'POST'));
  try {
    await changeCeiling(browser, changed);
    // The session keeps the guardrail it copied when it opened, stays open, and still runs under it.
    const kept = data(await personCall('session.detail', { sessionId: open.id })).session;
    expect(kept).toMatchObject({ id: open.id, status: 'open', guardrailVersion: open.guardrailVersion, openedAt: open.openedAt });
    const ran = data(
      await personCall(
        'run.complete',
        {
          sessionId: open.id,
          requestId: `${open.id}:after-change`,
          task: RUN_TASK,
          messages: [{ role: 'user', content: 'TEST after the change' }],
        },
        'POST',
      ),
    );
    expect(ran.text.trim()).not.toBe('');
    const a = await openRoutes(browser, 'a');
    await expect(ceilingOf(a)).toHaveText(changed);
    const audit = row(a).getByTestId('route-audit');
    await expect(audit).toContainText(`Changed by ${consoles.a.handle}, confirmed by ${consoles.b.handle}`);
    // Once: one confirmation more in the audit log, naming both founders.
    await expect(confirmations(a)).toHaveCount(confirmedBefore + 1);
    await expect(confirmations(a).first()).toContainText(`by ${consoles.b.handle}, asked by ${consoles.a.handle}`);
    await expect(confirmations(a).first()).toContainText(`Before: ceiling ${before}`);
    await expect(confirmations(a).first()).toContainText(`After: ceiling ${changed}`);
  } finally {
    // Put the route back the same way, so the stack's other journeys meet the table as it was.
    const a = await openRoutes(browser, 'a');
    if ((await ceilingOf(a).innerText()) !== before) await changeCeiling(browser, before);
    await personCall('session.close', { sessionId: open.id }, 'POST');
  }
});

test(`${J} #4 swaps the provider in configuration: new runs use the new provider with the source unchanged`, async ({ browser }) => {
  test.setTimeout(300_000);
  let page = await openRoutes(browser);
  const config = configured();
  const before = {};
  for (const r of config) before[r.task] = await cells(page, r.task);
  for (const r of config) expect(before[r.task]['Engine for new runs'], r.task).toBe('Stand-in engine (sandbox)');
  // A new run before the swap is answered by the stand-in engine.
  const sandbox = await navigatorRun('before-swap');
  expect(data(sandbox.answer).text.trim()).not.toBe('');
  await personCall('session.close', { sessionId: sandbox.session.id }, 'POST');
  // The same build restarted with the live model adapter as the configured provider: a configuration change only.
  restartWith('agents', 'LOCAL_STACK_AGENTS_SANDBOX_ENGINE', false);
  try {
    page = await openRoutes(browser);
    for (const r of config) {
      const after = await cells(page, r.task);
      expect(after['Engine for new runs'], r.task).toBe('Live model adapter');
      // Everything else as it was: the aliases, where they are set, the ceiling, the rates and the last change.
      expect({ ...after, 'Engine for new runs': '' }, r.task).toEqual({ ...before[r.task], 'Engine for new runs': '' });
      expect(after['Set in'], r.task).toBe('From configuration');
    }
    // A new run now goes to the new provider: the live adapter, which nothing answers on a test stack.
    const live = await navigatorRun('after-swap');
    expect(live.answer.status, JSON.stringify(live.answer.body).slice(0, 300)).not.toBe(200);
    expect(live.answer.body.error.message).toBe('agents.error.engine_unavailable');
    await personCall('session.close', { sessionId: live.session.id }, 'POST');
  } finally {
    restartWith('agents', 'LOCAL_STACK_AGENTS_SANDBOX_ENGINE', true);
  }
  page = await openRoutes(browser);
  for (const r of config) await expect(row(page, r.task).getByTestId('route-engine')).toHaveText('Stand-in engine (sandbox)');
  // And with the stand-in engine back in configuration, a new run is answered by it again.
  const back = await navigatorRun('swapped-back');
  expect(data(back.answer).text.trim()).not.toBe('');
  await personCall('session.close', { sessionId: back.session.id }, 'POST');
});
