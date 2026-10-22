import { test, expect } from '@playwright/test';
import { businessReadyPerson, openBusiness, refusedPayCalls } from './merchant.mjs';

// J-merchant-01, in the running app (docs/roadmap/journeys.json): open Business Pay and see my account as it really
// is. The business is new and its verification not started, so its owner holds the onboarding grant only, not the
// acquiring one. Tests titled "J-merchant-01 #<n>" prove a whole step; the others prove part of one and say which.
const J = 'J-merchant-01';

test.describe.configure({ mode: 'default' });

/** Every room the portal's navigation reaches from the home page, with its own address. */
async function navRooms(page) {
  const hrefs = await page.locator('nav a[href^="/pay/"]').evaluateAll((links) => links.map((a) => a.getAttribute('href')));
  return [...new Set(hrefs)];
}

test(`${J} #1 and #3 More opens Business Pay; with no business it leads to setup, and a new business sees one explanation, not a wall of zeros`, async ({
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
  // #3: one explanation with the next step, and the balance says it has nothing to show rather than 0.00.
  await expect(page.getByRole('heading', { name: 'Your first payment starts here' })).toBeVisible();
  await expect(page.getByText('No balance to show yet')).toBeVisible();
  await expect(page.getByRole('link', { name: /Create payment link/ }).first()).toBeVisible();
  await expect(page.getByText(/^As of .* UTC/).first()).toBeVisible();
  expect(refused).toEqual([]);
});

test(`${J} #2 and part of #4 a business with verification not started: "Not verified", the owner role, and every room opens`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const who = await businessReadyPerson(page, 'mh', '/pay/onboarding');
  await openBusiness(page, who, 'TEST Rooms Ltd');
  const refused = refusedPayCalls(page);
  const asked = [];
  page.on('request', (req) => req.url().includes('/api/') && asked.push(req.url()));
  const errors = [];
  page.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()));

  await page.getByRole('link', { name: 'Open the dashboard' }).click();
  await expect(page.getByText('TEST Rooms Ltd').first()).toBeVisible();
  await expect(page.getByText('Not verified').first()).toBeVisible();
  const account = page.locator('main section').filter({ hasText: 'Business verification' }).last();
  await expect(account).toContainText('Not sent');
  await expect(account).toContainText('Your role');
  await expect(account).toContainText('Owner');
  await expect(page.getByRole('link', { name: /Set up your account/ })).toHaveAttribute('href', '/pay/onboarding');

  // #4 (owner): each room from navigation opens with its own heading, never "no access", and no refused read.
  const visited = new Set();
  const queue = await navRooms(page);
  while (queue.length) {
    const room = queue.shift();
    if (visited.has(room)) continue;
    visited.add(room);
    await page.goto(room);
    await expect(page.locator('main h1').first(), room).toBeVisible();
    await expect(page.getByText('You don’t have access'), room).toHaveCount(0);
    for (const next of await navRooms(page)) if (!visited.has(next)) queue.push(next);
  }
  expect(visited.size).toBeGreaterThan(20);
  expect(refused).toEqual([]);
  expect(errors).toEqual([]);
  // The portal never asks the founder's console for anything.
  expect(asked.filter((url) => /founderAdmin/i.test(url))).toEqual([]);
});
