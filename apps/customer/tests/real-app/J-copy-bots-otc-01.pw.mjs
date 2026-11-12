// World: book, restart
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { EDGE, ORIGIN, ROOT, api, fromUnits, journeyState, tool, signOutBrowser, toUnits } from './stack.mjs';
import { fundedTrader, signIn, signUp, verify } from './desk.mjs';
import { listLeader, takeBest, userIdOf } from './copy.mjs';
import { approverSessions, makeContext, refusalText } from '../../../../tooling/scripts/local-test-gates.mjs';
import { installTestWallet, testWalletKey } from './test-wallet.mjs';
import {
  continueInWallet,
  otherTraderKey,
  otherTraderRun,
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
// the TEST venue, on the venue account the founder names for it. svc-trade's user-venue door is on for this file
// (venue.mjs `venueForThisFile`): a follow is on the follower's own venue account, and INTAFACED holds and moves none of
// it (the launch money model, OWNER 226). Every figure the TEST venue reports is TEST.
const J = 'J-copy-bots-otc-01';
const RUN = process.env.JOURNEY_RUN_ID ?? 'local';
const run = journeyState(`${J}-${RUN}`);
/** The venue's cash spot market the follow allows (the TEST venue's BTC-USDC). */
const VENUE_MARKET = 'BTC-USDC';
/** The stack's TEST agent key secret (tooling/profiles/test-owner-values/trade.json): public, holds nothing real. */
const AGENT_KEY_SEED = JSON.parse(readFileSync(path.join(ROOT, 'tooling/profiles/test-owner-values/trade.json'), 'utf8')).values
  .TRADE_AGENT_KEY_SEED.value;
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

const TABS = ['Leaders', 'Futures', 'Spot', 'Bots', 'Signal', 'My follows', 'Rules'];

test(`${J} #1 opens Copy trading: every tab, an empty tab says so with no placeholder row, the desk state is read`, async ({ page }) => {
  const follower = await signUp(page, 'jcf');
  await verify(page, follower);
  // The follower's own TEST wallet, and TEST USDC in its own account on the venue (the step's start).
  const walletKey = testWalletKey();
  const owner = privateKeyToAccount(walletKey).address.toLowerCase();
  run.reset({ follower, tag: Date.now().toString(36), walletKey, owner });
  await testDeposit(owner, 'USDC', '1000', depositRef('follower'));
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
  const spotRef = await listLeader(leader, spotName, { tenureStart: '2026-01-01T00:00:00.000Z' });
  const futuresLeader = await signUp(page, 'jcx');
  await listLeader(futuresLeader, futuresName, { marketMode: 'futures' });
  // The spot lead's own account on the venue, named by the founder who lists the lead, with TEST USDC for #8's trade.
  const leadName = `${J} lead ${RUN} ${tag}`;
  const leadOwner = otherTraderKey(leadName).address.toLowerCase();
  await testDeposit(leadOwner, 'USDC', '1000', depositRef('lead'));
  await setLeadVenueAccount(spotRef, leadOwner);
  run.write({ leader, spotName, spotRef, futuresName, leadName, leadOwner });

  await signOutBrowser(page.context());
  await signIn(page, state('follower'));
  await page.goto('/trade/copy?tab=futures');
  const table = page.getByRole('table', { name: 'Leaders' });
  await expect(table.getByRole('link', { name: futuresName })).toBeVisible();
  await expect(table.getByRole('link', { name: spotName })).toHaveCount(0);

  // The search goes to the service with the tab's market: the screen does not filter a second time.
  const asked = page.waitForRequest((req) => {
    if (!req.url().includes('copy.listLeaders')) return false;
    const input = JSON.parse(new URL(req.url()).searchParams.get('input') ?? '{}');
    return input.marketMode === 'futures' && input.q === `futures ${tag}`.toUpperCase();
  });
  await page.getByLabel('Search leaders').fill(`futures ${tag}`.toUpperCase());
  await asked;
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

  // Return and drawdown carry the TEST definitions; this listing publishes no figure, so each reads Not published.
  const metric = (key) => page.locator(`[data-testid="cb-metric"][data-metric=${key}]`);
  await expect(metric('publishedReturn')).toContainText('Not published');
  await expect(metric('publishedReturn')).toContainText('TEST definition');
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
  await expect(rows.nth(1)).toContainText('None set');
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

/** The founder who lists a lead names the venue account the lead trades on (svc-trade copy.venue.setLeadAccount). */
async function setLeadVenueAccount(leaderRef, owner) {
  const ctx = await makeContext({ log: () => {} });
  const founders = await approverSessions(ctx);
  const res = await ctx.edge.mutate('trade', 'copy.venue.setLeadAccount', { leaderRef, owner }, founders.a.token);
  if (res.json?.result?.data?.owner !== owner) throw new Error(`naming the lead's venue account refused: ${refusalText(res)}`);
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
  await wizard.getByRole('button', { name: 'Connect TEST Wallet' }).click();
  await expect(wizard.getByTestId('venue-wallet-address')).toHaveText(wallet.address);
  return wizard;
}

/** A Start copying request on the venue as the API takes it, for the follower's own venue account. */
const venueStart = (over = {}) => ({
  leaderRef: state('spotRef'),
  region: 'DE',
  permittedMarkets: [VENUE_MARKET],
  maxNotionalPerOrder: '50',
  maxAggregateExposure: '200',
  fixedOrderSize: '20',
  expiresAt: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
  owner: state('owner'),
  ...over,
});

async function fillLimits(wizard, { perOrder, total, fixed }) {
  await wizard.getByLabel('Most per order (USDT)').fill(perOrder);
  await wizard.getByLabel('Most in total (USDT)').fill(total);
  await wizard.getByLabel('Fixed amount per copied order (USDT)').fill(fixed);
  await wizard.getByLabel('Permission ends').fill(weekAhead());
}

test(`${J} #5 presses Start copying: below the copy verification level, under a blank country list and as a sub-account, each refused by name, and nothing is followed`, async ({
  page,
}) => {
  // Signing up and funding a new account takes most of a minute, and the country-list restart two more.
  test.setTimeout(420_000);
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
  const answer = page.waitForResponse((res) => res.url().includes('copy.venue.start'));
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

  // A blank country list refuses every follow, a verified person's too, and writes nothing. The follower's venue account
  // holds TEST USDC (#1), so the wizard's own free-balance check passes and the press reaches the service.
  const follower = state('follower');
  const me = await api(follower);
  const followsBefore = await myFollows(me);
  try {
    await copyCountries('blank');
    const refused = await (
      await api(follower)
    ).post('/api/trade/trpc/copy.venue.start', venueStart({ clientRequestId: `journey-blank-countries:${state('tag')}` }));
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
    const blankAnswer = page.waitForResponse((res) => res.url().includes('copy.venue.start'));
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
  const subAnswer = page.waitForResponse((res) => res.url().includes('copy.venue.start'));
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

  // Back to the main account in the same tab.
  await inUse.getByRole('button', { name: 'Switch back to the main account' }).click();
  await expect(inUse).toHaveCount(0);
});

/** Restart trade with the copy country list blank (`blank`) or as the TEST profile sets it (`set`), by its stack switch. */
async function copyCountries(state) {
  const before = process.env.LOCAL_STACK_TRADE_COPY_JURISDICTION;
  const door = process.env.LOCAL_STACK_USER_VENUE;
  if (state === 'blank') process.env.LOCAL_STACK_TRADE_COPY_JURISDICTION = 'blank';
  else delete process.env.LOCAL_STACK_TRADE_COPY_JURISDICTION;
  // The user-venue door stays on for this file across the restart (venueForThisFile).
  process.env.LOCAL_STACK_USER_VENUE = 'on';
  try {
    tool('local-test-stack.mjs', 'restart', 'trade');
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_TRADE_COPY_JURISDICTION;
    else process.env.LOCAL_STACK_TRADE_COPY_JURISDICTION = before;
    if (door === undefined) delete process.env.LOCAL_STACK_USER_VENUE;
    else process.env.LOCAL_STACK_USER_VENUE = door;
  }
  // A restart outlasts Edge's idle timeout: drop the closed kept-alive sockets before the next write (as in J-14).
  for (let i = 0, live = 0; i < 20 && live < 3; i++) {
    try {
      await fetch(`${EDGE}/api/v1/orderbook/${encodeURIComponent('BTC/USDT')}?limit=1`, { headers: { origin: ORIGIN } }).then((r) =>
        r.arrayBuffer(),
      );
      live += 1;
    } catch (error) {
      if (error?.cause?.code !== 'UND_ERR_SOCKET') throw error;
      live = 0;
    }
  }
}

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

/** The follow's agent key as svc-trade derives it (services/svc-trade/src/venue/agent-key.ts) from the TEST seed. */
const followAgentKey = (userId, followId) =>
  privateKeyToAccount(keccak256(toHex(`intafaced agent key\u0000${AGENT_KEY_SEED}\u0000${userId}\u0000copy:${followId}`)));

const codeOf = (res) => res.body?.error?.data?.cause?.code ?? res.body?.error?.data?.intafacedCode;

test(`${J} #7 enters a fixed amount and starts: zero, above the per-order cap and above the venue's free USDC refused; the wallet signs the follow's permission, which places and cancels and never withdraws; a rejected signature leaves no follow; the same key is the same follow; nothing is moved or held`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const follower = state('follower');
  const owner = state('owner');
  const me = await api(follower);
  const venue = await venueInfo();
  const before = await venueBalance(owner, 'USDC');
  const agentsBefore = (await venueRecord(owner, '/agents')).value;
  expect(agentsBefore, 'no copy permission before the follow').toEqual([]);

  // The service itself refuses each amount the screen refuses below, by its typed code, and starts no follow: a zero
  // fixed amount, one above the most per order, and one above the free USDC the venue reports, which the refusal names
  // with the venue's figure and its as-of time.
  const ask = (over) =>
    me.post('/api/trade/trpc/copy.venue.start', venueStart({ clientRequestId: `${J}-7-refused-${Date.now()}`, ...over }));
  const aboveFree = fromUnits(toUnits(before.free) + toUnits('1'));
  for (const [over, code] of [
    [{ fixedOrderSize: '0' }, 'trade.copy_envelope_invalid'],
    [{ fixedOrderSize: '60' }, 'trade.copy_fixed_size_above_cap'],
    [{ maxNotionalPerOrder: aboveFree, maxAggregateExposure: aboveFree, fixedOrderSize: aboveFree }, 'trade.copy_venue_balance_short'],
  ]) {
    const refused = await ask(over);
    expect(codeOf(refused), JSON.stringify(refused.body).slice(0, 300)).toBe(code);
    if (code === 'trade.copy_venue_balance_short') {
      const message = refused.body.error.message;
      expect(message, 'the refusal names the venue').toContain(venue.displayName);
      expect(message, "the refusal names the venue's free figure").toContain(`${before.free} USDC`);
      expect(message, 'the refusal names its as-of time').toMatch(/as of \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
    }
  }
  expect(await myFollows(me), 'no follow was started by a refused request').toEqual([]);
  expect((await venueRecord(owner, '/agents')).value, 'no permission was asked for by a refused request').toEqual([]);

  await signIn(page, follower);
  const wallet = await walletIn(page);
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
  await expect(
    wizard.getByText(new RegExp(`more than the 1,?000 USDC free that ${venue.displayName} reports for your account, as of `)),
  ).toBeVisible();
  await fillLimits(wizard, { perOrder: '50', total: '200', fixed: '20' });
  await wizard.getByRole('button', { name: 'Next' }).click();
  await expect(wizard.getByRole('region', { name: 'Copy permission' })).toContainText(
    'can place and cancel orders there and can never withdraw',
  );

  // The wallet is asked to sign the follow's permission; rejected, it is never sent, and there is no follow.
  wallet.rejectNext();
  await wizard.getByRole('button', { name: 'Start copying' }).click();
  await continueInWallet(page);
  await expect(wizard.getByRole('alert').filter({ hasText: 'Your wallet did not sign' })).toBeVisible();
  expect(await myFollows(me), 'a rejected signature leaves no follow').toEqual([]);
  expect((await venueRecord(owner, '/agents')).value, 'a rejected signature grants nothing on the venue').toEqual([]);
  const asked = wallet.requests.length;

  // Signed: the follow is active with the amounts as its limits, on the follower's own venue account.
  await wizard.getByRole('button', { name: 'Start copying' }).click();
  await continueInWallet(page);
  await expect(page).toHaveURL(/tab=follows/);
  expect(wallet.requests.length, 'the wallet was asked for one signature').toBe(asked + 1);
  const signedData = JSON.parse(wallet.requests.at(-1).params[1]);
  const row = page.getByRole('grid', { name: 'My follows' }).getByRole('rowgroup').nth(1).getByRole('row');
  await expect(row).toHaveCount(1);
  await row.first().getByRole('button', { name: 'Manage' }).click();
  const detail = page.getByRole('dialog');
  await expect(detail).toContainText('200 USDC');
  await expect(detail).toContainText('20 USDC');
  const [spot] = await myFollows(me);
  expect(spot.leaderRef).toBe(state('spotRef'));
  expect(spot.relationshipState).toBe('ACTIVE');
  expect(spot.maxAggregateExposure, 'the cap').toBe('200');
  expect(spot.fixedOrderSize).toBe('20');
  // Nothing is held by INTAFACED: no reserve, and the venue balance is exactly what it was.
  expect(spot.reserve ?? null, 'no reserve is held').toBeNull();
  await expect(detail.getByText('Reserved for this copy').locator('..')).toContainText('Not set');
  expect(await venueBalance(owner, 'USDC'), 'nothing moved on the venue').toEqual(before);

  // The permission the wallet signed is on the venue's own record of the follower's account: one agent, the follow's own
  // key, which the venue lets place and cancel orders and refuses a withdrawal.
  const agents = (await venueRecord(owner, '/agents')).value;
  expect(agents).toHaveLength(1);
  const agent = followAgentKey(await userIdOf(follower), spot.followId);
  expect(agents[0].address.toLowerCase(), "the permission is the follow's own key").toBe(agent.address.toLowerCase());
  expect(JSON.stringify(signedData.message).toLowerCase(), 'the wallet signed that key').toContain(agent.address.toLowerCase().slice(2));
  const account = await venueAccount(owner);
  const withdraw = await testVenue('/prepare', {
    account,
    signer: { role: 'agent', address: agent.address.toLowerCase() },
    intent: {
      kind: 'withdraw',
      asset: 'USDC',
      amount: '1',
      destination: agent.address.toLowerCase(),
      withdrawalKey: `withdraw:${state('tag')}`,
    },
  });
  expect(withdraw.status, JSON.stringify(withdraw.body).slice(0, 300)).not.toBe(200);
  expect(JSON.stringify(withdraw.body), 'the venue refuses the permission a withdrawal').toContain('agent_not_permitted');
  run.write({ agentAddress: agent.address.toLowerCase(), followId: spot.followId, followedAt: new Date().toISOString() });

  // The same request sent twice is one follow, asking for one signature (here to the futures leader, by the API the
  // screen uses): the same follow id and the same prepared permission, nothing new prepared.
  const futuresLeaderRef = await futuresRef(me);
  const request = venueStart({
    leaderRef: futuresLeaderRef,
    maxAggregateExposure: '100',
    fixedOrderSize: '10',
    clientRequestId: `journey-start:${state('tag')}`,
  });
  const first = await me.post('/api/trade/trpc/copy.venue.start', request);
  const second = await me.post('/api/trade/trpc/copy.venue.start', request);
  expect(first.status, JSON.stringify(first.body).slice(0, 300)).toBe(200);
  expect(second.status, JSON.stringify(second.body).slice(0, 300)).toBe(200);
  expect(second.body.result.data.followId).toBe(first.body.result.data.followId);
  expect(second.body.result.data.next.prepared.digest, 'one permission to sign, not two').toBe(first.body.result.data.next.prepared.digest);
  expect(
    (await myFollows(me)).map((f) => f.followId),
    'an unsigned request is no follow',
  ).toEqual([spot.followId]);
});

/** The follower's follows as svc-trade reads them back to their owner. */
async function myFollows(me) {
  const res = await me.get(`/api/trade/trpc/copy.listMyFollows?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

/** The futures leader's public ref, read from the directory the way the screen reads it. */
async function futuresRef(me) {
  const input = encodeURIComponent(JSON.stringify({ limit: 50, marketMode: 'futures', q: state('futuresName') }));
  const page = await me.get(`/api/trade/trpc/copy.listLeaders?input=${input}`);
  const ref = page.body?.result?.data?.leaders?.[0]?.leaderRef;
  if (!ref) throw new Error(`no futures leader listed: ${JSON.stringify(page.body).slice(0, 300)}`);
  return ref;
}

test(`${J} #8 waits for the lead to fill: the copy is the follower's own venue order, placed by the follow's permission at the fixed amount, with the venue's fill and fee and our builder fee as the venue reports them, and the Positions tab shows the copied fill and no profit share`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const follower = state('follower');
  const owner = state('owner');
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

  // The lead buys on the venue, its own signed order on its own venue account, at the best ask.
  const book = (await testVenue('/book', { account: null, symbol: VENUE_MARKET, depth: 1 })).body;
  const bestAsk = book?.value?.asks?.[0]?.price ?? book?.asks?.[0]?.price;
  expect(bestAsk, JSON.stringify(book).slice(0, 300)).toBeTruthy();
  const leadSent = await otherTraderRun(state('leadName'), {
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
  expect(leadSent, JSON.stringify(leadSent).slice(0, 300)).toMatchObject({ definite: true, accepted: true });
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
  await expect(copied.first()).toContainText('On the venue');
  // Placed by the follow's permission: the follow's own agent key, never the person's wallet.
  await expect(copied.first().getByTestId('copy-signed-by')).toHaveText(state('agentAddress'));

  // The venue's own record of the follower's account: exactly one copy, filled, at the fixed 20 USDC at one of the
  // lead's fill prices, stepped down to the market's lot, never more than 20 USDC.
  const mine = (await venueRecord(owner, '/fills', { since: state('followedAt') })).value;
  expect(mine.length, "the copy's fills on the follower's own venue account").toBeGreaterThan(0);
  const cloids = new Set(mine.map((f) => f.venueClientOrderId));
  expect(cloids.size, 'one copied order').toBe(1);
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

  // The Positions tab: the copied fill with the venue's fee and our builder fee, as the venue reports them, and no
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
  const shownFee = (await fillRows.first().locator('td').nth(headers.indexOf('Venue fee')).innerText()).trim();
  const shownBuilder = (await fillRows.first().locator('td').nth(headers.indexOf('Our builder fee')).innerText()).trim();
  const first = mine[0];
  expect(toUnits(shownFee.split(' ')[0].replace(/,/g, '')), "the venue's fee as the venue reports it").toBe(toUnits(first.venueFee));
  expect(shownFee).toContain(first.feeAsset);
  expect(toUnits(shownBuilder.split(' ')[0].replace(/,/g, '')), 'our builder fee as the venue reports it').toBe(toUnits(first.builderFee));
  await expect(detail.getByRole('tabpanel')).not.toContainText(/profit share/i);

  // A second sweep places nothing more: still one copied order a few seconds later.
  await page.waitForTimeout(5_000);
  await page.reload();
  await row.first().getByRole('button', { name: 'Manage' }).click();
  await expect(copied).toHaveCount(1);
  expect(new Set((await venueRecord(owner, '/fills', { since: state('followedAt') })).value.map((f) => f.venueClientOrderId)).size).toBe(1);
});
