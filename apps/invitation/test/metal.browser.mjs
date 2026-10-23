// Actual compiled UI/runtime regression. Local strict capture fixture; no live writes or email.
import { chromium, expect } from '@playwright/test';
import { outreachCaptureInputSchema, outreachContinuationInputSchema } from '../../../packages/contracts/dist/index.js';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, mkdtemp, chmod, rm } from 'node:fs/promises';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { applyPlaywrightBrowsersEnv } from '../../../tooling/uiproof/playwright-browsers.mjs';
const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(app, '../..');
const out = process.env.METAL_PROOF_DIR || '/tmp/intafaced-invitation-metal-regression';
await mkdir(out, { recursive: true });
const captures = [];
const drafts = new Map();
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/api/ops/trpc/outreach.capture') {
    assert.equal(req.method, 'POST');
    let text = '';
    for await (const part of req) text += part;
    const input = outreachCaptureInputSchema.parse(JSON.parse(text));
    captures.push(input.requestId); // Never record capability or contact data.
    await new Promise((r) => setTimeout(r, 900));
    const capturedAt = new Date().toISOString();
    const submissionId = randomUUID();
    const continuationExpiresAt = new Date(Date.now() + 86400000).toISOString();
    drafts.set(submissionId, {
      token: input.continuationToken,
      draft: {
        submissionId,
        revision: 1,
        capturedAt,
        continuationExpiresAt,
        contact: input.contact,
        questionnaires: [],
        completedAt: null,
      },
    });
    return res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        result: {
          data: {
            submissionId,
            revision: 1,
            capturedAt,
            continuationExpiresAt,
          },
        },
      }),
    );
  }
  if (path === '/api/ops/trpc/outreach.resume') {
    assert.equal(req.method, 'POST');
    let text = '';
    for await (const part of req) text += part;
    const input = outreachContinuationInputSchema.parse(JSON.parse(text));
    const saved = drafts.get(input.submissionId);
    assert.ok(saved && saved.token === input.continuationToken);
    return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ result: { data: saved.draft } }));
  }
  const file = path.startsWith('/assets/') ? resolve(app, 'dist', '.' + path) : resolve(app, 'dist/index.html');
  if (!file.startsWith(resolve(app, 'dist') + '/')) return res.writeHead(404).end();
  try {
    res
      .writeHead(200, {
        'content-type':
          { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2', '.webp': 'image/webp' }[
            extname(file)
          ] || 'application/octet-stream',
      })
      .end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const customExecutable = process.env.METAL_BROWSER_EXECUTABLE;
const profile = customExecutable ? await mkdtemp('/tmp/intafaced-metal-owned-browser-') : undefined;
if (profile) await chmod(profile, 0o700);
const launchOptions = {
  executablePath: customExecutable || applyPlaywrightBrowsersEnv({ repoRoot: root }).executablePath,
  headless: process.env.METAL_HEADED !== '1',
};
const persistent = profile ? await chromium.launchPersistentContext(profile, launchOptions) : undefined;
const browser = persistent?.browser() || (await chromium.launch(launchOptions));
if (profile) {
  // Inspect only processes matching this unique private profile; never inspect or kill a Default profile.
  const pids = execFileSync('pgrep', ['-f', profile], { encoding: 'utf8' }).trim().split(/\s+/);
  const owned = pids
    .map((pid) => {
      const args = execFileSync('ps', ['-p', pid, '-o', 'command='], { encoding: 'utf8' }).trim();
      return {
        pid: Number(pid),
        profileMatches: args.includes('--user-data-dir=' + profile),
        flags: args
          .split(' ')
          .filter(
            (value) =>
              value.startsWith('--user-data-dir=') ||
              value.startsWith('--remote-debugging-') ||
              value.startsWith('--headless') ||
              value.startsWith('--use-angle='),
          ),
      };
    })
    .filter((row) => row.profileMatches);
  assert.ok(owned.length, 'Explicit isolated browser profile must be proven before any UI interaction');
  await writeFile(out + '/browser-ownership.json', JSON.stringify({ executable: customExecutable, profile, owned }, null, 2));
}
const reports = [];
try {
  for (const width of process.env.METAL_REPRESENTATIVE_ONLY === '1' ? [390] : [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 850 } });
    await context.addInitScript(() => {
      window.__metalContexts = [];
      const get = OffscreenCanvas.prototype.getContext;
      OffscreenCanvas.prototype.getContext = function (type, ...args) {
        const ctx = get.call(this, type, ...args);
        if (type === 'webgl2' && ctx) window.__metalContexts.push({ canvas: this, ctx, draws: 0, programs: 0 });
        return ctx;
      };
      for (const key of ['drawArrays', 'createProgram']) {
        const original = WebGL2RenderingContext.prototype[key];
        WebGL2RenderingContext.prototype[key] = function (...args) {
          const item = window.__metalContexts.find((item) => item.ctx === this);
          if (item) item[key === 'drawArrays' ? 'draws' : 'programs']++;
          return original.apply(this, args);
        };
      }
    });
    const page = await context.newPage(),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(origin + '/invest');
    await page.getByRole('button', { name: 'Begin', exact: true }).click();
    await page.getByLabel('Your name', { exact: true }).pressSequentially('Shader regression visitor', { delay: 15 });
    await page.getByLabel('Email', { exact: true }).pressSequentially(`shader-${width}@example.invalid`, { delay: 15 });
    await page.waitForTimeout(1100);
    const save = page.getByRole('button', { name: 'Save details & continue', exact: true });
    await expect(save).toBeVisible();
    await expect(save).toBeEnabled();
    await save.focus();
    const guard = await page.evaluate(async () => {
      const list = window.__metalContexts,
        old = list[0],
        current = list.at(-1);
      if (list.length < 2) throw new Error('Expected actual old and new WebGL renderer contexts');
      const before = current.draws;
      old.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
      await new Promise((r) => setTimeout(r, 220));
      const after = current.draws,
        programsBefore = current.programs;
      old.canvas.dispatchEvent(new Event('webglcontextrestored'));
      await new Promise((r) => setTimeout(r, 80));
      return {
        contextCount: list.length,
        before,
        after,
        programsBefore,
        programsAfter: current.programs,
        currentActuallyLost: current.ctx.isContextLost(),
      };
    });
    assert.ok(guard.after > guard.before, 'Stale old loss event must not stop the actual new renderer');
    assert.equal(guard.programsAfter, guard.programsBefore, 'Stale restore must not rebuild the new context');
    assert.equal(guard.currentActuallyLost, false);
    await expect(save).toBeVisible();
    await page.screenshot({ path: `${out}/typed-save-${width}.png`, fullPage: true });
    const loss = await page.evaluate(async () => {
      const item = window.__metalContexts.at(-1),
        extension = item.ctx.getExtension('WEBGL_lose_context');
      if (!extension) throw new Error('Actual WebGL context-loss extension unavailable');
      extension.loseContext();
      await new Promise((r) => setTimeout(r, 100));
      const lost = item.ctx.isContextLost();
      const button = document.querySelector('.outreach-primary');
      const visibleDuringLoss = getComputedStyle(button).visibility === 'visible';
      extension.restoreContext();
      await new Promise((r) => setTimeout(r, 350));
      return { lost, visibleDuringLoss, restored: !item.ctx.isContextLost() };
    });
    assert.deepEqual(loss, { lost: true, visibleDuringLoss: true, restored: true });
    const before = await save.boundingBox();
    const count = captures.length;
    await save.click();
    const pending = page.getByRole('button', { name: 'Saving…', exact: false });
    await expect(pending).toBeDisabled();
    const during = await pending.boundingBox();
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(before[key] - during[key]) <= 1, `Stable pending ${key}`);
    await page.screenshot({ path: `${out}/pending-save-${width}.png`, fullPage: true });
    await expect(page.getByRole('heading', { name: 'How would you like to take part?' })).toBeVisible();
    assert.equal(captures.length - count, 1);
    assert.deepEqual(errors, []);
    reports.push({ width, realSequentialTypingVisible: true, guard, loss, before, during, singleCapture: true, errors });
    await context.close();
  }
  for (const failure of ['offscreen-allocation', 'shader-initialization']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addInitScript((failure) => {
      if (failure === 'offscreen-allocation') {
        const get = OffscreenCanvas.prototype.getContext;
        OffscreenCanvas.prototype.getContext = function (type, ...args) {
          return type === 'webgl2' ? null : get.call(this, type, ...args);
        };
      } else {
        WebGL2RenderingContext.prototype.createShader = function () {
          return null;
        };
      }
    }, failure);
    const page = await context.newPage(),
      errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin + '/invest');
    const begin = page.getByRole('button', { name: 'Begin', exact: true });
    await expect(page.locator('.metal-fx-fallback')).toBeVisible();
    await expect(begin).toBeVisible();
    await expect(begin).toBeEnabled();
    await begin.focus();
    await expect(begin).toBeFocused();
    await begin.press('Enter');
    await page.getByLabel('Your name', { exact: true }).fill('Fallback regression visitor');
    await page.getByLabel('Email', { exact: true }).fill(failure + '@example.invalid');
    const save = page.getByRole('button', { name: 'Save details & continue', exact: true });
    await expect(page.locator('.metal-fx-fallback')).toBeVisible();
    await expect(save).toHaveAttribute('type', 'submit');
    const native = await save.evaluate((button) => ({
      tag: button.tagName,
      hasForm: Boolean(button.form),
      visibility: getComputedStyle(button).visibility,
    }));
    assert.deepEqual(native, { tag: 'BUTTON', hasForm: true, visibility: 'visible' });
    await save.focus();
    await expect(save).toBeFocused();
    const count = captures.length;
    await save.press('Enter');
    await expect(page.getByRole('heading', { name: 'How would you like to take part?' })).toBeVisible();
    assert.equal(captures.length - count, 1);
    assert.deepEqual(errors, []);
    reports.push({ failure, originalFallbackRendered: true, keyboardNativeFormCapture: true, singleCapture: true, errors });
    await page.screenshot({ path: `${out}/fallback-${failure}.png`, fullPage: true });
    await context.close();
  }
  await writeFile(
    out + '/evidence.json',
    JSON.stringify(
      { label: 'Actual compiled React and actual original local MetalFx; strict synthetic capture fixture', reports },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ out, reports }));
} finally {
  await browser.close();
  if (profile) await rm(profile, { recursive: true, force: true });
  await new Promise((r) => server.close(r));
}
