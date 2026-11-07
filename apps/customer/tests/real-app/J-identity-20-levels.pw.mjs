// World: gates
import { expect, test } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { unconfirmedAccount } from './p2p.mjs';
import { api } from './stack.mjs';
import { staffSignIn } from './staff.mjs';

// J-identity-20 #7: per-level requirements and review times. Editing one is a platform-wide setting on the shared stack (the
// customer ladder of J-identity-08 #1 reads it), so this file declares `gates`, runs alone, and puts the level back to the
// owner's published TEST values before it ends, with the same two-person change.

/** One level's row on the settings page. */
const rowOf = (page, level) => page.locator(`[data-testid="kyc-level-row"][data-level="${level}"]`);

/** Propose a change on `page`; it then waits for a second person. */
async function propose(page, { level, restore = false, minutes = '' }) {
  await page.goto(`${ADMIN}/identity-ops/kyc/levels`, { waitUntil: 'load' });
  const form = page.getByTestId('kyc-level-propose');
  await expect(form).toBeVisible({ timeout: 60_000 });
  await form.getByLabel('Level').selectOption(level);
  if (restore) await form.getByLabel("Back to the owner's values").check();
  else await form.getByLabel('Review time in minutes').fill(minutes);
  await form.getByRole('button', { name: 'Propose this change' }).click();
  await expect(page.getByTestId('kyc-level-reply')).toHaveText('Change proposed. It waits for a second person.', { timeout: 60_000 });
  return page.locator(`[data-testid="kyc-level-change"][data-level="${level}"]`);
}

/** The second person approves the waiting change for `level` on their own console. */
async function approveOn(page, level) {
  await page.goto(`${ADMIN}/identity-ops/kyc/levels`, { waitUntil: 'load' });
  const change = page.locator(`[data-testid="kyc-level-change"][data-level="${level}"]`);
  await change.getByRole('button', { name: 'Approve this change' }).click({ timeout: 60_000 });
  await expect(page.getByTestId('kyc-level-reply')).toHaveText('Change approved and in force.', { timeout: 60_000 });
}

test('J-identity-20 #7 an edit to per-level requirements and review times waits for a second person; an overdue stated review time shows an escalation line', async ({
  browser,
}) => {
  test.setTimeout(480_000);
  const compliance = await (await browser.newContext()).newPage();
  const founder = await (await browser.newContext()).newPage();
  await staffSignIn(compliance, browser, 'compliance');
  await founderSignIn(founder, 'a');
  let edited = false;
  try {
    // The owner's TEST values state no review time for institutional.
    await compliance.goto(`${ADMIN}/identity-ops/kyc/levels`, { waitUntil: 'load' });
    await expect(rowOf(compliance, 'institutional')).toHaveAttribute('data-review-minutes', '', { timeout: 60_000 });

    // Compliance edits institutional's review time to one minute: the change waits, and nothing is in force yet.
    const waiting = await propose(compliance, { level: 'institutional', minutes: '1' });
    await expect(waiting).toContainText('review time 1 min');
    await expect(rowOf(compliance, 'institutional')).toHaveAttribute('data-review-minutes', '');
    // The proposer cannot be the second person.
    await waiting.getByRole('button', { name: 'Approve this change' }).click();
    await expect(compliance.getByTestId('kyc-level-refusal')).toHaveAttribute('data-code', 'kyc.same_reviewer', { timeout: 60_000 });
    await expect(rowOf(compliance, 'institutional')).toHaveAttribute('data-review-minutes', '');

    // A different person approves it, and only then is it in force.
    await approveOn(founder, 'institutional');
    edited = true;
    await compliance.goto(`${ADMIN}/identity-ops/kyc/levels`, { waitUntil: 'load' });
    await expect(rowOf(compliance, 'institutional')).toHaveAttribute('data-review-minutes', '1', { timeout: 60_000 });
    await expect(rowOf(compliance, 'institutional')).toHaveAttribute('data-edited', 'true');

    // A request at that level, open past its one stated minute, shows the escalation line on its case.
    const who = await unconfirmedAccount('jo');
    const customer = await api(who);
    const sent = await customer.post('/api/identity/trpc/kyc.submit', { tier: 'institutional', jurisdiction: 'DE' });
    expect(sent.body?.result?.data?.status, JSON.stringify(sent.body).slice(0, 300)).toBe('pending');
    const history = await customer.get(`/api/identity/trpc/kyc.history?input=${encodeURIComponent(JSON.stringify({ limit: 5 }))}`);
    const open = history.body?.result?.data?.cases?.find((c) => c.recordId === sent.body.result.data.id);
    expect(open?.state).toBe('submitted');
    await compliance.goto(`${ADMIN}/identity-ops/kyc/${open.id}`, { waitUntil: 'load' });
    await expect(compliance.getByTestId('kyc-case-review')).toBeVisible({ timeout: 60_000 });
    // Inside the minute: no escalation yet.
    await expect(compliance.getByTestId('kyc-case-overdue')).toHaveCount(0);
    const dueIn = Date.parse(open.submittedAt) + 60_000 - Date.now();
    if (dueIn > -5_000) await new Promise((resolve) => setTimeout(resolve, Math.max(0, dueIn) + 5_000));
    await compliance.reload({ waitUntil: 'load' });
    const overdue = compliance.getByTestId('kyc-case-overdue');
    await expect(overdue).toBeVisible({ timeout: 60_000 });
    await expect(overdue).toContainText('The stated review time for institutional ran out');
    await expect(overdue).toContainText('Escalate it');
  } finally {
    // Put institutional back to the owner's published values, with the same two-person change.
    if (edited) {
      await propose(compliance, { level: 'institutional', restore: true });
      await approveOn(founder, 'institutional');
      await compliance.goto(`${ADMIN}/identity-ops/kyc/levels`, { waitUntil: 'load' });
      await expect(rowOf(compliance, 'institutional')).toHaveAttribute('data-edited', 'false', { timeout: 60_000 });
      await expect(rowOf(compliance, 'institutional')).toHaveAttribute('data-review-minutes', '');
    }
    await compliance.context().close();
    await founder.context().close();
  }
});
