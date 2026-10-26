import { test, expect } from '@playwright/test';
import { awayBid, confirm, fundedTrader, openDesk, openOrders, previewed, reviewLimit, reviewSheet, signIn } from './desk.mjs';
import { api } from './stack.mjs';

// J-home-ia-05, in the running app (docs/roadmap/journeys.json): I read my notifications and allow them on this device.
// Tests titled "J-home-ia-05 #<n>" prove a whole step. One TEST person who is verified, bought at market (a fill notice)
// and cancelled a resting order (a cancelled-order notice). The stack's inbox page size (20) and unread cap (99) are
// LOCAL TEST values; production has none until the owner sets them.
const J = 'J-home-ia-05';

test.describe.configure({ mode: 'serial' });

const bell = (page) => page.getByTestId('tb-bell');
const popup = (page) => page.getByTestId('nf-pop');
const uuidText = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const rawKey = /notify\.[a-z_.]+/;

let who;

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
  const [order] = await openOrders(who);
  expect((await (await api(who)).delete(`/api/v1/orders/${order.id}?symbol=BTC%2FUSDT`)).status).toBe(200);
  // Verified, filled and cancelled: three notices, all unread.
  await expect
    .poll(async () => (await (await api(who)).get('/api/notify/trpc/notify.unreadCount')).body?.result?.data?.count, { timeout: 20_000 })
    .toBe(3);
  await page.close();
});

test(`${J} #1 the bell shows the unread count and a popover of recent notices in plain words`, async ({ page }) => {
  await signIn(page, who);
  await page.goto('/');
  await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications, 3 unread');
  await expect(bell(page).getByTestId('tb-badge')).toHaveText('3');
  await bell(page).click();
  await expect(popup(page)).toBeVisible();
  await expect(popup(page).getByTestId('nf-row')).toHaveCount(3);
  await expect(popup(page).locator('[data-testid="nf-row"][data-unread]')).toHaveCount(3);
  const titles = await popup(page).getByTestId('nf-title').allInnerTexts();
  expect(titles).toEqual(['Order cancelled', 'Order filled', 'Verification approved']);
  const words = await popup(page).innerText();
  expect(words).not.toMatch(uuidText);
  expect(words).not.toMatch(rawKey);
});

test(`${J} #2 a fill notice opens the trade in Activity and is marked read; a cancelled order opens Orders`, async ({ page }) => {
  await signIn(page, who);
  await page.goto('/');
  await bell(page).click();
  await popup(page).locator('[data-testid="nf-row"]', { hasText: 'Order filled' }).click();
  await expect(page).toHaveURL(/\/money\/activity\?tab=trades&asset=BTC$/);
  await expect(popup(page)).toHaveCount(0);
  await expect(bell(page).getByTestId('tb-badge')).toHaveText('2');
  await bell(page).click();
  await expect(popup(page).locator('[data-testid="nf-row"]', { hasText: 'Order filled' })).not.toHaveAttribute('data-unread');
  await popup(page).locator('[data-testid="nf-row"]', { hasText: 'Order cancelled' }).click();
  await expect(page).toHaveURL(/\/money\/activity\?tab=orders/);
  await expect(bell(page).getByTestId('tb-badge')).toHaveText('1');
});

test(`${J} #3 the full page: All and Unread, Mark all as read clears the dots and the badge, an empty Unread tab`, async ({ page }) => {
  await signIn(page, who);
  await page.goto('/notifications');
  await expect(page.getByTestId('nf-row')).toHaveCount(3);
  await page.getByRole('tab', { name: 'Unread' }).click();
  await expect(page.getByTestId('nf-row')).toHaveCount(1);
  await expect(page.getByTestId('nf-row')).toContainText('Verification approved');
  await page.getByRole('button', { name: 'Mark all as read' }).click();
  await expect(page.getByText("You're all caught up.")).toBeVisible();
  await expect(bell(page).getByTestId('tb-badge')).toHaveCount(0);
  await page.getByRole('tab', { name: 'All' }).click();
  await expect(page.getByTestId('nf-row')).toHaveCount(3);
  await expect(page.locator('[data-testid="nf-row"][data-unread]')).toHaveCount(0);
  // Fewer notices than the page size: no Load more.
  await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);
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
