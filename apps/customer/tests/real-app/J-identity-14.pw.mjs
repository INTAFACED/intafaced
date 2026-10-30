import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { api, mailedLines, signUpInBrowser, tool } from './stack.mjs';

// J-identity-14, in the running app (docs/roadmap/journeys.json): my account is restricted and I appeal.
// Starts signed in, with staff having restricted the account with a reason. Ends with the appeal decided by someone other
// than the person who restricted, and the restriction lifted or upheld with a reason the person can read.
// The restriction a signed-in person can appeal today is the trading restriction (I-account-lifecycle-12). Clauses whose
// part is not built yet fail by name.
const J = 'J-identity-14';

/** Every entry of an owner reason list in identity's TEST owner values, as identity returns its words. */
function ownerReasons(setting) {
  const raw = JSON.parse(readFileSync(new URL('../../../../tooling/profiles/test-owner-values/identity.json', import.meta.url), 'utf8'));
  return JSON.parse(raw.values[setting].value).map((r) => ({ code: r.code, text: r.reason, guidance: r.guidance }));
}
const [TRADING_REASON] = ownerReasons('IDENTITY_TRADING_RESTRICTION_REASONS');
const [LIFT_REASON, UPHOLD_REASON] = ownerReasons('IDENTITY_APPEAL_DECISION_REASONS');
const WINDOW_DAYS = JSON.parse(
  readFileSync(new URL('../../../../tooling/profiles/test-owner-values/identity.json', import.meta.url), 'utf8'),
).values.IDENTITY_APPEAL_WINDOW_DAYS.value;

function person(prefix = 'ap') {
  const handle = `${prefix}${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  return { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
}

/** A fresh TEST person signed up in this browser, whose trading staff restricted with the TEST reason. */
async function restricted(page, prefix) {
  const who = person(prefix);
  await signUpInBrowser(page, who);
  expect(tool('local-test-gates.mjs', 'trading-restrict', who.handle, 'restrict', TRADING_REASON.code)).toMatch(
    /OK .* trading restrict: changed/,
  );
  return who;
}

/** Identity's own record of this person's appeals and status, read with their session. */
async function readBack(client) {
  const appeals = await client.get('/api/identity/trpc/accountAppeal.mine');
  expect(appeals.status, JSON.stringify(appeals.body)).toBe(200);
  const status = await client.get('/api/identity/trpc/accountStatus.mine');
  expect(status.status, JSON.stringify(status.body)).toBe(200);
  return { mine: appeals.body.result.data, status: status.body.result.data };
}

/** File an appeal from the account status page, and see it listed as waiting. */
async function fileAppeal(page, text) {
  await page.goto('/uc/account');
  const panel = page.getByTestId('account-appeals');
  await expect(panel.getByText(`You can appeal within ${WINDOW_DAYS} days of the restriction starting.`)).toBeVisible();
  const submitted = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/accountAppeal.submit'));
  await panel.getByLabel('Why should this be lifted?').fill(text);
  await panel.getByRole('button', { name: 'Send appeal' }).click();
  expect((await submitted).status()).toBe(200);
  await expect(panel.getByRole('status')).toHaveText('Your appeal was sent. We will tell you the decision.');
  const listed = panel.getByTestId('account-appeals__appeal');
  await expect(listed).toHaveCount(1);
  await expect(listed).toHaveAttribute('data-status', 'submitted');
  await expect(listed).toContainText('Waiting for a decision');
  return panel;
}

const lifts = [];
test.afterAll(() => {
  // Leave no journey account restricted if a test stopped before its own lift.
  for (const handle of lifts) {
    try {
      tool('local-test-gates.mjs', 'trading-restrict', handle, 'restore');
    } catch {
      // Already lifted, which is what the test does on success.
    }
  }
});

test(`${J} #1 signs in to a restricted account: the status page shows the state, the stored reason in plain words and what is blocked; a staff close with a grace date lets me withdraw but not trade`, () => {
  throw new Error(
    'step #1 is not built yet: identity has no suspended state and no staff close with a grace date (I-account-lifecycle-13)',
  );
});

test(`${J} #2 opens a refusal on any screen: the same reason wording everywhere; ledger.frozen shows the platform message`, () => {
  throw new Error(
    "step #2 is not built yet: the desk's trade.account_restricted refusal does not carry the restriction's stored reason words (I-kyc-compliance-17)",
  );
});

test(`${J} #3 files an appeal: one open appeal at a time, a second is refused, a final closure refuses with "appeal not allowed"`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const who = await restricted(page, 'apf');
  lifts.push(who.handle);
  const client = await api(who);
  const panel = await fileAppeal(page, 'TEST: I only placed ordinary orders.');

  // Identity holds exactly that one appeal, open, for this restriction.
  const first = await readBack(client);
  expect(first.mine.windowDays).toBe(Number(WINDOW_DAYS));
  expect(first.mine.appeals).toHaveLength(1);
  expect(first.mine.appeals[0]).toMatchObject({
    restriction: 'trading_restricted',
    status: 'submitted',
    text: 'TEST: I only placed ordinary orders.',
    decision: null,
  });
  // While it is open the page offers no second form.
  await expect(panel.getByTestId('account-appeals__form')).toHaveCount(0);

  // A second appeal, sent straight to identity, is refused by name, and nothing is added.
  const second = await client.post('/api/identity/trpc/accountAppeal.submit', {
    restriction: 'trading_restricted',
    text: 'TEST: a second appeal',
    clientRequestId: `j14-second-${who.handle}`,
  });
  expect(second.status, JSON.stringify(second.body)).toBe(409);
  expect(second.body.error.data.cause.code).toBe('identity.appeal_open');
  const after = await readBack(client);
  expect(after.mine.appeals).toEqual(first.mine.appeals);
  await page.reload();
  await expect(page.getByTestId('account-appeals').getByTestId('account-appeals__appeal')).toHaveCount(1);

  throw new Error(
    'unbuilt: a final closure refusing with identity.appeal_not_allowed: a closed account cannot sign in, and identity has no signed-out appeal path yet (I-account-lifecycle-12)',
  );
});

test(`${J} #4 gets a decision, upheld: the restriction stays with a reason and a notice; the person who restricted cannot decide`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  // Upheld: the restriction stays, the page gives the reason in the owner's words, and a notice is mailed.
  const kept = await restricted(page, 'apu');
  lifts.push(kept.handle);
  const keptClient = await api(kept);
  await fileAppeal(page, 'TEST: please look again.');
  // The founder who set the restriction cannot decide its appeal: identity refuses that person by name.
  expect(tool('local-test-gates.mjs', 'appeal-decide', kept.handle, 'uphold', UPHOLD_REASON.code, '--as-restrictor')).toMatch(
    /REFUSED .* appeal uphold: .*identity\.appeal_decider_restricted/,
  );
  expect((await readBack(keptClient)).mine.appeals[0]).toMatchObject({ status: 'submitted', decision: null, decidedAt: null });
  // The other founder decides.
  expect(tool('local-test-gates.mjs', 'appeal-decide', kept.handle, 'uphold', UPHOLD_REASON.code)).toMatch(/OK .* appeal uphold: upheld/);
  const upheld = await readBack(keptClient);
  expect(upheld.mine.appeals).toHaveLength(1);
  expect(upheld.mine.appeals[0]).toMatchObject({
    status: 'upheld',
    decision: { outcome: 'upheld', reason: UPHOLD_REASON },
  });
  expect(upheld.status.state).toBe('restricted');
  expect(upheld.status.restrictions.filter((r) => r.kind === 'trading_restricted').map((r) => r.owner)).toEqual([TRADING_REASON]);
  await page.goto('/uc/account');
  const keptPanel = page.getByTestId('account-appeals');
  const keptRow = keptPanel.getByTestId('account-appeals__appeal');
  await expect(keptRow).toHaveAttribute('data-status', 'upheld');
  await expect(keptRow).toHaveAttribute('data-reason', UPHOLD_REASON.code);
  await expect(keptRow).toContainText('Upheld: the restriction stays');
  await expect(keptRow).toContainText(UPHOLD_REASON.text);
  await expect(keptRow).toContainText(`Next: ${UPHOLD_REASON.guidance}`);
  await expect(keptPanel).not.toContainText(UPHOLD_REASON.code);
  await expect(page.getByTestId('account-status__state')).toHaveAttribute('data-state', 'restricted');
  await expect.poll(() => mailedLines(kept.email, 'appeal-decided'), { timeout: 30_000 }).toHaveLength(1);
  expect(mailedLines(kept.email, 'appeal-decided')[0]).toMatch(/notice=appeal-decided outcome=upheld/);
});

test(`${J} #4 gets a decision, lifted: the restriction is released through four eyes with a reason and a notice`, async ({ page }) => {
  test.setTimeout(180_000);
  // The lift runs through the restore's four-eyes approval with the appeal as its reason, the restriction is released,
  // the page says so in the owner's words, and a notice is mailed.
  const freed = await restricted(page, 'apl');
  lifts.push(freed.handle);
  const freedClient = await api(freed);
  await fileAppeal(page, 'TEST: the review should clear me.');
  expect(tool('local-test-gates.mjs', 'appeal-decide', freed.handle, 'lift', LIFT_REASON.code)).toMatch(/OK .* appeal lift: lifted/);
  const lifted = await readBack(freedClient);
  expect(lifted.mine.appeals).toHaveLength(1);
  expect(lifted.mine.appeals[0]).toMatchObject({ status: 'lifted', decision: { outcome: 'lifted', reason: LIFT_REASON } });
  expect(lifted.status.state).toBe('active');
  expect(lifted.status.restrictions.filter((r) => r.kind === 'trading_restricted')).toEqual([]);
  await page.goto('/uc/account');
  await expect(page.getByTestId('account-status__state')).toHaveAttribute('data-state', 'active');
  const freedRow = page.getByTestId('account-appeals').getByTestId('account-appeals__appeal');
  await expect(freedRow).toHaveAttribute('data-status', 'lifted');
  await expect(freedRow).toContainText('Lifted: the restriction was removed');
  await expect(freedRow).toContainText(LIFT_REASON.text);
  await expect(freedRow).toContainText(`Next: ${LIFT_REASON.guidance}`);
  await expect.poll(() => mailedLines(freed.email, 'appeal-decided'), { timeout: 30_000 }).toHaveLength(1);
  expect(mailedLines(freed.email, 'appeal-decided')[0]).toMatch(/notice=appeal-decided outcome=lifted/);
  // A decided appeal is no longer open: there is nothing left to decide.
  expect(() => tool('local-test-gates.mjs', 'appeal-decide', freed.handle, 'uphold', UPHOLD_REASON.code)).toThrow(/has no open appeal/);
});
