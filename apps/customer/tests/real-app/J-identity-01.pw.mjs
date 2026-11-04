import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { test, expect } from './journey.mjs';
import {
  DEVICE_KEY,
  EDGE,
  api,
  fund,
  journeyState,
  mailedCodes,
  mailedConfirmLinks,
  nextMailedCode,
  restartWith,
  signOutBrowser,
  stackFile,
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

async function details(page, who, { country = 'DE', dateOfBirth = '1990-05-01', password = who.password, accountType = 'Personal' } = {}) {
  await page.goto('/register');
  // The person picks the account type and the channel, as the row says, rather than leaving the page's first choice.
  await page.getByRole('radio', { name: new RegExp(`^${accountType}\\b`) }).check();
  await page.getByRole('radio', { name: 'Email' }).check();
  await page.getByLabel('Email address').fill(who.email);
  await page.getByLabel('Handle').fill(who.handle);
  await page.getByLabel('Password').fill(password);
  await page.getByLabel('Country you live in').selectOption(country);
  await page.getByLabel('Date of birth').fill(dateOfBirth);
  await page.getByRole('button', { name: 'Create account' }).click();
}

/** The same details with the phone picked as the channel. */
async function phoneDetails(page, who, phone) {
  await page.goto('/register');
  await page.getByRole('radio', { name: /^Personal\b/ }).check();
  await page.getByRole('radio', { name: 'Phone' }).check();
  await page.getByLabel('Phone number, international format (+…)').fill(phone);
  await page.getByLabel('Handle').fill(who.handle);
  await page.getByLabel('Password').fill(who.password);
  await page.getByLabel('Country you live in').selectOption('DE');
  await page.getByLabel('Date of birth').fill('1990-05-01');
  await page.getByRole('button', { name: 'Create account' }).click();
}

/** The LOCAL-TEST outbox as it is now, and the whole lines it gained since `first` (other journeys mail meanwhile). */
const outbox = () => (existsSync(stackFile('email-outbox.log')) ? readFileSync(stackFile('email-outbox.log'), 'utf8') : '');
async function gainedSince(page, first) {
  // Identity writes a queued mail to the file just after the request's commit; give it time to land, then read until
  // the file ends on a whole line.
  await page.waitForTimeout(3_000);
  let after = '';
  await expect
    .poll(() => {
      after = outbox();
      return after === '' || after.endsWith('\n');
    })
    .toBe(true);
  const before = first.lastIndexOf('\n') + 1;
  // The file only grows: what was there before is still there.
  expect(after.startsWith(first.slice(0, before)), 'the outbox kept what it held before').toBe(true);
  return after.slice(before).split('\n').filter(Boolean);
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
  return {
    status: res.status,
    result: body.result?.data,
    code: data?.intafacedCode ?? data?.cause?.code ?? data?.code,
    message: body.error?.message,
    data,
  };
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

/** Identity restarted with no mail transport, as a build without a mail provider runs, or back on the stack's outbox. */
function mail(on) {
  const before = process.env.LOCAL_STACK_IDENTITY_MAIL;
  if (on) delete process.env.LOCAL_STACK_IDENTITY_MAIL;
  else process.env.LOCAL_STACK_IDENTITY_MAIL = 'off';
  try {
    tool('local-test-stack.mjs', 'restart', 'identity');
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_IDENTITY_MAIL;
    else process.env.LOCAL_STACK_IDENTITY_MAIL = before;
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

test(`${J} #1 fills the form with channel, country, birth date and account type; under-age, blocked or unlisted country and closed sign-up are refused in plain words and nothing is made`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const who = person();
  run.reset({ account: who });

  await details(page, who, { dateOfBirth: '2015-01-01' });
  await expect(notice(page)).toContainText('under the minimum age');
  await expect(notice(page)).toContainText('Nothing was created');
  await noAccount(who);

  await details(page, who, { country: 'AQ' });
  await expect(notice(page)).toContainText('cannot open accounts for this country');
  await noAccount(who);

  // A country that is not on the list at all is refused by its own code and in plain words, and nothing is made. The
  // page's list holds only real countries, so this is a page whose list is out of date: it offers one more code (XQ),
  // the person picks it, and the page shows identity's refusal in words.
  const unlisted = await signUpStart(who, { country: 'XQ' });
  expect(unlisted.status).toBe(400);
  expect(unlisted.code).toBe('identity.country_invalid');
  expect(unlisted.message).toBe('Choose the country you live in from the list.');
  await page.goto('/register');
  await page.getByRole('radio', { name: /^Personal\b/ }).check();
  await page.getByRole('radio', { name: 'Email' }).check();
  await page.getByLabel('Email address').fill(who.email);
  await page.getByLabel('Handle').fill(who.handle);
  await page.getByLabel('Password').fill(who.password);
  await page.getByLabel('Country you live in').evaluate((select) => {
    const stale = document.createElement('option');
    stale.value = 'XQ';
    stale.textContent = 'XQ (a country no longer listed)';
    select.append(stale);
  });
  await page.getByLabel('Country you live in').selectOption('XQ');
  await page.getByLabel('Date of birth').fill('1990-05-01');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(notice(page)).toContainText('Choose the country you live in, and your nationality if you give one, from the list.');
  await expect(notice(page)).toContainText('identity.country_invalid');
  await expect(page.getByRole('heading', { name: 'Check your email' })).toHaveCount(0);
  await noAccount(who);

  // Phone sign-up needs a text-message provider, which this build does not connect: refused by name, nothing made, and
  // no code mailed anywhere. The outbox is the whole stack's, and other journeys mail their own codes meanwhile (run
  // 1130), so only the whole lines it gained are read, and none of them may name this sign-up.
  const phone = '+491701234567';
  const first = outbox();
  await phoneDetails(page, who, phone);
  await expect(notice(page)).toContainText('Phone sign-up needs a text-message provider, which is not connected in this build.');
  await expect(notice(page)).toContainText('vendor.sms');
  const gained = await gainedSince(page, first);
  expect(gained.filter((line) => line.includes(who.handle) || line.includes(phone.slice(1)))).toEqual([]);
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

  // A good record, with its account type picked, goes on to the code step; still no account until the code is entered.
  await details(page, who, { accountType: 'Personal' });
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await noAccount(who);
});

test(`${J} #1 a Business account type signs up the same way and goes on to business verification after the code`, async ({ page }) => {
  const who = person();
  await details(page, who, { accountType: 'Business' });
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await page.getByLabel('Code from the email').fill(await nextMailedCode(who.email));
  await page.getByRole('button', { name: 'Confirm and open my account' }).click();
  await expect(page).toHaveURL(/\/identbusiness/);
});

test(`${J} #2 a too-short or breached password is refused with the rule in words before any account exists; an unset screening list is named`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const who = person();
  await page.goto('/register');
  await expect(page.getByText('At least 12 characters')).toBeVisible();
  // The stack's TEST breach list is set, so the page says nothing about it being unset.
  await expect(page.getByText('screening list is not set')).toHaveCount(0);
  await details(page, who, { password: 'short9' });
  await expect(notice(page)).toContainText('at least 12 characters');
  expect(mailedCodes(who.email)).toHaveLength(0);
  // A long enough password that is known from a breach (the stack's TEST breach list) is refused by name too.
  await details(page, who, { password: 'TEST-breached-password-0001' });
  await expect(notice(page)).toContainText('That password is known from a data breach. Choose a different one.');
  expect(mailedCodes(who.email)).toHaveLength(0);
  await noAccount(who);

  // With the owner's breached-password list not set (identity restarted without it), the page says it is not set,
  // beside the password rule, before anything is typed.
  restartWith('identity', 'LOCAL_STACK_IDENTITY_BREACH_LIST', false);
  try {
    await expect
      .poll(
        async () => {
          await page.goto('/register');
          return page.getByRole('status').filter({ hasText: 'screening list is not set' }).count();
        },
        { timeout: 30_000 },
      )
      .toBe(1);
    await expect(page.getByRole('status').filter({ hasText: 'screening list is not set' })).toHaveText(
      'The breached-password screening list is not set in this build, so a new password is not checked against known data breaches.',
    );
    await expect(page.getByText('At least 12 characters')).toBeVisible();
  } finally {
    restartWith('identity', 'LOCAL_STACK_IDENTITY_BREACH_LIST', true);
  }
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

test(`${J} #4 "check your email" reads the same for a known address, an early resend says the seconds left, and a failed channel is not switched: the person picks another`, async ({
  page,
}) => {
  test.setTimeout(180_000);
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

  // A channel that fails is not switched for another by itself; the person picks another. Phone sign-up fails here (no
  // text-message provider): the notice names it, Phone stays picked, nothing is sent by any channel, and no account is
  // made. The person then picks Email themself, and only then is a code mailed.
  const switcher = person();
  const phone = '+491701234568';
  const first = outbox();
  await phoneDetails(page, switcher, phone);
  await expect(notice(page)).toContainText('Phone sign-up needs a text-message provider, which is not connected in this build.');
  await expect(notice(page)).toContainText('Nothing was sent by any other channel');
  await expect(page.getByRole('radio', { name: 'Phone' })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Email' })).not.toBeChecked();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toHaveCount(0);
  const gained = await gainedSince(page, first);
  expect(gained.filter((line) => line.includes(switcher.handle) || line.includes(phone.slice(1)))).toEqual([]);
  expect(mailedCodes(switcher.email)).toHaveLength(0);
  await noAccount(switcher);
  await notice(page).getByRole('button', { name: 'Use email instead' }).click();
  await expect(page.getByRole('radio', { name: 'Email' })).toBeChecked();
  await page.getByLabel('Email address').fill(switcher.email);
  await page.getByLabel('Handle').fill(switcher.handle);
  await page.getByLabel('Password').fill(switcher.password);
  await page.getByLabel('Country you live in').selectOption('DE');
  await page.getByLabel('Date of birth').fill('1990-05-01');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await expect.poll(() => mailedCodes(switcher.email).length, { timeout: 20_000 }).toBe(1);

  // With email switched off, the notice names it and no code is mailed; Email stays picked, nothing goes by phone, and
  // the person is offered the other channel to pick.
  const offline = person();
  mail(false);
  try {
    await details(page, offline);
    await expect(notice(page)).toContainText('Email delivery is switched off in this build, so a sign-up code cannot be sent.', {
      timeout: 15_000,
    });
    await expect(notice(page)).toContainText('vendor.email');
    await expect(page.getByRole('radio', { name: 'Email' })).toBeChecked();
    await expect(notice(page).getByRole('button', { name: 'Use phone instead' })).toBeVisible();
    await expect(page.getByLabel('Code from the email')).toHaveCount(0);
    expect(mailedCodes(offline.email)).toHaveLength(0);
    await noAccount(offline);
  } finally {
    mail(true);
  }
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

/** The stack's TEST interval between two confirmation mails (tooling/scripts/local-stack-services/identity.mjs). */
const CONFIRM_RESEND_SECONDS = 10;

test(`${J} #7 Account shows "verify your email", sends a code and the person types it: the email shows verified; an early resend says the seconds left`, async ({
  page,
}) => {
  const who = await unprovedAccount();
  await signIn(page, who);
  await page.goto('/uc/account');
  const banner = page.getByRole('region', { name: 'Verify your email address' });
  await expect(banner).toBeVisible();

  await banner.getByRole('button', { name: 'Send confirmation email' }).click();
  await expect(banner.getByRole('status')).toContainText('a confirmation code is on its way');
  const pin = await nextMailedCode(who.email, 0, 20_000, 'email-confirm');
  expect(pin).toMatch(/^\d{6}$/);

  // Asking again before the interval is refused with the seconds left, and nothing more is mailed.
  await banner.getByRole('button', { name: 'Send confirmation email' }).click();
  const early = banner.getByRole('alert');
  await expect(early).toContainText(/You can ask for a new one in \d+ s\./);
  await expect(early).toContainText('auth.email_confirm_resend_too_soon');
  const left = Number(/in (\d+) s\./.exec(await early.innerText())?.[1]);
  expect(left).toBeGreaterThan(0);
  expect(left).toBeLessThanOrEqual(CONFIRM_RESEND_SECONDS);
  await page.waitForTimeout(1_500);
  expect(mailedCodes(who.email, 'email-confirm')).toHaveLength(1);

  // A wrong code is refused in words; the code from the mail proves the address.
  await banner.getByLabel('Code from the email').fill(pin === '000000' ? '111111' : '000000');
  await banner.getByRole('button', { name: 'Confirm code' }).click();
  await expect(banner.getByRole('alert')).toContainText('That code is not right.');
  await banner.getByLabel('Code from the email').fill(pin);
  await banner.getByRole('button', { name: 'Confirm code' }).click();
  await expect(page.getByText('Your email address is verified.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Verify your email address' })).toHaveCount(0);

  // Read again from the service: still verified, no banner.
  await page.reload();
  await expect(page.getByText('Your email address is verified.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Verify your email address' })).toHaveCount(0);
});

test(`${J} #7 with email delivery switched off, sending the code from Account says so by name and nothing is sent`, async ({ page }) => {
  test.setTimeout(180_000);
  const who = await unprovedAccount();
  mail(false);
  try {
    await signIn(page, who);
    await page.goto('/uc/account');
    const banner = page.getByRole('region', { name: 'Verify your email address' });
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await banner.getByRole('button', { name: 'Send confirmation email' }).click();
    const off = banner.getByRole('alert');
    await expect(off).toContainText('Email delivery is switched off in this build, so a confirmation code cannot be sent.');
    await expect(off).toContainText('vendor.email');
    await expect(banner.getByLabel('Code from the email')).toHaveCount(0);
    expect(mailedCodes(who.email, 'email-confirm')).toHaveLength(0);
  } finally {
    mail(true);
  }
});

test(`${J} #6 an old link from a mail shows "link expired" and a used one "link used", each with the next step and no raw code`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const who = await unprovedAccount();
  await signIn(page, who);
  // The hosted page for a link that cannot be used: its own name, the next step, and no token or code anywhere.
  const deadPage = async (heading, token) => {
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('open Account and send a new one');
    await expect(alert.getByRole('link', { name: 'Go to Account' })).toHaveAttribute('href', '/uc/account');
    await expect(page.locator('.pub-page')).not.toContainText(/auth\.|email_confirm|\b(400|404|409|410|500)\b/);
    await expect(page.locator('[lang="zxx"]')).toHaveCount(0);
    expect(await page.content()).not.toContain(token);
  };

  // An old link: mailed, then left until it ran out (the stack's TEST fixture moves its times back).
  await page.goto('/uc/account');
  await page.getByRole('region', { name: 'Verify your email address' }).getByRole('button', { name: 'Send confirmation email' }).click();
  const old = await nextLink(who.email, 0);
  const oldToken = new URL(old, 'http://x').searchParams.get('token');
  expect(old).toMatch(/^\/confirm-email\?token=/);
  expect(tool('local-test-stack.mjs', 'expire-email-confirmations', who.email)).toContain('1 open email confirmation link(s)');
  await page.goto(old);
  // Opening the page spends nothing; the person presses Confirm. The token leaves the address bar.
  await expect(page).toHaveURL(/\/confirm-email$/);
  const expired = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/auth.confirmEmail'));
  await page.getByRole('button', { name: 'Confirm' }).click();
  const expiredBody = await (await expired).json();
  expect(expiredBody.error?.data?.intafacedCode ?? expiredBody.error?.data?.cause?.code).toBe('auth.email_confirm_expired');
  await deadPage('This link has expired', oldToken);
  await expect(page.getByRole('alert')).toContainText('runs out after a while');

  // A used link: a new one (after the interval), used once to verify, then opened again from the same mail.
  await page.waitForTimeout(CONFIRM_RESEND_SECONDS * 1000 + 500);
  await page.goto('/uc/account');
  await page.getByRole('region', { name: 'Verify your email address' }).getByRole('button', { name: 'Send confirmation email' }).click();
  const fresh = await nextLink(who.email, 1);
  const freshToken = new URL(fresh, 'http://x').searchParams.get('token');
  await page.goto(fresh);
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('heading', { name: 'Your email address is verified' })).toBeVisible();
  await page.goto(fresh);
  await page.getByRole('button', { name: 'Confirm' }).click();
  await deadPage('This link was already used', freshToken);
  await expect(page.getByRole('alert')).toContainText('works once');
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
  test.setTimeout(120_000);
  const who = await unprovedAccount();
  await signIn(page, who);
  await page.goto('/uc/account');
  const banner = page.getByRole('region', { name: 'Verify your email address' });
  for (let i = 0; i < 5; i++) {
    // Each ask waits out the interval between two mails, so only the hourly budget refuses the sixth.
    if (i > 0) await page.waitForTimeout(CONFIRM_RESEND_SECONDS * 1000 + 500);
    await banner.getByRole('button', { name: 'Send confirmation email' }).click();
    await expect(banner.getByRole('status')).toContainText('on its way');
    await expect(banner.getByRole('alert')).toHaveCount(0);
  }
  await page.waitForTimeout(CONFIRM_RESEND_SECONDS * 1000 + 500);
  await expect.poll(() => mailedConfirmLinks(who.email).length).toBe(5);
  await banner.getByRole('button', { name: 'Send confirmation email' }).click();
  await expect(banner.getByRole('alert')).toContainText(/You can ask again in \d+ min\./);
  await expect(banner.getByRole('alert')).toContainText('auth.email_confirm_rate_limited');
  expect(mailedConfirmLinks(who.email)).toHaveLength(5);
});

test(`${J} #4 a new sign-up code asked for before the interval is refused by identity itself with the seconds left, and nothing more is sent`, async () => {
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
