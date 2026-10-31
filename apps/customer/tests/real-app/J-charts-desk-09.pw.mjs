import { test, expect } from '@playwright/test';
import { signUp } from './desk.mjs';
import { EDGE, ORIGIN } from './stack.mjs';

// J-charts-desk-09, in the running app (docs/roadmap/journeys.json): a person sets price alerts, manages them and reads
// what fired. One test per step, titled "J-charts-desk-09 #<n>", run in order on one TEST account in one browser. The
// alert engine is the stack's own svc-notify: it reads the TEST market maker's book and sweeps once a minute. Prices are
// TEST prices worked from what Edge serves for BTC/USDT, never typed in.
const J = 'J-charts-desk-09';
const ALERTS = '/notifications?view=alerts';
// svc-notify sweeps every minute (ALERT_SWEEP_INTERVAL_MS, services/svc-notify/src/alerts/service.ts).
const SWEEP_MS = 60_000;

test.describe.configure({ mode: 'serial' });

let page;
test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ baseURL: ORIGIN });
  page = await context.newPage();
  // The person has picked UTC+8 in Settings, so a time shown in their zone names it and differs from the device's.
  await page.addInitScript((key) => {
    const saved = JSON.parse(localStorage.getItem(key) ?? '{}');
    if (!saved.timeZoneChosen) localStorage.setItem(key, JSON.stringify({ ...saved, timeZone: 'UTC+8', timeZoneChosen: true }));
  }, 'intafaced.customer.view.v1');
  await signUp(page, 'jcd09');
  await page.goto(ALERTS);
  await expect(form()).toBeVisible();
  // The form opens once the markets, the list and the quota have loaded; a reason shows beside it until then.
  await expect(marketSelect(), 'the alert form opens once its data has loaded').toBeEnabled();
});
test.afterAll(async () => {
  await page?.context().close();
});

const form = () => page.getByTestId('alerts-form');
const marketSelect = () => form().getByRole('combobox', { name: /^Market/ });
const rows = () => page.getByTestId('alerts-list').getByTestId('alert-row');
const rowWith = (text) => rows().filter({ hasText: text });

/** BTC/USDT's last price as Edge serves it: a decimal string. */
async function lastText() {
  const res = await fetch(`${EDGE}/api/v1/ticker/${encodeURIComponent('BTC/USDT')}`);
  expect(res.status).toBe(200);
  const text = String((await res.json()).last);
  expect(text).toMatch(/^\d+(\.\d+)?$/);
  return text;
}

/** A decimal string in hundredths (BTC/USDT's 0.01 tick), as a bigint. */
const cents = (text) => {
  const [whole, frac = ''] = text.split('.');
  return BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
};
const fromCents = (n) => `${n / 100n}.${String(n % 100n).padStart(2, '0')}`;

/** A TEST price on the 0.01 tick: the last price times percent / 100, worked in scaled bigint. */
const testPrice = (percent, last) => fromCents((cents(last) * BigInt(percent)) / 100n);

/** A local date-time `days` ahead, as the browser's datetime-local input takes it. */
const daysAhead = (days) =>
  page.evaluate((d) => {
    const at = new Date(Date.now() + d * 86_400_000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
  }, days);

/** Fills the form for BTC/USDT and saves it through the review. */
async function createAlert({ condition, price, name, message, expires }) {
  await marketSelect().selectOption({ label: 'BTC/USDT' });
  await form().getByLabel('Notify me when the price is').selectOption({ label: condition });
  await form().getByLabel('Price (USDT)').fill(price);
  await form()
    .getByLabel('Name (optional)')
    .fill(name ?? '');
  await form()
    .getByLabel('Message (optional)')
    .fill(message ?? '');
  if (expires) await form().getByLabel('Stop watching at (optional)').fill(expires);
  await form().getByRole('button', { name: 'Review alert' }).click();
  await expect(page.getByRole('heading', { name: 'Review your alert' })).toBeVisible();
  await page.getByRole('button', { name: 'Save alert' }).click();
  await expect(page.getByTestId('alerts-notices').getByRole('status')).toHaveText('Alert saved. It is active and appears in your list.');
}

test(`${J} #1 creates an alert crossing up through a TEST price with a 30-day expiry and a message; a blank target is refused`, async () => {
  // A blank price is refused in words, and nothing goes to review.
  await marketSelect().selectOption({ label: 'BTC/USDT' });
  await form().getByLabel('Notify me when the price is').selectOption({ label: 'Crossing up through' });
  await form().getByRole('button', { name: 'Review alert' }).click();
  await expect(form()).toContainText('Enter a price.');
  await expect(page.getByRole('heading', { name: 'Review your alert' })).toHaveCount(0);
  // Well above the market, so it stays active through this journey.
  const target = testPrice(150, await lastText());
  await createAlert({
    condition: 'Crossing up through',
    price: target,
    name: 'TEST breakout',
    message: 'TEST: BTC/USDT broke out',
    expires: await daysAhead(30),
  });
  // Stored: it is in the list after a reload, active, with its condition, exact price, message and expiry.
  await page.reload();
  const row = rowWith('TEST breakout');
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('data-status', 'active');
  await expect(row).toContainText(`Crossing up through ${target} USDT`);
  await expect(row).toContainText('TEST: BTC/USDT broke out');
  await expect(row).toContainText('Active');
  await expect(row).toContainText(/Expires /);
});

test(`${J} #3 manages alerts: each shows its market, side, exact price and status; sort, edit, stop, resume, cancel and delete`, async () => {
  const at = await lastText();
  const low = testPrice(50, at);
  const mid = testPrice(60, at);
  await createAlert({ condition: 'At or below', price: low, name: 'TEST dip' });
  await createAlert({ condition: 'At or below', price: mid, name: 'TEST pullback' });
  // Each row: the market (as its name when it has none, here in the condition's quote), side, exact price, status.
  for (const [name, price] of [
    ['TEST dip', low],
    ['TEST pullback', mid],
  ]) {
    await expect(rowWith(name)).toContainText(`At or below ${price} USDT`);
    await expect(rowWith(name)).toHaveAttribute('data-status', 'active');
    await expect(rowWith(name).getByRole('button', { name: 'Cancel the alert on BTC/USDT' })).toBeVisible();
  }
  // Sorted by price, low to high: the dip, the pullback, then the breakout from #1.
  await page.getByTestId('alerts-find').getByLabel('Sort by').selectOption({ label: 'Price, low to high' });
  await expect(rows().getByTestId('nf-title')).toHaveText(['TEST dip', 'TEST pullback', 'TEST breakout']);
  // Edit: the pullback's name; the list shows the change.
  await rowWith('TEST pullback').getByRole('button', { name: 'Edit the alert on BTC/USDT' }).click();
  const edit = page.getByTestId('alert-edit');
  await edit.getByLabel('Name (optional)').fill('TEST deeper pullback');
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await expect(rowWith('TEST deeper pullback')).toHaveCount(1);
  // Stop, then resume.
  const pullback = rowWith('TEST deeper pullback');
  await pullback.getByRole('button', { name: 'Pause the alert on BTC/USDT' }).click();
  await expect(pullback).toHaveAttribute('data-status', 'stopped');
  await expect(pullback).toContainText('Stopped');
  await pullback.getByRole('button', { name: 'Resume the alert on BTC/USDT' }).click();
  await expect(pullback).toHaveAttribute('data-status', 'active');
  // The Active filter lists the three active alerts.
  await page.getByTestId('alerts-find').getByLabel('Show').selectOption({ label: 'Active' });
  await expect(rows()).toHaveCount(3);
  await page.getByTestId('alerts-find').getByLabel('Show').selectOption({ label: 'All alerts' });
  // Cancel the dip after the confirmation: it stays listed as cancelled, with no cancel left on it.
  const dip = rowWith('TEST dip');
  await dip.getByRole('button', { name: 'Cancel the alert on BTC/USDT' }).click();
  await dip.getByRole('button', { name: 'Yes, cancel it' }).click();
  await expect(dip).toHaveAttribute('data-status', 'cancelled');
  await expect(dip.getByRole('button', { name: 'Cancel the alert on BTC/USDT' })).toHaveCount(0);
  // Delete it after the confirmation: it leaves the list, and stays gone after a reload.
  await dip.getByRole('button', { name: 'Delete the alert on BTC/USDT' }).click();
  await dip.getByRole('button', { name: 'Yes, delete it' }).click();
  await expect(rowWith('TEST dip')).toHaveCount(0);
  await page.reload();
  await expect(rowWith('TEST dip')).toHaveCount(0);
  await expect(rows()).toHaveCount(2);
});

test(`${J} #4 edits an alert from one price to another: the new price and a modified time`, async () => {
  // A fresh alert nothing has changed yet: it shows no modified time until the edit.
  const first = testPrice(55, await lastText());
  await createAlert({ condition: 'At or below', price: first, name: 'TEST edit me' });
  const row = rowWith('TEST edit me');
  await expect(row.getByTestId('nf-body').first()).toHaveText(`At or below ${first} USDT`);
  await expect(row.locator('.nf-muted')).not.toContainText('Modified');
  const price = testPrice(52, await lastText());
  expect(price).not.toBe(first);
  await row.getByRole('button', { name: 'Edit the alert on BTC/USDT' }).click();
  const edit = page.getByTestId('alert-edit');
  await edit.getByLabel('Price (USDT)').fill(price);
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByTestId('alerts-notices').getByRole('status')).toHaveText('Alert updated.');
  // The new price, kept by the service: it is there after a reload.
  await page.reload();
  await expect(rowWith('TEST edit me').getByTestId('nf-body').first()).toHaveText(`At or below ${price} USDT`);
  // A modified time, in the person's zone (UTC+8), within the last few minutes there, after the created time.
  const muted = await rowWith('TEST edit me').locator('.nf-muted').textContent();
  const m = /Modified (\d{1,2} [A-Z][a-z]{2,3}(?: \d{4})?), (\d\d):(\d\d) UTC\+8/.exec(muted);
  expect(m, `"${muted}" names a UTC+8 modified time`).toBeTruthy();
  const nowThere = new Date(Date.now() + 8 * 3_600_000);
  const minutes = (nowThere.getUTCHours() * 60 + nowThere.getUTCMinutes() - (Number(m[2]) * 60 + Number(m[3])) + 1440) % 1440;
  expect(minutes).toBeLessThanOrEqual(5);
  expect(muted.indexOf('Created')).toBeLessThan(muted.indexOf('Modified'));
});

test(`${J} #6 reads the trigger log: when it fired, at what price, in the person's time zone, for the retention window`, async () => {
  test.setTimeout(4 * SWEEP_MS);
  // At or below a level above the market: the next sweep reads a mark under it and fires.
  const target = testPrice(120, await lastText());
  await createAlert({ condition: 'At or below', price: target, name: 'TEST fires' });
  const log = page.getByTestId('alerts-log');
  const fired = log.getByTestId('alert-trigger').filter({ hasText: `At or below ${target}.` });
  await expect(async () => {
    await page.reload();
    await expect(fired).toHaveCount(1, { timeout: 2_000 });
  }).toPass({ timeout: 3 * SWEEP_MS, intervals: [5_000] });
  // What it fired at: a real mark, at or below the level, near the market Edge serves.
  const text = await fired.getByTestId('nf-body').textContent();
  const mark = /Price when it triggered: (\d+(?:\.\d+)?)/.exec(text)?.[1];
  expect(mark, text).toBeTruthy();
  expect(cents(mark) <= cents(target), `mark ${mark} at or below ${target}`).toBe(true);
  // Within 5% of the market Edge serves now.
  const gap = cents(mark) - cents(await lastText());
  expect((gap < 0n ? -gap : gap) * 20n <= cents(mark), `mark ${mark} near the market`).toBe(true);
  await expect(fired.getByTestId('nf-title')).toHaveText('BTC/USDT');
  // When: in the person's zone (UTC+8), named, and within the last few minutes there.
  const when = await fired.locator('.nf-muted').textContent();
  const m = /^Triggered (\d{1,2} [A-Z][a-z]{2,3}(?: \d{4})?), (\d\d):(\d\d) UTC\+8$/.exec(when.trim());
  expect(m, `"${when}" is a UTC+8 time`).toBeTruthy();
  const nowThere = new Date(Date.now() + 8 * 3_600_000);
  const shownMinutes = Number(m[2]) * 60 + Number(m[3]);
  const nowMinutes = nowThere.getUTCHours() * 60 + nowThere.getUTCMinutes();
  expect((nowMinutes - shownMinutes + 1440) % 1440).toBeLessThanOrEqual(5);
  // The retention window the service keeps the log for.
  await expect(log).toContainText(/Kept for \d+ days\./);
  // The alert itself reads triggered, with the same time.
  const row = rowWith('TEST fires');
  await expect(row).toHaveAttribute('data-status', 'fired');
  await expect(row).toContainText(`Triggered ${m[1]}, ${m[2]}:${m[3]} UTC+8`);
});

test(`${J} #9 reads the evaluation status: whether server-side checks are connected, as the service reports it, with no promise of delivery`, async () => {
  // The state the service sends with the list, and the words the page shows for it.
  const listed = page.waitForResponse((res) => /notify\.alerts\b/.test(res.url()) && res.request().method() === 'GET');
  await page.reload();
  const body = await (await listed).text();
  const canFire = /"canFire":\s*(true|false)/.exec(body)?.[1];
  expect(canFire, 'the alerts reply carries the evaluation state').toBeTruthy();
  // The stack's checks are connected (and #6 showed an alert firing from the service's own sweep), and the page says so.
  expect(canFire).toBe('true');
  const banner = page.getByTestId('alerts-evaluation');
  await expect(banner).toContainText('Price checks are connected.');
  // Never a promise that a message reaches the person.
  await expect(banner).not.toContainText(/will be delivered|will reach you|you will (receive|get)/i);
});
