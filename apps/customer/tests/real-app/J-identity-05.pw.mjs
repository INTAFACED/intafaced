import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import {
  DEVICE_KEY,
  EDGE,
  ORIGIN,
  ROOT,
  api,
  fund,
  json,
  mailedCodes,
  mailedLines,
  nextMailedCode,
  signUpInBrowser,
  toUnits,
} from './stack.mjs';
import { verify } from './desk.mjs';
import { PASSKEY_ORIGIN, addAuthenticator, addPasskey, nextCode, virtualAuthenticator } from './identity-factors.mjs';

// J-identity-05, in the running app (docs/roadmap/journeys.json): I lost my phone and got back in. One test per step,
// titled "J-identity-05 #<n>". Every person is a TEST person on the local stack, signed up through the browser
// (J-identity-01) with an authenticator app and its recovery codes set up from Security (J-identity-04). "The phone" is
// the browser that set the authenticator up; a lost phone is a fresh browser context, so the person signs in elsewhere.
// Steps whose screens are not built yet fail at their first check, on a short timeout.
const J = 'J-identity-05';

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
  const codes = (await page.getByTestId('security__recovery').getByTestId('recovery-codes').locator('li').allInnerTexts()).map((code) =>
    code.trim(),
  );
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
  await expect(other.getByTestId('security__authenticator').filter({ hasText: 'Recovery codes left' })).toContainText(
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
  test.setTimeout(180_000);
  const { who, codes } = await withAuthenticator(page);
  // No recovery codes left: each one is spent signing in with it (a sign-in on this TEST browser's device key), until
  // identity says none remain.
  const signInWith = (code) =>
    fetch(`${EDGE}/api/identity/trpc/auth.login`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password, totpCode: code }),
    }).then(json);
  for (const [i, code] of codes.entries()) {
    const spent = await signInWith(code);
    expect(spent.status, JSON.stringify(spent.body).slice(0, 300)).toBe(200);
    expect(spent.body.result.data.recoveryCodesLeft).toBe(codes.length - i - 1);
  }
  const seen = mailedLines(who.email, 'mfa-reset-started').length;
  const { context, page: other } = await startLockedOutReset(browser, who);
  // Every contact on file: this person's only contact is the proved email, which is told with the end of the wait. (A
  // phone number on file is named as not texted in this build: mfa-reset.pg.test.ts.)
  await expect(other.getByText('an email went to')).toBeVisible();
  await expect.poll(() => mailedLines(who.email, 'mfa-reset-started').length).toBeGreaterThan(seen);
  const until = mailedLines(who.email, 'mfa-reset-started')
    .at(-1)
    .match(/ until=(\S+)/)?.[1];
  expect(until).toMatch(/^\d{4}-\d\d-\d\dT/);
  // The page shows the same end of the wait as the mail, in this browser's clock.
  const shown = await other.evaluate((iso) => {
    const at = Date.parse(iso);
    const sameYear = new Date(at).getFullYear() === new Date().getFullYear();
    const options = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...(sameYear ? {} : { year: 'numeric' }) };
    return new Intl.DateTimeFormat('en-GB', options).format(at);
  }, until);
  await expect(other.getByRole('status').filter({ hasText: 'second step is being reset' })).toContainText(
    `Your second step is being reset. It waits until ${shown}.`,
  );
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
  await expect(page.getByTestId('security__authenticator').filter({ hasText: 'Recovery codes left' })).toBeVisible();
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
  const { who, codes, secret, step: enrolled } = await withAuthenticator(page);
  let step = enrolled;
  const oldCode = async () => {
    let code;
    ({ code, step } = await nextCode(totp, secret, step));
    return code;
  };

  // On the new phone: sign in with a recovery code, then replace the app from Security. The old app still works
  // until the new one is proved; recovery codes confirm it is them and each is spent.
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
  const card = other.getByTestId('security__authenticator').filter({ hasText: 'Recovery codes left' });
  // Until the new app is proved, the old one still works: its code confirms the replace, and a wrong code from the new
  // app is refused, which leaves the old app in place (its next code still confirms a fresh replace) and the new key unused.
  await card.getByRole('button', { name: 'Replace', exact: true }).click();
  await card.getByLabel('6-digit code or a recovery code').fill(await oldCode());
  await card.getByRole('button', { name: 'Confirm', exact: true }).click();
  const firstKey = (await card.locator('code').innerText()).trim();
  const right = totp(firstKey);
  await card.getByLabel('Code from the new app').fill(String((Number(right) + 1) % 1_000_000).padStart(6, '0'));
  await card.getByLabel('Next code or a recovery code').fill(await oldCode());
  const refused = other.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/totpManage.replaceConfirm'));
  await card.getByRole('button', { name: 'Replace authenticator app' }).click();
  const wrong = await (await refused).json();
  expect(wrong.error.data.intafacedCode ?? wrong.error.data.cause?.code ?? wrong.error.data.code).toBe('auth.mfa_invalid');
  await expect(card.getByText('Authenticator app replaced')).toHaveCount(0);
  await other.reload();
  // The old app's code still confirms it is them, so the refused attempt changed nothing; the fresh replace is then done
  // with recovery codes, as a person whose old phone is gone would.
  await card.getByRole('button', { name: 'Replace', exact: true }).click();
  await card.getByLabel('6-digit code or a recovery code').fill(await oldCode());
  await card.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(card.getByLabel('Code from the new app')).toBeVisible();
  await expect((await card.locator('code').innerText()).trim()).not.toBe(firstKey);
  await other.reload();
  await card.getByRole('button', { name: 'Replace', exact: true }).click();
  await card.getByLabel('6-digit code or a recovery code').fill(codes[1]);
  await card.getByRole('button', { name: 'Confirm', exact: true }).click();
  const key = (await card.locator('code').innerText()).trim();
  await card.getByLabel('Code from the new app').fill(totp(key));
  await card.getByLabel('Next code or a recovery code').fill(codes[2]);
  await card.getByRole('button', { name: 'Replace authenticator app' }).click();
  const told = card.locator('[data-testid="notice"][role=status]');
  await expect(told).toContainText('Authenticator app replaced');
  await expect(told).toContainText('The recovery code you used is spent');
  await expect(told).toContainText('Every other device was signed out (1)');

  // New recovery codes, shown once: none of the old ones, and gone from the page after "I saved them".
  const fresh = (await card.getByTestId('security__recovery').getByTestId('recovery-codes').locator('li').allInnerTexts()).map((code) =>
    code.trim(),
  );
  expect(fresh.length).toBeGreaterThan(1);
  for (const old of codes) expect(fresh).not.toContain(old);
  await card.getByLabel('I saved these codes somewhere safe').check();
  await card.getByRole('button', { name: 'I saved them' }).click();
  await expect(card.getByTestId('security__recovery')).toHaveCount(0);
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

/**
 * What the ledger itself holds free for `userId` (its `available` accounts at `user:<id>`), in units per asset, read
 * at svc-ledger's operator account search with founder a's session (second factor) carrying `admin:treasury`. A
 * frozen owner cannot sign in, so their balances are read as an operator reads them.
 */
async function ledgerFree(userId) {
  const { ctx, sessions } = await founders();
  const treasuryToken = await sessions.a.treasuryToken();
  const res = await fetch(`${ctx.url('ledger')}/operator/accounts?prefix=${encodeURIComponent(`user:${userId}`)}`, {
    headers: { authorization: `Bearer ${treasuryToken}` },
  });
  const text = await res.text();
  expect(res.status, text).toBe(200);
  const page = JSON.parse(text);
  expect(page.nextCursor, 'one page holds every account of one owner').toBeNull();
  const free = {};
  for (const row of page.accounts) {
    if (row.address !== `user:${userId}` || row.kind !== 'available') continue;
    free[row.assetId] = (free[row.assetId] ?? 0n) + toUnits(row.balance);
  }
  return free;
}

/** The free balance per asset the customer's own API answers, in units. */
async function apiFree(client) {
  const out = {};
  for (const [asset, b] of Object.entries(await client.balances())) out[asset] = toUnits(b.free);
  return out;
}

/** One identity call as a member of Support (founder `a` or `b` of the local stack), answering its data or its refusal. */
async function support(kind, procedure, input, founder = 'a') {
  const { ctx, sessions } = await founders();
  const res =
    kind === 'query'
      ? await ctx.edge.query('identity', procedure, input, sessions[founder].token)
      : await ctx.edge.mutate('identity', procedure, input, sessions[founder].token);
  return { status: res.status, data: res.json?.result?.data, json: res.json, text: res.text };
}

/** The one typed code a tRPC refusal carries. */
function typed(res) {
  const body = res.json?.error ?? res.json?.[0]?.error;
  return body?.data?.intafacedCode ?? body?.data?.cause?.code ?? null;
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

// The passkey steps need the passkey origin (the stack's relying party is localhost).
test.describe('factor notices', () => {
  test.use({ baseURL: PASSKEY_ORIGIN });

  test(`${J} #6 mail and inbox notices for each factor change`, async ({ page }) => {
    test.setTimeout(300_000);
    const totp = await totpOf();
    await virtualAuthenticator(page);
    const started = await withAuthenticator(page);
    const { who } = started;
    let { secret, step } = started;
    // Each change is mailed to the proved address saying what changed (I-signin-sessions-08), and its inbox row follows the
    // event, which svc-identity's outbox relay publishes within a few seconds: reload until it shows.
    const notified = async (change, title) => {
      await expect
        .poll(() => mailedLines(who.email, 'factor-changed').some((line) => line.includes(`change=${change}`)), { timeout: 20_000 })
        .toBe(true);
      await expect(async () => {
        await page.goto('/notifications');
        await expect(page.getByText(title, { exact: true }).first()).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 30_000 });
      await page.goto('/uc/safe');
    };
    const code = async () => {
      let next;
      ({ code: next, step } = await nextCode(totp, secret, step));
      return next;
    };
    /** Answers identity's "Confirm it is you" sheet with the next authenticator code. */
    const confirmSheet = async () => {
      const sheet = page.getByRole('dialog', { name: /confirm it’s you/i });
      await sheet.getByLabel('Authenticator code or recovery code').fill(await code());
      await sheet.getByRole('button', { name: 'Confirm', exact: true }).click();
      await expect(sheet).toBeHidden();
    };
    await notified('totp_added', 'Authenticator app turned on');

    // A passkey added, after "Confirm it is you" with the code.
    await page.getByRole('button', { name: 'Add passkey' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Add passkey' }).click();
    await page.getByTestId('failure').getByRole('button', { name: 'Confirm it is you' }).click();
    await confirmSheet();
    await expect(page.getByTestId('security__checklist').getByText('1 on this account')).toBeVisible();
    await notified('passkey_added', 'Passkey added');

    // The passkey removed.
    await page.getByRole('button', { name: /^Remove passkey / }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Remove passkey' }).click();
    // Removing a factor needs the second step first, as adding one did: confirm with the code, and the removal goes ahead.
    await page.getByTestId('failure').getByRole('button', { name: 'Confirm it is you' }).click();
    await confirmSheet();
    await expect(page.getByTestId('security__checklist').getByText('1 on this account')).toHaveCount(0);
    await notified('passkey_removed', 'Passkey removed');

    // The same session replaces the app: its "Confirm it is you" with the old app's code starts and finishes the replace.
    await page.goto('/uc/safe');
    await expect(page).not.toHaveURL(/\/login/);

    // The authenticator app replaced: the old app's code, the new app's code and the old app's next code.
    const card = page.locator('[data-testid="security__authenticator"][aria-label="Authenticator app"]');
    await card.getByRole('button', { name: 'Replace', exact: true }).click();
    await card.getByLabel('6-digit code or a recovery code').fill(await code());
    await card.getByRole('button', { name: 'Confirm', exact: true }).click();
    const setup = page
      .locator('[data-testid="security__authenticator"]')
      .filter({ hasText: 'Add this key to your new authenticator app, then enter the code it shows.' });
    await expect(setup).toHaveCount(1);
    const newKey = (await setup.locator('code').innerText()).trim();
    await setup.getByLabel('Code from the new app').fill(totp(newKey));
    await setup.getByLabel('Next code or a recovery code').fill(await code());
    await setup.getByRole('button', { name: 'Replace authenticator app' }).click();
    await expect(page.locator('[data-testid="notice"][role=status]').filter({ hasText: 'Authenticator app replaced' })).toBeVisible();
    await notified('totp_replaced', 'Authenticator app replaced');

    // The new app turned off, with its codes.
    secret = newKey;
    step = Math.floor(Date.now() / 30_000);
    await card.getByRole('button', { name: 'Turn off', exact: true }).click();
    await card.getByLabel('6-digit code or a recovery code').fill(await code());
    await card.getByRole('button', { name: 'Confirm', exact: true }).click();
    // Turning it off asks for the app's next code too.
    await card.getByLabel('Next code or a recovery code').fill(await code());
    await card.getByRole('button', { name: 'Turn off authenticator app' }).click();
    await expect(page.getByRole('button', { name: 'Start authenticator setup' })).toBeVisible();
    await notified('totp_removed', 'Authenticator app turned off');
  });
});

/**
 * #7 is served by two slices, one test each: RC-identity-07 (the owner sets recovery keys and names the account that
 * receives the balances) and RC-identity-08 (after a confirmed death notice, those keys claim the trading balances for
 * that account). The keys confirm with a passkey, so the steps run on the passkey origin. "People they trust" are the
 * holders of the keys the owner makes; staff never hold one and are refused by every recovery door.
 */
test.describe('recovery keys', () => {
  test.use({ baseURL: PASSKEY_ORIGIN });

  /** The owner, with a passkey, makes two keys for people they trust and names the heir; answers the key texts. */
  async function setUpRecovery(page, browser) {
    const heir = person('rh');
    const heirContext = await browser.newContext();
    await signUpInBrowser(await heirContext.newPage(), heir);
    await heirContext.close();

    const owner = person('rk');
    await signUpInBrowser(page, owner);
    await virtualAuthenticator(page);
    await addPasskey(page);
    await page.goto('/uc/safe');
    const card = page.getByTestId('security__recovery-keys');
    await expect(page.getByRole('heading', { name: 'Recovery keys' })).toBeVisible();
    await expect(card).toContainText('No recovery keys set. If something happens to you, your balances stay frozen.');
    await expect(card).toContainText('Only keys you set can move your trading balances. Staff will not sell or transfer them.');
    const keys = [];
    for (const holder of ['Sister', 'Friend']) {
      await card.getByLabel('Who will hold it').fill(holder);
      await card.getByRole('button', { name: 'Make a key' }).click();
      await expect(card).toContainText('Confirm to add this recovery key.');
      await card.getByRole('button', { name: 'Confirm with a passkey' }).click();
      await expect(card.getByRole('heading', { name: `Give this key to ${holder}` })).toBeVisible();
      keys.push(await card.locator('textarea').inputValue());
      await card.getByRole('button', { name: 'I have saved it' }).click();
    }
    await card.getByLabel('Their handle on INTAFACED').fill(`@${heir.handle}`);
    await card.getByLabel('How many keys must sign').fill('2');
    await card.getByRole('button', { name: 'Save who receives' }).click();
    await card.getByRole('button', { name: 'Confirm with a passkey' }).click();
    await expect(card).toContainText(`Ready: 2 of your 2 live keys together can move your balances to @${heir.handle}.`);
    return { owner, heir, keys, card };
  }

  test(`${J} #7 (RC-identity-07) recovery keys set earlier: the owner gives keys to people they trust and names who receives`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000);
    const { keys, card } = await setUpRecovery(page, browser);
    expect(keys).toHaveLength(2);
    for (const key of keys) expect(key).toMatch(/^INTAFACED-RECOVERY-KEY-1\.[A-Za-z0-9_-]+$/);
    // Revoking a key takes it out at once: the setup no longer reaches its threshold.
    await card.getByRole('button', { name: 'Revoke the key for Friend' }).click();
    await card.getByRole('button', { name: 'Confirm with a passkey' }).click();
    await expect(card).toContainText('Not ready. Missing: enough live keys.');
    await page.reload();
    await expect(card).toContainText('Revoked');
    await expect(card).toContainText('It no longer counts.');
  });

  test(`${J} #7 (RC-identity-08) after a confirmed death notice, the keys claim the trading balances for the named account`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(240_000);
    const { owner, heir, keys } = await setUpRecovery(page, browser);
    // The heir is a fully verified customer, so the bank answers them; the owner holds TEST balances before they die.
    const heirSetup = await browser.newContext();
    const heirSetupPage = await heirSetup.newPage();
    await heirSetupPage.goto('/login');
    await heirSetupPage.fill('input[name=identifier]', heir.email);
    await heirSetupPage.fill('input[name=password]', heir.password);
    await heirSetupPage.getByRole('button', { name: /^sign in$/i }).click();
    await expect(heirSetupPage).not.toHaveURL(/\/login/);
    await verify(heirSetupPage, heir);
    await heirSetup.close();
    const heirApi = await api(heir);
    const heirBefore = await apiFree(heirApi);
    const heirLedgerBefore = await ledgerFree(heirApi.userId);
    expect(fund(owner.email, 'USDT', '125').tx).toBeTruthy();
    expect(fund(owner.email, 'BTC', '0.02').tx).toBeTruthy();
    // Two staff confirm a death notice on the owner (RC-identity-02). Recording it changes nothing; without a second
    // person's approval it is not confirmed; with one, the account is frozen and nobody signs in to it.
    const found = await support('query', 'accountDirectory.search', { email: owner.email });
    const ownerId = found.data?.rows?.[0]?.id;
    expect(ownerId, found.text).toBeTruthy();
    const recorded = await support('mutate', 'deathNotice.record', {
      userId: ownerId,
      caseRef: `TEST-${owner.handle}`,
      reporterKind: 'executor',
      evidenceDocumentIds: [],
      receivedAt: new Date().toISOString(),
    });
    expect(recorded.data, recorded.text).toMatchObject({ status: 'received', userId: ownerId });
    const { noticeId } = recorded.data;
    // Before the claim, the ledger holds exactly the funded amounts free on the owner.
    const ownerBefore = await ledgerFree(ownerId);
    expect(ownerBefore.USDT).toBe(toUnits('125'));
    expect(ownerBefore.BTC).toBe(toUnits('0.02'));
    const alone = await support('mutate', 'deathNotice.confirm', { noticeId, approvalId: 'apr-none' });
    expect(typed(alone), alone.text).toBe('identity.death_notice_approval_required');
    const { gates, ctx, sessions } = await founders();
    const { approvalId } = await gates.twoPerson(ctx, sessions, { ...recorded.data.approvalProposal, policyVersion: 'local-test:v1' });
    const confirmed = await support('mutate', 'deathNotice.confirm', { noticeId, approvalId });
    expect(confirmed.data, confirmed.text).toMatchObject({ status: 'confirmed', approvedBy: expect.any(String) });
    expect(confirmed.data.approvedBy).not.toBe(confirmed.data.decidedBy);
    const ownerContext = await browser.newContext();
    const ownerPage = await ownerContext.newPage();
    await ownerPage.goto('/login');
    await ownerPage.fill('input[name=identifier]', owner.email);
    await ownerPage.fill('input[name=password]', owner.password);
    await ownerPage.getByRole('button', { name: /^sign in$/i }).click();
    await expect(ownerPage.getByRole('alert')).toContainText('This account is frozen.');
    await ownerContext.close();

    // Staff never hold a key and every recovery door refuses them. Founder a's own signed-in session is staff: it holds
    // the desk scopes and the customer scopes those doors ask for, so only the staff check can refuse it. Each door is
    // tried once and refused by its one typed code; then both sides' balances read exactly what they read before.
    const staffToken = sessions.a.token;
    const staffScopes = JSON.parse(Buffer.from(staffToken.split('.')[1], 'base64url').toString('utf8')).scopes;
    expect(staffScopes, 'a founder desk scope makes this session staff').toEqual(expect.arrayContaining(['admin:read']));
    expect(staffScopes, 'the scopes the recovery doors ask for').toEqual(
      expect.arrayContaining(['bank:read', 'bank:write', 'identity:read', 'identity:write']),
    );
    const someKey = { kty: 'EC', crv: 'P-256', x: randomBytes(32).toString('base64url'), y: randomBytes(32).toString('base64url') };
    const someSignature = { publicKey: someKey, signature: randomBytes(64).toString('base64url') };
    const asked = `staff-${owner.handle}`;
    // A one-key plan: the number of keys that must sign, not a screenshot tolerance.
    const oneKey = 1;
    const RECOVERY_ROUTERS = [
      ['bank', 'services/svc-bank/src/recovery/recovery.router.ts'],
      ['identity', 'services/svc-identity/src/recovery-keys-router.ts'],
    ];
    const RECOVERY_DOORS = [
      ['bank', 'query', 'recovery.estates', undefined, 'bank.recovery_staff_forbidden'],
      ['bank', 'mutate', 'recovery.claims.open', { ownerUserId: ownerId }, 'bank.recovery_staff_forbidden'],
      [
        'bank',
        'mutate',
        'recovery.claims.execute',
        { claimId: randomUUID(), signatures: [someSignature] },
        'bank.recovery_staff_forbidden',
      ],
      ['identity', 'query', 'recovery.keys.list', {}, 'identity.recovery_staff_forbidden'],
      [
        'identity',
        'mutate',
        'recovery.keys.add',
        { kind: 'key', label: 'staff', publicKey: someKey, clientRequestId: `${asked}-add` },
        'identity.recovery_staff_forbidden',
      ],
      [
        'identity',
        'mutate',
        'recovery.keys.revoke',
        { keyId: randomUUID(), clientRequestId: `${asked}-revoke` },
        'identity.recovery_staff_forbidden',
      ],
      [
        'identity',
        'mutate',
        'recovery.plan.set',
        { heirHandle: heir.handle, threshold: oneKey, clientRequestId: `${asked}-plan` },
        'identity.recovery_staff_forbidden',
      ],
    ];
    // Every door is on the list exactly once: the list matches the procedures the two recovery routers declare.
    for (const [service, file] of RECOVERY_ROUTERS) {
      const declared = (readFileSync(path.join(ROOT, file), 'utf8').match(/^\s+\w+:\s*\w*[pP]rocedure\b/gm) ?? []).length;
      const listed = RECOVERY_DOORS.filter(([s]) => s === service).map(([, , procedure]) => procedure);
      expect(new Set(listed).size, `${service}: each recovery door once`).toBe(listed.length);
      expect(listed.length, `${service}: the list holds every door ${file} declares`).toBe(declared);
    }
    await test.step('never staff: every recovery door refuses a staff session by its typed code', async () => {
      for (const [service, kind, procedure, input, code] of RECOVERY_DOORS) {
        const res = await ctx.edge[kind](service, procedure, input, staffToken);
        expect(typed(res), `${service} ${procedure}: ${res.text?.slice(0, 300)}`).toBe(code);
      }
      expect(await ledgerFree(ownerId)).toEqual(ownerBefore);
      expect(await ledgerFree(heirApi.userId)).toEqual(heirLedgerBefore);
      expect(await apiFree(heirApi)).toEqual(heirBefore);
    });

    // The heir opens the claim room from the bank, pastes the two keys, and the owner's free balances move to the
    // heir's main account. The keys sign in the browser; staff hold none.
    const heirContext = await browser.newContext();
    const heirPage = await heirContext.newPage();
    await heirPage.goto('/login');
    await heirPage.fill('input[name=identifier]', heir.email);
    await heirPage.fill('input[name=password]', heir.password);
    await heirPage.getByRole('button', { name: /^sign in$/i }).click();
    await expect(heirPage).not.toHaveURL(/\/login/);
    await heirPage.goto('/bank');
    await heirPage.getByRole('link', { name: /Recovery claim/ }).click();
    await expect(heirPage.getByRole('heading', { name: 'Recovery claim', level: 1 })).toBeVisible();
    await expect(heirPage.getByText(`Account of @${owner.handle}`)).toBeVisible();
    await expect(heirPage.getByText('2 of their 2 live keys must sign.')).toBeVisible();
    const moving = heirPage.getByTestId('recovery-sweepable');
    await expect(moving).toContainText('125 USDT');
    await expect(moving).toContainText('0.02 BTC');
    await heirPage.getByLabel('Recovery key 1').fill(keys[0]);
    await heirPage.getByLabel('Recovery key 2').fill(keys[1]);
    await heirPage.getByRole('button', { name: 'Sign and claim' }).click();
    const moved = heirPage.getByTestId('recovery-moved');
    await expect(moved).toContainText('Moved to your main account:', { timeout: 20_000 });
    await expect(moved).toContainText('125 USDT');
    await expect(moved).toContainText('0.02 BTC');
    await expect(moved).not.toContainText('Refused');
    await expect(heirPage.getByText('Nothing is left to move.')).toBeVisible();
    await expect(heirPage.getByText(/^Claimed /)).toBeVisible();
    // Balances, not the page: the heir gained exactly 125 USDT and 0.02 BTC, read both from their own API and from the
    // ledger, and the ledger holds nothing free on the owner in any asset.
    const heirAfter = await apiFree(heirApi);
    expect(heirAfter.USDT ?? 0n).toBe((heirBefore.USDT ?? 0n) + toUnits('125'));
    expect(heirAfter.BTC ?? 0n).toBe((heirBefore.BTC ?? 0n) + toUnits('0.02'));
    const heirLedgerAfter = await ledgerFree(heirApi.userId);
    expect(heirLedgerAfter.USDT ?? 0n).toBe((heirLedgerBefore.USDT ?? 0n) + toUnits('125'));
    expect(heirLedgerAfter.BTC ?? 0n).toBe((heirLedgerBefore.BTC ?? 0n) + toUnits('0.02'));
    const ownerAfter = await ledgerFree(ownerId);
    expect(ownerAfter, "the owner's USDT account is still read").toHaveProperty('USDT');
    expect(ownerAfter, "the owner's BTC account is still read").toHaveProperty('BTC');
    for (const [asset, units] of Object.entries(ownerAfter)) expect(units, `owner's free ${asset}`).toBe(0n);
    // Claiming again moves nothing twice.
    await heirPage.getByLabel('Recovery key 1').fill(keys[0]);
    await heirPage.getByLabel('Recovery key 2').fill(keys[1]);
    await heirPage.getByRole('button', { name: 'Sign and claim' }).click();
    await expect(heirPage.getByText('Nothing new to move. Everything free was moved already.')).toBeVisible({ timeout: 20_000 });
    // The second claim moved nothing, by balance: both sides read exactly what they read after the first.
    expect(await apiFree(heirApi)).toEqual(heirAfter);
    expect(await ledgerFree(heirApi.userId)).toEqual(heirLedgerAfter);
    expect(await ledgerFree(ownerId)).toEqual(ownerAfter);
    await heirContext.close();
  });
});
