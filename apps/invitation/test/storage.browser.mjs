// Storage start-up proofs for the two-screen contact flow, in the built app (apps/invitation/dist).
// Run `pnpm --filter @intafaced/invitation build` first, then: node apps/invitation/test/storage.browser.mjs
//
// Ported from the old scene proof (origin/main apps/invitation/test/scene.browser.mjs). It guards the continuation token
// from being written to the wrong store before the storage switch: while saved progress is still being checked,
//   - "Checking saved progress" is shown (on both contact screens),
//   - "Save details & continue" stays disabled until storage is ready, then is enabled,
//   - the page never throws, and
//   - a failed capture (the only API here, always failing) neither replays the entrance nor remounts the backdrop.
// Modes: 'delayed' (IndexedDB answers only once released, held for the whole check), 'queued' (the open waits behind another tab's delete request),
// 'error' (storage works, the send fails), 'idb-error' (IndexedDB open errors outright).
// No production writes: the capture call is answered by a local server that always fails (503).
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { outreachCaptureInputSchema } from '../../../packages/contracts/dist/index.js';
import { applyPlaywrightBrowsersEnv } from '../../../tooling/uiproof/playwright-browsers.mjs';

const front = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(front, '../..');
const { executablePath } = applyPlaywrightBrowsersEnv({ repoRoot: root });
const out = process.env.STORAGE_PROOF_OUT || '/tmp/intafaced-invitation-storage-proof';
await mkdir(out, { recursive: true });

const dist = resolve(front, 'dist');
const captures = [];
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path.startsWith('/api/')) {
    let input = '';
    for await (const chunk of request) input += chunk;
    if (path.includes('outreach.capture')) {
      captures.push(outreachCaptureInputSchema.parse(JSON.parse(input))); // strict: a malformed capture fails the proof
    }
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
const results = [];
try {
  for (const mode of ['delayed', 'queued', 'error', 'idb-error']) {
    const started = Date.now();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const errors = [];
    // A busy machine can need longer; this only raises the patience, never changes what is asserted.
    context.setDefaultTimeout(Number(process.env.STORAGE_PROOF_TIMEOUT) || 60000);
    await context.addInitScript(
      ({ mode }) => {
        window.__entries = [];
        window.__resolves = 0;
        document.addEventListener('animationstart', (e) => {
          if (e.target.matches('.welcome-action')) window.__entries.push({ at: Date.now(), name: e.animationName });
          if (e.animationName === 'lb-resolve') window.__resolves++;
        });
        const original = indexedDB.open.bind(indexedDB);
        if (mode === 'queued') {
          // The storage layer gives up on a queued open after 3 s. On a loaded machine that moment can pass before the
          // proof has looked, so the proof holds that timer and fires it on demand (window.__giveUp): same outcome,
          // deterministic. Only the storage layer's timer is held (its callback takes the error argument).
          const nativeSetTimeout = window.setTimeout.bind(window);
          const held = [];
          window.__giveUp = () => held.splice(0).forEach((fire) => fire());
          window.setTimeout = (fn, delay, ...rest) => {
            if (delay === 3000 && fn.length === 1) {
              held.push(() => nativeSetTimeout(fn, 0, ...rest));
              return 0;
            }
            return nativeSetTimeout(fn, delay, ...rest);
          };
        }
        if (mode === 'delayed') {
          // IndexedDB answers only when the proof says so (deterministic, however loaded the machine is), and the
          // storage layer's own 3 s give-up timer is stretched so that "slow but working" is what gets exercised.
          const waiting = [];
          let released = false;
          window.__releaseIdb = () => {
            released = true;
            waiting.splice(0).forEach((fn) => fn());
          };
          const nativeSetTimeout = window.setTimeout.bind(window);
          window.setTimeout = (fn, delay, ...rest) =>
            nativeSetTimeout(fn, delay === 3000 && fn.length === 1 && !released ? 600000 : delay, ...rest);
          indexedDB.open = (...args) => {
            const request = original(...args);
            return new Proxy(request, {
              get(t, k) {
                const v = Reflect.get(t, k, t);
                return typeof v === 'function' ? v.bind(t) : v;
              },
              set(t, k, v) {
                if (k === 'onsuccess') {
                  t[k] = (e) => (released ? v(e) : waiting.push(() => v(e)));
                  return true;
                }
                return Reflect.set(t, k, v, t);
              },
            });
          };
        }
        if (mode === 'idb-error') {
          indexedDB.open = () => {
            const request = {};
            setTimeout(() => {
              request.error = new DOMException('blocked by the proof', 'UnknownError');
              request.onerror?.({ target: request, preventDefault() {}, stopPropagation() {} });
            }, 50);
            return request;
          };
        }
      },
      { mode },
    );
    let holder;
    if (mode === 'queued') {
      // Another tab asks to delete the database and never lets go, so a new open queues behind it.
      holder = await context.newPage();
      await holder.goto(origin + '/join');
      await holder.evaluate(async () => {
        window.__held = await new Promise((res, rej) => {
          const r = indexedDB.open('intafaced-enquiry-drafts', 1);
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        window.__held.onversionchange = () => {};
        window.__delete = indexedDB.deleteDatabase('intafaced-enquiry-drafts');
      });
    }
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    const t0 = Date.now();
    await page.goto(origin + '/invest');
    await page.getByRole('button', { name: 'Begin', exact: true }).waitFor();
    const title = await page.evaluate(() => {
      const c = getComputedStyle(document.querySelector('#welcome-title'));
      return { visibility: c.visibility };
    });
    assert.equal(title.visibility, 'visible');
    await page.getByRole('button', { name: 'Begin', exact: true }).click();
    // Whatever entrance had started by the time of this click is the first and only one; nothing may replay after it.
    const entriesAtBegin = await page.evaluate(() => window.__entries.length);
    await page.getByLabel('Your name', { exact: true }).fill('Bootstrap visitor');
    await page.getByLabel('Email', { exact: true }).fill(`capture-error-${mode}@example.invalid`);
    const sentBefore = captures.length;
    const slow = mode === 'delayed' || mode === 'queued';
    const checking = page.getByRole('status').filter({ hasText: 'Checking saved progress' });
    if (slow) {
      // Screen 1: the visitor can type, and is told storage is still being checked.
      await checking.waitFor().catch(async (e) => {
        console.log(`${mode}: ${Date.now() - t0} ms after navigation`);
        await page.screenshot({ path: `${out}/${mode}-screen1-FAILED.png` });
        console.log(await page.locator('body').innerText());
        throw e;
      });
      await page.screenshot({ path: `${out}/${mode}-screen1-checking.png` });
    }
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('heading', { name: 'A little more, if you like.', exact: true }).waitFor();
    const save = page.getByRole('button', { name: 'Save details & continue' });
    if (slow) {
      // Screen 2 is where data is sent: the button is disabled until storage is ready.
      await checking.waitFor();
      assert.equal(await save.isDisabled(), true, `${mode}: Save is disabled while storage is being checked`);
      await page.screenshot({ path: `${out}/${mode}-screen2-checking.png` });
      await page.waitForTimeout(500);
      assert.equal(await save.isDisabled(), true, `${mode}: Save stays disabled until storage is ready`);
      if (mode === 'delayed') await page.evaluate(() => window.__releaseIdb());
      if (mode === 'queued') await page.evaluate(() => window.__giveUp());
      if (holder) await holder.evaluate(() => window.__held.close());
      await page.waitForFunction(
        () => [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Save details & continue'))?.disabled === false,
        null,
        { timeout: 120000 },
      );
      assert.equal(await save.isEnabled(), true);
      assert.equal(await checking.count(), 0, `${mode}: the checking message is gone once storage is ready`);
    } else {
      await page.waitForFunction(
        () => [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Save details & continue'))?.disabled === false,
        null,
        { timeout: 120000 },
      );
    }
    assert.equal(captures.length, sentBefore, 'nothing is sent while storage is checked');
    const before = await page.evaluate(() => ({
      resolves: window.__resolves,
      backdrop: document.querySelectorAll('[data-backdrop]').length,
    }));
    await page.waitForTimeout(650);
    await save.click();
    await page.getByRole('alert').waitFor({ timeout: 120000 });
    await page.waitForTimeout(750);
    const after = await page.evaluate(() => ({
      resolves: window.__resolves,
      entries: window.__entries,
      backdrop: document.querySelectorAll('[data-backdrop]').length,
    }));
    assert.equal(captures.length, sentBefore + 1, `${mode}: exactly one capture was attempted, from screen 2`);
    assert.deepEqual(errors, [], `${mode}: no page errors`);
    assert.equal(after.entries.length, entriesAtBegin, `${mode}: a slow boot or an early Begin never replays the welcome entrance`);
    assert.equal(after.resolves, before.resolves, `${mode}: a failed capture does not replay the backdrop entrance`);
    assert.equal(after.backdrop, 1, `${mode}: one backdrop for the whole journey`);
    results.push({ mode, ok: true, ms: Date.now() - started });
    console.log(`ok   storage start-up (${mode})`);
    await writeFile(`${out}/incremental.json`, JSON.stringify(results, null, 2));
    await context.close();
  }
  // A1: a slow storage check never cancels the entrance. The check is held open (and the storage layer's own give-up timer is
  // stretched), so "slow" is true for the whole run; the welcome must still play out in full, on its own clock, and settle by itself.
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    context.setDefaultTimeout(Number(process.env.STORAGE_PROOF_TIMEOUT) || 60000);
    await context.addInitScript(() => {
      window.__entries = [];
      window.__entryClass = [];
      window.__released = false;
      document.addEventListener('animationstart', (e) => {
        if (e.target.matches('.welcome-action, .h1-line')) window.__entries.push({ at: Date.now(), name: e.animationName });
      });
      const original = indexedDB.open.bind(indexedDB);
      const waiting = [];
      window.__releaseIdb = () => {
        window.__released = true;
        waiting.splice(0).forEach((fn) => fn());
      };
      const nativeSetTimeout = window.setTimeout.bind(window);
      window.setTimeout = (fn, delay, ...rest) =>
        nativeSetTimeout(fn, delay === 3000 && fn.length === 1 && !window.__released ? 600000 : delay, ...rest);
      indexedDB.open = (...args) => {
        const request = original(...args);
        return new Proxy(request, {
          get(t, k) {
            const v = Reflect.get(t, k, t);
            return typeof v === 'function' ? v.bind(t) : v;
          },
          set(t, k, v) {
            if (k === 'onsuccess') {
              t[k] = (e) => (window.__released ? v(e) : waiting.push(() => v(e)));
              return true;
            }
            return Reflect.set(t, k, v, t);
          },
        });
      };
      // Every change of the page's entrance class, with the time, so "never cancelled" is read from a log, not a guess.
      new MutationObserver(() => {
        const page = document.querySelector('.outreach-page');
        if (!page) return;
        const state = page.classList.contains('entry-reveal') ? 'reveal' : 'settled';
        if (window.__entryClass.at(-1)?.state !== state) window.__entryClass.push({ state, at: Date.now() });
      }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const t0 = Date.now();
    await page.goto(origin + '/invest');
    await page.getByRole('button', { name: 'Begin', exact: true }).waitFor();
    // Well past the old 100ms give-up: the entrance is still in progress and the storage check is still pending.
    await page.waitForTimeout(450);
    assert.equal(
      await page.evaluate(() => document.querySelector('.outreach-page').classList.contains('entry-reveal')),
      true,
      'a slow storage check does not cancel the entrance',
    );
    assert.equal(await page.evaluate(() => window.__released), false, 'the storage check is still pending');
    await page.waitForFunction(() => window.__entries.some((e) => e.name === 'invitation-cta-entry'), null, { timeout: 8000 });
    assert.equal(await page.evaluate(() => window.__released), false, 'the button entrance played while storage was still being checked');
    // It finishes by itself, never skipped to the end: first the lines, then the button, then it settles.
    await page.waitForFunction(() => !document.querySelector('.outreach-page').classList.contains('entry-reveal'), null, {
      timeout: 10000,
    });
    const log = await page.evaluate(() => ({ entries: window.__entries, entryClass: window.__entryClass }));
    const settledAt = log.entryClass.find((row) => row.state === 'settled')?.at;
    const lineStart = log.entries.find((row) => row.name === 'invitation-line-entry')?.at;
    const buttonStart = log.entries.find((row) => row.name === 'invitation-cta-entry')?.at;
    assert.ok(lineStart && buttonStart && settledAt, 'the headline, the button and the settle all happened');
    assert.ok(settledAt - t0 > 1800, `settled on its own clock (${settledAt - t0} ms), not cut short at ~100 ms by the storage check`);
    assert.ok(settledAt > buttonStart, 'it settled after the button had entered');
    await page.evaluate(() => window.__releaseIdb());
    await page.waitForTimeout(300);
    assert.deepEqual(errors, []);
    await context.close();
    results.push({ mode: 'a1-slow-check-keeps-entrance', ok: true });
    console.log('ok   A1: a slow storage check does not cancel the entrance (it plays in full and settles by itself)');
  }
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
await writeFile(`${out}/results.json`, JSON.stringify({ origin, results }, null, 2));
console.log(`\n${results.length}/5 storage start-up proofs passed`);
