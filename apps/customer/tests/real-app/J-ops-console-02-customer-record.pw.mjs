import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { makeContext } from '../../../../tooling/scripts/local-test-gates.mjs';
import { FOUNDER_VAULT_NAME } from '../../../../tooling/scripts/local-test-founders.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { tool } from './stack.mjs';

// J-ops-console-02 steps #3 and #4: /accounts/:userId shows the money, trade, pay, cards, documents and tickets tabs for one
// account, each read loading or refusing on its own, and a part no service can read for one account names why; with svc-trade
// stopped only the trade tab's read refuses and every other read keeps its state (#3). And the risk card and indicator strip,
// which say there is no risk level and nothing is set rather than show a number (#4).
// #3's last clause, a staff member without the cards scope seeing "permission denied", fails by name: the console signs in
// founders only until staff access (OPS-admin-access-03) is built, so there is no such member to sign in yet. Step #5
// (each document's status and the viewer) is its own test, J-ops-console-02-documents.pw.mjs.
// The account looked at is the stack's second TEST founder, an account that always exists on the stack.

async function secondFounder() {
  const ctx = await makeContext({ log: () => {} });
  const vault = JSON.parse(readFileSync(path.join(ctx.paths.stateDir, FOUNDER_VAULT_NAME), 'utf8'));
  const customer = vault.founders[1]?.userId;
  if (!customer) throw new Error('the stack has no second founder yet: start the stack first (pnpm local:stack)');
  return customer;
}

/**
 * A read's state: 'read' when it answered, or its refusal (heading and code; a read can refuse for its own reason, such as
 * a scope). Times are left out, so the same answer read twice compares equal.
 */
async function readState(section) {
  await expect(section.getByText(/As of /).first()).toBeVisible({ timeout: 60_000 });
  const failed = section.getByTestId('read-failed');
  if (!(await failed.count())) return 'read';
  const text = await failed.innerText();
  return `${text.split('\n')[0]} / ${/Code: (\S+)/.exec(text)?.[1] ?? 'no code'}`;
}

/** Every read on one tab of the record, by its id, after opening that tab. */
async function tabStates(page, tab) {
  await page.getByTestId(`customer-tab-${tab}`).click();
  const panel = page.getByTestId(`customer-panel-${tab}`);
  await expect(panel).toBeVisible({ timeout: 60_000 });
  const states = {};
  for (const section of await panel.locator('[data-testid^="read-"]:not([data-testid="read-failed"])').all())
    states[await section.getAttribute('data-testid')] = await readState(section);
  return states;
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
  // Nothing numeric: once slice ids and codes are left out, neither shows a digit, a meter or a progress bar.
  for (const part of [risk, indicators]) {
    const words = (await part.innerText()).replace(/\b[A-Z]+(?:-[a-z]+)+-\d+\b/g, '').replace(/Code: \S+/g, '');
    expect(words, 'no score, level number or value').not.toMatch(/\d/);
    await expect(part.getByRole('meter')).toHaveCount(0);
    await expect(part.getByRole('progressbar')).toHaveCount(0);
  }
});

test('J-ops-console-02 #3 one customer record: six tabs each loading or refusing on its own', async ({ page }) => {
  test.setTimeout(480_000);
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
  await readState(balances);

  // Trade: svc-trade's restriction history answers for a founder; orders and positions name their blocker.
  await page.getByTestId('customer-tab-trade').click();
  await expect(page.getByTestId('customer-panel-trade')).toBeVisible({ timeout: 60_000 });
  expect(await readState(page.getByTestId('read-trade.controls'))).toBe('read');
  await expect(page.getByTestId('unwired-trade.orders')).toContainText('no source');

  // Pay: the two allowlist reads each answer or refuse alone.
  const pay = await tabStates(page, 'pay');
  expect(Object.keys(pay)).toEqual(expect.arrayContaining(['read-pay.allowlist-mode', 'read-pay.allowlist-policy']));

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

  // svc-trade down: the trade tab's read refuses as unavailable, and every read on the money, pay and documents tabs keeps
  // the state it had before.
  const before = { money: await tabStates(page, 'money'), pay, documents: await tabStates(page, 'documents') };
  expect(Object.keys(before.money)).toContain('read-bank.customer-balances');
  expect(Object.keys(before.documents)).toContain('read-identity.documents');
  let failure = null;
  try {
    tool('local-test-stack.mjs', 'stop', 'trade');
    await page.goto(`${ADMIN}/accounts/${customer}`, { waitUntil: 'load' });
    await expect(page.getByTestId('customer-record-id')).toHaveText(customer, { timeout: 60_000 });
    await page.getByTestId('customer-tab-trade').click();
    const refused = page.getByTestId('read-trade.controls').getByTestId('read-failed');
    await expect(refused).toBeVisible({ timeout: 60_000 });
    // Unavailable, not a refused session or a part not switched on: the stopped service is the reason.
    await expect(refused).toHaveAttribute('data-tone', 'danger');
    for (const tab of ['money', 'pay', 'documents'])
      expect(await tabStates(page, tab), `the ${tab} tab's reads are as they were`).toEqual(before[tab]);
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
  // svc-trade answers again, so the journeys after this one find it as it was.
  await page.goto(`${ADMIN}/accounts/${customer}?tab=trade`, { waitUntil: 'load' });
  await expect(page.getByTestId('customer-panel-trade')).toBeVisible({ timeout: 60_000 });
  expect(await readState(page.getByTestId('read-trade.controls'))).toBe('read');

  // A staff member without the cards scope sees "permission denied" on the cards tab. The console has no staff sign-in yet,
  // so this clause cannot run and the step stays red for that reason until staff access is built.
  const staffWithoutCards = null;
  expect(
    staffWithoutCards,
    'no staff member without the cards scope can sign in to the console: it signs in founders only until staff access (OPS-admin-access-03) is built',
  ).not.toBeNull();
});
