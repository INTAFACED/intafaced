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

const open = async (section, viewport = { width: 1440, height: 900 }, waitUntil = 'networkidle') => {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto(`${base}?only=${section}`, { waitUntil });
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
  // mouse-wheel scroll must keep the window filled (the virtualiser subscribes to the scroll element)
  await big.hover();
  await page.mouse.wheel(0, 6000);
  await page.waitForTimeout(400);
  const afterWheel = await big.locator('tbody tr[data-slot="table-row"]').count();
  const firstShown = await big.locator('tbody tr[data-slot="table-row"] td:first-child').first().textContent();
  check(
    'virtual: wheel scroll keeps rows on screen and moves the window',
    afterWheel > 5 && firstShown !== 'Row 1',
    `${afterWheel} rows, first ${firstShown}`,
  );

  // one Tab stop per row: the row checkboxes are not tab stops
  const dense2 = page.getByRole('grid', { name: 'Open orders, dense' });
  const stops = await dense2.evaluate(
    (el) => [...el.querySelectorAll('[tabindex]')].filter((n) => n.getAttribute('tabindex') === '0').length,
  );
  check(
    'table: multiple selection has one tabbable row, not one per checkbox',
    stops <= 2,
    `${stops} tab stops with tabindex=0 (header box + one row)`,
  );
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
  check(
    'input: a comma typed on a "." keyboard is refused, never read as a decimal point',
    (await q.inputValue()) === '1234.5',
    await q.inputValue(),
  );
  const p = page.getByLabel('Price (comfortable)');
  await p.fill('0.1');
  await p.press('ArrowUp');
  check('input: 0.1 stepped by 0.1 is exactly 0.2', (await p.inputValue()) === '0.2', await p.inputValue());
  await p.press('ArrowUp');
  check('input: 0.2 stepped by 0.1 is exactly 0.3', (await p.inputValue()) === '0.3', await p.inputValue());
  await page.context().close();
}

// Freshness: a chip given no `now` keeps its own clock and must turn Stale when its window passes
{
  const page = await open('figures', undefined, 'domcontentloaded');
  const chip = page.getByTestId('ticking-chip');
  await chip.waitFor();
  const before = await chip.getAttribute('data-freshness');
  await page.waitForTimeout(3000);
  const after = await chip.getAttribute('data-freshness');
  const word = (await chip.locator('[data-part="word"]').textContent()) ?? '';
  check(
    'freshness: a chip with no `now` turns Stale after its window',
    before === 'live' && after === 'stale' && word === 'Stale',
    `before ${before}, after 3 s ${after}, word ${word}`,
  );
  await page.context().close();
}

// Narrow screen (390 x 844): the pinned column and the wrapping page actions
const phone = { width: 390, height: 844 };
{
  const page = await open('table', phone);
  const grid = page.getByRole('grid', { name: 'Markets, comfortable' });
  const region = grid.locator('xpath=ancestor::*[@data-slot="table-scroll"]');
  const overflow = await region.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  check(
    'narrow table: the Markets table is wider than its region, so it scrolls sideways',
    overflow.scroll > overflow.client,
    `${overflow.scroll} > ${overflow.client}`,
  );
  await region.evaluate((el) => {
    el.scrollLeft = el.scrollWidth - el.clientWidth;
  });
  const scrolled = await region.evaluate((el) => ({ left: el.scrollLeft, max: el.scrollWidth - el.clientWidth }));
  check(
    'narrow table: the region scrolled all the way right',
    scrolled.left > 0 && Math.abs(scrolled.left - scrolled.max) <= 1,
    `${scrolled.left} of ${scrolled.max}`,
  );
  const boxes = await page.evaluate(() => {
    const table = [...document.querySelectorAll('table')].find((t) => t.querySelector('caption')?.textContent === 'Markets, comfortable');
    const r = (el) => {
      const b = el.getBoundingClientRect();
      return { left: b.left, right: b.right };
    };
    const scroller = table.closest('[data-slot="table-scroll"]');
    const row = table.querySelector('tbody tr');
    const cells = [...row.children];
    const heads = [...table.querySelectorAll('thead th')];
    return {
      region: r(scroller),
      firstCell: r(cells[0]),
      firstHead: r(heads[0]),
      lastCell: r(cells.at(-1)),
      lastText: cells.at(-1).textContent,
    };
  });
  const near = (a, b) => Math.abs(a - b) <= 1;
  check(
    "narrow table: the pinned first column cell stays at the region's left edge after scrolling right",
    near(boxes.firstCell.left, boxes.region.left),
    `cell ${boxes.firstCell.left}, region ${boxes.region.left}`,
  );
  check(
    'narrow table: the pinned header cell stays at the left edge too',
    near(boxes.firstHead.left, boxes.region.left),
    `${boxes.firstHead.left}`,
  );
  check(
    'narrow table: the last column is now visible',
    boxes.lastCell.right <= boxes.region.right + 1 && boxes.lastCell.left >= boxes.region.left,
    `last cell ${boxes.lastCell.left}..${boxes.lastCell.right}, region right ${boxes.region.right}, text ${boxes.lastText}`,
  );
  await page.context().close();
}
{
  const page = await open('page', phone);
  const headers = page.locator('[data-slot="page-header"]').filter({ has: page.locator('[data-slot="page-header-actions"]') });
  const count = await headers.count();
  let ok = true;
  const detail = [];
  let checked = 0;
  for (let i = 0; i < count; i++) {
    const h = headers.nth(i);
    // The "width" previews are 1440 px pages shrunk by a transform: their layout width is 1440, so they are not phone headers.
    if ((await h.evaluate((el) => el.offsetWidth)) > 390) continue;
    checked++;
    const title = await h.locator('[data-slot="page-header-title"]').first().boundingBox();
    const actions = await h.locator('[data-slot="page-header-actions"]').boundingBox();
    const fine = title && actions && actions.y >= title.y + title.height - 0.5;
    detail.push(
      `#${i} title bottom ${title ? Math.round(title.y + title.height) : '?'} actions top ${actions ? Math.round(actions.y) : '?'}`,
    );
    if (!fine) ok = false;
  }
  check("narrow page: a PageHeader's actions sit below its title at 390", ok && checked >= 2, `${checked} headers: ${detail.join('; ')}`);
  await page.context().close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
