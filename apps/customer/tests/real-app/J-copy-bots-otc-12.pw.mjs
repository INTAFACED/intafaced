// World: book, gates
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { api, bestPrices, journeyState, toUnits } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';
import { copiedOrders, followOnScreen, leadFill, listLeader, openFollow } from './copy.mjs';
import { tableIn, bodyRows } from './tables.mjs';

// J-copy-bots-otc-12, in the running app (docs/roadmap/journeys.json): two founders pause copy or bots by lead, bot type
// or symbol on the console's /trade-ops/kill-switch, "Copy and bots" tab. One test per step, titled
// "J-copy-bots-otc-12 #<n>", run in order. Founders A and B are the stack's LOCAL TEST founder pair (admin.mjs).
// #1 makes the start: a TEST leader on BTC/USDT and a verified follower copying it, with one copied buy. #2 starts a TEST
// grid bot before the pause. #3 makes a second TEST leader on ETH/USDT that the follower copies once, and a TEST TWAP bot
// on ETH/USDT that has placed a slice. Mirrors, skips, bots and slices are read back from svc-trade.
// A pause is platform-wide: every scope this file paused is resumed by two founders once the file is done, pass or fail.
const J = 'J-copy-bots-otc-12';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

/** The pause desk's own server route, from a console page signed in as a founder, with its CSRF token: { status, body }. */
async function pauseCall(page, body) {
  return page.evaluate(async (input) => {
    const session = await (await fetch('/api/session', { cache: 'no-store' })).json();
    const res = await fetch('/api/trade-ops/copy-bots-pauses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-intafaced-csrf': session.csrf },
      body: JSON.stringify(input),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, body);
}

/** svc-trade's pause desk as the console reads it: { paused, waiting }. */
async function readPauses(page) {
  const { status, body } = await pauseCall(page, { action: 'read' });
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body.data;
}

const pausedNow = (desk, kind, value) => desk.paused.some((p) => p.scope.kind === kind && p.scope.value === value);

/** A founder on the kill switch room, on the Copy and bots tab. */
async function killSwitch(browser, key = 'a') {
  const page = await (await browser.newContext()).newPage();
  await founderSignIn(page, key);
  // The room opens on the Copy and bots tab from its link, so no click can be lost to hydration or a re-render.
  await page.goto(`${ADMIN}/trade-ops/kill-switch?tab=copy-bots`);
  await expect(page.getByRole('tab', { name: 'Copy and bots' })).toHaveAttribute('aria-selected', 'true', UNBUILT);
  return page;
}

/** Remembers a scope this file paused, so it is resumed once the file is done. */
function remember(kind, value) {
  const paused = run.read().paused ?? [];
  if (!paused.some((p) => p.kind === kind && p.value === value)) run.write({ paused: [...paused, { kind, value }] });
}

/**
 * Founder A sets the form with `ask` and asks for a second founder; A is offered no confirm of their own request. Founder
 * B confirms it. Returns svc-trade's desk as B reads it after, and the request as it was filed.
 */
async function twoFounders(browser, ask) {
  const a = await killSwitch(browser, 'a');
  const before = await readPauses(a);
  await ask(a);
  await a.getByRole('button', { name: 'Ask for a second founder' }).click();
  await expect(a.getByRole('status').filter({ hasText: 'Sent for a second founder' })).toBeVisible();
  const filed = (await readPauses(a)).waiting.filter((w) => !before.waiting.some((x) => x.id === w.id));
  expect(filed, 'one request waits for a second founder').toHaveLength(1);
  const [request] = filed;
  const mine = bodyRows(tableIn(a, 'Waiting for a second founder')).filter({ hasText: request.scope.value });
  await expect(mine.first()).toContainText('Waiting for a second founder');
  await expect(mine.getByRole('button', { name: 'Confirm' })).toHaveCount(0);
  // Nothing changed yet: one founder's ask alone applies nothing.
  expect(pausedNow(await readPauses(a), request.scope.kind, request.scope.value)).toBe(request.op === 'resume');
  await a.context().close();

  const b = await killSwitch(browser, 'b');
  await bodyRows(tableIn(b, 'Waiting for a second founder'))
    .filter({ hasText: request.scope.value })
    .getByRole('button', { name: 'Confirm' })
    .click();
  await expect(b.getByRole('status').filter({ hasText: request.op === 'pause' ? 'Paused' : 'Resumed' })).toBeVisible();
  const after = await readPauses(b);
  await b.context().close();
  expect(after.waiting.map((w) => w.id)).not.toContain(request.id);
  expect(pausedNow(after, request.scope.kind, request.scope.value)).toBe(request.op === 'pause');
  if (request.op === 'pause') remember(request.scope.kind, request.scope.value);
  return { after, request };
}

/** Pause a scope through the form. */
const pauseScope = (kind, value) => async (a) => {
  await a.getByLabel('Scope', { exact: true }).selectOption(kind === 'lead' ? 'Lead' : kind === 'bot_type' ? 'Bot type' : 'Symbol');
  if (kind === 'bot_type') await a.getByLabel('Bot type', { exact: true }).selectOption({ value });
  else await a.getByLabel(kind === 'lead' ? 'Lead' : 'Symbol', { exact: true }).fill(value);
};

/** Resume a paused scope from its row. */
const resumeScope = (value) => async (a) => {
  await bodyRows(tableIn(a, 'Paused scopes')).filter({ hasText: value }).getByRole('button', { name: 'Resume' }).click();
};

/** The follower's skip log on one follow, as svc-trade gives it. */
async function skipLog(who, followId) {
  const res = await (await api(who)).get(`/api/trade/trpc/copy.skipLog?input=${encodeURIComponent(JSON.stringify({ followId }))}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data.items;
}

/** A fill the leader made just now that the follower's copy driver has had its sweep to copy or skip. */
async function skippedAs(who, followId, count) {
  await expect
    .poll(async () => (await skipLog(who, followId)).filter((s) => s.reason === 'platform_paused').length, { timeout: 60_000 })
    .toBe(count);
}

/** A grid bot, through the owner's own grid door: { status, body }. */
async function createGrid(who, clientRequestId, symbol = 'BTC/USDT') {
  const { body: book } = await bestPrices(symbol);
  const mid = (toUnits(book.bids[0][0]) + toUnits(book.asks[0][0])) / 2n;
  const units = (v) => String(v / toUnits('1'));
  const res = await (
    await api(who)
  ).post('/api/trade/trpc/bots.grid.create', {
    clientRequestId,
    symbol,
    lowerPrice: units((mid * 98n) / 100n),
    upperPrice: units((mid * 102n) / 100n),
    gridCount: 5,
    investment: '200',
  });
  return res;
}

async function gridGet(who, botId) {
  const res = await (await api(who)).get(`/api/trade/trpc/bots.grid.get?input=${encodeURIComponent(JSON.stringify({ botId }))}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

async function gridList(who) {
  const res = await (await api(who)).get('/api/trade/trpc/bots.grid.list');
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

/** The algo bot as its owner reads it. */
async function algoGet(who, algoId) {
  const res = await (await api(who)).get(`/api/trade/trpc/algo.get?input=${encodeURIComponent(JSON.stringify({ algoId }))}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

/** The slices an algo bot has taken: children placed and misses recorded. */
const slicesOf = (parent) => (parent.children?.length ?? 0) + (parent.misses?.length ?? 0);

const codeOf = (body) => body?.error?.data?.cause?.code ?? body?.error?.json?.data?.cause?.code;

test.afterAll(async ({ browser }) => {
  // Every scope this file paused is resumed by two founders, so no other journey runs under it.
  const { paused = [], twapOwner, twapId, gridOwner, gridId } = run.read();
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  try {
    await founderSignIn(a, 'a');
    await a.goto(`${ADMIN}/trade-ops/kill-switch`);
    await founderSignIn(b, 'b');
    await b.goto(`${ADMIN}/trade-ops/kill-switch`);
    for (const scope of paused) {
      if (!pausedNow(await readPauses(a), scope.kind, scope.value)) continue;
      const asked = await pauseCall(a, { action: 'ask', op: 'resume', scope });
      if (asked.status !== 200) continue;
      await pauseCall(b, { action: 'confirm', requestId: asked.body.data.id });
    }
  } finally {
    await a.context().close();
    await b.context().close();
  }
  // The bots this file started stop, so they place nothing after it.
  if (twapOwner && twapId) await (await api(twapOwner)).post('/api/trade/trpc/algo.cancel', { algoId: twapId }).catch(() => null);
  if (gridOwner && gridId) await (await api(gridOwner)).post('/api/trade/trpc/bots.grid.stop', { botId: gridId }).catch(() => null);
});

test(`${J} #1 pauses one lead: the next mirror for that lead is refused as paused by the platform, and existing positions keep running`, async ({
  page,
  browser,
}) => {
  test.setTimeout(420_000);
  const tag = Date.now().toString(36);
  const leader = await fundedTrader(page, 'jcl12', '2000');
  const leaderName = `Journey Pause ${tag}`;
  const leaderRef = await listLeader(leader, leaderName);
  const follower = await fundedTrader(page, 'jcf12', '1000');
  run.reset({ tag, leader, leaderName, leaderRef, follower, paused: [] });
  await signIn(page, follower);
  const followId = await followOnScreen(page, follower, leaderRef, { perOrder: '50', total: '300', fixed: '20' });
  await leadFill(leader, 'buy', '0.001', `${J}-1-a-${tag}`);
  await expect(async () => {
    await expect(copiedOrders(await openFollow(page, leaderRef))).toHaveCount(1, { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  run.write({ followId });
  const holding = (await (await api(follower)).balances()).BTC.total;
  expect(toUnits(holding), 'the copied buy is held').toBeGreaterThan(0n);

  const { request } = await twoFounders(browser, pauseScope('lead', leaderRef));
  expect(request).toMatchObject({ op: 'pause', scope: { kind: 'lead', value: leaderRef } });

  // The lead's next fill: the mirror is refused, named as paused by the platform, and nothing is copied.
  await leadFill(leader, 'buy', '0.001', `${J}-1-b-${tag}`);
  await skippedAs(follower, followId, 1);
  await expect(copiedOrders(await openFollow(page, leaderRef))).toHaveCount(1);
  // What the follower already holds keeps running: the copied position is untouched.
  expect((await (await api(follower)).balances()).BTC.total).toBe(holding);
  // The follow's skipped copies name the reason in the follower's words.
  const detail = await openFollow(page, leaderRef);
  await detail.getByRole('tab', { name: 'Skipped' }).click();
  await expect(detail.getByText('Paused by the platform').first()).toBeVisible();
});

test(`${J} #2 pauses a bot type such as grid: a new grid is refused and running grids continue`, async ({ page, browser }) => {
  test.setTimeout(300_000);
  const tag = state('tag');
  const owner = await fundedTrader(page, 'jcg12', '1000');
  // A grid running before the pause.
  const made = await createGrid(owner, `${J}-2-run-${tag}`);
  expect(made.status, JSON.stringify(made.body).slice(0, 400)).toBe(200);
  const gridId = made.body.result.data.botId;
  run.write({ gridOwner: owner, gridId });
  await expect.poll(async () => (await gridGet(owner, gridId)).status, { timeout: 60_000 }).toMatch(/^(running|paused_range)$/);

  await twoFounders(browser, pauseScope('bot_type', 'grid'));

  // A new grid is refused by the pause's code, and none is made.
  const listed = (await gridList(owner)).length;
  const refused = await createGrid(owner, `${J}-2-new-${tag}`);
  expect(refused.status, JSON.stringify(refused.body).slice(0, 400)).not.toBe(200);
  expect(codeOf(refused.body), JSON.stringify(refused.body).slice(0, 400)).toBe('trade.bots_paused_by_platform');
  expect((await gridList(owner)).length).toBe(listed);
  // The running grid continues: still live after the bot ticks have passed, with its level orders still working.
  await page.waitForTimeout(20_000);
  const after = await gridGet(owner, gridId);
  expect(after.status).toMatch(/^(running|paused_range)$/);
  expect(after.statusReason ?? '').not.toContain('paused_by_platform');
  expect(after.orders.length, 'the running grid still has its level orders').toBeGreaterThan(0);
  // The customer's bot catalogue says so on the grid row.
  await signIn(page, owner);
  await page.goto('/trade/bots');
  await expect(tableIn(page, 'Bot catalogue').getByRole('row', { name: /Grid/ }).first()).toContainText('Paused by the platform');
});

test(`${J} #3 halts a symbol: copy mirrors and bot slices on it stop`, async ({ page, browser }) => {
  test.setTimeout(480_000);
  const tag = state('tag');
  const follower = state('follower');
  // A second TEST leader on ETH/USDT that the follower copies once.
  const leader2 = await fundedTrader(page, 'jce12', '3000');
  const leader2Ref = await listLeader(leader2, `Journey Halt ${tag}`, { assets: ['ETH/USDT'] });
  run.write({ leader2, leader2Ref });
  await signIn(page, follower);
  const follow2Id = await followOnScreen(page, follower, leader2Ref, { perOrder: '50', total: '300', fixed: '20', markets: ['ETH/USDT'] });
  await leadFill(leader2, 'buy', '0.01', `${J}-3-a-${tag}`, 'ETH/USDT');
  await expect(async () => {
    await expect(copiedOrders(await openFollow(page, leader2Ref))).toHaveCount(1, { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });

  // A TEST TWAP bot on ETH/USDT that has placed its first slice.
  const owner = await fundedTrader(page, 'jct12', '1000');
  const { body: book } = await bestPrices('ETH/USDT');
  const limitPrice = String((toUnits(book.asks[0][0]) * 101n) / 100n / toUnits('1') + 1n);
  const made = await (
    await api(owner)
  ).post('/api/trade/trpc/algo.createTwap', {
    symbol: 'ETH/USDT',
    side: 'buy',
    totalQty: '0.05',
    durationMs: 600_000,
    sliceIntervalMs: 20_000,
    limitPrice,
    clientAlgoId: `${J}-3-${tag}`,
    kind: 'twap',
  });
  expect(made.status, JSON.stringify(made.body).slice(0, 300)).toBe(200);
  const twapId = made.body.result.data.id;
  run.write({ twapOwner: owner, twapId });
  // A slice is a placed child or a recorded miss (no liquidity at the limit): either way the bot acted at its due time.
  await expect
    .poll(async () => slicesOf(await algoGet(owner, twapId)), { timeout: 120_000, message: 'the TWAP took no slice before the halt' })
    .toBeGreaterThan(0);

  await twoFounders(browser, pauseScope('symbol', 'ETH/USDT'));

  // Bot slices on ETH/USDT stop: over three slice intervals the bot takes no slice (no child placed, no miss), and it is
  // still live, not ended.
  const slicesAtHalt = slicesOf(await algoGet(owner, twapId));
  await page.waitForTimeout(65_000);
  const halted = await algoGet(owner, twapId);
  expect(slicesOf(halted), `no slice while the symbol is halted: ${JSON.stringify(halted).slice(0, 400)}`).toBe(slicesAtHalt);
  expect(halted.status).toBe('active');
  // A new bot on ETH/USDT is refused by the pause's code.
  const another = await (
    await api(owner)
  ).post('/api/trade/trpc/algo.createTwap', {
    symbol: 'ETH/USDT',
    side: 'buy',
    totalQty: '0.01',
    durationMs: 600_000,
    sliceIntervalMs: 20_000,
    limitPrice,
    clientAlgoId: `${J}-3-new-${tag}`,
    kind: 'twap',
  });
  expect(codeOf(another.body), JSON.stringify(another.body).slice(0, 300)).toBe('trade.bots_paused_by_platform');

  // Copy mirrors on ETH/USDT stop: the leader's next ETH fill is refused as paused by the platform, nothing is copied.
  await leadFill(leader2, 'buy', '0.01', `${J}-3-b-${tag}`, 'ETH/USDT');
  await skippedAs(follower, follow2Id, 1);
  // The TWAP owner was made on this page after the follower signed in, and fundedTrader's verify() signs the page out
  // (desk.mjs signOutBrowser), so the follower signs in again here.
  await signIn(page, follower);
  await expect(copiedOrders(await openFollow(page, leader2Ref))).toHaveCount(1);
  await page.goto('/trade/copy?tab=follows');
  await expect(page.getByText('Copying on ETH/USDT is paused by the platform.')).toBeVisible();
});

test(`${J} #4 tries a pause with one founder: refused`, async ({ browser }) => {
  const a = await killSwitch(browser, 'a');
  const before = await readPauses(a);
  expect(pausedNow(before, 'bot_type', 'twap')).toBe(false);
  await a.getByLabel('Scope', { exact: true }).selectOption('Bot type');
  await a.getByLabel('Bot type', { exact: true }).selectOption({ value: 'twap' });
  const [answer] = await Promise.all([
    a.waitForResponse((r) => r.url().endsWith('/api/trade-ops/copy-bots-pauses') && r.request().postDataJSON()?.action === 'now'),
    a.getByRole('button', { name: 'Pause now' }).click(),
  ]);
  const body = await answer.json();
  expect([answer.status(), body.code]).toEqual([409, 'trade_ops.copy_bots_second_founder_required']);
  await expect(a.getByRole('alert').filter({ hasText: 'A second founder must confirm this.' })).toBeVisible();
  // Nothing changed: TWAP bots are not paused and no request waits.
  const after = await readPauses(a);
  expect(pausedNow(after, 'bot_type', 'twap')).toBe(false);
  expect(after.paused.map((p) => p.id).sort()).toEqual(before.paused.map((p) => p.id).sort());
  expect(after.waiting.map((w) => w.id).sort()).toEqual(before.waiting.map((w) => w.id).sort());
  await a.context().close();
});

test(`${J} #5 resumes with two founders: the scope runs again and an audit row exists`, async ({ page, browser }) => {
  test.setTimeout(300_000);
  const leaderRef = state('leaderRef');
  const { request } = await twoFounders(browser, resumeScope(leaderRef));
  expect(request).toMatchObject({ op: 'resume', scope: { kind: 'lead', value: leaderRef } });

  // The lead runs again: its next fill is copied.
  await leadFill(state('leader'), 'buy', '0.001', `${J}-5-${state('tag')}`);
  await signIn(page, state('follower'));
  await expect(async () => {
    await expect(copiedOrders(await openFollow(page, leaderRef))).toHaveCount(2, { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  expect((await skipLog(state('follower'), state('followId'))).filter((s) => s.reason === 'platform_paused')).toHaveLength(1);

  // The trade audit holds one resume row for this lead, asked by one founder and approved by the other.
  const founder = await (await browser.newContext()).newPage();
  await founderSignIn(founder, 'a');
  await founder.goto(`${ADMIN}/trade-ops/audit?kind=copy_bots.resume`);
  const rows = founder.getByRole('row').filter({ hasText: `lead:${leaderRef}` });
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('copy_bots.resume');
  const operator = (await rows.getByTestId('audit-operator').textContent())?.trim();
  expect(operator).toBe(request.proposedBy);
  await expect(rows).not.toContainText(/None\s*$/);
  await founder.goto(`${ADMIN}/trade-ops/audit?kind=copy_bots.pause`);
  await expect(founder.getByRole('row').filter({ hasText: `lead:${leaderRef}` })).toHaveCount(1);
  await founder.context().close();
});
