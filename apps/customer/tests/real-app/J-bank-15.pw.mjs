// World: none
import { randomUUID } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { api, fund, journeyState } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-bank-15, in the running app (docs/roadmap/journeys.json): I dispute a card charge. One test per step, titled
// "J-bank-15 #<n>", run in order on one TEST cardholder. The card and its money are the partner's (OWNER 226); no partner
// is named, so the stack runs the TEST partner card adapter (card-sim) with its switches from the bank profile: its TEST
// dispute rules take a dispute up to 120 days after the charge settled and no evidence from the cardholder once the
// representment is submitted, and its TEST provisional credit is the disputed amount, added to what it reports the
// cardholder can spend (`cards.payFrom`). The journey starts with three captured TEST charges of 25.00 USDC and one
// declined TEST payment, made through the bank's ops door with two founders' approval as the simulator's stand-in needs.
//   #1 presses Dispute this charge on charge A: a form prefilled from it, the partner's window and evidence rule, and the
//      cases that cannot be disputed named; the declined payment is refused by name.
//   #2 files a partial dispute of 10.00 with a reason: the tracker with each state and its date.
//   #3 adds evidence while the case is open; after support submits the representment, more evidence is refused, as the
//      TEST partner's rules say.
//   #4 reads three decisions. A: the partner's provisional credit of 10 (available rises once by exactly 10, as the
//      partner reports), then lost for the merchant with support's reason and the credit reversed (available back). B:
//      the partner's credit, then won for the cardholder with the reason, the credit final. C: withdrawn by the cardholder
//      with their reason. The ledger posts nothing at any step.
const J = 'J-bank-15';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

function world() {
  const w = run.read();
  if (!w.who || !w.charges) throw new Error(`${J} #1 made no cardholder and charges, so this step has none to use`);
  return w;
}

let gatesCtx;
async function founders() {
  gatesCtx ??= (async () => {
    const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
    const ctx = await gates.makeContext({ log: () => {} });
    return { gates, ctx, sessions: await gates.approverSessions(ctx) };
  })();
  return gatesCtx;
}
/** One card-issuer event through the bank's ops door, approved by two founders; the merchant rides with the message. */
async function cardEvent(actionType, procedure, fields, bound = fields) {
  const { gates, ctx, sessions } = await founders();
  const approval = await gates.twoPerson(ctx, sessions, {
    actionType,
    targetService: 'svc-bank',
    targetId: actionType,
    expectedVersion: '1',
    payloadHash: gates.bankPayloadHash(actionType, bound),
    policyVersion: gates.MARKERS.policyVersion,
  });
  const res = await ctx.edge.mutate('bank', procedure, { ...fields, ...approval }, await sessions.a.treasuryToken());
  expect(res.status, res.text.slice(0, 300)).toBe(200);
  return res.json.result.data;
}
/** Support's step on a case, as a founder with the support scopes the console's founder session carries. */
async function support(procedure, input) {
  const { ctx, sessions } = await founders();
  const op = sessions.a.op;
  const { token } = await ctx.tokens.issueAccessToken(
    { userId: op.userId, sessionId: op.sessionId, scopes: ['admin:read', 'support:ops'], tier: 'none', mfa: true },
    { secret: ctx.secrets.jwt, issuer: 'intafaced', audience: 'intafaced.api', accessTtlSeconds: 300 },
  );
  const res = await ctx.edge.mutate('bank', procedure, input, token);
  expect(res.status, res.text.slice(0, 300)).toBe(200);
  return res.json.result.data;
}
/** The cardholder's ledger figures through their own API: their card money's disputes post nothing there. */
const ledgerOf = async (who) => (await api(who)).balances();
/** The person's own svc-bank API through Edge: `{ status, body }`. */
async function customerBank(who) {
  const own = await api(who);
  return {
    query: (procedure, input) =>
      own.get(`/api/bank/trpc/${procedure}${input ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`),
    mutate: (procedure, input) => own.post(`/api/bank/trpc/${procedure}`, input),
  };
}
/** What the partner reports this cardholder can spend in USDC (Pay from), in 18-decimal units. */
async function partnerAvailable(who) {
  const res = await (await customerBank(who)).query('cards.payFrom');
  const row = res?.body?.result?.data?.assets?.find((a) => a.assetId === 'USDC');
  expect(row?.partnerBalance, JSON.stringify(res?.body ?? {}).slice(0, 300)).toBeTruthy();
  return units(row.partnerBalance);
}
async function disputeOf(who, disputeId) {
  const res = await (await customerBank(who)).query('cards.disputes.get', { disputeId });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}
const SCALE = 10n ** 18n;
const units = (d) => {
  const [whole, frac = ''] = String(d).split('.');
  return BigInt(whole) * SCALE + BigInt((frac + '0'.repeat(18)).slice(0, 18));
};

/** The card's Disputes panel on /bank/cards, signed in as the cardholder. */
async function disputesPanel(page, { signedIn = false } = {}) {
  const { who, cardId } = world();
  if (!signedIn) await signIn(page, who);
  await page.goto('/bank/cards');
  const here = page.locator(`[data-card="${cardId}"]`);
  const controls = here.getByRole('region', { name: 'Card controls', exact: true });
  const inspect = page.getByRole('button', { name: `Inspect decisions for card ${cardId}` });
  await expect(controls.or(inspect)).toBeVisible({ timeout: 30_000 });
  if (await inspect.isVisible()) await inspect.click();
  const panel = here.getByRole('region', { name: 'Disputes', exact: true });
  await expect(panel).toBeVisible();
  return panel;
}
const tracker = (panel, ref) => panel.getByRole('region', { name: `Dispute of ${ref}`, exact: true });

test(`${J} #1 opens the charge and presses Dispute this charge: a prefilled form, the partner's time window and the cases that cannot be disputed named`, async ({
  page,
}) => {
  test.setTimeout(600_000);
  // The start: a verified TEST cardholder with a TEST USDC card, three captured TEST charges of 25.00 and one declined.
  const who = await signUp(page, 'jb15');
  await verify(page, who);
  expect(fund(who.email, 'USDC', '200').tx).toBeTruthy();
  const issued = await (
    await customerBank(who)
  ).mutate('cards.issue', {
    cardId: randomUUID(),
    assetId: 'USDC',
    settlementAssetId: 'USDC',
    perAuthorizationLimit: '100',
  });
  const cardId = issued?.body?.result?.data?.id;
  expect(cardId, JSON.stringify(issued).slice(0, 300)).toBeTruthy();
  const charges = {};
  for (const name of ['a', 'b', 'c']) {
    const ref = `jb15-${name}-${randomUUID()}`;
    const bound = { cardId, authorizationRef: ref, amount: '25' };
    expect(await cardEvent('bank.card_authorize', 'ops.cardAuthorize', { ...bound, merchant: 'TEST Shop' }, bound)).toMatchObject({
      decision: 'approved',
    });
    await cardEvent('bank.card_capture', 'ops.cardCapture', bound);
    charges[name] = ref;
  }
  const declinedRef = `jb15-declined-${randomUUID()}`;
  const declinedBound = { cardId, authorizationRef: declinedRef, amount: '150' };
  expect(
    await cardEvent('bank.card_authorize', 'ops.cardAuthorize', { ...declinedBound, merchant: 'TEST Shop' }, declinedBound),
  ).toMatchObject({
    decision: 'declined',
  });
  const ledger = await ledgerOf(who);
  run.reset({ who, cardId, charges, declinedRef, ledger });

  // The form, as svc-bank answers it: the partner's TEST rules, and the charge disputable.
  const api = await customerBank(who);
  const form = (await api.query('cards.disputes.form', { cardId, authorizationRef: charges.a })).body.result.data;
  expect(form).toMatchObject({
    test: true,
    rules: { windowDays: 120, evidenceAfterSubmission: false },
    charge: { authorizationRef: charges.a, assetId: 'USDC', merchant: 'TEST Shop', captured: '25', disputable: '25' },
    standing: 'disputable',
    disputeId: null,
  });
  expect(new Date(form.deadline).getTime() - new Date(form.charge.settledAt).getTime()).toBe(120 * 86_400_000);

  // On the page: Dispute this charge on charge A opens the form prefilled from it.
  const panel = await disputesPanel(page);
  const row = panel.getByRole('list', { name: 'Payments you can dispute' }).locator(`li[data-authorization="${charges.a}"]`);
  await expect(row).toContainText('25 USDC at TEST Shop');
  await row.getByRole('button', { name: 'Dispute this charge' }).click();
  const shown = panel.getByRole('region', { name: 'Dispute a charge', exact: true });
  await expect(shown).toBeVisible();
  await expect(shown).toContainText(charges.a);
  await expect(shown).toContainText('TEST Shop');
  await expect(shown).toContainText('TEST card partner: these rules are a stand-in’s, not a partner’s.');
  await expect(shown.getByLabel('Amount to dispute (USDC)')).toHaveValue('25');
  await expect(shown.getByTestId('dispute-window')).toContainText(
    'The card partner takes a dispute up to 120 days after the charge settled: file it by',
  );
  await expect(shown.getByTestId('dispute-evidence-rule')).toHaveText(
    'You can add evidence while the case is open. Once the representment is submitted, the card partner takes no more evidence from you.',
  );
  const ineligible = shown.getByRole('list', { name: 'These cannot be disputed' }).getByRole('listitem');
  await expect(ineligible).toHaveText([
    'A declined payment: nothing was taken.',
    'A payment that has not settled yet.',
    'A payment the merchant refunded in full.',
    'A payment that is disputed already.',
    'A payment older than the card partner’s window.',
  ]);
  // An ineligible case: the declined payment is named so, and filing it is refused, nothing kept.
  const declinedForm = (await api.query('cards.disputes.form', { cardId, authorizationRef: declinedRef })).body.result.data;
  expect(declinedForm).toMatchObject({ standing: 'declined', disputeId: null });
  const refused = await api.mutate('cards.disputes.open', { cardId, authorizationRef: declinedRef, amount: '10', reason: 'TEST' });
  expect(refused.status).toBe(412);
  expect(JSON.stringify(refused.body)).toContain('bank.card_dispute_not_disputable');
  expect((await api.query('cards.disputes.list', { cardId })).body.result.data).toEqual([]);
});

test(`${J} #2 files a partial dispute with a reason: the tracker with each state and date, and the partial dispute of 10.00 accepted`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { who, cardId, charges, ledger } = world();
  const panel = await disputesPanel(page);
  await panel.locator(`li[data-authorization="${charges.a}"]`).getByRole('button', { name: 'Dispute this charge' }).click();
  const form = panel.getByRole('region', { name: 'Dispute a charge', exact: true });
  await form.getByLabel('Amount to dispute (USDC)').fill('10.00');
  await form.getByLabel('Why you dispute it').fill('TEST: charged 10 more than the price agreed');
  await form.getByRole('button', { name: 'File this dispute' }).click();

  const shown = tracker(panel, charges.a);
  await expect(shown).toBeVisible({ timeout: 30_000 });
  const [listed] = (await (await customerBank(who)).query('cards.disputes.list', { cardId })).body.result.data;
  expect(listed).toMatchObject({
    authorizationRef: charges.a,
    amount: '10',
    state: 'opened',
    reason: 'TEST: charged 10 more than the price agreed',
  });
  const stored = await disputeOf(who, listed.id);
  expect(stored.events).toEqual([expect.objectContaining({ kind: 'opened', toState: 'opened', by: 'you' })]);
  run.reset({ ...world(), cases: { a: listed.id } });

  await expect(shown).toHaveAttribute('data-state', 'opened');
  await expect(shown).toContainText('10 USDC disputed. Your reason: TEST: charged 10 more than the price agreed');
  await expect(shown.getByTestId('dispute-state')).toHaveText('Now: Filed');
  const steps = shown.getByRole('list', { name: 'Tracker' }).getByRole('listitem');
  await expect(steps).toHaveCount(1);
  await expect(steps.first()).toHaveAttribute('data-kind', 'opened');
  // Its date, as the page writes the stored time.
  const when = await page.evaluate(
    (iso) =>
      new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    stored.events[0].at,
  );
  await expect(steps.first()).toContainText(`Filed on ${when}, by you`);
  // The charge now reads disputed, and filing it again is the same case.
  await expect(panel.locator(`li[data-authorization="${charges.a}"]`)).toContainText('Disputed: see its tracker below.');
  const again = await (
    await customerBank(who)
  ).mutate('cards.disputes.open', {
    cardId,
    authorizationRef: charges.a,
    amount: '10.00',
    reason: 'TEST: charged 10 more than the price agreed',
  });
  expect(again.body.result.data.id).toBe(listed.id);
  expect(await ledgerOf(who)).toEqual(ledger);
});

test(`${J} #3 adds evidence: allowed while the case is open, refused after the representment is submitted as the partner's rules say`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { who, charges, cases, ledger } = world();
  if (!cases?.a) throw new Error(`${J} #2 filed no case, so this step has none to add evidence to`);
  const panel = await disputesPanel(page);
  const shown = tracker(panel, charges.a);
  await shown.getByLabel('Evidence').fill('TEST: the receipt shows the agreed price');
  await shown.getByRole('button', { name: 'Add evidence' }).click();
  const steps = shown.getByRole('list', { name: 'Tracker' }).getByRole('listitem');
  await expect(steps).toHaveCount(2);
  await expect(steps.nth(1)).toHaveAttribute('data-kind', 'evidence');
  await expect(steps.nth(1)).toContainText('Evidence added on');
  await expect(steps.nth(1)).toContainText('by you: TEST: the receipt shows the agreed price');
  expect((await disputeOf(who, cases.a)).events.map((e) => [e.kind, e.by, e.afterSubmission])).toEqual([
    ['opened', 'you', false],
    ['evidence', 'you', false],
  ]);

  // Support submits the representment; the TEST partner then takes no more evidence from the cardholder.
  await support('ops.cardDisputeRepresentment', {
    disputeId: cases.a,
    stepKey: `jb15-rep-${cases.a}`,
    description: 'TEST: the merchant says the price was right',
  });
  const after = tracker(await disputesPanel(page, { signedIn: true }), charges.a);
  await expect(after.getByTestId('dispute-state')).toHaveText('Now: Representment submitted');
  await after.getByLabel('Evidence').fill('TEST: a second receipt');
  await after.getByRole('button', { name: 'Add evidence' }).click();
  await expect(after.getByRole('alert')).toContainText(
    'The card partner takes no more evidence from you once the representment is submitted',
  );
  await expect(after.getByRole('alert')).toHaveAttribute('data-code', 'bank.card_dispute_evidence_closed');
  const events = (await disputeOf(who, cases.a)).events;
  expect(events.map((e) => [e.kind, e.by])).toEqual([
    ['opened', 'you'],
    ['evidence', 'you'],
    ['representment', 'support'],
  ]);
  expect(events.filter((e) => e.kind === 'evidence')).toHaveLength(1);
  expect(await ledgerOf(who)).toEqual(ledger);
});

test(`${J} #4 reads the decision: won, lost or withdrawn with its reason, and any provisional credit and its reversal as the partner reports them`, async ({
  page,
}) => {
  test.setTimeout(600_000);
  const { who, cardId, charges, cases, ledger } = world();
  if (!cases?.a) throw new Error(`${J} #2 filed no case, so this step has none to decide`);
  const api = await customerBank(who);
  const fileOf = async (ref, amount, reason) => {
    const res = await api.mutate('cards.disputes.open', { cardId, authorizationRef: ref, amount, reason });
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    return res.body.result.data.id;
  };
  const b = await fileOf(charges.b, '25', 'TEST: never delivered');
  const c = await fileOf(charges.c, '25', 'TEST: a payment I did not recognise');

  // A: the partner's provisional credit, once, by exactly the disputed 10, as the partner reports it.
  const start = await partnerAvailable(who);
  const credited = await support('ops.cardDisputeCredit', { disputeId: cases.a });
  expect(credited.provisionalCredit).toMatchObject({ state: 'credited', amount: '10' });
  expect(await partnerAvailable(who)).toBe(start + 10n * SCALE);
  await support('ops.cardDisputeCredit', { disputeId: cases.a });
  expect(await partnerAvailable(who)).toBe(start + 10n * SCALE);
  // A is lost: decided for the merchant with support's reason, and the partner reverses its credit.
  await support('ops.cardDisputeDecide', { disputeId: cases.a, outcome: 'merchant', reason: 'TEST: the merchant showed the agreed price' });
  expect(await partnerAvailable(who)).toBe(start);
  // B is won: the partner's credit of 25, then decided for the cardholder, the credit final.
  await support('ops.cardDisputeCredit', { disputeId: b });
  await support('ops.cardDisputeDecide', { disputeId: b, outcome: 'cardholder', reason: 'TEST: the merchant could not show delivery' });
  expect(await partnerAvailable(who)).toBe(start + 25n * SCALE);

  const panel = await disputesPanel(page);
  // C is withdrawn by the cardholder on the page, with their reason.
  const caseC = tracker(panel, charges.c);
  await caseC.getByLabel('Why you withdraw it').fill('TEST: I found it was my own purchase');
  await caseC.getByRole('button', { name: 'Withdraw this dispute' }).click();
  await expect(caseC.getByTestId('dispute-decision')).toHaveAttribute('data-outcome', 'withdrawn');
  expect(await partnerAvailable(who)).toBe(start + 25n * SCALE);

  const lost = await disputeOf(who, cases.a);
  expect(lost).toMatchObject({
    state: 'closed',
    provisionalCredit: { state: 'credited', amount: '10' },
    decision: { outcome: 'merchant', reason: 'TEST: the merchant showed the agreed price', creditSettlement: 'reversed' },
  });
  const caseA = tracker(panel, charges.a);
  await expect(caseA.getByTestId('dispute-decision')).toHaveAttribute('data-outcome', 'merchant');
  await expect(caseA.getByTestId('dispute-decision')).toContainText('Lost: decided for the merchant.');
  await expect(caseA.getByTestId('dispute-decision')).toContainText('Reason: TEST: the merchant showed the agreed price');
  await expect(caseA.getByTestId('dispute-credit')).toHaveText(
    `The card partner credited 10 USDC provisionally, reference ${lost.provisionalCredit.partnerRef}.`,
  );
  await expect(caseA.getByTestId('dispute-settlement')).toHaveText(
    `The card partner reversed its provisional credit of 10 USDC, reference ${lost.decision.creditSettlementPartnerRef}.`,
  );

  const won = await disputeOf(who, b);
  expect(won.decision).toMatchObject({
    outcome: 'cardholder',
    reason: 'TEST: the merchant could not show delivery',
    creditSettlement: 'final',
  });
  const caseB = tracker(panel, charges.b);
  await expect(caseB.getByTestId('dispute-decision')).toContainText('Won: decided for you.');
  await expect(caseB.getByTestId('dispute-decision')).toContainText('Reason: TEST: the merchant could not show delivery');
  await expect(caseB.getByTestId('dispute-settlement')).toHaveText(
    `The card partner made its provisional credit of 25 USDC final, reference ${won.decision.creditSettlementPartnerRef}.`,
  );

  const withdrawn = await disputeOf(who, c);
  expect(withdrawn).toMatchObject({
    state: 'closed',
    provisionalCredit: { state: 'none' },
    decision: { outcome: 'withdrawn', reason: 'TEST: I found it was my own purchase', creditSettlement: null },
  });
  await expect(caseC.getByTestId('dispute-decision')).toContainText('Withdrawn by you.');
  await expect(caseC.getByTestId('dispute-decision')).toContainText('Reason: TEST: I found it was my own purchase');
  await expect(caseC.getByTestId('dispute-credit')).toHaveText('No provisional credit.');
  for (const t of [caseA, caseB, caseC]) await expect(t.getByTestId('dispute-state')).toHaveText('Now: Decided');

  // The ledger posted nothing for any dispute: the cardholder's ledger balances are as the journey started.
  expect(await ledgerOf(who)).toEqual(ledger);
});
