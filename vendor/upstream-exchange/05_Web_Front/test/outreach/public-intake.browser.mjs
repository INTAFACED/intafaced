// Local browser proof. All service replies are fixtures; this never submits a live enquiry.
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { applyPlaywrightBrowsersEnv } from '../../../../../tooling/uiproof/playwright-browsers.mjs';

const front = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const root = resolve(front, '../../..');
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
const proof = '/tmp/intafaced-outreach-quality-journey-proof';
await (await import('node:fs/promises')).mkdir(proof, { recursive: true });
async function fixtures(context, options = {}) {
  let draft,
    firstCapture = !!options.loseCapture,
    lostAnswer = !!options.loseAnswer;
  const captureRequests = [],
    answerRequests = [],
    receipts = new Map(),
    answers = new Map();
  await context.route('**/api/ops/trpc/outreach.*', async (route) => {
    const request = route.request(),
      input = request.postDataJSON();
    assert.equal(request.method(), 'POST');
    assert.equal(request.headers().authorization, undefined);
    assert.equal(new URL(request.url()).search, '');
    let data;
    if (request.url().endsWith('.capture')) {
      captureRequests.push(input);
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
      answerRequests.push(input);
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
      assert.equal(input.expectedRevision, draft.revision);
      draft.contact.interests.push(...input.interests.filter((a) => !draft.contact.interests.includes(a)));
      draft.revision++;
      draft.completedAt = null;
      data = draft;
    } else data = draft;
    await route.fulfill({ json: { result: { data } } });
  });
  return { captureRequests, answerRequests, draft: () => draft };
}
async function begin(page, investor = true) {
  await page.getByRole('button', { name: investor ? 'Start enquiry' : 'Start a conversation', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tell us about yourself', exact: true })).toBeVisible();
}
async function fillContact(page, remember = false) {
  await page.getByLabel('Your name').fill('Local proof visitor');
  await page.getByLabel('Email', { exact: false }).fill('proof@example.com');
  await page.getByLabel('Organisation', { exact: false }).fill('Local proof');
  await page.getByLabel('Country', { exact: false }).selectOption('ID');
  if (remember) {
    await page.locator('.recovery-options summary').click();
    await page.getByRole('checkbox', { name: 'Remember my draft on this device.' }).check();
    await page.locator('.recovery-options summary').click();
  }
  await page.getByRole('button', { name: 'Save details & continue' }).click();
}
async function showDraftStatus(page) {
  const details = page.locator('.draft-recovery');
  if ((await details.getAttribute('open')) === null) await details.locator('summary').click();
}
async function continueGroup(page) {
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
}
async function review(page, timing = 'later') {
  await page.getByLabel('When would you consider taking part?').selectOption(timing);
  await page.getByRole('button', { name: 'Review your answers' }).click();
  await expect(page.getByRole('heading', { name: 'Review your answers', exact: true })).toBeVisible();
  await expect(page.locator('.question-segments [aria-current="step"]')).toContainText('Review');
  await page.waitForFunction(
    () => getComputedStyle(document.querySelector('.question-segments [aria-current="step"]')).borderTopColor === 'rgb(185, 246, 90)',
  );
}
async function reopen(page) {
  await page.getByRole('button', { name: 'Continue your enquiry' }).click();
  await page.getByRole('button', { name: 'Reopen saved enquiry' }).click();
}
async function geometry(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal overflow');
  assert.equal(await page.evaluate(() => document.fonts.check('16px "Outreach Inter"')), true, 'real Inter font loads');
  const reduced = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (reduced && (await page.locator('.welcome-content').count()))
    assert.equal(
      await page.locator('.welcome-content').evaluate((el) => getComputedStyle(el).animationName),
      'none',
      'reduced motion removes the welcome reveal',
    );
  assert.ok(
    await page.getByRole('img', { name: 'INTAFACED', exact: true }).evaluate((img) => img.complete && img.naturalWidth > 0),
    'actual logo loads',
  );
}
try {
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  for (const width of [1280, 1440, 390, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 850 },
      reducedMotion: width === 320 ? 'reduce' : 'no-preference',
      ...(width === 1280 ? { recordVideo: { dir: proof, size: { width: 1280, height: 850 } } } : {}),
    });
    let page = await context.newPage();
    const errors = [];
    context.on('page', (p) => p.on('pageerror', (e) => errors.push(e.message)));
    page.on('pageerror', (e) => errors.push(e.message));
    const api = await fixtures(context, { loseCapture: true, loseAnswer: true });
    await page.goto(origin + '/invest');
    await expect(page.getByRole('heading', { name: 'Discuss the INTAFACED raise.' })).toBeVisible();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.welcome-content')).opacity === '1');
    await page.screenshot({ path: `${proof}/invest-welcome-${width}.png`, fullPage: true });
    await geometry(page);
    const firstAction = await page.getByRole('button', { name: 'Start enquiry', exact: true }).boundingBox();
    assert.ok(firstAction.y + firstAction.height <= 850, 'first meaningful action fits the welcome viewport');
    await page.keyboard.press('Tab');
    await expect(page.getByText('Skip to main content', { exact: true })).toBeFocused();
    await begin(page);
    await page.screenshot({ path: `${proof}/invest-contact-${width}.png`, fullPage: true });
    await page.getByRole('button', { name: 'Change interests' }).click();
    for (const label of ['Investor', 'Trader', 'Merchant', 'Academy', 'Partner'])
      await page.getByRole('checkbox', { name: new RegExp('^' + label) }).check();
    await fillContact(page, true);
    await expect(page.getByRole('alert')).toContainText('could not confirm');
    await page.getByRole('button', { name: 'Reopen saved enquiry' }).click();
    await expect(page.getByRole('heading', { name: 'Investor enquiry', exact: true })).toBeVisible();
    assert.equal(api.captureRequests[0].requestId, api.captureRequests[1].requestId);
    assert.equal(api.captureRequests[0].contact.marketingOptIn, false);
    await page.getByRole('radio', { name: 'I’m considering investing' }).check();
    await page.getByLabel('Which best describes you or the organisation you represent?').selectOption('individual');
    await page.getByLabel('What is your role in the decision?').selectOption('decision_maker');
    await showDraftStatus(page);
    await expect(page.getByRole('status').filter({ hasText: 'Draft kept on this device' })).toBeVisible();
    await page.screenshot({ path: `${proof}/invest-questions-${width}.png`, fullPage: true });
    const welcomeVideo = page.video();
    await page.close();
    if (welcomeVideo) await welcomeVideo.saveAs(`${proof}/investor-desktop-welcome-contact.webm`);
    page = await context.newPage();
    await page.goto(origin + '/invest');
    await reopen(page);
    await expect(page.getByRole('radio', { name: 'I’m considering investing' })).toBeChecked();
    await expect(page.getByLabel('What is your role in the decision?')).toHaveValue('decision_maker');
    await continueGroup(page);
    await page.getByRole('radio', { name: 'Share an indicative amount' }).check();
    await page.getByLabel('Amount', { exact: true }).fill('9007199254740993.000000000000000001');
    await page.getByLabel('Currency', { exact: true }).selectOption('USD');
    if (width === 390) {
      await page.setViewportSize({ width, height: 420 });
      await page.getByLabel('Amount', { exact: true }).click();
      const inputBox = await page.getByLabel('Amount', { exact: true }).boundingBox();
      assert.ok(inputBox.y >= 0 && inputBox.y + inputBox.height <= 420, 'active input remains usable in a reduced keyboard viewport');
      await page.screenshot({ path: `${proof}/keyboard-viewport-${width}.png` });
      await page.setViewportSize({ width, height: 850 });
    }
    await review(page, 'undecided');
    await page.screenshot({ path: `${proof}/invest-review-${width}.png`, fullPage: true });
    await page.getByRole('button', { name: 'Edit answers' }).click();
    await expect(page.getByLabel('Amount', { exact: true })).toHaveValue('9007199254740993.000000000000000001');
    await review(page, 'undecided');
    await page.getByRole('button', { name: 'Send enquiry', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('could not confirm');
    await page.reload();
    await reopen(page);
    await expect(page.getByRole('heading', { name: 'Tell us about your trading interests' })).toBeVisible();
    await page.screenshot({ path: `${proof}/trader-questions-${width}.png`, fullPage: true });
    assert.equal(api.answerRequests[0].questionnaire.answers.indicativeContribution.amount, '9007199254740993.000000000000000001');
    await page.getByRole('checkbox', { name: 'Spot', exact: true }).check();
    await page.getByRole('radio', { name: 'Advanced', exact: true }).check();
    await page.getByRole('radio', { name: 'Professional', exact: true }).check();
    await page.getByLabel('What would you like from a trading platform?').fill('API access');
    await continueGroup(page);
    await review(page);
    await page.getByRole('button', { name: 'Send enquiry', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Tell us about your payment needs' })).toBeVisible();
    await page.screenshot({ path: `${proof}/merchant-questions-${width}.png`, fullPage: true });
    await page.getByLabel('Business name').fill('Example');
    await page.getByLabel('Industry').fill('Retail');
    await page.getByLabel('Operating countries', { exact: true }).selectOption(['ID', 'SG']);
    await page.getByRole('checkbox', { name: 'Payment acceptance' }).check();
    await continueGroup(page);
    await page.getByRole('radio', { name: 'Share an indicative amount' }).check();
    await page.getByLabel('Amount', { exact: true }).fill('0.000000000000000001');
    await page.getByLabel('Currency', { exact: true }).selectOption('IDR');
    await page.getByLabel('Volume period').selectOption('monthly');
    await review(page, 'as_available');
    await page.getByRole('button', { name: 'Send enquiry', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'What would you like to learn?', exact: true })).toBeVisible();
    await page.screenshot({ path: `${proof}/academy-questions-${width}.png`, fullPage: true });
    await page.getByRole('textbox', { name: 'What would you like to learn?', exact: true }).fill('Markets');
    await page.getByRole('radio', { name: 'Beginner', exact: true }).check();
    await page.getByLabel('Preferred subjects').fill('Risk, Markets');
    await page.getByLabel('Preferred learning format').selectOption('live');
    await continueGroup(page);
    await review(page, 'within_three_months');
    await page.getByRole('button', { name: 'Send enquiry', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Tell us about a potential collaboration' })).toBeVisible();
    await page.screenshot({ path: `${proof}/partner-questions-${width}.png`, fullPage: true });
    await page.getByLabel('Your expertise').fill('Education');
    await page.getByLabel('What would you like to contribute?').fill('A learning community');
    await page.getByRole('radio', { name: 'Collaboration', exact: true }).check();
    await continueGroup(page);
    await review(page);
    await page.getByRole('button', { name: 'Send enquiry', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your enquiry is with the team.' })).toBeVisible();
    assert.equal(api.draft().questionnaires.length, 5);
    assert.equal(new Set(api.draft().questionnaires.map((q) => q.audience)).size, 5);
    await page.screenshot({ path: `${proof}/complete-${width}.png`, fullPage: true });
    await geometry(page);
    const protectedEntry = await page.evaluate(async () => {
      let db = await new Promise((r) => {
        let q = indexedDB.open('intafaced-enquiry-drafts', 1);
        q.onsuccess = () => r(q.result);
      });
      return new Promise((r) => {
        let q = db.transaction('protected-drafts').objectStore('protected-drafts').get('current');
        q.onsuccess = () =>
          r({
            extractable: q.result.key.extractable,
            plaintext: JSON.stringify(q.result),
            ciphertextBytes: q.result.ciphertext.byteLength,
          });
      });
    });
    assert.equal(protectedEntry.extractable, false);
    assert.ok(protectedEntry.ciphertextBytes > 0);
    assert.ok(!protectedEntry.plaintext.includes('proof@example.com'));
    assert.ok(!protectedEntry.plaintext.includes(api.captureRequests[0].continuationToken));
    assert.deepEqual(errors, []);
    const questionsVideo = page.video();
    await context.close();
    if (questionsVideo) await questionsVideo.saveAs(`${proof}/investor-desktop-review-completion.webm`);
    console.log(
      `public ${width}px: all five enquiries, real font/logo, device reopen, unsent review/edit, lost response recovery, decimal strings, encrypted capability and overflow passed`,
    );
  }
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 850 } });
    const api = await fixtures(context);
    const page = await context.newPage();
    await page.goto(origin + '/invest');
    await begin(page);
    await page.screenshot({ path: `${proof}/introducer-contact-${width}.png`, fullPage: true });
    await fillContact(page, true);
    await page.getByRole('radio', { name: 'I can introduce an investor' }).check();
    await page.getByLabel('Which best describes you or the organisation you represent?').selectOption('individual');
    await page.getByLabel('What is your role in the decision?').selectOption('introducer');
    await continueGroup(page);
    await expect(page.getByText('What amount are you considering?', { exact: false })).toHaveCount(0);
    await page.getByLabel('What would you like us to know?', { exact: false }).fill('I can make an introduction.');
    await review(page);
    await expect(page.getByText('Not requested for an introduction')).toBeVisible();
    await page.screenshot({ path: `${proof}/introducer-review-${width}.png`, fullPage: true });
    await page.getByRole('button', { name: 'Send enquiry', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your enquiry is with the team.', exact: true })).toBeVisible();
    assert.deepEqual(api.answerRequests[0].questionnaire.answers.indicativeContribution, { status: 'undecided' });
    await page.locator('.saved-contact-details summary').click();
    await page.getByRole('button', { name: 'Add an interest' }).click();
    await page.getByRole('checkbox', { name: /^Academy/ }).check();
    await page.getByRole('button', { name: 'Add & continue' }).click();
    await expect(page.getByRole('heading', { name: 'What would you like to learn?', exact: true })).toBeVisible();
    assert.equal(api.draft().questionnaires[0].audience, 'investor');
    assert.equal(api.draft().completedAt, null);
    await showDraftStatus(page);
    await expect(page.getByRole('status').filter({ hasText: 'Draft kept on this device' })).toBeVisible();
    await page.evaluate(async () => {
      const db = await new Promise((r) => {
        const q = indexedDB.open('intafaced-enquiry-drafts', 1);
        q.onsuccess = () => r(q.result);
      });
      await new Promise((r) => {
        const tx = db.transaction('protected-drafts', 'readwrite'),
          q = tx.objectStore('protected-drafts').get('current');
        q.onsuccess = () => {
          const value = q.result;
          value.expiresAt = '2020-01-01T00:00:00Z';
          tx.objectStore('protected-drafts').put(value, 'current');
        };
        tx.oncomplete = r;
      });
    });
    await page.close();
    const fresh = await context.newPage();
    await fresh.goto(origin + '/invest');
    await expect(fresh.getByRole('status')).toContainText('previous draft access expired');
    await expect(fresh.getByRole('button', { name: 'Start enquiry', exact: true })).toBeVisible();
    await context.close();
    console.log(`introducer ${width}px: truthful amount skip, final write, append interests and device expiry passed`);
  }
  // Recovery consent boundaries: refresh works by default; a closed tab does not persist without opt-in.
  const tabContext = await browser.newContext({ viewport: { width: 390, height: 850 } });
  await fixtures(tabContext);
  let tabPage = await tabContext.newPage();
  await tabPage.goto(origin + '/invest');
  await begin(tabPage);
  await expect(tabPage.getByRole('checkbox', { name: 'Remember my draft on this device.', includeHidden: true })).not.toBeChecked();
  await fillContact(tabPage);
  await tabPage.getByRole('radio', { name: 'Both', exact: true }).check();
  await showDraftStatus(tabPage);
  await expect(tabPage.getByRole('status').filter({ hasText: 'Draft kept in this tab' })).toBeVisible();
  await tabPage.reload();
  await reopen(tabPage);
  await expect(tabPage.getByRole('radio', { name: 'Both', exact: true })).toBeChecked();
  await tabPage.close();
  tabPage = await tabContext.newPage();
  await tabPage.goto(origin + '/invest');
  await expect(tabPage.getByRole('button', { name: 'Start enquiry', exact: true })).toBeVisible();
  await tabContext.close();
  console.log('default privacy: refresh restores unsent choices; tab closure does not retain a device draft without opt-in');

  const blocked = await browser.newContext({ viewport: { width: 390, height: 850 } });
  await blocked.addInitScript(() => {
    Object.defineProperty(window, 'sessionStorage', {
      get() {
        throw new Error('disabled');
      },
    });
    Object.defineProperty(window, 'indexedDB', { value: undefined });
  });
  const blockedApi = await fixtures(blocked, { loseCapture: true });
  const blockedPage = await blocked.newPage();
  await blockedPage.goto(origin + '/invest');
  await begin(blockedPage);
  await expect(blockedPage.getByRole('checkbox', { name: 'Remember my draft on this device.', includeHidden: true })).toBeDisabled();
  await fillContact(blockedPage);
  await expect(blockedPage.getByRole('alert')).toContainText('could not confirm');
  await blockedPage.getByRole('button', { name: 'Reopen saved enquiry' }).click();
  await expect(blockedPage.getByRole('heading', { name: 'Investor enquiry', exact: true })).toBeVisible();
  await showDraftStatus(blockedPage);
  await expect(blockedPage.getByRole('status').filter({ hasText: 'cannot be stored' })).toContainText('cannot be stored');
  assert.equal(blockedApi.captureRequests[0].requestId, blockedApi.captureRequests[1].requestId);
  await blocked.close();
  console.log('blocked storage: honest resume limitation and stable in-memory capture retry passed');

  const forgetContext = await browser.newContext({ viewport: { width: 390, height: 850 } });
  await fixtures(forgetContext);
  const forgetPage = await forgetContext.newPage();
  await forgetPage.goto(origin + '/invest');
  await begin(forgetPage);
  await fillContact(forgetPage, true);
  await showDraftStatus(forgetPage);
  await expect(forgetPage.getByRole('status').filter({ hasText: 'Draft kept on this device' })).toBeVisible();
  await forgetPage.getByRole('button', { name: 'Privacy & your enquiry ↗', exact: true }).last().click();
  await expect(forgetPage.getByRole('heading', { name: 'Your enquiry, thoughtfully handled.' })).toBeFocused();
  forgetPage.on('dialog', (dialog) => dialog.accept());
  await forgetPage.getByRole('button', { name: 'Forget local draft', exact: true }).click();
  await expect(forgetPage.getByRole('button', { name: 'Start enquiry', exact: true })).toBeVisible();
  assert.equal(await forgetPage.evaluate(() => sessionStorage.getItem('intafaced.outreach.continuation.v1')), null);
  const remaining = await forgetPage.evaluate(async () => {
    const db = await new Promise((r) => {
      const q = indexedDB.open('intafaced-enquiry-drafts', 1);
      q.onsuccess = () => r(q.result);
    });
    return new Promise((r) => {
      const q = db.transaction('protected-drafts').objectStore('protected-drafts').count();
      q.onsuccess = () => r(q.result);
    });
  });
  assert.equal(remaining, 0);
  await forgetContext.close();
  console.log('forget: privacy explanation reachable and both local continuation stores durably removed');
} finally {
  if (browser) await browser.close();
  await new Promise((r) => server.close(r));
}
