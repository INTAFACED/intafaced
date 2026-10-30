import { createHash } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { api, journeyState, tool, toUnits } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';
import { refusalCode } from './p2p.mjs';
import { copiedOrders, copiedOrdersLoaded, followOnScreen, leadFill, listLeader, openFollow } from './copy.mjs';

// J-copy-bots-otc-03, in the running app (docs/roadmap/journeys.json): pause, stop or leave a copy, close what I choose,
// and read why trades were skipped. One test per step, titled "J-copy-bots-otc-03 #<n>", run in order. #1 makes the
// journey's start: a TEST leader listed by the stack's TEST founder, a verified follower with TEST 1000 USDT who follows
// it on screen, and three copied buys (the leader's own fills on the TEST book, copied by the copy driver), so a close of
// one can be told from a close of all and a position is still open when #7 leaves. Every state is read back from
// svc-trade and every balance from the ledger.
// #5 tries a skipped fill again through the stack's LOCAL TEST rewind (`local-test-gates.mjs copy-rewind`): nothing in the
// running app sends a fill the copy driver has passed through it again.
// A step whose part is not built yet is red by the name of what it waits for:
// - #4 (B3): copy.flatten asks no step-up; today a bare call closes and leaves the follow at once.
// - #6 (B5): no in-app notice for a skipped or stopped follow.
const J = 'J-copy-bots-otc-03';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };
const SYMBOL = 'BTC%2FUSDT';

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

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
  // A second follow for #4's close-all, so a close-all that runs without its step-up can't end the follow #7 leaves. It
  // is made first: on the stack (27 Oct) a follow made before another one of the same person's copied nothing after it.
  const other = await fundedTrader(page, 'jcl3b', '100');
  const otherRef = await listLeader(other, `Journey Exits B ${tag}`);
  await signIn(page, follower);
  run.write({ otherRef, otherFollowId: await followOnScreen(page, follower, otherRef, { perOrder: '50', total: '100', fixed: '20' }) });
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
  await expect(detail).toContainText('Paused');
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
  test.setTimeout(180_000);
  const follower = state('follower');
  await signIn(page, follower);
  const followId = state('followId');
  const detail = await openFollow(page, state('leaderRef'));
  const atStop = await snapshot(follower, followId);
  await act(page, detail, 'Stop');
  // Stop is close-only: the follow reads Stopping while the leader's closes still close the copied positions.
  await expect(detail).toContainText('Stopping');
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

test(`${J} #3 opens Positions and closes one order, then a part larger than open: the close runs once; the oversize part refused`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const follower = state('follower');
  const followId = state('followId');
  await signIn(page, follower);
  const detail = await openFollow(page, state('leaderRef'));
  await detail.getByRole('tab', { name: 'Positions' }).click();
  const table = detail.getByRole('table', { name: 'Copied positions' });
  // The screen lists svc-trade's copied positions in its order (newest first); a row is found by its index there and
  // checked by its market and amount, and the close it sends is checked to name that position.
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
  const target = open[0];
  const others = positionsBefore.filter((p) => p.positionId !== target.positionId);
  // A whole close runs under its business key: the client id of its sell is `copy.close:<follow>:<leader fill>`.
  const closeClientId = capped(`copy.close:${followId}:${await leaderFillOfPosition(follower, followId, target.positionId)}`);
  expect(await orderByClientId(follower, closeClientId), 'no close was placed under the key before').toBeNull();

  // Close one, twice at once (the screen's close and the same close by API): one sell, and the ledger moves once.
  const before = await holdings(follower);
  const ordersBefore = await myOrderIds(follower);
  const seen = new Set((await myFills(follower)).map((f) => f.id));
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
  const closeOrderId = answers.find((a) => a && !a.startsWith('trade.'));
  expect(closeOrderId, `neither close placed a sell: ${JSON.stringify(answers)}`).toBeTruthy();
  for (const a of answers) expect(['trade.copy_position_closed', closeOrderId]).toContain(a);
  const closeOrder = await orderByClientId(follower, closeClientId);
  expect(closeOrder?.id).toBe(closeOrderId);
  expect(closeOrder?.clientOrderId).toBe(closeClientId);
  // The close's order settles: nothing open and nothing closing on that position.
  await expect
    .poll(
      async () => {
        const p = (await copiedPositions(follower, followId)).find((x) => x.positionId === target.positionId);
        return p && { open: p.open, closing: p.closing };
      },
      { timeout: 30_000 },
    )
    .toEqual({ open: '0', closing: '0' });
  await expect(row).toContainText('Closed');
  // The funds return exactly: the ledger reads the balance before, moved by exactly what the close's fills settle; the
  // close sold exactly what was open, all of it in the one sell.
  expect(await settlesExactly(follower, before, seen)).toBe(toUnits(target.open));
  const fresh = (await myFills(follower)).filter((f) => !seen.has(f.id));
  expect(fresh.length).toBeGreaterThan(0);
  for (const f of fresh) expect(f.order).toBe(closeOrderId);
  const ordersAfter = await myOrderIds(follower);
  expect(ordersAfter).toEqual([...ordersBefore, closeOrderId].sort());
  // Every other position is as it was.
  const afterClose = await copiedPositions(follower, followId);
  expect(afterClose.filter((p) => p.positionId !== target.positionId)).toEqual(others);

  // The same close sent again: refused as closed, no second order, nothing moves.
  const settled = await holdings(follower);
  const again = await (await api(follower)).post('/api/trade/trpc/copy.closeCopiedPosition', { followId, positionId: target.positionId });
  expect(refusalCode(again), JSON.stringify(again.body).slice(0, 300)).toBe('trade.copy_position_closed');
  expect(await myOrderIds(follower)).toEqual(ordersAfter);
  expect(await holdings(follower)).toEqual(settled);

  // A part larger than what is open on a position still open: refused by its typed code, and nothing moves. The
  // position record reads as it did.
  const still = afterClose.find((p) => p.positionId !== target.positionId && isOpen(p));
  expect(still, 'an open copied position left for the oversize part').toBeTruthy();
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
  expect(await copiedPositions(follower, followId)).toEqual(afterClose);
  expect(await holdings(follower)).toEqual(settled);
  expect(await myOrderIds(follower)).toEqual(ordersAfter);
});

test(`${J} #4 presses close-all with an unrealised loss: a step-up opens, and the call without its token is refused`, async ({ page }) => {
  const follower = state('follower');
  const bare = await (await api(follower)).post('/api/trade/trpc/copy.flatten', { followId: state('otherFollowId') });
  expect(refusalCode(bare), `B3 close-all step-up: svc-trade answered ${bare.status} ${JSON.stringify(bare.body).slice(0, 200)}`).toBe(
    'identity.step_up_required',
  );
  await signIn(page, follower);
  const detail = await openFollow(page, state('otherRef'));
  await detail.getByRole('button', { name: 'Close copied positions' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Close copied positions' }).click();
  await expect(page.getByRole('dialog', { name: 'Confirm it’s you' }), 'B3 close-all step-up: no step-up opens').toBeVisible(UNBUILT);
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
  await signIn(page, state('follower'));
  await page.goto('/notifications');
  const notice = page.getByRole('article').filter({ hasText: /stopped copying|skipped a copy/i });
  await expect(notice.first(), 'B5 copy notices: no in-app notice for a skipped or stopped follow').toBeVisible(UNBUILT);
  await expect(notice.first()).toContainText(/You can /);
  await expect(notice.first()).not.toContainText(/trade\.[a-z_]+/);
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
  await expect(detail).toContainText('Left');
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
