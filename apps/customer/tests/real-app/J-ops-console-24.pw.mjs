// World: restart
import { expect, test } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { fund, restartWith, tool } from './stack.mjs';

// J-ops-console-24: watch capital and counterparties. #1 opens the capital monitor (/more-ops/capital, svc-ops
// `capital.snapshot`, RC-ops-console-06) with the buffer threshold blank. INTAFACED's own funds come from svc-ledger's
// `ownFunds` read (house and module accounts; customer money never counted), any reserve a partner holds of ours comes from
// svc-bank's TEST partner bank and TEST card partner (each "not known" on this stack), and the founders set a threshold with
// two founders to see one breach alert per asset and day, escalated to the named contact. With the ledger stopped, that part
// reads unknown and no scenario runs. The builder account at each venue is its own test: svc-ops reads it through its venue
// port from the stack's TEST venues (`OPS_TEST_VENUE`), and with them switched down (`LOCAL_STACK_OPS_TEST_VENUE_READ=off`,
// svc-ops restarted) each venue reads unknown, never 0.
// The test always leaves the ETH threshold blank again, so the step starts blank on the next run.

const J = 'J-ops-console-24';
const ASSET = 'ETH';
const CONTACT = 'TEST treasury on-call';
const REASON = 'TEST buffer policy for J-ops-console-24 #1';
const UNSET_WORDS =
  'No minimum buffer is set for this asset, so it is not monitored. A founder sets one below, with a second founder’s approval.';

test.use({ timezoneId: 'UTC' });

async function openMonitor(page) {
  await page.goto(`${ADMIN}/more-ops/capital`, { waitUntil: 'load' });
  await expect(page.getByRole('heading', { level: 2, name: 'Capital monitor' })).toBeVisible();
}

/** INTAFACED's own funds in `asset` as the page shows them, from the ledger. */
async function ownFunds(page, asset) {
  const table = page.getByRole('table', { name: 'INTAFACED’s own funds per asset' });
  const row = table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: asset, exact: true }) });
  await expect(row).toHaveCount(1);
  return (await page.getByTestId(`own-funds-${asset}`).innerText()).trim();
}

/** Exact decimal sum of two non-negative decimal strings, as scaled bigints (18 places). */
function plus(a, b) {
  const scale = (s) => {
    const [w, f = ''] = s.split('.');
    return BigInt(w) * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18));
  };
  const v = scale(a) + scale(b);
  const whole = v / 10n ** 18n;
  const frac = (v % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** One founder asks for the threshold change; returns the packet text the console made. */
async function ask(page, minimum, contact) {
  await openMonitor(page);
  const entry = page.getByTestId('capital-threshold-entry');
  await entry.getByLabel('Asset').fill(ASSET);
  await entry.getByLabel('Minimum buffer (blank clears it)').fill(minimum);
  await entry.getByLabel('Escalate a breach to').fill(contact);
  const desk = entry.getByTestId('control-desk');
  await desk.getByLabel(/^Why this threshold/).fill(REASON);
  await desk.getByLabel(/to confirm$/).fill(minimum ? `SET THRESHOLD ${ASSET}` : `CLEAR THRESHOLD ${ASSET}`);
  await desk.getByRole('button', { name: 'Ask a second founder to approve this threshold' }).click();
  await expect(desk.getByTestId('packet-made')).toBeVisible({ timeout: 60_000 });
  return (await desk.getByLabel('Request packet').inputValue()).trim();
}

/** The other founder approves that exact packet on their own console; the asker runs it. */
async function approveAndRun(asker, approver, packet, phrase) {
  await openMonitor(approver);
  const theirs = approver.getByTestId('capital-threshold-entry').getByTestId('control-desk');
  await theirs.getByLabel('Request packet').fill(packet);
  await expect(theirs.getByTestId('packet-summary')).toContainText(`minimum buffer for ${ASSET}`);
  await theirs.getByLabel(/to approve or run it$/).fill(phrase);
  await theirs.getByRole('button', { name: 'Approve this request' }).click();
  await expect(theirs.getByTestId('step-reply')).toContainText('Approved.', { timeout: 60_000 });
  const mine = asker.getByTestId('capital-threshold-entry').getByTestId('control-desk');
  await mine.getByLabel(/to approve or run it$/).fill(phrase);
  await mine.getByRole('button', { name: 'Run the approved request' }).click();
  return mine.getByTestId('step-reply');
}

async function clearThreshold(a, b) {
  const packet = await ask(a, '', '');
  await expect(await approveAndRun(a, b, packet, `CLEAR THRESHOLD ${ASSET}`)).toContainText(`the ${ASSET} threshold is cleared`, {
    timeout: 60_000,
  });
}

const bufferRow = (page) => page.getByTestId(`buffer-${ASSET}`);

test(`${J} #1 the capital monitor with the threshold blank: own funds from the ledger without customer money, partner reserves not known, ops.capital.threshold_unset and not monitored; a set threshold breached opens one alert per asset and day to the named contact; a stopped ledger reads unknown and runs no scenario`, async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  const founderA = await founderSignIn(a, 'a');
  await founderSignIn(b, 'b');

  // Opened from the command palette like any room.
  await a.goto(`${ADMIN}/more-ops`, { waitUntil: 'load' });
  await expect(a.getByRole('button', { name: /^Search/ })).toBeEnabled();
  await a.keyboard.press('Control+k');
  await a.keyboard.type('capital monitor');
  await a.keyboard.press('Enter');
  await a.waitForURL((url) => url.pathname === '/more-ops/capital', { timeout: 60_000 });
  await expect(a.getByRole('heading', { level: 2, name: 'Capital monitor' })).toBeVisible();
  await expect(a.getByTestId('read-failed')).toHaveCount(0);

  // The buffer threshold is blank: ops.capital.threshold_unset and "not monitored", in its exact words, never "ok".
  await expect(bufferRow(a)).toHaveAttribute('data-state', 'not_monitored');
  await expect(bufferRow(a).getByRole('cell').nth(2)).toHaveText(`Not monitored ops.capital.threshold_unset ${UNSET_WORDS}`);
  await expect(bufferRow(a)).not.toContainText('At or above the minimum');
  await expect(bufferRow(a).getByRole('cell').nth(1)).toHaveText('Not set');

  // INTAFACED's own funds come from the ledger and name it as their source; customer money is never counted.
  await expect(a.getByTestId('own-funds-source')).toContainText('Source: the ledger (svc-ledger), house and module accounts only, read ');
  await expect(a.getByTestId('own-funds-source')).toContainText('Customer balances are never counted as ours.');
  const before = await ownFunds(a, ASSET);
  const run = Date.now().toString(36);
  fund('house', ASSET, '2.5', `cap24-house-${run}`);
  fund(founderA.userId, ASSET, '7', `cap24-user-${run}`);
  await openMonitor(a);
  expect(await ownFunds(a, ASSET), 'the house funding counts, the customer funding does not').toBe(plus(before, '2.5'));
  const funds = a.getByRole('table', { name: 'INTAFACED’s own funds per asset' });
  await expect(funds.getByRole('row').filter({ hasText: ASSET }).getByRole('cell').last()).toHaveText(/^Ledger: \d+ accounts?$/);
  await a.getByText('The ledger accounts these sum').click();
  const accounts = a.getByRole('table', { name: 'Ledger accounts in INTAFACED’s own funds' });
  await expect(accounts.getByRole('row').filter({ hasText: 'house market-maker' }).filter({ hasText: ASSET })).toHaveCount(1);
  await expect(accounts).not.toContainText(founderA.userId);
  await expect(bufferRow(a).getByRole('cell').first()).toHaveText(plus(before, '2.5'));

  // Any reserve a partner holds of ours: the TEST partner bank and the TEST card partner each say "not known", never 0.
  const reserves = a.getByRole('table', { name: 'Reserves partners hold of ours' });
  const bankRow = reserves.getByRole('row').filter({ has: a.getByRole('rowheader', { name: 'TEST partner bank', exact: true }) });
  const cardRow = reserves.getByRole('row').filter({ has: a.getByRole('rowheader', { name: 'TEST partner card', exact: true }) });
  await expect(bankRow.getByRole('cell').first()).toHaveText('not known');
  await expect(bankRow.getByRole('cell').last()).toContainText('svc-bank, the partner bank adapter, read ');
  await expect(cardRow.getByRole('cell').first()).toHaveText('not known');
  await expect(cardRow.getByRole('cell').last()).toContainText('svc-bank, the card partner’s terms, read ');

  const held = plus(before, '2.5');
  const minimum = plus(held, '1');
  let set = false;
  try {
    // A threshold set above the buffer, by founder A with founder B's approval.
    const packet = await ask(a, minimum, CONTACT);
    await expect(a.getByTestId('capital-threshold-entry').getByRole('button', { name: 'Approve this request' })).toBeDisabled();
    const reply = await approveAndRun(a, b, packet, `SET THRESHOLD ${ASSET}`);
    await expect(reply).toContainText(`the ${ASSET} minimum buffer is ${minimum}`, { timeout: 60_000 });
    await expect(reply).toContainText(`escalated to ${CONTACT}`);
    set = true;

    // With the buffer below it: one breach alert for the asset and the day, escalated to the named contact.
    await openMonitor(a);
    await expect(bufferRow(a)).toHaveAttribute('data-state', 'below_minimum');
    await expect(bufferRow(a).getByRole('cell').nth(2)).toHaveText('Below the minimum');
    const day = new Date().toISOString().slice(0, 10);
    const alerts = a.getByRole('table', { name: 'Breach alerts' });
    const todays = alerts
      .getByRole('row')
      .filter({ has: a.getByRole('rowheader', { name: `capital-breach:${ASSET}:${day}`, exact: true }) });
    await expect(todays).toHaveCount(1);
    // Asset, day, buffer, minimum, escalated to. (An alert this day already opened by an earlier run keeps its own figures.)
    const [asset, period, buffer, floor, escalatedTo] = (await todays.getByRole('cell').allInnerTexts()).map((c) => c.trim());
    expect([asset, period, escalatedTo]).toEqual([ASSET, day, CONTACT]);
    expect(Number(buffer) < Number(floor), `the alert's buffer ${buffer} is below its minimum ${floor}`).toBe(true);
    // Evaluated again the same day: still one.
    await openMonitor(a);
    await expect(todays).toHaveCount(1);

    // The ledger read fails: that part reads unknown, the threshold is neither ok nor breached, and no scenario runs.
    try {
      tool('local-test-stack.mjs', 'stop', 'ledger');
      await openMonitor(a);
      const unknown = a.getByTestId('own-funds-unknown');
      await expect(unknown).toContainText('INTAFACED’s own funds: unknown');
      await expect(unknown.locator('code')).toHaveText('ops.capital.source_unavailable');
      await expect(a.getByRole('table', { name: 'INTAFACED’s own funds per asset' })).toHaveCount(0);
      await expect(bufferRow(a)).toHaveAttribute('data-state', 'unknown');
      await expect(bufferRow(a).getByRole('cell').first()).toHaveText('unknown');
      await expect(todays).toHaveCount(1);
      const scenario = a.getByTestId('capital-scenario');
      await scenario.getByLabel('Counterparty').fill('TEST venue');
      await scenario.getByLabel('Asset').fill(ASSET);
      await scenario.getByLabel('Exposure').fill('10');
      await scenario.getByLabel('Loss share (0 to 1)').fill('0.5');
      await scenario.getByRole('button', { name: 'Run the scenario' }).click();
      const refused = a.getByTestId('scenario-refused');
      await expect(refused).toContainText('No scenario was run', { timeout: 30_000 });
      await expect(refused.locator('code')).toHaveText('ops.capital.source_unavailable');
      await expect(a.getByTestId('scenario-result')).toHaveCount(0);
    } finally {
      tool('local-test-stack.mjs', 'start', '--only', 'ledger');
    }
  } finally {
    // The threshold goes back to blank, whatever happened above.
    if (set) await clearThreshold(a, b);
  }
  await openMonitor(a);
  await expect(bufferRow(a)).toHaveAttribute('data-state', 'not_monitored');
});

test(`${J} #1 the builder account's balance at each venue as the venue reports it with its as-of time, beside the venue's published minimum for collecting builder fees or "not published", each naming its source; a failed venue read reads unknown`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  await founderSignIn(page, 'a');
  await openMonitor(page);
  const venues = page.getByRole('table', { name: 'Builder account at each venue' });
  // No venue adapter reports a builder account to svc-ops yet: this fails fast here until one does.
  await expect(
    venues,
    await page
      .getByTestId('venues-not-connected')
      .innerText()
      .catch(() => 'no venue table'),
  ).toBeVisible({
    timeout: 10_000,
  });
  const rows = venues.getByRole('row').filter({ has: page.getByRole('rowheader') });
  expect(await rows.count()).toBeGreaterThan(0);
  for (const row of await rows.all()) {
    const [balance, asOf, minimum, source] = (await row.getByRole('cell').allInnerTexts()).map((c) => c.trim());
    expect(balance).toMatch(/^\d+(\.\d+)? [A-Z0-9]+$/);
    expect(asOf).not.toBe('unknown');
    expect(minimum === 'not published' || /^\d+(\.\d+)? [A-Z0-9]+$/.test(minimum), minimum).toBe(true);
    expect(source).toMatch(/^The venue’s own record for /);
  }
  const venueCount = await rows.count();

  // A venue read that fails: that part reads unknown (balance, as-of time and minimum), never 0 and never "not published",
  // while own funds still come from the ledger.
  restartWith('ops', 'LOCAL_STACK_OPS_TEST_VENUE_READ', false);
  try {
    await openMonitor(page);
    await expect(venues).toBeVisible();
    await expect(rows).toHaveCount(venueCount);
    for (const row of await rows.all()) {
      await expect(row).toHaveAttribute('data-state', 'unknown');
      const [balance, asOf, minimum, source] = (await row.getByRole('cell').allInnerTexts()).map((c) => c.trim());
      expect(balance).toBe('unknown (ops.capital.source_unavailable)');
      expect(asOf).toBe('unknown');
      expect(minimum).toBe('unknown (ops.capital.source_unavailable)');
      expect(source).toMatch(/^The venue’s own record for /);
    }
    await expect(venues).not.toContainText('not published');
    await expect(page.getByTestId('own-funds-source')).toContainText('Source: the ledger (svc-ledger)');
  } finally {
    restartWith('ops', 'LOCAL_STACK_OPS_TEST_VENUE_READ', true);
  }
});
