// World: gates
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { signUp } from './desk.mjs';
import { EDGE, api } from './stack.mjs';

// J-charts-desk-18 "I watch the health of market feeds, chart usage and the alert engine, and set the module's owner
// values", in the founder console (apps/admin) against the running stack. One test per step, titled "J-charts-desk-18 #<n>".
// The founder is founder A. Every value on the settings page is checked against what the customer side does with it: the
// compare add on the chart, and the customer's own alerts page and alert create.
//
// #5 and #6 change platform-wide owner values (the compare cap, the price-alert quota of one plan), so each puts the value
// it found back before it ends, through the same page, with a reason.
const J = 'J-charts-desk-18';
const RUN = Date.now().toString(36);
const SETTINGS = `${ADMIN}/trade-ops/charts/settings`;

async function openSettings(page) {
  await page.goto(SETTINGS);
  await expect(page.getByRole('heading', { name: 'Charts settings' })).toBeVisible();
}

/** Types `value` (blank clears) into the row whose input is labelled `<label>: new value`, saves it with `reason`. */
async function saveValue(page, label, value, reason) {
  const input = page.getByLabel(`${label}: new value`, { exact: true });
  await input.fill(value);
  await page.getByRole('row').filter({ has: input }).getByRole('button', { name: 'Save', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByLabel('Reason (kept in the audit)').fill(reason);
  await dialog.getByRole('button', { name: 'Save value', exact: true }).click();
  await expect(dialog.locator('[data-outcome=ok]')).toBeVisible();
}

/** The owner's chart values svc-trade serves for BTC/USDT. */
async function chartValues() {
  const res = await fetch(`${EDGE}/api/v1/charts/owner-values?symbol=${encodeURIComponent('BTC/USDT')}`);
  expect(res.status).toBe(200);
  return res.json();
}

const alertRow = (page, key, plan) =>
  page
    .getByRole('table', { name: 'Alert owner values' })
    .locator(plan ? `tr[data-key="${key}"][data-plan="${plan}"]` : `tr[data-key="${key}"]`);

test(`${J} #5 opens the module's settings page: compare cap, alert quotas and retention each not set or set; a blank compare cap refuses the customer add with the cap-unset error`, async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  await founderSignIn(page, 'a');
  await openSettings(page);
  // Compare cap: what svc-trade serves is what the page shows.
  const cap = (await chartValues()).compareCap;
  const capInput = page.getByLabel('Compare cap: new value', { exact: true });
  await expect(capInput).toHaveValue(cap === null ? '' : String(cap));
  // Alert quotas, one per plan, and the trigger log retention: each a number or "Not set", with where it comes from.
  for (const plan of ['none', 'basic', 'full', 'institutional']) {
    const row = alertRow(page, 'priceQuota', plan);
    await expect(row.locator('[data-field=current]')).toHaveText(/^(\d+|Not set)$/);
    await expect(row.locator('[data-field=source]')).toHaveText(
      /^(Set on this page, .+ UTC by .+|Deployment setting \(never set on this page\))$/,
    );
  }
  await expect(alertRow(page, 'triggerLogDays').locator('[data-field=current]')).toHaveText(/^(\d+|Not set)$/);

  // A blank compare cap: the customer's compare add refuses with the cap-unset error, and nothing is added.
  expect(Number.isInteger(cap), `the stack sets a compare cap to put back (${cap})`).toBe(true);
  await saveValue(page, 'Compare cap', '', `${J} #5 clears the compare cap to see the customer refusal (TEST ${RUN})`);
  try {
    await expect.poll(async () => (await chartValues()).compareCap).toBeNull();
    await openSettings(page);
    await expect(page.getByRole('row').filter({ has: page.getByLabel('Compare cap: new value', { exact: true }) })).toContainText(
      'Not set',
    );

    const context = await browser.newContext();
    const chart = await context.newPage();
    await chart.goto('/charts/BTC-USDT');
    const tools = chart.getByRole('group', { name: 'Compare and share' }).first();
    const picker = tools.getByRole('combobox', { name: /Compare with/ });
    const first = (await picker.locator('option').allTextContents())[0];
    await picker.selectOption(first);
    await tools.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(chart.getByTestId('compare-note')).toHaveAttribute('data-code', 'trade.chart.owner_value_unset');
    await expect(chart.getByTestId('compare-note')).toContainText('compare limit, which is not set. Nothing was added.');
    await expect(tools.getByRole('list', { name: 'Compared markets' }).getByRole('listitem')).toHaveCount(0);
    await context.close();
  } finally {
    await openSettings(page);
    await saveValue(page, 'Compare cap', String(cap), `${J} #5 puts the TEST compare cap back as it was (TEST ${RUN})`);
    await expect.poll(async () => (await chartValues()).compareCap).toBe(cap);
  }
});

test(`${J} #6 sets an alert quota for a plan and saves: the change is recorded with who and when, and customers see the new quota`, async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  // A fresh customer who has not verified is on the "Not verified" plan (`none`).
  const who = await signUp(page, `cd18q${RUN}`);
  const client = await api(who);
  const quotaLine = () => page.getByTestId('alerts-quota');
  await page.goto('/notifications?view=alerts');
  await expect(quotaLine()).toBeVisible();

  const context = await browser.newContext();
  const desk = await context.newPage();
  const founder = await founderSignIn(desk, 'a');
  await openSettings(desk);
  const row = alertRow(desk, 'priceQuota', 'none');
  const before = await row.locator('[data-field=current]').textContent();
  // The customer sees what applies to their plan now.
  await expect(quotaLine()).toContainText(before === 'Not set' ? 'has not been set' : `0 of ${before} price alerts in use`);

  // A TEST quota of 2 for the plan, saved with a reason.
  const label = 'Price alert quota, Not verified';
  const reason = `${J} #6 TEST quota of 2 for unverified accounts (${RUN})`;
  const startedAt = Date.now();
  await saveValue(desk, label, '2', reason);
  try {
    await openSettings(desk);
    await expect(alertRow(desk, 'priceQuota', 'none').locator('[data-field=current]')).toHaveText('2');
    await expect(alertRow(desk, 'priceQuota', 'none')).toHaveAttribute('data-source', 'page');
    // Recorded with who and when: the newest change names the founder, the time, the old and new value and the reason.
    const change = desk.getByRole('table', { name: 'Alert settings changes' }).locator('tbody tr').first();
    await expect(change).toHaveAttribute('data-plan', 'none');
    await expect(change.locator('[data-field=who]')).toHaveText(founder.userId);
    const at = Date.parse(await change.locator('[data-field=at]').getAttribute('data-at'));
    expect(at).toBeGreaterThanOrEqual(startedAt - 5_000);
    expect(at).toBeLessThanOrEqual(Date.now() + 5_000);
    await expect(change.locator('[data-field=old]')).toHaveText(before);
    await expect(change.locator('[data-field=new]')).toHaveText('2');
    await expect(change.locator('[data-field=reason]')).toHaveText(reason);

    // The customer sees the new quota, and it holds: two price alerts are taken, the third is refused at the quota.
    await page.reload();
    await expect(quotaLine()).toContainText('0 of 2 price alerts in use');
    const create = (n) =>
      client.post('/api/notify/trpc/notify.createAlert', { marketId: 'BTC-USDT', direction: 'above', targetPrice: String(10_000_000 + n) });
    expect((await create(1)).status).toBe(200);
    expect((await create(2)).status).toBe(200);
    const third = await create(3);
    expect(third.status).not.toBe(200);
    expect(JSON.stringify(third.body)).toContain('alert.quota_reached');
    await page.reload();
    await expect(quotaLine()).toContainText('2 of 2 price alerts in use');
  } finally {
    await openSettings(desk);
    await saveValue(desk, label, before === 'Not set' ? '' : before, `${J} #6 puts the quota back as it was (TEST ${RUN})`);
    await context.close();
  }
});
