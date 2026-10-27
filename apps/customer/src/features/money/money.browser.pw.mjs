import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Exact domain examples exist only at the test/network seam. No fixture app or
// financial sample route is installed. Screenshots below use honest absence.
const userId = '11111111-1111-4111-8111-111111111111';
const fromId = '22222222-2222-4222-8222-222222222222';
const toId = '33333333-3333-4333-8333-333333333333';
const session = {
  userId,
  accessToken: 'money-browser-test-token',
  refreshToken: 'money-browser-test-refresh',
  expiresAt: '2027-10-07T12:00:00Z',
};
const primary = {
  id: fromId,
  assetId: 'BTC',
  kind: 'primary',
  name: 'Primary',
  goalTarget: null,
  lockedUntil: null,
  balance: '0.200000000000000001',
  ledgerAccount: { ownerType: 'user', ownerId: userId, assetId: 'BTC', kind: 'available' },
};
const balances = {
  timestamp: 1791374400000,
  datetime: '2026-10-07T12:00:00Z',
  balances: { BTC: { free: '0.200000000000000001', used: '0.1', total: '0.300000000000000001' } },
};
function reply(route, data, raw = false) {
  return route.fulfill({ contentType: 'application/json', body: JSON.stringify(raw ? data : { result: { data } }) });
}
async function mount(page, path) {
  await page.goto('/');
  await page.evaluate(
    async ({ path, session }) => {
      const React = (await import('/node_modules/.vite/deps/react.js')).default;
      const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
      const { SessionProvider, useSession } = await import('/src/features/session/session.tsx');
      const { MoneyRoutes } = await import('/src/features/money/index.tsx');
      const { Shell } = await import('/src/app/Shell.tsx');
      const { savePreferences } = await import('/src/shared/preferences.ts');
      savePreferences({ hideBalances: false, displayCurrency: 'USD' });
      window.history.replaceState(null, '', path);
      const host = document.createElement('main');
      document.body.replaceChildren(host);
      function Setup() {
        const context = useSession();
        React.useEffect(() => {
          context.commit(session);
        }, []);
        return React.createElement(Shell, { door: 'Money' }, React.createElement(MoneyRoutes, { path }));
      }
      createRoot(host).render(React.createElement(SessionProvider, null, React.createElement(Setup)));
    },
    { path, session },
  );
}

test('Bank journals the original request before dispatch and survives closing its tab before any outcome', async ({ page, context }) => {
  let request;
  let journalAtDispatch;
  await defaultApi(page, {
    'spaces.list': (route) => reply(route, [primary]),
    'transfers.create': async (route) => {
      request = route.request().postDataJSON();
      journalAtDispatch = await page.evaluate((owner) => localStorage.getItem('intafaced.customer.bank-unconfirmed.v1:' + owner), userId);
      // Leave the response unresolved: closing the tab must not erase identity.
      await new Promise((resolve) => page.once('close', resolve));
    },
  });
  await mount(page, `/bank/transfers?from=${fromId}`);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Destination space ID').fill(toId);
  await page.getByLabel('Amount (BTC)').fill('0.000000000000000001');
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect.poll(() => request).toBeTruthy();
  await expect.poll(() => journalAtDispatch).not.toBeUndefined();
  expect(journalAtDispatch).toBeTruthy();
  const marker = JSON.parse(journalAtDispatch)[0];
  expect(marker.recordRefs.transferId).toBe(request.transferId);
  expect(marker.recordRefs).not.toHaveProperty('amount');
  expect(journalAtDispatch).not.toContain(session.accessToken);
  expect(journalAtDispatch).not.toContain(session.refreshToken);
  await page.close();
  const reopened = await context.newPage();
  await defaultApi(reopened, { 'spaces.list': (route) => reply(route, [primary]) });
  await mount(reopened, `/bank/transfers?from=${fromId}`);
  await expect(reopened.getByText('Bank writes are paused while an outcome is unconfirmed.')).toBeVisible();
  await expect(reopened.locator('#bank-unconfirmed')).toContainText(request.transferId);
  await reopened.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(reopened.getByRole('dialog')).toHaveCount(0);
  await reopened.close();
});

test('Bank refuses to dispatch when the original request cannot be durably saved', async ({ page }) => {
  let sends = 0;
  await defaultApi(page, {
    'spaces.list': (route) => reply(route, [primary]),
    'transfers.create': (route) => {
      sends++;
      return reply(route, { ledgerTxId: 'unexpected', amount: '0.000000000000000001' });
    },
  });
  await mount(page, `/bank/transfers?from=${fromId}`);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('intafaced.customer.bank-unconfirmed')) throw new DOMException('storage disabled', 'SecurityError');
      return original.call(this, key, value);
    };
  });
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Destination space ID').fill(toId);
  await page.getByLabel('Amount (BTC)').fill('0.000000000000000001');
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByText('Recovery storage is unavailable. No Bank request was sent.')).toBeVisible();
  expect(sends).toBe(0);
});

test('failed Bank balance sources stay unavailable instead of claiming an empty returned projection', async ({ page }) => {
  await page.route('**/api/**', (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Unavailable' } }) }),
  );
  await mount(page, '/bank');
  await expect(page.getByText('Holdings could not be loaded.')).toBeVisible();
  await expect(page.getByText('No available quantities returned')).toHaveCount(0);
  await expect(page.getByText(/An empty projection/)).toHaveCount(0);
});
async function defaultApi(page, overrides = {}) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const procedure = url.pathname.split('/').at(-1);
    if (overrides[procedure]) return overrides[procedure](route, url);
    if (url.pathname === '/api/v1/account/balance') return reply(route, { ...balances, balances: {} }, true);
    if (procedure === 'spaces.unnamed') return reply(route, []);
    return reply(route, []);
  });
}

test('Money keeps exact scoped quantities, excludes aliases and follows shared amount hiding', async ({ page }) => {
  await defaultApi(page, { balance: (route) => reply(route, balances, true), 'spaces.list': (route) => reply(route, [primary]) });
  await mount(page, '/portfolio');
  const holding = page.locator('.money-holding');
  await expect(holding).toHaveCount(1);
  await expect(holding).toContainText('0.300000000000000001 BTC');
  await expect(holding).toContainText('0.200000000000000001 BTC available');
  await expect(page.locator('.money-total')).toHaveText('Unavailable');
  await page.getByRole('button', { name: 'Hide amounts' }).click();
  await expect(holding).toContainText('Amounts hidden');
  await expect(holding).not.toContainText('0.300000000000000001');
});

for (const path of ['/portfolio/BTC', '/money/asset/BTC']) {
  test(`holding detail at ${path} preserves exact asset quantities and action context`, async ({ page }) => {
    await defaultApi(page, { balance: (route) => reply(route, balances, true), 'spaces.list': (route) => reply(route, [primary]) });
    await mount(page, path);
    await expect(page.getByRole('heading', { name: 'BTC', exact: true, level: 1 })).toBeVisible();
    await expect(page.locator('.money-holding-quantity')).toHaveText('0.300000000000000001 BTC');
    await expect(page.locator('.money-holding-restrictions .numeric')).toHaveText(['0.200000000000000001 BTC', '0.1 BTC']);
    await expect(page.getByText('Total account value', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Send available BTC/ })).toHaveAttribute('href', '/pay/send?asset=BTC');
    await expect(page.locator('a[href="/pay/send"]')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Buy BTC', exact: true })).toHaveAttribute('href', '/exchange?asset=BTC&side=buy');
    await expect(page.getByRole('link', { name: 'Sell BTC', exact: true })).toHaveAttribute('href', '/exchange?asset=BTC&side=sell');
    await expect(page.getByRole('link', { name: /Repeat buy/ })).toHaveAttribute('href', '/portfolio/BTC/repeat-buy');
  });
}

test('a reviewed transfer sends exact units and an unknown outcome offers no resubmit', async ({ page }) => {
  const sent = [];
  await defaultApi(page, {
    'spaces.list': (route) => reply(route, [primary]),
    'transfers.create': async (route) => {
      sent.push(route.request().postDataJSON());
      await route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'Upstream outcome unknown' } }),
      });
    },
  });
  await mount(page, `/bank/transfers?from=${fromId}`);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Destination space ID').fill(toId);
  await page.getByLabel('Amount (BTC)').fill('0.000000000000000001');
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('0.000000000000000001');
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Outcome not confirmed');
  await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit request' })).toHaveCount(0);
  expect(sent).toHaveLength(1);
  expect(sent[0].amount).toBe('0.000000000000000001');
  expect(sent[0].fromSpaceId).toBe(fromId);
  expect(sent[0].toSpaceId).toBe(toId);
  expect(sent[0].transferId).toMatch(/^[0-9a-f-]{36}$/);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('Bank writes are paused while an outcome is unconfirmed.')).toBeVisible();
  expect(sent).toHaveLength(1);
});

test('a locked source refuses before a transfer request can be sent', async ({ page }) => {
  let writes = 0;
  await defaultApi(page, {
    'spaces.list': (route) => reply(route, [{ ...primary, lockedUntil: '2027-10-07T12:00:00Z' }]),
    'transfers.create': (route) => {
      writes++;
      return reply(route, { ledgerTxId: 'unexpected', amount: '0.1' });
    },
  });
  await mount(page, `/bank/transfers?from=${fromId}`);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Destination space ID').fill(toId);
  await page.getByLabel('Amount (BTC)').fill('0.1');
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('This space is locked');
  await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toHaveCount(0);
  expect(writes).toBe(0);
});

test('analytics uses the requested asset and window and distinguishes movements from return', async ({ page }) => {
  let requested;
  await defaultApi(page, {
    'analytics.spend': (route, url) => {
      requested = JSON.parse(url.searchParams.get('input'));
      return reply(route, {
        ...requested,
        totalInflow: '0.3',
        totalOutflow: '0.1',
        net: '0.2',
        movements: 2,
        outflowByCategory: { transfer: '0.1' },
      });
    },
  });
  await mount(page, '/bank/analytics');
  await page.getByLabel('Asset', { exact: true }).fill('BTC');
  await page.getByLabel('From', { exact: true }).fill('2026-10-01T00:00');
  await page.getByLabel('To', { exact: true }).fill('2026-10-07T00:00');
  await page.getByRole('button', { name: 'Read movements' }).click();
  await expect(page.locator('.money-movement-stats')).toContainText('0.2 BTC');
  await expect(page.getByText('These figures are not gains', { exact: false })).toBeVisible();
  expect(requested.assetId).toBe('BTC');
  expect(requested.from).toMatch(/2026-10-01T00:00:00/);
  expect(requested.to).toMatch(/2026-10-07T00:00:00/);
});

test('Bank membership never enables company writes or duplicates personal money as company balance', async ({ page }) => {
  let writes = 0;
  await page.route('**/api/**', (route) => {
    if (route.request().method() === 'POST') writes++;
    return reply(route, [
      { id: toId, name: 'Membership record', assetId: 'BTC', spendThreshold: '1', status: 'active', createdAt: '2026-10-07T12:00:00Z' },
    ]);
  });
  await mount(page, '/bank/business');
  await expect(page.getByText('Company balance and write authority are unavailable')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Read pending approvals' })).toBeVisible();
  await expect(page.getByRole('button', { name: /payroll|approve|create company|propose/i })).toHaveCount(0);
  expect(writes).toBe(0);
});

test('honest absence fits desktop, tablet, phone and narrow phone and has no serious accessibility issues', async ({ page }) => {
  await defaultApi(page);
  await mount(page, '/bank');
  await expect(page.getByText('No account balances yet')).toBeVisible();
  for (const width of [1440, 1024, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  const scan = await new AxeBuilder({ page }).analyze();
  expect(scan.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact))).toEqual([]);
  await page.screenshot({ path: '/tmp/intafaced-money-bank-absence-320.png', fullPage: true });
});

test('a confirmed transfer outcome retains its exact asset units', async ({ page }) => {
  await defaultApi(page, {
    'spaces.list': (route) => reply(route, [primary]),
    'transfers.create': (route) => reply(route, { ledgerTxId: 'confirmed-original-transfer', amount: '0.000000000000000001' }),
  });
  await mount(page, `/bank/transfers?from=${fromId}`);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Destination space ID').fill(toId);
  await page.getByLabel('Amount (BTC)').fill('0.000000000000000001');
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Confirmed by the service');
  await expect(page.getByRole('dialog')).toContainText('0.000000000000000001 BTC');
});

test('Holding detail labels fallback availability without inventing a total or held quantity', async ({ page }) => {
  await defaultApi(page, {
    balance: (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }),
    'spaces.list': (route) => reply(route, [primary]),
  });
  await mount(page, '/portfolio/BTC');
  await expect(page.getByText('Available projection only', { exact: true })).toBeVisible();
  await expect(page.locator('.money-holding-quantity')).toHaveText('0.200000000000000001 BTC');
  await expect(page.locator('.money-holding-restrictions .numeric')).toHaveText(['0.200000000000000001 BTC', 'Unavailable']);
  await expect(page.getByRole('heading', { name: 'Can’t connect right now' })).toBeVisible();
});

test('An absent holding is not zero and retains its asset-specific task destinations', async ({ page }) => {
  await defaultApi(page);
  await mount(page, '/portfolio/BTC');
  await expect(page.getByText('You hold none of this asset', { exact: true })).toBeVisible();
  await expect(page.locator('.money-holding-quantity')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Send available BTC/ })).toHaveAttribute('href', '/pay/send?asset=BTC');
  await expect(page.locator('a[href="/pay/send"]')).toHaveCount(0);
});
