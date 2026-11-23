// World: restart
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { agentsRead, agentsRun, openNavigatorSession } from './agents.mjs';
import { signIn } from './desk.mjs';
import { ROOT, restartService } from './stack.mjs';

// J-agents-20, in the founder console (docs/roadmap/journeys.json): change the model routing table with an audit. One
// test per step, titled "J-agents-20 #<n>", run in order by the stack's two LOCAL TEST founders on More modules
// (/more-ops), whose Agents part shows "Task routes and prices", and one verified TEST person whose open session and
// new runs the steps read. Each route's provider and model alias come from the stack's configuration
// (AGENTS_ROUTING_TABLE in tooling/profiles/test-owner-values/agents.json); founders change a route's output ceiling and
// rates, and a change takes two distinct founders and writes one audit row naming both (svc-agents `routes.propose`,
// `routes.confirm`).
// #2 changes index.embed, the route no journey runs, and withdraws it. #3 changes navigator.plan, the task the person's
// Navigator session runs, while that session is open, and puts it back the same way in a finally, so the stack's other
// journeys meet the table as it was. The session keeps the guardrail it copied when it opened: svc-agents' own record of
// it (session.detail) reads the same before and after, open, on the guardrail version the Navigator had when it opened.
// #4 swaps the provider behind the configured alias in configuration: svc-agents is restarted, the same build, with its
// live model adapter in place of the stand-in engine, pointed at a TEST engine this file runs on loopback
// (LOCAL_STACK_AGENTS_UPSTREAM_URL). A new run (the person's Coach question) is answered by that engine, which receives
// the route's model alias from configuration; the svc-agents binary and its source are byte for byte what they were.
// Then the stand-in engine comes back.
const J = 'J-agents-20';
const agents = agentsRun(J);
/** #2's route: one no journey runs. */
const QUIET_ROUTE = 'index.embed';
/** #3's route: the task the person's Navigator session runs. */
const SESSION_ROUTE = 'navigator.plan';
/** The Coach lesson #4's new runs are asked from (J-agents-17). */
const LESSON = '/academy/foundations-risk-first?path=foundations';
/** What the TEST engine #4 runs answers every completion with. */
const UPSTREAM_REPLY = 'TEST engine reply: size sets the loss you can take; entry only sets where it starts.';

test.describe.configure({ mode: 'default' });

const routes = (page) => page.getByTestId('read-agents.routes');
const row = (page, task) => routes(page).getByRole('row').filter({ hasText: task });
const ceilingOf = (page, task) => row(page, task).getByRole('cell').nth(2);
/** The routing table's audit log as the console lists it: one line per proposal, withdrawal and confirmation. */
const confirmations = (page, task) =>
  page
    .getByTestId('agents-routes-audit')
    .getByRole('listitem')
    .filter({ hasText: `Confirmed ${task}` });

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

/** Founder A asks for `ceiling` as `task`'s output ceiling, and founder B confirms it on their own console. */
async function changeCeiling(browser, task, ceiling) {
  const a = await openRoutes(browser, 'a');
  await row(a, task).getByRole('button', { name: 'Change route', exact: true }).click();
  const sheet = a.getByRole('dialog', { name: `Change ${task}`, exact: true });
  await sheet.getByRole('textbox', { name: /^Output ceiling/ }).fill(ceiling);
  await sheet.getByRole('button', { name: 'Ask a second founder', exact: true }).click();
  await expect(row(a, task)).toContainText('Pending a second founder');
  const b = await openRoutes(browser, 'b');
  await row(b, task).getByRole('button', { name: 'Confirm change', exact: true }).click();
  await expect(ceilingOf(b, task)).toHaveText(ceiling);
}

const read = (procedure, input) => agentsRead(agents, procedure, input);

const coach = (page) => page.getByRole('main').getByRole('region', { name: 'Coach', exact: true });
/** The tRPC answer's data, whether or not the transport wraps it. */
const dataOf = (body) => body?.result?.data?.json ?? body?.result?.data;
/** The person asks the Coach `question` in the lesson (a new run): the answer region and svc-agents' answer. */
async function askCoach(page, question) {
  await signIn(page, agents.account());
  await page.goto(LESSON);
  const panel = coach(page);
  await expect(panel.getByTestId('coach-cost')).toBeVisible();
  await panel.getByRole('textbox', { name: /^Ask the Coach/ }).fill(question);
  const reply = page.waitForResponse((res) => res.url().includes('coach.runSession') && res.request().method() === 'POST');
  await panel.getByRole('button', { name: 'Ask', exact: true }).click();
  const response = await reply;
  expect(response.status()).toBe(200);
  return { answer: panel.getByRole('region', { name: 'Coach answer', exact: true }), data: dataOf(await response.json()) };
}

/**
 * A TEST engine on loopback speaking the live adapter's completion shape (svc-agents gateway/providers.rs
 * UpstreamProvider): every completion is answered with UPSTREAM_REPLY and exact token counts, and kept in `calls`.
 */
function testEngine() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      calls.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : null });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          content: [{ type: 'text', text: UPSTREAM_REPLY }],
          usage: { input_tokens: 12, output_tokens: 18 },
          stop_reason: 'end_turn',
        }),
      );
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        calls,
        close: () => new Promise((done) => server.close(done)),
      }),
    ),
  );
}

/** What svc-agents runs: the stack's binary (local-test-stack.mjs rustBin) by its hash, and its crate's source tree in git. */
function svcAgentsBuild() {
  const binary = createHash('sha256')
    .update(readFileSync(path.join(ROOT, 'crates/svc-agents/dist/svc-agents')))
    .digest('hex');
  const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' }).trim();
  return {
    binary,
    source: git('rev-parse', 'HEAD:crates/svc-agents'),
    edits: git('status', '--porcelain', '--', 'crates/svc-agents', 'crates/service-kit'),
  };
}

test(`${J} starts: both LOCAL TEST founders signed in to the console, and a verified TEST person`, async ({ browser, page }) => {
  test.setTimeout(300_000);
  await openRoutes(browser, 'a');
  await openRoutes(browser, 'b');
  expect(consoles.a.handle).not.toBe(consoles.b.handle);
  await agents.start(page, 'ag20', '10');
});

test(`${J} #1 opens the routing table: each task with provider alias, model alias and rate, or "not set"`, async ({
  browser,
  stepPicture,
}) => {
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
  await stepPicture(page);
});

test(`${J} #2 changes a route as the only founder: it stays pending`, async ({ browser, stepPicture }) => {
  const page = await openRoutes(browser);
  const before = await ceilingOf(page, QUIET_ROUTE).innerText();
  const asked = String(Number(before) + 1);
  await row(page, QUIET_ROUTE).getByRole('button', { name: 'Change route', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: `Change ${QUIET_ROUTE}`, exact: true });
  await sheet.getByRole('textbox', { name: /^Output ceiling/ }).fill(asked);
  await sheet.getByRole('button', { name: 'Ask a second founder', exact: true }).click();
  await expect(row(page, QUIET_ROUTE)).toContainText('Pending a second founder');
  await expect(ceilingOf(page, QUIET_ROUTE)).toHaveText(before);
  // Read again from svc-agents: still pending, the table as it was, and its own founder cannot confirm it.
  await page.reload();
  await expect(row(page, QUIET_ROUTE).getByTestId('route-pending')).toContainText(`ceiling ${asked}`);
  await expect(ceilingOf(page, QUIET_ROUTE)).toHaveText(before);
  await expect(row(page, QUIET_ROUTE).getByRole('button', { name: 'Confirm change', exact: true })).toHaveCount(0);
  await stepPicture(page);
  // Withdraw it, so #3 starts from the table as it was.
  await row(page, QUIET_ROUTE).getByRole('button', { name: 'Withdraw change', exact: true }).click();
  await expect(row(page, QUIET_ROUTE).getByRole('button', { name: 'Change route', exact: true })).toBeVisible();
  await expect(ceilingOf(page, QUIET_ROUTE)).toHaveText(before);
});

test(`${J} #3 a second founder confirms: the table changes once with an audit row naming both; sessions open at the time keep their copied guardrail`, async ({
  browser,
  page,
  stepPicture,
}) => {
  test.setTimeout(240_000);
  // The person's Navigator session, open before the change, on the guardrail the Navigator has now.
  const sessionId = await openNavigatorSession(page, agents);
  const navigator = await read('agent.get', { agentId: 'navigator' });
  expect(navigator.limits.allowedTasks).toContain(SESSION_ROUTE);
  const opened = await read('session.detail', { sessionId });
  expect(opened.session).toMatchObject({ id: sessionId, agentId: 'navigator', status: 'open', closedAt: null });
  expect(opened.session.guardrailVersion).toBe(navigator.version);

  const founderA = await openRoutes(browser);
  const before = await ceilingOf(founderA, SESSION_ROUTE).innerText();
  const confirmedBefore = await confirmations(founderA, SESSION_ROUTE).count();
  const changed = String(Number(before) - 1);
  try {
    await changeCeiling(browser, SESSION_ROUTE, changed);
    const a = await openRoutes(browser, 'a');
    await expect(ceilingOf(a, SESSION_ROUTE)).toHaveText(changed);
    const audit = row(a, SESSION_ROUTE).getByTestId('route-audit');
    await expect(audit).toContainText(`Changed by ${consoles.a.handle}, confirmed by ${consoles.b.handle}`);
    // Once: one confirmation more in the audit log, naming both founders, with the route before and after.
    await expect(confirmations(a, SESSION_ROUTE)).toHaveCount(confirmedBefore + 1);
    await expect(confirmations(a, SESSION_ROUTE).first()).toContainText(`by ${consoles.b.handle}, asked by ${consoles.a.handle}`);
    await expect(confirmations(a, SESSION_ROUTE).first()).toContainText(`Before: ceiling ${before}`);
    await expect(confirmations(a, SESSION_ROUTE).first()).toContainText(`After: ceiling ${changed}`);
    // The session open at the time keeps its copied guardrail: svc-agents' record of it is as it was when it opened,
    // still open, on the same guardrail version, and the Navigator's guardrail itself is untouched by a route change.
    const kept = await read('session.detail', { sessionId });
    expect(kept.session).toEqual(opened.session);
    expect(await read('agent.get', { agentId: 'navigator' })).toEqual(navigator);
    await stepPicture(a);
  } finally {
    // Put the route back the same way, so the stack's other journeys meet the table as it was.
    const a = await openRoutes(browser, 'a');
    if ((await ceilingOf(a, SESSION_ROUTE).innerText()) !== before) await changeCeiling(browser, SESSION_ROUTE, before);
  }
});

test(`${J} #4 swaps the provider in configuration: new runs use the new provider with the source unchanged`, async ({
  browser,
  page,
  stepPicture,
}) => {
  test.setTimeout(420_000);
  const config = configured();
  const coachRoute = config.find((r) => r.task === 'coach.answer');
  let founder = await openRoutes(browser);
  const before = {};
  for (const r of config) before[r.task] = await cells(founder, r.task);
  for (const r of config) expect(before[r.task]['Engine for new runs'], r.task).toBe('Stand-in engine (sandbox)');

  const engine = await testEngine();
  try {
    // A run before the swap: the stand-in engine answers, and the TEST engine hears nothing.
    const first = await askCoach(page, 'TEST: why does position size matter more than entry?');
    expect(first.data).toMatchObject({ status: 'answered', engine: 'sandbox' });
    expect(first.data.answer).toMatch(new RegExp(`^mock:${coachRoute.model}:`));
    await expect(first.answer).toHaveAttribute('data-engine', 'sandbox');
    expect(engine.calls).toEqual([]);

    // The swap: configuration only. The same build restarted with the live model adapter behind the configured alias.
    const build = svcAgentsBuild();
    await restartService('agents', { LOCAL_STACK_AGENTS_SANDBOX_ENGINE: 'off', LOCAL_STACK_AGENTS_UPSTREAM_URL: engine.url });
    founder = await openRoutes(browser);
    for (const r of config) {
      const after = await cells(founder, r.task);
      await expect(row(founder, r.task).getByTestId('route-engine')).toHaveText('Live model adapter');
      // Everything else as it was: the aliases, the ceiling, the rates and the last change, all from configuration.
      expect({ ...after, 'Engine for new runs': '' }, r.task).toEqual({ ...before[r.task], 'Engine for new runs': '' });
      expect(after['Set in'], r.task).toBe('From configuration');
    }

    // A new run uses the new provider: the TEST engine answers it, once, asked for the route's model alias.
    const second = await askCoach(page, 'TEST: why does position size matter more than entry, once more?');
    expect(second.data).toMatchObject({ status: 'answered', engine: 'live', answer: UPSTREAM_REPLY });
    await expect(second.answer).toHaveAttribute('data-engine', 'live');
    await expect(second.answer).toContainText(UPSTREAM_REPLY);
    await stepPicture(page);
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]).toMatchObject({ method: 'POST', path: '/v1/messages', body: { model: coachRoute.model } });
    expect(JSON.stringify(engine.calls[0].body.messages)).toContain('once more?');
    // The source unchanged: svc-agents runs the same binary, built from the same tree, with no edit in its crate or the kit it builds on.
    expect(svcAgentsBuild()).toEqual(build);
    expect(build.edits).toBe('');
  } finally {
    await restartService('agents', { LOCAL_STACK_AGENTS_SANDBOX_ENGINE: null, LOCAL_STACK_AGENTS_UPSTREAM_URL: null });
    await engine.close();
  }
  founder = await openRoutes(browser);
  for (const r of config) await expect(row(founder, r.task).getByTestId('route-engine')).toHaveText('Stand-in engine (sandbox)');
});
