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
import { AMOUNT_ERROR, amountAmbiguity, parseAmount, spellAmount, storedAmount } from '../src/lib/amount.ts';
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
  ['150.5', '150.5'],
  ['0.75', '0.75'],
  ['150.0', '150.0'],
  ['1234.567', '1234.567'],
])
  assert.deepEqual(parseAmount(typed), { kind: 'valid', plain }, `valid amount ${JSON.stringify(typed)}`);
for (const typed of [
  '1,5',
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
// Dots as thousands ("150.000" is 150,000 in Indonesian and 150 as a decimal) are ambiguous: asked about, never guessed.
for (const typed of ['150.000', '1.500.000', '150.000,50', '2.000', '1.000,50', ' 150.000 ', '999.999', '1.500.000.000'])
  assert.deepEqual(parseAmount(typed), { kind: 'ambiguous', plain: '' }, `ambiguous amount ${JSON.stringify(typed)}`);
for (const typed of ['150.5', '0.75', '150,000', '150000', '1234.567', '0.500', '150.00', '1.5', '150 000', '12.34.567', '1.0000'])
  assert.equal(amountAmbiguity(typed), null, `not ambiguous: ${JSON.stringify(typed)}`);
assert.equal(storedAmount('150.000'), '150.000', 'an ambiguous amount stays exactly as typed until it is answered');
// What the prompt says. Words only up to three comma groups; the decimal reading only when a single dot group can be one.
assert.deepEqual(amountAmbiguity('150.000'), {
  yes: '150000',
  yesText: '150,000',
  words: 'one hundred fifty thousand',
  no: '150',
  noText: '150',
});
assert.equal(amountAmbiguity('150.500').no, '150.5');
assert.equal(amountAmbiguity('2.000').words, 'two thousand');
assert.equal(amountAmbiguity('2.000').yesText, '2,000');
assert.equal(amountAmbiguity('1.500.000').words, 'one million five hundred thousand');
assert.equal(amountAmbiguity('1.500.000').no, null, 'two dot groups cannot be read as a decimal');
assert.equal(amountAmbiguity('1.500.000.000').words, null, 'four comma groups are not spelled out');
assert.equal(amountAmbiguity('1.500.000.000').yesText, '1,500,000,000');
assert.deepEqual(
  { yes: amountAmbiguity('150.000,50').yes, text: amountAmbiguity('150.000,50').yesText, words: amountAmbiguity('150.000,50').words },
  { yes: '150000.50', text: '150,000.50', words: null },
  'a comma-decimal reading is shown with its decimals and is not spelled out',
);
for (const [n, words] of [
  [150000, 'one hundred fifty thousand'],
  [1500000, 'one million five hundred thousand'],
  [2000, 'two thousand'],
  [21, 'twenty-one'],
  [100, 'one hundred'],
  [999999999, 'nine hundred ninety-nine million nine hundred ninety-nine thousand nine hundred ninety-nine'],
  [1000001, 'one million one'],
])
  assert.equal(spellAmount(n), words, `spelled ${n}`);
assert.equal(spellAmount(1000000000), null);
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
// Every single choice is a radio card in a radiogroup named after the question.
const PARTICIPATION = 'Are you considering investing or making an introduction?';
async function radioIn(page, group, label) {
  await page.getByRole('radiogroup', { name: group, exact: true }).getByRole('radio', { name: label, exact: true }).check();
}
async function begin(page, investor = true) {
  await page.getByRole('button', { name: 'Begin', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Let’s start with you.', exact: true })).toBeVisible();
}
const RECEIVED = 'Thank you. We’ve received your enquiry.';
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
  await pick(page, 'Country', 'Indonesia');
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
  if (await page.getByRole('radiogroup', { name: 'Amount preference', exact: true }).count()) await continueGroup(page);
  await choose(page, 'When would you consider taking part?', TIMING[timing]);
  await continueGroup(page);
  await control(page, 'What would you like us to know?', { exact: false }).fill(message);
  await page.getByRole('button', { name: 'Review your answers' }).click();
  await expect(page.getByRole('heading', { name: 'Before you send.', exact: true })).toBeVisible();
}
// A returning visitor's one click on the welcome button reopens the saved enquiry directly.
async function reopen(page, label = 'Continue your enquiry') {
  await page.getByRole('button', { name: label, exact: true }).click();
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
    await radioIn(page, PARTICIPATION, 'I’m considering investing');
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
    await expect(page.getByRole('radio', { name: 'I’m considering investing', exact: true })).toBeChecked();
    await continueGroup(page);
    await expect(page.getByRole('radio', { name: 'Individual', exact: true })).toBeChecked();
    await continueGroup(page);
    await expect(page.getByRole('radio', { name: 'I make investment decisions', exact: true })).toBeChecked();
    await continueGroup(page);
    await radioIn(page, 'Amount preference', 'Share an indicative amount');
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
    await expect(page.getByRole('combobox', { name: 'Currency', exact: true })).toHaveValue('USD · US Dollar');
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
    await expect(page.getByRole('heading', { name: 'Which markets interest you?', exact: true })).toBeVisible();
    await expect(page.locator('.step-helper')).toHaveText('Choose one or more.');
    await page.screenshot({ path: `${proof}/trader-questions-${width}.png`, fullPage: true });
    assert.equal(api.answerRequests[0].questionnaire.answers.indicativeContribution.amount, '9007199254740993.000000000000000001');
    await page.getByRole('checkbox', { name: 'Spot', exact: true }).check();
    await continueGroup(page);
    await radioIn(page, 'Trading experience', 'Advanced');
    await continueGroup(page);
    await radioIn(page, 'Your trading role', 'Professional');
    await continueGroup(page);
    await control(page, 'What would you like from a trading platform?').fill('API access');
    await continueGroup(page);
    await review(page);
    await page.getByRole('button', { name: 'Send enquiry', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'What’s your business called?', exact: true })).toBeVisible();
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
    await radioIn(page, 'Amount preference', 'Share an indicative amount');
    await control(page, 'Amount', { exact: true }).fill('1,250,000.50');
    await pick(page, 'Currency', 'IDR', 'Indonesian Rupiah');
    await radioIn(page, 'Volume period', 'Monthly');
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
    await radioIn(page, 'Current experience', 'Beginner');
    await continueGroup(page);
    await control(page, 'Preferred subjects').fill('Risk, Markets');
    await continueGroup(page);
    await choose(page, 'Preferred learning format', 'Live');
    await continueGroup(page);
    await review(page, 'within_three_months');
    await page.getByRole('button', { name: 'Send enquiry', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'What’s your area of expertise?', exact: true })).toBeVisible();
    await page.screenshot({ path: `${proof}/partner-questions-${width}.png`, fullPage: true });
    await control(page, 'Your expertise').fill('Education');
    await continueGroup(page);
    await control(page, 'What would you like to contribute?').fill('A learning community');
    await continueGroup(page);
    await radioIn(page, 'Preferred relationship', 'Collaboration');
    await continueGroup(page);
    await continueGroup(page);
    await review(page);
    await page.getByRole('button', { name: 'Send enquiry', exact: true }).click();
    await expect(page.getByRole('heading', { name: RECEIVED })).toBeVisible();
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
    await radioIn(page, PARTICIPATION, 'I can introduce an investor');
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
    await expect(page.getByRole('heading', { name: RECEIVED, exact: true })).toBeVisible();
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
    await radioIn(page, PARTICIPATION, 'I can introduce an investor');
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
      await expect(page.getByRole('heading', { name: RECEIVED })).toBeVisible();
      assert.equal(
        createHash('sha256').update(JSON.stringify(api.answerRequests[0])).digest('hex'),
        createHash('sha256').update(JSON.stringify(api.answerRequests[1])).digest('hex'),
        'unknown answer retry retains exact UUID, revision and original inputs',
      );
    } else {
      await expect(page.getByRole('heading', { name: RECEIVED })).toBeVisible();
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

  // Contact screen 1: the email rule is the contract's, screen 1 promises nothing, and every message is ours: the
  // browser's own validation bubble (in the browser's language) never opens.
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 850 } });
    const api = await fixtures(context);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // reportValidity() is what opens the bubble. Count every call, and keep the real one so a call would still be visible.
    await page.addInitScript(() => {
      window.__reportValidityCalls = 0;
      for (const type of [HTMLInputElement, HTMLTextAreaElement, HTMLSelectElement, HTMLFormElement]) {
        const real = type.prototype.reportValidity;
        type.prototype.reportValidity = function () {
          window.__reportValidityCalls++;
          return real.call(this);
        };
      }
    });
    await page.goto(origin + '/invest');
    await begin(page);
    const body = () => page.locator('.outreach-workspace').innerText();
    assert.ok(!/By continuing|ask INTAFACED/.test(await body()), 'screen 1 makes no promise');
    assert.match(await body(), /How we handle your details:/);
    await expect(page.getByRole('button', { name: 'Privacy & contact' })).toBeVisible();
    // A2: forms are noValidate, so the browser never validates on submit.
    assert.equal(await page.locator('form:not([novalidate])').count(), 0, 'every form is noValidate');
    // A11: an empty field is not flagged until the first Continue; the first invalid field only is flagged then.
    await control(page, 'Your name').focus();
    await control(page, 'Email', { exact: false }).focus();
    await control(page, 'Email', { exact: false }).blur();
    await expect(page.locator('#outreach-name-error, #outreach-email-error')).toHaveCount(0);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(control(page, 'Your name')).toBeFocused();
    await expect(page.locator('#outreach-name-error')).toHaveText('Enter your name.');
    await expect(page.locator('#outreach-email-error'), 'only the first invalid field is marked').toHaveCount(0);
    await control(page, 'Your name').fill('Local proof visitor');
    await expect(page.locator('#outreach-name-error')).toHaveCount(0);
    // A11: a malformed value is flagged as soon as the field is left, with our words.
    await control(page, 'Email', { exact: false }).fill('investor@gmail');
    await control(page, 'Email', { exact: false }).blur();
    await expect(page.locator('#outreach-email-error')).toContainText('full email address');
    for (const typed of ['investor@gmail', 'investor@', '@gmail.com', 'in vestor@gmail.com', '']) {
      await control(page, 'Email', { exact: false }).fill(typed);
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Let’s start with you.', exact: true })).toBeVisible();
      await expect(control(page, 'Email', { exact: false })).toBeFocused();
      // The message is ours for every kind of problem (missing, wrong shape, no dot in the domain), never the browser's.
      await expect(page.locator('#outreach-email-error')).toHaveText('Enter a full email address, for example you@example.com.');
      assert.equal(await control(page, 'Email', { exact: false }).inputValue(), typed, 'the typed email is left as typed');
    }
    assert.equal(await page.evaluate(() => window.__reportValidityCalls), 0, 'reportValidity (the browser bubble) is never called');
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
    // A15: the optional fields are not labelled "(optional)" (the page already says so); the notes sit inside the checkboxes.
    assert.ok(!/\(optional\)/i.test(await body()), 'no "(optional)" suffixes on screen 2');
    await expect(page.getByRole('checkbox', { name: 'Send me INTAFACED news and updates.' })).toBeVisible();
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
    assert.equal(await page.evaluate(() => window.__reportValidityCalls), 0, 'a refused contact does not open the browser bubble either');
    await page.evaluate(() => window.__restoreTrim());
    assert.deepEqual(errors, []);
    await context.close();
    console.log(
      `contact ${width}px: contract email rule on screen 1, our own copy and no browser bubble, first invalid field only, no promise on screen 1, invalid_input returns to the email field passed`,
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
    await radioIn(page, PARTICIPATION, 'I’m considering investing');
    await continueGroup(page);
    await choose(page, 'Which best describes you or the organisation you represent?', 'Individual');
    await continueGroup(page);
    await choose(page, 'What is your role in the decision?', 'I make investment decisions');
    await continueGroup(page);
    await radioIn(page, 'Amount preference', 'Share an indicative amount');
    const amount = control(page, 'Amount', { exact: true });
    const amountHeading = page.getByRole('heading', { name: 'What amount are you considering?', exact: true });
    await pick(page, 'Currency', 'USD', 'US Dollar');
    const cont = page.getByRole('button', { name: 'Continue', exact: true });
    for (const typed of ['1,5', '1e5', '-5', '1,2,3', '1.5.', ' ', '1 250,000', '1,50,000', '150,00', '12a', '$5']) {
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
    // Dots as thousands ("150.000", "1.500.000", "150.000,50") could be a decimal, so the visitor is ASKED, never guessed at.
    const ask = page.locator('.amount-ask');
    await amount.fill('');
    await amount.pressSequentially('1.500.000', { delay: 90 });
    await page.waitForTimeout(250);
    await expect(ask, 'the question waits until typing has paused, so "1.500" half way is never asked about').toHaveCount(0);
    await expect(ask).toContainText('Did you mean 1,500,000 (one million five hundred thousand)?', { timeout: 3000 });
    await expect(page.locator('.amount-ask-region')).toHaveAttribute('role', 'status');
    await expect(page.getByRole('button', { name: 'No, I’ll change it', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'No, I’ll change it', exact: true }).click();
    await expect(amount).toBeFocused();
    await expect(amount).toHaveValue('1.500.000');
    await expect(ask, 'still asking: nothing was answered').toHaveCount(1);
    await page.getByRole('button', { name: 'Yes, 1,500,000', exact: true }).click();
    await expect(amount).toHaveValue('1,500,000');
    await expect(ask).toHaveCount(0);
    await amount.fill('150.000,50');
    await amount.blur();
    await expect(ask).toContainText('Did you mean 150,000.50?');
    assert.ok(!/\(/.test(await ask.innerText()), 'a number with decimals is not spelled out');
    await amount.fill('1.500.000.000');
    await amount.blur();
    await expect(ask).toContainText('Did you mean 1,500,000,000?');
    assert.ok(!/\(/.test(await ask.innerText()), 'four comma groups are not spelled out');
    await amount.fill('2.000');
    await amount.blur();
    await expect(ask).toContainText('Did you mean 2,000 (two thousand)?');
    for (const plain of ['150.5', '0.75', '150,000']) {
      await amount.fill(plain);
      await amount.blur();
      await expect(ask, `no question for ${plain}`).toHaveCount(0);
      await expect(page.locator('#amount-help')).toHaveText('An estimate is fine. Use a comma or space for thousands.');
    }
    // "150.000" with Continue blocked until answered; "No, I meant 150" is remembered; nothing is sent.
    await amount.fill('150.000');
    await amount.blur();
    await expect(ask).toContainText('Did you mean 150,000 (one hundred fifty thousand)?');
    await expect(page.getByRole('button', { name: 'Yes, 150,000', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'No, I meant 150', exact: true })).toBeVisible();
    await expect(page.locator('#amount-error')).toHaveCount(0);
    await cont.click();
    await expect(amountHeading, 'Continue is blocked until the ambiguous amount is answered').toBeVisible();
    await expect(ask).toContainText('Choose one to continue.');
    await expect(page.getByRole('button', { name: 'Yes, 150,000', exact: true })).toBeFocused();
    assert.equal(api.answerRequests.length, 0, 'an unanswered amount is never sent');
    await page.getByRole('button', { name: 'No, I meant 150', exact: true }).click();
    await expect(amount).toHaveValue('150');
    await expect(ask).toHaveCount(0);
    await page.getByRole('button', { name: 'Back', exact: false }).click();
    await continueGroup(page);
    await expect(amount, 'the answer is remembered when the visitor goes back and forward').toHaveValue('150');
    await expect(ask).toHaveCount(0);
    await amount.fill('150.000');
    await amount.blur();
    await page.getByRole('button', { name: 'Yes, 150,000', exact: true }).click();
    await expect(amount).toHaveValue('150,000');
    await page.reload();
    await reopen(page);
    await expect(amountHeading, 'a reload returns to the step with the answer kept').toBeVisible();
    await expect(amount).toHaveValue('150,000');
    // Correcting it unblocks the step. Spaces between groups of three are normalised in what is sent.
    await amount.fill('150 000');
    await amount.blur();
    await expect(amount).toHaveValue('150,000');
    await expect(page.locator('#amount-error')).toHaveCount(0);
    await review(page, 'later', 'x');
    await expect(page.locator('.outreach-review')).toContainText('150,000 USD');
    await page.getByRole('button', { name: 'Send enquiry', exact: true }).click();
    await expect(page.getByRole('heading', { name: RECEIVED, exact: true })).toBeVisible();
    assert.equal(api.answerRequests.length, 1);
    assert.equal(
      api.answerRequests[0].questionnaire.answers.indicativeContribution.amount,
      '150000',
      'only the normalised plain string is sent',
    );
    assert.deepEqual(errors, []);
    await context.close();
    console.log(
      `amount ${width}px: accepted forms normalised, 11 odd forms kept as typed, blocked and never sent, Back/forward cannot bypass, dotted thousands asked about (never guessed), answer remembered`,
    );
  }

  // Design QA 2026-10-13: question steps, answer cards, errors that clear, progress, the confirmation, the privacy panel, a returning visitor.
  const LONG_EMAIL = 'a-very-long-investor-name.surname-and-more@example-company.com'; // 62 characters
  assert.ok(LONG_EMAIL.length >= 60);
  for (const [width, height] of [
    [1280, 800],
    [390, 844],
  ]) {
    const context = await browser.newContext({ viewport: { width, height } });
    const api = await fixtures(context);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(origin + '/invest');
    await begin(page);
    await control(page, 'Your name').fill('Design QA');
    await control(page, 'Email', { exact: false }).fill(LONG_EMAIL);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'A little more, if you like.', exact: true })).toBeFocused();
    const inView = async (name) => {
      const box = await page.getByRole('button', { name, exact: true }).boundingBox();
      assert.ok(
        box.y >= 0 && box.y + box.height <= height,
        `"${name}" is on screen without scrolling at ${width}x${height} (bottom ${box.y + box.height})`,
      );
    };
    // A10 + A17: the main button is on screen on contact 2, and the two tick boxes are cards like the answers.
    await inView('Save details & continue');
    assert.equal(await page.locator('.check-card').count(), 2, 'contact checkboxes are cards');
    // A17 (design QA): control borders are #636d65 (read with the pointer away, since hover lightens them).
    await page.mouse.move(0, 0);
    await expect
      .poll(() =>
        page
          .locator('.check-card')
          .first()
          .evaluate((el) => getComputedStyle(el).borderTopColor),
      )
      .toBe('rgb(99, 109, 101)');
    await expect(page.getByRole('combobox', { name: 'Country', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Save details & continue' }).click();
    await expect(page.locator('#intake-heading')).toBeFocused();
    const progress = page.getByRole('progressbar');

    // A5 + A4 + A18: one question per step, answered with cards; the error clears with the choice; progress counts this step.
    assert.equal(await page.locator('[aria-pressed]').count(), 0, 'no toggle well: single choices are radio cards');
    assert.equal(await page.getByRole('radiogroup', { name: PARTICIPATION, exact: true }).getByRole('radio').count(), 3);
    await expect(progress).toHaveAttribute('aria-valuenow', '1');
    await expect(progress).toHaveAttribute('aria-valuemax', '7');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    const stepError = page.locator('#step-error');
    await expect(stepError).toHaveText('Choose an option to continue.');
    await expect(stepError).toHaveAttribute('role', 'alert');
    assert.equal(await page.locator('.outreach-notice').count(), 0, 'the message is inline under the answers, not the banner');
    assert.equal(await page.locator('.step-error').evaluate((el) => !!el.closest('.outreach-questions')), true);
    await radioIn(page, PARTICIPATION, 'I’m considering investing');
    await expect(stepError, 'the message goes as soon as a choice is made').toHaveCount(0);
    await continueGroup(page);
    await expect(progress).toHaveAttribute('aria-valuenow', '2');
    // A10: five cards, and the main button is still on screen.
    assert.equal(
      await page
        .getByRole('radiogroup', { name: 'Which best describes you or the organisation you represent?' })
        .getByRole('radio')
        .count(),
      5,
    );
    await inView('Continue');
    await choose(page, 'Which best describes you or the organisation you represent?', 'Individual');
    await continueGroup(page);
    await choose(page, 'What is your role in the decision?', 'I make investment decisions');
    await continueGroup(page);
    await expect(progress).toHaveAttribute('aria-valuenow', '4');
    // Amount step: the status choice is cards too; the fields share one material, height and label style.
    await radioIn(page, 'Amount preference', 'Share an indicative amount');
    const amountBox = page.locator('#amount').locator('xpath=ancestor::*[@data-slot="halo-input-shell"]');
    const currencyBox = page.locator('.picker-shell');
    const [a, c] = [await amountBox.boundingBox(), await currencyBox.boundingBox()];
    assert.equal(Math.round(a.height), 56, 'amount field is 56px');
    assert.equal(Math.round(c.height), 56, 'currency picker is 56px');
    const labelTop = (selector) => page.locator(selector).evaluate((el) => Math.round(el.getBoundingClientRect().top * 10) / 10);
    if (width > 680) {
      const apart = Math.abs((await labelTop('label[for=amount]')) - (await labelTop('label[for=currency]')));
      assert.ok(apart <= 1, `Amount and Currency labels line up (${apart}px apart)`);
      assert.ok(Math.abs(a.y - c.y) <= 1, `Amount and Currency boxes line up (${Math.abs(a.y - c.y)}px apart)`);
    }
    const material = (selector) =>
      page.locator(selector).evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          backdrop: style.backdropFilter,
          border: style.borderTopColor,
          bg: style.backgroundImage.replace(/\s+/g, ' ').replace(/ (0|100)%/g, ''),
        };
      });
    const mAmount = await material('[data-slot="halo-input-shell"] > div:last-child');
    const mPicker = await material('.picker-shell');
    assert.equal(mAmount.backdrop, 'none', 'the field has no backdrop filter (no saturated, warm tint)');
    assert.equal(mPicker.backdrop, 'none');
    assert.equal(mAmount.border, 'rgb(99, 109, 101)');
    assert.equal(mPicker.border, 'rgb(99, 109, 101)');
    assert.equal(mAmount.bg, mPicker.bg, 'one surface for field and picker');
    // A7: one focus ring (2px, 4px away), the same on the field and the picker.
    await control(page, 'Amount', { exact: true }).focus();
    const ring = (selector) =>
      page.locator(selector).evaluate((el) => ({
        width: getComputedStyle(el).outlineWidth,
        offset: getComputedStyle(el).outlineOffset,
        style: getComputedStyle(el).outlineStyle,
      }));
    const ringField = await ring('[data-slot="halo-input-shell"]:has(#amount)');
    await page.getByRole('combobox', { name: 'Currency', exact: true }).focus();
    const ringPicker = await ring('.picker-shell');
    assert.deepEqual(ringField, { width: '2px', offset: '4px', style: 'solid' });
    assert.deepEqual(ringPicker, ringField, 'the picker has the same ring as the field');
    // A8: the currency reads "USD · US Dollar", and its popup stays inside the column (it opens aligned to the right edge).
    await pick(page, 'Currency', 'IDR', 'Indonesian Rupiah');
    await expect(page.getByRole('combobox', { name: 'Currency', exact: true })).toHaveValue('IDR · Indonesian Rupiah');
    await page.getByRole('combobox', { name: 'Currency', exact: true }).click();
    await expect(page.locator('.picker-popup')).toBeVisible();
    const popup = await page.locator('.picker-popup').boundingBox();
    const shell = await currencyBox.boundingBox();
    const column = await page.locator('.outreach-form-panel').boundingBox();
    assert.ok(popup.x + popup.width <= shell.x + shell.width + 1, 'the popup does not overhang the field on the right');
    assert.ok(popup.x >= 0 && popup.x + popup.width <= width, 'the popup is on screen');
    if (width > 680) assert.ok(popup.x + popup.width <= column.x + column.width + 1, 'the popup stays inside the form column');
    await page.keyboard.press('Escape');
    await control(page, 'Amount', { exact: true }).fill('150000');
    await continueGroup(page);
    await choose(page, 'When would you consider taking part?', TIMING.later);
    await continueGroup(page);
    // A17: the message box is tall enough to invite a sentence.
    const messageBox = await page.locator('[data-slot="halo-input-shell"]:has(textarea)').boundingBox();
    assert.ok(messageBox.height >= 120, `message box is at least 120px tall (${messageBox.height})`);
    await control(page, 'What would you like us to know?', { exact: false }).fill('Design QA.');
    await page.getByRole('button', { name: 'Review your answers' }).click();
    await expect(page.getByRole('heading', { name: 'Before you send.', exact: true })).toBeVisible();
    await expect(progress).toHaveAttribute('aria-valuenow', '7');
    await expect(progress).toHaveAttribute('aria-valuemax', '7');
    // A16: the review rows reuse the step headings; the answers are 15px / 500.
    await expect(page.locator('.outreach-review dt').first()).toHaveText('How would you like to take part?');
    assert.deepEqual(
      await page
        .locator('.outreach-review dd')
        .first()
        .evaluate((el) => [getComputedStyle(el).fontSize, getComputedStyle(el).fontWeight]),
      ['15px', '500'],
    );
    await inView('Send enquiry');
    await page.getByRole('button', { name: 'Send enquiry', exact: true }).click();

    // A15 + A3: the confirmation says "received", has the mark above the heading, and a long address wraps inside the phone.
    await expect(page.getByRole('heading', { name: RECEIVED, exact: true })).toBeVisible();
    await expect(page.locator('.outreach-complete')).toContainText(
      'We review every enquiry personally before arranging a call. We’ll reply to ' + LONG_EMAIL + '.',
    );
    await expect(page.locator('#intake-heading')).toBeFocused();
    const markY = (await page.locator('.completion-mark').boundingBox()).y;
    const headingY = (await page.locator('#intake-heading').boundingBox()).y;
    assert.ok(markY < headingY, 'the check mark is above the heading');
    assert.equal(await page.locator('h1').count(), 1, 'one h1');
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      `no sideways scroll with a ${LONG_EMAIL.length}-character email at ${width}px`,
    );
    const emailBox = await page.locator('.receipt-email').first().boundingBox();
    assert.ok(emailBox.x + emailBox.width <= width, 'the address stays inside the screen');
    await expect(page.locator('.outreach-complete li')).toContainText('Received ✓');
    await geometry(page);
    // A13 + A15: the disclosure line, the privacy panel aligned to the column, a readable date, a quiet destructive action.
    const details = await openDeviceDetails(page);
    await expect(details.locator('.device-status')).toContainText('Kept in this tab only.');
    assert.equal(
      await details
        .locator('dl > div')
        .first()
        .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ')[0]),
      '104px',
      'disclosure rows use a 104px label column',
    );
    await details.getByRole('button', { name: 'Privacy', exact: true }).click();
    await expect(page.locator('#privacy-heading')).toBeFocused();
    const panel = await page.locator('.outreach-privacy p').first().boundingBox();
    const column2 = await page.locator('.outreach-complete .completion-receipt-copy').boundingBox();
    assert.equal(Math.round(panel.x), Math.round(column2.x), 'the privacy panel starts where the form column starts');
    assert.equal(Math.round(panel.width), Math.round(column2.width), 'and is as wide as the form column');
    const privacyText = await page.locator('.outreach-privacy').innerText();
    assert.match(privacyText, /Local access expires \d{1,2} [A-Z][a-z]+ \d{4}\./, 'a plain date, no clock time or seconds');
    const forgetHere = page.locator('.outreach-privacy').getByRole('button', { name: 'Forget this draft on my device' });
    assert.equal(
      await forgetHere.evaluate((el) => el.classList.contains('outreach-text-button')),
      true,
      'the destructive action is a quiet text button',
    );
    assert.equal(await page.locator('.outreach-privacy .outreach-primary').count(), 0);
    assert.deepEqual(
      await page.locator('#privacy-heading').evaluate((el) => [getComputedStyle(el).fontWeight, getComputedStyle(el).letterSpacing]),
      ['500', '-0.7px'],
      'a lighter heading: 500 weight, -0.025em',
    );
    assert.equal(
      await page
        .locator('.outreach-privacy p')
        .first()
        .evaluate((el) => getComputedStyle(el).lineHeight),
      '23.1px',
      'paragraphs are 14px / 1.65',
    );
    await page.getByRole('button', { name: '← Return to your enquiry' }).click();

    // A12: a returning visitor after sending sees "View your enquiry", and one click opens it.
    await page.reload();
    await expect(page.getByRole('button', { name: 'View your enquiry', exact: true })).toBeVisible();
    await expect(page.getByText('You sent an enquiry from this browser.')).toBeVisible();
    assert.equal(await page.getByRole('button', { name: 'Continue your enquiry' }).count(), 0);
    await page.getByRole('button', { name: 'View your enquiry', exact: true }).click();
    await expect(page.getByRole('heading', { name: RECEIVED, exact: true })).toBeVisible();
    assert.equal(await page.getByRole('button', { name: 'Reopen saved enquiry' }).count(), 0, 'no second click is ever needed');
    assert.equal(api.answerRequests.length, 1);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(
      `design QA ${width}x${height}: cards, inline errors that clear, progress, 56px fields, one ring, long email, privacy column, returning visitor passed`,
    );
  }

  // A12: mid-flow, the first button reopens directly (not two clicks). A9/A10: the action bar is sticky only when the window is tall enough.
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await fixtures(context);
    const page = await context.newPage();
    await page.goto(origin + '/invest');
    await begin(page);
    await fillContact(page, false);
    await radioIn(page, PARTICIPATION, 'I can introduce an investor');
    await continueGroup(page);
    await page.reload();
    await expect(page.getByText('A previous enquiry is available in this browser.')).toBeVisible();
    await page.getByRole('button', { name: 'Continue your enquiry', exact: true }).click();
    await expect(page.locator('#intake-heading')).toBeFocused();
    await expect(
      page.getByRole('heading', { name: 'Which best describes you or the organisation you represent?', exact: true }),
    ).toBeVisible();
    assert.equal(await page.getByRole('button', { name: 'Reopen saved enquiry' }).count(), 0, 'one click, not two');
    const position = () => page.locator('.outreach-form-panel .outreach-actions').evaluate((el) => getComputedStyle(el).position);
    assert.equal(await position(), 'sticky', 'sticky on a laptop-height window');
    await page.setViewportSize({ width: 720, height: 450 }); // what 1440x900 becomes at 200% zoom
    assert.equal(await position(), 'static', 'not sticky when the window is short (200% zoom): it would cover the fields');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await position(), 'sticky', 'sticky on a phone');
    await context.close();
    console.log('returning visitor: one click reopens a saved enquiry; the action bar is sticky only in tall windows');
  }

  // A1: a saved enquiry found LATE (a slow storage check) changes the hero label with a crossfade and leaves the entrance running.
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    await fixtures(context);
    const first = await context.newPage();
    await first.goto(origin + '/invest');
    await begin(first);
    await fillContact(first, true);
    await radioIn(first, PARTICIPATION, 'I can introduce an investor');
    await continueGroup(first);
    await first.close();
    const page = await context.newPage(); // a new tab has no sessionStorage: only the (held) IndexedDB check can know about the draft
    await page.addInitScript(() => {
      window.__released = false;
      window.__labelOut = 0;
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
      new MutationObserver((list) => {
        for (const record of list) for (const node of record.addedNodes) if (node.classList?.contains('label-out')) window.__labelOut++;
      }).observe(document, { subtree: true, childList: true });
    });
    await page.goto(origin + '/invest');
    await page.getByRole('button', { name: 'Begin', exact: true }).waitFor();
    await page.waitForTimeout(500);
    const reveal = () => page.evaluate(() => document.querySelector('.outreach-page').classList.contains('entry-reveal'));
    assert.equal(await reveal(), true, 'the entrance is running while the storage check is slow');
    await page.evaluate(() => window.__releaseIdb());
    await expect(page.getByRole('button', { name: 'Continue your enquiry', exact: true })).toBeAttached();
    assert.equal(await reveal(), true, 'finding the draft late does not cut the entrance short');
    assert.ok(
      (await page.evaluate(() => window.__labelOut)) >= 1,
      'the old label was kept under the new one while it faded out (a crossfade)',
    );
    await page.waitForFunction(() => !document.querySelector('.outreach-page').classList.contains('entry-reveal'), null, {
      timeout: 10000,
    });
    assert.equal(await page.locator('.label-out').count(), 0, 'the crossfade clears itself');
    await expect(page.getByText('A previous enquiry is available in this browser.')).toBeVisible();
    await context.close();
    console.log('late-found draft: the entrance keeps playing and the hero label crossfades to "Continue your enquiry"');
  }

  // A1 lives in storage.browser.mjs (a slow storage check must not cancel the entrance). A5: the volume period is a compact three-card row,
  // and the tick-box questions are cards with a square indicator.
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    await fixtures(context);
    const page = await context.newPage();
    await page.goto(origin + '/merchant');
    await begin(page);
    await fillContact(page, false);
    await expect(page.getByRole('heading', { name: 'What’s your business called?', exact: true })).toBeVisible();
    await control(page, 'Business name').fill('Example');
    await continueGroup(page);
    await expect(page.getByRole('heading', { name: 'What’s your business website?', exact: true })).toBeVisible();
    await expect(page.locator('.step-helper')).toHaveText('Optional.');
    await control(page, 'Business website', { exact: false }).fill('example.com');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.locator('#outreach-merchant-website-error')).toHaveText('Start with https://, for example https://example.com.');
    await control(page, 'Business website', { exact: false }).fill('https://example.com');
    await continueGroup(page);
    await control(page, 'Industry').fill('Retail');
    await continueGroup(page);
    await expect(page.getByRole('heading', { name: 'Where does your business operate?', exact: true })).toBeVisible();
    await expect(page.locator('.step-helper')).toHaveText('Choose one or more.');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.locator('#step-error')).toHaveText('Choose at least one option to continue.');
    await pick(page, 'Operating countries', 'Indonesia');
    await expect(page.locator('#step-error')).toHaveCount(0);
    await continueGroup(page);
    await expect(page.getByRole('heading', { name: 'Which services would help your business?', exact: true })).toBeVisible();
    assert.equal(await page.locator('.check-card').count(), 4, 'tick-box answers are cards');
    await page.getByRole('checkbox', { name: 'Payment acceptance' }).check();
    assert.equal(await page.locator('.check-card[data-selected]').count(), 1);
    assert.equal(await page.locator('.check-card .choice-card-check-square').count(), 4, 'with a square indicator');
    await continueGroup(page);
    await radioIn(page, 'Amount preference', 'Share an indicative amount');
    const period = page.locator('.amount-period .choice-card');
    assert.equal(await period.count(), 3);
    const boxes = await period.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()));
    assert.ok(
      boxes.every((box) => Math.round(box.y) === Math.round(boxes[0].y)),
      'the three periods are one row',
    );
    assert.ok(
      boxes.every((box) => box.height >= 44 && box.height <= 48),
      'cards are 44px tall',
    );
    assert.equal(await page.locator('.amount-period .choice-card-check').count(), 0, 'no indicator circle on the period cards');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect.poll(() => page.locator('#step-error, #amount-error').first().innerText()).toMatch(/Enter an amount|Choose a/);
    await context.close();
    console.log('merchant steps: display headings and helpers, tick-box cards, compact volume period, inline errors passed');
  }

  // The status line is announced once, after typing settles, never on every keystroke.
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    await fixtures(context);
    const page = await context.newPage();
    await page.goto(origin + '/invest');
    await begin(page);
    await fillContact(page, false);
    await radioIn(page, PARTICIPATION, 'I can introduce an investor');
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
  await radioIn(tabPage, PARTICIPATION, 'I can introduce an investor');
  await continueGroup(tabPage);
  await choose(tabPage, 'Which best describes you or the organisation you represent?', 'Individual');
  await continueGroup(tabPage);
  await choose(tabPage, 'What is your role in the decision?', 'I make introductions');
  await continueGroup(tabPage);
  await review(tabPage, 'later', 'Tab-only draft.');
  await expect(tabPage.locator('.draft-status')).toHaveText('Draft kept in this tab');
  await (await openDeviceDetails(tabPage)).getByText('Kept in this tab only.').waitFor();
  await tabPage.reload();
  await reopen(tabPage);
  await expect(tabPage.getByText('Tab-only draft.', { exact: true })).toBeVisible();
  await tabPage.getByRole('button', { name: 'Edit answers' }).click();
  await expect(tabPage.getByRole('radio', { name: 'I can introduce an investor', exact: true })).toBeChecked();
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
  await forgetPage.getByRole('button', { name: 'Forget this draft on my device', exact: true }).click();
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
