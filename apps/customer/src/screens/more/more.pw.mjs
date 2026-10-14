import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const shots = process.env.MORE_SHOTS ?? join(tmpdir(), 'intafaced-more-shots');
mkdirSync(shots, { recursive: true });
const forbidden = /unavailable|not connected|restricted|fixture|lifecycle|\broom\b|\bledger\b|\btier\b/i;

const tiles = [
  ['account', '/uc/account', 'Account', 'Your account ID and details'],
  ['security', '/uc/safe', 'Security', 'Sign-in, devices and API keys'],
  ['verification', '/verification', 'Verification', 'Confirm who you are'],
  ['display', '/view', 'Display and language', 'Language, time zone and how numbers look'],
  ['notifications', '/notifications', 'Notifications', 'Updates about your orders and account'],
  ['help', '/support', 'Help', 'Answers and support'],
];

test('More at 1440x900 and 1280x800: sections, tile sizes, words, no dead links', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  await page.goto('/more');
  await expect(page.locator('.more-title')).toHaveText('More');
  expect(await page.locator('.more-h2').allTextContents()).toEqual(['Account', 'Settings', 'Help']);
  expect(await page.locator('.more-tile').count()).toBe(tiles.length);

  for (const [id, href, title, line] of tiles) {
    const tile = page.locator(`[data-tile="${id}"]`);
    await expect(tile).toHaveAttribute('href', href);
    await expect(tile.locator('.more-tile__title')).toHaveText(title);
    await expect(tile.locator('.more-tile__line')).toHaveText(line);
  }
  expect(await page.locator('.more-tile').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')))).not.toContain('#');

  for (const size of [
    { width: 1440, height: 900 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(size);
    await page.waitForTimeout(120);
    // Spec: 3 columns of 392 x 88 tiles in a 1224 container; icon 24 in a 40 circle.
    const first = await page.locator('.more-tile').first().boundingBox();
    expect(Math.round(first.width)).toBe(392);
    expect(Math.round(first.height)).toBe(88);
    const icon = await page.locator('.more-tile__icon').first().boundingBox();
    expect([Math.round(icon.width), Math.round(icon.height)]).toEqual([40, 40]);
    expect(
      await page
        .locator('.more-tile__icon svg')
        .first()
        .evaluate((node) => node.getAttribute('width')),
    ).toBe('24');
    const row = await page
      .locator('.more-tile')
      .evaluateAll((nodes) => nodes.slice(0, 3).map((node) => Math.round(node.getBoundingClientRect().top)));
    expect(new Set(row).size).toBe(1); // the first three tiles share one row
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: join(shots, `more-loaded-${size.width}.png`) });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: join(shots, 'more-loaded-390.png') });
  await page.setViewportSize({ width: 1440, height: 900 });

  expect(await page.locator('main').innerText()).not.toMatch(forbidden);
  expect(errors).toEqual([]);
});

test('every tile opens its screen (click each)', async ({ page }) => {
  for (const [id, href] of tiles) {
    await page.goto('/more');
    await page.locator(`[data-tile="${id}"]`).click();
    await expect(page.getByTestId('standin')).toHaveText(`Stand-in page ${href}`);
    expect(new URL(page.url()).pathname).toBe(href);
  }
});

test('keyboard: Tab moves through the tiles in order with a visible outline, Enter opens', async ({ page }) => {
  await page.goto('/more');
  await page.locator('.harness-bar a[aria-current="page"]').focus();
  for (const [id] of tiles) {
    await page.keyboard.press('Tab');
    await expect(page.locator(`[data-tile="${id}"]`)).toBeFocused();
  }
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('[data-tile="security"]')).toBeFocused();
  expect(await page.locator('[data-tile="security"]').evaluate((node) => getComputedStyle(node).outlineStyle)).toBe('solid');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('standin')).toHaveText('Stand-in page /uc/safe');
});
