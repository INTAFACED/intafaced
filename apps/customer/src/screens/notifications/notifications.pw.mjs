import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BTC_MARKET, cancelled, channelsEmail, channelsOff, fill, inbox, markets } from './notifications.fixtures.mjs';

const shots = process.env.NOTIFY_SHOTS ?? join(tmpdir(), 'intafaced-notify-shots');
mkdirSync(shots, { recursive: true });

const forbidden = /unavailable|not connected|restricted|fixture|lifecycle/i;
const uuidText = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const rawKey = /notify\.[a-z_.]+/;

const trpc = (data) => ({ status: 200, json: { result: { data } } });

/**
 * Answer svc-notify (`/api/notify/trpc/<procedure>`) and the market list. State lives in the test, so a mutation changes what the next read
 * returns. `fail` makes the list answer 500 until set back to false; `hold` keeps the list request open until `release()`;
 * `holdMarkets` keeps the market list open until `releaseMarkets()`. No service is contacted.
 */
async function mock(page, options = {}) {
  const state = {
    items: options.items ?? inbox(),
    channels: options.channels ?? channelsOff,
    prefs: [
      { channel: 'email', muted: false },
      { channel: 'push', muted: false },
      { channel: 'sms', muted: false },
    ],
    fail: options.fail ?? false,
    hold: options.hold ?? false,
    held: [],
    heldMarkets: options.holdMarkets ? [] : null,
    calls: [],
  };
  const unread = () => state.items.filter((item) => !item.readAt).length;
  await page.route('**/api/v1/markets**', (route) => {
    const answer = () => route.fulfill({ status: 200, json: markets });
    // Only the notifications' own read (`limit=500`) is held; any other market read on the page answers at once.
    const ours = new URL(route.request().url()).searchParams.get('limit') === '500';
    return state.heldMarkets && ours ? void state.heldMarkets.push(answer) : answer();
  });
  await page.route('**/api/notify/trpc/**', async (route) => {
    const url = new URL(route.request().url());
    const procedure = url.pathname.split('/trpc/')[1];
    const input =
      route.request().method() === 'POST' ? route.request().postDataJSON() : JSON.parse(url.searchParams.get('input') ?? 'null');
    state.calls.push({ procedure, input });
    switch (procedure) {
      case 'notify.unreadCount':
        return route.fulfill(trpc({ count: unread() }));
      case 'notify.list': {
        const answer = () => {
          if (state.fail) return route.fulfill({ status: 500, body: 'no' });
          let rows = state.items.filter((item) => !input.unreadOnly || !item.readAt);
          if (input.cursor) rows = rows.slice(rows.findIndex((item) => item.id === input.cursor) + 1);
          const page = rows.slice(0, input.limit);
          return route.fulfill(trpc({ items: page, nextCursor: rows.length > page.length ? page[page.length - 1].id : null }));
        };
        if (state.hold) return void state.held.push(answer);
        return answer();
      }
      case 'notify.markRead': {
        for (const item of state.items) if (input.ids.includes(item.id) && !item.readAt) item.readAt = new Date().toISOString();
        return route.fulfill(trpc({ marked: input.ids.length }));
      }
      case 'notify.markAllRead': {
        let marked = 0;
        for (const item of state.items) if (!item.readAt) ((item.readAt = new Date().toISOString()), (marked += 1));
        return route.fulfill(trpc({ marked }));
      }
      case 'notify.channels':
        return route.fulfill(trpc(state.channels));
      case 'notify.mutePrefs':
        return route.fulfill(trpc(state.prefs));
      case 'notify.targets':
        return route.fulfill(
          trpc([{ channel: 'email', address: 'test-friend@local.test', locale: 'en', verifiedAt: new Date().toISOString() }]),
        );
      case 'notify.setMute': {
        state.prefs = state.prefs.map((row) => (row.channel === input.channel ? { ...row, muted: input.muted } : row));
        return route.fulfill(trpc(state.prefs));
      }
      default:
        return route.fulfill({ status: 404, json: { error: { message: 'not mocked' } } });
    }
  });
  return {
    state,
    calls: (procedure) => state.calls.filter((call) => call.procedure === procedure),
    release: async () => {
      state.hold = false;
      for (const answer of state.held.splice(0)) await answer();
    },
    releaseMarkets: async () => {
      const held = state.heldMarkets ?? [];
      state.heldMarkets = null;
      for (const answer of held.splice(0)) await answer();
    },
  };
}

const bell = (page) => page.getByTestId('tb-bell');
const popup = (page) => page.getByTestId('nf-pop');
const shoot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) });
const sizes = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
];
async function shootBoth(page, name) {
  for (const size of sizes) {
    await page.setViewportSize(size);
    await page.waitForTimeout(150);
    await shoot(page, `${name}-${size.width}`);
  }
  await page.setViewportSize(sizes[0]);
}
/** Layout size in CSS px (offsetWidth/Height), unaffected by the popover's 0.98 to 1 scale-in. */
const size = (locator) => locator.evaluate((node) => ({ width: node.offsetWidth, height: node.offsetHeight }));
const texts = (locator) => locator.evaluateAll((nodes) => nodes.map((node) => node.textContent.trim()));
const watch = (page) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on(
    'console',
    (message) => message.type() === 'error' && !/Failed to load resource/.test(message.text()) && errors.push(message.text()),
  );
  return errors;
};

test('bell: count, popover layout, words, and a click opens the trade in Activity', async ({ page }) => {
  const errors = watch(page);
  const api = await mock(page);
  await page.goto('/home');
  await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications, 3 unread');
  await expect(bell(page).getByTestId('tb-badge')).toHaveText('3');
  expect(api.calls('notify.unreadCount').length).toBe(1);
  expect(api.calls('notify.list').length).toBe(0); // nothing is listed until the bell opens

  await bell(page).click();
  await expect(popup(page)).toBeVisible();
  await expect(page.getByTestId('nf-row').first()).toBeVisible();
  expect((await size(popup(page))).width).toBe(400);
  await expect(page.getByTestId('nf-pop__title')).toHaveText('Notifications');
  await expect(page.getByRole('button', { name: 'Mark all as read' })).toBeEnabled();
  // Up to 8 rows, newest first, 72 px each; the list asked for exactly 8.
  expect(await page.getByTestId('nf-row').count()).toBe(8);
  expect(api.calls('notify.list')[0].input).toEqual({ limit: 8 });
  for (const row of await page.getByTestId('nf-row').all()) expect((await size(row)).height).toBe(72);
  const first = page.getByTestId('nf-row').first();
  await expect(first.getByTestId('nf-title')).toHaveText('Order filled');
  await expect(first.getByTestId('nf-body')).toHaveText('Bought 0.00015 BTC at 64,733.35 USDT');
  await expect(first.locator('time')).toHaveText('2 min ago');
  await expect(first.getByTestId('nf-dot')).toHaveCount(1);
  await expect(page.getByTestId('nf-row').nth(1).getByTestId('nf-body')).toHaveText('Buy 0.00017 BTC at 30,000 USDT');
  await expect(page.locator('[data-testid="nf-row"][data-unread]')).toHaveCount(3);
  // Footer
  await expect(page.getByTestId('nf-pop__all')).toHaveText('See all');
  await expect(page.getByTestId('nf-pop__all')).toHaveAttribute('href', '/notifications');
  // No raw ids, catalogue keys or banned words anywhere in the popover.
  const words = await popup(page).innerText();
  expect(words).not.toMatch(forbidden);
  expect(words).not.toMatch(uuidText);
  expect(words).not.toMatch(rawKey);
  await shootBoth(page, 'bell-loaded');

  // A fill opens the Trades tab of Activity, marks itself read and closes the popover; the count follows.
  await first.click();
  await expect(page.getByTestId('standin')).toHaveText('Stand-in page /money/activity?tab=trades&asset=BTC');
  await expect(popup(page)).toHaveCount(0);
  await expect.poll(() => api.calls('notify.markRead').length).toBe(1);
  expect(api.calls('notify.markRead')[0].input.ids).toHaveLength(1);
  await expect(bell(page).getByTestId('tb-badge')).toHaveText('2');
  expect(errors).toEqual([]);
});

test('bell: cancelled order opens Orders; Mark all as read clears the dots and the badge', async ({ page }) => {
  const api = await mock(page);
  await page.goto('/home');
  await bell(page).click();
  await page.getByTestId('nf-row').nth(1).click();
  await expect(page.getByTestId('standin')).toHaveText('Stand-in page /money/activity?tab=orders');

  await bell(page).click();
  await expect(page.locator('[data-testid="nf-row"][data-unread]')).toHaveCount(2);
  await page.getByRole('button', { name: 'Mark all as read' }).click();
  await expect(page.locator('[data-testid="nf-row"][data-unread]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Mark all as read' })).toBeDisabled();
  expect(api.calls('notify.markAllRead')).toHaveLength(1);
  await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications');
  await expect(bell(page).getByTestId('tb-badge')).toHaveCount(0);
  await shootBoth(page, 'bell-all-read');
});

test('bell: empty, loading, error with Try again, and a refused answer', async ({ page }) => {
  const errors = watch(page);
  // Loading: skeleton rows of the final row height, no layout words.
  const api = await mock(page, { hold: true });
  await page.goto('/home');
  await bell(page).click();
  await expect(popup(page).locator('[data-kind="loading"]')).toBeVisible();
  const skeletons = popup(page).locator('[data-slot="skeleton"]');
  expect(await skeletons.count()).toBe(3);
  expect((await size(skeletons.first())).height).toBe(72);
  await shootBoth(page, 'bell-loading');

  // Error inside the popover only; the bell and page stay put. Try again recovers.
  api.state.fail = true;
  await api.release();
  await expect(popup(page).getByText('Couldn’t load your notifications.')).toBeVisible();
  await expect(bell(page)).toBeVisible();
  await shootBoth(page, 'bell-error');
  api.state.fail = false;
  await popup(page).getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByTestId('nf-row').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popup(page)).toHaveCount(0);

  // Empty
  const empty = await mock(page, { items: [] });
  await page.reload();
  await expect(bell(page)).toBeVisible();
  await expect(bell(page).getByTestId('tb-badge')).toHaveCount(0);
  await bell(page).click();
  await expect(popup(page).getByText("You're all caught up.")).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark all as read' })).toBeDisabled();
  await shootBoth(page, 'bell-empty');
  expect(empty).toBeDefined();
  expect(errors).toEqual([]);
});

test('bell: a refused read shows plain words, never the raw code', async ({ page }) => {
  await mock(page);
  await page.route('**/api/notify/trpc/notify.list**', (route) =>
    route.fulfill({
      status: 403,
      json: { error: { message: 'no', code: -32003, data: { code: 'FORBIDDEN', intafacedCode: 'denied.screening_fixture' } } },
    }),
  );
  await page.goto('/home');
  await bell(page).click();
  await expect(popup(page).locator('[data-kind="refused"]')).toBeVisible();
  const words = await popup(page).innerText();
  expect(words).toContain('Paused for account checks');
  expect(words).not.toMatch(forbidden);
  expect(words).not.toContain('denied.screening_fixture');
});

test('bell: the count is read again every 60 seconds and when the page changes', async ({ page }) => {
  const api = await mock(page);
  await page.clock.install();
  await page.goto('/home');
  await expect(bell(page).getByTestId('tb-badge')).toHaveText('3');
  const before = api.calls('notify.unreadCount').length;
  // A new fill arrives on the service.
  api.state.items.unshift(fill(50, 0));
  await page.clock.runFor(45_000);
  expect(api.calls('notify.unreadCount').length).toBe(before);
  // The scheduler waits 50 s plus up to 20% jitter, so the new count is on the bell by the 60 s mark.
  await page.clock.runFor(15_000);
  await expect(bell(page).getByTestId('tb-badge')).toHaveText('4');
  expect(api.calls('notify.unreadCount').length).toBe(before + 1);
});

test('page: All and Unread tabs, rows, Load more by cursor, empty Unread, 1440 and 1280', async ({ page }) => {
  const errors = watch(page);
  const many = Array.from({ length: 30 }, (_, i) =>
    i % 3 === 0
      ? cancelled(20 + i, 5 + i * 20, i < 2 ? null : new Date().toISOString())
      : fill(20 + i, 5 + i * 20, i < 2 ? null : new Date().toISOString()),
  );
  many.push(fill(99, 60 * 24 * 3, new Date().toISOString())); // three days old: shows a date, not "h ago"
  const api = await mock(page, { items: many });
  await page.goto('/notifications');
  await expect(page.getByTestId('nf-h1')).toHaveText('Notifications');
  // Container 760 wide, centred.
  const card = await page.getByTestId('nf-card').boundingBox();
  expect(Math.round(card.width)).toBe(760);
  expect(Math.round(card.x + card.width / 2)).toBe(720);
  await expect(page.getByTestId('nf-row')).toHaveCount(20);
  expect(api.calls('notify.list')[0].input).toEqual({ limit: 20 });
  await expect(page.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true');
  expect(await texts(page.locator('[role="tab"]'))).toEqual(['All', 'Unread']);
  // No settings link: no outside channel is set up on this service.
  await expect(page.getByRole('link', { name: 'Notification settings' })).toHaveCount(0);
  await shootBoth(page, 'page-loaded');

  // Load more follows the cursor and appends.
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(page.getByTestId('nf-row')).toHaveCount(31);
  expect(api.calls('notify.list').find((call) => call.input.cursor)?.input).toEqual({ limit: 20, cursor: many[19].id });
  await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);

  // Unread tab asks for unread only.
  await page.getByRole('tab', { name: 'Unread' }).click();
  await expect(page.getByTestId('nf-row')).toHaveCount(2);
  expect(api.calls('notify.list').at(-1).input).toEqual({ limit: 20, unreadOnly: true });
  await page.getByRole('button', { name: 'Mark all as read' }).click();
  await expect(page.getByText("You're all caught up.")).toBeVisible();
  await expect(page.getByText('Everything you have been sent has been read.')).toBeVisible();
  await shootBoth(page, 'page-unread-empty');

  // Links and times: a read fill still links to Trades; the time is shown in the viewer's zone (UTC here).
  await page.getByRole('tab', { name: 'All' }).click();
  await expect(page.getByTestId('nf-row').first()).toHaveAttribute('href', '/money/activity?tab=orders');
  await expect(page.getByTestId('nf-row').nth(1)).toHaveAttribute('href', '/money/activity?tab=trades&asset=BTC');
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(page.getByTestId('nf-row')).toHaveCount(31);
  const old = await page.getByTestId('nf-row').locator('time').last().textContent();
  expect(old).toMatch(/^\d{1,2} [A-Z][a-z]{2}, \d{2}:\d{2}$/);
  const words = await page.locator('main').innerText();
  expect(words).not.toMatch(forbidden);
  expect(words).not.toMatch(uuidText);
  expect(words).not.toMatch(rawKey);
  expect(errors).toEqual([]);
});

test('page: empty inbox, error with Try again, and loading', async ({ page }) => {
  const api = await mock(page, { items: [], hold: true });
  await page.goto('/notifications');
  await expect(page.getByTestId('nf-card').locator('[data-kind="loading"]')).toBeVisible();
  expect(await page.getByTestId('nf-card').locator('[data-slot="skeleton"]').count()).toBe(5);
  await shootBoth(page, 'page-loading');
  await api.release();
  await expect(page.getByText("You're all caught up.")).toBeVisible();
  await expect(page.getByText('New updates about your orders and account show up here.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark all as read' })).toBeDisabled();
  await shootBoth(page, 'page-empty');

  api.state.fail = true;
  await page.reload();
  await expect(page.getByText('Couldn’t load your notifications.')).toBeVisible();
  await shootBoth(page, 'page-error');
  api.state.fail = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText("You're all caught up.")).toBeVisible();
});

test('settings: link appears only when an outside channel is set up; a switch saves', async ({ page }) => {
  const api = await mock(page, { channels: channelsEmail });
  await page.goto('/notifications');
  const link = page.getByRole('link', { name: 'Notification settings' });
  await expect(link).toHaveAttribute('href', '/notifications?view=settings');
  await link.click();
  await expect(page.getByTestId('nf-h1')).toHaveText('Notification settings');
  // Only the channel that is really set up is listed.
  await expect(page.locator('.nf-channel')).toHaveCount(1);
  await expect(page.locator('.nf-channel')).toContainText('Email');
  await expect(page.locator('.nf-channel')).toContainText('test-friend@local.test · Confirmed');
  const toggle = page.getByRole('switch', { name: 'Send me these: Email' });
  await expect(toggle).toBeChecked();
  await shootBoth(page, 'settings-loaded');
  await toggle.click();
  await expect(page.getByTestId('nf-channel__state')).toHaveText('Saved');
  await expect(toggle).not.toBeChecked();
  expect(api.calls('notify.setMute').at(-1).input).toEqual({ channel: 'email', muted: true });
  const words = await page.getByTestId('if-notify').first().innerText();
  expect(words).not.toMatch(forbidden);
});

test('settings: with nothing set up the page sends you back to your inbox', async ({ page }) => {
  await mock(page);
  await page.goto('/notifications?view=settings');
  await expect(page.getByTestId('nf-h1')).toHaveText('Notifications');
  expect(new URL(page.url()).search).toBe('');
});

test('keyboard: Tab reaches the bell, Enter opens it, rows and See all are focusable, Escape closes and returns focus', async ({
  page,
}) => {
  await mock(page);
  await page.goto('/home');
  await expect(bell(page)).toBeVisible();
  await bell(page).focus();
  await page.keyboard.press('Enter');
  await expect(popup(page)).toBeVisible();
  await expect(page.getByTestId('nf-row').first()).toBeVisible();
  // Focus starts in the popover; Tab goes down it in order: Mark all as read, each row, See all.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Mark all as read' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('nf-row').first()).toBeFocused();
  const outline = await page
    .getByTestId('nf-row')
    .first()
    .evaluate((node) => getComputedStyle(node).outlineStyle);
  expect(outline).toBe('solid');
  await page.keyboard.press('Escape');
  await expect(popup(page)).toHaveCount(0);
  await expect(bell(page)).toBeFocused();
});

test('tied to market: a fill names its coin from the market list', async ({ page }) => {
  const api = await mock(page, { items: [{ ...fill(1, 1), params: { ...fill(1, 1).params, marketId: BTC_MARKET } }] });
  await page.goto('/notifications');
  await expect(page.getByTestId('nf-body').first()).toHaveText('Bought 0.00015 BTC at 64,733.35 USDT');
  expect(api.calls('notify.list').length).toBeGreaterThan(0);
});

test('tied to market: a fill row is not drawn, so cannot be opened, before the market list answers', async ({ page }) => {
  const api = await mock(page, { items: [{ ...fill(1, 1), params: { ...fill(1, 1).params, marketId: BTC_MARKET } }], holdMarkets: true });
  await page.goto('/home');
  await bell(page).click();
  await expect(popup(page)).toBeVisible();
  await expect.poll(() => api.calls('notify.list').length).toBeGreaterThan(0);
  // The inbox has answered; the market list has not. A row drawn now would open Trades unfiltered and read "a trade".
  await expect(popup(page).locator('[data-kind="loading"]')).toBeVisible();
  await expect(page.getByTestId('nf-row')).toHaveCount(0);
  await api.releaseMarkets();
  await expect(page.getByTestId('nf-row')).toHaveAttribute('href', '/money/activity?tab=trades&asset=BTC');
  await expect(page.getByTestId('nf-body')).toHaveText('Bought 0.00015 BTC at 64,733.35 USDT');
});
