import path from 'node:path';
import { expect } from '@playwright/test';
import { ROOT } from './stack.mjs';
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

/** The sign-in form, with the authenticator's next code once the person has one. */
export async function signInWithCode(page, who, destination) {
  await page.goto(`/login?redirect=${encodeURIComponent(destination)}`);
  if (who.secret) {
    const { code, step } = await nextCode(who.totp, who.secret, who.step);
    who.step = step;
    await page.fill('input[name=totp]', code);
  }
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).toHaveURL(new RegExp(`${destination.replace(/[/.]/g, '\\$&')}$`));
}

/** Step 1 of setup, as the owner fills it: a TEST business with the stack's TEST starter fee. Stays on onboarding. */
export async function openBusiness(page, who, legalName = 'TEST Merchant Ltd') {
  await page.goto('/pay/onboarding/business');
  await page.getByLabel('Legal business name *').fill(legalName);
  await page.getByLabel('Country code *').fill('DE');
  await page.getByLabel('Type of business *').fill('online shop');
  await page.getByLabel('Contact email *').fill(who.email);
  await page.getByRole('button', { name: 'Create my account' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Create my account' }).click();
  await expect(page.getByText('Your merchant account exists.')).toBeVisible();
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
