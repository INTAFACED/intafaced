// World: book, restart
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { ROOT, api, fromUnits, journeyState, restartService, tool, signOutBrowser, toUnits } from './stack.mjs';
import { fundedTrader, signIn, signUp, verify } from './desk.mjs';
import { listLeader, takeBest } from './copy.mjs';
import { installTestWallet, testWalletKey } from './test-wallet.mjs';
import { PASSKEY_ORIGIN } from './identity-factors.mjs';
import { browserHoldsPasskey, testPasskey } from './p2p.mjs';
import {
  continueInWallet,
  otherTraderKey,
  testDeposit,
  testVenue,
  venueAccount,
  venueBalance,
  venueForThisFile,
  venueInfo,
  venueRecord,
} from './venue.mjs';

// J-copy-bots-otc-01, in the running app (docs/roadmap/journeys.json): follow a lead trader with a fixed amount and see
// the first copied trade. One test per step this build serves, titled "J-copy-bots-otc-01 #<n>", run in order. The
// follower starts signed in and verified, with a TEST wallet whose own account on the stack's LOCAL TEST venue holds
// TEST USDC; the leaders are TEST accounts the stack's TEST founder lists through svc-trade's own operator door. The
// lead's profile trades (#4) are its own fills on the TEST book; the lead's trade that is copied (#8) is its own order on
// the TEST venue, on the lead's own venue account, signed by the lead's own TEST wallet through our door. svc-trade's
// user-venue door is on for this file (venue.mjs `venueForThisFile`): Start copying opens the follow's own agent account
// with the follower's wallet (a venue sub-account under it, with an agent permission that can place and cancel orders
// there and never withdraw), and every copy is a venue order on it; INTAFACED holds and moves none of it (the launch
// money model, OWNER 226). Every figure the TEST venue reports is TEST.
const J = 'J-copy-bots-otc-01';
const RUN = process.env.JOURNEY_RUN_ID ?? 'local';
const run = journeyState(`${J}-${RUN}`);
/** The venue's cash spot market the follow allows (the TEST venue's BTC-USDC). */
const VENUE_MARKET = 'BTC-USDC';
/** A chain-transfer-shaped TEST deposit reference, one per name, so a replay credits nothing. */
const depositRef = (name) => `84532:${keccak256(toHex(`${J} ${RUN} ${name}`))}:0`;

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

/** The leader's share of the fee the stack publishes, as the Rules tab writes it: the TEST profile's basis points as a
 * percent (tooling/profiles/test-owner-values/trade.json). No figure lives in this test. */
const PUBLISHED_SHARE = `${
  JSON.parse(
    JSON.parse(readFileSync(path.join(ROOT, 'tooling/profiles/test-owner-values/trade.json'), 'utf8')).values.TRADE_COPY_FEE_SHARE_LAW
      .value,
  ).leaderShareBps / 100
}%`;

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

/** The return the TEST spot lead discloses (#2), shown on its profile as published (#4). TEST figure. */
const PUBLISHED_RETURN = '12.34';

const TABS = ['Leaders', 'Futures', 'Spot', 'Bots', 'Signal', 'My follows', 'Rules'];

test(`${J} #1 opens Copy trading: every tab, an empty tab says so with no placeholder row, the desk state is read`, async ({ page }) => {
  const follower = await signUp(page, 'jcf');
  await verify(page, follower);
  run.reset({ follower, tag: Date.now().toString(36) });
  await signIn(page, follower);

  await page.goto('/trade/copy');
  await expect(page.getByRole('heading', { name: 'Copy trading', level: 1 })).toBeVisible();
  const tabs = page.getByRole('tablist', { name: 'Copy trading sections' });
  for (const name of TABS) await expect(tabs.getByRole('tab', { name, exact: true })).toBeVisible();

  // No journey ever lists a signal leader, so that tab is the empty directory: the words, and no row at all.
  await tabs.getByRole('tab', { name: 'Signal', exact: true }).click();
  await expect(page).toHaveURL(/tab=signal/);
  await expect(page.getByText('No leaders are listed')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Leaders' }).getByRole('button', { name: /^Follow / })).toHaveCount(0);

  // A control with no back end answers with a typed refusal, never a dead button: a ranked list is not offered, so
  // pressing one asks the service, which refuses by code, and the room says so in words.
  await tabs.getByRole('tab', { name: 'Leaders', exact: true }).click();
  const ranked = page.getByRole('group', { name: 'Ranked lists' }).getByRole('button', { name: 'Top return' });
  await expect(ranked).toBeEnabled();
  const ranking = page.waitForResponse((res) => res.url().includes('copy.listLeaders') && res.url().includes('category'));
  await ranked.click();
  expect((await ranking).status()).toBe(403);
  await expect(page.getByRole('alert').filter({ hasText: 'Rankings aren’t offered' })).toBeVisible();
  await expect(page.getByText('Reference trade.copy_ranking_forbidden')).toBeVisible();

  // The desk state comes from the service (TEST fee share and country list are published on this stack).
  await expect(page.getByText('Copy desk open')).toBeVisible();
  await tabs.getByRole('tab', { name: 'Rules', exact: true }).click();
  await expect(page.getByText(PUBLISHED_SHARE)).toBeVisible();
});

test(`${J} #2 chooses the Futures tab and searches a name: only futures leaders, matched on the server in any case`, async ({ page }) => {
  // Funding the leader on the TEST book takes most of a minute.
  test.setTimeout(240_000);
  const tag = state('tag');
  const leader = await fundedTrader(page, 'jcl', '1000');
  const spotName = `Journey Spot ${tag}`;
  const futuresName = `Journey Futures ${tag}`;
  // The spot lead discloses a TEST return; its drawdown stays unpublished, for #4. It trades the TEST book (#4) and the
  // venue's market (#8), so with the venue door on its Start copying copies on the venue.
  const spotRef = await listLeader(leader, spotName, {
    tenureStart: '2026-01-01T00:00:00.000Z',
    assets: ['BTC/USDT', VENUE_MARKET],
    published: { publishedReturn: PUBLISHED_RETURN },
  });
  const futuresLeader = await signUp(page, 'jcx');
  await listLeader(futuresLeader, futuresName, { marketMode: 'futures' });
  // The spot lead's own TEST wallet, with TEST USDC in its own venue account for #8's trade, which the lead signs through
  // our door: svc-trade reads a lead's fills only from venue accounts the lead signed for there.
  const leadName = `${J} lead ${RUN} ${tag}`;
  const leadOwner = otherTraderKey(leadName).address.toLowerCase();
  await testDeposit(leadOwner, 'USDC', '1000', depositRef('lead'));
  run.write({ leader, spotName, spotRef, futuresName, leadName, leadOwner });

  await signOutBrowser(page.context());
  await signIn(page, state('follower'));
  await page.goto('/trade/copy?tab=futures');
  const table = page.getByRole('table', { name: 'Leaders' });
  await expect(table.getByRole('link', { name: futuresName })).toBeVisible();
  await expect(table.getByRole('link', { name: spotName })).toHaveCount(0);

  // The search goes to the service with the tab's market: the screen does not filter a second time.
  const answered = page.waitForResponse((res) => {
    if (!res.url().includes('copy.listLeaders')) return false;
    const input = JSON.parse(new URL(res.url()).searchParams.get('input') ?? '{}');
    return input.marketMode === 'futures' && input.q === `futures ${tag}`.toUpperCase();
  });
  await page.getByLabel('Search leaders').fill(`futures ${tag}`.toUpperCase());
  // The server's own answer to the uppercased name: exactly the futures leader, matched in any case.
  const answer = await answered;
  expect(answer.status()).toBe(200);
  const listed = (await answer.json()).result.data.leaders;
  expect(listed.map((l) => l.displayName)).toEqual([futuresName]);
  expect(listed.map((l) => l.marketMode)).toEqual(['futures']);
  // The screen shows that answer: one row, the futures leader.
  await expect(table.getByRole('link', { name: futuresName })).toBeVisible();
  await expect(table.locator('tbody tr')).toHaveCount(1);

  // The same search on the Spot tab finds no futures leader.
  await page.goto('/trade/copy?tab=spot');
  await page.getByLabel('Search leaders').fill(`FUTURES ${tag}`);
  await expect(page.getByText('No leader matches that name')).toBeVisible();
  await page.getByLabel('Search leaders').fill(`spot ${tag}`);
  await expect(table.getByRole('link', { name: spotName })).toBeVisible();
});

test(`${J} #3 opens a ranked category and the trending row: a typed refusal, and no returns-ranked board`, async ({ page }) => {
  await signIn(page, state('follower'));
  await page.goto('/trade/copy');
  const rankings = page.getByRole('group', { name: 'Ranked lists' });
  const leaders = page.getByRole('table', { name: 'Leaders' });
  await expect(leaders).toBeVisible();
  // The list as read once it has loaded: while it loads, the table is busy and its rows are the "Loading" placeholder
  // (#7000: #3 once read that placeholder as the order before the clicks).
  const order = async (when) => {
    await expect(leaders, `the leader list ${when} is still loading`).not.toHaveAttribute('aria-busy', 'true');
    return (await leaders.locator('tbody tr').allInnerTexts()).map((row) => row.trim());
  };
  // The order compared is real leader rows (#2 listed two), not an error or empty row compared with itself.
  await expect(leaders.getByRole('button', { name: /^Follow / }).first()).toBeVisible();
  const before = await order('before the clicks');
  for (const name of ['Top return', 'Trending']) {
    const answer = page.waitForResponse(
      (res) => res.url().includes('copy.listLeaders') && res.url().includes(name === 'Trending' ? 'trending' : 'category'),
    );
    await rankings.getByRole('button', { name }).click();
    expect((await answer).status()).toBe(403);
    await expect(page.getByRole('alert').filter({ hasText: 'Rankings aren’t offered' })).toBeVisible();
    await expect(page.getByText('Reference trade.copy_ranking_forbidden')).toBeVisible();
    // No returns-ranked board: the only table is still the plain leader list, in the same order, with no rank column.
    await expect(page.getByRole('table')).toHaveCount(1);
    expect(await order(`after ${name}`), `the leader list after ${name}`).toEqual(before);
    await expect(leaders.getByRole('columnheader', { name: /rank/i })).toHaveCount(0);
  }
});

test(`${J} #4 opens a lead profile: metrics only with a definition, and the lead's real trades with entry, margin, TP/SL, close and ROI`, async ({
  page,
}) => {
  const tag = state('tag');
  // The lead trades on the TEST book at the best price: two buys, then a sell that closes the first one. The taker fee
  // is paid in the bought asset, so the second buy is what lets the sell close the first in full.
  const leader = state('leader');
  const closedBuy = await takeBest(leader, 'buy', '0.001', `${J}-4-buy-${tag}`);
  const openBuy = await takeBest(leader, 'buy', '0.0005', `${J}-4-open-${tag}`);
  const sell = await takeBest(leader, 'sell', '0.001', `${J}-4-sell-${tag}`);
  // What each row must show, from the leader's own fills (not from the profile read): spot margin is the quote paid, the
  // entry and close are quote over amount, and the return is (close − entry) / entry.
  // The ledger settles a fill a moment after the order reads filled, so the read waits until all three orders' fills are in.
  const leaderApi = await api(leader);
  let fills = [];
  await expect
    .poll(
      async () => {
        const { status, body } = await leaderApi.get(`/api/v1/account/trades?symbol=${encodeURIComponent('BTC/USDT')}&limit=100`);
        expect(status).toBe(200);
        fills = Array.isArray(body) ? body : (body.trades ?? []);
        return [closedBuy, openBuy, sell].every((order) => fills.some((f) => f.order === order.id));
      },
      { timeout: 30_000, message: "the leader's three orders each have their fills" },
    )
    .toBe(true);
  const summed = (order) => {
    const own = fills.filter((f) => f.order === order.id);
    const quote = own.reduce((sum, f) => sum + toUnits(f.cost), 0n);
    const qty = own.reduce((sum, f) => sum + toUnits(f.amount), 0n);
    expect(fromUnits(qty), `the fills of order ${order.id} add up to the order`).toBe(fromUnits(toUnits(order.filled)));
    return { quote, price: (quote * 10n ** 18n) / qty };
  };
  const [closedIn, openIn, out] = [summed(closedBuy), summed(openBuy), summed(sell)];

  await signIn(page, state('follower'));
  await page.goto('/trade/copy?tab=spot');
  await page.getByLabel('Search leaders').fill(`spot ${tag}`);
  await page
    .getByRole('table', { name: 'Leaders' })
    .getByRole('link', { name: state('spotName') })
    .click();
  await expect(page).toHaveURL(new RegExp(`/trade/copy/${state('spotRef')}$`));
  await expect(page.getByRole('heading', { name: state('spotName'), level: 1 })).toBeVisible();

  // Disclosed performance: the return the listing published, as published, with its TEST definition; the drawdown it
  // did not publish reads Not published, never a number.
  const metric = (key) => page.locator(`[data-testid="cb-metric"][data-metric=${key}]`);
  await expect(metric('publishedReturn').locator('strong')).toHaveText(`${PUBLISHED_RETURN}%`);
  await expect(metric('publishedReturn')).toContainText('TEST definition');
  await expect(metric('maximumDrawdown').locator('strong')).toHaveText('Not published');
  await expect(metric('maximumDrawdown')).toContainText('TEST definition');
  // No definition is published for these, so no number is shown.
  await expect(metric('winRate')).toHaveText(/Win rate\s*Not set by the platform/);
  await expect(metric('sharpeRatio')).toHaveText(/Sharpe ratio\s*Not set by the platform/);

  const trades = page.getByRole('table', { name: 'Leader trades' });
  const rows = trades.locator('tbody tr');
  await expect(rows).toHaveCount(2);
  // Newest first: the open buy, then the closed round trip.
  await expect(rows.nth(0)).toContainText('Open');
  await expect(rows.nth(0)).toContainText('Still open');
  await expect(rows.nth(1)).toContainText('Closed');
  await expect(rows.nth(1)).toContainText(/[−]?\d+\.\d\d%/);
  const headers = (await trades.locator('thead th').allInnerTexts()).map((h) => h.trim());
  for (const header of ['Entry price', 'Margin', 'TP / SL', 'Close price', 'Return before fees']) {
    expect(headers, `the trade table has a ${header} column`).toContain(header);
  }
  const cell = async (row, header) => (await rows.nth(row).locator('td').nth(headers.indexOf(header)).innerText()).trim();
  const amountOf = (text) => toUnits(text.replace(/,/g, '').replace('−', '-'));
  // Within one unit of the eighth place: the service floors its division, this side truncates.
  const near = (shown, expected, what) =>
    expect(
      Math.abs(Number(amountOf(shown) - expected)),
      `${what}: shown ${shown}, from the fills ${fromUnits(expected)}`,
    ).toBeLessThanOrEqual(1e10);
  // Neither trade carried a TP or SL: the TP / SL cell of each says so.
  expect(await cell(0, 'TP / SL')).toBe('None set');
  expect(await cell(1, 'TP / SL')).toBe('None set');
  // The open buy: its own entry and margin, no close.
  near(await cell(0, 'Entry price'), openIn.price, 'open row entry');
  expect(amountOf(await cell(0, 'Margin')), 'open row margin is the quote paid').toBe(openIn.quote);
  expect(await cell(0, 'Close price')).toBe('Still open');
  // The round trip: the first buy's entry and margin, the sell's close, and the return between them.
  near(await cell(1, 'Entry price'), closedIn.price, 'closed row entry');
  expect(amountOf(await cell(1, 'Margin')), 'closed row margin is the quote paid').toBe(closedIn.quote);
  near(await cell(1, 'Close price'), out.price, 'closed row close');
  // The return as the service computes it (18 places, half up), then shown to the cent, half up, as the room does.
  const diff = (out.price - closedIn.price) * 100n * 10n ** 18n;
  const half = closedIn.price / 2n;
  const roi18 = diff >= 0n ? (diff + half) / closedIn.price : -((-diff + half) / closedIn.price);
  const roiAbs = roi18 < 0n ? -roi18 : roi18;
  const roiCents = roiAbs / 10n ** 16n + ((roiAbs / 10n ** 15n) % 10n >= 5n ? 1n : 0n);
  const roiShown = `${roi18 < 0n && roiCents > 0n ? '−' : ''}${roiCents / 100n}.${String(roiCents % 100n).padStart(2, '0')}%`;
  expect(await cell(1, 'Return before fees'), 'the return, from the fills').toBe(roiShown);

  // An unknown leader page is a typed not-found, never an empty profile.
  await page.goto('/trade/copy/no-such-leader');
  await expect(page.getByText('That leader was not found')).toBeVisible();
});

/** A permission end a week ahead, in the datetime-local box's own format. */
function weekAhead() {
  const when = new Date(Date.now() + 7 * 24 * 3600_000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(when.getHours())}:${pad(when.getMinutes())}`;
}

/** The TEST wallet in this page, once per page, before the app's scripts run: `key` is the person's own TEST key. */
const wallets = new WeakMap();
async function walletIn(page, key = state('walletKey')) {
  if (!wallets.has(page)) wallets.set(page, await installTestWallet(page, { chainId: (await venueInfo()).chainId, privateKey: key }));
  return wallets.get(page);
}

/**
 * Start copying from the lead page, through the country and market steps, to the limits step, with the person's TEST
 * wallet connected there (the venue account the follow is on).
 */
async function openWizardAtLimits(page, key) {
  const wallet = await walletIn(page, key);
  await page.goto(`/trade/copy/${state('spotRef')}`);
  await page.getByRole('button', { name: 'Start copying' }).click();
  const wizard = page.getByRole('dialog');
  await expect(wizard.getByText(state('spotName'))).toBeVisible();
  await wizard.getByLabel('Your country').fill('DE');
  await wizard.getByRole('button', { name: 'Next' }).click();
  await wizard.getByText(VENUE_MARKET, { exact: true }).click();
  await wizard.getByRole('button', { name: 'Next' }).click();
  // Connected already when this page connected the wallet before (the wallet keeps its connection for the page).
  const connect = wizard.getByRole('button', { name: 'Connect TEST Wallet' });
  const address = wizard.getByTestId('venue-wallet-address');
  await expect(connect.or(address)).toBeVisible();
  if (await connect.isVisible()) await connect.click();
  await expect(address).toHaveText(wallet.address);
  return wizard;
}

/** A Start copying request on the venue as copy.checkVenueFollow takes it (svc-trade copy-service.ts). */
const venueStart = (over = {}) => ({
  leaderRef: state('spotRef'),
  region: 'DE',
  permittedMarkets: [VENUE_MARKET],
  maxNotionalPerOrder: '50',
  maxAggregateExposure: '200',
  fixedOrderSize: '20',
  expiresAt: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
  ...over,
});

async function fillLimits(wizard, { perOrder, total, fixed }) {
  await wizard.getByLabel('Most per order (USDC)').fill(perOrder);
  await wizard.getByLabel('Most in total (USDC)').fill(total);
  await wizard.getByLabel('Fixed amount per copied order (USDC)').fill(fixed);
  await wizard.getByLabel('Permission ends').fill(weekAhead());
}

test(`${J} #5 presses Start copying: below the copy verification level, under a blank country list and as a sub-account, each refused by name, and nothing is followed`, async ({
  page: first,
}) => {
  // The person below the copy level uses this page with their own TEST wallet; the follower then gets a new page in the
  // same browser, so the follower's own wallet is the one the wizard connects.
  let page = first;
  // Signing up and funding a new account takes most of a minute, and the country-list restart two more.
  test.setTimeout(420_000);
  // The follower's own TEST wallet, and TEST USDC in its own account on the venue (the journey's start), for #6 to #8.
  const walletKey = testWalletKey();
  const owner = privateKeyToAccount(walletKey).address.toLowerCase();
  run.write({ walletKey, owner });
  await testDeposit(owner, 'USDC', '1000', depositRef('follower'));
  // Verified at basic, which opens the copy room, but the TEST copy level is full.
  const unverified = await signUp(page, 'jcn');
  await page.goto('/verification');
  await page.getByLabel('Level to request').selectOption({ label: 'Basic' });
  await page.getByLabel('Country code').fill('DE');
  await page.getByRole('button', { name: 'Review request' }).click();
  await page.getByRole('button', { name: 'Submit this request' }).click();
  await expect(page.getByText('Your reviewed request')).toBeVisible();
  tool('local-test-gates.mjs', 'verify');
  // Their own TEST wallet with TEST USDC on the venue, so the wizard's own free-balance check passes.
  const unverifiedKey = testWalletKey();
  const unverifiedOwner = privateKeyToAccount(unverifiedKey).address.toLowerCase();
  await testDeposit(unverifiedOwner, 'USDC', '1000', depositRef('basic'));
  await signOutBrowser(page.context());
  await signIn(page, unverified);
  const wizard = await openWizardAtLimits(page, unverifiedKey);
  await fillLimits(wizard, { perOrder: '50', total: '200', fixed: '20' });
  await wizard.getByRole('button', { name: 'Next' }).click();
  const answer = page.waitForResponse((res) => res.url().includes('copy.checkVenueFollow'));
  await wizard.getByRole('button', { name: 'Start copying' }).click();
  expect((await answer).status()).toBe(403);
  await expect(wizard.getByRole('alert').filter({ hasText: 'More verification needed' })).toBeVisible();
  await expect(wizard.getByText('Reference trade.tier_insufficient')).toBeVisible();

  // Nothing was written: no follow, no copy permission on the venue, and the venue balance is untouched.
  await page.keyboard.press('Escape');
  await page.goto('/trade/copy?tab=follows');
  await expect(page.getByText('You aren’t following anyone')).toBeVisible();
  expect((await venueBalance(unverifiedOwner, 'USDC')).free, 'the venue balance is untouched').toBe('1000');
  expect((await venueRecord(unverifiedOwner, '/agents')).value, 'no copy permission was asked for').toEqual([]);
  expect((await venueRecord(unverifiedOwner, '/sub-accounts')).value, 'no agent account was opened on the venue').toEqual([]);
  expect(await agentAccounts(await api(unverified)), 'no agent account was made').toEqual([]);

  page = await first.context().newPage();

  // A blank country list refuses every follow, a verified person's too, and writes nothing. The follower's venue account
  // holds TEST USDC (#1), so the wizard's own free-balance check passes and the press reaches the service.
  const follower = state('follower');
  const me = await api(follower);
  const followsBefore = await myFollows(me);
  try {
    await copyCountries('blank');
    const refused = await (
      await api(follower)
    ).post('/api/trade/trpc/copy.checkVenueFollow', venueStart({ clientRequestId: `journey-blank-countries:${state('tag')}` }));
    expect(
      refused.body?.error?.data?.cause?.code ?? refused.body?.error?.data?.intafacedCode,
      JSON.stringify(refused.body).slice(0, 300),
    ).toBe('trade.copy_jurisdiction_blank');
    expect(await myFollows(await api(follower)), 'no follow was started under a blank country list').toEqual(followsBefore);
    await signIn(page, follower);
    await page.goto('/trade/copy');
    await expect(page.getByRole('heading', { name: 'Copy trading', level: 1 })).toBeVisible();
    await expect(page.getByText('Copy desk closed')).toBeVisible();
    await expect(page.getByText('Copy desk open')).toHaveCount(0);
    // The wizard checks the same gate when Start copying is pressed: refused by name, and nothing is followed.
    const closed = await openWizardAtLimits(page);
    await fillLimits(closed, { perOrder: '50', total: '200', fixed: '20' });
    await closed.getByRole('button', { name: 'Next' }).click();
    const blankAnswer = page.waitForResponse((res) => res.url().includes('copy.checkVenueFollow'));
    await closed.getByRole('button', { name: 'Start copying' }).click();
    expect((await blankAnswer).status()).toBe(412);
    await expect(closed.getByRole('alert').filter({ hasText: 'Copy trading isn’t open for your country' })).toBeVisible();
    await expect(closed.getByText('Reference trade.copy_jurisdiction_blank')).toBeVisible();
    await page.keyboard.press('Escape');
    expect(await myFollows(await api(follower)), 'no follow was started from the wizard under a blank country list').toEqual(followsBefore);
  } finally {
    await copyCountries('set');
  }

  // A sub-account is refused: the verified follower creates one of their own sub-accounts in the account room and uses
  // it in this tab, and the same press of Start copying is refused by name, as that sub-account, and writes nothing.
  await signIn(page, follower);
  await page.goto('/uc/account');
  const subLabel = `Copy ${state('tag')}`;
  const create = page.getByTestId('subaccounts__create');
  await create.getByLabel('Label').fill(subLabel);
  await create.getByRole('button', { name: 'Review subaccount' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Create subaccount' }).click();
  await expect(page.getByTestId('subaccounts__request').last()).toContainText('The service created the original strategy subaccount.');
  const row = page.locator('li.subaccounts__row').filter({ has: page.getByText(subLabel, { exact: true }) });
  const use = row.getByRole('button', { name: /^Use sub-account / });
  await expect(use).toBeEnabled();
  const subAccountId = (await use.getAttribute('aria-label')).replace('Use sub-account ', '').toLowerCase();
  await use.click();
  const inUse = page.getByRole('region', { name: 'Sub-account in use' });
  await expect(inUse).toContainText(`You are using sub-account ${subLabel} in this tab.`);
  await expect(inUse).toContainText(subAccountId);

  const mainBefore = await venueBalance(state('owner'), 'USDC');
  // The copy room, loaded as a new page, still acts as the sub-account (checked before the wizard's dialog hides the
  // rest of the page from the accessibility tree).
  await page.goto(`/trade/copy/${state('spotRef')}`);
  await expect(inUse, 'the copy room is opened as the sub-account').toContainText(subAccountId);
  const asSub = await openWizardAtLimits(page);
  await fillLimits(asSub, { perOrder: '50', total: '200', fixed: '20' });
  await asSub.getByRole('button', { name: 'Next' }).click();
  const subAnswer = page.waitForResponse((res) => res.url().includes('copy.checkVenueFollow'));
  await asSub.getByRole('button', { name: 'Start copying' }).click();
  const subRes = await subAnswer;
  // The press went out as the sub-account: its token names the sub-account the person chose.
  const bearer = (await subRes.request().headerValue('authorization'))?.replace(/^Bearer /, '') ?? '';
  const claims = JSON.parse(Buffer.from(bearer.split('.')[1] ?? '', 'base64url').toString('utf8') || '{}');
  expect(claims.sub_account, 'the Start copying request carries the sub-account').toBe(subAccountId);
  expect(subRes.status()).toBe(403);
  await expect(asSub.getByRole('alert').filter({ hasText: 'Sub-accounts can’t copy' })).toBeVisible();
  await expect(asSub.getByText('Reference trade.copy_subaccount_refused')).toBeVisible();

  // Nothing was written: no follow on the account, no copy permission on the venue, and the venue balance is untouched.
  await page.keyboard.press('Escape');
  expect(await myFollows(await api(follower)), 'no follow was started by the sub-account').toEqual(followsBefore);
  expect(await venueBalance(state('owner'), 'USDC'), 'nothing was set aside').toEqual(mainBefore);
  expect((await venueRecord(state('owner'), '/agents')).value, 'no copy permission was asked for').toEqual([]);
  expect((await venueRecord(state('owner'), '/sub-accounts')).value, 'no agent account was opened on the venue').toEqual([]);
  expect(await agentAccounts(await api(follower)), 'no agent account was made').toEqual([]);

  // Back to the main account in the same tab.
  await inUse.getByRole('button', { name: 'Switch back to the main account' }).click();
  await expect(inUse).toHaveCount(0);
});

/** Restart trade with the copy country list blank (`blank`) or as the TEST profile sets it (`set`), by its stack switch. */
const copyCountries = (state) =>
  // The user-venue door stays on for this file across the restart (venueForThisFile).
  restartService('trade', { LOCAL_STACK_TRADE_COPY_JURISDICTION: state === 'blank' ? 'blank' : undefined, LOCAL_STACK_USER_VENUE: 'on' });

// Step 6 was "reads and accepts the copy disclosure". Deferred until launch prep (owner decision 2026-10-27): no risk
// disclosure is asked for, so this step proves the review asks for none and Start is on once the limits are valid.
test(`${J} #6 reaches the review with no risk disclosure to accept, and Start copying is on`, async ({ page }) => {
  const follower = state('follower');
  await signIn(page, follower);
  const wizard = await openWizardAtLimits(page);
  await fillLimits(wizard, { perOrder: '50', total: '200', fixed: '20' });
  await wizard.getByRole('button', { name: 'Next' }).click();

  await expect(wizard.getByRole('region', { name: 'What it costs' })).toBeVisible();
  await expect(wizard.getByRole('region', { name: 'Copy risk disclosure' })).toHaveCount(0);
  await expect(wizard.getByRole('checkbox', { name: /disclosure/ })).toHaveCount(0);
  await expect(wizard.getByRole('button', { name: 'Start copying' })).toBeEnabled();
});

const codeOf = (res) => res.body?.error?.data?.cause?.code ?? res.body?.error?.data?.intafacedCode;

/** The person's agent accounts as svc-trade lists them to their owner (an ended one is not listed). */
async function agentAccounts(me) {
  const res = await me.get('/api/v1/venue/agent-accounts');
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.accounts;
}

/** Our builder fee as the venue status names it; null when the owner set none. */
async function builderOf(me) {
  const res = await me.get('/api/v1/venue/status');
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.builder ?? null;
}

/**
 * Answers every "Check before you sign" sheet the page shows with Continue in wallet, until `done` settles: the wallet
 * then signs or rejects as it was told. Returns how many it answered.
 */
async function walletAnswers(page, done) {
  const sheet = page.getByRole('dialog', { name: 'Check before you sign' });
  let finished = false;
  done.then(
    () => (finished = true),
    () => (finished = true),
  );
  let answered = 0;
  while (!finished && answered < 8) {
    const shown = await sheet
      .waitFor({ state: 'visible', timeout: 1_000 })
      .then(() => true)
      .catch(() => false);
    if (!shown) continue;
    await continueInWallet(page);
    answered += 1;
  }
  return answered;
}

test(`${J} #7 enters a fixed amount and starts: zero, above the per-order cap and above the venue's free USDC refused; the wallet signs the agent permission for this follow, which places and cancels and never withdraws; a rejected signature leaves no follow; the same key is the same follow; nothing is held by INTAFACED`, async ({
  browser,
}) => {
  test.setTimeout(420_000);
  const follower = state('follower');
  const owner = state('owner');
  const me = await api(follower);
  const venue = await venueInfo();
  const before = await venueBalance(owner, 'USDC');
  expect((await venueRecord(owner, '/sub-accounts')).value, 'no agent account before the follow').toEqual([]);

  // The service itself refuses each amount the screen refuses below, by its typed code, before anything is written: a
  // zero fixed amount, and one above the most per order.
  for (const [over, code] of [
    [{ fixedOrderSize: '0' }, 'trade.copy_envelope_invalid'],
    [{ fixedOrderSize: '60' }, 'trade.copy_fixed_size_above_cap'],
  ]) {
    const refused = await me.post(
      '/api/trade/trpc/copy.checkVenueFollow',
      venueStart({ clientRequestId: `${J}-7-refused-${Date.now()}`, ...over }),
    );
    expect(codeOf(refused), JSON.stringify(refused.body).slice(0, 300)).toBe(code);
  }
  expect(await myFollows(me), 'no follow was started by a refused request').toEqual([]);
  expect(await agentAccounts(me), 'no agent account was made by a refused request').toEqual([]);

  // The person confirms it's them with their own TEST passkey, held by the browser on the passkey origin.
  const passkey = await testPasskey(me);
  const context = await browser.newContext({ baseURL: PASSKEY_ORIGIN });
  try {
    const page = await context.newPage();
    const wallet = await walletIn(page);
    /** What the wallet was asked to sign, in order. */
    const signs = () => wallet.requests.filter((r) => r.method === 'eth_signTypedData_v4');
    await browserHoldsPasskey(page, passkey.saved());
    await signIn(page, follower);
    const wizard = await openWizardAtLimits(page);
    await expect(wizard.getByText(`${before.free} USDC`).or(wizard.getByText(/1,000 USDC/))).toBeVisible();
    await fillLimits(wizard, { perOrder: '50', total: '200', fixed: '0' });
    await wizard.getByRole('button', { name: 'Next' }).click();
    await expect(wizard.getByText('Enter an amount above zero')).toBeVisible();
    await wizard.getByLabel('Fixed amount per copied order (USDC)').fill('60');
    await wizard.getByRole('button', { name: 'Next' }).click();
    await expect(wizard.getByText('The most per order is 50 USDC')).toBeVisible();
    // Above the free USDC the venue reports: refused on the screen, naming the venue's figure and its as-of time.
    await wizard.getByLabel('Most per order (USDC)').fill('5000');
    await wizard.getByLabel('Fixed amount per copied order (USDC)').fill('5000');
    await wizard.getByLabel('Most in total (USDC)').fill('5000');
    await wizard.getByRole('button', { name: 'Next' }).click();
    const refusal = wizard.getByText(
      new RegExp(`more than the 1,?000 USDC free that ${venue.displayName} reports for your account, as of `),
    );
    await expect(refusal).toBeVisible();
    // The as-of time is the venue's own read of that balance: the same instant the balance line above names.
    const asOf = (await refusal.innerText()).split(', as of ')[1].trim();
    await expect(wizard.getByText(`As the venue reports it, as of ${asOf}`)).toBeVisible();
    const when = new Date(asOf);
    expect(Number.isNaN(when.getTime()), `the as-of time ${asOf} is a time`).toBe(false);
    expect(Math.abs(Date.now() - when.getTime()), 'read within the last few minutes').toBeLessThan(10 * 60_000);
    // The fixed amount is the follow's cap: no copy may go past 20 USDC, each copy or in total.
    await fillLimits(wizard, { perOrder: '20', total: '20', fixed: '20' });
    await wizard.getByRole('button', { name: 'Next' }).click();
    await expect(wizard.getByRole('region', { name: 'Copy permission' })).toContainText(
      'The permission can place and cancel orders there and can never withdraw',
    );
    expect(signs(), 'nothing is asked of the wallet to sign before Start copying').toEqual([]);

    // Start copying, confirmed with the passkey: the wallet is asked to open the follow's agent account. Rejected, it is
    // never sent: the account is ended, nothing moved, and there is no follow.
    wallet.rejectNext();
    await wizard.getByRole('button', { name: 'Start copying' }).click();
    await page.getByTestId('step-up-confirm').getByRole('button', { name: 'Use a passkey' }).click();
    await continueInWallet(page);
    await expect(page.getByRole('dialog').getByRole('alert').filter({ hasText: 'Your wallet did not sign' })).toBeVisible();
    expect(await myFollows(me), 'a rejected signature leaves no follow').toEqual([]);
    expect(await agentAccounts(me), 'a rejected signature makes no agent account').toEqual([]);
    expect((await venueRecord(owner, '/sub-accounts')).value, 'a rejected signature opens nothing on the venue').toEqual([]);
    expect(await venueBalance(owner, 'USDC'), 'a rejected signature moves nothing').toEqual(before);
    const asked = signs().length;
    expect(asked, 'the wallet was asked once, and rejected it').toBe(1);

    // Pressed again and confirmed: the wallet signs each step the agent account asks (the sub-account, the agent
    // permission, the move of the most in total into it) and our builder fee on it. The answer to the follow itself is
    // lost on the way back: the screen does not know the follow exists. A second press is the same request, under the
    // same key: it returns the same follow, now active, and asks the wallet and the passkey for nothing more.
    const builder = await builderOf(me);
    const followBodies = [];
    let lost;
    const answerLost = new Promise((resolve) => (lost = resolve));
    const isFollow = (url) => new URL(url).pathname.endsWith('/copy.follow');
    await page.route(isFollow, async (route) => {
      followBodies.push(route.request().postData());
      await route.fetch();
      await route.abort('connectionreset');
      lost();
    });
    await wizard.getByRole('button', { name: 'Start copying' }).click();
    await page.getByTestId('step-up-confirm').getByRole('button', { name: 'Use a passkey' }).click();
    const signed = await walletAnswers(page, answerLost);
    await answerLost;
    expect(signed, 'one signature per agent-account step, and one for our builder fee when the owner set one').toBe(builder ? 4 : 3);
    expect(signs().length).toBe(asked + signed);
    await expect(wizard.getByRole('button', { name: 'Start copying' })).toBeEnabled();
    await expect(page).not.toHaveURL(/tab=follows/);
    await page.unroute(isFollow);
    const second = page.waitForResponse((res) => isFollow(res.url()));
    await wizard.getByRole('button', { name: 'Start copying' }).click();
    const secondAnswer = await (await second).json();
    followBodies.push((await second).request().postData());
    await expect(page).toHaveURL(/tab=follows/);
    expect(signs().length, 'the second press asked the wallet for nothing').toBe(asked + signed);
    await expect(page.getByTestId('step-up-confirm'), 'nor for the passkey').toHaveCount(0);
    expect(followBodies[1], 'the second press is the same request, under the same key').toBe(followBodies[0]);

    const follows = await myFollows(me);
    expect(follows, 'one follow from the two presses').toHaveLength(1);
    const [spot] = follows;
    expect(JSON.stringify(secondAnswer)).toContain(spot.followId);
    expect(spot.leaderRef).toBe(state('spotRef'));
    expect(spot.relationshipState).toBe('ACTIVE');
    expect(spot.fixedOrderSize, 'the fixed amount').toBe('20');
    expect(spot.maxNotionalPerOrder, 'the fixed amount is the cap on each copy').toBe('20');
    expect(spot.maxAggregateExposure, 'the fixed amount is the cap in total').toBe('20');
    // Nothing is held by INTAFACED: no reserve of ours.
    expect(spot.reserve ?? null, 'no reserve is held').toBeNull();
    const row = page.getByRole('grid', { name: 'My follows' }).getByRole('rowgroup').nth(1).getByRole('row');
    await expect(row).toHaveCount(1);
    await row.first().getByRole('button', { name: 'Manage' }).click();
    const detail = page.getByRole('dialog');
    await expect(detail).toContainText('20 USDC');
    await expect(detail.getByText('Reserved for this copy').locator('..')).toContainText('Not set');

    // The follow's agent account: the person's own, open, capped at the fixed amount, holding the 20 USDC their own wallet
    // moved from their main venue account, as the venue reports both. Nothing else moved.
    const [account, ...more] = await agentAccounts(me);
    expect(more, 'one agent account, made once').toEqual([]);
    expect(account).toMatchObject({ status: 'open', owner, asset: 'USDC', next: null });
    expect(toUnits(account.cap)).toBe(toUnits('20'));
    const sub = account.subAccount;
    expect(sub, 'a venue sub-account under the wallet').toBeTruthy();
    expect((await venueRecord(owner, '/sub-accounts')).value.map((s) => s.subAccount)).toEqual([sub]);
    const moved = await venueBalance(owner, 'USDC');
    expect(toUnits(moved.free), 'the main venue account fell by exactly the 20 USDC moved').toBe(toUnits(before.free) - toUnits('20'));
    const onSub = (await venueRecord(owner, '/balances', {}, undefined, sub)).value.find((b) => b.asset === 'USDC');
    expect(toUnits(onSub.total), 'the agent account holds the 20 USDC, as the venue reports it').toBe(toUnits('20'));

    // The permission the wallet signed is on the venue's own record of that sub-account: one agent, which the venue lets
    // place and cancel orders and refuses a withdrawal.
    const agents = (await venueRecord(owner, '/agents', {}, undefined, sub)).value;
    expect(agents).toHaveLength(1);
    const agent = agents[0].address.toLowerCase();
    expect(
      signs().some((r) => JSON.stringify(JSON.parse(r.params[1]).message).toLowerCase().includes(agent.slice(2))),
      'the wallet signed that agent',
    ).toBe(true);
    const withdraw = await testVenue('/prepare', {
      account: { ...(await venueAccount(owner)), subAccount: sub },
      signer: { role: 'agent', address: agent },
      intent: { kind: 'withdraw', asset: 'USDC', amount: '1', destination: agent, withdrawalKey: `withdraw:${state('tag')}` },
    });
    expect(withdraw.status, JSON.stringify(withdraw.body).slice(0, 300)).not.toBe(200);
    expect(JSON.stringify(withdraw.body), 'the venue refuses the agent permission a withdrawal').toContain('agent_not_permitted');

    // The same request sent again by the API the screen uses is the same follow, and the check answers that follow.
    const again = await me.post('/api/trade/trpc/copy.follow', JSON.parse(followBodies[0]));
    expect(again.status, JSON.stringify(again.body).slice(0, 300)).toBe(200);
    expect(JSON.stringify(again.body)).toContain(spot.followId);
    const checked = await me.post('/api/trade/trpc/copy.checkVenueFollow', JSON.parse(followBodies[0]));
    expect(checked.status, JSON.stringify(checked.body).slice(0, 300)).toBe(200);
    expect(JSON.stringify(checked.body)).toContain(spot.followId);
    expect(await myFollows(me), 'still one follow').toHaveLength(1);
    run.write({ agentAddress: agent, subAccount: sub, followId: spot.followId, followedAt: new Date().toISOString() });
  } finally {
    await context.close();
  }
});

/** The follower's follows as svc-trade reads them back to their owner. */
async function myFollows(me) {
  const res = await me.get(`/api/trade/trpc/copy.listMyFollows?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

/** The lead's own wallet signs one action on its own venue account, through our door, and the venue accepts it. */
async function leadActs(intent, actionKey = null) {
  const key = otherTraderKey(state('leadName'));
  const owner = key.address.toLowerCase();
  const session = await api(state('leader'));
  const prepared = await session.post('/api/v1/venue/prepare', {
    owner,
    subAccount: null,
    signer: { role: 'owner', address: owner },
    intent,
    actionKey,
  });
  expect(prepared.status, JSON.stringify(prepared.body).slice(0, 300)).toBe(200);
  const t = prepared.body.prepared.typedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  const sent = await session.post('/api/v1/venue/submit', {
    actionKey: prepared.body.actionKey,
    signature: { digest: prepared.body.prepared.digest, signature, signedBy: owner },
  });
  expect(sent.status, JSON.stringify(sent.body).slice(0, 300)).toBe(200);
  expect(sent.body.outcome, JSON.stringify(sent.body.outcome).slice(0, 300)).toMatchObject({ definite: true, accepted: true });
  return sent.body;
}

test(`${J} #8 waits for the lead to fill: the copy is an order on the follower's own venue account, placed by the agent permission at the fixed amount, with the venue's fill and fee and our builder fee as the venue reports them, and the Positions tab shows the copied fills and no profit share`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const follower = state('follower');
  const owner = state('owner');
  const sub = state('subAccount');
  await signIn(page, follower);
  await walletIn(page);
  await page.goto('/trade/copy?tab=follows');
  // #7 followed the spot leader on screen; this is its follow.
  const row = page
    .getByRole('grid', { name: 'My follows' })
    .getByRole('rowgroup')
    .nth(1)
    .getByRole('row')
    .filter({ hasText: state('spotRef') });
  await row.first().getByRole('button', { name: 'Manage' }).click();
  const detail = page.getByRole('dialog');
  // Start copying in #7 also turned automatic copying on; nothing is copied before the lead trades.
  await expect(detail.getByRole('button', { name: 'Turn off automatic copying' })).toBeVisible();
  await expect(detail.getByText('No copied orders')).toBeVisible();

  // The lead buys on the venue: its own order on its own venue account, signed by its own wallet through our door, at
  // the best ask. Our builder fee rides on door orders, so the lead's wallet approves it first.
  const builder = await builderOf(await api(follower));
  if (builder) {
    await leadActs(
      { kind: 'approve_builder_fee', builder: builder.address, maxFeeBps: builder.feeBps },
      `approve:${J}:${state('tag')}:lead`,
    );
  }
  const book = (await testVenue('/book', { account: null, symbol: VENUE_MARKET, depth: 1 })).body;
  const bestAsk = book?.value?.asks?.[0]?.price ?? book?.asks?.[0]?.price;
  expect(bestAsk, JSON.stringify(book).slice(0, 300)).toBeTruthy();
  await leadActs({
    kind: 'place_order',
    symbol: VENUE_MARKET,
    side: 'buy',
    type: 'limit',
    amount: '0.001',
    price: bestAsk,
    timeInForce: 'IOC',
    reduceOnly: false,
    clientOrderKey: `order:${state('leadOwner')}:j01-8-${state('tag')}`,
    builderFee: null,
  });
  const leadFills = (await venueRecord(state('leadOwner'), '/fills', { since: state('followedAt') })).value;
  expect(leadFills.length, "the lead's buy filled on the venue").toBeGreaterThan(0);

  const copied = detail.getByRole('table', { name: 'Copied orders' }).locator('tbody tr:not([data-slot="table-empty-row"])');
  await expect(async () => {
    await page.reload();
    await row.first().getByRole('button', { name: 'Manage' }).click();
    await expect(copied).toHaveCount(1, { timeout: 2_000 });
    await expect(copied.first()).toContainText('Filled', { timeout: 2_000 });
  }).toPass({ timeout: 90_000 });
  await expect(copied.first()).toContainText(VENUE_MARKET);
  await expect(copied.first()).toContainText('Buy');
  // Placed by the agent permission on the follow's agent account, never by the person's wallet.
  await expect(copied.first().getByTestId('copy-placed-by')).toHaveText(state('agentAddress'));
  expect(state('agentAddress')).not.toBe(owner);

  // The venue's own record of the follower's agent account: exactly one copy, filled, at the fixed 20 USDC at one of the
  // lead's fill prices, stepped down to the market's lot, never more than 20 USDC; and nothing on the main account.
  const mine = (await venueRecord(owner, '/fills', { since: state('followedAt') }, undefined, sub)).value;
  expect(mine.length, "the copy's fills on the follower's own agent account").toBeGreaterThan(0);
  const cloids = new Set(mine.map((f) => f.venueClientOrderId));
  expect(cloids.size, 'one copied order').toBe(1);
  expect((await venueRecord(owner, '/fills', { since: state('followedAt') })).value, 'no copy on the main account').toEqual([]);
  const signer = (await venueRecord(owner, '/order-signer', { venueClientOrderId: [...cloids][0] }, undefined, sub)).value;
  expect(signer, 'the venue records the agent permission as the signer').toEqual({ role: 'agent', address: state('agentAddress') });
  const markets = (await testVenue('/markets', { account: null })).body.value;
  const lot = toUnits(markets.find((m) => m.symbol === VENUE_MARKET).lotSize);
  const amount = mine.reduce((sum, f) => sum + toUnits(f.amount), 0n);
  const sizes = leadFills.map((f) => {
    const scaled = (toUnits('20') * 10n ** 18n) / toUnits(f.price);
    return scaled - (scaled % lot);
  });
  expect(sizes, `the copy's ${fromUnits(amount)} is 20 USDC at a lead fill's price, stepped to the lot`).toContain(amount);
  const notional = mine.reduce((sum, f) => sum + (toUnits(f.amount) * toUnits(f.price)) / 10n ** 18n, 0n);
  expect(notional <= toUnits('20'), `the copy's notional ${fromUnits(notional)} is never above the fixed amount`).toBe(true);

  // The Positions tab: the copied fills with the venue's fee and our builder fee, as the venue reports them, and no
  // profit-share value anywhere on it.
  await detail.getByRole('tab', { name: 'Positions' }).click();
  const fillsTable = detail.getByRole('table', { name: 'Copied fills' });
  const fillRows = fillsTable.locator('tbody tr:not([data-slot="table-empty-row"])');
  await expect(fillRows).toHaveCount(mine.length);
  const headers = (await fillsTable.locator('thead th').allInnerTexts()).map((h) => h.trim());
  for (const header of ['Venue fee', 'Our builder fee']) expect(headers).toContain(header);
  expect(
    headers.some((h) => /profit/i.test(h)),
    'no profit-share column',
  ).toBe(false);
  const byId = new Map(mine.map((f) => [toUnits(f.amount).toString() + ':' + toUnits(f.price).toString(), f]));
  for (let i = 0; i < mine.length; i += 1) {
    const cells = fillRows.nth(i).locator('td');
    const num = async (header) => toUnits((await cells.nth(headers.indexOf(header)).innerText()).trim().split(' ')[0].replace(/,/g, ''));
    const f = byId.get(`${await num('Amount')}:${await num('Price')}`);
    expect(f, 'each fill shown is one the venue reports').toBeTruthy();
    expect(await num('Venue fee'), "the venue's fee as the venue reports it").toBe(toUnits(f.venueFee));
    expect(await num('Our builder fee'), 'our builder fee as the venue reports it').toBe(toUnits(f.builderFee));
    await expect(cells.nth(headers.indexOf('Venue fee'))).toContainText(f.feeAsset);
  }
  // No profit-share value: the copied fills name none, and where the copied positions keep a leader profit-share column
  // (J-copy-bots-otc-06), each of its cells says the platform sets none.
  await expect(fillsTable).not.toContainText(/profit/i);
  const positions = detail.getByRole('table', { name: 'Copied positions' });
  const positionHeaders = (await positions.locator('thead th').allInnerTexts()).map((h) => h.trim());
  const shareColumn = positionHeaders.findIndex((h) => /profit share/i.test(h));
  const positionRows = positions.locator('tbody tr:not([data-slot="table-empty-row"])');
  if (shareColumn >= 0) {
    for (let i = 0; i < (await positionRows.count()); i += 1) {
      await expect(positionRows.nth(i).locator('td').nth(shareColumn)).toHaveText('Not set by the platform');
    }
  }

  // Read again after the copy driver's later sweeps: still one copied order, on the screen and on the venue.
  await page.reload();
  await row.first().getByRole('button', { name: 'Manage' }).click();
  await expect(copied).toHaveCount(1);
  expect(
    new Set((await venueRecord(owner, '/fills', { since: state('followedAt') }, undefined, sub)).value.map((f) => f.venueClientOrderId))
      .size,
  ).toBe(1);
});
