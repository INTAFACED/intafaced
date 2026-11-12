// World: book, gates, restart
import { createHash, randomUUID } from 'node:crypto';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { api, bestPrices, fromUnits, fund, journeyState, tool, toUnits } from './stack.mjs';
import { fundedTrader, openOrders, signIn } from './desk.mjs';
import { confirmStepUp, refusalCode, restorePasskey, testPasskey } from './p2p.mjs';
import { testDeposit, testVenue, venueForThisFile, venueInfo } from './venue.mjs';
import { copiedOrders, copiedOrdersLoaded, followOnScreen, leadFill, listLeader, openFollow } from './copy.mjs';

// J-copy-bots-otc-03, in the running app (docs/roadmap/journeys.json): pause, stop or leave a copy, close what I choose,
// and read why trades were skipped. One test per step, titled "J-copy-bots-otc-03 #<n>", run in order. #1 makes the
// journey's start: a TEST leader listed by the stack's TEST founder, a verified follower with TEST 1000 USDT who follows
// it on screen, and three copied buys (the leader's own fills on the TEST book, copied by the copy driver), so a close of
// one can be told from a close of all and a position is still open when #7 leaves. Every state is read back from
// svc-trade and every balance from the ledger.
// #5 tries a skipped fill again through the stack's LOCAL TEST rewind (`local-test-gates.mjs copy-rewind`): nothing in the
// running app sends a fill the copy driver has passed through it again.
// #3 and #4 run on the venue (OWNER 226): a second follow, of a TEST leader on the stack's TEST venue, copies onto the
// follower's own agent account, and its positions, closes and close-all are the venue's own record (venueStart below).
// svc-trade's user-venue door is on for this file (venueForThisFile), so trade restarts once before and once after it.
const J = 'J-copy-bots-otc-03';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const SYMBOL = 'BTC%2FUSDT';
const SYMBOL_TEXT = 'BTC/USDT';

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });
venueForThisFile(test);

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

const trpc = (proc, input) => `/api/trade/trpc/${proc}?input=${encodeURIComponent(JSON.stringify(input ?? {}))}`;

/** Presses a follow action and confirms it in its dialog. */
async function act(page, detail, button) {
  await detail.getByRole('button', { name: button, exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: button, exact: true }).click();
}

/** The follower's own BTC/USDT fills: what the ledger settles, one posting per fill. */
async function myFills(who) {
  const res = await (await api(who)).get(`/api/v1/account/trades?symbol=${SYMBOL}&limit=100`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body;
}

/** BTC and USDT totals from the ledger, as scaled bigints. */
async function holdings(who) {
  const b = await (await api(who)).balances();
  return { BTC: toUnits(b.BTC?.total ?? '0'), USDT: toUnits(b.USDT?.total ?? '0') };
}

/**
 * Waits for a sell of the follower's that was not among `seen`, then for the ledger to read exactly `before` moved by
 * those new fills: base out and quote in on a sell (in and out on a buy), the fee out, a rebate in. Returns the BTC sold.
 */
async function settlesExactly(who, before, seen) {
  let sold = 0n;
  await expect
    .poll(
      async () => {
        const fresh = (await myFills(who)).filter((f) => !seen.has(f.id));
        if (!fresh.some((f) => f.side === 'sell')) return 'no close fill yet';
        const moved = { BTC: 0n, USDT: 0n };
        sold = 0n;
        for (const f of fresh) {
          const sign = f.side === 'buy' ? 1n : -1n;
          moved.BTC += sign * toUnits(f.amount);
          moved.USDT -= sign * toUnits(f.cost);
          if (f.side === 'sell') sold += toUnits(f.amount);
          if (f.fee.currency in moved) moved[f.fee.currency] -= toUnits(f.fee.cost);
          if (f.rebate && f.rebate.currency in moved) moved[f.rebate.currency] += toUnits(f.rebate.cost);
        }
        const now = await holdings(who);
        const want = { BTC: before.BTC + moved.BTC, USDT: before.USDT + moved.USDT };
        return now.BTC === want.BTC && now.USDT === want.USDT
          ? 'exact'
          : `ledger ${now.BTC}/${now.USDT}, fills say ${want.BTC}/${want.USDT}`;
      },
      { timeout: 60_000, message: 'the ledger never read exactly what the close fills settle' },
    )
    .toBe('exact');
  return sold;
}

/** A tRPC query of svc-trade's, as `who`: the result's data. */
async function trpcQuery(who, proc, input) {
  const res = await (await api(who)).get(trpc(proc, input));
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

/** The follow as svc-trade reads it back to its owner. */
async function myFollow(who, followId) {
  const follow = (await trpcQuery(who, 'copy.listMyFollows', { limit: 100 })).find((f) => f.followId === followId);
  expect(follow, `copy.listMyFollows has no follow ${followId}`).toBeTruthy();
  return follow;
}

/** The leader's own fills of one order, sorted: the fills a follow copies or skips, one by one. */
async function leaderFillsOf(leader, order) {
  const ids = (await myFills(leader)).filter((f) => f.order === order.id).map((f) => f.id);
  expect(ids.length, `the leader's order ${order.id} has no fills listed`).toBeGreaterThan(0);
  return ids.sort();
}

/** The follower's own BTC/USDT order ids, open and closed, sorted. */
async function myOrderIds(who) {
  const client = await api(who);
  const open = await client.get(`/api/v1/orders/open?symbol=${SYMBOL}&limit=100`);
  const closed = await client.get(`/api/v1/orders/closed?symbol=${SYMBOL}&limit=100`);
  expect(open.status, JSON.stringify(open.body).slice(0, 300)).toBe(200);
  expect(closed.status, JSON.stringify(closed.body).slice(0, 300)).toBe(200);
  return [...open.body, ...closed.body].map((o) => o.id).sort();
}

/** svc-trade's copied positions of the follow, newest first (the order the screen lists them in). */
async function copiedPositions(who, followId) {
  return (await trpcQuery(who, 'copy.copiedPositions', { followId })).positions;
}

const isOpen = (p) => toUnits(p.open) > 0n;

/**
 * A copy is a limit at the lead's fill price (svc-trade `copy/auto-mirror-place.ts`), placed by the copy driver's next
 * sweep, up to 2 s after the lead's fill. If the TEST market maker requotes in between and moves its price away, the copy
 * rests at that price, as a person's limit order would. In run 1124 #2's copied sell rested as a 0.0003 BTC ask and never
 * settled, and #5 then found it at the best ask. The book's liquidity is a TEST fixture here, as the maker is: once every
 * copy of the follow is placed, the TEST trader `market` takes each one that rests, at the copy's own price, together
 * with whatever stands in front of it at that price or better, and the copy must then fill. A copy that filled leaves
 * nothing to take, and this does nothing. It first waits until the follow lists `count` copies on `side` and none is still
 * being placed, so a copy the driver's sweep places late is taken too.
 */
async function takeRestingCopies(follower, followId, side, count) {
  const copies = async () => (await trpcQuery(follower, 'copy.followPositions', { followId })).positions;
  await expect
    .poll(
      async () => {
        const all = await copies();
        return all.filter((o) => o.side === side).length >= count && !all.some((o) => o.status === 'pending');
      },
      { timeout: 30_000, message: `the follow never listed ${count} placed ${side} copies` },
    )
    .toBe(true);
  const ids = new Set((await copies()).map((o) => o.orderId));
  const market = await api(state('market'));
  const follow = await api(follower);
  for (const copy of (await openOrders(follower)).filter((o) => ids.has(o.id))) {
    const price = toUnits(copy.price);
    const atOrBetter = ([level]) => (copy.side === 'sell' ? toUnits(level) <= price : toUnits(level) >= price);
    for (let attempt = 0; ; attempt += 1) {
      const { body } = await bestPrices(SYMBOL_TEXT);
      const amount = (copy.side === 'sell' ? body.asks : body.bids).filter(atOrBetter).reduce((sum, [, a]) => sum + toUnits(a), 0n);
      const res = await market.post('/api/v1/orders', {
        symbol: SYMBOL_TEXT,
        type: 'limit',
        side: copy.side === 'buy' ? 'sell' : 'buy',
        amount: fromUnits(amount > 0n ? amount : toUnits(copy.remaining)),
        price: copy.price,
        timeInForce: 'IOC',
        clientOrderId: capped(`jc3-take:${copy.id}:${attempt}`),
      });
      expect(res.status, `taking the resting copy ${copy.id}: ${JSON.stringify(res.body).slice(0, 300)}`).toBeLessThan(300);
      // The take settles through matching: give it 10 s to show on the copy before the book is read again.
      let left;
      for (const until = Date.now() + 10_000; ;) {
        const read = await follow.get(`/api/v1/orders/${copy.id}?symbol=${SYMBOL}`);
        expect(read.status, JSON.stringify(read.body).slice(0, 300)).toBe(200);
        left = read.body;
        if (left.status !== 'open' || Date.now() > until) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (left.status !== 'open') {
        // Ended means filled: a copy that was cancelled or expired instead is not what the steps go on to read.
        expect(toUnits(left.filled ?? '0'), `the resting copy ${copy.id} ended unfilled: ${JSON.stringify(left).slice(0, 300)}`).toBe(
          toUnits(left.amount),
        );
        break;
      }
      // The maker requoted in front of the copy between the read and the take: read the book again.
      expect(attempt, `the resting copy ${copy.id} at ${copy.price} was not taken: ${JSON.stringify(left).slice(0, 300)}`).toBeLessThan(2);
    }
  }
}

/**
 * Everything a pause, stop or leave must not touch: the follow's copied orders, its copied positions (ids and open
 * quantities), the person's order ids and both ledger totals. A resting sell leaves the BTC total unchanged, so the
 * total alone proves nothing.
 */
async function snapshot(who, followId) {
  const orders = (await trpcQuery(who, 'copy.followPositions', { followId })).positions;
  return {
    copiedOrders: [...orders].sort((a, b) => (a.orderId < b.orderId ? -1 : 1)),
    positions: await copiedPositions(who, followId),
    orderIds: await myOrderIds(who),
    holdings: await holdings(who),
  };
}

// svc-trade's client ids: a mirror buy is `copy-mirror:<follow>:<fill>`, a whole close is `copy.close:<follow>:<fill>`,
// each hashed to 64 hex characters only when longer than 64. A fill id shaped as a UUID is lower-cased first.
const capped = (id) => (id.length <= 64 ? id : createHash('sha256').update(id).digest('hex').slice(0, 64));
const canonicalFill = (id) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id.trim()) ? id.trim().toLowerCase() : id.trim();

/** The follower's order under a client id, or null when svc-trade has none (404); any other answer fails. */
async function orderByClientId(who, clientOrderId) {
  const res = await (await api(who)).get(`/api/v1/orders/by-client-id/${encodeURIComponent(clientOrderId)}?symbol=${SYMBOL}`);
  expect([200, 404], JSON.stringify(res.body).slice(0, 300)).toContain(res.status);
  return res.status === 200 ? res.body : null;
}

/** BTC/USDT's lot: the step every copied position's open quantity is floored to. */
async function btcLot(who) {
  const res = await (await api(who)).get('/api/v1/markets?limit=500');
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return toUnits(res.body.find((m) => m.symbol === 'BTC/USDT').precision.amount);
}

/** The leader fill a copied position was bought for: the fill whose mirror client id names that position's buy. */
async function leaderFillOfPosition(who, followId, positionId) {
  for (const fill of state('openFillIds')) {
    const order = await orderByClientId(who, capped(`copy-mirror:${followId}:${canonicalFill(fill)}`));
    if (order?.id === positionId) return canonicalFill(fill);
  }
  throw new Error(`no leader fill of #1's buys was mirrored as position ${positionId}`);
}

/** Copied orders on the follow after the page re-reads it. */
async function copiedNow(page) {
  return (await copiedOrdersLoaded(await openFollow(page, state('leaderRef')))).count();
}

test(`${J} #1 pauses the follow: new mirrors refused as paused, and existing positions stay open`, async ({ page }) => {
  test.setTimeout(420_000);
  const tag = Date.now().toString(36);
  const leader = await fundedTrader(page, 'jcl3', '2000');
  const leaderRef = await listLeader(leader, `Journey Exits ${tag}`);
  const follower = await fundedTrader(page, 'jcf3', '1000');
  run.reset({ tag, leader, leaderRef, follower });
  // The TEST trader who takes a copy that rests (takeRestingCopies).
  // It holds enough of each side to take every resting copy, with retries, through the maker's whole ladder in front of
  // it (three levels a side, about 0.28 BTC or 18000 USDT at 65000).
  const market = await fundedTrader(page, 'jcm3', '150000');
  expect(fund(market.email, 'BTC', '2.5').tx).toBeTruthy();
  run.write({ market });
  await signIn(page, follower);
  const followId = await followOnScreen(page, follower, leaderRef, { perOrder: '50', total: '300', fixed: '20' });
  run.write({ followId });
  // Three lead buys: #2's lead close takes from the oldest copy, #3 closes one of the rest, and one is still open when #7
  // leaves. The copy driver copies each leader fill on its own, so a lead buy that fills in two makes two copies.
  // A copied order is listed before the ledger credits its fill (run 701 read the holding with one of two credited), so
  // the state "nothing was sold" is compared with is read only once every buy is closed with all it filled listed as
  // fills, and the ledger holds exactly what those fills credit: each fill's BTC, less a BTC fee, plus a BTC rebate.
  // The follower held no BTC before.
  const openFillIds = [];
  for (const n of [1, 2, 3]) {
    const order = await leadFill(leader, 'buy', '0.001', `${J}-1-open${n}-${tag}`);
    openFillIds.push(...(await leaderFillsOf(leader, order)));
    await expect.poll(() => copiedNow(page), { timeout: 60_000 }).toBe(openFillIds.length);
  }
  await takeRestingCopies(follower, followId, 'buy', openFillIds.length);
  run.write({ openFillIds });
  await expect
    .poll(
      async () => {
        const closed = await (await api(follower)).get(`/api/v1/orders/closed?symbol=${SYMBOL}&limit=50`);
        expect(closed.status, JSON.stringify(closed.body).slice(0, 300)).toBe(200);
        const orders = closed.body.filter((o) => o.side === 'buy' && o.status === 'closed');
        if (orders.length < openFillIds.length) return 'the copied buys are not all closed yet';
        const buys = (await myFills(follower)).filter((f) => f.side === 'buy');
        const listed = buys.reduce((sum, f) => sum + toUnits(f.amount), 0n);
        const filled = orders.reduce((sum, o) => sum + toUnits(o.filled), 0n);
        if (listed !== filled) return `fills list ${listed} of the ${filled} the buys filled`;
        let want = 0n;
        for (const f of buys) {
          want += toUnits(f.amount);
          if (f.fee.currency === 'BTC') want -= toUnits(f.fee.cost);
          if (f.rebate?.currency === 'BTC') want += toUnits(f.rebate.cost);
        }
        const now = (await holdings(follower)).BTC;
        return now === want ? 'exact' : `ledger ${now}, fills say ${want}`;
      },
      { timeout: 60_000, message: 'the ledger never credited every copied buy' },
    )
    .toBe('exact');
  const before = await snapshot(follower, followId);
  expect(before.positions.filter(isOpen).length, 'open copied positions after #1').toBeGreaterThanOrEqual(3);

  const detail = await openFollow(page, leaderRef);
  await act(page, detail, 'Pause');
  await expect(detail.getByText('Paused', { exact: true })).toBeVisible();
  expect((await myFollow(follower, followId)).relationshipState).toBe('PAUSED');
  // A lead buy while paused: svc-trade writes one skip row for each of its fills, as paused, and copies none of it.
  const paused = await leadFill(leader, 'buy', '0.001', `${J}-1-paused-${tag}`);
  const pausedFillIds = await leaderFillsOf(leader, paused);
  run.write({ pausedFillIds });
  await expect
    .poll(
      async () =>
        (await trpcQuery(follower, 'copy.skipLog', { followId })).items
          .map((s) => [s.leaderFillId, s.reason])
          .sort((a, b) => (a[0] < b[0] ? -1 : 1)),
      { timeout: 60_000, message: 'svc-trade never logged the paused lead buy as paused' },
    )
    .toEqual(pausedFillIds.map((id) => [id, 'paused']));
  // The positions stay open: the copied orders, the positions and their open quantities, the person's orders and both
  // ledger totals read exactly as before the pause.
  expect(await snapshot(follower, followId)).toEqual(before);
  expect(await copiedNow(page)).toBe(openFillIds.length);
});

test(`${J} #2 stops with close-only: a new lead fill isn't mirrored, and a lead close still closes the position`, async ({ page }) => {
  // 300 s, not 180 s: taking a resting copy can add up to about 105 s (takeRestingCopies).
  test.setTimeout(300_000);
  const follower = state('follower');
  await signIn(page, follower);
  const followId = state('followId');
  const detail = await openFollow(page, state('leaderRef'));
  const atStop = await snapshot(follower, followId);
  await act(page, detail, 'Stop');
  // Stop is close-only: the follow reads Stopping while the leader's closes still close the copied positions.
  await expect(detail.getByText('Stopping', { exact: true })).toBeVisible();
  await expect(detail.getByText('Close-only: the leader’s closes still close your copied positions.')).toBeVisible();
  // svc-trade holds the follow as close-only, read back by its owner, and the stop itself closed and moved nothing.
  expect((await myFollow(follower, followId)).relationshipState).toBe('CLOSE_ONLY');
  expect(await snapshot(follower, followId)).toEqual(atStop);
  const copied = async () => (await trpcQuery(follower, 'copy.followPositions', { followId })).positions;
  const copiedBefore = await copied();
  const copies = state('openFillIds').length;
  expect(copiedBefore.filter((o) => o.side === 'buy')).toHaveLength(copies);
  const before = await holdings(follower);
  const ordersBefore = await myOrderIds(follower);
  const seen = new Set((await myFills(follower)).map((f) => f.id));

  // A new lead buy: svc-trade writes one skip row for each of its fills, as stopped, and places no copy of it.
  const newBuy = await leadFill(state('leader'), 'buy', '0.001', `${J}-2-new-${state('tag')}`);
  const stoppedFillIds = await leaderFillsOf(state('leader'), newBuy);
  run.write({ stoppedFillIds });
  await expect
    .poll(
      async () =>
        (await trpcQuery(follower, 'copy.skipLog', { followId })).items
          .filter((s) => stoppedFillIds.includes(s.leaderFillId))
          .sort((a, b) => (a.leaderFillId < b.leaderFillId ? -1 : 1))
          .map((s) => [s.leaderFillId, s.reason]),
      { timeout: 60_000, message: 'svc-trade wrote no skip row for the new lead buy' },
    )
    .toEqual(stoppedFillIds.map((id) => [id, 'stopped']));
  expect((await copied()).map((o) => o.orderId).sort()).toEqual(copiedBefore.map((o) => o.orderId).sort());
  expect(await myOrderIds(follower)).toEqual(ordersBefore);
  expect(await holdings(follower)).toEqual(before);

  // The leader's close still closes the person's copied positions: one copied sell, and the ledger moves by exactly
  // what its fills settle.
  // Nothing was sold from any copy yet, so each holds exactly what it bought, and its open is that floored to the lot.
  const lot = await btcLot(follower);
  const positionsBefore = await copiedPositions(follower, followId);
  for (const p of positionsBefore)
    expect(toUnits(p.open), `position ${p.positionId} before the lead close`).toBe((toUnits(p.bought) / lot) * lot);
  await leadFill(state('leader'), 'sell', '0.001', `${J}-2-close-${state('tag')}`);
  await takeRestingCopies(follower, followId, 'sell', 1);
  // The copied sell settles in full before what it sold is read: no copied order of the follow is still live.
  await expect
    .poll(
      async () =>
        (await copied()).filter((o) => o.side === 'sell' && !['pending', 'open', 'recovery_required', 'hold_unknown'].includes(o.status))
          .length,
      {
        timeout: 60_000,
        message: 'the copied sell never settled',
      },
    )
    .toBe(1);
  const sold = await settlesExactly(follower, before, seen);
  expect(sold).toBeGreaterThan(0n);
  await expect
    .poll(async () => (await copiedPositions(follower, followId)).filter((p) => p.closing !== '0').length, {
      timeout: 30_000,
      message: 'a copied position still reads closing after the lead close settled',
    })
    .toBe(0);
  // A lead close names no position: svc-trade takes what the copied sell sold from the oldest copy first, each copy
  // giving up to what it holds. The copies' holdings drop by exactly what was sold, and each copy's open is what it
  // still holds, floored to the lot: a copy it covers reads nothing open, the one it reaches into reads the rest, and
  // every newer copy reads as before.
  const positionsAfter = await copiedPositions(follower, followId);
  expect(positionsAfter.map((p) => p.positionId)).toEqual(positionsBefore.map((p) => p.positionId));
  let left = sold;
  let untouched = 0;
  for (const was of [...positionsBefore].reverse()) {
    const now = positionsAfter.find((p) => p.positionId === was.positionId);
    const held = toUnits(was.bought);
    const take = left < held ? left : held;
    left -= take;
    expect(toUnits(now.open), `position ${was.positionId}: held ${held}, the lead close took ${take}`).toBe(((held - take) / lot) * lot);
    if (take === 0n) {
      untouched += 1;
      expect(now, `position ${was.positionId} is newer than what the lead close sold`).toEqual(was);
    }
  }
  expect(untouched, 'a copy newer than the lead close').toBeGreaterThan(0);
  expect(left, 'the copied sell sold more than the copies held').toBe(0n);
  const after = await copied();
  expect(after.filter((o) => o.side === 'buy')).toHaveLength(copies);
  expect(after.filter((o) => o.side === 'sell')).toHaveLength(1);
  expect(await myOrderIds(follower)).toEqual([...ordersBefore, after.find((o) => o.side === 'sell').orderId].sort());
  // The page shows the same: the buys from before the stop, no copy of the new buy, and one close.
  const orders = copiedOrders(await openFollow(page, state('leaderRef')));
  await expect(orders.filter({ hasText: 'Buy' })).toHaveCount(copies);
  await expect(orders.filter({ hasText: 'Sell' })).toHaveCount(1);
});

// ── #3 #4 on the venue (OWNER 226): a follow that copies onto the follower's own agent account ──────────────────────
//
// The start for #3 and #4: a TEST leader with a TEST wallet buys BTC-USDC on their own venue account on the stack's TEST
// venue, each order signed by that wallet through our door; the follower opens an agent account (a venue sub-account
// under their own TEST wallet, with the agent permission their wallet signs for the key INTAFACED holds, which can trade
// and never withdraw), approves our builder fee on it, and follows the leader onto it. The copy driver copies each lead
// fill as one venue order on that sub-account, placed by the agent permission. The person's own wallet is the TEST key
// signing the venue's own EIP-712 payloads, as the browser wallet does. The follow is made through the API: choosing an
// agent account in the Start copying wizard is J-copy-bots-otc-01's screen (a later piece, a design change shown to the
// owner first). Every figure the TEST venue reports is TEST, read straight from the TEST venue on loopback.
const VSYMBOL = 'BTC-USDC';
const STEP_UP_AGENT = { scope: 'trade.step_up.venue.agentAccount', purpose: 'venue.agentAccount' };
const walletOf = (name) => privateKeyToAccount(keccak256(toHex(`intafaced TEST venue journey trader ${J} ${name} ${run.read().tag}`)));

async function signWith(key, prepared) {
  const t = prepared.typedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  return { digest: prepared.digest, signature, signedBy: key.address.toLowerCase() };
}

const ok = (res) => {
  expect(res.status, JSON.stringify(res.body).slice(0, 600)).toBe(200);
  return res.body;
};

/** One action the person's own wallet signs, through our door: prepared, signed, sent, and accepted by the venue. */
async function walletAct(session, key, { subAccount = null, intent, actionKey = null }) {
  const owner = key.address.toLowerCase();
  const prepared = ok(
    await session.post('/api/v1/venue/prepare', { owner, subAccount, signer: { role: 'owner', address: owner }, intent, actionKey }),
  );
  const sent = ok(
    await session.post('/api/v1/venue/submit', { actionKey: prepared.actionKey, signature: await signWith(key, prepared.prepared) }),
  );
  expect(sent.outcome, JSON.stringify(sent.outcome).slice(0, 300)).toMatchObject({ definite: true, accepted: true });
  return sent;
}

/** Our builder fee rides on every door order: the wallet approves it once on the account, up to the venue's cap. */
async function approveBuilder(session, key, subAccount, tag) {
  const status = ok(await session.get('/api/v1/venue/status'));
  if (!status.builder) return;
  const cap = (await testVenue('/markets', { account: null })).body.value.find((m) => m.symbol === VSYMBOL)?.builderFeeCapBps;
  expect(cap, `${VSYMBOL}'s builder-fee cap as the venue publishes it`).toMatchObject({ known: true });
  await walletAct(session, key, {
    subAccount,
    intent: { kind: 'approve_builder_fee', builder: status.builder.address, maxFeeBps: cap.value },
    actionKey: `approve:${tag}:builder`,
  });
}

/** A venue account as the TEST venue names it. */
const venueAcct = async (owner, subAccount = null) => ({ venueId: (await venueInfo()).id, owner: owner.toLowerCase(), subAccount });
/** The TEST venue's own record for an account, sub-account or main, read directly. */
async function onVenue(path, owner, subAccount = null, extra = {}) {
  const res = await testVenue(path, { account: await venueAcct(owner, subAccount), ...extra });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.value;
}
/** The venue's client order id for one of our business keys (venue-contracts `venueClientOrderId`). */
const cloidOf = async (key) =>
  `0x${createHash('sha256')
    .update(`${(await venueInfo()).id}\u0000${key}`)
    .digest('hex')
    .slice(0, 32)}`;
/** Every fill the venue reports on the follower's agent sub-account. */
const subFills = async () => onVenue('/fills', state('vOwner'), state('vSub'), { since: new Date(0).toISOString() });
const sameUnits = (a, b) => toUnits(String(a)) === toUnits(String(b));

/**
 * The leader fill a venue copy was made for: the leader's own venue fill (`venue:<leader account>:<ms>:<venue fill id>`,
 * svc-trade copy/venue-copy.ts) whose copy key names that position, `copy-mirror:<follow>:<client order id>`.
 */
async function leaderFillOfVenuePosition(positionId) {
  const followId = state('vFollowId');
  const leaderOwner = state('vLeaderOwner');
  for (const f of await onVenue('/fills', leaderOwner, null, { since: new Date(0).toISOString() })) {
    const id = `venue:${leaderOwner}:${new Date(f.filledAt).getTime()}:${f.fillId}`;
    if (`copy-mirror:${followId}:${capped(`copy-mirror:${followId}:${id}`)}` === positionId) return id;
  }
  throw new Error(`no venue fill of the leader's was copied as position ${positionId}`);
}

/** The leader buys once on their own venue account, signed by their own wallet: an IOC that fills against the TEST ladder. */
async function venueLeadBuy(leader, key, n) {
  const book = await testVenue('/book', { symbol: VSYMBOL, depth: 1 });
  const ask = book.body.value?.asks?.[0]?.price;
  expect(ask, `the TEST venue's ${VSYMBOL} ask`).toBeTruthy();
  await walletAct(await api(leader), key, {
    intent: {
      kind: 'place_order',
      symbol: VSYMBOL,
      side: 'buy',
      type: 'limit',
      amount: '0.002',
      price: ask,
      timeInForce: 'IOC',
      reduceOnly: false,
      clientOrderKey: `order:${J}:lead:${run.read().tag}:${n}`,
      builderFee: null,
    },
  });
}

/** The start for #3 and #4 (above); kept in this run's state. */
async function venueStart(page) {
  if (run.read().vFollowId) return;
  const { tag } = run.read();
  const follower = state('follower');
  const leaderKey = walletOf('leader');
  const followerKey = walletOf('follower');
  const leader = await fundedTrader(page, 'jvl3', '10');
  const vLeaderRef = await listLeader(leader, `Journey Venue Exits ${tag}`, { assets: [VSYMBOL] });
  const { chainId } = await venueInfo();
  const ref = (who) => `${chainId}:0x${createHash('sha256').update(`${J}:${tag}:${who}`).digest('hex')}:0`;
  await testDeposit(leaderKey.address.toLowerCase(), 'USDC', '1000', ref('leader'));
  await testDeposit(followerKey.address.toLowerCase(), 'USDC', '500', ref('follower'));
  const leaderSession = await api(leader);
  await approveBuilder(leaderSession, leaderKey, null, `${J}:${tag}:leader`);

  // The follower's agent account: cap TEST 200 USDC, funded 150, with step-up; the wallet signs the open, the agent
  // permission and the move in (J-agents-21 #3's own path).
  const session = await api(follower);
  const passkey = await testPasskey(session);
  run.write({ passkey: passkey.saved() });
  const owner = followerKey.address.toLowerCase();
  const accountId = randomUUID();
  const fields = { accountId, owner, asset: 'USDC', cap: '200', fund: '150' };
  const stepUpApprovalId = await confirmStepUp(session, passkey, { ...STEP_UP_AGENT, target: accountId, amount: '150', fields });
  let view = ok(await session.post('/api/v1/venue/agent-accounts', { ...fields, stepUpApprovalId }));
  for (let i = 0; view.next && i < 5; i += 1) {
    view = ok(
      await session.post(`/api/v1/venue/agent-accounts/${accountId}/submit`, {
        actionKey: view.next.actionKey,
        signature: await signWith(followerKey, view.next.prepared),
      }),
    );
  }
  expect(view.status).toBe('open');
  await approveBuilder(session, followerKey, view.subAccount, `${J}:${tag}:sub`);

  // The follow onto that agent account: fixed TEST 20 USDC a copy, at most 50 a copy and 150 in total; then automatic
  // copying on, as Start copying turns it on.
  const followed = ok(
    await session.post('/api/trade/trpc/copy.follow', {
      leaderRef: vLeaderRef,
      region: 'DE',
      permittedMarkets: [VSYMBOL],
      maxNotionalPerOrder: '50',
      maxAggregateExposure: '150',
      fixedOrderSize: '20',
      expiresAt: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
      clientRequestId: `jc3-venue:${tag}`,
      agentAccountId: accountId,
    }),
  );
  const vFollowId = followed.result.data.followId;
  ok(await session.post('/api/trade/trpc/copy.grantSessionKey', { followId: vFollowId }));
  run.write({
    vLeaderRef,
    vFollowId,
    vAccountId: accountId,
    vOwner: owner,
    vSub: view.subAccount,
    vLeaderOwner: leaderKey.address.toLowerCase(),
  });

  // Three lead buys, each copied by the driver as one venue order on the sub-account: #3 closes one and leaves a part,
  // #4 closes the rest.
  for (const n of [1, 2, 3]) {
    await venueLeadBuy(leader, leaderKey, n);
    await expect
      .poll(async () => (await copiedPositions(follower, vFollowId)).filter(isOpen).length, {
        timeout: 60_000,
        message: `the copy driver never copied lead buy ${n} onto the agent sub-account`,
      })
      .toBe(n);
  }
}

test(`${J} #3 opens Positions and closes one order, then a part larger than open: the close is one venue order by the agent permission, sent once, read closed as the venue reports it; the oversize part refused before anything is sent`, async ({
  page,
}) => {
  test.setTimeout(480_000);
  await venueStart(page);
  const follower = state('follower');
  const followId = state('vFollowId');
  const owner = state('vOwner');
  const subAccount = state('vSub');
  await signIn(page, follower);
  const detail = await openFollow(page, state('vLeaderRef'));
  await detail.getByRole('tab', { name: 'Positions' }).click();
  const table = detail.getByRole('table', { name: 'Copied positions' });
  // The positions are the venue's own record of the sub-account, and the screen says so.
  await expect(detail.getByTestId('copied-positions-source')).toContainText('TEST · As TEST venue simulator reports them');
  const rowOf = async (list, positionId) => {
    const at = list.findIndex((p) => p.positionId === positionId);
    const row = table.locator('tbody tr').nth(at);
    await expect(row).toContainText(list[at].market);
    await expect(row).toContainText(list[at].bought);
    return row;
  };
  const positionsBefore = await copiedPositions(follower, followId);
  const open = positionsBefore.filter(isOpen);
  expect(open.length, 'open copied positions before #3, so closing one is not closing all').toBeGreaterThanOrEqual(2);
  for (const p of positionsBefore) expect(p.reportedBy).toMatchObject({ test: true });
  // Each copied position is what the venue reports its copy filled on the sub-account.
  const fillsBefore = await subFills();
  const bought = fillsBefore.filter((f) => f.side === 'buy').reduce((s, f) => s + toUnits(f.amount), 0n);
  expect(positionsBefore.reduce((s, p) => s + toUnits(p.bought), 0n) <= bought).toBe(true);
  expect(
    fillsBefore.some((f) => f.side === 'sell'),
    'nothing was sold on the sub-account before #3',
  ).toBe(false);
  const target = open[0];
  const others = positionsBefore.filter((p) => p.positionId !== target.positionId);
  // The close runs once under `copy.close:<followId>:<leader fill>`.
  const leaderFill = await leaderFillOfVenuePosition(target.positionId);
  expect(
    await onVenue('/order-by-client-id', owner, subAccount, { venueClientOrderId: await cloidOf(`copy.close:${followId}:${leaderFill}`) }),
  ).toBeNull();
  const mainBefore = await onVenue('/balances', owner);
  const subBefore = await onVenue('/balances', owner, subAccount);

  // Close one, twice at once (the screen's close and the same close by API): one venue order, sent once.
  const row = await rowOf(positionsBefore, target.positionId);
  await row.getByRole('button', { name: 'Close', exact: true }).click();
  const client = await api(follower);
  const onScreen = page.waitForResponse((r) => r.url().includes('copy.closeCopiedPosition'));
  const sent = page.waitForRequest((r) => r.url().includes('copy.closeCopiedPosition'));
  const [, byApi] = await Promise.all([
    page.getByRole('alertdialog').getByRole('button', { name: 'Close' }).click(),
    client.post('/api/trade/trpc/copy.closeCopiedPosition', { followId, positionId: target.positionId }),
  ]);
  expect((await sent).postData() ?? '', 'the screen closed another position').toContain(target.positionId);
  const screenBody = await (await onScreen).json();
  const answers = [screenBody, byApi.body].map((body) => body?.result?.data?.orderId ?? refusalCode({ body }));
  const closeKeys = answers.filter((a) => a && a.startsWith('copy.close:'));
  expect(closeKeys.length, `neither close sent an order: ${JSON.stringify(answers)}`).toBeGreaterThan(0);
  for (const a of answers) expect(['trade.copy_position_closed', closeKeys[0]]).toContain(a);
  const closeKey = closeKeys[0];
  // The close's key names the follow and the leader fill the position was copied from.
  expect(closeKey).toBe(`copy.close:${followId}:${leaderFill}`);
  const cloid = await cloidOf(closeKey);
  // On the venue: one order under that key's client order id, on the agent sub-account, a sell of exactly what was open.
  // Nothing in the browser can sign (no wallet is connected on this page), and the only key INTAFACED holds for that
  // sub-account is its agent key, the one the venue lists on it: the agent permission placed it.
  const order = await onVenue('/order-by-client-id', owner, subAccount, { venueClientOrderId: cloid });
  expect(order, 'the venue has no order under the close key').toBeTruthy();
  expect(order).toMatchObject({ side: 'sell', symbol: VSYMBOL });
  expect(sameUnits(order.amount, target.open)).toBe(true);
  expect((await onVenue('/agents', owner, subAccount)).length).toBe(1);
  expect(await onVenue('/order-by-client-id', owner, null, { venueClientOrderId: cloid })).toBeNull();
  // The position reads closed as the venue reports it: its close's fills sold exactly what was open, and nothing else sold.
  await expect
    .poll(
      async () => {
        const p = (await copiedPositions(follower, followId)).find((x) => x.positionId === target.positionId);
        return p && { open: p.open, closing: p.closing, status: p.status };
      },
      { timeout: 30_000 },
    )
    .toEqual({ open: '0', closing: '0', status: 'closed' });
  await expect(row).toContainText('Closed');
  const sells = (await subFills()).filter((f) => f.side === 'sell');
  expect(sells.every((f) => f.venueClientOrderId === cloid)).toBe(true);
  expect(sells.reduce((s, f) => s + toUnits(f.amount), 0n)).toBe(toUnits(target.open));
  // What it freed stays on the follower's own sub-account, as the venue reports it; the main venue account is untouched.
  const subAfter = await onVenue('/balances', owner, subAccount);
  const usdc = (list) => toUnits(list.find((b) => b.asset === 'USDC')?.total ?? '0');
  expect(usdc(subAfter) > usdc(subBefore)).toBe(true);
  expect(await onVenue('/balances', owner)).toEqual(mainBefore);
  // Every other position is as it was.
  const afterClose = await copiedPositions(follower, followId);
  const stable = (list) => list.map(({ reportedBy: _r, ...p }) => p);
  expect(stable(afterClose.filter((p) => p.positionId !== target.positionId))).toEqual(stable(others));

  // The same close sent again: refused as closed, and no second order reaches the venue.
  const again = await (await api(follower)).post('/api/trade/trpc/copy.closeCopiedPosition', { followId, positionId: target.positionId });
  expect(refusalCode(again), JSON.stringify(again.body).slice(0, 300)).toBe('trade.copy_position_closed');
  expect((await subFills()).filter((f) => f.side === 'sell')).toEqual(sells);

  // A part larger than what is open on a position still open: refused by its typed code before anything is sent.
  const still = afterClose.find((p) => p.positionId !== target.positionId && isOpen(p));
  expect(still, 'an open copied position left for the oversize part').toBeTruthy();
  const openOrdersBefore = await onVenue('/open-orders', owner, subAccount);
  const partRow = await rowOf(afterClose, still.positionId);
  await partRow.getByRole('button', { name: 'Close part' }).click();
  const part = page.getByRole('dialog', { name: 'Close part of this position' });
  await part.getByLabel('Amount').fill('1');
  const oversize = page.waitForResponse((r) => r.url().includes('copy.closeCopiedPosition'));
  const partSent = page.waitForRequest((r) => r.url().includes('copy.closeCopiedPosition'));
  await part.getByRole('button', { name: 'Close' }).click();
  expect((await partSent).postData() ?? '', 'the screen sent the part for another position').toContain(still.positionId);
  expect(refusalCode({ body: await (await oversize).json() })).toBe('trade.copy_close_qty_exceeds');
  await expect(page.getByText('That is more than is open.')).toBeVisible();
  const stillFill = await leaderFillOfVenuePosition(still.positionId);
  expect(
    await onVenue('/order-by-client-id', owner, subAccount, { venueClientOrderId: await cloidOf(`copy.close:${followId}:${stillFill}:1`) }),
  ).toBeNull();
  expect(await onVenue('/open-orders', owner, subAccount)).toEqual(openOrdersBefore);
  expect((await subFills()).filter((f) => f.side === 'sell')).toEqual(sells);
  expect(stable(await copiedPositions(follower, followId))).toEqual(stable(afterClose));
});

test(`${J} #4 presses close-all with an unrealised loss: a step-up opens and the call without its token is refused; with it each position is closed by a venue order and reads closed as the venue reports it`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const follower = state('follower');
  const followId = state('vFollowId');
  const owner = state('vOwner');
  const subAccount = state('vSub');
  const open = (await copiedPositions(follower, followId)).filter(isOpen);
  expect(open.length, 'open copied positions before the close-all').toBeGreaterThan(0);
  // An unrealised loss: each copy was bought at the TEST ask and would sell now at the lower TEST bid.
  const book = (await testVenue('/book', { symbol: VSYMBOL, depth: 1 })).body.value;
  const fills = await subFills();
  const paid = fills.filter((f) => f.side === 'buy').map((f) => toUnits(f.price));
  expect(paid.length).toBeGreaterThan(0);
  expect(
    paid.every((p) => toUnits(book.bids[0].price) < p),
    'the TEST bid is below what every copy paid',
  ).toBe(true);

  // The call without its step-up token: refused, and nothing reaches the venue.
  const sellsBefore = fills.filter((f) => f.side === 'sell');
  const bare = await (await api(follower)).post('/api/trade/trpc/copy.flatten', { followId });
  expect(refusalCode(bare), `svc-trade answered ${bare.status} ${JSON.stringify(bare.body).slice(0, 200)}`).toBe(
    'identity.step_up_required',
  );
  expect((await subFills()).filter((f) => f.side === 'sell')).toEqual(sellsBefore);

  // On screen, pressing Close copied positions opens the step-up sheet before anything is sent.
  await signIn(page, follower);
  const detail = await openFollow(page, state('vLeaderRef'));
  await detail.getByRole('button', { name: 'Close copied positions' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Close copied positions' }).click();
  await expect(page.getByRole('dialog', { name: 'Confirm it’s you' }), 'no step-up opens').toBeVisible();
  expect((await subFills()).filter((f) => f.side === 'sell')).toEqual(sellsBefore);
  await page.keyboard.press('Escape');

  // With the token (the person's TEST passkey answering identity's step-up for exactly this follow and request): one venue
  // order per open position, each under `copy.flatten:<followId>:<leader fill>`, on the agent sub-account.
  const session = await api(follower);
  const passkey = await restorePasskey(state('passkey'));
  const requestId = `jc3-all-${run.read().tag}`;
  const stepUpApprovalId = await confirmStepUp(session, passkey, {
    scope: 'trade.step_up.copy.flatten',
    purpose: 'copy.flatten',
    target: followId,
    fields: { followId, requestId },
  });
  run.write({ passkey: passkey.saved() });
  const done = ok(await session.post('/api/trade/trpc/copy.flatten', { followId, requestId, stepUpApprovalId }));
  const keys = (
    await Promise.all(open.map(async (p) => `copy.flatten:${followId}:${await leaderFillOfVenuePosition(p.positionId)}`))
  ).sort();
  expect([...done.result.data.orderIds].sort()).toEqual(keys);
  for (const key of keys) {
    const order = await onVenue('/order-by-client-id', owner, subAccount, { venueClientOrderId: await cloidOf(key) });
    expect(order, `no venue order under ${key}`).toMatchObject({ side: 'sell', symbol: VSYMBOL });
  }
  // Each position reads closed as the venue reports it: the close-all's fills sold exactly what was open.
  await expect
    .poll(async () => (await copiedPositions(follower, followId)).every((p) => p.status === 'closed'), { timeout: 30_000 })
    .toBe(true);
  expect((await copiedPositions(follower, followId)).filter(isOpen)).toEqual([]);
  const cloids = await Promise.all(keys.map(cloidOf));
  const flattenSells = (await subFills()).filter((f) => f.side === 'sell' && cloids.includes(f.venueClientOrderId));
  expect(flattenSells.reduce((s, f) => s + toUnits(f.amount), 0n)).toBe(open.reduce((s, p) => s + toUnits(p.open), 0n));
  // And the screen lists every one of them as Closed.
  const shown = await openFollow(page, state('vLeaderRef'));
  await shown.getByRole('tab', { name: 'Positions' }).click();
  const rows = shown.getByRole('table', { name: 'Copied positions' }).locator('tbody tr');
  await expect(rows).toHaveCount((await copiedPositions(follower, followId)).length);
  for (const r of await rows.all()) await expect(r).toContainText('Closed');
});

test(`${J} #5 opens the skip log: one row per skipped mirror with the reason in words; a repeat writes no second row`, async ({ page }) => {
  test.setTimeout(180_000);
  const follower = state('follower');
  const followId = state('followId');
  const paused = state('pausedFillIds');
  const stopped = state('stoppedFillIds');
  // svc-trade's log holds exactly the fills skipped while paused (#1) and while stopped (#2), each once.
  const sorted = (rows) => [...rows].sort((a, b) => (a.leaderFillId < b.leaderFillId ? -1 : 1));
  const items = sorted((await trpcQuery(follower, 'copy.skipLog', { followId })).items);
  expect(items.map((s) => [s.leaderFillId, s.reason])).toEqual(
    [...paused.map((id) => [id, 'paused']), ...stopped.map((id) => [id, 'stopped'])].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
  );

  // The screen lists the same rows, each reason in words, no raw code.
  await signIn(page, follower);
  const detail = await openFollow(page, state('leaderRef'));
  await detail.getByRole('tab', { name: 'Skipped' }).click();
  const log = detail.getByRole('table', { name: 'Skipped copies' });
  await expect(log.locator('tbody tr')).toHaveCount(items.length);
  await expect(log.locator('tbody tr').filter({ hasText: 'You had paused this follow' })).toHaveCount(paused.length);
  await expect(log.locator('tbody tr').filter({ hasText: 'You had stopped this follow' })).toHaveCount(stopped.length);
  await expect(log).not.toContainText(/trade\.[a-z_]+/);

  // A new lead buy is skipped as stopped, once per fill, and the rows already logged read exactly as before. This shows
  // a new fill is logged; the repeat of a logged fill is the rewind below.
  const next = await leadFill(state('leader'), 'buy', '0.001', `${J}-5-sweep-${state('tag')}`);
  const nextIds = await leaderFillsOf(state('leader'), next);
  await expect
    .poll(
      async () =>
        sorted((await trpcQuery(follower, 'copy.skipLog', { followId })).items.filter((s) => nextIds.includes(s.leaderFillId))).map((s) => [
          s.leaderFillId,
          s.reason,
        ]),
      { timeout: 60_000, message: 'the copy driver never swept the new lead buy' },
    )
    .toEqual(nextIds.map((id) => [id, 'stopped']));
  const reread = sorted((await trpcQuery(follower, 'copy.skipLog', { followId })).items);
  expect(reread.filter((s) => !nextIds.includes(s.leaderFillId))).toEqual(items);
  expect(reread).toHaveLength(items.length + nextIds.length);
  // A repeat of the same fill: the stack's LOCAL TEST rewind moves the follow's copy cursor to just before one logged
  // fill, and one more lead buy drives one sweep from there. Once that buy's fills are logged, the sweep has passed the
  // rewound fill again: it still has exactly one row, every row reads as before, and nothing was placed or moved.
  const repeated = nextIds[0];
  const atRewind = await snapshot(follower, followId);
  const fillsAtRewind = (await myFills(follower)).map((f) => f.id).sort();
  tool('local-test-gates.mjs', 'copy-rewind', followId, repeated);
  const drive = await leadFill(state('leader'), 'buy', '0.001', `${J}-5-repeat-${state('tag')}`);
  const driveIds = await leaderFillsOf(state('leader'), drive);
  await expect
    .poll(
      async () => (await trpcQuery(follower, 'copy.skipLog', { followId })).items.filter((s) => driveIds.includes(s.leaderFillId)).length,
      { timeout: 60_000, message: 'the copy driver never swept after the rewind' },
    )
    .toBe(driveIds.length);
  const afterRepeat = sorted((await trpcQuery(follower, 'copy.skipLog', { followId })).items);
  expect(
    afterRepeat.filter((s) => s.leaderFillId === repeated),
    `skip rows for the repeated fill ${repeated}`,
  ).toHaveLength(1);
  expect(afterRepeat.filter((s) => !driveIds.includes(s.leaderFillId))).toEqual(reread);
  expect(afterRepeat).toHaveLength(reread.length + driveIds.length);
  expect(await snapshot(follower, followId)).toEqual(atRewind);
  expect((await myFills(follower)).map((f) => f.id).sort()).toEqual(fillsAtRewind);
});

test(`${J} #6 receives an in-app notice for a skipped or stopped follow: the reason and next step, no raw code`, async ({ page }) => {
  const follower = state('follower');
  const followId = state('followId');
  // svc-notify holds exactly one stop notice for #2's close-only stop of this follow, however often it was announced.
  const listed = await (
    await api(follower)
  ).get(`/api/notify/trpc/notify.list?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`);
  expect(listed.status, JSON.stringify(listed.body).slice(0, 300)).toBe(200);
  const inbox = listed.body.result.data;
  const stops = inbox.items.filter((n) => n.kind === 'trade.copy.stopped' && n.params.followId === followId);
  expect(
    stops.map((n) => n.bodyKey),
    'B5 copy notices: no stop notice for this follow in svc-notify',
  ).toEqual(['notify.trade.copy_stopped.body.follower_close_only']);
  // The inbox shows it: the reason (the person stopped it, closes still copied) and the next step, in words, no raw code.
  await signIn(page, follower);
  await page.goto('/notifications');
  const notice = page.getByTestId('nf-row').filter({ hasText: /stopped copying/ });
  await expect(notice).toHaveCount(1);
  await expect(notice).toContainText('Your follow stopped copying');
  await expect(notice).toContainText('You stopped this follow. Only the leader’s closes of what you hold are still copied.');
  await expect(notice).toContainText(/You can /);
  await expect(notice).not.toContainText(/trade\.[a-z_]+|notify\.[a-z_]+/);
});

test(`${J} #7 leaves the leader: the follow is left and the positions stay the person's own; leaving again is refused`, async ({
  page,
}) => {
  const follower = state('follower');
  const followId = state('followId');
  await signIn(page, follower);
  const before = await snapshot(follower, followId);
  expect(
    before.positions.reduce((sum, p) => sum + toUnits(p.open), 0n),
    'a copied position is still open when the follow is left',
  ).toBeGreaterThan(0n);
  const detail = await openFollow(page, state('leaderRef'));
  await act(page, detail, 'Leave leader');
  // The state badge itself: the dialog's "Left to use" limit already contains "Left" before the leave lands (#7739).
  await expect(detail.getByText('Left', { exact: true })).toBeVisible();
  // svc-trade holds the follow as left, and nothing was closed or moved.
  const followAfter = await myFollow(follower, followId);
  expect(followAfter.relationshipState).toBe('DETACHED');
  expect(await snapshot(follower, followId)).toEqual(before);
  // Leaving again: the button is off and says why.
  await expect(detail.getByRole('button', { name: 'Leave leader', exact: true })).toBeDisabled();
  await expect(detail.getByText('Leave leader: You have already left this leader')).toBeVisible();
  // The same leave by API is refused by its typed code, and the follow, its positions, orders and balances read the same.
  const again = await (await api(follower)).post('/api/trade/trpc/copy.detach', { followId });
  expect(refusalCode(again), `leave again: svc-trade answered ${again.status} ${JSON.stringify(again.body).slice(0, 200)}`).toBe(
    'trade.copy_detached',
  );
  expect(await myFollow(follower, followId)).toEqual(followAfter);
  expect(await snapshot(follower, followId)).toEqual(before);
});
