// Living backdrop, proven in the built app (apps/invitation/dist). Run `pnpm --filter @intafaced/invitation build` first.
//   node apps/invitation/test/scene.browser.mjs
// No production writes: the capture call is answered by a local server that always fails (503).
// Everything is read from the component's own data attributes and from the page's WebGL draw calls,
// never from pixels, so it is deterministic under load. Time limits are generous; the one hard timing
// rule (the 800 ms cap) is asserted as "not before ~800 ms, and well before the slow backdrop is ready".
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { applyPlaywrightBrowsersEnv } from '../../../tooling/uiproof/playwright-browsers.mjs';

const front = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(front, '../..');
const { executablePath } = applyPlaywrightBrowsersEnv({ repoRoot: root });
const out = process.env.SCENE_PROOF_OUT || '/tmp/intafaced-invitation-scene-proof';
await mkdir(out, { recursive: true });

const dist = resolve(front, 'dist');
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path.startsWith('/api/')) {
    for await (const _chunk of request); // drain
    response
      .writeHead(503, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: { message: 'ops.crm.storage_unavailable' } }));
    return;
  }
  const file = path.startsWith('/assets/') ? resolve(dist, '.' + path) : resolve(dist, 'index.html');
  if (!file.startsWith(dist + '/')) return response.writeHead(404).end();
  try {
    const type =
      {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.webp': 'image/webp',
        '.woff2': 'font/woff2',
      }[extname(file)] || 'application/octet-stream';
    response.writeHead(200, { 'content-type': type }).end(await readFile(file));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
// A second browser with WebGL switched off, for the "no WebGL" fallback.
let noGlBrowser;

// Instruments every page: counts WebGL draws, records when the page's own signals flip (page-relative ms),
// and lets a test fake the tab being hidden.
const instrument = () => {
  window.__draws = 0;
  window.__t = {};
  window.__resolves = 0;
  if (window.__hidden === undefined) window.__hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hidden });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (window.__hidden ? 'hidden' : 'visible') });
  for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!C) continue;
    const d = C.prototype.drawArrays;
    C.prototype.drawArrays = function (...a) {
      // Only the backdrop's own canvas counts (the hero button has a small shader of its own).
      if (this.canvas?.classList?.contains('lb__canvas')) window.__draws++;
      return d.apply(this, a);
    };
  }
  document.addEventListener(
    'animationstart',
    (e) => {
      if (e.animationName === 'lb-resolve') window.__resolves++;
    },
    true,
  );
  const mark = () => {
    const page = document.querySelector('.outreach-page');
    const lb = document.querySelector('[data-backdrop]');
    if (page?.classList.contains('entry-started') && window.__t.started == null) window.__t.started = performance.now();
    if (lb?.dataset.ready === '1' && window.__t.ready == null) window.__t.ready = performance.now();
  };
  new MutationObserver(mark).observe(document, { subtree: true, attributes: true, childList: true });
};

const draws = (page) => page.evaluate(() => window.__draws);
async function open(browserRef, query = '', options = {}) {
  const context = await browserRef.newContext({
    viewport: options.viewport || { width: 1440, height: 900 },
    reducedMotion: options.reduced ? 'reduce' : 'no-preference',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(instrument);
  if (options.route) await options.route(page);
  await page.goto(origin + '/invest' + query);
  return { context, page, errors };
}
const ready = (page) => page.waitForSelector('[data-backdrop][data-ready="1"]', { timeout: 60000, state: 'attached' });
// The ribbons loop parks one still frame once dim has settled; wait until the draw count stops moving.
async function drawsHaveStopped(page, gap = 700, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const a = await draws(page);
    await page.waitForTimeout(gap);
    if ((await draws(page)) === a) return true;
  }
  return false;
}
const results = [];
const check = async (name, fn) => {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log('ok   ' + name);
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.message || error).slice(0, 600) });
    console.log('FAIL ' + name + '\n     ' + String(error?.message || error).split('\n').join('\n     '));
  }
};

try {
  await check('welcome: ribbons by default, ready, entrance plays exactly once, foreground follows the backdrop', async () => {
    const { context, page, errors } = await open(browser);
    await ready(page);
    const mode = await page.evaluate(() => document.querySelector('[data-backdrop]').dataset.backdrop);
    assert.equal(mode, 'ribbons', 'WebGL is available here, so the default must be the ribbons');
    await page.getByRole('button', { name: 'Begin', exact: true }).waitFor({ state: 'visible', timeout: 30000 });
    await page.waitForFunction(() => document.querySelector('.outreach-page.entry-started'), null, { timeout: 30000 });
    assert.ok((await draws(page)) > 0, 'ribbons draw');
    const t = await page.evaluate(() => window.__t);
    assert.ok(t.started != null && t.ready != null);
    // The foreground never starts before the backdrop is ready unless the 800 ms cap hit first.
    assert.ok(t.started >= Math.min(t.ready, 780) - 50, `foreground started at ${t.started} before ready ${t.ready}`);
    await page.waitForFunction(() => window.__resolves >= 1, null, { timeout: 30000 });
    // Leave the welcome through the app's own flow: the entrance must not replay.
    await page.getByRole('button', { name: 'Begin', exact: true }).click();
    await page.getByLabel('Your name', { exact: true }).waitFor();
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => window.__resolves), 1, 'entrance plays once');
    assert.equal(await page.locator('[data-backdrop]').count(), 1, 'one backdrop for the whole journey');
    assert.deepEqual(errors, []);
    await context.close();
  });

  await check('welcome: ?bg=photo selects the photo variant and it becomes ready', async () => {
    const { context, page, errors } = await open(browser, '?bg=photo');
    await ready(page);
    const state = await page.evaluate(() => ({
      mode: document.querySelector('[data-backdrop]').dataset.backdrop,
      img: !!document.querySelector('.lb__photo img'),
      canvas: !!document.querySelector('.lb__canvas'),
      decoded: document.querySelector('.lb__photo img')?.naturalWidth > 0,
    }));
    assert.deepEqual(state, { mode: 'photo', img: true, canvas: false, decoded: true });
    assert.equal(await draws(page), 0, 'photo variant never touches WebGL');
    // Content stacks above the fixed backdrop.
    await page.getByRole('button', { name: 'Begin', exact: true }).waitFor({ state: 'visible', timeout: 30000 });
    const above = await page.evaluate(() => {
      const top = document.querySelector('#welcome-title').getBoundingClientRect().top;
      return !!document.elementFromPoint(window.innerWidth / 2, top + 10)?.closest('.outreach-welcome');
    });
    assert.ok(above, 'welcome content is above the backdrop');
    assert.deepEqual(errors, []);
    await context.close();
  });

  await check('phone width uses the small photo (below 700px), desktop the large one', async () => {
    const phone = await open(browser, '?bg=photo', { viewport: { width: 390, height: 844 } });
    await ready(phone.page);
    assert.match(await phone.page.evaluate(() => document.querySelector('.lb__photo img').currentSrc), /graphite-fins-phone/);
    await phone.context.close();
    const desktop = await open(browser, '?bg=photo');
    await ready(desktop.page);
    assert.match(await desktop.page.evaluate(() => document.querySelector('.lb__photo img').currentSrc), /graphite-fins-desktop/);
    await desktop.context.close();
  });

  await check('after Begin: dimmed, and the ribbons park (no more draws) while someone answers', async () => {
    const { context, page } = await open(browser);
    await ready(page);
    assert.equal(await page.evaluate(() => document.querySelector('.lb').classList.contains('is-dim')), false, 'welcome is undimmed');
    const before = await draws(page);
    await page.waitForTimeout(600);
    assert.ok((await draws(page)) > before, 'welcome ribbons are drawing');
    await page.getByRole('button', { name: 'Begin', exact: true }).click();
    await page.getByLabel('Your name', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('.lb.is-dim'), null, { timeout: 30000 });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.lb__dim')).opacity === '0.65', null, { timeout: 30000 });
    assert.ok(await drawsHaveStopped(page), 'ribbons park on one still frame once dim has settled');
    const parked = await draws(page);
    await page.getByLabel('Your name', { exact: true }).fill('Typing visitor');
    await page.waitForTimeout(1000);
    assert.equal(await draws(page), parked, 'typing does not wake the ribbons');
    await context.close();
  });

  await check('after Begin, photo variant: dimmed and its drift and sweep animations are paused', async () => {
    const { context, page } = await open(browser, '?bg=photo');
    await ready(page);
    await page.getByRole('button', { name: 'Begin', exact: true }).click();
    await page.getByLabel('Your name', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('.lb.is-dim'), null, { timeout: 30000 });
    const states = await page.evaluate(() => [...document.querySelectorAll('.lb__photo, .lb__sweep i')].map((e) => getComputedStyle(e).animationPlayState));
    assert.deepEqual(states, ['paused', 'paused']);
    await context.close();
  });

  await check('reduced motion, ribbons: one still frame, nothing animates, content settled at once', async () => {
    const { context, page } = await open(browser, '', { reduced: true });
    await ready(page);
    await page.getByRole('button', { name: 'Begin', exact: true }).waitFor({ state: 'visible' });
    assert.ok(await drawsHaveStopped(page, 400, 10), 'no ongoing draws');
    const stopped = await draws(page);
    assert.ok(stopped >= 1 && stopped <= 3, `a still frame (${stopped} draws)`);
    const state = await page.evaluate(() => ({
      reduced: document.querySelector('.lb').classList.contains('is-reduced'),
      entering: !!document.querySelector('.lb__stage.is-entering, .lb__veil.is-entering'),
      reveal: document.querySelector('.outreach-page').classList.contains('entry-reveal'),
      running: document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.target?.closest?.('.lb')).length,
      title: getComputedStyle(document.querySelector('#welcome-title .h1-line')).opacity,
      button: getComputedStyle(document.querySelector('.welcome-action')).opacity,
      stage: getComputedStyle(document.querySelector('.lb__stage')).opacity,
    }));
    assert.deepEqual(state, { reduced: true, entering: false, reveal: false, running: 0, title: '1', button: '1', stage: '1' });
    await context.close();
  });

  await check('reduced motion, photo: still image, no animation, settled', async () => {
    const { context, page } = await open(browser, '?bg=photo', { reduced: true });
    await ready(page);
    await page.getByRole('button', { name: 'Begin', exact: true }).waitFor({ state: 'visible' });
    const state = await page.evaluate(() => ({
      running: document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.target?.closest?.('.lb')).length,
      sweep: getComputedStyle(document.querySelector('.lb__sweep')).display,
      entering: !!document.querySelector('.lb__stage.is-entering'),
      reveal: document.querySelector('.outreach-page').classList.contains('entry-reveal'),
    }));
    assert.deepEqual(state, { running: 0, sweep: 'none', entering: false, reveal: false });
    await context.close();
  });

  await check('hidden tab: the ribbons pause, and resume when the tab is back', async () => {
    const { context, page } = await open(browser, '', { viewport: { width: 1000, height: 700 } });
    await ready(page);
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      window.__hidden = true;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    assert.ok(await drawsHaveStopped(page, 500, 10), 'draws stop while hidden');
    const paused = await draws(page);
    await page.waitForTimeout(800);
    assert.equal(await draws(page), paused);
    await page.evaluate(() => {
      window.__hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction((n) => window.__draws > n, paused, { timeout: 30000 });
    await context.close();
  });

  await check('a page opened in a hidden tab is settled straight away (no entrance to wait for)', async () => {
    const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.__hidden = true;
    });
    await page.addInitScript(instrument);
    await page.goto(origin + '/invest');
    await page.getByRole('button', { name: 'Begin', exact: true }).waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => document.querySelector('.outreach-page').classList.contains('entry-reveal')), false);
    await context.close();
  });

  await check('800 ms cap: a slow backdrop never holds the foreground (slow photo decode)', async () => {
    const { context, page } = await open(browser, '?bg=photo', {
      route: (p) =>
        p.route(/graphite-fins-.*\.webp/, async (route) => {
          await new Promise((r) => setTimeout(r, 3500));
          await route.continue();
        }),
    });
    await page.waitForFunction(() => window.__t.started != null, null, { timeout: 30000 });
    const early = await page.evaluate(() => ({
      t: window.__t,
      ready: document.querySelector('[data-backdrop]').dataset.ready,
      stage: getComputedStyle(document.querySelector('.lb__stage')).opacity,
    }));
    assert.equal(early.ready, '0', 'backdrop is still loading when the foreground starts');
    assert.equal(early.stage, '0', 'and it is not half-showing');
    assert.ok(early.t.started >= 700, `the cap is a cap, not an early start (${early.t.started})`);
    assert.ok(early.t.started < 3000, `the foreground did not wait for the slow image (${early.t.started})`);
    await page.getByRole('button', { name: 'Begin', exact: true }).waitFor({ state: 'visible', timeout: 30000 });
    await ready(page);
    const late = await page.evaluate(() => window.__t);
    assert.ok(late.ready > late.started, 'backdrop arrived after the foreground started');
    const eases = await page.evaluate(() => {
      const c = getComputedStyle(document.querySelector('.lb__stage'));
      return (c.animationName.includes('lb-resolve') && c.animationDuration !== '0s') || c.transitionDuration !== '0s';
    });
    assert.ok(eases, 'a late backdrop eases in instead of popping');
    await context.close();
  });

  await check('800 ms cap with no WebGL: ribbons fall back to the photo, foreground still starts on time', async () => {
    noGlBrowser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ['--disable-gpu', '--disable-3d-apis', '--disable-webgl'] });
    const { context, page, errors } = await open(noGlBrowser);
    await page.waitForFunction(() => window.__t.started != null, null, { timeout: 30000 });
    const started = await page.evaluate(() => window.__t.started);
    assert.ok(started < 4000, `started at ${started}`);
    await ready(page);
    assert.equal(await page.evaluate(() => document.querySelector('[data-backdrop]').dataset.backdrop), 'photo');
    assert.equal(await draws(page), 0);
    assert.deepEqual(errors, []);
    await context.close();
  });

  await check('shader setup failure (createShader returns null): falls back to the photo, the page does not break', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => {
      for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) C.prototype.createShader = () => null;
    });
    await page.goto(origin + '/invest');
    await page.getByRole('button', { name: 'Begin', exact: true }).waitFor({ state: 'visible', timeout: 30000 });
    await ready(page);
    assert.equal(await page.evaluate(() => document.querySelector('[data-backdrop]').dataset.backdrop), 'photo');
    assert.deepEqual(errors, []);
    await context.close();
  });

  await check('a failed send changes nothing about the backdrop and never replays the entrance', async () => {
    const { context, page, errors } = await open(browser);
    await ready(page);
    await page.getByRole('button', { name: 'Begin', exact: true }).click();
    await page.getByLabel('Your name', { exact: true }).fill('Backdrop visitor');
    await page.getByLabel('Email', { exact: true }).fill('backdrop-visitor@example.invalid');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('heading', { name: 'A little more, if you like.' }).waitFor();
    await page.waitForFunction(() => document.querySelector('.lb.is-dim'), null, { timeout: 30000 });
    await page.evaluate(() => {
      document.querySelector('[data-backdrop]').__mark = 'same-node';
    });
    const save = page.getByRole('button', { name: 'Save details & continue' });
    await expect(save).toBeEnabled({ timeout: 30000 });
    await save.click();
    await page.getByRole('alert').waitFor({ timeout: 30000 });
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => ({
      mark: document.querySelector('[data-backdrop]').__mark,
      mode: document.querySelector('[data-backdrop]').dataset.backdrop,
      resolves: window.__resolves,
      dim: document.querySelector('.lb').classList.contains('is-dim'),
    }));
    assert.deepEqual(after, { mark: 'same-node', mode: 'ribbons', resolves: 1, dim: true });
    assert.deepEqual(errors, []);
    await context.close();
  });
} finally {
  await browser.close();
  await noGlBrowser?.close();
  await new Promise((r) => server.close(r));
}

await writeFile(out + '/results.json', JSON.stringify({ origin, results }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
