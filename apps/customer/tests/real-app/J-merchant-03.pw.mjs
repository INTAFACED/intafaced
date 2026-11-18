// World: stack
import path from 'node:path';
import { test, expect } from './journey.mjs';
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
  await page.getByRole('button', { name: 'Invite by account ID instead', exact: true }).click();
  await page.getByLabel('Account ID *', { exact: true }).fill(who.userId);
  await page.getByRole('combobox', { name: /^Role \*/ }).selectOption({ label: role });
  await page.getByRole('button', { name: 'Send invitation', exact: true }).click();
  await page.getByRole('dialog').locator('[data-testid="form-stack"] > button').last().click();
  await expect(
    page
      .getByRole('row')
      .filter({ hasText: role })
      .filter({ hasText: /Invited/ }),
  ).toHaveCount(1);
  await forgetSession(page);
  await signInWithCode(page, who, '/pay/team');
  const accept = page.locator('li').filter({ hasText: role }).getByRole('button', { name: 'Accept', exact: true }).first();
  await expect(async () => {
    await page.reload();
    await expect(accept).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 30_000 });
  await accept.click();
  await page.getByRole('dialog').locator('[data-testid="form-stack"] > button').last().click();
  await expect(accept).toHaveCount(0);
}

test(`${J} #1 Products opens empty with Add product, and finance and viewers see no write control anywhere in the products room`, async ({
  page,
  browser,
}) => {
  test.setTimeout(720_000);
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
  await expect(page.getByRole('heading', { name: 'No products yet', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Add product', exact: true })).toHaveAttribute('href', '/pay/products/new');
  expect(refused).toEqual([]);
  await forgetSession(page);
  run.write({ owner: saved(own) });

  for (const member of [finance, viewer]) {
    await signInWithCode(page, member, '/pay/products');
    const theirs = refusedPayCalls(page);
    await expect(page.getByRole('heading', { name: 'No products yet', exact: true })).toBeVisible();
    await expect(page.getByText('The owner, an admin or a developer can add them.', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Add product', exact: true })).toHaveCount(0);
    await page.goto('/pay/products/new');
    await expect(page.getByRole('button', { name: 'Save product', exact: true })).toHaveCount(0);
    expect(theirs).toEqual([]);
    await forgetSession(page);
  }

  // Every other write control of the room needs a product to show on. The owner makes one with two one-time TEST
  // prices and sees each control there: Archive, Delete, Add price, Set as default and Replace price.
  await signInWithCode(page, own, '/pay/products/new');
  run.write({ owner: saved(own) });
  const ownRefused = refusedPayCalls(page);
  await page.getByLabel('Name *', { exact: true }).fill('TEST Read-only check');
  await page.getByLabel('Product ID', { exact: true }).fill(`readonly-${own.handle}`);
  await page.getByRole('button', { name: 'Save product', exact: true }).click();
  await expect(page).toHaveURL(/\/pay\/products\/[0-9a-f-]{36}$/);
  const productUrl = new URL(page.url()).pathname;
  for (const amount of ['1', '2']) {
    await page.getByRole('button', { name: 'Add price', exact: true }).click();
    await page.getByLabel('Billing *', { exact: true }).selectOption({ label: 'One time' });
    await page.getByLabel('Amount *', { exact: true }).fill(amount);
    await page.getByLabel('Asset *', { exact: true }).fill('USDC');
    await page.getByRole('button', { name: 'Save price', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Price added.' })).toBeVisible();
  }
  const ownerPrices = page.getByRole('region', { name: 'Prices of this product', exact: true });
  await expect(
    ownerPrices.getByRole('row').filter({ hasText: '2.00 USDC' }).getByRole('button', { name: 'Set as default', exact: true }),
  ).toBeVisible();
  await expect(ownerPrices.getByRole('button', { name: 'Replace price', exact: true })).toHaveCount(2);
  for (const name of ['Archive product', 'Delete product', 'Add price'])
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  await page.goto('/pay/products');
  for (const name of ['Add product', 'Import products']) await expect(page.getByRole('link', { name })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy to test', exact: true })).toBeVisible();
  expect(ownRefused).toEqual([]);

  /** Every write control the products room draws for a writer is absent here, or switched off, in both catalogues. */
  async function noWriteControls(their) {
    for (const mode of ['live', 'test']) {
      await their.goto(mode === 'live' ? '/pay/products' : '/pay/products?mode=test');
      await expect(their.getByLabel('Catalogue', { exact: true })).toHaveValue(mode);
      if (mode === 'live')
        await expect(
          their.getByRole('region', { name: 'Your products', exact: true }).getByText('TEST Read-only check', { exact: true }),
        ).toBeVisible();
      else await expect(their.getByRole('heading', { name: 'No products yet', exact: true })).toBeVisible();
      for (const name of ['Add product', 'Import products']) await expect(their.getByRole('link', { name })).toHaveCount(0);
      for (const name of ['Copy to live', 'Copy to test']) await expect(their.getByRole('button', { name })).toHaveCount(0);
    }
    await their.goto('/pay/products/new');
    await expect(their.getByText('The owner, an admin or a developer can add them.', { exact: true })).toBeVisible();
    await expect(their.getByLabel('Name *', { exact: true })).toHaveCount(0);
    await expect(their.getByRole('button', { name: 'Save product', exact: true })).toHaveCount(0);
    await their.goto('/pay/products/import');
    await expect(their.getByText('The owner, an admin or a developer can add them.', { exact: true })).toBeVisible();
    await expect(their.getByLabel('Products file (CSV)', { exact: true })).toHaveCount(0);
    await expect(their.getByRole('button', { name: 'Check file', exact: true })).toHaveCount(0);
    await expect(their.getByRole('button', { name: /^Import \d/ })).toHaveCount(0);
    await their.goto(productUrl);
    await expect(their.locator('dl[data-testid="pp-facts"]')).toContainText('TEST Read-only check');
    const theirPrices = their.getByRole('region', { name: 'Prices of this product', exact: true });
    await expect(theirPrices.getByRole('row').filter({ hasText: '2.00 USDC' })).toHaveCount(1);
    await expect(theirPrices.getByRole('row').filter({ hasText: '1.00 USDC' })).toHaveCount(1);
    for (const name of [
      'Archive product',
      'Unarchive product',
      'Delete product',
      'Add price',
      'Set as default',
      'Replace price',
      'Save price',
    ])
      await expect(their.getByRole('button', { name, exact: true })).toHaveCount(0);
    await expect(their.getByRole('link', { name: 'Add a store', exact: true })).toHaveCount(0);
    for (const box of await their.getByRole('checkbox').all()) await expect(box).toBeDisabled();
  }

  // Finance and the viewer each keep their own browser, so the same pages can be read again after the owner archives.
  const members = [];
  try {
    for (const member of [finance, viewer]) {
      const context = await browser.newContext();
      const their = await context.newPage();
      members.push({ context, their, refused: refusedPayCalls(their) });
      await signInWithCode(their, member, '/pay/products');
      await noWriteControls(their);
    }

    // Archived, the product offers a writer Unarchive; finance and the viewer still get no control. Archiving also
    // leaves the live catalogue with no active product, as the later steps expect of it.
    await page.goto(productUrl);
    await page.getByRole('button', { name: 'Archive product', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Product archived.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Unarchive product', exact: true })).toBeVisible();
    for (const { their, refused: theirs } of members) {
      await their.goto(productUrl);
      await expect(their.getByText('This product is archived.', { exact: false })).toBeVisible();
      for (const name of ['Archive product', 'Unarchive product', 'Delete product', 'Add price', 'Set as default', 'Replace price'])
        await expect(their.getByRole('button', { name, exact: true })).toHaveCount(0);
      expect(theirs).toEqual([]);
    }
  } finally {
    for (const { context } of members) await context.close();
  }
  expect(ownRefused).toEqual([]);
  await forgetSession(page);
});

test(`${J} #2 the owner adds a product with type, unit label, descriptor and image, and a taken id is refused`, async ({ page }) => {
  test.setTimeout(240_000);
  const state = journey();
  const own = await signInOwner(page, state, '/pay/products/new');
  const refused = refusedPayCalls(page);
  const save = page.getByRole('button', { name: 'Save product', exact: true });
  await expect(save).toBeDisabled();

  // An event asks for its start time and place; a digital product does not.
  const type = page.getByLabel('Type *', { exact: true });
  await type.selectOption({ label: 'Event' });
  await expect(page.getByLabel('Start time *', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Location *', { exact: true })).toBeVisible();
  await type.selectOption({ label: 'Digital product' });
  await expect(page.getByLabel('Start time *', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Location *', { exact: true })).toHaveCount(0);
  await type.selectOption({ label: 'Physical good' });

  // The image rule is the owner's (a TEST 500 KB on this stack): a 3 MB file and a GIF are refused with it.
  const image = page.getByLabel('Image', { exact: true });
  const big = Buffer.concat([PNG, Buffer.alloc(3_000_000 - PNG.length, 0)]);
  await image.setInputFiles({ name: 'TEST-big.png', mimeType: 'image/png', buffer: big });
  await expect(page.getByText('This file is 3 MB. Images can be up to 500 KB, as PNG, JPEG or WebP.', { exact: true })).toBeVisible();
  await image.setInputFiles({ name: 'TEST.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a TEST', 'latin1') });
  await expect(page.getByText('This file is not a PNG, JPEG or WebP image.', { exact: false })).toBeVisible();
  await image.setInputFiles({ name: 'TEST.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByRole('status').filter({ hasText: 'Image added.' })).toBeVisible();

  const id = `poster-${own.handle}`;
  await page.getByLabel('Name *', { exact: true }).fill('TEST Poster');
  await expect(save).toBeEnabled();
  await page.getByLabel('Unit label', { exact: true }).fill('print');
  await page.getByLabel('Statement descriptor', { exact: true }).fill('TEST POSTERS');
  await page.getByLabel('Product ID', { exact: true }).fill(id);
  await save.click();
  await expect(page).toHaveURL(/\/pay\/products\/[0-9a-f-]{36}$/);
  const facts = page.locator('dl[data-testid="pp-facts"]');
  await expect(facts).toContainText('TEST Poster');
  await expect(facts).toContainText('Physical good');
  await expect(facts).toContainText(id);
  await expect(facts).toContainText('print');
  await expect(facts).toContainText('TEST POSTERS');
  await expect(page.getByRole('img', { name: 'Picture of TEST Poster', exact: true })).toBeVisible();
  run.write({ productUrl: new URL(page.url()).pathname });

  // The same chosen id again is refused as taken, and nothing new is listed.
  await page.goto('/pay/products/new');
  await page.getByLabel('Name *', { exact: true }).fill('TEST Second poster');
  await page.getByLabel('Product ID', { exact: true }).fill(id);
  await save.click();
  await expect(page.getByText('Another product already uses this product ID.', { exact: false })).toBeVisible();
  await page.goto('/pay/products');
  await expect(page.getByRole('link', { name: 'Add product', exact: true })).toBeVisible();
  await expect(page.getByText('TEST Poster', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('TEST Second poster', { exact: true })).toHaveCount(0);
  expect(refused.filter((r) => !r.includes('merchantCatalog.products.create'))).toEqual([]);
});

test(`${J} #3 a one-time TEST 20 USDC price is the default until the monthly one is set as default`, async ({ page }) => {
  test.setTimeout(180_000);
  const state = journey();
  if (!state.productUrl) throw new Error(`${J} #2 made no product, so this step has none to price`);
  await signInOwner(page, state, state.productUrl);
  const refused = refusedPayCalls(page);
  const prices = page.getByRole('region', { name: 'Prices of this product', exact: true });
  const row = (text) => prices.getByRole('row').filter({ hasText: text });

  async function addPrice({ billing, amount, chosen }) {
    await page.getByRole('button', { name: 'Add price', exact: true }).click();
    await page.getByLabel('Billing *', { exact: true }).selectOption({ label: billing });
    if (chosen) {
      await page.getByLabel('How the amount is set *', { exact: true }).selectOption({ label: 'The customer chooses' });
      await page.getByLabel('Minimum *', { exact: true }).fill(chosen.min);
      await page.getByLabel('Maximum *', { exact: true }).fill(chosen.max);
    } else await page.getByLabel('Amount *', { exact: true }).fill(amount);
    await page.getByLabel('Asset *', { exact: true }).fill('USDC');
    await page.getByRole('button', { name: 'Save price', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Price added.' })).toBeVisible();
  }

  // The first price is the default; a second one is not, until Set as default is pressed on it.
  await addPrice({ billing: 'One time', amount: '20' });
  const once = row('20.00 USDC').filter({ hasText: 'One time' });
  await expect(once.getByText('Default', { exact: true })).toBeVisible();
  await addPrice({ billing: 'Monthly', amount: '5' });
  const monthly = row('5.00 USDC').filter({ hasText: 'Monthly' });
  await expect(monthly.getByRole('button', { name: 'Set as default', exact: true })).toBeVisible();
  await expect(once.getByText('Default', { exact: true })).toBeVisible();
  await monthly.getByRole('button', { name: 'Set as default', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'The default price changed.' })).toBeVisible();
  await expect(monthly.getByText('Default', { exact: true })).toBeVisible();
  await expect(once.getByRole('button', { name: 'Set as default', exact: true })).toBeVisible();

  // A customer-chosen amount below its minimum is refused, and one inside the range is taken.
  await addPrice({ billing: 'One time', chosen: { min: '5', max: '100' } });
  await expect(row('Customer chooses')).toHaveCount(1);
  const check = page.getByRole('group', { name: "Try a customer's amount", exact: true });
  await check.getByLabel('Amount the customer enters', { exact: true }).fill('2');
  await check.getByRole('button', { name: 'Check amount', exact: true }).click();
  await expect(check.getByRole('alert')).toHaveText('This amount is below the minimum for this price.');
  await check.getByLabel('Amount the customer enters', { exact: true }).fill('10');
  await check.getByRole('button', { name: 'Check amount', exact: true }).click();
  await expect(check.getByRole('status')).toContainText('A customer can pay 10');
  expect(refused.filter((r) => !r.includes('merchantCatalog.prices.quote'))).toEqual([]);
});

/** A mandate the owner records for a TEST customer: what a subscription charges, monthly, from next month. */
async function recordMandate(page, customerId, amount) {
  await page.getByRole('button', { name: 'New mandate', exact: true }).click();
  await page.getByLabel('Authorized customer ID', { exact: true }).fill(customerId);
  await page.getByLabel('Authorized amount', { exact: true }).fill(amount);
  await page.getByLabel('Cadence', { exact: true }).selectOption('monthly');
  const starts = new Date(Date.now() + 30 * 86_400_000);
  const local = new Date(starts.getTime() - starts.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  await page.getByLabel('Authorization starts', { exact: true }).fill(local);
  const recorded = page.waitForResponse((r) => r.url().includes('mandate.create') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Record mandate', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Record mandate', exact: true }).click();
  expect((await recorded).ok()).toBe(true);
}

/** Choose the mandate of `customerId` in the subscription form; its option names the customer first. */
async function chooseMandate(page, customerId) {
  const select = page.getByLabel('Active customer mandate *', { exact: true });
  await expect(select.locator('option', { hasText: customerId })).toHaveCount(1);
  const value = await select.locator('option', { hasText: customerId }).getAttribute('value');
  await select.selectOption(value);
}

test(`${J} #4 replacing a price a subscription uses keeps the subscription on the old one, and archiving keeps old documents readable`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const state = journey();
  if (!state.productUrl) throw new Error(`${J} #2 made no product, so this step has none to change`);
  await signInOwner(page, state, state.productUrl);
  const refused = refusedPayCalls(page);
  const prices = page.getByRole('region', { name: 'Prices of this product', exact: true });
  const row = (text) => prices.getByRole('row').filter({ hasText: text });

  // A monthly TEST 5 USDT price, and a subscription started on it from a 5 USDT monthly mandate.
  await page.getByRole('button', { name: 'Add price', exact: true }).click();
  await page.getByLabel('Billing *', { exact: true }).selectOption({ label: 'Monthly' });
  await page.getByLabel('Amount *', { exact: true }).fill('5');
  await page.getByLabel('Asset *', { exact: true }).fill('USDT');
  await page.getByRole('button', { name: 'Save price', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Price added.' })).toBeVisible();
  await expect(row('5.00 USDT')).toHaveCount(1);

  const customer = `TEST-customer-${state.owner.handle}`;
  await page.goto('/pay/subscriptions/new');
  await recordMandate(page, customer, '5');
  await chooseMandate(page, customer);
  await page.getByLabel('Supported charge path *', { exact: true }).selectOption({ label: 'Crypto invoice and watch' });
  const pick = page.getByLabel('Price from your catalogue', { exact: true });
  await expect(pick.locator('option', { hasText: 'TEST Poster · 5.00 USDT monthly' })).toHaveCount(1);
  // A 5 USDC price is not offered to a USDT mandate, and a one-time price never is.
  await expect(pick.locator('option', { hasText: 'USDC' })).toHaveCount(0);
  await pick.selectOption({ label: 'TEST Poster · 5.00 USDT monthly' });
  const created = page.waitForResponse((r) => r.url().includes('subscription.create') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create subscription', exact: true }).click();
  const review = page.getByRole('dialog');
  await expect(review.getByText('TEST Poster · 5.00 USDT monthly', { exact: true })).toBeVisible();
  await review.getByRole('button', { name: 'Create subscription', exact: true }).click();
  expect((await created).ok()).toBe(true);
  await page.getByRole('link', { name: 'Open the new subscription', exact: true }).click();
  await expect(page).toHaveURL(/\/pay\/subscriptions\/[0-9a-f-]{36}$/);
  const subscriptionUrl = new URL(page.url()).pathname;
  run.write({ subscriptionUrl });
  await expect(page.getByRole('link', { name: 'TEST Poster · 5.00 USDT monthly', exact: true })).toBeVisible();

  // Replace price says what uses the old price first; the new one takes its place and the subscription stays.
  await page.goto(state.productUrl);
  await row('5.00 USDT').getByRole('button', { name: 'Replace price', exact: true }).click();
  const replace = page.getByRole('group', { name: 'Replace 5.00 USDT', exact: true });
  await expect(replace.getByRole('status')).toHaveText('1 subscription uses this price. It stays on this price.');
  await replace.getByLabel('Amount *', { exact: true }).fill('6');
  await replace.getByRole('button', { name: 'Save replacement', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Price replaced.' })).toBeVisible();
  await expect(row('6.00 USDT').filter({ hasText: 'Active' })).toHaveCount(1);
  await expect(row('5.00 USDT').filter({ hasText: 'Archived' })).toHaveCount(1);
  await expect(row('5.00 USDT').getByRole('button', { name: 'Replace price', exact: true })).toHaveCount(0);
  await page.goto(subscriptionUrl);
  await expect(page.getByRole('link', { name: 'TEST Poster · 5.00 USDT monthly (archived)', exact: true })).toBeVisible();

  // A product with prices cannot be deleted; it is archived instead, and leaves the list and the price picker.
  await page.goto(state.productUrl);
  await page.getByRole('button', { name: 'Delete product', exact: true }).click();
  await page
    .getByRole('group', { name: 'Delete product', exact: true })
    .getByRole('button', { name: 'Delete product', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('This product has prices, so it cannot be deleted.');
  await page.getByRole('button', { name: 'Archive product', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Product archived.' })).toBeVisible();
  await expect(page.getByText('This product is archived.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add price', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Replace price', exact: true })).toHaveCount(0);

  await page.goto('/pay/products');
  await expect(page.getByRole('heading', { name: 'No active products', exact: true })).toBeVisible();
  await page.getByLabel('Show', { exact: true }).selectOption({ label: 'Archived products' });
  await expect(
    page.getByRole('region', { name: 'Your products', exact: true }).getByText('TEST Poster', { exact: true }).first(),
  ).toBeVisible();

  const second = `TEST-customer-2-${state.owner.handle}`;
  await page.goto('/pay/subscriptions/new');
  await recordMandate(page, second, '6');
  await chooseMandate(page, second);
  await expect(
    page.getByText('No active monthly price in your catalogue has this mandate’s amount and asset.', { exact: true }),
  ).toBeVisible();

  // The subscription still reads the price and product it was sold on.
  await page.goto(subscriptionUrl);
  await expect(page.getByRole('link', { name: 'TEST Poster · 5.00 USDT monthly (archived, product archived)', exact: true })).toBeVisible();

  // A product without prices can be deleted.
  await page.goto('/pay/products/new');
  await page.getByLabel('Name *', { exact: true }).fill('TEST Draft');
  await page.getByRole('button', { name: 'Save product', exact: true }).click();
  await expect(page).toHaveURL(/\/pay\/products\/[0-9a-f-]{36}$/);
  await page.getByRole('button', { name: 'Delete product', exact: true }).click();
  await page
    .getByRole('group', { name: 'Delete product', exact: true })
    .getByRole('button', { name: 'Delete product', exact: true })
    .click();
  await expect(page).toHaveURL(/\/pay\/products$/);
  await expect(page.getByText('TEST Draft', { exact: true })).toHaveCount(0);
  expect(refused.filter((r) => !r.includes('merchantCatalog.products.delete'))).toEqual([]);
});

test(`${J} #5 an import dry run lists line-numbered errors and writes nothing, and a commit writes once`, async ({ page }) => {
  test.setTimeout(180_000);
  const state = journey();
  const own = await signInOwner(page, state, '/pay/products');
  const refused = refusedPayCalls(page);
  await page.getByRole('link', { name: 'Import products', exact: true }).click();
  await expect(page).toHaveURL(/\/pay\/products\/import$/);
  const file = page.getByLabel('Products file (CSV)', { exact: true });
  const csv = (lines) => ({ name: 'TEST-products.csv', mimeType: 'text/csv', buffer: Buffer.from(`${lines.join('\n')}\n`) });

  // A file with three bad lines: each is named by its line, and nothing is written.
  const mug = `mug-${own.handle}`;
  await file.setInputFiles(
    csv([
      'name,type,product_id,unit_label',
      `TEST Mug,physical,${mug},mug`,
      'TEST Toy,toy,,',
      `TEST Poster again,physical,poster-${own.handle},`,
      ',digital,,',
    ]),
  );
  await page.getByRole('button', { name: 'Check file', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '3 problems found. Nothing was written.' })).toBeVisible();
  const problems = page.getByRole('region', { name: 'Problems in the file', exact: true }).getByRole('row');
  await expect(problems).toHaveCount(4);
  await expect(problems.nth(1)).toContainText('3');
  await expect(problems.nth(1)).toContainText('type');
  await expect(problems.nth(1)).toContainText('This value is not one this column allows.');
  await expect(problems.nth(2)).toContainText('4');
  await expect(problems.nth(2)).toContainText('A product in your catalogue already has this ID.');
  await expect(problems.nth(3)).toContainText('5');
  await expect(problems.nth(3)).toContainText('This cell is required.');
  await expect(page.getByRole('button', { name: /^Import \d/ })).toHaveCount(0);
  await page.goto('/pay/products');
  await expect(page.getByText('No active products', { exact: true })).toBeVisible();

  // The fixed file is checked clean, then imported once.
  const good = csv([
    'name,type,product_id,unit_label,event_starts_at,event_location',
    `TEST Mug,physical,${mug},mug,,`,
    'TEST Workshop,event,,,2026-12-01T19:00:00Z,"TEST Hall, Room 2"',
    'TEST Guide,digital,,,,',
  ]);
  await page.goto('/pay/products/import');
  await file.setInputFiles(good);
  await page.getByRole('button', { name: 'Check file', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '3 products are ready to import. Nothing has been written yet.' })).toBeVisible();
  await page.getByRole('button', { name: 'Import 3 products', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Imported 3 products.' })).toBeVisible();
  const made = page.getByRole('region', { name: 'Products from this file', exact: true });
  for (const name of ['TEST Mug', 'TEST Workshop', 'TEST Guide']) await expect(made.getByText(name, { exact: true })).toBeVisible();
  await expect(made).toContainText(mug);

  // The same file again is a replay: it says when it was imported, offers no import, and makes nothing.
  await page.goto('/pay/products/import');
  await file.setInputFiles(good);
  await page.getByRole('button', { name: 'Check file', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'This file was already imported, so nothing new was made.' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Import \d/ })).toHaveCount(0);
  await page.goto('/pay/products');
  const list = page.getByRole('region', { name: 'Your products', exact: true });
  await expect(list.getByText('TEST Mug', { exact: true })).toHaveCount(1);
  await expect(list.getByText('TEST Workshop', { exact: true })).toHaveCount(1);
  await expect(list.getByText('TEST Guide', { exact: true })).toHaveCount(1);
  expect(refused).toEqual([]);
});

test(`${J} #6 copying the catalogue between test and live makes no duplicates, and an item not sold in a store refuses there`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const state = journey();
  const own = await signInOwner(page, state, '/pay/products');
  const refused = refusedPayCalls(page);

  // The test catalogue is its own: empty while live holds step 5's products.
  await page.getByLabel('Catalogue', { exact: true }).selectOption({ label: 'Test catalogue' });
  await expect(page).toHaveURL(/\/pay\/products\?mode=test$/);
  await expect(page.getByText('No products yet', { exact: true })).toBeVisible();

  // Two test products by import: one with the id step 5 gave a live mug, one new.
  await page.getByRole('link', { name: 'Import products', exact: true }).click();
  await expect(page).toHaveURL(/\/pay\/products\/import\?mode=test$/);
  await expect(page.getByRole('note').filter({ hasText: 'These products join your test catalogue.' })).toBeVisible();
  const lines = ['name,type,product_id', `TEST Sample mug,physical,mug-${own.handle}`, `TEST Sample guide,digital,guide-${own.handle}`];
  await page
    .getByLabel('Products file (CSV)', { exact: true })
    .setInputFiles({ name: 'TEST-test-products.csv', mimeType: 'text/csv', buffer: Buffer.from(`${lines.join('\n')}\n`) });
  await page.getByRole('button', { name: 'Check file', exact: true }).click();
  await page.getByRole('button', { name: 'Import 2 products', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Imported 2 products.' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to products', exact: true }).click();
  await expect(page).toHaveURL(/\/pay\/products\?mode=test$/);
  const testList = page.getByRole('region', { name: 'Your products', exact: true });
  await expect(testList.getByText('TEST Sample mug', { exact: true })).toBeVisible();
  await expect(testList.getByText('TEST Sample guide', { exact: true })).toBeVisible();

  // Copy to live: the guide is made, the mug is skipped because live already uses its id.
  const copy = async () => {
    await page.getByRole('button', { name: 'Copy to live', exact: true }).click();
    await page.getByRole('group', { name: 'Copy to live', exact: true }).getByRole('button', { name: 'Copy to live', exact: true }).click();
  };
  await copy();
  await expect(page.getByRole('status').filter({ hasText: '1 copied to the live catalogue, 1 skipped.' })).toBeVisible();
  const created = page.getByRole('region', { name: 'Copied', exact: true });
  await expect(created.getByText('TEST Sample guide', { exact: true })).toBeVisible();
  await expect(created).toContainText(`guide-${own.handle}`);
  const skipped = page.getByRole('region', { name: 'Skipped', exact: true });
  await expect(skipped.getByRole('row').filter({ hasText: 'TEST Sample mug' })).toContainText(
    'A product in the live catalogue already has this product ID.',
  );

  // A second copy makes nothing: both are reported as skipped, the guide as copied before.
  await copy();
  await expect(page.getByRole('status').filter({ hasText: '0 copied to the live catalogue, 2 skipped.' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Copied', exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('region', { name: 'Skipped', exact: true }).getByRole('row').filter({ hasText: 'TEST Sample guide' }),
  ).toContainText('Already in the live catalogue: copied before.');

  // Live holds the guide once, and its page says where it came from.
  await page.getByLabel('Catalogue', { exact: true }).selectOption({ label: 'Live catalogue' });
  const liveList = page.getByRole('region', { name: 'Your products', exact: true });
  await expect(liveList.getByText('TEST Sample guide', { exact: true })).toHaveCount(1);
  await expect(liveList.getByText('TEST Sample mug', { exact: true })).toHaveCount(0);
  await liveList.getByRole('row').filter({ hasText: 'TEST Sample guide' }).getByRole('link').last().click();
  const facts = page.locator('dl[data-testid="pp-facts"]');
  await expect(facts).toContainText('Live catalogue');
  await expect(facts.getByRole('link', { name: 'Its product in the test catalogue', exact: true })).toBeVisible();
  const guideUrl = page.url();

  // Channel availability: a store, then the guide turned off for in-person sales there.
  await page.goto('/pay/settings/stores');
  await expect(page.getByRole('heading', { name: 'Stores', exact: true })).toBeVisible();
  await expect(page.getByText('No stores yet', { exact: true })).toBeVisible();
  await page.getByLabel('Store name', { exact: true }).fill('TEST Market stall');
  await page.getByLabel('Address (optional)', { exact: true }).fill('TEST 1 Market Square');
  await page.getByLabel('Time zone', { exact: true }).fill('Europe/Berlin');
  await page.getByRole('button', { name: 'Add store', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'TEST Market stall was added.' })).toBeVisible();
  const stores = page.getByRole('region', { name: 'Your stores', exact: true });
  await expect(stores.getByRole('row').filter({ hasText: 'TEST Market stall' })).toContainText('Europe/Berlin');

  await page.goto(guideUrl);
  await page.getByRole('button', { name: 'Add price', exact: true }).click();
  await page.getByLabel('Billing *', { exact: true }).selectOption({ label: 'One time' });
  await page.getByLabel('Amount *', { exact: true }).fill('12');
  await page.getByLabel('Asset *', { exact: true }).fill('USDC');
  await page.getByRole('button', { name: 'Save price', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Price added.' })).toBeVisible();

  const where = page.getByRole('region', { name: 'Where this product is sold', exact: true });
  const inPerson = where.getByRole('checkbox', { name: 'In person at TEST Market stall', exact: true });
  await expect(inPerson).toBeChecked();
  await expect(where.getByRole('checkbox', { name: 'Online at TEST Market stall', exact: true })).toBeChecked();
  await inPerson.uncheck();
  await expect(page.getByRole('status').filter({ hasText: 'In person at TEST Market stall: not sold.' })).toBeVisible();
  await expect(inPerson).not.toBeChecked();

  // A sale in person there is refused; online in the same store it is sold.
  const sale = page.getByRole('group', { name: 'Check a sale', exact: true });
  await sale.getByLabel('Store', { exact: true }).selectOption({ label: 'TEST Market stall' });
  await sale.getByLabel('Channel', { exact: true }).selectOption({ label: 'In person' });
  await sale.getByRole('button', { name: 'Check sale', exact: true }).click();
  await expect(sale.getByRole('alert')).toHaveText('This product is not sold in this store through this channel.');
  await sale.getByLabel('Channel', { exact: true }).selectOption({ label: 'Online' });
  await sale.getByRole('button', { name: 'Check sale', exact: true }).click();
  await expect(sale.getByRole('status')).toContainText('Sold here for 12');

  // It stays off after a reload: the service keeps it, not the page.
  await page.reload();
  await expect(
    page
      .getByRole('region', { name: 'Where this product is sold', exact: true })
      .getByRole('checkbox', { name: 'In person at TEST Market stall', exact: true }),
  ).not.toBeChecked();
  expect(refused.filter((r) => !r.includes('merchantCatalog.prices.quote'))).toEqual([]);
});
