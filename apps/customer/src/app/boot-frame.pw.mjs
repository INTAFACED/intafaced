// Home's boot frame draws each block where Home's loading state draws it, so the hand-over from frame to app moves
// nothing. For each width, in Volt (the only look), the frame is measured alone (the app's entry is held, so it never runs) and Home is
// measured with every answer held (a return visit: the Get started list was closed last time), and every block's box
// must match within TOLERANCE. Section heads and the label row are text-wide in Home, so only their top and height count.
import { expect, test } from '@playwright/test';
import { trpc } from '../screens/home/home.fixtures.mjs';

const TOLERANCE = 4;
const USER = '11111111-1111-4111-8111-111111111111';

/** [name, frame selector under #boot-frame, Home selector under #root, every match] */
const BLOCKS = [
  ['top bar', '.bf-top', 'header.tb'],
  ['hero', '.hm-hero', '.hm-hero'],
  ['label', '.bf-label', '[data-testid="home-label"]'],
  ['figure', '.bf-total > *', '[data-testid="home-total"] > *'],
  ['figure bar', '.bf-total .lt-ghost-item', '[data-testid="home-total"] .lt-ghost-item'],
  ['change', '.bf-change > *', '[data-testid="home-change"] > *'],
  ['ranges', '.bf-ranges', '.hm-hero .lt-tabs'],
  ['chart', '.hm-chart', '.hm-chart'],
  ['keys tray', '.bf-keys', '[data-testid="home-actions"]'],
  ['key', '.bf-keys .lt-ghost-item', '[data-testid="home-actions"] .lt-ghost-item', true],
  ['markets head', '.bf-markets-head', '.lt-panel-title:has(#home-markets-title)'],
  // the side panels that have a loading state (Learn has none: its words are there at once, and the frame draws no words)
  ['side card', '.bf-side > .lit-surface', '[data-testid="home-side"] > .lit-surface:has(.lt-ghost)', true],
  ['side head', '.bf-side-head', '[data-testid="home-side"] > .lit-surface:has(.lt-ghost) h2', true],
  ['side bar', '.bf-side .lt-ghost-item', '[data-testid="home-side"] .lt-ghost-item', true],
];

async function boxes(browser, { width, height, frame }) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, isMobile: width < 600 });
  const page = await context.newPage();
  await page.addInitScript(
    ([user]) => {
      localStorage.setItem('intafaced.customer.view.v1', JSON.stringify({ layoutMode: 'simple' }));
      localStorage.setItem(`intafaced.customer.home.started.open.v1:${user}`, 'closed');
    },
    [USER],
  );
  // the session answers; every other answer is held, so Home stays in its loading state
  await page.route('**/api/**', async (route) => {
    if (route.request().url().includes('auth.refresh'))
      return route.fulfill({ status: 200, json: trpc({ accessToken: 'test-token', expiresAt: '2030-01-01T00:00:00.000Z', userId: USER }) });
  });
  if (frame) {
    await page.route(/\/assets\/index-[^/]+\.js$/, () => {});
    await page.goto('/home', { waitUntil: 'commit' });
    await expect(page.locator('#boot-frame')).toBeVisible();
    // the frame draws with the entry stylesheet's tokens; the browser holds paint for it, a measurement does not
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--if-space-4').trim() !== '');
  } else {
    await page.goto('/home');
    await expect(page.getByTestId('home-total')).toBeVisible();
    await expect(page.getByTestId('home-work__rows')).toBeVisible();
    // Home's text swaps to Inter when it arrives (font-display: swap), and at 390 the label row wraps to its settled
    // height only in Inter; measured on the fallback face the row is 18 px shorter (#7896)
    await page.evaluate(() => document.fonts.load('400 1rem Inter'));
  }
  const found = await page.evaluate(
    ([blocks, frame]) =>
      blocks.map(([, f, h, all]) => {
        const selector = frame ? `#boot-frame ${f}` : `#root ${h}`;
        const els = all ? [...document.querySelectorAll(selector)] : [document.querySelector(selector)].filter(Boolean);
        return els
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.height > 0)
          .map((r) => [r.x, r.y, r.width, r.height].map(Math.round));
      }),
    [BLOCKS, frame],
  );
  await context.close();
  return found;
}

for (const [width, height] of [
  [390, 844],
  [1440, 900],
]) {
  test(`at ${width}, the frame's blocks sit on Home's loading boxes`, async ({ browser }) => {
    const frame = await boxes(browser, { width, height, frame: true });
    const home = await boxes(browser, { width, height, frame: false });
    const off = [];
    BLOCKS.forEach(([name], i) => {
      const count = Math.max(frame[i].length, home[i].length);
      for (let k = 0; k < count; k++) {
        const a = frame[i][k];
        const b = home[i][k];
        if (!a && b && b[1] >= height) continue; // below the fold, where the frame draws nothing
        const sides = /head|label/.test(name) ? [1, 3] : [0, 1, 2, 3];
        if (!a || !b || sides.some((j) => Math.abs(a[j] - b[j]) > TOLERANCE))
          off.push(`${name} ${k}: frame ${a?.join(',') ?? 'missing'}, Home ${b?.join(',') ?? 'missing'}`);
      }
    });
    expect(off).toEqual([]);
  });
}
