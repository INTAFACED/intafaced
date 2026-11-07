// World: none
import { expect, test } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { unconfirmedAccount } from './p2p.mjs';
import { api } from './stack.mjs';
import { staffSignIn } from './staff.mjs';

// J-identity-20: I work the verification queue (compliance). Signed in to the admin app as compliance (the stack's TEST
// compliance member), on the verification queue. Money: none. The second reviewer is a TEST founder. Every case here is a
// fresh TEST customer's own request, made through identity's own kyc.submit.

/** A fresh TEST customer with one pending verification; returns its record and case ids. */
async function pendingCase(tag) {
  const who = await unconfirmedAccount(tag);
  const customer = await api(who);
  const submitted = await customer.post('/api/identity/trpc/kyc.submit', { tier: 'basic', jurisdiction: 'DE' });
  const record = submitted.body?.result?.data;
  expect(record?.status, JSON.stringify(submitted.body).slice(0, 300)).toBe('pending');
  const history = await customer.get(`/api/identity/trpc/kyc.history?input=${encodeURIComponent(JSON.stringify({ limit: 5 }))}`);
  const open = history.body?.result?.data?.cases?.find((c) => c.recordId === record.id);
  expect(open?.state, JSON.stringify(history.body).slice(0, 300)).toBe('submitted');
  return { userId: record.userId, recordId: record.id, caseId: open.id, who };
}

/** Pages the queue forward until the case's row shows, reading each page's rows on the way. Returns the row. */
async function pageTo(page, caseId) {
  const seen = new Set();
  for (let n = 0; n < 400; n++) {
    await expect(page.getByTestId('kyc-queue-meta')).toBeVisible({ timeout: 60_000 });
    const rows = page.getByTestId('kyc-queue-row');
    const ids = await rows.evaluateAll((els) => els.map((el) => el.getAttribute('data-case')));
    for (const id of ids) {
      // A cursor page never repeats a case another page showed.
      expect(seen.has(id), `case ${id} shown on two pages`).toBe(false);
      seen.add(id);
    }
    const row = page.locator(`[data-testid="kyc-queue-row"][data-case="${caseId}"]`);
    if ((await row.count()) === 1) return row;
    const next = page.getByRole('button', { name: 'Next page' });
    expect(await next.isEnabled(), `the queue ended without case ${caseId}`).toBe(true);
    const before = await page.getByTestId('kyc-queue-meta').getAttribute('data-page');
    await next.click();
    await expect(page.getByTestId('kyc-queue-meta')).not.toHaveAttribute('data-page', before ?? '', { timeout: 60_000 });
  }
  throw new Error(`case ${caseId} not found in 400 pages`);
}

test('J-identity-20 #1 the queue is a cursor page of pending cases in the owner page size; two reviewers claim at once, one wins and the other sees kyc.case_assigned', async ({
  browser,
}) => {
  test.setTimeout(480_000);
  // More open cases than one page holds, so the page fills and a next page exists, whatever else is waiting on this stack.
  const cases = [];
  for (let i = 0; i < 6; i++) cases.push(await pendingCase(`jq${i}x`));
  const target = cases[0];

  const compliance = await (await browser.newContext()).newPage();
  const founder = await (await browser.newContext()).newPage();
  await staffSignIn(compliance, browser, 'compliance');
  await founderSignIn(founder, 'a');
  try {
    // Opens the queue: a page of pending cases in the owner's page size (the stack's TEST value is 5).
    await compliance.goto(`${ADMIN}/identity-ops/kyc`, { waitUntil: 'load' });
    const meta = compliance.getByTestId('kyc-queue-meta');
    await expect(meta).toBeVisible({ timeout: 60_000 });
    await expect(meta).toHaveAttribute('data-page-size', '5');
    await expect(meta).toHaveAttribute('data-page', '1');
    await expect(compliance.getByTestId('kyc-queue-row')).toHaveCount(5);
    // At least six cases wait, so the page is full and identity gives a marker for the next page.
    await expect(compliance.getByRole('button', { name: 'Next page' })).toBeEnabled();
    // Every row is a pending case nobody else is working yet, or says who holds it.
    for (const label of await compliance.getByTestId('kyc-queue-assignee').allInnerTexts())
      expect(['Nobody', 'You', 'Another reviewer']).toContain(label.trim());

    // The next page is read by its cursor: different cases, never one from the page before.
    const rowCompliance = await pageTo(compliance, target.caseId);
    await expect(rowCompliance.getByTestId('kyc-queue-assignee')).toHaveText('Nobody');

    // The second reviewer (a founder) finds the same case on their own console.
    await founder.goto(`${ADMIN}/identity-ops/kyc`, { waitUntil: 'load' });
    const rowFounder = await pageTo(founder, target.caseId);
    await expect(rowFounder.getByTestId('kyc-queue-assignee')).toHaveText('Nobody');

    // Both claim at once: exactly one wins, the other is told the case is taken (kyc.case_assigned).
    await Promise.all([
      rowCompliance.getByRole('button', { name: 'Claim' }).click(),
      rowFounder.getByRole('button', { name: 'Claim' }).click(),
    ]);
    const outcome = async (row) => {
      await expect(row.getByTestId('kyc-queue-claimed').or(row.getByTestId('kyc-review-refusal'))).toBeVisible({ timeout: 60_000 });
      return (await row.getByTestId('kyc-queue-claimed').count()) === 1
        ? 'won'
        : await row.getByTestId('kyc-review-refusal').getAttribute('data-code');
    };
    const results = [await outcome(rowCompliance), await outcome(rowFounder)];
    expect(results.sort()).toEqual(['kyc.case_assigned', 'won']);
    const loser = results[0] === 'won' ? rowFounder : rowCompliance;
    await expect(loser.getByTestId('kyc-review-refusal')).toContainText('Another reviewer has this case');

    // Each reviewer's queue now names who holds it: the winner reads "You", the other "Another reviewer".
    const winnerRow = loser === rowFounder ? rowCompliance : rowFounder;
    await expect(winnerRow.getByTestId('kyc-queue-assignee')).toHaveText('You', { timeout: 60_000 });
    await expect(loser.getByTestId('kyc-queue-assignee')).toHaveText('Another reviewer', { timeout: 60_000 });
  } finally {
    await compliance.context().close();
    await founder.context().close();
  }
});
