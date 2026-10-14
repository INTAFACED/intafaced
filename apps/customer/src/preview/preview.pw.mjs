import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const shots = process.env.PREVIEW_SHOTS ?? join(tmpdir(), 'intafaced-preview-shots');
mkdirSync(shots, { recursive: true });
const flagOff = process.env.PREVIEW_HARNESS_FLAG === '0';

const products = [
  ['futures', '/preview/futures', 'Futures'],
  ['options', '/preview/options', 'Options'],
  ['margin', '/preview/margin', 'Margin'],
  ['copy', '/preview/copy', 'Copy trading'],
  ['bots', '/preview/bots', 'Trading bots'],
  ['agents', '/preview/agents', 'Agents'],
  ['p2p', '/preview/p2p', 'P2P'],
  ['earn', '/preview/earn', 'Earn'],
  ['loans', '/preview/loans', 'Loans'],
  ['deposit', '/preview/deposit', 'Deposit'],
  ['withdraw', '/preview/withdraw', 'Withdraw'],
  ['card', '/preview/card', 'Card'],
  ['ifc', '/preview/ifc', 'IFC'],
  ['academy', '/preview/academy', 'Academy'],
];

/** Every request goes to a mocked API; the test records them so it can prove the Preview screens send none of their own. */
async function mockApi(page) {
  const calls = [];
  await page.route('**/api/**', async (route) => {
    calls.push({ method: route.request().method(), url: route.request().url() });
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { message: 'mocked' } }) });
  });
  return calls;
}
const consoleErrors = (page) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
};

test.describe('Preview on', () => {
  test.skip(flagOff, 'run without PREVIEW_HARNESS_FLAG=0');

  test('Futures shows the chip, the caption and sample data; an action opens the sheet and sends nothing', async ({ page }) => {
    const errors = consoleErrors(page);
    const calls = await mockApi(page);
    await page.goto('/preview/futures');
    await expect(page.locator('.if-preview__title')).toHaveText('Futures');
    await expect(page.locator('.if-preview__head [data-slot="preview-chip"]')).toHaveText('Preview');
    await expect(page.locator('[data-slot="preview-caption"]')).toHaveText('Preview: sample numbers, not your account');
    await expect(page.getByTestId('preview-sample')).toContainText('Mark price');
    await expect(page.getByTestId('preview-sample')).toContainText('$64,250.00');
    await page.screenshot({ path: join(shots, 'futures-loaded-1440.png') });

    await page.waitForTimeout(500);
    const before = calls.length;
    await page.getByRole('button', { name: 'Try an action' }).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('heading', { name: 'Preview: nothing was sent' })).toBeVisible();
    await expect(sheet).toContainText('Futures is not live yet. Nothing was sent, and nothing on your account changed.');
    await page.screenshot({ path: join(shots, 'futures-sheet-1440.png') });
    await page.waitForTimeout(400);
    expect(calls.length, 'the action must not call the API').toBe(before);

    await sheet.getByRole('button', { name: 'OK' }).click();
    await expect(sheet).toBeHidden();
    await page.getByRole('button', { name: 'Try an action' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('all 14 products open a Preview screen with the chip, the caption and the sheet', async ({ page }) => {
    const errors = consoleErrors(page);
    await mockApi(page);
    for (const [id, path, name] of products) {
      await page.goto(path);
      await expect(page.locator('.if-preview__title'), id).toHaveText(name);
      expect(new URL(page.url()).pathname, id).toBe(path);
      await expect(page.locator('[data-preview-product]'), id).toHaveAttribute('data-preview-product', id);
      await expect(page.locator('.if-preview__head [data-slot="preview-chip"]'), id).toHaveText('Preview');
      await expect(page.locator('[data-slot="preview-caption"]'), id).toHaveText('Preview: sample numbers, not your account');
      await page.getByRole('button', { name: 'Try an action' }).click();
      await expect(page.getByRole('dialog').getByRole('heading', { name: 'Preview: nothing was sent' }), id).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog'), id).toBeHidden();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${id} no horizontal scroll`).toBe(true);
    }
    expect(errors).toEqual([]);
  });

  test('an older address redirects to its /preview/<product> route', async ({ page }) => {
    await mockApi(page);
    for (const [path, target] of [
      ['/trade/futures', '/preview/futures'],
      ['/uc/recharge', '/preview/deposit'],
      ['/academy', '/preview/academy'],
    ]) {
      await page.goto(path);
      await expect.poll(() => new URL(page.url()).pathname, path).toBe(target);
      await expect(page.locator('[data-slot="preview-chip"]').first()).toBeVisible();
    }
  });

  test('the top-bar menus list the Preview products, each with the chip, and a click lands on the Preview screen', async ({ page }) => {
    await mockApi(page);
    await page.goto('/trade/spot/BTC-USDT');
    const trade = page.locator('.tb-item', { hasText: 'Trade' }).first();
    await trade.hover();
    const menu = page.locator('.tb-menu').first();
    await expect(menu).toBeVisible();
    const futures = menu.locator('.tb-menu-item', { hasText: 'Futures' });
    await expect(futures.locator('[data-slot="preview-chip"]')).toHaveText('Preview');
    const live = menu.locator('.tb-menu-item', { hasText: 'Convert' });
    await expect(live.locator('[data-slot="preview-chip"]')).toHaveCount(0);
    await page.screenshot({ path: join(shots, 'menu-trade-1440.png') });
    await futures.click();
    await expect(page.locator('.if-preview__title')).toHaveText('Futures');
    expect(new URL(page.url()).pathname).toBe('/preview/futures');
  });

  test('a person with no saved choice lands in Pro (the desk), and Simple is kept once chosen', async ({ page }) => {
    await mockApi(page);
    await page.goto('/home');
    await expect(page.locator('.tb-mode [aria-pressed="true"]').first()).toContainText('Pro');
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('intafaced.customer.view.v1') ?? '{}'));
    expect(stored.layoutModeChosen ?? false).toBe(false);
    await page.screenshot({ path: join(shots, 'home-default-pro-1440.png') });
    // An older save holding the old default (simple, never chosen) also opens in Pro.
    await page.evaluate(() => localStorage.setItem('intafaced.customer.view.v1', JSON.stringify({ layoutMode: 'simple' })));
    await page.reload();
    await expect(page.locator('.tb-mode [aria-pressed="true"]').first()).toContainText('Pro');
    // A mode picked after the change is kept.
    await page.evaluate(() =>
      localStorage.setItem('intafaced.customer.view.v1', JSON.stringify({ layoutMode: 'simple', layoutModeChosen: true })),
    );
    await page.reload();
    await expect(page.locator('.tb-mode [aria-pressed="true"]').first()).toContainText('Simple');
  });
});

test.describe('Preview off (what a production build does by default)', () => {
  test.skip(!flagOff, 'run with PREVIEW_HARNESS_FLAG=0');

  // The harness is a dev server, and a dev build opens hidden screens under a ribbon instead of redirecting them (App.tsx);
  // a customer build redirects them to the tab home (feature-registry.test.ts covers that rule). Here: no Preview chip,
  // the page says it is hidden, and the menus list no Preview rows.
  test('a Preview path is treated as hidden and the menus list no Preview rows', async ({ page }) => {
    await mockApi(page);
    await page.goto('/preview/futures');
    await expect(page.locator('.dev-ribbon')).toContainText('Hidden from customers');
    await expect(page.locator('[data-slot="preview-chip"]')).toHaveCount(0);
    await page.goto('/trade/spot/BTC-USDT');
    await page.locator('.tb-item', { hasText: 'Trade' }).first().hover();
    await expect(page.locator('.tb-menu').first()).toBeVisible();
    await expect(page.locator('.tb-menu .tb-menu-item', { hasText: 'Futures' })).toHaveCount(0);
    await expect(page.locator('.tb-menu .tb-menu-item', { hasText: 'Convert' })).toHaveCount(1);
    await page.screenshot({ path: join(shots, 'flag-off-menu-1440.png') });
  });
});
