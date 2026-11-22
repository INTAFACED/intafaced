// The look gate's in-page checks on planted pages: each check still catches its fault on text and controls a person
// sees, and none judges what the browser never draws (a closed <details>, display: none; #9596's false red).
// Run: node --test tooling/ci/look-gate/look-gate.test.mjs (also by the tooling-tests gate). It needs a Chromium:
// Playwright's own, or the machine's Chrome (GitHub's runners have one); with neither it says so and skips.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePng } from './png.mjs';
import { CLIPPED_COPY, GENERATED_ID, HIDE_TEXT_CSS, contrastFindings, focusState, fontFindings, measure } from './look-gate.mjs';

let browser = null;
let why = '';
try {
  const { chromium } = await import('@playwright/test');
  browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
} catch (error) {
  why = String(error?.message ?? error).split('\n')[0];
}
const skip = browser ? false : `no Chromium to drive: ${why}`;
test.after(() => browser?.close());

async function pageOf(html, viewport = { width: 400, height: 400 }) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html lang="en"><body style="margin:0;background:#fff">${html}</body></html>`);
  return { page, close: () => context.close() };
}

/**
 * check()'s contrast pass: the whole page in one viewport (as check() sizes it), measure, then the shot with all text
 * hidden, then the worst pixel under each text box.
 */
async function contrastOn(html, viewport) {
  const { page, close } = await pageOf(html, viewport);
  try {
    const { width, height } = page.viewportSize();
    const full = await page.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
    if (full > height) await page.setViewportSize({ width, height: full });
    const m = await page.evaluate(measure, { maxText: 400 });
    const hide = await page.addStyleTag({ content: HIDE_TEXT_CSS });
    const blank = decodePng(await page.screenshot({ animations: 'disabled', caret: 'hide' }));
    await hide.evaluate((el) => el.remove());
    return contrastFindings(m.texts, blank).map((f) => f.split(' (')[0]);
  } finally {
    await close();
  }
}

const measured = async (html) => {
  const { page, close } = await pageOf(html);
  try {
    return await page.evaluate(measure, { maxText: 400 });
  } finally {
    await close();
  }
};

// #999 on white is 2.84:1, under the 4.5 body text needs.
const GREY = '<p class="faint" style="color:#999;font-size:13px">Rail connection details</p>';
const FAINT = ['p.faint "Rail connection details" 2.84 < 4.5'];

test('contrast: low-contrast text a person sees fails, wherever it is on the page', { skip }, async () => {
  assert.deepEqual(await contrastOn(GREY), FAINT, 'in plain view');
  assert.deepEqual(
    await contrastOn(`<details open><summary style="color:#000">More</summary>${GREY}</details>`),
    FAINT,
    'in an open <details>',
  );
  assert.deepEqual(await contrastOn(`<div style="height:1500px"></div>${GREY}`), FAINT, 'below the first screen');
  assert.deepEqual(
    await contrastOn(
      `<div style="height:1500px"></div><div style="content-visibility:auto;contain-intrinsic-size:auto 40px">${GREY}</div>`,
    ),
    FAINT,
    'below the first screen under content-visibility: auto, which only defers painting',
  );
  assert.deepEqual(
    await contrastOn(`${GREY}<nav style="position:fixed;inset:0 0 auto 0;height:60px;background:#fff;color:#000">Bar</nav>`),
    FAINT,
    'under a fixed bar',
  );
  assert.deepEqual(await contrastOn(`<div inert>${GREY}</div>`), FAINT, 'inert content is still drawn');
});

test('contrast: text the browser never draws is not judged (#9596)', { skip }, async () => {
  for (const [html, where] of [
    [`<details><summary style="color:#000">Rail connection details</summary>${GREY}</details>`, 'a closed <details>'],
    [`<div style="display:none">${GREY}</div>`, 'display: none'],
    [`<div hidden>${GREY}</div>`, 'the hidden attribute'],
    [`<div hidden="until-found">${GREY}</div>`, 'hidden="until-found"'],
    [`<div style="visibility:hidden">${GREY}</div>`, 'visibility: hidden'],
    [`<div style="opacity:0">${GREY}</div>`, 'an ancestor at opacity 0'],
    [`<div aria-hidden="true" style="height:0;overflow:hidden">${GREY}</div>`, 'aria-hidden with no box'],
  ])
    assert.deepEqual(await contrastOn(html), [], `inside ${where}`);
  // The visible summary of a closed section is still judged.
  assert.deepEqual(
    await contrastOn(
      `<details><summary class="faint" style="color:#999;font-size:13px">Rail connection details</summary>${GREY}</details>`,
    ),
    ['summary.faint "Rail connection details" 2.84 < 4.5'],
    'the summary of a closed <details>',
  );
});

test('money: a figure on a see-through panel fails; one in a closed section is not judged', { skip }, async () => {
  const money = '<div style="background:rgba(0,0,0,0.4)"><span data-slot="money">1,000.00 USDT</span></div>';
  assert.equal((await measured(money)).money.length, 1, 'in plain view');
  assert.deepEqual((await measured(`<details><summary>More</summary>${money}</details>`)).money, [], 'in a closed <details>');
});

test('targets: small crowded controls fail; the same in a closed section are no targets', { skip }, async () => {
  const pair =
    '<button style="display:block;width:20px;height:16px;padding:0">+</button><button style="display:block;width:20px;height:16px;padding:0">-</button>';
  assert.equal((await measured(`<div style="margin:40px">${pair}</div>`)).small.length, 2, 'in plain view');
  assert.equal((await measured(`<div style="margin:40px" inert>${pair}</div>`)).small.length, 2, 'inert, outside the gallery marker');
  assert.deepEqual(
    (await measured(`<div style="margin:40px" inert data-look-gate-picture>${pair}</div>`)).small,
    [],
    'the gallery picture',
  );
  assert.deepEqual((await measured(`<details><summary>More</summary>${pair}</details>`)).small, [], 'in a closed <details>');
});

test('copy at 130%: a row that cuts its label fails; the same in a closed section is not judged', { skip }, async () => {
  const row =
    '<div class="row" style="width:120px;overflow:hidden"><span class="label" data-look-gate-copy style="display:block;width:max-content">A long pseudo label that runs on</span></div>';
  const cut = async (html) => {
    const { page, close } = await pageOf(html);
    try {
      return await page.evaluate(CLIPPED_COPY, GENERATED_ID);
    } finally {
      await close();
    }
  };
  assert.deepEqual(await cut(row), [['span.label', 'is cut by div.row']], 'in plain view');
  assert.deepEqual(await cut(`<details open><summary>More</summary>${row}</details>`), [['span.label', 'is cut by div.row']], 'open');
  assert.deepEqual(await cut(`<details><summary>More</summary>${row}</details>`), [], 'in a closed <details>');
  assert.deepEqual(await cut(`<div style="display:none">${row}</div>`), [], 'under display: none');
});

test('focus: a control a fixed bar paints over fails; one clear of it passes', { skip }, async () => {
  const bar = '<nav data-obscures="bottom" style="position:fixed;inset:auto 0 0 0;height:80px;background:#000"></nav>';
  const at = async (top) => {
    const { page, close } = await pageOf(`<button id="go" style="position:absolute;top:${top}px;left:20px">Go</button>${bar}`);
    try {
      await page.focus('#go');
      return (await page.evaluate(focusState, GENERATED_ID)).covered;
    } finally {
      await close();
    }
  };
  assert.equal(await at(350), true, 'under the bottom bar');
  assert.equal(await at(100), false, 'clear of the bar');
});

test('font: text whose first family is no loaded web font fails; the same in a closed section is not judged', { skip }, async () => {
  const text = '<p style="font-family:NoSuchWebFont,sans-serif">Drawn in a fallback</p>';
  const fonts = async (html) => {
    const { page, close } = await pageOf(html);
    try {
      return await fontFindings(page, await page.evaluate(measure, { maxText: 400 }));
    } finally {
      await close();
    }
  };
  const found = await fonts(text);
  assert.equal(found.length, 1, 'in plain view');
  assert.match(found[0], /^p "Drawn in a fallback": first family "NoSuchWebFont" is not a web font/);
  assert.deepEqual(await fonts(`<details><summary></summary>${text}</details>`), [], 'in a closed <details>');
});
