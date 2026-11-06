import { expect, test } from './journey.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { founderTotp, makeContext } from '../../../../tooling/scripts/local-test-gates.mjs';
import { FOUNDER_VAULT_NAME } from '../../../../tooling/scripts/local-test-founders.mjs';
import { createHash } from 'node:crypto';
import { signUp, verify } from './desk.mjs';
import { api } from './stack.mjs';

const RUN = Date.now().toString(36);

/** A stable uuid for a journey key, so a write sent again in this run names the same account. */
function uuidOf(key) {
  const hex = createHash('sha256').update(key).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// J-ops-console-01 step #2: the customer app's /ops room asks identity whether the signed-in account is a founder. A founder
// gets the operator console panel with its link to the Team console; anyone else gets a pointer to
// their own tools and never a founder control. A business user (a verified person who opens a TEST business account at the
// bank, svc-bank `business.create`, and switches to it in the account menu, as J-home-ia-07 does) also gets the merchant
// admin link on that pointer page.

test('J-ops-console-01 #2 a founder sees the console panel on /ops', async ({ page }) => {
  const ctx = await makeContext({ log: () => {} });
  const vault = JSON.parse(readFileSync(path.join(ctx.paths.stateDir, FOUNDER_VAULT_NAME), 'utf8'));
  const founder = vault.founders[0];
  if (!founder?.totpSecret) throw new Error('founder a has no confirmed second factor yet: start the stack first (pnpm local:stack)');
  await page.goto('/login');
  await page.fill('input[name=identifier]', founder.handle ?? founder.email);
  await page.fill('input[name=password]', founder.password);
  await page.getByLabel(/Two-factor or recovery code/).fill(await founderTotp(ctx, 'a', founder.totpSecret));
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto('/ops');
  await expect(page.getByRole('heading', { name: 'Open the operator console' })).toBeVisible();
  await expect(page.getByText('Nothing to open here')).toHaveCount(0);
  // The stack's build points the Team link at its LOCAL TEST HTTPS address (#6949), so the founder gets the real link.
  await expect(page.getByTestId('team-desk-console')).toHaveAttribute('href', 'https://127.0.0.1:3143/ops');
  await expect(page.getByText('The Team deployment address is not configured.')).toHaveCount(0);
});

test('J-ops-console-01 #2 a customer who is not a founder gets the pointer and no founder control on /ops', async ({ page }) => {
  await signUp(page, 'opsuser');
  await page.goto('/ops');
  await expect(page.getByRole('heading', { name: 'Nothing to open here' })).toBeVisible();
  await expect(page.getByText('This page is for founders.')).toBeVisible();
  await expect(page.getByText('Open the operator console')).toHaveCount(0);
  await expect(page.getByText('Open Team')).toHaveCount(0);
});

test('J-ops-console-01 #2 a business user gets the pointer page, the merchant admin link and no founder control on /ops', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const person = await signUp(page, 'opsbiz');
  // Bank reads, the business list among them, answer a verified person.
  await verify(page, person);
  const name = `TEST Ops Room ${RUN}`;
  const res = await (
    await api(person)
  ).post('/api/bank/trpc/business.create', {
    accountId: uuidOf(`J-ops-console-01:business:${RUN}`),
    name,
    assetId: 'USDT',
    spendThreshold: '10',
  });
  expect(res.status, `business.create: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);

  // The person switches to the business in the account menu, so the app is in Business mode.
  await page.goto('/home');
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByTestId('profile-business').filter({ hasText: name }).click();
  await expect(page).toHaveURL(/\/pay\/merchant/);

  await page.goto('/ops');
  await expect(page.getByRole('heading', { name: 'Nothing to open here' })).toBeVisible();
  await expect(page.getByText('This page is for founders.')).toBeVisible();
  await expect(page.getByText('Your business team, roles and settings are managed in merchant admin.')).toBeVisible();
  const merchant = page.getByTestId('team-desk-merchant');
  await expect(merchant).toHaveText('Open merchant admin');
  await expect(merchant).toHaveAttribute('href', '/pay/merchant');
  // No founder control: no console panel, no Team link.
  await expect(page.getByText('Open the operator console')).toHaveCount(0);
  await expect(page.getByText('Open Team')).toHaveCount(0);
  await expect(page.getByTestId('team-desk-console')).toHaveCount(0);
});
