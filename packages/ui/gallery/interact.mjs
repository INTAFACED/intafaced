/**
 * Real-browser checks of what server-rendered unit tests cannot see: header sorting, keyboard row
 * navigation, jumping inside a virtualised list, and decimal typing that must never lose a digit.
 * Needs the gallery running (see shots.mjs). Exit code 1 if any check fails.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const base = process.env.GALLERY_URL ?? 'http://127.0.0.1:3290/';
const shell = join(
  homedir(),
  'Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell',
);
const browser = await chromium.launch({ executablePath: existsSync(shell) ? shell : undefined });
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
};

const open = async (section) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto(`${base}?only=${section}`, { waitUntil: 'networkidle' });
  return page;
};

// Table
{
  const page = await open('table');
  const first = page.getByRole('grid', { name: 'Markets, comfortable' });
  const names = async () => first.locator('tbody tr td:first-child').allTextContents();
  const before = await names();
  await first.getByRole('button', { name: 'Last price' }).click();
  const sortAttr = await first.getByRole('columnheader', { name: /Last price/ }).getAttribute('aria-sort');
  const after = await names();
  check('table: clicking a header flips aria-sort', sortAttr === 'ascending', sortAttr ?? 'null');
  check('table: sort reorders rows, unknown price last', before.join() !== after.join() && after.at(-1) === 'EEE/USDT', after.join(' '));
  check('table: 18-decimal neighbours ordered (…001 before …002)', after.indexOf('BBB/USDT') < after.indexOf('FFF/USDT'));

  // keyboard on the dense multi-select table
  const dense = page.getByRole('grid', { name: 'Open orders, dense' });
  const rows = dense.locator('tbody tr[data-slot="table-row"]');
  await rows.nth(0).focus();
  await page.keyboard.press('ArrowDown');
  const focusedIndex = await page.evaluate(() => document.activeElement?.getAttribute('data-row-index'));
  check('table: ArrowDown moves focus to the next row', focusedIndex === '1', `index ${focusedIndex}`);
  await page.keyboard.press('Space');
  const sel = await rows.nth(1).getAttribute('aria-selected');
  check('table: Space toggles selection (row 2 started selected, now off)', sel === 'false', String(sel));
  await page.keyboard.press('Enter');
  check('table: Enter opens the row', (await page.getByText(/Last opened: o2/).count()) === 1);
  await page.keyboard.press('End');
  const endIndex = await page.evaluate(() => document.activeElement?.getAttribute('data-row-index'));
  check('table: End focuses the last row', endIndex === '3', `index ${endIndex}`);

  // virtualised list
  const big = page.getByRole('grid', { name: 'Ten thousand rows' });
  const rendered = await big.locator('tbody tr[data-slot="table-row"]').count();
  check('virtual: only a window of 10,000 rows is in the page', rendered > 5 && rendered < 60, `${rendered} rows`);
  await big.locator('tbody tr[data-slot="table-row"]').first().focus();
  await page.keyboard.press('End');
  await page.waitForTimeout(300);
  const bigEnd = await page.evaluate(() => document.activeElement?.getAttribute('data-row-index'));
  check('virtual: End scrolls to and focuses row 10,000', bigEnd === '9999', `index ${bigEnd}`);
  const lastText = await page.evaluate(() => document.activeElement?.textContent ?? '');
  check('virtual: the focused row shows the last record', lastText.includes('Row 10000'), lastText.slice(0, 40));
  await page.context().close();
}

// Decimal input
{
  const page = await open('input');
  const q = page.getByLabel('Quantity, 18 decimals (comfortable)');
  await q.fill('');
  await q.pressSequentially('0.123456789012345678');
  check('input: 18 decimals typed keep every digit', (await q.inputValue()) === '0.123456789012345678', await q.inputValue());
  await q.press('9');
  check('input: the 19th decimal is refused', (await q.inputValue()) === '0.123456789012345678', await q.inputValue());
  await q.fill('');
  await q.pressSequentially('1,234.5');
  check('input: a group separator typed is not accepted into the value', !(await q.inputValue()).includes(','), await q.inputValue());
  const p = page.getByLabel('Price (comfortable)');
  await p.fill('0.1');
  await p.press('ArrowUp');
  check('input: 0.1 stepped by 0.1 is exactly 0.2', (await p.inputValue()) === '0.2', await p.inputValue());
  await p.press('ArrowUp');
  check('input: 0.2 stepped by 0.1 is exactly 0.3', (await p.inputValue()) === '0.3', await p.inputValue());
  await page.context().close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
