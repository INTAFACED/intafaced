// Compiled real UI + strict local HTTP fixtures. No interception, email or live service writes.
import { chromium, expect } from '@playwright/test';
import {
  outreachCaptureInputSchema,
  outreachContinuationInputSchema,
  outreachQuestionnaireInputSchema,
} from '../../../packages/contracts/dist/index.js';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, mkdtemp, chmod, rm } from 'node:fs/promises';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { applyPlaywrightBrowsersEnv } from '../../../tooling/uiproof/playwright-browsers.mjs';
const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(app, '../..');
const out = process.env.COMPLETION_PROOF_DIR || '/tmp/intafaced-invitation-completion-proof';
await mkdir(out, { recursive: true });
let mode = 'delayed';
const drafts = new Map(),
  intents = new Map(),
  requests = [],
  acknowledgments = [];
const reply = (res, data) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ result: { data } }));
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path.startsWith('/api/ops/trpc/outreach.')) {
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.authorization, undefined);
    let body = '';
    for await (const part of req) body += part;
    const input = JSON.parse(body),
      method = path.split('.').pop();
    ({ capture: outreachCaptureInputSchema, resume: outreachContinuationInputSchema, answer: outreachQuestionnaireInputSchema })[
      method
    ].parse(input);
    requests.push({ method, requestId: input.requestId, bodyHash: createHash('sha256').update(body).digest('hex') });
    if (method === 'capture') {
      const capturedAt = new Date().toISOString(),
        submissionId = randomUUID();
      const draft = {
        submissionId,
        revision: 1,
        capturedAt,
        continuationExpiresAt: new Date(Date.now() + 86400000).toISOString(),
        contact: input.contact,
        questionnaires: [],
        completedAt: null,
      };
      drafts.set(submissionId, { token: input.continuationToken, draft, mode });
      return reply(res, { submissionId, revision: 1, capturedAt, continuationExpiresAt: draft.continuationExpiresAt });
    }
    const saved = drafts.get(input.submissionId);
    assert.ok(saved && saved.token === input.continuationToken);
    if (method === 'resume') return reply(res, saved.draft);
    if (saved.mode === 'failing')
      return res
        .writeHead(503, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: { message: 'ops.crm.storage_unavailable' } }));
    const prior = intents.get(input.requestId);
    // Chromium may retry a lost socket before fetch rejects. Keep that outcome
    // unknown until the visitor explicitly retries the persisted intent.
    if (saved.mode === 'unknown' && prior && !saved.unknownReleased)
      return res
        .writeHead(503, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: { message: 'ops.crm.storage_unavailable' } }));
    if (!prior) {
      assert.equal(input.expectedRevision, saved.draft.revision);
      if (saved.mode === 'delayed') await new Promise((r) => setTimeout(r, 1100));
      saved.draft.questionnaires.push(structuredClone(input.questionnaire));
      saved.draft.revision++;
      saved.draft.completedAt = new Date().toISOString();
      intents.set(input.requestId, { body, data: structuredClone(saved.draft) });
      if (saved.mode === 'unknown') return res.destroy();
    } else assert.equal(prior.body, body);
    const serverReplyAt = Date.now();
    acknowledgments.push({ submissionId: input.submissionId, serverReplyAt });
    return reply(res, intents.get(input.requestId).data);
  }
  const relative =
    path === '/component-licenses.txt' || path === '/font-OFL.txt' || path.startsWith('/assets/') ? '.' + path : 'index.html';
  const file = resolve(app, 'dist', relative);
  if (!file.startsWith(resolve(app, 'dist') + '/')) return res.writeHead(404).end();
  try {
    res
      .writeHead(200, {
        'content-type':
          {
            '.html': 'text/html',
            '.js': 'text/javascript',
            '.css': 'text/css',
            '.txt': 'text/plain',
            '.woff2': 'font/woff2',
            '.webp': 'image/webp',
          }[extname(file)] || 'application/octet-stream',
      })
      .end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const executablePath = process.env.COMPLETION_BROWSER_EXECUTABLE || applyPlaywrightBrowsersEnv({ repoRoot: root }).executablePath;
const profile = process.env.COMPLETION_BROWSER_EXECUTABLE ? await mkdtemp('/tmp/intafaced-completion-owned-') : undefined;
if (profile) await chmod(profile, 0o700);
const persistent = profile
  ? await chromium.launchPersistentContext(profile, { executablePath, headless: process.env.COMPLETION_HEADED !== '1' })
  : undefined;
const browser = persistent?.browser() || (await chromium.launch({ executablePath, headless: true }));
if (profile) {
  const owned = execFileSync('pgrep', ['-f', profile], { encoding: 'utf8' })
    .trim()
    .split(/\s+/)
    .map((pid) => ({ pid: Number(pid), args: execFileSync('ps', ['-p', pid, '-o', 'command='], { encoding: 'utf8' }).trim() }))
    .filter((row) => row.args.includes('--user-data-dir=' + profile))
    .map((row) => ({ pid: row.pid, profileMatches: true }));
  assert.ok(owned.length);
  await writeFile(out + '/browser-ownership.json', JSON.stringify({ profile, owned }, null, 2));
}
const reports = [];
async function review(page) {
  await page.goto(origin + '/invest');
  await page.getByRole('button', { name: 'Begin', exact: true }).click();
  await page.getByLabel('Your name', { exact: true }).fill('Completion regression visitor');
  await page.getByLabel('Email', { exact: true }).fill(`completion-${mode}@example.invalid`);
  await page.getByRole('button', { name: 'Save details & continue' }).click();
  await page.getByRole('button', { name: 'I can introduce an investor', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page
    .getByLabel('Which best describes you or the organisation you represent?')
    .and(page.locator('select'))
    .selectOption('individual');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('What is your role in the decision?').and(page.locator('select')).selectOption('introducer');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('When would you consider taking part?').and(page.locator('select')).selectOption('later');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('What would you like us to know?').and(page.locator('textarea')).fill('Please review this introduction enquiry.');
  await page.getByRole('button', { name: 'Review your answers' }).click();
  await expect(page.getByRole('heading', { name: 'Before you send.' })).toBeVisible();
  assert.equal(await page.locator('.completion-mark').count(), 0);
}
try {
  for (const scenario of [
    { mode: 'delayed', width: 390 },
    { mode: 'delayed', width: 1280 },
    { mode: 'failing', width: 390 },
    { mode: 'unknown', width: 390 },
    { mode: 'reduced', width: 390 },
    { mode: 'local-delay', width: 390 },
  ]) {
    mode = scenario.mode;
    const context = await browser.newContext({
      viewport: { width: scenario.width, height: scenario.width === 390 ? 844 : 850 },
      reducedMotion: mode === 'reduced' ? 'reduce' : 'no-preference',
      recordVideo:
        mode === 'delayed'
          ? { dir: out + '/videos', size: { width: scenario.width, height: scenario.width === 390 ? 844 : 850 } }
          : undefined,
    });
    await context.addInitScript((scenarioMode) => {
      window.__completionTimeline = { completedResumeBodyAt: null, delayedUiCallbacks: [], deliveredUiCallbacks: [] };
      window.__delayUiStorage = false;
      const text = Response.prototype.text;
      Response.prototype.text = async function (...args) {
        const body = await text.apply(this, args);
        let data;
        try {
          data = JSON.parse(body);
        } catch {
          /* Leave non-JSON transport responses unchanged. */
        }
        if (this.url.endsWith('.resume') && data?.result?.data?.completedAt) {
          window.__completionTimeline.completedResumeBodyAt = Date.now();
          if (scenarioMode === 'local-delay') window.__delayUiStorage = true;
        }
        return body;
      };
      if (scenarioMode === 'local-delay') {
        const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete');
        Object.defineProperty(IDBTransaction.prototype, 'oncomplete', {
          ...descriptor,
          set(callback) {
            descriptor.set.call(
              this,
              typeof callback !== 'function'
                ? callback
                : function (event) {
                    if (!window.__delayUiStorage) return callback.call(this, event);
                    window.__completionTimeline.delayedUiCallbacks.push(Date.now());
                    setTimeout(() => {
                      window.__completionTimeline.deliveredUiCallbacks.push(Date.now());
                      callback.call(this, event);
                    }, 1000);
                  },
            );
          },
        });
      }
      window.__completionEvents = [];
      window.__headingCallbacks = [];
      window.__holdHeading = false;
      const raf = window.requestAnimationFrame;
      window.requestAnimationFrame = function (callback) {
        if (window.__holdHeading && callback.toString().includes('stepHeading')) {
          window.__headingCallbacks.push(callback);
          return 0;
        }
        return raf.call(this, callback);
      };
      new MutationObserver(() => {
        const receipt = document.querySelector('.outreach-complete');
        if (!receipt) return;
        const state = receipt.classList.contains('completion-enter') ? 'entering' : 'static';
        if (window.__completionEvents.at(-1)?.state !== state)
          window.__completionEvents.push({
            state,
            at: Date.now(),
            markOffset: getComputedStyle(receipt.querySelector('.completion-check')).strokeDashoffset,
          });
      }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
      document.addEventListener('animationend', (event) => {
        if (event.animationName.startsWith('invitation-completion'))
          window.__completionEvents.push({ animation: event.animationName, at: Date.now() });
      });
    }, mode);
    const page = await context.newPage(),
      pageBornAt = Date.now(),
      errors = [],
      clientResponses = [],
      start = requests.length,
      ackStart = acknowledgments.length;
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (response) => {
      if (response.url().includes('/api/ops/trpc/outreach.'))
        clientResponses.push({ method: response.url().split('.').pop(), at: Date.now(), status: response.status() });
    });

    await review(page);
    await page.evaluate(() => {
      window.__holdHeading = true;
    });
    const finalClickAt = Date.now();
    if (mode === 'delayed' && scenario.width === 390) {
      await page.getByRole('button', { name: 'Send enquiry', exact: true }).evaluate((button) => {
        button.click();
        button.click();
      });
    } else await page.getByRole('button', { name: 'Send enquiry', exact: true }).click();
    if (mode === 'delayed') {
      await expect(page.getByRole('button', { name: 'Saving…', exact: false })).toBeDisabled();
      await page.waitForTimeout(300);
      assert.equal(await page.locator('.outreach-complete').count(), 0);
    }
    if (mode === 'failing' || mode === 'unknown') {
      await expect(page.getByRole('alert')).toBeVisible();
      assert.equal(await page.locator('.outreach-complete').count(), 0);
      if (mode === 'failing') {
        reports.push({
          ...scenario,
          pendingAndFailureNeverSuccess: true,
          writes: requests.slice(start).filter((r) => r.method !== 'resume'),
          errors,
        });
        await context.close();
        continue;
      }
      for (const saved of drafts.values()) if (saved.mode === 'unknown') saved.unknownReleased = true;
      await page.getByRole('button', { name: 'Send enquiry', exact: true }).click();
    }
    const receipt = page.locator('.outreach-complete');
    await expect(page.getByRole('heading', { name: 'Your enquiry is saved.' })).toBeVisible();
    await expect(receipt.getByRole('status')).toHaveCount(1);
    const control = page.getByRole('button', { name: 'Forget this draft on my device' });
    await expect(control).toBeEnabled();
    if (mode === 'local-delay') {
      await page.waitForTimeout(80);
      const beforeForget = await page.evaluate(() => ({ timeline: window.__completionTimeline, events: window.__completionEvents }));
      assert.ok(beforeForget.timeline.delayedUiCallbacks.length);
      assert.equal(beforeForget.timeline.deliveredUiCallbacks.length, 0);
      assert.equal(beforeForget.events[0].state, 'entering', 'No initial static mark before the ceremony');
      page.once('dialog', (dialog) => dialog.accept());
      await control.click();
      await expect(page.getByRole('button', { name: 'Begin', exact: true })).toBeVisible();
      await page.waitForTimeout(1100);
      const localAbsent = await page.evaluate(async () => {
        const tabAbsent = !sessionStorage.getItem('intafaced.outreach.continuation.v1');
        const database = await new Promise((resolve, reject) => {
          const request = indexedDB.open('intafaced-enquiry-drafts', 1);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const rememberedCount = await new Promise((resolve, reject) => {
          const request = database.transaction('protected-drafts', 'readonly').objectStore('protected-drafts').count();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        database.close();
        return { tabAbsent, rememberedCount };
      });
      assert.deepEqual(localAbsent, { tabAbsent: true, rememberedCount: 0 });
      const writes = requests.slice(start).filter((r) => r.method !== 'resume');
      assert.equal(writes.filter((r) => r.method === 'capture').length, 1);
      assert.equal(writes.filter((r) => r.method === 'answer').length, 1);
      await page.reload();
      await expect(page.getByRole('button', { name: 'Begin', exact: true })).toBeVisible();
      reports.push({
        ...scenario,
        beforeForget,
        immediateForgetAfterConfirmation: true,
        localAbsent,
        noResurrection: true,
        writes,
        clientResponses,
        errors,
      });
      assert.deepEqual(errors, []);
      await context.close();
      continue;
    }
    await control.focus();
    const held = await page.evaluate(() => {
      const list = window.__headingCallbacks;
      for (const callback of list) callback(performance.now());
      return list.length;
    });
    assert.ok(held, 'Actual scheduled heading callback must be exercised');
    await expect(control).toBeFocused();
    const summary = page.locator('.saved-contact-details > summary');
    await summary.focus();
    await page.evaluate(() => {
      for (const callback of window.__headingCallbacks) callback(performance.now());
    });
    await expect(summary).toBeFocused();
    await page.waitForTimeout(850);
    const events = await page.evaluate(() => window.__completionEvents);
    const ack = acknowledgments.slice(ackStart).at(-1),
      answerAck = clientResponses.filter((r) => r.method === 'answer' && r.status === 200).at(-1),
      resumeAck = clientResponses.filter((r) => r.method === 'resume').at(-1),
      timeline = await page.evaluate(() => window.__completionTimeline),
      entered = events.find((e) => e.state === 'entering');
    await writeFile(
      `${out}/checkpoint-${mode}-${scenario.width}.json`,
      JSON.stringify({ scenario, events, timeline, clientResponses, writes: requests.slice(start), errors }, null, 2),
    );
    if (mode === 'delayed') {
      assert.ok(entered && entered.at >= timeline.completedResumeBodyAt);
      assert.equal(events[0].state, 'entering', 'Receipt must not first paint a static check and rewind');
      const finish = events.find((e) => e.animation === 'invitation-completion-copy');
      assert.ok(
        finish && finish.at - timeline.completedResumeBodyAt <= 800,
        `Completion from parsed authoritative completed resume took ${finish?.at - timeline.completedResumeBodyAt}ms`,
      );
      const finalStyles = await receipt.evaluate((el) => ({
        check: getComputedStyle(el.querySelector('.completion-check')).strokeDashoffset,
        copyOpacity: getComputedStyle(el.querySelector('.completion-receipt-copy')).opacity,
      }));
      assert.deepEqual(finalStyles, { check: '0px', copyOpacity: '1' });
    } else assert.equal(entered, undefined, 'Reduced motion and unknown-intent retry stay static');
    await expect(summary).toBeFocused();
    await page.screenshot({ path: `${out}/receipt-${mode}-${scenario.width}.png`, fullPage: true });
    const writes = requests.slice(start).filter((r) => r.method !== 'resume');
    assert.equal(writes.filter((r) => r.method === 'capture').length, 1);
    if (mode !== 'unknown') assert.equal(writes.filter((r) => r.method === 'answer').length, 1);
    if (mode === 'unknown') {
      const answers = writes.filter((r) => r.method === 'answer');
      assert.ok(answers.length >= 2);
      for (const retry of answers.slice(1)) assert.deepEqual(answers[0], retry);
    }
    assert.deepEqual(errors, []);
    let video;
    if (mode === 'delayed') {
      video = page.video();
    }
    await page.reload();
    await page.getByRole('button', { name: 'Continue your enquiry' }).click();
    await page.getByRole('button', { name: 'Reopen saved enquiry' }).click();
    await expect(page.getByRole('heading', { name: 'Your enquiry is saved.' })).toBeVisible();
    await page.waitForTimeout(750);
    assert.equal(await page.locator('.completion-enter').count(), 0);
    const returnEvents = await page.evaluate(() => window.__completionEvents);
    assert.equal(
      returnEvents.some((e) => e.state === 'entering'),
      false,
    );
    reports.push({
      ...scenario,
      finalClickAt,
      pageBornAt,
      serverAnswerReplyAt: ack.serverReplyAt,
      clientAnswerAckAt: answerAck.at,
      clientResumeAckAt: resumeAck.at,
      parsedCompletedResumeAt: timeline.completedResumeBodyAt,
      answerToResumeMs: resumeAck.at - answerAck.at,
      doubleNativeClick: mode === 'delayed' && scenario.width === 390,
      events,
      heldHeadingCallbacks: held,
      receiptControlsAndSummaryKeepFocus: true,
      returnStatic: true,
      writes,
      errors,
    });
    await context.close();
    if (video) await video.saveAs(`${out}/videos/completion-${scenario.width}.webm`);
  }
  await writeFile(
    out + '/evidence.json',
    JSON.stringify(
      {
        label:
          'Actual compiled app, original controls, strict local HTTP fixtures; no intercepts/live writes/email. Instrumented heading callbacks only for focus regression.',
        reports,
      },
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
