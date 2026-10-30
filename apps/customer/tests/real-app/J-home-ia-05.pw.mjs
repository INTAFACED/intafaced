import { test, expect } from '@playwright/test';
import { awayBid, confirm, fundedTrader, openDesk, openOrders, previewed, reviewLimit, reviewSheet, signIn } from './desk.mjs';
import { api, fromUnits, toUnits } from './stack.mjs';

// J-home-ia-05, in the running app (docs/roadmap/journeys.json): I read my notifications and allow them on this device.
// Tests titled "J-home-ia-05 #<n>" prove a whole step. One TEST person who is verified, bought 0.001 BTC at market (a notice
// for each fill of that buy, and the book an earlier journey left can split it into several) and cancelled a resting order
// (a cancelled-order notice). Every count is read from this account's own fills, never from a fixed book. The stack's
// inbox page size (20), popover size (8) and unread cap (99) are LOCAL TEST values; production has none until the owner
// sets them.
const J = 'J-home-ia-05';

test.describe.configure({ mode: 'serial' });

const bell = (page) => page.getByTestId('tb-bell');
const popup = (page) => page.getByTestId('nf-pop');
const uuidText = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const rawKey = /notify\.[a-z_.]+/;

const POPOVER_ITEMS = 8;
const PAGE_ITEMS = 20;

let who;
let cancelled;
/** This account's own fills of its market buy, from svc-trade: one fill notice each. */
let fills;
/** Verified, each fill, cancelled: every notice this account holds. */
let total;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  const page = await browser.newPage();
  who = await fundedTrader(page, 'hmn', '1000');
  await openDesk(page, who);
  await page.locator('[role=tab]', { hasText: /^Market$/ }).click();
  await previewed(page, () => page.getByRole('textbox', { name: 'Amount' }).first().fill('0.001'));
  await page.getByRole('button', { name: 'Buy BTC' }).click();
  await expect(reviewSheet(page)).toBeVisible();
  await confirm(page, 'buy');
  await reviewLimit(page, 'buy', await awayBid(90), '0.001');
  await confirm(page, 'buy');
  [cancelled] = await openOrders(who);
  expect((await (await api(who)).delete(`/api/v1/orders/${cancelled.id}?symbol=BTC%2FUSDT`)).status).toBe(200);
  // The market buy's fills are the whole 0.001 BTC, and the resting order filled nothing.
  fills = (await (await api(who)).get('/api/v1/account/trades?limit=100')).body;
  expect(fills.length, JSON.stringify(fills)).toBeGreaterThan(0);
  expect(fills.every((fill) => fill.side === 'buy' && fill.order !== cancelled.id)).toBe(true);
  expect(fromUnits(fills.reduce((sum, fill) => sum + toUnits(String(fill.amount)), 0n))).toBe('0.001');
  total = fills.length + 2;
  // Verified, each fill and cancelled: all unread, and each fill notice is one of this account's own fills.
  await expect
    .poll(async () => (await (await api(who)).get('/api/notify/trpc/notify.unreadCount')).body?.result?.data?.count, { timeout: 20_000 })
    .toBe(total);
  const listed = await (await api(who)).get(`/api/notify/trpc/notify.list?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`);
  const items = listed.body?.result?.data?.items;
  expect(items, `notify.list answered ${JSON.stringify(listed.body)}`).toBeInstanceOf(Array);
  expect(items.map((item) => item.kind).sort()).toEqual(
    [...fills.map(() => 'trade.fill'), 'trade.order.terminal', 'identity.kyc.approved'].sort(),
  );
  expect(
    items
      .filter((item) => item.kind === 'trade.fill')
      .map((item) => item.params.fillId)
      .sort(),
  ).toEqual(fills.map((fill) => fill.id).sort());
  await page.close();
});

test(`${J} #1 the bell shows the unread count and a popover of recent notices in plain words`, async ({ page }) => {
  await signIn(page, who);
  await page.goto('/');
  await expect(bell(page)).toHaveAttribute('aria-label', `Notifications, ${total} unread`);
  await expect(bell(page).getByTestId('tb-badge')).toHaveText(String(total));
  await bell(page).click();
  await expect(popup(page)).toBeVisible();
  // Newest first, as many as the popover holds.
  const shown = Math.min(total, POPOVER_ITEMS);
  await expect(popup(page).getByTestId('nf-row')).toHaveCount(shown);
  await expect(popup(page).locator('[data-testid="nf-row"][data-unread]')).toHaveCount(shown);
  const titles = await popup(page).getByTestId('nf-title').allInnerTexts();
  expect(titles).toEqual(['Order cancelled', ...fills.map(() => 'Order filled'), 'Verification approved'].slice(0, shown));
  const words = await popup(page).innerText();
  expect(words).not.toMatch(uuidText);
  expect(words).not.toMatch(rawKey);
});

test(`${J} #2 a fill notice opens the trade in Activity and is marked read; a cancelled order opens Orders`, async ({ page }) => {
  await signIn(page, who);
  await page.goto('/');
  await bell(page).click();
  // The newest fill notice; the popover keeps its order, so it is still the first fill row when the bell opens again.
  const fillRows = (scope) => scope.locator('[data-testid="nf-row"]', { hasText: 'Order filled' });
  await fillRows(popup(page)).first().click();
  await expect(page).toHaveURL(/\/money\/activity\?tab=trades&asset=BTC$/);
  await expect(popup(page)).toHaveCount(0);
  // The trade itself is on screen: the market buy of 0.001 BTC, and each of its fills with its own amount and price. A buy
  // that filled in parts is one order row (the type and how many fills) with its fills under it.
  const table = page.getByTestId('money-trade-tab');
  const trades = table.locator('tbody tr[data-fill]');
  await expect(trades).toHaveCount(fills.length);
  if (fills.length > 1) {
    const head = table.locator(`tbody tr[data-order="${fills[0].order}"]`);
    await expect(head.getByTestId('dk-trade-what')).toHaveText('Bought 0.001 BTC');
    await expect(head).toContainText(`Market order · ${fills.length} fills`);
  }
  for (const fill of fills) {
    const row = trades.and(page.locator(`[data-fill="${fill.id}"]`));
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('dk-trade-what')).toHaveText(`Bought ${fromUnits(toUnits(String(fill.amount)))} BTC`);
    await expect(row).toContainText(fills.length > 1 ? 'BTC/USDT' : 'BTC/USDT · Market');
    await expect(row).toContainText(Number(fill.price).toLocaleString('en-US', { minimumFractionDigits: 2 }));
  }
  await expect(bell(page).getByTestId('tb-badge')).toHaveText(String(total - 1));
  await bell(page).click();
  // Only the opened notice is read.
  await expect(fillRows(popup(page)).first()).not.toHaveAttribute('data-unread');
  await expect(fillRows(popup(page)).and(page.locator('[data-unread]'))).toHaveCount(Math.min(fills.length, POPOVER_ITEMS - 1) - 1);
  await popup(page).locator('[data-testid="nf-row"]', { hasText: 'Order cancelled' }).click();
  await expect(page).toHaveURL(/\/money\/activity\?tab=orders/);
  // The cancelled order is on screen in the order history, marked Cancelled with nothing filled.
  const order = page
    .getByTestId('money-trade-tab')
    .locator('tbody tr')
    .filter({ has: page.locator(`a[data-testid="dk-order-link"][href="/trade/orders/${cancelled.id}"]`) });
  await expect(order).toHaveCount(1);
  await expect(order.locator('[data-slot="status-tag"]')).toHaveText('Cancelled');
  await expect(order.locator('td').nth(6)).toHaveText('0');
  await expect(bell(page).getByTestId('tb-badge')).toHaveText(String(total - 2));
});

test(`${J} #3 the full page: All and Unread, Mark all as read clears the dots and the badge, an empty Unread tab`, async ({ page }) => {
  await signIn(page, who);
  await page.goto('/notifications');
  const pageRows = Math.min(total, PAGE_ITEMS);
  await expect(page.getByTestId('nf-row')).toHaveCount(pageRows);
  // Unread: the fills #2 did not open, and the verification.
  await page.getByRole('tab', { name: 'Unread' }).click();
  await expect(page.getByTestId('nf-row')).toHaveCount(Math.min(total - 2, PAGE_ITEMS));
  await expect(page.getByTestId('nf-title')).toHaveText(
    [...fills.slice(1).map(() => 'Order filled'), 'Verification approved'].slice(0, PAGE_ITEMS),
  );
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
