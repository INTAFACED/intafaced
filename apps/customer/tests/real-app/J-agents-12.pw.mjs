import { createServer } from 'node:http';
import { test, expect } from '@playwright/test';
import { UNBUILT, agentsRun } from './agents.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { PASSKEY_ORIGIN, addPasskey, virtualAuthenticator } from './identity-factors.mjs';
import { EDGE, json } from './stack.mjs';

// J-agents-12, in the running app (docs/roadmap/journeys.json): run an agent from my own code with the session API. One
// test per step, titled "J-agents-12 #<n>", run in order. The start is real: a verified TEST account with a passkey (a key
// needs one) makes two TEST keys on the API keys page: a trade:read key without the agents scope, and a key with
// agents:read; a second TEST person makes an agents key of their own, for #3. Every later step is the person's own
// code: plain HTTP to Edge with a key, scoped to the key's account.
// Runs are metered exactly as in J-agents-01; run notices by email, SMS or push show their vendor notice.
// What is built: the API keys page, which offers agents:read (J-developer-03), and svc-agents refuses a caller without
// agents:read (#1). Steps not built yet fail at their first missing part, quickly (UNBUILT):
// - there is no background run, event cursor, run read or webhook for a key
//   (AG-sessions-04).
const J = 'J-agents-12';
const agents = agentsRun(J);

test.describe.configure({ mode: 'default' });

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

/** A value an earlier step kept in the run file; a later step after a failed one says so instead of guessing. */
function kept(name) {
  const value = agents.run.read()[name];
  if (!value) throw new Error(`${J}: an earlier step left no ${name}, so this step has nothing to act on`);
  return value;
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

/** A verified TEST person with a passkey, in a browser of their own; `make(page)` creates their keys there. */
async function withPasskeyPerson(browser, prefix, make) {
  const context = await browser.newContext({ baseURL: PASSKEY_ORIGIN });
  try {
    const page = await context.newPage();
    await virtualAuthenticator(page);
    const who = await signUp(page, prefix);
    await verify(page, who);
    await signIn(page, who);
    await addPasskey(page);
    await make(page, who);
  } finally {
    await context.close();
  }
}

/** Makes a key with agents:read alone, chosen by hand. */
const agentsKey = (page, name) =>
  createKey(page, name, async () => {
    await page.getByLabel('Choose', { exact: true }).check();
    await page.getByRole('checkbox', { name: /^agents:read/ }).check(UNBUILT);
  });

test(`${J} starts: a verified TEST account with a passkey, a key without the agents scope and a key with agents:read; another person's agents key`, async ({
  browser,
}) => {
  test.setTimeout(360_000);
  await withPasskeyPerson(browser, 'ag12', async (page, who) => {
    agents.run.reset({ account: who });
    // The read-only preset ticks every read scope, agents:read among them, so this key is chosen by hand.
    agents.run.write({
      offKey: await createKey(page, 'TEST agents-off', async () => {
        await page.getByLabel('Choose', { exact: true }).check();
        await page.getByRole('checkbox', { name: /^trade:read/ }).check();
      }),
    });
    agents.run.write({ onKey: await agentsKey(page, 'TEST agents-on') });
  });
  await withPasskeyPerson(browser, 'ag12x', async (page) => {
    agents.run.write({ otherKey: await agentsKey(page, 'TEST someone else') });
  });
});

test(`${J} #1 calls the session API with a key lacking the agents read scope: refused`, async () => {
  const { status, body } = await call(kept('offKey'), 'session.mine', { limit: 10 });
  expect(status).toBe(403);
  expect(JSON.stringify(body)).toContain('agents:read');
});

test(`${J} #2 opens a background run with a key holding the scope: a run id and a status`, async () => {
  const { status, body } = await call(
    kept('onKey'),
    'run.background',
    { agentId: 'navigator', ask: 'TEST: list the markets', requestId: `${J}:run:${kept('account').handle}` },
    'POST',
  );
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  const { runId, status: runStatus } = body.result.data;
  expect(runId).toMatch(/^[0-9a-f-]{36}$/);
  expect(['queued', 'running']).toContain(runStatus);
  agents.run.write({ runId });
});

test(`${J} #3 lists events from a cursor: only later actions, only for the caller's session`, async () => {
  const first = await call(kept('onKey'), 'run.events', { runId: kept('runId') });
  expect(first.status, JSON.stringify(first.body).slice(0, 300)).toBe(200);
  const { events, cursor } = first.body.result.data;
  expect(events.length).toBeGreaterThan(0);
  const later = await call(kept('onKey'), 'run.events', { runId: kept('runId'), cursor });
  const seen = new Set(events.map((event) => event.id));
  for (const event of later.body.result.data.events) expect(seen.has(event.id)).toBe(false);
  // The key without the scope reads nothing of this run, and another person's agents key finds no such run.
  expect((await call(kept('offKey'), 'run.events', { runId: kept('runId') })).status).toBe(403);
  expect((await call(kept('otherKey'), 'run.events', { runId: kept('runId') })).status).toBe(404);
});

test(`${J} #4 retrieves the finished run: the stored reply, cost and refusal codes as keys, no prompt text`, async () => {
  await expect
    .poll(async () => (await call(kept('onKey'), 'run.get', { runId: kept('runId') })).body?.result?.data?.status, { timeout: 60_000 })
    .toBe('completed');
  const run = (await call(kept('onKey'), 'run.get', { runId: kept('runId') })).body.result.data;
  expect(run.reply).toBeTruthy();
  expect(run.cost).toMatch(/^\d+(\.\d+)?$/);
  expect(Array.isArray(run.refusalCodes)).toBe(true);
  expect(JSON.stringify(run)).not.toContain('TEST: list the markets');
});

test(`${J} #5 registers a webhook: one delivery per finished run`, async () => {
  test.setTimeout(120_000);
  const deliveries = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      deliveries.push(JSON.parse(body || '{}'));
      res.end('ok');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/agents-hook`;
    const hook = await call(kept('onKey'), 'webhook.register', { url, events: ['run.finished'] }, 'POST');
    expect(hook.status, JSON.stringify(hook.body).slice(0, 300)).toBe(200);
    const started = await call(
      kept('onKey'),
      'run.background',
      { agentId: 'navigator', ask: 'TEST: one more', requestId: `${J}:hook:${kept('account').handle}` },
      'POST',
    );
    const { runId } = started.body.result.data;
    await expect.poll(() => deliveries.filter((d) => d.runId === runId).length, { timeout: 60_000 }).toBe(1);
    // A second look later still finds one delivery for that run.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    expect(deliveries.filter((d) => d.runId === runId)).toHaveLength(1);
  } finally {
    server.close();
  }
});
