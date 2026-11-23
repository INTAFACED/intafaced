// World: none
import { expect, test } from './journey.mjs';
import { randomUUID } from 'node:crypto';
import { founderSignIn } from './admin.mjs';
import { fund, toUnits } from './stack.mjs';
import {
  approveReversal,
  askReversal,
  legsOf,
  openBusinessKey,
  openTx,
  proposeReversal,
  requestRow,
  reversalStep,
  reversePhrase,
  runReversal,
} from './ledger-reversal-desk.mjs';

// J-ops-console-05: correct the books on the founder console's /ledger page. Steps 1-3 (OPS-ledger-desk-02): reverse a
// posted transaction of INTAFACED's own with a reason and a case reference; it waits for a different founder's approval,
// then the ledger books one linked compensating transaction from the stored original; a second reversal of the same
// transaction is refused with the first one shown.
//
// The original: INTAFACED's own TEST money, booked through a real ledger recipe by the stack's funding tool
// (`fund('house', ...)`: `marketMakerSeedFund`, our house market-maker inventory against the TEST rail boundary). No
// customer account is on it. A TEST builder fee due (`builderFeeEarn`) is booked on this stack only by svc-trade from a
// routed fill on the TEST venue's door (J-bank-13's earnBuilderFees: a trade restart, a wallet's builder-fee approval and
// seven sells), so this journey takes the house seed, the other own-money posting the stack books on request. Its asset
// (SGD) is one no other journey reads, so taking it back out of the house account never moves another journey's figures.
// Steps 4-10 (adjust, attribute) are later slices and are not in this file yet.

const tag = randomUUID().slice(0, 8);
const ASSET = 'SGD';
const AMOUNT = '1.25';
const state = {
  a: null,
  b: null,
  founderB: null,
  originalTxId: null,
  requestNo: null,
  ledgerKey: null,
  packetText: null,
  reversingTxId: null,
};
const ask = {
  reason: `LOCAL TEST J-ops-console-05 reverse a TEST house seed ${tag}`,
  caseRef: `LOCAL-TEST-OPS05-${tag}`,
};

/** Founder a (holds the console's treasury credential: asks and runs) and founder b (approves), each signed in once. */
async function founders(browser) {
  if (!state.a) {
    state.a = await (await browser.newContext()).newPage();
    await founderSignIn(state.a, 'a');
  }
  if (!state.b) {
    state.b = await (await browser.newContext()).newPage();
    state.founderB = await founderSignIn(state.b, 'b');
  }
  return { a: state.a, b: state.b };
}

/** Sums legs per key, a debit counted up and a credit down. */
function netBy(legs, keyOf) {
  const net = new Map();
  for (const leg of legs) {
    const signed = leg.direction === 'debit' ? toUnits(leg.amount) : -toUnits(leg.amount);
    net.set(keyOf(leg), (net.get(keyOf(leg)) ?? 0n) + signed);
  }
  return Object.fromEntries([...net].map(([k, v]) => [k, v.toString()]));
}

test.describe.serial('J-ops-console-05 correct the books', () => {
  test('J-ops-console-05 #1 reverse with a reason and a case reference waits for a different approver; nothing posts and the intent row stays at intent', async ({
    browser,
    stepPicture,
  }) => {
    test.setTimeout(300_000);
    const { a, b } = await founders(browser);

    // The posted TEST transaction of INTAFACED's own, booked through the ledger's own recipe.
    const booked = fund('house', ASSET, AMOUNT, `ops05-${tag}`);
    expect(booked.tx, `the house seed names its ledger transaction: ${booked.out}`).toMatch(/^[0-9a-f-]{36}$/);
    state.originalTxId = booked.tx.toLowerCase();
    const original = await openTx(a, state.originalTxId);
    await expect(original.getByTestId('tx-reversed-by')).toHaveCount(0);
    await expect(original.getByTestId('tx-reversal-links')).toHaveText('Not reversed');

    // A reason under 12 characters or no case reference holds the Reverse button.
    const form = original.getByTestId('tx-reverse');
    await form.getByLabel(/^Reason \(12 to 500/).fill('too short');
    await form.getByLabel('Case reference', { exact: true }).fill(ask.caseRef);
    await expect(form.getByTestId('tx-reverse-submit')).toBeDisabled();
    await form.getByLabel(/^Reason \(12 to 500/).fill(ask.reason);
    await form.getByLabel('Case reference', { exact: true }).fill('');
    await expect(form.getByTestId('tx-reverse-submit')).toBeDisabled();

    // Reverse, with a reason and a case reference: svc-ops stores the request at "intent".
    const { desk, requestNo } = await askReversal(a, state.originalTxId, ask);
    state.requestNo = requestNo;
    await expect(desk.getByTestId('reversal-asked')).toContainText(`Reversal request ${requestNo} is stored at intent`);
    const row = requestRow(desk, requestNo);
    await expect(row).toHaveAttribute('data-state', 'intent', { timeout: 30_000 });
    await expect(row.getByTestId('reversal-state')).toHaveText('intent');
    await expect(row).toContainText(`“${ask.reason}”, case ${ask.caseRef}`);
    await expect(row).toContainText('Not approved yet');
    state.ledgerKey = /ledger key (ops:reversal:[0-9a-f-]{36}:\d+)/.exec(await row.innerText())?.[1] ?? null;
    expect(state.ledgerKey, 'a first reversal of this original goes under its ordinal 1').toBe(`ops:reversal:${state.originalTxId}:1`);

    // The requester asks a different founder to approve: the packet is made, and the requester cannot approve it.
    state.packetText = await proposeReversal(desk, requestNo);
    await expect(row.getByRole('button', { name: 'Approve this request', exact: true })).toBeDisabled();
    const alone = await reversalStep(a, state.packetText, 'approve', reversePhrase(requestNo));
    expect(alone.body?.ok, JSON.stringify(alone)).toBe(false);
    expect(alone.body?.refusal?.code, JSON.stringify(alone)).toBe('action_approval.same_person');

    // The other founder's console holds Reverse for them (the treasury credential is not theirs): they can only approve.
    const other = (await openTx(b, state.originalTxId)).getByTestId('tx-reversal');
    await expect(other.getByTestId('reversal-writes-parked')).toBeVisible();
    await expect(other.getByTestId('tx-reverse-submit')).toBeDisabled();

    // Nothing posted: the ledger holds nothing under the reversal's key, and the original is not reversed.
    const lookup = await openBusinessKey(b, state.ledgerKey);
    await expect(lookup.getByTestId('ledger-lookup-not-found')).toContainText(state.ledgerKey);
    await expect(lookup.getByTestId('ledger-lookup-transaction')).toHaveCount(0);

    // The request, read again from svc-ops, still waits at "intent", and the original still shows not reversed.
    const again = await openTx(a, state.originalTxId);
    await expect(again.getByTestId('tx-reversal-links')).toHaveText('Not reversed');
    const waiting = requestRow(again.getByTestId('tx-reversal'), requestNo);
    await expect(waiting).toHaveAttribute('data-state', 'intent');
    await expect(waiting).toContainText('Not approved yet');
    await expect(again.getByTestId('reversal-request')).toHaveCount(1);
    await stepPicture(a);
  });

  test('J-ops-console-05 #2 a second approver approves: one linked compensating transaction posts, the original shows reverted and the pair nets to zero per asset', async ({
    browser,
    stepPicture,
  }) => {
    test.setTimeout(300_000);
    if (!state.packetText) throw new Error('#1 left no reversal request waiting for approval');
    const { a, b } = await founders(browser);

    await approveReversal(b, state.originalTxId, state.requestNo, state.packetText);
    state.reversingTxId = await runReversal(a, state.originalTxId, state.requestNo, state.packetText);
    expect(state.reversingTxId).not.toBe(state.originalTxId);

    // One compensating transaction, under the request's key, linked to the original.
    const reversing = await openTx(b, state.reversingTxId);
    await expect(reversing.getByTestId('ledger-lookup-business-key')).toHaveText(state.ledgerKey);
    await expect(reversing.getByTestId('tx-reverses')).toHaveAttribute('data-tx-id', state.originalTxId);
    await expect(reversing.getByTestId('tx-reversed-by')).toHaveCount(0);
    const reversingLegs = await legsOf(reversing);
    const byKey = await openBusinessKey(b, state.ledgerKey);
    await expect(byKey.getByTestId('ledger-lookup-tx-id')).toHaveText(state.reversingTxId);

    const original = await openTx(b, state.originalTxId);
    const originalLegs = await legsOf(original);
    expect(originalLegs.length, 'the original has legs').toBeGreaterThan(0);

    // Each leg of the original, flipped, the same amount, on the same account; nothing else.
    const flip = (leg) => ({ ...leg, direction: leg.direction === 'debit' ? 'credit' : 'debit', amount: toUnits(leg.amount).toString() });
    const same = (leg) => ({ ...leg, amount: toUnits(leg.amount).toString() });
    const order = (x, y) => (x.account + x.asset + x.direction).localeCompare(y.account + y.asset + y.direction);
    expect(reversingLegs.map(same).sort(order), 'the reversing legs are the original legs flipped').toEqual(
      originalLegs.map(flip).sort(order),
    );
    // The money invariant, from both transactions' legs as the console reads them: the pair nets to zero per asset, and on
    // every account it touched.
    const both = [...originalLegs, ...reversingLegs];
    const perAsset = netBy(both, (l) => l.asset);
    expect(Object.keys(perAsset), 'the pair moved the original’s asset').toContain(ASSET);
    for (const [asset, net] of Object.entries(perAsset)) expect(net, `${asset} nets to zero over the pair`).toBe('0');
    for (const [account, net] of Object.entries(netBy(both, (l) => `${l.account} ${l.asset}`)))
      expect(net, `${account} nets to zero over the pair`).toBe('0');

    // The request, read again from svc-ops: posted, approved by the other founder, naming the reversing transaction.
    const shown = await openTx(a, state.originalTxId);
    const row = requestRow(shown.getByTestId('tx-reversal'), state.requestNo);
    await expect(row).toHaveAttribute('data-state', 'posted');
    await expect(row.getByTestId('reversal-reversing-tx')).toHaveAttribute('data-tx-id', state.reversingTxId);
    await expect(row, 'approved by the other founder').toContainText(new RegExp(state.founderB.userId, 'i'));
    await expect(row).not.toContainText('Not approved yet');
    // The original shows reverted, with the reversing id.
    await expect(shown.getByTestId('tx-reversed-by')).toHaveAttribute('data-tx-id', state.reversingTxId);
    await expect(shown.getByTestId('tx-reversed-by')).toContainText(`Reverted by ${state.reversingTxId}`);
    await stepPicture(a);
  });

  test('J-ops-console-05 #3 reversing the same transaction again is refused ops.reversal_already_reversed with the first reversal shown', async ({
    browser,
    stepPicture,
  }) => {
    test.setTimeout(300_000);
    if (!state.reversingTxId) throw new Error('#2 posted no reversal');
    const { a, b } = await founders(browser);

    const desk = (await openTx(a, state.originalTxId)).getByTestId('tx-reversal');
    const form = desk.getByTestId('tx-reverse');
    await form.getByLabel(/^Reason \(12 to 500/).fill(`${ask.reason} again`);
    await form.getByLabel('Case reference', { exact: true }).fill(`${ask.caseRef}-2`);
    await form.getByTestId('tx-reverse-submit').click();
    const refused = desk.getByTestId('reversal-refused');
    await expect(refused.getByTestId('reversal-refused-code')).toHaveText('ops.reversal_already_reversed', { timeout: 30_000 });
    await expect(refused.getByTestId('reversal-first')).toHaveAttribute('data-tx-id', state.reversingTxId);
    await expect(refused).toContainText(`(reversal request ${state.requestNo})`);
    await expect(desk.getByTestId('reversal-asked')).toHaveCount(0);

    // Nothing new: svc-ops holds the one request, the original is still reversed once by the first reversal, and the ledger
    // holds nothing under a second ordinal.
    const lookup = await openBusinessKey(b, `ops:reversal:${state.originalTxId}:2`);
    await expect(lookup.getByTestId('ledger-lookup-not-found')).toBeVisible();
    const again = await openTx(b, state.originalTxId);
    await expect(again.getByTestId('tx-reversed-by')).toHaveAttribute('data-tx-id', state.reversingTxId);
    await expect(again.getByTestId('reversal-request')).toHaveCount(1);
    await expect(requestRow(again.getByTestId('tx-reversal'), state.requestNo)).toHaveAttribute('data-state', 'posted');
    await expect(refused).toBeVisible();
    await stepPicture(a);
  });
});
