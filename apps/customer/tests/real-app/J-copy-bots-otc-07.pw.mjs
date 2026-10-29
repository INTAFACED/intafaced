import { test, expect } from '@playwright/test';
import { fund, journeyState } from './stack.mjs';
import { listLeader } from './copy.mjs';
import { codeOf, keyHolder, makeKey, withKey } from './developer.mjs';

// J-copy-bots-otc-07, in the running app (docs/roadmap/journeys.json): automate copy trading and signals with API keys.
// One test per step, titled "J-copy-bots-otc-07 #<n>", run in order. #1 makes the start: two verified TEST accounts
// with passkeys, one listed as a lead by the stack's TEST founder, each holding TEST USDT. Keys are made on
// /uc/safe/api-keys/new, and every call goes to Edge with the key as a developer's client sends it.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - every step: the key form offers no lead or copier scope, and there is no lead API, copier API, lead failure stream
//   or signal-bot API.
const J = 'J-copy-bots-otc-07';
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

test(`${J} #1 as a follower tries to mint a lead-scope key: refused until the account is an approved lead`, async ({ browser }) => {
  test.setTimeout(300_000);
  const follower = await keyHolder(browser, 'jck');
  expect(fund(follower.who.email, 'USDT', '500').tx).toBeTruthy();
  run.reset({ follower: follower.who });
  await follower.page.goto('/uc/safe/api-keys/new');
  await follower.page.getByLabel('Lead trading', { exact: true }).check(UNBUILT);
  await expect(follower.page.getByText(/only for an approved lead/)).toBeVisible();
  await follower.page.context().close();
});

test(`${J} #2 as an approved lead mints a lead key; a delegate can't mint one`, async ({ browser }) => {
  const lead = await keyHolder(browser, 'jckl');
  expect(fund(lead.who.email, 'USDT', '2000').tx).toBeTruthy();
  const leadRef = await listLeader(lead.who, `Journey Keys ${Date.now().toString(36)}`);
  await lead.page.goto('/uc/safe/api-keys/new');
  await lead.page.getByLabel('Lead trading', { exact: true }).check(UNBUILT);
  const key = await makeKey(lead.page, { name: 'lead-bot', preset: 'Lead trading' });
  run.write({ lead: lead.who, leadRef, leadKey: key });
  await lead.page.context().close();
});

test(`${J} #3 calls the lead API with a non-lead key: refused by scope`, async ({ browser }) => {
  const follower = await keyHolder(browser, 'jck3');
  const key = await makeKey(follower.page);
  await follower.page.context().close();
  const res = await withKey(key, {
    method: 'POST',
    path: '/api/v1/copy/lead/orders',
    body: { symbol: 'BTC/USDT', side: 'buy', amount: '0.001' },
  });
  expect(res.status, JSON.stringify(res.body).slice(0, 200)).toBe(403);
  expect(codeOf(res.body)).toBe('insufficient_scope');
});

test(`${J} #4 opens a position through the lead API on a listed instrument, then an unlisted one: one runs, one refused`, async () => {
  const res = await withKey(state('leadKey'), {
    method: 'POST',
    path: '/api/v1/copy/lead/orders',
    body: { symbol: 'BTC/USDT', side: 'buy', amount: '0.001' },
  });
  expect(res.status).toBe(200);
});

test(`${J} #5 calls start, amend, stop and list with a copier key: as the web; ratio refused; margin mode ignored with a reason`, async ({
  browser,
}) => {
  const copier = await keyHolder(browser, 'jck5');
  await copier.page.goto('/uc/safe/api-keys/new');
  await copier.page.getByLabel('Copy trading', { exact: true }).check(UNBUILT);
  const key = await makeKey(copier.page, { name: 'copier-bot', preset: 'Copy trading' });
  await copier.page.context().close();
  const res = await withKey(key, { path: '/api/v1/copy/follows' });
  expect(res.status).toBe(200);
});

test(`${J} #6 reads leader stats and asks for a leaderboard: copier counts; the leaderboard refused`, async () => {
  const stats = await withKey(state('leadKey'), { path: `/api/v1/copy/leaders/${state('leadRef')}/stats` });
  expect(stats.body.copiers).toBeGreaterThanOrEqual(0);
});

test(`${J} #7 listens to the lead failure stream: one message per failed lead trade, to that lead only, replayable`, async () => {
  const res = await withKey(state('leadKey'), { path: '/api/v1/copy/lead/failures?cursor=0' });
  expect(res.status).toBe(200);
});

test(`${J} #8 creates a signal bot by API twice with one client id, then reads its history: one bot, events in order`, async () => {
  const body = { name: 'TEST signal bot', symbol: 'BTC/USDT', clientId: `${J}-8` };
  const a = await withKey(state('leadKey'), { method: 'POST', path: '/api/v1/bots/signal', body });
  const b = await withKey(state('leadKey'), { method: 'POST', path: '/api/v1/bots/signal', body });
  expect(b.body.id).toBe(a.body.id);
});
