// World: market
import { test, expect } from './journey.mjs';
import { signUp } from './desk.mjs';
import { bestPrices, EDGE, ORIGIN, stackUrl, tool } from './stack.mjs';
import { answerAfterNavigation } from './navigation.mjs';

// J-charts-desk-09 #8, in the running app (docs/roadmap/journeys.json): a person hits the alert quota, and an alert that
// triggers too often is stopped with its stop reason. #1 to #7 and #9 are in J-charts-desk-09.pw.mjs. This file has its
// own TEST account in its own browser, set up the same way (beforeAll): signed up, UTC+8 picked in Settings, the alerts
// page open with its form loaded. #8 counts what is in use from the quota header and fills the places left, so it starts
// from whatever the account holds. The alert engine is the stack's own svc-notify: it reads the TEST market maker's book
// and sweeps once a minute. Prices are TEST prices worked from what Edge serves for BTC/USDT, never typed in.
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
  await signUp(page, 'jcd09q');
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

// svc-notify's own readiness on the TEST stack: `alerts.sweep.lastAt` is when its last alert sweep finished.
const NOTIFY = stackUrl('notify');
const lastSweepAt = async () => (await (await fetch(`${NOTIFY}/ready`)).json()).alerts.sweep.lastAt;

/** A TEST price on the 0.01 tick: the last price times percent / 100, worked in scaled bigint. */
const testPrice = (percent, last) => fromCents((cents(last) * BigInt(percent)) / 100n);

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
  const quotaRead = await answerAfterNavigation(
    page,
    (r) => /notify\.alertQuota\b/.test(r.url()) && r.ok(),
    () => page.reload(),
  );
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
