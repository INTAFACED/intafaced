// World: book
import { test, expect } from './journey.mjs';
import { chosePro, signIn, signUp } from './desk.mjs';
import { ORIGIN } from './stack.mjs';
import { clickPlot, openWorkbench, pick, rows } from './charts-desk.mjs';
import { readFileSync } from 'node:fs';

// J-charts-desk-07, in the running app (docs/roadmap/journeys.json): a pro trader arranges the spot desk. One test per
// step, titled "J-charts-desk-07 #<n>", run in order on one TEST account. #1 and #2 are the desk's widget workspace on
// this device (C-workspace-01); #3 to #5 are saved layouts kept by the account (C-workspace-02); #6 is a chart template
// and the per-desk chart options, #7 the person's locale on the chart (C-embed-feed-ops-03).
const J = 'J-charts-desk-07';
const DESK = '/trade/spot/BTC-USDT';
const PREFERENCES = 'intafaced.customer.view.v1';

test.describe.configure({ mode: 'serial' });

let page;
let who;
test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ baseURL: ORIGIN });
  page = await context.newPage();
  await chosePro(page);
  who = await signUp(page, 'jcd07');
});
test.afterAll(async () => {
  await page?.context().close();
});

const desk = () => page.getByTestId('if-desk');
const widget = (id) => desk().locator(`[data-widget="${id}"]`);
const widgetIds = async () =>
  desk()
    .locator('[data-widget]')
    .evaluateAll((nodes) =>
      nodes
        .filter((node) => node.getBoundingClientRect().width > 0)
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
        .map((node) => node.getAttribute('data-widget')),
    );
const width = async (id) => (await widget(id).boundingBox()).width;
const layouts = () => page.getByRole('button', { name: 'Layouts' });
const layoutsMenu = () => page.getByRole('dialog', { name: 'Desk layout' });

async function openDesk() {
  await page.goto(DESK);
  await expect(page.getByRole('button', { name: 'Buy BTC' })).toBeVisible();
}

test(`${J} #1 opens the desk in Classic and picks Advanced from Layouts; the widget set changes and the choice is kept on this device`, async () => {
  await openDesk();
  // Classic: the markets list, the chart with its ticket, and the order book; no separate trades widget.
  await expect(desk()).toHaveAttribute('data-preset', 'classic');
  await expect.poll(widgetIds).toEqual(['markets', 'chart', 'book']);
  await expect(widget('trades')).toHaveCount(0);
  await layouts().click();
  await expect(layoutsMenu().getByRole('radio', { name: 'Classic' })).toBeChecked();
  await layoutsMenu().getByRole('radio', { name: 'Advanced' }).check();
  await expect(desk()).toHaveAttribute('data-preset', 'advanced');
  // Advanced adds the market trades widget beside the book.
  await expect.poll(widgetIds).toEqual(['markets', 'chart', 'book', 'trades']);
  await expect(widget('trades').getByRole('heading', { name: 'Market trades' })).toBeVisible();
  // Kept on this device: a reload opens Advanced again.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Buy BTC' })).toBeVisible();
  await expect(desk()).toHaveAttribute('data-preset', 'advanced');
  await expect.poll(widgetIds).toEqual(['markets', 'chart', 'book', 'trades']);
});

test(`${J} #2 drags a widget, resizes it, then resets the desk; the layout follows and reset returns the preset`, async () => {
  await openDesk();
  await expect(desk()).toHaveAttribute('data-preset', 'advanced');
  const presetWidth = await width('markets');
  await layouts().click();
  await layoutsMenu().getByRole('button', { name: 'Arrange widgets' }).click();
  await expect(desk()).toHaveAttribute('data-arranging', 'true');
  // Drag the order book onto the markets list: the two swap places and the others stay in view.
  // From the top of the desk, where both widgets' tops are on screen and clear of the sticky header.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole('button', { name: 'Move Order book' }).dragTo(widget('markets'), { targetPosition: { x: 40, y: 80 } });
  await expect.poll(widgetIds).toEqual(['book', 'chart', 'markets', 'trades']);
  for (const id of ['book', 'chart', 'markets', 'trades']) await expect(widget(id)).toBeInViewport();
  // Resize the markets list by its edge: it grows by about the distance dragged.
  const edge = page.getByRole('separator', { name: 'Resize Markets' });
  const box = await edge.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 64, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await width('markets')) - presetWidth).toBeGreaterThan(48);
  // The arrangement is kept on this device.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Buy BTC' })).toBeVisible();
  await expect.poll(widgetIds).toEqual(['book', 'chart', 'markets', 'trades']);
  expect((await width('markets')) - presetWidth).toBeGreaterThan(48);
  // Reset asks first, then returns the Advanced preset: its order and its widths.
  await layouts().click();
  await layoutsMenu().getByRole('button', { name: 'Reset desk' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Reset the desk?' });
  await expect(confirm).toContainText('Advanced');
  await confirm.getByRole('button', { name: 'Reset' }).click();
  await expect.poll(widgetIds).toEqual(['markets', 'chart', 'book', 'trades']);
  await expect.poll(async () => Math.abs((await width('markets')) - presetWidth)).toBeLessThan(2);
});

// #7 runs before the saved-layout steps, so a step still waiting on its store never keeps it from running.
test(`${J} #7 opens the desk with a locale set; chart labels and number formats follow the person's locale`, async ({ browser }) => {
  const context = await browser.newContext({ baseURL: ORIGIN });
  const fr = await context.newPage();
  try {
    // Signed in first (the sign-in helper reads the English page), then the person's language is French.
    await signIn(fr, who);
    await fr.evaluate((key) => {
      const saved = JSON.parse(localStorage.getItem(key) ?? '{}');
      localStorage.setItem(key, JSON.stringify({ ...saved, layoutMode: 'pro', language: 'fr' }));
    }, PREFERENCES);
    await fr.goto(DESK);
    const canvas = fr.getByRole('img', { name: /^Graphique des prix de / });
    await expect(canvas).toBeVisible({ timeout: 30_000 });
    // Hover the chart until the legend shows a bar: its labels and prices are the French ones.
    const box = await canvas.boundingBox();
    const legend = fr.getByTestId('pc-legend');
    await expect(async () => {
      for (let f = 0.95; f > 0.05; f -= 0.1) {
        await fr.mouse.move(box.x + box.width * f, box.y + box.height / 2);
        if (await legend.isVisible()) return;
      }
      throw new Error('no bar under the pointer');
    }).toPass({ timeout: 30_000 });
    await expect(legend).toContainText('Ouv.');
    await expect(legend).toContainText('Clôt.');
    await expect(legend).toContainText('Variation');
    // BTC/USDT prices are in the tens of thousands with a 0.01 tick: French groups thousands with a narrow space and
    // writes the decimals after a comma, never "65,000.00".
    const text = await legend.innerText();
    expect(text, text).toMatch(/\d[   ]\d{3},\d{2}/);
    expect(text, text).not.toMatch(/\d,\d{3}\.\d{2}/);
  } finally {
    await context.close();
  }
});

// Saved layouts are kept by the account (svc-identity preferences). Until that store serves them these steps fail at
// their first control, quickly.
const saveLayout = () => page.getByRole('button', { name: 'Save layout' });

test(`${J} #3 saves the layout as "Scalp"; it appears in the list with its symbol and interval, and the same name asks to replace`, async () => {
  await openDesk();
  await layouts().click();
  await saveLayout().click({ timeout: 5_000 });
  const dialog = page.getByRole('dialog', { name: 'Save layout' });
  await dialog.getByLabel('Layout name').fill('Scalp');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await layouts().click();
  const row = layoutsMenu().getByRole('listitem').filter({ hasText: 'Scalp' });
  await expect(row).toContainText('BTC/USDT');
  await expect(row).toContainText(/\b(1m|3m|5m|15m|30m|1h|2h|4h|6h|12h|1d|1w)\b/);
  await saveLayout().click();
  await page.getByRole('dialog', { name: 'Save layout' }).getByLabel('Layout name').fill('Scalp');
  await page.getByRole('dialog', { name: 'Save layout' }).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('alertdialog', { name: 'Replace “Scalp”?' })).toBeVisible();
  await page.getByRole('alertdialog', { name: 'Replace “Scalp”?' }).getByRole('button', { name: 'Replace' }).click();
  await layouts().click();
  await expect(layoutsMenu().getByRole('listitem').filter({ hasText: 'Scalp' })).toHaveCount(1);
});

test(`${J} #4 opens the same account on another device; the layout and its autosaved changes are there`, async ({ browser }) => {
  await openDesk();
  await layouts().click();
  await expect(layoutsMenu().getByRole('listitem').filter({ hasText: 'Scalp' })).toHaveCount(1, { timeout: 5_000 });
  // An autosaved change on this device, one a fresh device does not open with: the Advanced preset inside "Scalp".
  // Classic first when Advanced is already on, so the change to Advanced is a new one that is saved into the layout.
  const advanced = layoutsMenu().getByRole('radio', { name: 'Advanced' });
  if (await advanced.isChecked()) {
    await layoutsMenu().getByRole('radio', { name: 'Classic' }).check();
    await expect(desk()).toHaveAttribute('data-preset', 'classic');
  }
  await advanced.check();
  await expect(desk()).toHaveAttribute('data-preset', 'advanced');
  await expect(layoutsMenu()).toContainText('Saved');
  const other = await browser.newContext({ baseURL: ORIGIN });
  const second = await other.newPage();
  try {
    await chosePro(second);
    await signIn(second, who);
    await second.goto(DESK);
    const otherDesk = second.getByTestId('if-desk');
    // A fresh device opens Classic: anything else it shows came from the account.
    await expect(otherDesk).toHaveAttribute('data-preset', 'classic');
    await second.getByRole('button', { name: 'Layouts' }).click();
    const list = second.getByRole('dialog', { name: 'Desk layout' });
    const scalp = list.getByRole('listitem').filter({ has: second.getByText('Scalp', { exact: true }) });
    await expect(scalp).toHaveCount(1);
    await expect(scalp).toContainText('BTC/USDT');
    await scalp.getByRole('button', { name: 'Open' }).click();
    // The autosaved change is there: Advanced, with the market trades widget beside the book.
    await expect(otherDesk).toHaveAttribute('data-preset', 'advanced');
    await expect(otherDesk.locator('[data-widget="trades"]')).toBeVisible();
  } finally {
    await other.close();
  }
});

test(`${J} #5 copies, exports and deletes a layout, then recovers the deleted one with its charts`, async () => {
  await openDesk();
  await layouts().click();
  // A row by its exact name: "Scalp" must not also match "Scalp (copy)".
  const row = (name) =>
    layoutsMenu()
      .getByRole('listitem')
      .filter({ has: page.getByText(name, { exact: true }) });
  await row('Scalp').getByRole('button', { name: 'Copy' }).click({ timeout: 5_000 });
  await expect(row('Scalp (copy)')).toHaveCount(1);
  const download = page.waitForEvent('download');
  await row('Scalp').getByRole('button', { name: 'Export' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/Scalp.*\.json$/);
  // The file is the layout itself: its name, the symbol and interval it was saved on, and the desk's widgets.
  const exported = JSON.parse(readFileSync(await file.path(), 'utf8'));
  expect(exported.kind).toBe('intafaced.desk-layout');
  expect(exported.layout.name).toBe('Scalp');
  expect(exported.layout.symbol).toBe('BTC/USDT');
  expect(exported.layout.desk.order).toContain('chart');
  const savedInterval = exported.layout.interval;
  await row('Scalp').getByRole('button', { name: 'Delete' }).click();
  await expect(row('Scalp')).toHaveCount(0);
  await layoutsMenu().getByRole('button', { name: 'Recently deleted' }).click();
  await layoutsMenu().getByRole('listitem').filter({ hasText: 'Scalp' }).getByRole('button', { name: 'Restore' }).click();
  await expect(row('Scalp')).toHaveCount(1);
  // Back after a delete and a restore, the copy unchanged beside it.
  await expect(row('Scalp (copy)')).toHaveCount(1);
  // With its charts: from another market at another interval, opening it brings back its symbol and interval.
  const label = (id) => (id === '1d' ? '1D' : id === '1w' ? '1W' : id);
  const MAIN_CHIPS = ['1m', '5m', '15m', '1h', '4h', '1d'];
  const elsewhere = savedInterval === '1h' ? '4h' : '1h';
  await page.keyboard.press('Escape');
  await page.goto('/trade/spot/ETH-USDT');
  await expect(page.getByRole('button', { name: 'Buy ETH' })).toBeVisible();
  const intervals = page.getByTestId('dk-chart').getByRole('group', { name: 'Chart intervals' });
  await intervals.getByRole('button', { name: label(elsewhere), exact: true }).click();
  await expect(intervals.getByRole('button', { name: label(elsewhere), exact: true })).toHaveAttribute('aria-pressed', 'true');
  await layouts().click();
  await row('Scalp').getByRole('button', { name: 'Open' }).click();
  await expect(page).toHaveURL(/\/trade\/spot\/BTC-USDT$/);
  await expect(page.getByRole('button', { name: 'Buy BTC' })).toBeVisible();
  await expect(widget('chart')).toBeVisible();
  if (MAIN_CHIPS.includes(savedInterval)) {
    await expect(intervals.getByRole('button', { name: label(savedInterval), exact: true })).toHaveAttribute('aria-pressed', 'true');
  } else {
    // An interval from More: the More button names it.
    await expect(page.getByTestId('dk-chart').locator('.dk-more')).toContainText(label(savedInterval));
  }
});

test(`${J} #6 saves a chart template with indicators and drawings and applies it to another symbol; the desk's chart options are honoured`, async ({
  browser,
}) => {
  const host = (p) => p.getByTestId('cw').getByTestId('wc-host');
  const rsiSeries = async (p) =>
    JSON.parse((await host(p).getAttribute('data-study-series')) ?? '[]').filter((x) => x.key.split(':')[0] === 'rsi-1');
  const rsiChip = (p) => p.getByRole('button', { name: 'Settings for Relative Strength Index' });
  const canvas = (p, symbol) => p.getByRole('img', { name: `Price chart of ${symbol}` }).first();

  // On BTC/USDT: an indicator in a sub-pane, the Heikin Ashi style and a drawing on the price pane.
  await openWorkbench(page);
  await page.getByRole('button', { name: 'Indicators' }).click();
  await page.getByRole('searchbox', { name: 'Search indicators' }).fill('rsi');
  await page.getByRole('button', { name: 'Add Relative Strength Index', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(rsiChip(page)).toContainText('RSI 14');
  await page.getByRole('group', { name: 'Chart style' }).first().getByRole('button', { name: 'Heikin Ashi', exact: true }).click();
  await expect(canvas(page, 'BTC/USDT')).toHaveAttribute('data-style', 'heikin-ashi');
  await pick(page, 'Horizontal line');
  await clickPlot(page, 0.5, 0.3);
  await expect(rows(page)).toHaveCount(1);

  await page.getByRole('button', { name: 'Templates' }).click({ timeout: 5_000 });
  await page.getByRole('button', { name: 'Save as template' }).click();
  await page.getByLabel('Template name').fill('TEST studies');
  await page.getByRole('button', { name: 'Save template' }).click();
  // Kept by the account before the page is left: leaving at once could cut the write off.
  await expect(page.getByTestId('cw-template-saved')).toHaveAttribute('data-template', 'TEST studies');

  // Another symbol on another device: nothing of this chart is there until the template is applied.
  const other = await browser.newContext({ baseURL: ORIGIN });
  const second = await other.newPage();
  try {
    await chosePro(second);
    await signIn(second, who);
    await second.goto('/charts/ETH-USDT');
    await expect(host(second)).toBeVisible();
    await expect(second.getByTestId('studies')).toBeVisible();
    await expect(rsiChip(second)).toHaveCount(0);
    await expect(canvas(second, 'ETH/USDT')).not.toHaveAttribute('data-style', 'heikin-ashi');
    // The workbench is the full chart: every style, studies, drawings and templates are on.
    await expect(second.locator('.cw-page')).toHaveAttribute(
      'data-featureset',
      'styles=candles,bars,line,area,columns,heikin-ashi studies=on drawings=on templates=on',
    );
    await second.getByRole('button', { name: 'Templates' }).click();
    await second.getByRole('menuitem', { name: 'TEST studies' }).click();
    await expect(second.getByTestId('cw-template')).toHaveAttribute('data-template', 'TEST studies');
    // The study set is reproduced: RSI with its inputs, drawn in a sub-pane below the price pane, and the chart's style.
    await expect(rsiChip(second)).toContainText('RSI 14');
    await expect.poll(async () => (await rsiSeries(second)).length).toBeGreaterThan(0);
    for (const series of await rsiSeries(second)) expect(series.pane).toBeGreaterThan(0);
    await expect(canvas(second, 'ETH/USDT')).toHaveAttribute('data-style', 'heikin-ashi');
    // Drawings belong to the prices and times they were drawn on, so they stay on BTC/USDT.
    await expect(rows(second)).toHaveCount(0);

    // The spot desk's chart has its own options: candles and line, no indicators, drawings or templates, and the
    // template's Heikin Ashi does not reach it.
    await second.goto('/trade/spot/ETH-USDT');
    const deskChart = second.getByTestId('dk-chart');
    await expect(deskChart).toHaveAttribute('data-featureset', 'styles=candles,line studies=off drawings=off templates=off');
    const deskStyles = deskChart.getByRole('group', { name: 'Chart style' });
    await expect(deskStyles.getByRole('button')).toHaveText(['Candles', 'Line']);
    await expect(deskChart.getByRole('button', { name: 'Templates' })).toHaveCount(0);
    await expect(deskChart.getByRole('button', { name: 'Indicators' })).toHaveCount(0);
    await expect(deskStyles.locator('[aria-pressed="true"]')).toHaveCount(1);
  } finally {
    await other.close();
  }
});
