import {
  outreachCaptureInputSchema,
  outreachQuestionnaireInputSchema as outreachAnswerInputSchema,
  outreachAddInterestsInputSchema,
  outreachContinuationInputSchema as outreachResumeInputSchema,
} from '../../../packages/contracts/dist/index.js';
// Local browser proof. All service replies are fixtures; this never submits a live enquiry.
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { applyPlaywrightBrowsersEnv } from '../../../tooling/uiproof/playwright-browsers.mjs';

const front = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(front, '../..');
const { executablePath } = applyPlaywrightBrowsersEnv({ repoRoot: root });
const server = createServer(async (request, response) => {
  const requested = new URL(request.url, 'http://localhost').pathname;
  const file = requested.startsWith('/assets/') ? resolve(front, 'dist', '.' + requested) : resolve(front, 'dist/index.html');
  if (!file.startsWith(resolve(front, 'dist') + '/')) {
    response.writeHead(404).end();
    return;
  }
  try {
    const data = await readFile(file);
    const type =
      {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.webp': 'image/webp',
        '.woff2': 'font/woff2',
      }[extname(file)] || 'application/octet-stream';
    response.writeHead(200, { 'content-type': type }).end(data);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

let browser;
const proof = '/tmp/intafaced-outreach-react-invitation-focus-proof';
await (await import('node:fs/promises')).mkdir(proof, { recursive: true });
async function fixtures(context, options = {}) {
  let draft,
    firstCapture = !!options.loseCapture,
    lostAnswer = !!options.loseAnswer,
    blockedAnswer = !!options.loseAnswerBeforeWrite,
    blockedExtension = !!options.loseExtensionBeforeWrite;
  const captureRequests = [],
    answerRequests = [],
    extensionRequests = [],
    receipts = new Map(),
    answers = new Map();
  await context.route('**/api/ops/trpc/outreach.*', async (route) => {
    const request = route.request(),
      input = request.postDataJSON();
    const method = request.url().split('.').pop();
    ({
      capture: outreachCaptureInputSchema,
      answer: outreachAnswerInputSchema,
      addInterests: outreachAddInterestsInputSchema,
      resume: outreachResumeInputSchema,
    })[method].parse(input);
    assert.equal(request.method(), 'POST');
    assert.equal(request.headers().authorization, undefined);
    assert.equal(new URL(request.url()).search, '');
    let data;
    if (request.url().endsWith('.capture')) {
      captureRequests.push(structuredClone(input));
      if (!receipts.has(input.requestId)) {
        const now = new Date().toISOString();
        draft = {
          submissionId: randomUUID(),
          revision: 1,
          capturedAt: now,
          continuationExpiresAt: new Date(Date.now() + 86400000).toISOString(),
          contact: input.contact,
          questionnaires: [],
          completedAt: null,
        };
        receipts.set(input.requestId, {
          submissionId: draft.submissionId,
          revision: 1,
          capturedAt: now,
          continuationExpiresAt: draft.continuationExpiresAt,
        });
      }
      data = receipts.get(input.requestId);
      if (firstCapture) {
        firstCapture = false;
        await route.abort('failed');
        return;
      }
    } else if (request.url().endsWith('.answer')) {
      answerRequests.push(structuredClone(input));
      if (blockedAnswer) {
        blockedAnswer = false;
        await route.abort('failed');
        return;
      }
      if (!answers.has(input.requestId)) {
        assert.equal(input.expectedRevision, draft.revision);
        assert.ok(!draft.questionnaires.some((q) => q.audience === input.questionnaire.audience));
        draft.questionnaires.push(input.questionnaire);
        draft.revision += 1;
        if (draft.questionnaires.length === draft.contact.interests.length) draft.completedAt = new Date().toISOString();
        answers.set(input.requestId, structuredClone(draft));
      }
      data = answers.get(input.requestId);
      if (lostAnswer) {
        lostAnswer = false;
        await route.abort('failed');
        return;
      }
    } else if (request.url().endsWith('.addInterests')) {
      extensionRequests.push(structuredClone(input));
      if (blockedExtension) {
        blockedExtension = false;
        await route.abort('failed');
        return;
      }
      assert.equal(input.expectedRevision, draft.revision);
      draft.contact.interests.push(...input.interests.filter((a) => !draft.contact.interests.includes(a)));
      draft.revision++;
      draft.completedAt = null;
      data = draft;
    } else data = draft;
    await route.fulfill({ json: { result: { data } } });
  });
  return { captureRequests, answerRequests, extensionRequests, draft: () => draft };
}

function control(page, name) {
  return page.getByLabel(name, { exact: false }).and(page.locator('input,select,textarea'));
}
async function next(page) {
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('#intake-heading')).toBeFocused();
}
try {
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 850 } });
    const api = await fixtures(context);
    let page = await context.newPage();
    await page.goto(origin + '/invest');
    await page.getByRole('button', { name: 'Begin', exact: true }).click();
    await control(page, 'Your name').fill('Local focus proof');
    await control(page, 'Email').fill('focus@example.invalid');
    await page.locator('.optional-details>summary').click();
    await page.locator('.recovery-options summary').click();
    await page.getByRole('checkbox', { name: 'Remember my draft on this device.' }).check();
    await page.getByRole('button', { name: 'Save details & continue' }).click();
    await page.getByRole('button', { name: 'I can introduce an investor', exact: true }).click();
    await next(page);
    await control(page, 'Which best describes you').selectOption('individual');
    await next(page);
    await control(page, 'What is your role').selectOption('introducer');
    await next(page);
    await control(page, 'When would you consider').selectOption('later');
    // Simulate a delayed display frame, then begin real keyboard entry immediately.
    // There is deliberately no wait for heading focus before the first character.
    await page.evaluate(() => {
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) => raf((time) => setTimeout(() => callback(time), 200));
    });
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    const message = 'A relevant introduction with full context.';
    await control(page, 'What would you like us to know?').pressSequentially(message, { delay: 60 });
    await expect(control(page, 'What would you like us to know?')).toBeFocused();
    await expect(control(page, 'What would you like us to know?')).toHaveValue(message);
    await page.getByRole('button', { name: 'Review your answers' }).click();
    await expect(page.getByText(message, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Edit answers' }).click();
    for (let i = 0; i < 4; i++) await next(page);
    await expect(control(page, 'What would you like us to know?')).toHaveValue(message);
    const edited = message + ' Please reply by email.';
    await control(page, 'What would you like us to know?').focus();
    await control(page, 'What would you like us to know?').evaluate((field) =>
      field.setSelectionRange(field.value.length, field.value.length),
    );
    await control(page, 'What would you like us to know?').pressSequentially(' Please reply by email.', { delay: 60 });
    await expect(control(page, 'What would you like us to know?')).toHaveValue(edited);
    await page.getByRole('button', { name: 'Review your answers' }).click();
    await page.locator('.draft-recovery>summary').click();
    await expect(page.getByRole('status').filter({ hasText: 'Draft kept on this device' })).toBeVisible();
    await page.close();
    page = await context.newPage();
    await page.goto(origin + '/invest');
    await page.getByRole('button', { name: 'Continue your enquiry' }).click();
    await page.getByRole('button', { name: 'Reopen saved enquiry' }).click();
    await expect(page.getByText(edited, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Send enquiry', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your enquiry is saved.' })).toBeVisible();
    assert.equal(api.answerRequests.length, 1);
    assert.equal(api.answerRequests[0].questionnaire.answers.message, edited);
    assert.equal(api.answerRequests[0].questionnaire.answers.participation, 'introduction');
    await page.screenshot({ path: proof + '/completed-' + width + '.png', fullPage: true });
    await context.close();
    console.log(
      `focus ${width}px: delayed heading focus preserves immediate sequential typing, review, unsent edit, actual tab reopen and exact wire message`,
    );
  }
} finally {
  if (browser) await browser.close();
  await new Promise((r) => server.close(r));
}
