// The look gate's in-page checks on planted pages: each check still catches its fault on text and controls a person
// sees, and none judges what the browser never draws (a closed <details>, display: none; #9596's false red).
// Run: node --test tooling/ci/look-gate/look-gate.test.mjs (also by the tooling-tests gate). It needs a Chromium:
// Playwright's own, or the machine's Chrome (GitHub's runners have one); with neither it says so and skips.
import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { decodePng } from './png.mjs';
import * as gate from './look-gate.mjs';
import { CLIPPED_COPY, GENERATED_ID, HIDE_TEXT_CSS, contrastFindings, fitToPage, focusState, fontFindings, measure } from './look-gate.mjs';

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

/** The gate's sizing before 23 Nov: one resize to the height read first. */
async function oneResize(page) {
  const { width, height } = page.viewportSize();
  const full = await page.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
  if (full > height) await page.setViewportSize({ width, height: full });
}

/**
 * check()'s contrast pass: the whole page in one viewport (fitToPage, as check() sizes it), measure, then the shot with
 * all text hidden, then the worst pixel under each text box.
 */
async function contrastOn(html, viewport, fit = fitToPage) {
  const { page, close } = await pageOf(html, viewport);
  try {
    await fit(page);
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

test('contrast: a fixed dock is not measured as the background of text it covers only once vh content grows', { skip }, async () => {
  // /trade/spot's "Market" and /charts' note (22 Nov): a block sized in vh (capped, as the app's clamps are) grows when
  // the viewport is set to the page's height, the page grows past it, and the dock lands on text the bottom padding
  // (wider than the dock) keeps clear at any one height. Read again until the height holds, the dock is back over the
  // padding.
  const room = (extra = '') => `<div style="background:#111;color:#ddd;padding-bottom:112px">
    <div style="height:308px"></div>${extra}<div style="height:min(40vh,280px)"></div>
    <p class="row" style="margin:0;font-size:16px;line-height:20px">Market</p></div>
    <nav style="position:fixed;inset:auto 0 0 0;height:80px;background:#d0d0d0"></nav>`;
  const dock = await contrastOn(room(), undefined, oneResize);
  assert.equal(dock.length, 1, 'one resize: the planted page does put the dock under "Market"');
  assert.match(dock[0], /^p\.row "Market" 1\.\d\d < 4\.5$/);
  assert.deepEqual(await contrastOn(room()), [], 'height read until it holds: "Market" on its own panel');
  // Real low contrast on the same growing page is still caught.
  assert.deepEqual(
    await contrastOn(room('<p class="faint" style="margin:0;color:#444;font-size:13px">Rail connection details</p>')),
    ['p.faint "Rail connection details" 1.93 < 4.5'],
    'dim text on the growing page',
  );
  // The settled height: the page fits its viewport, the dock back over the padding.
  const { page, close } = await pageOf(room());
  try {
    assert.deepEqual(await fitToPage(page), { settled: true, fits: true });
    assert.deepEqual(
      await page.evaluate(() => [innerHeight, document.documentElement.scrollHeight]),
      [720, 720],
      'the page is 308 + 280 + 20 + 112 px tall at its settled height',
    );
  } finally {
    await close();
  }
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
  // A screen-reader-only box around the text (the kit's .lt-sr, holding a chart's data table): nobody sees it cut.
  const sr = (style) =>
    `<div class="lt-sr" style="position:absolute;width:1px;height:1px;overflow:hidden;${style}"><table><caption data-look-gate-copy>A chart's data, for screen readers</caption></table></div>`;
  assert.deepEqual(await cut(sr('clip-path:inset(50%)')), [], 'inside a box clipped to nothing');
  assert.deepEqual(await cut(sr('')), [], 'inside a 1 px box that cuts what it holds');
  assert.deepEqual(
    await cut(`<div style="position:relative">${row}</div>`),
    [['span.label', 'is cut by div.row']],
    'a visible box around still cuts',
  );
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

test('loading: the gate waits out the app\'s "Opening room…" panel, not only a lazy room\'s loading line', { skip }, async () => {
  // The panel the app draws while the session restores or a room's code loads (#11271: /reg shot as it, under a
  // signed-in bar). Its root's classes are read from the component, so a rename there fails here, not in a shot.
  const source = readFileSync(new URL('../../../apps/customer/src/app/RoomLoading.tsx', import.meta.url), 'utf8');
  const [, classes] = source.match(/<div className="([^"]+)" role="status">/) ?? [];
  assert.ok(classes, 'RoomLoading.tsx draws its panel as <div className="…" role="status">');
  // The selector the gate waits on before it shoots; before #11271 it was this one, hard-coded in each wait.
  const loading = gate.LOADING ?? '.loading, [aria-busy="true"]';
  const stillLoading = async (html) => {
    const { page, close } = await pageOf(html);
    try {
      return await page.evaluate((s) => !!document.querySelector(s), loading);
    } finally {
      await close();
    }
  };
  assert.equal(
    await stillLoading(`<header>Home</header><div class="${classes}" role="status"><span>Opening room…</span></div>`),
    true,
    'the panel',
  );
  assert.equal(await stillLoading('<p class="loading">Loading…</p>'), true, "a lazy room's loading line");
  assert.equal(await stillLoading('<section aria-busy="true"></section>'), true, 'a busy region');
  assert.equal(await stillLoading('<main><h1>Open your account</h1><form></form></main>'), false, 'a settled room');
});
