import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, extname } from 'node:path';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdtemp, chmod, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const front = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  root = resolve(front, '../..'),
  require = createRequire(root + '/package.json'),
  { chromium } = require('@playwright/test'),
  out = process.env.SCENE_PROOF_OUT || '/tmp/intafaced-invitation-scene-proof';
const server = createServer(async (request, response) => {
  if (request.url.startsWith('/api/ops/trpc/outreach.capture')) {
    let input = '';
    for await (const chunk of request) input += chunk;
    const { outreachCaptureInputSchema } = await import('../../../packages/contracts/dist/index.js');
    outreachCaptureInputSchema.parse(JSON.parse(input));
    response
      .writeHead(503, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: { message: 'ops.crm.storage_unavailable' } }));
    return;
  }
  const path = new URL(request.url, 'http://localhost').pathname;
  const asset =
    path.startsWith('/assets/') || ['/component-licenses.txt', '/font-OFL.txt'].includes(path)
      ? resolve(front, 'dist', '.' + path)
      : resolve(front, 'dist/index.html');
  try {
    response
      .writeHead(200, {
        'content-type':
          {
            '.html': 'text/html',
            '.js': 'text/javascript',
            '.css': 'text/css',
            '.woff2': 'font/woff2',
            '.svg': 'image/svg+xml',
            '.webp': 'image/webp',
            '.txt': 'text/plain',
          }[extname(asset)] || 'application/octet-stream',
      })
      .end(await readFile(asset));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = 'http://127.0.0.1:' + server.address().port;
await mkdir(out, { recursive: true });
const profile = await mkdtemp('/tmp/intafaced-graphite-bootstrap-owned-');
await chmod(profile, 0o700);
const persistent = await chromium.launchPersistentContext(profile, {
    ...(process.env.SCENE_BROWSER_EXECUTABLE ? { executablePath: process.env.SCENE_BROWSER_EXECUTABLE } : {}),
    headless: process.env.SCENE_HEADED !== '1',
  }),
  browser = persistent.browser();
const owned = execFileSync('pgrep', ['-f', profile], { encoding: 'utf8' })
  .trim()
  .split(/\s+/)
  .map((pid) => ({ pid: Number(pid), args: execFileSync('ps', ['-p', pid, '-o', 'command='], { encoding: 'utf8' }).trim() }))
  .filter((r) => r.args.includes('--user-data-dir=' + profile));
assert.ok(owned.length);
await writeFile(out + '/ownership.json', JSON.stringify({ profile, owned }, null, 2));
const reports = [];
try {
  for (const mode of ['delayed', 'queued', 'error']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } }),
      errors = [];
    await context.addInitScript(
      ({ mode }) => {
        window.__lights = [];
        window.__entries = [];
        document.addEventListener('animationstart', (e) => {
          if (e.target.matches('.graphite-field'))
            window.__lights.push({ key: e.target.dataset.sceneView, name: e.animationName, at: Date.now() });
          if (e.target.matches('.welcome-action')) window.__entries.push({ at: Date.now(), name: e.animationName });
        });
        if (mode === 'delayed') {
          const original = indexedDB.open.bind(indexedDB);
          indexedDB.open = (...args) => {
            const request = original(...args);
            return new Proxy(request, {
              get(t, k) {
                const v = Reflect.get(t, k, t);
                return typeof v === 'function' ? v.bind(t) : v;
              },
              set(t, k, v) {
                if (k === 'onsuccess') {
                  t[k] = (e) => setTimeout(() => v(e), 1800);
                  return true;
                }
                return Reflect.set(t, k, v, t);
              },
            });
          };
        }
      },
      { mode },
    );
    let holder;
    if (mode === 'queued') {
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
    await page.goto(origin + '/invest');
    await page.getByRole('button', { name: 'Begin', exact: true }).waitFor();
    await page.waitForTimeout(300);
    const first = await page.evaluate(() => {
      const s = (e) => {
        const r = e.getBoundingClientRect(),
          c = getComputedStyle(e);
        return { opacity: c.opacity, visibility: c.visibility, width: r.width, height: r.height, text: e.textContent };
      };
      return {
        title: s(document.querySelector('#welcome-title')),
        support: s(document.querySelector('.welcome-description')),
        art: s(document.querySelector('.invitation-scene')),
        entries: window.__entries,
        lights: window.__lights,
      };
    });
    assert.equal(first.title.visibility, 'visible');
    if (mode !== 'error') {
      assert.equal(first.title.opacity, '1');
      assert.equal(first.support.opacity, '1');
    }
    await page.screenshot({ path: out + '/' + mode + '-300ms.png' });
    await page.getByRole('button', { name: 'Begin', exact: true }).click();
    await page.getByLabel('Your name', { exact: true }).fill('Bootstrap visitor');
    await page.getByLabel('Email', { exact: true }).fill('capture-error-' + mode + '@example.invalid');
    if (mode !== 'error') {
      await page.getByRole('status').filter({ hasText: 'Checking saved progress' }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Save details & continue' }).isDisabled(), true);
      await page.waitForTimeout(mode === 'queued' ? 3100 : 1900);
      await page.getByRole('button', { name: 'Save details & continue' }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Save details & continue' }).isEnabled(), true);
      if (holder) await holder.evaluate(() => window.__held.close());
    }
    await page.waitForTimeout(650);
    const before = await page.evaluate(() => ({ lights: window.__lights, filter: document.querySelector('.graphite-grain filter')?.id }));
    await page.getByRole('button', { name: 'Save details & continue' }).click();
    await page.getByRole('alert').waitFor();
    await page.waitForTimeout(750);
    const after = await page.evaluate(() => ({
      lights: window.__lights,
      filter: document.querySelector('.graphite-grain filter')?.id,
      entries: window.__entries,
      text: document.body.innerText,
    }));
    assert.deepEqual(errors, []);
    assert.equal(after.lights.length, before.lights.length, 'capture failure must not restart question lighting');
    assert.equal(after.filter, before.filter, 'original noise filter stays mounted');
    assert.equal(after.entries.length, 0, 'slow boot/early navigation never replays entry');
    reports.push({ mode, first, before, after, errors });
    await writeFile(out + '/incremental.json', JSON.stringify(reports, null, 2));
    await context.close();
  }
  await writeFile(
    out + '/evidence.json',
    JSON.stringify(
      {
        origin,
        label:
          'Actual built React+native IDB; strict failing RAM capture HTTP, no API interception; native queued open is held behind own delete request. No production writes.',
        reports,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      out,
      counts: reports.map((r) => ({
        mode: r.mode,
        before: r.before.lights.length,
        after: r.after.lights.length,
        keys: r.after.lights.map((x) => x.key),
      })),
    }),
  );
} finally {
  await browser.close();
  await rm(profile, { recursive: true, force: true });
  await new Promise((r) => server.close(r));
}
