import { randomBytes } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { signUpInBrowser } from './stack.mjs';

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
  await signUpInBrowser(page, person());
  await page.goto('/verification');
  const ladder = page.getByRole('region', { name: 'What each level unlocks' });
  return { ladder, rung: (level) => ladder.locator(`.verification__rung[data-level="${level}"]`) };
}

test(`${J}, part of #1 (I-kyc-compliance-04): a ladder of levels, and every gated feature says which level unlocks it`, async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { ladder, rung } = await atVerification(page);
  await expect(ladder.locator('.verification__rung')).toHaveCount(LEVELS.length);
  for (const [i, level] of LEVELS.entries())
    await expect(ladder.locator('.verification__rung').nth(i)).toHaveAttribute('data-level', level);
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
  const basic = rung('basic').locator('.verification__requirements');
  await expect(basic).toHaveAttribute('data-published', 'true');
  await expect(basic.locator('li')).toHaveText(['Legal name', 'Date of birth', 'Home address', 'Photo ID']);
  await expect(rung('basic').locator('.verification__review-time')).toHaveText('Review usually takes up to 24 hours.');
  for (const level of ['full', 'institutional']) {
    const list = rung(level).locator('.verification__requirements');
    await expect(list).toHaveAttribute('data-published', 'false');
    await expect(list).toHaveText('No requirements are published for this level yet.');
    await expect(list.locator('li')).toHaveCount(0);
    await expect(rung(level).locator('.verification__review-time')).toContainText('No review time is stated.');
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

test(`${J} #6: one case record with history; an approval unlocks the mapped features at once`, async ({ page }) => {
  test.setTimeout(60_000);
  await atVerification(page);
  await expect(page.getByRole('heading', { name: 'Case history' })).toBeVisible(UNBUILT);
});

test(`${J} #7: a restriction on another screen gives its reason in plain words and the next step`, async ({ page }) => {
  test.setTimeout(60_000);
  await atVerification(page);
  await expect(page.getByRole('heading', { name: 'Restrictions on your account' })).toBeVisible(UNBUILT);
});
