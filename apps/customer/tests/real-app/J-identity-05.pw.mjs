import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { ROOT, mailedCodes, mailedLines, nextMailedCode, signUpInBrowser } from './stack.mjs';
import { addAuthenticator } from './identity-factors.mjs';

// J-identity-05, in the running app (docs/roadmap/journeys.json): I lost my phone and got back in. One test per step,
// titled "J-identity-05 #<n>". Every person is a TEST person on the local stack, signed up through the browser
// (J-identity-01) with an authenticator app and its recovery codes set up from Security (J-identity-04). "The phone" is
// the browser that set the authenticator up; a lost phone is a fresh browser context, so the person signs in elsewhere.
// Steps whose screens are not built yet fail at their first check, on a short timeout.
const J = 'J-identity-05';
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });

function person(prefix = 'lp') {
  const handle = `${prefix}${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  return { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
}

let totpModule;
const totpOf = async () => (totpModule ??= (await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'))).totp);

/** A TEST person signed up on "the phone", with an authenticator app on; answers its recovery codes as Security shows them. */
async function withAuthenticator(page) {
  const who = person();
  await signUpInBrowser(page, who);
  const { secret, step } = await addAuthenticator(page, await totpOf());
  const codes = (await page.locator('.security__recovery .recovery-codes li').allInnerTexts()).map((code) => code.trim());
  expect(codes.length).toBeGreaterThan(1);
  return { who, secret, step, codes };
}

async function fillSignIn(page, who, code) {
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  if (code !== undefined) await page.fill('input[name=totp]', code);
  await page.getByRole('button', { name: /^sign in$/i }).click();
}

/** On a fresh browser (the phone is gone): the right password, and the page asks for the second step. */
async function atSecondStep(browser, who) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/login');
  await fillSignIn(page, who);
  await expect(page.getByRole('alert')).toContainText('Your password is right');
  return { context, page };
}

test(`${J} #1 a recovery code at the second step is accepted once and spent; the person is told how many remain`, async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const { who, codes } = await withAuthenticator(page);

  const { context, page: other } = await atSecondStep(browser, who);
  await other.getByRole('button', { name: 'Use a recovery code' }).click();
  await expect(other.getByLabel('Recovery code', { exact: true })).toBeVisible();
  await other.getByLabel('Recovery code', { exact: true }).fill(codes[0]);
  await fillSignIn(other, who);
  const told = other.getByRole('status').filter({ hasText: 'Signed in with a recovery code' });
  await expect(told).toContainText('That recovery code is now spent');
  await expect(told).toContainText(`Recovery codes left: ${codes.length - 1}`);
  await told.getByRole('button', { name: 'Continue' }).click();
  await expect(other).not.toHaveURL(/\/login/);
  // Security on the new browser counts the same.
  await other.goto('/uc/safe');
  await expect(other.locator('.security__authenticator').filter({ hasText: 'Recovery codes left' })).toContainText(
    `Recovery codes left: ${codes.length - 1}`,
  );
  await context.close();

  // The spent code is refused from another browser, the same way a wrong code is.
  const again = await atSecondStep(browser, who);
  await again.page.getByRole('button', { name: 'Use a recovery code' }).click();
  await again.page.getByLabel('Recovery code', { exact: true }).fill(codes[0]);
  await fillSignIn(again.page, who);
  await expect(again.page.getByRole('alert')).toContainText('That code did not work. Every code works only once');
  await expect(again.page).toHaveURL(/\/login/);
  await again.context.close();
});

test(`${J} #1, on a phone never used before: once the device is approved with the mailed code, the count shows`, async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const { who, codes } = await withAuthenticator(page);
  // No device cookie at all: the new phone has never signed in to this account.
  const context = await browser.newContext();
  await context.clearCookies();
  const other = await context.newPage();
  await other.goto('/login');
  await fillSignIn(other, who);
  await expect(other.getByRole('alert')).toContainText('Your password is right');
  await other.getByRole('button', { name: 'Use a recovery code' }).click();
  await other.getByLabel('Recovery code', { exact: true }).fill(codes[0]);
  const seen = mailedCodes(who.email, 'new-device-code').length;
  await fillSignIn(other, who);
  await expect(other.getByRole('heading', { name: 'Authorise this device' })).toBeVisible({ timeout: 10_000 });
  await other.getByLabel('Device code from the email').fill(await nextMailedCode(who.email, seen, 20_000, 'new-device-code'));
  await other.getByRole('button', { name: 'Approve this device' }).click();
  const told = other.getByRole('status').filter({ hasText: 'Signed in with a recovery code' });
  await expect(told).toContainText(`Recovery codes left: ${codes.length - 1}`);
  await told.getByRole('button', { name: 'Continue' }).click();
  await expect(other).not.toHaveURL(/\/login/);
  await context.close();
});

/**
 * At the second step with no codes to hand: "I lost my authenticator" starts the locked-out reset (I-signin-sessions-12):
 * the password again, then the code mailed to the proved address, and the wait begins.
 */
async function startLockedOutReset(browser, who) {
  const at = await atSecondStep(browser, who);
  await at.page.getByRole('button', { name: 'I lost my authenticator' }).click();
  await expect(at.page.getByRole('heading', { name: 'Reset your second step' })).toBeVisible();
  await expect(at.page.getByLabel('Email or handle')).toHaveValue(who.email);
  await at.page.getByLabel('Password', { exact: true }).fill(who.password);
  const seen = mailedCodes(who.email, 'mfa-reset-code').length;
  await at.page.getByRole('button', { name: 'Email me a code' }).click();
  await expect(at.page.getByRole('status').filter({ hasText: 'We emailed a 6-digit code' })).toBeVisible();
  await at.page.getByLabel('Code from the email').fill(await nextMailedCode(who.email, seen, 20_000, 'mfa-reset-code'));
  await at.page.getByRole('button', { name: 'Start the reset' }).click();
  await expect(at.page.getByRole('status').filter({ hasText: 'second step is being reset' })).toContainText('until');
  return at;
}

test(`${J} #2 with no recovery codes left, a locked-out reset tells every contact and shows the waiting time`, async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const { who } = await withAuthenticator(page);
  const seen = mailedLines(who.email, 'mfa-reset-started').length;
  const { context, page: other } = await startLockedOutReset(browser, who);
  // Every contact on file: this person's only contact is the proved email, which is told with the end of the wait. (A
  // phone number on file is named as not texted in this build: mfa-reset.pg.test.ts.)
  await expect(other.getByText('an email went to')).toBeVisible();
  await expect.poll(() => mailedLines(who.email, 'mfa-reset-started').length).toBeGreaterThan(seen);
  expect(mailedLines(who.email, 'mfa-reset-started').at(-1)).toMatch(/ until=\d{4}-\d\d-\d\dT/);
  // During the wait the password alone still does not get in.
  await other.getByRole('button', { name: 'Back to sign in' }).click();
  await fillSignIn(other, who);
  await expect(other.getByRole('alert')).toContainText('Your password is right');
  // A blank waiting setting refuses and points to Support: the stack sets it (TEST), so the refusal is proved in
  // apps/customer/src/features/public/mfa-reset.test.tsx and services/svc-identity/src/auth/mfa-reset.pg.test.ts.
  await context.close();
});

test(`${J} #3 a reset stops when cancelled from a signed-in session; otherwise it completes after the wait`, async ({ page, browser }) => {
  test.setTimeout(150_000);
  const { who } = await withAuthenticator(page);
  const first = await startLockedOutReset(browser, who);
  // The phone is still signed in: Security names the waiting reset and stops it.
  await page.goto('/uc/safe');
  await expect(page.getByRole('region', { name: 'Second step reset waiting' })).toContainText('removed after');
  const cancelled = mailedLines(who.email, 'mfa-reset-cancelled').length;
  await page.getByRole('button', { name: 'Stop this reset' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'The reset was stopped' })).toBeVisible();
  await expect.poll(() => mailedLines(who.email, 'mfa-reset-cancelled').length).toBeGreaterThan(cancelled);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Stop this reset' })).toHaveCount(0);
  await expect(page.locator('.security__authenticator').filter({ hasText: 'Recovery codes left' })).toBeVisible();
  await first.context.close();

  // Not cancelled: once the TEST wait (20 s, tooling/profiles/test-owner-values/identity.json) has passed, the password
  // alone signs in; the app and its codes are gone and every older session has ended.
  const second = await startLockedOutReset(browser, who);
  const done = mailedLines(who.email, 'mfa-reset-completed').length;
  await second.page.waitForTimeout(21_000);
  await second.page.getByRole('button', { name: 'Back to sign in' }).click();
  await fillSignIn(second.page, who);
  await expect(second.page).not.toHaveURL(/\/login/, { timeout: 15_000 });
  await expect.poll(() => mailedLines(who.email, 'mfa-reset-completed').length).toBeGreaterThan(done);
  await second.page.goto('/uc/safe');
  await expect(second.page.getByRole('button', { name: 'Start authenticator setup' })).toBeVisible();
  // The phone's session ended with the reset.
  await page.goto('/money');
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible({ timeout: 15_000 });
  await second.context.close();
});

test(`${J} #4 replacing the authenticator on the new phone ends the old device's sessions and shows new recovery codes once`, async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  const totp = await totpOf();
  const { who, codes } = await withAuthenticator(page);

  // On the new phone: sign in with a recovery code, then replace the app from Security. The old app is gone, so a
  // recovery code confirms it is them and a second one proves the old factor; each is spent.
  const { context, page: other } = await atSecondStep(browser, who);
  await other.getByRole('button', { name: 'Use a recovery code' }).click();
  await other.getByLabel('Recovery code', { exact: true }).fill(codes[0]);
  await fillSignIn(other, who);
  await other
    .getByRole('status')
    .filter({ hasText: 'Signed in with a recovery code' })
    .getByRole('button', { name: 'Open Security' })
    .click();
  await expect(other).toHaveURL(/\/uc\/safe/);
  const card = other.locator('.security__authenticator').filter({ hasText: 'Recovery codes left' });
  await card.getByRole('button', { name: 'Replace', exact: true }).click();
  await card.getByLabel('6-digit code or a recovery code').fill(codes[1]);
  await card.getByRole('button', { name: 'Confirm', exact: true }).click();
  const key = (await card.locator('code').innerText()).trim();
  await card.getByLabel('Code from the new app').fill(totp(key));
  await card.getByLabel('Next code or a recovery code').fill(codes[2]);
  await card.getByRole('button', { name: 'Replace authenticator app' }).click();
  const told = card.locator('.notice[role=status]');
  await expect(told).toContainText('Authenticator app replaced');
  await expect(told).toContainText('The recovery code you used is spent');
  await expect(told).toContainText('Every other device was signed out (1)');

  // New recovery codes, shown once: none of the old ones, and gone from the page after "I saved them".
  const fresh = (await card.locator('.security__recovery .recovery-codes li').allInnerTexts()).map((code) => code.trim());
  expect(fresh.length).toBeGreaterThan(1);
  for (const old of codes) expect(fresh).not.toContain(old);
  await card.getByLabel('I saved these codes somewhere safe').check();
  await card.getByRole('button', { name: 'I saved them' }).click();
  await expect(card.locator('.security__recovery')).toHaveCount(0);
  await expect(card).toContainText(`Recovery codes left: ${fresh.length}`);

  // The old phone's session has ended.
  await page.goto('/money');
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible({ timeout: 15_000 });

  // The new app's next code signs in, and an old recovery code no longer does.
  await context.close();
  const next = await atSecondStep(browser, who);
  await next.page.getByRole('button', { name: 'Use a recovery code' }).click();
  await next.page.getByLabel('Recovery code', { exact: true }).fill(codes[3]);
  await fillSignIn(next.page, who);
  await expect(next.page.getByRole('alert')).toContainText('That code did not work');
  await next.page.getByLabel('Recovery code', { exact: true }).fill(fresh[0]);
  await fillSignIn(next.page, who);
  await expect(next.page.getByRole('status').filter({ hasText: 'Signed in with a recovery code' })).toContainText(
    `Recovery codes left: ${fresh.length - 1}`,
  );
  await next.context.close();
});

let founderSessions;
/** The stack's founder sessions, signed in once for the file: Support's two people for the recovery case. */
function founders() {
  founderSessions ??= (async () => {
    const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
    const ctx = await gates.makeContext({ log: () => {} });
    return { gates, ctx, sessions: await gates.approverSessions(ctx) };
  })();
  // A failed sign-in is not kept: the next staff call signs in again.
  founderSessions.catch(() => {
    founderSessions = undefined;
  });
  return founderSessions;
}

/** One identity call as a member of Support (founder `a` or `b` of the local stack), answering its data or its refusal. */
async function support(kind, procedure, input, founder = 'a') {
  const { ctx, sessions } = await founders();
  const res =
    kind === 'query'
      ? await ctx.edge.query('identity', procedure, input, sessions[founder].token)
      : await ctx.edge.mutate('identity', procedure, input, sessions[founder].token);
  return { status: res.status, data: res.json?.result?.data, text: res.text };
}

test(`${J} #5 support recovery: a case with a mailed one-time link, a second approver, and the agent never sees the link`, async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  const { who } = await withAuthenticator(page);
  // The phone is gone: on a fresh browser the sign-in page's "I cannot sign in" says a person answers, and how.
  const lost = await browser.newContext();
  const elsewhere = await lost.newPage();
  await elsewhere.goto('/login');
  await elsewhere.getByRole('link', { name: 'I cannot sign in' }).click();
  await expect(elsewhere.getByRole('heading', { name: /a person answers/i })).toBeVisible();
  await expect(elsewhere.getByText('A second member of Support must approve the case.')).toBeVisible();

  // Support finds the account and opens a case: the masked address and live sessions, no link yet.
  const found = await support('query', 'accountDirectory.search', { email: who.email });
  const userId = found.data?.rows?.[0]?.id;
  expect(userId, found.text).toBeTruthy();
  const opened = await support('mutate', 'supportRecovery.open', {
    userId,
    reason: 'TEST: lost phone and recovery codes, identity checked on a call',
    requestId: `j05-5-${who.handle}`,
  });
  expect(opened.data, opened.text).toMatchObject({ state: 'open', approvedBy: null, linkSentAt: null, contact: { emailProved: true } });
  expect(opened.data.contact.email).not.toBe(who.email);
  expect(opened.data.sessions.length).toBeGreaterThan(0);
  expect(mailedLines(who.email, 'support-recovery')).toHaveLength(0);

  // Without a second approver no link is made.
  const alone = await support('mutate', 'supportRecovery.sendLink', { caseId: opened.data.caseId, approvalId: 'apr-none' });
  expect(alone.status).toBe(412);
  expect(alone.text).toContain('identity.support_recovery_approval_required');
  expect(mailedLines(who.email, 'support-recovery')).toHaveLength(0);

  // The agent files the case's approval, a different person approves it, and the agent sends the link.
  const { gates, ctx, sessions } = await founders();
  const { approvalId } = await gates.twoPerson(ctx, sessions, { ...opened.data.approvalProposal, policyVersion: 'local-test:v1' });
  const sent = await support('mutate', 'supportRecovery.sendLink', { caseId: opened.data.caseId, approvalId });
  expect(sent.data, sent.text).toMatchObject({ state: 'link_sent', approvedBy: expect.any(String) });
  expect(sent.data.approvedBy).not.toBe(sent.data.openedBy);
  await expect.poll(() => mailedLines(who.email, 'support-recovery').length, { timeout: 20_000 }).toBe(1);
  const link = /\blink=(\S+)/.exec(mailedLines(who.email, 'support-recovery')[0])[1];
  const token = new URL(link, 'http://x').searchParams.get('token');
  // The agent never sees it: no answer of the case carries it.
  const watched = await support('query', 'supportRecovery.case', { caseId: opened.data.caseId });
  expect(watched.data.state).toBe('link_sent');
  expect(watched.text).not.toContain(token);
  expect(sent.text).not.toContain(token);

  // The person opens the link from the mail on the new phone and recovers the account.
  await elsewhere.goto(`/${link}`);
  await expect(elsewhere).toHaveURL(/\/recover-account$/);
  await elsewhere.getByRole('button', { name: 'Recover', exact: true }).click();
  await expect(elsewhere.getByRole('heading', { name: 'Your account is recovered' })).toBeVisible();
  // The old phone's sessions ended.
  await page.goto('/money');
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible({ timeout: 30_000 });
  expect((await support('query', 'supportRecovery.case', { caseId: opened.data.caseId })).data.state).toBe('used');

  // The link worked once.
  await elsewhere.goto(`/${link}`);
  await elsewhere.getByRole('button', { name: 'Recover', exact: true }).click();
  await expect(elsewhere.getByRole('heading', { name: 'This recovery link does not work' })).toBeVisible();

  // The password alone signs in now, and Security offers a new authenticator app. Recovery un-trusted every device, so
  // this one is approved with the code mailed to the proved address first.
  await elsewhere.goto('/login');
  const seen = mailedCodes(who.email, 'new-device-code').length;
  await fillSignIn(elsewhere, who);
  await expect(elsewhere.getByRole('heading', { name: 'Authorise this device' })).toBeVisible({ timeout: 10_000 });
  await elsewhere.getByLabel('Device code from the email').fill(await nextMailedCode(who.email, seen, 20_000, 'new-device-code'));
  await elsewhere.getByRole('button', { name: 'Approve this device' }).click();
  await elsewhere.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
  await elsewhere.goto('/uc/safe');
  await expect(elsewhere.getByRole('button', { name: 'Start authenticator setup' }).first()).toBeVisible({ timeout: 30_000 });
  await lost.close();
});

test(`${J} #6 mail and inbox notices for each factor change`, async ({ page }) => {
  test.setTimeout(120_000);
  const { who } = await withAuthenticator(page);
  // The mail to the proved address says what changed (I-signin-sessions-08).
  await expect
    .poll(() => mailedLines(who.email, 'factor-changed').some((line) => line.includes('change=totp_added')), { timeout: 20_000 })
    .toBe(true);
  // The inbox row follows the event, which svc-identity's outbox relay publishes within a few seconds: reload until it shows.
  await expect(async () => {
    await page.goto('/notifications');
    await expect(page.getByText('Authenticator app turned on')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
});

test(`${J} #7 recovery keys set earlier (people they trust, never staff) claim the account back`, async ({ page }) => {
  test.setTimeout(90_000);
  const who = person('rk');
  await signUpInBrowser(page, who);
  await page.goto('/uc/safe');
  await expect(page.getByRole('heading', { name: 'Recovery keys' })).toBeVisible(UNBUILT);
});
