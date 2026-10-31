import { expect, test } from './journey.mjs';
import { randomUUID } from 'node:crypto';
import { ADMIN, founderSignIn } from './admin.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, signUpInBrowser, staffFreeze } from './stack.mjs';

// J-ops-console-04 step #6: lifting a staff freeze takes a second person. Founder A asks on Account controls; approving their
// own request is refused by identity (action_approval.same_person), and so is running it before anyone approved; founder B
// approves the same account, version and reason on their own console; the run lifts the freeze once and the history names
// both founders.

const login = (who) =>
  fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password }),
  });

/** One step of the two-founder request, posted as the signed-in founder in `page` (the console's own CSRF header). */
const step = (page, body) =>
  page.evaluate(async (payload) => {
    const session = await (await fetch('/api/session', { cache: 'no-store' })).json();
    const res = await fetch('/api/accounts/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-intafaced-csrf': session.csrf },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json() };
  }, body);

async function openAccount(page, userId) {
  await page.goto(`${ADMIN}/accounts`, { waitUntil: 'load' });
  await page.getByLabel('Account area').selectOption('identity');
  await page.getByLabel('Platform user ID').fill(userId);
  await page.getByRole('button', { name: 'Inspect account' }).click();
  await expect(page.getByRole('heading', { name: 'Restricted' })).toBeVisible({ timeout: 60_000 });
}

test('J-ops-console-04 #6 unfreezing needs a different approver: refused alone, done with a second founder, both in the history', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const tag = randomUUID().slice(0, 8);
  const who = { handle: `ops46${tag}`, email: `ops46-${tag}@local-test.invalid`, password: `Ops46-${tag}-Test!pass` };
  await signUpInBrowser(await (await browser.newContext({ baseURL: ORIGIN })).newPage(), who);
  const userId = await staffFreeze(who, `LOCAL TEST J-ops-console-04 #6 freeze ${tag}`);
  expect((await login(who)).status, 'the frozen customer cannot sign in').toBe(403);

  // Founder A asks for the restore.
  const a = await (await browser.newContext()).newPage();
  const founderA = await founderSignIn(a, 'a');
  await openAccount(a, userId);
  const desk = a.getByTestId('account-unfreeze');
  await desk.getByLabel(/^Why/).fill(`LOCAL TEST customer verified ${tag}`);
  const phrase = `UNFREEZE ACCOUNT ${userId.slice(0, 8)}`;
  await desk.getByLabel(/to confirm$/).fill(phrase);
  await desk.getByRole('button', { name: 'Ask a second founder to approve lifting the freeze' }).click();
  await expect(desk.getByTestId('packet-made')).toBeVisible({ timeout: 60_000 });
  const packetText = (await desk.getByLabel('Request packet').inputValue()).trim();
  const packet = JSON.parse(Buffer.from(packetText.slice('ifa1.'.length), 'base64url').toString('utf8'));

  // Alone: the console will not offer A an approve button, identity refuses A approving their own request, and a run
  // before anyone approved changes nothing.
  await desk.getByLabel(/to approve or run it$/).fill(phrase);
  await expect(desk.getByRole('button', { name: 'Approve this request' })).toBeDisabled();
  const selfApprove = await step(a, { step: 'approve', request: packet.request, confirm: phrase, approvalId: packet.approvalId });
  expect(selfApprove.body).toMatchObject({ ok: false, refusal: { code: 'action_approval.same_person' } });
  await desk.getByRole('button', { name: 'Run the approved request' }).click();
  await expect(desk.getByTestId('step-reply')).toContainText('That approval is not for this change');
  await expect(a.getByRole('heading', { name: 'Restricted' })).toBeVisible();
  expect((await login(who)).status, 'still frozen after the refusals').toBe(403);

  // Founder B, on their own console, reads the same request and approves it.
  const b = await (await browser.newContext()).newPage();
  const founderB = await founderSignIn(b, 'b');
  await openAccount(b, userId);
  const deskB = b.getByTestId('account-unfreeze');
  await deskB.getByLabel('Request packet').fill(packetText);
  await expect(deskB.getByTestId('packet-summary')).toContainText('Lift the staff freeze');
  await deskB.getByLabel(/to approve or run it$/).fill(phrase);
  await deskB.getByRole('button', { name: 'Approve this request' }).click();
  await expect(deskB.getByTestId('step-reply')).toContainText('Approved.');

  // A runs it: the freeze lifts once, the history names both, and the customer can sign in again.
  await desk.getByLabel(/to approve or run it$/).fill(phrase);
  await desk.getByRole('button', { name: 'Run the approved request' }).click();
  await expect(a.getByRole('heading', { name: 'Access permitted' })).toBeVisible({ timeout: 60_000 });
  // Identity's history keeps the refused early run too; the change is the row with outcome "changed".
  const rows = a.locator('table tbody tr').filter({ hasText: `LOCAL TEST customer verified ${tag}` });
  await expect(rows.filter({ hasText: 'refused' })).toHaveCount(1);
  const row = rows.filter({ hasText: 'changed' });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('restore');
  await expect(row).toContainText(founderA.userId.slice(0, 8));
  await expect(row).toContainText(founderB.userId.slice(0, 8));
  expect((await login(who)).status, 'the customer can sign in again').toBe(200);

  // The spent approval cannot lift a second freeze.
  await staffFreeze(who, `LOCAL TEST J-ops-console-04 #6 refreeze ${tag}`);
  const again = await step(b, {
    step: 'execute',
    request: packet.request,
    confirm: phrase,
    approvalId: packet.approvalId,
    operationId: packet.operationId,
  });
  // Identity refuses it (the account moved to a new version, and the approval is spent) and nothing changes.
  expect(again.body.ok).toBe(false);
  expect(['restriction.version_conflict', 'restriction_approval_consumed']).toContain(again.body.refusal.code);
  expect((await login(who)).status, 'the refrozen customer stays frozen').toBe(403);
});
