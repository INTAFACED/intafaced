import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ADMIN, founderSignIn } from './admin.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, signUpInBrowser } from './stack.mjs';

// J-ops-console-04 step #1: a founder freezes one TEST customer's account with a reason on the console's Account controls.
// Identity records the freeze against the version the console read, and refuses a page that read an older one; the history shows the founder and the reason; the
// ledger's platform-wide posting freeze is a different control and stays off.
const LEDGER = 'http://127.0.0.1:14501';

test('J-ops-console-04 #1 freezes an account with a reason: identity records it, the history shows actor and reason, posting is untouched', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const tag = randomUUID().slice(0, 8);
  const who = { handle: `ops04${tag}`, email: `ops04-${tag}@local-test.invalid`, password: `Ops04-${tag}-Test!pass` };

  const customer = await (await browser.newContext({ baseURL: ORIGIN })).newPage();
  await signUpInBrowser(customer, who);
  const login = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password }),
  }).then((r) => r.json());
  const userId = login?.result?.data?.userId;
  if (!userId) throw new Error(`the new TEST customer could not sign in: ${JSON.stringify(login).slice(0, 300)}`);
  expect((await fetch(`${LEDGER}/ready`)).status, 'posting is open before the freeze').toBe(200);

  /** A console page that has inspected the customer's identity account, holding the version it read. */
  async function inspected() {
    const page = await (await browser.newContext()).newPage();
    const founder = await founderSignIn(page, 'a');
    await page.goto(`${ADMIN}/accounts`, { waitUntil: 'load' });
    await page.getByLabel('Account area').selectOption('identity');
    await page.getByLabel('Platform user ID').fill(userId);
    await page.getByRole('button', { name: 'Inspect account' }).click();
    await expect(page.getByRole('heading', { name: 'Access permitted' })).toBeVisible({ timeout: 60_000 });
    return { page, founder };
  }
  const { page, founder } = await inspected();
  await expect(page.getByText('No recorded control attempts.')).toBeVisible();
  // A second page reads the same version now and acts only after the freeze below has changed it.
  const { page: stale } = await inspected();

  const reason = `LOCAL TEST J-ops-console-04 freeze ${tag}`;
  await page.getByRole('textbox', { name: 'Reason', exact: true }).fill(reason);
  await page.getByLabel(/I reviewed this account/).check();
  await page.getByRole('button', { name: 'Restrict access' }).click();
  await expect(page.getByRole('status')).toContainText('Account restricted.');
  await expect(page.getByRole('heading', { name: 'Restricted' })).toBeVisible();

  // The version check: the stale page sends the version it read, and identity refuses it because the account changed since.
  await stale.getByRole('textbox', { name: 'Reason', exact: true }).fill(`LOCAL TEST stale restrict ${tag}`);
  await stale.getByLabel(/I reviewed this account/).check();
  await stale.getByRole('button', { name: 'Restrict access' }).click();
  await expect(stale.getByRole('alert').filter({ hasText: 'The account changed since inspection. Review the current state.' })).toHaveCount(
    1,
  );
  // The stale page then reads the account again and shows it restricted, by the first request.
  await expect(stale.getByRole('heading', { name: 'Restricted' })).toBeVisible();

  // The history is identity's own record of the attempt: who did it, what, and why.
  const row = page.locator('table tbody tr').filter({ hasText: reason });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('restrict');
  await expect(row).toContainText('changed');
  await expect(row).toContainText(founder.userId.slice(0, 8));
  // The stale attempt changed nothing: the account is restricted once, by the first founder's request.
  await page.reload();
  await page.getByLabel('Account area').selectOption('identity');
  await page.getByLabel('Platform user ID').fill(userId);
  await page.getByRole('button', { name: 'Inspect account' }).click();
  await expect(page.getByRole('heading', { name: 'Restricted' })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('table tbody tr').filter({ hasText: 'changed' })).toHaveCount(1);

  // The freeze is identity's: the customer's sessions are revoked and sign-in refuses, while the ledger keeps posting.
  const again = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password }),
  });
  expect(again.status, 'a frozen account cannot sign in').not.toBe(200);
  expect((await fetch(`${LEDGER}/ready`)).status, 'the posting freeze is untouched').toBe(200);
});
