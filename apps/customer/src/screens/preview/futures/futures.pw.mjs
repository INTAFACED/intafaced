import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const shots = process.env.DERIVS_SHOTS ?? join(tmpdir(), 'intafaced-derivs-shots');
mkdirSync(shots, { recursive: true });

/** Every request goes to a mocked API; the test records them so it can prove the Preview screen sends none of its own. */
async function mockApi(page) {
  const calls = [];
  await page.route('**/api/**', async (route) => {
    calls.push({ method: route.request().method(), url: route.request().url() });
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { message: 'mocked' } }) });
  });
  return calls;
}

test('Futures shows the chip, the caption, the ribbon, the ticket and sample positions; an action sends nothing', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const calls = await mockApi(page);
  await page.goto('/preview/futures');
  await expect(page.locator('.if-preview__title')).toHaveText('Futures');
  await expect(page.locator('.if-preview__head [data-slot="preview-chip"]')).toHaveText('Preview');
  await expect(page.locator('[data-slot="preview-caption"]')).toHaveText('Preview: sample numbers, not your account');

  // Ribbon: mark, index and funding with its countdown.
  const ribbon = page.getByRole('region', { name: 'Contract summary' });
  await expect(ribbon).toContainText('Mark');
  await expect(ribbon).toContainText('$64,250.0');
  await expect(ribbon).toContainText('Index');
  await expect(ribbon).toContainText('Funding rate');
  await expect(ribbon).toContainText('+0.0100%');
  await expect(ribbon).toContainText('03:20:00');
  await expect(page.getByTestId('fx-funding-note')).toContainText('longs pay people holding shorts');

  // Sample positions with liquidation price, margin and unrealised profit.
  const positions = page.getByTestId('fx-positions');
  await expect(positions).toContainText('BTC-USDT');
  await expect(positions).toContainText('Liquidation price (estimate)');
  await expect(positions).toContainText('+$267.50');
  await expect(positions).toContainText('−$171.20');
  await expect(page.getByText('Sample rows')).toBeVisible();
  await page.screenshot({ path: join(shots, 'futures-loaded-1440.png'), fullPage: true });

  // Leverage and margin mode change the estimate.
  const before = await page.getByTestId('fx-liq-long').textContent();
  await page.getByRole('slider', { name: 'Leverage' }).fill('20');
  await expect(page.getByTestId('fx-leverage')).toHaveText('20x');
  await expect(page.getByTestId('fx-liq-long')).not.toHaveText(before ?? '');
  await page.getByRole('button', { name: 'Cross' }).first().click();
  await expect(page.getByTestId('fx-mode-note')).toContainText('share your whole futures balance');

  // Take profit and stop loss open their fields and work out the sample result.
  await page.getByRole('checkbox', { name: 'Take profit and stop loss' }).click();
  await expect(page.getByTestId('fx-tpsl')).toBeVisible();
  await page.getByRole('textbox', { name: 'Take profit' }).fill('66000');
  await page.getByRole('textbox', { name: 'Stop loss' }).fill('63000');
  await expect(page.getByTestId('fx-tpsl')).toContainText('Profit at take profit, if long');
  await page.screenshot({ path: join(shots, 'futures-ticket-1440.png') });

  // Other contract and other tabs.
  await page.getByRole('button', { name: 'ETH', exact: true }).click();
  await expect(page.getByTestId('fx-last')).toContainText('$2,318.61');
  await page.getByRole('tab', { name: /Open orders/ }).click();
  await expect(page.getByRole('table', { name: 'Sample open orders' })).toBeVisible();
  await page.getByRole('tab', { name: 'Funding history' }).click();
  await expect(page.getByRole('table', { name: 'Sample funding payments' })).toBeVisible();

  // Every action opens the shared sheet and sends nothing.
  await page.waitForTimeout(500);
  const sent = calls.length;
  await page.getByRole('button', { name: 'Buy / Long' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('heading', { name: 'Preview: nothing was sent' })).toBeVisible();
  await expect(sheet).toContainText('Futures is not live yet. Nothing was sent, and nothing on your account changed.');
  await page.screenshot({ path: join(shots, 'futures-sheet-1440.png') });
  await page.waitForTimeout(400);
  expect(calls.length, 'the action must not call the API').toBe(sent);
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('Futures keeps the risk wording sober and on screen', async ({ page }) => {
  await mockApi(page);
  await page.goto('/preview/futures');
  await expect(page.getByRole('heading', { name: 'Read this before futures open' })).toBeVisible();
  const body = await page.locator('.fx-risk').innerText();
  expect(body).toContain('closed by force');
  expect(body).toContain('not open yet');
  expect(body).not.toMatch(/guarantee|risk-free|moon|profit every/i);
  // The Close tab names the position and offers the matching buttons.
  await page.getByRole('button', { name: 'Close', exact: true }).first().click();
  await expect(page.getByTestId('fx-close-size')).toContainText('0.250 BTC Long');
  await expect(page.getByRole('button', { name: 'Close long' })).toBeVisible();
});
