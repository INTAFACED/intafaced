// World: none
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { test, expect } from './journey.mjs';
import { EDGE, ORIGIN, ROOT, mailedLines, signUpInBrowser, tool } from './stack.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';

// J-identity-03, in the running app (docs/roadmap/journeys.json): I forgot my password or my handle. One test per step,
// titled "J-identity-03 #<n>". Every person is a TEST person on the local stack, signed up through the browser
// (J-identity-01), and every mail is read from the stack's LOCAL-TEST outbox as the person would read their inbox. The
// stack's TEST owner values: a reset code lives ten minutes and three wrong codes lock the reset.
const J = 'J-identity-03';

test.describe.configure({ mode: 'default' });

function person(prefix = 'fp') {
  const handle = `${prefix}${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  return { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
}

/** A fresh TEST account, signed up in its own browser context, which stays open and signed in (an "other device"). */
async function account(browser) {
  const who = person();
  const device = await browser.newContext();
  const page = await device.newPage();
  await signUpInBrowser(page, who);
  return { who, device, page };
}

/** The reset codes mailed to `email`, oldest first. The mail carries the code in its link. */
function resetCodes(email) {
  return mailedLines(email, 'password-reset')
    .map((line) => /code=([^\s&]+)/.exec(line)?.[1])
    .filter(Boolean)
    .map(decodeURIComponent);
}

async function nextResetCode(email, seen) {
  await expect.poll(() => resetCodes(email).length, { timeout: 20_000 }).toBeGreaterThan(seen);
  return resetCodes(email).at(-1);
}

async function askReset(page, email) {
  await page.goto('/findPwd');
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'Send reset code' }).click();
  await expect(page.getByLabel('Code from the email')).toBeVisible();
  return page.getByRole('status').filter({ hasText: 'a code is on its way' }).innerText();
}

/**
 * Send the reset form and wait until it is no longer busy. The submit clears the last message at once (a discrete
 * React event), so the next check reads this attempt's message, never the previous one.
 */
async function submitReset(page, code, password, confirm = password) {
  await page.getByLabel('Code from the email').fill(code);
  await page.getByLabel('New password', { exact: true }).fill(password);
  await page.getByLabel('Repeat the new password').fill(confirm);
  await page.getByRole('button', { name: 'Save new password' }).click();
  await expect(page.getByRole('button', { name: 'Saving…' })).toHaveCount(0);
}

/** One raw reset request through Edge, as the page sends it; answers the status, the body and how long it took. */
async function timedReset(email) {
  const started = performance.now();
  const res = await fetch(`${EDGE}/api/identity/trpc/auth.requestPasswordReset`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const body = await res.text();
  return { status: res.status, body, ms: performance.now() - started };
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

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

test(`${J} #1 the find-password page answers with the same message and the same timing whether or not the account exists`, async ({
  page,
  browser,
}) => {
  const { who, device } = await account(browser);
  await device.close();
  const seen = resetCodes(who.email).length;
  const unknown = `nobody-${who.handle}@local-test.invalid`;
  const forUnknown = await askReset(page, unknown);
  const forKnown = await askReset(page, who.email);
  expect(forUnknown).toBe(forKnown);
  expect(forKnown).toContain('If an account uses this email, a code is on its way.');
  // Only the real account is mailed. The relay sends in order, so once the later request's code is out, the earlier
  // unknown address's job has been handled too: nothing reached it (the stack keeps no-account notices off).
  await nextResetCode(who.email, seen);
  expect(mailedLines(unknown, 'password-reset')).toHaveLength(0);
  expect(mailedLines(unknown, 'reset-no-account')).toHaveLength(0);

  // The same timing: identity's answer to a known address and to unknown ones, taken in turn, the same reply each time,
  // and their medians within 100 ms of each other (a few requests each, well inside the address's request budget).
  const known = [];
  const strangers = [];
  for (let i = 0; i < 4; i++) {
    const a = await timedReset(who.email);
    const b = await timedReset(`nobody-${i}-${who.handle}@local-test.invalid`);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body).toBe(a.body);
    known.push(a.ms);
    strangers.push(b.ms);
  }
  expect(Math.abs(median(known) - median(strangers)), `known ${known.join(',')} unknown ${strangers.join(',')}`).toBeLessThan(100);
});

test(`${J} #1 with mail switched off the find-password page names it, the same for every address, and sends nothing`, async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const { who, device } = await account(browser);
  await device.close();
  const unknown = `nobody-${who.handle}@local-test.invalid`;
  const before = resetCodes(who.email).length;
  mail(false);
  try {
    const answers = [];
    for (const email of [who.email, unknown]) {
      await page.goto('/findPwd');
      await page.getByLabel('Email address', { exact: true }).fill(email);
      await page.getByRole('button', { name: 'Send reset code' }).click();
      const off = page.getByRole('alert');
      await expect(off).toContainText('Email delivery is switched off in this build', { timeout: 15_000 });
      await expect(off).toContainText('vendor.email');
      // No code step opens: nothing was sent, so nothing is promised.
      await expect(page.getByRole('status').filter({ hasText: 'a code is on its way' })).toHaveCount(0);
      await expect(page.getByLabel('Code from the email')).toHaveCount(0);
      answers.push(await off.innerText());
    }
    expect(answers[1]).toBe(answers[0]);
    expect(resetCodes(who.email)).toHaveLength(before);
  } finally {
    mail(true);
  }
});

test(`${J} #2 the code step: three wrong codes lock the reset, and a used code is refused`, async ({ page, browser }) => {
  const { who, device } = await account(browser);
  await device.close();
  const seen = resetCodes(who.email).length;
  await askReset(page, who.email);
  const code = await nextResetCode(who.email, seen);
  const fresh = `TEST-${randomBytes(9).toString('base64url')}-new`;
  for (let i = 0; i < 3; i++) {
    await submitReset(page, `wrong-${i}-${code}`, fresh);
    await expect(page.getByRole('alert')).toContainText(i < 2 ? 'That code is not valid' : 'Too many attempts');
  }
  // Locked: even the right code is refused now.
  await submitReset(page, code, fresh);
  await expect(page.getByRole('alert')).toContainText('Too many attempts');

  // A second reset, used once, then refused.
  const other = await account(browser);
  await other.device.close();
  const before = resetCodes(other.who.email).length;
  await askReset(page, other.who.email);
  const good = await nextResetCode(other.who.email, before);
  await submitReset(page, good, fresh);
  await expect(page.getByRole('status').filter({ hasText: 'Your password has been changed' })).toBeVisible();
  await askReset(page, other.who.email);
  await submitReset(page, good, `${fresh}-again`);
  await expect(page.getByRole('alert')).toContainText('That code is not valid');
});

/** The reset links mailed to `email`, oldest first, as the person would open them from the mail. */
function resetLinks(email) {
  return mailedLines(email, 'password-reset')
    .map((line) => /link=(\S+)/.exec(line)?.[1])
    .filter(Boolean);
}

test(`${J} #2 the code page names its resend limit, and past it a new code is refused with the limit named and nothing mailed`, async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const { who, device } = await account(browser);
  await device.close();
  await askReset(page, who.email);
  // The stack's TEST owner value: ten reset mails per address an hour. The code page says so before it is reached.
  await expect(page.getByRole('main')).toContainText(/\b10\b[^.]*\bhour\b/);
  await expect.poll(() => resetCodes(who.email).length, { timeout: 20_000 }).toBe(1);
  // "Ask for a new code" up to the limit: each one mails a new code.
  for (let sent = 1; sent < 10; sent++) {
    await page.getByRole('button', { name: 'Ask for a new code' }).click();
    await page.getByRole('button', { name: 'Send reset code' }).click();
    await expect(page.getByLabel('Code from the email')).toBeVisible();
    await expect.poll(() => resetCodes(who.email).length, { timeout: 20_000 }).toBe(sent + 1);
  }
  // One more inside the hour is refused by the page, with the limit named, and no mail goes out.
  await page.getByRole('button', { name: 'Ask for a new code' }).click();
  await page.getByRole('button', { name: 'Send reset code' }).click();
  await expect(page.getByRole('alert')).toContainText(/\b10\b[^.]*\bhour\b/);
  await page.waitForTimeout(5_000);
  expect(resetCodes(who.email)).toHaveLength(10);
});

test(`${J} #2 opening the mailed link opens the code page with its code, and the reset completes from there`, async ({ page, browser }) => {
  const { who, device } = await account(browser);
  await device.close();
  const seen = resetLinks(who.email).length;
  await askReset(page, who.email);
  await expect.poll(() => resetLinks(who.email).length, { timeout: 20_000 }).toBeGreaterThan(seen);
  const link = resetLinks(who.email).at(-1);
  const code = await nextResetCode(who.email, 0);
  // A fresh tab, as a mail app opens it: the link alone carries the person to the code page.
  const tab = await (await browser.newContext()).newPage();
  await tab.goto(`/${link}`);
  await expect(tab.getByLabel('New password', { exact: true })).toBeVisible();
  const field = tab.getByLabel('Code from the email');
  if (await field.count()) await expect(field).toHaveValue(code);
  const fresh = `TEST-${randomBytes(9).toString('base64url')}-new`;
  await tab.getByLabel('New password', { exact: true }).fill(fresh);
  await tab.getByLabel('Repeat the new password').fill(fresh);
  await tab.getByRole('button', { name: 'Save new password' }).click();
  await expect(tab.getByRole('status').filter({ hasText: 'Your password has been changed' })).toBeVisible();
  await tab.context().close();
});

test(`${J} #3 the new password follows the rule: a short one is refused with the reason`, async ({ page, browser }) => {
  const { who, device } = await account(browser);
  await device.close();
  const seen = resetCodes(who.email).length;
  await askReset(page, who.email);
  const code = await nextResetCode(who.email, seen);
  // The rule is on the page before anything is typed, as the new password field's own description.
  await expect(page.getByLabel('New password', { exact: true })).toHaveAccessibleDescription(
    /At least 12 characters, up to 72 bytes\. Ordinary letters and digits count one each; accented letters and emoji count more\./,
  );
  await submitReset(page, code, 'short');
  await expect(page.getByRole('alert')).toContainText('Use at least 12 characters');
  // A password on the owner's breached list is refused by name (I-signin-sessions-04). Fails fast until it lands.
  await submitReset(page, code, 'TEST-breached-password-0001');
  await expect(page.getByRole('alert')).toContainText('known from a data breach', { timeout: 5_000 });
});

test(`${J} #4 signs in with the new password; the old one fails; every other device is signed out`, async ({ page, browser }) => {
  const { who, device, page: other } = await account(browser);
  const seen = resetCodes(who.email).length;
  await askReset(page, who.email);
  const code = await nextResetCode(who.email, seen);
  const fresh = `TEST-${randomBytes(9).toString('base64url')}-new`;
  await submitReset(page, code, fresh);
  await expect(page.getByRole('status').filter({ hasText: 'every device that was signed in has been signed out' })).toBeVisible();

  await page.getByRole('button', { name: 'Go to sign in' }).click();
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page.getByTestId('failure')).toContainText('Those details did not work');
  await page.fill('input[name=password]', fresh);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/);

  // The device that was signed in before the reset is signed out.
  await other.goto('/money');
  await expect(other.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
  await device.close();
});

test(`${J} #5 a forgotten handle is mailed to the stored address; the page never says whether the account exists`, async ({
  page,
  browser,
}) => {
  const { who, device } = await account(browser);
  await device.close();
  const ask = async (email) => {
    await page.goto('/findPwd');
    await page.getByRole('button', { name: 'I forgot my handle' }).click();
    await page.getByLabel('Email address for your handle').fill(email);
    await page.getByRole('button', { name: 'Email me my handle' }).click();
    return page.getByRole('status').filter({ hasText: 'its handle is on its way' }).innerText();
  };
  const forKnown = await ask(who.email);
  const forUnknown = await ask(`nobody-${who.handle}@local-test.invalid`);
  expect(forUnknown).toBe(forKnown);
  await expect
    .poll(() => mailedLines(who.email, 'handle-recovery').some((line) => line.includes(`handle=${who.handle}`)), { timeout: 20_000 })
    .toBe(true);
});

test(`${J} #6 a "your password was changed" notice by mail and in the inbox`, async ({ page, browser }) => {
  const { who, device } = await account(browser);
  await device.close();
  const seen = resetCodes(who.email).length;
  await askReset(page, who.email);
  const code = await nextResetCode(who.email, seen);
  const changed = `TEST-${randomBytes(9).toString('base64url')}-new`;
  await submitReset(page, code, changed);
  await expect(page.getByRole('status').filter({ hasText: 'Your password has been changed' })).toBeVisible();
  // The security notice (I-signin-sessions-08). Fails fast until it lands. This account set no anti-phishing code, so the
  // mail carries none.
  await expect.poll(() => mailedLines(who.email, 'password-changed').length, { timeout: 5_000 }).toBe(1);
  const notice = mailedLines(who.email, 'password-changed')[0];
  expect(notice).toContain('notice=password-changed');
  expect(notice).not.toContain('anti_phishing=');
  // And in the inbox: signed in with the new password, the security notice names the password change and links to
  // Security. It follows the event svc-identity's outbox relay publishes within a few seconds: reload until it shows.
  await page.goto('/login');
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', changed);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
  // The row itself: its title, its body and its link to Security.
  const row = page.getByTestId('nf-row').filter({ has: page.getByTestId('nf-title').getByText('Password changed', { exact: true }) });
  await expect(async () => {
    await page.goto('/notifications');
    await expect(row).toHaveCount(1, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await expect(row.getByTestId('nf-body')).toHaveText(
    'The password of your account was changed. If this was not you, reset it now, open Security, sign out everywhere and contact Support.',
  );
  await expect(row).toHaveAttribute('href', '/uc/safe');
});

test(`${J} #6 with an anti-phishing code set, the "your password was changed" mail carries it, and the inbox shows the notice`, async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const { totp } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));
  const { who, device, page: own } = await account(browser);
  // The person sets an anti-phishing code in Security, confirmed with an authenticator, as J-identity-04 #8 does.
  let { secret, step } = await addAuthenticator(own, totp);
  await own.goto('/uc/safe');
  const card = own.getByTestId('security__anti-phishing');
  const antiPhishing = `Owl${randomBytes(3).toString('hex')}`;
  await card.getByRole('button', { name: 'Set a code' }).click();
  await card.getByLabel('New code (4 to 20 letters and digits)').fill(antiPhishing);
  let code;
  ({ code, step } = await nextCode(totp, secret, step));
  await card.getByLabel('6-digit code from your authenticator app').fill(code);
  await card.getByRole('button', { name: 'Save with code' }).click();
  await expect(card.getByRole('status')).toHaveText('Anti-phishing code saved.');
  await device.close();

  const seen = resetCodes(who.email).length;
  await askReset(page, who.email);
  const reset = await nextResetCode(who.email, seen);
  const changed = `TEST-${randomBytes(9).toString('base64url')}-new`;
  await submitReset(page, reset, changed);
  await expect(page.getByRole('status').filter({ hasText: 'Your password has been changed' })).toBeVisible();
  // The mail: one "password changed" notice to the account's own address, with the code the person set.
  await expect.poll(() => mailedLines(who.email, 'password-changed').length, { timeout: 15_000 }).toBe(1);
  const notice = mailedLines(who.email, 'password-changed')[0];
  expect(notice).toContain('notice=password-changed');
  expect(notice).toContain(`anti_phishing=${antiPhishing}`);

  // And in the inbox, signed in with the new password and the authenticator.
  await page.goto('/login');
  ({ code, step } = await nextCode(totp, secret, step));
  await page.fill('input[name=totp]', code);
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', changed);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
  const row = page.getByTestId('nf-row').filter({ has: page.getByTestId('nf-title').getByText('Password changed', { exact: true }) });
  await expect(async () => {
    await page.goto('/notifications');
    await expect(row).toHaveCount(1, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await expect(row.getByTestId('nf-body')).toHaveText(
    'The password of your account was changed. If this was not you, reset it now, open Security, sign out everywhere and contact Support.',
  );
  await expect(row).toHaveAttribute('href', '/uc/safe');
});
