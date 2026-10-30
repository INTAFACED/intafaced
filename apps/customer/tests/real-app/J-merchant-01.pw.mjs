import { test, expect } from '@playwright/test';
import { MONEY_ROOMS, businessReadyPerson, everyRoomOpens, openBusiness, refusedPayCalls } from './merchant.mjs';

// J-merchant-01, in the running app (docs/roadmap/journeys.json): open Business Pay and see my account as it really
// is. The business is new and its verification not started, so its owner holds the onboarding grant only, not the
// acquiring one. Each test proves one whole step; #4 is in J-merchant-01-team.pw.mjs and #6 in J-merchant-01-settings.pw.mjs.
const J = 'J-merchant-01';

test.describe.configure({ mode: 'default' });

/** The registry rows (apps/customer/src/app/feature-registry.ts) whose paths own `path`, matched as the app matches them. */
async function registryRowsFor(path) {
  const { features } = await import('../../src/app/feature-registry.ts');
  const { hasPattern, matchPath } = await import('../../src/app/path-match.ts');
  return features.filter((f) => f.paths.some((p) => p === path || (hasPattern(p) && matchPath(p, path) !== undefined)));
}

/** A tRPC reply's data, single or batched. */
const dataOf = (sent) => (Array.isArray(sent) ? sent[0] : sent)?.result?.data;

test(`${J} #1 More opens Business Pay at /pay/merchant from the registry row business-pay with its real status; with no business it leads to setup, and the new business's dashboard opens from it`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const refused = refusedPayCalls(page);
  const who = await businessReadyPerson(page, 'mo', '/more');
  // The Merchant entry in More is the one tile whose address /pay/merchant is owned by exactly one registry row,
  // business-pay. Its real status is the registry's word for it: live, which More draws as an open tile (a hidden row
  // would drop it) and which the room honours with no blocker note, reading the person's businesses from the service.
  const rows = await registryRowsFor('/pay/merchant');
  expect(rows.map((r) => r.id)).toEqual(['business-pay']);
  const [row] = rows;
  expect(row.status).toBe('live');
  const section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Money and pay', level: 2 }) });
  const tile = section.getByRole('link', { name: /^Merchant\b/ });
  await expect(tile).toHaveCount(1);
  await expect(tile).toHaveAttribute('href', '/pay/merchant');
  await expect(tile).toContainText('Accept payments and run your business');
  let access = null;
  const accessRead = page.waitForResponse(async (r) => {
    if (!r.url().includes('merchant.myAccess') || r.status() !== 200) return false;
    access = dataOf(await r.json().catch(() => null));
    return access != null;
  });
  await tile.click();
  await expect(page).toHaveURL(/\/pay\/merchant$/);
  await accessRead;
  // A live row opens with no blocker note above the room.
  await expect(page.getByRole('note').filter({ hasText: 'Hidden from customers' })).toHaveCount(0);
  // No business yet: the service answers "none of yours", not "no access".
  expect(access.memberships).toEqual([]);
  await expect(page.getByRole('heading', { name: 'No business account yet' })).toBeVisible();
  await expect(page.getByText('You don’t have access')).toHaveCount(0);
  await page.getByRole('link', { name: 'Start setup' }).click();
  await expect(page).toHaveURL(/\/pay\/onboarding/);
  // Until the business exists the team and verification reads answer "not a merchant": a typed answer, not a fault.
  await openBusiness(page, who);
  refused.length = 0;

  await page.getByRole('link', { name: 'Open the dashboard' }).click();
  await expect(page).toHaveURL(/\/pay\/merchant$/);
  await expect(page.getByRole('heading', { name: 'Business overview', level: 1 })).toHaveCount(1);
  expect(refused).toEqual([]);
});

test(`${J} #3 a new business reads its KPI area: one explanation with a link to create a payment link, no tile shows 0 as if measured, and each unmeasured figure says so with its own as-of`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const who = await businessReadyPerson(page, 'mk', '/pay/onboarding');
  await openBusiness(page, who, 'TEST First Ltd');
  const refused = refusedPayCalls(page);
  // The service's own answers the dashboard draws from: one snapshot per period, the daily series, and the refunds list.
  const snapshots = {};
  let series = null;
  const refundLists = [];
  page.on('response', async (r) => {
    const url = new URL(r.url());
    if (r.status() !== 200 || !url.pathname.startsWith('/api/pay/trpc/')) return;
    const data = dataOf(await r.json().catch(() => null));
    if (!data) return;
    if (url.pathname.endsWith('merchantMetrics.snapshot')) snapshots[JSON.parse(url.searchParams.get('input')).window.preset] = data;
    else if (url.pathname.endsWith('merchantMetrics.series')) series = data;
    else if (url.pathname.endsWith('payment.refunds.list')) refundLists.push(data);
  });
  await page.getByRole('link', { name: 'Open the dashboard' }).click();
  await expect(page).toHaveURL(/\/pay\/merchant$/);
  await expect(page.getByText('TEST First Ltd').first()).toBeVisible();
  // One explanation with the next step.
  await expect(page.getByRole('heading', { name: 'Your first payment starts here' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Create payment link/ }).first()).toHaveAttribute('href', '/pay/links/new');
  await expect.poll(() => Object.keys(snapshots).sort()).toEqual(['rolling_30d', 'rolling_7d', 'today']);
  await expect.poll(() => series !== null).toBe(true);

  // A new business: the service measured nothing for any period, and says when it looked.
  for (const snap of Object.values(snapshots)) {
    expect(snap).toMatchObject({ balances: [], paymentCount: 0, captured: [], refunded: [], net: [] });
    expect(snap.freshness.asOf).not.toBeNull();
    expect(snap.freshness.lagSeconds).not.toBeNull();
  }
  expect(series.points).toEqual([]);

  /** A figure's own as-of line: the service's asOf, to the millisecond, and its lag. */
  const asOfSays = async (where, freshness) => {
    const line = where.getByRole('status').filter({ hasText: /^As of / });
    await expect(line).toHaveCount(1);
    await expect(line.locator('time')).toHaveAttribute('datetime', freshness.asOf);
    if (freshness.lagSeconds < 60) await expect(line).toContainText(`· ${freshness.lagSeconds} s behind`);
  };

  // The balance says it has nothing to show rather than 0.00, with today's as-of.
  const balance = page.getByRole('region', { name: 'Available to pay out' });
  await expect(balance.getByRole('heading', { name: 'No balance to show yet' })).toBeVisible();
  await expect(balance.getByTestId('plo-balance-amount')).toHaveCount(0);
  await asOfSays(balance, snapshots.today.freshness);

  // Each period's tiles: a money figure the service has no rows for reads "—" with "No payments in this period", never
  // 0.00; the payment count is the service's own measured count; refunds issued reads None while the refunds list is
  // empty; and the strip carries that period's own as-of.
  expect(refundLists.length).toBeGreaterThan(0);
  const metrics = page.getByRole('region', { name: 'Reporting period' });
  for (const [preset, button] of [
    ['today', /^Today \(UTC\)/],
    ['rolling_7d', '7 days'],
    ['rolling_30d', '30 days'],
  ]) {
    await metrics.getByRole('button', { name: button }).click();
    const snap = snapshots[preset];
    const tiles = metrics.getByTestId('plo-kpi-strip').getByRole('link');
    await expect(tiles).toHaveCount(5);
    const shown = await tiles.evaluateAll((as) =>
      as.map((a) => ({
        label: a.querySelector('span')?.textContent?.split(' · ')[0],
        value: a.querySelector('strong')?.textContent?.trim(),
        none: a.querySelector('strong .pp-none')?.getAttribute('title') ?? null,
      })),
    );
    expect(shown, preset).toEqual([
      { label: 'Captured', value: '—', none: 'No payments in this period' },
      { label: 'Payments', value: String(snap.paymentCount), none: null },
      { label: 'Refunds on payments taken', value: '—', none: 'No payments in this period' },
      { label: 'Refunds issued', value: 'None', none: null },
      { label: 'Net received', value: '—', none: 'No payments in this period' },
    ]);
    for (const tile of shown) if (tile.label !== 'Payments') expect(tile.value, `${preset} ${tile.label}`).not.toMatch(/^0([.,]0*)?\b/);
    await asOfSays(metrics, snap.freshness);
  }
  for (const list of refundLists) expect(list.items).toEqual([]);

  // Pending settlement draws no figure for a business with no balance, with today's as-of.
  const pending = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Pending settlement', level: 2 }) });
  const pendingText = await pending.evaluate((el) => {
    const copy = el.cloneNode(true);
    copy.querySelectorAll('[role="status"]').forEach((n) => n.remove());
    return copy.textContent;
  });
  expect(pendingText).not.toMatch(/\d/);
  await asOfSays(pending, snapshots.today.freshness);

  // The volume chart says there is nothing in the period, with the series' own as-of, and draws no bars.
  const volume = page.getByTestId('plo-volume');
  await expect(volume.getByRole('heading', { name: 'No captured payments in this period' })).toBeVisible();
  await expect(volume.getByRole('img')).toHaveCount(0);
  await asOfSays(volume, series.freshness);

  // More insights holds one explanation with its link, not a wall of zero tiles.
  await page.getByRole('button', { name: 'More payment insights' }).click();
  const insights = page.getByRole('region', { name: 'More payment insights' });
  await expect(insights.getByRole('heading', { name: 'No payments yet' })).toBeVisible();
  await expect(insights.getByRole('link', { name: 'Create a payment link' })).toHaveAttribute('href', '/pay/links');
  await expect(insights.getByRole('group')).toHaveCount(0);
  expect(refused).toEqual([]);
});

test(`${J} #2 a business with verification not started: its checklist, "Not verified", every room reachable, Pay out and Refund leading to pages that say there is nothing to move yet, and no call to the founder console`, async ({
  page,
}) => {
  test.setTimeout(420_000);
  const who = await businessReadyPerson(page, 'mh', '/pay/onboarding');
  await openBusiness(page, who, 'TEST Rooms Ltd');
  const refused = refusedPayCalls(page);
  const asked = [];
  page.on('request', (req) => req.url().includes('/api/') && asked.push(req.url()));
  const errors = [];
  page.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()));

  // The service's own word on this person's place in the business: the owner of an account that is not active yet,
  // whose verification has not started.
  await page.getByRole('link', { name: 'Open the dashboard' }).click();
  await expect(page).toHaveURL(/\/pay\/merchant$/);
  // A fresh load, so the page reads it now rather than from what an earlier page kept.
  // The body is read as the response arrives: a read the reload cuts off has no body, so it is not the one.
  let sent = null;
  const accessRead = page.waitForResponse(async (r) => {
    if (!r.url().includes('merchant.myAccess') || r.status() !== 200) return false;
    sent = await r.json().catch(() => null);
    return sent !== null;
  });
  await page.reload();
  await accessRead;
  const memberships = (Array.isArray(sent) ? sent[0] : sent).result.data.memberships;
  expect(memberships).toHaveLength(1);
  // Verification not started: no KYB application and not verified (the account's own status is a separate field).
  expect(memberships[0]).toMatchObject({ role: 'owner', kybStatus: 'none', verified: false });
  await expect(page.getByText('TEST Rooms Ltd').first()).toBeVisible();
  await expect(page.getByText('Not verified').first()).toBeVisible();
  const account = page.locator('main section').filter({ hasText: 'Business verification' }).last();
  await expect(account).toContainText('Not sent');
  await expect(account).toContainText('Your role');
  await expect(account).toContainText('Owner');

  // The home page has no money action of its own; the money rooms' Pay out and Issue a refund are checked room by room
  // below.

  // The checklist: the setup steps, each in the state the service's own onboarding progress gives it.
  await page.getByRole('link', { name: /Set up your account/ }).click();
  await expect(page).toHaveURL(/\/pay\/onboarding$/);
  // The body is read as the response arrives: a read the reload cuts off has no body, so it is not the one.
  let progressBody = null;
  const progressRead = page.waitForResponse(async (r) => {
    if (!r.url().includes('merchant.onboarding.progress') || r.status() !== 200) return false;
    progressBody = await r.json().catch(() => null);
    return progressBody !== null;
  });
  await page.reload();
  await progressRead;
  const progress = (Array.isArray(progressBody) ? progressBody[0] : progressBody).result.data;
  expect(progress.kybStatus).not.toBe('approved');
  const verification = progress.kybStatus === 'pending' ? 'Waiting for review' : 'Up next';
  const expected = [
    ['Business details', progress.business.done ? 'Done' : 'Up next'],
    ['Verification', verification],
    ['Payout destination', progress.destination.present ? 'Done' : verification === 'Up next' ? 'Not started' : 'Up next'],
  ];
  const steps = page.getByRole('navigation', { name: 'Setup steps' }).getByRole('listitem');
  await expect(steps).toHaveCount(expected.length);
  for (const [i, [title, state]] of expected.entries()) {
    await expect(steps.nth(i).getByRole('heading')).toHaveText(`Step ${i + 1} of 3: ${title}`);
    await expect(steps.nth(i).locator('strong')).toHaveText(state);
  }
  expect(refused).toEqual([]);
  expect(errors).toEqual([]);

  // Every room is reachable from navigation.
  const rooms = await everyRoomOpens(page);
  await test
    .info()
    .attach('rooms-and-states.json', { body: JSON.stringify(Object.fromEntries(rooms), null, 2), contentType: 'application/json' });
  // svc-pay does not hold back a payout or a refund for verification on test money: the payout door refuses KYB that is
  // not approved only under live acquiring (`merchant-kyb-money-gate.ts`), and refunds are never KYB-gated. So each
  // money room's action is on, and it leads to a page that says plainly there is nothing to move yet.
  const target = (room) => (room === '/pay/refunds' ? '/pay/refunds/new' : '/pay/payouts/new');
  for (const room of MONEY_ROOMS) expect(rooms.get(room).action, room).toEqual({ on: [target(room)] });
  await page.goto('/pay/payouts/new');
  await expect(page.getByText('Nothing is ready to pay out')).toBeVisible();
  await expect(page.getByText('A settlement becomes payable once its statement is finalised.')).toBeVisible();
  await expect(page.getByRole('button', { name: /^(Ask|Pay out|Send)/ })).toHaveCount(0);
  await page.goto('/pay/refunds/new');
  await expect(page.getByText('No refundable payments')).toBeVisible();
  await expect(page.getByText('No payment matches, or everything has been refunded already.')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Refund/ })).toHaveCount(0);
  // The portal never asks the founder's console for anything.
  expect(asked.filter((url) => /founderAdmin/i.test(url))).toEqual([]);
});

test(`${J} #5 the team page lists the five built-in roles and every permission exactly as the service's role table holds them`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const who = await businessReadyPerson(page, 'mr', '/pay/onboarding');
  await openBusiness(page, who, 'TEST Roles Ltd');
  const refused = refusedPayCalls(page);
  const answer = page.waitForResponse((r) => r.url().includes('merchantOps.permissions.catalogue'));
  await page.goto('/pay/team');
  const sent = await (await answer).json();
  const catalogue = (Array.isArray(sent) ? sent[0] : sent).result.data;
  expect(catalogue.roles.map((r) => r.role)).toEqual(['owner', 'admin', 'finance', 'developer', 'viewer']);

  const roles = page.getByRole('region', { name: 'What each role can do' });
  for (const role of catalogue.roles) await expect(roles).toContainText(role.description);
  // Each permission row, in the service's order: the five cells say Yes exactly where its heldBy names the role.
  const order = ['owner', 'admin', 'finance', 'developer', 'viewer'];
  const expected = catalogue.areas.flatMap((g) => g.permissions.map((p) => order.map((r) => (p.heldBy.includes(r) ? 'Yes' : 'No'))));
  const matrix = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Every permission, by role' }) });
  await expect(matrix.locator('tbody tr')).toHaveCount(expected.length);
  const shown = await matrix
    .locator('tbody tr')
    .evaluateAll((trs) => trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent)));
  expect(shown).toEqual(expected);
  expect(expected.length).toBeGreaterThan(20);
  await expect(matrix.getByText(/has no name for yet/)).toHaveCount(0);
  expect(refused).toEqual([]);
});
