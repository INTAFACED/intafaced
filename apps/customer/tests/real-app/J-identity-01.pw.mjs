import { randomBytes } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { EDGE, journeyState, mailedCodes, nextMailedCode } from './stack.mjs';

// J-identity-01, in the running app (docs/roadmap/journeys.json): sign up with an email, get the code, land signed in.
// One test per step this build serves, titled "J-identity-01 #<n>". Every person here is a TEST person on the local
// stack; the codes are read from the stack's LOCAL-TEST mail outbox, as the person would read their inbox. The stack's
// TEST owner values: minimum age 18, sign-up closed for AQ, five wrong codes lock, a new code after 30 s.
const J = 'J-identity-01';
const ORIGIN = 'http://127.0.0.1:3210';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

function person() {
  const handle = `ji${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  // A fresh TEST password per run, kept only in the run file (mode 600).
  return { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
}

async function details(page, who, { country = 'DE', dateOfBirth = '1990-05-01', password = who.password } = {}) {
  await page.goto('/register');
  await page.getByLabel('Email address').fill(who.email);
  await page.getByLabel('Handle').fill(who.handle);
  await page.getByLabel('Password').fill(password);
  await page.getByLabel('Country you live in').selectOption(country);
  await page.getByLabel('Date of birth').fill(dateOfBirth);
  await page.getByRole('button', { name: 'Create account' }).click();
}

/** Nothing was made for `who`: the password does not sign in. */
async function noAccount(who) {
  const res = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: who.email, password: who.password }),
  });
  expect(res.status).toBe(401);
}

const notice = (page) => page.getByRole('alert');

test(`${J} #1 fills the form; an under-age date or a closed country is refused in plain words and nothing is made`, async ({ page }) => {
  const who = person();
  run.reset({ account: who });

  await details(page, who, { dateOfBirth: '2015-01-01' });
  await expect(notice(page)).toContainText('under the minimum age');
  await expect(notice(page)).toContainText('Nothing was created');
  await noAccount(who);

  await details(page, who, { country: 'AQ' });
  await expect(notice(page)).toContainText('cannot open accounts for this country');
  await noAccount(who);

  // A good record goes on to the code step; still no account until the code is entered.
  await details(page, who);
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await noAccount(who);
});

test(`${J} #2 a too-short password is refused with the rule in words before any account exists`, async ({ page }) => {
  const who = person();
  await page.goto('/register');
  await expect(page.getByText('At least 12 characters')).toBeVisible();
  await details(page, who, { password: 'short9' });
  await expect(notice(page)).toContainText('at least 12 characters');
  expect(mailedCodes(who.email)).toHaveLength(0);
});

test(`${J} #4 "check your email" reads the same for a known address, and an early resend says the seconds left`, async ({ page }) => {
  const who = run.read().account;
  // The account made in #5 does not exist yet, so use a second TEST person who signs up fully first.
  const known = person();
  await details(page, known);
  await page.getByLabel('Code from the email').fill(await nextMailedCode(known.email));
  await page.getByRole('button', { name: 'Confirm and open my account' }).click();
  await page.waitForURL((url) => url.pathname !== '/register');
  await page.context().clearCookies();

  await details(page, { ...person(), email: known.email });
  const forKnown = await page.getByRole('status').filter({ hasText: 'a 6-digit code is on its way' }).innerText();
  await details(page, who);
  const forNew = await page.getByRole('status').filter({ hasText: 'a 6-digit code is on its way' }).innerText();
  expect(forKnown.replace(known.email, 'X')).toBe(forNew.replace(who.email, 'X'));

  await expect(page.getByRole('button', { name: 'Send a new code' })).toBeDisabled();
  await expect(page.getByText(/You can ask for a new code in \d+ s\./)).toBeVisible();
});

test(`${J} #5 enters the code and is signed in on Home; wrong codes lock with a time; a used code is refused`, async ({ page }) => {
  const who = run.read().account;
  if (!who) throw new Error(`${J} #1 made no TEST person, so this step has no one to act as`);
  // Lockout first, on a separate TEST sign-up, so the person's own code stays good.
  const other = person();
  await details(page, other);
  const otherCode = await nextMailedCode(other.email);
  const wrong = otherCode === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) {
    await page.getByLabel('Code from the email').fill(wrong);
    await page.getByRole('button', { name: 'Confirm and open my account' }).click();
    await expect(notice(page)).toContainText(i < 4 ? 'That code is not right' : /Too many tries\. Try again in \d+ min\./);
  }
  await page.getByLabel('Code from the email').fill(otherCode);
  await page.getByRole('button', { name: 'Confirm and open my account' }).click();
  await expect(notice(page)).toContainText('Too many tries');

  // The person's own sign-up: details, the newest mailed code, signed in on Home.
  const seen = mailedCodes(who.email).length;
  const started = page.waitForResponse((r) => r.url().includes('auth.signUpStart'));
  await details(page, who);
  const flowId = (await (await started).json()).result.data.flowId;
  const code = await nextMailedCode(who.email, seen);
  await page.getByLabel('Code from the email').fill(code);
  await page.getByRole('button', { name: 'Confirm and open my account' }).click();
  await expect(page).toHaveURL(/\/home/);
  await expect(page.getByRole('link', { name: /sign in/i })).toHaveCount(0);

  // The same code a second time is refused, and makes no second session.
  const again = await fetch(`${EDGE}/api/identity/trpc/auth.signUpConfirm`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ flowId, code }),
  });
  expect(again.status).toBe(409);
  expect(JSON.stringify(await again.json())).toContain('identity.signup_code_used');
});
