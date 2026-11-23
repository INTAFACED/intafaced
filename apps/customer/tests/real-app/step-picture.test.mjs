import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromTop } from './step-picture.mjs';

// The step picture's readying (journey.mjs stepPicture) on planted pages in a real Chromium: a page left scrolled down
// gets a whole-page picture with its bar at the top (J-agents-21 #11 read BROKEN for the bar drawn over the content), a
// focused skip link is hidden, and an open menu or a focused field keeps the state the step ends on. It needs a Chromium:
// Playwright's own, or the machine's Chrome; with neither it says so and skips.
let browser = null;
let why = '';
beforeAll(async () => {
  try {
    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
  } catch (error) {
    why = String(error?.message ?? error).split('\n')[0];
  }
});
afterAll(() => browser?.close());

const BAR = [255, 0, 0];
const PAGE = `
  <style>#skip{position:absolute;left:-9999px}#skip:focus{left:0;top:0;z-index:2;background:#00f;color:#00f}</style>
  <a href="#main" id="skip">Skip to content</a>
  <header style="position:sticky;top:0;height:40px;background:rgb(255,0,0)">bar</header>
  <main id="main" style="height:3000px;background:rgb(255,255,255)">
    <div style="height:1540px"></div><button id="open">Menu</button><input id="field" aria-label="Field">
  </main>`;

async function pageOf(extra = '') {
  const context = await browser.newContext({ viewport: { width: 400, height: 600 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html lang="en"><body style="margin:0">${PAGE}${extra}</body></html>`);
  return { page, close: () => context.close() };
}

/** The colour at (x, y) of a whole-page picture, read by drawing the picture on a canvas in a page of its own. */
async function pixel(page, x, y) {
  const png = (await page.screenshot({ fullPage: true })).toString('base64');
  const reader = await page.context().newPage();
  try {
    return await reader.evaluate(
      async ([src, px, py]) => {
        const img = new Image();
        img.src = `data:image/png;base64,${src}`;
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const g = canvas.getContext('2d');
        g.drawImage(img, 0, 0);
        return Array.from(g.getImageData(px, py, 1, 1).data.subarray(0, 3));
      },
      [png, x, y],
    );
  } finally {
    await reader.close();
  }
}

describe('step picture from the top', () => {
  it('a page left scrolled down gets its bar at the top of the picture, not over the content', async (t) => {
    if (!browser) return t.skip(`no Chromium to drive: ${why}`);
    const { page, close } = await pageOf();
    await page.evaluate(() => window.scrollTo(0, 1500));
    // The fault, as the picture stood before: the bar drawn at the scroll height, over the content.
    expect(await pixel(page, 200, 1510)).toEqual(BAR);
    expect(await fromTop(page)).toBe('scrolled');
    expect(await pixel(page, 200, 10)).toEqual(BAR);
    expect(await pixel(page, 200, 1510)).toEqual([255, 255, 255]);
    await close();
  });

  it('a focused skip link is not drawn over the page', async (t) => {
    if (!browser) return t.skip(`no Chromium to drive: ${why}`);
    const { page, close } = await pageOf();
    await page.focus('#skip');
    expect(await pixel(page, 5, 5)).toEqual([0, 0, 255]);
    expect(await fromTop(page)).toBe('at top');
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    expect(await pixel(page, 5, 5)).toEqual(BAR);
    await close();
  });

  it('an open menu keeps the page as the step left it: not scrolled, still focused', async (t) => {
    if (!browser) return t.skip(`no Chromium to drive: ${why}`);
    const { page, close } = await pageOf('<ul role="menu" style="position:absolute;top:1520px"><li role="menuitem">One</li></ul>');
    await page.evaluate(() => window.scrollTo(0, 1500));
    await page.focus('#open');
    expect(await fromTop(page)).toBe('kept: something open');
    expect(await page.evaluate(() => [window.scrollY, document.activeElement.id])).toEqual([1500, 'open']);
    await close();
  });

  it('a focused field stays focused while the page goes to the top', async (t) => {
    if (!browser) return t.skip(`no Chromium to drive: ${why}`);
    const { page, close } = await pageOf();
    await page.evaluate(() => window.scrollTo(0, 1500));
    await page.focus('#field');
    expect(await fromTop(page)).toBe('scrolled');
    expect(await page.evaluate(() => [window.scrollY, document.activeElement.id])).toEqual([0, 'field']);
    await close();
  });

  it('a page held by a browser dialog is left as it stands after the bound, and readying never throws', async (t) => {
    if (!browser) return t.skip(`no Chromium to drive: ${why}`);
    const { page, close } = await pageOf();
    page.on('dialog', () => {}); // a listener that leaves the dialog open, as a test that waits on one does
    await page.evaluate(() => window.scrollTo(0, 1500));
    void page.evaluate(() => alert('held')).catch(() => {});
    expect(await fromTop(page, 300)).toBe('not readied');
    await close();
    expect(await fromTop(page)).toBe('not readied');
  });
});
