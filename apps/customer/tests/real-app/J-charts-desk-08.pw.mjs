import { test, expect } from '@playwright/test';

// J-charts-desk-08, in the running app (docs/roadmap/journeys.json): several charts at once, synced, and a replay of a
// past move. One test per step, titled "J-charts-desk-08 #<n>". The chart limit is the owner's value, served by
// svc-trade; the local stack sets a labelled TEST value (local-test-gates.mjs charts). Bars are the stack's TEST trades.
const J = 'J-charts-desk-08';
const CHART = '/charts/BTC-USDT';

const cell = (page, i) => page.locator(`[data-cell="${i}"]`);
const canvasOf = (page, i) => cell(page, i).getByRole('img', { name: /Price chart of/ });
const pressedIn = (page, i) => cell(page, i).getByRole('group', { name: 'Chart intervals' }).locator('button[aria-pressed="true"]');

async function openGrid(page) {
  await page.goto(CHART);
  await page.getByRole('combobox', { name: /^Layout/ }).selectOption('grid');
  await expect(page.locator('section[data-testid="cw"]')).toHaveCount(4);
  for (let i = 0; i < 4; i += 1)
    await expect.poll(async () => Number(await canvasOf(page, i).getAttribute('data-bars'))).toBeGreaterThan(0);
}

const width = async (page, i) => (await cell(page, i).boundingBox()).width;
const height = async (page, i) => (await cell(page, i).boundingBox()).height;

test(`${J} #1 opens a 2x2 grid; dragging a border resizes two cells and a double-click resets`, async ({ page }) => {
  await openGrid(page);
  const before = [await width(page, 0), await width(page, 1)];
  expect(Math.abs(before[0] - before[1])).toBeLessThan(4);
  const border = page.getByRole('separator', { name: /resize the columns/ });
  const box = await border.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 200, box.y + 40, { steps: 6 });
  await page.mouse.up();
  const after = [await width(page, 0), await width(page, 1)];
  expect(after[0] - before[0]).toBeGreaterThan(150);
  expect(before[1] - after[1]).toBeGreaterThan(150);
  // The rows kept their size.
  expect(Math.abs((await height(page, 0)) - (await height(page, 2)))).toBeLessThan(4);
  await border.dblclick();
  await expect.poll(async () => Math.abs((await width(page, 0)) - (await width(page, 1)))).toBeLessThan(4);
});

test(`${J} #2 maximises one chart with Alt+Enter and brings the others back on the same key`, async ({ page }) => {
  await openGrid(page);
  await canvasOf(page, 1).focus();
  await page.keyboard.press('Alt+Enter');
  await expect(page.getByTestId('cg-area')).toHaveAttribute('data-maximised', '1');
  await expect(cell(page, 0)).toBeHidden();
  await expect(cell(page, 1)).toBeVisible();
  expect(await width(page, 1)).toBeGreaterThan(1000);
  await page.keyboard.press('Alt+Enter');
  await expect(page.getByTestId('cg-area')).toHaveAttribute('data-maximised', '');
  // The others stayed alive: their bars are still drawn.
  for (const i of [0, 2, 3]) await expect.poll(async () => Number(await canvasOf(page, i).getAttribute('data-bars'))).toBeGreaterThan(0);
});

test(`${J} #3 turns on sync for symbol, interval, crosshair and date range in one group; the others do not follow`, async ({ page }) => {
  await openGrid(page);
  for (const name of ['Market', 'Interval', 'Crosshair', 'Date range']) await page.getByRole('checkbox', { name }).check();
  // Chart 4 leaves the blue group.
  await cell(page, 3).getByLabel('Group').selectOption({ label: 'No group' });
  // Interval from chart 1: charts 2 and 3 follow, chart 4 keeps its own.
  await cell(page, 0).getByRole('group', { name: 'Chart intervals' }).getByRole('button', { name: '5m', exact: true }).click();
  for (const i of [0, 1, 2]) await expect(pressedIn(page, i)).toHaveText('5m');
  await expect(pressedIn(page, 3)).toHaveText('15m');
  // Market from chart 2: the group (and the address) follow; chart 4 stays on BTC/USDT.
  await cell(page, 1).getByLabel('Market').selectOption('ETH/USDT');
  for (const i of [0, 1, 2]) await expect(cell(page, i)).toHaveAttribute('data-symbol', 'ETH/USDT');
  await expect(cell(page, 3)).toHaveAttribute('data-symbol', 'BTC/USDT');
  await expect(page).toHaveURL(/\/charts\/ETH-USDT/);
  for (let i = 0; i < 4; i += 1)
    await expect.poll(async () => Number(await canvasOf(page, i).getAttribute('data-bars'))).toBeGreaterThan(0);
  // Crosshair: hovering chart 1 puts the crosshair at the same time on charts 2 and 3, not on 4.
  // The stack's TEST trades may cover only part of the plot, so sweep across it until the pointer is over a bar.
  const box = await canvasOf(page, 0).boundingBox();
  await expect
    .poll(async () => {
      for (let f = 0.05; f < 0.95; f += 0.05) {
        await page.mouse.move(box.x + box.width * f, box.y + box.height / 2);
        if (await cell(page, 0).getAttribute('data-crosshair')) return true;
      }
      return false;
    })
    .toBe(true);
  const at = await cell(page, 0).getAttribute('data-crosshair');
  for (const i of [1, 2]) await expect(cell(page, i)).toHaveAttribute('data-crosshair', at);
  await expect(cell(page, 3)).not.toHaveAttribute('data-crosshair', at);
  // Date range: zooming chart 1 moves charts 2 and 3 to the same range; chart 4 keeps its own.
  const unzoomed = await cell(page, 0).getAttribute('data-range');
  await canvasOf(page, 0).focus();
  await page.keyboard.press('+');
  await page.keyboard.press('+');
  // Each zoom lands a moment after its key, so chart 1's range is read again on every poll, never once up front.
  const ranges = async () => Promise.all([0, 1, 2, 3].map((i) => cell(page, i).getAttribute('data-range')));
  await expect
    .poll(async () => {
      const [first, second, third] = await ranges();
      return first !== unzoomed && second === first && third === first;
    })
    .toBe(true);
  const [zoomed, , , own] = await ranges();
  expect(own).not.toBe(zoomed);
});

test(`${J} #5 starts bar replay 100 bars back at 4x; the chart moves forward bar by bar and the real bars are untouched`, async ({
  page,
}) => {
  await page.goto(`${CHART}?interval=1m`);
  const canvas = canvasOf(page, 0);
  await expect.poll(async () => Number(await canvas.getAttribute('data-bars'))).toBeGreaterThan(0);
  const total = Number(await canvas.getAttribute('data-bars'));
  const newest = await canvas.getAttribute('data-last');
  await page.getByRole('button', { name: 'Bar replay' }).click();
  const back = Math.min(100, total - 1);
  await page.getByLabel('Start this many bars back').fill(String(back));
  await page.getByRole('group', { name: 'Bar replay' }).getByLabel('Speed').selectOption('4');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByTestId('replay-position')).toHaveText(`Replay: bar ${total - back} of ${total}`);
  await expect(canvas).toHaveAttribute('data-bars', String(total - back));
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  // At 4x a bar every 250 ms: the position climbs one bar at a time.
  const seen = new Set();
  for (let i = 0; i < 12; i += 1) {
    seen.add(Number(await canvas.getAttribute('data-bars')));
    await page.waitForTimeout(120);
  }
  const steps = [...seen].sort((a, b) => a - b);
  expect(steps.length).toBeGreaterThan(3);
  for (let i = 1; i < steps.length; i += 1) expect(steps[i] - steps[i - 1]).toBeLessThanOrEqual(2);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const held = await canvas.getAttribute('data-bars');
  await page.waitForTimeout(600);
  await expect(canvas).toHaveAttribute('data-bars', held);
  // Asking further back than the loaded bars is refused with the depth there is.
  await page.getByRole('button', { name: 'Exit replay' }).click();
  await page.getByLabel('Start this many bars back').fill(String(total + 50));
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByTestId('replay-note')).toContainText('replay can start at most');
  // Leaving replay draws every bar again, up to the newest.
  await expect.poll(async () => Number(await canvas.getAttribute('data-bars'))).toBeGreaterThanOrEqual(total);
  expect(Number(await canvas.getAttribute('data-last'))).toBeGreaterThanOrEqual(Number(newest));
});

test(`${J} #6 uses chart and desk shortcuts, and each does what its help list says`, async ({ page }) => {
  await openGrid(page);
  await canvasOf(page, 0).focus();
  await page.keyboard.press('?');
  const list = page.getByTestId('shortcut-list');
  await expect(list).toBeVisible();
  for (const key of ['Alt+Enter', 'Alt+1 … Alt+6', 'Alt+R', 'Alt+G', 'Alt+T', '?']) await expect(list).toContainText(key);
  await page.keyboard.press('Escape');
  await canvasOf(page, 2).focus();
  await page.keyboard.press('Alt+3');
  await expect(canvasOf(page, 2)).toHaveAttribute('data-style', 'line');
  await page.keyboard.press('Alt+6');
  await expect(canvasOf(page, 2)).toHaveAttribute('data-style', 'heikin-ashi');
  await page.keyboard.press('Alt+R');
  await expect(cell(page, 2).getByRole('group', { name: 'Bar replay' })).toBeVisible();
  await page.keyboard.press('Alt+Enter');
  await expect(page.getByTestId('cg-area')).toHaveAttribute('data-maximised', '2');
  await page.keyboard.press('Alt+Enter');
  await page.keyboard.press('Alt+G');
  await expect(page.getByTestId('cg-area')).toHaveAttribute('data-layout', 'single');
  // Keys are off inside a field.
  await page.getByLabel('Go to date').first().focus();
  await page.keyboard.press('Alt+G');
  await expect(page.getByTestId('cg-area')).toHaveAttribute('data-layout', 'single');
  // The desk key opens the desk for this market; nothing is sent.
  await canvasOf(page, 0).focus();
  await page.keyboard.press('Alt+T');
  await expect(page).toHaveURL(/\/trade\/spot\/BTC-USDT/);
});

test(`${J} #4 applies RSI to every chart of a 2x2 sync group at once: each cell draws its RSI pane`, async ({ page }) => {
  // 1m: RSI 14 needs 15 bars at the chart's interval, and the stack's 1m history is the longest of the TEST intervals.
  await openGrid(page);
  for (let i = 0; i < 4; i += 1)
    await cell(page, i).getByRole('group', { name: 'Chart intervals' }).getByRole('button', { name: '1m', exact: true }).click();
  await cell(page, 0).getByRole('button', { name: 'Indicators' }).click();
  await page.getByRole('searchbox', { name: 'Search indicators' }).fill('rsi');
  // All four charts start in the blue group, so the group has four charts.
  await page.getByRole('checkbox', { name: /Add to every chart in this sync group \(4\)/ }).check();
  await page.getByRole('button', { name: 'Add Relative Strength Index', exact: true }).click();
  for (let i = 0; i < 4; i += 1) {
    await expect(cell(page, i).locator('[data-study="rsi-1"]')).toHaveAttribute('data-pane', 'sub');
    // Volume is the default sub-pane, so RSI makes two indicator panes.
    await expect(canvasOf(page, i)).toHaveAttribute('data-study-panes', '2');
  }
});
