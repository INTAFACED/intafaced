import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { EDGE, ORIGIN, ROOT, mailedCodes, nextMailedCode, signOutBrowser, signUpInBrowser, staffFreeze, tool } from './stack.mjs';
import { PASSKEY_ORIGIN, addAuthenticator, addPasskey, forgetSession, nextCode, virtualAuthenticator } from './identity-factors.mjs';

// J-identity-02, in the running app (docs/roadmap/journeys.json): sign in, on a new device too. One test per step this
// build serves, titled "J-identity-02 #<n>". Every person here is a TEST person on the local stack, signed up through
// the browser (J-identity-01) with a fresh TEST password kept only in memory for the run.
const J = 'J-identity-02';

test.describe.configure({ mode: 'default' });

function person(prefix = 'js') {
  const handle = `${prefix}${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  return { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
}

/** A fresh TEST account, signed up in a throwaway browser context so the test's own page starts signed out. */
async function account(browser) {
  const who = person();
  const context = await browser.newContext();
  await signUpInBrowser(await context.newPage(), who);
  await context.close();
  return who;
}

async function fillSignIn(page, identifier, password) {
  await page.fill('input[name=identifier]', identifier);
  await page.fill('input[name=password]', password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
}

test(`${J} #1 signs in with the email or the handle and a password; an unknown name and a wrong password read the same`, async ({
  page,
  browser,
}) => {
  const who = await account(browser);
  await page.goto('/login');
  const refusal = page.getByTestId('failure');
  await fillSignIn(page, `nobody-${who.handle}@local-test.invalid`, who.password);
  await expect(refusal).toContainText('Those details did not work');
  await expect(refusal).toContainText('Check what you typed');
  const unknown = await refusal.textContent();
  await page.reload();
  await fillSignIn(page, who.email, `${who.password}-wrong`);
  await expect(refusal).toHaveText(unknown);
  // The handle with the password signs in, and so does the email with the password; identity answers both with the
  // same account.
  const signedInAs = async (identifier) => {
    const answered = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/auth.login'));
    await fillSignIn(page, identifier, who.password);
    const res = await answered;
    expect(res.status(), identifier).toBe(200);
    await expect(page).not.toHaveURL(/\/login/);
    return (await res.json()).result.data.userId;
  };
  const byHandle = await signedInAs(who.handle);
  await page.goto('about:blank');
  await signOutBrowser(page.context());
  await page.goto('/login');
  const byEmail = await signedInAs(who.email);
  expect(byEmail).toBe(byHandle);
  await page.goto('/uc/account');
  await expect(page).toHaveURL(/\/uc\/account$/);
});

test(`${J} #8 a private address while signed out goes to sign-in and back to that exact room; a reload keeps the sign-in`, async ({
  page,
  browser,
}) => {
  const who = await account(browser);
  const room = '/money?asset=BTC';
  await page.goto(room);
  // The room keeps its place and says why it is empty; its sign-in link carries the way back.
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
  await page.getByRole('main').getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/login\?redirect=/);
  await fillSignIn(page, who.email, who.password);
  await expect(page).toHaveURL(/\/money\?asset=BTC$/);
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toHaveCount(0);
  // A reload keeps the sign-in: the same room, still signed in, and identity still answers for this person.
  await page.reload();
  await expect(page).toHaveURL(/\/money\?asset=BTC$/);
  await expect(page.locator('input[name=password]')).toHaveCount(0);
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toHaveCount(0);
  await expect(page.getByRole('main').getByRole('link', { name: 'Sign in' })).toHaveCount(0);
});

test(`${J} #2 several wrong passwords give a typed lockout with the minutes left`, async ({ page, browser }) => {
  const who = await account(browser);
  await page.goto('/login');
  const refusal = page.getByTestId('failure');
  // The stack's TEST owner value: ten wrong passwords in fifteen minutes, then a pause.
  for (let i = 0; i < 10; i++) {
    await fillSignIn(page, who.email, `${who.password}-wrong-${i}`);
    await expect(refusal).toContainText('Those details did not work');
    await page.reload();
  }
  await fillSignIn(page, who.email, who.password);
  // Even the right password waits out the pause, and the page says how long.
  await expect(page.getByRole('alert')).toContainText(/Too many tries\. You can try again in \d+ min\./);
  await expect(page).toHaveURL(/\/login/);
});

/** Restarts identity with the sign-in challenge after `count` failures from an address, or the stack's TEST count. */
function challengeAfter(count) {
  const before = process.env.LOCAL_STACK_IDENTITY_SIGNIN_CHALLENGE_AFTER;
  if (count === null) delete process.env.LOCAL_STACK_IDENTITY_SIGNIN_CHALLENGE_AFTER;
  else process.env.LOCAL_STACK_IDENTITY_SIGNIN_CHALLENGE_AFTER = String(count);
  try {
    tool('local-test-stack.mjs', 'restart', 'identity');
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_IDENTITY_SIGNIN_CHALLENGE_AFTER;
    else process.env.LOCAL_STACK_IDENTITY_SIGNIN_CHALLENGE_AFTER = before;
  }
}

/** A raw `auth.login` from this machine's address, answering the status and the typed code (or `ok`). */
async function rawLogin(input) {
  const res = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await res.json();
  const data = body.error?.data;
  return { status: res.status, code: data ? (data.intafacedCode ?? data.cause?.code ?? data.code) : 'ok' };
}

test(`${J} #2 (I-signin-sessions-30): after the owner's count of failures from this address the next sign-in solves the self-hosted challenge; a used challenge is refused`, async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const who = await account(browser);
  // The owner's count, for this test: one failure from this address (TEST), then every sign-in from it needs a challenge.
  challengeAfter(1);
  try {
    await page.goto('/login');
    await fillSignIn(page, who.email, `${who.password}-wrong`);
    await expect(page.getByTestId('failure')).toContainText('Those details did not work');
    await page.reload();

    // Without a solved challenge the right password is refused by its code, the same for a name that does not exist.
    expect(await rawLogin({ identifier: who.email, password: who.password })).toEqual({ status: 403, code: 'auth.challenge_required' });
    expect(await rawLogin({ identifier: `nobody-${who.handle}@local-test.invalid`, password: who.password })).toEqual({
      status: 403,
      code: 'auth.challenge_required',
    });

    // The page solves the challenge in the browser, says so while it works, and signs in.
    const issued = page.waitForResponse((res) => new URL(res.url()).pathname.endsWith('/auth.challenge'));
    await fillSignIn(page, who.email, who.password);
    expect((await issued).status()).toBe(200);
    await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });

    // A challenge solved by hand works once; the same one again is refused.
    const res = await fetch(`${EDGE}/api/identity/trpc/auth.challenge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    const challenge = (await res.json()).result.data;
    expect(challenge.bits).toBe(12);
    let nonce = 0;
    const met = (digest, bits) => {
      for (let i = 0, left = bits; left > 0; i += 1, left -= 8) {
        if (left >= 8 ? digest[i] !== 0 : digest[i] >> (8 - left) !== 0) return false;
      }
      return true;
    };
    while (
      !met(
        createHash('sha256')
          .update(`signin:${challenge.token}:${nonce.toString(36)}`)
          .digest(),
        challenge.bits,
      )
    )
      nonce += 1;
    const proof = { token: challenge.token, nonce: nonce.toString(36) };
    expect((await rawLogin({ identifier: who.email, password: who.password, challenge: proof })).code).not.toMatch(/^auth\.challenge/);
    expect(await rawLogin({ identifier: who.email, password: who.password, challenge: proof })).toEqual({
      status: 403,
      code: 'auth.challenge_used',
    });
  } finally {
    challengeAfter(null);
  }
});

/** Ask for a sign-in code by email or handle on /login; answers with the newest code mailed to `email` (if any arrives). */
async function askForCode(page, identifier) {
  await page.getByLabel('Email or handle for the code').fill(identifier);
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  return page.getByRole('status').filter({ hasText: 'a 6-digit code is on its way' }).innerText();
}

test(`${J} #3 "send me a code" instead of a password: wrong codes lock, a used code is refused, an unknown name reads the same`, async ({
  page,
  browser,
}) => {
  const who = await account(browser);
  const other = await account(browser);
  const notice = () => page.getByRole('alert');
  await page.goto('/login');

  // An unknown name and a real one get the same step and the same words; only the real one is mailed.
  const unknownName = `nobody${who.handle}`;
  const forUnknown = await askForCode(page, unknownName);
  await page.getByRole('button', { name: 'Use a different email or handle' }).click();
  const forOther = await askForCode(page, other.handle);
  expect(forUnknown.replace(unknownName, 'X')).toBe(forOther.replace(other.handle, 'X'));

  // Five wrong codes lock this code, with the minutes left; then even the right one is refused.
  const otherCode = await nextMailedCode(other.email, 0, 20_000, 'login-code');
  const wrong = otherCode === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) {
    await page.getByLabel('Sign-in code from the email').fill(wrong);
    await page.getByRole('button', { name: 'Sign in with the code' }).click();
    await expect(notice()).toContainText(i < 4 ? 'That code is not right' : /Too many tries\. Try again in \d+ min\./);
  }
  await page.getByLabel('Sign-in code from the email').fill(otherCode);
  await page.getByRole('button', { name: 'Sign in with the code' }).click();
  await expect(notice()).toContainText(/Too many tries/);
  await expect(page).toHaveURL(/\/login/);

  // The person's own code signs in once, by email this time.
  await page.getByRole('button', { name: 'Use a different email or handle' }).click();
  const seen = mailedCodes(who.email, 'login-code').length;
  const asked = page.waitForResponse((res) => res.url().includes('auth.loginCodeRequest'));
  await askForCode(page, who.email);
  const { flowId } = (await (await asked).json()).result.data;
  const code = await nextMailedCode(who.email, seen, 20_000, 'login-code');
  await page.getByLabel('Sign-in code from the email').fill(code);
  await page.getByRole('button', { name: 'Sign in with the code' }).click();
  await expect(page).not.toHaveURL(/\/login/);

  // The same code on the same request, sent again from outside the browser, is refused and opens nothing.
  const reused = await fetch(`${EDGE}/api/identity/trpc/auth.loginWithCode`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ flowId, code }),
  });
  const body = await reused.json();
  expect(reused.status).toBe(401);
  expect(JSON.stringify(body)).toContain('auth.code_invalid');
  expect(JSON.stringify(body)).not.toContain('accessToken');
});

test(`${J} #5 a browser never used before is asked to authorise this device, by a signed-in session or a mailed code`, async ({
  browser,
}) => {
  let who = await account(browser);
  // A browser this account has never signed in on: no device cookie at all.
  const fresh = await browser.newContext();
  await fresh.clearCookies();
  const page = await fresh.newPage();
  const askDevice = async () => {
    const seen = mailedCodes(who.email, 'new-device-code').length;
    await page.goto('/login');
    await fillSignIn(page, who.email, who.password);
    await expect(page.getByRole('heading', { name: 'Authorise this device' })).toBeVisible({ timeout: 10_000 });
    return nextMailedCode(who.email, seen, 20_000, 'new-device-code');
  };
  const enter = async (code) => {
    await page.getByLabel('Device code from the email').fill(code);
    await page.getByRole('button', { name: 'Approve this device' }).click();
  };

  // Five wrong codes lock this request; even the right code is refused after that.
  const locked = await askDevice();
  const wrong = locked === '000000' ? '111111' : '000000';
  for (let i = 0; i < 4; i++) {
    await enter(wrong);
    await expect(page.getByRole('alert')).toContainText('That code is not right');
  }
  await enter(wrong);
  await expect(page.getByRole('alert')).toContainText('Too many wrong codes');
  await expect(page.getByLabel('Device code from the email')).toHaveCount(0);
  await page.getByRole('button', { name: 'Start over' }).click();

  // The wrong codes count against the account, not the request: starting over inside the window is refused with the
  // minutes left, so a fresh request never buys more guesses.
  await page.goto('/login');
  await fillSignIn(page, who.email, who.password);
  await expect(page.getByRole('alert')).toContainText(/Too many tries\. You can try again in \d+ min/);

  // Another account on this browser: the mailed code approves the browser and signs in.
  who = await account(browser);
  await enter(await askDevice());
  await expect(page).not.toHaveURL(/\/login/, { timeout: 10_000 });

  // Trusted now: signing in again on this browser asks nothing.
  await page.context().clearCookies({ name: 'ifc_rt' });
  await page.goto('/login');
  await fillSignIn(page, who.email, who.password);
  await expect(page).not.toHaveURL(/\/login/, { timeout: 10_000 });

  // A missing device cookie makes it a new device again.
  await page.context().clearCookies();
  await page.goto('/login');
  await fillSignIn(page, who.email, who.password);
  await expect(page.getByRole('heading', { name: 'Authorise this device' })).toBeVisible({ timeout: 10_000 });
  await fresh.close();
});

test(`${J} #5 a new device's sign-in waits until a signed-in session on a trusted device approves it`, async ({ browser }) => {
  test.setTimeout(180_000);
  const { totp } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));
  const who = person();
  // The trusted side: the TEST browser this account signed up on, signed in, with an authenticator for the step-up.
  const trustedContext = await browser.newContext();
  const trusted = await trustedContext.newPage();
  await signUpInBrowser(trusted, who);
  let { secret, step } = await addAuthenticator(trusted, totp);

  // A browser this account has never signed in on asks to authorise this device, and waits.
  const fresh = await browser.newContext();
  await fresh.clearCookies();
  const waiting = await fresh.newPage();
  await waiting.goto('/login');
  await fillSignIn(waiting, who.email, who.password);
  // The account has an authenticator, so its code comes first; only then is the browser itself asked about.
  let code;
  ({ code, step } = await nextCode(totp, secret, step));
  await waiting.fill('input[name=totp]', code);
  await fillSignIn(waiting, who.email, who.password);
  await expect(waiting.getByRole('heading', { name: 'Authorise this device' })).toBeVisible({ timeout: 10_000 });

  // The signed-in session sees the waiting sign-in and approves it, confirmed with its authenticator.
  await trusted.goto('/uc/safe');
  const card = trusted.locator('section.security__trusted-devices');
  await expect(card.getByRole('heading', { name: 'Waiting for your approval' })).toBeVisible({ timeout: 15_000 });
  const approve = card.getByRole('button', { name: /^Approve / });
  await expect(approve).toHaveCount(1);
  await approve.click();
  await expect(card.getByText('Confirm it is you. The waiting browser then signs in by itself.')).toBeVisible();
  ({ code, step } = await nextCode(totp, secret, step));
  await card.getByLabel('6-digit code from your authenticator app').fill(code);
  const approved = trusted.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/trustedDevices.approve'));
  await card.getByRole('button', { name: 'Confirm with code' }).click();
  expect((await approved).status()).toBe(200);
  await expect(card.getByRole('status').filter({ hasText: 'Approved.' })).toBeVisible();
  await expect(card.getByRole('heading', { name: 'Waiting for your approval' })).toHaveCount(0);

  // The waiting browser signs in by itself, with no code typed there, and is trusted from now on.
  await expect(waiting).not.toHaveURL(/\/login/, { timeout: 30_000 });
  // Signing in there again asks for the authenticator code, as every sign-in of this account does, but not about the
  // browser any more.
  // Signed out there (the session cookie and the tab's state go; the browser's own device cookie stays), and the page
  // shows it, so the sign-in below really happens.
  await waiting.context().clearCookies({ name: 'ifc_rt' });
  await waiting.evaluate(() => sessionStorage.clear());
  await waiting.goto('/uc/safe');
  await expect(waiting.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
  await waiting.goto('/login');
  ({ code, step } = await nextCode(totp, secret, step));
  await waiting.fill('input[name=totp]', code);
  await fillSignIn(waiting, who.email, who.password);
  await expect(waiting).not.toHaveURL(/\/login/, { timeout: 10_000 });
  await expect(waiting.getByRole('heading', { name: 'Authorise this device' })).toHaveCount(0);
  await fresh.close();
  await trustedContext.close();
});

test(`${J} #7 a frozen account is named after the right password, with the way to support; a wrong password names nothing`, async ({
  page,
  browser,
}) => {
  const who = await account(browser);
  await staffFreeze(who);
  await page.goto('/login');
  const refusal = page.getByTestId('failure');
  // A wrong password learns nothing about the account's state.
  await fillSignIn(page, who.email, `${who.password}-wrong`);
  await expect(refusal).toContainText('Those details did not work');
  await expect(refusal).not.toContainText('frozen');
  await page.reload();
  await fillSignIn(page, who.email, who.password);
  await expect(page.getByRole('alert')).toContainText('This account is frozen.');
  await expect(page.getByRole('alert')).toContainText('Only support can lift a freeze');
  await expect(page).toHaveURL(/\/login/);
  await page.getByRole('alert').getByRole('link', { name: 'Contact support' }).click();
  await expect(page).toHaveURL(/\/help/);
});

test.describe('passkeys', () => {
  test.use({ baseURL: PASSKEY_ORIGIN });

  test(`${J} #4 passkey sign-in by handle; an unknown handle and one without passkeys look the same until the prompt`, async ({
    page,
    browser,
  }) => {
    const bare = await account(browser);
    const who = person('pk');
    await virtualAuthenticator(page);
    await signUpInBrowser(page, who);
    await addPasskey(page);
    await forgetSession(page);

    const answers = [];
    for (const identifier of [`nobody-${who.handle}`, bare.handle]) {
      await page.goto('/login');
      await page.fill('input[name=identifier]', identifier);
      const options = page.waitForResponse((res) => res.url().includes('webauthn.authOptions'));
      await page.getByRole('button', { name: 'Use a passkey' }).click();
      const body = (await (await options).json()).result.data;
      // Both get a challenge and a list of credentials, so the browser prompt opens for each.
      expect(body.challenge).toBeTruthy();
      expect(body.allowCredentials.length).toBeGreaterThan(0);
      await expect(page.getByTestId('failure')).toBeVisible();
      answers.push(await page.getByTestId('failure').textContent());
    }
    expect(answers[1]).toBe(answers[0]);

    await page.goto('/login');
    await page.fill('input[name=identifier]', who.handle);
    await page.getByRole('button', { name: 'Use a passkey' }).click();
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.locator('input[name=password]')).toHaveCount(0);
  });

  test(`${J} #6 a second step: the authenticator code or a passkey; a code used twice is refused`, async ({ page, browser }) => {
    test.setTimeout(150_000);
    const { totp } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));
    const who = person('mf');
    await virtualAuthenticator(page);
    await signUpInBrowser(page, who);
    await addPasskey(page);
    // With a passkey on the account, changing its factors needs a session that passed one: sign in with it.
    await forgetSession(page);
    await page.goto('/login');
    await page.fill('input[name=identifier]', who.handle);
    await page.getByRole('button', { name: 'Use a passkey' }).click();
    await expect(page).not.toHaveURL(/\/login/);
    let { secret, step } = await addAuthenticator(page, totp);

    const fresh = await browser.newContext({ baseURL: PASSKEY_ORIGIN });
    const other = await fresh.newPage();
    await other.goto('/login');
    await fillSignIn(other, who.email, who.password);
    // The right password alone asks for the second step, on this page: the account's passkey, or the authenticator code
    // with the password again (I-signin-sessions-10).
    await expect(other.getByRole('alert')).toContainText(
      'Confirm with one of your passkeys, or enter your password again with the six-digit code from your authenticator app',
    );
    await expect(other).toHaveURL(/\/login/);
    let used;
    ({ code: used, step } = await nextCode(totp, secret, step));
    await other.fill('input[name=totp]', used);
    await fillSignIn(other, who.email, who.password);
    await expect(other).not.toHaveURL(/\/login/);
    await fresh.close();

    // The same code again, from another browser, is refused.
    const again = await browser.newContext({ baseURL: PASSKEY_ORIGIN });
    const third = await again.newPage();
    await third.goto('/login');
    await third.fill('input[name=totp]', used);
    await fillSignIn(third, who.email, who.password);
    await expect(third.getByRole('alert')).toContainText('That code did not work. Every code works only once');
    await expect(third).toHaveURL(/\/login/);
    await again.close();

    // A passkey is a second step on its own.
    await forgetSession(page);
    await page.goto('/login');
    await page.fill('input[name=identifier]', who.handle);
    await page.getByRole('button', { name: 'Use a passkey' }).click();
    await expect(page).not.toHaveURL(/\/login/);
  });
});
