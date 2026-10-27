import { randomBytes } from 'node:crypto';
import { test, expect } from '@playwright/test';
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

test(`${J}, part of #1 (I-kyc-compliance-04): a ladder of levels, and every gated feature says which level unlocks it`, async ({
  page,
}) => {
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

test(`${J}, part of #1 (I-kyc-compliance-05): requirements not published say none are published; the review time is stated or says it is not`, async ({
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

test(`${J}, part of #1 (I-kyc-compliance-04, withdrawal limits): owner limits not set read "not set"`, async ({ page }) => {
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
  test.setTimeout(60_000);
  await atVerification(page);
  await expect(page.getByRole('button', { name: 'Start guided verification' })).toBeVisible(UNBUILT);
});

test(`${J} #3: with the face check switched off the selfie is kept for manual review; a hand-off link used twice is refused`, async ({
  page,
}) => {
  test.setTimeout(60_000);
  await atVerification(page);
  await expect(page.getByRole('heading', { name: 'Selfie and liveness' })).toBeVisible(UNBUILT);
});

test(`${J} #4: too many failed attempts give a typed lockout with the seconds left, or say no limit is set`, async ({ page }) => {
  test.setTimeout(60_000);
  await atVerification(page);
  await expect(page.getByText(/Try again in \d+ seconds|No attempt limit is set/)).toBeVisible(UNBUILT);
});

test(`${J} #5: proof of address, the risk questionnaire and tax certification, with honest refusals`, async ({ page }) => {
  test.setTimeout(60_000);
  await atVerification(page);
  await expect(page.getByRole('heading', { name: 'Proof of address' })).toBeVisible(UNBUILT);
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
  test.setTimeout(60_000);
  await atVerification(page);
  await expect(page.getByRole('heading', { name: 'Restrictions on your account' })).toBeVisible(UNBUILT);
});
