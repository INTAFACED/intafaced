// World: book, stack
import { test, expect } from './journey.mjs';
import { api, journeyState, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-copy-bots-otc-21, in the running app (docs/roadmap/journeys.json): subscribe to a signal and run a signal bot. One
// test per step, titled "J-copy-bots-otc-21 #<n>", run in order on one verified TEST account. The signal listing is one
// a second verified TEST account, the TEST provider, publishes through svc-market's own door (`signals.publish`), at a
// TEST price. Access is paid by card through the stack's TEST partner card (MARKET_SIGNAL_CARD_PARTNER=test), which
// takes the payment and settles it to our TEST reserve at once; our ledger records only our revenue, so the buyer's own
// ledger shows nothing for it (INTAFACED keeps no prepaid balance). The signal bot's cap is the stack's TEST cap.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #4 and #5: no signal reaches a signal bot yet (no provider signal intake, one-way check, cap check or history).
const J = 'J-copy-bots-otc-21';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };
/** The TEST provider's price for access. A TEST figure. */
const PRICE = '5';

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

const trpcQuery = (service, proc) => `/api/${service}/trpc/${proc}`;
const data = (res) => res.body?.result?.data;

const listing = (page) => page.getByRole('article', { name: state('title') });
const signalBotRows = (page) =>
  page
    .getByRole('table', { name: 'Signal bots' })
    .locator('tbody tr')
    .filter({ hasText: state('title') });

async function signals(page) {
  await signIn(page, state('trader'));
  await page.goto('/trade/bots/signals');
  await expect(page.getByRole('heading', { name: 'Signals', level: 1 })).toBeVisible();
}

test(`${J} #1 tries to create a signal bot from an unpurchased listing: refused as access required`, async ({ page }) => {
  test.setTimeout(300_000);
  // The TEST provider and its listing, published through svc-market's own door.
  const provider = await signUp(page, 'jcsp');
  await verify(page, provider);
  const title = `TEST signal ${Date.now().toString(36)}`;
  const published = await (
    await api(provider)
  ).post(trpcQuery('market', 'signals.publish'), {
    clientListingId: title,
    title,
    description: 'TEST: a signal the TEST provider publishes for this journey, not a real strategy.',
    assetId: 'USDC',
    price: PRICE,
  });
  expect(published.status, JSON.stringify(published.body).slice(0, 300)).toBe(200);
  const trader = await signUp(page, 'jcs');
  await verify(page, trader);
  run.reset({ trader, title, listingId: data(published).id });

  await signals(page);
  await expect(listing(page)).toBeVisible();
  await expect(listing(page)).toContainText(`${PRICE} USDC`);
  await listing(page).getByRole('button', { name: 'Create a bot' }).click();
  await expect(listing(page).getByRole('alert')).toHaveText(/Buy access to this signal first/);
  // Refused before anything was written: the person has no signal bot.
  const bots = await (await api(trader)).get(trpcQuery('trade', 'signals.bots.list'));
  expect(bots.status, JSON.stringify(bots.body).slice(0, 300)).toBe(200);
  expect(data(bots)).toEqual([]);
});

test(`${J} #2 purchases the listing with the TEST partner card, then creates the bot twice with one key: one payment and one bot`, async ({
  page,
}) => {
  const me = await api(state('trader'));
  const ledgerBefore = (await me.get('/api/v1/ledger?limit=200')).body?.entries?.length ?? 0;
  await signals(page);
  await listing(page).getByRole('button', { name: 'Buy access' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(`${PRICE} USDC`);
  await dialog.getByRole('button', { name: 'Buy' }).click();
  await expect(dialog).toBeHidden();
  await expect(listing(page)).toContainText('Access bought');
  await expect(listing(page)).toContainText('TEST partner card');
  await expect(listing(page).getByRole('button', { name: 'Buy access' })).toHaveCount(0);

  // One payment: paid once, by card, through the TEST partner card. Buying again answers the same payment.
  const payments = data(await me.get(trpcQuery('market', 'signals.payments')));
  const mine = payments.filter((p) => p.listingId === state('listingId'));
  expect(mine).toHaveLength(1);
  expect(mine[0]).toMatchObject({ method: 'card', status: 'paid', amount: PRICE, assetId: 'USDC', test: true });
  const again = await me.post(trpcQuery('market', 'signals.buy'), { listingId: state('listingId') });
  expect(again.status, JSON.stringify(again.body).slice(0, 300)).toBe(200);
  expect(data(again).paymentId).toBe(mine[0].paymentId);
  expect(data(await me.get(trpcQuery('market', 'signals.payments'))).filter((p) => p.listingId === state('listingId'))).toHaveLength(1);
  // INTAFACED keeps no prepaid balance: nothing was posted to the buyer's own ledger.
  expect((await me.get('/api/v1/ledger?limit=200')).body?.entries?.length ?? 0).toBe(ledgerBefore);

  // Create a bot pressed twice, with the one key this visit holds: one bot.
  await listing(page).getByRole('button', { name: 'Create a bot' }).dblclick();
  await expect(listing(page).getByRole('status')).toContainText('The bot was created');
  await listing(page).getByRole('button', { name: 'Create a bot' }).click();
  await expect(listing(page).getByRole('status')).toContainText('The bot was created');
  const bots = data(await me.get(trpcQuery('trade', 'signals.bots.list'))).filter((b) => b.listingId === state('listingId'));
  expect(bots).toHaveLength(1);
  await page.goto('/trade/bots?tab=mine');
  await expect(signalBotRows(page)).toHaveCount(1);
});

test(`${J} #3 opens the bot before any signal: "awaiting signal"`, async ({ page }) => {
  await signIn(page, state('trader'));
  await page.goto('/trade/bots?tab=mine');
  await expect(signalBotRows(page)).toHaveCount(1);
  await expect(signalBotRows(page)).toContainText('Awaiting signal');
  await page.goto('/trade/bots/signals');
  await expect(
    page
      .getByRole('table', { name: 'Signal bots' })
      .locator('tbody tr')
      .filter({ hasText: state('title') }),
  ).toContainText('Awaiting signal');
});

test(`${J} #4 a signal arrives for a pair not in one-way mode, and the bot cap is reached: each refused with its code`, async ({
  page,
}) => {
  tool('local-test-world.mjs', 'signal-send', state('listingId'), '--pair', 'ETH/USDT');
  await signIn(page, state('trader'));
  await page.goto('/trade/bots?tab=mine');
  await expect(page.getByRole('row', { name: /Signal/ })).toContainText(/one-way mode/, UNBUILT);
});

test(`${J} #5 opens the bot history after three alerts and two actions: five events in order`, async ({ page }) => {
  await signIn(page, state('trader'));
  await page.goto('/trade/bots?tab=mine');
  await page
    .getByRole('row', { name: /Signal/ })
    .getByRole('button', { name: 'History' })
    .click(UNBUILT);
  await expect(page.getByRole('table', { name: 'Bot history' }).locator('tbody tr')).toHaveCount(5);
});
