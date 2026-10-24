import path from 'node:path';
import { test, expect } from '@playwright/test';
import { ROOT, journeyState } from './stack.mjs';
import { forgetSession } from './identity-factors.mjs';
import { businessReadyPerson, openBusiness, refusedPayCalls, signInWithCode, verifiedBusiness } from './merchant.mjs';

// J-merchant-03, in the running app (docs/roadmap/journeys.json): create a product and a price. One test per step,
// titled "J-merchant-03 #<n>", run in order on one verified TEST business. #1 makes the owner, a finance member and a
// viewer; the later steps sign the owner in again. Products are records only: nothing here moves money.
const J = 'J-merchant-03';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

/** What #1 left: the owner (with its authenticator secret) and the business. */
function journey() {
  const state = run.read();
  if (!state.owner?.secret) throw new Error(`${J} #1 made no business, so this step has no owner to act as`);
  return state;
}

const saved = (who) => ({
  handle: who.handle,
  email: who.email,
  password: who.password,
  secret: who.secret,
  step: who.step,
  userId: who.userId,
});

/** The owner signs in again (with the authenticator code function the saved state cannot carry), and the code's time step
 * is kept so the next sign-in waits for a fresh code. */
async function signInOwner(page, state, destination) {
  const { totp } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));
  const who = { ...state.owner, totp };
  await signInWithCode(page, who, destination);
  run.write({ owner: saved(who) });
  return who;
}

/** A 1x1 PNG: the smallest real image. TEST bytes. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** The owner invites a person by account id with a role; that person accepts from their own sign-in. */
async function addMember(page, who, role, ownerWho) {
  await signInWithCode(page, ownerWho, '/pay/team');
  await page.getByRole('button', { name: 'Invite by account ID instead' }).click();
  await page.getByLabel('Account ID *').fill(who.userId);
  await page.getByRole('combobox', { name: /^Role \*/ }).selectOption({ label: role });
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await page.getByRole('dialog').locator('.form-stack > button').last().click();
  await expect(
    page
      .getByRole('row')
      .filter({ hasText: role })
      .filter({ hasText: /Invited/ }),
  ).toHaveCount(1);
  await forgetSession(page);
  await signInWithCode(page, who, '/pay/team');
  const accept = page.locator('li').filter({ hasText: role }).getByRole('button', { name: 'Accept' }).first();
  await expect(async () => {
    await page.reload();
    await expect(accept).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 30_000 });
  await accept.click();
  await page.getByRole('dialog').locator('.form-stack > button').last().click();
  await expect(accept).toHaveCount(0);
}

test(`${J} #1 Products opens empty with Add product, and finance and viewers see no way to add`, async ({ page }) => {
  test.setTimeout(420_000);
  run.reset({});
  const finance = await businessReadyPerson(page, 'm3f', '/pay/merchant');
  await forgetSession(page);
  const viewer = await businessReadyPerson(page, 'm3v', '/pay/merchant');
  await forgetSession(page);
  const own = await businessReadyPerson(page, 'm3o', '/pay/onboarding');
  const merchantId = await openBusiness(page, own, 'TEST Catalogue Ltd');
  await verifiedBusiness(page, own, merchantId);
  await forgetSession(page);
  run.write({ owner: saved(own) });

  await addMember(page, finance, 'Finance', own);
  await forgetSession(page);
  await addMember(page, viewer, 'Viewer', own);
  await forgetSession(page);
  run.write({ owner: saved(own) });

  await signInWithCode(page, own, '/pay/products');
  const refused = refusedPayCalls(page);
  await expect(page.getByRole('heading', { name: 'No products yet' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Add product' })).toHaveAttribute('href', '/pay/products/new');
  expect(refused).toEqual([]);
  await forgetSession(page);
  run.write({ owner: saved(own) });

  for (const member of [finance, viewer]) {
    await signInWithCode(page, member, '/pay/products');
    const theirs = refusedPayCalls(page);
    await expect(page.getByRole('heading', { name: 'No products yet' })).toBeVisible();
    await expect(page.getByText('The owner, an admin or a developer can add them.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Add product' })).toHaveCount(0);
    await page.goto('/pay/products/new');
    await expect(page.getByRole('button', { name: 'Save product' })).toHaveCount(0);
    expect(theirs).toEqual([]);
    await forgetSession(page);
  }
});

test(`${J} #2 the owner adds a product with type, unit label, descriptor and image, and a taken id is refused`, async ({ page }) => {
  test.setTimeout(240_000);
  const state = journey();
  const own = await signInOwner(page, state, '/pay/products/new');
  const refused = refusedPayCalls(page);
  const save = page.getByRole('button', { name: 'Save product' });
  await expect(save).toBeDisabled();

  // An event asks for its start time and place; a digital product does not.
  const type = page.getByLabel('Type *');
  await type.selectOption({ label: 'Event' });
  await expect(page.getByLabel('Start time *')).toBeVisible();
  await expect(page.getByLabel('Location *')).toBeVisible();
  await type.selectOption({ label: 'Digital product' });
  await expect(page.getByLabel('Start time *')).toHaveCount(0);
  await expect(page.getByLabel('Location *')).toHaveCount(0);
  await type.selectOption({ label: 'Physical good' });

  // The image rule is the owner's (a TEST 500 KB on this stack): a 3 MB file and a GIF are refused with it.
  const image = page.getByLabel('Image');
  const big = Buffer.concat([PNG, Buffer.alloc(3_000_000 - PNG.length, 0)]);
  await image.setInputFiles({ name: 'TEST-big.png', mimeType: 'image/png', buffer: big });
  await expect(page.getByText('This file is 3 MB. Images can be up to 500 KB, as PNG, JPEG or WebP.')).toBeVisible();
  await image.setInputFiles({ name: 'TEST.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a TEST', 'latin1') });
  await expect(page.getByText('This file is not a PNG, JPEG or WebP image.', { exact: false })).toBeVisible();
  await image.setInputFiles({ name: 'TEST.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByRole('status').filter({ hasText: 'Image added.' })).toBeVisible();

  const id = `poster-${own.handle}`;
  await page.getByLabel('Name *').fill('TEST Poster');
  await expect(save).toBeEnabled();
  await page.getByLabel('Unit label').fill('print');
  await page.getByLabel('Statement descriptor').fill('TEST POSTERS');
  await page.getByLabel('Product ID').fill(id);
  await save.click();
  await expect(page).toHaveURL(/\/pay\/products\/[0-9a-f-]{36}$/);
  const facts = page.locator('dl.pp-facts');
  await expect(facts).toContainText('TEST Poster');
  await expect(facts).toContainText('Physical good');
  await expect(facts).toContainText(id);
  await expect(facts).toContainText('print');
  await expect(facts).toContainText('TEST POSTERS');
  await expect(page.getByRole('img', { name: 'Picture of TEST Poster' })).toBeVisible();
  run.write({ productUrl: new URL(page.url()).pathname });

  // The same chosen id again is refused as taken, and nothing new is listed.
  await page.goto('/pay/products/new');
  await page.getByLabel('Name *').fill('TEST Second poster');
  await page.getByLabel('Product ID').fill(id);
  await save.click();
  await expect(page.getByText('Another product already uses this product ID.', { exact: false })).toBeVisible();
  await page.goto('/pay/products');
  await expect(page.getByRole('link', { name: 'Add product' })).toBeVisible();
  await expect(page.getByText('TEST Poster', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('TEST Second poster')).toHaveCount(0);
  expect(refused.filter((r) => !r.includes('merchantCatalog.products.create'))).toEqual([]);
});

test(`${J} #3 a one-time TEST 20 USDC price is the default until the monthly one is set as default`, async ({ page }) => {
  test.setTimeout(180_000);
  const state = journey();
  if (!state.productUrl) throw new Error(`${J} #2 made no product, so this step has none to price`);
  await signInOwner(page, state, state.productUrl);
  const refused = refusedPayCalls(page);
  const prices = page.getByRole('region', { name: 'Prices of this product' });
  const row = (text) => prices.getByRole('row').filter({ hasText: text });

  async function addPrice({ billing, amount, chosen }) {
    await page.getByRole('button', { name: 'Add price' }).click();
    await page.getByLabel('Billing *').selectOption({ label: billing });
    if (chosen) {
      await page.getByLabel('How the amount is set *').selectOption({ label: 'The customer chooses' });
      await page.getByLabel('Minimum *').fill(chosen.min);
      await page.getByLabel('Maximum *').fill(chosen.max);
    } else await page.getByLabel('Amount *').fill(amount);
    await page.getByLabel('Asset *').fill('USDC');
    await page.getByRole('button', { name: 'Save price' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Price added.' })).toBeVisible();
  }

  // The first price is the default; a second one is not, until Set as default is pressed on it.
  await addPrice({ billing: 'One time', amount: '20' });
  const once = row('20.00 USDC').filter({ hasText: 'One time' });
  await expect(once.getByText('Default', { exact: true })).toBeVisible();
  await addPrice({ billing: 'Monthly', amount: '5' });
  const monthly = row('5.00 USDC').filter({ hasText: 'Monthly' });
  await expect(monthly.getByRole('button', { name: 'Set as default' })).toBeVisible();
  await expect(once.getByText('Default', { exact: true })).toBeVisible();
  await monthly.getByRole('button', { name: 'Set as default' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'The default price changed.' })).toBeVisible();
  await expect(monthly.getByText('Default', { exact: true })).toBeVisible();
  await expect(once.getByRole('button', { name: 'Set as default' })).toBeVisible();

  // A customer-chosen amount below its minimum is refused, and one inside the range is taken.
  await addPrice({ billing: 'One time', chosen: { min: '5', max: '100' } });
  await expect(row('Customer chooses')).toHaveCount(1);
  const check = page.getByRole('group', { name: "Try a customer's amount" });
  await check.getByLabel('Amount the customer enters').fill('2');
  await check.getByRole('button', { name: 'Check amount' }).click();
  await expect(check.getByRole('alert')).toHaveText('This amount is below the minimum for this price.');
  await check.getByLabel('Amount the customer enters').fill('10');
  await check.getByRole('button', { name: 'Check amount' }).click();
  await expect(check.getByRole('status')).toContainText('A customer can pay 10');
  expect(refused.filter((r) => !r.includes('merchantCatalog.prices.quote'))).toEqual([]);
});

// Steps 4 to 6 come with their slices (M-adv-payments-core-20 and -21, the import). Until then each fails at its first
// check, quickly.
const unbuilt = { timeout: 5000 };

test(`${J} #4 replacing a price a subscription uses keeps the subscription on the old one, and archiving keeps old documents readable`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const state = journey();
  if (!state.productUrl) throw new Error(`${J} #2 made no product, so this step has none to change`);
  await signInOwner(page, state, state.productUrl);
  await page.getByRole('button', { name: 'Replace price' }).first().click(unbuilt);
  await page.getByRole('button', { name: 'Archive product' }).click(unbuilt);
});

test(`${J} #5 an import dry run lists line-numbered errors and writes nothing, and a commit writes once`, async ({ page }) => {
  test.setTimeout(120_000);
  const state = journey();
  await signInOwner(page, state, '/pay/products');
  await page.getByRole('link', { name: 'Import products' }).click(unbuilt);
  await expect(page).toHaveURL(/\/pay\/products\/import$/, unbuilt);
});

test(`${J} #6 copying the catalogue between test and live reports created and skipped ids, and a second run makes no duplicates`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const state = journey();
  await signInOwner(page, state, '/pay/products');
  await page.getByRole('button', { name: 'Copy to live' }).click(unbuilt);
});
