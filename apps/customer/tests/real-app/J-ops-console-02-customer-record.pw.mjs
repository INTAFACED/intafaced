import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { makeContext } from '../../../../tooling/scripts/local-test-gates.mjs';
import { FOUNDER_VAULT_NAME } from '../../../../tooling/scripts/local-test-founders.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';

// J-ops-console-02 step #3: /accounts/:userId shows money, trade, pay, cards and tickets tabs for one account; each read loads
// or refuses on its own, and a part no service can read for one account names why. The account looked at is the stack's
// second TEST founder, an account that always exists on the stack.

test('J-ops-console-02 #3 one customer record: five tabs, each loading or refusing on its own', async ({ page }) => {
  test.setTimeout(240_000);
  const ctx = await makeContext({ log: () => {} });
  const vault = JSON.parse(readFileSync(path.join(ctx.paths.stateDir, FOUNDER_VAULT_NAME), 'utf8'));
  const customer = vault.founders[1]?.userId;
  if (!customer) throw new Error('the stack has no second founder yet: start the stack first (pnpm local:stack)');
  await founderSignIn(page, 'a');

  await page.goto(`${ADMIN}/accounts`, { waitUntil: 'load' });
  await page.getByLabel('Account id').fill(customer.toUpperCase());
  await page.getByRole('button', { name: 'Open customer record' }).click();
  await page.waitForURL((url) => url.pathname === `/accounts/${customer}`, { timeout: 60_000 });
  await expect(page.getByTestId('customer-record-id')).toHaveText(customer);
  for (const tab of ['money', 'trade', 'pay', 'cards', 'tickets']) await expect(page.getByTestId(`customer-tab-${tab}`)).toBeVisible();

  // Money: the balance read answers or refuses in words; it is never blank.
  const balances = page.getByTestId('read-bank.customer-balances');
  await expect(balances).toBeVisible();
  await expect(balances.getByText(/As of /).first()).toBeVisible();

  // Trade: svc-trade's restriction history answers or refuses; orders and positions name their blocker.
  await page.getByTestId('customer-tab-trade').click();
  await expect(page.getByTestId('customer-panel-trade')).toBeVisible({ timeout: 60_000 });
  await expect(
    page
      .getByTestId('read-trade.controls')
      .getByText(/As of /)
      .first(),
  ).toBeVisible();
  await expect(page.getByTestId('unwired-trade.orders')).toContainText('no source');

  // Pay: the two allowlist reads each answer or refuse alone.
  await page.getByTestId('customer-tab-pay').click();
  await expect(page.getByTestId('customer-panel-pay')).toBeVisible({ timeout: 60_000 });
  await expect(
    page
      .getByTestId('read-pay.allowlist-mode')
      .getByText(/As of /)
      .first(),
  ).toBeVisible();
  await expect(
    page
      .getByTestId('read-pay.allowlist-policy')
      .getByText(/As of /)
      .first(),
  ).toBeVisible();

  for (const tab of ['cards', 'tickets']) {
    await page.getByTestId(`customer-tab-${tab}`).click();
    await expect(page.getByTestId(`customer-panel-${tab}`)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId(`customer-panel-${tab}`)).toContainText('ops.customer_record_source_unwired');
  }
});
