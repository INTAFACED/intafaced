import { expect, test } from '@playwright/test';
const userId = '11111111-1111-4111-8111-111111111111';
const seatId = '22222222-2222-4222-8222-222222222222';
const reply = (route, data) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data } }) });
async function mount(page, path = '/uc/safe') {
  await page.goto('/');
  await page.evaluate(
    async ({ owner, path }) => {
      const React = (await import('/node_modules/.vite/deps/react.js')).default;
      const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
      const { SessionProvider, useSession } = await import('/src/features/session/session.tsx');
      const { AccountRoutes } = await import('/src/features/account/AccountRoutes.tsx');
      const host = document.createElement('main');
      document.body.replaceChildren(host);
      function Setup() {
        const session = useSession();
        React.useEffect(() => {
          session.commit({
            userId: owner,
            accessToken: 'identity-review-token',
            refreshToken: 'identity-review-refresh',
            expiresAt: '2027-10-07T12:00:00Z',
          });
        }, []);
        return session.userId ? React.createElement(AccountRoutes, { path }) : null;
      }
      createRoot(host).render(React.createElement(SessionProvider, null, React.createElement(Setup)));
    },
    { owner: userId, path },
  );
}
test('Security reads bounded own seats and revokes only the reviewed named seat with real contracts', async ({ page }) => {
  const reads = [],
    writes = [];
  let active = true;
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const procedure = url.pathname.split('/').at(-1);
    if (procedure === 'listSessions') {
      reads.push(JSON.parse(url.searchParams.get('input')));
      return reply(route, { userId, sessions: active ? [{ id: seatId, createdAt: '2026-10-08T00:00:00Z', revoked: false }] : [] });
    }
    if (procedure === 'revokeSession') {
      writes.push(route.request().postDataJSON());
      active = false;
      return reply(route, { userId, sessionId: seatId, revoked: true });
    }
    return reply(route, []);
  });
  await mount(page);
  await expect(page.getByRole('region', { name: 'Where you’re signed in' })).toContainText(seatId);
  expect(reads[0]).toEqual({ userId, limit: 50 });
  await page.getByRole('button', { name: `Sign out session ${seatId}` }).click();
  expect(writes).toEqual([]);
  const dialog = page.getByRole('dialog', { name: 'Sign out this session?' });
  await expect(dialog).toContainText(seatId);
  await dialog.getByRole('button', { name: 'Sign out this session' }).click();
  await expect(page.getByText('The service revoked the selected session.')).toBeVisible();
  await expect(page.getByText('No active sessions')).toBeVisible();
  expect(writes).toEqual([{ userId, sessionId: seatId }]);
  expect(reads.length).toBeGreaterThan(1);
});

test('View renders written French and Spanish controls while preserving device enums and English valuation fallback', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('intafaced.customer.view.v1', JSON.stringify({ language: 'fr' })));
  await page.route('**/api/**', (route) => reply(route, []));
  await mount(page, '/view');
  await expect(page.getByRole('heading', { name: 'Affichage', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('combobox', { name: 'Thème', exact: true }).selectOption('system');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const fallback = page.getByText('A converted total requires a complete valuation source. Asset quantities retain their own units.');
  await expect(fallback).toHaveAttribute('lang', 'en');
  await page.getByRole('combobox', { name: 'Graphique sur téléphone' }).selectOption('bottom');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('intafaced.customer.view.v1')).phoneChart)).toBe('bottom');
  await page.getByRole('combobox', { name: 'Langue', exact: true }).selectOption('es');
  await expect(page.getByRole('heading', { name: 'Vista', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await expect(page.getByRole('button', { name: 'Restaurar valores predeterminados' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Gráfico en el teléfono' })).toHaveValue('bottom');
  await expect(fallback).toHaveAttribute('lang', 'en');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test('French identity revoke keeps original account and seat payload values', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('intafaced.customer.view.v1', JSON.stringify({ language: 'fr' })));
  let write;
  await page.route('**/api/**', (route) => {
    const procedure = new URL(route.request().url()).pathname.split('/').at(-1);
    if (procedure === 'listSessions')
      return reply(route, { userId, sessions: [{ id: seatId, createdAt: '2026-10-08T00:00:00Z', revoked: false }] });
    if (procedure === 'revokeSession') {
      write = route.request().postDataJSON();
      return reply(route, { userId, sessionId: seatId, revoked: false });
    }
    return reply(route, []);
  });
  await mount(page);
  await page.getByRole('button', { name: `Révoquer la session ${seatId}` }).click();
  await page.getByRole('button', { name: 'Révoquer cette session' }).click();
  await expect(page.getByText('Le service n’a pas révoqué de session active.', { exact: false })).toBeVisible();
  expect(write).toEqual({ userId, sessionId: seatId });
  await expect(page.getByText('Le service a révoqué la session sélectionnée.')).toHaveCount(0);
});

test('actual App keeps explicit Paper context through Execution and every Quant toolbar handoff', async ({ page }) => {
  let writes = 0;
  await page.route('**/api/**', (route) => {
    if (route.request().method() === 'POST') writes++;
    return reply(route, []);
  });
  await page.goto('/execution?simulated=true');
  await page.evaluate(async (owner) => {
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const { SessionProvider, useSession } = await import('/src/features/session/session.tsx');
    const { App } = await import('/src/app/App.tsx');
    const host = document.createElement('main');
    document.body.replaceChildren(host);
    function Setup() {
      const session = useSession();
      React.useEffect(() => {
        session.commit({
          userId: owner,
          accessToken: 'paper-review-token',
          refreshToken: 'paper-review-refresh',
          expiresAt: '2027-10-07T12:00:00Z',
        });
      }, []);
      return React.createElement(App);
    }
    createRoot(host).render(React.createElement(SessionProvider, null, React.createElement(Setup)));
  }, userId);
  await page.getByRole('link', { name: 'Open Quant studio' }).click();
  await expect(page).toHaveURL(/\/quant\/studio\?simulated=true$/);
  await page.getByTestId('more-toolbar').getByRole('link', { name: 'Sandbox', exact: true }).click();
  await expect(page).toHaveURL(/\/quant\?simulated=true$/);
  await page.getByTestId('more-toolbar').getByRole('link', { name: 'Backtest', exact: true }).click();
  await expect(page).toHaveURL(/\/quant\/backtest\?simulated=true$/);
  await page.getByTestId('more-toolbar').getByRole('link', { name: 'Studio', exact: true }).click();
  await page.getByTestId('more-toolbar').getByRole('link', { name: 'Execution', exact: true }).click();
  await expect(page).toHaveURL(/\/execution\?simulated=true$/);
  await expect(page.getByRole('checkbox', { name: /Simulated/ })).toBeChecked();
  expect(writes).toBe(0);
});

test('Security refuses foreign session source data instead of presenting it as an owned device', async ({ page }) => {
  await page.route('**/api/**', (route) => {
    const procedure = new URL(route.request().url()).pathname.split('/').at(-1);
    return reply(
      route,
      procedure === 'listSessions'
        ? { userId: '33333333-3333-4333-8333-333333333333', sessions: [{ id: seatId, createdAt: '2026-10-08T00:00:00Z', revoked: false }] }
        : [],
    );
  });
  await mount(page);
  await expect(page.getByRole('heading', { name: 'Information could not be verified' })).toBeVisible();
  await expect(page.getByRole('button', { name: `Sign out session ${seatId}` })).toHaveCount(0);
});

test('owned keyed copy fits actual Shell composites with honest service absence on desktop and phone', async ({ page }) => {
  await page.route('**/api/**', (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Unavailable' } }) }),
  );
  await page.goto('/bank');
  await page.evaluate(async (owner) => {
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const { SessionProvider, useSession } = await import('/src/features/session/session.tsx');
    const { App } = await import('/src/app/App.tsx');
    const host = document.createElement('main');
    document.body.replaceChildren(host);
    function Setup() {
      const context = useSession();
      React.useEffect(() => {
        context.commit({
          userId: owner,
          accessToken: 'absence-review-token',
          refreshToken: 'absence-review-refresh',
          expiresAt: '2027-10-07T12:00:00Z',
        });
      }, []);
      return React.createElement(App);
    }
    createRoot(host).render(React.createElement(SessionProvider, null, React.createElement(Setup)));
  }, userId);
  for (const path of ['/bank', '/uc/safe', '/more', '/quant/studio']) {
    await page.evaluate((path) => {
      history.pushState(null, '', path);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, path);
    if (path === '/bank') await expect(page.getByText('Holdings could not be loaded.')).toBeVisible();
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.waitForTimeout(100);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `/tmp/intafaced-owned-copy-${path.replaceAll('/', '-').slice(1)}-${width}.png`, fullPage: true });
    }
  }
});
