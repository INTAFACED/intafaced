import { test, expect } from '@playwright/test';
import { UNBUILT, agentsRun, openNavigatorSession, tableIn } from './agents.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { PASSKEY_ORIGIN, addPasskey, virtualAuthenticator } from './identity-factors.mjs';
import { EDGE, api, json, toUnits } from './stack.mjs';

// J-agents-12, in the running app (docs/roadmap/journeys.json): read an agent's runs from my own code with the session
// API. One test per step, titled "J-agents-12 #<n>", run in order. The start is real: a verified TEST account funded with
// TEST USDT and holding a passkey (a key needs one) makes two TEST keys on the API keys page, a trade:read key without the
// agents scope and a key with agents:read, then runs Navigator once from the Agents room and once more with a task the
// agent may not run, which is refused and stored. A second TEST person makes an agents key of their own. Every later
// step is the person's own code: plain HTTP to Edge with a key, scoped to the key's account, checked against what the
// service tells the person on their own sign-in.
// Runs are metered exactly as in J-agents-01 (the stack's TEST rate card, tooling/profiles/test-owner-values/agents.json).
// Red by name, never counted: #2 (a run started from an API key) is overtaken by OWNER 107, which keeps running to the
// person's own session; #5 (webhooks) waits on the developer module's webhook delivery (developer-webhooks-001), which
// is not on main.
const J = 'J-agents-12';
const agents = agentsRun(J);

test.describe.configure({ mode: 'default' });

/** The asks the person types; neither may come back from any read. */
const ASK = 'TEST: where do I place a limit order?';
const REFUSED_ASK = 'TEST: write a support reply';
const LATER_ASK = 'TEST: and a stop order?';

/** One call of the agents API with `key`, as the person's code makes it: a query or a mutation, no browser. */
async function call(key, procedure, input, method = 'GET') {
  const url = new URL(`${EDGE}/api/agents/trpc/${procedure}`);
  if (method === 'GET' && input !== undefined) url.searchParams.set('input', JSON.stringify(input));
  return fetch(url, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
    body: method === 'POST' ? JSON.stringify(input) : undefined,
  }).then(json);
}

/** One agents call through Edge as the run's account, on its own sign-in (not a key): the independent source. */
async function personCall(procedure, input, method = 'GET') {
  const door = await api(agents.account());
  return method === 'GET'
    ? door.get(`/api/agents/trpc/${procedure}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`)
    : door.post(`/api/agents/trpc/${procedure}`, input);
}

/** The session's whole log as the person reads it, oldest first. */
async function personLog(sessionId) {
  const log = await personCall('session.log', { sessionId, limit: 500 });
  expect(log.status).toBe(200);
  return log.body.result.data;
}

/** A value an earlier step kept in the run file; a later step after a failed one says so instead of guessing. */
function kept(name) {
  const value = agents.run.read()[name];
  if (!value) throw new Error(`${J}: an earlier step left no ${name}, so this step has nothing to act on`);
  return value;
}

/** A service refusal: exactly this status and this typed code as its message, and no data. */
function refusedWith(answer, status, code) {
  expect(answer.status, JSON.stringify(answer.body).slice(0, 300)).toBe(status);
  expect(answer.body.result).toBeUndefined();
  expect(answer.body.error.message).toBe(code);
}

/** A scope refusal: 403 with the platform's one typed scope code, naming the missing scope, and no data. */
function scopeDenied(answer) {
  expect(answer.status, JSON.stringify(answer.body).slice(0, 300)).toBe(403);
  expect(answer.body.result).toBeUndefined();
  expect(answer.body.error.data.intafacedCode).toBe('scope.denied');
  expect(answer.body.error.message).toContain('agents:read');
}

/** Creates a key on the API keys page with the passkey's fresh step-up and returns its secret, shown once. */
async function createKey(page, name, choose) {
  await page.goto('/uc/safe/api-keys/new');
  await expect(page.getByRole('heading', { name: 'Create an API key' })).toBeVisible();
  await page.getByLabel('Key name').fill(name);
  await choose();
  await page.getByRole('button', { name: 'Create with a passkey', exact: true }).click();
  const key = (await page.getByTestId('api-keys__key').textContent())?.trim();
  expect(key).toMatch(/^ifc_[A-Za-z0-9_-]{20,}$/);
  await page.getByLabel('I have stored this key somewhere safe').check();
  await page.getByRole('button', { name: 'Done' }).click();
  return key;
}

/** Makes a key with agents:read alone, chosen by hand. */
const agentsKey = (page, name) =>
  createKey(page, name, async () => {
    await page.getByLabel('Choose', { exact: true }).check();
    await page.getByRole('checkbox', { name: /^agents:read/ }).check(UNBUILT);
  });

/** The exact cost the service's rate card puts on `usage` for `task`: each token count times its published rate per
 * million, rounded up once at the ledger's last place (services/svc-agents/src/metering/pricing.ts). */
async function rateCardCost(task, usage) {
  const routes = await personCall('routes.list');
  expect(routes.status).toBe(200);
  const matching = routes.body.result.data.filter((row) => row.task === task && row.capability === 'complete');
  expect(matching).toHaveLength(1);
  const MILLION = 1_000_000n;
  const part = (tokens, rate) => (BigInt(tokens) * toUnits(rate) + MILLION - 1n) / MILLION;
  return part(usage.inputTokens, matching[0].inputPerMillion) + part(usage.outputTokens, matching[0].outputPerMillion);
}

test(`${J} starts: a funded TEST account with a passkey, a key without the agents scope and a key with agents:read; one Navigator run from the room and one refused run; another person's agents key`, async ({
  browser,
}) => {
  test.setTimeout(360_000);
  const context = await browser.newContext({ baseURL: PASSKEY_ORIGIN });
  try {
    const page = await context.newPage();
    await virtualAuthenticator(page);
    const who = await agents.start(page, 'ag12', '100');
    await signIn(page, who);
    await addPasskey(page);
    // The read-only preset ticks every read scope, agents:read among them, so this key is chosen by hand.
    agents.run.write({
      offKey: await createKey(page, 'TEST agents-off', async () => {
        await page.getByLabel('Choose', { exact: true }).check();
        await page.getByRole('checkbox', { name: /^trade:read/ }).check();
      }),
    });
    agents.run.write({ onKey: await agentsKey(page, 'TEST agents-on') });

    // The person runs Navigator from the room: Run, then the spend ceiling, as in J-agents-01 #5.
    const sessionId = await openNavigatorSession(page, agents);
    const workspace = page.getByRole('main').getByRole('region', { name: 'Session workspace' });
    await workspace.getByRole('textbox', { name: /^Ask the agent/ }).fill(ASK);
    const sent = page.waitForRequest((req) => req.url().endsWith('/api/agents/trpc/run.complete'));
    const answered = page.waitForResponse((res) => res.url().endsWith('/api/agents/trpc/run.complete'));
    await workspace.getByRole('button', { name: 'Run' }).click();
    await page.getByRole('dialog', { name: 'Confirm the spend ceiling' }).getByRole('button', { name: 'Run up to 1 USDT' }).click();
    const { requestId } = JSON.parse((await sent).postData());
    const response = await answered;
    expect(response.status()).toBe(200);
    const run = (await response.json()).result.data;
    expect(run.text.trim()).not.toBe('');
    // The reply the person sees is the run's own text.
    await expect(workspace.getByRole('region', { name: 'Reply' }).getByTestId('more-body')).toHaveText(run.text, { timeout: 60_000 });
    await expect(tableIn(workspace, 'Runs').getByRole('row').nth(1)).toContainText('Completed');
    agents.run.write({
      sessionId,
      requestId,
      runId: run.runId,
      reply: run.text,
      cost: run.cost,
      assetId: run.assetId,
      task: run.action.task,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
    });

    // A task Navigator may not run, sent by the person on their own sign-in: refused, and stored as a refused run.
    const refusedRequestId = `${sessionId}:not-allowed`;
    const refused = await personCall(
      'run.complete',
      { sessionId, requestId: refusedRequestId, task: 'support.reply', messages: [{ role: 'user', content: REFUSED_ASK }] },
      'POST',
    );
    refusedWith(refused, 403, 'agents.refused.task_not_allowed');
    agents.run.write({ refusedRequestId });
  } finally {
    await context.close();
  }

  const other = await browser.newContext({ baseURL: PASSKEY_ORIGIN });
  try {
    const page = await other.newPage();
    await virtualAuthenticator(page);
    const someone = await signUp(page, 'ag12x');
    await verify(page, someone);
    await signIn(page, someone);
    await addPasskey(page);
    agents.run.write({ otherKey: await agentsKey(page, 'TEST someone else') });
  } finally {
    await other.close();
  }
});

test(`${J} #1 calls the session API with a key lacking the agents read scope: refused`, async () => {
  const sessionId = kept('sessionId');
  const runId = kept('runId');
  const before = await personLog(sessionId);
  const offKey = kept('offKey');
  // Every read of the session API, each refused with the one typed scope code and no data.
  scopeDenied(await call(offKey, 'session.mine', { limit: 10 }));
  scopeDenied(await call(offKey, 'session.log', { sessionId, limit: 50 }));
  scopeDenied(await call(offKey, 'session.events', { sessionId, limit: 50 }));
  scopeDenied(await call(offKey, 'run.list', { sessionId }));
  scopeDenied(await call(offKey, 'run.get', { runId }));
  scopeDenied(await call(offKey, 'run.events', { runId, limit: 50 }));
  // Nothing changed: the person's log reads exactly as before, and the key with the scope reads the same run.
  expect(await personLog(sessionId)).toEqual(before);
  const read = await call(kept('onKey'), 'run.get', { runId });
  expect(read.status).toBe(200);
  expect(read.body.result.data.state).toBe('completed');
});

test(`${J} #2 opens a background run with a key holding the scope: a run id and a status`, async () => {
  // STALE under OWNER 107 ("never from API keys or delegated tokens"): a run starts only from the person's own session,
  // so no key may start one. Red by name and never counted.
  throw new Error(
    `${J} #2 BLOCKED (OWNER 107): starting a run from an API key is overtaken by the owner's decision that runs start only from the person's own session`,
  );
});

test(`${J} #3 lists events from a cursor: only later actions, only for the caller's session`, async () => {
  const sessionId = kept('sessionId');
  const onKey = kept('onKey');
  const log = await personLog(sessionId);
  // The session so far, as the person's own log has it: the open, the Navigator run, the refused task.
  expect(log.map(({ sequence, kind, status }) => ({ sequence, kind, status }))).toEqual([
    { sequence: 0, kind: 'session_open', status: 'executed' },
    { sequence: 1, kind: 'completion', status: 'executed' },
    { sequence: 2, kind: 'completion', status: 'refused' },
  ]);
  expect(log[1].cost).toBe(kept('cost'));
  expect(log[2].refusalCode).toBe('agents.task_not_allowed');

  // From the start, one at a time: the first page is the open alone, and its cursor is that sequence.
  const first = await call(onKey, 'session.events', { sessionId, limit: 1 });
  expect(first.status).toBe(200);
  expect(first.body.result.data).toEqual({ events: [log[0]], cursor: '0' });
  // From that cursor: exactly the later actions, as the person's log has them.
  const rest = await call(onKey, 'session.events', { sessionId, cursor: '0', limit: 500 });
  expect(rest.status).toBe(200);
  expect(rest.body.result.data).toEqual({ events: log.slice(1), cursor: '2' });
  // Read to the end: nothing more, and the cursor stays.
  const end = await call(onKey, 'session.events', { sessionId, cursor: '2', limit: 500 });
  expect(end.status).toBe(200);
  expect(end.body.result.data).toEqual({ events: [], cursor: '2' });

  // The person runs again on their own sign-in; the saved cursor then returns that run's action alone.
  const later = await personCall(
    'run.complete',
    { sessionId, requestId: `${sessionId}:later`, task: kept('task'), messages: [{ role: 'user', content: LATER_ASK }] },
    'POST',
  );
  expect(later.status, JSON.stringify(later.body).slice(0, 300)).toBe(200);
  const laterRun = later.body.result.data;
  agents.run.write({ laterRunId: laterRun.runId });
  const after = await call(onKey, 'session.events', { sessionId, cursor: '2', limit: 500 });
  expect(after.status).toBe(200);
  const logNow = await personLog(sessionId);
  expect(logNow).toHaveLength(4);
  expect(after.body.result.data).toEqual({ events: [logNow[3]], cursor: '3' });
  expect(logNow[3]).toMatchObject({ id: laterRun.action.id, sequence: 3, kind: 'completion', status: 'executed', cost: laterRun.cost });
  // No ask the person typed comes back.
  for (const ask of [ASK, REFUSED_ASK, LATER_ASK]) expect(JSON.stringify([first.body, rest.body, after.body])).not.toContain(ask);

  // Only the caller's session: another person's agents key finds no such session, and a malformed cursor is refused.
  refusedWith(await call(kept('otherKey'), 'session.events', { sessionId, limit: 500 }), 404, 'agents.refused.session_closed');
  refusedWith(await call(onKey, 'session.events', { sessionId, cursor: 'x', limit: 500 }), 400, 'agents.refused.cursor_invalid');
  // The refusals changed nothing.
  expect(await personLog(sessionId)).toEqual(logNow);
});

test(`${J} #4 retrieves the finished run: the stored reply, cost and refusal codes as keys, no prompt text`, async () => {
  const sessionId = kept('sessionId');
  const onKey = kept('onKey');
  const runId = kept('runId');
  // The session's runs, oldest first: the room's run, the refused task, the later run.
  const list = await call(onKey, 'run.list', { sessionId });
  expect(list.status).toBe(200);
  expect(list.body.result.data).toEqual([
    { runId, requestId: kept('requestId'), state: 'completed', createdAt: expect.any(String) },
    { runId: expect.any(String), requestId: kept('refusedRequestId'), state: 'refused', createdAt: expect.any(String) },
    { runId: kept('laterRunId'), requestId: `${sessionId}:later`, state: 'completed', createdAt: expect.any(String) },
  ]);

  // The room's run: the reply the person saw, its cost at the published rate, no refusal.
  const finished = await call(onKey, 'run.get', { runId });
  expect(finished.status).toBe(200);
  expect(finished.body.result.data).toEqual({
    runId,
    sessionId,
    agentId: 'navigator',
    requestId: kept('requestId'),
    task: kept('task'),
    state: 'completed',
    reply: kept('reply'),
    cost: kept('cost'),
    assetId: kept('assetId'),
    metered: true,
    refusalCodes: [],
    createdAt: expect.any(String),
    updatedAt: expect.any(String),
  });
  const { inputTokens, outputTokens } = agents.run.read();
  expect(toUnits(finished.body.result.data.cost)).toBe(await rateCardCost(kept('task'), { inputTokens, outputTokens }));

  // The refused run: its state and its refusal code as a key, no reply and no cost.
  const refusedId = list.body.result.data[1].runId;
  const refused = await call(onKey, 'run.get', { runId: refusedId });
  expect(refused.status).toBe(200);
  expect(refused.body.result.data).toMatchObject({
    runId: refusedId,
    sessionId,
    requestId: kept('refusedRequestId'),
    task: 'support.reply',
    state: 'refused',
    reply: null,
    cost: null,
    refusalCodes: ['agents.task_not_allowed'],
  });
  for (const ask of [ASK, REFUSED_ASK]) expect(JSON.stringify([finished.body, refused.body, list.body])).not.toContain(ask);

  // Someone else's key finds no such run, and nothing changed.
  refusedWith(await call(kept('otherKey'), 'run.get', { runId }), 404, 'agents.run_not_found');
  expect((await call(onKey, 'run.get', { runId })).body).toEqual(finished.body);
});

test(`${J} #5 registers a webhook: one delivery per finished run`, async () => {
  // Webhook signing and delivery belong to the developer module (developer-webhooks-001), not on main. Red by name.
  throw new Error(
    `${J} #5 BLOCKED (developer-webhooks-001): the developer module's webhook delivery is not on main, so no endpoint can be registered`,
  );
});
