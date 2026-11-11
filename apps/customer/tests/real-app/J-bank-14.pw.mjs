// World: book, restart
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { test, expect } from './journey.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, ROOT, fund, journeyState, json, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';

// J-bank-14, in the running app (docs/roadmap/journeys.json): I control my card and pay with it. One TEST account,
// signed up in Germany, verified, funded with TEST 100 USDT and with an authenticator on, holds a TEST virtual card on
// the stack's card simulator (card-sim, no issuer, no network). A purchase arrives through the bank's four-eyes ops door
// that stands in for the issuer's message, approved by the stack's two TEST founders, as in J-bank-13.
// #1 (BK-cctl-01): blocks by category, merchant and country, each declining with a plain reason in the feed and
// nothing held, and the temporary lock (the freeze) with its history. #2 (BK-cctl-02): the per-purchase cap is an exact
// figure above zero, the other caps may be blank but never zero, and a purchase over a cap declines naming it.
// #3 (BK-cctl-03): the TEST card partner (the stack's partner switches say `secrets: "test"`) shows a TEST card number,
// expiry and security code after a fresh authenticator code, drops them from the screen when svc-bank's 60 seconds are
// up, and asks again for the next reveal; a TEST PIN is set and viewed the same way, and wrong PINs typed at a terminal
// block it at the owner's TEST count of 3 (BANK_CARD_PIN_TRY_LIMIT). The owner's step-up rule is on for #3 only, by a
// bank restart (World: restart), which also forgets the TEST partner's PINs. #4 (BK-cctl-04): the card goes into a phone
// wallet as one token row in state added, shown paused while the card is frozen.
// #5 (BK-cpay-01): the TEST card partner asks for a 3D Secure check on an online purchase through the same four-eyes
// door; its TEST code, shown TEST in the card room, completes the authorisation once, and the owner's TEST count of 3
// wrong codes (BANK_CARD_3DS_TRY_LIMIT) locks the check with nothing authorised. #7 (BK-cpay-01): reporting fraud on a
// payment locks the card, opens one case for it, and shows the safety messages. #6 (BK-cpay-02), partner-held (OWNER
// 259 (4)): the person's TEST partner switch `custody: 'off'` puts a second TEST card, in USDC, at the TEST card partner
// (TEST 30 USDC spendable, BANK_CARD_SIM_PARTNER_JSON), so its purchases, capture and refund move only at the partner and
// the ledger posts nothing. A purchase above the partner balance declines with a known code, shown in plain words with
// what to do; the partner switch `cardDecline: 'unlisted'` makes the partner decline with a code of its own that nothing
// here has words for, shown raw; payments the issuer marks recurring list by merchant; the TEST merchant's refund of a
// captured payment (`testPartner.cardRefund`) lists on the payment and under Merchant refunds. Whether a refund's
// cashback is taken back is an open owner question, so cashback is left as it is.
const J = 'J-bank-14';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

const totpLib = () => import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));

function person() {
  const { who } = run.read();
  if (!who) throw new Error(`${J} starts made no account, so this step has no one to act as`);
  return who;
}

/** The next authenticator code, once #5 has set one up, keeping its step so no code is ever used twice. */
async function code() {
  const state = run.read();
  if (!state.secret) return undefined;
  const { totp } = await totpLib();
  const next = await nextCode(totp, state.secret, state.step);
  run.write({ step: next.step });
  return next.code;
}

/** The person's own svc-bank API through Edge, with a session of its own (not the browser's). */
const kept = new Map();
async function bank(who = person()) {
  const held = kept.get(who.email);
  if (held && Date.now() - held.at < 4 * 60_000) return held.client;
  const totpCode = await code();
  const { status, body: login } = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password, ...(totpCode ? { totpCode } : {}) }),
  }).then(json);
  const token = login?.result?.data?.accessToken;
  if (!token) throw new Error(`sign-in for ${who.email} refused: ${status} ${JSON.stringify(login).slice(0, 300)}`);
  const headers = { origin: ORIGIN, authorization: `Bearer ${token}` };
  const answer = async (res) => {
    const body = await res.json();
    if (!res.ok)
      return {
        ok: false,
        status: res.status,
        code: body?.error?.data?.intafacedCode ?? body?.error?.data?.cause?.code ?? body?.error?.data?.code,
        body,
      };
    return { ok: true, data: body.result.data };
  };
  const client = {
    query: (procedure, input) =>
      fetch(`${EDGE}/api/bank/trpc/${procedure}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`, {
        headers,
      }).then(answer),
    mutate: (procedure, input) =>
      fetch(`${EDGE}/api/bank/trpc/${procedure}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }).then(answer),
    async usdt() {
      return this.holding('USDT');
    },
    async holding(asset) {
      const res = await fetch(`${EDGE}/api/v1/account/balance`, { headers }).then(json);
      if (res.status !== 200) throw new Error(`balance read refused: ${res.status}`);
      return res.body.balances[asset] ?? { free: '0', used: '0' };
    },
  };
  kept.set(who.email, { client, at: Date.now() });
  return client;
}

/** Signs the person in on the page; once #5 set up an authenticator, with a fresh code too. */
async function signInPerson(page) {
  const who = person();
  const totpCode = await code();
  if (!totpCode) return signIn(page, who);
  await page.goto('/login');
  await page.fill('input[name=totp]', totpCode);
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** The owner's step-up rule on or off, by a bank restart (as J-bank-13 does). A restart forgets the TEST partner's PINs. */
function stepUpRule(required) {
  const key = 'LOCAL_STACK_BANK_STEP_UP_MONEY_OUT';
  const before = process.env[key];
  if (required) process.env[key] = 'required';
  else delete process.env[key];
  try {
    tool('local-test-stack.mjs', 'restart', 'bank');
  } finally {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  }
  kept.clear();
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
async function cardEvent(actionType, procedure, fields, hashed = fields) {
  const { gates, ctx, sessions } = await founders();
  const approval = await gates.twoPerson(ctx, sessions, {
    actionType,
    targetService: 'svc-bank',
    targetId: actionType,
    expectedVersion: '1',
    payloadHash: gates.bankPayloadHash(actionType, hashed),
    policyVersion: gates.MARKERS.policyVersion,
  });
  const res = await ctx.edge.mutate('bank', procedure, { ...fields, ...approval }, await sessions.a.treasuryToken());
  expect(res.status, res.text.slice(0, 300)).toBe(200);
  return res.json.result.data;
}

async function cards() {
  const res = await (await bank()).query('cards.list', { limit: 50 });
  expect(res.ok, JSON.stringify(res.body ?? {}).slice(0, 300)).toBe(true);
  return res.data;
}
const cardOf = async (id) => (await cards()).find((card) => card.id === id);
/** The card's own panel on /bank/cards, by its four-digit tail. */
const panel = (page, card) => page.getByTestId(`card-${card.id}`);

/** A purchase the issuer reports on the card, as its message names it. */
function buy(cardId, amount, at = {}) {
  const bound = { cardId, authorizationRef: `jb14-${randomUUID()}`, amount };
  // The founders' approval binds the card, the reference and the amount, as the ops door checks it; the merchant parts
  // ride with the issuer's message.
  return cardEvent('bank.card_authorize', 'ops.cardAuthorize', { ...bound, ...at }, bound);
}

const cardId = () => {
  const { card } = run.read();
  if (!card) throw new Error(`${J} starts issued no card, so this step has no card to use`);
  return card;
};
/** The card's own controls, as svc-bank holds them. */
async function controls() {
  const res = await (await bank()).query('cards.controls.get', { cardId: cardId() });
  expect(res.ok, JSON.stringify(res.body ?? {}).slice(0, 300)).toBe(true);
  return res.data;
}
/** The card's decisions, newest first, as svc-bank holds them. */
async function feed() {
  const res = await (await bank()).query('cards.authorizations', { cardId: cardId(), limit: 50 });
  expect(res.ok, JSON.stringify(res.body ?? {}).slice(0, 300)).toBe(true);
  return res.data;
}
const blocksPanel = (page) => page.locator(`[data-card="${cardId()}"]`).getByRole('region', { name: 'Card controls', exact: true });
const limitsPanel = (page) => page.locator(`[data-card="${cardId()}"]`).getByRole('region', { name: 'Spending limits', exact: true });
const decisions = (page) => page.getByRole('region', { name: 'Card decisions', exact: true });
/** One decision in the card's feed on the page, by the reference its purchase was sent under. */
const decision = (page, ref) => decisions(page).getByRole('listitem').filter({ hasText: ref });

/** Opens /bank/cards on the card: its decisions, controls and limits show once the card is chosen (kept for the tab). */
async function openCards(page) {
  await signInPerson(page);
  await page.goto('/bank/cards');
  await showCard(page);
}
async function showCard(page) {
  const inspect = page.getByRole('button', { name: `Inspect decisions for card ${cardId()}` });
  await expect(blocksPanel(page).or(inspect)).toBeVisible();
  if (await inspect.isVisible()) await inspect.click();
  await expect(blocksPanel(page)).toBeVisible();
}

test(`${J} starts: a verified TEST account with an authenticator on, funded with TEST 100 USDT, holding a TEST virtual card on the card simulator`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const who = await signUp(page, 'jb14');
  await verify(page, who);
  expect(fund(who.email, 'USDT', '100').tx).toBeTruthy();
  run.reset({ who });
  await signInPerson(page);
  const { totp } = await totpLib();
  const { secret, step } = await addAuthenticator(page, totp);
  run.write({ secret, step });
  kept.clear();

  await signInPerson(page);
  await page.goto('/bank/cards/new');
  await page.getByLabel('Country you live in').selectOption('DE');
  const terms = page.getByTestId('card-terms');
  await terms.getByLabel('I accept the cardholder terms').check();
  await terms.getByRole('button', { name: 'Accept terms' }).click();
  await expect(terms).toContainText('You accepted version local-test-1');
  await page.getByRole('radio', { name: 'Virtual card' }).check();
  await page.getByLabel('Limit per payment (USDT)').fill('50');
  await page.getByRole('button', { name: 'Issue virtual card' }).click();
  const result = page.getByTestId('card-order-result');
  await expect(result).toContainText('Virtual card issued');
  const id = await result.getAttribute('data-card-id');
  expect(await cardOf(id)).toMatchObject({ cardType: 'virtual', status: 'active', simulated: true, issuer: 'card-sim' });
  run.write({ card: id });
});

test(`${J} #1 opens the card controls: categories, merchants, countries, channels and a temporary lock with history; a blocked category declines with a plain reason in the feed`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  await openCards(page);
  const panel = blocksPanel(page);
  // Every control is laid out, each with the service's state: nothing blocked yet, every channel on, never locked.
  const categories = panel.getByRole('group', { name: 'Categories' });
  for (const name of ['Gambling', 'Cash-like payments', 'Travel', 'Groceries'])
    await expect(categories.getByRole('switch', { name: new RegExp(`^${name}`) })).toHaveAttribute('aria-checked', 'false');
  await expect(panel.getByRole('form', { name: 'Merchants' })).toBeVisible();
  await expect(panel.getByRole('form', { name: 'Countries' })).toBeVisible();
  const channels = page.locator(`[data-card="${cardId()}"]`).getByRole('region', { name: 'Where this card works', exact: true });
  for (const name of ['Online payments', 'Contactless', 'Cash at ATMs', 'Payments abroad'])
    await expect(channels.getByRole('switch', { name: new RegExp(`^${name}`) })).toHaveAttribute('aria-checked', 'true');
  const lock = panel.getByRole('region', { name: 'Temporary lock' });
  await expect(lock.getByRole('status')).toContainText('Not locked');
  await expect(lock).toContainText('Never locked.');

  // Block gambling, one merchant and one country.
  await categories.getByRole('switch', { name: /^Gambling/ }).click();
  await expect(categories.getByRole('switch', { name: /^Gambling/ })).toHaveAttribute('aria-checked', 'true');
  const merchants = panel.getByRole('form', { name: 'Merchants' });
  await merchants.getByLabel('Merchant name').fill('TEST Casino Shop');
  await merchants.getByRole('button', { name: 'Block merchant' }).click();
  await expect(merchants.getByRole('list')).toContainText('test casino shop');
  const countries = panel.getByRole('form', { name: 'Countries' });
  await countries.getByLabel('Country code (two letters)').fill('us');
  await countries.getByRole('button', { name: 'Block country' }).click();
  await expect(countries.getByRole('list')).toContainText('US');
  expect((await controls()).controls.map((c) => [c.kind, c.value])).toEqual([
    ['category', 'gambling'],
    ['merchant', 'test casino shop'],
    ['country', 'US'],
  ]);

  // A gambling purchase declines with its own code, and nothing is held for it.
  const before = await (await bank()).usdt();
  const gamble = await buy(cardId(), '5', { merchantCategory: 'gambling', merchant: 'TEST Bookmaker', merchantCountry: 'DE' });
  expect(gamble).toMatchObject({ decision: 'declined', declineCode: 'bank.card_category_blocked' });
  const atMerchant = await buy(cardId(), '5', { merchantCategory: 'groceries', merchant: 'TEST Casino Shop', merchantCountry: 'DE' });
  expect(atMerchant).toMatchObject({ decision: 'declined', declineCode: 'bank.card_merchant_blocked' });
  const abroad = await buy(cardId(), '5', { merchantCategory: 'groceries', merchant: 'TEST Grocer', merchantCountry: 'US' });
  expect(abroad).toMatchObject({ decision: 'declined', declineCode: 'bank.card_country_blocked' });
  expect(await (await bank()).usdt()).toEqual(before);

  // The feed says why in plain words, beside the code.
  await page.reload();
  await showCard(page);
  const rows = await feed();
  const refOf = (id) => rows.find((row) => row.id === id).authorizationRef;
  const gambled = decision(page, refOf(gamble.authorizationId));
  await expect(gambled.getByTestId('decline-reason')).toHaveText(
    'You blocked this kind of shop on this card. To pay here, allow the category again under Card controls.',
  );
  await expect(gambled).toContainText('bank.card_category_blocked');
  await expect(decision(page, refOf(atMerchant.authorizationId)).getByTestId('decline-reason')).toContainText('You blocked this merchant');
  await expect(decision(page, refOf(abroad.authorizationId)).getByTestId('decline-reason')).toContainText(
    'You blocked payments in this country',
  );

  // Allowed again, a gambling purchase goes through.
  await blocksPanel(page)
    .getByRole('group', { name: 'Categories' })
    .getByRole('switch', { name: /^Gambling/ })
    .click();
  await expect(
    blocksPanel(page)
      .getByRole('group', { name: 'Categories' })
      .getByRole('switch', { name: /^Gambling/ }),
  ).toHaveAttribute('aria-checked', 'false');
  expect(await buy(cardId(), '5', { merchantCategory: 'gambling', merchant: 'TEST Bookmaker', merchantCountry: 'DE' })).toMatchObject({
    decision: 'approved',
  });

  // The temporary lock: freeze, then unfreeze, and each change is in the history with who made it.
  const card = page.getByRole('main');
  await card.getByRole('button', { name: 'Freeze', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^(Confirm|Freeze card)$/ })
    .click();
  await expect(page.getByRole('dialog').getByText('Confirmed by the service')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  expect(await buy(cardId(), '5', { merchantCategory: 'groceries' })).toMatchObject({
    decision: 'declined',
    declineCode: 'bank.card_not_active',
  });
  await card.getByRole('button', { name: 'Unfreeze', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^(Confirm|Unfreeze card)$/ })
    .click();
  await expect(page.getByRole('dialog').getByText('Confirmed by the service')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  expect((await controls()).history.map((h) => [h.status, h.actor])).toEqual([
    ['active', 'owner'],
    ['frozen', 'owner'],
  ]);
  await page.reload();
  await showCard(page);
  const history = blocksPanel(page).getByRole('region', { name: 'Lock history' }).getByRole('row');
  await expect(history).toHaveCount(3);
  await expect(history.nth(1)).toContainText('Unlocked');
  await expect(history.nth(2)).toContainText('Locked');
  await expect(history.nth(2)).toContainText('You');
});

test(`${J} #2 sets a per-purchase cap and other limits: an exact figure above zero for the cap; other caps may be blank but never zero; a purchase over a cardholder limit declines naming the scope`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  await openCards(page);
  const limits = limitsPanel(page);
  await limits.getByRole('button', { name: 'Change limits' }).click();
  const dialog = page.getByRole('dialog');
  // Zero is never a cap: neither the per-purchase cap nor any other.
  await dialog.getByLabel('Per purchase (USDT)').fill('0');
  await dialog.getByLabel('Per day (USDT)').fill('0');
  await dialog.getByRole('button', { name: 'Review' }).click();
  await expect(dialog.getByText('Enter an exact amount greater than zero.').first()).toBeVisible();
  // An exact cap above zero, a daily cap, and the monthly and cash caps left blank.
  await dialog.getByLabel('Per purchase (USDT)').fill('20.5');
  await dialog.getByLabel('Per day (USDT)').fill('30');
  await dialog.getByLabel('Per month (USDT)').fill('');
  await dialog.getByLabel('Cash withdrawals (USDT)').fill('');
  await dialog.getByRole('button', { name: 'Review' }).click();
  await dialog.getByRole('button', { name: 'Save limits' }).click();
  await expect(dialog.getByText('Confirmed by the service')).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  expect(await cardOf(cardId())).toMatchObject({ perAuthorizationLimit: '20.5', dailyLimit: '30', monthlyLimit: null, cashLimit: null });
  await expect(limits).toContainText('No limit');
  // The service refuses zero itself, whatever the page lets through.
  const zero = await (
    await bank()
  ).mutate('cards.setLimits', { cardId: cardId(), commandId: randomUUID(), perAuthorizationLimit: '20.5', monthlyLimit: '0' });
  expect(zero.ok).toBe(false);

  // Over the per-purchase cap: declined naming that cap, and nothing is held.
  let before = await (await bank()).usdt();
  const tooBig = await buy(cardId(), '21');
  expect(tooBig).toMatchObject({ decision: 'declined', declineCode: 'bank.card_limit_exceeded' });
  expect(await (await bank()).usdt()).toEqual(before);
  // A purchase inside both caps goes through; then one that fits the per-purchase cap but not what is left of the day
  // declines naming the daily cap, and nothing is held for it.
  expect(await buy(cardId(), '15')).toMatchObject({ decision: 'approved' });
  const today = new Date().toISOString().slice(0, 10);
  const spent = (await feed())
    .filter((row) => row.decision === 'approved' && row.decidedAt.slice(0, 10) === today)
    .reduce((sum, row) => sum + Number(row.amount), 0);
  const overDayAmount = Math.floor(30 - spent) + 1;
  expect(overDayAmount).toBeLessThanOrEqual(20);
  before = await (await bank()).usdt();
  const overDay = await buy(cardId(), String(overDayAmount));
  expect(overDay).toMatchObject({ decision: 'declined', declineCode: 'bank.card_daily_limit_exceeded' });
  expect(await (await bank()).usdt()).toEqual(before);
  await page.reload();
  await showCard(page);
  const rows = await feed();
  const refOf = (id) => rows.find((row) => row.id === id).authorizationRef;
  await expect(decision(page, refOf(tooBig.authorizationId)).getByTestId('decline-reason')).toContainText(
    'Over this card’s per-purchase limit',
  );
  await expect(decision(page, refOf(overDay.authorizationId)).getByTestId('decline-reason')).toContainText('Over this card’s daily limit');
});

const cardPanel = (page, name) => page.locator(`[data-card="${cardId()}"]`).getByRole('region', { name, exact: true });
/** The fresh confirmation inside a panel: a new authenticator code each time. */
async function confirmIn(region) {
  await region.getByLabel('Authenticator code').fill(await code());
  await region.getByRole('button', { name: 'Confirm', exact: true }).click();
}

test(`${J} #3 reveals card details and sets a PIN: details clear after 60 seconds and a second reveal needs a new step-up; wrong-PIN block at the owner's count`, async ({
  page,
}) => {
  test.setTimeout(420_000);
  expect((await cardOf(cardId())).status).toBe('active');
  stepUpRule(true);
  try {
    // Without a fresh confirmation the bank refuses, and shows nothing.
    const bare = await (await bank()).mutate('cards.reveal', { cardId: cardId(), revealId: randomUUID() });
    expect(bare).toMatchObject({ ok: false, code: 'bank.step_up_required' });
    expect(await (await bank()).query('cards.secretsOffered')).toMatchObject({
      ok: true,
      data: { details: true, pin: true, wallet: true, test: true },
    });

    await openCards(page);
    const details = cardPanel(page, 'Card details');
    const show = details.getByRole('button', { name: 'Show card number and security code' });
    await show.click();
    await confirmIn(details);
    const pan = details.getByTestId('card-pan');
    await expect(pan).toHaveText(/^999999\d{10}$/);
    await expect(details.getByTestId('card-expiry')).toHaveText(/^(0[1-9]|1[0-2])\/\d{2}$/);
    await expect(details.getByTestId('card-cvv')).toHaveText(/^\d{3}$/);
    await expect(details).toContainText('TEST card details from a stand-in card partner');
    const shownAt = Date.now();
    const number = await pan.textContent();
    // svc-bank's 60 seconds: still shown a little before, gone after.
    await page.waitForTimeout(Math.max(0, 50_000 - (Date.now() - shownAt)));
    await expect(pan).toBeVisible();
    await expect(pan).toHaveCount(0, { timeout: 20_000 });
    expect(Date.now() - shownAt).toBeGreaterThanOrEqual(55_000);
    // The next reveal asks again: the button opens a new confirmation, and only a new code shows the number.
    await show.click();
    await expect(details.getByLabel('Authenticator code')).toBeVisible();
    await expect(pan).toHaveCount(0);
    await confirmIn(details);
    await expect(pan).toHaveText(number);

    // A TEST PIN, set and viewed, each after its own confirmation.
    const pinPanel = cardPanel(page, 'PIN');
    await pinPanel.getByLabel('New PIN (4 to 12 digits)').fill('2468');
    await pinPanel.getByRole('button', { name: 'Set this PIN' }).click();
    await confirmIn(pinPanel);
    await expect(pinPanel).toContainText('PIN set.');
    await pinPanel.getByRole('button', { name: 'View PIN' }).click();
    await confirmIn(pinPanel);
    await expect(pinPanel.getByTestId('card-pin-shown')).toHaveText('2468');
    await expect(pinPanel).toContainText('TEST PIN kept by a stand-in card partner');

    // At a terminal: the right PIN goes through; wrong PINs block at the owner's TEST count of 3, and then even the right
    // PIN declines. Nothing is held for a decline.
    expect(await buy(cardId(), '0.01', { pin: '2468' })).toMatchObject({ decision: 'approved' });
    const before = await (await bank()).usdt();
    const first = await buy(cardId(), '0.01', { pin: '1111' });
    expect(first).toMatchObject({ decision: 'declined', declineCode: 'bank.card_pin_wrong' });
    expect(await buy(cardId(), '0.01', { pin: '1111' })).toMatchObject({ decision: 'declined', declineCode: 'bank.card_pin_wrong' });
    const third = await buy(cardId(), '0.01', { pin: '1111' });
    expect(third).toMatchObject({ decision: 'declined', declineCode: 'bank.card_pin_blocked' });
    expect(await buy(cardId(), '0.01', { pin: '2468' })).toMatchObject({ decision: 'declined', declineCode: 'bank.card_pin_blocked' });
    expect(await (await bank()).usdt()).toEqual(before);
    await page.reload();
    await showCard(page);
    const rows = await feed();
    const refOf = (id) => rows.find((row) => row.id === id).authorizationRef;
    await expect(decision(page, refOf(first.authorizationId)).getByTestId('decline-reason')).toContainText('Wrong PIN.');
    await expect(decision(page, refOf(third.authorizationId)).getByTestId('decline-reason')).toContainText('The PIN is blocked');
  } finally {
    stepUpRule(false);
  }
});

test(`${J} #4 adds the card to a mobile wallet: one token row in state added; a frozen card shows its tokens paused`, async ({ page }) => {
  test.setTimeout(240_000);
  const api = await bank();
  expect((await cardOf(cardId())).status).toBe('active');
  await openCards(page);
  const wallets = cardPanel(page, 'Phone wallets');
  await expect(wallets).toContainText('This card is in no phone wallet.');
  await wallets.getByRole('button', { name: 'Add to Apple Wallet' }).click();
  const apple = wallets.locator('li[data-wallet="apple"]');
  await expect(apple).toHaveText('Apple Wallet: Added');
  await expect(wallets).toContainText('TEST wallet tokens from a stand-in card partner');
  // The same wallet again is the same token: once the second add is answered (the buttons free again), still one row.
  const addApple = wallets.getByRole('button', { name: 'Add to Apple Wallet' });
  const second = page.waitForResponse((res) => res.url().includes('cards.walletProvision') && res.request().method() === 'POST');
  await addApple.click();
  expect((await second).ok()).toBe(true);
  await expect(addApple).toBeEnabled();
  await page.reload();
  await showCard(page);
  await expect(apple).toHaveCount(1);
  const added = await api.query('cards.walletTokens', { cardId: cardId() });
  expect(added).toMatchObject({ ok: true, data: { test: true } });
  expect(added.data.tokens).toEqual([expect.objectContaining({ wallet: 'apple', state: 'added' })]);

  // Frozen: the token shows paused, and no wallet takes the card.
  expect(await api.mutate('cards.setStatus', { cardId: cardId(), status: 'frozen' })).toMatchObject({ ok: true });
  try {
    expect((await api.query('cards.walletTokens', { cardId: cardId() })).data.tokens).toEqual([
      expect.objectContaining({ wallet: 'apple', state: 'paused' }),
    ]);
    const refused = await api.mutate('cards.walletProvision', {
      cardId: cardId(),
      provisionId: randomUUID(),
      wallet: 'google',
      nonce: randomUUID(),
    });
    expect(refused).toMatchObject({ ok: false, code: 'bank.card_not_active' });
    await page.reload();
    await showCard(page);
    await expect(apple).toHaveText('Apple Wallet: Paused while the card is frozen');
    await expect(wallets.getByRole('button', { name: 'Add to Google Wallet' })).toHaveCount(0);
    await expect(wallets).toContainText('A frozen or closed card cannot be added to a phone wallet.');
  } finally {
    expect(await api.mutate('cards.setStatus', { cardId: cardId(), status: 'active' })).toMatchObject({ ok: true });
  }
  expect((await api.query('cards.walletTokens', { cardId: cardId() })).data.tokens).toEqual([
    expect.objectContaining({ wallet: 'apple', state: 'added' }),
  ]);
});

/** The issuer's 3D Secure request for an online purchase, through the ops door with the founders' approval. */
function challengeFor(amount, merchant) {
  // The founders' approval binds the whole purchase the cardholder is asked about, merchant parts too.
  const bound = {
    cardId: cardId(),
    challengeId: randomUUID(),
    challengeRef: `jb14-3ds-${randomUUID()}`,
    amount,
    merchant,
    merchantCountry: 'DE',
  };
  return cardEvent('bank.card_3ds_challenge', 'ops.cardThreeDSChallenge', bound).then((opened) => ({ ...opened, ref: bound.challengeRef }));
}
/** The TEST partner's code for one challenge, as the card room shows it. */
async function testCodeIn(item) {
  const said = await item.getByText(/TEST code from a stand-in card partner: \d{6}\./).textContent();
  return said.match(/(\d{6})\./)[1];
}
const notCode = (code) => (code === '000000' ? '111111' : '000000');

test(`${J} #5 approves a 3D Secure challenge: the authorisation completes once; too many wrong codes lock the challenge`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const api = await bank();
  expect((await cardOf(cardId())).status).toBe('active');
  const ok = await challengeFor('1', 'TEST Online Shop');
  expect(ok.state).toBe('open');
  await openCards(page);
  const checks = cardPanel(page, '3D Secure checks');
  const item = checks.locator(`li[data-challenge="${ok.ref}"]`);
  await expect(item).toContainText('1 USDT at TEST Online Shop');
  await expect(item).toContainText('Waiting for your code. 3 tries left.');
  const right = await testCodeIn(item);

  // One wrong code counts; the right one makes the purchase go through.
  await item.getByLabel('Code from the card partner').fill(notCode(right));
  await item.getByRole('button', { name: 'Confirm this purchase' }).click();
  await expect(item).toContainText('Wrong code. 2 tries left before this check locks.');
  await item.getByLabel('Code from the card partner').fill(right);
  await item.getByRole('button', { name: 'Confirm this purchase' }).click();
  await expect(item).toContainText('Confirmed. The purchase went through once.');

  // Once: one approved authorisation under the challenge's key, and answering again reaches the same one.
  const authRef = `3ds:${ok.ref}`;
  const completed = (await feed()).filter((row) => row.authorizationRef === authRef);
  expect(completed).toHaveLength(1);
  expect(completed[0]).toMatchObject({ decision: 'approved' });
  const again = await api.mutate('cards.threeDS.answer', { cardId: cardId(), challengeId: ok.challengeId, code: right });
  expect(again).toMatchObject({ ok: true, data: { state: 'approved', authorizationId: completed[0].id } });
  expect((await feed()).filter((row) => row.authorizationRef === authRef)).toHaveLength(1);
  await page.reload();
  await showCard(page);
  await expect(decision(page, authRef)).toBeVisible();

  // Three wrong codes (the owner's TEST count) lock the next challenge: nothing is authorised, and the right code no
  // longer helps.
  const locked = await challengeFor('1', 'TEST Other Shop');
  await page.reload();
  await showCard(page);
  const lockedItem = checks.locator(`li[data-challenge="${locked.ref}"]`);
  const code = await testCodeIn(lockedItem);
  for (const left of [2, 1]) {
    await lockedItem.getByLabel('Code from the card partner').fill(notCode(code));
    await lockedItem.getByRole('button', { name: 'Confirm this purchase' }).click();
    await expect(lockedItem).toContainText(`Wrong code. ${left} tries left before this check locks.`);
  }
  await lockedItem.getByLabel('Code from the card partner').fill(notCode(code));
  await lockedItem.getByRole('button', { name: 'Confirm this purchase' }).click();
  await expect(lockedItem).toContainText('Locked after too many wrong codes. The purchase did not go through, and nothing was held.');
  const late = await api.mutate('cards.threeDS.answer', { cardId: cardId(), challengeId: locked.challengeId, code });
  expect(late).toMatchObject({ ok: true, data: { state: 'locked', authorizationId: null } });
  expect((await feed()).filter((row) => row.authorizationRef === `3ds:${locked.ref}`)).toHaveLength(0);
});

test(`${J} #6 reads a decline and the transaction feed: a known code gives plain reason and next steps; an unknown code shows the raw code; recurring payments and merchant refunds are listed`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const api = await bank();
  const ledgerBefore = await api.holding('USDC');
  const switched = await api.mutate('testPartner.set', { custody: 'off', cardDecline: 'none' });
  expect(switched, JSON.stringify(switched.body ?? {}).slice(0, 300)).toMatchObject({ ok: true, data: { custody: 'off' } });
  try {
    // A second TEST virtual card, in USDC, which the TEST card partner holds for this person (TEST 30 USDC spendable).
    const issued = await api.mutate('cards.issue', { cardId: randomUUID(), assetId: 'USDC', perAuthorizationLimit: '50' });
    expect(issued.ok, JSON.stringify(issued.body ?? {}).slice(0, 300)).toBe(true);
    const card = issued.data.id;
    const pay = async (amount, at = {}) => {
      const ref = `jb14-${randomUUID()}`;
      const bound = { cardId: card, authorizationRef: ref, amount };
      const done = await cardEvent('bank.card_authorize', 'ops.cardAuthorize', { ...bound, ...at }, bound);
      return { ...done, ref };
    };

    // A known code: above the partner balance, the partner declines and the feed says why and what to do.
    const short = await pay('31', { merchant: 'TEST Big Shop' });
    expect(short).toMatchObject({ decision: 'declined', declineCode: 'bank.card_partner_insufficient_funds' });
    // An unknown code: the partner declines with a reason of its own that nothing here has words for.
    expect((await api.mutate('testPartner.set', { cardDecline: 'unlisted' })).ok).toBe(true);
    const odd = await pay('1', { merchant: 'TEST Odd Shop' });
    expect(odd).toMatchObject({ decision: 'declined', declineCode: 'test_partner.unlisted_reason' });
    expect((await api.mutate('testPartner.set', { cardDecline: 'none' })).ok).toBe(true);

    // Recurring payments the issuer marked as the merchant charging the card on file, and one that is not.
    for (const [amount, merchant] of [
      ['4', 'TEST Stream'],
      ['4', 'TEST Stream'],
      ['5', 'TEST Gym'],
    ]) {
      expect(await pay(amount, { merchant, merchantCountry: 'DE', recurring: true })).toMatchObject({ decision: 'approved' });
    }
    // A payment the merchant captures and then refunds in part, at the partner.
    const shop = await pay('8', { merchant: 'TEST Shop' });
    expect(shop).toMatchObject({ decision: 'approved' });
    await cardEvent('bank.card_capture', 'ops.cardCapture', { cardId: card, authorizationRef: shop.ref, amount: '8' });
    const refunded = await api.mutate('testPartner.cardRefund', { cardId: card, authorizationRef: shop.ref, amount: '3' });
    expect(refunded, JSON.stringify(refunded.body ?? {}).slice(0, 300)).toMatchObject({ ok: true, data: { refunded: '3' } });

    // svc-bank's own reads: the refund is on its payment, recurring payments group by merchant, and the partner's figure
    // is 30 - 4 - 4 - 5 - 8 + 3 = 12 USDC spendable.
    const rows = (await api.query('cards.authorizations', { cardId: card, limit: 50 })).data;
    expect(rows.find((r) => r.authorizationRef === shop.ref)).toMatchObject({
      heldBy: 'partner',
      recurring: false,
      refund: { amount: '3', status: 'settled' },
    });
    expect(rows.find((r) => r.authorizationRef === odd.ref)).toMatchObject({ declineCode: 'test_partner.unlisted_reason' });
    const recurring = await api.query('cards.recurring', { cardId: card, limit: 50 });
    expect(recurring.data.map((r) => [r.merchant, r.payments, r.lastAmount])).toEqual([
      ['TEST Gym', 1, '5'],
      ['TEST Stream', 2, '4'],
    ]);
    const held = await api.query('cards.partnerHeld', { cardId: card, limit: 50 });
    expect(held.data).toMatchObject({ heldBy: 'partner', figures: { assetId: 'USDC', available: '12' } });
    // Nothing on our ledger: the person's USDC there is as it was.
    expect(await api.holding('USDC')).toEqual(ledgerBefore);

    // On the page, on the partner card.
    await signInPerson(page);
    await page.goto('/bank/cards');
    const inspect = page.getByRole('button', { name: `Inspect decisions for card ${card}` });
    const here = page.locator(`[data-card="${card}"]`);
    const controlsHere = here.getByRole('region', { name: 'Card controls', exact: true });
    await expect(controlsHere.or(inspect)).toBeVisible();
    if (await inspect.isVisible()) await inspect.click();
    await expect(controlsHere).toBeVisible();

    const known = decision(page, short.ref);
    await expect(known.getByTestId('decline-reason')).toHaveText(
      'Not enough money at the card partner for this purchase. Add money to the card partner balance, or pay less.',
    );
    const unknown = decision(page, odd.ref);
    await expect(unknown).toContainText('test_partner.unlisted_reason');
    await expect(unknown.getByTestId('decline-reason')).toHaveText(
      'Declined. This code has no plain words here yet: keep it if you contact support.',
    );

    const subs = here
      .getByRole('region', { name: 'Recurring payments', exact: true })
      .getByRole('list', { name: 'Merchants charging this card' });
    await expect(subs.getByRole('listitem')).toHaveCount(2);
    await expect(subs.locator('li[data-merchant="TEST Stream"]')).toContainText('TEST Stream, DE');
    await expect(subs.locator('li[data-merchant="TEST Stream"]')).toContainText('2 payments, the last 4 USDC on');
    await expect(subs.locator('li[data-merchant="TEST Gym"]')).toContainText('1 payment, 5 USDC on');

    const refunds = here.getByRole('region', { name: 'Merchant refunds', exact: true });
    await expect(refunds.getByRole('list', { name: 'Refunds on this card' }).getByRole('listitem')).toHaveCount(1);
    await expect(refunds.locator(`li[data-authorization="${shop.ref}"]`)).toContainText(`3 USDC refunded for ${shop.ref} on`);
    await expect(refunds).toContainText('Cashback on a refunded payment stays as it was');
    await expect(decision(page, shop.ref)).toContainText('Refund');
  } finally {
    await api.mutate('testPartner.set', { custody: 'on', cardDecline: 'none' });
  }
});

test(`${J} #7 reports fraud on a card payment: the card is locked, a fraud case opens, and safety messages show`, async ({ page }) => {
  test.setTimeout(240_000);
  const api = await bank();
  expect((await cardOf(cardId())).status).toBe('active');
  const paid = (await feed()).find((row) => row.decision === 'approved');
  if (!paid) throw new Error(`${J} #7 found no approved payment on the card to report`);
  await openCards(page);
  const fraud = cardPanel(page, 'Report fraud');
  await fraud.getByRole('button', { name: `Report fraud on ${paid.authorizationRef}` }).click();
  await expect(fraud).toContainText('The card is locked. No new payment goes through while it is locked.');
  await expect(fraud.getByRole('list', { name: 'Open fraud cases' }).getByRole('listitem')).toHaveCount(1);
  await expect(fraud.locator(`li[data-authorization="${paid.authorizationRef}"]`)).toContainText('is open for this payment.');
  const safety = cardPanel(page, 'Keep your money safe');
  await expect(safety).toContainText('We never ask for your PIN, your card number or a check code');
  await expect(safety).toContainText('Never open a payment link someone sent you out of the blue.');

  // Locked, with one case for the payment: reporting it again is the same case, and the next purchase declines.
  expect((await cardOf(cardId())).status).toBe('frozen');
  const listed = await api.query('cards.fraud.list', { cardId: cardId() });
  expect(listed).toMatchObject({ ok: true });
  expect(listed.data.reports).toEqual([expect.objectContaining({ authorizationId: paid.id, state: 'open' })]);
  const again = await api.mutate('cards.fraud.report', { cardId: cardId(), authorizationId: paid.id });
  expect(again).toMatchObject({ ok: true, data: { id: listed.data.reports[0].id } });
  expect(await buy(cardId(), '1')).toMatchObject({ decision: 'declined' });
  await page.reload();
  await showCard(page);
  await expect(cardPanel(page, 'Report fraud').getByRole('list', { name: 'Open fraud cases' }).getByRole('listitem')).toHaveCount(1);
});
