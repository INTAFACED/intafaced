import { expect, test } from './journey.mjs';
import { randomUUID } from 'node:crypto';
import { ADMIN, founderSignIn } from './admin.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, signUpInBrowser } from './stack.mjs';

// J-ops-console-04 step #11: move an account to another product tier. The stack's TEST tiers (labelled TEST, never an
// owner decision) include one whose monthly fee is blank: the console will not offer it and identity refuses it
// (identity.tier_terms_unset), even with two founders. A move needs the other founder: a run before they approved
// changes nothing; once founder B approves the same account, tier, reason and tier version, the run moves it once and the
// history names both.

/** One step of the two-founder request, posted as the signed-in founder in `page` (the console's own CSRF header). */
const step = (page, body) =>
  page.evaluate(async (payload) => {
    const session = await (await fetch('/api/session', { cache: 'no-store' })).json();
    const res = await fetch('/api/accounts/tier', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-intafaced-csrf': session.csrf },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json() };
  }, body);

const decode = (text) => JSON.parse(Buffer.from(text.slice('ifa1.'.length), 'base64url').toString('utf8'));

async function openTier(page, userId) {
  await page.goto(`${ADMIN}/accounts`, { waitUntil: 'load' });
  await page.getByLabel('Account area').selectOption('identity');
  await page.getByLabel('Platform user ID').fill(userId);
  await page.getByRole('button', { name: 'Inspect account' }).click();
  const panel = page.getByTestId('account-tier');
  await expect(panel.getByTestId('account-tier-status')).toBeVisible({ timeout: 60_000 });
  return panel;
}

test('J-ops-console-04 #11 a tier move needs the other founder, and a tier with a blank fee is refused', async ({ browser }) => {
  test.setTimeout(300_000);
  const tag = randomUUID().slice(0, 8);
  const who = { handle: `ops411${tag}`, email: `ops411-${tag}@local-test.invalid`, password: `Ops411-${tag}-Test!pass` };
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

  // The account is on no tier; the TEST tiers show their terms, and the blank fee says "not set".
  const panel = await openTier(a, userId);
  await expect(panel.getByTestId('account-tier-status')).toContainText('Not on a tier');
  const premierRow = panel.getByTestId('account-tier-list').locator('tbody tr').filter({ hasText: 'TEST Premier' });
  await expect(premierRow).toContainText('not set');

  // The tier with a blank fee cannot be chosen on the desk, and identity refuses it even with two founders.
  await panel.getByLabel('Move to tier').selectOption({ label: 'TEST Premier' });
  await expect(panel).toContainText('identity.tier_terms_unset');
  await expect(panel.getByRole('button', { name: 'Tier move unavailable' })).toBeDisabled();
  const phrase = `MOVE TIER ${userId.slice(0, 8)}`;
  const premier = {
    kind: 'identity.account.tier_move',
    userId,
    tierId: 'test-premier',
    reason: `LOCAL TEST try premier ${tag}`,
    version: '0',
  };
  const proposed = await step(a, { step: 'propose', request: premier, confirm: phrase });
  expect(proposed.body.ok, JSON.stringify(proposed.body).slice(0, 300)).toBe(true);
  const premierPacket = decode(proposed.body.packet);
  expect((await step(b, { step: 'approve', request: premier, confirm: phrase, approvalId: premierPacket.approvalId })).body.ok).toBe(true);
  const refused = await step(a, {
    step: 'execute',
    request: premier,
    confirm: phrase,
    approvalId: premierPacket.approvalId,
    operationId: premierPacket.operationId,
  });
  expect(refused.body).toMatchObject({ ok: false, refusal: { code: 'identity.tier_terms_unset' } });
  expect(refused.body.refusal.body).toContain('Blank: monthlyFee.');

  // Founder A asks to move the account to TEST Plus.
  const desk = await openTier(a, userId);
  await desk.getByLabel('Move to tier').selectOption({ label: 'TEST Plus' });
  const why = `LOCAL TEST customer qualifies for plus ${tag}`;
  await desk.getByLabel(/^Why/).fill(why);
  await desk.getByLabel(/to confirm$/).fill(phrase);
  await desk.getByRole('button', { name: 'Ask the other founder to approve the tier move' }).click();
  await expect(desk.getByTestId('packet-made')).toBeVisible({ timeout: 60_000 });
  const packetText = (await desk.getByLabel('Request packet').inputValue()).trim();

  // Alone: no approve button for A, and a run before B approved changes nothing.
  await desk.getByLabel(/to approve or run it$/).fill(phrase);
  await expect(desk.getByRole('button', { name: 'Approve this request' })).toBeDisabled();
  await desk.getByRole('button', { name: 'Run the approved request' }).click();
  await expect(desk.getByTestId('step-reply')).toContainText('That approval is not for this change');
  await expect(desk.getByTestId('account-tier-status')).toContainText('Not on a tier');

  // B approves the same request on their own console; A runs it: moved once, and the history names both.
  const deskB = await openTier(b, userId);
  await deskB.getByLabel('Request packet').fill(packetText);
  await expect(deskB.getByTestId('packet-summary')).toContainText('onto tier "test-plus"');
  await deskB.getByLabel(/to approve or run it$/).fill(phrase);
  await deskB.getByRole('button', { name: 'Approve this request' }).click();
  await expect(deskB.getByTestId('step-reply')).toContainText('Approved.');
  await desk.getByLabel(/to approve or run it$/).fill(phrase);
  await desk.getByRole('button', { name: 'Run the approved request' }).click();
  await expect(desk.getByTestId('account-tier-status')).toContainText('Tier: TEST Plus (test-plus)', { timeout: 60_000 });
  const moved = desk.getByTestId('account-tier-history').locator('tbody tr').filter({ hasText: why }).filter({ hasText: 'changed' });
  await expect(moved).toHaveCount(1);
  await expect(moved).toContainText('none → test-plus');
  await expect(moved).toContainText(founderA.userId.slice(0, 8));
  await expect(moved).toContainText(founderB.userId.slice(0, 8));
  await expect(desk.getByTestId('account-tier-history').locator('tbody tr').filter({ hasText: 'identity.tier_terms_unset' })).toContainText(
    'blank: monthlyFee',
  );
});
