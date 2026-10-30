import { test, expect } from '@playwright/test';
import { agentsRun, openNavigatorSession, tableIn } from './agents.mjs';
import { fundedTrader, signIn } from './desk.mjs';
import { PASSKEY_ORIGIN, addPasskey, virtualAuthenticator } from './identity-factors.mjs';
import { EDGE, api, json, toUnits } from './stack.mjs';

// J-agents-12, in the running app (docs/roadmap/journeys.json): read an agent's runs from my own code with the session
// API. One test per step, titled "J-agents-12 #<n>", run in order. Everything the steps read is made in the start, so a
// step re-run alone reads the same records:
// - a verified TEST account funded with TEST USDT and holding a passkey (a key needs one) makes two TEST keys on the API
//   keys page, a trade:read key without the agents scope and a key with agents:read;
// - on their own sign-in the person runs Navigator once from the Agents room (session A), sends a task Navigator may not
//   run (refused and stored), runs once more in A, opens a second session B with a run of its own, and closes A, which
//   settles A's usage once on the ledger;
// - a second funded TEST person makes an agents key and runs Navigator in a session of their own.
// Every step after the start is the person's own code: plain HTTP to Edge with a key, checked against what the service
// tells the person on their own sign-in. Runs are metered exactly as in J-agents-01: each run's cost is its usage at the
// stack's TEST rate card (tooling/profiles/test-owner-values/agents.json), held in the session's usage window, and the
// window settles once as a ledger fee when the session closes.
// Red by name, never counted: #2 (a run started from an API key) is overtaken by OWNER 107, which keeps running to the
// person's own session; #5 (webhooks) waits on the developer module's webhook delivery (developer-webhooks-001); run
// notices wait on the run events of AG-sessions-04, not yet declared in packages/events. The journey's end (a background
// run, events from a cursor, a webhook delivery) is therefore partial: only the cursor read is proven.
const J = 'J-agents-12';
const agents = agentsRun(J);

test.describe.configure({ mode: 'default' });

/** The asks the people type; none may come back from any read. */
const ASK = 'TEST: where do I place a limit order?';
const REFUSED_ASK = 'TEST: write a support reply';
const LATER_ASK = 'TEST: and a stop order?';
const B_ASK = 'TEST: what is a market order?';
const OTHER_ASK = 'TEST: someone else asks';
const ASKS = [ASK, REFUSED_ASK, LATER_ASK, B_ASK, OTHER_ASK];

/**
 * The task Navigator may not run, as the service's refusal map has it (services/svc-agents/src/fleet/guardrails.ts:493,
 * `refuse('agents.task_not_allowed', 'agents.refused.task_not_allowed')`): the stored code is `code`, the answer's
 * message is `key` (router.ts:285 answers an AgentError with its user message key), and the answer's cause is the
 * guardrail error's own `agents.refused` (RefusedError, runtime.ts:123). The run and the log store `code`
 * (runs/record.ts:53).
 */
const TASK_REFUSAL = { code: 'agents.task_not_allowed', key: 'agents.refused.task_not_allowed', cause: 'agents.refused' };
/** A session that is not the caller's reads exactly like one that does not exist (router.ts:417, `ownedSession`). */
const NOT_YOUR_SESSION = 'agents.refused.session_closed';
/** A run that is not the caller's reads exactly like one that does not exist (runs/routes.ts:87). */
const NOT_YOUR_RUN = 'agents.run_not_found';
/** An id no session or run has. */
const NO_SUCH_ID = '00000000-0000-4000-8000-000000000000';

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

/** One tRPC call through Edge as `who`, on their own sign-in (not a key): the independent source. */
async function as(who, path, input, method = 'GET') {
  const door = await api(who);
  return method === 'GET'
    ? door.get(`${path}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`)
    : door.post(path, input);
}

/** One agents call as the run's account, on its own sign-in. */
const personCall = (procedure, input, method = 'GET') => as(agents.account(), `/api/agents/trpc/${procedure}`, input, method);

/** A session's whole log as its owner reads it, oldest first. */
async function logOf(who, sessionId) {
  const log = await as(who, '/api/agents/trpc/session.log', { sessionId, limit: 500 });
  expect(log.status).toBe(200);
  return log.body.result.data;
}

/** The person's sessions as the person reads them. */
async function mine() {
  const list = await personCall('session.mine', { limit: 50 });
  expect(list.status).toBe(200);
  return list.body.result.data;
}

/** A value an earlier step kept in the run file; a later step after a failed one says so instead of guessing. */
function kept(name) {
  const value = agents.run.read()[name];
  if (value === undefined) throw new Error(`${J}: the start left no ${name}, so this step has nothing to act on`);
  return value;
}

/** A service refusal: exactly this status and this typed code as its message, and no data. */
function refusedWith(answer, status, code) {
  expect(answer.status, JSON.stringify(answer.body).slice(0, 300)).toBe(status);
  expect(answer.body.result).toBeUndefined();
  expect(answer.body.error.message).toBe(code);
}

/** A scope refusal: 403, the platform's one scope code, the exact missing scope, and no data. */
function scopeDenied(answer, scope) {
  expect(answer.status, JSON.stringify(answer.body).slice(0, 300)).toBe(403);
  expect(answer.body.result).toBeUndefined();
  expect(answer.body.error.data.intafacedCode).toBe('scope.denied');
  expect(answer.body.error.message).toBe(`Scope "${scope}" is required`);
}

/** The run's data from a 200 answer. */
function ok(answer) {
  expect(answer.status, JSON.stringify(answer.body).slice(0, 300)).toBe(200);
  return answer.body.result.data;
}

/** The agents service's own procedures, from its built router (what the stack runs): path → query or mutation. */
async function agentsProcedures() {
  const { createAgentsRouter } = await import(new URL('../../../../services/svc-agents/dist/router.js', import.meta.url).href);
  return Object.entries(createAgentsRouter({ runtime: {}, gateway: {} })._def.procedures).map(([path, procedure]) => ({
    path,
    type: procedure._def.type,
  }));
}

/** Creates a key on the API keys page with the passkey's fresh step-up and returns its secret, shown once. */
async function createKey(page, name, scope) {
  await page.goto('/uc/safe/api-keys/new');
  await expect(page.getByRole('heading', { name: 'Create an API key' })).toBeVisible();
  await page.getByLabel('Key name').fill(name);
  // The read-only preset ticks every read scope, agents:read among them, so each key's one scope is chosen by hand.
  await page.getByLabel('Choose', { exact: true }).check();
  await page.getByRole('checkbox', { name: new RegExp(`^${scope}`) }).check();
  await page.getByRole('button', { name: 'Create with a passkey', exact: true }).click();
  const key = (await page.getByTestId('api-keys__key').textContent())?.trim();
  expect(key).toMatch(/^ifc_[A-Za-z0-9_-]{20,}$/);
  await page.getByLabel('I have stored this key somewhere safe').check();
  await page.getByRole('button', { name: 'Done' }).click();
  return key;
}

/** The key named `name`, as identity lists the owner's keys: it exists once, live, with exactly `scopes`. */
async function keyReadBack(who, name, key, scopes) {
  const rows = ok(await as(who, '/api/identity/trpc/apiKeys.list', { limit: 50 })).filter((row) => row.name === name);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ scopes, revoked: false });
  expect(key.startsWith(rows[0].prefix)).toBe(true);
}

/** A funded TEST person with a passkey, signed in on `page`. */
async function passkeyPerson(page, prefix, usdt, start) {
  await virtualAuthenticator(page);
  const who = await start(page, prefix, usdt);
  await signIn(page, who);
  await addPasskey(page);
  return who;
}

/** The exact cost the service's rate card puts on `usage` for `task`: each token count times its published rate per
 * million, rounded up once at the ledger's last place (services/svc-agents/src/metering/pricing.ts). */
async function rateCardCost(task, usage) {
  const matching = ok(await personCall('routes.list')).filter((row) => row.task === task && row.capability === 'complete');
  expect(matching).toHaveLength(1);
  const MILLION = 1_000_000n;
  const part = (tokens, rate) => (BigInt(tokens) * toUnits(rate) + MILLION - 1n) / MILLION;
  return part(usage.inputTokens, matching[0].inputPerMillion) + part(usage.outputTokens, matching[0].outputPerMillion);
}

/** A metered run's cost is real: tokens both ways, a cost above zero, and exactly the rate card's price for them. */
async function pricedAtRateCard(run) {
  expect(run.inputTokens).toBeGreaterThan(0);
  expect(run.outputTokens).toBeGreaterThan(0);
  expect(run.metered).toBe(true);
  expect(toUnits(run.cost) > 0n).toBe(true);
  expect(toUnits(run.cost)).toBe(await rateCardCost(run.action.task, run));
}

/** Session `sessionId`'s open usage window, as the person reads it: pending and total, in ledger units. */
async function usage(sessionId) {
  const { pending, sessionTotal } = ok(await personCall('usage.current', { sessionId }));
  return { pending: toUnits(pending), total: toUnits(sessionTotal) };
}

/** The person's ledger balances, every asset, as the ledger answers them. */
const ledgerBalances = async () => (await api(agents.account())).balances();

/** One run on the person's own sign-in, with an ask the agent may run. */
const personRun = (sessionId, requestId, task, content) =>
  personCall('run.complete', { sessionId, requestId, task, messages: [{ role: 'user', content }] }, 'POST');

test(`${J} starts: a funded TEST account with a passkey and two keys; two Navigator runs and one refused run in one session, closed and settled; a second session; another person's key and session`, async ({
  browser,
}) => {
  const context = await browser.newContext({ baseURL: PASSKEY_ORIGIN });
  try {
    const page = await context.newPage();
    const who = await passkeyPerson(page, 'ag12', '100', (p, prefix, usdt) => agents.start(p, prefix, usdt));
    const offKey = await createKey(page, 'TEST agents-off', 'trade:read');
    const onKey = await createKey(page, 'TEST agents-on', 'agents:read');
    // Each key is stored with exactly the one scope chosen for it.
    await keyReadBack(who, 'TEST agents-off', offKey, ['trade:read']);
    await keyReadBack(who, 'TEST agents-on', onKey, ['agents:read']);
    agents.run.write({ offKey, onKey });

    const before = await ledgerBalances();
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
    // The reply the person sees is the run's own text, and the run is priced at the rate card.
    await expect(workspace.getByRole('region', { name: 'Reply' }).getByTestId('more-body')).toHaveText(run.text);
    await expect(tableIn(workspace, 'Runs').getByRole('row').nth(1)).toContainText('Completed');
    await pricedAtRateCard(run);
    // Metered as in J-agents-01: the window holds exactly the run's cost, and the ledger waits for the close.
    expect(await usage(sessionId)).toEqual({ pending: toUnits(run.cost), total: toUnits(run.cost) });
    expect(await ledgerBalances()).toEqual(before);

    // A task Navigator may not run, sent by the person on their own sign-in: refused with the refusal map's key and
    // cause, stored as a refused run, and nothing held or charged.
    const refusedRequestId = `${sessionId}:not-allowed`;
    const refused = await personCall(
      'run.complete',
      { sessionId, requestId: refusedRequestId, task: 'support.reply', messages: [{ role: 'user', content: REFUSED_ASK }] },
      'POST',
    );
    refusedWith(refused, 403, TASK_REFUSAL.key);
    expect(refused.body.error.data.cause.code).toBe(TASK_REFUSAL.cause);
    expect(await usage(sessionId)).toEqual({ pending: toUnits(run.cost), total: toUnits(run.cost) });
    expect(await ledgerBalances()).toEqual(before);

    // The cursor a developer would hold now: the last action the person's log has so far.
    const cursorBeforeLater = String((await logOf(who, sessionId)).at(-1).sequence);
    const later = ok(await personRun(sessionId, `${sessionId}:later`, run.action.task, LATER_ASK));
    await pricedAtRateCard(later);
    const held = toUnits(run.cost) + toUnits(later.cost);
    expect(await usage(sessionId)).toEqual({ pending: held, total: held });
    expect(await ledgerBalances()).toEqual(before);

    // A second session of the same person, with a run of its own; it stays open.
    const sessionB = ok(await personCall('session.open', { agentId: 'navigator' }, 'POST')).id;
    const runB = ok(await personRun(sessionB, `${sessionB}:b`, run.action.task, B_ASK));
    await pricedAtRateCard(runB);

    // Closing session A settles its window once: the ledger drops by exactly the two runs' cost, as a fee from USDT;
    // session B's open window has not settled, and nothing else moved.
    expect(ok(await personCall('session.close', { sessionId }, 'POST')).status).toBe('closed');
    await expect.poll(async () => toUnits((await ledgerBalances()).USDT.total)).toBe(toUnits(before.USDT.total) - held);
    const after = await ledgerBalances();
    expect(toUnits(before.USDT.free) - toUnits(after.USDT.free)).toBe(held);
    expect(after.USDT.used).toBe(before.USDT.used);
    expect({ ...after, USDT: undefined }).toEqual({ ...before, USDT: undefined });

    agents.run.write({
      sessionId,
      sessionB,
      cursorBeforeLater,
      requestId,
      runId: run.runId,
      reply: run.text,
      cost: run.cost,
      assetId: run.assetId,
      task: run.action.task,
      refusedRequestId,
      laterRunId: later.runId,
      laterReply: later.text,
      laterCost: later.cost,
      laterActionId: later.action.id,
    });
  } finally {
    await context.close();
  }

  const other = await browser.newContext({ baseURL: PASSKEY_ORIGIN });
  try {
    const page = await other.newPage();
    const someone = await passkeyPerson(page, 'ag12x', '100', fundedTrader);
    const otherKey = await createKey(page, 'TEST someone else', 'agents:read');
    await keyReadBack(someone, 'TEST someone else', otherKey, ['agents:read']);
    // Their own session with a run, so their key has something of its own to read.
    const opened = ok(await as(someone, '/api/agents/trpc/session.open', { agentId: 'navigator' }, 'POST'));
    ok(
      await as(
        someone,
        '/api/agents/trpc/run.complete',
        { sessionId: opened.id, requestId: `${opened.id}:other`, task: kept('task'), messages: [{ role: 'user', content: OTHER_ASK }] },
        'POST',
      ),
    );
    agents.run.write({ otherKey, otherAccount: someone, otherSessionId: opened.id });
  } finally {
    await other.close();
  }
});

/** What a key may read of a person's sessions, each once, with an input naming the person's session A or its first run. */
const readInputs = () => ({
  'session.detail': { sessionId: kept('sessionId') },
  'session.selected': undefined,
  'session.log': { sessionId: kept('sessionId'), limit: 50 },
  'session.mine': { limit: 10 },
  'session.events': { sessionId: kept('sessionId'), limit: 50 },
  'run.list': { sessionId: kept('sessionId'), limit: 50 },
  'run.get': { runId: kept('runId') },
  'run.events': { runId: kept('runId'), limit: 50 },
  'usage.current': { sessionId: kept('sessionB') },
  'log.mine': { limit: 50 },
});

test(`${J} #1 calls the session API with a key lacking the agents read scope: refused`, async () => {
  const inputs = readInputs();
  // Every read of the session API, as the service's own router lists them, is tried exactly once.
  const reads = (await agentsProcedures())
    .filter(({ path, type }) => type === 'query' && /^(session|run|usage|log)\./.test(path))
    .map(({ path }) => path);
  expect(Object.keys(inputs).sort()).toEqual([...reads].sort());
  const sessionsBefore = await mine();
  const logBefore = await logOf(agents.account(), kept('sessionId'));
  for (const path of reads) scopeDenied(await call(kept('offKey'), path, inputs[path]), 'agents:read');
  // A write is refused too, by the scope it needs.
  scopeDenied(await call(kept('offKey'), 'session.open', { agentId: 'navigator' }, 'POST'), 'agents:execute');
  // Nothing changed: the person's sessions and log read exactly as before, and the key with the scope reads the run.
  expect(await mine()).toEqual(sessionsBefore);
  expect(await logOf(agents.account(), kept('sessionId'))).toEqual(logBefore);
  expect(ok(await call(kept('onKey'), 'run.get', { runId: kept('runId') })).state).toBe('completed');
});

test(`${J} #2 opens a background run with a key holding the scope: a run id and a status`, async () => {
  // What the app does today: a key with agents:read cannot start a run, by the scope a run needs, and nothing is stored.
  const sessionB = kept('sessionB');
  const logBefore = await logOf(agents.account(), sessionB);
  const runsBefore = ok(await personCall('run.list', { sessionId: sessionB, limit: 50 }));
  scopeDenied(
    await call(
      kept('onKey'),
      'run.complete',
      { sessionId: sessionB, requestId: `${sessionB}:from-key`, task: kept('task'), messages: [{ role: 'user', content: 'TEST' }] },
      'POST',
    ),
    'agents:execute',
  );
  expect(await logOf(agents.account(), sessionB)).toEqual(logBefore);
  expect(ok(await personCall('run.list', { sessionId: sessionB, limit: 50 }))).toEqual(runsBefore);
  // STALE under OWNER 107 ("never from API keys or delegated tokens"): a run starts only from the person's own session.
  // Red by name and never counted.
  throw new Error(
    `${J} #2 BLOCKED (OWNER 107): starting a run from an API key is overtaken by the owner's decision that runs start only from the person's own session`,
  );
});

test(`${J} #3 lists events from a cursor: only later actions, only for the caller's session`, async () => {
  const sessionId = kept('sessionId');
  const onKey = kept('onKey');
  const cursor = kept('cursorBeforeLater');
  const log = await logOf(agents.account(), sessionId);
  // Session A as the person's own log has it: the open, the room's run, the refused task, then the later run.
  expect(log.slice(0, 3).map(({ sequence, kind, status }) => ({ sequence, kind, status }))).toEqual([
    { sequence: 0, kind: 'session_open', status: 'executed' },
    { sequence: 1, kind: 'completion', status: 'executed' },
    { sequence: 2, kind: 'completion', status: 'refused' },
  ]);
  expect(log[1].cost).toBe(kept('cost'));
  expect(log[2]).toMatchObject({ refusalCode: TASK_REFUSAL.code, messageKey: TASK_REFUSAL.key });
  expect(cursor).toBe('2');
  const laterIndex = log.findIndex((entry) => entry.id === kept('laterActionId'));
  expect(log[laterIndex]).toMatchObject({ sequence: 3, kind: 'completion', status: 'executed', cost: kept('laterCost') });
  const last = String(log.at(-1).sequence);

  // From the start, one at a time: the first page is the open alone, and its cursor is that sequence.
  const first = await call(onKey, 'session.events', { sessionId, limit: 1 });
  expect(ok(first)).toEqual({ events: [log[0]], cursor: '0' });
  // From that cursor: exactly the later actions, as the person's log has them.
  const rest = await call(onKey, 'session.events', { sessionId, cursor: '0', limit: 500 });
  expect(ok(rest)).toEqual({ events: log.slice(1), cursor: last });
  // From the cursor held before the later run: that run's action and what followed it, nothing before.
  const fromHeld = await call(onKey, 'session.events', { sessionId, cursor, limit: 500 });
  expect(ok(fromHeld)).toEqual({ events: log.slice(laterIndex), cursor: last });
  expect(fromHeld.body.result.data.events[0].id).toBe(kept('laterActionId'));
  // Read to the end: nothing more, and the cursor stays.
  expect(ok(await call(onKey, 'session.events', { sessionId, cursor: last, limit: 500 }))).toEqual({ events: [], cursor: last });

  // Only session A: every event is A's, and none of the same person's session B (which has actions) appears.
  const logB = await logOf(agents.account(), kept('sessionB'));
  expect(logB.map(({ kind }) => kind)).toContain('completion');
  const pages = [first, rest, fromHeld].flatMap((answer) => answer.body.result.data.events);
  for (const event of pages) expect(event.sessionId).toBe(sessionId);
  const idsB = new Set(logB.map(({ id }) => id));
  expect(pages.filter(({ id }) => idsB.has(id))).toEqual([]);
  for (const ask of ASKS) expect(JSON.stringify([first.body, rest.body, fromHeld.body])).not.toContain(ask);

  // Only the caller's sessions: another person's key reads their own session, and A reads exactly like a session that
  // does not exist (not as closed: A's owner still reads it above).
  const otherLog = await logOf(kept('otherAccount'), kept('otherSessionId'));
  const own = await call(kept('otherKey'), 'session.events', { sessionId: kept('otherSessionId'), limit: 500 });
  expect(ok(own)).toEqual({ events: otherLog, cursor: String(otherLog.at(-1).sequence) });
  const notYours = await call(kept('otherKey'), 'session.events', { sessionId, limit: 500 });
  refusedWith(notYours, 404, NOT_YOUR_SESSION);
  const absent = await call(kept('otherKey'), 'session.events', { sessionId: NO_SUCH_ID, limit: 500 });
  refusedWith(absent, 404, NOT_YOUR_SESSION);
  expect(notYours.body.error.data.code).toBe(absent.body.error.data.code);
  // A malformed cursor is the existing typed refusal.
  const bad = await call(onKey, 'session.events', { sessionId, cursor: 'x', limit: 500 });
  refusedWith(bad, 400, 'agents.refused.cursor_invalid');
  expect(bad.body.error.data.cause.code).toBe('agents.cursor_invalid');
  // The refusals changed nothing.
  expect(await logOf(agents.account(), sessionId)).toEqual(log);
});

test(`${J} #4 retrieves the finished run: the stored reply, cost and refusal codes as keys, no prompt text`, async () => {
  const sessionId = kept('sessionId');
  const onKey = kept('onKey');
  const runId = kept('runId');
  // The session's runs, oldest first: the room's run, the refused task, the later run.
  const list = await call(onKey, 'run.list', { sessionId, limit: 50 });
  expect(ok(list)).toEqual([
    { runId, requestId: kept('requestId'), state: 'completed', createdAt: expect.any(String) },
    { runId: expect.any(String), requestId: kept('refusedRequestId'), state: 'refused', createdAt: expect.any(String) },
    { runId: kept('laterRunId'), requestId: `${sessionId}:later`, state: 'completed', createdAt: expect.any(String) },
  ]);
  const refusedId = list.body.result.data[1].runId;
  const stamps = { createdAt: expect.any(String), updatedAt: expect.any(String) };

  // The room's run: the reply the person saw, its cost at the published rate (checked in the start), no refusal.
  const finished = await call(onKey, 'run.get', { runId });
  expect(ok(finished)).toEqual({
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
    ...stamps,
  });
  // The later run, the same way.
  const later = await call(onKey, 'run.get', { runId: kept('laterRunId') });
  expect(ok(later)).toEqual({
    runId: kept('laterRunId'),
    sessionId,
    agentId: 'navigator',
    requestId: `${sessionId}:later`,
    task: kept('task'),
    state: 'completed',
    reply: kept('laterReply'),
    cost: kept('laterCost'),
    assetId: kept('assetId'),
    metered: true,
    refusalCodes: [],
    ...stamps,
  });
  // The refused run: its state and the refusal map's stored code as a key; no reply, cost or asset.
  const refused = await call(onKey, 'run.get', { runId: refusedId });
  expect(ok(refused)).toEqual({
    runId: refusedId,
    sessionId,
    agentId: 'navigator',
    requestId: kept('refusedRequestId'),
    task: 'support.reply',
    state: 'refused',
    reply: null,
    cost: null,
    assetId: null,
    metered: null,
    refusalCodes: [TASK_REFUSAL.code],
    ...stamps,
  });
  // Each run's own states, oldest first, with the refusal's code on its last.
  const states = async (id) =>
    ok(await call(onKey, 'run.events', { runId: id, limit: 500 })).events.map(({ sequence, state, code }) => ({ sequence, state, code }));
  const ran = [
    { sequence: 1, state: 'admitted', code: null },
    { sequence: 2, state: 'running', code: null },
  ];
  expect(await states(runId)).toEqual([...ran, { sequence: 3, state: 'completed', code: null }]);
  expect(await states(refusedId)).toEqual([...ran, { sequence: 3, state: 'refused', code: TASK_REFUSAL.code }]);
  const events = await Promise.all(
    [runId, refusedId, kept('laterRunId')].map((id) => call(onKey, 'run.events', { runId: id, limit: 500 })),
  );
  // No ask anyone typed comes back from any of these reads.
  const bodies = JSON.stringify([list.body, finished.body, later.body, refused.body, ...events.map(({ body }) => body)]);
  for (const ask of ASKS) expect(bodies).not.toContain(ask);

  // Someone else's key finds no such run, exactly as for a run that does not exist; nothing changed.
  refusedWith(await call(kept('otherKey'), 'run.get', { runId }), 404, NOT_YOUR_RUN);
  refusedWith(await call(kept('otherKey'), 'run.get', { runId: NO_SUCH_ID }), 404, NOT_YOUR_RUN);
  expect((await call(onKey, 'run.get', { runId })).body).toEqual(finished.body);
});

test(`${J} #5 registers a webhook: one delivery per finished run`, async () => {
  // What the app has today: the agents service publishes no webhook procedure, and a register call finds none.
  expect((await agentsProcedures()).filter(({ path }) => /webhook/i.test(path))).toEqual([]);
  const register = await call(kept('onKey'), 'webhook.register', { url: 'http://127.0.0.1:9/agents-hook' }, 'POST');
  expect(register.status).toBe(404);
  expect(register.body.error.data.code).toBe('NOT_FOUND');
  // Webhook signing and delivery belong to the developer module (developer-webhooks-001), not on main. Red by name.
  throw new Error(
    `${J} #5 BLOCKED (developer-webhooks-001): the developer module's webhook delivery is not on main, so no endpoint can be registered`,
  );
});

test(`${J} outside: run notices by email, SMS or push show their vendor notice and write an inbox row`, async () => {
  // The notices ride on AG-sessions-04's run events, declared in packages/events before any service publishes them.
  // Red by name until they are: this check turns when the catalogue declares the run's completion.
  const { ALL_EVENTS } = await import(new URL('../../../../packages/events/dist/catalog.js', import.meta.url).href);
  expect(
    ALL_EVENTS.map(({ subject }) => subject),
    `${J} outside BLOCKED (AG-sessions-04 events): agents.run.completed is not declared in packages/events, so no run notice exists`,
  ).toContain('intafaced.agents.run.completed');
});
