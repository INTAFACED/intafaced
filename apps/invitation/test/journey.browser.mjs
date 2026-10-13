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
import { AMOUNT_ERROR, parseAmount, storedAmount } from '../src/lib/amount.ts';
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

// The amount rule itself, as a table: what is accepted (and what it becomes) and what is never normalised.
for (const [typed, plain] of [
  ['150000', '150000'],
  ['150000.50', '150000.50'],
  ['0.5', '0.5'],
  ['150,000', '150000'],
  ['1,250,000.50', '1250000.50'],
  ['150 000', '150000'],
  ['1 250 000.5', '1250000.5'],
  ['150\u00a0000', '150000'],
  [' 150000 ', '150000'],
  ['150.000', '150.000'],
])
  assert.deepEqual(parseAmount(typed), { kind: 'valid', plain }, `valid amount ${JSON.stringify(typed)}`);
for (const typed of [
  '1,5',
  '1.000,50',
  '1e5',
  '-5',
  '1,2,3',
  '1.5.',
  ' ',
  '1 250,000',
  '1,250 000',
  '1,50,000',
  '150,00',
  '1234,567',
  '01',
  '12a',
  '$5',
  '.5',
  '5.',
  ',',
])
  assert.deepEqual(parseAmount(typed), { kind: 'invalid', plain: '' }, `invalid amount ${JSON.stringify(typed)}`);
assert.equal(parseAmount('').kind, 'empty');
assert.equal(storedAmount('1,5'), '1,5', 'an invalid amount is stored exactly as typed, never repaired');
assert.equal(storedAmount('150,000'), '150000', 'a legacy grouped value reads back as the plain string');

let browser;
const proof = '/tmp/intafaced-outreach-react-invitation-journey-proof';
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
async function chooseInterest(page, name) {
  const choice = page.getByRole('checkbox', { name });
  if ((await choice.getAttribute('aria-checked')) !== 'true') await choice.click();
}
function control(page, label, options) {
  return page.getByLabel(label, options).and(page.locator('input, select, textarea'));
}
async function begin(page, investor = true) {
  await page.getByRole('button', { name: 'Begin', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Let’s start with you.', exact: true })).toBeVisible();
}
const TIMING = {
  as_available: 'When available',
  within_three_months: 'Within three months',
  later: 'Later',
  undecided: 'I’m not sure yet',
};
// Single-choice questions with more than three options are answer cards (radiogroup > radio).
async function choose(page, group, label) {
  await page.getByRole('radiogroup', { name: group, exact: true }).getByRole('radio', { name: label, exact: true }).check();
}
// Currency and country are searchable pickers (Base UI combobox): type, then pick the option.
async function pick(page, label, text, option = text) {
  const box = page.getByRole('combobox', { name: label, exact: true });
  await box.click();
  await box.fill(text);
  await page.getByRole('option', { name: option }).first().click();
}
async function fillContact(page, remember = false, onSecondScreen = async () => {}) {
  await control(page, 'Your name').fill('Local proof visitor');
  await control(page, 'Email', { exact: false }).fill('proof@example.com');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A little more, if you like.', exact: true })).toBeFocused();
  await control(page, 'Organisation', { exact: false }).fill('Local proof');
  await onSecondScreen(page);
  await pick(page, 'Country (optional)', 'Indonesia');
  if (remember) await page.getByRole('checkbox', { name: 'Remember my draft on this device.' }).check();
  await page.getByRole('button', { name: 'Save details & continue' }).click();
}
async function openDeviceDetails(page) {
  const details = page.locator('.saved-contact-details');
  if ((await details.getAttribute('open')) === null) await details.locator('summary').click();
  return details;
}
async function showSavedStatus(page) {
  await expect(page.locator('.draft-status')).toHaveText('Draft saved ✓');
}
async function continueGroup(page) {
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('#intake-heading')).toBeFocused();
}
async function review(page, timing = 'later', message = '') {
  if (
    (await page.getByRole('button', { name: 'Not decided yet', exact: true }).count()) ||
    (await page.getByRole('button', { name: 'Not sure yet', exact: true }).count())
  )
    await continueGroup(page);
  await choose(page, 'When would you consider taking part?', TIMING[timing]);
  await continueGroup(page);
  await control(page, 'What would you like us to know?', { exact: false }).fill(message);
  await page.getByRole('button', { name: 'Review your answers' }).click();
  await expect(page.getByRole('heading', { name: 'Before you send.', exact: true })).toBeVisible();
}
async function reopen(page) {
  await page.getByRole('button', { name: 'Continue your enquiry' }).click();
  await page.getByRole('button', { name: 'Reopen saved enquiry' }).click();
}
// The entrance animations sit on the welcome content's children, not on .welcome-content itself. Returns every one
// that still animates (empty when still), and fails loudly if the elements it is meant to inspect are not there.
const WELCOME_ANIMATED = [
  '.welcome-logo',
  '.h1-line',
  '.welcome-description',
  '.welcome-action',
  '.hero-cta',
  '.welcome-content > .outreach-small',
];
async function welcomeMotion(page) {
  return page.evaluate((selectors) => {
    const found = [];
    const moving = [];
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        found.push(selector);
        const name = getComputedStyle(el).animationName;
        const running = el.getAnimations().filter((a) => a.playState === 'running').length;
        if (name !== 'none' || running) moving.push(`${selector}: ${name}, ${running} running`);
      }
    }
    if (found.length < selectors.length)
      throw new Error('welcome motion check found no element for some selectors: ' + selectors.filter((x) => !found.includes(x)));
    return moving;
  }, WELCOME_ANIMATED);
}
async function geometry(page) {
  assert.equal(await page.locator('[data-framework=react]').count(), 1);
  assert.equal(await page.locator('.ivu-loading-bar,.ivu-menu').count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal overflow');
  assert.equal(
    await page.evaluate(() => {
      const bar = document.querySelector('.ivu-loading-bar');
      return !bar || getComputedStyle(bar).display === 'none';
    }),
    true,
    'legacy route-complete loading bar is hidden for outreach',
  );
  assert.equal(await page.evaluate(() => document.fonts.check('16px "Outreach Inter"')), true, 'real Inter font loads');
  const reduced = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (reduced && (await page.locator('.welcome-content').count()))
    assert.deepEqual(await welcomeMotion(page), [], 'reduced motion removes the welcome reveal from every element that carries it');
  assert.ok(
    await page.getByRole('img', { name: 'INTAFACED', exact: true }).evaluate((img) => img.complete && img.naturalWidth > 0),
    'actual logo loads',
  );
  assert.equal(await page.locator('header, footer').count(), 0, 'no header or footer chrome in the corners');
}
try {
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  for (const width of process.env.OUTREACH_PROOF_SLICE === 'recovery' ? [] : [1280, 1440, 390, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 850 },
      reducedMotion: width === 320 ? 'reduce' : 'no-preference',
      ...(width === 1280 ? { recordVideo: { dir: proof, size: { width: 1280, height: 850 } } } : {}),
    });
    // A heavily loaded machine can need longer; OUTREACH_PROOF_TIMEOUT raises it without changing the proof.
    context.setDefaultTimeout(Number(process.env.OUTREACH_PROOF_TIMEOUT) || 10000);
    let page = await context.newPage();
    const errors = [];
    context.on('page', (p) => p.on('pageerror', (e) => errors.push(e.message)));
    page.on('pageerror', (e) => errors.push(e.message));
    const api = await fixtures(context, { loseCapture: true, loseAnswer: true });
    await page.goto(origin + '/invest');
    await expect(page.getByRole('heading', { name: 'A conversation about INTAFACED.' })).toBeVisible();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.welcome-content')).opacity === '1');
    await page.screenshot({ path: `${proof}/invest-welcome-${width}.png`, fullPage: true });
    await geometry(page);
    if (width === 320) {
      // Positive control: the motion check can fail. Put a running animation on a child and it must be reported.
      const control = await page.addStyleTag({
        content: '.outreach-page .h1-line{animation:control-spin 4s linear infinite !important}@keyframes control-spin{to{opacity:.99}}',
      });
      assert.ok((await welcomeMotion(page)).length > 0, 'the reduced-motion check reports a child that animates');
      await control.evaluate((el) => el.remove());
      assert.deepEqual(await welcomeMotion(page), []);
    }
    const firstAction = await page.getByRole('button', { name: 'Begin', exact: true }).boundingBox();
    assert.ok(firstAction.y + firstAction.height <= 850, 'first meaningful action fits the welcome viewport');
    await page.keyboard.press('Tab');
    await expect(page.getByText('Skip to main content', { exact: true })).toBeFocused();
    await begin(page);
    await page.screenshot({ path: `${proof}/invest-contact-${width}.png`, fullPage: true });
    await page.getByRole('button', { name: 'Change interests' }).click();
    for (const label of ['Investor', 'Trader', 'Merchant', 'Academy', 'Partner']) await chooseInterest(page, new RegExp('^' + label));
    await continueGroup(page);
    await fillContact(page, true);
    await expect(page.getByRole('alert')).toContainText('could not confirm');
    assert.equal(api.captureRequests.length, 1, 'an unknown capture is never automatically retried');
    await page.getByRole('button', { name: 'Reopen saved enquiry' }).click();
    await expect(page.getByRole('heading', { name: 'How would you like to take part?', exact: true })).toBeFocused();
    assert.equal(api.captureRequests[0].requestId, api.captureRequests[1].requestId);
    assert.equal(api.captureRequests[0].contact.marketingOptIn, false);
    assert.equal(api.captureRequests[0].contact.country, 'ID', 'country picker value reaches the wire as its code');
    await page.getByRole('button', { name: 'I’m considering investing' }).click();
    assert.equal(api.answerRequests.length, 0);
    await continueGroup(page);
    await choose(page, 'Which best describes you or the organisation you represent?', 'Individual');
    await continueGroup(page);
    await choose(page, 'What is your role in the decision?', 'I make investment decisions');
    await showSavedStatus(page);
    await expect(page.getByText('Draft and recovery')).toHaveCount(0);
    await expect(page.getByText('View your saved details')).toHaveCount(0);
    await page.screenshot({ path: `${proof}/invest-questions-${width}.png`, fullPage: true });
    const welcomeVideo = page.video();
    await page.close();
    if (welcomeVideo)
      await welcomeVideo
        .saveAs(`${proof}/investor-desktop-welcome-contact.webm`)
        .catch((e) => console.warn('video evidence not saved (recorder unavailable):', e.code || e.message));
    page = await context.newPage();
    await page.goto(origin + '/invest');
    await reopen(page);
    await expect(page.getByRole('radio', { name: 'I make investment decisions', exact: true })).toBeChecked();
    await page.getByRole('button', { name: 'Back', exact: false }).click();
    await page.getByRole('button', { name: 'Back', exact: false }).click();
    await expect(page.getByRole('button', { name: 'I’m considering investing' })).toHaveAttribute('aria-pressed', 'true');
    await continueGroup(page);
    await expect(page.getByRole('radio', { name: 'Individual', exact: true })).toBeChecked();
    await continueGroup(page);
    await expect(page.getByRole('radio', { name: 'I make investment decisions', exact: true })).toBeChecked();
    await continueGroup(page);
    await page.getByRole('button', { name: 'Share an indicative amount' }).click();
    // Digits with comma or space grouping and one decimal point are accepted and shown with separators.
    for (const [typed, shown] of [
      ['150,000', '150,000'],
      ['150 000', '150,000'],
      ['150000', '150,000'],
      ['150000.50', '150,000.50'],
      ['1,250,000.50', '1,250,000.50'],
    ]) {
      await control(page, 'Amount', { exact: true }).fill(typed);
      await control(page, 'Amount', { exact: true }).blur();
      await expect(control(page, 'Amount', { exact: true })).toHaveValue(shown);
    }
    await control(page, 'Amount', { exact: true }).fill('9007199254740993.000000000000000001');
    await control(page, 'Amount', { exact: true }).blur();
    await expect(control(page, 'Amount', { exact: true })).toHaveValue('9,007,199,254,740,993.000000000000000001');
    await pick(page, 'Currency', 'USD', 'US Dollar');
    await expect(page.getByRole('combobox', { name: 'Currency', exact: true })).toHaveValue('US Dollar · USD');
    await expect(page.getByText('Find a currency')).toHaveCount(0);
    if (width === 390) {
      await page.setViewportSize({ width, height: 420 });
      await control(page, 'Amount', { exact: true }).click();
      const inputBox = await control(page, 'Amount', { exact: true }).boundingBox();
      assert.ok(inputBox.y >= 0 && inputBox.y + inputBox.height <= 420, 'active input remains usable in a reduced keyboard viewport');
      await page.screenshot({ path: `${proof}/keyboard-viewport-${width}.png` });
      await page.setViewportSize({ width, height: 850 });
    }
    await review(page, 'undecided');
    await page.screenshot({ path: `${proof}/invest-review-${width}.png`, fullPage: true });
    await page.getByRole('button', { name: 'Edit answers' }).click();
    await continueGroup(page);
    await continueGroup(page);
    await continueGroup(page);
    await expect(control(page, 'Amount', { exact: true })).toHaveValue('9,007,199,254,740,993.000000000000000001');
    await review(page, 'undecided');
    await page.getByRole('button', { name: 'Send enquiry', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('could not confirm');
    await page.reload();
    await reopen(page);
    await expect(page.getByRole('heading', { name: 'Markets you are interested in (select at least one)' })).toBeVisible();
    await page.screenshot({ path: `${proof}/trader-questions-${width}.png`, fullPage: true });
    assert.equal(api.answerRequests[0].questionnaire.answers.indicativeContribution.amount, '9007199254740993.000000000000000001');
    await page.getByRole('checkbox', { name: 'Spot', exact: true }).check();
    await continueGroup(page);
    await page.getByRole('button', { name: 'Advanced', exact: true }).click();
    await continueGroup(page);
    await page.getByRole('button', { name: 'Professional', exact: true }).click();
    await continueGroup(page);
    await control(page, 'What would you like from a trading platform?').fill('API access');
    await continueGroup(page);
    await review(page);
    await page.getByRole('button', { name: 'Send enquiry', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Business name' })).toBeVisible();
    await page.screenshot({ path: `${proof}/merchant-questions-${width}.png`, fullPage: true });
    await control(page, 'Business name').fill('Example');
    await continueGroup(page);
    await continueGroup(page);
    await control(page, 'Industry').fill('Retail');
    await continueGroup(page);
    await pick(page, 'Operating countries', 'Indonesia');
    await pick(page, 'Operating countries', 'Singapore');
    await expect(page.getByRole('button', { name: 'Remove Indonesia' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove Singapore' })).toBeVisible();
    await continueGroup(page);
    await page.getByRole('checkbox', { name: 'Payment acceptance' }).check();
    await continueGroup(page);
    await page.getByRole('button', { name: 'Share an indicative amount' }).click();
    await control(page, 'Amount', { exact: true }).fill('1,250,000.50');
    await pick(page, 'Currency', 'IDR', 'Indonesian Rupiah');
    await page.getByRole('button', { name: 'Monthly', exact: true }).click();
    await review(page, 'as_available');
    if (width > 680) {
      // Eight review rows on a laptop: the main action is still on screen without scrolling.
      const send = await page.getByRole('button', { name: 'Send enquiry', exact: true }).boundingBox();
      assert.ok(
        send.y >= 0 && send.y + send.height <= 850,
        `Send enquiry is above the fold at ${width}px (bottom ${send.y + send.height})`,
      );
    }
    await page.getByRole('button', { name: 'Send enquiry', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'What would you like to learn?', exact: true })).toBeVisible();
    await page.screenshot({ path: `${proof}/academy-questions-${width}.png`, fullPage: true });
    await page.getByRole('textbox', { name: 'What would you like to learn?', exact: true }).fill('Markets');
    await continueGroup(page);
    await page.getByRole('button', { name: 'Beginner', exact: true }).click();
    await continueGroup(page);
    await control(page, 'Preferred subjects').fill('Risk, Markets');
    await continueGroup(page);
    await choose(page, 'Preferred learning format', 'Live');
    await continueGroup(page);
    await review(page, 'within_three_months');
    await page.getByRole('button', { name: 'Send enquiry', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your expertise' })).toBeVisible();
    await page.screenshot({ path: `${proof}/partner-questions-${width}.png`, fullPage: true });
    await control(page, 'Your expertise').fill('Education');
    await continueGroup(page);
    await control(page, 'What would you like to contribute?').fill('A learning community');
    await continueGroup(page);
    await page.getByRole('button', { name: 'Collaboration', exact: true }).click();
    await continueGroup(page);
    await continueGroup(page);
    await review(page);
    await page.getByRole('button', { name: 'Send enquiry', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your enquiry is saved.' })).toBeVisible();
    assert.equal(api.draft().questionnaires.length, 5);
    assert.equal(new Set(api.draft().questionnaires.map((q) => q.audience)).size, 5);
    assert.equal(
      api.draft().questionnaires.find((q) => q.audience === 'merchant').answers.processingVolume.amount,
      '1250000.50',
      'grouped amount is stored as a plain decimal string',
    );
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
    if (questionsVideo)
      await questionsVideo
        .saveAs(`${proof}/investor-desktop-review-completion.webm`)
        .catch((e) => console.warn('video evidence not saved (recorder unavailable):', e.code || e.message));
    console.log(
      `public ${width}px: all five enquiries, real font/logo, device reopen, unsent review/edit, lost response recovery, decimal strings, encrypted capability and overflow passed`,
    );
  }
  for (const width of process.env.OUTREACH_PROOF_SLICE === 'recovery' ? [] : [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 850 } });
    const api = await fixtures(context);
    const page = await context.newPage();
    await page.goto(origin + '/invest');
    await begin(page);
    await page.screenshot({ path: `${proof}/introducer-contact-${width}.png`, fullPage: true });
    await fillContact(page, true);
    await page.getByRole('button', { name: 'I can introduce an investor' }).click();
    await continueGroup(page);
    await choose(page, 'Which best describes you or the organisation you represent?', 'Individual');
    await continueGroup(page);
    await choose(page, 'What is your role in the decision?', 'I make introductions');
    await continueGroup(page);
    await expect(page.getByText('What amount are you considering?', { exact: false })).toHaveCount(0);
    await review(page, 'later', 'I can make an introduction.');
    await expect(page.getByText('Not requested for an introduction')).toBeVisible();
    await page.screenshot({ path: `${proof}/introducer-review-${width}.png`, fullPage: true });
    await page.getByRole('button', { name: 'Send enquiry', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your enquiry is saved.', exact: true })).toBeVisible();
    assert.deepEqual(api.answerRequests[0].questionnaire.answers.indicativeContribution, { status: 'undecided' });
    await (await openDeviceDetails(page)).getByRole('button', { name: 'Add an interest' }).click();
    assert.equal(api.answerRequests.length, 1, 'the disclosure opens append-only interests without an answer write');
    await chooseInterest(page, /^Academy/);
    await page.getByRole('button', { name: 'Add & continue' }).click();
    await expect(page.getByRole('heading', { name: 'What would you like to learn?', exact: true })).toBeVisible();
    assert.equal(api.draft().questionnaires[0].audience, 'investor');
    assert.equal(api.draft().completedAt, null);
    await showSavedStatus(page);
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
    await expect(fresh.getByRole('button', { name: 'Begin', exact: true })).toBeVisible();
    await context.close();
    console.log(`introducer ${width}px: truthful amount skip, final write, append interests and device expiry passed`);
  }
  // A lost pre-write response must not turn interest navigation into a new
  // intent, erase unsent input, or silently issue an answer/extension retry.
  for (const [width, mode] of [
    [1280, 'answer'],
    [390, 'extension'],
  ]) {
    const context = await browser.newContext({ viewport: { width, height: 850 } });
    const api = await fixtures(context, { loseAnswerBeforeWrite: mode === 'answer', loseExtensionBeforeWrite: mode === 'extension' });
    const page = await context.newPage();
    await page.goto(origin + '/invest');
    await begin(page);
    await fillContact(page, true);
    await page.getByRole('button', { name: 'I can introduce an investor' }).click();
    await continueGroup(page);
    await choose(page, 'Which best describes you or the organisation you represent?', 'Individual');
    await continueGroup(page);
    await choose(page, 'What is your role in the decision?', 'I make introductions');
    await continueGroup(page);
    await review(page, 'later', 'Preserve this unsent introduction.');
    await page.getByRole('button', { name: 'Send enquiry', exact: true }).click();
    if (mode === 'answer') {
      await expect(page.getByRole('alert')).toContainText('could not confirm');
      await (await openDeviceDetails(page)).getByRole('button', { name: 'Add an interest' }).click();
      assert.equal(api.answerRequests.length, 1);
      await page.getByRole('button', { name: 'Reopen saved enquiry' }).click();
      await expect(page.getByRole('alert')).toContainText('last send is not confirmed');
      await expect(page.getByText('Preserve this unsent introduction.', { exact: true })).toBeVisible();
      assert.equal(api.answerRequests.length, 1);
      await page.screenshot({ path: `${proof}/unknown-answer-safe-interest-${width}.png`, fullPage: true });
      await page.getByRole('button', { name: 'Send enquiry', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Your enquiry is saved.' })).toBeVisible();
      assert.equal(
        createHash('sha256').update(JSON.stringify(api.answerRequests[0])).digest('hex'),
        createHash('sha256').update(JSON.stringify(api.answerRequests[1])).digest('hex'),
        'unknown answer retry retains exact UUID, revision and original inputs',
      );
    } else {
      await expect(page.getByRole('heading', { name: 'Your enquiry is saved.' })).toBeVisible();
      await (await openDeviceDetails(page)).getByRole('button', { name: 'Add an interest' }).click();
      await chooseInterest(page, /^Academy/);
      await page.getByRole('button', { name: 'Add & continue' }).click();
      await expect(page.getByRole('alert')).toContainText('could not confirm');
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await (await openDeviceDetails(page)).getByRole('button', { name: 'Add an interest' }).click();
      assert.equal(api.extensionRequests.length, 1);
      await page.getByRole('button', { name: 'Reopen saved enquiry' }).click();
      await expect(page.getByRole('checkbox', { name: /^Academy/ })).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByRole('checkbox', { name: /^Academy/ })).toBeDisabled();
      assert.equal(api.extensionRequests.length, 1);
      await page.screenshot({ path: `${proof}/unknown-interest-preserved-${width}.png`, fullPage: true });
      await page.getByRole('button', { name: 'Add & continue' }).click();
      await expect(page.getByRole('heading', { name: 'What would you like to learn?' })).toBeVisible();
      assert.equal(
        createHash('sha256').update(JSON.stringify(api.extensionRequests[0])).digest('hex'),
        createHash('sha256').update(JSON.stringify(api.extensionRequests[1])).digest('hex'),
        'unknown append retry retains exact UUID, revision and original selection',
      );
      assert.equal(api.draft().completedAt, null);
      assert.equal(api.draft().questionnaires[0].answers.message, 'Preserve this unsent introduction.');
    }
    assert.deepEqual(api.captureRequests[0].contact.interests, ['investor']);
    await geometry(page);
    await context.close();
    console.log(`disclosure ${width}px ${mode}: explicit unknown-state recovery, retained inputs and same-intent retry passed`);
  }

  // Contact screen 1: the email rule is the contract's, and screen 1 promises nothing.
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 850 } });
    const api = await fixtures(context);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(origin + '/invest');
    await begin(page);
    const body = () => page.locator('.outreach-workspace').innerText();
    assert.ok(!/By continuing|ask INTAFACED/.test(await body()), 'screen 1 makes no promise');
    assert.match(await body(), /How we handle your details:/);
    await expect(page.getByRole('button', { name: 'Privacy & contact' })).toBeVisible();
    await control(page, 'Your name').fill('Local proof visitor');
    for (const typed of ['investor@gmail', 'investor@', '@gmail.com', 'in vestor@gmail.com']) {
      await control(page, 'Email', { exact: false }).fill(typed);
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Let’s start with you.', exact: true })).toBeVisible();
      await expect(control(page, 'Email', { exact: false })).toBeFocused();
      // "investor@gmail" passes the browser's own email check, so the message is ours; the others get the browser's wording.
      if (typed === 'investor@gmail') await expect(page.locator('#outreach-email-error')).toContainText('full email address');
      else await expect(page.locator('#outreach-email-error')).toBeVisible();
      assert.equal(await control(page, 'Email', { exact: false }).inputValue(), typed, 'the typed email is left as typed');
    }
    assert.equal(api.captureRequests.length, 0, 'nothing is sent from screen 1');
    // Correcting it clears the message and lets the visitor on.
    await control(page, 'Email', { exact: false }).fill('investor@gmail.com');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'A little more, if you like.', exact: true })).toBeFocused();
    assert.match(
      await body(),
      /By continuing, you ask INTAFACED to review and reply to your enquiry\./,
      'the promise sits on screen 2, where data is sent',
    );
    assert.equal(api.captureRequests.length, 0, 'screen 2 has not been submitted yet');
    // If the details are refused as invalid after all, the visitor lands back on the email field with the error shown.
    await page.evaluate(() => {
      const trim = String.prototype.trim;
      window.__restoreTrim = () => (String.prototype.trim = trim);
      String.prototype.trim = function () {
        const value = trim.call(this);
        return value === 'investor@gmail.com' ? '' : value;
      };
    });
    await page.getByRole('button', { name: 'Save details & continue' }).click();
    await expect(page.getByRole('heading', { name: 'Let’s start with you.', exact: true })).toBeVisible();
    await expect(control(page, 'Email', { exact: false })).toBeFocused();
    await expect(page.locator('#outreach-email-error')).toContainText('full email address');
    await expect(page.locator('.outreach-notice')).toContainText('Check the required fields');
    assert.equal(await control(page, 'Email', { exact: false }).inputValue(), 'investor@gmail.com', 'the email is kept');
    assert.equal(await control(page, 'Your name').inputValue(), 'Local proof visitor', 'the name is kept');
    assert.equal(api.captureRequests.length, 0, 'a refused contact is never sent');
    await page.evaluate(() => window.__restoreTrim());
    assert.deepEqual(errors, []);
    await context.close();
    console.log(
      `contact ${width}px: contract email rule on screen 1, no promise on screen 1, invalid_input returns to the email field passed`,
    );
  }

  // The amount step: only digits (one decimal point) or three-digit grouping with a comma or a space are accepted.
  // Anything else stays as typed, shows an inline error, blocks Continue, and is never sent.
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 850 } });
    const api = await fixtures(context);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(origin + '/invest');
    await begin(page);
    await fillContact(page, false);
    await page.getByRole('button', { name: 'I’m considering investing' }).click();
    await continueGroup(page);
    await choose(page, 'Which best describes you or the organisation you represent?', 'Individual');
    await continueGroup(page);
    await choose(page, 'What is your role in the decision?', 'I make investment decisions');
    await continueGroup(page);
    await page.getByRole('button', { name: 'Share an indicative amount' }).click();
    const amount = control(page, 'Amount', { exact: true });
    const amountHeading = page.getByRole('heading', { name: 'What amount are you considering?', exact: true });
    await pick(page, 'Currency', 'USD', 'US Dollar');
    const cont = page.getByRole('button', { name: 'Continue', exact: true });
    for (const typed of ['1,5', '1.000,50', '1e5', '-5', '1,2,3', '1.5.', ' ', '1 250,000', '1,50,000', '150,00', '12a', '$5']) {
      await amount.fill(typed);
      await amount.blur();
      await expect(amount, `displayed as typed: ${JSON.stringify(typed)}`).toHaveValue(typed);
      await expect(page.locator('#amount-error'), `error for ${JSON.stringify(typed)}`).toHaveText(AMOUNT_ERROR);
      await cont.click();
      await expect(amountHeading, `Continue is blocked for ${JSON.stringify(typed)}`).toBeVisible();
      await expect(amount).toHaveValue(typed);
    }
    assert.equal(api.answerRequests.length, 0, 'an invalid amount is never sent');
    // Back and forward must not launder it: the remounted field still carries the error and still blocks.
    for (const typed of ['1.5.', ' ']) {
      await amount.fill(typed);
      await page.getByRole('button', { name: 'Back', exact: false }).click();
      await expect(page.locator('#intake-heading')).toBeFocused();
      await continueGroup(page);
      await expect(amountHeading).toBeVisible();
      await expect(amount).toHaveValue(typed);
      await cont.click();
      await expect(amountHeading, `Continue still blocked after Back and forward for ${JSON.stringify(typed)}`).toBeVisible();
      await expect(page.locator('#amount-error')).toHaveText(AMOUNT_ERROR);
    }
    // Correcting it unblocks the step. Spaces between groups of three are normalised in what is sent.
    await amount.fill('150 000');
    await amount.blur();
    await expect(amount).toHaveValue('150,000');
    await expect(page.locator('#amount-error')).toHaveCount(0);
    await review(page, 'later', 'x');
    await expect(page.locator('.outreach-review')).toContainText('150,000 USD');
    await page.getByRole('button', { name: 'Send enquiry', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your enquiry is saved.', exact: true })).toBeVisible();
    assert.equal(api.answerRequests.length, 1);
    assert.equal(
      api.answerRequests[0].questionnaire.answers.indicativeContribution.amount,
      '150000',
      'only the normalised plain string is sent',
    );
    assert.deepEqual(errors, []);
    await context.close();
    console.log(
      `amount ${width}px: accepted forms normalised, 12 odd forms kept as typed, blocked and never sent, Back/forward cannot bypass`,
    );
  }

  // The status line is announced once, after typing settles, never on every keystroke.
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    await fixtures(context);
    const page = await context.newPage();
    await page.goto(origin + '/invest');
    await begin(page);
    await fillContact(page, false);
    await page.getByRole('button', { name: 'I can introduce an investor' }).click();
    await continueGroup(page);
    await choose(page, 'Which best describes you or the organisation you represent?', 'Individual');
    await continueGroup(page);
    await choose(page, 'What is your role in the decision?', 'I make introductions');
    await continueGroup(page);
    await choose(page, 'When would you consider taking part?', TIMING.later);
    await continueGroup(page);
    const message = control(page, 'What would you like us to know?', { exact: false });
    await expect(page.locator('.draft-status')).toHaveText('Draft kept in this tab');
    await expect(page.locator('.draft-status-live')).toHaveText('Draft kept in this tab', { timeout: 5000 });
    await page.evaluate(() => {
      const count = (selector) => {
        const node = document.querySelector(selector);
        const box = { n: 0 };
        new MutationObserver((list) => (box.n += list.length)).observe(node, { subtree: true, childList: true, characterData: true });
        return box;
      };
      window.__live = count('.draft-status-live');
      window.__visible = count('.draft-status');
    });
    await message.click();
    await message.pressSequentially('hello world', { delay: 45 }); // 11 characters
    const during = await page.evaluate(() => ({ live: window.__live.n, visible: window.__visible.n }));
    assert.equal(during.live, 0, `the live region stays quiet while typing (${during.live} changes)`);
    assert.ok(during.visible >= 2, `the visible text does follow the typing (${during.visible} changes), so this check is not vacuous`);
    await page.waitForTimeout(1500);
    const settled = await page.evaluate(() => window.__live.n);
    assert.ok(settled <= 1, `at most one announcement once typing settles (${settled})`);
    assert.equal(await page.locator('.draft-status-live').textContent(), 'Draft kept in this tab');
    assert.equal(await page.locator('.draft-status').getAttribute('aria-hidden'), 'true', 'the visible copy is not read out as well');
    await context.close();
    console.log('status line: 0 live-region changes while typing 11 characters, at most 1 once settled');
  }

  // Recovery consent boundaries: refresh works by default; a closed tab does not persist without opt-in.
  const tabContext = await browser.newContext({ viewport: { width: 390, height: 850 } });
  await fixtures(tabContext);
  let tabPage = await tabContext.newPage();
  await tabPage.goto(origin + '/invest');
  await begin(tabPage);
  await fillContact(tabPage, false, async (page) => {
    await expect(page.getByRole('checkbox', { name: 'Remember my draft on this device.' })).not.toBeChecked();
  });
  await tabPage.getByRole('button', { name: 'I can introduce an investor', exact: true }).click();
  await continueGroup(tabPage);
  await choose(tabPage, 'Which best describes you or the organisation you represent?', 'Individual');
  await continueGroup(tabPage);
  await choose(tabPage, 'What is your role in the decision?', 'I make introductions');
  await continueGroup(tabPage);
  await review(tabPage, 'later', 'Tab-only draft.');
  await expect(tabPage.locator('.draft-status')).toHaveText('Draft kept in this tab');
  await (await openDeviceDetails(tabPage)).getByText('Draft kept in this tab').waitFor();
  await tabPage.reload();
  await reopen(tabPage);
  await expect(tabPage.getByText('Tab-only draft.', { exact: true })).toBeVisible();
  await tabPage.getByRole('button', { name: 'Edit answers' }).click();
  await expect(tabPage.getByRole('button', { name: 'I can introduce an investor', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await tabPage.close();
  tabPage = await tabContext.newPage();
  await tabPage.goto(origin + '/invest');
  await expect(tabPage.getByRole('button', { name: 'Begin', exact: true })).toBeVisible();
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
  await fillContact(blockedPage, false, async (page) => {
    await expect(page.getByRole('checkbox', { name: 'Remember my draft on this device.' })).toBeDisabled();
  });
  await expect(blockedPage.getByRole('alert')).toContainText('could not confirm');
  await blockedPage.getByRole('button', { name: 'Reopen saved enquiry' }).click();
  await expect(blockedPage.getByRole('heading', { name: 'How would you like to take part?', exact: true })).toBeVisible();
  await expect(blockedPage.getByRole('status').filter({ hasText: 'cannot be stored' })).toContainText('cannot be stored');
  await expect(blockedPage.locator('.draft-status')).toHaveText('Not saved in this browser');
  await expect(blockedPage.locator('.draft-status-live')).toHaveText('Not saved in this browser');
  assert.equal(blockedApi.captureRequests[0].requestId, blockedApi.captureRequests[1].requestId);
  await blocked.close();
  console.log('blocked storage: honest resume limitation and stable in-memory capture retry passed');

  const forgetContext = await browser.newContext({ viewport: { width: 390, height: 850 } });
  await fixtures(forgetContext);
  const forgetPage = await forgetContext.newPage();
  await forgetPage.goto(origin + '/invest');
  await begin(forgetPage);
  await fillContact(forgetPage, true);
  await showSavedStatus(forgetPage);
  await forgetPage.reload();
  await expect(forgetPage.getByText('A previous enquiry is available in this browser.')).toBeVisible();
  await forgetPage.locator('.welcome-content').getByRole('button', { name: 'Privacy', exact: true }).click();
  await expect(forgetPage.getByRole('heading', { name: 'Your enquiry, thoughtfully handled.' })).toBeFocused();
  forgetPage.on('dialog', (dialog) => dialog.accept());
  await forgetPage.getByRole('button', { name: 'Forget local draft', exact: true }).click();
  await expect(forgetPage.getByRole('button', { name: 'Begin', exact: true })).toBeVisible();
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
