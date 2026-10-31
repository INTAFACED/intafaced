import { expect, test } from './journey.mjs';
import { randomUUID } from 'node:crypto';
import { ADMIN, founderSignIn } from './admin.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, api, signUpInBrowser } from './stack.mjs';
import { verify } from './desk.mjs';

// J-ops-console-04 step #7: staff close an account with a second approver, then reopen it. Founder A asks on Account
// controls with a reason code; a run before anyone approved changes nothing; founder B approves the same account, version,
// code and reason on their own console; the run closes it once and the history names both. An account closed at the
// customer's request reopens the same way; one closed for a bank reason is refused (identity.reopen_not_allowed).
// While the customer still holds a card (the stack's TEST card simulator, never a live issuer) the approved close is
// refused with the card named and the approval kept; once the customer closes the card, the same approval closes it.

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
    const res = await fetch('/api/accounts/closure', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-intafaced-csrf': session.csrf },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json() };
  }, body);

const decode = (text) => JSON.parse(Buffer.from(text.slice('ifa1.'.length), 'base64url').toString('utf8'));

async function openAccount(page, userId) {
  await page.goto(`${ADMIN}/accounts`, { waitUntil: 'load' });
  await page.getByLabel('Account area').selectOption('identity');
  await page.getByLabel('Platform user ID').fill(userId);
  await page.getByRole('button', { name: 'Inspect account' }).click();
  await expect(page.getByTestId('account-closure-status')).toBeVisible({ timeout: 60_000 });
  return page.getByTestId('account-closure');
}

/** A asks on the closure desk; returns the packet text. */
async function ask(desk, { reasonCode, why, phrase, submit }) {
  if (reasonCode) await desk.getByLabel('Reason code').selectOption(reasonCode);
  await desk.getByLabel(/^Why/).fill(why);
  await desk.getByLabel(/to confirm$/).fill(phrase);
  await desk.getByRole('button', { name: submit }).click();
  await expect(desk.getByTestId('packet-made')).toBeVisible({ timeout: 60_000 });
  return (await desk.getByLabel('Request packet').inputValue()).trim();
}

async function approveOn(page, userId, packetText, phrase, summary) {
  const desk = await openAccount(page, userId);
  await desk.getByLabel('Request packet').fill(packetText);
  await expect(desk.getByTestId('packet-summary')).toContainText(summary);
  await desk.getByLabel(/to approve or run it$/).fill(phrase);
  await desk.getByRole('button', { name: 'Approve this request' }).click();
  await expect(desk.getByTestId('step-reply')).toContainText('Approved.');
}

test('J-ops-console-04 #7 close with a second approver, reopen a customer-closed account, refuse a bank-closed one', async ({
  browser,
}) => {
  test.setTimeout(420_000);
  const tag = randomUUID().slice(0, 8);
  const who = { handle: `ops47${tag}`, email: `ops47-${tag}@local-test.invalid`, password: `Ops47-${tag}-Test!pass` };
  const customer = await (await browser.newContext({ baseURL: ORIGIN })).newPage();
  await signUpInBrowser(customer, who);
  await verify(customer, who);
  const own = await api(who);
  const cardId = randomUUID();
  const issued = await own.post('/api/bank/trpc/cards.issue', {
    cardId,
    assetId: 'USDT',
    perAuthorizationLimit: '50',
    cardType: 'virtual',
  });
  expect(issued.status, JSON.stringify(issued.body).slice(0, 300)).toBe(200);
  expect(issued.body.result.data).toMatchObject({ status: 'active', simulated: true });
  const signedIn = await login(who);
  expect(signedIn.status, 'the open customer can sign in').toBe(200);
  const userId = (await signedIn.json()).result.data.userId;

  const a = await (await browser.newContext()).newPage();
  const founderA = await founderSignIn(a, 'a');
  const b = await (await browser.newContext()).newPage();
  const founderB = await founderSignIn(b, 'b');

  // Founder A asks to close it at the customer's request.
  const desk = await openAccount(a, userId);
  await expect(desk.getByTestId('account-closure-status')).toContainText('Open');
  const closePhrase = `CLOSE ACCOUNT ${userId.slice(0, 8)}`;
  const closeWhy = `LOCAL TEST customer letter ${tag}`;
  const closePacket = await ask(desk, {
    reasonCode: 'customer_request',
    why: closeWhy,
    phrase: closePhrase,
    submit: 'Ask a second founder to approve closing the account',
  });

  // Alone: no approve button for A, and a run before anyone approved changes nothing.
  await desk.getByLabel(/to approve or run it$/).fill(closePhrase);
  await expect(desk.getByRole('button', { name: 'Approve this request' })).toBeDisabled();
  await desk.getByRole('button', { name: 'Run the approved request' }).click();
  await expect(desk.getByTestId('step-reply')).toContainText('That approval is not for this change');
  expect((await login(who)).status, 'still open after the refusal').toBe(200);

  // B approves; A runs it while the card is still open: refused with the card named, nothing changed, approval kept.
  await approveOn(b, userId, closePacket, closePhrase, `Close account ${userId}`);
  await desk.getByLabel(/to approve or run it$/).fill(closePhrase);
  await desk.getByRole('button', { name: 'Run the approved request' }).click();
  await expect(desk.getByTestId('step-reply')).toContainText('The account still has open products or balances');
  await expect(desk.getByTestId('step-reply')).toContainText('Still open: 1 × card not closed.');
  expect((await login(who)).status, 'still open while a card is open').toBe(200);

  // The customer closes their card; the same approval now closes the account once.
  const cardClosed = await own.post('/api/bank/trpc/cards.setStatus', { cardId, status: 'closed' });
  expect(cardClosed.status, JSON.stringify(cardClosed.body).slice(0, 300)).toBe(200);
  expect(cardClosed.body.result.data.status).toBe('closed');
  await desk.getByLabel(/to approve or run it$/).fill(closePhrase);
  await desk.getByRole('button', { name: 'Run the approved request' }).click();
  await expect(desk.getByTestId('account-closure-status')).toContainText('Closed by the customer (customer request)', { timeout: 60_000 });
  expect((await login(who)).status, 'the closed customer cannot sign in').toBe(403);
  const closed = desk
    .getByTestId('account-closure-history')
    .locator('tbody tr')
    .filter({ hasText: closeWhy })
    .filter({ hasText: 'changed' });
  await expect(closed).toHaveCount(1);
  await expect(closed).toContainText(founderA.userId.slice(0, 8));
  await expect(closed).toContainText(founderB.userId.slice(0, 8));
  await expect(
    desk
      .getByTestId('account-closure-history')
      .locator('tbody tr')
      .filter({ hasText: 'identity.close_blocked' })
      .filter({ hasText: closeWhy }),
  ).toContainText('still open: 1 × card not closed');

  // Reopen: B asks this time, A approves, B runs it. The customer can sign in again.
  const deskB = await openAccount(b, userId);
  const reopenPhrase = `REOPEN ACCOUNT ${userId.slice(0, 8)}`;
  const reopenPacket = await ask(deskB, {
    why: `LOCAL TEST customer came back ${tag}`,
    phrase: reopenPhrase,
    submit: 'Ask a second founder to approve reopening the account',
  });
  await approveOn(a, userId, reopenPacket, reopenPhrase, `Reopen account ${userId}`);
  await deskB.getByLabel(/to approve or run it$/).fill(reopenPhrase);
  await deskB.getByRole('button', { name: 'Run the approved request' }).click();
  await expect(deskB.getByTestId('account-closure-status')).toContainText('Open', { timeout: 60_000 });
  expect((await login(who)).status, 'the reopened customer can sign in').toBe(200);

  // Close it again for a bank reason: it stays closed, and a reopen is refused by identity even with two founders.
  const deskA = await openAccount(a, userId);
  const bankWhy = `LOCAL TEST bank ended relationship ${tag}`;
  const bankPacket = await ask(deskA, {
    reasonCode: 'bank_reason',
    why: bankWhy,
    phrase: closePhrase,
    submit: 'Ask a second founder to approve closing the account',
  });
  await approveOn(b, userId, bankPacket, closePhrase, 'bank reason');
  await deskA.getByLabel(/to approve or run it$/).fill(closePhrase);
  await deskA.getByRole('button', { name: 'Run the approved request' }).click();
  await expect(deskA.getByTestId('account-closure-status')).toContainText('Closed by staff (bank reason)', { timeout: 60_000 });
  await expect(deskA).toContainText('identity.reopen_not_allowed');
  await expect(deskA.getByRole('button', { name: 'Reopen unavailable' })).toBeDisabled();
  const version = decode(bankPacket).request.version;
  const reopen = { kind: 'identity.account.reopen', userId, reason: `LOCAL TEST try reopen ${tag}`, version: String(BigInt(version) + 1n) };
  const proposed = await step(a, { step: 'propose', request: reopen, confirm: reopenPhrase });
  expect(proposed.body.ok).toBe(true);
  const packet = decode(proposed.body.packet);
  expect((await step(b, { step: 'approve', request: reopen, confirm: reopenPhrase, approvalId: packet.approvalId })).body.ok).toBe(true);
  const refused = await step(a, {
    step: 'execute',
    request: reopen,
    confirm: reopenPhrase,
    approvalId: packet.approvalId,
    operationId: packet.operationId,
  });
  expect(refused.body).toMatchObject({ ok: false, refusal: { code: 'identity.reopen_not_allowed' } });
  expect((await login(who)).status, 'the bank-closed customer stays out').toBe(403);
});
