// World: market
import { test, expect } from './journey.mjs';
import { signUp } from './desk.mjs';
import { EDGE, ORIGIN, bestPrices, tool } from './stack.mjs';

// J-charts-desk-09, in the running app (docs/roadmap/journeys.json): a person sets price alerts, manages them and reads
// what fired. One test per step, titled "J-charts-desk-09 #<n>", run in order on one TEST account in one browser. The
// alert engine is the stack's own svc-notify: it reads the TEST market maker's book and sweeps once a minute. Prices are
// TEST prices worked from what Edge serves for BTC/USDT, never typed in.
const J = 'J-charts-desk-09';
const ALERTS = '/notifications?view=alerts';
// svc-notify sweeps every minute (ALERT_SWEEP_INTERVAL_MS, services/svc-notify/src/alerts/service.ts).
const SWEEP_MS = 60_000;

test.describe.configure({ mode: 'serial' });
// An action on a part that never becomes usable fails in 15 s, not at the step's time limit.
test.use({ actionTimeout: 15_000 });

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
async function createAlert({ condition, price, name, message, expires, repeat }) {
  await marketSelect().selectOption({ label: 'BTC/USDT' });
  await form().getByLabel('Notify me when the price is').selectOption({ label: condition });
  if (repeat) {
    // The page draws its own box over the input, so the person clicks the label.
    await form().getByTestId('alerts-repeat').click();
    await expect(form().getByTestId('alerts-repeat').getByRole('checkbox')).toBeChecked();
  }
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

const CHART = '/charts/BTC-USDT';
const chartHost = () => page.getByTestId('cw').getByTestId('wc-host');

/** The price pane's box on the page: the trading overlay names where it sits in the chart (a volume pane sits below it). */
async function pricePaneBox() {
  const box = await chartHost().boundingBox();
  const overlay = page.getByTestId('cw').getByTestId('chart-trading-overlay');
  const top = Number(await overlay.getAttribute('data-pane-top'));
  const height = Number(await overlay.getAttribute('data-pane-height'));
  expect(height).toBeGreaterThan(0);
  return { x: box.x, y: box.y + top, width: box.width, height };
}

/** The price the chart names under the pointer at a fraction of the price pane's height, from the price-axis plus button. */
async function axisPriceAt(fy) {
  const box = await pricePaneBox();
  const y = box.y + box.height * fy;
  await page.mouse.move(box.x + box.width * 0.5, y - 1);
  await page.mouse.move(box.x + box.width * 0.5, y);
  const plus = page.getByTestId('chart-axis-plus');
  await expect(plus).toBeVisible();
  await expect.poll(async () => Math.abs((await plus.boundingBox()).y + (await plus.boundingBox()).height / 2 - y)).toBeLessThan(2);
  return { y, price: Number(await plus.getAttribute('data-price')) };
}

/** The chart's own price-to-pixel line, from two readings of the price axis (the scale is linear). */
async function chartScale() {
  const a = await axisPriceAt(0.25);
  const b = await axisPriceAt(0.75);
  return {
    yOf: (price) => a.y + ((Number(price) - a.price) * (b.y - a.y)) / (b.price - a.price),
    perPixel: (a.price - b.price) / (b.y - a.y),
  };
}

test(`${J} #5 sees the alert level on the chart and drags it: the level line moves and the alert updates once`, async () => {
  // A level the chart shows: the price the chart's own axis names a third of the way down its price pane, on the tick.
  await page.goto(CHART);
  await expect(chartHost()).toBeVisible();
  const level = fromCents(cents(String((await axisPriceAt(0.3)).price.toFixed(2))));
  // An active alert that does not fire during the step: crossing towards the level from the other side of the market.
  const above = cents(level) > cents(await lastText());
  const condition = above ? 'Crossing down through' : 'Crossing up through';
  await page.goto(ALERTS);
  await expect(marketSelect()).toBeEnabled();
  await createAlert({ condition, price: level, name: 'TEST on the chart' });
  await page.goto(CHART);
  await expect(chartHost()).toBeVisible();
  // The level on the chart: its handle names the condition and the exact price, and sits at that price's pixel.
  const line = page.getByTestId('chart-alert-line').filter({ hasText: `Alert: ${condition} ${level} USDT` });
  await expect(line).toHaveCount(1);
  await expect(line).toHaveAttribute('data-price', level);
  await expect(page.getByTestId('chart-alert-row').filter({ hasText: `Alert: ${condition} ${level} USDT` })).toHaveCount(1);
  const scale = await chartScale();
  const atLevel = await line.boundingBox();
  expect(Math.abs(atLevel.y + atLevel.height / 2 - scale.yOf(level)), 'the handle sits at its price').toBeLessThan(3);

  // Every edit this page sends from now on.
  const edits = [];
  page.on('request', (request) => {
    if (/notify\.updateAlert\b/.test(request.url()) && request.method() === 'POST') edits.push(request.postData());
  });
  // Drag the handle up by 40 pixels: the chart names the price it is dropped at.
  const from = atLevel.y + atLevel.height / 2;
  const to = from - 40;
  await page.mouse.move(atLevel.x + atLevel.width / 2, from);
  await page.mouse.down();
  await page.mouse.move(atLevel.x + atLevel.width / 2, to, { steps: 12 });
  await page.mouse.up();
  const note = page.getByTestId('chart-alerts-note');
  await expect(note).toHaveAttribute('data-tone', 'good');
  const moved = /^The alert now watches (\d+(?:\.\d+)?) USDT\.$/.exec(((await note.textContent()) ?? '').trim())?.[1];
  expect(moved, 'the note names the price the service now holds').toBeTruthy();
  // The new price is where the handle was dropped, within a few pixels' worth of price, and above the old one.
  expect(cents(moved) > cents(level), `${moved} is above ${level}`).toBe(true);
  expect(Math.abs(Number(moved) - (Number(level) + 40 * scale.perPixel)), 'dropped at its pixel').toBeLessThan(4 * scale.perPixel + 0.01);
  // The line moved: one handle, at the new price and its pixel; none left at the old one.
  const movedLine = page.getByTestId('chart-alert-line').filter({ hasText: `Alert: ${condition} ${moved} USDT` });
  await expect(movedLine).toHaveCount(1);
  await expect(page.getByTestId('chart-alert-line').filter({ hasText: `Alert: ${condition} ${level} USDT` })).toHaveCount(0);
  const atMoved = await movedLine.boundingBox();
  expect(Math.abs(atMoved.y + atMoved.height / 2 - scale.yOf(moved)), 'the handle sits at its new price').toBeLessThan(3);
  // Once: one edit, at that price.
  await page.waitForTimeout(2_000);
  expect(edits, 'one edit was sent for one drag').toHaveLength(1);
  expect(edits[0]).toContain(`"targetPrice":"${moved}"`);
  // The service holds it: after a reload the chart and the alerts page both show the new price, with a modified time.
  await page.reload();
  await expect(page.getByTestId('chart-alert-line').filter({ hasText: `Alert: ${condition} ${moved} USDT` })).toHaveCount(1);
  await page.goto(ALERTS);
  await expect(marketSelect()).toBeEnabled();
  const row = rowWith('TEST on the chart');
  await expect(row.getByTestId('nf-body').first()).toHaveText(`${condition} ${moved} USDT`);
  await expect(row).toHaveAttribute('data-status', 'active');
  await expect(row.locator('.nf-muted')).toContainText('Modified');
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
  // The last-trade alert fired at the price of the TEST tape's latest trade at that sweep, read from the public tape. The
  // latest print can be older than the sweep by any amount (on a quiet shard nothing traded BTC/USDT for minutes: main run
  // 42187412745), so the tape is read newest first with no time cut, never only the last two sweeps.
  const tape = await (await fetch(`${EDGE}/api/v1/trades/${encodeURIComponent('BTC/USDT')}?limit=500`)).json();
  expect(Array.isArray(tape) && tape.length > 0, 'the TEST tape has trades').toBe(true);
  // "Latest" is the tape's own order, the match sequence (a print's id), which is how the ticker picks its last
  // (svc-trade publicTape: ORDER BY sequence DESC). Never re-sort by time.
  for (const t of tape) expect(String(t.id), 'a tape print is identified by its match sequence').toMatch(/^\d+$/);
  const bySequence = [...tape].sort((a, b) => Number(b.id) - Number(a.id));
  // A trigger's time is when its sweep started; the sweep reads the ticker a moment later. So the alert fired on the
  // latest print written by the sweep's start, or on one written in the few seconds before its read. A print after the
  // read is not the one it saw, and must not stand in for it (main run 42447632070 and PR #7526's repeat 42451286997:
  // the TEST maker sold at 65153.12 on its cycle 7, the sweep read the cycle-12 book, bid 65231.23 and ask 65309.57,
  // with that print still its last, and the cycle-13 sale at 65152.95 landed within 5 s after the sweep's start;
  // taking the latest print up to 5 s after the start as "the latest at the sweep" dropped the one the alert read).
  const atStart = bySequence.find((t) => t.timestamp <= onLast.at);
  const justAfter = bySequence.filter((t) => t.timestamp > onLast.at && t.timestamp <= onLast.at + 5_000);
  const prints = [...(atStart ? [atStart] : []), ...justAfter].map((t) => fromCents(cents(String(t.price))));
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

const watchlists = () => page.getByRole('region', { name: 'Watchlists' });
/** Opens the chart with the person's account watchlists read, and adds a market to the selected list by search. */
async function addToWatchlist(symbol) {
  await page.goto(CHART);
  await expect(watchlists()).toHaveAttribute('data-status', /^(ready|error)$/);
  expect(await watchlists().getAttribute('data-status'), "the person's saved lists were read").toBe('ready');
  const saved = page.waitForResponse((res) => /preferences/.test(res.url()) && res.request().method() !== 'GET' && res.ok());
  await watchlists().getByRole('searchbox', { name: 'Add a market' }).fill(symbol.split('/')[0].toLowerCase());
  await watchlists()
    .getByRole('button', { name: `Add ${symbol}` })
    .click();
  await saved;
  await expect(watchlists().locator(`tr[data-symbol="${symbol}"]`)).toBeVisible();
}

test(`${J} #7 creates one alert for every market in a watchlist; a market added later is picked up on the next sweep`, async () => {
  test.setTimeout(5 * SWEEP_MS);
  // A watchlist on the account, kept beside the chart: ETH/USDT, then BTC/USDT.
  await addToWatchlist('ETH/USDT');
  await addToWatchlist('BTC/USDT');
  // Far above both markets, so no alert of this rule fires and leaves the list during the step.
  const level = testPrice(300, await lastText());
  const follow = page.getByTestId('alerts-follow');
  await page.goto(ALERTS);
  await expect(marketSelect()).toBeEnabled();
  await follow.getByRole('combobox', { name: 'Watchlist' }).selectOption({ label: 'Watchlist' });
  await expect(follow.getByTestId('alerts-follow-markets')).toHaveText('Markets on the list now: ETH/USDT, BTC/USDT');
  await follow.getByRole('combobox', { name: 'Notify me when the price is' }).selectOption({ label: 'At or above' });
  await follow.getByLabel('Price, the same for every market').fill(level);
  await follow.getByRole('button', { name: 'Review list alert' }).click();
  const review = follow.getByTestId('alerts-follow-review');
  await expect(review).toContainText('ETH/USDT, BTC/USDT');
  await expect(review).toContainText(`At or above ${level}`);
  await review.getByRole('button', { name: 'Follow this list' }).click();
  await expect(follow.getByTestId('alerts-follow-notice').getByRole('status')).toHaveText(
    'You now follow Watchlist. Each of its markets has its own alert in your list.',
  );
  // One alert per market, each active with the rule, after a reload (the service holds them).
  await page.reload();
  const ruleRows = () => rows().filter({ hasText: `At or above ${level} USDT` });
  const marketsOfRule = async () => (await ruleRows().getByTestId('nf-title').allTextContents()).sort();
  await expect(ruleRows()).toHaveCount(2);
  expect(await marketsOfRule()).toEqual(['BTC/USDT', 'ETH/USDT']);
  for (const status of await ruleRows().evaluateAll((els) => els.map((el) => el.getAttribute('data-status'))))
    expect(status).toBe('active');
  const rule = follow.getByTestId('follow-rule').filter({ hasText: 'Watchlist' });
  await expect(rule).toHaveCount(1);
  await expect(rule).toHaveAttribute('data-status', 'active');
  await expect(rule).toContainText(`At or above ${level} · ETH/USDT, BTC/USDT`);

  // A market added to the list later: the next sweep gives it the same alert, once.
  await addToWatchlist('IFC/USDT');
  const addedAt = Date.now();
  await page.goto(ALERTS);
  await expect(async () => {
    await page.reload();
    await expect(ruleRows()).toHaveCount(3, { timeout: 2_000 });
  }).toPass({ timeout: 2 * SWEEP_MS + 30_000, intervals: [5_000] });
  expect(Date.now() - addedAt, 'picked up within one sweep interval and the page reload after it').toBeLessThan(2 * SWEEP_MS + 30_000);
  expect(await marketsOfRule()).toEqual(['BTC/USDT', 'ETH/USDT', 'IFC/USDT']);
  await expect(ruleRows().filter({ has: page.getByTestId('nf-title').getByText('IFC/USDT', { exact: true }) })).toHaveAttribute(
    'data-status',
    'active',
  );
  await expect(rule).toContainText(`At or above ${level} · ETH/USDT, BTC/USDT, IFC/USDT`);
  await expect(rule.getByTestId('follow-rule-reason')).toHaveCount(0);
  // The sweep after adds nothing more.
  const sweptBefore = await lastSweepAt();
  await expect.poll(lastSweepAt, { timeout: SWEEP_MS + 15_000, intervals: [2_000] }).not.toBe(sweptBefore);
  await page.reload();
  await expect(ruleRows()).toHaveCount(3);
});

/** A shift in basis points as the TEST market tool takes it: `+0.60%`, `-1.25%`. */
const shiftText = (bps) => {
  const abs = bps < 0n ? -bps : bps;
  return `${bps < 0n ? '-' : '+'}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}%`;
};
/** BTC/USDT's book mid now, in hundredths. */
const midCents = async () => {
  const { bid, ask } = await bestPrices();
  return (cents(String(bid)) + cents(String(ask))) / 2n;
};

// Last in the file: it fills the account up to the quota, so a step after it could not save an alert.
test(`${J} #8 hits the alert quota, and an alert that triggers too often is stopped with its stop reason`, async () => {
  test.setTimeout(18 * SWEEP_MS);
  // The owner's limits, as the service publishes them with the quota.
  const quotaRead = page.waitForResponse((r) => /notify\.alertQuota\b/.test(r.url()) && r.ok());
  await page.reload();
  const published = await (await quotaRead).text();
  const max = Number(/"max":\s*(\d+)/.exec(published)?.[1]);
  const maxTriggers = Number(/"maxTriggers":\s*(\d+)/.exec(published)?.[1]);
  const windowMinutes = Number(/"windowMinutes":\s*(\d+)/.exec(published)?.[1]);
  expect(
    max > 0 && maxTriggers > 0 && windowMinutes > 0,
    `the quota and burst rule the service publishes (${published.slice(0, 300)})`,
  ).toBe(true);
  // Every trigger of the burst comes from its own sweep, one a minute, so the rule must be one this journey can reach.
  expect(maxTriggers + 1, 'the burst fits inside its window at one trigger a sweep').toBeLessThan(windowMinutes);
  const burstWords = `An alert that triggers more than ${maxTriggers} times in ${windowMinutes} minutes is stopped.`;

  // The burst: a crossing alert that repeats, at the level the market stands at now. The TEST market maker's price is then
  // moved to just under the level and over it again, sweep after sweep, so every sweep sees a real crossing.
  const level = await midCents();
  const levelText = fromCents(level);
  await form().getByRole('combobox', { name: 'Price to watch' }).selectOption({ index: 0 });
  await createAlert({ condition: 'Crossing, either way,', price: levelText, name: 'TEST bursts', repeat: true });
  const row = rowWith('TEST bursts');
  await expect(row.getByTestId('nf-body').first()).toHaveText(`Crossing, either way, ${levelText} USDT`);
  await expect(row.getByTestId('alert-repeats')).toContainText('Triggered so far: 0');

  let shift = 0n;
  /** Moves the TEST price to 0.6% under (-1) or over (+1) the level, from the walk's own price now, and waits for the book. */
  async function aim(sign) {
    const unshifted = ((await midCents()) * 10_000n) / (10_000n + shift);
    const target = (level * (10_000n + BigInt(sign) * 60n)) / 10_000n;
    shift = ((target - unshifted) * 10_000n) / unshifted;
    tool('local-test-market.mjs', 'move', 'BTC/USDT', shiftText(shift));
    await expect
      .poll(async () => (sign < 0 ? level - (await midCents()) : (await midCents()) - level), {
        timeout: 30_000,
        intervals: [1_000],
        message: `the book's mid moves ${sign < 0 ? 'under' : 'over'} ${levelText}`,
      })
      .toBeGreaterThan((level * 20n) / 10_000n);
  }
  /** Waits for a sweep that ran after the book got where it is now. */
  async function nextSweep() {
    const after = Date.now() + 3_000;
    await expect
      .poll(async () => Date.parse(await lastSweepAt()), { timeout: SWEEP_MS + 30_000, intervals: [2_000] })
      .toBeGreaterThan(after);
  }
  const triggered = async () => {
    await page.reload();
    return Number(/Triggered so far: (\d+)/.exec((await row.getByTestId('alert-repeats').textContent()) ?? '')?.[1]);
  };

  try {
    // First a sweep sees the price under the level, so the alert knows which side it is on.
    await aim(-1);
    await nextSweep();
    expect(await triggered(), 'no trigger while the price stays on one side').toBe(0);
    // Then one crossing a sweep, up and down, until one more than the rule allows.
    for (let n = 1; n <= maxTriggers + 1; n += 1) {
      await aim(n % 2 === 1 ? 1 : -1);
      // A sweep that read the book a moment before it moved sees no crossing yet; the next one does.
      await expect.poll(triggered, { timeout: 2 * SWEEP_MS + 30_000, intervals: [5_000], message: `trigger ${n}` }).toBe(n);
      if (n <= maxTriggers) await expect(row).toHaveAttribute('data-status', 'active');
    }
    // The trigger past the rule stopped it, and the row says why.
    await expect(row).toHaveAttribute('data-status', 'stopped');
    await expect(row).toContainText('Stopped');
    await expect(row.getByTestId('alert-stop-reason')).toHaveText('Stopped because it triggered too often. Resume it to watch again.');
    // Stopped means stopped: the next crossing triggers nothing.
    await aim(-1);
    await nextSweep();
    await nextSweep();
    expect(await triggered(), 'a stopped alert does not trigger again').toBe(maxTriggers + 1);
    await expect(row).toHaveAttribute('data-status', 'stopped');
  } finally {
    tool('local-test-market.mjs', 'move', 'BTC/USDT', '0%');
  }

  // The quota: the header names how many are in use and the limit, with the burst rule, as the service counts them.
  const header = page.getByTestId('alerts-quota');
  const usedText = /^(\d+) of (\d+) price alerts in use\./.exec(((await header.textContent()) ?? '').trim());
  expect(usedText, 'the quota header names what is in use and the limit').toBeTruthy();
  expect(Number(usedText[2])).toBe(max);
  await expect(header).toContainText(burstWords);
  // Fill every place left, far under the market so nothing fires and frees one.
  const last = await lastText();
  for (let k = Number(usedText[1]); k < max; k += 1) {
    await createAlert({ condition: 'At or below', price: testPrice(30, last), name: `TEST fill ${k + 1}` });
  }
  await page.reload();
  await expect(header).toHaveText(
    `${max} of ${max} price alerts in use. You are at the limit. Cancel or delete an alert to make room. ${burstWords}`,
  );
  // At the limit the form is switched off, saying why, and nothing can go to review.
  await expect(form().getByTestId('alerts-reason')).toHaveText(
    'Switched off: you are at your limit of price alerts. Cancel or delete one to make room.',
  );
  await expect(form().getByRole('button', { name: 'Review alert' })).toBeDisabled();
  // The service holds the same count after a reload: the list carries `max` open (active or stopped) alerts.
  await expect(rows().and(page.locator('[data-status="active"], [data-status="stopped"]'))).toHaveCount(max);
});
