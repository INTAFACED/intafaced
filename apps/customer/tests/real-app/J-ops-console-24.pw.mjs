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

/** A non-negative decimal string as a bigint scaled to 18 places. */
function scale(s) {
  const [w, f = ''] = s.split('.');
  return BigInt(w) * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18));
}

/** Exact decimal sum of two non-negative decimal strings, as scaled bigints (18 places). */
function plus(a, b) {
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

/** The ledger accounts in `asset` that own funds sum, from the same read as the total: `[name, balance]` pairs. */
async function ownAccounts(page, asset) {
  await page.getByText('The ledger accounts these sum').click();
  const table = page.getByRole('table', { name: 'Ledger accounts in INTAFACED’s own funds' });
  await expect(table).toBeVisible();
  const rows = [];
  for (const row of await table.getByRole('row').all()) {
    const head = (await row.getByRole('rowheader').allInnerTexts()).map((t) => t.trim());
    const cells = (await row.getByRole('cell').allInnerTexts()).map((t) => t.trim());
    if (head.length === 1 && cells[0] === asset) rows.push([head[0], cells[1]]);
  }
  return rows;
}

/**
 * The balance of the house market-maker account in `asset`, the account `fund('house', ...)` credits. The ledger lists
 * only accounts with a balance above 0 (svc-ledger own-funds.ts), so no row reads 0 (`listed` false), never twice.
 */
function houseBalance(rows, { listed = false } = {}) {
  const house = rows.filter(([name]) => name === 'house market-maker');
  expect(house.length, 'at most one house market-maker account in the own-funds accounts').toBeLessThanOrEqual(1);
  if (listed) expect(house, 'the funded house market-maker account is listed').toHaveLength(1);
  return house[0]?.[1] ?? '0';
}

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
  const houseBefore = houseBalance(await ownAccounts(a, ASSET));
  const run = Date.now().toString(36);
  fund('house', ASSET, '2.5', `cap24-house-${run}`);
  fund(founderA.userId, ASSET, '7', `cap24-user-${run}`);
  await openMonitor(a);
  // Other journeys on the shared stack add fees to INTAFACED's module accounts at any moment, so the total is not
  // compared with the earlier read: the house funding is checked on the account it went to, and the total against the
  // accounts it sums in the same read, which never list the customer's.
  const after = await ownFunds(a, ASSET);
  const accountsAfter = await ownAccounts(a, ASSET);
  expect(scale(houseBalance(accountsAfter, { listed: true })), 'the house funding counts').toBe(scale(plus(houseBefore, '2.5')));
  expect(
    accountsAfter.reduce((sum, [, balance]) => sum + scale(balance), 0n),
    'the total is the sum of house and module accounts alone',
  ).toBe(scale(after));
  expect(scale(after) < scale(plus(plus(before, '2.5'), '7')), 'the customer funding does not count').toBe(true);
  const funds = a.getByRole('table', { name: 'INTAFACED’s own funds per asset' });
  await expect(funds.getByRole('row').filter({ hasText: ASSET }).getByRole('cell').last()).toHaveText(/^Ledger: \d+ accounts?$/);
  const accounts = a.getByRole('table', { name: 'Ledger accounts in INTAFACED’s own funds' });
  await expect(accounts).not.toContainText(founderA.userId);
  await expect(bufferRow(a).getByRole('cell').first()).toHaveText(after);

  // Any reserve a partner holds of ours: the TEST partner bank and the TEST card partner each say "not known", never 0.
  const reserves = a.getByRole('table', { name: 'Reserves partners hold of ours' });
  const bankRow = reserves.getByRole('row').filter({ has: a.getByRole('rowheader', { name: 'TEST partner bank', exact: true }) });
  const cardRow = reserves.getByRole('row').filter({ has: a.getByRole('rowheader', { name: 'TEST partner card', exact: true }) });
  await expect(bankRow.getByRole('cell').first()).toHaveText('not known');
  await expect(bankRow.getByRole('cell').last()).toContainText('svc-bank, the partner bank adapter, read ');
  await expect(cardRow.getByRole('cell').first()).toHaveText('not known');
  await expect(cardRow.getByRole('cell').last()).toContainText('svc-bank, the card partner’s terms, read ');

  const held = after;
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
  // Without a venue adapter the room says ops.capital.venue_not_connected instead: this fails fast with those words. The
  // reason is read only once one of the two is on the page, so reading it never waits out the test's own timeout.
  const notConnected = page.getByTestId('venues-not-connected');
  await expect(venues.or(notConnected)).toBeVisible({ timeout: 10_000 });
  await expect(venues, (await notConnected.count()) > 0 ? await notConnected.innerText() : 'no venue table').toBeVisible();
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
