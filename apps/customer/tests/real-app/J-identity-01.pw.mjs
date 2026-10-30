import { randomBytes } from 'node:crypto';
import { test, expect } from '@playwright/test';
import {
  DEVICE_KEY,
  EDGE,
  api,
  fund,
  journeyState,
  mailedCodes,
  mailedConfirmLinks,
  nextMailedCode,
  signOutBrowser,
  signUpInBrowser,
  tool,
} from './stack.mjs';
import { awayBid, deskPath, held, openOrders, previewed, reviewSheet, verify } from './desk.mjs';

// J-identity-01, in the running app (docs/roadmap/journeys.json): sign up with an email, get the code, land signed in.
// One test per step this build serves, titled "J-identity-01 #<n>". Every person here is a TEST person on the local
// stack; the codes are read from the stack's LOCAL-TEST mail outbox, as the person would read their inbox. The stack's
// TEST owner values: minimum age 18, sign-up closed for AQ, five wrong codes lock, a new code after 30 s, five
// confirmation emails an hour.
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

/** identity's own sign-up step 1, sent as the page sends it: the status and the typed code of a refusal. */
async function signUpStart(who, fields = {}) {
  const res = await fetch(`${EDGE}/api/identity/trpc/auth.signUpStart`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({
      channel: 'email',
      handle: who.handle,
      email: who.email,
      password: who.password,
      country: 'DE',
      dateOfBirth: '1990-05-01',
      accountType: 'individual',
      ...fields,
    }),
  });
  const body = await res.json();
  const data = body.error?.data;
  return { status: res.status, result: body.result?.data, code: data?.intafacedCode ?? data?.cause?.code ?? data?.code, data };
}

/** Identity restarted with sign-up published as closed, or back on the stack's TEST "open". */
function registration(open) {
  const before = process.env.LOCAL_STACK_IDENTITY_REGISTRATION;
  if (open) delete process.env.LOCAL_STACK_IDENTITY_REGISTRATION;
  else process.env.LOCAL_STACK_IDENTITY_REGISTRATION = 'closed';
  try {
    tool('local-test-stack.mjs', 'restart', 'identity');
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_IDENTITY_REGISTRATION;
    else process.env.LOCAL_STACK_IDENTITY_REGISTRATION = before;
  }
}

/** Nothing was made for `who`: the password does not sign in. */
async function noAccount(who) {
  const res = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password }),
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

  // A country that is not on the list at all is refused by its own code, before anything else is checked (the page's
  // list cannot send one, so it goes as the page would send it).
  expect((await signUpStart(who, { country: 'XQ' })).code).toBe('identity.country_invalid');
  await noAccount(who);

  // Phone sign-up needs a text-message provider, which this build does not connect: refused by name, nothing made, and
  // no code mailed anywhere.
  await page.goto('/register');
  await page.getByRole('radio', { name: 'Phone' }).check();
  await page.getByLabel('Phone number, international format (+…)').fill('+491701234567');
  await page.getByLabel('Handle').fill(who.handle);
  await page.getByLabel('Password').fill(who.password);
  await page.getByLabel('Country you live in').selectOption('DE');
  await page.getByLabel('Date of birth').fill('1990-05-01');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(notice(page)).toContainText(
    'Phone sign-up needs a text-message provider, which is not connected in this build. Use email instead.',
  );
  expect(mailedCodes(who.email)).toHaveLength(0);
  await noAccount(who);

  // With the owner's sign-up closed, the same good record is refused in words and nothing is made.
  registration(false);
  try {
    await details(page, who);
    await expect(notice(page)).toContainText('Sign-up is closed right now. Nothing was created.', { timeout: 15_000 });
    await noAccount(who);
  } finally {
    registration(true);
  }

  // A good record goes on to the code step; still no account until the code is entered.
  await details(page, who);
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await noAccount(who);
});

test(`${J} #1 a Business account type signs up the same way and goes on to business verification after the code`, async ({ page }) => {
  const who = person();
  await signUpInBrowser(page, who, { accountType: 'business' });
  await expect(page).toHaveURL(/\/identbusiness/);
});

test(`${J} #2 a too-short password is refused with the rule in words before any account exists`, async ({ page }) => {
  const who = person();
  await page.goto('/register');
  await expect(page.getByText('At least 12 characters')).toBeVisible();
  await details(page, who, { password: 'short9' });
  await expect(notice(page)).toContainText('at least 12 characters');
  expect(mailedCodes(who.email)).toHaveLength(0);
  // A long enough password that is known from a breach (the stack's TEST breach list) is refused by name too.
  await details(page, who, { password: 'TEST-breached-password-0001' });
  await expect(notice(page)).toContainText('That password is known from a data breach. Choose a different one.');
  expect(mailedCodes(who.email)).toHaveLength(0);
  await noAccount(who);
});

test(`${J} #3 a social or wallet sign-in button says it needs an outside provider that is switched off, with the code`, async ({
  page,
}) => {
  for (const path of ['/register', '/login']) {
    for (const name of ['Continue with a social account', 'Continue with a wallet']) {
      await page.goto(path);
      await page.getByRole('button', { name }).click();
      const alert = page.getByRole('alert').filter({ hasText: 'outside sign-in provider' });
      await expect(alert).toContainText('switched off in this build');
      await expect(alert).toContainText('idp.social');
      await expect(page).toHaveURL(new RegExp(`${path}$`));
    }
  }
});

test(`${J} #4 "check your email" reads the same for a known address, and an early resend says the seconds left`, async ({ page }) => {
  const who = run.read().account;
  // The account made in #5 does not exist yet, so use a second TEST person who signs up fully first.
  const known = person();
  await details(page, known);
  await page.getByLabel('Code from the email').fill(await nextMailedCode(known.email));
  await page.getByRole('button', { name: 'Confirm and open my account' }).click();
  await page.waitForURL((url) => url.pathname !== '/register');
  await signOutBrowser(page.context());

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
  // Signed in: the top bar has the account menu and no sign-in link. Home's own cards may say "sign in" in their text
  // (the passkey card does), so only the top bar is read.
  const topBar = page.getByRole('banner');
  await expect(topBar.getByRole('button', { name: 'Account menu' })).toBeVisible();
  await expect(topBar.getByRole('link', { name: /sign in/i })).toHaveCount(0);

  // The same code a second time is refused, and makes no second session.
  const again = await fetch(`${EDGE}/api/identity/trpc/auth.signUpConfirm`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ flowId, code }),
  });
  expect(again.status).toBe(409);
  expect(JSON.stringify(await again.json())).toContain('identity.signup_code_used');
});

/** A TEST account whose email was never proved: made through the dev stack's direct register, as older accounts were. */
async function unprovedAccount() {
  const who = person();
  const res = await fetch(`${EDGE}/api/identity/trpc/auth.register`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, handle: who.handle, email: who.email, password: who.password, region: 'DE' }),
  });
  expect(res.status).toBe(200);
  return who;
}

async function signIn(page, who) {
  await page.goto('/login');
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function nextLink(email, seen) {
  const until = Date.now() + 20_000;
  for (;;) {
    const links = mailedConfirmLinks(email);
    if (links.length > seen) return links.at(-1);
    if (Date.now() > until) throw new Error(`no confirmation email reached the LOCAL-TEST outbox for ${email}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

test(`${J} #7 and #6 Account shows "verify your email", sends a link, and the opened link shows the email verified; opened again it is used`, async ({
  page,
}) => {
  const who = await unprovedAccount();
  await signIn(page, who);
  await page.goto('/uc/account');
  const banner = page.getByRole('region', { name: 'Verify your email address' });
  await expect(banner).toBeVisible();

  await banner.getByRole('button', { name: 'Send confirmation email' }).click();
  await expect(banner.getByRole('status')).toContainText('a confirmation link is on its way');
  // The person opens the link exactly as mailed.
  const link = await nextLink(who.email, 0);
  const token = new URL(link, 'http://x').searchParams.get('token');
  expect(link).toMatch(/^\/confirm-email\?token=/);
  await page.goto(link);
  // Opening the page spends nothing; the person presses Confirm. The token leaves the address bar.
  await expect(page).toHaveURL(/\/confirm-email$/);
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('heading', { name: 'Your email address is verified' })).toBeVisible();

  await page.goto('/uc/account');
  await expect(page.getByText('Your email address is verified.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Verify your email address' })).toHaveCount(0);

  // Step 6 on the same link, now used: a page that names it and the next step, never the token.
  await page.goto(link);
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('heading', { name: 'This link no longer works' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('send a new one');
  await expect(page.getByRole('link', { name: 'Go to Account' })).toBeVisible();
  expect(await page.content()).not.toContain(token);
});

test(`${J} #6 a confirmation link with no token or a wrong one is a page with the next step, not an error code`, async ({ page }) => {
  // The dead-link page: its name, the next step (send a new one from Account, with the link there), and no code at all.
  const deadLinkPage = async () => {
    await expect(page.getByRole('heading', { name: 'This link no longer works' })).toBeVisible();
    const notice = page.getByRole('alert');
    await expect(notice).toContainText('Sign in, open Account and send a new one.');
    await expect(notice.getByRole('link', { name: 'Go to Account' })).toHaveAttribute('href', '/uc/account');
    await expect(page.locator('.pub-page')).not.toContainText(/auth\.|email_confirm|\b(400|404|500)\b/);
    await expect(page.locator('[lang="zxx"]')).toHaveCount(0);
  };
  await page.goto('/confirm-email');
  await deadLinkPage();
  await page.goto('/confirm-email?token=not-a-real-token');
  const answered = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/auth.confirmEmail'));
  await page.getByRole('button', { name: 'Confirm' }).click();
  // Identity refused the token by its typed code; the page turns that into words and the next step.
  const refused = await (await answered).json();
  expect(refused.error?.data?.intafacedCode ?? refused.error?.data?.cause?.code).toBe('auth.email_confirm_invalid');
  await deadLinkPage();
  expect(await page.content()).not.toContain('not-a-real-token');
});

test(`${J} #7b asking for more confirmation emails than the hour allows says how long to wait, and nothing more is sent`, async ({
  page,
}) => {
  const who = await unprovedAccount();
  await signIn(page, who);
  await page.goto('/uc/account');
  const banner = page.getByRole('region', { name: 'Verify your email address' });
  for (let i = 0; i < 5; i++) {
    await banner.getByRole('button', { name: 'Send confirmation email' }).click();
    await expect(banner.getByRole('status')).toContainText('on its way');
  }
  await expect.poll(() => mailedConfirmLinks(who.email).length).toBe(5);
  await banner.getByRole('button', { name: 'Send confirmation email' }).click();
  await expect(banner.getByRole('alert')).toContainText(/You can ask again in \d+ min\./);
  await expect(banner.getByRole('alert')).toContainText('auth.email_confirm_rate_limited');
  expect(mailedConfirmLinks(who.email)).toHaveLength(5);
});

test(`${J} #7 a new sign-up code asked for before the interval is refused with the seconds left, and nothing more is sent`, async () => {
  const who = person();
  const started = await signUpStart(who);
  expect(started.status, JSON.stringify(started.data)).toBe(200);
  await expect.poll(() => mailedCodes(who.email).length, { timeout: 20_000 }).toBe(1);
  // Straight away, identity itself refuses the resend (the page's button is held, so it goes as the page would send it).
  const res = await fetch(`${EDGE}/api/identity/trpc/auth.signUpResend`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ flowId: started.result.flowId }),
  });
  const data = (await res.json()).error?.data;
  expect(data?.intafacedCode ?? data?.cause?.code ?? data?.code).toBe('identity.resend_too_soon');
  // The stack's TEST interval is 30 seconds: the wait left is in seconds, within it.
  expect(data.retryAfterSeconds).toBeGreaterThan(0);
  expect(data.retryAfterSeconds).toBeLessThanOrEqual(30);
  expect(mailedCodes(who.email)).toHaveLength(1);
});

test(`${J} #8 a verified, funded account with an email never proved is stopped at the trade room until it proves it`, async ({ page }) => {
  test.setTimeout(120_000);
  const who = await unprovedAccount();
  await signIn(page, who);
  // Identity verification and TEST funds, so the email is the only thing missing.
  await verify(page, who);
  expect(fund(who.email, 'USDT', '1000').tx).toBeTruthy();
  await signIn(page, who);

  // The room says it before the person tries, and links back to step 7.
  await page.goto(deskPath());
  const notice = page.getByRole('region', { name: 'Confirm your email to place orders' });
  await expect(notice).toBeVisible();
  await expect(notice.getByRole('link', { name: 'Confirm email' })).toHaveAttribute('href', '/uc/account');

  // Trying anyway: the order is refused in plain words, nothing rests and nothing is held.
  const price = await awayBid();
  await page.locator('[role=tab]', { hasText: /^Limit$/ }).click();
  await page.getByRole('textbox', { name: 'Price' }).nth(0).fill(price);
  await previewed(page, () => page.getByRole('textbox', { name: 'Amount' }).nth(0).fill('0.01'));
  await page.getByRole('button', { name: 'Buy BTC' }).click();
  await expect(reviewSheet(page)).toBeVisible();
  const placed = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/orders' && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Confirm buy' }).click();
  const answer = await placed;
  expect(answer.status()).toBe(403);
  expect(JSON.stringify(await answer.json())).toContain('trade.email_proof_required');
  await expect(page.getByText('Confirm your email first').first()).toBeVisible();
  expect(await openOrders(who)).toHaveLength(0);
  expect(held(await (await api(who)).balances(), 'USDT')).toBe(0n);

  // Security shows the same send-proof control as Account.
  await page.goto('/uc/safe');
  await expect(page.getByRole('region', { name: 'Verify your email address' })).toBeVisible();

  // Step 7 from the link: send, open the mailed link, confirm.
  await page.goto(deskPath());
  await page.getByRole('region', { name: 'Confirm your email to place orders' }).getByRole('link', { name: 'Confirm email' }).click();
  await expect(page).toHaveURL(/\/uc\/account$/);
  const banner = page.getByRole('region', { name: 'Verify your email address' });
  await banner.getByRole('button', { name: 'Send confirmation email' }).click();
  await page.goto(await nextLink(who.email, 0));
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('heading', { name: 'Your email address is verified' })).toBeVisible();

  // Proved: the notice is gone and the same order now rests.
  await page.goto(deskPath());
  await expect(page.getByRole('button', { name: 'Buy BTC' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Confirm your email to place orders' })).toHaveCount(0);
  await page.locator('[role=tab]', { hasText: /^Limit$/ }).click();
  await page.getByRole('textbox', { name: 'Price' }).nth(0).fill(price);
  await previewed(page, () => page.getByRole('textbox', { name: 'Amount' }).nth(0).fill('0.01'));
  await page.getByRole('button', { name: 'Buy BTC' }).click();
  await page.getByRole('button', { name: 'Confirm buy' }).click();
  await expect(reviewSheet(page)).toHaveCount(0);
  await expect.poll(async () => (await openOrders(who)).length, { timeout: 20_000 }).toBe(1);
  // Leave the book as it was: cancel the TEST order through the person's own API.
  const [open] = await openOrders(who);
  const gone = await (await api(who)).delete(`/api/v1/orders/${encodeURIComponent(open.id)}?symbol=${encodeURIComponent('BTC/USDT')}`);
  expect(gone.status).toBeLessThan(300);
});
