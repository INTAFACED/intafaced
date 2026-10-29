import { randomBytes } from 'node:crypto';
import { chromium, test, expect } from '@playwright/test';
import { localTestDeviceState } from '../../../../tooling/scripts/local-test-device.mjs';
import { signUpInBrowser, tool } from './stack.mjs';

// J-identity-08, in the running app (docs/roadmap/journeys.json): I get verified and see what each level unlocks.
// Starts signed in at level none on /verification. Tests titled "J-identity-08 #<n>" prove a whole step; the others
// prove part of one and say which slice. Steps whose screens are not built yet fail at their first check, on a short
// timeout, so the run stays inside its time limit.
const J = 'J-identity-08';
const UNBUILT = { timeout: 5_000 };
const LEVELS = ['none', 'basic', 'full', 'institutional'];
const GATED = ['deposit', 'withdraw', 'trade', 'card', 'earn'];

function person(prefix = 'kv') {
  const handle = `${prefix}${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  return { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
}

/** A fresh TEST person, signed up in this browser, on /verification at level none. */
async function atVerification(page) {
  const who = person();
  await signUpInBrowser(page, who);
  await page.goto('/verification');
  const ladder = page.getByRole('region', { name: 'What each level unlocks' });
  return { who, ladder, rung: (level) => ladder.locator(`[data-testid="verification__rung"][data-level="${level}"]`) };
}

/** Send the request form as it stands for `country`, through its review step. */
async function sendRequest(page, country = 'DE') {
  await page.getByLabel('Country code').fill(country);
  await page.getByRole('button', { name: 'Review request' }).click();
  await page.getByRole('button', { name: 'Submit this request' }).click();
  await expect(page.getByText('Your reviewed request')).toBeVisible();
}

test(`${J} #1 (I-kyc-compliance-04): a ladder of levels, and every gated feature says which level unlocks it`, async ({ page }) => {
  test.setTimeout(90_000);
  const { ladder, rung } = await atVerification(page);
  await expect(ladder.getByTestId('verification__rung')).toHaveCount(LEVELS.length);
  for (const [i, level] of LEVELS.entries())
    await expect(ladder.getByTestId('verification__rung').nth(i)).toHaveAttribute('data-level', level);
  // Level none is where the person stands.
  await expect(rung('none')).toHaveAttribute('aria-current', 'step');
  await expect(rung('none')).toContainText('Your level');
  // At level none every gated feature names the level that unlocks it, and that level shows it unlocked.
  for (const feature of GATED) {
    const item = rung('none').locator(`[data-feature="${feature}"]`);
    await expect(item).toHaveAttribute('data-state', 'needs_level');
    const needs = await item.getAttribute('data-needs');
    expect(LEVELS.slice(1)).toContain(needs);
    await expect(item).toContainText(/Needs level (Basic|Full|Institutional)/);
    await expect(rung(needs).locator(`[data-feature="${feature}"]`)).toHaveAttribute('data-state', 'allowed');
  }
  // Each reward names its own level, so the ladder says so instead of a level.
  await expect(rung('none').locator('[data-feature="rewards"]')).toContainText('Set per reward');
  // Every level above none can be started from here; it fills the request form, it grants nothing.
  await rung('basic').getByRole('button', { name: 'Verify to unlock' }).click();
  await expect(page.getByLabel('Level to request')).toHaveValue('basic');
  await rung('full').getByRole('button', { name: 'Verify to unlock' }).click();
  await expect(page.getByLabel('Level to request')).toHaveValue('full');
  await expect(rung('none').getByRole('button', { name: 'Verify to unlock' })).toHaveCount(0);
});

test(`${J} #1 (I-kyc-compliance-05): requirements not published say none are published; the review time is stated or says it is not`, async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { rung } = await atVerification(page);
  // The stack's TEST owner values publish basic's list and review time only (tooling/profiles/test-owner-values/identity.json).
  const basic = rung('basic').getByTestId('verification__requirements');
  await expect(basic).toHaveAttribute('data-published', 'true');
  await expect(basic.locator('li')).toHaveText(['Legal name', 'Date of birth', 'Home address', 'Photo ID']);
  await expect(rung('basic').getByTestId('verification__review-time')).toHaveText('Review usually takes up to 24 hours.');
  for (const level of ['full', 'institutional']) {
    const list = rung(level).getByTestId('verification__requirements');
    await expect(list).toHaveAttribute('data-published', 'false');
    await expect(list).toHaveText('No requirements are published for this level yet.');
    await expect(list.locator('li')).toHaveCount(0);
    await expect(rung(level).getByTestId('verification__review-time')).toContainText('No review time is stated.');
  }
});

test(`${J} #1 (I-kyc-compliance-04, withdrawal limits): owner limits not set read "not set"`, async ({ page }) => {
  test.setTimeout(90_000);
  const { rung } = await atVerification(page);
  // Each level's withdrawal limits are svc-pay's owner-set figures (D-148). The stack's TEST gates set figures for the
  // verified levels only (local-test-gates.mjs TEST_WITHDRAWAL_LIMITS), so level none reads "Limit not set", never a number.
  for (const level of LEVELS)
    await expect(rung(level).locator('.verification__limits [data-limits]').first()).toHaveAttribute('data-limits', /^(set|unset)$/);
  const none = rung('none').locator('.verification__limits');
  await expect(none.locator('[data-limits="unset"]')).toHaveText('Limit not set');
  await expect(none.locator('li')).toHaveCount(0);
  // A level with figures lists each coin's figures as the owner set them (the gates publish TEST figures for basic).
  await expect(rung('basic').locator('.verification__limits [data-limits="set"] li').first()).toHaveText(
    /^[A-Z0-9]+: up to \d+(\.\d+)? per withdrawal and \d+(\.\d+)? in 24 hours$/,
  );
});

test(`${J} #2: guided verification resumes at the step left, a country with no document list says so, an over-size file names the cap`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  await atVerification(page);
  const guided = page.getByRole('region', { name: 'Guided verification' });
  const current = guided.getByTestId('verification__guided-steps').locator('li[aria-current="step"]');
  const cases = page.getByRole('region', { name: 'Case history' }).getByTestId('verification__case');
  await guided.getByRole('button', { name: 'Start guided verification' }).click();
  await expect(current).toHaveAttribute('data-step', 'residence');

  // Steps 1 and 2 for a country with no published ID list (TEST lists only DE and US): the ID step says so.
  await guided.getByLabel('Country you live in').fill('FR');
  await guided.getByLabel('Nationality').fill('FR');
  await guided.getByRole('button', { name: 'Save and continue' }).click();
  await expect(current).toHaveAttribute('data-step', 'identity');
  await guided.getByLabel('Legal name').fill('TEST Anna Muster');
  await guided.getByLabel('Date of birth').fill('1990-01-31');
  await guided.getByRole('button', { name: 'Save and continue' }).click();
  await expect(current).toHaveAttribute('data-step', 'document');
  await expect(guided.getByTestId('verification__guided-doc-types')).toHaveAttribute('data-published', 'false');
  await expect(guided.getByTestId('verification__guided-doc-types')).toHaveText(
    'No accepted ID list is published for FR, so this step cannot be finished here. Ask Support about it.',
  );

  // Left and back: it resumes at step 3, and what was entered is kept.
  await page.reload();
  await expect(guided.getByTestId('verification__guided-resume')).toHaveText(
    'You stopped at step 3 of 6: ID document. What you entered is kept.',
  );
  await expect(current).toHaveAttribute('data-step', 'document');
  await guided.getByRole('button', { name: '1. Where you live' }).click();
  await expect(guided.getByLabel('Country you live in')).toHaveValue('FR');
  await guided.getByLabel('Country you live in').fill('DE');
  await guided.getByLabel('Nationality').fill('DE');
  await guided.getByRole('button', { name: 'Save and continue' }).click();
  // A fixed earlier step keeps the later ones: back at step 3, and step 2 still holds the name.
  await expect(current).toHaveAttribute('data-step', 'document');
  await guided.getByRole('button', { name: '2. Your name and date of birth' }).click();
  await expect(guided.getByLabel('Legal name')).toHaveValue('TEST Anna Muster');
  await guided.getByRole('button', { name: '3. ID document' }).click();

  // DE has a published list: pick from it.
  await expect(guided.getByTestId('verification__guided-doc-types')).toHaveAttribute('data-published', 'true');
  await guided.getByLabel('ID type').selectOption({ label: 'TEST: Passport' });
  await expect(guided.getByText('Bring the original. A copy is not accepted.')).toBeVisible();
  await guided.getByLabel('ID number').fill('TEST123456');
  await guided.getByRole('button', { name: 'Save and continue' }).click();
  await guided.getByLabel('Street and number').fill('TEST Strasse 1');
  await guided.getByLabel('City').fill('Berlin');
  await guided.getByLabel('Postal code').fill('10115');
  await guided.getByRole('button', { name: 'Save and continue' }).click();

  // The photo: over the owner's TEST cap (256 KiB) it is refused naming the cap; a small PNG is stored.
  await expect(current).toHaveAttribute('data-step', 'upload');
  const file = guided.getByLabel('Photo of your ID');
  await expect(file).toHaveAttribute('data-max-bytes', '262144');
  await file.setInputFiles({ name: 'id.png', mimeType: 'image/png', buffer: Buffer.alloc(300 * 1024, 7) });
  await guided.getByRole('button', { name: 'Upload photo' }).click();
  await expect(guided.getByTestId('verification__guided-problem')).toHaveText('This file is 300 KiB. The limit is 256 KiB.');
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  await file.setInputFiles({ name: 'id.png', mimeType: 'image/png', buffer: png });
  await guided.getByRole('button', { name: 'Upload photo' }).click();

  // Check and send: one pending case; the automatic check is not connected, so a person reviews it.
  await expect(current).toHaveAttribute('data-step', 'review');
  await expect(guided.getByTestId('verification__guided-review')).toContainText('TEST Anna Muster');
  await guided.getByRole('button', { name: 'Send for review' }).click();
  await expect(guided.getByTestId('verification__guided-sent')).toBeVisible();
  await expect(guided.getByTestId('verification__guided-manual')).toContainText('a person reviews your documents');
  await expect(cases).toHaveCount(1);
  await expect(cases.first()).toHaveAttribute('data-state', 'submitted');
});

test(`${J} #3: with the face check switched off the selfie is kept for manual review; a hand-off link used twice is refused`, async ({
  baseURL,
}) => {
  test.setTimeout(90_000);
  // A browser whose camera is Chromium's fake device, granted, as a person's would be after they allow it.
  const browser = await chromium.launch({
    channel: 'chromium',
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    ...(process.env.JOURNEY_CHROMIUM ? { executablePath: process.env.JOURNEY_CHROMIUM } : {}),
  });
  try {
    const context = await browser.newContext({
      baseURL,
      permissions: ['camera'],
      storageState: localTestDeviceState(),
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    const { who } = await atVerification(page);
    const selfie = page.getByTestId('verification__selfie');
    await expect(page.getByRole('heading', { name: 'Selfie and liveness' })).toBeVisible();
    await expect(selfie.getByTestId('verification__selfie-manual')).toHaveAttribute('data-face-check', 'not_connected');
    // The vendor is off: the notice names both checks it does not run, and that a person reviews the capture instead.
    await expect(selfie.getByTestId('verification__selfie-manual')).toHaveText(
      'The automatic face match and liveness check are not connected here, so a person compares your selfie with your ID photo.',
    );
    await expect(selfie.getByTestId('verification__selfie-liveness')).toHaveText('No action asks for a liveness re-check.');

    // Taken live on this device: no file picker is offered, and the selfie waits for a person.
    await expect(selfie.locator('input[type="file"]')).toHaveCount(0);
    const takeLive = async (where) => {
      await where.getByRole('button', { name: 'Open camera' }).click();
      const preview = where.getByLabel('Camera preview');
      await expect(preview).toBeVisible();
      await expect.poll(() => preview.evaluate((video) => video.videoWidth)).toBeGreaterThan(0);
      await where.getByRole('button', { name: 'Take selfie' }).click();
      await expect(where.getByTestId('verification__selfie-sent')).toHaveText('Selfie sent. A person compares it with your ID photo.');
    };
    await takeLive(selfie);
    await expect(selfie.getByTestId('verification__selfie-latest')).toHaveAttribute('data-status', 'provided');
    await expect(selfie.getByTestId('verification__selfie-latest')).toHaveAttribute('data-via', 'this_device');

    // A one-time link for the phone, as a code and as a link, for this account only.
    await selfie.getByRole('button', { name: 'Use my phone instead' }).click();
    await expect(selfie.getByRole('img', { name: 'Code with the link for your phone' })).toBeVisible();
    await expect(selfie.getByText('The link works once, only for this account, for 10 minutes.')).toBeVisible();
    const href = await selfie.getByTestId('verification__selfie-link').getAttribute('href');
    expect(href).toMatch(/\/verification\?handoff=[A-Za-z0-9_-]{43}$/);

    // The phone is its own browser, signed in to the same account; it opens the link and takes the selfie there.
    const phoneContext = await browser.newContext({
      baseURL,
      permissions: ['camera'],
      storageState: localTestDeviceState(),
      viewport: { width: 390, height: 844 },
    });
    const phone = await phoneContext.newPage();
    await phone.goto('/login');
    await phone.fill('input[name=identifier]', who.email);
    await phone.fill('input[name=password]', who.password);
    await phone.getByRole('button', { name: /^sign in$/i }).click();
    await expect(phone).not.toHaveURL(/\/login/);
    await phone.goto(href);
    const onPhone = phone.getByTestId('verification__selfie');
    await expect(onPhone.getByTestId('verification__selfie-handoff')).toHaveAttribute('data-state', 'open');
    await takeLive(onPhone);
    await expect(onPhone.getByTestId('verification__selfie-latest')).toHaveAttribute('data-via', 'handoff');
    // The phone says it is done, with no refusal; the computer picks up the phone's selfie and the code leaves its screen.
    await expect(onPhone.getByTestId('verification__selfie-handoff')).toHaveAttribute('data-state', 'done');
    await expect(onPhone.getByRole('alert')).toHaveCount(0);
    // Back on the computer, which still holds its own session and reads the latest selfie.
    await expect(selfie.getByTestId('verification__selfie-latest')).toHaveAttribute('data-via', 'handoff', { timeout: 15_000 });
    await expect(selfie.getByRole('img', { name: 'Code with the link for your phone' })).toHaveCount(0);
    await expect(selfie.getByTestId('verification__selfie-sent')).toBeVisible();

    // The same link opened again is refused in plain words, and offers no camera.
    const again = await phoneContext.newPage();
    await again.goto(href);
    const refused = again.getByTestId('verification__selfie').getByTestId('verification__selfie-handoff');
    await expect(refused).toHaveAttribute('data-state', 'used');
    await expect(refused).toHaveText('This link was already used. Make a new one on your computer.');
    await expect(again.getByTestId('verification__selfie').getByRole('button', { name: 'Open camera' })).toHaveCount(0);

    // A link that lost characters on the way is refused as not whole, with no camera and no new phone link offered.
    const cut = await phoneContext.newPage();
    await cut.goto(href.slice(0, -5));
    const broken = cut.getByTestId('verification__selfie').getByTestId('verification__selfie-handoff');
    await expect(broken).toHaveAttribute('data-state', 'broken');
    await expect(cut.getByTestId('verification__selfie').getByRole('button', { name: 'Open camera' })).toHaveCount(0);
    await expect(cut.getByTestId('verification__selfie-phone')).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

test(`${J} #4: too many failed attempts give a typed lockout with the seconds left, or say no limit is set`, async ({ page }) => {
  test.setTimeout(180_000);
  const { who } = await atVerification(page);
  const attempts = page.getByTestId('verification__attempts');
  const cases = page.getByRole('region', { name: 'Case history' }).getByTestId('verification__case');
  // The TEST limit: two rejected requests in 24 hours, then a new request is refused for an hour after the last.
  await expect(attempts).toHaveAttribute('data-state', 'open');
  await expect(attempts).toContainText('0 of 2 rejected requests in the last 24 hours.');

  for (const n of [1, 2]) {
    await page.getByLabel('Level to request').selectOption({ label: 'Basic' });
    await sendRequest(page);
    await page.reload();
    await expect(cases).toHaveCount(n);
    expect(tool('local-test-gates.mjs', 'kyc-reject', who.handle, 'document_unreadable')).toContain('rejected (document_unreadable)');
    await page.reload();
    await expect(cases.first()).toHaveAttribute('data-state', 'rejected');
  }

  // At the cap: the seconds left, counting down, and the form held.
  await expect(attempts).toHaveAttribute('data-state', 'locked');
  const locked = attempts.getByTestId('verification__attempts-locked');
  await expect(locked).toHaveText(/^Too many rejected requests\. Try again in \d+ seconds\.$/);
  const seconds = Number((await locked.textContent()).match(/in (\d+) seconds/)[1]);
  expect(seconds).toBeGreaterThan(3500);
  expect(seconds).toBeLessThanOrEqual(3600);
  await expect(page.getByRole('button', { name: 'Review request' })).toBeDisabled();
  await expect(cases.first().getByRole('button', { name: 'Send a new request' })).toBeDisabled();
  await expect.poll(async () => Number((await locked.textContent()).match(/in (\d+) seconds/)[1])).toBeLessThan(seconds);
  await expect(cases).toHaveCount(2);
});

/** Identity restarted with the owner's proof-of-address recency rule blank, or back on the stack's TEST rule. */
function identityPoaRule(on) {
  const before = process.env.LOCAL_STACK_IDENTITY_POA_RULE;
  if (on) delete process.env.LOCAL_STACK_IDENTITY_POA_RULE;
  else process.env.LOCAL_STACK_IDENTITY_POA_RULE = 'off';
  try {
    tool('local-test-stack.mjs', 'restart', 'identity');
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_IDENTITY_POA_RULE;
    else process.env.LOCAL_STACK_IDENTITY_POA_RULE = before;
  }
}

test(`${J} #5: proof of address, with honest refusals`, async ({ page }) => {
  test.setTimeout(240_000);
  await atVerification(page);
  const poa = page.getByRole('region', { name: 'Proof of address' });
  // Asked for only after level Basic is approved.
  await expect(poa.getByTestId('verification__poa-state')).toHaveText('Proof of address is asked for after level Basic is approved.');
  await page.getByLabel('Level to request').selectOption({ label: 'Basic' });
  await sendRequest(page);
  tool('local-test-gates.mjs', 'verify');
  await page.reload();

  // The owner's TEST rule (90 days) and the lists for DE: what counts and what never does.
  await expect(poa.getByTestId('verification__poa-rule')).toHaveText('Issued within the last 90 days.');
  await expect(poa.getByTestId('verification__poa-documents')).toHaveAttribute('data-country', 'DE');
  await expect(poa.getByTestId('verification__poa-accepted').locator('li')).toHaveText([
    'TEST: Utility bill (gas, power, water)',
    'TEST: Bank statement',
  ]);
  await expect(poa.getByTestId('verification__poa-refused').locator('li')).toHaveText(['TEST: Screenshots', 'TEST: Mobile phone bills']);
  // A country with no list says none is published.
  await poa.getByLabel('Country the document is from').fill('US');
  await expect(poa.getByTestId('verification__poa-documents')).toHaveAttribute('data-published', 'false');
  await expect(poa.getByTestId('verification__poa-documents')).toHaveText(
    'No proof-of-address list is published for US, so a document from there is refused.',
  );

  const day = (daysAgo) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
  const pdf = { name: 'bill.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 TEST proof of address') };
  const problem = poa.getByTestId('verification__poa-problem');

  // With the owner's recency rule blank, the room says so and a send is refused with its code; nothing is stored.
  const ruleUnset = 'No rule is published for how recent a proof of address must be, so a submission is refused.';
  try {
    identityPoaRule(false);
    await page.reload();
    await expect(poa.getByTestId('verification__poa-rule')).toHaveAttribute('data-max-age-days', '');
    await expect(poa.getByTestId('verification__poa-rule')).toHaveText(ruleUnset);
    await poa.getByRole('combobox', { name: 'Document' }).selectOption({ label: 'TEST: Utility bill (gas, power, water)' });
    await poa.getByLabel('Date issued').fill(day(10));
    await poa.getByLabel('The document', { exact: true }).setInputFiles(pdf);
    await poa.getByRole('button', { name: 'Send proof of address' }).click();
    await expect(problem).toHaveAttribute('data-code', 'kyc.poa_rule_unset');
    await expect(problem).toHaveText(ruleUnset);
    await expect(poa.getByTestId('verification__poa-sent')).toHaveCount(0);
    await expect(poa.getByTestId('verification__poa-latest')).toHaveCount(0);
    await page.reload();
    await expect(poa.getByTestId('verification__poa-latest')).toHaveCount(0);
  } finally {
    identityPoaRule(true);
  }
  await page.reload();
  await expect(poa.getByTestId('verification__poa-rule')).toHaveText('Issued within the last 90 days.');

  // Too old for the rule: refused with its code, naming the rule.
  await poa.getByLabel('Country the document is from').fill('DE');
  await poa.getByRole('combobox', { name: 'Document' }).selectOption({ label: 'TEST: Utility bill (gas, power, water)' });
  await poa.getByLabel('Date issued').fill(day(120));
  await poa.getByLabel('The document', { exact: true }).setInputFiles(pdf);
  await poa.getByRole('button', { name: 'Send proof of address' }).click();
  await expect(problem).toHaveAttribute('data-code', 'kyc.poa_too_old');
  await expect(problem).toHaveText('This document is older than 90 days. Send one issued within the last 90 days.');

  // Recent, from another country than the residence: sent for review, and flagged for the reviewer.
  await poa.getByLabel('Country the document is from').fill('FR');
  await poa.getByRole('combobox', { name: 'Document' }).selectOption({ label: 'TEST: Utility bill' });
  await poa.getByLabel('Date issued').fill(day(5));
  await poa.getByLabel('The document', { exact: true }).setInputFiles(pdf);
  await poa.getByRole('button', { name: 'Send proof of address' }).click();
  await expect(poa.getByTestId('verification__poa-sent')).toContainText('Sent for review.');
  await expect(poa.getByTestId('verification__poa-latest')).toHaveAttribute('data-status', 'submitted');
  await expect(poa.getByTestId('verification__poa-mismatch')).toHaveText(
    'This document is from FR, not where you live (DE), so the reviewer checks it.',
  );
  await expect(poa.getByTestId('verification__poa-latest')).toHaveAttribute('data-mismatch', 'true');
  await expect(poa.getByTestId('verification__poa-one-at-a-time')).toHaveText(
    'One document waits for review at a time. You can send another after a reviewer decides it.',
  );

  // Another document while that one waits: refused in plain words, and the one on record stays.
  await poa.getByLabel('Country the document is from').fill('DE');
  await poa.getByRole('combobox', { name: 'Document' }).selectOption({ label: 'TEST: Utility bill (gas, power, water)' });
  await poa.getByLabel('Date issued').fill(day(10));
  await poa.getByLabel('The document', { exact: true }).setInputFiles({ ...pdf, buffer: Buffer.from('%PDF-1.4 TEST another bill') });
  await poa.getByRole('button', { name: 'Send proof of address' }).click();
  await expect(problem).toHaveAttribute('data-code', 'kyc.poa_pending');
  await expect(problem).toHaveText('A document is already waiting for review. You can send another after a reviewer decides it.');
  await expect(poa.getByTestId('verification__poa-latest')).toHaveAttribute('data-mismatch', 'true');
});

test(`${J}, part of #6 (I-kyc-compliance-01): one case record with history; a reject gives a plain reason, a resubmission opens a linked case, an approval unlocks at once`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { who, rung } = await atVerification(page);
  const history = page.getByRole('region', { name: 'Case history' });
  const cases = history.getByTestId('verification__case');
  await expect(history.getByText('No verification requests yet.')).toBeVisible();

  // Sent: one case, pending review, with its one step.
  await page.getByLabel('Level to request').selectOption({ label: 'Full' });
  await sendRequest(page);
  await page.reload();
  await expect(cases).toHaveCount(1);
  await expect(cases.first()).toHaveAttribute('data-state', 'submitted');
  await expect(cases.first()).toContainText('Pending review');
  await expect(cases.first().getByTestId('verification__case-steps').locator('li')).toHaveCount(1);

  // Rejected by the stack's two TEST operators with a listed code: the reason and what to do, in plain words.
  expect(tool('local-test-gates.mjs', 'kyc-reject', who.handle, 'document_unreadable')).toContain('rejected (document_unreadable)');
  await page.reload();
  const rejected = cases.first();
  await expect(rejected).toHaveAttribute('data-state', 'rejected');
  await expect(rejected.getByTestId('verification__case-reason')).toHaveAttribute('data-reason', 'document_unreadable');
  await expect(rejected.getByTestId('verification__case-reason-text')).toHaveText('Reason: TEST: the photo of your ID could not be read.');
  await expect(rejected.getByTestId('verification__case-guidance')).toContainText('What to do: TEST: take a new photo');
  await expect(rejected.getByTestId('verification__case-steps').locator('li')).toHaveText([/^Sent for review · /, /^Rejected · /]);
  await expect(rung('none')).toHaveAttribute('aria-current', 'step');

  // Sent again from the rejected case: a new case, linked to the rejected one, which stays as it was.
  await rejected.getByRole('button', { name: 'Send a new request' }).click();
  await expect(page.getByLabel('Level to request')).toHaveValue('full');
  await sendRequest(page);
  await page.reload();
  await expect(cases).toHaveCount(2);
  await expect(cases.first()).toHaveAttribute('data-state', 'submitted');
  await expect(cases.first().getByTestId('verification__case-follows')).toHaveText('This request follows your earlier rejected request.');
  await expect(cases.nth(1)).toHaveAttribute('data-state', 'rejected');
  await expect(cases.first().getByRole('button', { name: 'Send a new request' })).toHaveCount(0);

  // Approved: the case says so, and the ladder moves to Full at once, with what Full unlocks included.
  tool('local-test-gates.mjs', 'verify');
  await page.reload();
  await expect(cases.first()).toHaveAttribute('data-state', 'approved');
  await expect(cases.first().getByTestId('verification__case-steps').locator('li')).toHaveText([/^Sent for review · /, /^Approved · /]);
  await expect(rung('full')).toHaveAttribute('aria-current', 'step');
  for (const feature of ['deposit', 'withdraw', 'trade'])
    await expect(rung('full').locator(`[data-feature="${feature}"]`)).toContainText('Included in your level');
});

test(`${J} #6: one case record with history; an approval unlocks the mapped features at once`, async ({ page }) => {
  test.setTimeout(120_000);
  const { rung } = await atVerification(page);
  const capabilities = page.getByRole('region', { name: 'Capabilities' });
  const capability = (name) => capabilities.locator(`[data-testid="verification__capability"][data-capability="${name}"]`);
  const cases = page.getByRole('region', { name: 'Case history' }).getByTestId('verification__case');
  // Nothing asked yet: every capability reads not requested, with the level that includes it (TEST mapping).
  await expect(capabilities.getByTestId('verification__capability')).toHaveCount(5);
  await expect(capabilities.getByTestId('verification__capabilities')).toHaveAttribute('data-mapped', 'true');
  for (const name of ['custody_crypto', 'transfer_crypto', 'trade_crypto', 'custody_fiat', 'transfer_fiat'])
    await expect(capability(name)).toHaveAttribute('data-state', 'unrequested');
  await expect(capability('trade_crypto')).toContainText('Comes with level Basic');
  await expect(capability('custody_fiat')).toContainText('Comes with level Full');

  // Sent for Full: one case, and what Full includes is pending review.
  await page.getByLabel('Level to request').selectOption({ label: 'Full' });
  await sendRequest(page);
  await page.reload();
  await expect(cases).toHaveCount(1);
  await expect(cases.first()).toHaveAttribute('data-state', 'submitted');
  await expect(capability('custody_fiat')).toHaveAttribute('data-state', 'pending');
  await expect(capability('trade_crypto')).toContainText('Pending review');

  // Approved: the same case reads approved with its two steps, and every mapped capability is active at once.
  tool('local-test-gates.mjs', 'verify');
  await page.reload();
  await expect(cases).toHaveCount(1);
  await expect(cases.first()).toHaveAttribute('data-state', 'approved');
  await expect(cases.first().getByTestId('verification__case-steps').locator('li')).toHaveText([/^Sent for review · /, /^Approved · /]);
  for (const name of ['custody_crypto', 'transfer_crypto', 'trade_crypto', 'custody_fiat', 'transfer_fiat']) {
    await expect(capability(name)).toHaveAttribute('data-state', 'active');
    await expect(capability(name)).toContainText('Active');
  }
  await expect(rung('full')).toHaveAttribute('aria-current', 'step');
  for (const feature of ['deposit', 'withdraw', 'trade'])
    await expect(rung('full').locator(`[data-feature="${feature}"]`)).toContainText('Included in your level');
});

test(`${J} #7: a restriction on another screen gives its reason in plain words and the next step`, async ({ page }) => {
  test.setTimeout(120_000);
  const { who } = await atVerification(page);
  const restrictions = page.getByTestId('verification__restrictions');
  await expect(restrictions.getByRole('heading', { name: 'Restrictions on your account' })).toBeVisible();
  await expect(restrictions.getByTestId('verification__restrictions-none')).toHaveText('Nothing is restricted on your account.');

  // Compliance switches trading crypto off, two people with the stack's TEST reason (I-kyc-compliance-07).
  expect(tool('local-test-gates.mjs', 'kyc-capability-off', who.handle, 'trade_crypto', 'compliance_hold')).toContain(
    'switched off (compliance_hold)',
  );
  await page.reload();
  // Here: Capabilities says it is switched off and why, and the restrictions section points there, saying it once.
  const capabilities = page.getByRole('region', { name: 'Capabilities' });
  const capability = capabilities.locator('[data-testid="verification__capability"][data-capability="trade_crypto"]');
  await expect(capability).toContainText('Switched off');
  await expect(capability).toContainText('TEST: this was switched off after a compliance review.');
  await expect(restrictions.getByTestId('verification__restrictions-capabilities')).toHaveText(
    'A capability compliance switched off is listed under Capabilities above.',
  );
  await expect(restrictions.getByTestId('verification__restrictions-none')).toHaveCount(0);

  // On another screen, the account status: the reason in the owner's plain words, the next step, what it stops today
  // (a new request for a level that includes it) and what it does not (orders and transfers), and that nothing lifts it.
  await restrictions.getByRole('link', { name: 'See your account status' }).click();
  await expect(page).toHaveURL(/\/uc\/account/);
  const status = page.getByTestId('account-status');
  await expect(status.getByTestId('account-status__state')).toHaveAttribute('data-state', 'restricted');
  const off = status.locator('li[data-kind="capability_off"][data-capability="trade_crypto"]');
  await expect(off).toContainText('Trade crypto switched off');
  await expect(off).toContainText('TEST: this was switched off after a compliance review.');
  await expect(off).toContainText('Next: TEST: ask Support what the review found.');
  await expect(off).toContainText('It stops a new request for a level that includes it.');
  await expect(off).toContainText('it does not stop your orders or transfers.');
  await expect(off).toContainText('It cannot be switched back on.');
  await expect(status.getByTestId('account-status__cannot').locator('li')).toHaveText([
    'Ask for a verification level that includes a switched-off capability',
  ]);
});
