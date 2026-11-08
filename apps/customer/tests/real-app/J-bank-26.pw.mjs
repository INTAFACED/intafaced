// World: restart
import { randomUUID } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, fund, json, tool } from './stack.mjs';
import { signUp, verify } from './desk.mjs';

// J-bank-26, in the running app (docs/roadmap/journeys.json): I run the card programme (support and finance), on the founder
// console's bank desk. The card programme and its money are the partner's (OWNER 226); no partner is named, so the stack
// runs the TEST partner card adapter (card-sim) with its switches from the bank profile (BANK_CARD_SIM_PARTNER_JSON,
// CUSTODY-DELTA §4). Step 6 (BK-cops-05), opening programme funding. A TEST cardholder's USDC card first gets one open hold
// of 5 and one capture of 20 (through the bank's ops door, approved by two founders, as the simulator's stand-in needs),
// so the app's own figure for USDC moves by a known 25. The profile's TEST partner has said nothing about the funder, the
// reserve, its programme figures, the funding stablecoin or what funding it offers: each reads "not known", never zero, and
// so does the reconciliation's partner figure and difference, and fund, defund and auto reload are switched off with that
// reason. For one restart (LOCAL_STACK_BANK_CARD_PARTNER=reported) the same partner reports TEST answers: the funder and
// reserve; its figures for USDC (5 held, 20 captured) and BTC (0.0005 captured, which the app has no record of); USDC as
// the funding stablecoin; fund and defund offered and auto reload not. The desk reconciles each row (the difference is the
// partner's minus the app's, "matches" or "break"), converts each into USDC at the rate source's rate and time, and two
// founders send one Fund instruction, which the partner answers with a TEST reference and nothing posts. Steps 1 to 5, 7
// and 8 are not built yet.
const J = 'J-bank-26';

/** The bank restarted with one LOCAL_STACK_ switch set for that restart only (unset puts the profile's TEST value back). */
function restartBank(key, value) {
  const before = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    tool('local-test-stack.mjs', 'restart', 'bank');
  } finally {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
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
/** svc-bank's programme funding read, as founder A's session sees it. */
async function fundingRead() {
  const { ctx, sessions } = await founders();
  const res = await ctx.edge.query('bank', 'ops.cardProgrammeFunding', undefined, await sessions.a.treasuryToken());
  expect(res.status, res.text.slice(0, 300)).toBe(200);
  return res.json.result.data;
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
  return (procedure, input) =>
    fetch(`${EDGE}/api/bank/trpc/${procedure}`, {
      method: 'POST',
      headers: { origin: ORIGIN, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }).then(json);
}

async function desk(browser, key = 'a') {
  const context = await browser.newContext({ baseURL: ADMIN, viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await founderSignIn(page, key);
  await page.goto('/bank-ops');
  return page;
}
const terms = (page) => page.getByTestId('read-bank.card-partner-terms');
const fact = (page, read, label) =>
  page
    .getByTestId(`read-${read}`)
    .locator('.dk-kv-row')
    .filter({ has: page.getByText(label, { exact: true }) })
    .locator('dd');
/** A list read's rows as the screen shows them, each keyed by its column heading. */
async function shownRows(page, read) {
  const list = page.getByTestId(`read-${read}`);
  await expect(list.locator('tbody tr').first()).toBeVisible({ timeout: 30_000 });
  return list.evaluate((el) => {
    const heads = [...el.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    return [...el.querySelectorAll('tbody tr')]
      .filter((tr) => !tr.querySelector('td[colspan]'))
      .map((tr) => Object.fromEntries([...tr.querySelectorAll('td')].map((td, i) => [heads[i], td.textContent.trim()])));
  });
}
const SCALE = 10n ** 18n;
const units = (d) => {
  const negative = d.startsWith('-');
  const [whole, frac = ''] = (negative ? d.slice(1) : d).split('.');
  const v = BigInt(whole) * SCALE + BigInt((frac + '0'.repeat(18)).slice(0, 18));
  return negative ? -v : v;
};
const decimal = (v) => {
  const negative = v < 0n;
  const a = negative ? -v : v;
  const frac = (a % SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${a / SCALE}${frac ? `.${frac}` : ''}`;
};
/** The reconciliation holds on every row: the difference is the partner's figure minus the app's, and the word follows it. */
function expectReconciled(row) {
  if (row['Partner’s figure'] === 'not known') {
    expect(row).toMatchObject({ Difference: 'not known', Reconciliation: 'not known' });
    return;
  }
  const difference = units(row['Partner’s figure']) - units(row['Held plus captured (app)']);
  expect(row.Difference).toBe(decimal(difference));
  expect(row.Reconciliation).toBe(difference === 0n ? 'matches' : 'break');
}

test(`${J} #6 opens programme funding: who funds the programme and any reserve the partner requires, or "not known", never shown as zero; the settlement reconciliation against the partner's figures and the stablecoin conversion shown; fund, defund and auto reload where the partner offers them`, async ({
  browser,
}) => {
  test.setTimeout(600_000);
  // A TEST cardholder with a USDC card: one hold of 5 left open, one of 25 captured at 20 (its 5 remainder returned).
  const customer = await (await browser.newContext({ baseURL: ORIGIN })).newPage();
  const who = await signUp(customer, 'jb26');
  await verify(customer, who);
  expect(fund(who.email, 'USDC', '100').tx).toBeTruthy();
  const issued = await (await customerBank(who))('cards.issue', { cardId: randomUUID(), assetId: 'USDC', perAuthorizationLimit: '50' });
  const cardId = issued?.result?.data?.id;
  expect(cardId, JSON.stringify(issued).slice(0, 300)).toBeTruthy();
  await customer.context().close();
  const before = (await fundingRead()).rows.find((r) => r.assetId === 'USDC') ?? { appHeld: '0', appCaptured: '0', appFigure: '0' };
  await cardEvent('bank.card_authorize', 'ops.cardAuthorize', { cardId, authorizationRef: `jb26-open-${randomUUID()}`, amount: '5' });
  const captureRef = `jb26-cap-${randomUUID()}`;
  await cardEvent('bank.card_authorize', 'ops.cardAuthorize', { cardId, authorizationRef: captureRef, amount: '25' });
  await cardEvent('bank.card_capture', 'ops.cardCapture', { cardId, authorizationRef: captureRef, amount: '20' });
  const after = (await fundingRead()).rows.find((r) => r.assetId === 'USDC');
  // The app's own figure moved by exactly what happened: 5 more held, 20 more captured.
  expect(units(after.appHeld) - units(before.appHeld)).toBe(units('5'));
  expect(units(after.appCaptured) - units(before.appCaptured)).toBe(units('20'));
  expect(units(after.appFigure) - units(before.appFigure)).toBe(units('25'));

  // The profile's TEST partner has answered nothing: every partner answer reads "not known", and no figure stands in.
  let page = await desk(browser);
  await expect(terms(page)).toBeVisible();
  await expect(fact(page, 'bank.card-partner-terms', 'Card partner')).toHaveText('TEST partner card adapter');
  await expect(fact(page, 'bank.card-partner-terms', 'Who funds the programme')).toHaveText('not known');
  await expect(fact(page, 'bank.card-partner-terms', 'Reserve the partner requires')).toHaveText('not known');
  await expect(fact(page, 'bank.card-partner-terms', 'Reserve the partner requires')).not.toContainText(/\d/);
  await expect(fact(page, 'bank.card-funding-offers', 'Funding stablecoin')).toHaveText('not known');
  for (const label of ['Fund', 'Defund', 'Auto reload']) {
    await expect(fact(page, 'bank.card-funding-offers', label)).toHaveText('not known');
  }
  const silentRow = (await shownRows(page, 'bank.card-funding-reconciliation')).find((r) => r.Asset === 'USDC');
  expect(silentRow).toMatchObject({
    'Open holds (app)': after.appHeld,
    'Captured (app)': after.appCaptured,
    'Held plus captured (app)': after.appFigure,
    'Partner’s figure': 'not known',
    Difference: 'not known',
    Reconciliation: 'not known',
    // No funding stablecoin reported, so no conversion: "not known", never 0.
    'Rate in the funding stablecoin': 'not known',
    'App figure in the funding stablecoin': 'not known',
  });
  const action = page.getByTestId('card-funding-action');
  for (const [id, label] of [
    ['fund', 'Fund'],
    ['defund', 'Defund'],
    ['autoReload', 'Auto reload'],
  ]) {
    await expect(action.getByTestId(`card-funding-${id}`).getByRole('button', { name: label, exact: true })).toBeDisabled();
    await expect(action.getByTestId(`card-funding-${id}`)).toContainText('Not known: the partner has not said whether it offers this.');
  }
  await page.context().close();

  // The same partner reporting its answers, for one restart.
  restartBank('LOCAL_STACK_BANK_CARD_PARTNER', 'reported');
  try {
    page = await desk(browser);
    await expect(fact(page, 'bank.card-partner-terms', 'Who funds the programme')).toHaveText('TEST: the programme pre-funds in USDC');
    await expect(fact(page, 'bank.card-partner-terms', 'Reserve the partner requires')).toHaveText('25000.00 USDC, as the partner reports');
    await expect(fact(page, 'bank.card-funding-offers', 'Funding stablecoin')).toHaveText('USDC');
    await expect(fact(page, 'bank.card-funding-offers', 'Fund')).toHaveText('offered by the partner');
    await expect(fact(page, 'bank.card-funding-offers', 'Defund')).toHaveText('offered by the partner');
    await expect(fact(page, 'bank.card-funding-offers', 'Auto reload')).toHaveText('not offered by the partner');

    // The settlement reconciliation against the partner's figures: each row's difference is the partner's minus the app's.
    const read = await fundingRead();
    const rows = await shownRows(page, 'bank.card-funding-reconciliation');
    for (const row of rows) expectReconciled(row);
    const usdc = rows.find((r) => r.Asset === 'USDC');
    const btc = rows.find((r) => r.Asset === 'BTC');
    expect(usdc['Partner’s figure']).toBe('25');
    expect(usdc['Held plus captured (app)']).toBe(read.rows.find((r) => r.assetId === 'USDC').appFigure);
    // A BTC capture the partner reports and the app has no record of: a break, never folded into a match.
    expect(btc).toMatchObject({ 'Partner’s figure': '0.0005', Reconciliation: 'break' });
    // The stablecoin conversion into USDC: USDC itself at 1, BTC at the TEST ticker's rate with its time.
    expect(usdc['Rate in the funding stablecoin']).toBe('1');
    expect(usdc['App figure in the funding stablecoin']).toBe(usdc['Held plus captured (app)']);
    const btcRead = read.rows.find((r) => r.assetId === 'BTC');
    expect(btcRead.fundingRate).toMatch(/^\d+(\.\d+)?$/);
    expect(units(btcRead.fundingRate)).toBeGreaterThan(0n);
    expect(Date.parse(btcRead.fundingRateAsOf)).toBeGreaterThan(Date.now() - 10 * 60_000);
    expect(btc['Rate in the funding stablecoin']).toMatch(/^\d+(\.\d+)?$/);
    expect(btc['App figure in the funding stablecoin']).toMatch(/^\d+(\.\d+)?$/);

    // Fund and defund where the partner offers them; auto reload, which it does not, is switched off and says so.
    const action = page.getByTestId('card-funding-action');
    await expect(action.getByTestId('card-funding-fund').getByRole('button', { name: 'Fund', exact: true })).toBeEnabled();
    await expect(action.getByTestId('card-funding-defund').getByRole('button', { name: 'Defund', exact: true })).toBeEnabled();
    await expect(action.getByTestId('card-funding-autoReload').getByRole('button', { name: 'Auto reload', exact: true })).toBeDisabled();
    await expect(action.getByTestId('card-funding-autoReload')).toContainText('Not offered by the partner.');

    // Founder A asks to fund 1000 USDC; founder B approves that exact request on their own console; A runs it once.
    const amount = `${1000 + Math.floor(Math.random() * 1000)}`;
    const phrase = `FUND CARD PROGRAMME ${amount}`;
    await action.getByRole('button', { name: 'Fund', exact: true }).click();
    await action.getByLabel('Amount of the funding stablecoin').fill(amount);
    await action.getByLabel(/^Why \(kept with the instruction/).fill('LOCAL TEST programme top up for the month');
    await action.getByLabel(/to confirm$/).fill(phrase);
    await action.getByRole('button', { name: 'Ask the other founder to approve: fund the programme' }).click();
    await expect(action.getByTestId('packet-made')).toBeVisible({ timeout: 60_000 });
    const packet = (await action.getByLabel('Request packet').inputValue()).trim();
    const pageB = await desk(browser, 'b');
    const actionB = pageB.getByTestId('card-funding-action');
    await actionB.getByRole('button', { name: 'Fund', exact: true }).click();
    await actionB.getByLabel('Request packet').fill(packet);
    await actionB.getByLabel(/to approve or run it$/).fill(phrase);
    await actionB.getByRole('button', { name: 'Approve this request' }).click();
    await expect(actionB.getByTestId('step-reply')).toContainText('Approved.');
    await pageB.context().close();
    await action.getByLabel(/to approve or run it$/).fill(phrase);
    await action.getByRole('button', { name: 'Run the approved request' }).click();
    await expect(action.getByTestId('step-reply')).toContainText('the card partner took the instruction, reference TEST-card-sim-', {
      timeout: 60_000,
    });
    const sent = (await fundingRead()).requests.find((r) => r.amount === amount);
    expect(sent).toMatchObject({ kind: 'fund', assetId: 'USDC', threshold: null });
    expect(sent.partnerRef).toMatch(/^TEST-card-sim-[0-9a-f]{16}$/);
    await page.reload();
    const shown = (await shownRows(page, 'bank.card-funding-requests')).find((r) => r.Amount === amount);
    expect(shown).toMatchObject({ Instruction: 'Fund', Stablecoin: 'USDC', 'Partner reference': sent.partnerRef });
    // Nothing posted: the USDC app figures are the cardholder's holds and captures, unchanged by the instruction.
    expect((await fundingRead()).rows.find((r) => r.assetId === 'USDC').appFigure).toBe(
      read.rows.find((r) => r.assetId === 'USDC').appFigure,
    );
    await page.context().close();
  } finally {
    restartBank('LOCAL_STACK_BANK_CARD_PARTNER', undefined);
  }
});
