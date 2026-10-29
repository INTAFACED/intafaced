import { test, expect } from '@playwright/test';
import { signIn, signUp } from './desk.mjs';
import { ORIGIN } from './stack.mjs';

// J-home-ia-03, in the running app (docs/roadmap/journeys.json): I make Home mine. Tests titled "J-home-ia-03 #<n>" prove
// a whole step. One TEST person on two devices (two browser contexts with nothing shared but the account).
const J = 'J-home-ia-03';

test.describe.configure({ mode: 'serial' });

let who;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  const page = await browser.newPage();
  who = await signUp(page, 'hmt');
  // The app opens in Simple (owner decision 2026-10-26); this person picks Pro, a choice their account keeps for every device.
  await page.goto('/view');
  const pro = page.getByRole('group', { name: 'Default view' }).getByRole('button', { name: 'Pro', exact: true });
  const written = page.waitForResponse((res) => res.url().includes('preferences.set') && res.request().method() === 'POST');
  await pro.click();
  await expect(pro).toHaveAttribute('aria-pressed', 'true');
  expect((await written).status()).toBe(200);
  await page.close();
});

/** A device: its own browser context, signed in as the person, on Pro Home (the account's choice). */
async function device(browser) {
  const context = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await signIn(page, who);
  await page.goto('/home');
  await expect(page.getByTestId('if-home-pro')).toBeVisible();
  // While the balance call is out Home draws the assets panel as busy. This person is not verified, so once the call
  // answers the summary names that refusal and the panel goes; tiles are read only after that answer.
  await expect(page.getByTestId('hp-summary')).toContainText('Verify your identity first');
  return { context, page };
}

/** The tiles Pro Home draws, top to bottom, by the tile each element is. */
const TILE_OF = { 'hp-started': 'started', 'hp-assets-panel': 'holdings', 'hp-activity': 'activity', 'hp-markets': 'markets' };
async function drawnTiles(page) {
  return page
    .locator('[data-testid="if-home-pro"] > *')
    .evaluateAll((nodes, names) => nodes.map((node) => names[node.getAttribute('data-testid')]).filter(Boolean), TILE_OF);
}

async function openCustomise(page) {
  await page.getByRole('button', { name: 'Customise Home' }).click();
  const dialog = page.getByRole('dialog', { name: 'Customise Home' });
  await expect(dialog).toBeVisible();
  return dialog;
}
const outcome = (dialog) => dialog.getByRole('status');

/** The order the dialog lists, and which tiles it marks hidden. */
async function listed(dialog) {
  return dialog
    .locator('[data-tile]')
    .evaluateAll((rows) =>
      rows.map((row) => `${row.getAttribute('data-tile')}${row.getAttribute('data-hidden') === 'true' ? ' (hidden)' : ''}`),
    );
}

test(`${J} #1 Customise Home hides and reorders tiles on the account: the same layout on another device, Reset, and a conflict keeps the newer layout`, async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const a = await device(browser);
  const shipped = await drawnTiles(a.page);
  expect(shipped).toContain('markets');
  expect(shipped.indexOf('activity')).toBeLessThan(shipped.indexOf('markets'));

  // Hide the markets tile and move Recent activity up one place.
  let dialog = await openCustomise(a.page);
  const shippedList = await listed(dialog);
  expect(shippedList.some((tile) => tile.endsWith('(hidden)'))).toBe(false);
  await dialog.getByRole('checkbox', { name: 'Show Markets' }).uncheck();
  await expect(outcome(dialog)).toHaveText('Saved to your account.');
  await dialog.getByRole('button', { name: 'Move Recent activity up' }).click();
  await expect(outcome(dialog)).toHaveText('Saved to your account.');
  const chosen = await listed(dialog);
  expect(chosen).toContain('markets (hidden)');
  await dialog.getByRole('button', { name: 'Done' }).click();

  // After a reload the tile is gone, and Customise lists it as hidden; the other tiles keep the new order.
  await a.page.reload();
  await expect(a.page.getByTestId('if-home-pro')).toBeVisible();
  await expect(a.page.getByTestId('hp-markets')).toHaveCount(0);
  const mine = await drawnTiles(a.page);
  expect(mine).not.toContain('markets');
  dialog = await openCustomise(a.page);
  expect(await listed(dialog)).toEqual(chosen);
  await dialog.getByRole('button', { name: 'Done' }).click();
  // Hiding the tile hid nothing else: the markets are still a door in the top bar.
  await expect(a.page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Trade' })).toBeVisible();

  // Another device, with nothing stored in its browser, shows the same Home.
  const b = await device(browser);
  await expect(b.page.getByTestId('hp-markets')).toHaveCount(0);
  expect(await drawnTiles(b.page)).toEqual(mine);

  // Both devices have the layout open at the same version. A changes it first; B's change then meets a version
  // conflict, and B shows the newer layout instead of writing over it.
  const onA = await openCustomise(a.page);
  const onB = await openCustomise(b.page);
  await onA.getByRole('checkbox', { name: 'Show Recent activity' }).uncheck();
  await expect(outcome(onA)).toHaveText('Saved to your account.');
  await onB.getByRole('checkbox', { name: 'Show Markets' }).click(); // conflict: the box goes back to the newer layout
  await expect(outcome(onB)).toContainText('changed on another device');
  await expect(onB.locator('[data-tile="activity"]')).toHaveAttribute('data-hidden', 'true');
  await expect(onB.locator('[data-tile="markets"]')).toHaveAttribute('data-hidden', 'true');
  await onB.getByRole('button', { name: 'Done' }).click();
  await b.page.reload();
  await expect(b.page.getByTestId('hp-activity')).toHaveCount(0);
  await expect(b.page.getByTestId('hp-markets')).toHaveCount(0);

  // Reset returns the shipped order with every tile shown, on both devices.
  const reset = await openCustomise(b.page);
  await reset.getByRole('button', { name: 'Reset' }).click();
  await expect(outcome(reset)).toHaveText('Saved to your account.');
  expect(await listed(reset)).toEqual(shippedList);
  await reset.getByRole('button', { name: 'Done' }).click();
  await expect.poll(() => drawnTiles(b.page)).toEqual(shipped);
  await onA.getByRole('button', { name: 'Done' }).click();
  await a.page.reload();
  await expect(a.page.getByTestId('if-home-pro')).toBeVisible();
  await expect.poll(() => drawnTiles(a.page)).toEqual(shipped);

  await a.context.close();
  await b.context.close();
});
