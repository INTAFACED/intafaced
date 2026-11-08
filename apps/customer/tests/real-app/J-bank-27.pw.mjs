// World: restart
import { randomUUID } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, fund, journeyState, json, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-bank-27, in the running app (docs/roadmap/journeys.json): I handle card disputes (support), on the founder console at
// /bank-ops/cards/disputes. The card and its money are the partner's (OWNER 226); no partner is named, so the stack runs the
// TEST partner card adapter (card-sim) with its switches from the bank profile. One TEST cardholder with a USDC card makes
// three captured TEST payments (50, 40 and 250 USDC, through the bank's ops door, approved by two founders as the
// simulator's stand-in needs), and support opens one TEST case on each: the journey's three TEST cases. Case B is worked to
// a representment by the second founder before step 1, so its timeline has more than one transition and actor.
//   #1 filters the queue by state and opens case B: a timeline with every transition, its actor and its time.
//   #2 on case A adds evidence, submits a representment, adds evidence after submission (stored with its time and marked
//      so) and escalates to arbitration, an explicit state the queue filters by.
//   #3 grants case A's provisional credit (TEST rule: the TEST partner credits the disputed 50.00): recorded as the
//      partner's credit with its reference; the cardholder's available, as the partner reports it, rises once by exactly
//      50; a second grant changes nothing; the ledger posts nothing.
//   #4 decides and closes. With the profile's TEST partner (loss liability not reported), case B closes with who bears the
//      fraud loss "not known", never the partner; case C (250 USDC) is refused above the TEST dispute cap of 100.00 USDC and
//      stays open. For one restart the partner reports its TEST terms (the programme bears the loss) and the cap is blank:
//      case A closes for the merchant with the programme recorded under the partner's terms and the partner's credit
//      reversed, and case C is refused by name, the cap not published.
// Step 5 (the regulatory clock) is deferred until launch prep (owner decision 2026-10-27).
const J = 'J-bank-27';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

function world() {
  const w = run.read();
  if (!w.cases) throw new Error(`${J} #1 made no cases, so this step has none to work`);
  return w;
}

/** The bank restarted with LOCAL_STACK_ switches set for that restart only (undefined puts the profile's TEST value back). */
function restartBank(switches) {
  const before = Object.fromEntries(Object.keys(switches).map((k) => [k, process.env[k]]));
  const set = (values) => {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  set(switches);
  try {
    tool('local-test-stack.mjs', 'restart', 'bank');
  } finally {
    set(before);
  }
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
/** One card-issuer event through the bank's ops door, approved by two founders as the simulator's stand-in requires. */
async function cardEvent(actionType, procedure, fields) {
  const { gates, ctx, sessions } = await founders();
  const approval = await gates.twoPerson(ctx, sessions, {
    actionType,
    targetService: 'svc-bank',
    targetId: actionType,
    expectedVersion: '1',
    payloadHash: gates.bankPayloadHash(actionType, fields),
    policyVersion: gates.MARKERS.policyVersion,
  });
  const res = await ctx.edge.mutate('bank', procedure, { ...fields, ...approval }, await sessions.a.treasuryToken());
  expect(res.status, res.text.slice(0, 300)).toBe(200);
  return res.json.result.data;
}
/** A founder's own session with the support scopes the console's founder session carries on this stack. */
async function supportToken(key) {
  const { ctx, sessions } = await founders();
  const op = sessions[key].op;
  const { token } = await ctx.tokens.issueAccessToken(
    { userId: op.userId, sessionId: op.sessionId, scopes: ['admin:read', 'support:ops'], tier: 'none', mfa: true },
    { secret: ctx.secrets.jwt, issuer: 'intafaced', audience: 'intafaced.api', accessTtlSeconds: 300 },
  );
  return { token, userId: op.userId };
}
async function bankOps(kind, procedure, input, key = 'a') {
  const { ctx } = await founders();
  const { token } = await supportToken(key);
  const res =
    kind === 'query' ? await ctx.edge.query('bank', procedure, input, token) : await ctx.edge.mutate('bank', procedure, input, token);
  return res;
}
async function disputeRead(disputeId) {
  const res = await bankOps('query', 'ops.cardDispute', { disputeId });
  expect(res.status, res.text.slice(0, 300)).toBe(200);
  return res.json.result.data;
}
/** The cardholder's ledger balances, as the treasury desk reads them: the check that nothing posted. */
async function ledgerBalances(userId) {
  const { ctx, sessions } = await founders();
  const res = await ctx.edge.query('bank', 'ops.customerBalances', { userId }, await sessions.a.treasuryToken());
  expect(res.status, res.text.slice(0, 300)).toBe(200);
  return res.json.result.data.assets;
}
/** A person's own svc-bank API through Edge. */
async function customerBank(who) {
  const { body: login } = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password }),
  }).then(json);
  const token = login?.result?.data?.accessToken;
  if (!token) throw new Error(`sign-in for ${who.email} refused: ${JSON.stringify(login).slice(0, 300)}`);
  const headers = { origin: ORIGIN, authorization: `Bearer ${token}` };
  return {
    query: (procedure) => fetch(`${EDGE}/api/bank/trpc/${procedure}`, { headers }).then(json),
    mutate: (procedure, input) =>
      fetch(`${EDGE}/api/bank/trpc/${procedure}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }).then(json),
  };
}
/** What the partner reports this cardholder can spend in USDC (Pay from, J-bank-29 #2). */
async function partnerAvailable(who) {
  const res = await (await customerBank(who)).query('cards.payFrom');
  const row = res?.body?.result?.data?.assets?.find((a) => a.assetId === 'USDC');
  expect(row, JSON.stringify(res?.body ?? {}).slice(0, 300)).toBeTruthy();
  return row.partnerBalance;
}

async function desk(browser, path, key = 'a') {
  const context = await browser.newContext({ baseURL: ADMIN, viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  const founder = await founderSignIn(page, key);
  await page.goto(path);
  return { page, founder };
}
const fact = (page, testId) => page.getByTestId(testId).locator('dd');
/** A table's rows as the screen shows them, each keyed by its column heading. */
async function shownRows(table) {
  await expect(table.locator('tbody tr').first()).toBeVisible({ timeout: 30_000 });
  return table.evaluate((el) => {
    const heads = [...el.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    return [...el.querySelectorAll('tbody tr')].map((tr) => ({
      id: tr.getAttribute('data-dispute-id'),
      time: tr.querySelector('time')?.getAttribute('datetime') ?? null,
      ...Object.fromEntries([...tr.querySelectorAll('td')].map((td, i) => [heads[i], td.textContent.trim()])),
    }));
  });
}
const SCALE = 10n ** 18n;
const units = (d) => {
  const [whole, frac = ''] = d.split('.');
  return BigInt(whole) * SCALE + BigInt((frac + '0'.repeat(18)).slice(0, 18));
};

/** The three TEST cases: one TEST cardholder, three captured USDC payments, one case on each; case B worked to representment. */
async function makeCases(browser) {
  const customer = await (await browser.newContext({ baseURL: ORIGIN })).newPage();
  const who = await signUp(customer, 'jb27');
  await verify(customer, who);
  await customer.context().close();
  expect(fund(who.email, 'USDC', '400').tx).toBeTruthy();
  const issued = await (
    await customerBank(who)
  ).mutate('cards.issue', {
    cardId: randomUUID(),
    assetId: 'USDC',
    settlementAssetId: 'USDC',
    perAuthorizationLimit: '300',
  });
  const cardId = issued?.body?.result?.data?.id;
  expect(cardId, JSON.stringify(issued).slice(0, 300)).toBeTruthy();
  const cases = {};
  for (const [name, amount] of [
    ['a', '50'],
    ['b', '40'],
    ['c', '250'],
  ]) {
    const ref = `jb27-${name}-${randomUUID()}`;
    await cardEvent('bank.card_authorize', 'ops.cardAuthorize', { cardId, authorizationRef: ref, amount });
    await cardEvent('bank.card_capture', 'ops.cardCapture', { cardId, authorizationRef: ref, amount });
    const opened = await bankOps('mutate', 'ops.cardDisputeOpen', {
      caseKey: `jb27-case-${randomUUID()}`,
      cardId,
      authorizationRef: ref,
      amount,
      reason: `TEST: the cardholder does not recognise this ${amount} USDC payment`,
    });
    expect(opened.status, opened.text.slice(0, 300)).toBe(200);
    cases[name] = opened.json.result.data.id;
  }
  // Case B: the first founder adds evidence, the second submits the representment.
  for (const [procedure, input, key] of [
    ['ops.cardDisputeEvidence', { stepKey: `jb27-ev-${randomUUID()}`, description: 'TEST: the merchant’s delivery receipt' }, 'a'],
    ['ops.cardDisputeRepresentment', { stepKey: `jb27-rep-${randomUUID()}`, description: 'TEST: the merchant shows delivery' }, 'b'],
  ]) {
    const res = await bankOps('mutate', procedure, { disputeId: cases.b, ...input }, key);
    expect(res.status, res.text.slice(0, 300)).toBe(200);
  }
  return run.reset({ who, cardId, cases });
}

test(`${J} #1 filters the queue by state and opens a case: a timeline with every transition, actor and time`, async ({ browser }) => {
  test.setTimeout(600_000);
  const { cases } = await makeCases(browser);
  const { page } = await desk(browser, '/bank-ops/cards/disputes');
  await expect(page.getByTestId('dispute-desk')).toBeVisible();

  // Every state: all three TEST cases are on the queue.
  let rows = await shownRows(page.getByTestId('dispute-queue'));
  for (const id of Object.values(cases)) expect(rows.map((r) => r.id)).toContain(id);

  // Filtered to "Representment submitted": case B, and only cases in that state.
  await page.getByLabel('State', { exact: true }).selectOption('representment');
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await expect(page).toHaveURL(/[?&]state=representment\b/);
  rows = await shownRows(page.getByTestId('dispute-queue'));
  expect(rows.map((r) => r.id)).toContain(cases.b);
  expect(rows.map((r) => r.id)).not.toContain(cases.a);
  expect(rows.map((r) => r.id)).not.toContain(cases.c);
  for (const r of rows) expect(r.State).toBe('Representment submitted');
  // Filtered to "Opened": A and C, not B.
  await page.getByLabel('State', { exact: true }).selectOption('opened');
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await expect(page).toHaveURL(/[?&]state=opened\b/);
  rows = await shownRows(page.getByTestId('dispute-queue'));
  expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining([cases.a, cases.c]));
  expect(rows.map((r) => r.id)).not.toContain(cases.b);
  for (const r of rows) expect(r.State).toBe('Opened');

  // Opens case B from the queue: its timeline shows every transition the service recorded, with its actor and its time.
  await page.getByLabel('State', { exact: true }).selectOption('representment');
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await page.getByTestId('dispute-queue').locator(`tr[data-dispute-id="${cases.b}"]`).getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`/bank-ops/cards/disputes/${cases.b}$`));
  await expect(fact(page, 'dispute-state-fact')).toHaveText('Representment submitted');
  const stored = await disputeRead(cases.b);
  const timeline = await shownRows(page.getByTestId('dispute-timeline'));
  const a = (await supportToken('a')).userId;
  const b = (await supportToken('b')).userId;
  expect(stored.events.map((e) => [e.kind, e.toState, e.actor])).toEqual([
    ['opened', 'opened', a],
    ['evidence', 'opened', a],
    ['representment', 'representment', b],
  ]);
  expect(timeline).toHaveLength(stored.events.length);
  timeline.forEach((row, i) => {
    const e = stored.events[i];
    expect(row).toMatchObject({
      '#': String(e.sequence),
      Step: ['Case opened', 'Evidence added', 'Representment submitted'][i],
      From: i === 0 ? 'None' : 'Opened',
      To: ['Opened', 'Opened', 'Representment submitted'][i],
      By: e.actor,
    });
    // The time is the service's own, to the second.
    expect(row.time).toBe(e.at);
    expect(Date.parse(row.time)).toBeGreaterThan(Date.now() - 30 * 60_000);
    expect(row.When).toMatch(/^\d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2}:\d{2} UTC$/);
  });
  await page.context().close();
});

test(`${J} #2 adds evidence and a representment: evidence after submission is stored with its time; arbitration is an explicit state`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { cases } = world();
  const { page, founder } = await desk(browser, `/bank-ops/cards/disputes/${cases.a}`);
  const actions = page.getByTestId('dispute-actions');
  await expect(fact(page, 'dispute-state-fact')).toHaveText('Opened');

  await actions.getByLabel('Evidence', { exact: true }).fill('TEST: the cardholder’s statement and screenshot');
  await actions.getByRole('button', { name: 'Add evidence' }).click();
  await expect(page.getByTestId('dispute-answer')).toContainText('The evidence is stored with its time.');
  await actions.getByLabel('Representment', { exact: true }).fill('TEST: the merchant’s representment, no proof of delivery');
  await actions.getByRole('button', { name: 'Submit representment' }).click();
  await expect(fact(page, 'dispute-state-fact')).toHaveText('Representment submitted');
  const submittedAt = Date.parse((await disputeRead(cases.a)).events.find((e) => e.kind === 'representment').at);

  // Evidence after submission: kept, with its own time, and marked so.
  await actions.getByLabel('Evidence', { exact: true }).fill('TEST: the cardholder’s late letter');
  await actions.getByRole('button', { name: 'Add evidence' }).click();
  await expect(page.getByTestId('dispute-timeline').locator('tbody tr')).toHaveCount(4);
  let timeline = await shownRows(page.getByTestId('dispute-timeline'));
  const late = timeline[3];
  expect(late).toMatchObject({
    Step: 'Evidence added (after submission)',
    By: founder.userId,
    Detail: 'TEST: the cardholder’s late letter',
  });
  expect(Date.parse(late.time)).toBeGreaterThanOrEqual(submittedAt);
  const stored = await disputeRead(cases.a);
  expect(stored.events.map((e) => [e.kind, e.afterSubmission])).toEqual([
    ['opened', false],
    ['evidence', false],
    ['representment', false],
    ['evidence', true],
  ]);
  expect(late.time).toBe(stored.events[3].at);

  // Arbitration is its own state, on the case and in the queue's filter.
  await actions.getByRole('button', { name: 'Escalate to arbitration' }).click();
  await expect(fact(page, 'dispute-state-fact')).toHaveText('In arbitration');
  timeline = await shownRows(page.getByTestId('dispute-timeline'));
  expect(timeline[4]).toMatchObject({
    Step: 'Escalated to arbitration',
    From: 'Representment submitted',
    To: 'In arbitration',
    By: founder.userId,
  });
  expect((await disputeRead(cases.a)).state).toBe('arbitration');
  await page.goto('/bank-ops/cards/disputes?state=arbitration');
  const rows = await shownRows(page.getByTestId('dispute-queue'));
  expect(rows.find((r) => r.id === cases.a)).toMatchObject({ State: 'In arbitration' });
  for (const r of rows) expect(r.State).toBe('In arbitration');
  await page.context().close();
});

test(`${J} #3 grants provisional credit: recorded as the partner's credit: the cardholder's available rises once by exactly the amount, as the partner reports, and the case shows the partner's reference`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { who, cases } = world();
  const before = await partnerAvailable(who);
  expect(before).toMatch(/^\d+(\.\d+)?$/);
  const cardholder = (await disputeRead(cases.a)).userId;
  const ledgerBefore = await ledgerBalances(cardholder);

  const { page } = await desk(browser, `/bank-ops/cards/disputes/${cases.a}`);
  await expect(fact(page, 'dispute-credit')).toHaveText('None');
  await page.getByTestId('dispute-actions').getByRole('button', { name: 'Grant provisional credit' }).click();
  await expect(fact(page, 'dispute-credit')).toHaveText('50 USDC, the partner’s credit');
  const stored = await disputeRead(cases.a);
  expect(stored.provisionalCredit).toMatchObject({ state: 'credited', amount: '50' });
  expect(stored.provisionalCredit.partnerRef).toMatch(/^TEST-card-sim-credit-[0-9a-f]{16}$/);
  await expect(fact(page, 'dispute-credit-ref')).toHaveText(stored.provisionalCredit.partnerRef);
  const timeline = await shownRows(page.getByTestId('dispute-timeline'));
  expect(timeline.at(-1)).toMatchObject({ Step: 'Provisional credit (the partner’s)' });
  expect(timeline.at(-1).Detail).toContain(stored.provisionalCredit.partnerRef);
  // The button is gone once the partner has answered.
  await expect(page.getByRole('button', { name: 'Grant provisional credit' })).toHaveCount(0);
  await page.context().close();

  // The cardholder's available, as the partner reports it, rose by exactly the amount.
  const after = await partnerAvailable(who);
  expect(units(after) - units(before)).toBe(units(stored.provisionalCredit.amount));
  // Once: a second grant is the same credit and the same reference, and the figure does not move again.
  const again = await bankOps('mutate', 'ops.cardDisputeCredit', { disputeId: cases.a });
  expect(again.status, again.text.slice(0, 300)).toBe(200);
  expect(again.json.result.data.provisionalCredit.partnerRef).toBe(stored.provisionalCredit.partnerRef);
  expect(await partnerAvailable(who)).toBe(after);
  expect((await disputeRead(cases.a)).events.filter((e) => e.kind === 'provisional_credit')).toHaveLength(1);
  // The cardholder sees it in Pay from, as the partner reports it.
  const customer = await (await browser.newContext({ baseURL: ORIGIN })).newPage();
  await signIn(customer, who);
  await customer.goto('/bank/cards');
  await expect(customer.getByTestId('card-pay-from-USDC')).toContainText(`${after} USDC`);
  await customer.context().close();
  // The ledger posted nothing: the cardholder's ledger balances are as they were.
  expect(await ledgerBalances(cardholder)).toEqual(ledgerBefore);
});

test(`${J} #4 decides loss liability and closes: who bears the fraud loss recorded under the partner's terms, or "not known"; it is never assumed to be the partner; a dispute cap enforced`, async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const { cases } = world();

  // The profile's TEST partner has not reported who bears a loss: case B closes with "not known", never the partner.
  let { page } = await desk(browser, `/bank-ops/cards/disputes/${cases.b}`);
  await page.getByLabel('Decision', { exact: true }).selectOption('merchant');
  await page.getByRole('button', { name: 'Decide and close' }).click();
  await expect(fact(page, 'dispute-state-fact')).toHaveText('Closed');
  await expect(fact(page, 'dispute-outcome')).toHaveText('For the merchant');
  await expect(fact(page, 'dispute-loss')).toHaveText('not known');
  await expect(fact(page, 'dispute-loss')).not.toContainText(/partner/i);
  await expect(fact(page, 'dispute-credit-settlement')).toHaveText('None was given');
  const b = await disputeRead(cases.b);
  expect(b.decision).toMatchObject({ outcome: 'merchant', lossStatus: 'not_known', lossBearer: null, lossTerms: null });
  expect(b.events.at(-1)).toMatchObject({ kind: 'closed', toState: 'closed' });
  expect(b.events.at(-1).detail).toContain('who bears the fraud loss is not known');
  // A closed case offers no further step.
  await expect(page.getByTestId('dispute-actions')).toHaveCount(0);
  await page.context().close();

  // Case C, 250 USDC, is above the TEST dispute cap of 100.00 USDC: no credit and no decision for the cardholder.
  ({ page } = await desk(browser, `/bank-ops/cards/disputes/${cases.c}`));
  await expect(fact(page, 'dispute-cap')).toHaveText('100.00 USDC (TEST)');
  await page.getByRole('button', { name: 'Grant provisional credit' }).click();
  await expect(page.getByTestId('dispute-answer')).toHaveText(
    'This dispute is above the owner’s dispute cap. Nothing was credited or decided for the cardholder.',
  );
  await page.getByLabel('Decision', { exact: true }).selectOption('cardholder');
  await page.getByRole('button', { name: 'Decide and close' }).click();
  await expect(page.getByTestId('dispute-answer')).toHaveText(
    'This dispute is above the owner’s dispute cap. Nothing was credited or decided for the cardholder.',
  );
  await page.reload();
  await expect(fact(page, 'dispute-state-fact')).toHaveText('Opened');
  await expect(fact(page, 'dispute-credit')).toHaveText('None');
  const capped = await bankOps('mutate', 'ops.cardDisputeDecide', { disputeId: cases.c, outcome: 'cardholder' });
  expect(capped.text).toContain('bank.card_dispute_cap_exceeded');
  expect((await disputeRead(cases.c)).state).toBe('opened');
  await page.context().close();

  // For one restart the partner reports its TEST terms (the programme bears the loss) and the owner's cap is blank.
  restartBank({ LOCAL_STACK_BANK_CARD_PARTNER: 'reported', LOCAL_STACK_BANK_CARD_DISPUTE_CAP: 'off' });
  try {
    // Case C: the cap not published refuses by name.
    ({ page } = await desk(browser, `/bank-ops/cards/disputes/${cases.c}`));
    await expect(fact(page, 'dispute-cap')).toHaveText(
      'Not set: a credit or a decision for the cardholder refuses until the owner publishes it.',
    );
    await page.getByLabel('Decision', { exact: true }).selectOption('cardholder');
    await page.getByRole('button', { name: 'Decide and close' }).click();
    await expect(page.getByTestId('dispute-answer')).toContainText('The owner has not published the dispute cap for this asset');
    const unset = await bankOps('mutate', 'ops.cardDisputeDecide', { disputeId: cases.c, outcome: 'cardholder' });
    expect(unset.text).toContain('bank.card_dispute_cap_unset');
    expect((await disputeRead(cases.c)).state).toBe('opened');
    await page.context().close();

    // Case A (in arbitration, credited): decided for the merchant. The loss is recorded as the partner's terms say: the
    // programme, with the terms' words; the partner's provisional credit is reversed with its reference.
    ({ page } = await desk(browser, `/bank-ops/cards/disputes/${cases.a}`));
    await page.getByLabel('Decision', { exact: true }).selectOption('merchant');
    await page.getByRole('button', { name: 'Decide and close' }).click();
    await expect(fact(page, 'dispute-state-fact')).toHaveText('Closed');
    await expect(fact(page, 'dispute-loss')).toHaveText(
      'The programme (INTAFACED), under the partner’s terms: TEST terms: the programme bears card fraud and lost chargebacks',
    );
    const a = await disputeRead(cases.a);
    expect(a.decision).toMatchObject({
      outcome: 'merchant',
      lossStatus: 'reported',
      lossBearer: 'programme',
      lossTerms: 'TEST terms: the programme bears card fraud and lost chargebacks',
      creditSettlement: 'reversed',
    });
    expect(a.decision.creditSettlementPartnerRef).toMatch(/^TEST-card-sim-reversed-[0-9a-f]{16}$/);
    await expect(fact(page, 'dispute-credit-settlement')).toHaveText(
      `Reversed by the partner, reference ${a.decision.creditSettlementPartnerRef}`,
    );
    // The decision is recorded once: the same decision again returns the case, a different one refuses.
    const other = await bankOps('mutate', 'ops.cardDisputeDecide', { disputeId: cases.a, outcome: 'cardholder' });
    expect(other.text).toContain('bank.card_dispute_state');
    // Case B, closed before the restart, keeps the "not known" it was decided under: a later answer does not rewrite it.
    expect((await disputeRead(cases.b)).decision).toMatchObject({ lossStatus: 'not_known', lossBearer: null });
    await page.context().close();
  } finally {
    restartBank({ LOCAL_STACK_BANK_CARD_PARTNER: undefined, LOCAL_STACK_BANK_CARD_DISPUTE_CAP: undefined });
  }
});
