// Shared by the Playwright tests of the "house" batch (P2P, Card, IFC, Academy). Test code only.
import { expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const shots = process.env.PREVIEW_SHOTS ?? join(tmpdir(), 'intafaced-house-shots');
mkdirSync(shots, { recursive: true });

/** Every request goes to a mocked API; the test records them so it can prove a Preview screen sends none of its own. */
export async function mockApi(page) {
  const calls = [];
  await page.route('**/api/**', async (route) => {
    calls.push({ method: route.request().method(), url: route.request().url() });
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { message: 'mocked' } }) });
  });
  return calls;
}

export function pageErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

/** The title, the Preview chip and the caption that every Preview screen shows. */
export async function expectFrame(page, title) {
  await expect(page.locator('.if-preview__title')).toHaveText(title);
  await expect(page.locator('.if-preview__head [data-slot="preview-chip"]')).toHaveText('Preview');
  await expect(page.locator('[data-slot="preview-caption"]')).toHaveText('Preview: sample numbers, not your account');
}

/** Click an action, check the "nothing was sent" sheet, prove no request was made, then close it. */
export async function expectSheet(page, calls, button, product, name) {
  await page.waitForTimeout(400);
  const before = calls.length;
  await button.click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('heading', { name: 'Preview: nothing was sent' })).toBeVisible();
  await expect(sheet).toContainText(`${name} is not live yet. Nothing was sent, and nothing on your account changed.`);
  if (product) await expect(page.locator(`[data-preview-product="${product}"]`)).toBeVisible();
  await page.waitForTimeout(400);
  expect(calls.length, 'the action must not call the API').toBe(before);
  return sheet;
}

export async function closeSheet(page, sheet) {
  await sheet.getByRole('button', { name: 'OK' }).click();
  await expect(sheet).toBeHidden();
}

export async function noHorizontalScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
}
