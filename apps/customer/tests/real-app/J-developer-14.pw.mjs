import { test, expect } from '@playwright/test';
import { journeyState } from './stack.mjs';
import { codeOf, keyHolder, makeKey, withKey } from './developer.mjs';

// J-developer-14, in the running app (docs/roadmap/journeys.json): connect over FIX. One test per step, titled
// "J-developer-14 #<n>", run in order. #1 makes the start: a verified TEST account with a passkey and a live key with FIX
// permission and 127.0.0.1 on its list, then asks for FIX access. Logons go to the stack's TEST UAT acceptor; the limits,
// disconnect count and resend policy are the stack's TEST FIX terms.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - every step: the key form has no FIX permission, there is no FIX access page or session record, and the stack runs
//   no UAT acceptor (FIX stays an adapter: AGENTS.md money rule 3); no drop-copy stream or certification suite.
const J = 'J-developer-14';
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

/** Asks the stack's TEST acceptor for a logon with the given proof and reads its verdict. */
const logon = (key, body) => withKey(key, { method: 'POST', path: '/api/fix/uat/logon', body });

test(`${J} #1 asks for FIX access: my CompIDs, the key's permission, the IP list and the TLS endpoints`, async ({ browser }) => {
  test.setTimeout(240_000);
  const { page, who } = await keyHolder(browser, 'jdfx');
  await page.goto('/uc/safe/api-keys/new');
  await page.getByLabel('FIX', { exact: true }).check(UNBUILT);
  const key = await makeKey(page, { name: 'fix-1', preset: 'FIX', ips: '127.0.0.1' });
  run.reset({ who, key });
  await page.goto('/developers/fix/access');
  const access = page.getByRole('region', { name: 'FIX access' });
  await expect(access.getByText(/SenderCompID/)).toBeVisible();
  await expect(access.getByText('127.0.0.1')).toBeVisible();
  await expect(access.getByText(/tls:\/\//)).toBeVisible();
});

test(`${J} #2 logs on with a good proof, then bad ones: the good logon succeeds; each other is rejected with its reason`, async () => {
  const key = state('key');
  expect((await logon(key, { proof: 'good' })).status).toBe(200);
  for (const [proof, reason] of [
    ['bad', 'fix.proof_invalid'],
    ['replayed', 'fix.nonce_replayed'],
    ['unmapped', 'fix.compid_unmapped'],
  ])
    expect(codeOf((await logon(key, { proof })).body)).toBe(reason);
});

test(`${J} #3 logs on with a blank address list or a blank limit for my CompID: rejected with that reason`, async () => {
  expect(codeOf((await logon(state('key'), { proof: 'good', compId: 'blank-limits' })).body)).toBe('fix.limit_unset');
});

test(`${J} #4 exceeds a configured limit: a business reject; after the set count the session disconnects`, async () => {
  const res = await withKey(state('key'), { method: 'POST', path: '/api/fix/uat/flood', body: { count: 100 } });
  expect(res.body.businessRejects).toBeGreaterThan(0);
  expect(res.body.disconnected).toBe(true);
});

test(`${J} #5 restarts my engine: the store replays the session; resend as documented`, async () => {
  const res = await withKey(state('key'), { method: 'POST', path: '/api/fix/uat/restart', body: {} });
  expect(res.body.replayed).toBe(true);
});

test(`${J} #6 opens the drop-copy stream: each execution carries its source; an order with no origin is unattributed`, async () => {
  const res = await withKey(state('key'), { path: '/api/fix/uat/drop-copy' });
  for (const exec of res.body.executions) expect(exec.source).toMatch(/ui|websocket|algo|api_key|rfq|liquidation|broker|unattributed/);
});

test(`${J} #7 runs the certification scenarios: a verdict per scenario`, async ({ page }) => {
  await page.goto('/developers/fix/certification');
  const table = page.getByRole('table', { name: 'Certification scenarios' });
  await expect(table).toBeVisible(UNBUILT);
  for (const name of ['Sequence gap', 'Duplicate order', 'Mass cancel', 'Risk reject', 'Clock skew'])
    await expect(table.getByRole('row', { name: new RegExp(name) })).toBeVisible();
});
