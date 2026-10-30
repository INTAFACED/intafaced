import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import {
  awayBid,
  confirm,
  fundedTrader,
  openDesk,
  openOrders,
  previewed,
  reviewLimit,
  reviewSheet,
  signIn,
  signUp,
  verify,
} from './desk.mjs';
import { api, fromUnits, fund, signOutBrowser, toUnits, tool } from './stack.mjs';
import { METHOD, p2p, readyTaker, testInstrument, testPasskey } from './p2p.mjs';

// J-home-ia-05, in the running app (docs/roadmap/journeys.json): I read my notifications and allow them on this device.
// Tests titled "J-home-ia-05 #<n>" prove a whole step. One TEST person who is verified, bought 0.001 and then 0.002 BTC at
// market (a notice for each fill of each buy, and the book an earlier journey left can split a buy into several; two buys
// mean a notice opening "on that trade" always picks one of several) and cancelled a resting order (a cancelled-order notice). Every count is read from this account's own fills, never from a fixed book. The stack's
// inbox page size (20), popover size (8) and unread cap (99) are LOCAL TEST values; production has none until the owner
// sets them.
const J = 'J-home-ia-05';

test.describe.configure({ mode: 'serial' });

const bell = (page) => page.getByTestId('tb-bell');
const popup = (page) => page.getByTestId('nf-pop');
const uuidText = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const rawKey = /notify\.[a-z_.]+/;

// POPOVER_ITEMS and PAGE in src/screens/notifications/BellPopover.tsx and NotificationsPage.tsx; the badge caps at 99+.
const POPOVER_ITEMS = 8;
const PAGE_ITEMS = 20;
const badge = (count) => (count > 99 ? '99+' : String(count));
const TITLES = {
  'trade.fill': 'Order filled',
  'trade.order.terminal': 'Order cancelled',
  'identity.kyc.approved': 'Verification approved',
  'ledger.freeze.set': 'Postings paused',
  'ledger.freeze.cleared': 'Postings resumed',
};
// svc-notify's audience-all notices (services/svc-notify/src/freeze-notice.ts): every account holds them, so a journey
// that set the platform posting freeze earlier on the same stack leaves them in this inbox too.
const PLATFORM_KINDS = ['ledger.freeze.set', 'ledger.freeze.cleared'];

let who;
let cancelled;
/** This account's own fills of its two market buys, from svc-trade: one fill notice each. */
let fills;
/** Verified, each fill, cancelled, and any platform-wide notice: every notice this account holds. */
let total;
/** Those notices' kinds, newest first, as svc-notify lists them: the order every screen shows them in. */
let kinds;

/** The inbox as svc-notify tells it, never as the bell draws it: which kinds it holds as read, and its unread count. */
async function told(session) {
  const [list, count] = await Promise.all([
    session.get(`/api/notify/trpc/notify.list?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`),
    session.get('/api/notify/trpc/notify.unreadCount'),
  ]);
  // A refusal fails here by its own words, never as a bare "cannot read" or a poll timeout.
  expect(list.body?.result?.data?.items, `notify.list answered ${JSON.stringify(list.body)}`).toBeInstanceOf(Array);
  expect(count.body?.result?.data?.count, `notify.unreadCount answered ${JSON.stringify(count.body)}`).toBeDefined();
  const items = list.body.result.data.items;
  const read = items
    .filter((item) => item.readAt !== null)
    .map((item) => item.kind)
    .sort();
  return { items, read, unread: count.body.result.data.count };
}

/** A real P2P trade, escrowed: a TEST seller's sell ad, taken for 10 USDT by a TEST buyer (as J-p2p-02 #1 does). */
async function escrowedTrade(page) {
  tool('local-test-gates.mjs', 'p2p');
  const seller = await signUp(page, 'hmns');
  await verify(page, seller);
  expect(fund(seller.email, 'USDT', '50').tx).toBeTruthy();
  const sellerSession = await api(seller);
  const s = p2p(sellerSession, await testPasskey(sellerSession));
  await testInstrument(s, seller);
  const offer = await s.mutate('offers.create', {
    side: 'sell',
    asset: 'USDT',
    fiatCurrency: 'EUR',
    priceType: 'fixed',
    price: '0.92',
    minAmount: '10',
    maxAmount: '50',
    totalAmount: '50',
    methods: [METHOD],
    terms: 'TEST terms: pay from an account in your own name; no third-party payments.',
    idempotencyKey: `${J}:offer:${seller.handle}`,
  });
  await signOutBrowser(page.context());
  const buyer = await signUp(page, 'hmnb');
  await verify(page, buyer);
  const buyerSession = await api(buyer);
  const b = await readyTaker(buyerSession, buyer, await testPasskey(buyerSession));
  const trade = await b.mutate('trades.take', { offerId: offer.id, tradeId: randomUUID(), amount: '10', method: METHOD });
  expect(trade).toMatchObject({ status: 'escrowed', amount: '10' });
  // svc-notify's own (current) notice of the lock lands first, so the stored old one is the newest.
  await expect
    .poll(async () => (await told(buyerSession)).items.some((item) => item.kind === 'p2p.escrow.locked'), { timeout: 20_000 })
    .toBe(true);
  return { buyer, tradeId: trade.id };
}
test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  const page = await browser.newPage();
  who = await fundedTrader(page, 'hmn', '1000');
  await openDesk(page, who);
  for (const amount of ['0.001', '0.002']) {
    await page.locator('[role=tab]', { hasText: /^Market$/ }).click();
    await previewed(page, () => page.getByRole('textbox', { name: 'Amount' }).first().fill(amount));
    await page.getByRole('button', { name: 'Buy BTC' }).click();
    await expect(reviewSheet(page)).toBeVisible();
    await confirm(page, 'buy');
  }
  await reviewLimit(page, 'buy', await awayBid(90), '0.001');
  await confirm(page, 'buy');
  [cancelled] = await openOrders(who);
  expect((await (await api(who)).delete(`/api/v1/orders/${cancelled.id}?symbol=BTC%2FUSDT`)).status).toBe(200);
  // The market buys' fills are the whole 0.003 BTC, and the resting order filled nothing.
  // Read until every fill of both buys is written, then pin them to exactly two orders, neither the cancelled one.
  await expect
    .poll(
      async () => {
        fills = (await (await api(who)).get('/api/v1/account/trades?limit=100')).body;
        return fromUnits(fills.reduce((sum, fill) => sum + toUnits(String(fill.amount)), 0n));
      },
      { timeout: 20_000 },
    )
    .toBe('0.003');
  expect(fills.every((fill) => fill.side === 'buy' && fill.order !== cancelled.id)).toBe(true);
  expect(new Set(fills.map((fill) => fill.order)).size).toBe(2);
  // Verified, each fill and cancelled: this account's own notices, each fill notice one of its own fills. Any other
  // notice is a platform-wide one; all of them are unread.
  const inbox = async () => {
    const listed = await (await api(who)).get(`/api/notify/trpc/notify.list?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`);
    expect(listed.body?.result?.data?.items, `notify.list answered ${JSON.stringify(listed.body)}`).toBeInstanceOf(Array);
    return listed.body.result.data.items;
  };
  const own = (items) => items.filter((item) => !PLATFORM_KINDS.includes(item.kind));
  await expect.poll(async () => own(await inbox()).length, { timeout: 20_000 }).toBe(fills.length + 2);
  const items = await inbox();
  expect(
    own(items)
      .map((item) => item.kind)
      .sort(),
  ).toEqual([...fills.map(() => 'trade.fill'), 'trade.order.terminal', 'identity.kyc.approved'].sort());
  expect(
    items
      .filter((item) => item.kind === 'trade.fill')
      .map((item) => item.params.fillId)
      .sort(),
  ).toEqual(fills.map((fill) => fill.id).sort());
  total = items.length;
  expect(items.filter((item) => item.readAt === null)).toHaveLength(total);
  expect((await (await api(who)).get('/api/notify/trpc/notify.unreadCount')).body?.result?.data?.count).toBe(total);
  kinds = items.map((item) => item.kind);
  await page.close();
});

test(`${J} #1 the bell shows the unread count and a popover of recent notices in plain words`, async ({ page }) => {
  await signIn(page, who);
  await page.goto('/');
  await expect(bell(page)).toHaveAttribute('aria-label', `Notifications, ${total} unread`);
  await expect(bell(page).getByTestId('tb-badge')).toHaveText(badge(total));
  await bell(page).click();
  await expect(popup(page)).toBeVisible();
  // Newest first, as many as the popover holds.
  const shown = Math.min(total, POPOVER_ITEMS);
  await expect(popup(page).getByTestId('nf-row')).toHaveCount(shown);
  await expect(popup(page).locator('[data-testid="nf-row"][data-unread]')).toHaveCount(shown);
  const titles = await popup(page).getByTestId('nf-title').allInnerTexts();
  expect(titles).toEqual(kinds.slice(0, shown).map((kind) => TITLES[kind]));
  const words = await popup(page).innerText();
  expect(words).not.toMatch(uuidText);
  expect(words).not.toMatch(rawKey);
});

test(`${J} #2 a fill notice opens the trade in Activity and is marked read; a cancelled order opens Orders`, async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page, who);
  const session = await api(who);
  await page.goto('/');
  await bell(page).click();
  // The newest fill notice; the popover keeps its order, so it is still the first fill row when the bell opens again.
  const fillRows = (scope) => scope.locator('[data-testid="nf-row"]', { hasText: 'Order filled' });
  await fillRows(popup(page)).first().click();
  // The link names one fill: one of this person's own, and the very one the clicked notice is about.
  await expect(page).toHaveURL((url) => url.pathname === '/money/activity' && /^\?tab=trades&asset=BTC&fill=[^&]+$/.test(url.search));
  const fillId = new URL(page.url()).searchParams.get('fill');
  const fill = fills.find((row) => row.id === fillId);
  expect(fill, `the link's fill ${fillId} is one of ${fills.map((row) => row.id)}`).toBeDefined();
  const notice = (await told(session)).items.find((item) => item.kind === 'trade.fill' && item.params.fillId === fill.id);
  expect(notice, `a fill notice names fill ${fill.id}`).toBeDefined();
  await expect(popup(page)).toHaveCount(0);
  // Every trade of both buys is listed, each with its own amount and price. A buy that filled in parts is one order row
  // (the type and how many fills) with its fills under it.
  const table = page.getByTestId('money-trade-tab');
  const trades = table.locator('tbody tr[data-fill]');
  await expect(trades).toHaveCount(fills.length);
  const partsOf = (order) => fills.filter((row) => row.order === order).length;
  for (const order of new Set(fills.map((row) => row.order))) {
    if (partsOf(order) === 1) continue;
    const bought = fromUnits(fills.filter((row) => row.order === order).reduce((sum, row) => sum + toUnits(String(row.amount)), 0n));
    const head = table.locator(`tbody tr[data-order="${order}"]`);
    await expect(head.getByTestId('dk-trade-what')).toHaveText(`Bought ${bought} BTC`);
    await expect(head).toContainText(`Market order · ${partsOf(order)} fills`);
  }
  for (const row of fills) {
    const shown = trades.and(page.locator(`[data-fill="${row.id}"]`));
    await expect(shown).toHaveCount(1);
    await expect(shown.getByTestId('dk-trade-what')).toHaveText(`Bought ${fromUnits(toUnits(String(row.amount)))} BTC`);
    await expect(shown).toContainText(partsOf(row.order) > 1 ? 'BTC/USDT' : 'BTC/USDT · Market');
    // BTC/USDT's tick is 0.01, so its price shows with exactly two decimals.
    await expect(shown).toContainText(Number(row.price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  }
  // The one the notice named is the current row, and it is in view.
  const current = table.locator('tbody tr[aria-current="true"]');
  await expect(current).toHaveCount(1);
  await expect(current).toHaveAttribute('data-fill', fill.id);
  await expect(current).toBeInViewport();
  await expect(bell(page).getByTestId('tb-badge')).toHaveText(badge(total - 1));
  // Marked read where it is kept: svc-notify holds that fill notice, and only it, as read.
  await expect
    .poll(async () => {
      const now = await told(session);
      return { read: now.items.filter((item) => item.readAt !== null).map((item) => item.id), unread: now.unread };
    })
    .toEqual({ read: [notice.id], unread: total - 1 });
  await bell(page).click();
  await expect(fillRows(popup(page)).first()).not.toHaveAttribute('data-unread');
  const popoverFills = kinds.slice(0, POPOVER_ITEMS).filter((kind) => kind === 'trade.fill').length;
  await expect(fillRows(popup(page)).and(page.locator('[data-unread]'))).toHaveCount(popoverFills - 1);
  await popup(page).locator('[data-testid="nf-row"]', { hasText: 'Order cancelled' }).click();
  await expect(page).toHaveURL(/\/money\/activity\?tab=orders$/);
  // The cancelled order is on screen in the order history, marked Cancelled with nothing filled.
  const order = page
    .getByTestId('money-trade-tab')
    .locator('tbody tr')
    .filter({ has: page.locator(`a[data-testid="dk-order-link"][href="/trade/orders/${cancelled.id}"]`) });
  await expect(order).toHaveCount(1);
  await expect(order.locator('[data-slot="status-tag"]')).toHaveText('Cancelled');
  await expect(order.locator('td').nth(6)).toHaveText('0');
  await expect(bell(page).getByTestId('tb-badge')).toHaveText(badge(total - 2));
  await expect
    .poll(async () => ({ ...(await told(session)), items: undefined }))
    .toEqual({ read: ['trade.fill', 'trade.order.terminal'], unread: total - 2 });

  // The link svc-notify stored on the fill is the in-spec order address (the market buy's own order), not the Activity
  // link the bell builds; opened as stored, it still lands on that order, filled.
  expect(notice.href).toBe(`/trade/orders/${fill.order}`);
  await page.goto(notice.href);
  await expect(page).toHaveURL((url) => url.pathname === notice.href);
  await expect(page.getByRole('heading', { name: 'Buy BTC/USDT', level: 1 })).toBeVisible();
  await expect(page.getByTestId('page-heading')).toContainText('Filled');

  // A link stored before svc-notify moved its targets (PR 5435) is never rewritten. The stack stores one as svc-notify
  // wrote it then (`/p2p/trades/<id>`, with the lock's own params) for a real escrowed P2P trade of another TEST person,
  // who opens it from the bell and lands on that very order. svc-notify's current notice of the same lock opens the same
  // order, so it is read first: the one unread escrow row is the old one.
  const { buyer, tradeId } = await escrowedTrade(page);
  const buyerSession = await api(buyer);
  expect((await buyerSession.post('/api/notify/trpc/notify.markAllRead', {})).status).toBe(200);
  tool('local-test-stack.mjs', 'seed-notice', buyer.email, tradeId);
  const escrow = (await told(buyerSession)).items.filter((item) => item.kind === 'p2p.escrow.locked');
  expect(escrow.filter((item) => item.readAt === null)).toEqual([expect.objectContaining({ href: `/p2p/trades/${tradeId}` })]);
  await signOutBrowser(page.context());
  await signIn(page, buyer);
  await page.goto('/');
  await bell(page).click();
  const row = popup(page).locator('[data-testid="nf-row"][data-unread]', { hasText: 'Escrow locked' });
  await expect(row).toHaveCount(1);
  expect(await row.innerText()).not.toMatch(rawKey);
  expect(await row.innerText()).toMatch(/10 USDT locked/);
  await row.click();
  await expect(page).toHaveURL((url) => url.pathname === '/uc/order' && url.searchParams.get('tradeId') === tradeId);
  const p2pOrder = page.getByRole('main');
  await expect(p2pOrder.getByTestId('p2p-order-identity')).toContainText('You are the buyer');
  await expect(p2pOrder.getByTestId('p2p-order-quantities')).toContainText('10');
  await expect(p2pOrder.getByTestId('p2p-order-quantities')).toContainText('USDT');
  await expect(p2pOrder).not.toContainText('The request was refused');
});

test(`${J} #3 the full page: All and Unread, Mark all as read clears the dots and the badge, an empty Unread tab`, async ({ page }) => {
  await signIn(page, who);
  await page.goto('/notifications');
  const pageRows = Math.min(total, PAGE_ITEMS);
  await expect(page.getByTestId('nf-row')).toHaveCount(pageRows);
  // Unread: the fills #2 did not open, and the verification.
  await page.getByRole('tab', { name: 'Unread' }).click();
  await expect(page.getByTestId('nf-row')).toHaveCount(Math.min(total - 2, PAGE_ITEMS));
  const unread = kinds.filter((kind) => kind !== 'trade.order.terminal');
  unread.splice(unread.indexOf('trade.fill'), 1);
  await expect(page.getByTestId('nf-title')).toHaveText(unread.slice(0, PAGE_ITEMS).map((kind) => TITLES[kind]));
  await page.getByRole('button', { name: 'Mark all as read' }).click();
  await expect(page.getByText("You're all caught up.")).toBeVisible();
  await expect(bell(page).getByTestId('tb-badge')).toHaveCount(0);
  await page.getByRole('tab', { name: 'All' }).click();
  await expect(page.getByTestId('nf-row')).toHaveCount(pageRows);
  await expect(page.locator('[data-testid="nf-row"][data-unread]')).toHaveCount(0);
  // Load more only when the account holds more notices than one page.
  await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(total > PAGE_ITEMS ? 1 : 0);
  expect(await page.locator('main').innerText()).not.toMatch(uuidText);
});

/** Counts the browser's permission prompts on this page, from before the app loads. */
async function countPrompts(page) {
  await page.addInitScript(() => {
    window.__prompts = 0;
    const ask = Notification.requestPermission.bind(Notification);
    Notification.requestPermission = (...args) => {
      window.__prompts += 1;
      return ask(...args);
    };
  });
  return () => page.evaluate(() => window.__prompts);
}

const pushCard = (page) => page.locator('[data-testid="nf-channelcard"][data-channel="push"]');

test(`${J} #4 Allow notifications on this device asks the browser only on the press, and a block says what is lost and how to change it`, async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const prompts = await countPrompts(page);
  await signIn(page, who);
  await page.goto('/notifications?view=settings');
  const card = pushCard(page);
  await expect(card.getByRole('button', { name: 'Allow notifications on this device' })).toBeVisible();
  // Nothing is asked, and no state is claimed, on load.
  expect(await prompts()).toBe(0);
  await expect(card.getByTestId('nf-push__state')).toHaveCount(0);
  // This browser answers the prompt with a block (no grant was given to the context).
  await card.getByRole('button', { name: 'Allow notifications on this device' }).click();
  await expect(card.getByTestId('nf-push__state')).toHaveText('Blocked on this device.');
  expect(await prompts()).toBe(1);
  await expect(card).toContainText('No alert reaches this device while notifications are blocked; your in-app inbox still works.');
  await expect(card).toContainText('open this site’s settings in your browser, allow notifications');
  // Nothing was registered: the device is not on the account.
  const stored = await (await api(who)).get('/api/notify/trpc/notify.targets');
  expect(stored.body.result.data.filter((row) => row.channel === 'push')).toEqual([]);
  await context.close();
});

test(`${J} #5 allowed while the push gateway is not configured: the service-off sentence with vendor.push, nothing registered, and an empty inbox stays an empty state`, async ({
  browser,
}) => {
  const context = await browser.newContext();
  await context.grantPermissions(['notifications']);
  const page = await context.newPage();
  const prompts = await countPrompts(page);
  await signIn(page, who);
  await page.goto('/notifications?view=settings');
  const card = pushCard(page);
  await card.getByRole('button', { name: 'Allow notifications on this device' }).click();
  await expect(card.getByTestId('nf-push__state')).toHaveText('Allowed on this device, not registered.');
  // Already allowed: the browser is not asked again.
  expect(await prompts()).toBe(0);
  const off = card.locator('[data-not-connected="vendor.push"]');
  await expect(off).toHaveText('Registering this device needs a push delivery gateway. It is switched off in this build. vendor.push');
  const stored = await (await api(who)).get('/api/notify/trpc/notify.targets');
  expect(stored.body.result.data.filter((row) => row.channel === 'push')).toEqual([]);
  // The inbox (all read since #3) shows its empty Unread state, never the service-off notice.
  await page.goto('/notifications');
  await page.getByRole('tab', { name: 'Unread' }).click();
  await expect(page.getByText("You're all caught up.")).toBeVisible();
  await expect(page.locator('[data-not-connected]')).toHaveCount(0);
  await context.close();
});
