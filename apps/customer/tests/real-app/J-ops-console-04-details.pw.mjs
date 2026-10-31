import { expect, test } from './journey.mjs';
import { randomUUID } from 'node:crypto';
import { ADMIN, founderSignIn } from './admin.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, signUpInBrowser } from './stack.mjs';

// J-ops-console-04 step #9: edit the customer's name. A change of a contact detail applies at once with one founder and a
// reason. A change of the legal name opens a compliance review instead: the record keeps the old name, the founder who
// asked cannot decide it (identity.details_review_self_forbidden), and only the other founder's pass applies the new
// name. The history names the fields and the people, never a value.

const login = (who) =>
  fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password }),
  });

/** A POST as the signed-in founder in `page`, with the console's own CSRF header. */
const post = (page, path, body) =>
  page.evaluate(
    async ({ path, payload }) => {
      const session = await (await fetch('/api/session', { cache: 'no-store' })).json();
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-intafaced-csrf': session.csrf },
        body: JSON.stringify(payload),
      });
      return { status: res.status, body: await res.json() };
    },
    { path, payload: body },
  );

async function openDetails(page, userId) {
  await page.goto(`${ADMIN}/accounts`, { waitUntil: 'load' });
  await page.getByLabel('Account area').selectOption('identity');
  await page.getByLabel('Platform user ID').fill(userId);
  await page.getByRole('button', { name: 'Inspect account' }).click();
  const panel = page.getByTestId('account-details');
  await expect(panel.getByTestId('account-details-table')).toBeVisible({ timeout: 60_000 });
  return panel;
}

const row = (panel, key) => panel.getByTestId('account-details-table').locator(`tr[data-detail="${key}"] td`);

async function change(panel, { detail, value, why, submit }) {
  await panel.getByLabel('Detail to change').selectOption(detail);
  await panel.getByLabel('New value').fill(value);
  await panel.getByLabel(/^Why/).fill(why);
  await panel.getByRole('button', { name: submit }).click();
}

async function pass(page, userId, note) {
  const panel = await openDetails(page, userId);
  await panel.getByLabel(/^Decision note/).fill(note);
  await panel.getByRole('button', { name: 'Pass the review' }).click();
  await expect(panel.getByTestId('account-details-reply')).toContainText('Review passed: identity applied Legal name');
  return panel;
}

test('J-ops-console-04 #9 a name edit opens a compliance review and the old name stays until the other founder passes it', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const tag = randomUUID().slice(0, 8);
  const who = { handle: `ops49${tag}`, email: `ops49-${tag}@local-test.invalid`, password: `Ops49-${tag}-Test!pass` };
  const customer = await (await browser.newContext({ baseURL: ORIGIN })).newPage();
  await signUpInBrowser(customer, who);
  const signedIn = await login(who);
  expect(signedIn.status).toBe(200);
  const userId = (await signedIn.json()).result.data.userId;

  const a = await (await browser.newContext()).newPage();
  const founderA = await founderSignIn(a, 'a');
  const b = await (await browser.newContext()).newPage();
  const founderB = await founderSignIn(b, 'b');

  // Nothing is on record yet, and identity says so rather than fill anything in.
  let panel = await openDetails(a, userId);
  await expect(row(panel, 'legalName')).toHaveText('Not on record');
  await expect(panel.getByTestId('account-details-review')).toHaveText('No compliance review is open.');

  // A contact detail applies at once with one founder and a reason.
  await change(panel, { detail: 'city', value: 'Leeds', why: `LOCAL TEST moved house ${tag}`, submit: 'Save the change' });
  await expect(panel.getByTestId('account-details-reply')).toContainText('Saved: identity applied City');
  await expect(row(panel, 'city')).toHaveText('Leeds');

  // The first legal name goes through a review too: A asks, B passes.
  const firstName = `Ada Lovelace ${tag}`;
  await change(panel, {
    detail: 'legalName',
    value: firstName,
    why: `LOCAL TEST passport seen ${tag}`,
    submit: 'Ask for a compliance review',
  });
  await expect(panel.getByTestId('account-details-reply')).toContainText('Compliance review opened for Legal name');
  await expect(row(panel, 'legalName')).toHaveText('Not on record');
  await pass(b, userId, `LOCAL TEST passport matches ${tag}`);
  panel = await openDetails(a, userId);
  await expect(row(panel, 'legalName')).toHaveText(firstName);

  // The edit of step #9: A changes the name. A review opens and the old name stays.
  const newName = `Ada King ${tag}`;
  await change(panel, {
    detail: 'legalName',
    value: newName,
    why: `LOCAL TEST marriage certificate ${tag}`,
    submit: 'Ask for a compliance review',
  });
  await expect(panel.getByTestId('account-details-reply')).toContainText(
    'The record keeps the old value until the other founder passes it.',
  );
  await expect(row(panel, 'legalName')).toHaveText(firstName);
  const review = panel.getByTestId('account-details-review');
  await expect(review).toContainText(`Legal name: ${firstName} → ${newName}`);
  await expect(review).toContainText(founderA.userId.slice(0, 8));

  // A cannot decide their own request: the console says why, and identity refuses it anyway.
  await panel.getByLabel(/^Decision note/).fill(`LOCAL TEST self approve ${tag}`);
  await expect(panel.getByTestId('account-details-decide-why')).toContainText('identity.details_review_self_forbidden');
  await expect(panel.getByRole('button', { name: 'Pass the review' })).toBeDisabled();
  const state = await a.evaluate(async (id) => (await fetch(`/api/accounts/details?id=${id}`, { cache: 'no-store' })).json(), userId);
  const self = await post(a, '/api/accounts/details/decide', {
    userId,
    reviewId: state.openReview.reviewId,
    decision: 'pass',
    note: `LOCAL TEST self approve ${tag}`,
  });
  expect(self.body).toMatchObject({ ok: false, text: expect.stringContaining('identity.details_review_self_forbidden') });
  panel = await openDetails(a, userId);
  await expect(row(panel, 'legalName')).toHaveText(firstName);

  // B passes it: the new name is on record, the review is closed, and the history names fields and people, no values.
  await pass(b, userId, `LOCAL TEST certificate matches ${tag}`);
  panel = await openDetails(a, userId);
  await expect(row(panel, 'legalName')).toHaveText(newName);
  await expect(panel.getByTestId('account-details-review')).toHaveText('No compliance review is open.');
  const history = panel.getByTestId('account-details-history');
  await expect(history.locator('tbody tr').filter({ hasText: 'review opened' }).filter({ hasText: 'marriage certificate' })).toHaveCount(1);
  const applied = history.locator('tbody tr').filter({ hasText: 'applied' }).filter({ hasText: 'certificate matches' });
  await expect(applied).toHaveCount(1);
  await expect(applied).toContainText(founderB.userId.slice(0, 8));
  await expect(history).toContainText('refused (identity.details_review_self_forbidden)');
  await expect(history).not.toContainText(newName);
});
