// World: restart
import { randomUUID } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, fund, journeyState, json, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-bank-29, in the running app (docs/roadmap/journeys.json): I pay by card from my crypto and stablecoins, converted at
// checkout. The card and its money are the partner's (OWNER 226); no partner is named, so the stack runs the TEST partner
// card adapter (card-sim, no issuer, no network) with its switches from the bank profile (BANK_CARD_SIM_PARTNER_JSON,
// CUSTODY-DELTA §4): the stand-in partner spends from USDC, BTC and USD, reports TEST 30 USDC, 0.01 BTC and 50 USD
// spendable, and quotes its own TEST rates in USDC (1 BTC is 50000 USDC, 1 USD is 1 USDC, USDC in itself is 1), each
// stamped with its clock at the read. The owner's TEST spendable-asset list is USDC, BTC, USD (BANK_CARD_SPEND_ASSETS).
// One TEST account, verified and funded with TEST USDT, holds one TEST card drawing on USDT (an asset the partner cannot
// spend from) and settling in USDC.
//   #1 (BK-ccrypto-01): the owner's list switched off for one restart refuses Pay from by name; no order can be saved.
//   #2: Pay from lists what the partner can spend from, each with the partner's balance, its quoted rate labelled an
//       estimate and the rate's time, and "not offered by the partner" for the rest; the person orders USDC, BTC, USD and
//       the saved order reads back; the trading account and agent accounts read "not used for card payments". In both of
//       the partner's modes (one restart with LOCAL_STACK_BANK_CARD_PARTNER=wallet_pull), then a partner spending only USDC
//       and USD (=narrow) and a partner reporting nothing (=off).
//   #3 to #7 (BK-ccrypto-02, -03): the person's TEST partner switch `custody: 'off'` puts the card's payments at the TEST
//       card partner. Each TEST merchant charge is the issuer's message through the bank's four-eyes ops door, approved by
//       the stack's two TEST founders (the card-sim network call). The partner walks the saved order and holds from the
//       first asset that covers the charge, at its rate; capture, the returned remainder and the TEST merchant's refund
//       (`testPartner.cardRefund`, sent twice as a network repeat) move only at the partner, and the ledger posts nothing.
//   #8: a founder opens the cards desk (/bank-ops): the pay-from reconciliation reads each USDC and BTC line "matches"
//       against the partner's own report of each hold; after a bank restart (the TEST partner forgets its holds) each of
//       this person's payments is its own break row.
const J = 'J-bank-29';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

function person() {
  const { who } = run.read();
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

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

/** The person's own svc-bank API through Edge, with a session of its own (not the browser's). */
async function bank(who = person()) {
  const { status, body: login } = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password }),
  }).then(json);
  const token = login?.result?.data?.accessToken;
  if (!token) throw new Error(`sign-in for ${who.email} refused: ${status} ${JSON.stringify(login).slice(0, 300)}`);
  const headers = { origin: ORIGIN, authorization: `Bearer ${token}` };
  const answer = async (res) => {
    const body = await res.json();
    if (!res.ok) return { ok: false, status: res.status, code: body?.error?.data?.intafacedCode ?? body?.error?.data?.code, body };
    return { ok: true, data: body.result.data };
  };
  return {
    query: (procedure) => fetch(`${EDGE}/api/bank/trpc/${procedure}`, { headers }).then(answer),
    mutate: (procedure, input) =>
      fetch(`${EDGE}/api/bank/trpc/${procedure}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }).then(answer),
  };
}

const payFrom = (page) => page.getByTestId('card-pay-from');
/** A decimal string in 18-place units, so two rates compare without a JS number. */
const units = (d) => {
  const [whole, frac = ''] = String(d).split('.');
  return BigInt(whole) * 10n ** 18n + BigInt((frac + '0'.repeat(18)).slice(0, 18));
};
const assetRow = (page, assetId) => page.getByTestId(`card-pay-from-${assetId}`);

test(`${J} #1 with the owner's spendable-asset list switched off for one restart, opens Pay from: refused bank.card_spend_assets_unset; no order can be saved`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const who = await signUp(page, 'jb29');
  await verify(page, who);
  expect(fund(who.email, 'USDT', '100').tx).toBeTruthy();
  run.reset({ who });
  // One TEST card on the TEST partner card adapter, drawing on USDT and settling in USDC (the stack's TEST settlement asset).
  const issued = await (
    await bank()
  ).mutate('cards.issue', {
    cardId: randomUUID(),
    assetId: 'USDT',
    settlementAssetId: 'USDC',
    // Above every charge this journey makes, so #5's decline is the partner's, never the card's own limit.
    perAuthorizationLimit: '1000',
  });
  expect(issued.ok, JSON.stringify(issued.body ?? {}).slice(0, 300)).toBe(true);
  expect(issued.data).toMatchObject({ simulated: true, issuer: 'card-sim', assetId: 'USDT' });
  run.write({ card: issued.data.id });

  restartBank('LOCAL_STACK_BANK_CARD_SPEND_ASSETS', 'off');
  try {
    // svc-bank names its refusal in the message (router/errors.ts: the wire carries the message, not the cause).
    const refused = await (await bank()).query('cards.payFrom');
    expect(refused).toMatchObject({ ok: false, status: 412 });
    expect(refused.body?.error?.message).toContain('bank.card_spend_assets_unset');
    await signIn(page, who);
    await page.goto('/bank/cards');
    const panel = payFrom(page);
    await expect(panel.getByRole('alert')).toContainText('The list of assets a card may pay from is not published');
    await expect(panel.getByRole('alert')).toContainText('bank.card_spend_assets_unset');
    // Nothing to order: no asset row and no order form while the list is unset.
    await expect(panel.locator('[data-testid^="card-pay-from-"][data-state]')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Save order' })).toHaveCount(0);
    // And the bank saves none: an order sent anyway refuses by name, and Pay from still has none saved once the list is back.
    const saved = await (await bank()).mutate('cards.setPayFromOrder', { assetIds: ['USDC', 'BTC', 'USD'] });
    expect(saved).toMatchObject({ ok: false, status: 412 });
    expect(saved.body?.error?.message).toContain('bank.card_spend_assets_unset');
  } finally {
    restartBank('LOCAL_STACK_BANK_CARD_SPEND_ASSETS', undefined);
  }
  const after = await (await bank()).query('cards.payFrom');
  expect(after.ok, JSON.stringify(after.body ?? {}).slice(0, 300)).toBe(true);
  expect(after.data.order).toBeNull();
});

test(`${J} #2 with the TEST list back, opens Pay from and orders USDC, then BTC, then USD: the assets the partner can spend from, each with its partner balance, the partner's quoted rate labelled an estimate, and the rate's time, and "not offered by the partner" for any other; the saved order reads USDC, BTC, USD; the trading account and any agent account are listed as "not used for card payments"; in both modes`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const who = person();
  await signIn(page, who);

  // Mode one: the partner holds the crypto it spends.
  const held = await (await bank()).query('cards.payFrom');
  expect(held.ok, JSON.stringify(held.body ?? {}).slice(0, 300)).toBe(true);
  expect(held.data.custodyMode).toBe('partner_holds');
  expect(held.data.assets.map((a) => [a.assetId, a.state])).toEqual([
    ['USDC', 'offered'],
    ['BTC', 'offered'],
    ['USD', 'offered'],
    ['USDT', 'not_offered'],
  ]);
  await page.goto('/bank/cards');
  const panel = payFrom(page);
  await expect(panel).toHaveAttribute('data-mode', 'partner_holds');
  await expect(panel).toContainText('TEST card partner');
  await expect(page.getByTestId('card-pay-from-mode')).toContainText('The partner holds the crypto it spends');
  for (const asset of ['USDC', 'BTC', 'USD']) {
    await expect(assetRow(page, asset)).toHaveAttribute('data-state', 'offered');
    await expect(assetRow(page, asset)).toContainText('offered by the partner');
    await expect(assetRow(page, asset)).not.toContainText('not offered');
  }
  // The person's USDT card draws on an asset the partner cannot spend from.
  await expect(assetRow(page, 'USDT')).toHaveAttribute('data-state', 'not_offered');
  await expect(assetRow(page, 'USDT')).toContainText('not offered by the partner');

  // Each asset the partner can spend from, with the balance the partner reports: TEST 30 USDC, 0.01 BTC and 50 USD.
  const balances = { USDC: '30', BTC: '0.01', USD: '50' };
  for (const [asset, amount] of Object.entries(balances)) {
    expect(held.data.assets.find((a) => a.assetId === asset)?.partnerBalance).toBe(amount);
    await expect(page.getByTestId(`card-pay-from-${asset}-balance`)).toHaveText(`${amount} ${asset}`);
  }
  // None for the asset the partner cannot spend from.
  await expect(page.getByTestId('card-pay-from-USDT-balance')).toHaveText('');
  expect(held.data.settlementAssetId).toBe('USDC');

  // The partner's quoted rate of each, in the card's settlement asset (USDC), and the quote's time: the TEST partner's own
  // TEST rates, stamped with its clock at the read, so each time falls inside the read that asked for it.
  const askedAt = Date.now();
  const rated = await (await bank()).query('cards.payFrom');
  const answeredAt = Date.now();
  expect(rated.ok, JSON.stringify(rated.body ?? {}).slice(0, 300)).toBe(true);
  const quotes = { USDC: '1', BTC: '50000', USD: '1' };
  for (const [asset, rate] of Object.entries(quotes)) {
    const row = rated.data.assets.find((a) => a.assetId === asset);
    expect(row.rate).toBe(rate);
    expect(Date.parse(row.rateAsOf)).toBeGreaterThanOrEqual(askedAt - 2_000);
    expect(Date.parse(row.rateAsOf)).toBeLessThanOrEqual(answeredAt + 2_000);
  }
  // The asset the partner cannot spend from has no rate.
  expect(rated.data.assets.find((a) => a.assetId === 'USDT')).toMatchObject({ rate: null, rateAsOf: null });
  const reloadedAt = Date.now();
  await page.reload();
  for (const [asset, rate] of Object.entries(quotes)) {
    // Each quote labelled an estimate: the partner's rate binds only once it holds a payment.
    await expect(page.getByTestId(`card-pay-from-${asset}-rate`)).toHaveText(`${rate} USDC (estimate)`);
    await expect(page.getByTestId(`card-pay-from-${asset}-rate-estimate`)).toHaveText('(estimate)');
    const shownAt = Date.parse(await page.getByTestId(`card-pay-from-${asset}-rate-time`).locator('time').getAttribute('datetime'));
    expect(shownAt).toBeGreaterThanOrEqual(reloadedAt - 2_000);
    expect(shownAt).toBeLessThanOrEqual(Date.now() + 2_000);
  }
  await expect(page.getByTestId('card-pay-from-estimate')).toContainText(
    'A quoted rate is an estimate until the card partner holds a payment',
  );
  await expect(page.getByTestId('card-pay-from-USDT-rate')).toHaveText('');

  // The person orders USDC, then BTC, then USD: nothing is saved yet; moved BTC first and back, then saved.
  await expect(page.getByTestId('card-pay-from-saved')).toHaveText('Saved order: No order saved');
  const order = page.getByTestId('card-pay-from-order');
  await page.getByRole('button', { name: 'Move BTC up' }).click();
  await expect(order.locator('li')).toHaveText([/^BTC/, /^USDC/, /^USD\b/]);
  await page.getByRole('button', { name: 'Move BTC down' }).click();
  await expect(order.locator('li')).toHaveText([/^USDC/, /^BTC/, /^USD\b/]);
  await page.getByRole('button', { name: 'Save order' }).click();
  await expect(page.getByTestId('card-pay-from-saved')).toHaveText('Saved order: USDC, BTC, USD');
  const ordered = await (await bank()).query('cards.payFrom');
  expect(ordered.data.order).toEqual(['USDC', 'BTC', 'USD']);
  await page.reload();
  await expect(page.getByTestId('card-pay-from-saved')).toHaveText('Saved order: USDC, BTC, USD');
  // An asset the partner cannot spend from is refused by name and the saved order stays.
  const refused = await (await bank()).mutate('cards.setPayFromOrder', { assetIds: ['USDT', 'USDC'] });
  expect(refused).toMatchObject({ ok: false, status: 412 });
  expect(refused.body?.error?.message).toContain('bank.card_pay_from_not_offered');
  expect((await (await bank()).query('cards.payFrom')).data.order).toEqual(['USDC', 'BTC', 'USD']);

  // The trading account and any agent account never fund a card.
  expect(held.data.notUsedForCards).toEqual(['trading', 'agent']);
  const notUsed = page.getByTestId('card-pay-from-not-used');
  await expect(notUsed.locator('[data-kind="trading"]')).toHaveText('Trading account: not used for card payments');
  await expect(notUsed.locator('[data-kind="agent"]')).toHaveText('Agent accounts: not used for card payments');

  // Mode two, for one restart: the card pulls from the person's own wallet. The same list, read again from the partner.
  restartBank('LOCAL_STACK_BANK_CARD_PARTNER', 'wallet_pull');
  try {
    const pulled = await (await bank()).query('cards.payFrom');
    expect(pulled.ok, JSON.stringify(pulled.body ?? {}).slice(0, 300)).toBe(true);
    expect(pulled.data.custodyMode).toBe('wallet_pull');
    await signIn(page, who);
    await page.goto('/bank/cards');
    await expect(payFrom(page)).toHaveAttribute('data-mode', 'wallet_pull');
    await expect(page.getByTestId('card-pay-from-mode')).toContainText('The card pulls from your own wallet');
    await expect(assetRow(page, 'USDC')).toHaveAttribute('data-state', 'offered');
    await expect(assetRow(page, 'USDT')).toContainText('not offered by the partner');
    // The same partner balances and the same saved order in this mode.
    for (const [asset, amount] of Object.entries(balances)) {
      await expect(page.getByTestId(`card-pay-from-${asset}-balance`)).toHaveText(`${amount} ${asset}`);
    }
    await expect(page.getByTestId('card-pay-from-BTC-rate')).toHaveText('50000 USDC (estimate)');
    await expect(page.getByTestId('card-pay-from-saved')).toHaveText('Saved order: USDC, BTC, USD');
    await expect(page.getByTestId('card-pay-from-not-used').locator('[data-kind="trading"]')).toHaveText(
      'Trading account: not used for card payments',
    );
  } finally {
    restartBank('LOCAL_STACK_BANK_CARD_PARTNER', undefined);
  }

  // The partner's list, not the owner's, decides: a partner that spends only USDC and USD reads BTC (on the owner's list)
  // "not offered by the partner".
  restartBank('LOCAL_STACK_BANK_CARD_PARTNER', 'narrow');
  try {
    const narrow = await (await bank()).query('cards.payFrom');
    expect(narrow.ok, JSON.stringify(narrow.body ?? {}).slice(0, 300)).toBe(true);
    expect(narrow.data.assets.map((a) => [a.assetId, a.state])).toEqual([
      ['USDC', 'offered'],
      ['BTC', 'not_offered'],
      ['USD', 'offered'],
      ['USDT', 'not_offered'],
    ]);
    await signIn(page, who);
    await page.goto('/bank/cards');
    await expect(assetRow(page, 'BTC')).toHaveAttribute('data-state', 'not_offered');
    await expect(assetRow(page, 'BTC')).toContainText('not offered by the partner');
    await expect(assetRow(page, 'USDC')).toHaveAttribute('data-state', 'offered');
    // The saved order still names BTC, and says the partner no longer spends from it rather than reading it as usable.
    await expect(page.getByTestId('card-pay-from-saved')).toHaveText('Saved order: USDC, BTC (not offered by the partner), USD');
  } finally {
    restartBank('LOCAL_STACK_BANK_CARD_PARTNER', undefined);
  }

  // A partner that reports nothing: how it spends and what it spends from are "not known", never guessed as offered.
  restartBank('LOCAL_STACK_BANK_CARD_PARTNER', 'off');
  try {
    const silent = await (await bank()).query('cards.payFrom');
    expect(silent.ok, JSON.stringify(silent.body ?? {}).slice(0, 300)).toBe(true);
    expect(silent.data.custodyMode).toBeNull();
    await signIn(page, who);
    await page.goto('/bank/cards');
    await expect(payFrom(page)).toHaveAttribute('data-mode', 'not_known');
    await expect(page.getByTestId('card-pay-from-mode')).toContainText('not known');
    for (const asset of ['USDC', 'BTC', 'USD']) {
      await expect(assetRow(page, asset)).toHaveAttribute('data-state', 'not_known');
      await expect(assetRow(page, asset)).toContainText('not known');
      await expect(assetRow(page, asset)).not.toContainText('offered');
      // Nothing the partner did not report is shown as a figure.
      await expect(page.getByTestId(`card-pay-from-${asset}-balance`)).not.toContainText(/\d/);
      expect(silent.data.assets.find((a) => a.assetId === asset)).toMatchObject({ partnerBalance: null, rate: null });
    }
  } finally {
    restartBank('LOCAL_STACK_BANK_CARD_PARTNER', undefined);
  }
});

// ── #3 to #8: payments by the pay-from order, at the TEST card partner ──────────────────────────────────────────────

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

const cardOf = () => {
  const { card } = run.read();
  if (!card) throw new Error(`${J} #1 issued no card, so this step has no card to pay with`);
  return card;
};
/** A TEST merchant's charge in USDC, as the card network's message reaches the bank (the card-sim network call). */
async function charge(amount, merchant) {
  const ref = `jb29-${randomUUID()}`;
  const decided = await cardEvent('bank.card_authorize', 'ops.cardAuthorize', {
    cardId: cardOf(),
    authorizationRef: ref,
    amount,
    merchant,
  });
  return { ...decided, ref };
}
/** The card's decisions, as svc-bank holds them. */
async function feedRow(ref) {
  const res = await (
    await bank()
  ).query(`cards.authorizations?input=${encodeURIComponent(JSON.stringify({ cardId: cardOf(), limit: 50 }))}`);
  expect(res.ok, JSON.stringify(res.body ?? {}).slice(0, 300)).toBe(true);
  const row = res.data.find((r) => r.authorizationRef === ref);
  expect(row, `${ref} is not in the card's feed`).toBeTruthy();
  return row;
}
/** What the partner reports spendable per asset, through Pay from. */
async function spendable() {
  const res = await (await bank()).query('cards.payFrom');
  expect(res.ok, JSON.stringify(res.body ?? {}).slice(0, 300)).toBe(true);
  return Object.fromEntries(res.data.assets.filter((a) => a.state === 'offered').map((a) => [a.assetId, a.partnerBalance]));
}
/** Each of this card's holds as the partner reports it now. */
async function partnerHolds() {
  const res = await (await bank()).query(`cards.partnerHeld?input=${encodeURIComponent(JSON.stringify({ cardId: cardOf(), limit: 50 }))}`);
  expect(res.ok, JSON.stringify(res.body ?? {}).slice(0, 300)).toBe(true);
  return res.data;
}
const holdOf = async (ref) => (await partnerHolds()).authorizations.find((a) => a.authorizationRef === ref)?.report ?? null;

/** /bank/cards with this card's decisions open. */
async function openFeed(page) {
  await signIn(page, person());
  await page.goto('/bank/cards');
  const card = cardOf();
  const here = page.locator(`[data-card="${card}"]`);
  const inspect = page.getByRole('button', { name: `Inspect decisions for card ${card}` });
  const decisions = page.getByRole('region', { name: 'Card decisions', exact: true });
  await expect(decisions.or(inspect).first()).toBeVisible();
  if (await inspect.isVisible()) await inspect.click();
  await expect(decisions).toBeVisible();
  return { here, decision: (ref) => decisions.getByRole('listitem').filter({ hasText: ref }) };
}
const quantity = (amount, asset) => new RegExp(`^${amount.replace('.', '\\.')}\\s*${asset}$`);

test(`${J} #3 a TEST merchant charges 25.00 (card-sim network call): approved; the feed row reads "Paid from USDC" with the USDC the partner held, the rate and its time; USDC available falls by exactly the held amount, as the partner reports`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const client = await bank();
  // This person's card money at the TEST card partner (OWNER 226): it holds, and the ledger posts nothing.
  const switched = await client.mutate('testPartner.set', { custody: 'off', cardDecline: 'none' });
  expect(switched, JSON.stringify(switched.body ?? {}).slice(0, 300)).toMatchObject({ ok: true, data: { custody: 'off' } });
  const before = await spendable();
  expect(before).toEqual({ USDC: '30', BTC: '0.01', USD: '50' });

  const paid = await charge('25', 'TEST Shop');
  expect(paid).toMatchObject({ decision: 'approved', amount: '25' });
  run.write({ first: paid.ref });
  const row = await feedRow(paid.ref);
  expect(row).toMatchObject({
    decision: 'approved',
    status: 'settled',
    heldBy: 'partner',
    amount: '25',
    payFrom: { order: ['USDC', 'BTC', 'USD'], assetId: 'USDC' },
  });
  expect(row.conversion).toMatchObject({ settlementAssetId: 'USDC', settlementAmount: '25', rate: '1', rateQuality: 'partner' });
  // The hold, its rate and the rate's time are the partner's own, read back.
  const hold = await holdOf(paid.ref);
  expect(hold).toMatchObject({ assetId: 'USDC', amount: '25', status: 'held', conversion: { rate: '1', settlementAmount: '25' } });
  expect(hold.conversion.rateAsOf).toBe(row.conversion.rateAsOf);
  // USDC available falls by exactly the 25 the partner held; nothing else moves.
  expect(await spendable()).toEqual({ USDC: '5', BTC: '0.01', USD: '50' });

  const { here, decision } = await openFeed(page);
  const shown = decision(paid.ref);
  await expect(shown.getByTestId('card-paid-from-asset')).toHaveText('Paid from USDC');
  await expect(shown.getByTestId('card-paid-from-held')).toHaveText(quantity('25', 'USDC'));
  await expect(shown.getByTestId('card-paid-from-rate')).toHaveText('1 USDC / USDC');
  await expect(shown.getByTestId('card-paid-from-rate-time').locator('time')).toHaveAttribute('datetime', row.conversion.rateAsOf);
  await expect(shown.getByTestId('card-paid-from-order')).toHaveText('Your pay-from order: USDC, BTC, USD');
  await expect(page.getByTestId('card-pay-from-USDC-balance')).toHaveText('5 USDC');
});

test(`${J} #4 a TEST merchant charges 40.00, more than the USDC left: approved from BTC, the next asset in the order: one partner BTC hold, with its rate and the rate's time as the partner reports them; USDC unchanged`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const paid = await charge('40', 'TEST Electronics');
  expect(paid).toMatchObject({ decision: 'approved', amount: '0.0008' });
  run.write({ second: paid.ref });
  const row = await feedRow(paid.ref);
  // 40 USDC at the partner's 50000 USDC for 1 BTC: 0.0008 BTC.
  expect(row).toMatchObject({
    status: 'settled',
    heldBy: 'partner',
    amount: '0.0008',
    payFrom: { order: ['USDC', 'BTC', 'USD'], assetId: 'BTC' },
  });
  expect(row.conversion).toMatchObject({ settlementAssetId: 'USDC', settlementAmount: '40', rate: '50000', rateQuality: 'partner' });
  // One partner hold for this payment, in BTC, at its rate and time.
  const holds = (await partnerHolds()).authorizations.filter((a) => a.authorizationRef === paid.ref);
  expect(holds).toHaveLength(1);
  expect(holds[0].report).toMatchObject({ assetId: 'BTC', amount: '0.0008', status: 'held', conversion: { rate: '50000' } });
  expect(holds[0].report.conversion.rateAsOf).toBe(row.conversion.rateAsOf);
  // USDC unchanged at the 5 #3 left; BTC down by the one hold.
  expect(await spendable()).toEqual({ USDC: '5', BTC: '0.0092', USD: '50' });

  const { decision } = await openFeed(page);
  const shown = decision(paid.ref);
  await expect(shown.getByTestId('card-paid-from-asset')).toHaveText('Paid from BTC');
  await expect(shown.getByTestId('card-paid-from-held')).toHaveText(quantity('0.0008', 'BTC'));
  await expect(shown.getByTestId('card-paid-from-rate')).toHaveText('50,000 USDC / BTC');
  await expect(shown.getByTestId('card-paid-from-rate-time').locator('time')).toHaveAttribute('datetime', row.conversion.rateAsOf);
  await expect(page.getByTestId('card-pay-from-USDC-balance')).toHaveText('5 USDC');
});

test(`${J} #5 a TEST merchant charges more than any one asset covers: declined bank.card_insufficient_funds by the partner, the reason naming the pay-from order; nothing held`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const before = await spendable();
  const heldBefore = (await partnerHolds()).authorizations.length;
  // 500 USDC: more than the 5 USDC left, the 0.0092 BTC (460 USDC) and the 50 USD (50 USDC), each on its own.
  const declined = await charge('500', 'TEST Jeweller');
  expect(declined).toMatchObject({ decision: 'declined', declineCode: 'bank.card_insufficient_funds' });
  const row = await feedRow(declined.ref);
  expect(row).toMatchObject({
    status: 'rejected',
    declineCode: 'bank.card_insufficient_funds',
    payFrom: { order: ['USDC', 'BTC', 'USD'], assetId: null },
  });
  expect(row.conversion).toBeNull();
  // Nothing held: every partner figure is as it was, and no hold was added.
  expect(await spendable()).toEqual(before);
  expect((await partnerHolds()).authorizations).toHaveLength(heldBefore);

  const { decision } = await openFeed(page);
  const shown = decision(declined.ref);
  await expect(shown).toContainText('bank.card_insufficient_funds');
  await expect(shown.getByTestId('decline-reason')).toHaveText(
    'No one asset in your pay-from order covers this payment, as the card partner reports. Add money to one of them, change the order under Pay from, or pay less.',
  );
  await expect(shown.getByTestId('card-paid-from-order')).toHaveText('Your pay-from order: USDC, BTC, USD');
  await expect(shown.getByTestId('card-paid-from-asset')).toHaveCount(0);
});

test(`${J} #6 the first merchant captures 22.00 of its 25.00: the partner settles 22.00 worth of USDC, never more than it held, and returns the rest of the hold to USDC; the feed shows both as the partner reports them`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { first } = run.read();
  if (!first) throw new Error(`${J} #3 made no payment, so this step has nothing to capture`);
  await cardEvent('bank.card_capture', 'ops.cardCapture', { cardId: cardOf(), authorizationRef: first, amount: '22' });
  const row = await feedRow(first);
  expect(row.payFrom).toEqual({ order: ['USDC', 'BTC', 'USD'], assetId: 'USDC', captured: '22', returned: '3' });
  // As the partner reports the hold: 22 captured, 3 given back, nothing still held.
  expect(await holdOf(first)).toMatchObject({ assetId: 'USDC', amount: '25', captured: '22', released: '3', open: '0' });
  // The 3 back in USDC: 5 + 3.
  expect(await spendable()).toEqual({ USDC: '8', BTC: '0.0092', USD: '50' });
  // Never more than it held: a second capture of the same payment is refused, and the figures stay.
  const { gates, ctx, sessions } = await founders();
  const fields = { cardId: cardOf(), authorizationRef: first, amount: '3' };
  const approval = await gates.twoPerson(ctx, sessions, {
    actionType: 'bank.card_capture',
    targetService: 'svc-bank',
    targetId: 'bank.card_capture',
    expectedVersion: '1',
    payloadHash: gates.bankPayloadHash('bank.card_capture', fields),
    policyVersion: gates.MARKERS.policyVersion,
  });
  const again = await ctx.edge.mutate('bank', 'ops.cardCapture', { ...fields, ...approval }, await sessions.a.treasuryToken());
  expect(again.status, again.text.slice(0, 300)).not.toBe(200);
  expect(await spendable()).toEqual({ USDC: '8', BTC: '0.0092', USD: '50' });

  const { decision } = await openFeed(page);
  const shown = decision(first);
  await expect(shown.getByTestId('card-paid-from-settled')).toHaveText(quantity('22', 'USDC'));
  await expect(shown.getByTestId('card-paid-from-returned')).toHaveText(quantity('3', 'USDC'));
  await expect(shown).toContainText('Returned to USDC by the card partner');
});

test(`${J} #7 the merchant refunds 10.00, and the network sends the same refund again: the partner's credit to USDC, read back once, as the partner reports it; the second message changes nothing`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { first } = run.read();
  if (!first) throw new Error(`${J} #3 made no payment, so this step has nothing to refund`);
  const client = await bank();
  const refunded = await client.mutate('testPartner.cardRefund', { cardId: cardOf(), authorizationRef: first, amount: '10' });
  expect(refunded, JSON.stringify(refunded.body ?? {}).slice(0, 300)).toMatchObject({ ok: true, data: { refunded: '10' } });
  expect(await spendable()).toEqual({ USDC: '18', BTC: '0.0092', USD: '50' });
  // The same refund again, as a network repeat: the same credit, nothing more.
  const repeat = await client.mutate('testPartner.cardRefund', { cardId: cardOf(), authorizationRef: first, amount: '10' });
  expect(repeat, JSON.stringify(repeat.body ?? {}).slice(0, 300)).toMatchObject({ ok: true, data: { refunded: '10' } });
  expect(repeat.data.partnerRef).toBe(refunded.data.partnerRef);
  expect(await spendable()).toEqual({ USDC: '18', BTC: '0.0092', USD: '50' });
  expect(await holdOf(first)).toMatchObject({ refunded: '10', captured: '22' });
  expect((await feedRow(first)).refund).toMatchObject({ amount: '10', status: 'settled' });

  const { here } = await openFeed(page);
  const refunds = here.getByRole('region', { name: 'Merchant refunds', exact: true });
  await expect(refunds.getByRole('list', { name: 'Refunds on this card' }).locator(`li[data-authorization="${first}"]`)).toHaveCount(1);
  await expect(refunds.locator(`li[data-authorization="${first}"]`)).toContainText(`10 USDC refunded for ${first} on`);
  await expect(page.getByTestId('card-pay-from-USDC-balance')).toHaveText('18 USDC');
});

/** A list read's rows as the desk shows them, each keyed by its column heading. */
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

test(`${J} #8 a founder opens the cards desk's reconciliation: for USDC and BTC, spend the partner reports against what the app showed the user, and open holds against the partner's, each line reading "matches"; a difference is a break row`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { first, second } = run.read();
  if (!first || !second) throw new Error(`${J} #3 and #4 made no payments, so there is nothing to reconcile`);
  const { ctx, sessions } = await founders();
  const read = async () => {
    const res = await ctx.edge.query('bank', 'ops.cardPayFromReconciliation', undefined, await sessions.a.treasuryToken());
    expect(res.status, res.text.slice(0, 300)).toBe(200);
    return res.json.result.data;
  };
  const view = await read();
  for (const assetId of ['USDC', 'BTC']) {
    for (const kind of ['spend', 'open_holds']) {
      const line = view.lines.find((l) => l.assetId === assetId && l.kind === kind);
      expect(line, `${assetId} ${kind}`).toMatchObject({ status: 'matches' });
      expect(line.app).toBe(line.partner);
    }
  }
  // What this person was shown is inside those lines: 22 captured less 10 refunded in USDC, 0.0008 BTC still held.
  expect(view.breaks.filter((b) => [first, second].includes(b.authorizationRef))).toEqual([]);

  const context = await browser.newContext({ baseURL: ADMIN, viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await founderSignIn(page, 'a');
  await page.goto('/bank-ops');
  const rows = await shownRows(page, 'bank.card-pay-from-reconciliation');
  for (const [asset, line] of [
    ['USDC', 'Spend'],
    ['USDC', 'Open holds'],
    ['BTC', 'Spend'],
    ['BTC', 'Open holds'],
  ]) {
    const shown = rows.find((r) => r.Asset === asset && r.Line === line);
    expect(shown, `${asset} ${line}`).toMatchObject({ Reconciliation: 'matches' });
    expect(shown['This app']).toBe(shown['Card partner']);
  }

  // A difference is a break row: the TEST partner forgets its holds on a restart, so it no longer reports these two
  // payments, and each is named as its own break, never summed into a line.
  restartBank('LOCAL_STACK_BANK_CARD_PARTNER', undefined);
  const after = await read();
  for (const ref of [first, second]) {
    expect(after.breaks.find((b) => b.authorizationRef === ref)).toMatchObject({ reason: 'not_reported', partner: null });
  }
  await page.reload();
  const breaks = await shownRows(page, 'bank.card-pay-from-breaks');
  for (const ref of [first, second]) {
    expect(breaks.find((r) => r.Payment === ref)).toMatchObject({ Break: 'not reported by the partner' });
  }
  await context.close();
});
