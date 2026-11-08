// World: book
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { test, expect } from './journey.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, ROOT, fund, journeyState, json } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';

// J-bank-14, in the running app (docs/roadmap/journeys.json): I control my card and pay with it. One TEST account,
// signed up in Germany, verified, funded with TEST 100 USDT and with an authenticator on, holds a TEST virtual card on
// the stack's card simulator (card-sim, no issuer, no network). A purchase arrives through the bank's four-eyes ops door
// that stands in for the issuer's message, approved by the stack's two TEST founders, as in J-bank-13.
// #1 (BK-cctl-01): blocks by category, merchant and country, each declining with a plain reason in the feed and
// nothing held, and the temporary lock (the freeze) with its history. #2 (BK-cctl-02): the per-purchase cap is an exact
// figure above zero, the other caps may be blank but never zero, and a purchase over a cap declines naming it.
// #3 to #7 are not built: card details, PIN and mobile wallets need a TEST issuer path, and 3D Secure, the decline
// guide, recurring payments, refunds and fraud reports are not built; an approved purchase's hold moves to the partner
// with B3's partner-held card authorisations (project-state #1790). Their tests come with them.
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
const authorize = (cardId, amount) =>
  cardEvent('bank.card_authorize', 'ops.cardAuthorize', { cardId, authorizationRef: `jb14-${randomUUID()}`, amount });
const capture = (cardId, authorizationRef, amount) =>
  cardEvent('bank.card_capture', 'ops.cardCapture', { cardId, authorizationRef, amount });

async function cards() {
  const res = await (await bank()).query('cards.list', { limit: 50 });
  expect(res.ok, JSON.stringify(res.body ?? {}).slice(0, 300)).toBe(true);
  return res.data;
}
const cardOf = async (id) => (await cards()).find((card) => card.id === id);
/** The card's own panel on /bank/cards, by its four-digit tail. */
const panel = (page, card) => page.getByTestId(`card-${card.id}`);

/** A purchase the issuer reports on the card, as its message names it. */
const buy = (cardId, amount, at = {}) =>
  cardEvent('bank.card_authorize', 'ops.cardAuthorize', { cardId, authorizationRef: `jb14-${randomUUID()}`, amount, ...at });

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
