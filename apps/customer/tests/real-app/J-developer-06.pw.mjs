// World: restart
import { test, expect } from './journey.mjs';
import { restartWith } from './stack.mjs';
import { codeOf, keyHolder, makeKey, withKey } from './developer.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { bodyRows, tableIn } from './tables.mjs';

// J-developer-06, in the running app (docs/roadmap/journeys.json; the step words are in project-state
// operation-zero/modules/developer/acceptance/journeys.md): a developer stays inside the rate limits and asks for more.
// One test per step, titled "J-developer-06 #<n>". The person is a TEST account with a passkey and one live key made in
// the browser (developer.mjs keyHolder, makeKey); the owner has set the base tier (the stack's TEST tier). Every call
// after that goes from the developer's own program straight to Edge, as a bot's would.
//
// Where a step needs the tiers blank ("with no tiers set", "when the owner never set the base tier"), Edge is restarted
// with its TEST tiers switched off (LOCAL_STACK_EDGE_RATE_TIERS=off) and put back right after.
// A part that is not built yet fails at it quickly (UNBUILT) instead of waiting out the default timeout.
const J = 'J-developer-06';
const UNBUILT = { timeout: 10_000 };
const TIERS_SWITCH = 'LOCAL_STACK_EDGE_RATE_TIERS';
// The route the bot calls: a read on the trade door, which Edge counts against the key's own bucket.
const ROUTE = '/api/v1/orders/open?symbol=BTC%2FUSDT';
const ROUTE_NAME = 'GET /api/v1/orders/open';
// Every journey on a shard shares one client address, so a probe of the burst spends that address's budget too. A TEST
// base tier with a burst above this would starve the other journeys; the step then fails and says so.
const MAX_PROBE = 200;

test.describe.configure({ mode: 'default' });
test.use({ actionTimeout: 15_000 });

/** @type {import('@playwright/test').Page} */
let page;
let key;
let keyId;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  ({ page } = await keyHolder(browser, 'dl6'));
  key = await makeKey(page, { name: 'limits-bot', preset: 'Trade' });
  await page.goto('/uc/safe/api-keys');
  await page.getByTestId('api-keys__table').getByRole('link', { name: 'limits-bot' }).click();
  await expect(page).toHaveURL(/\/uc\/safe\/api-keys\/[0-9a-f-]{36}$/);
  keyId = new URL(page.url()).pathname.split('/').at(-1);
});

test.afterAll(async () => {
  await page?.context().close();
});

/** Edge with its TEST tiers blank for `body`, then back on the stack's TEST tiers, whatever `body` did. */
async function withTiersBlank(body) {
  restartWith('edge', TIERS_SWITCH, false);
  try {
    await body();
  } finally {
    restartWith('edge', TIERS_SWITCH, true);
  }
}

const number = (text) => {
  const m = /-?\d+(?:\.\d+)?/.exec(String(text ?? '').replace(/,/g, ''));
  if (!m) throw new Error(`no number in "${text}"`);
  return Number(m[0]);
};

/** The published model as the page shows it: the base tier's burst and refill per second, and the route's cost. */
async function publishedModel() {
  await page.goto('/developers/rate-limits');
  const tiers = tableIn(page, 'Rate-limit tiers');
  await expect(tiers).toBeVisible(UNBUILT);
  const headers = (await tiers.getByRole('columnheader').allTextContents()).map((h) => h.trim());
  const burstAt = headers.findIndex((h) => /burst/i.test(h));
  const refillAt = headers.findIndex((h) => /refill/i.test(h));
  expect(burstAt, `tier columns: ${headers.join(' | ')}`).toBeGreaterThanOrEqual(0);
  expect(refillAt, `tier columns: ${headers.join(' | ')}`).toBeGreaterThanOrEqual(0);
  const base = bodyRows(tiers).filter({ hasText: /base/i });
  await expect(base).toHaveCount(1);
  const baseCells = base.getByRole('rowheader').or(base.getByRole('cell'));
  const burst = number(await baseCells.nth(burstAt).textContent());
  const refill = number(await baseCells.nth(refillAt).textContent());
  const costs = tableIn(page, 'Cost per route');
  const routeRow = bodyRows(costs).filter({ hasText: ROUTE_NAME });
  await expect(routeRow).toHaveCount(1);
  const cost = number(await routeRow.getByRole('cell').last().textContent());
  return { burst, refill, cost };
}

test(`${J} #1 reads the limits page: the tiers, the per-route cost, the burst and the refill; with no tiers set, a banner saying so`, async () => {
  test.setTimeout(240_000);
  await page.goto('/developers/rate-limits');
  await expect(page.getByRole('heading', { name: 'Rate limits', level: 1 })).toBeVisible();
  // The section is written, not a "waits for" placeholder.
  await expect(page.getByText(/waits for DV-limits-01/i)).toHaveCount(0);

  // The tiers: each with its burst and its refill, the base tier the owner set among them.
  const tiers = tableIn(page, 'Rate-limit tiers');
  await expect(tiers).toBeVisible(UNBUILT);
  const headers = await tiers.getByRole('columnheader').allTextContents();
  expect(
    headers.some((h) => /tier/i.test(h)),
    headers.join(' | '),
  ).toBe(true);
  expect(
    headers.some((h) => /burst/i.test(h)),
    headers.join(' | '),
  ).toBe(true);
  expect(
    headers.some((h) => /refill/i.test(h)),
    headers.join(' | '),
  ).toBe(true);
  expect(await bodyRows(tiers).count()).toBeGreaterThan(0);
  const { burst, refill, cost } = await publishedModel();
  expect(burst).toBeGreaterThan(0);
  expect(refill).toBeGreaterThan(0);

  // The per-route cost: every route a key can call has a cost, the bot's route among them.
  await page.goto('/developers/rate-limits');
  const costs = tableIn(page, 'Cost per route');
  await expect(costs).toBeVisible();
  expect(await bodyRows(costs).count()).toBeGreaterThan(1);
  expect(cost).toBeGreaterThan(0);
  // The page says what burst and refill mean, in words, beside the numbers.
  await expect(page.getByRole('main')).toContainText(/burst/i);
  await expect(page.getByRole('main')).toContainText(/refill/i);
  // With tiers set, no "not set" banner.
  await expect(
    page
      .getByRole('main')
      .getByRole('status')
      .filter({ hasText: /no (rate-limit )?tiers (are )?set/i }),
  ).toHaveCount(0);

  // With no tiers set: a banner saying so, and no invented tier.
  await withTiersBlank(async () => {
    await page.goto('/developers/rate-limits');
    await expect(
      page
        .getByRole('main')
        .getByRole('status')
        .filter({ hasText: /no (rate-limit )?tiers (are )?set/i }),
    ).toBeVisible();
    await expect(bodyRows(tableIn(page, 'Rate-limit tiers'))).toHaveCount(0);
  });
});

test(`${J} #2 sends calls faster than the refill: allowed until the burst is spent, then 429 with reason, retry-after seconds and the request id, and matching headers`, async () => {
  test.setTimeout(180_000);
  const { burst, refill, cost } = await publishedModel();
  const allowedAtOnce = Math.floor(burst / cost);
  expect(allowedAtOnce, `the TEST base tier's burst ${burst} at cost ${cost}`).toBeGreaterThan(0);
  expect(allowedAtOnce + 5, `a burst above ${MAX_PROBE} calls would spend the shard's shared address budget`).toBeLessThanOrEqual(
    MAX_PROBE,
  );

  // A wait for the bucket to fill: the earlier steps' reads of the route count too.
  await page.waitForTimeout(Math.ceil((burst / refill) * 1000) + 1000);
  // All at once, far faster than the refill.
  const started = Date.now();
  const replies = await Promise.all(Array.from({ length: allowedAtOnce + 5 }, () => withKey(key, { path: ROUTE })));
  const elapsedSeconds = (Date.now() - started) / 1000;
  const allowed = replies.filter((r) => r.status !== 429);
  const refused = replies.filter((r) => r.status === 429);
  // Every call that got through was answered by the route itself, never a different refusal.
  for (const r of allowed) expect(r.status, JSON.stringify(r.body)).toBe(200);
  // Calls are allowed until the burst is spent (plus only what refilled while they were in flight), then refused.
  expect(allowed.length).toBeGreaterThanOrEqual(allowedAtOnce);
  expect(allowed.length).toBeLessThanOrEqual(Math.floor((burst + refill * elapsedSeconds) / cost));
  expect(refused.length).toBeGreaterThan(0);

  const limited = refused[0];
  expect(codeOf(limited.body), JSON.stringify(limited.body)).toBe('edge.rate_limited');
  // The reason: which limit refused it.
  expect(['global', 'endpoint', 'concurrency']).toContain(limited.body.reason);
  // Retry-after in whole seconds, no more than one call's cost takes to refill.
  expect(Number.isInteger(limited.body.retryAfterSeconds), JSON.stringify(limited.body)).toBe(true);
  expect(limited.body.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  expect(limited.body.retryAfterSeconds).toBeLessThanOrEqual(Math.ceil(cost / refill));
  // The request id, in the body for support.
  expect(limited.body.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  // The headers say the same.
  expect(limited.headers.get('retry-after')).toBe(String(limited.body.retryAfterSeconds));
  expect(limited.headers.get('x-request-id')).toBe(limited.body.requestId);
  expect(limited.headers.get('x-ratelimit-reason')).toBe(limited.body.reason);
  expect(limited.headers.get('x-ratelimit-remaining')).toBe('0');
  expect(limited.headers.get('x-ratelimit-cost')).toBe(String(cost));
});

/** The key detail's usage, as the page shows it: used, remaining and the as-of time. */
async function usage() {
  const box = page.getByRole('region', { name: 'Usage' });
  await expect(box).toBeVisible(UNBUILT);
  return {
    used: number(await box.getByTestId('api-keys__used').textContent()),
    remaining: number(await box.getByTestId('api-keys__remaining').textContent()),
    asOf: (await box.getByTestId('api-keys__usage-as-of').textContent())?.trim(),
  };
}

test(`${J} #3 opens the key detail: used and remaining with an as-of time that moves on Refresh`, async () => {
  test.setTimeout(120_000);
  const { burst, cost } = await publishedModel();
  await withKey(key, { path: ROUTE });
  await page.goto(`/uc/safe/api-keys/${keyId}`);
  const first = await usage();
  // The key has made calls (step 2's and the one above): used counts them, remaining is what is left of the burst.
  expect(first.used).toBeGreaterThan(0);
  expect(first.remaining).toBeGreaterThanOrEqual(0);
  expect(first.remaining).toBeLessThanOrEqual(burst);
  expect(first.asOf).toMatch(/as of/i);
  expect(Number.isNaN(Date.parse(first.asOf.replace(/^.*as of\s*/i, '')))).toBe(false);

  // One more call, then Refresh: the as-of time moves and used counts the call.
  await page.waitForTimeout(1_500);
  const call = await withKey(key, { path: ROUTE });
  expect([200, 429]).toContain(call.status);
  await page.getByRole('region', { name: 'Usage' }).getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByTestId('api-keys__usage-as-of')).not.toHaveText(first.asOf);
  const second = await usage();
  expect(Date.parse(second.asOf.replace(/^.*as of\s*/i, ''))).toBeGreaterThan(Date.parse(first.asOf.replace(/^.*as of\s*/i, '')));
  if (call.status === 200) expect(second.used).toBeGreaterThanOrEqual(first.used + cost);
});

test(`${J} #4 reads the backoff guidance: the documented exponential backoff with jitter`, async () => {
  await page.goto('/developers/rate-limits');
  const guidance = page.getByRole('region', { name: /backoff/i });
  await expect(guidance).toBeVisible(UNBUILT);
  await expect(guidance).toContainText(/exponential/i);
  await expect(guidance).toContainText(/jitter/i);
  // It tells the client to wait at least what retry-after says before the next try.
  await expect(guidance).toContainText(/retry-after/i);
});

/** The higher-limit request form in the developer area. */
const requestForm = () => page.getByRole('form', { name: 'Ask for a higher limit' });

test(`${J} #5 submits a request for a higher limit and a spike notice: the request recorded; when the owner never set the base tier, the form says limits not set`, async () => {
  test.setTimeout(240_000);
  const { burst } = await publishedModel();
  const asked = burst * 4;
  const day = (days) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);

  await page.goto('/developers/rate-limits');
  const form = requestForm();
  await expect(form).toBeVisible(UNBUILT);
  await form.getByLabel('Key').selectOption({ label: 'limits-bot' });
  await form.getByLabel('Limit asked for').fill(String(asked));
  // The spike notice: when the traffic will spike.
  await form.getByLabel('Spike starts').fill(day(7));
  await form.getByLabel('Spike ends').fill(day(8));
  await form.getByLabel('Why').fill('TEST: a launch week');
  await form.getByRole('button', { name: 'Send request' }).click();
  await expect(
    page
      .getByRole('main')
      .getByRole('status')
      .filter({ hasText: /request (is )?recorded/i }),
  ).toBeVisible();

  // Recorded: it is still there after a reload, with what was asked and the spike window, waiting for review.
  await page.reload();
  const mine = bodyRows(tableIn(page, 'Your limit requests')).filter({ hasText: 'limits-bot' });
  await expect(mine).toHaveCount(1);
  await expect(mine).toContainText(String(asked));
  await expect(mine).toContainText(day(7));
  await expect(mine).toContainText(day(8));
  await expect(mine).toContainText(/waiting for review/i);

  // When the owner never set the base tier, the form says limits not set, and sends nothing.
  await withTiersBlank(async () => {
    await page.goto('/developers/rate-limits');
    await expect(requestForm()).toContainText(/limits not set/i);
    await expect(requestForm().getByRole('button', { name: 'Send request' })).toBeDisabled();
  });
});

test(`${J} #6 the reviewer grants part of it: the customer is told the granted amount; one audit entry`, async ({ browser }) => {
  test.setTimeout(240_000);
  const { burst } = await publishedModel();
  const asked = burst * 4;
  const granted = burst * 2;
  await page.goto('/developers/rate-limits');
  const mine = bodyRows(tableIn(page, 'Your limit requests')).filter({ hasText: 'limits-bot' });
  await expect(mine).toHaveCount(1, UNBUILT);
  await expect(mine).toContainText(/waiting for review/i);

  // The reviewer, in the founder console: the request in the review queue, granted in part.
  const ops = await (await browser.newContext()).newPage();
  try {
    await founderSignIn(ops);
    await ops.goto(`${ADMIN}/support/limit-requests`);
    const row = bodyRows(tableIn(ops, 'Limit requests')).filter({ hasText: 'limits-bot' });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(String(asked));
    await row.getByRole('button', { name: 'Review' }).click();
    const sheet = ops.getByRole('dialog', { name: 'Review limit request' });
    await sheet.getByLabel('Grant').fill(String(granted));
    await sheet.getByLabel('Reason').fill('TEST: part of the launch week');
    await sheet.getByRole('button', { name: 'Grant in part' }).click();
    await expect(sheet).toBeHidden();
    await expect(row).toContainText(/granted in part/i);
    // One audit entry for the grant, naming the request and the amount.
    const audit = bodyRows(tableIn(ops, 'Audit')).filter({ hasText: 'limits-bot' });
    await expect(audit).toHaveCount(1);
    await expect(audit).toContainText(String(granted));
  } finally {
    await ops.context().close();
  }

  // The customer is told the granted amount.
  await page.goto('/developers/rate-limits');
  const told = bodyRows(tableIn(page, 'Your limit requests')).filter({ hasText: 'limits-bot' });
  await expect(told).toContainText(/granted in part/i);
  await expect(told).toContainText(String(granted));
  await page.goto('/notifications');
  await expect(page.getByRole('main')).toContainText(new RegExp(`limit.*${granted}`, 'i'));
});
