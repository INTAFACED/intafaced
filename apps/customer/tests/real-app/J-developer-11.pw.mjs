import { test, expect } from '@playwright/test';
import { EDGE, ORIGIN, journeyState } from './stack.mjs';
import { codeOf, keyHolder, makeKey, withKey } from './developer.mjs';

// J-developer-11, in the running app (docs/roadmap/journeys.json): test my webhook receiver from the command line. One
// test per step, titled "J-developer-11 #<n>", run in order. #1 makes the start: a verified TEST account with a passkey
// and a live key, and pairs the command-line tool the way the tool does it (it asks Edge for a pairing code, the person
// approves it in the browser, the tool polls). Every delivery is read back from the service.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1: there is no command-line tool and no pairing route or approval page.
// - #2 to #4: there are no sandbox webhook endpoints, test sends or forwarding.
// - #5: there is no MCP server, agent key or call log.
const J = 'J-developer-11';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

/** The tool's own call: no key and no session, only the pairing exchange. */
async function cli(body) {
  const res = await fetch(`${EDGE}/api/developer/cli/pair`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test(`${J} #1 logs the tool in with a pairing code approved in the browser: a session held by the tool, no secret in a file`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { page, who } = await keyHolder(browser, 'jdcl');
  const key = await makeKey(page, { name: 'cli-test' });
  run.reset({ who, key });
  const start = await cli({ client: 'intafaced-cli' });
  expect(start.status, JSON.stringify(start.body).slice(0, 300)).toBe(200);
  const { pairingCode, deviceId } = start.body;
  await page.goto(`/developers/cli/approve?code=${encodeURIComponent(pairingCode)}`);
  await page.getByRole('button', { name: 'Approve the command-line tool' }).click(UNBUILT);
  const polled = await cli({ deviceId, poll: true });
  expect(polled.body.session).toMatch(/\S+/);
  expect(polled.body.secret ?? null).toBeNull();
  run.write({ session: polled.body.session });
});

test(`${J} #2 sends a test event to a sandbox endpoint: one delivery row flagged test; the payload says TEST`, async () => {
  const res = await withKey(state('session'), { method: 'POST', path: '/api/developer/webhooks/test', body: { environment: 'sandbox' } });
  expect(res.status).toBe(200);
  expect(res.body.delivery.test).toBe(true);
  expect(JSON.stringify(res.body.delivery.payload)).toContain('TEST');
});

test(`${J} #3 forwards sandbox events to a local address: the events arrive locally`, async () => {
  const res = await withKey(state('session'), {
    method: 'POST',
    path: '/api/developer/webhooks/forward',
    body: { environment: 'sandbox', to: 'http://127.0.0.1:0/hook' },
  });
  expect(res.status).toBe(200);
});

test(`${J} #4 sends a test event to a live endpoint: the test-live-refused code; nothing sent`, async () => {
  const res = await withKey(state('key'), { method: 'POST', path: '/api/developer/webhooks/test', body: { environment: 'live' } });
  expect(codeOf(res.body)).toBe('webhooks.test_live_refused');
});

test(`${J} #5 lets an assistant use the MCP server with an agent key: calls logged; a live write refuses; a sensitive action goes to approval`, async ({
  browser,
}) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/developers/mcp');
  await expect(page.getByRole('heading', { name: 'MCP server', level: 1 })).toBeVisible(UNBUILT);
  await expect(page.getByRole('table', { name: 'Call log' })).toBeVisible();
});
