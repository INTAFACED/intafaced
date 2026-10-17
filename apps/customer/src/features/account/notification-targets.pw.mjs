import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Native App forms and isolated network replies only. These tests never send
// real verification messages or read an OTP from the service/inbox.
const owner = '11111111-1111-4111-8111-111111111111',
  other = '22222222-2222-4222-8222-222222222222';
const at = '2026-10-09T01:20:00Z',
  expiresAt = '2026-10-09T03:20:00Z';
const target = (channel = 'email', address = 'account@example.test', verifiedAt = null) => ({ channel, address, locale: 'en', verifiedAt });
const reply = (route, data) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data } }) });
const refuse = (route, status = 503, code = 'notify.source_unavailable') =>
  route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify({
      error: {
        message: code === 'notify.verify_ttl_unset' ? 'NOTIFY_VERIFY_TTL_MINUTES is unset. Blank refuses.' : code,
        data: { code: 'PRECONDITION_FAILED', cause: { code } },
      },
    }),
  });
async function network(page, state, handlers = {}, identity = () => owner) {
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
        accessToken: 'target-isolated-token-' + identity(),
        refreshToken: 'target-isolated-refresh-' + identity(),
        expiresAt: '2027-10-09T01:20:00Z',
      });
    if (procedure === 'auth.logout') return reply(route, { ok: true });
    if (procedure === 'notify.list') return reply(route, { items: [], nextCursor: null });
    if (procedure === 'notify.targets') return reply(route, state.rows);
    if (procedure === 'notify.mutePrefs')
      return reply(
        route,
        ['email', 'sms', 'push'].map((channel) => ({ channel, muted: false })),
      );
    if (procedure === 'notify.channels')
      return reply(
        route,
        ['inapp', 'email', 'sms', 'push'].map((channel) => ({
          channel,
          configured: channel === 'inapp',
          available: channel === 'inapp',
          reason: channel === 'inapp' ? null : 'channel.not_configured',
          requires: [],
          socket: null,
        })),
      );
    return reply(route, []);
  });
  return { reads, writes, errors };
}
async function signIn(page) {
  await page.goto('/login?redirect=%2Fnotifications');
  await page.getByLabel('Email or handle', { exact: true }).fill('target-review');
  await page.getByLabel('Password', { exact: true }).fill('isolated-review-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/notifications$/);
  await expect(page.getByRole('heading', { name: 'Notification targets', exact: true })).toBeVisible();
}
const room = (page) => page.getByRole('region', { name: 'Notification targets', exact: true });
const channel = (page, name = 'Email target') => room(page).getByRole('region', { name, exact: true });
async function enrollment(page, name = 'Email target', address = 'new@example.test') {
  const section = channel(page, name);
  await section.getByRole('button', { name: /^(Add|Change) target$/ }).click();
  await section.getByLabel(name === 'Email target' ? 'Email address' : 'Phone number', { exact: true }).fill(address);
  await section.getByRole('checkbox', { name: 'I understand the replacement and new-code consequences.', exact: true }).check();
  return section.getByRole('button', { name: 'Save target and request code', exact: true });
}
const targetWrites = (calls) => calls.writes.filter((r) => /^notify\.(register|verify|remove)Target$/.test(r.procedure));

test('email and SMS enroll through exact owner payloads, external code verification and fresh current projections', async ({ page }) => {
  const state = { rows: [] };
  const calls = await network(page, state, {
    'notify.registerTarget': (route, input) => {
      state.rows = [...state.rows.filter((r) => r.channel !== input.channel), target(input.channel, input.address)];
      return reply(route, { status: 'sent', channel: input.channel, code: null, expiresAt });
    },
    'notify.verifyTarget': (route, input) => {
      state.rows = state.rows.map((r) => (r.channel === input.channel ? { ...r, verifiedAt: at } : r));
      return reply(route, { verified: true, code: null });
    },
  });
  await signIn(page);
  for (const [name, address, id] of [
    ['Email target', 'new@example.test', 'email'],
    ['SMS target', '+447700900000', 'sms'],
  ]) {
    const button = await enrollment(page, name, address);
    await button.click();
    await expect(room(page)).toContainText(
      'The service accepted the verification send. Arrival and target verification are not confirmed.',
    );
    await expect(channel(page, name)).toContainText('Target not verified');
    await channel(page, name).getByLabel('Code received at the current target', { exact: true }).fill('123456');
    await channel(page, name).getByRole('button', { name: 'Verify current target', exact: true }).click();
    await expect(channel(page, name)).toContainText('Verified target');
    expect(targetWrites(calls).slice(-2)).toEqual([
      { procedure: 'notify.registerTarget', input: { channel: id, address, locale: 'en' } },
      { procedure: 'notify.verifyTarget', input: { channel: id, code: '123456' } },
    ]);
  }
  expect(calls.reads.filter((r) => r.procedure === 'notify.targets').every((r) => r.input === null)).toBe(true);
  expect(calls.errors).toEqual([]);
});

test('local inputs and explicit consequences block invalid enrollment and code submissions', async ({ page }) => {
  const calls = await network(page, { rows: [target()] });
  await signIn(page);
  await channel(page).getByRole('button', { name: 'Change target' }).click();
  await expect(channel(page).getByRole('button', { name: 'Save target and request code' })).toBeDisabled();
  await channel(page).getByLabel('Email address', { exact: true }).fill('bad');
  await channel(page).getByRole('checkbox').check();
  await channel(page).getByRole('button', { name: 'Save target and request code' }).click();
  await expect(channel(page)).toContainText('Enter a valid email address');
  await channel(page).getByLabel('Code received at the current target', { exact: true }).fill('12x');
  await channel(page).getByRole('button', { name: 'Verify current target' }).click();
  await expect(channel(page)).toContainText('Enter exactly six digits');
  await enrollment(page, 'SMS target', '07700900000').then((button) => button.click());
  await expect(channel(page, 'SMS target')).toContainText('Enter an international number');
  expect(targetWrites(calls)).toEqual([]);
});

test('refused and failed sends can leave a changed unverified target; response refusal code never fills the OTP', async ({ page }) => {
  const state = { rows: [target('email', 'original@example.test', at)] };
  let status = 'refused';
  const calls = await network(page, state, {
    'notify.registerTarget': (route, input) => {
      state.rows = [target('email', input.address)];
      return reply(route, { status, channel: 'email', code: status === 'refused' ? 'channel.not_configured' : null, expiresAt });
    },
  });
  await signIn(page);
  for (const outcome of ['refused', 'failed']) {
    status = outcome;
    await enrollment(page, 'Email target', outcome + '@example.test').then((b) => b.click());
    await expect(room(page)).toContainText(outcome === 'refused' ? 'Verification send refused' : 'Verification send failed');
    await expect(channel(page)).toContainText(outcome + '@example.test');
    await expect(channel(page)).toContainText('Target not verified');
    await expect(channel(page).getByLabel('Code received at the current target', { exact: true })).toHaveValue('');
    await expect(room(page)).not.toContainText('The service accepted the verification send.');
  }
  expect(targetWrites(calls)).toHaveLength(2);
});

test('wrong or spent code and rate refusal are distinct, and no rejected code is retained or replayed', async ({ page }) => {
  let limited = false;
  const calls = await network(
    page,
    { rows: [target()] },
    { 'notify.verifyTarget': (route) => reply(route, { verified: false, code: limited ? 'channel.verify_rate_limited' : null }) },
  );
  await signIn(page);
  for (limited of [false, true]) {
    await channel(page).getByLabel('Code received at the current target', { exact: true }).fill('123456');
    await channel(page).getByRole('button', { name: 'Verify current target' }).click();
    await expect(room(page)).toContainText(
      limited ? 'Verification refused' : 'Wrong, expired and already-used codes have the same result.',
    );
    await expect(channel(page).getByLabel('Code received at the current target', { exact: true })).toHaveValue('');
  }
  expect(targetWrites(calls)).toHaveLength(2);
});

test('replacement, verification and removal refuse changed target preflights before any write', async ({ page }) => {
  const state = { rows: [target()] },
    calls = await network(page, state);
  await signIn(page);
  const save = await enrollment(page);
  state.rows = [target('email', 'second@example.test')];
  await save.click();
  await expect(room(page)).toContainText('The current target changed. Review it again before continuing.');
  await expect(channel(page)).toContainText('second@example.test');
  await channel(page).getByLabel('Code received at the current target', { exact: true }).fill('123456');
  state.rows = [target('email', 'third@example.test')];
  await channel(page).getByRole('button', { name: 'Verify current target' }).click();
  await expect(channel(page)).toContainText('third@example.test');
  await channel(page).getByRole('button', { name: 'Remove target', exact: true }).click();
  state.rows = [target('email', 'fourth@example.test')];
  await page
    .getByRole('dialog', { name: 'Remove current target?' })
    .getByRole('button', { name: 'Remove current target', exact: true })
    .click();
  await expect(channel(page)).toContainText('fourth@example.test');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(targetWrites(calls)).toEqual([]);
});

test('preflight failure hides stale controls, and uncertain write needs fresh recovery without automatic resend', async ({ page }) => {
  const state = { rows: [target()] };
  let failRead = false;
  const calls = await network(page, state, {
    'notify.targets': (route) => (failRead ? refuse(route) : reply(route, state.rows)),
    'notify.registerTarget': (route, input) => {
      state.rows = [target('email', input.address)];
      return refuse(route);
    },
  });
  await signIn(page);
  const save = await enrollment(page);
  failRead = true;
  await save.click();
  await expect(room(page)).toContainText('notify.source_unavailable');
  await expect(channel(page)).toHaveCount(0);
  expect(targetWrites(calls)).toEqual([]);
  failRead = false;
  await room(page).getByRole('button', { name: 'Recheck targets', exact: true }).click();
  await enrollment(page).then((b) => b.click());
  await expect(room(page)).toContainText('Request not confirmed');
  await expect(channel(page)).toContainText('new@example.test');
  expect(targetWrites(calls)).toHaveLength(1);
  await room(page).getByRole('button', { name: 'Recheck targets', exact: true }).click();
  await expect(channel(page)).toContainText('new@example.test');
  await expect(channel(page).getByLabel('Code received at the current target', { exact: true })).toHaveValue('');
  expect(targetWrites(calls)).toHaveLength(1);
});

test('typed verification lifetime refusal remains exact and publishes no invented duration or countdown', async ({ page }) => {
  const calls = await network(page, { rows: [] }, { 'notify.registerTarget': (route) => refuse(route, 412, 'notify.verify_ttl_unset') });
  await signIn(page);
  await enrollment(page).then((b) => b.click());
  await expect(room(page)).toContainText('notify.verify_ttl_unset');
  await expect(room(page)).toContainText('has not published a verification-code lifetime');
  await expect(room(page)).toContainText('The service refused this request.');
  await expect(room(page)).not.toContainText('Request expires');
  await expect(room(page)).not.toContainText('The service accepted the verification send.');
  expect(targetWrites(calls)).toHaveLength(1);
});

test('malformed registration responses remain unknown, without exposing or applying an API-returned OTP', async ({ page }) => {
  let response = { status: 'sent', channel: 'email', code: '123456', expiresAt };
  const calls = await network(page, { rows: [] }, { 'notify.registerTarget': (route) => reply(route, response) });
  await signIn(page);
  for (response of [
    { status: 'sent', channel: 'email', code: '123456', expiresAt },
    { status: 'sent', channel: 'sms', code: null, expiresAt },
    { status: 'sent', channel: 'email', code: null, expiresAt: 'soon' },
  ]) {
    await enrollment(page).then((b) => b.click());
    await expect(channel(page).getByRole('button', { name: 'Add target', exact: true })).toBeEnabled();
    await expect(room(page)).toContainText('Request not confirmed');
    await expect(room(page)).not.toContainText('The service accepted the verification send.');
    await expect(room(page)).not.toContainText('123456');
  }
  expect(targetWrites(calls)).toHaveLength(3);
});

test('same-address code rotation preserves only the current returned verification state', async ({ page }) => {
  const state = { rows: [target('email', 'account@example.test', at)] };
  const calls = await network(page, state, {
    'notify.registerTarget': (route) => reply(route, { status: 'sent', channel: 'email', code: null, expiresAt }),
  });
  await signIn(page);
  await enrollment(page, 'Email target', 'account@example.test').then((button) => button.click());
  await expect(channel(page)).toContainText('Verified target');
  await expect(room(page)).toContainText('Arrival and target verification are not confirmed.');
  await expect(channel(page).getByLabel('Code received at the current target', { exact: true })).toHaveCount(0);
  expect(targetWrites(calls)).toHaveLength(1);
});

test('malformed verification and removal remain unknown while confirmed no-removal remains distinct', async ({ page }) => {
  let removed = false;
  const calls = await network(
    page,
    { rows: [target()] },
    {
      'notify.verifyTarget': (route) => reply(route, { verified: true, code: 'channel.verify_rate_limited' }),
      'notify.removeTarget': (route) => reply(route, { removed }),
    },
  );
  await signIn(page);
  await channel(page).getByLabel('Code received at the current target', { exact: true }).fill('123456');
  await channel(page).getByRole('button', { name: 'Verify current target', exact: true }).click();
  await expect(room(page)).toContainText('Request not confirmed');
  await expect(channel(page)).toContainText('Target not verified');
  await expect(channel(page).getByLabel('Code received at the current target', { exact: true })).toHaveValue('');
  for (removed of [false, 'yes']) {
    await channel(page).getByRole('button', { name: 'Remove target', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Remove current target?' })
      .getByRole('button', { name: 'Remove current target', exact: true })
      .click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(room(page)).toContainText(removed === false ? 'The service did not remove a target.' : 'Request not confirmed');
    await expect(channel(page)).toContainText('account@example.test');
  }
  expect(targetWrites(calls)).toHaveLength(3);
});

test('existing email and push targets can be removed with current-target confirmation; push token enrollment stays absent', async ({
  page,
}) => {
  const state = { rows: [target(), target('push', 'opaque-secret-device-token', at)] };
  const calls = await network(page, state, {
    'notify.removeTarget': (route, input) => {
      state.rows = state.rows.filter((r) => r.channel !== input.channel);
      return reply(route, { removed: true });
    },
  });
  await signIn(page);
  await expect(room(page)).not.toContainText('opaque-secret-device-token');
  await expect(channel(page, 'Registered device').getByRole('textbox')).toHaveCount(0);
  for (const name of ['Email target', 'Registered device']) {
    await channel(page, name).getByRole('button', { name: 'Remove target', exact: true }).click();
    await page.getByRole('dialog', { name: 'Remove current target?' }).getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(channel(page, name).getByRole('button', { name: 'Remove target', exact: true })).toBeFocused();
    await channel(page, name).getByRole('button', { name: 'Remove target', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Remove current target?' })
      .getByRole('button', { name: 'Remove current target', exact: true })
      .click();
    await expect(channel(page, name)).toContainText('No destination');
  }
  expect(targetWrites(calls)).toEqual([
    { procedure: 'notify.removeTarget', input: { channel: 'email' } },
    { procedure: 'notify.removeTarget', input: { channel: 'push' } },
  ]);
});

test('native account change cancels pending preflight before writing for the previous actor', async ({ page }) => {
  let actor = owner,
    delayed = false,
    release;
  const state = { rows: [target()] };
  const calls = await network(
    page,
    state,
    {
      'notify.targets': (route) =>
        delayed && actor === owner
          ? new Promise((resolve) => {
              release = () => reply(route, state.rows).then(resolve);
            })
          : reply(route, state.rows),
    },
    () => actor,
  );
  await signIn(page);
  const save = await enrollment(page);
  delayed = true;
  await save.click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.getByRole('button', { name: 'Open person menu' }).click();
  await page.getByRole('dialog', { name: 'Your account' }).getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(room(page)).toHaveCount(0);
  actor = other;
  state.rows = [target('email', 'second-owner@example.test')];
  await expect(page.getByRole('dialog', { name: 'Your account' })).toHaveCount(0);
  await page.locator('#main').getByRole('link', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Email or handle', { exact: true }).fill('second-owner');
  await page.getByLabel('Password', { exact: true }).fill('isolated-review-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(channel(page)).toContainText('second-owner@example.test');
  await release();
  await expect(room(page)).not.toContainText('new@example.test');
  expect(targetWrites(calls)).toEqual([]);
  expect(calls.errors).toEqual([]);
});

test('native account change suppresses a previous owner late registration outcome', async ({ page }) => {
  let actor = owner,
    release;
  const state = { rows: [target()] };
  const calls = await network(
    page,
    state,
    {
      'notify.registerTarget': (route) =>
        new Promise((resolve) => {
          release = () => reply(route, { status: 'sent', channel: 'email', code: null, expiresAt }).then(resolve);
        }),
    },
    () => actor,
  );
  await signIn(page);
  await enrollment(page).then((b) => b.click());
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.getByRole('button', { name: 'Open person menu' }).click();
  await page.getByRole('dialog', { name: 'Your account' }).getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(room(page)).toHaveCount(0);
  actor = other;
  state.rows = [target('email', 'other-owner@example.test')];
  await expect(page.getByRole('dialog', { name: 'Your account' })).toHaveCount(0);
  await page.locator('#main').getByRole('link', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Email or handle', { exact: true }).fill('another-owner');
  await page.getByLabel('Password', { exact: true }).fill('isolated-review-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(channel(page)).toContainText('other-owner@example.test');
  await release();
  await expect(room(page)).not.toContainText('The service accepted the verification send.');
  await expect(room(page)).not.toContainText('new@example.test');
  expect(targetWrites(calls)).toHaveLength(1);
  expect(calls.errors).toEqual([]);
});

for (const [locale, title] of [
  ['es', 'Destinos de notificaciones'],
  ['fr', 'Destinations des notifications'],
]) {
  test('native language preference covers every new ' + locale + ' message without English fallback', async ({ page }) => {
    await network(page, { rows: [] });
    await signIn(page);
    await page.getByRole('button', { name: 'Open person menu' }).click();
    await page.getByRole('dialog', { name: 'Your account' }).getByRole('link', { name: 'View and language', exact: true }).click();
    await page.getByLabel('Language', { exact: true }).selectOption(locale);
    await page.locator('header a[href="/notifications"]').click();
    const translated = page.getByRole('region', { name: title, exact: true });
    await expect(translated).toHaveAttribute('lang', locale);
    await expect(translated.locator('span[lang="en"]')).toHaveCount(0);
  });
}

test('compiled actual App covers five widths, native focus,44px actions and accessibility', async ({ page }) => {
  const calls = await network(page, { rows: [target()] });
  await signIn(page);
  await channel(page).getByRole('button', { name: 'Change target' }).click();
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const button = room(page).getByRole('button', { name: 'Recheck targets', exact: true });
    await button.focus();
    await expect(button).toBeFocused();
    expect(await button.evaluate((n) => n.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (process.env.NOTIFICATION_TARGETS_ARTIFACT)
      await page.screenshot({ path: process.env.NOTIFICATION_TARGETS_ARTIFACT + '/app-targets-' + width + '.png', fullPage: true });
  }
  const audit = await new AxeBuilder({ page }).analyze();
  expect(audit.violations.filter((v) => ['serious', 'critical'].includes(v.impact))).toEqual([]);
  expect(calls.errors).toEqual([]);
});

test('ordinary unintercepted signed-out App keeps targets private and dispatches no notification writes', async ({ page }) => {
  const requests = [],
    errors = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname.startsWith('/api/')) requests.push(r.method());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/notifications');
  await expect(page.getByRole('heading', { name: 'Sign in to continue', exact: true })).toBeVisible();
  await expect(room(page)).toHaveCount(0);
  expect(requests.filter((m) => m !== 'GET')).toEqual([]);
  expect(errors).toEqual([]);
  if (process.env.NOTIFICATION_TARGETS_ARTIFACT)
    await page.screenshot({ path: process.env.NOTIFICATION_TARGETS_ARTIFACT + '/app-targets-ordinary-signed-out.png', fullPage: true });
});
