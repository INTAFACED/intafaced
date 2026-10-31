import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { EDGE, signOutBrowser } from './stack.mjs';
import { signIn, signUp } from './desk.mjs';

// J-charts-desk-17, in the running app (docs/roadmap/journeys.json): compare markets on one chart, arrange its indicator
// panes, then snapshot, link,
// print and export it. One test per step, titled "J-charts-desk-17 #<n>". The compare cap is the owner's value served by
// svc-trade; the local stack sets a labelled TEST value of 3 (local-test-gates.mjs charts). Bars are TEST trades.
const J = 'J-charts-desk-17';
const CHART = '/charts/BTC-USDT';

const canvas = (page) => page.getByRole('img', { name: 'Price chart of BTC/USDT' }).first();
const tools = (page) => page.getByRole('group', { name: 'Compare and share' }).first();

async function openChart(page, path = CHART) {
  await page.goto(path);
  await expect.poll(async () => Number(await canvas(page).getAttribute('data-bars'))).toBeGreaterThan(0);
}

/** The owner's chart values svc-trade serves for BTC/USDT (the compare cap is `compareCap`). */
async function ownerValues() {
  const res = await fetch(`${EDGE}/api/v1/charts/owner-values?symbol=${encodeURIComponent('BTC/USDT')}`);
  expect(res.status).toBe(200);
  return res.json();
}

/** Every listed market other than BTC/USDT, as the compare picker offers them. */
async function others(page) {
  return tools(page)
    .getByRole('combobox', { name: /Compare with/ })
    .locator('option')
    .allTextContents();
}

test(`${J} #1 adds symbols to a BTC chart, each a removable line; past the cap the add is refused`, async ({ page }) => {
  await openChart(page);
  const offered = await others(page);
  // The cap is the owner's value (a TEST 3 on the stack), and the stack lists more markets than that, so the add past
  // the cap is always tried.
  const cap = (await ownerValues()).compareCap;
  expect(Number.isInteger(cap) && cap > 0, `the compare cap is set (${cap})`).toBe(true);
  expect(offered.length).toBeGreaterThan(cap);
  const list = tools(page).getByRole('list', { name: 'Compared markets' });
  let added = 0;
  for (const symbol of offered.slice(0, cap)) {
    await tools(page)
      .getByRole('combobox', { name: /Compare with/ })
      .selectOption(symbol);
    await tools(page).getByRole('button', { name: 'Add', exact: true }).click();
    added += 1;
    await expect(list.getByRole('listitem')).toHaveCount(added);
    await expect(list.getByRole('listitem').nth(added - 1)).toHaveAttribute('data-state', /ready|empty/);
  }
  for (let i = 0; i < added; i += 1) await expect(list.getByRole('button', { name: /^Remove / }).nth(i)).toBeVisible();
  await tools(page)
    .getByRole('combobox', { name: /Compare with/ })
    .selectOption(offered[cap]);
  await tools(page).getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByTestId('compare-note')).toContainText(`A chart can compare ${cap} markets`);
  await expect(page.getByTestId('compare-note')).toHaveAttribute('data-code', 'trade.chart.compare_cap_reached');
  await expect(list.getByRole('listitem')).toHaveCount(cap);
  // A row comes off with its remove control.
  await list
    .getByRole('button', { name: /^Remove / })
    .first()
    .click();
  await expect(list.getByRole('listitem')).toHaveCount(added - 1);
});

test(`${J} #2 turns percent mode on and every series is rebased to the same start`, async ({ page }) => {
  await openChart(page);
  // ETH/USDT: the stack's TEST maker trades it, so it has bars to rebase at this interval.
  await tools(page)
    .getByRole('combobox', { name: /Compare with/ })
    .selectOption('ETH/USDT');
  await tools(page).getByRole('button', { name: 'Add', exact: true }).click();
  const item = tools(page).getByRole('list', { name: 'Compared markets' }).getByRole('listitem').first();
  await expect(item).toHaveAttribute('data-state', 'ready');
  const before = await canvas(page).screenshot();
  await tools(page).getByRole('checkbox', { name: 'Percent scale' }).check();
  // The axis now reads in percent.
  await expect.poll(async () => !(await canvas(page).screenshot()).equals(before)).toBe(true);
  await expect(canvas(page)).toHaveAttribute('data-scale', 'percent');
  await expect(tools(page).getByRole('checkbox', { name: 'Percent scale' })).toBeChecked();
  // The main series: a base is named, and the first value the library holds for its first bar is 0.00.
  await expect(canvas(page)).toHaveAttribute('data-base', /^\d+(\.\d+)?$/);
  await expect(canvas(page)).toHaveAttribute('data-first-percent', '0.00');
  // The compared line: rebased the same way, from its own first bar.
  await expect(item).toHaveAttribute('data-base', /^\d+(\.\d+)?$/);
  await expect(item).toHaveAttribute('data-first-percent', '0.00');
});

test(`${J} #4 takes a snapshot, copies a share link and prints, with no account detail`, async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  // Signed in, so there is an account the snapshot and the link could leak.
  const who = await signUp(page, 'cs');
  // Sign-up leaves the browser signed in and /login can reset its form on the session refresh: sign in from signed out.
  await signOutBrowser(page.context());
  await signIn(page, who);
  await openChart(page, `${CHART}?interval=1h`);
  const [png] = await Promise.all([page.waitForEvent('download'), tools(page).getByRole('button', { name: 'Snapshot (PNG)' }).click()]);
  expect(png.suggestedFilename()).toBe('chart-BTC-USDT-1h.png');
  const bytes = readFileSync(await png.path());
  expect(bytes.subarray(1, 4).toString()).toBe('PNG');
  // The image is the chart: its size is the chart's drawing size, and it is drawn (more than a handful of colours).
  const image = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    [c.width, c.height] = [img.width, img.height];
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    const colours = new Set();
    for (let i = 0; i < data.length; i += 4 * 97) colours.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    return { width: img.width, height: img.height, colours: colours.size };
  }, bytes.toString('base64'));
  const box = await canvas(page).boundingBox();
  const ratio = await page.evaluate(() => window.devicePixelRatio);
  expect(Math.abs(image.width - box.width * ratio)).toBeLessThanOrEqual(2 * ratio);
  expect(Math.abs(image.height - box.height * ratio)).toBeLessThanOrEqual(2 * ratio);
  expect(image.colours).toBeGreaterThan(5);
  await tools(page).getByRole('button', { name: 'Copy link' }).click();
  await expect(page.getByTestId('compare-note')).toContainText('/charts/BTC-USDT?interval=1h&style=candles');
  const link = (await page.getByTestId('compare-note').textContent()).replace(/^.*?(http\S+)$/, '$1');
  expect(link).not.toMatch(/user|account|email|token|session/i);
  // Nothing of the signed-in account: not its handle, its email or its id.
  for (const detail of [who.handle, who.email, encodeURIComponent(who.email)]) expect(link).not.toContain(detail);
  expect(new URL(link).searchParams.toString()).toBe('interval=1h&style=candles');
  // The link opens the same chart.
  await page.goto(link);
  await expect(page.getByTestId('chart-title').first()).toHaveText('BTC/USDT · 1h');
  // Print opens the browser's print for the page.
  await page.evaluate(() => {
    window.__printed = 0;
    window.print = () => {
      window.__printed += 1;
    };
  });
  await tools(page).getByRole('button', { name: 'Print' }).click();
  expect(await page.evaluate(() => window.__printed)).toBe(1);
  // A public page is refused: there is no publishing store.
  await tools(page).getByRole('button', { name: 'Public page' }).click();
  await expect(page.getByTestId('compare-note')).toHaveAttribute('data-code', 'trade.chart.publish_unavailable');
});

test(`${J} #5 exports the visible bars to a file`, async ({ page }) => {
  await openChart(page, `${CHART}?interval=1m`);
  // Zoomed in, so the bars in view are fewer than the bars loaded and "visible" means something.
  await canvas(page).focus();
  for (let i = 0; i < 4; i += 1) await page.keyboard.press('+');
  const readView = () =>
    canvas(page).evaluate((el) => ({
      from: Number(el.getAttribute('data-view-from')),
      to: Number(el.getAttribute('data-view-to')),
      bars: Number(el.getAttribute('data-bars')),
      first: Number(el.getAttribute('data-first')),
    }));
  const same = (a, b) => a.from === b.from && a.to === b.to && a.bars === b.bars && a.first === b.first;
  // Export once the zoom has settled, and keep the export whose view did not move between the click and the read after
  // it (a new bar arriving in between shifts the view; the export is then taken again).
  let view;
  let lines;
  let exportedAt;
  await expect
    .poll(
      async () => {
        const before = await readView();
        await page.waitForTimeout(200);
        if (!same(before, await readView()) || !(before.to - before.from > 0)) return false;
        exportedAt = Date.now();
        const [file] = await Promise.all([
          page.waitForEvent('download'),
          tools(page).getByRole('button', { name: 'Export bars (CSV)' }).click(),
        ]);
        expect(file.suggestedFilename()).toBe('chart-BTC-USDT-1m.csv');
        lines = readFileSync(await file.path(), 'utf8').split('\n');
        view = await readView();
        return same(before, view);
      },
      { message: 'an export whose view held still', intervals: [300] },
    )
    .toBe(true);
  expect(lines[0]).toMatch(/^# BTC\/USDT 1m bars; times are UTC; viewer time zone \S+/);
  expect(lines[1]).toBe('time_utc,open,high,low,close,volume,filled');
  const rows = lines.slice(2);
  for (const row of rows) expect(row).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:00\.000Z,[\d.]+,[\d.]+,[\d.]+,[\d.]+,[\d.]+,(yes|no)$/);
  // The visible bars exactly: the bars whose centre is in view (indexes rounded from the view's edges), from the first to
  // the last, one minute apart, and fewer than the bars loaded.
  const [from, to] = [Math.max(0, Math.round(view.from)), Math.min(view.bars - 1, Math.round(view.to))];
  expect(rows.length).toBe(to - from + 1);
  expect(rows.length).toBeLessThan(view.bars);
  const times = rows.map((r) => Date.parse(r.split(',')[0]));
  times.forEach((t, i) => expect(t).toBe(view.first + (from + i) * 60_000));
  // Each traded bar is Edge's own 1m candle, value for value; a filled bar repeats the close before it with no volume.
  // The minute still forming at the export can trade again after it, and a minute that closed in the last few seconds
  // may not have reached the chart yet, so only minutes finished at least 5 s before the export are compared.
  const res = await fetch(`${EDGE}/api/v1/ohlcv/${encodeURIComponent('BTC/USDT')}?timeframe=1m&limit=240`);
  expect(res.status).toBe(200);
  const forming = Math.floor((exportedAt - 5_000) / 60_000) * 60_000;
  const candles = new Map((await res.json()).map((c) => [c[0], c]));
  let previous = null;
  for (const row of rows) {
    const [time, o, h, l, c, v, filled] = row.split(',');
    const candle = candles.get(Date.parse(time));
    if (Date.parse(time) >= forming) break;
    if (filled === 'no') {
      expect(candle, `${time} is a traded bar on Edge`).toBeTruthy();
      expect([o, h, l, c, v]).toEqual(candle.slice(1, 6).map(String));
    } else {
      expect(candle, `${time} has no trade on Edge`).toBeUndefined();
      if (previous) expect([o, h, l, c, v]).toEqual([previous, previous, previous, previous, '0']);
    }
    previous = c;
  }
});

test(`${J} #3 reorders, collapses, resizes and maximises indicator panes, and moves one to the main pane; each pane acts and persists`, async ({
  page,
}) => {
  // 1m: RSI 14 needs 15 bars at the chart's interval, and the stack's 1m history is the longest of the TEST intervals.
  await openChart(page, '/charts/BTC-USDT?interval=1m');
  // A compared market on the main pane, which every pane change below must leave in place.
  const [symbol] = await others(page);
  await tools(page)
    .getByRole('combobox', { name: /Compare with/ })
    .selectOption(symbol);
  await tools(page).getByRole('button', { name: 'Add', exact: true }).click();
  const compared = tools(page).getByRole('list', { name: 'Compared markets' }).getByRole('listitem');
  await expect(compared).toHaveCount(1);
  await page.getByRole('button', { name: 'Indicators' }).first().click();
  await page.getByRole('searchbox', { name: 'Search indicators' }).fill('rsi');
  await page.getByRole('button', { name: 'Add Relative Strength Index', exact: true }).click();
  await page.keyboard.press('Escape');
  const host = canvas(page);
  // What the chart lays out, read from the library: the panes' order and settings, each pane's height in pixels, and
  // the pane each study's series is drawn in.
  const layout = async () => JSON.parse((await host.getAttribute('data-study-pane-layout')) ?? '[]');
  const order = async () => (await layout()).map((p) => p.study);
  const heights = () => host.evaluate((el) => el.readPaneHeights());
  const paneOf = async (study) =>
    JSON.parse((await host.getAttribute('data-study-series')) ?? '[]').find((x) => x.key.split(':')[0] === study)?.pane;
  const pane = (name) => page.getByRole('group', { name: new RegExp(`^${name}.* pane$`) });
  const press = (name, action) =>
    pane(name)
      .getByRole('button', { name: new RegExp(`^${action}`) })
      .click();
  const RSI = 'Relative Strength Index';
  const VOL = 'Volume';
  // Volume is the default indicator pane, so RSI is the second one under the price.
  await expect.poll(order).toEqual(['volume-1', 'rsi-1']);
  // Reorder: RSI moves above Volume, in the layout and in the panes the library draws the series in.
  await press(RSI, 'Move .* pane up');
  await expect.poll(order).toEqual(['rsi-1', 'volume-1']);
  await expect.poll(() => paneOf('rsi-1')).toBe(1);
  await expect.poll(() => paneOf('volume-1')).toBe(2);
  // Collapse: Volume keeps a strip only; expanding it gives it back its height.
  const open = await heights();
  await press(VOL, 'Collapse');
  await expect.poll(async () => (await heights())[2]).toBeLessThan(open[2] * 0.4);
  await expect(pane(VOL)).toHaveAttribute('data-pane-state', 'collapsed');
  await press(VOL, 'Expand');
  await expect.poll(async () => Math.abs((await heights())[2] - open[2])).toBeLessThanOrEqual(2);
  // Resize: RSI made taller twice is about 2.25 times Volume's height.
  await press(RSI, 'Make .* pane taller');
  await press(RSI, 'Make .* pane taller');
  await expect.poll(async () => (await layout()).find((p) => p.study === 'rsi-1').size).toBe(2.25);
  await expect
    .poll(async () => {
      const h = await heights();
      return h[1] / h[2];
    })
    .toBeGreaterThan(2);
  const resized = await heights();
  // Maximise: RSI takes nearly the whole chart; restoring gives every pane its height back.
  await press(RSI, 'Maximise');
  await expect
    .poll(async () => {
      const h = await heights();
      return h[1] / h.reduce((a, b) => a + b, 0);
    })
    .toBeGreaterThan(0.75);
  await expect(pane(RSI)).toHaveAttribute('data-pane-state', 'maximised');
  // While RSI is maximised, Volume is a strip: its size controls wait for the restore.
  await expect(pane(VOL).getByRole('button', { name: /^Make .* pane taller/ })).toBeDisabled();
  await press(RSI, 'Restore the panes');
  await expect.poll(async () => (await heights()).every((h, n) => Math.abs(h - resized[n]) <= 2)).toBe(true);
  // Move to the main pane: Volume draws over the price, and one indicator pane is left.
  await press(VOL, 'Move .* to the main pane');
  await expect.poll(() => paneOf('volume-1')).toBe(0);
  await expect(host).toHaveAttribute('data-study-panes', '1');
  await expect.poll(order).toEqual(['rsi-1']);
  await expect(pane(VOL)).toHaveAttribute('data-pane-state', 'main');
  // The compared market stayed on the main pane through every change.
  await expect(compared).toHaveCount(1);
  await expect(compared.first()).toHaveAttribute('data-state', /ready|empty/);
  // Persists: after a reload the panes come back as they were left.
  const kept = await layout();
  const keptHeights = await heights();
  await page.reload();
  await expect.poll(async () => Number(await canvas(page).getAttribute('data-bars'))).toBeGreaterThan(0);
  await expect.poll(layout).toEqual(kept);
  await expect.poll(() => paneOf('volume-1')).toBe(0);
  await expect.poll(() => paneOf('rsi-1')).toBe(1);
  await expect.poll(async () => (await heights()).every((h, n) => Math.abs(h - keptHeights[n]) <= 2)).toBe(true);
  // And back to its own pane, under RSI.
  await press(VOL, 'Move .* to its own pane');
  await expect.poll(order).toEqual(['rsi-1', 'volume-1']);
});
