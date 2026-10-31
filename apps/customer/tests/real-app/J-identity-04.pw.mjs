import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { test, expect } from './journey.mjs';
import { ROOT, mailedLines, signUpInBrowser } from './stack.mjs';
import { PASSKEY_ORIGIN, addAuthenticator, addPasskey, forgetSession, nextCode, virtualAuthenticator } from './identity-factors.mjs';
import { installTestWallet } from './test-wallet.mjs';

// J-identity-04, in the running app (docs/roadmap/journeys.json): I turn on two-factor sign-in and check my Security
// centre. Tests titled "J-identity-04 #<n>" prove a whole step; the others prove part of one and say which.
const J = 'J-identity-04';

test.describe.configure({ mode: 'default' });
test.use({ baseURL: PASSKEY_ORIGIN });

function person(prefix) {
  const handle = `${prefix}${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  return { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
}

test(`${J}, part of #2 and #3: with an authenticator on, adding a passkey asks to sign in again with the code, then adds`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { totp } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));
  const who = person('sp');
  await virtualAuthenticator(page);
  await signUpInBrowser(page, who);
  const { secret, step } = await addAuthenticator(page, totp);

  // This browser's sign-in has not passed the new second factor, so the service refuses before any change.
  await page.goto('/uc/safe');
  await page.getByRole('button', { name: 'Add passkey' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Add passkey' }).click();
  const refusal = page.getByTestId('failure');
  await expect(refusal).toContainText('Confirm it is you');
  await expect(refusal).toContainText('Confirm it is you with your authenticator code or a passkey');
  await expect(refusal).not.toContainText('Outcome not confirmed');
  await expect(page.getByTestId('security__passkeys')).toContainText('No passkeys yet');

  // Its link signs in again with the code and comes back to Security, where the passkey now adds.
  await refusal.getByRole('link', { name: 'Sign in again' }).click();
  await expect(page).toHaveURL(/\/login\?redirect=%2Fuc%2Fsafe/);
  const { code } = await nextCode(totp, secret, step);
  await page.fill('input[name=totp]', code);
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).toHaveURL(/\/uc\/safe$/);
  await addPasskey(page);
});

test(`${J}, part of #2: the refused passkey add goes ahead after the authenticator code in "Confirm it's you", without signing in again`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { totp } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));
  const who = person('su');
  await virtualAuthenticator(page);
  await signUpInBrowser(page, who);
  const { secret, step } = await addAuthenticator(page, totp);

  await page.goto('/uc/safe');
  await page.getByRole('button', { name: 'Add passkey' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Add passkey' }).click();
  const refusal = page.getByTestId('failure');
  await expect(refusal).toContainText('Confirm it is you');

  // The sheet asks for a fresh factor; the code buys one change, and the same add runs again on this page.
  await refusal.getByRole('button', { name: 'Confirm it is you' }).click();
  const sheet = page.getByRole('dialog', { name: /confirm it’s you/i });
  await expect(sheet).toContainText('This changes how you sign in');
  const { code } = await nextCode(totp, secret, step);
  await sheet.getByLabel('Authenticator code or recovery code').fill(code);
  await sheet.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(page).toHaveURL(/\/uc\/safe$/);
  await expect(page.getByTestId('security__passkeys')).not.toContainText('No passkeys yet');
  await expect(page.getByTestId('failure')).toHaveCount(0);
});

test(`${J} #3 adds a passkey, names it, adds a second; each shows its type and label; the name holds 64 characters at most, an empty one is refused, and no limit shows as "no limit set"`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const who = person('pn');
  await virtualAuthenticator(page);
  await signUpInBrowser(page, who);
  await addPasskey(page);

  const names = page.getByTestId('security__passkey-names');
  await expect(names).toContainText('No passkey limit is set.');
  await expect(names).toContainText('This device');
  await expect(names).toContainText('Unnamed passkey');

  // Renaming confirms with the passkey itself. The name field stops at 64 characters, and an empty name is refused
  // before anything is sent.
  await names.getByRole('button', { name: /^Rename passkey/ }).click();
  const name = names.getByLabel('Name (1 to 64 characters)');
  await name.fill('x'.repeat(70));
  expect((await name.inputValue()).length).toBeLessThanOrEqual(64);
  await name.fill('   ');
  await names.getByRole('button', { name: 'Save with a passkey' }).click();
  await expect(names.getByRole('alert')).toContainText('Use 1 to 64 characters');
  await name.fill('Work laptop');
  await names.getByRole('button', { name: 'Save with a passkey' }).click();
  await expect(names).toContainText('Name saved.');
  await expect(names).toContainText('Work laptop');

  // A second passkey from another authenticator. This sign-in has not passed a second factor, so the add asks
  // "Confirm it is you" first; the first passkey answers it.
  await virtualAuthenticator(page, 'usb');
  await page.getByRole('button', { name: 'Add passkey' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Add passkey' }).click();
  const refusal = page.getByTestId('failure');
  await expect(refusal).toContainText('Confirm it is you');
  await refusal.getByRole('button', { name: 'Confirm it is you' }).click();
  const sheet = page.getByRole('dialog', { name: /confirm it’s you/i });
  await sheet.getByRole('button', { name: 'Use a passkey' }).click();
  await expect(sheet).toBeHidden();
  // The names list follows the add on its own, with no refresh.
  await expect(names.getByTestId('security__row')).toHaveCount(2);
  await expect(names.locator('[data-testid="security__row"]', { hasText: 'Work laptop' })).toContainText('This device');
  await expect(names.locator('[data-testid="security__row"]', { hasText: 'Unnamed passkey' })).toContainText('Security key');
});

test(`${J} #1 Security opens on a checklist: each method, its status and why an open one matters; money out and security changes are always "Required"`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { totp } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));
  const who = person('cl');
  await virtualAuthenticator(page);
  await signUpInBrowser(page, who);

  await page.goto('/uc/safe');
  const checklist = page.getByTestId('security__checklist');
  const item = (name) => checklist.getByTestId('security__row').filter({ has: page.getByText(name, { exact: true }) });
  await expect(item('A second step at sign-in')).toContainText('To do');
  await expect(item('A second step at sign-in')).toContainText('anyone who learns it can sign in');
  // Each open method says why it matters, in its own words.
  await expect(item('A passkey')).toContainText('To do');
  await expect(item('A passkey')).toContainText('A passkey cannot be typed into a fake site, so phishing cannot take it.');
  await expect(item('An authenticator app')).toContainText('To do');
  await expect(item('An authenticator app')).toContainText('Six-digit codes from your phone still work when this device is lost.');
  await expect(item('Recovery codes saved')).toContainText('To do');
  await expect(item('Recovery codes saved')).toContainText('If you lose your phone, a recovery code is how you get back in.');
  // No owner policy is set on this stack: the floor actions still carry "Required", and nothing else does.
  await expect(checklist.getByText('Required', { exact: true })).toHaveCount(2);
  await expect(item('Moving money out')).toContainText('Required');
  await expect(item('Changing how you sign in or secure your account')).toContainText('Required');
  await expect(checklist).toContainText('The owner has not set further actions');
  await expect(checklist).toContainText('your password alone can change how you sign in, and money cannot move out');

  // Turning on an authenticator ticks it, the second step and its recovery codes, on the same page.
  const { secret, step } = await addAuthenticator(page, totp);
  await expect(item('An authenticator app')).toContainText('Done');
  await expect(item('A second step at sign-in')).toContainText('Done');
  await expect(item('Recovery codes saved')).toContainText('Done');
  // A done method no longer argues for itself; the open one still does.
  await expect(item('An authenticator app')).not.toContainText('Six-digit codes from your phone');
  await expect(item('A second step at sign-in')).not.toContainText('anyone who learns it can sign in');
  await expect(item('A passkey')).toContainText('To do');
  await expect(item('A passkey')).toContainText('phishing cannot take it');
  await expect(checklist).toContainText('Always needs a second step');

  // A passkey after "Confirm it is you" with the code ticks the last one.
  await page.getByRole('button', { name: 'Add passkey' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Add passkey' }).click();
  await page.getByTestId('failure').getByRole('button', { name: 'Confirm it is you' }).click();
  const sheet = page.getByRole('dialog', { name: /confirm it’s you/i });
  const { code } = await nextCode(totp, secret, step);
  await sheet.getByLabel('Authenticator code or recovery code').fill(code);
  await sheet.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(item('A passkey')).toContainText('Done');
  await expect(item('A passkey')).toContainText('1 on this account');
  await expect(checklist.getByText('To do', { exact: true })).toHaveCount(0);
});

test(`${J} #5 the first authenticator code turns it on; recovery codes show once with "I saved them", and nothing secret stays in the page`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { totp } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));
  const who = person('rc');
  await signUpInBrowser(page, who);
  const { secret } = await addAuthenticator(page, totp);

  // The codes appear once the authenticator works, each one usable once.
  const recovery = page.getByTestId('security__recovery');
  await expect(recovery).toContainText('Your recovery codes');
  const codes = await recovery.getByTestId('recovery-codes').locator('li').allInnerTexts();
  expect(codes).toHaveLength(10);
  for (const code of codes) expect(code).toMatch(/^[0-9A-Fa-f]{5}-[0-9A-Fa-f]{5}$/);
  await expect(
    page.locator('[data-testid="security__checklist"] [data-testid="security__row"]', { hasText: 'Recovery codes saved' }),
  ).toContainText(`${codes.length} left`);

  // "I saved them" takes the codes and the setup key off the page; neither was ever written to storage.
  const saved = recovery.getByRole('button', { name: 'I saved them' });
  await expect(saved).toBeDisabled();
  await recovery.getByLabel('I wrote these codes down or stored them somewhere safe').check();
  await saved.click();
  await expect(recovery).toHaveCount(0);
  const html = await page.content();
  for (const code of codes) expect(html).not.toContain(code);
  expect(html).not.toContain(secret);
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  for (const code of codes) expect(stored).not.toContain(code);
  expect(stored).not.toContain(secret);
  await expect(page.getByTestId('security__authenticator')).toContainText('Start authenticator setup');

  // After a reload the authenticator is still on, and the codes are never shown again: only how many are left.
  await page.reload();
  const checklist = page.getByTestId('security__checklist');
  await expect(
    checklist.getByTestId('security__row').filter({ has: page.getByText('An authenticator app', { exact: true }) }),
  ).toContainText('Done');
  await expect(checklist.getByTestId('security__row').filter({ hasText: 'Recovery codes saved' })).toContainText(`${codes.length} left`);
  await expect(page.getByTestId('security__recovery')).toHaveCount(0);
  const again = await page.content();
  for (const code of codes) expect(again).not.toContain(code);
  expect(again).not.toContain(secret);
});

test(`${J}, part of #5: when the confirmation's answer is lost, the recovery codes still show, labelled as such`, async ({ page }) => {
  test.setTimeout(120_000);
  const { totp } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));
  const who = person('ru');
  await signUpInBrowser(page, who);
  await page.goto('/uc/safe');
  await page.getByRole('button', { name: 'Start authenticator setup' }).click();
  await page.getByRole('button', { name: 'Start authenticator setup' }).last().click();
  await page.getByRole('button', { name: 'Show setup key' }).click();
  const secret = await page.getByLabel('Authenticator setup key').inputValue();

  // Identity turns the authenticator on, then the answer never reaches the browser.
  await page.route('**/totp.confirm**', async (route) => {
    await route.fetch();
    await route.abort('connectionreset');
  });
  await page.getByLabel('Six-digit authenticator code').fill(totp(secret));
  await page.getByRole('button', { name: 'Confirm authenticator' }).click();

  const recovery = page.getByTestId('security__recovery');
  await expect(recovery).toContainText('We could not tell whether your authenticator was turned on');
  await expect(recovery.getByTestId('recovery-codes').locator('li')).toHaveCount(10);
  // The page no longer asks for the confirmation it may already have.
  await expect(page.getByRole('button', { name: 'Confirm authenticator' })).toHaveCount(0);
  await expect(page.getByTestId('security__authenticator')).not.toContainText('Confirmation is still required');
  // It was on: the checklist says so.
  const authenticatorRow = page
    .getByTestId('security__checklist')
    .getByTestId('security__row')
    .filter({ has: page.getByText('An authenticator app', { exact: true }) });
  await expect(authenticatorRow).toContainText('Done');
  await recovery.getByLabel('I wrote these codes down or stored them somewhere safe').check();
  await recovery.getByRole('button', { name: 'I saved them' }).click();
  await expect(recovery).toHaveCount(0);
});

test(`${J}, part of #8: the anti-phishing code sets with a confirmation, rides on an account email, refuses the handle, changes and goes`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { totp } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));
  const who = person('ap');
  await signUpInBrowser(page, who);
  let { secret, step } = await addAuthenticator(page, totp);

  await page.goto('/uc/safe');
  const card = page.getByTestId('security__anti-phishing');
  await expect(card).toContainText('No anti-phishing code is set');
  // The card says which emails carry the code.
  await expect(card).toContainText('Every email we send to your account’s confirmed address about your account shows this code');
  await expect(card.getByTestId('security__mail-preview')).toContainText('You have not set an anti-phishing code.');

  // Each save confirms with a fresh authenticator code, bound to the code typed.
  async function save(code, button = 'Save with code') {
    const next = await nextCode(totp, secret, step);
    step = next.step;
    if (code !== null) await card.getByLabel('New code (4 to 20 letters and digits)').fill(code);
    await card.getByLabel('6-digit code from your authenticator app').fill(next.code);
    await card.getByRole('button', { name: button }).click();
  }

  // A code that is the handle is refused, and nothing is set.
  await card.getByRole('button', { name: 'Set a code' }).click();
  await card.getByLabel('New code (4 to 20 letters and digits)').fill('ab');
  await card.getByRole('button', { name: 'Save with code' }).click();
  await expect(card.getByRole('alert')).toHaveText('Use 4 to 20 letters and digits.');
  await save(who.handle.toUpperCase());
  await expect(card.getByRole('alert')).toContainText('it is your handle, your email or your password');
  await expect(card).toContainText('No anti-phishing code is set');

  const code = `Owl${randomBytes(3).toString('hex')}`;
  await save(code);
  await expect(card.getByRole('status')).toHaveText('Anti-phishing code saved.');
  await expect(card).toContainText(`Your code: ${code}`);
  await expect(card.getByTestId('security__mail-preview')).toContainText(`Your anti-phishing code: ${code}`);
  // The code is never left in a field, in storage or in the address bar.
  await expect(card.locator('input')).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))).not.toContain(code);
  expect(page.url()).not.toContain(code);

  // After a reload the page reads it back from the service.
  await page.reload();
  await expect(card).toContainText(`Your code: ${code}`);

  // Someone signing up again with this address (from a signed-out page) sends the owner a notice; it carries the code.
  async function noticeMail() {
    const before = mailedLines(who.email, 'signup-existing').length;
    const other = await page.context().browser().newPage({ baseURL: PASSKEY_ORIGIN });
    await other.goto('/register');
    await other.getByLabel('Email address').fill(who.email);
    await other.getByLabel('Handle').fill(`${who.handle}x`);
    await other.getByLabel('Password').fill(`TEST-${randomBytes(9).toString('base64url')}-9b`);
    await other.getByLabel('Country you live in').selectOption('DE');
    await other.getByLabel('Date of birth').fill('1990-05-01');
    await other.getByRole('button', { name: 'Create account' }).click();
    await other.getByRole('heading', { name: 'Check your email' }).waitFor();
    await other.close();
    await expect.poll(() => mailedLines(who.email, 'signup-existing').length, { timeout: 30_000 }).toBeGreaterThan(before);
    return mailedLines(who.email, 'signup-existing').at(-1);
  }
  expect(await noticeMail()).toMatch(new RegExp(` anti_phishing=${code}$`));

  const changed = `Heron${randomBytes(3).toString('hex')}`;
  await card.getByRole('button', { name: 'Change the code' }).click();
  await save(changed);
  await expect(card).toContainText(`Your code: ${changed}`);
  await expect(card.getByTestId('security__mail-preview')).toContainText(`Your anti-phishing code: ${changed}`);

  await card.getByRole('button', { name: 'Remove the code' }).click();
  await expect(card).toContainText('Confirm it is you to remove the code.');
  await save(null, 'Remove with code');
  await expect(card.getByRole('status')).toHaveText('Anti-phishing code removed.');
  await expect(card).toContainText('No anti-phishing code is set');
  // With the code removed, the next mail carries none.
  expect(await noticeMail()).not.toContain('anti_phishing=');
});

test(`${J} #6 "my codes do not work" names a clock that is out by seconds, or says codes should work and offers replace; a new phone is a guided replace`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { totp } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));
  const who = person('ck');
  await signUpInBrowser(page, who);
  let { secret, step } = await addAuthenticator(page, totp);
  let signInCode;

  // A returning person: signed in again with the authenticator, as replacing it needs a session that passed it.
  await forgetSession(page);
  await page.goto('/login');
  ({ code: signInCode, step } = await nextCode(totp, secret, step));
  await page.fill('input[name=totp]', signInCode);
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/);

  // With the right time: codes should work, and Replace is offered.
  await page.goto('/uc/safe');
  const real = page.locator('[data-testid="security__authenticator"][aria-label="Authenticator app"]');
  await real.getByRole('button', { name: 'My codes do not work' }).click();
  const ok = real.getByRole('region', { name: 'When codes do not work' });
  await expect(ok.getByRole('status')).toContainText('so codes should work');
  await expect(ok).toContainText('Apps that sync codes');
  await expect(ok.getByRole('listitem')).toHaveCount(4);
  await expect(ok.getByRole('button', { name: 'Replace', exact: true })).toBeVisible();
  // Moving to a new phone starts the card's own replace, which first confirms it is you, then takes the new app's code.
  await ok.getByRole('button', { name: 'Move to a new phone' }).click();
  await expect(ok).toHaveCount(0);
  await expect(real.getByRole('heading', { name: 'Confirm it is you' })).toBeVisible();
  let code;
  ({ code, step } = await nextCode(totp, secret, step));
  await real.getByLabel('6-digit code or a recovery code').fill(code);
  await real.getByRole('button', { name: 'Confirm', exact: true }).click();
  // The new key shows in its own setup card, under the same name.
  const setup = page
    .locator('[data-testid="security__authenticator"]')
    .filter({ hasText: 'Add this key to your new authenticator app, then enter the code it shows.' });
  await expect(setup).toHaveCount(1);
  const newKey = (await setup.locator('code').innerText()).trim();
  await setup.getByLabel('Code from the new app').fill(totp(newKey));
  ({ code, step } = await nextCode(totp, secret, step));
  await setup.getByLabel('Next code or a recovery code').fill(code);
  await setup.getByRole('button', { name: 'Replace authenticator app' }).click();
  await expect(page.locator('[data-testid="notice"][role=status]').filter({ hasText: 'Authenticator app replaced' })).toBeVisible();

  // The same signed-in browser with its clock set 90 seconds ahead (the clock is the whole browser's), on a fresh page.
  await page.context().clock.install({ time: new Date(Date.now() + 90_000) });
  await page.context().clock.resume();
  const skewed = await page.context().newPage();
  await skewed.goto('/uc/safe');
  const card = skewed.locator('[data-testid="security__authenticator"][aria-label="Authenticator app"]');
  await card.getByRole('button', { name: 'My codes do not work' }).click();
  const help = card.getByRole('region', { name: 'When codes do not work' });
  await expect(help).toContainText('Codes depend on the clock.');
  await expect(help.getByRole('status')).toHaveText(/This device’s clock is (89|90|91) seconds ahead of ours\./);
  await expect(help.getByRole('button', { name: 'Replace', exact: true })).toHaveCount(0);
  await skewed.close();
});

/** The passkeys a virtual authenticator holds, by their base64url ids. */
async function heldPasskeys({ cdp, authenticatorId }) {
  const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  return credentials.map((c) => Buffer.from(c.credentialId, 'base64').toString('base64url'));
}

test(`${J} #4 sets a passkey as the second step and keeps one for signing in: another person's passkey is refused, and the kept passkey is the only one offered`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const device = await virtualAuthenticator(page);

  // Someone else signs up on this browser first and adds a passkey, which stays on the same authenticator.
  const other = person('po');
  await signUpInBrowser(page, other);
  await addPasskey(page);
  const [theirs] = await heldPasskeys(device);
  await forgetSession(page);

  // This person adds a passkey on the device, then asks for it after the password.
  const who = person('ps');
  await signUpInBrowser(page, who);
  await addPasskey(page);
  const mine = (await heldPasskeys(device)).find((id) => id !== theirs);
  const names = page.getByTestId('security__passkey-names');
  const second = names.getByRole('group', { name: 'A passkey after your password' });
  await expect(second).toContainText('Off: your password signs you in');
  await second.getByRole('button', { name: 'Ask for a passkey' }).click();
  await second.getByRole('button', { name: 'Save with a passkey' }).click();
  await expect(names.getByRole('status')).toHaveText('Saved how you sign in.');
  await expect(second).toContainText('On: signing in with your password also asks for one of your passkeys.');

  // A second passkey, a security key, kept for signing in only.
  const key = await virtualAuthenticator(page, 'usb');
  await page.getByRole('button', { name: 'Add passkey' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Add passkey' }).click();
  await page.getByTestId('failure').getByRole('button', { name: 'Confirm it is you' }).click();
  await page
    .getByRole('dialog', { name: /confirm it’s you/i })
    .getByRole('button', { name: 'Use a passkey' })
    .click();
  await expect(names.getByTestId('security__row')).toHaveCount(2);
  const [kept] = await heldPasskeys(key);
  const securityKey = names.locator('[data-testid="security__row"]', { hasText: 'Security key' });
  await expect(securityKey).toContainText('Kept for: nothing in particular');
  await securityKey.getByRole('button', { name: /^Choose what passkey/ }).click();
  await securityKey.getByLabel('Signing in').check();
  await securityKey.getByRole('button', { name: 'Save with a passkey' }).click();
  await expect(names.getByRole('status')).toHaveText('Saved what this passkey is for.');
  await expect(securityKey).toContainText('Kept for: Signing in');
  await expect(names.locator('[data-testid="security__row"]', { hasText: 'This device' })).toContainText('Kept for: nothing in particular');
  await forgetSession(page);

  async function password() {
    await page.goto('/login');
    await page.fill('input[name=identifier]', who.email);
    await page.fill('input[name=password]', who.password);
    const answer = page.waitForResponse((res) => new URL(res.url()).pathname.endsWith('/api/identity/trpc/auth.login'));
    await page.getByRole('button', { name: /^sign in$/i }).click();
    const body = await (await answer).json();
    await expect(page.getByRole('alert')).toContainText('Your password is right. Now confirm with one of your passkeys.');
    return body.error.data.secondStep;
  }

  // The password is not enough now. The kept passkey is the only one offered; the device's own passkey is not.
  const offered = await password();
  expect(offered.totp).toBe(false);
  expect(offered.passkey.allowCredentials.map((c) => c.id)).toEqual([kept]);
  expect(mine).toBeDefined();

  // A browser that answers with the other person's passkey gets it refused, and nothing signs in. The page only offers
  // the kept passkey, so this browser signs the account's own challenge with theirs (the device holds it) and sends it
  // where the page sends its answer: the app and identity are unmodified.
  const { passkey: challenge } = await password();
  // Only the device that holds their passkey answers: the security key is unplugged for this attempt, with its passkey
  // (and its sign count as it stands now) kept to plug back in.
  const {
    credentials: [keptCredential],
  } = await key.cdp.send('WebAuthn.getCredentials', { authenticatorId: key.authenticatorId });
  await key.cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: key.authenticatorId });
  const forged = await page.evaluate(
    async ({ options, theirsId }) => {
      const fromB64 = (value) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
      const toB64 = (buffer) =>
        btoa(String.fromCharCode(...new Uint8Array(buffer)))
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');
      const credential = await navigator.credentials.get({
        publicKey: {
          ...options,
          challenge: fromB64(options.challenge),
          allowCredentials: [{ type: 'public-key', id: fromB64(theirsId) }],
        },
      });
      const response = credential.response;
      const res = await fetch('/api/identity/trpc/auth.loginSecondStepPasskey', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          credential: {
            id: credential.id,
            rawId: toB64(credential.rawId),
            type: 'public-key',
            response: {
              clientDataJSON: toB64(response.clientDataJSON),
              authenticatorData: toB64(response.authenticatorData),
              signature: toB64(response.signature),
              userHandle: response.userHandle ? toB64(response.userHandle) : null,
            },
            clientExtensionResults: {},
          },
        }),
      });
      return { usedId: credential.id, status: res.status, body: await res.json() };
    },
    { options: challenge, theirsId: theirs },
  );
  expect(forged.usedId).toBe(theirs);
  const refusal = forged.body.error?.data;
  expect(refusal?.intafacedCode ?? refusal?.cause?.code ?? refusal?.code).toBe('auth.webauthn_invalid');
  expect(JSON.stringify(forged.body)).not.toContain('accessToken');
  await page.goto('/uc/safe');
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();

  // The person's own kept passkey signs them in: the security key is plugged back in and the device is put away, so the
  // browser offers the one authenticator that holds the kept passkey.
  await device.cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: device.authenticatorId });
  const replugged = await virtualAuthenticator(page, 'usb');
  await replugged.cdp.send('WebAuthn.addCredential', { authenticatorId: replugged.authenticatorId, credential: keptCredential });
  await password();
  await page.getByRole('button', { name: 'Use your passkey' }).click();
  await page.waitForURL((url) => url.pathname !== '/login');
  await page.goto('/uc/safe');
  await expect(page.getByTestId('security__passkey-names')).toContainText(
    'On: signing in with your password also asks for one of your passkeys.',
  );
});

test(`${J} #7 links a wallet with its own signature and a confirmation, refuses a wrong key, shows the texting and social provider notices, and refuses to remove the last way in`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  await virtualAuthenticator(page);
  // A TEST wallet stands in for the person's own (tests/real-app/test-wallet.mjs); nothing reaches a chain.
  const wallet = await installTestWallet(page, { chainId: 1 });
  const who = person('sm');
  await signUpInBrowser(page, who);
  await addPasskey(page);
  const card = page.getByTestId('security__signin-methods');
  const row = (name) => card.getByRole('listitem', { name, exact: true });
  await expect(row('Password')).toContainText('On: you can sign in with your password.');
  await expect(row('Code by email')).toContainText(`On: we can mail a sign-in code to ${who.email}.`);
  await expect(row('Wallets')).toContainText('No wallet linked.');

  // A phone number and a social account need outside providers that are off in this build; the card names them.
  await row('Phone number').getByRole('button', { name: 'Link a phone number' }).click();
  await row('Phone number').getByLabel('Phone number, starting with +').fill('+44 20 7946 0000');
  await row('Phone number').getByRole('button', { name: 'Text me a code' }).click();
  await expect(card.locator('[data-not-connected="vendor.sms"]')).toContainText('Texting a sign-in code needs an SMS delivery provider.');
  await row('Social account').getByRole('button', { name: 'Link a social account' }).click();
  await expect(card.locator('[data-not-connected="idp.social"]')).toContainText(
    'Signing in with a social account needs an outside sign-in provider.',
  );

  // A signature from another key is refused before any confirmation is asked for, and nothing is linked.
  wallet.signWithOtherKeyNext();
  await row('Wallets').getByRole('button', { name: 'Link a wallet' }).click();
  await expect(card.getByTestId('failure')).toContainText('That signature is not from this wallet. Nothing was changed.');
  await expect(card.getByRole('form', { name: 'Confirm it is you' })).toHaveCount(0);
  await expect(row('Wallets')).toContainText('No wallet linked.');

  // The wallet's own signature, then a confirmation with the passkey, links it.
  async function confirmWithPasskey() {
    await card.getByRole('form', { name: 'Confirm it is you' }).getByRole('button', { name: 'Confirm with a passkey' }).click();
  }
  await row('Wallets').getByRole('button', { name: 'Link a wallet' }).click();
  await confirmWithPasskey();
  const short = `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`;
  await expect(card.getByRole('status')).toContainText(`Wallet ${short} linked. You can sign in with it.`);
  await expect(row('Wallets').getByTitle(wallet.address)).toBeVisible();
  expect(wallet.requests.filter((request) => request.method === 'personal_sign')).toHaveLength(2);

  // Code by email off, then the password, each confirmed with the passkey.
  await row('Code by email').getByRole('button', { name: 'Turn off' }).click();
  await confirmWithPasskey();
  await expect(row('Code by email')).toContainText('Off: no sign-in code is mailed.');
  await row('Password').getByRole('button', { name: 'Stop using a password' }).click();
  await confirmWithPasskey();
  await expect(row('Password')).toContainText('Off: your old password no longer signs in.');
  await forgetSession(page);

  // The old password no longer signs in. The passkey does, and then it is removed, leaving the wallet as the only way in.
  await page.goto('/login');
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page.getByTestId('failure')).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
  await page.goto('/login');
  await page.fill('input[name=identifier]', who.handle);
  await page.getByRole('button', { name: 'Use a passkey' }).click();
  await page.waitForURL((url) => url.pathname !== '/login');
  await page.goto('/uc/safe');
  await page.getByRole('button', { name: /^Remove passkey / }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove passkey' }).click();
  await expect(row('Passkeys')).toContainText('None on this account.');
  await expect(card).toContainText('This is your only way to sign in, so it cannot be removed. Add another first.');

  // Removing the wallet now is refused as the last way in, before any confirmation, and the wallet stays.
  await row('Wallets')
    .getByRole('button', { name: `Remove wallet ${short}` })
    .click();
  await expect(card.getByTestId('failure')).toContainText('This is your last way to sign in. Add another before you remove it.');
  await expect(card.getByRole('form', { name: 'Confirm it is you' })).toHaveCount(0);
  await expect(row('Wallets').getByTitle(wallet.address)).toBeVisible();
  await forgetSession(page);

  // The wallet signs in on the sign-in page by its signature alone.
  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue with a wallet' }).click();
  await page.waitForURL((url) => url.pathname !== '/login');
  await page.goto('/uc/safe');
  await expect(row('Wallets').getByTitle(wallet.address)).toBeVisible();
  await expect(row('Password')).toContainText('Off: your old password no longer signs in.');
});
