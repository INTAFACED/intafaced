// World: book
import { test, expect } from './journey.mjs';
import { EDGE, ORIGIN, api, bestPrices, fund, journeyState } from './stack.mjs';
import { listLeader } from './copy.mjs';
import { codeOf, keyHolder, makeKey, withKey } from './developer.mjs';

// J-copy-bots-otc-07, in the running app (docs/roadmap/journeys.json): automate copy trading and signals with API keys.
// One test per step, titled "J-copy-bots-otc-07 #<n>", run in order. Each actor is a verified TEST account with a
// passkey holding TEST USDT; a lead is listed by the stack's TEST founder. Keys are made on /uc/safe/api-keys/new, and
// every call goes to Edge with the key as a developer's client sends it.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #5 to #8: the copier API, leader stats, the lead failure stream and the signal-bot API.
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

/** The account's own keys as identity holds them, read through a fresh sign-in. */
async function storedKeys(who) {
  const res = await (
    await api(who)
  ).get(`/api/identity/trpc/developerKeys.list?input=${encodeURIComponent(JSON.stringify({ limit: 50 }))}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.result.data.keys;
}

/** The typed code identity puts at the end of a refusal's message (`... [identity.delegated_refused]`). */
const identityCode = (body) => /\[([a-z_]+\.[a-z_.]+)\]$/.exec(body?.error?.message ?? body?.[0]?.error?.message ?? '')?.[1];

/** Ticks the Lead trading preset on a fresh form and presses Create with a passkey. */
async function tryLeadKey(page, name) {
  await page.goto('/uc/safe/api-keys/new');
  await page.getByLabel('Key name').fill(name);
  await page.getByLabel('Lead trading', { exact: true }).check();
  await expect(page.getByText('It is only for an approved lead.')).toBeVisible();
  await page.getByRole('button', { name: 'Create with a passkey', exact: true }).click();
}

/** An account's BTC/USDT orders, open and closed, as the exchange holds them, read through its own sign-in. */
async function ordersOf(who) {
  const mine = await api(who);
  const open = await mine.get('/api/v1/orders/open?symbol=BTC%2FUSDT&limit=100');
  const closed = await mine.get('/api/v1/orders/closed?symbol=BTC%2FUSDT&limit=100');
  expect(open.status, JSON.stringify(open.body)).toBe(200);
  expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  return [...open.body, ...closed.body];
}

test(`${J} #1 as a follower tries to mint a lead-scope key: refused until the account is an approved lead`, async ({ browser }) => {
  test.setTimeout(300_000);
  const follower = await keyHolder(browser, 'jck');
  expect(fund(follower.who.email, 'USDT', '500').tx).toBeTruthy();
  run.reset({ follower: follower.who });
  const { page } = follower;
  await tryLeadKey(page, 'lead-bot');
  await expect(page.getByRole('alert').filter({ hasText: 'A lead trading key is only for an approved lead.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your new key' })).toHaveCount(0);
  // Refused by identity itself, not only on the page: the same create sent straight to identity through Edge, with the
  // follower's own sign-in, answers the typed refusal, and no key was made.
  const direct = await (
    await api(follower.who)
  ).post('/api/identity/trpc/developerKeys.create', {
    name: 'lead-bot-direct',
    scopes: ['trade:read', 'trade:write', 'copy:lead'],
    requestId: `${J}-1-direct-${process.env.JOURNEY_RUN_ID ?? 'local'}`,
  });
  expect(direct.status, JSON.stringify(direct.body)).toBe(403);
  expect(identityCode(direct.body), JSON.stringify(direct.body)).toBe('identity.key_lead_not_approved');
  expect(await storedKeys(follower.who)).toEqual([]);

  // Until: once the account is listed as a lead, the same form makes the key.
  await listLeader(follower.who, `Journey Keys Until ${Date.now().toString(36)}`);
  const key = await makeKey(page, { name: 'lead-bot-listed', preset: 'Lead trading' });
  expect(key).toBeTruthy();
  const keys = await storedKeys(follower.who);
  expect(keys.map((k) => k.name)).toEqual(['lead-bot-listed']);
  expect(keys[0].scopes).toContain('copy:lead');
  await page.context().close();
});

test(`${J} #2 as an approved lead mints a lead key; a delegate can't mint one`, async ({ browser }) => {
  test.setTimeout(300_000);
  const lead = await keyHolder(browser, 'jckl');
  expect(fund(lead.who.email, 'USDT', '2000').tx).toBeTruthy();
  const leadRef = await listLeader(lead.who, `Journey Keys ${Date.now().toString(36)}`);
  const key = await makeKey(lead.page, { name: 'lead-bot', preset: 'Lead trading' });
  // The key carries the lead scope, beside the trade scopes a lead order needs.
  const minted = (await storedKeys(lead.who)).find((k) => k.name === 'lead-bot');
  expect(minted?.scopes, JSON.stringify(minted)).toEqual(expect.arrayContaining(['copy:lead', 'trade:read', 'trade:write']));
  await lead.page.goto('/uc/safe/api-keys');
  await expect(lead.page.getByTestId('api-keys__table')).toContainText('copy:lead');

  // A delegate: a second key of this lead holding identity:write as well as copy:lead, which then asks identity for a
  // new lead key. A key is already a delegate and cannot grant one.
  await lead.page.goto('/uc/safe/api-keys/new');
  await lead.page.getByLabel('Key name').fill('delegate');
  for (const scope of ['identity:write', 'copy:lead']) await lead.page.locator(`input[name="scope"][value="${scope}"]`).check();
  await lead.page.getByRole('button', { name: 'Create with a passkey', exact: true }).click();
  await expect(lead.page.getByRole('heading', { name: 'Your new key' })).toBeVisible();
  const delegate = (await lead.page.getByTestId('api-keys__key').locator('code').textContent())?.trim();
  await lead.page.getByLabel('I have stored this key somewhere safe').check();
  await lead.page.getByRole('button', { name: 'Done' }).click();
  const before = (await storedKeys(lead.who)).length;
  // Each create door answers its own typed refusal: the key form's door refuses anything but a person signed in on a
  // device, and the older door refuses a key minting a key.
  const refusals = {
    'developerKeys.create': (body) => expect(identityCode(body), JSON.stringify(body)).toBe('identity.delegated_refused'),
    'apiKeys.create': (body) => expect(body?.error?.message, JSON.stringify(body)).toBe('A delegate cannot grant further'),
  };
  for (const [door, refused] of Object.entries(refusals)) {
    const res = await fetch(`${EDGE}/api/identity/trpc/${door}`, {
      method: 'POST',
      headers: { origin: ORIGIN, authorization: `Bearer ${delegate}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: `from-delegate-${door}`, scopes: ['copy:lead'], requestId: `${J}-2-${door}` }),
    });
    const body = await res.json();
    expect(res.status, `${door}: ${JSON.stringify(body)}`).toBe(403);
    refused(body);
  }
  expect((await storedKeys(lead.who)).length).toBe(before);
  run.write({ lead: lead.who, leadRef, leadKey: key });
  await lead.page.context().close();
});

test(`${J} #3 calls the lead API with a non-lead key: refused by scope`, async ({ browser }) => {
  test.setTimeout(300_000);
  const trader = await keyHolder(browser, 'jck3');
  expect(fund(trader.who.email, 'USDT', '500').tx).toBeTruthy();
  const key = await makeKey(trader.page, { name: 'trade-bot', preset: 'Trade' });
  await trader.page.context().close();
  const clientOrderId = `${J}-3-${process.env.JOURNEY_RUN_ID ?? 'local'}`;
  const { body: book } = await bestPrices('BTC/USDT');
  const res = await withKey(key, {
    method: 'POST',
    path: '/api/v1/copy/lead/orders',
    body: { symbol: 'BTC/USDT', type: 'limit', side: 'buy', amount: '0.001', price: book.bids[0][0], clientOrderId },
  });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(403);
  expect(res.body.intafacedCode, JSON.stringify(res.body)).toBe('scope.denied');
  expect(res.body.message).toBe('Scope "copy:lead" is required');
  expect(codeOf(res.body)).toBe('PermissionDenied');
  // Nothing was placed: the trader holds no order under that id, open or closed.
  expect((await ordersOf(trader.who)).filter((o) => o.clientOrderId === clientOrderId)).toEqual([]);
});

test(`${J} #4 opens a position through the lead API on a listed instrument, then an unlisted one: one runs, one refused`, async () => {
  const lead = state('lead');
  const { body: book } = await bestPrices('BTC/USDT');
  const bid = book.bids[0][0];
  const clientOrderId = `${J}-4-${process.env.JOURNEY_RUN_ID ?? 'local'}`;
  const placed = await withKey(state('leadKey'), {
    method: 'POST',
    path: '/api/v1/copy/lead/orders',
    body: { symbol: 'BTC/USDT', type: 'limit', side: 'buy', amount: '0.001', price: bid, clientOrderId },
  });
  expect(placed.status, JSON.stringify(placed.body).slice(0, 400)).toBe(201);
  expect(placed.body).toMatchObject({ symbol: 'BTC/USDT', side: 'buy', type: 'limit', amount: '0.001', clientOrderId });
  // The ordinary path: the order is the lead's own, read back through the web's sign-in exactly as any order is.
  const held = (await ordersOf(lead)).find((o) => o.id === placed.body.id);
  expect(held, `order ${placed.body.id} not among the lead's orders`).toMatchObject({ symbol: 'BTC/USDT', side: 'buy', clientOrderId });

  // An instrument the lead's listing does not name is refused before the order path, so nothing is placed.
  const unlisted = await withKey(state('leadKey'), {
    method: 'POST',
    path: '/api/v1/copy/lead/orders',
    body: { symbol: 'ETH/USDT', type: 'limit', side: 'buy', amount: '0.01', price: '1', clientOrderId: `${clientOrderId}-eth` },
  });
  expect(unlisted.status, JSON.stringify(unlisted.body)).toBe(400);
  expect(unlisted.body.intafacedCode).toBe('trade.copy_lead_instrument_unlisted');
  expect(unlisted.body.message).toContain('ETH/USDT is not on your lead listing');
  expect((await ordersOf(lead)).filter((o) => o.clientOrderId === `${clientOrderId}-eth`)).toEqual([]);
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
