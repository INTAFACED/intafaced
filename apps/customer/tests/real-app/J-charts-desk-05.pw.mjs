// World: none
import { test, expect } from './journey.mjs';
import { EDGE } from './stack.mjs';
import {
  atTick,
  barTimeText,
  centred,
  clickPlot,
  openWorkbench,
  pick,
  plot,
  pointerAt,
  pointText,
  pricesOf,
  rowNamed,
  rows,
  timesOf,
} from './charts-desk.mjs';

// J-charts-desk-05 "I draw on the chart: lines, text, select and move, lock, undo and delete", in the running app. One test
// per step, titled "J-charts-desk-05 #<n>", run in order in one browser context: drawings are kept on this device, so the
// steps share the page. Drawings are placed by fractions of the chart's width and height, never by a bar index.
const J = 'J-charts-desk-05';

const chartHost = (page) => page.getByTestId('cw').getByTestId('wc-host');

/** The chart's panes as the drawings read them: each pane's index, top and height in pixels from the chart's top. */
const paneBoxes = (page) => chartHost(page).evaluate((el) => el.readPaneBoxes());

/** What the chart has painted for each drawing: its pane, lines, handles and texts (font and colour), in chart pixels. */
const drawn = (page) => chartHost(page).evaluate((el) => el.readDrawnLines());

/**
 * A point on one pane: across, on the loaded bar `fx` picks (as `plot` does); down, at `fy` of that pane's own height, from
 * the pane's top as the chart lays it out, rounded to a whole pixel as a mouse gives (the chart reads whole pixels).
 */
async function inPane(page, pane, fx, fy) {
  const { x } = await plot(page, fx, 0.5);
  const box = await chartHost(page).boundingBox();
  const at = (await paneBoxes(page)).find((b) => b.index === pane);
  if (!box || !at) throw new Error(`the chart has no pane ${pane}`);
  return { x, y: box.y + Math.round(at.top + at.height * fy) };
}

/**
 * What the chart reads under a pixel on an indicator pane: the pane's index and the value at that height on the pane's own
 * scale, as the library reports them on the grid cell (`data-crosshair-pane`, `data-crosshair-pane-value`). The pointer
 * is moved a pixel away and the marks cleared first, so what is read is what the chart wrote for this position.
 */
async function paneValueAt(page, point) {
  const cell = page.locator('[data-crosshair]').first();
  await page.mouse.move(point.x - 1, point.y);
  await expect.poll(async () => (await cell.getAttribute('data-crosshair-pane')) ?? '').not.toBe('');
  await cell.evaluate((el) => {
    el.setAttribute('data-crosshair-pane', '');
    el.setAttribute('data-crosshair-pane-value', '');
  });
  await page.mouse.move(point.x, point.y);
  await expect.poll(async () => (await cell.getAttribute('data-crosshair-pane')) ?? '').not.toBe('');
  await expect.poll(async () => (await cell.getAttribute('data-crosshair-pane-value')) ?? '').not.toBe('');
  return {
    pane: Number(await cell.getAttribute('data-crosshair-pane')),
    value: Number(await cell.getAttribute('data-crosshair-pane-value')),
  };
}

test.describe.configure({ mode: 'serial' });

let page;
test.beforeAll(async ({ browser }) => {
  // Tall enough for the whole workbench: the page never scrolls, so a pixel read on the chart is the pixel then clicked.
  const context = await browser.newContext({ viewport: { width: 1440, height: 2200 } });
  page = await context.newPage();
  await openWorkbench(page);
});
test.afterAll(async () => {
  await page?.context().close();
});

test(`${J} #1 opens the drawing toolbar and picks the trend line, then two clicks place it as bar times and decimal prices`, async () => {
  // Tool groups: the drawing toolbar holds each group, by name, with its own tools, and the trend line is in Lines.
  const toolbar = page.getByRole('toolbar', { name: 'Drawing tools' });
  const groups = {
    Cursors: ['Select', 'Dot cursor', 'Arrow cursor', 'Eraser'],
    Lines: ['Horizontal line', 'Ray', 'Vertical line', 'Cross line', 'Trend line', 'Info line'],
    'Channels and Fibonacci': ['Parallel channel', 'Pitchfork', 'Fib retracement', 'Fib extension'],
    Gann: ['Gann fan', 'Gann box'],
    Patterns: ['Pattern ABCD', 'Pattern XABCD'],
    Positions: ['Long position', 'Short position'],
    Measure: ['Measure'],
    Shapes: ['Rectangle', 'Ellipse'],
    Brush: ['Brush'],
    Annotation: ['Text'],
  };
  for (const [name, tools] of Object.entries(groups)) {
    const group = toolbar.getByRole('group', { name, exact: true });
    await expect(group, `tool group ${name}`).toBeVisible();
    await expect(group.getByRole('button')).toHaveText(tools);
  }
  const trendTool = toolbar.getByRole('group', { name: 'Lines', exact: true }).getByRole('button', { name: 'Trend line', exact: true });
  await expect(trendTool).toHaveAttribute('aria-pressed', 'false');
  await trendTool.click();
  await expect(trendTool).toHaveAttribute('aria-pressed', 'true');
  // What the chart reads under each click: the bar's time and the price at that height.
  const trendPoints = [await centred(page, await plot(page, 0.3, 0.4)), await centred(page, await plot(page, 0.6, 0.5))];
  // Each click, then what the chart reads at that same pixel (read after it, so both see the page as it was clicked).
  const at = [];
  for (const point of trendPoints) {
    await page.mouse.click(point.x, point.y);
    at.push(await pointerAt(page, point));
  }
  await expect(rows(page)).toHaveCount(1);
  const text = await pointText(rows(page).first()).textContent();
  // Two points, each stored as that bar's time and that price at the tick's places (two for BTC-USDT's 0.01 tick).
  expect(timesOf(text)).toEqual(at.map((p) => barTimeText(p.time)));
  expect(pricesOf(text)).toHaveLength(2);
  pricesOf(text).forEach((price, i) => {
    expect(price).toMatch(/^\d+\.\d{2}$/);
    expect(atTick(price, at[i].price), `point ${i + 1}: stored ${price}, pointer ${at[i].price}`).toBe(true);
  });
});

test(`${J} #2 adds an info line, a horizontal line and a ray, each on the price pane, and on an indicator pane where allowed`, async () => {
  const host = page.getByTestId('cw').getByTestId('wc-host');
  const hostBox = await host.boundingBox();
  // The chart opens with its default Volume study in its own indicator pane, pane 1 under the price pane.
  const panes = await paneBoxes(page);
  const price = panes.find((b) => b.index === 0);
  const volume = panes.find((b) => b.index === 1);
  expect(price, 'the price pane').toBeTruthy();
  expect(volume, 'the Volume indicator pane').toBeTruthy();
  const inside = (y, box) => y >= box.top - 1 && y <= box.top + box.height + 1;

  // On the price pane: each point is placed inside the price pane itself.
  const clickIn = async (pane, fx, fy) => {
    const point = await inPane(page, pane, fx, fy);
    await page.mouse.click(point.x, point.y);
    return point;
  };
  await pick(page, 'Info line');
  await clickIn(0, 0.2, 0.7);
  await clickIn(0, 0.4, 0.6);
  await pick(page, 'Horizontal line');
  await clickIn(0, 0.5, 0.3);
  await pick(page, 'Ray');
  await clickIn(0, 0.7, 0.8);
  await clickIn(0, 0.8, 0.75);
  // The object tree lists the newest first: ray, horizontal, info, trend.
  await expect(rows(page)).toHaveCount(4);
  await expect(rows(page).nth(0)).toHaveAttribute('data-kind', 'ray');
  await expect(rows(page).nth(1)).toHaveAttribute('data-kind', 'horizontal');
  await expect(rows(page).nth(2)).toHaveAttribute('data-kind', 'info');
  // Each is on the price pane: the tree says so, and the chart paints every line of it inside the price pane.
  const priceIds = [];
  for (let i = 0; i < 3; i += 1) {
    await expect(rows(page).nth(i)).toHaveAttribute('data-pane', '0');
    await expect(rows(page).nth(i).getByTestId('drawing-pane')).toHaveText('Price pane');
    priceIds.push(await rows(page).nth(i).getAttribute('data-drawing-id'));
  }
  await expect(host).toHaveAttribute('data-drawings-pane', '0');
  await expect.poll(async () => (await drawn(page)).filter((d) => priceIds.includes(d.id)).length).toBe(3);
  for (const d of (await drawn(page)).filter((x) => priceIds.includes(x.id))) {
    expect(d.pane, `${d.id} pane`).toBe(0);
    expect(d.lines.length, `${d.id} lines`).toBeGreaterThan(0);
    for (const [, y1, , y2] of d.lines) {
      expect(inside(y1, price) && inside(y2, price), `${d.id} line ${y1}..${y2} inside the price pane`).toBe(true);
    }
  }

  // On the Volume pane, where lines are allowed: a horizontal line, stored at the value the pane reads at the click.
  await pick(page, 'Horizontal line');
  const level = await inPane(page, 1, 0.5, 0.4);
  const read = await paneValueAt(page, level);
  expect(read.pane).toBe(1);
  await page.mouse.click(level.x, level.y);
  await expect(rows(page)).toHaveCount(5);
  const onVolume = rows(page).nth(0);
  await expect(onVolume).toHaveAttribute('data-kind', 'horizontal');
  await expect(onVolume).toHaveAttribute('data-pane', '1');
  await expect(onVolume.getByTestId('drawing-pane')).toHaveText('Indicator pane 1');
  const storedLevel = pricesOf(await pointText(onVolume).textContent());
  expect(storedLevel).toHaveLength(1);
  expect(atTick(storedLevel[0], read.value), `stored ${storedLevel[0]}, pane value ${read.value}`).toBe(true);
  // Painted on the Volume pane, at the height that was clicked.
  const levelId = await onVolume.getAttribute('data-drawing-id');
  await expect.poll(async () => (await drawn(page)).find((d) => d.id === levelId)?.pane ?? null).toBe(1);
  const levelDrawn = (await drawn(page)).find((d) => d.id === levelId);
  expect(levelDrawn.lines.length).toBeGreaterThan(0);
  for (const [, y1, , y2] of levelDrawn.lines) {
    expect(inside(y1, volume) && inside(y2, volume), `line ${y1}..${y2} inside the Volume pane`).toBe(true);
    expect(Math.abs(y1 - (level.y - hostBox.y)), `line at ${y1}, clicked at ${level.y - hostBox.y}`).toBeLessThanOrEqual(1.5);
  }

  // A ray and an info line on the Volume pane: each point stored at the value the pane reads under it, and each painted
  // inside the Volume pane through the points that were clicked.
  const twoPointsOnVolume = async (tool, kind, a, b, count) => {
    await pick(page, tool);
    const p1 = await inPane(page, 1, a[0], a[1]);
    const v1 = await paneValueAt(page, p1);
    expect(v1.pane).toBe(1);
    await page.mouse.click(p1.x, p1.y);
    const p2 = await inPane(page, 1, b[0], b[1]);
    const v2 = await paneValueAt(page, p2);
    expect(v2.pane).toBe(1);
    await page.mouse.click(p2.x, p2.y);
    await expect(rows(page)).toHaveCount(count);
    const row = rows(page).nth(0);
    await expect(row).toHaveAttribute('data-kind', kind);
    await expect(row).toHaveAttribute('data-pane', '1');
    await expect(row.getByTestId('drawing-pane')).toHaveText('Indicator pane 1');
    const values = pricesOf(await pointText(row).textContent());
    expect(values).toHaveLength(2);
    expect(atTick(values[0], v1.value), `${kind} point 1: stored ${values[0]}, pane value ${v1.value}`).toBe(true);
    expect(atTick(values[1], v2.value), `${kind} point 2: stored ${values[1]}, pane value ${v2.value}`).toBe(true);
    const id = await row.getAttribute('data-drawing-id');
    await expect.poll(async () => (await drawn(page)).find((d) => d.id === id)?.pane ?? null).toBe(1);
    const painted = (await drawn(page)).find((d) => d.id === id);
    expect(painted.lines.length, `${kind} lines`).toBeGreaterThan(0);
    for (const [, y1, , y2] of painted.lines) {
      expect(inside(y1, volume) && inside(y2, volume), `${kind} line ${y1}..${y2} inside the Volume pane`).toBe(true);
    }
    // The first painted line starts at the height of the first point clicked, on the Volume pane.
    const startY = painted.lines[0][1];
    expect(Math.abs(startY - (p1.y - hostBox.y)), `${kind} starts at y ${startY}, clicked at ${p1.y - hostBox.y}`).toBeLessThanOrEqual(1.5);
    return id;
  };
  const rayId = await twoPointsOnVolume('Ray', 'ray', [0.6, 0.3], [0.8, 0.6], 6);
  const infoId = await twoPointsOnVolume('Info line', 'info', [0.2, 0.7], [0.4, 0.35], 7);

  // Where it is not allowed: a position reads a price, so on the Volume pane it is refused by name and nothing is placed.
  await pick(page, 'Long position');
  await clickIn(1, 0.5, 0.5);
  await expect(page.getByRole('alert').filter({ hasText: 'This tool draws on the price pane only.' })).toBeVisible();
  await expect(rows(page)).toHaveCount(7);
  await pick(page, 'Select');

  // The three Volume pane drawings are removed again, so the later steps list this journey's price pane drawings.
  for (const id of [infoId, rayId, levelId]) {
    await page.locator(`[data-drawing-id="${id}"]`).getByRole('button', { name: 'Delete', exact: true }).click();
  }
  await expect(rows(page)).toHaveCount(4);
});

test(`${J} #3 adds text at the chosen point, with the font size and colour chosen`, async () => {
  const toolbar = page.getByRole('toolbar', { name: 'Drawing tools' });
  const token = (name) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
  await pick(page, 'Text');
  await page.getByLabel('Text to place or edit').first().fill('Support');
  // The font size and colour are chosen before the text is placed.
  await toolbar.getByLabel('Text size').selectOption({ label: '24 px' });
  await toolbar.getByLabel('Text colour').selectOption({ label: 'Up' });
  const point = await centred(page, await inPane(page, 0, 0.25, 0.55));
  await page.mouse.click(point.x, point.y);
  const at = await pointerAt(page, point);
  const row = page.locator('[data-drawing-id][data-kind="text"]');
  await expect(row).toHaveCount(1);
  await expect(row.getByRole('textbox', { name: 'Text to place or edit' })).toHaveValue('Support');
  // At the chosen point: stored as the bar under the click and the price at its height.
  const stored = await pointText(row).textContent();
  expect(timesOf(stored)).toEqual([barTimeText(at.time)]);
  expect(atTick(pricesOf(stored)[0], at.price), `stored ${pricesOf(stored)[0]}, pointer ${at.price}`).toBe(true);
  // With the font size and colour chosen: stored with the text, and painted in that size and the Up colour.
  await expect(row).toHaveAttribute('data-size', '24');
  await expect(row).toHaveAttribute('data-tone', 'up');
  const id = await row.getAttribute('data-drawing-id');
  const up = await token('--if-up');
  const neutral = await token('--if-fg-2');
  expect(up, 'the Up colour token').not.toBe('');
  expect(up, 'Up is not the neutral text colour').not.toBe(neutral);
  const paintedText = async () => (await drawn(page)).find((d) => d.id === id)?.texts.find((t) => t.text === 'Support') ?? null;
  await expect.poll(async () => (await paintedText())?.font ?? '').toMatch(/(^|\s)24px\s/);
  expect((await paintedText()).colour).toBe(up);
  expect(
    Math.abs((await paintedText()).y - (point.y - (await page.getByTestId('cw').getByTestId('wc-host').boundingBox()).y)),
  ).toBeLessThanOrEqual(1.5);

  // The placed text's size and colour change from the object tree; its point stays where it was.
  await row.getByLabel('Text size').selectOption({ label: '18 px' });
  await row.getByLabel('Text colour').selectOption({ label: 'Down' });
  await expect(row).toHaveAttribute('data-size', '18');
  await expect(row).toHaveAttribute('data-tone', 'down');
  await expect.poll(async () => (await paintedText())?.font ?? '').toMatch(/(^|\s)18px\s/);
  expect((await paintedText()).colour).toBe(await token('--if-down'));
  await expect(pointText(row)).toHaveText(stored);
});

test(`${J} #4 drags a line's middle handle, and both points move by the same bar and price delta`, async () => {
  const trend = rowNamed(page, /^Trend line \d+$/);
  await trend.getByRole('button', { name: /^Trend line \d+$/ }).click();
  const beforeText = await pointText(trend).textContent();
  const before = pricesOf(beforeText);
  // The line's middle handle where the chart draws it now (the scale may have moved since step 1), in page pixels.
  const host = page.getByTestId('cw').getByTestId('wc-host');
  const id = await trend.getAttribute('data-drawing-id');
  const handle = await expect
    .poll(async () =>
      host.evaluate(
        (el, want) =>
          el
            .readDrawnLines?.()
            .find((d) => d.id === want)
            ?.handles.find((h) => h.index === 'middle') ?? null,
        id,
      ),
    )
    .not.toBeNull()
    .then(() =>
      host.evaluate(
        (el, want) =>
          el
            .readDrawnLines()
            .find((d) => d.id === want)
            .handles.find((h) => h.index === 'middle'),
        id,
      ),
    );
  const box = await host.boundingBox();
  const middle = { x: box.x + handle.x, y: box.y + handle.y };
  await page.mouse.move(middle.x, middle.y);
  await page.mouse.down();
  await page.mouse.move(middle.x + 40, middle.y - 12, { steps: 8 });
  await page.mouse.up();
  const afterText = await pointText(trend).textContent();
  const after = pricesOf(afterText);
  expect(after).not.toEqual(before);
  // The same bar delta: both points moved by the same time, a whole number of bars, and not by zero.
  const ms = (t) => Date.parse(`${t.replace(' ', 'T')}:00Z`);
  const [tb, ta] = [timesOf(beforeText).map(ms), timesOf(afterText).map(ms)];
  expect(ta[0] - tb[0]).toBe(ta[1] - tb[1]);
  expect(ta[0] - tb[0]).not.toBe(0);
  expect((ta[0] - tb[0]) % (15 * 60_000)).toBe(0);
  // Staying on the tick size: every moved price is written at the tick's places (two for BTC-USDT's 0.01 tick), so each
  // is a whole number of ticks, and both points moved by the same whole number of ticks.
  expect(after).toHaveLength(2);
  before.forEach((price, i) => expect(price, `point ${i + 1} before the drag`).toMatch(/^\d+\.\d{2}$/));
  after.forEach((price, i) => expect(price, `moved point ${i + 1}`).toMatch(/^\d+\.\d{2}$/));
  const cents = (price) => BigInt(price.replace('.', ''));
  const deltaA = cents(after[0]) - cents(before[0]);
  const deltaB = cents(after[1]) - cents(before[1]);
  expect(deltaA).toBe(deltaB);
});

test(`${J} #5 locks a drawing so it cannot move, and turns magnet on`, async () => {
  // Step 4 moved the first line, so this step draws its own line on points it knows, and works on that selected drawing.
  await pick(page, 'Trend line');
  const a = await plot(page, 0.3, 0.4);
  const b = await plot(page, 0.6, 0.5);
  await clickPlot(page, 0.3, 0.4);
  await clickPlot(page, 0.6, 0.5);
  const line = page.locator('[data-drawing-id][data-selected]');
  await expect(line).toHaveCount(1);
  const before = await pointText(line).textContent();
  const actions = page.getByRole('group', { name: 'Drawing actions' });
  await actions.getByRole('button', { name: 'Lock', exact: true }).click();
  const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  await page.mouse.move(middle.x, middle.y);
  await page.mouse.down();
  await page.mouse.move(middle.x + 60, middle.y, { steps: 6 });
  await page.mouse.up();
  await expect(pointText(line)).toHaveText(before);
  await expect(page.getByRole('alert').filter({ hasText: 'locked' })).toBeVisible();
  // Magnet snaps a placed point to the open, high, low or close of the nearest bar: it is switched on here.
  await pick(page, 'Magnet off');
  await expect(page.getByRole('button', { name: 'Magnet on', exact: true })).toHaveAttribute('aria-pressed', 'true');
  // Unlock and delete the line this step drew, so step 6 lists the five drawings of this journey.
  await actions.getByRole('button', { name: 'Unlock', exact: true }).click();
  await actions.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(rows(page)).toHaveCount(5);
  // With magnet on, a placed point snaps to the bar's close (the check adds a line and deletes it again).
  await magnetSnapsToClose();
  await expect(rows(page)).toHaveCount(5);
});

/**
 * With magnet on, a point placed a few pixels off a bar's close is stored at one of that bar's open, high, low or close,
 * not at the pointer's price: the bar under the pointer is read from the chart, its prices from Edge's candles, and the
 * height of the close found by reading the price up the plot.
 */
async function magnetSnapsToClose() {
  const x = await centred(page, await plot(page, 0.5, 0.3));
  const bar = await pointerAt(page, x);
  const host = page.getByTestId('cw').getByTestId('wc-host');
  const box = await host.boundingBox();
  const actions = page.getByRole('group', { name: 'Drawing actions' });
  // The bar's open, high, low and close from Edge's candles: its own candle's, or the previous close four times when the
  // bucket had no trade (a filled bar).
  const barPricesNow = async () => {
    const res = await fetch(`${EDGE}/api/v1/ohlcv/${encodeURIComponent('BTC/USDT')}?timeframe=15m&limit=240`);
    const rows15 = (await res.json()).sort((p, q) => p[0] - q[0]);
    const candle = rows15.filter((r) => r[0] <= bar.time * 1000).at(-1);
    expect(candle, `Edge serves a 15m candle at or before ${barTimeText(bar.time)}`).toBeDefined();
    return candle[0] === bar.time * 1000 ? candle.slice(1, 5).map(Number) : Array(4).fill(Number(candle[4]));
  };
  // The height the close is drawn at, read from the chart (the price pane is the chart's top pane).
  const closeYOf = (price) => host.evaluate((el, p) => el.readPriceY?.(p) ?? null, price);
  // The shared stack trades on this book while the step runs: a trade can move this bar's prices, or rescale the price
  // axis, between the read of the close's height and the click (run 42723613808 stored 65193.56, a price no snap from
  // three pixels off a 64976.46 close can reach). A placement during which the bar or the axis moved is deleted and
  // made again; the check below is only made on a placement both stayed still for.
  for (let attempt = 1; ; attempt += 1) {
    const ohlc = await barPricesNow();
    const close = ohlc[3];
    const closeY = await closeYOf(close);
    expect(closeY, 'the close is drawn on the price pane').not.toBeNull();
    // Three pixels off the close: the price there is not the close at the tick, so only the magnet can store the close.
    const off = await pointerAt(page, { x: x.x, y: box.y + closeY + 3 });
    expect(atTick(close.toFixed(2), off.price), 'three pixels off the close reads another price').toBe(false);
    await pick(page, 'Horizontal line');
    await page.mouse.click(x.x, box.y + closeY + 3);
    const placed = page.locator('[data-drawing-id][data-selected]');
    await expect(placed).toHaveAttribute('data-kind', 'horizontal');
    const placedText = await pointText(placed).textContent();
    const still = JSON.stringify(await barPricesNow()) === JSON.stringify(ohlc) && Math.abs((await closeYOf(close)) - closeY) < 0.5;
    if (!still && attempt < 3) {
      await actions.getByRole('button', { name: 'Delete', exact: true }).click();
      continue;
    }
    expect(still, `the bar and the price axis stayed still for one of ${attempt} placements`).toBe(true);
    // Stored at one of the bar's four prices (the nearest within the magnet's reach), not at the pointer's own price.
    const [stored] = pricesOf(placedText);
    expect(timesOf(placedText)).toEqual([barTimeText(bar.time)]);
    expect(
      ohlc.map((p) => p.toFixed(2)),
      `stored ${stored}; pointer ${off.price}`,
    ).toContain(stored);
    expect(atTick(stored, off.price)).toBe(false);
    await actions.getByRole('button', { name: 'Delete', exact: true }).click();
    return;
  }
}

test(`${J} #6 lists every drawing in the object tree, and hides a group together`, async () => {
  // Trend line, info line, horizontal line, ray and text: five drawings.
  await expect(rows(page)).toHaveCount(5);
  const checks = page.getByRole('checkbox', { name: /^Select / });
  await checks.nth(0).check();
  await checks.nth(1).check();
  await page.getByRole('button', { name: /^Group checked/ }).click();
  await page.getByRole('button', { name: 'Hide group', exact: true }).click();
  await expect(page.locator('[data-visible="false"]')).toHaveCount(2);
  await page.getByRole('button', { name: 'Show group', exact: true }).click();
  await expect(page.locator('[data-visible="false"]')).toHaveCount(0);
  // The tree also lists the chart's indicators: one row per study on the studies bar, each with its own actions. Hiding
  // one from the tree hides it on this interval: its legend row says so and the chart stops drawing it.
  const tree = page.getByTestId('tree-indicators');
  const chips = page.getByRole('group', { name: 'Studies on this chart' }).getByRole('button');
  await expect(tree.locator('[data-study-id]')).toHaveCount(await chips.count());
  const volume = tree.locator('[data-study-id="volume-1"]');
  await expect(volume).toContainText('Volume');
  const drawnKeys = async () =>
    JSON.parse((await page.getByTestId('cw').getByTestId('wc-host').getAttribute('data-study-series')) ?? '[]').map((x) => x.key);
  await expect.poll(drawnKeys).toContain('volume-1');
  await volume.getByRole('button', { name: /^Hide on / }).click();
  await expect(volume).toHaveAttribute('data-shown-here', 'false');
  await expect(page.locator('[data-study="volume-1"]')).toContainText('Hidden on this interval');
  await expect.poll(drawnKeys).not.toContain('volume-1');
  await volume.getByRole('button', { name: /^Show on / }).click();
  await expect(volume).toHaveAttribute('data-shown-here', 'true');
  await expect.poll(drawnKeys).toContain('volume-1');
});

test(`${J} #7 deletes a line, and Undo brings it back with its original points`, async () => {
  const line = rowNamed(page, /^Horizontal line \d+$/);
  await line.getByRole('button', { name: /^Horizontal line \d+$/ }).click();
  const before = await pointText(line).textContent();
  const count = await rows(page).count();
  await page.keyboard.press('Delete');
  await expect(rows(page)).toHaveCount(count - 1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(rows(page)).toHaveCount(count);
  await expect(pointText(rowNamed(page, /^Horizontal line \d+$/))).toHaveText(before);
});

test(`${J} #8 hides all drawings, then clears them after a confirmation`, async () => {
  await pick(page, 'Hide all');
  await expect(page.getByRole('button', { name: 'Show all', exact: true })).toBeVisible();
  // Every drawing is hidden: as many hidden rows as drawings, and none shown.
  const count = await rows(page).count();
  expect(count).toBeGreaterThan(0);
  await expect(page.locator('[data-drawing-id][data-visible="false"]')).toHaveCount(count);
  await expect(page.locator('[data-drawing-id][data-visible="true"]')).toHaveCount(0);
  await pick(page, 'Show all');
  await pick(page, 'Clear all');
  // The clear waits for the in-app dialog: nothing goes until it is confirmed.
  await expect(rows(page)).not.toHaveCount(0);
  await page.getByRole('alertdialog').getByRole('button', { name: 'Clear all', exact: true }).click();
  await expect(rows(page)).toHaveCount(0);
  // The cleared layout stays cleared on this device.
  await page.reload();
  await expect(rows(page)).toHaveCount(0);
});
