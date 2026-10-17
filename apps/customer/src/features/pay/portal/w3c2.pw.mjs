import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createPortalMock, USER_ID } from './portal.mock.mjs';
const shots = process.env.PORTAL_SHOTS_DIR;
if (shots) mkdirSync(shots, { recursive: true });
const M = '11111111-1111-4111-8111-111111111111';
const S = '66666666-6666-4666-8666-666666666666';
const D = '77777777-7777-4777-8777-777777777777';
const at = '2026-10-16T00:00:00.000Z';
const subscription = {
  id: S,
  merchantId: M,
  mandateId: D,
  customerId: 'TEST-customer',
  nextRunAt: '2026-11-16T00:00:00.000Z',
  status: 'active',
  cancelledAt: null,
  path: 'crypto_invoice',
  createdAt: at,
  anchorAt: at,
  anchorOccurrence: 0,
  pausedAt: null,
  resumedAt: null,
  stalledAt: null,
  stallReason: null,
};
const mandate = {
  id: D,
  merchantId: M,
  customerId: 'TEST-customer',
  assetId: 'USDT',
  amount: '29.99',
  ceiling: null,
  cadence: 'monthly',
  startsAt: at,
  endsAt: null,
  railAdapter: null,
  railMandateRef: null,
  status: 'active',
  cancelledAt: null,
  createdAt: at,
};
const cycle = {
  occurrence: 0,
  amount: '29.99',
  status: 'invoiced',
  idempotencyKey: `TEST-period:${S}:0`,
  attemptCount: 1,
  rejectionCode: null,
  paymentId: null,
  exhausted: false,
  settledAt: null,
  notifyStatus: 'skipped_unwired',
  notifyCode: null,
};
const execution = { ...cycle, id: '88888888-8888-4888-8888-888888888888', subscriptionId: S, createdAt: at, attemptedAt: at };
const reply = (route, data) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data } }) });
async function setup(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, body: '{}' }));
  await page.route('**/api/identity/trpc/auth.login', (route) =>
    reply(route, { userId: USER_ID, accessToken: 'TEST-only', refreshToken: 'TEST-only', expiresAt: '2027-10-08T00:00:00Z' }),
  );
  await page.route('**/api/identity/trpc/webauthn.list?*', (route) => reply(route, []));
  const mock = createPortalMock('active');
  await mock.install(page);
  for (const [proc, data] of Object.entries({
    'subscription.list': { items: [subscription], nextCursor: null },
    'subscription.get': subscription,
    'mandate.list': { items: [mandate], nextCursor: null },
    'mandate.get': mandate,
    'subscription.cycles': { subscriptionId: S, cycles: [cycle] },
    'subscription.listExecutions': [execution],
    'subscription.productReady': {
      paths: [
        { path: 'crypto_invoice', charge: 'open_crypto_invoice', opensMoney: true, posture: 'invoice-and-watch' },
        { path: 'card', charge: 'refuse', opensMoney: false, posture: 'refuse' },
      ],
      preChargeNotify: { status: 'unwired', notified: false, merchantReadable: 'Not connected' },
      card: { status: 'refuse_closed', code: 'pay.mandate_rail_absent' },
    },
  }))
    await page.route(new RegExp(`/api/pay/trpc/${proc.replaceAll('.', '\\.')}(?:\\?|$)`), (route) => reply(route, data));
  return { mock, errors };
}
async function signIn(page, path) {
  await page.goto(`/login?redirect=${encodeURIComponent(path)}`);
  await page.getByLabel('Email or handle', { exact: true }).fill('TEST@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('TEST-only');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'));
}
async function go(page, path) {
  await page.evaluate((path) => {
    history.pushState(null, '', path);
    dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}
async function capture(page, name) {
  await expect(page.locator('.pp .pp-skeleton')).toHaveCount(0);
  const audit = await new AxeBuilder({ page }).include('.pp').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(audit.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  if (shots) {
    await page.evaluate(() => {
      document.getElementById('fixture-label')?.remove();
      const badge = document.createElement('p');
      badge.id = 'fixture-label';
      badge.textContent = 'TEST DATA · local screenshot fixture';
      badge.style.cssText = 'margin:0;background:#c8f64a;color:#111;padding:6px 24px;font:12px system-ui';
      document.body.prepend(badge);
      window.scrollTo(0, 0);
    });
    await page.screenshot({ path: `${shots}/${name}-viewport.png`, fullPage: false });
    await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
  }
}
async function both(page, name) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await capture(page, name);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await capture(page, `${name}-phone`);
  await page.setViewportSize({ width: 1440, height: 1000 });
}

test('invoices: no invented entity, money or write', async ({ page }) => {
  const { mock, errors } = await setup(page);
  await signIn(page, '/pay/invoices');
  await expect(page.getByText('Standalone invoice records are not available yet.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create invoice' })).toBeDisabled();
  await both(page, 'P20-invoices');
  await go(page, '/pay/invoices/TEST-invoice');
  await expect(page.getByText(/does not confirm whether the reference exists/)).toBeVisible();
  await both(page, 'P21-invoice-detail');
  expect(mock.calls.some((c) => /invoice\.(create|void|send)/.test(c.procedure))).toBe(false);
  expect(errors).toEqual([]);
});
test('developers: direct routes retain company authority guard', async ({ page }) => {
  const { mock, errors } = await setup(page);
  await signIn(page, '/pay/developer/keys');
  for (const [path, name, title] of [
    ['/pay/developer/keys', 'P43-api-keys', 'API keys'],
    ['/pay/developer/signing', 'P44-signing', 'Request signing'],
    ['/pay/developer/webhooks', 'P45-webhooks', 'Webhook endpoints'],
    ['/pay/developer/webhooks/TEST-endpoint', 'P46-endpoint', 'Endpoint detail'],
    ['/pay/developer/deliveries', 'P47-deliveries', 'Webhook deliveries'],
  ]) {
    await go(page, path);
    await expect(page.getByRole('heading', { name: title, level: 1, exact: true })).toBeVisible();
    await expect(
      page.locator('.pp').getByText(path.endsWith('signing') ? /Per-key signing policy/ : /Verified company membership is required/),
    ).toBeVisible();
    await both(page, name);
  }
  expect(mock.calls.some((c) => /apiKeys|webhook/.test(c.procedure))).toBe(false);
  expect(errors).toEqual([]);
});
test('settings: profile does not misuse checkout mutation; team search and current-view export', async ({ page }) => {
  const { errors } = await setup(page);
  await signIn(page, '/pay/settings');
  await expect(page.getByRole('button', { name: 'Save profile' })).toBeDisabled();
  await both(page, 'P54-profile');
  await go(page, '/pay/settings/team');
  await expect(page.getByRole('region', { name: 'Members', exact: true })).toBeVisible();
  await both(page, 'P39-team-settings');
  const search = page.getByRole('textbox', { name: 'Search loaded records', exact: true });
  await search.fill('no-match-in-TEST-data');
  await expect(page).toHaveURL(/search=no-match/);
  await expect(page.getByText('No members match')).toBeVisible();
  await search.fill('');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download shown records (CSV)' }).click();
  expect((await download).suggestedFilename()).toBe('team-members.csv');
  await go(page, '/pay/team');
  await expect(page.getByRole('region', { name: 'Members', exact: true })).toBeVisible();
  await both(page, 'P39-team');
  expect(errors).toEqual([]);
});
test('notifications: preferences route opens preferences, retains draft on cancelled navigation, saves once', async ({ page }) => {
  const { mock, errors } = await setup(page);
  await signIn(page, '/pay/settings/notifications');
  await expect(page.getByRole('heading', { name: 'Notification preferences', level: 1 })).toBeVisible();
  await expect(page.getByText('Nothing is sent by email or text.', { exact: false })).toBeVisible();
  await both(page, 'P56-notification-settings');
  const pref = page.locator('.pp-pref').first();
  await pref.getByRole('checkbox').click();
  page.once('dialog', (d) => d.dismiss());
  await page.locator('.pp').getByRole('link', { name: 'Business profile', exact: true }).click();
  await expect(page).toHaveURL(/settings\/notifications$/);
  await pref.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(pref.getByRole('status')).toHaveText('Saved');
  await expect(pref.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  expect(mock.calls.filter((c) => c.procedure === 'merchantOps.notifications.preferences.set')).toHaveLength(1);
  expect(errors).toEqual([]);
});
test('compliance: verification status and append-only history do not imply screening clearance', async ({ page }) => {
  const { errors } = await setup(page);
  await signIn(page, '/pay/compliance');
  await expect(page.getByText(/is not a screening clearance/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Verification history', exact: true })).toBeVisible();
  await both(page, 'P38-compliance');
  expect(errors).toEqual([]);
});
test('subscriptions: filters, exact terms, period keys, and creation with existing mandate', async ({ page }) => {
  const { mock, errors } = await setup(page);
  await signIn(page, '/pay/subscriptions');
  await expect(page.getByText('1 records shown')).toBeVisible();
  await both(page, 'P17-subscriptions');
  await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('paused');
  await expect(page).toHaveURL(/status=paused/);
  await expect(page.getByText('No subscriptions in this view')).toBeVisible();
  await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('');
  await page.getByRole('link', { name: 'TEST-customer', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Subscription detail', level: 1 })).toBeVisible();
  await expect(page.getByText('TEST-period:', { exact: false })).toBeVisible();
  await both(page, 'P18-subscription-detail');
  await go(page, '/pay/subscriptions/new');
  await expect(page.getByLabel('Active customer mandate *')).toBeVisible();
  await page.getByLabel('Active customer mandate *').selectOption(D);
  await page.getByLabel('Supported charge path *').selectOption('crypto_invoice');
  await expect(page.getByLabel('Supported charge path *').locator('option[value="card"]')).toHaveCount(0);
  await both(page, 'P19-create-subscription');
  expect(mock.calls.some((c) => /subscription\.(create|cancel|pause|resume)/.test(c.procedure))).toBe(false);
  expect(errors).toEqual([]);
});
test('subscription reads refuse foreign responses and foreign ids without exposing fields', async ({ page }) => {
  await setup(page);
  await page.route('**/api/pay/trpc/subscription.get?*', (route) =>
    reply(route, { ...subscription, merchantId: 'foreign', customerId: 'FOREIGN PRIVATE NAME' }),
  );
  await signIn(page, `/pay/subscriptions/${S}`);
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(page.getByText('FOREIGN PRIVATE NAME')).toHaveCount(0);
});
test('conversion: all routes are TEST, quote disabled, halt read does not enable writes', async ({ page }) => {
  const { mock, errors } = await setup(page);
  await signIn(page, '/pay/conversion');
  for (const [path, name] of [
    ['/pay/conversion', 'P33-conversion'],
    ['/pay/conversion/new', 'P34-convert'],
    ['/pay/conversion/TEST-order', 'P35-conversion-order'],
  ]) {
    await go(page, path);
    await expect(page.getByText('TEST · Sandbox / testnet only', { exact: true })).toBeVisible();
    await both(page, name);
  }
  await go(page, '/pay/conversion/new');
  await expect(page.getByRole('button', { name: 'Get quote' })).toBeDisabled();
  expect(mock.calls.some((c) => /^conversion\./.test(c.procedure))).toBe(false);
  expect(errors).toEqual([]);
});
test('keyboard search remains available and stored light preference follows existing app policy', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('intafaced.customer.view.v1', JSON.stringify({ theme: 'light' })));
  await setup(page);
  await signIn(page, '/pay/settings');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('intafaced.customer.view.v1')).theme)).toBe('light');
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('combobox', { name: 'Search markets' })).toBeFocused();
});

// Isolated component fixtures exercise the reachable controls without granting the real App a company membership.
async function developerFixture(page, kind, uncertainAction = false) {
  await page.goto('/login');
  await page.evaluate(
    async ({ kind, subscription, mandate, uncertainAction }) => {
      const loadedModule = (name) =>
        performance
          .getEntriesByType('resource')
          .map((r) => r.name)
          .find((url) => new URL(url).pathname.endsWith(`/node_modules/.vite/deps/${name}.js`));
      const { default: React } = await import(loadedModule('react') ?? '/node_modules/.vite/deps/react.js');
      const { default: ReactDOM } = await import(loadedModule('react-dom_client') ?? '/node_modules/.vite/deps/react-dom_client.js');
      const { createRoot } = ReactDOM;
      await import('/src/features/pay/pay.css');
      const views = await import('/src/features/pay/portal/settings/Developers.tsx');
      const billing = await import('/src/features/pay/portal/payments/Subscriptions.tsx');
      const { PortalFrame } = await import('/src/features/pay/portal/MerchantPortal.tsx');
      document.getElementById('root').style.display = 'none';
      const host = document.createElement('div');
      host.id = 'isolated-fixture';
      host.className = 'if-app if-business';
      document.body.append(host);
      document.documentElement.dataset.theme = 'dark';
      const endpoint = {
        id: 'TEST-endpoint',
        merchantId: 'TEST',
        url: 'https://receiver.invalid/events?token=TEST-secret-in-URL',
        status: 'active',
        disabledReason: null,
        consecutiveFailures: 1,
        createdAt: '2026-10-16T00:00:00Z',
        updatedAt: '2026-10-16T01:00:00Z',
      };
      const delivery = {
        id: 'TEST-delivery',
        endpointId: endpoint.id,
        merchantId: 'TEST',
        eventId: 'TEST-event',
        eventType: 'payment.captured',
        status: 'failed',
        attempts: 2,
        nextAttemptAt: '2026-10-16T03:00:00Z',
        lastStatusCode: 500,
        lastError: 'INTERNAL SECRET DO NOT DISPLAY',
        createdAt: '2026-10-16T02:00:00Z',
        deliveredAt: null,
      };
      const keys = [
        {
          id: 'TEST-key',
          name: 'TEST integration',
          prefix: 'ifc_sandbox_TEST',
          scopes: ['pay:read'],
          lastUsedAt: '2026-10-16T01:00:00Z',
          revoked: false,
          mode: 'sandbox',
        },
      ];
      const ready = (data) => ({ status: 'ready', data });
      window.__fixtureCalls = [];
      const { createPayMutationGuard } = await import('/src/features/pay/pay-api.ts');
      const guard = createPayMutationGuard();
      window.__fixtureGuard = guard;
      const pay = {
        authority: { userId: 'TEST', merchantId: 'TEST', scopes: ['pay:read', 'pay:write'] },
        guard,
        access: () => null,
        keys: async () => ({ ok: true, data: keys }),
        createSandboxKey: async () => {
          window.__fixtureCalls.push('create');
          return { ok: true, data: { id: 'TEST-created', key: 'TEST-ONCE-ONLY-SECRET', prefix: 'TEST', mode: 'sandbox' } };
        },
        revokeKey: async () => {
          window.__fixtureCalls.push('revoke');
          await new Promise((r) => setTimeout(r, 50));
          return { ok: true, data: { revoked: true } };
        },
        registerWebhook: async () => {
          window.__fixtureCalls.push('register');
          return { ok: true, data: { ...endpoint, secret: 'TEST-WEBHOOK-ONCE-ONLY' } };
        },
        query: async (procedure, input) => {
          window.__fixtureReads = [...(window.__fixtureReads ?? []), { procedure, input }];
          const saved = window.__fixtureProof;
          return {
            ok: true,
            data: procedure === 'subscription.list' ? { items: saved ? [saved] : [], nextCursor: null } : (saved ?? subscription),
          };
        },
        mutate: async (procedure, input, _schema, scope, guardKey, reference) => {
          window.__fixtureCalls.push({ procedure, input, scope, guardKey });
          await new Promise((r) => setTimeout(r, 50));
          if (uncertainAction)
            return guard.run(
              `TEST:${guardKey}`,
              async () => ({ ok: false, reason: 'uncertain', code: 'pay.operation_unresolved', message: 'TEST timeout' }),
              reference,
            );
          return { ok: true, data: subscription };
        },
        manageWebhook: async () => {
          window.__fixtureCalls.push('manage');
          return { ok: true, data: { disabled: true } };
        },
      };
      const content =
        kind === 'subscription'
          ? React.createElement(billing.SubscriptionDetailView, {
              subscription,
              mandate: ready(mandate),
              cycles: ready({ subscriptionId: subscription.id, cycles: [] }),
              executions: ready([]),
              pay,
              reload: () => {},
            })
          : kind === 'subscription-create'
            ? React.createElement(billing.CreateSubscriptionView, {
                mandates: ready([mandate]),
                posture: ready({
                  paths: [{ path: 'crypto_invoice', charge: 'open_crypto_invoice', opensMoney: true, posture: 'invoice-and-watch' }],
                  preChargeNotify: { status: 'unwired', notified: false, merchantReadable: 'Not connected' },
                  card: { status: 'refuse_closed', code: 'pay.mandate_rail_absent' },
                }),
                pay,
                reload: () => {},
              })
            : kind === 'keys'
              ? React.createElement(views.KeysView, { resource: ready(keys), pay, reload: () => {} })
              : kind === 'endpoint'
                ? React.createElement(views.EndpointsView, {
                    resource: ready([endpoint]),
                    deliveries: ready([delivery]),
                    pay,
                    endpointId: endpoint.id,
                    reload: () => {},
                  })
                : kind === 'webhooks'
                  ? React.createElement(views.EndpointsView, {
                      resource: ready([endpoint]),
                      deliveries: ready([delivery]),
                      pay,
                      reload: () => {},
                    })
                  : React.createElement(views.DeliveryRows, { resource: ready([delivery]), reload: () => {} });
      createRoot(host).render(
        React.createElement(
          PortalFrame,
          {
            route: {
              room:
                kind === 'subscription'
                  ? 'subscription'
                  : kind === 'subscription-create'
                    ? 'subscription-new'
                    : kind === 'keys'
                      ? 'developer-keys'
                      : kind === 'endpoint'
                        ? 'developer-endpoint'
                        : kind === 'webhooks'
                          ? 'developer-webhooks'
                          : 'developer-deliveries',
            },
          },
          content,
        ),
      );
    },
    { kind, subscription, mandate, uncertainAction },
  );
  await expect(page.locator('#isolated-fixture .pp')).toBeVisible();
}
test('developer key component: review, single dispatch, once-only secret and filter export', async ({ page }) => {
  await developerFixture(page, 'keys');
  await expect(page.getByRole('rowheader', { name: /TEST integration/ })).toBeVisible();
  await both(page, 'P43-api-keys-component-TEST');
  await page.getByRole('button', { name: 'Revoke sandbox key', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.evaluate(() => window.__fixtureCalls)).toEqual([]);
  await page.getByRole('button', { name: 'Confirm revoke sandbox key', exact: true }).dblclick();
  await expect.poll(() => page.evaluate(() => window.__fixtureCalls)).toEqual(['revoke']);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByLabel('Key name', { exact: true }).pressSequentially('TEST new key');
  await page.getByRole('checkbox', { name: 'pay:read', exact: true }).check();
  await page.getByRole('button', { name: 'Create sandbox key', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm create sandbox key', exact: true }).click();
  await expect(page.getByText('TEST-ONCE-ONLY-SECRET', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Hide secret', exact: true }).click();
  await expect(page.getByText('TEST-ONCE-ONLY-SECRET', { exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Search loaded records', exact: true }).fill('not-a-key');
  await expect(page.getByText('0 records shown')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download shown records (CSV)' })).toBeDisabled();
});
test('webhook component: redacted URL, endpoint detail and enable/disable review', async ({ page }) => {
  await developerFixture(page, 'webhooks');
  await both(page, 'P45-webhooks-component-TEST');
  await expect(page.locator('.pp')).not.toContainText('TEST-secret-in-URL');
  await developerFixture(page, 'endpoint');
  await both(page, 'P46-endpoint-component-TEST');
  await page.getByRole('button', { name: 'Disable receiver', exact: true }).click();
  expect(await page.evaluate(() => window.__fixtureCalls)).toEqual([]);
  await page.getByRole('button', { name: 'Confirm disable receiver', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__fixtureCalls)).toEqual(['manage']);
});
test('delivery component: scoped drawer, safe response, URL filters and shown-row export', async ({ page }) => {
  await page.clock.install();
  await developerFixture(page, 'deliveries');
  await page.getByRole('button', { name: 'Open detail', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Delivery facts', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/delivery=TEST-delivery/);
  await expect(page.locator('.pp')).not.toContainText('INTERNAL SECRET');
  await both(page, 'P47-deliveries-component-TEST');
  await page.clock.fastForward(301000);
  await expect(page.getByText(/read more than five minutes ago/)).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download shown records (CSV)' }).click();
  expect((await download).suggestedFilename()).toBe('webhook-deliveries.csv');
  await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('delivered');
  await expect(page.getByText('0 records shown')).toBeVisible();
  await expect(page.getByText('No deliveries in this view')).toBeVisible();
});

test('subscription component: cancellation requires a summary and dispatches the existing guarded action once', async ({ page }) => {
  await developerFixture(page, 'subscription');
  await page.getByRole('button', { name: 'Cancel subscription', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('stop its future scheduled cycles');
  await expect(dialog).toContainText('TEST-customer');
  expect(await page.evaluate(() => window.__fixtureCalls)).toEqual([]);
  await dialog.getByRole('button', { name: 'Confirm cancel subscription', exact: true }).dblclick();
  await expect
    .poll(() => page.evaluate(() => window.__fixtureCalls))
    .toEqual([{ procedure: 'subscription.cancel', input: { subscriptionId: S }, scope: 'pay:write', guardKey: `subscription:${S}` }]);
});
test('subscription component: create reviews the authorized terms and uses the existing creation guard', async ({ page }) => {
  await developerFixture(page, 'subscription-create');
  await page.getByLabel('Active customer mandate *').selectOption(D);
  await page.getByLabel('Supported charge path *').selectOption('crypto_invoice');
  await page.getByRole('button', { name: 'Create subscription', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('cannot pull funds from the customer');
  await expect(dialog).toContainText('29.99');
  for (const value of ['TEST-customer', 'monthly', 'Open ended', 'No ceiling returned', 'USDT', 'crypto_invoice', D])
    await expect(dialog).toContainText(value);
  await expect(dialog.locator('time')).toHaveAttribute('datetime', at);
  if (shots) await page.screenshot({ path: `${shots}/P19-review-fixes-TEST.png`, fullPage: true });
  await dialog.getByRole('button', { name: 'Confirm create subscription', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__fixtureCalls))
    .toEqual([
      {
        procedure: 'subscription.create',
        input: { mandateId: D, path: 'crypto_invoice' },
        scope: 'pay:write',
        guardKey: `subscription-create:${D}`,
      },
    ]);
  await expect(page.getByRole('link', { name: `Subscription detail: ${S}`, exact: true })).toBeVisible();
});

test('subscription review fixes: uncertain create is mandate-scoped and check-original unlocks without another POST', async ({ page }) => {
  await developerFixture(page, 'subscription-create', true);
  await page.getByLabel('Active customer mandate *').selectOption(D);
  await page.getByLabel('Supported charge path *').selectOption('crypto_invoice');
  await page.getByRole('button', { name: 'Create subscription', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm create subscription', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('TEST timeout');
  await page.getByRole('dialog').getByRole('button', { name: 'Close dialog', exact: true }).click();
  const check = page.getByRole('button', { name: 'Check original action', exact: true });
  await expect(check).toBeVisible();
  await check.click();
  await expect(page.getByText(/original outcome is still unconfirmed/)).toBeVisible();
  await page.evaluate(
    ({ subscription }) => {
      window.__fixtureProof = { ...subscription, createdAt: new Date().toISOString() };
    },
    { subscription },
  );
  await check.click();
  await expect(page.getByRole('link', { name: `Subscription detail: ${S}`, exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__fixtureCalls.length)).toBe(1);
  expect(
    await page.evaluate(() => window.__fixtureGuard.status(`TEST:subscription-create:${'77777777-7777-4777-8777-777777777777'}`)),
  ).toBeNull();
});
test('subscription review fixes: uncertain pause checks recorded status and releases only the original lock', async ({ page }) => {
  await developerFixture(page, 'subscription', true);
  await page.getByRole('button', { name: 'Pause subscription', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm pause subscription', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('TEST timeout');
  await page.getByRole('dialog').getByRole('button', { name: 'Close dialog', exact: true }).click();
  const check = page.getByRole('button', { name: 'Check original action', exact: true });
  await check.click();
  await expect(page.getByText(/original outcome is still unconfirmed/)).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/P18-recovery-fixes-TEST.png`, fullPage: true });
  await page.evaluate(
    ({ subscription }) => {
      window.__fixtureProof = { ...subscription, status: 'paused' };
    },
    { subscription },
  );
  await check.click();
  await expect(check).toHaveCount(0);
  expect(await page.evaluate(() => window.__fixtureGuard.status(`TEST:subscription:${'66666666-6666-4666-8666-666666666666'}`))).toBeNull();
  expect(await page.evaluate(() => window.__fixtureCalls.length)).toBe(1);
});

test('subscription recovery: reload locks the stored path and conflict clears the journal', async ({ page }) => {
  async function mount() {
    await page.evaluate(
      async ({ mandate, D }) => {
        const React = (await import('/node_modules/.vite/deps/react.js')).default;
        const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
        const { CreateSubscriptionView } = await import('/src/features/pay/portal/payments/Subscriptions.tsx');
        const { createApiClient } = await import('/src/shared/api.ts');
        const { createBusinessPayApi, createPayMutationGuard } = await import('/src/features/pay/pay-api.ts');
        await import('/src/features/pay/pay.css');
        const ready = (data) => ({ status: 'ready', data });
        const guard = createPayMutationGuard(localStorage);
        window.__fixtureGuard = guard;
        window.__fixtureCalls = [];
        const api = createApiClient({
          fetch: async (url, options) => {
            if (String(url).includes('merchant.me'))
              return new Response(
                JSON.stringify({
                  result: {
                    data: {
                      id: mandate.merchantId,
                      userId: '22222222-2222-4222-8222-222222222222',
                      mode: 'gateway',
                      status: 'active',
                      kybStatus: 'approved',
                      kybRef: 'TEST-approved',
                      feeBps: null,
                    },
                  },
                }),
              );
            if (!String(url).includes('subscription.create')) throw new Error('Unexpected TEST request');
            window.__fixtureCalls.push(JSON.parse(options.body));
            if (!localStorage.getItem('TEST-response-lost')) {
              localStorage.setItem('TEST-response-lost', 'yes');
              throw new Error('TEST lost response');
            }
            return new Response(
              JSON.stringify({
                error: {
                  message: 'Idempotency-Key was already used with a different request body',
                  data: { code: 'pay.idempotency_conflict' },
                },
              }),
              { status: 409 },
            );
          },
        });
        const pay = createBusinessPayApi(
          api,
          '22222222-2222-4222-8222-222222222222',
          {
            verified: true,
            companyId: 'TEST-company',
            companyName: 'TEST company',
            merchantId: mandate.merchantId,
            userId: '22222222-2222-4222-8222-222222222222',
            scopes: ['pay:read', 'pay:write'],
          },
          guard,
        );
        document.getElementById('root').style.display = 'none';
        const host = document.createElement('div');
        host.className = 'if-app if-business';
        document.body.append(host);
        createRoot(host).render(
          React.createElement(CreateSubscriptionView, {
            mandates: ready([mandate]),
            posture: ready({
              paths: [{ path: 'crypto_invoice', charge: 'open_crypto_invoice', opensMoney: true, posture: 'invoice-and-watch' }],
              preChargeNotify: { status: 'unwired', notified: false, merchantReadable: 'none' },
              card: { status: 'refuse_closed', code: 'pay.mandate_rail_absent' },
            }),
            pay,
            reload: () => {},
          }),
        );
      },
      { mandate, D },
    );
  }
  await page.goto('/login');
  await mount();
  await page.getByLabel('Active customer mandate *').selectOption(D);
  await page.getByLabel('Supported charge path *').selectOption('crypto_invoice');
  await page.getByRole('button', { name: 'Create subscription', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm create subscription', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__fixtureCalls.length)).toBe(1);
  await expect(page.getByRole('dialog')).toContainText('Outcome not confirmed');
  const firstBody = await page.evaluate(() => window.__fixtureCalls[0]);
  await page.reload();
  await mount();
  const path = page.getByLabel('Supported charge path *');
  await expect(path).toHaveValue('crypto_invoice');
  await expect(path).toBeDisabled();
  if (shots) await page.screenshot({ path: `${shots}/P19-recovery-reloaded-TEST.png`, fullPage: true });
  await page.getByRole('button', { name: 'Check original action', exact: true }).click();
  await expect(
    page.getByText('A subscription request for this mandate is already recorded. Open Subscriptions to check it.').first(),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Subscriptions', exact: true })).toHaveAttribute('href', `/pay/subscriptions?mandateId=${D}`);
  expect(await page.evaluate(() => window.__fixtureCalls[0])).toEqual(firstBody);
  expect(
    await page.evaluate((D) => window.__fixtureGuard.status(`22222222-2222-4222-8222-222222222222:subscription-create:${D}`), D),
  ).toBeNull();
  expect(
    await page.evaluate((D) => localStorage.getItem(`pay.unresolved:22222222-2222-4222-8222-222222222222:subscription-create:${D}`), D),
  ).toBeNull();
  await expect(page.getByRole('button', { name: 'Create subscription', exact: true })).toBeEnabled();
  await expect(page.locator('body')).not.toContainText('Idempotency-Key was already used');
  if (shots) await page.screenshot({ path: `${shots}/P19-recovery-conflict-TEST.png`, fullPage: true });
});
