import path from 'node:path';
import { expect } from '@playwright/test';
import { ROOT, tool } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { addAuthenticator, forgetSession, nextCode } from './identity-factors.mjs';

/**
 * A person who may open a business: signed up, verified "full" by the stack's TEST operators, with an authenticator,
 * and signed in again with its code (opening a business needs a second factor). Lands on `destination`.
 */
export async function businessReadyPerson(page, prefix, destination = '/pay/merchant') {
  const { totp } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));
  const who = await signUp(page, prefix);
  await verify(page, who);
  await signInWithCode(page, who, '/uc/safe');
  const { secret, step } = await addAuthenticator(page, totp);
  Object.assign(who, { totp, secret, step });
  await forgetSession(page);
  await signInWithCode(page, who, destination);
  return who;
}

/**
 * The sign-in form, with the authenticator's next code once the person has one. The form is used only once the page's
 * own session check (`auth.refresh`) has answered: a sign-in sent while that answer lands is discarded by the form as
 * "sign-in context changed", which a person typing never meets but a script filling in 200 ms does.
 */
export async function signInWithCode(page, who, destination) {
  const restored = page.waitForResponse((r) => r.url().includes('auth.refresh'), { timeout: 10_000 }).catch(() => null);
  await page.goto(`/login?redirect=${encodeURIComponent(destination)}`);
  await restored;
  await expect(page.getByRole('button', { name: /^sign in$/i })).toBeEnabled();
  if (who.secret) {
    const { code, step } = await nextCode(who.totp, who.secret, who.step);
    who.step = step;
    await page.fill('input[name=totp]', code);
  }
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  const login = page.waitForResponse((r) => r.url().includes('auth.login') && r.request().method() === 'POST');
  await page.getByRole('button', { name: /^sign in$/i }).click();
  const sent = await (await login).json().catch(() => null);
  who.userId = (Array.isArray(sent) ? sent[0] : sent)?.result?.data?.userId ?? who.userId;
  await expect(page).toHaveURL(new RegExp(`${destination.replace(/[/.]/g, '\\$&')}$`));
}

/** Step 1 of setup, as the owner fills it: a TEST business with the stack's TEST starter fee. Stays on onboarding and
 * returns the new merchant's id. */
export async function openBusiness(page, who, legalName = 'TEST Merchant Ltd') {
  const created = page.waitForResponse((r) => r.url().includes('merchant.create') && r.request().method() === 'POST');
  await page.goto('/pay/onboarding/business');
  await page.getByLabel('Legal business name *').fill(legalName);
  await page.getByLabel('Country code *').fill('DE');
  await page.getByLabel('Type of business *').fill('online shop');
  await page.getByLabel('Contact email *').fill(who.email);
  await page.getByRole('button', { name: 'Create my account' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Create my account' }).click();
  const sent = await (await created).json();
  await expect(page.getByText('Your merchant account exists.')).toBeVisible();
  return (Array.isArray(sent) ? sent[0] : sent).result.data.id;
}

/**
 * Once the stack's category table has categories (J-merchant-02 #7 adds one), approval needs a chosen category that
 * INTAFACED takes (RC-merchant-08). The owner picks a standard one if there is one, else the first taken one with its
 * terms set; an empty table asks nothing.
 */
async function chooseTakenCategory(page) {
  await page.goto('/pay/compliance');
  const section = page
    .locator('section[data-testid="pay-section"]')
    .filter({ has: page.getByRole('heading', { name: 'Business category' }) });
  const all = section.getByRole('list', { name: 'Every category' });
  await expect(section.getByTestId('category-no-rule').or(all)).toBeVisible();
  if (!(await all.isVisible())) return;
  // A standard category (cards, crypto and bank transfer) first, so a journey's business can take every method whatever
  // categories earlier journeys added; otherwise the first one taken.
  const items = await all.getByRole('listitem').all();
  const texts = await Promise.all(items.map(async (item) => (await item.textContent()) ?? ''));
  // The class is the first fact under each category (CategoryFacts): its exact word, never a label that contains it.
  const classes = await Promise.all(items.map(async (item) => ((await item.locator('dd').first().textContent()) ?? '').trim()));
  const standard = (i) => classes[i] === 'Standard';
  const order = [...items.keys()].sort((x, y) => Number(!standard(x)) - Number(!standard(y)));
  for (const i of order) {
    const item = items[i];
    const text = texts[i];
    if (text.includes('Not taken') || text.includes('Not set.')) continue;
    await section.getByLabel('Your business category').selectOption({ label: await item.getAttribute('aria-label') });
    await section.getByRole('button', { name: 'Save category' }).click();
    await expect(section.getByText('Your category was saved.')).toBeVisible();
    return;
  }
}

/** Step 2 of setup: the owner sends a TEST verification reference, then the stack's founder pair approves it through
 * svc-pay's two-person door (`local-test-world.mjs approve-kyb`). The owner signs in again after, for the new grant. */
export async function verifiedBusiness(page, who, merchantId) {
  await chooseTakenCategory(page);
  await page.goto('/pay/onboarding/verification');
  await page.getByLabel('Verification file reference *').fill(`TEST-kyb-${who.handle}`);
  await page.getByRole('button', { name: 'Send for review' }).click();
  await page.getByRole('dialog').locator('[data-testid="form-stack"] > button').last().click();
  await expect(page.getByText('INTAFACED is reviewing it')).toBeVisible();
  const decided = JSON.parse(tool('local-test-world.mjs', 'approve-kyb', merchantId).trim().split('\n').pop());
  expect(decided.kybStatus).toBe('approved');
}

/** Every pay call the page makes that the service refuses, as "status procedure". */
export function refusedPayCalls(page) {
  const refused = [];
  page.on('response', (res) => {
    const url = new URL(res.url());
    if (url.pathname.startsWith('/api/pay/') && res.status() >= 400)
      refused.push(`${res.status()} ${url.pathname.replace('/api/pay/trpc/', '')}`);
  });
  return refused;
}
