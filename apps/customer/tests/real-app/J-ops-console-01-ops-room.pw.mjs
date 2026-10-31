import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { founderTotp, makeContext } from '../../../../tooling/scripts/local-test-gates.mjs';
import { FOUNDER_VAULT_NAME } from '../../../../tooling/scripts/local-test-founders.mjs';
import { signUp } from './desk.mjs';

// J-ops-console-01 step #2: the customer app's /ops room asks identity whether the signed-in account is a founder. A founder
// gets the operator console panel with its link to the Team console; anyone else gets a pointer to
// their own tools and never a founder control. A Business-mode person also gets the merchant admin link; reaching Business
// mode needs a verified business profile, so that branch is proven in team-desk.render.test.tsx, not here.

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
