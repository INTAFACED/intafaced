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
