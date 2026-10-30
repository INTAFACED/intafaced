import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { makeContext } from '../../../../tooling/scripts/local-test-gates.mjs';
import { FOUNDER_VAULT_NAME } from '../../../../tooling/scripts/local-test-founders.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { tool } from './stack.mjs';

// J-ops-console-02 steps #3 and #4: /accounts/:userId shows the money, trade, pay, cards, documents and tickets tabs for one
// account, each read loading or refusing on its own, and a part no service can read for one account names why; with svc-trade
// stopped only the trade tab refuses (#3). The row's last clause, a staff member without the cards scope seeing "permission
// denied", has no console sign-in to run on: the console signs in founders only until staff access (OPS-admin-access-03)
// is built, so it is not proven here. And the
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

/** A read's state: 'read' when it answered, or its refusal code (a read can refuse for its own reason, such as a scope). */
async function readState(section) {
  await expect(section.getByText(/As of /).first()).toBeVisible({ timeout: 60_000 });
  const failed = section.getByTestId('read-failed');
  if (!(await failed.count())) return 'read';
  return /Code: (\S+)/.exec(await failed.innerText())?.[1] ?? 'refused without a code';
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
  test.setTimeout(360_000);
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
  const moneyBefore = await readState(balances);
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
  await expect(page.getByTestId('read-trade.controls').getByTestId('read-failed')).toHaveCount(0);
  await expect(page.getByTestId('unwired-trade.orders')).toContainText('no source');

  // Pay: the two allowlist reads each answer or refuse alone.
  const payStates = async () => [
    await readState(page.getByTestId('read-pay.allowlist-mode')),
    await readState(page.getByTestId('read-pay.allowlist-policy')),
  ];
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

  const payBefore = await payStates();

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

  // svc-trade down: the trade tab's read refuses on its own, and the money and pay reads are exactly as they were.
  let failure = null;
  try {
    tool('local-test-stack.mjs', 'stop', 'trade');
    await page.goto(`${ADMIN}/accounts/${customer}`, { waitUntil: 'load' });
    await expect(page.getByTestId('customer-record-id')).toHaveText(customer, { timeout: 60_000 });
    await page.getByTestId('customer-tab-money').click();
    expect(await readState(page.getByTestId('read-bank.customer-balances')), 'the money read is as it was').toBe(moneyBefore);
    await page.getByTestId('customer-tab-trade').click();
    await expect(page.getByTestId('read-trade.controls').getByTestId('read-failed')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('customer-tab-pay').click();
    await expect(page.getByTestId('customer-panel-pay')).toBeVisible({ timeout: 60_000 });
    expect(await payStates(), 'the pay reads are as they were').toEqual(payBefore);
  } catch (error) {
    failure = error;
  }
  // Bring svc-trade back for the journeys after this one; a failure to restart never hides the tab's own failure.
  try {
    tool('local-test-stack.mjs', 'start', '--only', 'trade');
  } catch (restart) {
    failure ??= restart;
  }
  if (failure) throw failure;
});
