// World: book, restart, stack
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { test, expect } from './journey.mjs';
import {
  api,
  DEVICE_KEY,
  EDGE,
  fromUnits,
  journeyState,
  mailedCodes,
  mailedConfirmLinks,
  nextMailedCode,
  ORIGIN,
  restartService,
  signOutBrowser,
  stackFile,
  tool,
  toUnits,
} from './stack.mjs';
import { reviewSheet, verify } from './desk.mjs';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { connectWhenAsked } from './dex.mjs';
import { testWalletKey } from './test-wallet.mjs';
import {
  continueInWallet,
  openVenueDesk,
  testDeposit,
  testVenue,
  venueBalance,
  venueForThisFile,
  venueInfo,
  venueRecord,
  walletDoorAct,
} from './venue.mjs';

// J-identity-01, in the running app (docs/roadmap/journeys.json): sign up with an email, get the code, land signed in.
// One test per step this build serves, titled "J-identity-01 #<n>". Every person here is a TEST person on the local
// stack; the codes are read from the stack's LOCAL-TEST mail outbox, as the person would read their inbox. The stack's
// TEST owner values: minimum age 18, sign-up closed for AQ, five wrong codes lock, a new code after 30 s, five
// confirmation emails an hour.
const J = 'J-identity-01';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });
// #8's trade room is the launch desk, the person's own venue account: svc-trade's user-venue door is on for this file.
venueForThisFile(test);

function person() {
  const handle = `ji${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  // A fresh TEST password per run, kept only in the run file (mode 600).
  return { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
}

async function details(
  page,
  who,
  { country = 'DE', subdivision, usPerson = false, dateOfBirth = '1990-05-01', password = who.password, accountType = 'Personal' } = {},
) {
  await page.goto('/register');
  // The person picks the account type and the channel, as the row says, rather than leaving the page's first choice.
  await page.getByRole('radio', { name: new RegExp(`^${accountType}\\b`) }).check();
  await page.getByRole('radio', { name: 'Email', exact: true }).check();
  await page.getByLabel('Email address', { exact: true }).fill(who.email);
  await page.getByLabel('Handle', { exact: true }).fill(who.handle);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel(/^Country you live in/).selectOption(country);
  if (subdivision) await page.getByLabel(/^Province or territory you live in/).selectOption(subdivision);
  // `null` leaves the US-person question unanswered.
  if (usPerson !== null) await page.getByRole('radio', { name: usPerson ? 'Yes, I am a US person' : 'No, I am not a US person' }).check();
  await page.getByLabel('Date of birth', { exact: true }).fill(dateOfBirth);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
}

/** The same details with the phone picked as the channel. */
async function phoneDetails(page, who, phone) {
  await page.goto('/register');
  await page.getByRole('radio', { name: /^Personal\b/ }).check();
  await page.getByRole('radio', { name: 'Phone', exact: true }).check();
  await page.getByLabel('Phone number, international format (+…)', { exact: true }).fill(phone);
  await page.getByLabel('Handle', { exact: true }).fill(who.handle);
  await page.getByLabel('Password', { exact: true }).fill(who.password);
  await page.getByLabel(/^Country you live in/).selectOption('DE');
  await page.getByRole('radio', { name: 'No, I am not a US person', exact: true }).check();
  await page.getByLabel('Date of birth', { exact: true }).fill('1990-05-01');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
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
      usPerson: false,
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
async function registration(open) {
  await restartService('identity', { LOCAL_STACK_IDENTITY_REGISTRATION: open ? undefined : 'closed' });
}

/** Identity restarted with no mail transport, as a build without a mail provider runs, or back on the stack's outbox. */
async function mail(on) {
  await restartService('identity', { LOCAL_STACK_IDENTITY_MAIL: on ? undefined : 'off' });
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

  // Under-age: identity's own answer is a typed refusal (the stack's TEST minimum age is 18), the page shows it in plain
  // words with its code, the code step never opens, no code is mailed for this sign-up and no account exists.
  let first = outbox();
  const young = await signUpStart(who, { dateOfBirth: '2015-01-01' });
  expect(young.status).toBe(403);
  expect(young.code).toBe('identity.underage');
  expect(young.message).toBe('You must be at least 18 to open an account.');
  await details(page, who, { dateOfBirth: '2015-01-01' });
  await expect(notice(page)).toContainText('You are under the minimum age to open an account. Nothing was created.');
  await expect(notice(page).locator('small')).toHaveText('identity.underage');
  await expect(page.getByRole('heading', { name: /Check your email/i })).toHaveCount(0);
  expect((await gainedSince(page, first)).filter((line) => line.includes(who.email) || line.includes(who.handle))).toEqual([]);
  await noAccount(who);

  // A blocked country (AQ, closed on the stack's TEST owner list): the same, by its own code.
  first = outbox();
  const blocked = await signUpStart(who, { country: 'AQ' });
  expect(blocked.status).toBe(403);
  expect(blocked.code).toBe('identity.region_blocked');
  expect(blocked.message).toBe('We cannot open accounts for this country right now.');
  await details(page, who, { country: 'AQ' });
  await expect(notice(page)).toContainText('We cannot open accounts for this country right now. Nothing was created.');
  await expect(notice(page).locator('small')).toHaveText('identity.region_blocked');
  await expect(page.getByRole('heading', { name: /Check your email/i })).toHaveCount(0);
  expect((await gainedSince(page, first)).filter((line) => line.includes(who.email) || line.includes(who.handle))).toEqual([]);
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
  await page.getByRole('radio', { name: 'Email', exact: true }).check();
  await page.getByLabel('Email address', { exact: true }).fill(who.email);
  await page.getByLabel('Handle', { exact: true }).fill(who.handle);
  await page.getByLabel('Password', { exact: true }).fill(who.password);
  await page.getByLabel(/^Country you live in/).evaluate((select) => {
    const stale = document.createElement('option');
    stale.value = 'XQ';
    stale.textContent = 'XQ (a country no longer listed)';
    select.append(stale);
  });
  await page.getByLabel(/^Country you live in/).selectOption('XQ');
  await page.getByRole('radio', { name: 'No, I am not a US person', exact: true }).check();
  await page.getByLabel('Date of birth', { exact: true }).fill('1990-05-01');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(notice(page)).toContainText('Choose the country you live in, and your nationality if you give one, from the list.');
  await expect(notice(page)).toContainText('identity.country_invalid');
  await expect(page.getByRole('heading', { name: /Check your email/i })).toHaveCount(0);
  await noAccount(who);

  // Phone sign-up needs a text-message provider, which this build does not connect: refused by name, nothing made, and
  // no code mailed anywhere. The outbox is the whole stack's, and other journeys mail their own codes meanwhile (run
  // 1130), so only the whole lines it gained are read, and none of them may name this sign-up.
  const phone = '+491701234567';
  first = outbox();
  await phoneDetails(page, who, phone);
  await expect(notice(page)).toContainText('Phone sign-up needs a text-message provider, which is not connected in this build.');
  await expect(notice(page)).toContainText('vendor.sms');
  const gained = await gainedSince(page, first);
  expect(gained.filter((line) => line.includes(who.handle) || line.includes(phone.slice(1)))).toEqual([]);
  await noAccount(who);

  // With the owner's sign-up closed, the same good record is refused in words and nothing is made.
  await registration(false);
  try {
    await details(page, who);
    await expect(notice(page)).toContainText('Sign-up is closed right now. Nothing was created.', { timeout: 15_000 });
    await expect(notice(page).locator('small')).toHaveText('identity.registration_closed');
    await expect(page.getByRole('heading', { name: /Check your email/i })).toHaveCount(0);
    await noAccount(who);

    // The owner's invited list (REGISTRATION_EMAIL_ALLOWLIST) opens a closed sign-up to the addresses on it: an invited
    // address goes on to the code step, and any other address still gets the same refusal.
    const invited = person();
    await restartService('identity', { LOCAL_STACK_IDENTITY_REGISTRATION: 'closed', LOCAL_STACK_IDENTITY_INVITED: invited.email });
    await details(page, who);
    await expect(notice(page)).toContainText('Sign-up is closed right now. Nothing was created.', { timeout: 15_000 });
    await expect(notice(page).locator('small')).toHaveText('identity.registration_closed');
    await noAccount(who);
    await details(page, invited);
    await expect(page.getByRole('heading', { name: 'Check your email', exact: true })).toBeVisible();
    await noAccount(invited);
  } finally {
    await registration(true);
  }

  // A good record, with its account type picked, goes on to the code step; still no account until the code is entered.
  await details(page, who, { accountType: 'Personal' });
  await expect(page.getByRole('heading', { name: 'Check your email', exact: true })).toBeVisible();
  await noAccount(who);
});

test(`${J} #1 a Business account type signs up the same way and goes on to business verification after the code`, async ({ page }) => {
  const who = person();
  await details(page, who, { accountType: 'Business' });
  await expect(page.getByRole('heading', { name: 'Check your email', exact: true })).toBeVisible();
  await page.getByLabel('Code from the email', { exact: true }).fill(await nextMailedCode(who.email));
  await page.getByRole('button', { name: 'Confirm and open my account', exact: true }).click();
  await expect(page).toHaveURL(/\/identbusiness/);
});

test(`${J} #2 a too-short or breached password is refused with the rule in words before any account exists; an unset screening list is named`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const who = person();
  await page.goto('/register');
  await expect(page.getByText(/At least 12 characters/)).toBeVisible();
  // The stack's TEST breach list is set, so the page says nothing about it being unset.
  await expect(page.getByText(/screening list is not set/i)).toHaveCount(0);
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
  await restartService('identity', { LOCAL_STACK_IDENTITY_BREACH_LIST: 'off' });
  try {
    // Identity may still be coming back up: open the page again until it has asked identity and shows the answer.
    await expect(async () => {
      await page.goto('/register');
      await expect(page.getByRole('status').filter({ hasText: 'screening list is not set' })).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 45_000 });
    await expect(page.getByRole('status').filter({ hasText: 'screening list is not set' })).toHaveText(
      'The breached-password screening list is not set in this build, so a new password is not checked against known data breaches.',
    );
    await expect(page.getByText(/At least 12 characters/)).toBeVisible();
  } finally {
    await restartService('identity', { LOCAL_STACK_IDENTITY_BREACH_LIST: undefined });
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
  await page.getByLabel('Code from the email', { exact: true }).fill(await nextMailedCode(known.email));
  await page.getByRole('button', { name: 'Confirm and open my account', exact: true }).click();
  await page.waitForURL((url) => url.pathname !== '/register');
  await signOutBrowser(page.context());

  await details(page, { ...person(), email: known.email });
  const forKnown = await page.getByRole('status').filter({ hasText: 'a 6-digit code is on its way' }).innerText();
  await details(page, who);
  const forNew = await page.getByRole('status').filter({ hasText: 'a 6-digit code is on its way' }).innerText();
  expect(forKnown.replace(known.email, 'X')).toBe(forNew.replace(who.email, 'X'));

  await expect(page.getByRole('button', { name: 'Send a new code', exact: true })).toBeDisabled();
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
  await expect(page.getByRole('radio', { name: 'Phone', exact: true })).toBeChecked();
  await expect(page.getByRole('radio', { name: /Email/i })).not.toBeChecked();
  await expect(page.getByRole('heading', { name: /Check your email/i })).toHaveCount(0);
  const gained = await gainedSince(page, first);
  expect(gained.filter((line) => line.includes(switcher.handle) || line.includes(phone.slice(1)))).toEqual([]);
  expect(mailedCodes(switcher.email)).toHaveLength(0);
  await noAccount(switcher);
  await notice(page).getByRole('button', { name: 'Use email instead', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Email', exact: true })).toBeChecked();
  await page.getByLabel('Email address', { exact: true }).fill(switcher.email);
  await page.getByLabel('Handle', { exact: true }).fill(switcher.handle);
  await page.getByLabel('Password', { exact: true }).fill(switcher.password);
  await page.getByLabel(/^Country you live in/).selectOption('DE');
  await page.getByRole('radio', { name: 'No, I am not a US person', exact: true }).check();
  await page.getByLabel('Date of birth', { exact: true }).fill('1990-05-01');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Check your email', exact: true })).toBeVisible();
  await expect.poll(() => mailedCodes(switcher.email).length, { timeout: 20_000 }).toBe(1);

  // With email switched off, the notice names it and no code is mailed; Email stays picked, nothing goes by phone, and
  // the person is offered the other channel to pick.
  const offline = person();
  await mail(false);
  try {
    await details(page, offline);
    await expect(notice(page)).toContainText('Email delivery is switched off in this build, so a sign-up code cannot be sent.', {
      timeout: 15_000,
    });
    await expect(notice(page)).toContainText('vendor.email');
    await expect(page.getByRole('radio', { name: 'Email', exact: true })).toBeChecked();
    await expect(notice(page)).toContainText('Nothing was switched to another channel: pick one yourself.');
    await expect(page.getByRole('radio', { name: 'Phone', exact: true })).toBeEnabled();
    await expect(page.getByRole('radio', { name: /Phone/i })).not.toBeChecked();
    await expect(page.getByLabel(/Code from the email/i)).toHaveCount(0);
    expect(mailedCodes(offline.email)).toHaveLength(0);
    await noAccount(offline);
  } finally {
    await mail(true);
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
    await page.getByLabel('Code from the email', { exact: true }).fill(wrong);
    await page.getByRole('button', { name: 'Confirm and open my account', exact: true }).click();
    await expect(notice(page)).toContainText(i < 4 ? 'That code is not right' : /Too many tries\. Try again in \d+ min\./);
  }
  await page.getByLabel('Code from the email', { exact: true }).fill(otherCode);
  await page.getByRole('button', { name: 'Confirm and open my account', exact: true }).click();
  await expect(notice(page)).toContainText('Too many tries');

  // The person's own sign-up: details, the newest mailed code, signed in on Home.
  const seen = mailedCodes(who.email).length;
  const started = page.waitForResponse((r) => r.url().includes('auth.signUpStart'));
  await details(page, who);
  const flowId = (await (await started).json()).result.data.flowId;
  const code = await nextMailedCode(who.email, seen);
  await page.getByLabel('Code from the email', { exact: true }).fill(code);
  await page.getByRole('button', { name: 'Confirm and open my account', exact: true }).click();
  await expect(page).toHaveURL(/\/home/);
  // Signed in: the top bar has the account menu and no sign-in link. Home's own cards may say "sign in" in their text
  // (the passkey card does), so only the top bar is read.
  const topBar = page.getByRole('banner');
  await expect(topBar.getByRole('button', { name: 'Account menu', exact: true })).toBeVisible();
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
  const banner = page.getByRole('region', { name: /Verify your email address/i });
  await expect(banner).toBeVisible();

  await banner.getByRole('button', { name: 'Send confirmation email', exact: true }).click();
  await expect(banner.getByRole('status')).toContainText('a confirmation code is on its way');
  const pin = await nextMailedCode(who.email, 0, 20_000, 'email-confirm');
  expect(pin).toMatch(/^\d{6}$/);

  // Asking again before the interval is refused with the seconds left, and nothing more is mailed.
  await banner.getByRole('button', { name: 'Send confirmation email', exact: true }).click();
  const early = banner.getByRole('alert');
  await expect(early).toContainText(/You can ask for a new one in \d+ s\./);
  await expect(early).toContainText('auth.email_confirm_resend_too_soon');
  const left = Number(/in (\d+) s\./.exec(await early.innerText())?.[1]);
  expect(left).toBeGreaterThan(0);
  expect(left).toBeLessThanOrEqual(CONFIRM_RESEND_SECONDS);
  await page.waitForTimeout(1_500);
  expect(mailedCodes(who.email, 'email-confirm')).toHaveLength(1);

  // A wrong code is refused in words; the code from the mail proves the address.
  await banner.getByLabel('Code from the email', { exact: true }).fill(pin === '000000' ? '111111' : '000000');
  await banner.getByRole('button', { name: 'Confirm code', exact: true }).click();
  await expect(banner.getByRole('alert')).toContainText('That code is not right.');
  await banner.getByLabel('Code from the email', { exact: true }).fill(pin);
  await banner.getByRole('button', { name: 'Confirm code', exact: true }).click();
  await expect(page.getByText('Your email address is verified.', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: /Verify your email address/i })).toHaveCount(0);

  // Read again from the service: still verified, no banner.
  await page.reload();
  await expect(page.getByText('Your email address is verified.', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: /Verify your email address/i })).toHaveCount(0);
});

test(`${J} #7 with email delivery switched off, sending the code from Account says so by name and nothing is sent`, async ({ page }) => {
  test.setTimeout(180_000);
  const who = await unprovedAccount();
  await mail(false);
  try {
    await signIn(page, who);
    await page.goto('/uc/account');
    const banner = page.getByRole('region', { name: /Verify your email address/i });
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await banner.getByRole('button', { name: 'Send confirmation email', exact: true }).click();
    const off = banner.getByRole('alert');
    await expect(off).toContainText('Email delivery is switched off in this build, so a confirmation code cannot be sent.');
    await expect(off).toContainText('vendor.email');
    await expect(banner.getByLabel(/Code from the email/i)).toHaveCount(0);
    expect(mailedCodes(who.email, 'email-confirm')).toHaveLength(0);
  } finally {
    await mail(true);
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
    await expect(alert.getByRole('link', { name: 'Go to Account', exact: true })).toHaveAttribute('href', '/uc/account');
    await expect(page.locator('[data-template="flow"]')).not.toContainText(/auth\.|email_confirm|\b(400|404|409|410|500)\b/);
    await expect(page.locator('[lang="zxx"]')).toHaveCount(0);
    expect(await page.content()).not.toContain(token);
  };

  // An old link: mailed, then left until it ran out (the stack's TEST fixture moves its times back).
  await page.goto('/uc/account');
  await page
    .getByRole('region', { name: 'Verify your email address', exact: true })
    .getByRole('button', { name: 'Send confirmation email', exact: true })
    .click();
  const old = await nextLink(who.email, 0);
  const oldToken = new URL(old, 'http://x').searchParams.get('token');
  expect(old).toMatch(/^\/confirm-email\?token=/);
  expect(tool('local-test-stack.mjs', 'expire-email-confirmations', who.email)).toContain('1 open email confirmation link(s)');
  await page.goto(old);
  // Opening the page spends nothing; the person presses Confirm. The token leaves the address bar.
  await expect(page).toHaveURL(/\/confirm-email$/);
  const expired = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/auth.confirmEmail'));
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  const expiredBody = await (await expired).json();
  expect(expiredBody.error?.data?.intafacedCode ?? expiredBody.error?.data?.cause?.code).toBe('auth.email_confirm_expired');
  await deadPage('This link has expired', oldToken);
  await expect(page.getByRole('alert')).toContainText('runs out after a while');

  // A used link: a new one (after the interval), used once to verify, then opened again from the same mail.
  await page.waitForTimeout(CONFIRM_RESEND_SECONDS * 1000 + 500);
  await page.goto('/uc/account');
  await page
    .getByRole('region', { name: 'Verify your email address', exact: true })
    .getByRole('button', { name: 'Send confirmation email', exact: true })
    .click();
  const fresh = await nextLink(who.email, 1);
  const freshToken = new URL(fresh, 'http://x').searchParams.get('token');
  await page.goto(fresh);
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your email address is verified', exact: true })).toBeVisible();
  await page.goto(fresh);
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await deadPage('This link was already used', freshToken);
  await expect(page.getByRole('alert')).toContainText('works once');
});

test(`${J} #6 a confirmation link with no token or a wrong one is a page with the next step, not an error code`, async ({ page }) => {
  // The dead-link page: its name, the next step (send a new one from Account, with the link there), and no code at all.
  const deadLinkPage = async () => {
    await expect(page.getByRole('heading', { name: 'This link no longer works', exact: true })).toBeVisible();
    const notice = page.getByRole('alert');
    await expect(notice).toContainText('Sign in, open Account and send a new one.');
    await expect(notice.getByRole('link', { name: 'Go to Account', exact: true })).toHaveAttribute('href', '/uc/account');
    await expect(page.locator('[data-template="flow"]')).not.toContainText(/auth\.|email_confirm|\b(400|404|500)\b/);
    await expect(page.locator('[lang="zxx"]')).toHaveCount(0);
  };
  await page.goto('/confirm-email');
  await deadLinkPage();
  await page.goto('/confirm-email?token=not-a-real-token');
  const answered = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/auth.confirmEmail'));
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
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
  const banner = page.getByRole('region', { name: /Verify your email address/i });
  for (let i = 0; i < 5; i++) {
    // Each ask waits out the interval between two mails, so only the hourly budget refuses the sixth.
    if (i > 0) await page.waitForTimeout(CONFIRM_RESEND_SECONDS * 1000 + 500);
    await banner.getByRole('button', { name: 'Send confirmation email', exact: true }).click();
    await expect(banner.getByRole('status')).toContainText('on its way');
    await expect(banner.getByRole('alert')).toHaveCount(0);
  }
  await page.waitForTimeout(CONFIRM_RESEND_SECONDS * 1000 + 500);
  await expect.poll(() => mailedConfirmLinks(who.email).length).toBe(5);
  await banner.getByRole('button', { name: 'Send confirmation email', exact: true }).click();
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

test(`${J} #8 a verified account with TEST money on its own venue account and an email never proved is stopped at the trade room until it proves it`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(240_000);
  const who = await unprovedAccount();
  await signIn(page, who);
  // Identity verification and TEST money on the person's own venue account (the launch desk; custody off our ledger holds
  // none of it), so the email is the only thing missing.
  await verify(page, who);
  const walletKey = testWalletKey();
  const owner = privateKeyToAccount(walletKey).address.toLowerCase();
  expect(await testDeposit(owner, 'USDC', '100', `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
  const wallet = await openVenueDesk(page, who, VENUE_DESK, walletKey);
  const signatures = () => wallet.requests.filter((r) => r.method === 'eth_signTypedData_v4').length;

  // The room says it before the person tries, and links back to step 7.
  const notice = page.getByRole('region', { name: 'Confirm your email to place orders', exact: true });
  await expect(notice).toBeVisible();
  await expect(notice.getByRole('link', { name: 'Confirm email', exact: true })).toHaveAttribute('href', '/uc/account');

  // Trying anyway: our door refuses the order in plain words before the wallet is asked; nothing rests and nothing is held.
  const price = await venueAwayBid();
  const asked = signatures();
  const refused = await confirmVenueBuy(page, price);
  expect(refused.status()).toBe(403);
  expect(JSON.stringify(await refused.json())).toContain('trade.email_proof_required');
  const outcome = page.getByTestId('venue-bottom').getByTestId('venue-outcome');
  await expect(outcome).toHaveText(
    'Confirm your email first: new orders wait until you confirm the email on this account. Refused before your wallet was asked; nothing was signed or sent.',
    { timeout: 20_000 },
  );
  await expect(outcome).toHaveAttribute('data-code', 'trade.email_proof_required');
  await expect(page.getByRole('dialog', { name: 'Check before you sign', exact: true })).toHaveCount(0);
  await stepPicture();
  expect(signatures()).toBe(asked);
  expect((await venueRecord(owner, '/open-orders')).value).toHaveLength(0);
  expect((await venueBalance(owner, 'USDC')).locked).toMatch(/^0(\.0+)?$/);

  // Security shows the same send-proof control as Account.
  await page.goto('/uc/safe');
  await expect(page.getByRole('region', { name: 'Verify your email address', exact: true })).toBeVisible();

  // Step 7 from the link: send, open the mailed link, confirm.
  await page.goto(VENUE_DESK);
  await page
    .getByRole('region', { name: 'Confirm your email to place orders', exact: true })
    .getByRole('link', { name: 'Confirm email', exact: true })
    .click();
  await expect(page).toHaveURL(/\/uc\/account$/);
  const banner = page.getByRole('region', { name: /Verify your email address/i });
  await banner.getByRole('button', { name: 'Send confirmation email', exact: true }).click();
  await page.goto(await nextLink(who.email, 0));
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your email address is verified', exact: true })).toBeVisible();

  // Proved: the notice is gone and the same order now rests on the person's own venue account.
  await page.goto(VENUE_DESK);
  await connectWhenAsked(page, page.getByTestId('venue-wallet-address'));
  await expect(page.getByRole('button', { name: 'Buy BTC', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: /Confirm your email to place orders/i })).toHaveCount(0);
  const placed = await confirmVenueBuy(page, price, { sign: true });
  expect(placed.status()).toBe(200);
  const key = placed.request().postDataJSON().intent.clientOrderKey;
  await expect(outcome).toContainText('Open on the venue.', { timeout: 20_000 });
  await expect.poll(async () => (await venueRecord(owner, '/open-orders')).value.length, { timeout: 20_000 }).toBe(1);
  // Leave the venue as it was: the person's own wallet cancels the TEST order through our door.
  await walletDoorAct(await api(who), privateKeyToAccount(walletKey), {
    intent: { kind: 'cancel_order', symbol: VENUE_SYMBOL, clientOrderKey: key },
  });
});

/** The launch desk: the stack's TEST venue market BTC/USDC on the person's own venue account (venue.mjs). */
const VENUE_DESK = '/trade/spot/BTC-USDC';
const VENUE_SYMBOL = 'BTC-USDC';

/** A TEST price half the venue's own best bid, on its tick: a buy there rests and never fills. */
async function venueAwayBid() {
  const { body } = await testVenue('/markets', {});
  const market = body.value.find((m) => m.symbol === VENUE_SYMBOL);
  expect(market, JSON.stringify(body).slice(0, 300)).toBeTruthy();
  const { id } = await venueInfo();
  // The TEST venue's own bid maker (venue-reads.mjs venueBook): the bid is read from the venue, never our engine.
  const bidder = privateKeyToAccount(keccak256(toHex('intafaced TEST venue maker bid'))).address.toLowerCase();
  const read = await testVenue('/open-orders', { account: { venueId: id, owner: bidder, subAccount: null } });
  expect(read.status, JSON.stringify(read.body).slice(0, 300)).toBe(200);
  const bids = read.body.value.filter((o) => o.symbol === VENUE_SYMBOL && o.side === 'buy').map((o) => toUnits(o.price));
  expect(bids.length, `the TEST venue has bids on ${VENUE_SYMBOL}`).toBeGreaterThan(0);
  const best = bids.reduce((x, y) => (y > x ? y : x));
  const tick = toUnits(market.tickSize);
  return fromUnits((best / 2n / tick) * tick);
}

/** A TEST limit buy of 0.001 BTC typed, reviewed and confirmed on the venue desk; the door's prepare answer. */
async function confirmVenueBuy(page, price, { sign = false } = {}) {
  await page.locator('[role=tab]', { hasText: /^Limit$/ }).click();
  const form = page.locator('form[data-testid="dk-form"][data-side="buy"]');
  await form.getByRole('textbox', { name: 'Price' }).fill(price);
  const preview = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/venue/preview' && r.request().method() === 'POST');
  await form.getByRole('textbox', { name: 'Amount' }).fill('0.001');
  await preview;
  await page.getByRole('button', { name: 'Buy BTC', exact: true }).click();
  await expect(reviewSheet(page)).toBeVisible();
  const prepared = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/venue/prepare' && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Confirm buy', exact: true }).click();
  if (sign) await continueInWallet(page);
  return prepared;
}

/** Identity restarted with no blocked list at all (no list, no rows, fail-closed on), or back on the stack's own list. */
async function screeningList(set) {
  await restartService('identity', { LOCAL_STACK_IDENTITY_SCREENING: set ? undefined : 'unset' });
}

/** Refused at the door: the code step never opens, nothing is mailed for this person and no account exists. */
async function nothingMade(page, who, first) {
  await expect(page.getByRole('heading', { name: /Check your email/i })).toHaveCount(0);
  expect((await gainedSince(page, first)).filter((line) => line.includes(who.email) || line.includes(who.handle))).toEqual([]);
  await noAccount(who);
}

test(`${J} #9 a blocked province is refused with its reason, a US person from their own answer, an unanswered question is refused, and a blank list says it is not set`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const who = person();

  // Canada with no province: identity cannot tell Ontario from Quebec, so it asks; the page offers the provinces.
  let first = outbox();
  const bare = await signUpStart(who, { country: 'CA' });
  expect(bare.code).toBe('identity.subdivision_required');
  await page.goto('/register');
  await page.getByLabel(/^Country you live in/).selectOption('CA');
  await expect(page.getByLabel(/^Province or territory you live in/).locator('option', { hasText: 'Ontario' })).toHaveCount(1);
  await expect(page.getByLabel(/^Province or territory you live in/).locator('option', { hasText: 'Quebec' })).toHaveCount(1);
  await details(page, who, { country: 'CA' });
  await expect(notice(page)).toContainText('Choose the province or territory you live in from the list. Nothing was created.');
  await expect(notice(page).locator('small')).toHaveText('identity.subdivision_required');
  await nothingMade(page, who, first);

  // A blocked province (Ontario, on the shipped launch list): refused identity.region_blocked with its reason in plain
  // words, by identity itself and on the page, and nothing is made.
  first = outbox();
  const ontario = await signUpStart(who, { country: 'CA', subdivision: 'CA-ON' });
  expect(ontario.status).toBe(403);
  expect(ontario.code).toBe('identity.region_blocked');
  expect(ontario.message).toBe('Ontario, Canada is not served at launch.');
  await details(page, who, { country: 'CA', subdivision: 'CA-ON' });
  await expect(notice(page)).toContainText(
    'We cannot open an account where you live. Ontario, Canada is not served at launch. Nothing was created.',
  );
  await expect(notice(page).locator('small')).toHaveText('identity.region_blocked');
  await nothingMade(page, who, first);

  // A US person living in Germany, where the owner's list blocks US persons: refused from their own answer.
  first = outbox();
  const american = await signUpStart(who, { usPerson: true });
  expect(american.status).toBe(403);
  expect(american.code).toBe('identity.us_person_blocked');
  expect(american.message).toContain('US citizens, green-card holders and US residents, wherever they live');
  await details(page, who, { usPerson: true });
  await expect(notice(page)).toContainText(
    'We cannot open accounts for US persons (US citizens, green-card holders and US residents, wherever they live). This is from your own answer. Nothing was created.',
  );
  await expect(notice(page).locator('small')).toHaveText('identity.us_person_blocked');
  await nothingMade(page, who, first);

  // The question left unanswered: refused, never taken as no, by identity and on the page.
  first = outbox();
  const unanswered = await signUpStart(who, { usPerson: undefined });
  expect(unanswered.status).toBe(400);
  expect(unanswered.code).toBe('identity.us_person_unanswered');
  await details(page, who, { usPerson: null });
  await expect(page.getByRole('radio', { name: /Yes, I am a US person/i })).not.toBeChecked();
  await expect(page.getByRole('radio', { name: /No, I am not a US person/i })).not.toBeChecked();
  await expect(notice(page)).toContainText('Answer whether you are a US person. We never take a blank answer as no. Nothing was created.');
  await expect(notice(page).locator('small')).toHaveText('identity.us_person_unanswered');
  await nothingMade(page, who, first);

  // With the owner's blocked list blank, sign-up refuses and says the list is not set; nothing is made.
  await screeningList(false);
  try {
    first = outbox();
    await details(page, who);
    await expect(notice(page)).toContainText('Sign-up is paused: the blocked-countries list is not set. Nothing was created.', {
      timeout: 15_000,
    });
    await expect(notice(page).locator('small')).toHaveText('identity.screening_unset');
    // No code step and nothing mailed. Sign-in is refused too while the list is blank (J-identity-22 #1), so whether an
    // account exists is asked once the list is back.
    await expect(page.getByRole('heading', { name: 'Check your email', exact: true })).toHaveCount(0);
    expect((await gainedSince(page, first)).filter((line) => line.includes(who.email) || line.includes(who.handle))).toEqual([]);
  } finally {
    await screeningList(true);
  }
  await noAccount(who);

  // A province that is served (Quebec), answered "not a US person", goes on to the code step: the blocks are the
  // blocked regions only.
  await details(page, who, { country: 'CA', subdivision: 'CA-QC', usPerson: false });
  await expect(page.getByRole('heading', { name: 'Check your email', exact: true })).toBeVisible({ timeout: 15_000 });
  await noAccount(who);
});
