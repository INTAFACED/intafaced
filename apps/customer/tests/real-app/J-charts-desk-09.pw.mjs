import { test, expect } from './journey.mjs';
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

/**
 * The mid of two decimal strings as svc-notify writes it (midDecimalString): both scaled to the larger number of decimal
 * places, summed, halved with the remainder dropped, and trailing zeros trimmed. Worked in bigint, never a JS number.
 */
function midOf(bidText, askText) {
  const [bi, bf = ''] = bidText.split('.');
  const [ai, af = ''] = askText.split('.');
  const scale = Math.max(bf.length, af.length);
  const mid = (BigInt(bi + bf.padEnd(scale, '0')) + BigInt(ai + af.padEnd(scale, '0'))) / 2n;
  if (scale === 0) return mid.toString();
  const raw = mid.toString().padStart(scale + 1, '0');
  const frac = raw.slice(-scale).replace(/0+$/, '');
  return frac ? `${raw.slice(0, -scale)}.${frac}` : raw.slice(0, -scale);
}

// svc-notify's own readiness on the TEST stack: `alerts.sweep.lastAt` is when its last alert sweep finished.
const NOTIFY = 'http://127.0.0.1:14510';
const lastSweepAt = async () => (await (await fetch(`${NOTIFY}/ready`)).json()).alerts.sweep.lastAt;

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

// Last in the file (the steps run in order on one account), so the alerts it adds change no count the steps above read.
test(`${J} #2 chooses the bid, the ask or the last trade as the source, adds conditions up to the cap; an indicator alert refuses`, async () => {
  test.setTimeout(6 * SWEEP_MS);
  // The TEST book has a spread, so at any one moment its best ask sits above its mid and its mid above its best bid.
  const res = await fetch(`${EDGE}/api/v1/ticker/${encodeURIComponent('BTC/USDT')}`);
  const { bid, ask, last } = await res.json();
  expect(cents(String(ask)) - cents(String(bid)), 'the TEST book has a spread').toBeGreaterThan(2n);
  // The sources offered, as the person reads them.
  const source = form().getByRole('combobox', { name: 'Price to watch' });
  const MID = 'Mid price (the last trade when one side of the book is empty)';
  await expect(source.locator('option')).toHaveText([MID, 'Best bid', 'Best ask', 'Last trade']);
  // One alert per source, each at or above its own level far under the market, so one sweep fires all four together.
  // The TEST market maker moves the book further in a minute than its spread, so a level between two sides would be luck:
  // the price each alert fired at is what shows which price it watched.
  const watches = [
    { name: 'TEST on the mid', label: MID, suffix: '', level: testPrice(80, String(last)) },
    { name: 'TEST on the ask', label: 'Best ask', suffix: ' · Best ask', level: testPrice(79, String(last)) },
    { name: 'TEST on the bid', label: 'Best bid', suffix: ' · Best bid', level: testPrice(78, String(last)) },
    { name: 'TEST on the last trade', label: 'Last trade', suffix: ' · Last trade', level: testPrice(77, String(last)) },
  ];
  // Sweeps are a minute apart. Start right after one lands, so all four are saved well before the next.
  const sweptBefore = await lastSweepAt();
  await expect.poll(lastSweepAt, { timeout: SWEEP_MS + 15_000, intervals: [1_000] }).not.toBe(sweptBefore);
  const sweptAt = Date.parse(await lastSweepAt());
  for (const { name, label, suffix, level } of watches) {
    await source.selectOption({ label });
    await createAlert({ condition: 'At or above', price: level, name });
    await expect(rowWith(name).getByTestId('nf-body').first()).toHaveText(`At or above ${level} USDT${suffix}`);
  }
  expect(Date.now() - sweptAt, 'all four were saved inside one sweep interval').toBeLessThan(SWEEP_MS - 5_000);
  const log = page.getByTestId('alerts-log');
  const trigger = (level) => log.getByTestId('alert-trigger').filter({ hasText: `At or above ${level}.` });
  await expect(async () => {
    await page.reload();
    for (const { level } of watches) await expect(trigger(level)).toHaveCount(1, { timeout: 2_000 });
  }).toPass({ timeout: 3 * SWEEP_MS, intervals: [5_000] });
  // The log as the page read it, for each trigger's exact time.
  const triggersRead = page.waitForResponse((r) => /notify\.alertTriggers\b/.test(r.url()) && r.ok());
  await page.reload();
  const answer = await (await triggersRead).json();
  const items = (Array.isArray(answer) ? answer[0] : answer).result.data.items;
  const fired = {};
  for (const { name, level } of watches) {
    await expect(trigger(level)).toHaveCount(1);
    const text = await trigger(level).getByTestId('nf-body').textContent();
    const price = /Price when it triggered: (\d+(?:\.\d+)?)/.exec(text)?.[1];
    expect(price, text).toBeTruthy();
    const item = items.find((t) => cents(String(t.targetPrice)) === cents(level));
    expect(item, `the trigger at ${level}`).toBeTruthy();
    fired[name] = { price, at: Date.parse(item.firedAt) };
    await expect(rowWith(name)).toHaveAttribute('data-status', 'fired');
  }
  const [mid, onAsk, onBid, onLast] = watches.map((w) => fired[w.name]);
  // One sweep: every trigger carries that sweep's one time. In one pass every price of a market comes from one read of the book.
  for (const other of [onAsk, onBid, onLast]) expect(other.at, 'all four fired in the same sweep').toBe(mid.at);
  // The mid alert fired at exactly the mid of what the ask and bid alerts fired at, with the ask above it and the bid below.
  // An ask or bid alert that fell back to the mark would have fired at the mid itself, and this would fail.
  expect(cents(onAsk.price) - cents(onBid.price), 'the book had a spread in that sweep').toBeGreaterThan(1n);
  expect(mid.price, `mid of bid ${onBid.price} and ask ${onAsk.price}`).toBe(midOf(onBid.price, onAsk.price));
  expect(cents(onAsk.price) > cents(mid.price) && cents(mid.price) > cents(onBid.price), 'bid < mid < ask').toBe(true);
  // The last-trade alert fired at the price of the TEST tape's latest trade at that sweep, read from the public tape.
  const tape = await (
    await fetch(`${EDGE}/api/v1/trades/${encodeURIComponent('BTC/USDT')}?limit=500&since=${onLast.at - 2 * SWEEP_MS}`)
  ).json();
  expect(Array.isArray(tape) && tape.length > 0, 'the TEST tape has trades').toBe(true);
  const upTo = tape.filter((t) => t.timestamp <= onLast.at + 5_000).sort((a, b) => b.timestamp - a.timestamp);
  // The latest print at the sweep, and any print in the few seconds around it (the read is a moment after the sweep's time).
  const prints = upTo.filter((t, i) => i === 0 || t.timestamp >= onLast.at - 5_000).map((t) => fromCents(cents(String(t.price))));
  expect(prints, `the last-trade alert fired at ${onLast.price}, a print on the tape`).toContain(fromCents(cents(onLast.price)));

  // Conditions up to the owner's cap (the main one included), saved and read back.
  const quotaRead = page.waitForResponse((r) => /notify\.alertQuota\b/.test(r.url()));
  await page.reload();
  const quota = await (await quotaRead).text();
  const max = Number(/"maxConditions":\s*(\d+)/.exec(quota)?.[1]);
  expect(max, `the cap the service publishes (${quota.slice(0, 200)})`).toBeGreaterThan(1);
  const add = form().getByRole('button', { name: 'Add a condition' });
  for (let n = 1; n < max; n += 1) {
    await expect(add).toBeEnabled();
    await add.click();
  }
  const extraRows = form().getByTestId('alerts-extra');
  await expect(extraRows).toHaveCount(max - 1);
  await expect(add).toBeDisabled();
  await expect(form().getByTestId('alerts-extra-cap')).toHaveText(`An alert holds at most ${max} conditions, the first one included.`);
  // Above the market, and each extra a level of its own, so the alert stays active and every condition is told apart.
  const extras = Array.from({ length: max - 1 }, (_, i) => ({
    words: i % 2 === 0 ? 'At or below' : 'At or above',
    price: testPrice(160 + i, String(last)),
  }));
  for (const [i, extra] of extras.entries()) {
    await extraRows.nth(i).getByLabel('And also when the price is').selectOption({ label: extra.words });
    await extraRows.nth(i).getByLabel('Price for this condition').fill(extra.price);
  }
  const main = testPrice(150, String(last));
  await createAlert({ condition: 'At or above', price: main, name: 'TEST with conditions' });
  await page.reload();
  const saved = rowWith('TEST with conditions');
  await expect(saved).toHaveAttribute('data-status', 'active');
  await expect(saved.getByTestId('nf-body').first()).toHaveText(`At or above ${main} USDT`);
  for (const extra of extras) {
    await expect(saved.getByTestId('nf-body').filter({ hasText: `and ${extra.words} ${extra.price} USDT` })).toHaveCount(1);
  }

  // An indicator alert is listed and refused in words: nothing can go to review.
  await form().getByRole('combobox', { name: 'Alert on' }).selectOption({ label: 'An indicator (RSI, moving averages)' });
  await expect(form().getByTestId('alerts-kind-refused')).toHaveText(
    'Indicator alerts are not offered, so this one cannot be saved. Choose the price to set an alert.',
  );
  await expect(form().getByRole('button', { name: 'Review alert' })).toBeDisabled();
  await form().getByRole('combobox', { name: 'Alert on' }).selectOption({ label: 'The price' });
  await expect(form().getByTestId('alerts-kind-refused')).toHaveCount(0);
});
