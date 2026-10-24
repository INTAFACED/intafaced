import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ADMIN, founderSignIn } from './admin.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, signUpInBrowser } from './stack.mjs';

// J-ops-console-04 step #12, the override half: a founder sets a limit override with an expiry. The stack's TEST policy
// (labelled TEST, never an owner decision) lets an override last 48 hours and puts the ceiling at 5000 USDT and 5000 USDC.
// At or under it one founder sets it; above it the other founder must approve, and a run before they did changes
// nothing. At its stored end time identity stops answering with the override and the base limit applies again; a founder
// can also end one early. The other half of the step (a withdrawal meeting the limit) is the enforcing service's.

const REASON_LABEL = 'Why (kept in the override history, 12 to 255 characters)';

async function openLimits(page, userId) {
  await page.goto(`${ADMIN}/accounts`, { waitUntil: 'load' });
  await page.getByLabel('Account area').selectOption('identity');
  await page.getByLabel('Platform user ID').fill(userId);
  await page.getByRole('button', { name: 'Inspect account' }).click();
  const panel = page.getByTestId('account-limits');
  await expect(panel.getByTestId('account-limits-policy')).toBeVisible({ timeout: 60_000 });
  return panel;
}

async function fillOverride(panel, { assetId, rolling, minutes }) {
  await panel.getByLabel('Asset').selectOption(assetId);
  await panel.getByLabel(/^Over 24 hours/).fill(rolling);
  await panel.getByLabel('Lasts for (minutes)').fill(minutes);
}

test('J-ops-console-04 #12 a limit override applies until its stored expiry, then the base limit returns; above the owner ceiling it needs the other founder', async ({
  browser,
}) => {
  test.setTimeout(360_000);
  const tag = randomUUID().slice(0, 8);
  const who = { handle: `ops412${tag}`, email: `ops412-${tag}@local-test.invalid`, password: `Ops412-${tag}-Test!pass` };
  await signUpInBrowser(await (await browser.newContext({ baseURL: ORIGIN })).newPage(), who);
  const login = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password }),
  });
  const userId = (await login.json()).result.data.userId;

  const a = await (await browser.newContext()).newPage();
  const founderA = await founderSignIn(a, 'a');
  const b = await (await browser.newContext()).newPage();
  const founderB = await founderSignIn(b, 'b');

  // The TEST policy and no overrides: the base limits apply.
  const panel = await openLimits(a, userId);
  await expect(panel.getByTestId('account-limits-policy')).toContainText('Longest override: 48 hours');
  await expect(panel.getByTestId('account-limits-policy')).toContainText('USDT 5000');
  await expect(panel.getByTestId('account-limits-none')).toContainText('the base limits apply');

  // Above the ceiling: the console says the other founder must approve, and a run before they did changes nothing.
  await fillOverride(panel, { assetId: 'USDC', rolling: '8000', minutes: '60' });
  await expect(panel.getByTestId('account-limits-path')).toContainText('Above the USDC ceiling of 5000');
  const phrase = `RAISE LIMIT ${userId.slice(0, 8)}`;
  const why = `LOCAL TEST customer is buying a house ${tag}`;
  await panel.getByLabel(REASON_LABEL, { exact: true }).fill(why);
  await panel.getByLabel(/to confirm$/).fill(phrase);
  await panel.getByRole('button', { name: 'Ask the other founder to approve the override' }).click();
  await expect(panel.getByTestId('packet-made')).toBeVisible({ timeout: 60_000 });
  const packetText = (await panel.getByLabel('Request packet').inputValue()).trim();
  await panel.getByLabel(/to approve or run it$/).fill(phrase);
  await expect(panel.getByRole('button', { name: 'Approve this request' })).toBeDisabled();
  await panel.getByRole('button', { name: 'Run the approved request' }).click();
  await expect(panel.getByTestId('step-reply')).toContainText('That approval is not for this override');
  await expect(panel.getByTestId('account-limits-none')).toBeVisible();

  // B approves the same request on their own console; A runs it: set once, approved by B.
  const panelB = await openLimits(b, userId);
  await panelB.getByLabel('Request packet').fill(packetText);
  await expect(panelB.getByTestId('packet-summary')).toContainText('over 24 hours 8000');
  await panelB.getByLabel(/to approve or run it$/).fill(phrase);
  await panelB.getByRole('button', { name: 'Approve this request' }).click();
  await expect(panelB.getByTestId('step-reply')).toContainText('Approved.');
  await panel.getByLabel(/to approve or run it$/).fill(phrase);
  await panel.getByRole('button', { name: 'Run the approved request' }).click();
  const usdc = panel.getByTestId('account-limit-withdrawal-USDC');
  await expect(usdc).toContainText('over 24 hours 8000', { timeout: 60_000 });
  await expect(usdc).toContainText('In force');
  await expect(usdc).toContainText(founderB.userId.slice(0, 8));

  // At or under the ceiling one founder sets it, for one minute.
  const desk = await openLimits(a, userId);
  await fillOverride(desk, { assetId: 'USDT', rolling: '3000', minutes: '1' });
  await expect(desk.getByTestId('account-limits-path')).toContainText('you can set it yourself');
  await desk.getByLabel(/^Why, for an override you set yourself/).fill(`LOCAL TEST short raise for a move ${tag}`);
  await desk.getByRole('button', { name: 'Set override' }).click();
  await expect(desk.getByTestId('account-limits-reply')).toContainText('Saved: per transaction base · over 24 hours 3000 USDT');
  const usdt = desk.getByTestId('account-limit-withdrawal-USDT');
  await expect(usdt).toContainText('In force');

  // Its stored end time passes: identity no longer answers with it, and the base limit applies again.
  await expect
    .poll(
      async () => {
        const again = await openLimits(a, userId);
        return again.getByTestId('account-limit-withdrawal-USDT').innerText();
      },
      { timeout: 150_000, intervals: [10_000] },
    )
    .toContain('Ended at its stored time');

  // A founder ends the USDC override early; the history names who set, approved and ended each.
  const last = await openLimits(b, userId);
  await last.getByLabel(/^Why, for an override you set yourself/).fill(`LOCAL TEST house purchase is done ${tag}`);
  await last.getByTestId('account-limit-withdrawal-USDC').getByRole('button', { name: 'End now' }).click();
  await expect(last.getByTestId('account-limits-reply')).toContainText('Ended: the withdrawal override for USDC is cleared');
  await expect(last.getByTestId('account-limit-withdrawal-USDC')).toContainText(`Ended early by ${founderB.userId.slice(0, 8)}`);
  await expect(last.getByTestId('account-limit-withdrawal-USDT').getByRole('button', { name: 'End now' })).toBeDisabled();
  const history = last.getByTestId('account-limits-history').locator('tbody tr');
  await expect(history.filter({ hasText: 'ended early' })).toHaveCount(1);
  await expect(history.filter({ hasText: 'set: per transaction base · over 24 hours 8000' })).toContainText(founderA.userId.slice(0, 8));
  await expect(history.filter({ hasText: 'identity.limit_approval_mismatch' })).toHaveCount(1);
});
