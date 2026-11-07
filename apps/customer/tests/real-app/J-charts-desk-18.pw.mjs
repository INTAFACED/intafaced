// World: market
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { EDGE, tool } from './stack.mjs';

// J-charts-desk-18 "I watch the health of market feeds, chart usage and the alert engine, and set the module's owner
// values", in the founder console (apps/admin) against the running stack. One test per step, titled "J-charts-desk-18 #<n>".
// The founder is founder A. Every figure on the desk is checked against a source read on its own: the public trade tape
// for the last tick, svc-trade's public owner values for the boundary.
//
// #1 and #2 need a real-time market whose stream really stops: the TEST market maker is run on BTC/USDT only, so
// ETH/USDT gets no trade, its stream ages past the owner's delayed boundary (a TEST 30 s on the stack) and the feed
// watcher journals a drop; the maker is then started on every market again, ETH/USDT trades, and a reconnect is journaled.
const J = 'J-charts-desk-18';
const BTC = 'BTC/USDT';
const ETH = 'ETH/USDT';
const MINUTE = 60_000;

/** The TEST market maker's own status line; `status` exits non-zero when the maker is down, which is an answer here. */
function maker(cmd) {
  try {
    return tool('local-test-market.mjs', cmd);
  } catch (err) {
    return String(err.stdout ?? '');
  }
}

/** The owner's chart values svc-trade serves (`delayedBoundarySeconds` is the stale boundary). */
async function ownerValues(symbol) {
  const res = await fetch(`${EDGE}/api/v1/charts/owner-values?symbol=${encodeURIComponent(symbol)}`);
  expect(res.status).toBe(200);
  return res.json();
}

/** The newest trade on the public tape, epoch ms, or null when the market has none. */
async function newestTrade(symbol) {
  const res = await fetch(`${EDGE}/api/v1/trades/${encodeURIComponent(symbol)}?limit=1`);
  expect(res.status).toBe(200);
  const tape = await res.json();
  return tape.length > 0 ? tape[0].timestamp : null;
}

const feedRow = (page, symbol) => page.getByRole('table', { name: 'Candle streams' }).locator(`tr[data-symbol="${symbol}"]`);

async function openFeeds(page) {
  await page.goto(`${ADMIN}/trade-ops/feeds`);
  await expect(page.getByRole('heading', { name: 'Market feeds' })).toBeVisible();
}

test.describe(`${J} #1 #2 on a market whose candle stream stops and then resumes`, () => {
  test.describe.configure({ mode: 'serial' });
  let makerWasRunning = false;
  let lastTick = null;
  let boundary = null;

  test.beforeAll(() => {
    // Stopping cancels every resting maker order and starting funds it again: each may take up to the tool's 120 s.
    test.setTimeout(300_000);
    makerWasRunning = /^test market: (ok|STALE)/.test(maker('status'));
    tool('local-test-market.mjs', 'stop');
    tool('local-test-market.mjs', 'start', '--markets', BTC);
  });
  test.afterAll(() => {
    test.setTimeout(300_000);
    tool('local-test-market.mjs', 'stop');
    // Put the maker back as the stack had it: on every market (as the run starts it), or off if it was off.
    if (makerWasRunning) tool('local-test-market.mjs', 'start');
  });

  test(`${J} #1 opens the market feed desk: a stream 40 seconds old reads stale with its age and last tick time, and the drill-down lists its candle gaps`, async ({
    page,
  }) => {
    test.setTimeout(300_000);
    boundary = (await ownerValues(ETH)).delayedBoundarySeconds;
    expect(Number.isInteger(boundary) && boundary > 0 && boundary < 40, `the delayed boundary is set below 40 s (${boundary})`).toBe(true);
    lastTick = await newestTrade(ETH);
    expect(lastTick, 'ETH/USDT has traded on the stack').not.toBeNull();
    // Wait until the stream is at least 40 s old and a whole minute after its last tick has closed with no trade.
    await expect
      .poll(
        async () =>
          (await newestTrade(ETH)) === lastTick && Date.now() >= Math.max(lastTick + 40_000, (Math.floor(lastTick / MINUTE) + 2) * MINUTE),
        {
          timeout: 200_000,
          intervals: [2_000],
        },
      )
      .toBe(true);

    await founderSignIn(page, 'a');
    await openFeeds(page);
    const row = feedRow(page, ETH);
    await expect(row).toHaveAttribute('data-state', 'stale');
    await expect(row.locator('[data-field=state]')).toHaveText('stale');
    const age = Number(await row.locator('[data-field=age]').getAttribute('data-seconds'));
    expect(age).toBeGreaterThanOrEqual(40);
    await expect(row.locator('[data-field=age]')).toHaveText(`${age} s`);
    // The last tick is the tape's own newest trade, to the millisecond, shown to the second in UTC.
    const shown = await row.locator('[data-field=last-tick]').getAttribute('data-at');
    expect(Date.parse(shown)).toBe(lastTick);
    await expect(row.locator('[data-field=last-tick]')).toHaveText(
      `${new Date(lastTick).toISOString().slice(0, 19).replace('T', ' ')} UTC`,
    );
    await expect(page.getByTestId('feed-boundary')).toHaveAttribute('data-seconds', String(boundary));

    await row.getByRole('link', { name: ETH }).click();
    await expect(page.getByRole('heading', { name: `${ETH} feed` })).toBeVisible();
    const gaps = page.getByRole('region', { name: 'Candle gaps' }).getByRole('table', { name: 'Candle gaps list' }).locator('tbody tr');
    // The newest gap starts at the first minute after the last tick's own minute: no candle was traded since.
    const firstEmpty = new Date((Math.floor(lastTick / MINUTE) + 1) * MINUTE).toISOString();
    await expect(gaps.first()).toHaveAttribute('data-from', firstEmpty);
    expect(Number(await gaps.first().locator('td').nth(2).textContent())).toBeGreaterThanOrEqual(1);
  });

  test(`${J} #2 opens the feed event journal for a market: each drop and reconnect with time, reason and actor (system), read-only`, async ({
    page,
  }) => {
    test.setTimeout(400_000);
    expect(lastTick, '#1 ran and read the last tick').not.toBeNull();
    await founderSignIn(page, 'a');
    const journalOf = async () => {
      await page.goto(`${ADMIN}/trade-ops/feeds/${encodeURIComponent(ETH)}`);
      return page.getByRole('region', { name: 'Feed event journal' });
    };
    // The drop: dated when the stream passed the boundary, from the system, with the reason.
    const dropAt = new Date(lastTick + boundary * 1000).toISOString();
    await expect
      .poll(async () => (await journalOf()).locator(`tr[data-kind=drop][data-at="${dropAt}"]`).count(), { timeout: 30_000 })
      .toBe(1);
    let journal = await journalOf();
    const drop = journal.locator(`tr[data-kind=drop][data-at="${dropAt}"]`);
    await expect(drop.locator('[data-field=event]')).toHaveText('drop');
    await expect(drop.locator('[data-field=actor]')).toHaveText('system');
    await expect(drop.locator('[data-field=reason]')).toContainText(`past the owner's ${boundary} s boundary`);
    await expect(drop.locator('[data-field=time]')).toHaveText(`${dropAt.slice(0, 19).replace('T', ' ')} UTC`);

    // The stream resumes: the maker trades ETH/USDT again, and the watcher journals the reconnect at that trade's time.
    tool('local-test-market.mjs', 'stop');
    tool('local-test-market.mjs', 'start', '--markets', `${BTC},${ETH}`);
    let resumed = null;
    await expect
      .poll(
        async () => {
          const t = await newestTrade(ETH);
          resumed = t !== null && t > lastTick ? t : null;
          return resumed !== null;
        },
        { timeout: 180_000, intervals: [3_000] },
      )
      .toBe(true);
    await expect.poll(async () => (await journalOf()).locator('tr[data-kind=reconnect]').count(), { timeout: 60_000 }).toBeGreaterThan(0);
    journal = await journalOf();
    // Newest first: the reconnect sits above the drop, and is dated at a trade after the drop's last tick.
    const reconnect = journal.locator('tr[data-kind=reconnect]').first();
    const reconnectAt = Date.parse(await reconnect.getAttribute('data-at'));
    expect(reconnectAt).toBeGreaterThan(lastTick);
    expect(reconnectAt).toBeLessThanOrEqual(await newestTrade(ETH));
    await expect(reconnect.locator('[data-field=actor]')).toHaveText('system');
    await expect(reconnect.locator('[data-field=reason]')).toContainText('Candle ticks resumed after');
    const kinds = await journal.locator('tbody tr').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-kind')));
    expect(kinds.indexOf('reconnect')).toBeLessThan(kinds.indexOf('drop'));
    // Read only: the journal offers nothing to press or type.
    await expect(journal.getByRole('button')).toHaveCount(0);
    await expect(journal.getByRole('textbox')).toHaveCount(0);
    await expect(journal.locator('input, select, textarea')).toHaveCount(0);
  });
});
