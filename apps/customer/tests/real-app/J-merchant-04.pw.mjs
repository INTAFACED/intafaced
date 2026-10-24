import path from 'node:path';
import { test, expect } from '@playwright/test';
import { ROOT, journeyState } from './stack.mjs';
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
  await page.getByRole('dialog').locator('.form-stack > button').last().click();
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
  const look = page.locator('section.pay-section').filter({ has: page.getByRole('heading', { name: 'How your checkout looks' }) });
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
  const linkId = (await page.locator('.pp-facts .pp-mono').first().textContent())?.trim();
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
  await expect(page.locator('dl.pp-facts')).toContainText('TEST Tote bag · 25.00 USDC');
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
    .locator('section.pay-section')
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
  const stallId = (await page.locator('.pp-facts .pp-mono').first().textContent())?.trim();

  // Turned off with a message: the link's page and a customer opening it both show it.
  await page.goto(`/pay/links/${stallId}`);
  await expect(page.locator('dl.pp-facts')).toContainText('Your own web page: https://shop.example/thanks');
  await page.getByLabel('Message for customers').fill('TEST Sold out until Monday');
  await page.getByRole('button', { name: 'Deactivate link' }).click();
  const off = page.getByRole('dialog');
  await expect(off).toContainText('TEST Sold out until Monday');
  await off.getByRole('button', { name: 'Deactivate link' }).click();
  await expect(page.locator('dl.pp-facts')).toContainText('TEST Sold out until Monday');
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
