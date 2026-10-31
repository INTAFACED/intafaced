import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chromium, test, expect } from '@playwright/test';
import { localTestDeviceState } from '../../../../tooling/scripts/local-test-device.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { confirm, deskPath, free, fundedTrader, held, openDesk, openOrders, reviewLimit } from './desk.mjs';
import { api, signUpInBrowser, tool } from './stack.mjs';

// J-identity-08, in the running app (docs/roadmap/journeys.json): I get verified and see what each level unlocks.
// Starts signed in at level none on /verification. Tests titled "J-identity-08 #<n>" prove a whole step; the others
// prove part of one and say which slice. Steps whose screens are not built yet fail at their first check, on a short
// timeout, so the run stays inside its time limit.
const J = 'J-identity-08';
const UNBUILT = { timeout: 5_000 };
const LEVELS = ['none', 'basic', 'full', 'institutional'];
const GATED = ['deposit', 'withdraw', 'trade', 'card', 'earn'];
/** The stack's one TEST reason from an owner reason list in identity's TEST owner values, as account status returns it. */
function ownerReason(setting) {
  const raw = JSON.parse(readFileSync(new URL('../../../../tooling/profiles/test-owner-values/identity.json', import.meta.url), 'utf8'));
  const [listed] = JSON.parse(raw.values[setting].value);
  return { code: listed.code, text: listed.reason, guidance: listed.guidance };
}
/** IDENTITY_TRADING_RESTRICTION_REASONS: why staff restricted trading. */
const TRADING_REASON = ownerReason('IDENTITY_TRADING_RESTRICTION_REASONS');
/** IDENTITY_KYC_CAPABILITY_REASONS: why compliance switched a capability off. */
const CAPABILITY_REASON = ownerReason('IDENTITY_KYC_CAPABILITY_REASONS');

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

    // The service itself refuses the used link, not only the page: a selfie sent straight to identity with it is refused
    // with its one typed code, and a re-read shows the phone's selfie is still the latest, so no second selfie was stored.
    const own = await api(who);
    const handoff = new URL(href, baseURL).searchParams.get('handoff');
    const readLatest = async () => {
      const { status, body } = await own.get('/api/identity/trpc/kyc.selfie.read');
      expect(status).toBe(200);
      return body.result.data.latest;
    };
    const kept = await readLatest();
    expect(kept).toMatchObject({ via: 'handoff', status: 'provided' });
    const checked = await own.get(
      `/api/identity/trpc/kyc.selfie.handoff.check?input=${encodeURIComponent(JSON.stringify({ token: handoff }))}`,
    );
    expect(checked.status).toBe(200);
    expect(checked.body.result.data.state).toBe('used');
    // A 1x1 PNG: a photo the owner's upload caps accept, so the only thing wrong with this send is the link.
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const reused = await own.post('/api/identity/trpc/kyc.selfie.submit', { contentType: 'image/png', bytesBase64: png, handoff });
    expect(reused.status).toBe(409);
    expect(reused.body.error.data.cause.code).toBe('kyc.handoff_used');
    expect(await readLatest()).toEqual(kept);

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

  // Identity's own answer, not only the page's words: the limit and when it opens, and a third request refused by its
  // typed code with the seconds left.
  const own = await api(who);
  const read = await own.get('/api/identity/trpc/kyc.attempts.read');
  expect(read.body.result.data).toMatchObject({ limit: { maxDenials: 2 }, denialsInWindow: 2 });
  // It opens when the page said it would: no later than the countdown read above, and only the seconds since then sooner.
  const opensIn = (Date.parse(read.body.result.data.lockedUntil) - Date.now()) / 1000;
  expect(opensIn).toBeLessThanOrEqual(seconds);
  expect(opensIn).toBeGreaterThan(seconds - 60);
  const third = await own.post('/api/identity/trpc/kyc.submit', { tier: 'basic', jurisdiction: 'DE' });
  expect(third.status).toBe(429);
  const data = third.body.error.data;
  expect(data.intafacedCode ?? data.cause?.code ?? data.code).toBe('kyc.attempts_exhausted');
  expect(data.retryAfterSeconds).toBeLessThanOrEqual(Math.ceil(opensIn) + 1);
  expect(data.retryAfterSeconds).toBeGreaterThan(seconds - 60);
  await page.reload();
  await expect(cases).toHaveCount(2);

  // With the owner's limit blank (identity restarted without it), the page says no limit is set and the form is open:
  // the lockout does not invent a limit.
  identityKycAttempts(false);
  try {
    await page.reload();
    await expect(attempts).toHaveAttribute('data-state', 'unset', { timeout: 30_000 });
    await expect(attempts).toContainText('No attempt limit is set.');
    await expect(attempts.getByTestId('verification__attempts-locked')).toHaveCount(0);
    const unset = await (await api(who)).get('/api/identity/trpc/kyc.attempts.read');
    expect(unset.body.result.data).toMatchObject({ limit: null, denialsInWindow: null, lockedUntil: null });
  } finally {
    identityKycAttempts(true);
  }
});

/** Identity restarted with the owner's verification attempt limit blank, or back on the stack's TEST limit. */
function identityKycAttempts(on) {
  const before = process.env.LOCAL_STACK_IDENTITY_KYC_ATTEMPTS;
  if (on) delete process.env.LOCAL_STACK_IDENTITY_KYC_ATTEMPTS;
  else process.env.LOCAL_STACK_IDENTITY_KYC_ATTEMPTS = 'off';
  try {
    tool('local-test-stack.mjs', 'restart', 'identity');
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_IDENTITY_KYC_ATTEMPTS;
    else process.env.LOCAL_STACK_IDENTITY_KYC_ATTEMPTS = before;
  }
}

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
  expect(tool('local-test-gates.mjs', 'kyc-capability-off', who.handle, 'trade_crypto', CAPABILITY_REASON.code)).toContain(
    `switched off (${CAPABILITY_REASON.code})`,
  );
  // The reason identity stored with the switch-off, read back from identity itself: the code and the owner's words and
  // next step for it. Every reason shown below is this record's.
  const client = await api(who);
  const mine = await client.get('/api/identity/trpc/accountStatus.mine');
  expect(mine.status).toBe(200);
  const stored = mine.body.result.data.restrictions.filter((r) => r.kind === 'capability_off');
  expect(stored.map((r) => [r.capability, r.owner])).toEqual([['trade_crypto', CAPABILITY_REASON]]);
  await page.reload();
  // Here: Capabilities says it is switched off and why, and the restrictions section points there, saying it once.
  const capabilities = page.getByRole('region', { name: 'Capabilities' });
  const capability = capabilities.locator('[data-testid="verification__capability"][data-capability="trade_crypto"]');
  await expect(capability).toContainText('Switched off');
  await expect(capability).toContainText(CAPABILITY_REASON.text);
  await expect(restrictions.getByTestId('verification__restrictions-capabilities')).toHaveText(
    'A capability compliance switched off is listed under Capabilities above.',
  );
  await expect(restrictions.getByTestId('verification__restrictions-none')).toHaveCount(0);

  // On another screen, the account status: the reason in the owner's plain words, the next step, what it stops today
  // (a new request for the level that grants it) and what it does not (orders and transfers), and that nothing lifts it.
  await restrictions.getByRole('link', { name: 'See your account status' }).click();
  await expect(page).toHaveURL(/\/uc\/account/);
  const status = page.getByTestId('account-status');
  await expect(status.getByTestId('account-status__state')).toHaveAttribute('data-state', 'restricted');
  const off = status.locator('li[data-kind="capability_off"][data-capability="trade_crypto"]');
  await expect(off).toContainText('Trade crypto switched off');
  await expect(off).toContainText(CAPABILITY_REASON.text);
  await expect(off).toContainText(`Next: ${CAPABILITY_REASON.guidance}`);
  // In plain words: the owner's sentence, never the code behind it.
  await expect(off).not.toContainText(CAPABILITY_REASON.code);
  await expect(off).toContainText('It stops a new request for the level that grants it.');
  await expect(off).toContainText('it does not stop your orders or transfers.');
  await expect(off).toContainText('It cannot be switched back on.');
  await expect(status.getByTestId('account-status__cannot').locator('li')).toHaveText([
    'Ask for the verification level that grants a switched-off capability',
  ]);

  // Hit it: ask for Basic, the TEST level that grants trading crypto, from its own screen. Identity refuses it with its
  // one typed code before anything is stored, and the refusal gives the reason in the owner's words and the next step.
  await page.goto('/verification');
  const cases = page.getByRole('region', { name: 'Case history' }).getByTestId('verification__case');
  await expect(cases).toHaveCount(0);
  await page.getByLabel('Level to request').selectOption({ label: 'Basic' });
  await page.getByLabel('Country code').fill('DE');
  await page.getByRole('button', { name: 'Review request' }).click();
  const [reply] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('kyc.submit') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Submit this request' }).click(),
  ]);
  expect(reply.status()).toBe(409);
  const wire = await reply.json();
  expect((Array.isArray(wire) ? wire[0] : wire).error.data.cause.code).toBe('kyc.capability_inactive');
  const refused = page.getByTestId('verification__capability-refused');
  await expect(refused).toHaveAttribute('data-code', 'kyc.capability_inactive');
  await expect(refused).toContainText(
    'This level was refused because it grants a capability compliance switched off. The service opened no request.',
  );
  // The heading names the list it introduces, so it sits only above a list that has entries.
  const list = refused.getByRole('list', { name: 'Switched off on your account:' });
  await expect(list).toHaveCount(1);
  const why = list.locator('li[data-kind="capability_off"][data-capability="trade_crypto"]');
  await expect(why).toHaveCount(1);
  await expect(why).toContainText('Trade crypto switched off');
  await expect(why).toContainText(CAPABILITY_REASON.text);
  await expect(why).toContainText(`Next: ${CAPABILITY_REASON.guidance}`);
  await expect(refused).not.toContainText(CAPABILITY_REASON.code);
  await expect(refused.locator('li')).toHaveCount(1);

  // Re-read: no case opened, trading crypto is still the one switched off, and nothing is held pending.
  await page.reload();
  await expect(cases).toHaveCount(0);
  await expect(capability).toHaveAttribute('data-state', 'inactive');
  const states = await capabilities
    .getByTestId('verification__capability')
    .evaluateAll((items) => items.map((li) => [li.getAttribute('data-capability'), li.getAttribute('data-state')]));
  expect(states.filter(([, state]) => state !== 'unrequested')).toEqual([['trade_crypto', 'inactive']]);
});

test(`${J} #7: a trading restriction refuses a new order on the desk by name, keeps cancel and money, and the lift lets it through`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  // A verified person with TEST USDT, so only the restriction can refuse the order. The deposit is the precondition.
  const who = await fundedTrader(page, 'kvtr', '100');
  await openDesk(page, who);
  const order = () => reviewLimit(page, 'buy', '10000.00', '0.001');
  const sends = () => page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/orders' && r.request().method() === 'POST');
  // One resting order from before the restriction: the restriction must leave it in place and cancellable.
  await order();
  await confirm(page, 'buy');
  await expect.poll(async () => (await openOrders(who)).length, { timeout: 20_000 }).toBe(1);
  const [earlier] = await openOrders(who);
  expect(earlier?.id).toBeTruthy();
  const client = await api(who);
  const usdtBefore = (await client.balances()).USDT;
  // The earlier order holds USDT, so the cancel below has a hold to release.
  expect(usdtBefore.used).not.toMatch(/^0(\.0+)?$/);

  let lifted = false;
  try {
    // A trade-ops operator restricts this account's trading at identity, with a second person's approval and a reason
    // code from the owner's list (the stack's TEST IDENTITY_TRADING_RESTRICTION_REASONS).
    expect(tool('local-test-gates.mjs', 'trading-restrict', who.handle, 'restrict', TRADING_REASON.code)).toMatch(
      /OK .* trading restrict: changed/,
    );

    // On another screen, the trade desk: a new order is refused by name before anything is held.
    await page.reload();
    const sent = sends();
    const review = await order();
    await review.getByRole('button', { name: 'Confirm buy' }).click();
    const answer = await sent;
    // A trading control's refusal is a permission refusal (403), carrying identity's one typed code.
    expect(answer.status()).toBe(403);
    const refusal = await answer.json();
    expect(refusal.intafacedCode).toBe('trade.account_restricted');
    expect(refusal.message).toBe('trade.account_restricted');
    const main = page.getByRole('main');
    await expect(main.getByText('Trading is on hold on your account')).toBeVisible();
    await expect(
      main.getByText(
        "New orders can't be placed, and this one wasn't. You can still cancel orders and move money. Contact support to find out why.",
      ),
    ).toBeVisible();
    // Re-read: the one earlier order is all that rests, and the ledger holds exactly what it held before the refusal.
    expect((await openOrders(who)).map((o) => o.id)).toEqual([earlier.id]);
    expect((await client.balances()).USDT).toEqual(usdtBefore);

    // The account status names it, what it stops and what it does not.
    await main.getByRole('link', { name: 'See your account status' }).click();
    await expect(page).toHaveURL(/\/uc\/account/);
    const status = page.getByTestId('account-status');
    await expect(status.getByTestId('account-status__state')).toHaveAttribute('data-state', 'restricted');
    const restriction = status.getByTestId('account-status__restrictions').locator('li[data-kind="trading_restricted"]');
    await expect(restriction).toContainText('Trading restricted');
    await expect(restriction).toContainText(
      'It stops new orders, larger orders, new bots and copied trades. You can still cancel an order.',
    );
    // The reason identity stored with the restriction, read back from identity itself: the code staff chose and the
    // owner's words and next step for it.
    const mine = await client.get('/api/identity/trpc/accountStatus.mine');
    expect(mine.status).toBe(200);
    const stored = mine.body.result.data.restrictions.filter((r) => r.kind === 'trading_restricted');
    expect(stored.map((r) => r.owner)).toEqual([TRADING_REASON]);
    // The page says that stored reason in plain words, with its next step, and that only support lifts it.
    await expect(restriction).toHaveAttribute('data-reason', TRADING_REASON.code);
    await expect(restriction).toContainText(TRADING_REASON.text);
    await expect(restriction).toContainText(`Next: ${TRADING_REASON.guidance}`);
    await expect(restriction).not.toContainText('No reason recorded.');
    // In plain words: the owner's sentence, never the stored code or the refusal's typed code.
    await expect(restriction).not.toContainText(TRADING_REASON.code);
    await expect(status).not.toContainText('trade.account_restricted');
    await expect(restriction).toContainText('Only support can lift this.');
    await expect(status.getByTestId('account-status__cannot').locator('li')).toHaveText(['Trade']);

    // Cancel still works while it holds: the earlier order is cancelled and its hold released.
    const cancel = await client.delete(`/api/v1/orders/${earlier.id}?symbol=${encodeURIComponent('BTC/USDT')}`);
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    await expect.poll(async () => (await openOrders(who)).length, { timeout: 20_000 }).toBe(0);
    // Its hold is released: nothing is held, and all of the same total is free again.
    await expect
      .poll(async () => (await client.balances()).USDT, { timeout: 20_000 })
      .toEqual({ free: usdtBefore.total, used: expect.stringMatching(/^0(\.0+)?$/), total: usdtBefore.total });

    // Lifted, again with two people: the same order goes through and rests.
    expect(tool('local-test-gates.mjs', 'trading-restrict', who.handle, 'restore')).toMatch(/OK .* trading restore: changed/);
    lifted = true;
    await page.goto('/uc/account');
    await expect(status.getByTestId('account-status__state')).toHaveAttribute('data-state', 'active');
    await page.goto(deskPath());
    const accepted = sends();
    await order();
    await confirm(page, 'buy');
    expect((await accepted).status()).toBeLessThan(300);
    await expect.poll(async () => (await openOrders(who)).length, { timeout: 20_000 }).toBe(1);
  } finally {
    // Lift it if the test stopped before its own lift, without hiding the first failure behind a second one.
    if (!lifted) {
      try {
        tool('local-test-gates.mjs', 'trading-restrict', who.handle, 'restore');
      } catch (error) {
        console.warn(`J-identity-08 #7: the lift after a failure failed too: ${error}`);
      }
    }
  }
});

// ── The platform posting freeze, as the founders' freeze desk does it (A asks, B approves, A runs) ─────────────────────

const founders = { a: null, b: null };
test.afterAll(async () => {
  for (const key of ['a', 'b']) await founders[key]?.context().close();
});
async function founderPages(browser) {
  for (const key of ['a', 'b']) {
    if (founders[key]) continue;
    founders[key] = await (await browser.newContext()).newPage();
    await founderSignIn(founders[key], key);
    await founders[key].goto(`${ADMIN}/`, { waitUntil: 'load' });
  }
  return founders;
}

const freezeStep = (page, body) =>
  page.evaluate(async (payload) => {
    const session = await (await fetch('/api/session', { cache: 'no-store' })).json();
    const res = await fetch('/api/ledger-freeze', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-intafaced-csrf': session.csrf },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json() };
  }, body);

const decode = (text) => JSON.parse(Buffer.from(text.slice('ifa1.'.length), 'base64url').toString('utf8'));
const readFreeze = (page) => page.evaluate(async () => (await fetch('/api/ledger-freeze', { cache: 'no-store' })).json());

async function setPostingFreeze(browser, frozen) {
  const { a, b } = await founderPages(browser);
  const record = await readFreeze(a);
  expect(record.ok, JSON.stringify(record)).toBe(true);
  if (record.state.frozen === frozen) return;
  const version = record.state.version;
  const request = frozen
    ? { kind: 'ledger.freeze', reason: `LOCAL TEST ${J} #7 posting freeze`, version }
    : { kind: 'ledger.unfreeze', version };
  const confirm = frozen ? 'FREEZE LEDGER' : 'UNFREEZE LEDGER';
  const proposed = await freezeStep(a, { step: 'propose', request, confirm });
  expect(proposed.body.ok, JSON.stringify(proposed.body)).toBe(true);
  const packet = decode(proposed.body.packet);
  const approved = await freezeStep(b, { step: 'approve', request, confirm, approvalId: packet.approvalId });
  expect(approved.body.ok, JSON.stringify(approved.body)).toBe(true);
  const ran = await freezeStep(a, { step: 'execute', request, confirm, approvalId: packet.approvalId, operationId: packet.operationId });
  expect(ran.body.ok, JSON.stringify(ran.body)).toBe(true);
  expect((await readFreeze(a)).state.frozen).toBe(frozen);
}

/** Set from just before #7 asks for the posting freeze until it is lifted, so the teardown below can lift it after a timeout. */
let freezeOn = false;

// A posting freeze left on refuses every later journey's posts on this stack (main run 41151424814: J-ops-console-22 and
// J-pay-03 went red with ledger.frozen). A timeout closes the test's own pages before its finally can run, so the
// freeze is lifted here on fresh founder pages, as J-ops-console-04's holds journey does.
test.afterEach(async ({ browser }) => {
  if (!freezeOn) return;
  founders.a = null;
  founders.b = null;
  await setPostingFreeze(browser, false);
  freezeOn = false;
});

/** Wording that would make the platform's posting freeze read as this account's own restriction. */
const ACCOUNT_HOLD_WORDS = /restricted|on hold|suspended|your account is (limited|blocked|frozen)/i;

test(`${J} #7: a platform posting freeze never reads as "your account is restricted"`, async ({ page, browser }) => {
  test.setTimeout(360_000);
  // A verified person with TEST USDT, so the order reaches the ledger: the freeze, not a missing level or balance, is
  // what refuses it. The deposit is only the precondition; nothing here counts it as a step.
  const who = await fundedTrader(page, 'kvfz', '100');
  await openDesk(page, who);
  const client = await api(who);
  const before = await client.balances();
  const restingBefore = (await openOrders(who)).map((o) => o.id);
  try {
    freezeOn = true;
    await setPostingFreeze(browser, true);
    // On another screen, the trade desk: the order is refused as paused for everyone, never as this account's hold.
    const sent = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/orders' && r.request().method() === 'POST');
    // 10 USDT at a fixed TEST price: over the market's minimum, under the TEST balance; the book is not needed.
    const review = await reviewLimit(page, 'buy', '10000.00', '0.001');
    await review.getByRole('button', { name: 'Confirm buy' }).click();
    const answer = await sent;
    expect(answer.status()).toBe(400);
    // svc-trade names a freeze that stopped the order before the engine `posting_frozen` (a refusal: nothing was held).
    const refusal = await answer.json();
    expect(refusal.intafacedCode, JSON.stringify(refusal)).toBe('posting_frozen');
    expect(refusal.code).toBe('OnMaintenance');
    const main = page.getByRole('main');
    await expect(main.getByText('Orders are paused right now')).toBeVisible();
    await expect(main.getByText("Orders can't go through at the moment, and this one wasn't placed. Try again later.")).toBeVisible();
    // Nowhere on the page, not only in the desk: no wording that makes it this account's restriction.
    await expect(page.locator('body')).not.toContainText(ACCOUNT_HOLD_WORDS);

    // Re-read: the refused order moved nothing. Free and held USDT are what they were, the same orders rest, and no
    // order, open or closed, carries the refused request's client id.
    const clientOrderId = answer.request().postDataJSON()?.clientOrderId;
    expect(clientOrderId, 'the desk sends a client order id').toBeTruthy();
    const after = await client.balances();
    expect(free(after, 'USDT')).toBe(free(before, 'USDT'));
    expect(held(after, 'USDT')).toBe(held(before, 'USDT'));
    expect((await openOrders(who)).map((o) => o.id)).toEqual(restingBefore);
    expect((await openOrders(who)).filter((o) => o.clientOrderId === clientOrderId)).toEqual([]);
    const closed = await client.get(`/api/v1/orders/closed?symbol=${encodeURIComponent('BTC/USDT')}&limit=100`);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.filter((o) => o.clientOrderId === clientOrderId)).toEqual([]);

    // The account status, read while the freeze is on: the account is active and nothing on it is restricted.
    await page.goto('/uc/account');
    const status = page.getByTestId('account-status');
    await expect(status.getByTestId('account-status__state')).toHaveAttribute('data-state', 'active');
    await expect(status).toContainText('Your account is active. Nothing is restricted.');
    await expect(status.getByTestId('account-status__cannot').locator('li')).toHaveText(['Nothing']);
    await expect(status.getByTestId('account-status__restrictions').locator('li')).toHaveCount(0);
    // Identity's own record agrees: active, with no restriction listed.
    const mine = await client.get('/api/identity/trpc/accountStatus.mine');
    expect(mine.status).toBe(200);
    expect([mine.body.result.data.state, mine.body.result.data.restrictions]).toEqual(['active', []]);

    // And on /verification: nothing is restricted on the account, and no capability reads switched off.
    await page.goto('/verification');
    await expect(page.getByTestId('verification__restrictions-none')).toHaveText('Nothing is restricted on your account.');
    await expect(
      page.getByRole('region', { name: 'Capabilities' }).locator('[data-testid="verification__capability"][data-state="inactive"]'),
    ).toHaveCount(0);
  } finally {
    await setPostingFreeze(browser, false);
    freezeOn = false;
  }
});
