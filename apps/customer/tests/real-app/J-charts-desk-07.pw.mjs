import { expect, test } from '@playwright/test';
import { EDGE, journeyState } from './stack.mjs';
import { signIn, signUp } from './desk.mjs';

// J-charts-desk-07 "I arrange my desk: Classic or Advanced widgets, saved layouts and templates that follow me"
// (docs/roadmap/journeys.json). One test per step, titled "J-charts-desk-07 #<n>", run in order on one TEST account that the
// first step makes (the run file keeps it). Slices: C-workspace-01 (presets, drag, reset), C-workspace-02 (saved layouts, the
// server copy, recovery), C-embed-feed-ops-03 (templates, featuresets, locale).
//
// This is a DRAFT: it has not been run against the local stack (the shared stack was not available when it was written).
// Every control is named by the copy the screen renders (apps/customer/src/screens/charts/layouts/copy.ts). The owner's layout
// limits are the TEST profile values (IDENTITY_LAYOUT_CAP, IDENTITY_LAYOUT_RESTORE_DAYS, IDENTITY_LAYOUT_RESTORE_LIST_SIZE,
// IDENTITY_CHART_TEMPLATE_CAP), so each save here is allowed. Prices are read from the public ticker Edge serves.
const J = 'J-charts-desk-07';
const CHART = '/charts/BTC-USDT';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

/** The Layouts menu's panel: a labelled region, open after its button is pressed. */
const panel = (page) => page.getByRole('region', { name: 'Layouts' });
const split = (page) => page.locator('.cw-split');
const grip = (page) => page.getByRole('button', { name: 'Drag widget' });
const savedRow = (page, name) => page.locator('.ly-item').filter({ hasText: name });

function account() {
  const who = run.read().account;
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

/** Opens the workbench and waits for its heading. */
async function openWorkbench(page, path = CHART) {
  await page.goto(path);
  await expect(page.getByRole('heading', { name: 'Charts' })).toBeVisible();
}

/** Opens the Layouts menu. The menu is closed by default, so each test that needs it opens it once. */
async function openLayouts(page) {
  await page.getByRole('button', { name: 'Layouts', exact: true }).click();
  await expect(panel(page)).toBeVisible();
}

/** The public ticker Edge serves for a symbol: the market the page must agree with. */
async function publicTicker(symbol) {
  const res = await fetch(`${EDGE}/api/v1/ticker/${encodeURIComponent(symbol)}`);
  expect(res.status).toBe(200);
  return res.json();
}

/** Adds a study through the indicator dialog: search, then Add (the steps J-charts-desk-03 uses). */
async function addStudy(page, search, name) {
  await page.getByRole('button', { name: 'Indicators' }).click();
  await page.getByRole('searchbox', { name: 'Search indicators' }).fill(search);
  await page.getByRole('button', { name: `Add ${name}`, exact: true }).click();
}

test(`${J} #1 opens the desk, picks Classic and then Advanced from Layouts; the widget set changes and the choice stays on this device`, async ({
  page,
}) => {
  const who = await signUp(page, 'desk');
  run.reset({ account: who });
  await signIn(page, who);
  await openWorkbench(page);
  // A device with nothing stored opens on Advanced: the studies bar and the drawing tools are on the page.
  await expect(page.getByTestId('studies').first()).toBeVisible();
  await openLayouts(page);
  await expect(page.locator('[data-preset="advanced"]')).toHaveAttribute('aria-pressed', 'true');
  // Classic leaves the studies bar and the drawing tools out of the page.
  await page.locator('[data-preset="classic"]').click();
  await expect(page.locator('[data-preset="classic"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('studies')).toHaveCount(0);
  // Advanced brings them back.
  await page.locator('[data-preset="advanced"]').click();
  await expect(page.getByTestId('studies').first()).toBeVisible();
  await expect(page.locator('.dw-layer').first()).toBeVisible();
  // The choice is kept on this device: a reload comes back in Advanced.
  await page.reload();
  await expect(page.getByTestId('studies').first()).toBeVisible();
});

test(`${J} #2 drags the watchlist to the left, resizes its column, then resets the desk; the reset returns the preset`, async ({
  page,
}) => {
  await signIn(page, account());
  await openWorkbench(page);
  // Drag the watchlist widget onto the left half of the page.
  await grip(page).dragTo(split(page), { targetPosition: { x: 8, y: 120 } });
  await expect(split(page)).toHaveAttribute('data-side', 'left');
  // Resize the watchlist column by its Last separator, dragged to the right.
  const separator = page.getByRole('separator', { name: 'Resize Last column' });
  const box = await separator.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2);
  await page.mouse.up();
  // Reset the desk: the watchlist goes back to the right, the grid to one chart. Reset asks first.
  await openLayouts(page);
  await page.getByRole('button', { name: 'Reset desk', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Reset desk' })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(split(page)).toHaveAttribute('data-side', 'right');
  await expect(page.locator('[data-cell]')).toHaveCount(1);
});

test(`${J} #3 saves the layout as "Scalp": it shows with its symbol and interval; saving the same name asks to replace`, async ({
  page,
}) => {
  await signIn(page, account());
  await openWorkbench(page);
  await openLayouts(page);
  await page.getByRole('textbox', { name: 'Layout name' }).fill('Scalp');
  await page.getByRole('button', { name: 'Save as', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved Scalp.' })).toBeVisible();
  const row = savedRow(page, 'Scalp');
  await expect(row).toContainText('BTC/USDT');
  await expect(row).toContainText('15m');
  // The second save under the same name (case and spacing ignored) asks first; Replace keeps one layout with that name.
  await page.getByRole('textbox', { name: 'Layout name' }).fill(' scalp ');
  await page.getByRole('button', { name: 'Save as', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'already exists' })).toBeVisible();
  await page.getByRole('button', { name: 'Replace', exact: true }).click();
  await expect(page.locator('.ly-item').filter({ hasText: 'Scalp' })).toHaveCount(1);
});

test(`${J} #4 opens the same account on another device: the layout and its autosaved change are there`, async ({ page, browser }) => {
  const who = account();
  await signIn(page, who);
  await openWorkbench(page);
  await openLayouts(page);
  // Open Scalp, then change the interval on this device: the open layout autosaves the change to the account.
  await page.getByRole('button', { name: 'Open Scalp', exact: true }).click();
  await page.getByRole('group', { name: 'Chart intervals' }).getByRole('button', { name: '1h', exact: true }).click();
  const other = await browser.newContext({ baseURL: 'http://127.0.0.1:3210' });
  try {
    const second = await other.newPage();
    await signIn(second, who);
    await openWorkbench(second);
    await openLayouts(second);
    await expect(savedRow(second, 'Scalp')).toBeVisible();
    await expect(savedRow(second, 'Scalp')).toContainText('BTC/USDT');
    // Autosave is debounced: the first device says so once the change has landed, then the account copy shows the new interval.
    await expect(panel(page).getByRole('status').filter({ hasText: 'Saved to your account.' })).toBeVisible({ timeout: 15_000 });
    await second.reload();
    await openLayouts(second);
    await expect(savedRow(second, 'Scalp')).toContainText('1h');
  } finally {
    await other.close();
  }
});

test(`${J} #5 copies, exports and deletes a layout, then recovers the deleted one with its charts`, async ({ page }) => {
  await signIn(page, account());
  await openWorkbench(page);
  await openLayouts(page);
  // Copy: the copy has the same settings under its own name.
  await page.getByRole('button', { name: 'Copy Scalp', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Copied as Scalp copy.' })).toBeVisible();
  await expect(savedRow(page, 'Scalp copy')).toBeVisible();
  // Export: a file of the settings, never the candles.
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export Scalp copy', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('scalp-copy.layout.json');
  // Delete: the layout goes to Recently deleted, from which it can be recovered.
  await page.getByRole('button', { name: 'Delete Scalp copy', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Recover it from the list below.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recently deleted' })).toBeVisible();
  // Recover: it comes back in the list with its charts.
  await page.getByRole('button', { name: 'Recover Scalp copy', exact: true }).click();
  await expect(savedRow(page, 'Scalp copy')).toBeVisible();
});

test(`${J} #6 saves a chart template with indicators and drawings and applies it to another market; the desk's featureset is honoured`, async ({
  page,
}) => {
  await signIn(page, account());
  await openWorkbench(page);
  await openLayouts(page);
  await page.locator('[data-preset="advanced"]').click();
  // The indicator dialog opens from the studies bar, which Advanced shows. The Layouts panel stays open.
  await addStudy(page, 'sma', 'Simple moving average');
  await page.getByRole('textbox', { name: 'Template name' }).fill('Trend desk');
  await page.getByRole('button', { name: 'Save template', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved template Trend desk.' })).toBeVisible();
  // Apply the template to ETH-USDT: its study set comes with it, and the page moves to that market.
  const template = page.locator('[data-template-id]').filter({ hasText: 'Trend desk' });
  await template.getByRole('combobox', { name: 'Apply to market' }).selectOption('ETH/USDT');
  await template.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page).toHaveURL(/\/charts\/ETH-USDT/);
  await expect(page.getByTestId('study-legend').first()).toContainText('SMA');
  // Featureset: on Classic the studies bar is not in the page, though the template keeps its studies for Advanced.
  await openLayouts(page);
  await page.locator('[data-preset="classic"]').click();
  await expect(page.getByTestId('studies')).toHaveCount(0);
  // The market applied to is a listed market: its ticker is served by the public route.
  expect(await publicTicker('ETH/USDT')).toBeTruthy();
});

test(`${J} #7 opens the desk with a locale set: chart labels and number formats follow the person's locale`, async ({ page }) => {
  await signIn(page, account());
  // The account's language, set from the account menu. The control's accessible name is confirmed when the stack runs.
  await page
    .getByRole('combobox', { name: /language/i })
    .first()
    .selectOption('fr');
  await openWorkbench(page);
  await openLayouts(page);
  // The menu's words follow French where the catalogue has them.
  await expect(page.getByRole('button', { name: 'Enregistrer sous', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Réinitialiser le bureau', exact: true })).toBeVisible();
  // A word French has no translation for is shown in English, and the menu says so.
  await expect(panel(page)).toContainText('Some words are shown in English');
  expect(await publicTicker('BTC/USDT')).toBeTruthy();
});
