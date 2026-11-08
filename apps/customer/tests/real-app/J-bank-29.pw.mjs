// World: restart
import { randomUUID } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, fund, journeyState, json, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-bank-29, in the running app (docs/roadmap/journeys.json): I pay by card from my crypto and stablecoins. The card and its
// money are the partner's (OWNER 226); no partner is named, so the stack runs the TEST partner card adapter (card-sim, no
// issuer, no network) with its switches from the bank profile (BANK_CARD_SIM_PARTNER_JSON, CUSTODY-DELTA §4): the stand-in
// partner spends from USDC, BTC and USD. The owner's TEST spendable-asset list is USDC, BTC, USD (BANK_CARD_SPEND_ASSETS).
// One TEST account, verified and funded with TEST USDT, holds one TEST card drawing on USDT: an asset the partner cannot
// spend from. Step 1 (BK-ccrypto-01): the owner's list switched off for one restart refuses Pay from by name. Step 2: Pay
// from lists what the partner can spend from and reads "not offered by the partner" for the rest, in both of the partner's
// modes: it holds the crypto, or (one restart with LOCAL_STACK_BANK_CARD_PARTNER=wallet_pull) the card pulls from the
// person's own wallet. Not yet built, and not asserted here: each asset's partner balance, rate and rate time, the saved
// order, the trading and agent accounts' line, and steps 3 to 8 (the authorisation path in each mode).
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
const assetRow = (page, assetId) => page.getByTestId(`card-pay-from-${assetId}`);

test(`${J} #1 with the owner's spendable-asset list switched off for one restart, opens Pay from: refused bank.card_spend_assets_unset, and no order can be saved`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const who = await signUp(page, 'jb29');
  await verify(page, who);
  expect(fund(who.email, 'USDT', '100').tx).toBeTruthy();
  run.reset({ who });
  // One TEST card on the TEST partner card adapter, drawing on USDT.
  const issued = await (await bank()).mutate('cards.issue', { cardId: randomUUID(), assetId: 'USDT', perAuthorizationLimit: '50' });
  expect(issued.ok, JSON.stringify(issued.body ?? {}).slice(0, 300)).toBe(true);
  expect(issued.data).toMatchObject({ simulated: true, issuer: 'card-sim', assetId: 'USDT' });

  restartBank('LOCAL_STACK_BANK_CARD_SPEND_ASSETS', 'off');
  try {
    const refused = await (await bank()).query('cards.payFrom');
    expect(refused).toMatchObject({ ok: false, code: 'bank.card_spend_assets_unset' });
    await signIn(page, who);
    await page.goto('/bank/cards');
    const panel = payFrom(page);
    await expect(panel.getByRole('alert')).toHaveAttribute('data-code', 'bank.card_spend_assets_unset');
    await expect(panel).toContainText('The list of assets a card may pay from is not published yet.');
    // Nothing to order: no asset row is listed while the list is unset.
    await expect(panel.locator('[data-testid^="card-pay-from-"][data-state]')).toHaveCount(0);
  } finally {
    restartBank('LOCAL_STACK_BANK_CARD_SPEND_ASSETS', undefined);
  }
});

test(`${J} #2 with the TEST list back, opens Pay from: the assets the partner can spend from, and "not offered by the partner" for any other, in both modes (the partner holds them, or the card pulls from the user's own wallet)`, async ({
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
  } finally {
    restartBank('LOCAL_STACK_BANK_CARD_PARTNER', undefined);
  }
});
