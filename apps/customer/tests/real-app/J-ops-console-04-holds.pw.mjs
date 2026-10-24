import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ADMIN, founderSignIn } from './admin.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, api, fund, journeyState, signUpInBrowser, tool } from './stack.mjs';

// J-ops-console-04 steps #2-#5: staff holds on one TEST customer's funds, on the founder console's account page.
//   #2 founder A holds 40 of the customer's 100 TEST USDT with a reason: available falls to 60, the total stays 100; a hold
//      above what is available is refused by the ledger and holds nothing.
//   #3 founder A asks to release 15 of it; a run before anyone approved changes nothing; founder B approves the same hold and
//      amount on their own console; A runs it once: 25 stays held and 75 is available again.
//   #4 a hold with an expiry releases itself: the stack's TEST fixture moves its stored expiry to just past, and svc-ops' own
//      expiry worker releases what is left, with no approver.
//   #5 founder A asks to confirm the first hold, B approves, A runs it: the 25 still held leaves the customer's balance for
//      the TEST owner-named account, and the hold says so.
// Holds go out on the console's treasury credential (founder A's, on the stack); the money only ever moves in the ledger.

const J = 'J-ops-console-04-holds';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

const login = (who) =>
  fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password }),
  });

const usdt = async (who) => {
  const b = (await (await api(who)).balances()).USDT ?? { free: '0', used: '0', total: '0' };
  return { free: b.free, total: b.total };
};

function saved() {
  const state = run.read();
  if (!state.who || !state.userId || !state.firstHold) throw new Error('step #2 did not leave its customer and hold: run #2 first');
  return state;
}

async function openHolds(page, userId) {
  await page.goto(`${ADMIN}/accounts`, { waitUntil: 'load' });
  await page.getByLabel('Account area').selectOption('identity');
  await page.getByLabel('Platform user ID').fill(userId);
  await page.getByRole('button', { name: 'Inspect account' }).click();
  const holds = page.getByTestId('account-holds');
  await expect(holds.getByTestId('hold-settings')).toBeVisible({ timeout: 60_000 });
  return holds;
}

async function placeHold(holds, { amount, reason, hours = '' }) {
  await holds.getByLabel('Coin').fill('USDT');
  await holds.getByLabel('Amount to hold').fill(amount);
  await holds.getByLabel(/^Reason/).fill(reason);
  await holds.getByLabel(/^Expires in hours/).fill(hours);
  await holds.getByRole('button', { name: 'Place the hold' }).click();
  const reply = holds.getByTestId('hold-place-reply');
  await expect(reply).toBeVisible({ timeout: 60_000 });
  return reply;
}

const row = (holds, holdNo) => holds.locator(`[data-testid=hold-row][data-hold-no="${holdNo}"]`);

/** A asks on one of the hold's two desks; returns the packet text. */
async function ask(desk, { why, phrase, submit }) {
  await desk.getByLabel(/^Why/).fill(why);
  await desk.getByLabel(/to confirm$/).fill(phrase);
  await desk.getByRole('button', { name: submit }).click();
  await expect(desk.getByTestId('packet-made')).toBeVisible({ timeout: 60_000 });
  return (await desk.getByLabel('Request packet').inputValue()).trim();
}

async function approveOn(page, userId, which, packetText, phrase, summary) {
  const desk = (await openHolds(page, userId)).getByTestId(which);
  await desk.getByLabel('Request packet').fill(packetText);
  await expect(desk.getByTestId('packet-summary')).toContainText(summary);
  await desk.getByLabel(/to approve or run it$/).fill(phrase);
  await desk.getByRole('button', { name: 'Approve this request' }).click();
  await expect(desk.getByTestId('step-reply')).toContainText('Approved.');
}

async function runIt(desk, phrase) {
  await desk.getByLabel(/to approve or run it$/).fill(phrase);
  await desk.getByRole('button', { name: 'Run the approved request' }).click();
}

test('J-ops-console-04 #2 holds part of a customer’s funds with a reason: available falls, the total does not, and more than is available is refused', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  run.reset({});
  const tag = randomUUID().slice(0, 8);
  const who = { handle: `ops42${tag}`, email: `ops42-${tag}@local-test.invalid`, password: `Ops42-${tag}-Test!pass` };
  const customer = await (await browser.newContext({ baseURL: ORIGIN })).newPage();
  await signUpInBrowser(customer, who);
  const signedIn = await login(who);
  expect(signedIn.status).toBe(200);
  const userId = (await signedIn.json()).result.data.userId;
  fund(who.email, 'USDT', '100', `ops42-${tag}`);
  expect(await usdt(who)).toEqual({ free: '100', total: '100' });

  const a = await (await browser.newContext()).newPage();
  await founderSignIn(a, 'a');
  const holds = await openHolds(a, userId);
  await expect(holds.getByTestId('holds-empty')).toBeVisible();
  await expect(holds.getByTestId('hold-settings')).toContainText('24 hours');

  // More than is available: the ledger refuses, nothing is held, and the refused hold is listed as holding nothing.
  const refused = await placeHold(holds, { amount: '100.01', reason: `LOCAL TEST too much ${tag}` });
  await expect(refused).toContainText('Not enough available');
  expect(await usdt(who)).toEqual({ free: '100', total: '100' });
  await expect(holds.getByTestId('hold-row').first().getByTestId('hold-state')).toContainText('Refused by the ledger');

  const reason = `LOCAL TEST suspected takeover ${tag}`;
  const placed = await placeHold(holds, { amount: '40.00', reason });
  await expect(placed).toContainText(/hold \d+ is active, 40 USDT still held/);
  const firstHold = /hold (\d+) is active/.exec(await placed.innerText())[1];
  const listed = row(holds, firstHold);
  await expect(listed.getByTestId('hold-state')).toHaveText('Held');
  await expect(listed).toContainText(reason);
  await expect(listed.getByTestId('hold-movement')).toContainText([`Hold 1: 40, one founder, posted · key ops:hold:${firstHold}`]);
  expect(await usdt(who), 'available falls by the hold, the total does not').toEqual({ free: '60', total: '100' });
  run.write({ who, userId, firstHold });
});

test('J-ops-console-04 #3 releases part of a hold with a second founder: alone it changes nothing, approved it runs once', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { who, userId, firstHold } = saved();
  const tag = randomUUID().slice(0, 8);
  const a = await (await browser.newContext()).newPage();
  await founderSignIn(a, 'a');
  const b = await (await browser.newContext()).newPage();
  const founderB = await founderSignIn(b, 'b');

  const holds = await openHolds(a, userId);
  await holds.getByLabel('Hold', { exact: true }).selectOption(firstHold);
  await holds.getByLabel('Amount to release').fill('15');
  const desk = holds.getByTestId('hold-release');
  const phrase = `RELEASE HOLD ${firstHold}`;
  const packet = await ask(desk, {
    why: `LOCAL TEST customer proved part of the funds ${tag}`,
    phrase,
    submit: 'Ask a second founder to approve the release',
  });

  // Alone: A cannot approve their own request, and a run before anyone approved changes nothing.
  await desk.getByLabel(/to approve or run it$/).fill(phrase);
  await expect(desk.getByRole('button', { name: 'Approve this request' })).toBeDisabled();
  await runIt(desk, phrase);
  await expect(desk.getByTestId('step-reply')).not.toContainText('still held');
  expect(await usdt(who), 'nothing released without the second founder').toEqual({ free: '60', total: '100' });

  await approveOn(b, userId, 'hold-release', packet, phrase, `Release 15 USDT of staff hold ${firstHold}`);
  await runIt(desk, phrase);
  await expect(desk.getByTestId('step-reply')).toContainText(`hold ${firstHold} is partially released, 25 USDT still held.`, {
    timeout: 60_000,
  });
  expect(await usdt(who)).toEqual({ free: '75', total: '100' });

  const listed = row(await openHolds(a, userId), firstHold);
  await expect(listed.getByTestId('hold-state')).toHaveText('Partly released');
  await expect(listed.getByTestId('hold-remaining')).toHaveText('25 USDT');
  await expect(listed.getByTestId('hold-movement').nth(1)).toContainText(
    `Release 1: 15, approved by ${founderB.userId.slice(0, 8)}, posted · key ops:hold-release:${firstHold}:1`,
  );
});

test('J-ops-console-04 #4 a hold with an expiry releases itself once it is due, with no approver', async ({ browser }) => {
  test.setTimeout(300_000);
  const { who, userId } = saved();
  const tag = randomUUID().slice(0, 8);
  const a = await (await browser.newContext()).newPage();
  await founderSignIn(a, 'a');
  const holds = await openHolds(a, userId);

  const placed = await placeHold(holds, { amount: '10', reason: `LOCAL TEST hold until checked ${tag}`, hours: '2' });
  await expect(placed).toContainText(/hold \d+ is active, 10 USDT still held/);
  const holdNo = /hold (\d+) is active/.exec(await placed.innerText())[1];
  await expect(row(holds, holdNo)).not.toContainText('No expiry');
  expect(await usdt(who)).toEqual({ free: '65', total: '100' });

  // Longer than the owner's longest expiry (24 TEST hours) is refused before anything is sent.
  await holds.getByLabel(/^Expires in hours/).fill('25');
  await expect(holds.getByTestId('hold-place-why')).toContainText('at most 24 hours');

  // The stored expiry is moved to just past; svc-ops' worker checks it against its own clock and releases the rest.
  tool('local-test-stack.mjs', 'expire-staff-holds', who.email);
  await expect.poll(async () => (await usdt(who)).free, { timeout: 60_000, message: 'the expiry worker released the 10' }).toBe('75');
  const listed = row(await openHolds(a, userId), holdNo);
  await expect(listed.getByTestId('hold-state')).toHaveText('Released when it expired');
  await expect(listed.getByTestId('hold-movement').nth(1)).toContainText(
    `Release 1: 10, the expiry, no approver, posted · key ops:hold-release:${holdNo}:1`,
  );
  expect(await usdt(who)).toEqual({ free: '75', total: '100' });
});

test('J-ops-console-04 #5 confirms a hold with a second founder: what is still held leaves for the owner-named account', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { who, userId, firstHold } = saved();
  const tag = randomUUID().slice(0, 8);
  const a = await (await browser.newContext()).newPage();
  await founderSignIn(a, 'a');
  const b = await (await browser.newContext()).newPage();
  await founderSignIn(b, 'b');

  const holds = await openHolds(a, userId);
  await expect(holds.getByTestId('hold-settings')).toContainText('The owner-named account.');
  await holds.getByLabel('Hold', { exact: true }).selectOption(firstHold);
  const desk = holds.getByTestId('hold-confirm');
  const phrase = `CONFIRM HOLD ${firstHold}`;
  const packet = await ask(desk, {
    why: `LOCAL TEST fraud confirmed ${tag}`,
    phrase,
    submit: 'Ask a second founder to approve the confirm',
  });
  await approveOn(b, userId, 'hold-confirm', packet, phrase, `Confirm staff hold ${firstHold}`);
  await runIt(desk, phrase);
  await expect(desk.getByTestId('step-reply')).toContainText(`hold ${firstHold} is confirmed, 0 USDT still held.`, { timeout: 60_000 });
  expect(await usdt(who), 'the 25 still held left the customer’s balance').toEqual({ free: '75', total: '75' });

  const listed = row(await openHolds(a, userId), firstHold);
  await expect(listed.getByTestId('hold-state')).toContainText('Confirmed');
  await expect(listed.getByTestId('hold-movement').nth(2)).toContainText(`Confirm 1: 25,`);
  await expect(listed.getByTestId('hold-movement').nth(2)).toContainText(`posted · key ops:hold-confirm:${firstHold}:1`);
  // Nothing is left to release or confirm.
  await expect(holds.getByLabel('Hold', { exact: true }).locator(`option[value="${firstHold}"]`)).toHaveCount(0);
});
