import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Playwright fixtures exercise the public feature/session and network seams only.
// No test application, fixture route or production sample dataset is exposed.
const userId = '11111111-1111-4111-8111-111111111111';
const spaceId = '22222222-2222-4222-8222-222222222222';
const merchantId = '33333333-3333-4333-8333-333333333333';
const orderId = '44444444-4444-4444-8444-444444444444';
const source = {
  id: spaceId,
  assetId: 'USDT',
  kind: 'primary',
  name: 'Main',
  goalTarget: null,
  lockedUntil: null,
  balance: '4.000000000000000001',
  ledgerAccount: { ownerType: 'user', ownerId: userId, assetId: 'USDT', kind: 'bank:primary' },
};
const session = {
  accessToken: 'test-only-in-memory',
  refreshToken: 'test-only-in-memory-refresh',
  expiresAt: '2027-10-07T12:00:00Z',
  userId,
};
const authority = {
  verified: true,
  companyId: 'fixture-company',
  companyName: 'Company test fixture',
  userId,
  merchantId,
  scopes: ['pay:read', 'pay:write', 'pay:refund', 'pay:payout'],
};
const merchant = {
  id: merchantId,
  userId,
  mode: 'gateway',
  status: 'active',
  kybStatus: 'approved',
  kybRef: 'test-reference',
  feeBps: null,
};
const reply = (route, data, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ result: { data } }) });

async function mount(page, path, business = null, signedIn = true) {
  await page.goto('/');
  await page.evaluate(
    async ({ path, business, session, signedIn }) => {
      const React = (await import('/node_modules/.vite/deps/react.js')).default;
      const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
      const { SessionProvider, useSession } = await import('/src/features/session/session.tsx');
      const { PayRoutes, PayBusinessProvider } = await import('/src/features/pay/PayRoutes.tsx');
      window.history.replaceState(null, '', path);
      const host = document.createElement('main');
      document.body.replaceChildren(host);
      function Setup() {
        const context = useSession();
        React.useEffect(() => {
          if (signedIn) context.commit(session);
        }, []);
        return React.createElement(PayBusinessProvider, { authority: business }, React.createElement(PayRoutes, { path }));
      }
      createRoot(host).render(React.createElement(SessionProvider, null, React.createElement(Setup)));
    },
    { path, business, session, signedIn },
  );
}

test('Personal Pay hides merchant rooms and direct Business refuses without company authority', async ({ page }) => {
  const requests = [];
  await page.route('**/api/**', (route) => {
    requests.push(route.request().url());
    return reply(route, null);
  });
  await mount(page, '/pay');
  await expect(page.getByRole('heading', { name: 'Pay', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /merchant|settlement|permission/i })).toHaveCount(0);
  await mount(page, '/pay/links');
  await expect(page.getByRole('heading', { name: 'Access is restricted' })).toBeVisible();
  await expect(page.getByText(/verified Business account and company membership/)).toBeVisible();
  expect(requests).toEqual([]);
});

test('Send reviews exact units, posts once, and a lost response survives navigation', async ({ page }) => {
  const posted = [];
  await page.route('**/api/**', async (route) => {
    if (route.request().url().includes('spaces.list')) return reply(route, [source]);
    posted.push(route.request().postDataJSON());
    return route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'Rail outcome unknown' } }),
    });
  });
  await mount(page, '/pay/send');
  await page.getByLabel('Source account').selectOption(spaceId);
  await page.getByLabel('Recipient account ID').fill(merchantId);
  await page.getByLabel('Amount · USDT', { exact: true }).fill('0.000000000000000001');
  await page.getByRole('button', { name: 'Review transfer' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review transfer' });
  await expect(dialog.getByText('0.000000000000000001 USDT', { exact: true })).toBeVisible();
  expect(posted).toEqual([]);
  await dialog.getByRole('button', { name: 'Confirm transfer' }).click();
  await expect(dialog.getByRole('heading', { name: 'Outcome not confirmed' })).toBeVisible();
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({ amount: '0.000000000000000001', fromSpaceId: spaceId, toUserId: merchantId });
  await mount(page, '/pay/send');
  await expect(page.getByRole('heading', { name: 'Original transfer is unresolved' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review transfer' })).toBeDisabled();
  const recovery = page.getByRole('region', { name: 'Original transfer is unresolved' });
  await expect(recovery.getByText(posted[0].transferId, { exact: true })).toBeVisible();
  await expect(recovery.getByRole('link', { name: 'Contact Support' })).toHaveAttribute('href', '/support');
  await expect(recovery.getByRole('link', { name: 'Check Money activity' })).toHaveAttribute('href', '/uc/record');
  const recoveryY = await recovery.evaluate((node) => node.getBoundingClientRect().top);
  const entryY = await page.getByLabel('Source account').evaluate((node) => node.getBoundingClientRect().top);
  expect(recoveryY).toBeLessThan(entryY);
  if (process.env.PAY_JOURNEY_SCREENSHOTS) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${process.env.PAY_JOURNEY_SCREENSHOTS}/journey-2-original-transfer-recovery.png`, fullPage: true });
  }
  expect(posted).toHaveLength(1);
});

test('Transfer review supports exact-value inspection and editing, and a receipt keeps its original asset', async ({ page }) => {
  const posted = [];
  const second = {
    ...source,
    id: orderId,
    assetId: 'BTC',
    name: 'Bitcoin source',
    ledgerAccount: { ...source.ledgerAccount, assetId: 'BTC' },
  };
  await page.route('**/api/**', (route) => {
    if (route.request().url().includes('spaces.list')) return reply(route, [source, second]);
    const input = route.request().postDataJSON();
    posted.push(input);
    return reply(route, { ledgerTxId: 'confirmed-test-transfer', amount: input.amount });
  });
  await mount(page, '/pay/send');
  await page.getByLabel('Source account').selectOption(spaceId);
  await page.getByLabel('Recipient account ID').fill(merchantId);
  await page.getByLabel('Amount · USDT', { exact: true }).fill('0.000000000000000001');
  await page.getByRole('button', { name: 'Review transfer' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review transfer' });
  const value = dialog.getByRole('group', { name: 'You send' });
  await expect(value.getByText('0.000000000000000001 USDT', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Main · USDT', { exact: true })).toBeVisible();
  await expect(dialog.getByText(merchantId, { exact: true })).toBeVisible();
  await expect(dialog.getByText(/Confirm this account ID with your recipient/)).toBeVisible();
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const fit = await dialog.evaluate((node) => ({
      viewport: innerWidth,
      left: node.getBoundingClientRect().left,
      right: node.getBoundingClientRect().right,
      scroll: node.scrollWidth,
      client: node.clientWidth,
    }));
    expect(fit.left).toBeGreaterThanOrEqual(0);
    expect(fit.right).toBeLessThanOrEqual(fit.viewport);
    expect(fit.scroll).toBeLessThanOrEqual(fit.client);
    const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(audit.violations.filter((item) => ['serious', 'critical'].includes(item.impact))).toEqual([]);
    for (const name of ['Edit transfer', 'Confirm transfer']) {
      const button = dialog.getByRole('button', { name });
      const bounds = await button.boundingBox();
      expect(bounds.height).toBeGreaterThanOrEqual(44);
    }
    await dialog.evaluate((node) => {
      node.scrollTop = 0;
    });
    const confirmBounds = await dialog.getByRole('button', { name: 'Confirm transfer' }).boundingBox();
    expect(confirmBounds.y + confirmBounds.height).toBeLessThanOrEqual(844);
    if (process.env.PAY_JOURNEY_SCREENSHOTS) {
      await dialog.evaluate((node) => {
        node.scrollTop = 0;
      });
      await page.screenshot({ path: `${process.env.PAY_JOURNEY_SCREENSHOTS}/journey-2-review-${width}.png` });
    }
  }
  await dialog.getByRole('button', { name: 'Edit transfer' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Review transfer' })).toBeFocused();
  await expect(page.getByLabel('Amount · USDT', { exact: true })).toHaveValue('0.000000000000000001');
  expect(posted).toEqual([]);
  await page.getByRole('button', { name: 'Review transfer' }).click();
  await dialog.getByRole('button', { name: 'Confirm transfer' }).click();
  await expect(page.getByText('confirmed-test-transfer', { exact: true })).toBeVisible();
  expect(posted).toHaveLength(1);
  await page.getByLabel('Source account').selectOption(orderId);
  await expect(page.getByText('0.000000000000000001 USDT', { exact: true })).toBeVisible();
  await expect(page.getByText('0.000000000000000001 BTC', { exact: true })).toHaveCount(0);
  expect(posted).toHaveLength(1);
});

test('A confirmed transfer receipt survives failed source refresh and subsequent recovery', async ({ page }) => {
  let reads = 0;
  let allowRefresh = false;
  const posted = [];
  await page.route('**/api/**', (route) => {
    if (route.request().url().includes('spaces.list')) {
      reads++;
      return reads <= 2 || allowRefresh ? reply(route, [source]) : reply(route, null, 503);
    }
    const input = route.request().postDataJSON();
    posted.push(input);
    return reply(route, { ledgerTxId: 'confirmed-before-refresh', amount: input.amount });
  });
  await mount(page, '/pay/send');
  await page.getByLabel('Source account').selectOption(spaceId);
  await page.getByLabel('Recipient account ID').fill(merchantId);
  await page.getByLabel('Amount · USDT', { exact: true }).fill('1.000000000000000001');
  await page.getByRole('button', { name: 'Review transfer' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm transfer' }).click();
  await expect(page.getByRole('heading', { name: 'Transfer confirmed' })).toBeVisible();
  await expect(page.getByText('confirmed-before-refresh', { exact: true })).toBeVisible();
  await expect(page.getByText('1.000000000000000001 USDT', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Connection unavailable' })).toBeVisible();
  expect(reads).toBe(3);
  expect(posted).toHaveLength(1);
  allowRefresh = true;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByLabel('Source account')).toBeVisible();
  await expect(page.getByText('confirmed-before-refresh', { exact: true })).toBeVisible();
  await expect(page.getByText('1.000000000000000001 USDT', { exact: true })).toBeVisible();
  expect(posted).toHaveLength(1);
});

test('P2P keeps release behind seller-confirmed external payment and shows absent chat', async ({ page }) => {
  const trade = {
    id: orderId,
    offerId: spaceId,
    sellerId: userId,
    buyerId: merchantId,
    asset: 'USDT',
    amount: '2',
    fiatCurrency: 'USD',
    fiatAmount: '2.1',
    price: '1.05',
    method: 'operator-method',
    status: 'escrowed',
    resolution: null,
    deadlineAt: null,
    createdAt: '2026-10-07T12:00:00Z',
    escrowedAt: '2026-10-07T12:00:00Z',
    resolvedAt: null,
    settledAt: null,
  };
  await page.route('**/api/**', (route) => (route.request().url().includes('trades.get') ? reply(route, trade) : reply(route, null, 404)));
  await mount(page, `/chat?tradeId=${orderId}`);
  await expect(page.getByRole('heading', { name: 'Order details' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Release escrow' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Message thread is not connected' })).toBeVisible();
  trade.status = 'fiat_sent';
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await page.getByRole('button', { name: 'Release escrow' }).click();
  await expect(page.getByRole('dialog', { name: 'Review: Release escrow' }).getByText('2 USDT', { exact: true })).toBeVisible();
});

test('Legacy counterparty IDs read reputation instead of addressing an order', async ({ page }) => {
  const requests = [];
  await page.route('**/api/**', (route) => {
    requests.push(route.request().url());
    return reply(route, {
      tradesTotal: 2,
      completed: 1,
      cancelled: 1,
      disputed: 0,
      disputesLost: 0,
      completionRate: 0.5,
      avgReleaseSecs: 20,
      badges: [],
      merchant: null,
    });
  });
  await mount(page, `/checkuser?id=${merchantId}`);
  await expect(page.getByRole('heading', { name: 'Counterparty', exact: true })).toBeVisible();
  await expect(page.getByText('Programme unavailable', { exact: true })).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain('/api/p2p/trpc/reputation.get');
});

test('Personal P2P programme application does not create Business authority', async ({ page }) => {
  const posted = [];
  let applied = false;
  await page.route('**/api/**', (route) => {
    const url = route.request().url();
    if (url.includes('merchants.apiAccess'))
      return reply(route, {
        eligible: false,
        credential: 'session',
        merchantStatus: applied ? 'applied' : null,
        keyPlane: 'identity',
        rateLimitPlane: 'edge',
        disputeResolution: 'interactive_human_only',
      });
    const standing = {
      userId,
      status: 'applied',
      appliedCompletionRate: 1,
      appliedTradesTotal: 2,
      appliedAt: '2026-10-07T12:00:00Z',
      decidedAt: null,
    };
    if (url.includes('merchants.submitApplication')) {
      posted.push(route.request().postDataJSON());
      applied = true;
      return reply(route, standing);
    }
    return reply(route, applied ? standing : null);
  });
  await mount(page, '/p2p?view=access');
  await expect(page.locator('nav[aria-label="P2P rooms"] [aria-current="page"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Apply to P2P programme', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm apply to p2p programme' }).click();
  await expect(page.getByText('applied', { exact: true })).toBeVisible();
  expect(posted).toEqual([{}]);
  await mount(page, '/pay/links');
  await expect(page.getByRole('heading', { name: 'Access is restricted' })).toBeVisible();
});

test('Public checkout keeps fixed amount authoritative and never invents a payment handoff', async ({ page }) => {
  const posted = [];
  await page.route('**/api/**', (route) => {
    const url = route.request().url();
    if (url.includes('resolveLink'))
      return reply(route, {
        id: orderId,
        merchantId,
        profileId: null,
        label: 'Checkout test fixture',
        amount: '12.000000000000000001',
        currency: 'USD',
        expiresAt: null,
        remainingUses: 1,
        checkoutConfig: {},
      });
    const checkout = {
      id: orderId,
      status: 'open',
      label: 'Checkout test fixture',
      amount: '12.000000000000000001',
      currency: 'USD',
      method: 'card',
      expiresAt: '2027-10-07T12:00:00Z',
      instruction: null,
    };
    if (url.includes('checkout.open')) {
      posted.push(route.request().postDataJSON());
      return reply(route, { sessionToken: 'session-test-capability', session: checkout });
    }
    return reply(route, checkout);
  });
  await mount(page, '/pay/checkout?token=link-test-capability', null, false);
  await expect(page.getByText('12.000000000000000001 USD', { exact: true })).toBeVisible();
  await page.getByLabel('Your country').fill('ID');
  await page.getByLabel('Payment method', { exact: true }).selectOption('card');
  await page.getByRole('button', { name: 'Open payment session', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm open payment session' }).click();
  await expect(page.getByRole('heading', { name: 'Payment instructions were not returned' })).toBeVisible();
  expect(posted).toEqual([{ token: 'link-test-capability', geoCountry: 'ID', method: 'card' }]);
  await expect(page.getByRole('button', { name: /paid|capture|pay now/i })).toHaveCount(0);
});

test('Developer sandbox key cannot omit its mode or enter the live payment path', async ({ page }) => {
  const posted = [];
  await page.route('**/api/**', (route) => {
    const url = route.request().url();
    if (url.includes('merchant.me')) return reply(route, merchant);
    if (url.includes('apiKeys.list')) return reply(route, []);
    posted.push({ url, body: route.request().postDataJSON() });
    return reply(route, { id: orderId, key: 'ifc_test_fixture-secret', prefix: 'ifc_test_fixture', mode: 'sandbox' });
  });
  await mount(page, '/pay/developer', authority);
  await page.getByLabel('Key name').fill('Sandbox test fixture');
  await page.getByLabel('pay:read', { exact: true }).check();
  await page.getByRole('button', { name: 'Create sandbox key', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm create sandbox key' }).click();
  await expect(page.getByRole('heading', { name: 'Sandbox secret returned once' })).toBeVisible();
  expect(posted).toHaveLength(1);
  expect(posted[0].body).toEqual({ name: 'Sandbox test fixture', scopes: ['pay:read'], mode: 'sandbox' });
  expect(posted[0].url).toContain('/api/identity/trpc/apiKeys.create');
  await expect(page.getByRole('button', { name: /capture|refund|payout|live payment/i })).toHaveCount(0);
});

test('Personal Pay fits desktop, tablet and phone without page overflow', async ({ page }) => {
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await mount(page, '/pay');
    await expect(page.getByRole('heading', { name: 'Pay', exact: true })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    expect(overflow).toBe(false);
    await page.screenshot({
      path: `${process.env.PAY_PROOF_DIR ?? '/tmp/intafaced-pay-browser-results'}/personal-pay-${width}.png`,
      fullPage: true,
    });
  }
});

test('Pay uses accessible control names, page regions and contrast in the browser', async ({ page }) => {
  await mount(page, '/pay');
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
  await mount(page, '/pay/links');
  await expect(page.getByRole('heading', { name: 'Access is restricted' })).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
});

test('light appearance keeps the real Pay chrome action readable', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('intafaced.customer.view.v1', JSON.stringify({ theme: 'light' })));
  await mount(page, '/pay');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const action = page.getByRole('link', { name: 'Send money', exact: true });
  await expect(action).toBeVisible();
  // Axe cannot resolve gradient images. Check the actual flat face under the
  // label separately; the metallic border is outside that painted area.
  const contrast = await action.evaluate((node) => {
    const style = getComputedStyle(node);
    const faces = [...style.backgroundImage.matchAll(/rgb\(([^)]+)\)/g)].slice(0, 2).map((match) => match[1]);
    if (faces.length !== 2 || faces[0] !== faces[1]) throw new Error('The chrome face is not a flat opaque surface');
    const luminance = (rgb) =>
      rgb
        .split(',')
        .map(Number)
        .map((channel) => {
          const value = channel / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        })
        .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const text = luminance(style.color.match(/rgb\(([^)]+)\)/)[1]);
    const face = luminance(faces[0]);
    return (Math.max(text, face) + 0.05) / (Math.min(text, face) + 0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
  const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(audit.violations.filter((item) => ['serious', 'critical'].includes(item.impact))).toEqual([]);
});

test('an unwritten Pay locale uses honest English fallback and preserves the exact reviewed transfer', async ({ page }) => {
  const posted = [];
  await page.route('**/api/**', async (route) => {
    if (route.request().url().includes('spaces.list')) return reply(route, [source]);
    posted.push(route.request().postDataJSON());
    return route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Original source explanation' }),
    });
  });
  await mount(page, '/pay/send');
  await page.evaluate(async () => {
    const { savePreferences } = await import('/src/shared/preferences.ts');
    savePreferences({ language: 'fr' });
  });
  const heading = page.getByRole('heading', { name: 'Send money', exact: true });
  await expect(heading).toBeVisible();
  expect(await heading.evaluate((element) => element.closest('[lang]')?.getAttribute('lang'))).toBe('en');
  await page.getByLabel('Source account').selectOption(spaceId);
  await page.getByLabel('Recipient account ID').fill(merchantId);
  await page.getByLabel('Amount · USDT', { exact: true }).fill('0.000000000000000001');
  await page.getByRole('button', { name: 'Review transfer' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review transfer' });
  await expect(dialog.getByText('0.000000000000000001 USDT', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Confirm transfer' }).click();
  await expect(dialog.getByRole('heading', { name: 'Résultat non confirmé' })).toBeVisible();
  await expect(dialog.getByText('Original source explanation', { exact: true })).toBeVisible();
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({ amount: '0.000000000000000001', fromSpaceId: spaceId, toUserId: merchantId });
});
