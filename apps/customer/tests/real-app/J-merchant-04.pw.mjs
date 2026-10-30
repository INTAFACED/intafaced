import path from 'node:path';
import { test, expect } from '@playwright/test';
import { ROOT, journeyState, tool } from './stack.mjs';
import { forgetSession } from './identity-factors.mjs';
import { businessReadyPerson, openBusiness, refusedPayCalls, signInWithCode, verifiedBusiness } from './merchant.mjs';

// J-merchant-04, in the running app (docs/roadmap/journeys.json): share a payment link and get paid at hosted checkout.
// One test per step, titled "J-merchant-04 #<n>", run in order on one verified TEST business. #1 makes the owner and
// the business; the later steps sign the owner in again. The payer opens the link in a browser with no INTAFACED session.
const J = 'J-merchant-04';
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
/** A PNG of 120 000 bytes (the stack publishes a 100 KB logo limit). TEST bytes. */
const BIG_PNG = Buffer.concat([PNG, Buffer.alloc(120_000 - PNG.length)]);

/** The owner makes a fixed-amount link from the form and reads its checkout address from the receipt. */
async function makeLink(page, label, amount, asset) {
  await page.goto('/pay/links/new');
  await page.getByLabel('Link label *').fill(label);
  await page.getByLabel('Fixed amount', { exact: true }).fill(amount);
  await page.getByRole('combobox', { name: /^Asset/ }).selectOption(asset);
  await page.getByRole('button', { name: 'Create link' }).click();
  await page.getByRole('dialog').locator('[data-testid="form-stack"] > button').last().click();
  await expect(page.getByRole('heading', { name: 'Your link is ready' })).toBeVisible();
  return page.getByTestId('link-address').getByRole('link', { name: 'Open the link' }).getAttribute('href');
}

test(`${J} #1 the owner sets up hosted checkout once: defaults with Save, an oversized logo refused, logo and colour on the payer page`, async ({
  page,
  browser,
}) => {
  test.setTimeout(420_000);
  run.reset({});
  const own = await businessReadyPerson(page, 'm4o', '/pay/onboarding');
  const merchantId = await openBusiness(page, own, 'TEST Checkout Ltd');
  await verifiedBusiness(page, own, merchantId);
  await forgetSession(page);
  run.write({ owner: saved(own), merchantId });

  const owner = await signInOwner(page, journey(), '/pay/checkout');
  const refused = refusedPayCalls(page);
  const look = page
    .locator('section[data-testid="pay-section"]')
    .filter({ has: page.getByRole('heading', { name: 'How your checkout looks' }) });
  // Not configured: the default look, with Save.
  await expect(look.getByTestId('checkout-look-state')).toHaveText(/You are using the default look/);
  await expect(look.getByLabel('Brand colour *')).toHaveValue('#1a5fd0');
  await expect(look.getByRole('button', { name: 'Save look' })).toBeEnabled();
  await expect(look.getByText('PNG, JPEG or WebP, up to 100 KB.')).toBeVisible();

  // A logo over the published size is refused with the limits, and nothing is sent.
  await look.getByLabel('Logo').setInputFiles({ name: 'big-logo.png', mimeType: 'image/png', buffer: BIG_PNG });
  await expect(look.getByRole('alert')).toHaveText('This logo is 120 KB. A logo can be up to 100 KB, as PNG, JPEG or WebP.');
  await expect(look.getByRole('img', { name: 'Your logo' })).toHaveCount(0);

  // A valid logo and colour show in the preview, then are saved.
  await look.getByLabel('Logo').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG });
  await look.getByLabel('Brand colour *').fill('#FF6600');
  const preview = look.getByRole('figure', { name: 'Checkout preview' });
  await expect(preview.getByRole('img', { name: 'Your logo' })).toBeVisible();
  await expect(preview.getByTestId('checkout-look-button')).toHaveCSS('background-color', 'rgb(255, 102, 0)');
  const savedLook = page.waitForResponse((r) => r.url().includes('merchantCheckout.branding.save') && r.request().method() === 'POST');
  await look.getByRole('button', { name: 'Save look' }).click();
  expect((await savedLook).status()).toBe(200);
  await expect(look.getByText('Saved. Your payment links now show this look.')).toBeVisible();
  await expect(look.getByTestId('checkout-look-state')).toHaveText(/Last saved:/);
  await expect(look.getByLabel('Brand colour *')).toHaveValue('#ff6600');
  await expect(preview.getByRole('img', { name: 'Your logo' })).toBeVisible();
  // Saved means kept: a fresh read shows it.
  await page.reload();
  await expect(look.getByTestId('checkout-look-state')).toHaveText(/Last saved:/);
  await expect(preview.getByRole('img', { name: 'Your logo' })).toHaveAttribute('src', `data:image/png;base64,${PNG.toString('base64')}`);
  expect(refused).toEqual([]);

  // The payer page of a link shows the logo and the colour, to someone with no INTAFACED session.
  const address = await makeLink(page, 'TEST Hoodie', '25', 'USDT');
  expect(address).toMatch(/\/api\/pay\/checkout\?token=/);
  run.write({ owner: saved(owner) });
  const payer = await browser.newContext();
  try {
    const payerPage = await payer.newPage();
    await payerPage.goto(address);
    await expect(payerPage.getByRole('heading', { name: 'TEST Hoodie' })).toBeVisible();
    await expect(payerPage.getByRole('img', { name: 'Merchant logo' })).toHaveAttribute(
      'src',
      `data:image/png;base64,${PNG.toString('base64')}`,
    );
    await expect(payerPage.getByRole('button', { name: /continue/i })).toHaveCSS('background-color', 'rgb(255, 102, 0)');
  } finally {
    await payer.close();
  }
});

test(`${J} #2 the owner makes a link from a product's price: the receipt shows the address once, the list shows active, 0 of 3 uses and the expiry, and one key makes one link`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const state = journey();
  await signInOwner(page, state, '/pay/products/new');
  const refused = refusedPayCalls(page);

  // A product with a one-time TEST 25 USDC price.
  await page.getByLabel('Type *').selectOption({ label: 'Physical good' });
  await page.getByLabel('Name *').fill('TEST Tote bag');
  await page.getByRole('button', { name: 'Save product' }).click();
  await expect(page).toHaveURL(/\/pay\/products\/[0-9a-f-]{36}$/);
  await page.getByRole('button', { name: 'Add price' }).click();
  await page.getByLabel('Billing *').selectOption({ label: 'One time' });
  await page.getByLabel('Amount *').fill('25');
  await page.getByLabel('Asset *').fill('USDC');
  await page.getByRole('button', { name: 'Save price' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Price added.' })).toBeVisible();

  // The picker reads the product and its price, and the price sets the amount and asset.
  await page.goto('/pay/links/new');
  const picker = page.getByRole('combobox', { name: /^Product and price/ });
  await picker.selectOption({ label: 'TEST Tote bag · 25.00 USDC' });
  await expect(page.getByLabel('Link label *')).toHaveValue('TEST Tote bag');
  await expect(page.getByLabel('Fixed amount', { exact: true })).toHaveValue(/^25(\.0+)?$/);
  await expect(page.getByLabel('Fixed amount', { exact: true })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: /^Asset/ })).toHaveValue('USDC');
  await expect(page.getByRole('combobox', { name: /^Asset/ })).toBeDisabled();
  await page.getByLabel('Maximum completed payments').fill('3');

  // Create, reviewed, then confirmed with a double press: one request body, one key.
  const creates = [];
  page.on('request', (request) => {
    if (request.url().includes('merchant.createLink') && request.method() === 'POST') creates.push(request);
  });
  await page.getByRole('button', { name: 'Create link' }).click();
  const review = page.getByRole('dialog');
  await expect(review).toContainText('TEST Tote bag · 25.00 USDC');
  await review.getByRole('button', { name: 'Create link' }).dblclick();
  await expect(page.getByRole('heading', { name: 'Your link is ready' })).toBeVisible();
  const address = page.getByTestId('link-address');
  await expect(address.getByRole('link', { name: 'Open the link' })).toHaveAttribute('href', /\/api\/pay\/checkout\?token=pl_/);
  const linkId = (await page.getByTestId('pp-facts').getByTestId('pp-mono').first().textContent())?.trim();
  expect(linkId).toMatch(/^[0-9a-f-]{36}$/);
  // The second press of a double press sends nothing: one request, so one key.
  expect(creates).toHaveLength(1);
  const sent = creates[0];
  const body = JSON.parse(sent.postData() ?? '{}');
  const input = body.json ?? body;
  expect(input).toMatchObject({ label: 'TEST Tote bag', currency: 'USDC', maxUses: 3 });
  expect(input.priceId).toMatch(/^[0-9a-f-]{36}$/);
  expect(typeof input.idempotencyKey).toBe('string');

  // The same request sent again with its key answers with the same link, not a second one.
  const headers = Object.fromEntries(
    Object.entries(await sent.allHeaders()).filter(
      ([name]) => !name.startsWith(':') && !['cookie', 'content-length', 'host'].includes(name),
    ),
  );
  const again = await page.evaluate(
    async ({ url, data, headers }) => {
      const response = await fetch(url, { method: 'POST', body: data, headers, credentials: 'include' });
      return { status: response.status, text: await response.text() };
    },
    { url: sent.url(), data: sent.postData(), headers },
  );
  expect(again.status).toBe(200);
  expect(again.text).toContain(linkId);
  run.write({ owner: saved(journey().owner), toteLinkId: linkId });

  // The list shows the one link: active, 0 of 3 uses, with its expiry.
  await page.goto('/pay/links');
  const rows = page.getByRole('row').filter({ hasText: 'TEST Tote bag' });
  await expect(rows).toHaveCount(1);
  // "Available" is the portal's plain word for an active link.
  await expect(rows.first()).toContainText('Available');
  await expect(rows.first()).toContainText('0 of 3');
  await expect(rows.first().locator('td').last()).not.toHaveText('—');
  await expect(rows.first().locator('td').last()).toContainText(/\d{4}|[A-Z][a-z]{2}/);

  // Its page names the product and price it sells.
  await page.goto(`/pay/links/${linkId}`);
  await expect(page.locator('dl[data-testid="pp-facts"]')).toContainText('TEST Tote bag · 25.00 USDC');
  expect(refused).toEqual([]);
});

test(`${J} #3 the owner copies the full address, the QR and the payment button; an http page after payment is refused; a link turned off shows its message`, async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const state = journey();
  if (!state.toteLinkId) throw new Error(`${J} #2 made no link, so this step has none to share`);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await signInOwner(page, state, `/pay/links/${state.toteLinkId}`);
  const refused = refusedPayCalls(page);
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());

  // Copy puts the full address on the clipboard: the same one Open the link goes to, with this site's host.
  const address = page.getByTestId('link-address');
  const href = await address.getByRole('link', { name: 'Open the link' }).getAttribute('href');
  expect(href).toMatch(/^https?:\/\/[^/]+\/api\/pay\/checkout\?token=pl_/);
  await address.getByRole('button', { name: 'Copy link address' }).click();
  await expect(address.getByRole('status').filter({ hasText: 'Copied' })).toBeVisible();
  expect(await clipboard()).toBe(href);
  await expect(address.getByRole('img', { name: 'QR code for the link address' })).toBeVisible();

  // The payment button's code carries the same full address and the link's label.
  const button = page
    .locator('section[data-testid="pay-section"]')
    .filter({ has: page.getByRole('heading', { name: 'Payment button for your website' }) });
  await button.getByRole('button', { name: 'Copy button code' }).click();
  const code = await clipboard();
  expect(code).toContain(`href="${href}"`);
  expect(code).toContain('>TEST Tote bag</a>');

  // An after-payment page that is not https is refused before anything is sent; an https one is kept.
  await page.goto('/pay/links/new');
  await page.getByLabel('Link label *').fill('TEST Pop-up stall');
  await page.getByLabel('Fixed amount', { exact: true }).fill('10');
  await page.getByRole('combobox', { name: /^Asset/ }).selectOption('USDT');
  await page.getByRole('combobox', { name: /^What the customer sees after paying/ }).selectOption({ label: 'Your own web page' });
  const pageAddress = page.getByLabel('Page address *');
  await pageAddress.fill('http://shop.example/thanks');
  await expect(page.getByText('Use an address that starts with https://.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create link' })).toBeDisabled();
  await pageAddress.fill('https://shop.example/thanks');
  await page.getByRole('button', { name: 'Create link' }).click();
  const review = page.getByRole('dialog');
  await expect(review).toContainText('Your own web page: https://shop.example/thanks');
  await review.getByRole('button', { name: 'Create link' }).click();
  await expect(page.getByRole('heading', { name: 'Your link is ready' })).toBeVisible();
  const stallAddress = await page.getByTestId('link-address').getByRole('link', { name: 'Open the link' }).getAttribute('href');
  const stallId = (await page.getByTestId('pp-facts').getByTestId('pp-mono').first().textContent())?.trim();

  // Turned off with a message: the link's page and a customer opening it both show it.
  await page.goto(`/pay/links/${stallId}`);
  await expect(page.locator('dl[data-testid="pp-facts"]')).toContainText('Your own web page: https://shop.example/thanks');
  await page.getByLabel('Message for customers').fill('TEST Sold out until Monday');
  await page.getByRole('button', { name: 'Deactivate link' }).click();
  const off = page.getByRole('dialog');
  await expect(off).toContainText('TEST Sold out until Monday');
  await off.getByRole('button', { name: 'Deactivate link' }).click();
  await expect(page.locator('dl[data-testid="pp-facts"]')).toContainText('TEST Sold out until Monday');
  await expect(page.getByText('Deactivated').first()).toBeVisible();
  expect(refused).toEqual([]);

  const payer = await browser.newContext();
  try {
    const payerPage = await payer.newPage();
    await payerPage.goto(stallAddress);
    await expect(payerPage.getByText('TEST Sold out until Monday').first()).toBeVisible();
    await expect(payerPage.getByRole('button', { name: /continue/i })).toHaveCount(0);
  } finally {
    await payer.close();
  }
});

/** The payer's hosted page (no INTAFACED session): the session page's acceptance reference, after Continue. */
async function payerContinues(payerPage, country = 'DE') {
  await payerPage.getByLabel('Country').fill(country);
  await payerPage.getByRole('button', { name: /continue/i }).click();
  await expect(payerPage.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(payerPage.getByText('Send exactly this amount to')).toBeVisible();
  return (await payerPage.locator('.reference code').textContent())?.trim();
}

test(`${J} #4 the payer opens the link: the fixed amount and asset before confirming; an expired, used-up or turned-off link opens a plain state and no payment; a link with no amount asks for one`, async ({
  page,
  browser,
}) => {
  test.setTimeout(420_000);
  const state = journey();
  if (!state.toteLinkId) throw new Error(`${J} #2 made no link, so this step has none for the payer to open`);
  await signInOwner(page, state, `/pay/links/${state.toteLinkId}`);
  const refused = refusedPayCalls(page);
  const toteAddress = await page.getByTestId('link-address').getByRole('link', { name: 'Open the link' }).getAttribute('href');

  // A link for one payment of TEST 5 USDT, and the create request it sent (replayed below for a short-lived link).
  await page.goto('/pay/links/new');
  await page.getByLabel('Link label *').fill('TEST Single print');
  await page.getByLabel('Fixed amount', { exact: true }).fill('5');
  await page.getByRole('combobox', { name: /^Asset/ }).selectOption('USDT');
  await page.getByLabel('Maximum completed payments').fill('1');
  const created = page.waitForRequest((request) => request.url().includes('merchant.createLink') && request.method() === 'POST');
  await page.getByRole('button', { name: 'Create link' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Create link' }).click();
  await expect(page.getByRole('heading', { name: 'Your link is ready' })).toBeVisible();
  const printAddress = await page.getByTestId('link-address').getByRole('link', { name: 'Open the link' }).getAttribute('href');
  const sent = await created;

  // A link that expires 20 seconds from now: the same request with its own key and an expiry the form does not offer.
  const body = JSON.parse(sent.postData() ?? '{}');
  const input = body.json ?? body;
  Object.assign(input, {
    label: 'TEST Flash sale',
    idempotencyKey: `j-merchant-04-flash-${Date.now()}`,
    expiresAt: new Date(Date.now() + 20_000).toISOString(),
  });
  delete input.maxUses;
  const headers = Object.fromEntries(
    Object.entries(await sent.allHeaders()).filter(
      ([name]) => !name.startsWith(':') && !['cookie', 'content-length', 'host'].includes(name),
    ),
  );
  const flash = await page.evaluate(
    async ({ url, data, headers }) => {
      const response = await fetch(url, { method: 'POST', body: data, headers, credentials: 'include' });
      return { status: response.status, text: await response.text() };
    },
    { url: sent.url(), data: JSON.stringify(body), headers },
  );
  expect(flash.status).toBe(200);
  const flashToken = /"checkoutUrl":"[^"]*token=(pl_[A-Za-z0-9_-]+)/.exec(flash.text)?.[1];
  expect(flashToken).toBeTruthy();
  const flashAddress = printAddress.replace(/token=pl_[A-Za-z0-9_-]+/, `token=${flashToken}`);

  // A link with no amount: the payer names it.
  await page.goto('/pay/links/new');
  await page.getByLabel('Link label *').fill('TEST Tip jar');
  await page.getByRole('combobox', { name: /^Asset/ }).selectOption('USDT');
  await page.getByRole('button', { name: 'Create link' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Create link' }).click();
  await expect(page.getByRole('heading', { name: 'Your link is ready' })).toBeVisible();
  const tipAddress = await page.getByTestId('link-address').getByRole('link', { name: 'Open the link' }).getAttribute('href');

  // A link the owner turned off: created with a fixed amount, then deactivated on its own page.
  await page.goto('/pay/links/new');
  await page.getByLabel('Link label *').fill('TEST Retired print');
  await page.getByLabel('Fixed amount', { exact: true }).fill('7');
  await page.getByRole('combobox', { name: /^Asset/ }).selectOption('USDT');
  await page.getByRole('button', { name: 'Create link' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Create link' }).click();
  await expect(page.getByRole('heading', { name: 'Your link is ready' })).toBeVisible();
  const offAddress = await page.getByTestId('link-address').getByRole('link', { name: 'Open the link' }).getAttribute('href');
  const offId = (await page.getByTestId('pp-facts').getByTestId('pp-mono').first().textContent())?.trim();
  await page.goto(`/pay/links/${offId}`);
  await page.getByLabel('Message for customers').fill('TEST This print is retired');
  await page.getByRole('button', { name: 'Deactivate link' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Deactivate link' }).click();
  await expect(page.getByText('Deactivated').first()).toBeVisible();
  expect(refused).toEqual([]);

  const payer = await browser.newContext();
  try {
    const payerPage = await payer.newPage();

    // The fixed amount and asset show before the payer confirms anything; Continue opens the payment's own reference.
    await payerPage.goto(toteAddress);
    await expect(payerPage.getByRole('heading', { name: 'TEST Tote bag' })).toBeVisible();
    await expect(payerPage.locator('.amount')).toHaveText('25.00 USDC');
    await expect(payerPage.getByLabel('Amount')).toHaveCount(0);
    const toteReference = await payerContinues(payerPage);
    expect(toteReference).toMatch(/^addr_usdc_[0-9a-f-]{36}$/);
    await expect(payerPage.locator('.amount')).toHaveText('25.00 USDC');

    // One payment uses the single-payment link up: paid in full by a TEST transfer, it then opens a plain state.
    await payerPage.goto(printAddress);
    await expect(payerPage.locator('.amount')).toHaveText('5.00 USDT');
    const printReference = await payerContinues(payerPage);
    const sessionUrl = payerPage.url();
    tool('local-test-stack.mjs', 'chain-deposit', printReference, 'USDT', '5', '12', '--tx', `j-merchant-04-print-${Date.now()}`);
    await expect(async () => {
      await payerPage.goto(sessionUrl);
      await expect(payerPage.getByText('Payment received')).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 60_000 });
    await payerPage.goto(printAddress);
    await expect(payerPage.getByRole('heading', { name: 'Link already used' })).toBeVisible();
    await expect(payerPage.getByRole('button', { name: /continue/i })).toHaveCount(0);

    // Past its expiry the link opens a plain state and no payment form.
    await payerPage.goto(flashAddress);
    await expect(async () => {
      await payerPage.goto(flashAddress);
      await expect(payerPage.getByRole('heading', { name: 'Link expired' })).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 60_000 });
    await expect(payerPage.getByRole('button', { name: /continue/i })).toHaveCount(0);

    // A link that is off opens a plain state with the merchant's words: no amount, no payment form, no Continue.
    const offOpened = await payerPage.goto(offAddress);
    expect(offOpened.status()).toBe(404);
    await expect(payerPage.getByRole('heading', { level: 1 })).toHaveText('TEST This print is retired');
    await expect(payerPage.locator('.amount')).toHaveCount(0);
    await expect(payerPage.locator('form')).toHaveCount(0);
    await expect(payerPage.getByRole('button', { name: /continue/i })).toHaveCount(0);

    // With no amount on the link, the payer is asked for one, and the payment is for what they named.
    await payerPage.goto(tipAddress);
    await expect(payerPage.locator('.amount')).toHaveText('Choose an amount');
    await payerPage.getByLabel(/Amount/).fill('3');
    const tipReference = await payerContinues(payerPage);
    expect(tipReference).toMatch(/^addr_usdt_/);
    await expect(payerPage.locator('.amount')).toHaveText('3.00 USDT');
  } finally {
    await payer.close();
  }

  // The owner sees the single-payment link used once of once.
  await page.goto('/pay/links');
  const print = page.getByRole('row').filter({ hasText: 'TEST Single print' });
  await expect(print).toContainText('1 of 1');
});

/** The owner's pending (clearing) figure for one asset on the balance page. */
async function pendingBalance(page, asset) {
  await page.goto('/pay/money');
  const row = page.getByRole('row').filter({ hasText: asset });
  await expect(row).toHaveCount(1);
  return (await row.textContent())?.replace(/\s+/g, ' ').trim();
}

test(`${J} #5 the payer pays in two transfers: TEST 60 of TEST 100 received and TEST 40 missing with no credit yet; the second confirmed transfer completes it once`, async ({
  page,
  browser,
}) => {
  test.setTimeout(420_000);
  const state = journey();
  await signInOwner(page, state, '/pay/links');
  const refused = refusedPayCalls(page);
  // Its own label per run, so a re-run on the same business finds this link's row.
  const label = `TEST Invoice in two parts ${Date.now().toString(36)}`;
  const address = await makeLink(page, label, '100', 'USDT');
  expect(refused).toEqual([]);
  const before = await pendingBalance(page, 'USDT');

  const payer = await browser.newContext();
  try {
    const payerPage = await payer.newPage();
    await payerPage.goto(address);
    await expect(payerPage.locator('.amount')).toHaveText('100.00 USDT');
    const reference = await payerContinues(payerPage);
    const sessionUrl = payerPage.url();
    const run = Date.now();

    // The first TEST transfer covers part of it: the page says what arrived and what is missing.
    tool('local-test-stack.mjs', 'chain-deposit', reference, 'USDT', '60', '12', '--tx', `j-merchant-04-part-1-${run}`);
    await expect(async () => {
      await payerPage.goto(sessionUrl);
      await expect(payerPage.getByRole('status')).toHaveText('60.00 USDT of 100.00 USDT received, 40.00 USDT missing', { timeout: 2_000 });
    }).toPass({ timeout: 60_000 });
    await expect(payerPage.getByText('Send the missing 40.00 USDT to the same reference')).toBeVisible();
    await expect(payerPage.locator('.reference code')).toHaveText(reference);

    // No credit yet: the owner's pending balance has not moved.
    expect(await pendingBalance(page, 'USDT')).toBe(before);

    // The second confirmed TEST transfer completes the payment.
    tool('local-test-stack.mjs', 'chain-deposit', reference, 'USDT', '40', '12', '--tx', `j-merchant-04-part-2-${run}`);
    await expect(async () => {
      await payerPage.goto(sessionUrl);
      await expect(payerPage.getByText('Payment received')).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 60_000 });
    await expect(payerPage.locator('.amount')).toHaveText('100.00 USDT');

    // Once: delivering the second transfer again books nothing more.
    const after = await pendingBalance(page, 'USDT');
    expect(after).not.toBe(before);
    tool('local-test-stack.mjs', 'chain-deposit', reference, 'USDT', '40', '12', '--tx', `j-merchant-04-part-2-${run}`);
    expect(await pendingBalance(page, 'USDT')).toBe(after);
  } finally {
    await payer.close();
  }

  // The owner sees the link used once.
  await page.goto('/pay/links');
  const invoice = page.getByRole('row').filter({ hasText: label });
  await expect(invoice).toBeVisible();
  const usesColumn = (await page.getByRole('columnheader').allTextContents()).findIndex((h) => h.trim() === 'Completed payments');
  expect(usesColumn).toBeGreaterThanOrEqual(0);
  await expect(invoice.getByRole('cell').nth(usesColumn)).toHaveText('1');
});

/** The owner's EUR balance row on the balance page, once the page has read the balances: '' when the business holds no
 * EUR row yet. A EUR row can appear with zeros as soon as a EUR payment exists, so callers compare figures, not presence. */
async function eurBalance(page) {
  await page.goto('/pay/money');
  await expect(page.getByRole('row').nth(1)).toBeVisible();
  const rows = page.getByRole('row').filter({ hasText: 'EUR' });
  return (await rows.count()) === 0 ? '' : ((await rows.first().textContent()) ?? '').replace(/\s+/g, ' ').trim();
}
/** True when a balance row shows no money: only zero figures. */
const noMoney = (row) => !/[1-9]/.test(row);

/** The payer's hosted page for a link with no amount or currency: the payer names both, then the name on their bank
 * account when the business takes the payment by bank transfer. Returns the transfer reference the page shows. */
async function payerSendsByBank(payerPage, address, amount, currency, name) {
  await payerPage.goto(address);
  await expect(payerPage.locator('.amount')).toHaveText('Choose an amount');
  await payerPage.getByLabel(/Amount/).fill(amount);
  await payerPage.getByLabel('Currency').fill(currency);
  await payerPage.getByLabel('Country').fill('DE');
  await payerPage.getByRole('button', { name: /continue/i }).click();
  // A bank transfer is checked against the name on the account it comes from, so the page asks for it.
  await expect(payerPage.getByRole('alert')).toHaveText('Give the name on the bank account you will send the transfer from.');
  await payerPage.getByLabel('Name on your bank account').fill(name);
  await payerPage.getByRole('button', { name: /continue/i }).click();
  await expect(payerPage.getByText('Pay by bank transfer', { exact: true })).toBeVisible();
  await expect(payerPage.getByText('TEST bank: no real bank account receives this transfer.')).toBeVisible();
  const reference = (await payerPage.locator('.reference code').textContent())?.trim();
  expect(reference).toMatch(/^BT[0-9A-F]{12}$/);
  return reference;
}

test(`${J} #6 the payer pays by bank from an account in another name: the transfer is held for review, nothing is credited, and the owner sees why; the same transfer from the given name completes`, async ({
  page,
  browser,
}) => {
  test.setTimeout(420_000);
  const state = journey();
  await signInOwner(page, state, '/pay/links/new');
  const refused = refusedPayCalls(page);

  // A link with no amount or asset: the payer names both, here TEST 30 EUR, which only the TEST bank takes.
  const label = `TEST Bank invoice ${Date.now().toString(36)}`;
  await page.getByLabel('Link label *').fill(label);
  await page.getByRole('combobox', { name: /^Asset/ }).selectOption('');
  await page.getByRole('button', { name: 'Create link' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Create link' }).click();
  await expect(page.getByRole('heading', { name: 'Your link is ready' })).toBeVisible();
  const address = await page.getByTestId('link-address').getByRole('link', { name: 'Open the link' }).getAttribute('href');
  expect(refused).toEqual([]);
  // This business has never been paid in EUR.
  expect(noMoney(await eurBalance(page))).toBe(true);
  const run = Date.now();

  const payer = await browser.newContext();
  try {
    const payerPage = await payer.newPage();

    // The payer says the transfer comes from Ada Lovelace; the TEST bank reports it from "A LOVELACE".
    const reference = await payerSendsByBank(payerPage, address, '30', 'EUR', 'Ada Lovelace');
    const sessionUrl = payerPage.url();
    await expect(payerPage.getByText('Waiting for your transfer')).toBeVisible();
    tool('local-test-stack.mjs', 'bank-transfer', reference, 'EUR', '30', '--tx', `j-merchant-04-name-${run}`, '--payer', 'A LOVELACE');
    await expect(async () => {
      await payerPage.goto(sessionUrl);
      await expect(payerPage.getByRole('status')).toHaveText('Your bank transfer arrived and is held for a check', { timeout: 2_000 });
    }).toPass({ timeout: 60_000 });
    await expect(payerPage.getByText('Being checked')).toBeVisible();
    await expect(payerPage.getByText('Payment received')).toHaveCount(0);

    // Delivered again, the same transfer is still one held transfer, and nothing is credited.
    tool('local-test-stack.mjs', 'bank-transfer', reference, 'EUR', '30', '--tx', `j-merchant-04-name-${run}`, '--payer', 'A LOVELACE');
    expect(noMoney(await eurBalance(page))).toBe(true);

    // The owner's payment is still open, held for a name check, with the reason; it was never captured.
    await page.goto('/pay/payments');
    await page.getByRole('row').filter({ hasText: 'EUR' }).first().getByRole('link').first().click();
    await expect(page).toHaveURL(/\/pay\/payments\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId('payment-name-hold')).toHaveText(
      'Held for a name check. The bank transfer came from an account in another name than the one your customer gave. Nothing has been taken or added to your balance while it is checked.',
    );
    await expect(page.getByText('Bank transfer held for a name check').first()).toBeVisible();

    // The contrast: the same TEST bank and amount, from the name the payer gave, completes once and is credited.
    const matching = await payerSendsByBank(payerPage, address, '30', 'EUR', 'Grace Hopper');
    const matchingUrl = payerPage.url();
    tool('local-test-stack.mjs', 'bank-transfer', matching, 'EUR', '30', '--tx', `j-merchant-04-match-${run}`, '--payer', 'GRACE  HOPPER');
    await expect(async () => {
      await payerPage.goto(matchingUrl);
      await expect(payerPage.getByText('Payment received')).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 60_000 });
    await expect(async () => expect(noMoney(await eurBalance(page))).toBe(false)).toPass({ timeout: 30_000 });
  } finally {
    await payer.close();
  }
});

test(`${J} #7 the payer is offered only the methods for the country and currency in the set order; bank debit with no rail shows rail.bank; a crypto payment completes`, async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const state = journey();
  await signInOwner(page, state, '/pay/checkout');
  const refused = refusedPayCalls(page);
  const methods = page.getByRole('list', { name: 'Payment methods' });
  const method = (id) => methods.locator(`li[data-method="${id}"]`);

  // What the platform can take: crypto and the TEST bank's transfers are available; card, bank debit and pay later each
  // name the piece they need.
  await expect(method('crypto').getByText('Available')).toBeVisible();
  await expect(method('bank_transfer').getByText('Available')).toBeVisible();
  await expect(method('bank_debit').locator('[data-not-connected="rail.bank"]')).toContainText('Bank debit needs a banking partner.');
  await expect(method('card').locator('[data-not-connected="rail.card"]')).toBeVisible();
  await expect(method('pay_later').locator('[data-not-connected="rail.card"]')).toBeVisible();

  // The owner puts bank debit first and turns it on, and keeps crypto on.
  // (A rerun on the same business finds it saved already.)
  for (let moves = 0; moves < 3 && (await methods.locator(':scope > li').first().getAttribute('data-method')) !== 'bank_debit'; moves++) {
    await page.getByRole('button', { name: 'Move Bank debit up' }).click();
  }
  await page.getByRole('checkbox', { name: 'Offer Bank debit' }).check();
  await expect(page.getByRole('checkbox', { name: 'Offer Crypto' })).toBeChecked();
  await page.getByRole('button', { name: 'Save methods' }).click();
  await expect(page.getByText('Saved. Your checkout now offers these methods in this order.')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('checkout-methods-state')).toContainText('Last saved:');
  expect(await methods.locator(':scope > li').evaluateAll((items) => items.map((li) => li.dataset.method))).toEqual([
    'bank_debit',
    'crypto',
    'card',
    'pay_later',
    'bank_transfer',
  ]);

  // A customer in Germany paying in EUR is offered bank debit, which names rail.bank, then bank transfer, and not crypto.
  const preview = async (country, currency) => {
    await page.getByLabel('Country').fill(country);
    await page.getByLabel('Currency').fill(currency);
    const answered = page.waitForResponse((response) => response.url().includes('merchantCheckoutMethods.preview'));
    await page.getByRole('button', { name: 'Check', exact: true }).click();
    await answered;
    const offer = page.getByTestId('checkout-methods-offer');
    await expect(offer).toBeVisible();
    return offer;
  };
  const eur = await preview('DE', 'EUR');
  const eurOffered = eur.locator('ol > li');
  expect(await eurOffered.evaluateAll((items) => items.map((li) => li.dataset.method))).toEqual(['bank_debit', 'bank_transfer']);
  await expect(eurOffered.first().locator('[data-not-connected="rail.bank"]')).toBeVisible();
  await expect(eur.locator('li[data-method="crypto"]')).toHaveText('Crypto: Not for this currency');
  await expect(eur.locator('li[data-method="card"]')).toHaveText('Card: Switched off');
  // Paying in USDT, the same customer is offered crypto alone.
  const usdt = await preview('DE', 'USDT');
  expect(await usdt.locator('ol > li').evaluateAll((items) => items.map((li) => li.dataset.method))).toEqual(['crypto']);
  await expect(usdt.locator('ol > li').first()).toContainText('Available');
  await expect(usdt.locator('li[data-method="bank_debit"]')).toHaveText('Bank debit: Not for this currency');

  // A TEST 7 USDT link: the payer is taken straight to the crypto reference, and a transfer completes the payment.
  const address = await makeLink(page, `TEST Poster ${Date.now().toString(36)}`, '7', 'USDT');
  expect(refused).toEqual([]);
  const payer = await browser.newContext();
  try {
    const payerPage = await payer.newPage();
    await payerPage.goto(address);
    await expect(payerPage.locator('.amount')).toHaveText('7.00 USDT');
    const reference = await payerContinues(payerPage);
    expect(reference).toMatch(/^addr_usdt_/);
    const sessionUrl = payerPage.url();
    tool('local-test-stack.mjs', 'chain-deposit', reference, 'USDT', '7', '12', '--tx', `j-merchant-04-methods-${Date.now()}`);
    await expect(async () => {
      await payerPage.goto(sessionUrl);
      await expect(payerPage.getByText('Payment received')).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 60_000 });
  } finally {
    await payer.close();
  }
});
