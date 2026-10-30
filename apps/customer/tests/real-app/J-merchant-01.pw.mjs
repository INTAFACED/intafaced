import { test, expect } from '@playwright/test';
import { MONEY_OFF_INACTIVE, businessReadyPerson, everyRoomOpens, openBusiness, refusedPayCalls } from './merchant.mjs';

// J-merchant-01, in the running app (docs/roadmap/journeys.json): open Business Pay and see my account as it really
// is. The business is new and its verification not started, so its owner holds the onboarding grant only, not the
// acquiring one. Each test proves one whole step; #4 is in J-merchant-01-team.pw.mjs and #6 in J-merchant-01-settings.pw.mjs.
const J = 'J-merchant-01';

test.describe.configure({ mode: 'default' });

test(`${J} #1 More opens Business Pay at /pay/merchant; with no business it leads to setup, and the new business's dashboard opens from it`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const refused = refusedPayCalls(page);
  const who = await businessReadyPerson(page, 'mo', '/more');
  await page
    .getByRole('link', { name: /Merchant/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/pay\/merchant$/);
  // No business yet: the service answers "none of yours", not "no access".
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

test(`${J} #3 a new business reads its KPI area: one explanation with a link to create a payment link, no balance shown as 0, and the as-of`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const who = await businessReadyPerson(page, 'mk', '/pay/onboarding');
  await openBusiness(page, who, 'TEST First Ltd');
  const refused = refusedPayCalls(page);
  await page.getByRole('link', { name: 'Open the dashboard' }).click();
  await expect(page).toHaveURL(/\/pay\/merchant$/);
  await expect(page.getByText('TEST First Ltd').first()).toBeVisible();
  // One explanation with the next step, and the balance says it has nothing to show rather than 0.00.
  await expect(page.getByRole('heading', { name: 'Your first payment starts here' })).toBeVisible();
  await expect(page.getByText('No balance to show yet')).toBeVisible();
  await expect(page.getByRole('link', { name: /Create payment link/ }).first()).toBeVisible();
  await expect(page.getByText(/^As of .* UTC/).first()).toBeVisible();
  expect(refused).toEqual([]);
});

test(`${J} #2 a business with verification not started: its checklist, "Not verified", every room reachable, refunds and payouts off with what blocks them, and no call to the founder console`, async ({
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

  // The home page has no money action of its own; the money rooms' Pay out and Refund, switched off with what blocks
  // them, are checked room by room below (everyRoomOpens with moneyOff).

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

  // Every room is reachable from navigation, and each one that moves money out says why it is off.
  const rooms = await everyRoomOpens(page, { moneyOff: MONEY_OFF_INACTIVE });
  await test
    .info()
    .attach('rooms-and-states.json', { body: JSON.stringify(Object.fromEntries(rooms), null, 2), contentType: 'application/json' });
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
