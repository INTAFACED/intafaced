import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { ROOT, signUpInBrowser } from './stack.mjs';
import { PASSKEY_ORIGIN, addAuthenticator, addPasskey, nextCode, virtualAuthenticator } from './identity-factors.mjs';

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
  const refusal = page.locator('.failure');
  await expect(refusal).toContainText('Confirm it is you');
  await expect(refusal).toContainText('Confirm it is you with your authenticator code or a passkey');
  await expect(refusal).not.toContainText('Outcome not confirmed');
  await expect(page.locator('.security__passkeys')).toContainText('No passkeys yet');

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
  const refusal = page.locator('.failure');
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
  await expect(page.locator('.security__passkeys')).not.toContainText('No passkeys yet');
  await expect(page.locator('.failure')).toHaveCount(0);
});

test(`${J} #3 adds a passkey, names it, adds a second; each shows its type and label; the name holds 64 characters at most, an empty one is refused, and no limit shows as "no limit set"`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const who = person('pn');
  await virtualAuthenticator(page);
  await signUpInBrowser(page, who);
  await addPasskey(page);

  const names = page.locator('.security__passkey-names');
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
  const refusal = page.locator('.failure');
  await expect(refusal).toContainText('Confirm it is you');
  await refusal.getByRole('button', { name: 'Confirm it is you' }).click();
  const sheet = page.getByRole('dialog', { name: /confirm it’s you/i });
  await sheet.getByRole('button', { name: 'Use a passkey' }).click();
  await expect(sheet).toBeHidden();
  // The names list follows the add on its own, with no refresh.
  await expect(names.locator('.security__row')).toHaveCount(2);
  await expect(names.locator('.security__row', { hasText: 'Work laptop' })).toContainText('This device');
  await expect(names.locator('.security__row', { hasText: 'Unnamed passkey' })).toContainText('Security key');
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
  const checklist = page.locator('.security__checklist');
  const item = (name) => checklist.locator('.security__row').filter({ has: page.getByText(name, { exact: true }) });
  await expect(item('A second step at sign-in')).toContainText('To do');
  await expect(item('A second step at sign-in')).toContainText('anyone who learns it can sign in');
  await expect(item('A passkey')).toContainText('To do');
  await expect(item('An authenticator app')).toContainText('To do');
  await expect(item('Recovery codes saved')).toContainText('To do');
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
  await expect(item('A passkey')).toContainText('To do');
  await expect(checklist).toContainText('Always needs a second step');

  // A passkey after "Confirm it is you" with the code ticks the last one.
  await page.getByRole('button', { name: 'Add passkey' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Add passkey' }).click();
  await page.locator('.failure').getByRole('button', { name: 'Confirm it is you' }).click();
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
  const recovery = page.locator('.security__recovery');
  await expect(recovery).toContainText('Your recovery codes');
  const codes = await recovery.locator('.recovery-codes li').allInnerTexts();
  expect(codes).toHaveLength(10);
  for (const code of codes) expect(code).toMatch(/^[0-9A-Fa-f]{5}-[0-9A-Fa-f]{5}$/);
  await expect(page.locator('.security__checklist .security__row', { hasText: 'Recovery codes saved' })).toContainText(
    `${codes.length} left`,
  );

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
  await expect(page.locator('.security__authenticator')).toContainText('Start authenticator setup');
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

  const recovery = page.locator('.security__recovery');
  await expect(recovery).toContainText('We could not tell whether your authenticator was turned on');
  await expect(recovery.locator('.recovery-codes li')).toHaveCount(10);
  // The page no longer asks for the confirmation it may already have.
  await expect(page.getByRole('button', { name: 'Confirm authenticator' })).toHaveCount(0);
  await expect(page.locator('.security__authenticator')).not.toContainText('Confirmation is still required');
  // It was on: the checklist says so.
  const authenticatorRow = page
    .locator('.security__checklist .security__row')
    .filter({ has: page.getByText('An authenticator app', { exact: true }) });
  await expect(authenticatorRow).toContainText('Done');
  await recovery.getByLabel('I wrote these codes down or stored them somewhere safe').check();
  await recovery.getByRole('button', { name: 'I saved them' }).click();
  await expect(recovery).toHaveCount(0);
});

test(`${J}, part of #8: the anti-phishing code sets with a confirmation, shows in the email preview, refuses the handle, changes and goes`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { totp } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));
  const who = person('ap');
  await signUpInBrowser(page, who);
  let { secret, step } = await addAuthenticator(page, totp);

  await page.goto('/uc/safe');
  const card = page.locator('.security__anti-phishing');
  await expect(card).toContainText('No anti-phishing code is set');
  // Mail does not carry the code on this service, and the card says so rather than promising it.
  await expect(card).toContainText('Our security emails do not show this code');
  await expect(card.locator('.security__mail-preview')).toContainText('You have not set an anti-phishing code.');

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
  await expect(card.locator('.security__mail-preview')).toContainText(`Your anti-phishing code: ${code}`);
  // The code is never left in a field, in storage or in the address bar.
  await expect(card.locator('input')).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))).not.toContain(code);
  expect(page.url()).not.toContain(code);

  // After a reload the page reads it back from the service.
  await page.reload();
  await expect(card).toContainText(`Your code: ${code}`);

  const changed = `Heron${randomBytes(3).toString('hex')}`;
  await card.getByRole('button', { name: 'Change the code' }).click();
  await save(changed);
  await expect(card).toContainText(`Your code: ${changed}`);
  await expect(card.locator('.security__mail-preview')).toContainText(`Your anti-phishing code: ${changed}`);

  await card.getByRole('button', { name: 'Remove the code' }).click();
  await expect(card).toContainText('Confirm it is you to remove the code.');
  await save(null, 'Remove with code');
  await expect(card.getByRole('status')).toHaveText('Anti-phishing code removed.');
  await expect(card).toContainText('No anti-phishing code is set');
});
