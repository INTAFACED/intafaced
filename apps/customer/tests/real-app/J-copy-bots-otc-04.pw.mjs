// World: book, restart
import { readFileSync } from 'node:fs';
import { keccak256, toHex } from 'viem';
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { EDGE, ORIGIN, api, bestPrices, fromUnits, fund, journeyState, signOutBrowser, tool, toUnits } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';
import { copiedOrdersLoaded, followOnScreen, leadVenueAccount, listLeader, mineOf, openFollow } from './copy.mjs';
import { testDeposit, venueForThisFile } from './venue.mjs';
import { agePast } from './test-age.mjs';
import { LEAD_TEST_SPOT } from '../../../../tooling/scripts/seed-spot-test-listing.mjs';

// J-copy-bots-otc-04, in the running app (docs/roadmap/journeys.json): become a lead trader and place my first lead trade.
// One test per step, titled "J-copy-bots-otc-04 #<n>", run in order. The applicant is a verified TEST account with TEST
// 3000 USDT on the TEST book (to follow with) and a TEST wallet whose account on the stack's LOCAL TEST venue holds TEST
// 3000 USDC, made the applicant's own by one action their wallet signs through svc-trade's user-venue door, switched on
// for this file. A second TEST leader (listed by the stack's TEST founder) is the master the applicant first follows.
// The least venue balance to lead is the stack's TEST value (tooling/profiles/test-owner-values/trade.json), blanked for
// one restart of svc-trade in #1; the founders reject and approve on the console. Lead orders are the applicant's own.
// #3 to #8: the new-trader missions (the TEST mission minimum on the applicant's own venue account, met by a TEST deposit),
// the two founders' approval on the console and the lead account it opens, and the lead's own trades on the spot desk
// with the Lead trade switch. #5, #7 and #8 trade the TEST lead book (seed-spot-test-listing.mjs `LEAD_TEST_SPOT`),
// which the market maker never quotes and no other journey trades, so the lead's post-only buy rests on a book of its
// own and only this file's TEST taker fills it. The lead limits are the stack's TEST values (daily buy cap, per-pair
// holding limits; the equity minimum is the least venue balance to lead, raised for one restart of svc-trade in #7).
const J = 'J-copy-bots-otc-04';
const RUN = process.env.JOURNEY_RUN_ID ?? 'local';
const run = journeyState(`${J}-${RUN}`);
const PROFILE = JSON.parse(
  readFileSync(new URL('../../../../tooling/profiles/test-owner-values/trade.json', import.meta.url), 'utf8'),
).values;
/** The least venue USDC to lead, as the stack's TEST profile sets it. */
const THRESHOLD = PROFILE.TRADE_COPY_LEAD_MIN_VENUE_USDC.value;
/** The new-trader mission minimum and the lead daily buy cap, as the stack's TEST profile sets them. */
const MISSION_MIN = PROFILE.TRADE_COPY_LEAD_MISSION_MIN_USDC.value;
const DAILY_BUY_CAP = PROFILE.TRADE_COPY_LEAD_DAILY_BUY_CAP.value;
/** The TEST lead book, `TLED/USDT`, and its desk path. */
const BOOK = LEAD_TEST_SPOT;
const BOOK_PATH = BOOK.replace('/', '-');
const BOOK_QUERY = encodeURIComponent(BOOK);

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });
venueForThisFile(test);

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

const codeOf = (body) => body?.error?.data?.cause?.code;

/** svc-trade restarted with the user-venue door on and the least venue balance to lead blank, a TEST figure, or its TEST value. */
function leadBalance(value) {
  const saved = { door: process.env.LOCAL_STACK_USER_VENUE, balance: process.env.LOCAL_STACK_TRADE_COPY_LEAD_BALANCE };
  process.env.LOCAL_STACK_USER_VENUE = 'on';
  if (value === 'test') delete process.env.LOCAL_STACK_TRADE_COPY_LEAD_BALANCE;
  else process.env.LOCAL_STACK_TRADE_COPY_LEAD_BALANCE = value;
  try {
    tool('local-test-stack.mjs', 'restart', 'trade');
  } finally {
    for (const [key, before] of [
      ['LOCAL_STACK_USER_VENUE', saved.door],
      ['LOCAL_STACK_TRADE_COPY_LEAD_BALANCE', saved.balance],
    ]) {
      if (before === undefined) delete process.env[key];
      else process.env[key] = before;
    }
  }
}

const terms = (page) => page.getByRole('region', { name: 'What leading needs', exact: true });

/** Opens Apply to lead, fills the display name and presses Apply; returns svc-trade's answer to the submit. */
async function applyOnScreen(page, displayName) {
  await page.goto('/copy/lead/apply');
  await page.getByRole('textbox', { name: 'Display name', exact: true }).fill(displayName);
  const sent = page.waitForResponse((res) => res.url().includes('copy.applyToLead') && res.request().method() === 'POST');
  await page.getByRole('button', { name: 'Apply to lead', exact: true }).click();
  const answer = await sent;
  return { status: answer.status(), body: await answer.json(), request: answer.request().postDataJSON() };
}

/**
 * A lead order on the spot desk with the Lead trade switch on: Limit, an optional post-only pick, price and amount, Buy
 * and Confirm buy. Returns svc-trade's answer to the place and the body the desk sent.
 */
async function leadOrderOnScreen(page, { symbol = BOOK_PATH, price, amount, postOnly = false }) {
  await page.goto(`/trade/spot/${symbol}?lead=1`);
  const toggle = page.getByRole('switch', { name: 'Lead trade', exact: true });
  await expect(toggle).toBeChecked();
  await page.locator('[role=tab]', { hasText: /^Limit$/ }).click();
  if (postOnly) {
    await page.getByRole('combobox', { name: 'Time in force', exact: true }).click();
    await page.getByRole('option', { name: 'Post only', exact: true }).click();
  }
  const form = page.locator('form[data-testid="dk-form"][data-side="buy"]');
  await form.getByRole('textbox', { name: 'Price', exact: true }).fill(price);
  await form.getByRole('textbox', { name: 'Amount', exact: true }).fill(amount);
  await page.getByRole('button', { name: `Buy ${symbol.split('-')[0]}`, exact: true }).click();
  const sent = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/v1/orders' && res.request().method() === 'POST');
  await page.getByRole('button', { name: 'Confirm buy', exact: true }).click();
  const answer = await sent;
  return { status: answer.status(), body: await answer.json().catch(() => null), request: answer.request().postDataJSON() };
}

/** The lead's own lead trades as svc-trade answers `copy.leadTrades`. */
async function leadTrades(who) {
  const res = await (await api(who)).get('/api/trade/trpc/copy.leadTrades');
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

/** The founders' listing edit for the approved lead: its leading instrument list (the console's directory write). */
async function setLeadInstruments(who, displayName, assets) {
  await listLeader(who, displayName, { assets });
  await expect
    .poll(async () => (await (await api(who)).get('/api/trade/trpc/copy.myLead')).body?.result?.data?.instruments)
    .toEqual(assets);
}

/** The depth of `symbol` as the edge answers it, empty sides included (bestPrices waits for both sides). */
async function bestPricesOrEmpty(symbol) {
  try {
    return await bestPrices(symbol, 50, 2_000);
  } catch {
    const res = await fetch(`${EDGE}/api/v1/orderbook/${encodeURIComponent(symbol)}?limit=50`, { headers: { origin: ORIGIN } });
    return { body: await res.json() };
  }
}

/** The levels of `book` that would meet or stand in front of a buy resting at `price`: asks at or below it, bids at or above it. */
function inFrontOf(book, price) {
  return {
    asks: (book.asks ?? []).filter(([p]) => toUnits(p) <= toUnits(price)),
    bids: (book.bids ?? []).filter(([p]) => toUnits(p) >= toUnits(price)),
  };
}

async function openDesk(page, founder = 'a') {
  await founderSignIn(page, founder);
  await page.goto(`${ADMIN}/trade-ops/copy`);
  await expect(page.getByRole('heading', { name: 'Copy trading', level: 1 })).toBeVisible();
}

test(`${J} #1 applies to lead while following another master: refused naming the master; with the balance threshold blank, refused naming the threshold`, async ({
  page,
}) => {
  test.setTimeout(480_000);
  const tag = Date.now().toString(36);
  const master = await fundedTrader(page, 'jcm4', '10');
  const masterName = `Journey Master ${tag}`;
  const masterRef = await listLeader(master, masterName);
  const applicant = await fundedTrader(page, 'jca4', '3000');
  const owner = await leadVenueAccount(applicant, `${J} ${RUN} ${tag} applicant`, '3000');
  const displayName = `TEST lead ${tag}`;
  run.reset({ tag, master, masterName, masterRef, applicant, owner, displayName });
  await signIn(page, applicant);
  await followOnScreen(page, applicant, masterRef, { perOrder: '20', total: '40', fixed: '10' });

  // Following the master: the room says whom, and the application is refused naming them. Nothing is written.
  const following = await applyOnScreen(page, displayName);
  expect([following.status, codeOf(following.body)], JSON.stringify(following.body).slice(0, 300)).toEqual([
    400,
    'trade.copy_lead_following',
  ]);
  await expect(page.getByText(`You are following ${masterName}. Leave that leader before you apply to lead.`)).toBeVisible();
  await expect(terms(page)).toContainText(`You are following ${masterName}`);
  // The venue balance the room shows is the venue's own figure for the wallet's account, labelled TEST.
  await expect(terms(page)).toContainText('3,000 USDC TEST');
  expect(await mineOf(applicant), 'a refused application writes nothing').toBeNull();

  // Leave the master on screen.
  const detail = await openFollow(page, masterRef);
  await detail.getByRole('button', { name: 'Leave leader', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Leave leader', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);

  // With the least venue balance to lead blank, the application is refused naming the threshold, which reads Not set.
  leadBalance('blank');
  try {
    const blank = await applyOnScreen(page, displayName);
    expect([blank.status, codeOf(blank.body)], JSON.stringify(blank.body).slice(0, 300)).toEqual([
      400,
      'trade.copy_lead_balance_threshold_unset',
    ]);
    await expect(page.getByText('The least venue balance to lead is not set by the platform')).toBeVisible();
    await expect(terms(page)).toContainText('No leader');
    await expect(terms(page)).toContainText(/Least venue balance\s*Not set/);
    expect(await mineOf(applicant), 'a refused application writes nothing').toBeNull();
  } finally {
    leadBalance('test');
  }
});

test(`${J} #2 submits a valid application: submitted, the same submit again returns the same row; a rejected one shows its reason and may be resubmitted after the owner's wait`, async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const applicant = state('applicant');
  const displayName = state('displayName');
  await signIn(page, applicant);
  // Following no one, with the TEST threshold set and the venue's figure above it.
  await page.goto('/copy/lead/apply');
  await expect(terms(page)).toContainText('No leader');
  await expect(terms(page)).toContainText(`${Number(THRESHOLD).toLocaleString('en-US')} USDC`);
  const answer = await applyOnScreen(page, displayName);
  expect(answer.status, JSON.stringify(answer.body).slice(0, 300)).toBe(200);
  const first = answer.body.result.data;
  expect(first).toMatchObject({ state: 'submitted', displayName });
  await expect(page.getByRole('status').filter({ hasText: 'Application sent' })).toBeVisible();
  // The same submit again (the same person and name: the application's key) answers with the same row.
  const again = await (await api(applicant)).post('/api/trade/trpc/copy.applyToLead', answer.request);
  expect(again.status, JSON.stringify(again.body).slice(0, 300)).toBe(200);
  expect(again.body.result.data).toEqual(first);
  expect(await mineOf(applicant)).toEqual(first);

  // A founder rejects it with a reason on the console.
  const reason = `TEST: track record not shown ${state('tag')}`;
  const founder = await (await browser.newContext()).newPage();
  await openDesk(founder);
  const row = founder.getByRole('table', { name: 'Lead applications', exact: true }).locator('tbody tr').filter({ hasText: displayName });
  await row.getByRole('button', { name: 'Reject', exact: true }).click();
  await founder.getByRole('dialog').getByRole('textbox', { name: 'Reason', exact: true }).fill(reason);
  await founder.getByRole('dialog').getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(founder.getByRole('status').filter({ hasText: 'Rejected' })).toBeVisible();
  await founder.context().close();

  // The applicant sees the reason and when the owner's wait ends, and no application is offered while it runs.
  const decided = await mineOf(applicant);
  expect(decided).toMatchObject({ applicationId: first.applicationId, state: 'disapproved', reason });
  await page.goto('/copy/lead/apply');
  await expect(page.getByText(reason)).toBeVisible();
  await expect(page.getByTestId('reapply-after')).toHaveAttribute('datetime', decided.reapplyAfter);
  await expect(page.getByRole('button', { name: 'Apply to lead', exact: true })).toHaveCount(0);
  // After the wait (the rejection aged past it through svc-trade's TEST age door), the room offers the application
  // again and a new one is submitted.
  await agePast('trade', 'lead-application', first.applicationId, decided.reapplyAfter);
  await page.reload();
  await expect(page.getByText('The waiting period has ended')).toBeVisible();
  const resubmit = await applyOnScreen(page, displayName);
  expect(resubmit.status, JSON.stringify(resubmit.body).slice(0, 300)).toBe(200);
  const second = resubmit.body.result.data;
  expect(second).toMatchObject({ state: 'submitted', displayName, reason: null });
  expect(second.applicationId).not.toBe(first.applicationId);
  run.write({ applicationId: second.applicationId });
});

test(`${J} #3 completes a new-trader mission: its progress is shown`, async ({ page }) => {
  const applicant = state('applicant');
  await signIn(page, applicant);
  await page.goto('/trade/copy?tab=lead');
  const missions = page.getByRole('list', { name: 'New-trader missions', exact: true });
  const fund = missions.getByRole('listitem').filter({ hasText: 'Hold the mission minimum on your venue account' });
  // Applied (#2), not yet approved, and the venue account holds the TEST 3000 USDC, under the TEST mission minimum.
  await expect(page.getByText('1 of 3 missions done')).toBeVisible();
  await expect(missions.getByRole('listitem').filter({ hasText: 'Apply to lead' })).toContainText('Done');
  await expect(fund).toContainText('Not done');
  await expect(fund).toContainText(`0 of 1 · 3000 of ${MISSION_MIN} USDC on your venue account (TEST)`);
  // The person moves the rest onto their own venue account (a TEST deposit to the wallet's account): the mission is done.
  const more = String(Number(MISSION_MIN) - 3000);
  await testDeposit(state('owner'), 'USDC', more, `84532:${keccak256(toHex(`${J} ${RUN} ${state('tag')} mission`))}:0`);
  await expect
    .poll(
      async () => {
        await page.reload();
        return (await fund.textContent()) ?? '';
      },
      { timeout: 30_000, message: 'the funding mission never read done after the TEST deposit' },
    )
    .toContain(`1 of 1 · ${MISSION_MIN} of ${MISSION_MIN} USDC on your venue account (TEST)`);
  await expect(fund).toContainText('Done');
  await expect(page.getByText('2 of 3 missions done')).toBeVisible();
  // Not yet a lead: no lead account opens before the founders approve.
  await expect(page.getByRole('region', { name: 'Your lead account', exact: true })).toContainText('You are not a lead yet');
});

test(`${J} #4 after approval opens the lead account: the lead's level ("Not set" where blank) and the lead trading screen`, async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const displayName = state('displayName');
  const founder = await (await browser.newContext()).newPage();
  await openDesk(founder, 'a');
  // The lead criteria are a founder's setting; a TEST value where none is set yet.
  if (
    !(await founder
      .getByRole('form', { name: 'Lead criteria', exact: true })
      .getByText(/Minimum track record\s*\d+/)
      .count())
  ) {
    const criteria = founder.getByRole('form', { name: 'Lead criteria', exact: true });
    await criteria.getByRole('textbox', { name: 'Minimum track record, days', exact: true }).fill('30');
    await criteria.getByRole('button', { name: 'Save criteria', exact: true }).click();
    await expect(founder.getByRole('status').filter({ hasText: 'Criteria saved' })).toBeVisible();
  }
  const row = (p) => p.getByRole('table', { name: 'Lead applications', exact: true }).locator('tbody tr').filter({ hasText: displayName });
  await row(founder).getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(row(founder)).toContainText('Waiting for a second founder');
  await founder.context().close();
  const second = await (await browser.newContext()).newPage();
  await openDesk(second, 'b');
  await row(second).getByRole('button', { name: 'Confirm approval', exact: true }).click();
  await expect(second.getByRole('status').filter({ hasText: 'Approved and listed' })).toBeVisible();
  await second.context().close();

  await signIn(page, state('applicant'));
  await page.goto('/trade/copy?tab=lead');
  const account = page.getByRole('region', { name: 'Your lead account', exact: true });
  const lead = (await (await api(state('applicant'))).get('/api/trade/trpc/copy.myLead')).body?.result?.data;
  expect(lead, 'the approved applicant has a lead account').toMatchObject({ applicationId: state('applicationId'), state: 'listed' });
  await expect(account).toContainText(lead.leaderRef);
  await expect(account).toContainText(state('applicationId').slice(0, 8));
  // The approval lists the lead with no instruments: the owner has set none, so the list reads Not set.
  await expect(account).toContainText(/Leading instruments\s*Not set by the platform/);
  await expect(page.getByText('3 of 3 missions done')).toBeVisible();
  // The level: the owner has published no level thresholds, so it reads Not set and no level is shown.
  await expect(page.getByText(/Level\s*Not set: the platform has not published level thresholds/)).toBeVisible();
  // The lead trading screen: the spot desk, with the Lead trade switch on.
  await account.getByRole('link', { name: 'Open the lead trading screen', exact: true }).click();
  await expect(page).toHaveURL(/\/trade\/spot\/BTC-USDT\?lead=1/);
  await expect(page.getByRole('switch', { name: 'Lead trade', exact: true })).toBeChecked();
  run.write({ leadRef: lead.leaderRef });
});

test(`${J} #5 places a post-only lead order: with the leading instrument list blank refused naming the list; with it set it rests, and its fill is mirrored only after it fills`, async ({
  page,
}) => {
  test.setTimeout(420_000);
  const applicant = state('applicant');
  const leadRef = state('leadRef');
  const tag = state('tag');
  // With the list blank (as approved), a post-only lead buy is refused naming the list, and nothing is placed.
  await signIn(page, applicant);
  const blank = await leadOrderOnScreen(page, { price: '1', amount: '10', postOnly: true });
  expect([blank.status, blank.body?.intafacedCode ?? blank.body?.code]).toEqual([400, 'trade.copy_leader_instruments_not_set']);
  await expect(page.getByText('Reference trade.copy_leader_instruments_not_set')).toBeVisible();
  await expect(page.getByText(/leading instrument list is empty/)).toBeVisible();
  expect((await leadTrades(applicant)).counts, 'a refused lead order is no lead trade').toEqual({ ongoing: 0, history: 0 });

  // The founders set the list (their listing edit, as the console's does); a follower then copies the lead.
  await setLeadInstruments(applicant, state('displayName'), [BOOK, 'ETH/USDT']);
  const follower = await fundedTrader(page, 'jcf4', '500');
  await followOnScreen(page, follower, leadRef, { perOrder: '200', total: '400', fixed: '50', markets: [BOOK] });
  run.write({ follower });

  // The lead's buy is the best bid on the TEST lead book: one tick over anything an earlier run of this file left
  // resting, and under every ask, so it rests and only the TEST taker below fills it.
  const book = (await bestPricesOrEmpty(BOOK)).body;
  const top = (book.bids ?? []).reduce((m, [p]) => (toUnits(p) > toUnits(m) ? p : m), '0');
  const bid = toUnits(top) > 0n ? fromUnits(toUnits(top) + toUnits('0.0001')) : '1';
  expect(inFrontOf(book, bid), `nothing stands at or in front of ${bid}`).toEqual({ asks: [], bids: [] });
  await signIn(page, applicant);
  const placed = await leadOrderOnScreen(page, { price: bid, amount: '10', postOnly: true });
  expect(placed.status, JSON.stringify(placed.body).slice(0, 300)).toBe(201);
  expect(placed.request).toMatchObject({ lead: true, postOnly: true, timeInForce: 'PO' });
  const orderId = placed.body.id;
  // It rests: an ongoing lead trade, open on the book, and nothing is copied while it has not filled.
  await expect.poll(async () => (await leadTrades(applicant)).ongoing.map((o) => [o.orderId, o.status])).toEqual([[orderId, 'open']]);
  await signOutBrowser(page.context());
  await signIn(page, follower);
  let detail = await openFollow(page, leadRef);
  await expect(await copiedOrdersLoaded(detail)).toHaveCount(0);

  // A TEST taker sells into it: the lead's order fills, and only then is it copied.
  const taker = await fundedTrader(page, 'jct4', '10');
  expect(fund(taker.email, BOOK.split('/')[0], '10').tx).toBeTruthy();
  const sold = await (
    await api(taker)
  ).post('/api/v1/orders', {
    symbol: BOOK,
    type: 'limit',
    side: 'sell',
    amount: '10',
    price: bid,
    timeInForce: 'IOC',
    clientOrderId: `${J}-5-taker-${tag}`,
  });
  expect(sold.status, JSON.stringify(sold.body).slice(0, 300)).toBeLessThan(300);
  await expect
    .poll(async () => (await leadTrades(applicant)).history.map((o) => [o.orderId, o.status]), { timeout: 30_000 })
    .toEqual([[orderId, 'filled']]);
  await signIn(page, follower);
  await expect
    .poll(
      async () => {
        detail = await openFollow(page, leadRef);
        return (await copiedOrdersLoaded(detail)).filter({ hasText: BOOK }).count();
      },
      { timeout: 60_000, message: 'the lead fill was never copied' },
    )
    .toBe(1);
});

test(`${J} #6 places an iceberg order: not a lead trade; the toggle is forced off and the copy skipped with the reason`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const applicant = state('applicant');
  await signIn(page, applicant);
  await page.goto('/execution');
  await page.getByRole('tablist', { name: 'Execution sections', exact: true }).getByRole('tab', { name: 'Iceberg', exact: true }).click();
  const form = page.getByRole('region', { name: 'New iceberg', exact: true });
  const toggle = form.getByRole('switch', { name: 'Lead trade', exact: true });
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeDisabled();
  await expect(form.getByText('Iceberg orders are never lead trades, so followers don’t copy them.')).toBeVisible();
  // A TEST taker rests an ask on the TEST lead book over every bid there, and the lead's iceberg buy takes it at once.
  const book = (await bestPricesOrEmpty(BOOK)).body;
  const top = (book.bids ?? []).reduce((m, [p]) => (toUnits(p) > toUnits(m) ? p : m), '1');
  const ask = fromUnits(toUnits(top) + toUnits('0.1'));
  const seller = await fundedTrader(page, 'jcs4', '10');
  expect(fund(seller.email, BOOK.split('/')[0], '20').tx).toBeTruthy();
  const rested = await (
    await api(seller)
  ).post('/api/v1/orders', {
    symbol: BOOK,
    type: 'limit',
    side: 'sell',
    amount: '20',
    price: ask,
    timeInForce: 'GTC',
    clientOrderId: `${J}-6-seller-${state('tag')}`,
  });
  expect(rested.status, JSON.stringify(rested.body).slice(0, 300)).toBeLessThan(300);
  await signIn(page, applicant);
  await page.goto('/execution');
  await page.getByRole('tablist', { name: 'Execution sections', exact: true }).getByRole('tab', { name: 'Iceberg', exact: true }).click();
  await form.getByRole('combobox', { name: 'Market', exact: true }).click();
  await page.getByRole('option', { name: new RegExp(`^${BOOK.replace('/', '\\/')}(?:,|$)`) }).click();
  await form.getByLabel(`Total size (${BOOK.split('/')[0]})`).fill('20');
  await form.getByLabel(`Display size (${BOOK.split('/')[0]})`).fill('10');
  await form.getByLabel('Limit price').fill(ask);
  const sent = page.waitForResponse((res) => res.url().includes('/api/v1/orders') && res.request().method() === 'POST');
  await form.getByRole('button', { name: /Review/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: /Place/ }).click();
  const answer = await sent;
  expect(answer.status(), (await answer.text()).slice(0, 300)).toBeLessThan(300);
  expect(answer.request().postDataJSON()).toMatchObject({ lead: false, displayQty: '10' });
  const iceberg = await answer.json();
  // Not a lead trade: never listed among the lead's trades.
  const trades = await leadTrades(applicant);
  expect([...trades.ongoing, ...trades.history].map((o) => o.orderId)).not.toContain(iceberg.id);
  // Once it fills, the follower's copy of it is skipped with the reason.
  await expect
    .poll(
      async () => {
        const read = await (await api(applicant)).get(`/api/v1/orders/${iceberg.id}?symbol=${BOOK_QUERY}`);
        return read.body?.filled;
      },
      { timeout: 60_000, message: 'the iceberg never filled' },
    )
    .not.toBe('0');
  await signOutBrowser(page.context());
  await signIn(page, state('follower'));
  await expect
    .poll(
      async () => {
        const detail = await openFollow(page, state('leadRef'));
        return (await detail.getByRole('table', { name: 'Skipped copies', exact: true }).textContent()) ?? '';
      },
      { timeout: 60_000, message: 'the iceberg fill was never logged as a skipped copy' },
    )
    .toContain('The leader marked that order as not a lead trade, so it is not copied');
});

test(`${J} #7 reaches the lead's equity minimum or daily buy cap, or a pair with no holding limit: the lead order is refused by code`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const applicant = state('applicant');
  await signIn(page, applicant);
  const before = await leadTrades(applicant);
  // ETH/USDT is on the lead's list but has no TEST holding limit: refused by that code.
  const pair = await leadOrderOnScreen(page, { symbol: 'ETH-USDT', price: '1000', amount: '0.01' });
  expect([pair.status, pair.body?.intafacedCode ?? pair.body?.code]).toEqual([400, 'trade.copy_pair_limit_not_set']);
  await expect(page.getByText('Reference trade.copy_pair_limit_not_set')).toBeVisible();
  // A lead buy on the TEST lead book past the TEST daily buy cap (TEST 500 USDT a day; #5 used about 10 of it), inside
  // its TEST holding limit of 5000: refused by the cap.
  const big = fromUnits(toUnits(DAILY_BUY_CAP) + toUnits('1'));
  const cap = await leadOrderOnScreen(page, { price: '1', amount: big });
  expect([cap.status, cap.body?.intafacedCode ?? cap.body?.code]).toEqual([400, 'trade.copy_daily_buy_cap']);
  await expect(page.getByText('Reference trade.copy_daily_buy_cap')).toBeVisible();
  // Under the equity minimum: svc-trade restarts with a TEST minimum above the venue's figure for the lead's account.
  leadBalance('1000000');
  try {
    await signIn(page, applicant);
    const equity = await leadOrderOnScreen(page, { price: '1', amount: '10' });
    expect([equity.status, equity.body?.intafacedCode ?? equity.body?.code]).toEqual([400, 'trade.copy_leader_equity_below_min']);
    await expect(page.getByText('Reference trade.copy_leader_equity_below_min')).toBeVisible();
  } finally {
    leadBalance('test');
  }
  expect((await leadTrades(applicant)).counts, 'a refused lead order is no lead trade').toEqual(before.counts);
});

test(`${J} #8 opens the lead trade views: counters for ongoing and history, and each copier's status`, async ({ page }) => {
  const applicant = state('applicant');
  // One lead buy resting under #5's fill on the TEST lead book, so ongoing counts it; #5's filled one is history.
  await signIn(page, applicant);
  const resting = await leadOrderOnScreen(page, { price: '0.5', amount: '10', postOnly: true });
  expect(resting.status, JSON.stringify(resting.body).slice(0, 300)).toBe(201);
  const counts = (await leadTrades(applicant)).counts;
  expect(counts.ongoing).toBeGreaterThanOrEqual(1);
  expect(counts.history).toBeGreaterThanOrEqual(1);
  await page.goto('/trade/copy?tab=lead');
  const views = page.getByRole('region', { name: 'Lead trades', exact: true });
  await expect(views.getByRole('tab', { name: `Ongoing (${counts.ongoing})`, exact: true })).toBeVisible();
  await expect(views.getByRole('tab', { name: `History (${counts.history})`, exact: true })).toBeVisible();
  await expect(views.getByRole('table', { name: 'Ongoing lead trades', exact: true })).toContainText(resting.body.id.slice(0, 8));
  await views.getByRole('tab', { name: `History (${counts.history})`, exact: true }).click();
  await expect(views.getByRole('table', { name: 'Lead trade history', exact: true })).toContainText('filled');
  // Each copier with its state: the follower from #5, copying.
  const copiers = page.getByRole('table', { name: 'Your copiers', exact: true });
  await expect(copiers.locator('tbody tr').first()).toContainText('Active');
  // Cancel the resting lead buy so the book is left as found.
  await (await api(applicant)).delete(`/api/v1/orders/${resting.body.id}?symbol=${BOOK_QUERY}`);
});
