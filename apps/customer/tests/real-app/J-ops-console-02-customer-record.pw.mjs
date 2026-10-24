import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { makeContext } from '../../../../tooling/scripts/local-test-gates.mjs';
import { FOUNDER_VAULT_NAME } from '../../../../tooling/scripts/local-test-founders.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';

// J-ops-console-02 steps #3 and #4: /accounts/:userId shows the money, trade, pay, cards, documents and tickets tabs for one
// account, each read loading or refusing on its own, and a part no service can read for one account names why (#3); and the
// risk card and indicator strip, which say there is no risk level and nothing is set rather than show a number (#4). Step #5
// (each document's status and the viewer) is its own test, J-ops-console-02-documents.pw.mjs.
// The account looked at is the stack's second TEST founder, an account that always exists on the stack.

async function secondFounder() {
  const ctx = await makeContext({ log: () => {} });
  const vault = JSON.parse(readFileSync(path.join(ctx.paths.stateDir, FOUNDER_VAULT_NAME), 'utf8'));
  const customer = vault.founders[1]?.userId;
  if (!customer) throw new Error('the stack has no second founder yet: start the stack first (pnpm local:stack)');
  return customer;
}

test('J-ops-console-02 #4 the risk card says no risk level and the indicator strip says not set, never a made-up number', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const customer = await secondFounder();
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/accounts/${customer}`, { waitUntil: 'load' });
  await expect(page.getByTestId('customer-record-id')).toHaveText(customer, { timeout: 60_000 });
  // No risk ruleset exists, so the record says there is no risk level and why, never a made-up score.
  const risk = page.getByTestId('customer-risk-card');
  await expect(risk).toContainText('Risk: No risk level');
  await expect(risk).toContainText('No risk ruleset exists');
  // ...and the indicator strip says "not set" with its code, never a made-up value.
  const indicators = page.getByTestId('customer-indicator-strip');
  await expect(indicators).toContainText('Indicators: Not set');
  await expect(indicators).toContainText('compliance.indicators_unset');
});

test('J-ops-console-02 #3 one customer record: six tabs each loading or refusing on its own', async ({ page }) => {
  test.setTimeout(240_000);
  const customer = await secondFounder();
  await founderSignIn(page, 'a');

  await page.goto(`${ADMIN}/accounts`, { waitUntil: 'load' });
  await page.getByLabel('Account id').fill(customer.toUpperCase());
  await page.getByRole('button', { name: 'Open customer record' }).click();
  await page.waitForURL((url) => url.pathname === `/accounts/${customer}`, { timeout: 60_000 });
  await expect(page.getByTestId('customer-record-id')).toHaveText(customer);
  for (const tab of ['money', 'trade', 'pay', 'cards', 'documents', 'tickets'])
    await expect(page.getByTestId(`customer-tab-${tab}`)).toBeVisible();

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

  // Documents: identity's document list for this account answers in words (a list or "holds no document"), and the
  // per-document decisions identity does not keep name their blocker.
  await page.getByTestId('customer-tab-documents').click();
  await expect(page.getByTestId('customer-panel-documents')).toBeVisible({ timeout: 60_000 });
  const documents = page.getByTestId('read-identity.documents');
  await expect(documents.getByText(/As of /).first()).toBeVisible();
  await expect(page.getByTestId('unwired-documents.decisions')).toContainText('no source');

  for (const tab of ['cards', 'tickets']) {
    await page.getByTestId(`customer-tab-${tab}`).click();
    await expect(page.getByTestId(`customer-panel-${tab}`)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId(`customer-panel-${tab}`)).toContainText('ops.customer_record_source_unwired');
  }
});
