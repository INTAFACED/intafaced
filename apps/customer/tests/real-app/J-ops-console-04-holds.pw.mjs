import { expect, test } from './journey.mjs';
import { randomUUID } from 'node:crypto';
import { ADMIN, founderSignIn } from './admin.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, api, fund, journeyState, signUpInBrowser, tool } from './stack.mjs';

// J-ops-console-04 steps #2-#5: staff holds on one TEST customer's funds, on the founder console's account page.
//   #2 founder A holds 40 of the customer's 100 TEST USDT with a reason: available falls to 60, the total stays 100; a hold
//      above what is available is refused by the ledger and holds nothing.
//   #3 a hold with an expiry releases itself at the stored time: the stack's TEST fixture moves its stored expiry to just
//      past, and svc-ops' own expiry worker releases what is left, with no approver, under release number 1 only.
//   #4 founder A asks to release 15 of the first hold: A approving it is refused (action_approval.same_person) and a run
//      before anyone approved changes nothing; founder B approves; A runs it once and 25 stays held; running it again
//      returns the stored release.
//   #5 A asks to confirm the first hold and to release all 25 of it, B approves both, and A runs both at the same moment:
//      exactly one wins (svc-ops locks the hold's row). A confirm debits the 25 once, for the TEST owner-named account.
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

/** One step of a two-founder request, posted as the signed-in founder in `page` (the console's own CSRF header). */
const step = (page, body) =>
  page.evaluate(async (payload) => {
    const session = await (await fetch('/api/session', { cache: 'no-store' })).json();
    const res = await fetch('/api/accounts/holds', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-intafaced-csrf': session.csrf },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json() };
  }, body);

const decode = (text) => JSON.parse(Buffer.from(text.slice('ifa1.'.length), 'base64url').toString('utf8'));

/** One step of a two-founder posting freeze or unfreeze, as the signed-in founder in `page` (as J-ops-console-03 does it). */
const freezeStep = (page, body) =>
  page.evaluate(async (payload) => {
    const session = await (await fetch('/api/session', { cache: 'no-store' })).json();
    const res = await fetch('/api/ledger-freeze', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-intafaced-csrf': session.csrf },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json() };
  }, body);

/** A asks, B approves, A runs: svc-ledger's platform-wide posting freeze on (`frozen`) or off. */
async function setPostingFreeze(a, b, frozen, why) {
  const record = await a.evaluate(async () => (await fetch('/api/ledger-freeze', { cache: 'no-store' })).json());
  expect(record.ok, JSON.stringify(record)).toBe(true);
  if (record.state.frozen === frozen) return;
  const request = frozen
    ? { kind: 'ledger.freeze', reason: why, version: record.state.version }
    : { kind: 'ledger.unfreeze', version: record.state.version };
  const confirm = frozen ? 'FREEZE LEDGER' : 'UNFREEZE LEDGER';
  const proposed = await freezeStep(a, { step: 'propose', request, confirm });
  expect(proposed.body.ok, JSON.stringify(proposed.body)).toBe(true);
  const packet = decode(proposed.body.packet);
  const approved = await freezeStep(b, { step: 'approve', request, confirm, approvalId: packet.approvalId });
  expect(approved.body.ok, JSON.stringify(approved.body)).toBe(true);
  const ran = await freezeStep(a, { step: 'execute', request, confirm, approvalId: packet.approvalId, operationId: packet.operationId });
  expect(ran.body.ok, JSON.stringify(ran.body)).toBe(true);
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

/** Set while #3 holds the platform-wide posting freeze on, so the teardown below can lift it even after a timeout. */
let freezeOn = false;

// A posting freeze left on would refuse every later journey's posts on this stack, so it is lifted here on fresh pages
// when #3 ends with it on (a timeout closes that test's own pages before its own cleanup can run).
test.afterEach(async ({ browser }) => {
  if (!freezeOn) return;
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await founderSignIn(a, 'a');
  await founderSignIn(b, 'b');
  await a.goto(`${ADMIN}/`, { waitUntil: 'load' });
  await b.goto(`${ADMIN}/`, { waitUntil: 'load' });
  await setPostingFreeze(a, b, false);
  freezeOn = false;
});

test('J-ops-console-04 #3 a hold with an expiry releases itself at the stored time, with no approver, once', async ({ browser }) => {
  test.setTimeout(480_000);
  const { who, userId } = saved();
  const tag = randomUUID().slice(0, 8);
  const a = await (await browser.newContext()).newPage();
  await founderSignIn(a, 'a');
  const holds = await openHolds(a, userId);

  const placed = await placeHold(holds, { amount: '10', reason: `LOCAL TEST hold until checked ${tag}`, hours: '2' });
  await expect(placed).toContainText(/hold \d+ is active, 10 USDT still held/);
  const holdNo = /hold (\d+) is active/.exec(await placed.innerText())[1];
  await expect(row(holds, holdNo)).not.toContainText('No expiry');
  expect(await usdt(who)).toEqual({ free: '50', total: '100' });

  // Longer than the owner's longest expiry (24 TEST hours) is refused before anything is sent.
  await holds.getByLabel(/^Expires in hours/).fill('25');
  await expect(holds.getByTestId('hold-place-why')).toContainText('at most 24 hours');

  // The stored expiry is moved to just past while svc-ledger's posting freeze is on: svc-ops' worker checks it against its
  // own clock, stores release 1 and the ledger refuses it (ledger.frozen), so the release waits with its number. When the
  // freeze is lifted the worker sends it again under that same number and key, and it posts once.
  const releaseKey = `ops:hold-release:${holdNo}:1`;
  const b = await (await browser.newContext()).newPage();
  await founderSignIn(b, 'b');
  await a.goto(`${ADMIN}/`, { waitUntil: 'load' });
  await b.goto(`${ADMIN}/`, { waitUntil: 'load' });
  let failure = null;
  try {
    // Marked on before the call: a freeze that reached the ledger is lifted even if the call's own answer failed.
    freezeOn = true;
    await setPostingFreeze(a, b, true, `LOCAL TEST J-ops-console-04 #3 retried release ${tag}`);
    tool('local-test-stack.mjs', 'expire-staff-holds', who.email);
    await expect
      .poll(
        async () => {
          const movement = row(await openHolds(a, userId), holdNo)
            .getByTestId('hold-movement')
            .nth(1);
          return (await movement.count()) ? movement.innerText() : '';
        },
        { timeout: 90_000, message: 'the expiry worker stored release 1 and could not post it while posting was frozen' },
      )
      .toMatch(new RegExp(`^Release 1: 10, the expiry, no approver, waiting to be sent again \\(ledger\\.frozen\\) · key ${releaseKey}$`));
  } catch (error) {
    failure = error;
  }
  // Lift the freeze for the journeys after this one; a failure to lift it never hides the release's own failure.
  try {
    await setPostingFreeze(a, b, false);
    freezeOn = false;
  } catch (unfreeze) {
    failure ??= unfreeze;
  }
  if (failure) throw failure;
  await expect.poll(async () => (await usdt(who)).free, { timeout: 120_000, message: 'the retried release posted the 10' }).toBe('60');
  // The retry reused the stored release: still one release, number 1, its key, posted; worker ticks after it add nothing.
  await a.waitForTimeout(12_000);
  const listed = row(await openHolds(a, userId), holdNo);
  await expect(listed.getByTestId('hold-state')).toHaveText('Released when it expired');
  await expect(listed.getByTestId('hold-movement')).toHaveCount(2);
  await expect(listed.getByTestId('hold-movement').nth(1)).toContainText(
    `Release 1: 10, the expiry, no approver, posted · key ${releaseKey}`,
  );
  expect(await usdt(who)).toEqual({ free: '60', total: '100' });
});

test('J-ops-console-04 #4 releases part of a hold: the requester alone is refused, a different approver lets it run once', async ({
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

  // Alone: identity refuses A approving their own request, and a run before anyone approved changes nothing.
  await desk.getByLabel(/to approve or run it$/).fill(phrase);
  await expect(desk.getByRole('button', { name: 'Approve this request' })).toBeDisabled();
  const ticket = decode(packet);
  const selfApprove = await step(a, { step: 'approve', request: ticket.request, confirm: phrase, approvalId: ticket.approvalId });
  expect(selfApprove.body).toMatchObject({ ok: false, refusal: { code: 'action_approval.same_person' } });
  await runIt(desk, phrase);
  await expect(desk.getByTestId('step-reply')).not.toContainText('still held');
  expect(await usdt(who), 'nothing released without a different approver').toEqual({ free: '60', total: '100' });

  await approveOn(b, userId, 'hold-release', packet, phrase, `Release 15 USDT of staff hold ${firstHold}`);
  await runIt(desk, phrase);
  await expect(desk.getByTestId('step-reply')).toContainText(`hold ${firstHold} is partially released, 25 USDT still held.`, {
    timeout: 60_000,
  });
  expect(await usdt(who)).toEqual({ free: '75', total: '100' });
  // Running it again returns the stored release; nothing more moves.
  await runIt(desk, phrase);
  await expect(desk.getByTestId('step-reply')).toContainText(`Already done: hold ${firstHold} is partially released, 25 USDT still held.`);
  expect(await usdt(who)).toEqual({ free: '75', total: '100' });

  const listed = row(await openHolds(a, userId), firstHold);
  await expect(listed.getByTestId('hold-state')).toHaveText('Partly released');
  await expect(listed.getByTestId('hold-remaining')).toHaveText('25 USDT');
  await expect(listed.getByTestId('hold-movement')).toHaveCount(2);
  await expect(listed.getByTestId('hold-movement').nth(1)).toContainText(
    `Release 1: 15, approved by ${founderB.userId.slice(0, 8)}, posted · key ops:hold-release:${firstHold}:1`,
  );
});

test('J-ops-console-04 #5 confirms the rest while a release of it runs at the same moment: exactly one wins, a confirm debits once', async ({
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
  const confirmPhrase = `CONFIRM HOLD ${firstHold}`;
  const confirmPacket = await ask(holds.getByTestId('hold-confirm'), {
    why: `LOCAL TEST fraud confirmed ${tag}`,
    phrase: confirmPhrase,
    submit: 'Ask a second founder to approve the confirm',
  });
  await holds.getByLabel('Amount to release').fill('25');
  const releasePhrase = `RELEASE HOLD ${firstHold}`;
  const releasePacket = await ask(holds.getByTestId('hold-release'), {
    why: `LOCAL TEST customer proved the rest ${tag}`,
    phrase: releasePhrase,
    submit: 'Ask a second founder to approve the release',
  });
  await approveOn(b, userId, 'hold-confirm', confirmPacket, confirmPhrase, `Confirm staff hold ${firstHold}`);
  await approveOn(b, userId, 'hold-release', releasePacket, releasePhrase, `Release 25 USDT of staff hold ${firstHold}`);

  // Both approved; A runs both at the same moment. svc-ops takes the hold's row lock for each, so one finds nothing left.
  const run1 = (text, phrase) => {
    const ticket = decode(text);
    return step(a, {
      step: 'execute',
      request: ticket.request,
      confirm: phrase,
      approvalId: ticket.approvalId,
      operationId: ticket.operationId,
    });
  };
  const [confirmed, released] = await Promise.all([run1(confirmPacket, confirmPhrase), run1(releasePacket, releasePhrase)]);
  const winners = [confirmed, released].filter((r) => r.body.ok === true);
  expect(winners, `exactly one of the two runs wins: ${JSON.stringify([confirmed.body, released.body])}`).toHaveLength(1);
  const loser = confirmed.body.ok ? released : confirmed;
  expect(loser.body).toMatchObject({ ok: false, refusal: { code: expect.stringMatching(/^ops\.hold_/) } });

  console.log(`J-ops-console-04 #5: the ${confirmed.body.ok ? 'confirm' : 'release'} won the race`);
  let confirmedHold = firstHold;
  if (confirmed.body.ok) {
    expect(await usdt(who), 'the confirm won: the 25 left the customer once').toEqual({ free: '75', total: '75' });
  } else {
    // The release won: the 25 is the customer's again and the confirm moved nothing. A confirm is then shown on a fresh hold.
    expect(await usdt(who), 'the release won: nothing was confirmed').toEqual({ free: '100', total: '100' });
    const again = await openHolds(a, userId);
    const placed = await placeHold(again, { amount: '25', reason: `LOCAL TEST fraud confirmed ${tag}` });
    confirmedHold = /hold (\d+) is active/.exec(await placed.innerText())[1];
    await again.getByLabel('Hold', { exact: true }).selectOption(confirmedHold);
    const phrase = `CONFIRM HOLD ${confirmedHold}`;
    const packet = await ask(again.getByTestId('hold-confirm'), {
      why: `LOCAL TEST fraud confirmed ${tag}`,
      phrase,
      submit: 'Ask a second founder to approve the confirm',
    });
    await approveOn(b, userId, 'hold-confirm', packet, phrase, `Confirm staff hold ${confirmedHold}`);
    const done = await run1(packet, phrase);
    expect(done.body).toMatchObject({ ok: true });
    expect(await usdt(who), 'the 25 left the customer once').toEqual({ free: '75', total: '75' });
  }

  const listed = row(await openHolds(a, userId), confirmedHold);
  await expect(listed.getByTestId('hold-state')).toContainText('Confirmed');
  await expect(listed.getByTestId('hold-movement').filter({ hasText: 'Confirm 1: 25,' })).toContainText(
    `posted · key ops:hold-confirm:${confirmedHold}:1`,
  );
  await expect(listed.getByTestId('hold-movement').filter({ hasText: /^Confirm/ })).toHaveCount(1);
  // Nothing is left to release or confirm on it.
  await expect(holds.getByLabel('Hold', { exact: true }).locator(`option[value="${confirmedHold}"]`)).toHaveCount(0);
  expect(await usdt(who)).toEqual({ free: '75', total: '75' });
});
