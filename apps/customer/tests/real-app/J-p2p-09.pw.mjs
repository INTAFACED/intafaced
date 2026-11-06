// World: freeze, gates, restart
import { randomUUID } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { api, fund, fromUnits, journeyState, restartWith, tool, toUnits } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { p2p, readyTaker, refusalCode, testPasskey, verifiedName, METHOD, TEST_IBAN } from './p2p.mjs';

// J-p2p-09, in the running app (docs/roadmap/journeys.json): a moderator runs the dispute queue to a ruling. One test per
// step, titled "J-p2p-09 #<n>", run in order. The moderators are the stack's LOCAL TEST founder pair, signed in to the
// founder console (apps/admin) with their own second factor: natural people who hold the moderator permission. Founder a
// moderates; founder b is the second approver where svc-p2p asks for one. #1 makes the open disputes the journey works
// on through svc-p2p's own doors: a TEST seller sells TEST USDT to a TEST buyer from a TEST ad, the buyer marks four
// orders paid, and each becomes a dispute. Fiat never moves; the coins sit in the ledger's escrow until a ruling posts.
//
// The stack's dispute-desk clocks are labelled TEST values (tooling/scripts/local-stack-services/p2p.mjs): a claim lease
// of 20 s, an information request answered within 20 s, a hold clock of 20 s, and a response target for one case type
// only (a buyer's "paid, not released" case), so the seller's case shows that no target is set.
const J = 'J-p2p-09';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const AMOUNT = '5';
const LEASE_SECONDS = 20;
const INFO_SECONDS = 20;
const HOLD_SECONDS = 20;

test.describe.configure({ mode: 'default' });

test.beforeAll(() => {
  tool('local-test-gates.mjs', 'p2p');
});

function journey() {
  const state = run.read();
  if (!state.disputes) throw new Error(`${J} #1 made no disputes, so this step has nothing to work on`);
  return state;
}

/** The founder pair's own signed-in sessions (second factor), for the moments the journey acts as both at once. */
let foundersPromise;
async function founders() {
  foundersPromise ??= (async () => {
    const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
    const ctx = await gates.makeContext({ log: () => {} });
    const pair = await gates.approverSessions(ctx);
    const as = (key) => ({
      mutate: (proc, input) => ctx.edge.mutate('p2p', proc, input, pair[key].token),
      query: (proc, input) => ctx.edge.query('p2p', proc, input, pair[key].token),
    });
    return { a: as('a'), b: as('b') };
  })();
  return foundersPromise;
}
const data = (res) => res.json?.result?.data;
const code = (res) => res.json?.error?.data?.cause?.code ?? res.json?.error?.data?.intafacedCode ?? null;

/** The person's TEST USDT balance in base units. */
async function usdt(who) {
  return toUnits((await (await api(who)).balances()).USDT?.total ?? '0');
}

async function queue(page) {
  await page.goto(`${ADMIN}/p2p-ops/disputes`, { waitUntil: 'load' });
  const region = page.getByRole('region', { name: 'Dispute queue' });
  await expect(region).toBeVisible();
  return region;
}
const queueRow = (region, tradeId) => region.locator(`tr[data-trade-id="${tradeId}"]`);

async function openCase(page, tradeId) {
  await page.goto(`${ADMIN}/p2p-ops/disputes/${tradeId}`, { waitUntil: 'load' });
  await expect(page.getByRole('heading', { name: /^Dispute on order/ })).toBeVisible();
}

test('J-p2p-09 #1 the ruling desk shows the queue with SLA colour, assignment and lease; one of two claims wins; a lapsed lease unassigns; no target, no colour', async ({
  page,
}) => {
  test.setTimeout(420_000);
  // The traders: a verified seller with TEST USDT, a saved TEST bank transfer and a sell ad; a verified buyer.
  const seller = await signUp(page, 'p2p09s');
  await verify(page, seller);
  expect(fund(seller.email, 'USDT', '100').tx).toBeTruthy();
  const buyer = await signUp(page, 'p2p09b');
  await verify(page, buyer);
  const sellerSession = await api(seller);
  const s = p2p(sellerSession, await testPasskey(sellerSession));
  const b = await readyTaker(await api(buyer), buyer);
  await s.mutate('instruments.create', {
    instrumentId: randomUUID(),
    methodId: METHOD,
    country: 'DE',
    fiatCurrency: 'EUR',
    label: 'TEST account',
    details: { account_holder: await verifiedName(sellerSession, seller), iban: TEST_IBAN },
  });
  const offer = await s.mutate('offers.create', {
    side: 'sell',
    asset: 'USDT',
    fiatCurrency: 'EUR',
    priceType: 'fixed',
    price: '0.92',
    minAmount: '1',
    maxAmount: AMOUNT,
    totalAmount: '40',
    methods: [METHOD],
    idempotencyKey: `${J}:offer:${seller.handle}`,
  });
  // Four paid orders, each disputed: three by the buyer ("paid, not released"), one by the seller ("not received").
  const disputes = {};
  for (const [name, by] of [
    ['ruling', 'buyer'],
    ['escalate', 'buyer'],
    ['hold', 'seller'],
    ['single', 'buyer'],
  ]) {
    const trade = await b.mutate('trades.take', { offerId: offer.id, tradeId: randomUUID(), amount: AMOUNT, method: METHOD });
    expect(trade.status).toBe('escrowed');
    await b.mutate('trades.markFiatSent', { tradeId: trade.id });
    const opener = by === 'buyer' ? b : s;
    const opened = await opener.mutate('disputes.open', {
      tradeId: trade.id,
      reason: by === 'buyer' ? 'TEST I paid and the seller has not released' : 'TEST the payment never arrived',
    });
    disputes[name] = { tradeId: trade.id, disputeId: opened.disputeId };
  }
  run.reset({ seller, buyer, disputes });

  // Founder a opens the ruling desk.
  await founderSignIn(page, 'a');
  const region = await queue(page);
  await expect(page.getByTestId('ruling-mode')).toContainText('Two-person rulings');
  // The buyer's case has a TEST response target and was just opened: on time, in green.
  const ruling = queueRow(region, disputes.ruling.tradeId);
  await expect(ruling).toBeVisible();
  await expect(ruling.getByTestId('sla')).toHaveAttribute('data-sla', 'green');
  await expect(ruling.getByTestId('sla')).toContainText('On time');
  await expect(ruling.getByTestId('assignee')).toHaveText('Unassigned');
  // The seller's case type has no target set: no colour, and the desk says so.
  const hold = queueRow(region, disputes.hold.tradeId);
  await expect(hold.getByTestId('sla')).toHaveAttribute('data-sla', 'none');
  await expect(hold.getByTestId('sla')).toHaveText('No target set');

  // Two moderators claim the same case at the same moment: exactly one wins, the other is told it is claimed.
  const f = await founders();
  const both = await Promise.all([
    f.a.mutate('disputes.claim', { disputeId: disputes.escalate.disputeId }),
    f.b.mutate('disputes.claim', { disputeId: disputes.escalate.disputeId }),
  ]);
  const won = both.filter((res) => res.status === 200);
  const lost = both.filter((res) => res.status !== 200);
  expect(won, JSON.stringify(both.map((res) => res.json))).toHaveLength(1);
  expect(lost).toHaveLength(1);
  expect(code(lost[0])).toBe('p2p.case_claimed');

  // Founder a claims the buyer's case on the desk: it is theirs, with the lease's end shown.
  await ruling.getByRole('button', { name: 'Claim' }).click();
  await expect(ruling.getByTestId('assignee')).toHaveText(/^You, until \d\d:\d\d:\d\d/);
  const queued = data(await f.a.query('disputes.queue', { limit: 200 })).rows.find((r) => r.tradeId === disputes.ruling.tradeId);
  expect(queued.leaseUntil).toBeTruthy();
  // Founder b cannot take it while the lease runs.
  expect(code(await f.b.mutate('disputes.claim', { disputeId: disputes.ruling.disputeId }))).toBe('p2p.case_claimed');

  // The lease runs out with nobody renewing it: the case is unassigned again, and another moderator may take it.
  await page.waitForTimeout((LEASE_SECONDS + 2) * 1000);
  await page.reload();
  await expect(queueRow(await queue(page), disputes.ruling.tradeId).getByTestId('assignee')).toHaveText('Unassigned');
});

test('J-p2p-09 #2 asking a party for information notifies them and the case waits; an expired request tells the moderator', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { buyer, seller, disputes } = journey();
  const b = p2p(await api(buyer));
  const unreadBefore = (await b.query('chat.unread')).total ?? 0;

  await founderSignIn(page, 'a');
  await openCase(page, disputes.ruling.tradeId);
  const ask = page.getByRole('region', { name: 'Ask a party for information' });
  await ask.getByLabel('Party').selectOption('buyer');
  await ask.getByLabel('Question').fill('TEST Please send the bank confirmation of your transfer.');
  await ask.getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByTestId('case-status')).toHaveText('Waiting on the buyer');
  const requests = page.getByTestId('info-requests');
  await expect(requests).toContainText('To the buyer');
  await expect(requests).toContainText('Open');

  // The buyer is told: the question arrives in the order chat as an official staff message, unread.
  await expect.poll(async () => (await b.query('chat.unread')).total ?? 0, { timeout: 20_000 }).toBeGreaterThan(unreadBefore);
  const mine = await b.query('disputes.infoRequests', { tradeId: disputes.ruling.tradeId });
  const open = mine.requests.find((r) => r.status === 'open');
  expect(open.question).toBe('TEST Please send the bank confirmation of your transfer.');
  expect(open.addressee).toBe('buyer');
  // The seller is not the addressee and cannot answer for the buyer.
  const s = p2p(await api(seller));
  expect(refusalCode(await s.raw.mutate('disputes.respondInfo', { requestId: open.id, answer: 'TEST not mine' }))).toBe(
    'p2p.not_the_addressee',
  );
  // The buyer answers; the case is no longer waiting.
  await b.mutate('disputes.respondInfo', { requestId: open.id, answer: 'TEST Confirmation reference TEST-123 attached in chat.' });
  await page.reload();
  await expect(page.getByTestId('case-status')).toHaveText('Open');
  await expect(page.getByTestId('info-requests')).toContainText('Answered');
  await expect(page.getByTestId('info-requests')).toContainText('TEST Confirmation reference TEST-123');

  // A second request, to the seller, is left unanswered past its window: it expires and the moderator is told.
  await ask.getByLabel('Party').selectOption('seller');
  await ask.getByLabel('Question').fill('TEST Please confirm whether the transfer reached your account.');
  await ask.getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByTestId('case-status')).toHaveText('Waiting on the seller');
  await page.waitForTimeout((INFO_SECONDS + 2) * 1000);
  await page.reload();
  await expect(page.getByTestId('case-status')).toHaveText('Open');
  await expect(page.getByTestId('info-requests')).toContainText('Expired');
  await expect(page.getByRole('alert').filter({ hasText: 'The seller did not answer in time' })).toBeVisible();
  const region = await queue(page);
  await expect(queueRow(region, disputes.ruling.tradeId).getByTestId('alerts')).toContainText('Request expired');
});

test('J-p2p-09 #3 a ruling with a basis: proposer cannot approve, it posts once, a second resolve returns the first; switched off, one moderator rules and the record says so', async ({
  browser,
  page,
}) => {
  test.setTimeout(420_000);
  const { buyer, seller, disputes } = journey();
  const f = await founders();
  const feeBps = BigInt((await p2p(await api(buyer)).query('fees.schedule')).feeBps);
  const amount = toUnits(AMOUNT);
  const fee = (amount * feeBps) / 10_000n;
  const buyerBefore = await usdt(buyer);
  const sellerBefore = await usdt(seller);

  await founderSignIn(page, 'a');
  await openCase(page, disputes.ruling.tradeId);
  const form = page.getByRole('region', { name: 'Ruling' });
  await form.getByLabel('Winner').selectOption('buyer');
  await form.getByLabel('Basis').selectOption('buyer_paid_seller_silent');
  await form.getByLabel('Notes for both parties').fill('TEST The buyer showed the transfer; the seller did not answer.');
  await form.getByRole('button', { name: 'Propose ruling' }).click();
  const proposals = page.getByTestId('ruling-proposals');
  await expect(proposals).toContainText('Waiting for a second moderator');
  // The proposer approving their own ruling is refused, on the desk and at the door.
  await proposals.getByRole('button', { name: 'Approve ruling' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'p2p.same_person_approval' })).toBeVisible();
  const proposalId = await proposals.locator('[data-proposal-id]').first().getAttribute('data-proposal-id');
  expect(code(await f.a.mutate('disputes.approveRuling', { proposalId }))).toBe('p2p.same_person_approval');
  // Nothing has moved yet.
  expect(await usdt(buyer)).toBe(buyerBefore);

  // Founder b approves it in their own console session: the ruling posts once.
  const context = await browser.newContext();
  const second = await context.newPage();
  await founderSignIn(second, 'b');
  await openCase(second, disputes.ruling.tradeId);
  await second.getByTestId('ruling-proposals').getByRole('button', { name: 'Approve ruling' }).click();
  const record = second.getByTestId('ruling-record');
  await expect(record).toContainText('Released to the buyer');
  await expect(record).toContainText('Two moderators');
  await expect(record).toContainText('Buyer paid, seller did not release');
  await context.close();

  const b = p2p(await api(buyer));
  await expect
    .poll(async () => (await b.query('trades.get', { tradeId: disputes.ruling.tradeId })).escrowHeld, { timeout: 60_000 })
    .toBe('0');
  // Buyer gains the amount minus the published fee; the seller's coins were already in escrow, so they gain nothing.
  expect(await usdt(buyer)).toBe(buyerBefore + amount - fee);
  expect(await usdt(seller)).toBe(sellerBefore);
  // A second resolve returns the first ruling and posts nothing.
  const again = await f.b.mutate('disputes.approveRuling', { proposalId });
  expect(again.status, again.text).toBe(200);
  expect(data(again).status).toBe('released');
  expect(await usdt(buyer)).toBe(buyerBefore + amount - fee);

  // The approval switch off (an explicit `off`): one moderator rules alone, and the record says so.
  restartWith('p2p', 'LOCAL_STACK_P2P_DISPUTE_FOUR_EYES', false);
  try {
    const sellerMid = await usdt(seller);
    await page.reload();
    await openCase(page, disputes.single.tradeId);
    await expect(page.getByTestId('ruling-mode')).toContainText('Single moderator');
    const single = page.getByRole('region', { name: 'Ruling' });
    await single.getByLabel('Winner').selectOption('seller');
    await single.getByLabel('Basis').selectOption('seller_not_received');
    await single.getByLabel('Notes for both parties').fill('TEST No transfer was shown.');
    await single.getByRole('button', { name: 'Rule' }).click();
    const alone = page.getByTestId('ruling-record');
    await expect(alone).toContainText('Refunded to the seller');
    await expect(alone).toContainText('One moderator (two-person approval switched off)');
    await expect
      .poll(async () => (await b.query('trades.get', { tradeId: disputes.single.tradeId })).escrowHeld, { timeout: 60_000 })
      .toBe('0');
    expect(await usdt(seller)).toBe(sellerMid + amount);
  } finally {
    restartWith('p2p', 'LOCAL_STACK_P2P_DISPUTE_FOUR_EYES', true);
  }
});

test('J-p2p-09 #4 hold, release of hold and transfer: two approvals, identity called once, unreachable stays requested, no recipe refuses, a passed hold clock alerts and holds', async ({
  browser,
  page,
}) => {
  test.setTimeout(420_000);
  const { buyer, disputes } = journey();
  const f = await founders();
  const escrowBefore = (await p2p(await api(buyer)).query('trades.get', { tradeId: disputes.hold.tradeId })).escrowHeld;

  await founderSignIn(page, 'a');
  await openCase(page, disputes.hold.tradeId);
  const actions = page.getByRole('region', { name: 'Support actions' });
  // A transfer needs a ledger recipe that does not exist: refused, and nothing posts.
  await actions.getByLabel('Action').selectOption('transfer');
  await actions.getByLabel('Party').selectOption('buyer');
  await actions.getByLabel('Reason').fill('TEST move the coins');
  await actions.getByRole('button', { name: 'Request action' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'p2p.recipe_unavailable' })).toBeVisible();
  expect((await p2p(await api(buyer)).query('trades.get', { tradeId: disputes.hold.tradeId })).escrowHeld).toBe(escrowBefore);

  // Identity unreachable: the approved hold stays `requested`, and the desk says so.
  restartWith('p2p', 'LOCAL_STACK_P2P_IDENTITY', false);
  let held;
  try {
    await actions.getByLabel('Action').selectOption('hold');
    await actions.getByLabel('Party').selectOption('buyer');
    await actions.getByLabel('Reason').fill('TEST hold the buyer while the payment is checked');
    await actions.getByRole('button', { name: 'Request action' }).click();
    const list = page.getByTestId('support-actions');
    await expect(list).toContainText('Waiting for a second moderator');
    held = await list.locator('[data-action-id]').first().getAttribute('data-action-id');
    // The requester cannot approve their own action.
    expect(code(await f.a.mutate('disputes.approveSupportAction', { actionId: held }))).toBe('p2p.same_person_approval');
    const approved = await f.b.mutate('disputes.approveSupportAction', { actionId: held });
    expect(approved.status, approved.text).toBe(200);
    expect(data(approved).status).toBe('requested');
    await page.reload();
    await expect(page.getByTestId('support-actions')).toContainText('Requested: identity did not answer');
  } finally {
    restartWith('p2p', 'LOCAL_STACK_P2P_IDENTITY', true);
  }
  // Identity back: the reconciler completes the hold, calling identity once.
  await expect
    .poll(
      async () => data(await f.a.query('disputes.case', { tradeId: disputes.hold.tradeId })).actions.find((a) => a.id === held)?.status,
      {
        timeout: 90_000,
        intervals: [5_000],
      },
    )
    .toBe('held');
  const holdRow = data(await f.a.query('disputes.case', { tradeId: disputes.hold.tradeId })).actions.find((a) => a.id === held);
  expect(holdRow.identityCalls).toBe(1);
  // A replayed approval is a no-op: identity is not called again.
  await f.b.mutate('disputes.approveSupportAction', { actionId: held });
  expect(data(await f.a.query('disputes.case', { tradeId: disputes.hold.tradeId })).actions.find((a) => a.id === held).identityCalls).toBe(
    1,
  );
  // The hold is real: the buyer's account is frozen, so they cannot sign in.
  await expect(api(buyer)).rejects.toThrow(/refused/);

  // The hold clock passes with no ruling: an alert is raised, and the hold is not released.
  await page.waitForTimeout((HOLD_SECONDS + 35) * 1000);
  await page.reload();
  await expect(page.getByRole('alert').filter({ hasText: 'Hold clock passed' })).toBeVisible();
  await expect(page.getByTestId('support-actions')).toContainText('Held');
  await expect(api(buyer)).rejects.toThrow(/refused/);

  // Release of the hold: requested by a, approved by b in their console; identity lifts it, and the buyer is back.
  await actions.getByLabel('Action').selectOption('release_hold');
  await actions.getByLabel('Party').selectOption('buyer');
  await actions.getByLabel('Reason').fill('TEST payment checked, release the hold');
  await actions.getByRole('button', { name: 'Request action' }).click();
  const context = await browser.newContext();
  const second = await context.newPage();
  await founderSignIn(second, 'b');
  await openCase(second, disputes.hold.tradeId);
  await second.getByTestId('support-actions').getByRole('button', { name: 'Approve action' }).first().click();
  await expect(second.getByTestId('support-actions')).toContainText('Released');
  await context.close();
  expect((await api(buyer)).userId).toBeTruthy();
  // Through all of it the escrow stayed exactly where it was.
  expect((await p2p(await api(buyer)).query('trades.get', { tradeId: disputes.hold.tradeId })).escrowHeld).toBe(escrowBefore);
});

test('J-p2p-09 #5 escalating to compliance with a reason: escalated, deadline re-armed, escrow held, compliance queue lists it, a repeat is one escalation', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { buyer, disputes } = journey();
  const f = await founders();
  const b = p2p(await api(buyer));
  const before = (await b.query('trades.get', { tradeId: disputes.escalate.tradeId })).escrowHeld;
  const caseBefore = data(await f.a.query('disputes.case', { tradeId: disputes.escalate.tradeId }));

  await founderSignIn(page, 'a');
  await openCase(page, disputes.escalate.tradeId);
  const form = page.getByRole('region', { name: 'Escalate' });
  await form.getByLabel('To').selectOption('compliance');
  await form.getByLabel('Reason').fill('TEST the payer name does not match the account; compliance to review');
  await form.getByRole('button', { name: 'Escalate' }).click();
  await expect(page.getByTestId('case-status')).toHaveText('Escalated to compliance');
  const after = data(await f.a.query('disputes.case', { tradeId: disputes.escalate.tradeId }));
  expect(after.escalatedTo).toBe('compliance');
  expect(after.escalations).toBe(caseBefore.escalations + 1);
  expect(Date.parse(after.deadlineAt)).toBeGreaterThan(Date.parse(caseBefore.deadlineAt));
  expect((await b.query('trades.get', { tradeId: disputes.escalate.tradeId })).escrowHeld).toBe(before);

  // The compliance queue lists it.
  await page.goto(`${ADMIN}/p2p-ops/disputes`, { waitUntil: 'load' });
  await expect(
    page.getByRole('region', { name: 'Compliance queue' }).locator(`tr[data-trade-id="${disputes.escalate.tradeId}"]`),
  ).toBeVisible();

  // The same request again, with the same key, gives one escalation.
  const key = `${J}:escalate:${disputes.escalate.disputeId}`;
  const input = { disputeId: disputes.escalate.disputeId, target: 'compliance', reason: 'TEST repeat', clientRequestId: key };
  const first = await f.a.mutate('disputes.escalate', input);
  expect(first.status, first.text).toBe(200);
  const repeat = await f.a.mutate('disputes.escalate', input);
  expect(data(repeat).replay).toBe(true);
  expect(data(repeat).escalations).toBe(data(first).escalations);
  expect(data(await f.a.query('disputes.case', { tradeId: disputes.escalate.tradeId })).escalations).toBe(data(first).escalations);
});

test('J-p2p-09 #6 the scenario guide per dispute type, and a reopen after posting opens a recovery case', async ({ page }) => {
  test.setTimeout(180_000);
  const { buyer, seller, disputes } = journey();
  const f = await founders();
  await founderSignIn(page, 'a');

  // A guide for the buyer's "paid, not released" case, and another for the seller's "not received" case.
  await openCase(page, disputes.escalate.tradeId);
  const guide = page.getByRole('region', { name: 'Scenario guide' });
  await expect(guide.getByRole('heading', { name: 'Buyer paid, seller did not release' })).toBeVisible();
  await expect(guide.getByRole('listitem').first()).toBeVisible();
  await openCase(page, disputes.hold.tradeId);
  await expect(
    page.getByRole('region', { name: 'Scenario guide' }).getByRole('heading', { name: 'Seller says the payment did not arrive' }),
  ).toBeVisible();

  // The ruled case: a reopen after its ruling posted opens a recovery case and posts nothing.
  const buyerBefore = await usdt(buyer);
  const sellerBefore = await usdt(seller);
  await openCase(page, disputes.ruling.tradeId);
  const reopen = page.getByRole('region', { name: 'Reopen' });
  await reopen.getByLabel('Reason for reopening').fill('TEST the seller sent proof the payment was reversed after release');
  await reopen.getByRole('button', { name: 'Reopen' }).click();
  await expect(page.getByTestId('recovery-cases')).toContainText('Recovery case opened');
  const c = data(await f.a.query('disputes.case', { tradeId: disputes.ruling.tradeId }));
  expect(c.recoveryCases).toHaveLength(1);
  expect(c.status).toBe('resolved');
  expect(c.resolution).toBe('release');
  expect(await usdt(buyer)).toBe(buyerBefore);
  expect(await usdt(seller)).toBe(sellerBefore);
  expect(fromUnits(buyerBefore)).toBeTruthy();
});
