// World: restart
import { test, expect } from './journey.mjs';
import { EDGE, ORIGIN, api, restartWith } from './stack.mjs';
import { codeOf, keyHolder, makeKey, withKey } from './developer.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { bodyRows, tableIn } from './tables.mjs';

// J-developer-06, in the running app (docs/roadmap/journeys.json; the step words are in project-state
// operation-zero/modules/developer/acceptance/journeys.md): stay inside the rate limits, and ask for more.
// One test per step, titled "J-developer-06 #<n>". Starts: a live key on a tier; the owner has set the base tier. The
// person is a TEST account with a passkey and one live Trade key made in the browser (developer.mjs); the stack's
// labelled TEST tiers are the owner's (tooling/profiles/test-owner-values/identity.json). Every key call after that
// goes from the developer's own program straight to Edge, as a bot's would.
//
// "With no tiers set" and "when the owner never set the base tier" are seen by restarting identity with its TEST
// tiers blank (LOCAL_STACK_IDENTITY_RATE_LIMITS=off) and putting them back right after.
const J = 'J-developer-06';
const TIERS_SWITCH = 'LOCAL_STACK_IDENTITY_RATE_LIMITS';
// The route the bot calls: a read on the trade door. Its cost comes from the published cost table.
const PATH = '/api/v1/account/balance';
const ROUTE = `GET ${PATH}`;
// Every journey on a shard shares one client address and its budget: a burst probe above this would starve the others.
const MAX_PROBE = 150;
/** A number as the page's sentences print it (localised, en). */
const fmt = (n) => n.toLocaleString('en');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test.describe.configure({ mode: 'serial' });

/** @type {import('@playwright/test').Page} */
let page;
let who;
let key;
let keyId;
const keyName = `limits-${Date.now().toString(36)}`;
/** What step 2 spent, for step 3 to find on the key detail. */
let spent = 0;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  ({ page, who } = await keyHolder(browser, 'dl6'));
  key = await makeKey(page, { name: keyName, preset: 'Trade' });
  await page.goto('/uc/safe/api-keys');
  await page.getByTestId('api-keys__table').getByRole('link', { name: keyName }).click();
  await expect(page).toHaveURL(/\/uc\/safe\/api-keys\/[0-9a-f-]{36}$/);
  keyId = new URL(page.url()).pathname.split('/').at(-1);
});

test.afterAll(async () => {
  await page?.context().close();
});

/** Identity with its TEST tiers blank for `body`, then back on the stack's TEST tiers, whatever `body` did. */
async function withTiersBlank(body) {
  restartWith('identity', TIERS_SWITCH, false);
  try {
    await body();
  } finally {
    restartWith('identity', TIERS_SWITCH, true);
  }
}

const numberIn = (text) => {
  const m = /\d[\d,]*/.exec(String(text ?? ''));
  if (!m) throw new Error(`no number in "${text}"`);
  return Number(m[0].replace(/,/g, ''));
};

/** The published model as the limits page shows it: the base tier's burst and refill a minute, and the route's cost. */
async function publishedModel() {
  await page.goto('/developers/rate-limits');
  const tiers = tableIn(page, 'Rate-limit tiers');
  const base = bodyRows(tiers).filter({ hasText: /^Base/ });
  await expect(base).toHaveCount(1);
  const cells = base.getByRole('cell');
  const burst = numberIn(await cells.nth(0).textContent());
  const refillPerMinute = numberIn(await cells.nth(1).textContent());
  const routeRow = bodyRows(tableIn(page, 'Cost per route')).filter({ hasText: ROUTE });
  await expect(routeRow).toHaveCount(1);
  const cost = numberIn(await routeRow.getByRole('cell').last().textContent());
  return { burst, refillPerMinute, cost };
}

test(`${J} #1 reads the limits page: the tiers, the per-route cost, the burst and the refill; with no tiers set, a banner saying so`, async () => {
  test.setTimeout(240_000);
  await page.goto('/developers/rate-limits');
  await expect(page.getByRole('heading', { name: 'Rate limits', level: 1 })).toBeVisible();
  await expect(page.getByText(/waits for DV-limits-01/i)).toHaveCount(0);

  // The tiers, each with its burst and its refill.
  const tiers = tableIn(page, 'Rate-limit tiers');
  await expect(tiers.getByRole('columnheader')).toHaveText(['Tier', 'Burst (tokens)', 'Refill per minute', 'Refill per second']);
  await expect(bodyRows(tiers).filter({ hasText: /^Base/ })).toHaveCount(1);
  await expect(bodyRows(tiers).filter({ hasText: /^Sandbox/ })).toHaveCount(1);
  const { burst, refillPerMinute, cost } = await publishedModel();
  expect(burst).toBeGreaterThan(0);
  expect(refillPerMinute).toBeGreaterThan(0);
  // The page shows the services' own numbers, not its own: identity's tiers and the edge's cost table.
  const published = await (await fetch(`${EDGE}/api/identity/trpc/apiRateTiers`, { headers: { origin: ORIGIN } })).json();
  const baseTier = published.result.data.tiers.find((tier) => tier.id === 'base');
  expect(baseTier).toMatchObject({ burst, refillPerMinute });
  const costs = await (await fetch(`${EDGE}/api/edge/rate-limits/costs`, { headers: { origin: ORIGIN } })).json();
  expect(costs.costs.find((row) => row.route === ROUTE)?.cost).toBe(cost);

  // The per-route cost: a row per route the table names, the bot's route among them.
  const costTable = tableIn(page, 'Cost per route');
  await expect(costTable.getByRole('columnheader')).toHaveText(['Route', 'Cost (tokens)']);
  expect(await bodyRows(costTable).count()).toBe(costs.costs.length);
  expect(cost).toBeGreaterThan(0);
  // What the burst and the refill are, in words.
  const model = page.getByRole('region', { name: 'How the limit works' });
  await expect(model).toContainText('The burst is the most the bucket holds');
  await expect(model).toContainText('refill');
  // With tiers set, no "not set" banner.
  await expect(page.getByTestId('rate-limits__unset')).toHaveCount(0);

  // With no tiers set: a banner saying so, no invented tier, and a key call is refused rather than metered on a guess.
  await withTiersBlank(async () => {
    await page.goto('/developers/rate-limits');
    await expect(page.getByRole('status').filter({ hasText: 'No rate-limit tiers are set yet' })).toBeVisible();
    await expect(bodyRows(tableIn(page, 'Rate-limit tiers'))).toHaveCount(0);
    const refused = await withKey(key, { path: PATH });
    expect(refused.status, JSON.stringify(refused.body)).toBe(503);
    expect(codeOf(refused.body)).toBe('edge.limits_unset');
  });
});

test(`${J} #2 sends calls faster than the refill: allowed until the burst is spent, then 429 with reason, retry-after seconds and the request id, and matching headers`, async () => {
  test.setTimeout(180_000);
  const { burst, refillPerMinute, cost } = await publishedModel();
  const allowedAtOnce = Math.floor(burst / cost);
  const sent = allowedAtOnce + 30;
  expect(allowedAtOnce, `the TEST base tier's burst ${burst} at cost ${cost}`).toBeGreaterThan(0);
  expect(sent, `a probe above ${MAX_PROBE} calls would spend the shard's shared address budget`).toBeLessThanOrEqual(MAX_PROBE);

  // Let the bucket fill (#1's calls were refused unmetered, but a fill wait makes the start certain).
  await page.waitForTimeout(Math.ceil((burst / refillPerMinute) * 60_000) + 1_000);
  // All at once, far faster than the refill.
  const started = Date.now();
  const replies = await Promise.all(Array.from({ length: sent }, () => withKey(key, { path: PATH })));
  const elapsedMs = Date.now() - started;
  const allowed = replies.filter((r) => r.status !== 429);
  const refused = replies.filter((r) => r.status === 429);
  // Every call that got through was answered by the route itself.
  for (const r of allowed) expect(r.status, JSON.stringify(r.body)).toBe(200);
  // Allowed until the burst is spent (plus only what refilled while they were in flight), then refused.
  expect(allowed.length).toBeGreaterThanOrEqual(allowedAtOnce);
  expect(allowed.length).toBeLessThanOrEqual(Math.floor((burst + (refillPerMinute / 60_000) * elapsedMs) / cost));
  expect(refused.length).toBeGreaterThan(0);
  // Each allowed call says what it cost and what is left, so a client can slow down before the 429.
  for (const r of allowed) {
    expect(r.headers.get('x-ratelimit-cost')).toBe(String(cost));
    expect(r.headers.get('x-ratelimit-limit')).toBe(String(burst));
    expect(Number(r.headers.get('x-ratelimit-remaining'))).toBeLessThan(burst);
  }
  spent = allowed.length * cost;

  for (const limited of refused) {
    expect(codeOf(limited.body), JSON.stringify(limited.body)).toBe('edge.rate_limited');
    // The reason: the key's own bucket is spent.
    expect(limited.body.reason).toBe('global');
    // Retry-after in whole seconds: what one call's cost takes to refill, rounded up.
    expect(Number.isInteger(limited.body.retryAfterSeconds), JSON.stringify(limited.body)).toBe(true);
    expect(limited.body.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(limited.body.retryAfterSeconds).toBeLessThanOrEqual(Math.ceil(cost / (refillPerMinute / 60)));
    // The request id, in the body for support.
    expect(limited.body.requestId).toMatch(UUID);
    // The headers say the same.
    expect(limited.headers.get('retry-after')).toBe(String(limited.body.retryAfterSeconds));
    expect(limited.headers.get('x-request-id')).toBe(limited.body.requestId);
    expect(limited.headers.get('x-ratelimit-reason')).toBe(limited.body.reason);
    expect(limited.headers.get('x-ratelimit-remaining')).toBe('0');
    expect(limited.headers.get('x-ratelimit-cost')).toBe(String(cost));
    expect(limited.headers.get('x-ratelimit-limit')).toBe(String(burst));
  }
  // Each refusal names its own request.
  expect(new Set(refused.map((r) => r.body.requestId)).size).toBe(refused.length);
});

/** The key detail's usage, as the page shows it. */
async function usage() {
  const box = page.getByRole('region', { name: 'Usage' });
  await expect(box.getByTestId('api-keys__usage-as-of')).toBeVisible();
  return {
    used: numberIn(await box.getByTestId('api-keys__used').textContent()),
    remaining: numberIn(await box.getByTestId('api-keys__remaining').textContent()),
    asOf: (await box.getByTestId('api-keys__usage-as-of').textContent())?.trim(),
  };
}

test(`${J} #3 opens the key detail: used and remaining with an as-of time that moves on Refresh`, async () => {
  test.setTimeout(120_000);
  expect(spent, '#2 spent tokens with this key').toBeGreaterThan(0);
  const { burst, cost } = await publishedModel();
  await page.goto(`/uc/safe/api-keys/${keyId}`);
  const first = await usage();
  // Used counts what the key spent (step 2's calls); remaining is what is left of the burst.
  expect(first.used).toBeGreaterThanOrEqual(spent);
  expect(first.remaining).toBeGreaterThanOrEqual(0);
  expect(first.remaining).toBeLessThanOrEqual(burst);
  await expect(page.getByRole('region', { name: 'Usage' }).getByTestId('api-keys__remaining')).toContainText(`of ${burst} tokens`);
  expect(first.asOf).toMatch(/^As of .+ UTC$/);

  // One more call once a token is back, then Refresh: the as-of time moves and used counts the call.
  await page.waitForTimeout(3_000);
  const call = await withKey(key, { path: PATH });
  expect(call.status, JSON.stringify(call.body)).toBe(200);
  await page.getByRole('region', { name: 'Usage' }).getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByTestId('api-keys__usage-as-of')).not.toHaveText(first.asOf);
  const second = await usage();
  expect(second.asOf).not.toBe(first.asOf);
  expect(second.used).toBe(first.used + cost);
  // Reading usage is never itself counted.
  await page.getByRole('region', { name: 'Usage' }).getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByTestId('api-keys__usage-as-of')).not.toHaveText(second.asOf);
  expect((await usage()).used).toBe(second.used);
});

test(`${J} #4 reads the backoff guidance: the documented exponential backoff with jitter`, async () => {
  await page.goto('/developers/rate-limits');
  const guidance = page.getByRole('region', { name: 'Backing off after a 429' });
  await expect(guidance).toBeVisible();
  await expect(guidance).toContainText('Wait at least the retry-after seconds');
  await expect(guidance).toContainText('back off exponentially: double the wait each time');
  await expect(guidance).toContainText('add random jitter to each wait');
  // A refusal links to this guidance.
  const spend = await Promise.all(Array.from({ length: 80 }, () => withKey(key, { path: PATH })));
  const limited = spend.find((r) => r.status === 429);
  expect(limited, 'a burst of 80 is refused').toBeTruthy();
  expect(limited.body.docs).toBe('/developers/rate-limits');
});

/** The higher-limit request form on the limits page. */
const requestForm = () => page.getByRole('form', { name: 'Ask for a higher limit' });
const day = (days) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);

test(`${J} #5 submits a request for a higher limit and a spike notice: the request recorded; when the owner never set the base tier, the form says limits not set`, async () => {
  test.setTimeout(240_000);
  const { refillPerMinute } = await publishedModel();
  const asked = refillPerMinute * 4;

  await page.goto('/developers/rate-limits');
  const form = requestForm();
  await form.getByLabel('Key').selectOption({ label: keyName });
  await form.getByLabel('Limit asked for (calls a minute)').fill(String(asked));
  // The spike notice: when the traffic will spike.
  await form.getByLabel('Spike starts').fill(day(7));
  await form.getByLabel('Spike ends').fill(day(8));
  await form.getByLabel('Why').fill('TEST: a launch week');
  await form.getByRole('button', { name: 'Send request' }).click();
  await expect(form.getByRole('status')).toHaveText('Your request is recorded. A reviewer will answer it here.');

  // Recorded: still there after a reload, with what was asked, what the key had and the spike window, waiting.
  await page.reload();
  const mine = bodyRows(tableIn(page, 'Your limit requests')).filter({ hasText: keyName });
  await expect(mine).toHaveCount(1);
  await expect(mine.getByRole('cell').nth(0)).toHaveText(String(asked));
  await expect(mine.getByRole('cell').nth(1)).toHaveText(String(refillPerMinute));
  await expect(mine).toContainText(`${day(7)} to ${day(8)}`);
  await expect(mine).toContainText('Waiting for review');
  // One waiting request per key: a second is refused and records nothing.
  await requestForm().getByLabel('Key').selectOption({ label: keyName });
  await requestForm().getByLabel('Limit asked for (calls a minute)').fill(String(asked));
  await requestForm().getByRole('button', { name: 'Send request' }).click();
  await expect(requestForm().getByRole('alert')).toHaveText('This key already has a request waiting for review. Nothing was sent.');
  await page.reload();
  await expect(bodyRows(tableIn(page, 'Your limit requests')).filter({ hasText: keyName })).toHaveCount(1);

  // When the owner never set the base tier, the form says limits not set and sends nothing, and the service refuses too.
  await withTiersBlank(async () => {
    await page.goto('/developers/rate-limits');
    await expect(requestForm().getByRole('status')).toHaveText(
      'Limits not set: rate-limit tiers are not set yet, so no higher limit can be asked for.',
    );
    await expect(requestForm().getByRole('button', { name: 'Send request' })).toBeDisabled();
    const session = await api(who);
    const direct = await session.post('/api/identity/trpc/apiLimitRequests.create', {
      keyId,
      askedPerMinute: 5000,
      spikeStartsOn: null,
      spikeEndsOn: null,
      note: '',
      requestId: `limit-request:${keyName}:blank`,
    });
    expect(direct.status, JSON.stringify(direct.body)).toBe(412);
    expect(JSON.stringify(direct.body)).toContain('identity.rate_limits_unset');
  });
  await page.goto('/developers/rate-limits');
  await expect(bodyRows(tableIn(page, 'Your limit requests')).filter({ hasText: keyName })).toHaveCount(1);
});

test(`${J} #6 the reviewer grants part of it: the customer is told the granted amount; one audit entry`, async ({ browser }) => {
  test.setTimeout(240_000);
  const { refillPerMinute } = await publishedModel();
  const asked = refillPerMinute * 4;
  const granted = refillPerMinute * 2;
  await page.goto('/developers/rate-limits');
  await expect(bodyRows(tableIn(page, 'Your limit requests')).filter({ hasText: keyName })).toContainText('Waiting for review');

  // The reviewer, in the founder console: the request in the queue, granted in part, with a reason.
  const ops = await (await browser.newContext()).newPage();
  try {
    await founderSignIn(ops);
    await ops.goto(`${ADMIN}/identity-ops/limits`);
    const row = bodyRows(tableIn(ops, 'Limit requests')).filter({ hasText: keyName });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(String(asked));
    await expect(row).toContainText('Waiting for review');
    await row.getByRole('button', { name: 'Review' }).click();
    const sheet = ops.getByRole('dialog', { name: 'Review limit request' });
    await sheet.getByLabel('Grant (calls a minute)').fill(String(granted));
    await sheet.getByLabel('Reason').fill('TEST: part of the launch week');
    await sheet.getByRole('button', { name: 'Grant in part' }).click();
    await expect(sheet).toBeHidden();
    const decided = bodyRows(tableIn(ops, 'Limit requests')).filter({ hasText: keyName });
    await expect(decided).toContainText('Granted in part');
    await expect(decided).toContainText(String(granted));
    // One audit entry for the decision, naming the key, what was asked, what it had and the amount granted.
    const audit = bodyRows(tableIn(ops, 'Audit')).filter({ hasText: keyName });
    await expect(audit).toHaveCount(1);
    await expect(audit).toContainText('Granted in part');
    await expect(audit).toContainText(String(asked));
    await expect(audit).toContainText(String(refillPerMinute));
    await expect(audit).toContainText(String(granted));
    await expect(audit).toContainText('TEST: part of the launch week');
  } finally {
    await ops.context().close();
  }

  // The customer is told the granted amount.
  await page.goto('/developers/rate-limits');
  const told = bodyRows(tableIn(page, 'Your limit requests')).filter({ hasText: keyName });
  await expect(told).toContainText('Granted in part');
  await expect(told).toContainText(`Granted ${fmt(granted)} calls a minute`);
  // And it is in force: the key's next call is metered at the granted refill.
  await page.waitForTimeout(3_000);
  expect((await withKey(key, { path: PATH })).status).toBe(200);
  await page.goto(`/uc/safe/api-keys/${keyId}`);
  await expect(page.getByRole('region', { name: 'Usage' })).toContainText(`${fmt(granted)} a minute`);
});
