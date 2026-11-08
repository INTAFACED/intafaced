// World: market, restart
import { randomUUID } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, api, fund, journeyState, json, tool } from './stack.mjs';
import { HOLD_MAX_MS } from '../../../../tooling/scripts/local-test-market.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-bank-29, in the running app (docs/roadmap/journeys.json): I pay by card from my crypto and stablecoins. The card and its
// money are the partner's (OWNER 226); no partner is named, so the stack runs the TEST partner card adapter (card-sim, no
// issuer, no network) with its switches from the bank profile (BANK_CARD_SIM_PARTNER_JSON, CUSTODY-DELTA §4): the stand-in
// partner spends from USDC, BTC and USD and reports TEST 30 USDC, 0.01 BTC and 50 USD spendable. The owner's TEST
// spendable-asset list is USDC, BTC, USD (BANK_CARD_SPEND_ASSETS). One TEST account, verified and funded with TEST USDT,
// holds one TEST card drawing on USDT (an asset the partner cannot spend from) and settling in USDC, so each rate is one
// unit in USDC from the stack's TEST ticker (svc-trade, BTC/USDC; USDC in itself is 1). Step 1 (BK-ccrypto-01): the
// owner's list switched off for one restart refuses Pay from by name, and no order can be saved. Step 2: Pay from lists
// what the partner can spend from, each with the partner's balance, the rate and its time, and "not offered by the
// partner" for the rest; the person orders USDC, then BTC, then USD, and the saved order reads back; the trading account
// and agent accounts read "not used for card payments". In both of the partner's modes: it holds the crypto, or (one
// restart with LOCAL_STACK_BANK_CARD_PARTNER=wallet_pull) the card pulls from the person's own wallet. Two more restarts
// tell the partner's list from the owner's and show the unknown: a partner spending from USDC and USD only (=narrow) reads
// BTC "not offered by the partner"; a partner reporting nothing (=off) reads its mode, every owner-listed asset and every
// balance "not known". The stack's ticker has no USD market against USDC, so USD's rate reads "not known" (see the PR).
// Steps 3 to 8 (the authorisation path in each mode) are not built yet.
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
    perAuthorizationLimit: '50',
  });
  expect(issued.ok, JSON.stringify(issued.body ?? {}).slice(0, 300)).toBe(true);
  expect(issued.data).toMatchObject({ simulated: true, issuer: 'card-sim', assetId: 'USDT' });

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

test(`${J} #2 with the TEST list back, opens Pay from and orders USDC, then BTC, then USD: the assets the partner can spend from, each with its partner balance, its rate and the rate's time, and "not offered by the partner" for any other; the saved order reads USDC, BTC, USD; the trading account and any agent account are listed as "not used for card payments"; in both modes`, async ({
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

  // The rate of each, in the card's settlement asset (USDC), and the rate's time, from the stack's TEST ticker. BTC/USDC
  // is held for the reading so the screen and the service see one price (local-test-market.mjs hold).
  const heldAt = Date.now();
  tool('local-test-market.mjs', 'hold', 'BTC/USDC');
  const ticker = await api(who);
  let rated;
  await expect(async () => {
    const client = await bank();
    const { body: quote } = await ticker.get('/api/v1/ticker/BTC%2FUSDC');
    const askedAt = Date.now();
    rated = await client.query('cards.payFrom');
    const answeredAt = Date.now();
    expect(rated.ok).toBe(true);
    const btc = rated.data.assets.find((a) => a.assetId === 'BTC');
    // svc-bank's mark is the floor of the ticker's mid (or its last price with no two-sided book), stamped with the time
    // the ticker answered, which falls inside this read.
    const mark = quote.bid && quote.ask ? (units(quote.bid) + units(quote.ask)) / 2n : units(quote.last);
    expect(units(btc.rate)).toBe(mark);
    expect(Date.parse(btc.rateAsOf)).toBeGreaterThanOrEqual(askedAt - 2_000);
    expect(Date.parse(btc.rateAsOf)).toBeLessThanOrEqual(answeredAt + 2_000);
  }).toPass({ timeout: 30_000 });
  const usdc = rated.data.assets.find((a) => a.assetId === 'USDC');
  expect(usdc).toMatchObject({ rate: '1' });
  expect(Date.parse(usdc.rateAsOf)).toBeGreaterThan(heldAt - 60_000);
  await page.reload();
  const btcRate = rated.data.assets.find((a) => a.assetId === 'BTC');
  await expect(page.getByTestId('card-pay-from-BTC-rate')).toHaveText(`${btcRate.rate} USDC`);
  await expect(page.getByTestId('card-pay-from-BTC-rate-time').locator('time')).toHaveAttribute('datetime', btcRate.rateAsOf);
  await expect(page.getByTestId('card-pay-from-USDC-rate')).toHaveText('1 USDC');
  await expect(page.getByTestId('card-pay-from-USDC-rate-time').locator('time')).toHaveAttribute('datetime', /^\d{4}-\d\d-\d\dT/);
  expect(Date.now() - heldAt, 'the BTC/USDC hold lapsed before the screen showed the rate').toBeLessThan(HOLD_MAX_MS);
  tool('local-test-market.mjs', 'release', 'BTC/USDC');
  // No USD market against USDC on the stack's ticker: USD's rate is "not known", never 0 or 1.
  expect(rated.data.assets.find((a) => a.assetId === 'USD')).toMatchObject({ rate: null, rateAsOf: null });
  await expect(page.getByTestId('card-pay-from-USD-rate')).toHaveText('not known');
  await expect(page.getByTestId('card-pay-from-USD-rate-time')).toHaveText('not known');

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
    await expect(page.getByTestId('card-pay-from-BTC-rate')).toHaveText(/^\d+(\.\d+)? USDC$/);
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
