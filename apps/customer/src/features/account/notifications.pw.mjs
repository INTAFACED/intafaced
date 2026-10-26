import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir } from 'node:fs/promises';

// Network examples are confined to these isolated tests. Every journey uses the
// actual App and its native sign-in form; no fixture app or sample route exists.
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const first = '33333333-3333-4333-8333-333333333333';
const second = '44444444-4444-4444-8444-444444444444';
const next = '55555555-5555-4555-8555-555555555555';
const at = '2026-10-09T01:20:00Z';
const row = (id = first, userId = owner, extra = {}) => ({
  id,
  userId,
  titleKey: 'example.account.title',
  bodyKey: 'example.account.body',
  title: id === first ? 'Security settings updated' : 'Account update',
  body: 'Review the change to your account security.',
  href: '/uc/safe',
  severity: 'action',
  readAt: null,
  createdAt: at,
  ...extra,
});
const prefs = (muted = false) => [
  { channel: 'email', muted },
  { channel: 'push', muted: false },
  { channel: 'sms', muted: true },
];
const channels = ['inapp', 'email', 'push', 'sms'].map((channel) => ({
  channel,
  configured: channel === 'inapp' || channel === 'push',
  available: channel === 'inapp',
  reason: channel === 'inapp' ? null : channel === 'push' ? 'channel.unprobed' : 'channel.not_configured',
  requires: [],
  socket: channel === 'inapp' ? null : `socket.notify-${channel}`,
}));
const delivery = [
  { channel: 'inapp', status: 'accepted', attempts: 1, attemptedAt: at, acceptedAt: at, refusalCode: null },
  { channel: 'email', status: 'refused', attempts: 0, attemptedAt: null, acceptedAt: null, refusalCode: 'channel.not_configured' },
];
const reply = (route, data) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data } }) });
const refuse = (route, status = 503) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify({ error: { message: 'Notification source unavailable', data: { code: 'notify.source_unavailable' } } }),
  });
async function network(page, handlers = {}, identity = () => owner) {
  const reads = [],
    writes = [],
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()),
      procedure = url.pathname.split('/').at(-1);
    const input =
      route.request().method() === 'POST' ? route.request().postDataJSON() : JSON.parse(url.searchParams.get('input') ?? 'null');
    (route.request().method() === 'POST' ? writes : reads).push({ procedure, input });
    if (handlers[procedure]) return handlers[procedure](route, input);
    if (procedure === 'auth.login')
      return reply(route, {
        userId: identity(),
        accessToken: `notifications-isolated-test-token-${identity()}`,
        refreshToken: `notifications-isolated-test-refresh-${identity()}`,
        expiresAt: '2027-10-09T01:20:00Z',
      });
    if (procedure === 'auth.logout') return reply(route, { ok: true });
    if (procedure === 'notify.list') return reply(route, { items: [row(first, identity())], nextCursor: null });
    if (procedure === 'notify.channels') return reply(route, channels);
    if (procedure === 'notify.targets')
      return reply(route, [{ channel: 'email', address: 'account@example.test', locale: 'en', verifiedAt: at }]);
    if (procedure === 'notify.mutePrefs') return reply(route, prefs());
    if (procedure === 'notify.deliveries') return reply(route, delivery);
    return reply(route, []);
  });
  return { reads, writes, errors };
}
async function signIn(page) {
  await page.goto('/login?redirect=%2Fnotifications');
  await page.getByLabel('Email or handle', { exact: true }).fill('notification-review');
  await page.getByLabel('Password', { exact: true }).fill('isolated-review-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/notifications$/);
  await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible();
}

test('native App connects owned notification controls, exact mute payload and bounded delivery inspection', async ({ page }) => {
  let muted = false;
  const calls = await network(page, {
    'notify.mutePrefs': (route) => reply(route, prefs(muted)),
    'notify.setMute': (route, input) => {
      muted = input.muted;
      return reply(route, prefs(muted));
    },
    'notify.markRead': (route) => reply(route, { marked: 1 }),
  });
  await signIn(page);
  await expect(page.getByRole('region', { name: 'Email', exact: true })).toContainText('Verified target · account@example.test');
  await expect(page.getByRole('region', { name: 'Push', exact: true })).toContainText('Configured · connection unverified');
  await expect(page.getByText('Critical alerts still follow the service policy.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Inspect delivery', exact: true }).click();
  const inspection = page.getByRole('region', { name: 'Delivery details', exact: true });
  await expect(inspection).toContainText(first);
  await expect(inspection).toContainText('Accepted · 1 attempt');
  await expect(inspection).toContainText('channel.not_configured');
  expect(calls.reads.find((call) => call.procedure === 'notify.list').input).toEqual({ limit: 50, unreadOnly: false });
  expect(calls.reads.find((call) => call.procedure === 'notify.deliveries').input).toEqual({ notificationId: first });
  await page.getByRole('button', { name: 'Mute Email', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unmute Email', exact: true })).toBeEnabled();
  await expect(page.getByText('The service confirmed that Email is muted.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Mark read', exact: true }).click();
  await expect(page.getByText('The service marked this notification read.')).toBeVisible();
  expect(calls.writes.filter((call) => call.procedure.startsWith('notify.'))).toEqual([
    { procedure: 'notify.setMute', input: { channel: 'email', muted: true } },
    { procedure: 'notify.markRead', input: { ids: [first] } },
  ]);
  expect(calls.errors).toEqual([]);
});

test('inbox paging and unread filters preserve original selection without stale delivery reads', async ({ page }) => {
  const calls = await network(page, {
    'notify.list': (route, input) =>
      reply(route, input.cursor ? { items: [row(second)], nextCursor: null } : { items: [row()], nextCursor: next }),
  });
  await signIn(page);
  await page.getByRole('button', { name: 'Inspect delivery', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Delivery details' })).toContainText('Accepted');
  const reads = calls.reads.filter((call) => call.procedure === 'notify.deliveries').length;
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Account update' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Selected notification' })).toContainText(first);
  await expect(page.getByRole('region', { name: 'Delivery details' })).toHaveCount(0);
  expect(calls.reads.filter((call) => call.procedure === 'notify.deliveries')).toHaveLength(reads);
  expect(calls.reads.find((call) => call.input?.cursor === next).input).toEqual({ limit: 50, cursor: next, unreadOnly: false });
  await page.getByRole('button', { name: 'Unread only', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Security settings updated' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Delivery details' })).toContainText(first);
  expect(calls.reads.some((call) => call.procedure === 'notify.list' && call.input?.unreadOnly === true && !call.input.cursor)).toBe(true);
});

test('selected original survives loading, failed, empty and restored inbox reads', async ({ page }) => {
  let state = 'ready',
    pending;
  await network(page, {
    'notify.list': (route) =>
      state === 'loading'
        ? new Promise((resolve) => {
            pending = () => reply(route, { items: [row()], nextCursor: null }).then(resolve);
          })
        : state === 'failed'
          ? refuse(route)
          : reply(route, { items: state === 'empty' ? [] : [row()], nextCursor: null }),
  });
  await signIn(page);
  await page.getByRole('button', { name: 'Inspect delivery', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Delivery details' })).toContainText('Accepted');
  state = 'loading';
  await page.getByRole('button', { name: 'Refresh inbox', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Selected notification' })).toContainText(first);
  await expect(page.getByRole('region', { name: 'Delivery details' })).toHaveCount(0);
  await expect.poll(() => Boolean(pending)).toBe(true);
  await pending();
  await expect(page.getByRole('region', { name: 'Delivery details' })).toContainText(first);
  for (const value of ['failed', 'empty']) {
    state = value;
    await page.getByRole('button', { name: 'Refresh inbox', exact: true }).first().click();
    await expect(page.getByRole('region', { name: 'Selected notification' })).toContainText(first);
    await expect(page.getByRole('region', { name: 'Delivery details' })).toHaveCount(0);
    await expect(
      page.getByText(value === 'empty' ? 'No notifications yet' : 'Notification source unavailable', { exact: true }),
    ).toBeVisible();
  }
  state = 'ready';
  await page.getByRole('region', { name: 'Selected notification' }).getByRole('button', { name: 'Refresh inbox' }).click();
  await expect(page.getByRole('region', { name: 'Delivery details' })).toContainText(first);
});

test('foreign inbox data and malformed preferences refuse before details or writes', async ({ page }) => {
  const calls = await network(page, {
    'notify.list': (route) => reply(route, { items: [row(first, other)], nextCursor: null }),
    'notify.mutePrefs': (route) =>
      reply(route, [
        { channel: 'email', muted: false },
        { channel: 'email', muted: true },
      ]),
  });
  await signIn(page);
  await expect(page.getByRole('article')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Mute|Unmute) / })).toHaveCount(0);
  await expect(page.getByText('The service response could not be verified.', { exact: true }).first()).toBeVisible();
  expect(calls.reads.filter((call) => call.procedure === 'notify.deliveries')).toEqual([]);
  expect(calls.writes.filter((call) => call.procedure.startsWith('notify.'))).toEqual([]);
});

test('uncertain mute is not success and another change waits for a fresh current-preference read', async ({ page }) => {
  let fail = true,
    muted = false;
  const calls = await network(page, {
    'notify.mutePrefs': (route) => reply(route, prefs(muted)),
    'notify.setMute': (route, input) => (fail ? refuse(route) : ((muted = input.muted), reply(route, prefs(muted)))),
  });
  await signIn(page);
  await page.getByRole('button', { name: 'Mute Email', exact: true }).click();
  await expect(page.getByText('Email preference not confirmed', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mute Email', exact: true })).toBeDisabled();
  await expect(page.getByText('The service confirmed that Email is muted.', { exact: true })).toHaveCount(0);
  expect(calls.writes.filter((call) => call.procedure === 'notify.setMute')).toHaveLength(1);
  fail = false;
  await page.getByRole('button', { name: 'Refresh settings', exact: true }).click();
  await expect(page.getByText('These are your current notification preferences.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mute Email', exact: true })).toBeEnabled();
  expect(calls.writes.filter((call) => call.procedure === 'notify.setMute')).toHaveLength(1);
  await page.getByRole('button', { name: 'Mute Email', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unmute Email', exact: true })).toBeEnabled();
});

test('delivery empty and malformed results never claim message delivery', async ({ page }) => {
  let state = 'empty';
  await network(page, {
    'notify.deliveries': (route) => (state === 'empty' ? reply(route, []) : reply(route, [{ ...delivery[0], status: 'delivered' }])),
  });
  await signIn(page);
  await page.getByRole('button', { name: 'Inspect delivery', exact: true }).click();
  await expect(page.getByText('No delivery records yet')).toBeVisible();
  state = 'bad';
  await page.getByRole('button', { name: 'Refresh delivery details', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Delivery details' })).toContainText('could not be verified');
  await expect(page.getByRole('region', { name: 'Delivery details' })).not.toContainText('Accepted');
});

test('existing related-room filters retain Customer routes and suppress external/team/parked destinations', async ({ page }) => {
  const unsafe = ['https://example.test/x', '/ops', '/chain', '/pay/merchant'];
  await network(page, {
    'notify.list': (route) =>
      reply(route, {
        items: [
          row(),
          ...unsafe.map((href, index) =>
            row(`66666666-6666-4666-8666-66666666666${index}`, owner, { href, title: `Unsafe destination ${index}` }),
          ),
        ],
        nextCursor: null,
      }),
  });
  await signIn(page);
  const links = page.getByTestId('notifications-item').getByRole('link', { name: 'Open related room' });
  await expect(links).toHaveCount(2);
  await expect(links.first()).toHaveAttribute('href', '/uc/safe');
  await expect(links.last()).toHaveAttribute('href', '/pay/merchant');
  await links.first().click();
  await expect(page).toHaveURL(/\/uc\/safe$/);
});

test('responsive App and native keyboard controls remain legible and accessible without financial writes', async ({ page }) => {
  const calls = await network(page);
  await signIn(page);
  await page.getByRole('button', { name: 'Inspect delivery', exact: true }).click();
  const artifact = process.env.NOTIFICATIONS_ARTIFACT;
  if (artifact) await mkdir(artifact, { recursive: true });
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (artifact) await page.screenshot({ path: `${artifact}/app-notifications-isolated-${width}.png`, fullPage: true });
  }
  await page.getByRole('button', { name: 'Mute Email', exact: true }).focus();
  const control = page.getByRole('button', { name: 'Mute Email', exact: true });
  await expect(control).toBeFocused();
  const bounds = await control.boundingBox();
  expect(bounds.height).toBeGreaterThanOrEqual(44);
  expect(
    await control.evaluate((node) => {
      const r = node.getBoundingClientRect();
      return node.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    }),
  ).toBe(true);
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.filter((issue) => ['serious', 'critical'].includes(issue.impact))).toEqual([]);
  expect(calls.errors).toEqual([]);
  expect(calls.writes.filter((call) => call.procedure !== 'auth.login')).toEqual([]);
});

test('late delivery for a previous selection cannot replace the new notification', async ({ page }) => {
  let release;
  await network(page, {
    'notify.list': (route) => reply(route, { items: [row(), row(second)], nextCursor: null }),
    'notify.deliveries': (route, input) =>
      input.notificationId === first
        ? new Promise((resolve) => {
            release = () => reply(route, [{ ...delivery[0], refusalCode: 'old-selection-only' }]).then(resolve);
          })
        : reply(route, delivery),
  });
  await signIn(page);
  await page.getByRole('article', { name: 'Security settings updated' }).getByRole('button', { name: 'Inspect delivery' }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.getByRole('article', { name: 'Account update' }).getByRole('button', { name: 'Inspect delivery' }).click();
  const inspection = page.getByRole('region', { name: 'Delivery details' });
  await expect(inspection).toContainText(second);
  await expect(inspection).toContainText('Accepted');
  await release();
  await expect(inspection).not.toContainText(first);
  await expect(inspection).not.toContainText('old-selection-only');
});

test('native sign-out and a different owner suppress the old pending preference outcome', async ({ page }) => {
  let actor = owner,
    release;
  const calls = await network(
    page,
    {
      'notify.setMute': (route) =>
        new Promise((resolve) => {
          release = () => reply(route, prefs(true)).then(resolve);
        }),
      'notify.list': (route) => reply(route, { items: [row(actor === owner ? first : second, actor)], nextCursor: null }),
    },
    () => actor,
  );
  await signIn(page);
  await page.getByRole('button', { name: 'Inspect delivery', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Delivery details' })).toContainText(first);
  await page.getByRole('button', { name: 'Mute Email', exact: true }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
  await page.getByRole('dialog', { name: 'Your account' }).getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Delivery details' })).toHaveCount(0);
  actor = other;
  await expect(page.getByRole('dialog', { name: 'Your account' })).toHaveCount(0);
  await page.locator('#main').getByRole('link', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Email or handle', { exact: true }).fill('another-review-account');
  await page.getByLabel('Password', { exact: true }).fill('isolated-review-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Account update' })).toBeVisible();
  await release();
  await expect(page.getByRole('button', { name: 'Mute Email', exact: true })).toBeEnabled();
  await expect(page.getByText('The service confirmed that Email is muted.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Selected notification' })).toHaveCount(0);
  expect(calls.errors).toEqual([]);
});

test('ordinary App has no intercepted account or financial fixture and keeps the private boundary', async ({ page }) => {
  const requests = [],
    errors = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) requests.push(request.method());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/notifications');
  await expect(page.getByRole('heading', { name: 'Sign in to continue', exact: true })).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Notification settings' })).toHaveCount(0);
  expect(requests.filter((method) => method !== 'GET')).toEqual([]);
  expect(errors).toEqual([]);
  if (process.env.NOTIFICATIONS_ARTIFACT)
    await page.screenshot({ path: `${process.env.NOTIFICATIONS_ARTIFACT}/app-notifications-ordinary-signed-out.png`, fullPage: true });
});

test('missing preferences and empty copy stay unknown instead of becoming an unmuted setting', async ({ page }) => {
  const calls = await network(page, {
    'notify.list': (route) => reply(route, { items: [row(first, owner, { title: '', body: '' })], nextCursor: null }),
    'notify.mutePrefs': (route) => reply(route, []),
    'notify.channels': (route) => reply(route, []),
  });
  await signIn(page);
  await expect(page.getByRole('article', { name: 'Notification text is unavailable' })).toContainText(
    'This notification’s details are not published.',
  );
  const controls = page.getByRole('button', { name: 'No preference saved', exact: true });
  await expect(controls).toHaveCount(3);
  for (const control of await controls.all()) {
    await expect(control).toBeDisabled();
    await expect(control).not.toHaveAttribute('aria-pressed');
  }
  await expect(page.getByText('Channel status unavailable', { exact: true })).toHaveCount(3);
  expect(calls.writes.filter((call) => call.procedure.startsWith('notify.'))).toEqual([]);
});
