import { expect, test } from '@playwright/test';
const userId = '11111111-1111-4111-8111-111111111111';
const seatId = '22222222-2222-4222-8222-222222222222';
const reply = (route, data) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data } }) });
async function mount(page) {
  await page.goto('/');
  await page.evaluate(async (owner) => {
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const { SessionProvider, useSession } = await import('/src/features/session/session.tsx');
    const { AccountRoutes } = await import('/src/features/account/AccountRoutes.tsx');
    const host = document.createElement('main'); document.body.replaceChildren(host);
    function Setup() {
      const session = useSession();
      React.useEffect(() => { session.commit({ userId: owner, accessToken: 'identity-review-token', refreshToken: 'identity-review-refresh', expiresAt: '2027-10-07T12:00:00Z' }); }, []);
      return session.userId ? React.createElement(AccountRoutes, { path: '/uc/safe' }) : null;
    }
    createRoot(host).render(React.createElement(SessionProvider, null, React.createElement(Setup)));
  }, userId);
}
test('Security reads bounded own seats and revokes only the reviewed named seat with real contracts', async ({ page }) => {
  const reads = [], writes = [];
  let active = true;
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()); const procedure = url.pathname.split('/').at(-1);
    if (procedure === 'listSessions') {
      reads.push(JSON.parse(url.searchParams.get('input')));
      return reply(route, { userId, sessions: active ? [{ id: seatId, createdAt: '2026-10-08T00:00:00Z', revoked: false }] : [] });
    }
    if (procedure === 'revokeSession') {
      writes.push(route.request().postDataJSON()); active = false;
      return reply(route, { userId, sessionId: seatId, revoked: true });
    }
    return reply(route, []);
  });
  await mount(page);
  await expect(page.getByRole('region', { name: 'Signed-in identity sessions' })).toContainText(seatId);
  expect(reads[0]).toEqual({ userId, limit: 50 });
  await page.getByRole('button', { name: `Revoke session ${seatId}` }).click();
  expect(writes).toEqual([]);
  const dialog = page.getByRole('dialog', { name: 'Revoke session' });
  await expect(dialog).toContainText(seatId);
  await dialog.getByRole('button', { name: 'Revoke this session' }).click();
  await expect(page.getByText('The service revoked the selected session.')).toBeVisible();
  await expect(page.getByText('No live sessions returned')).toBeVisible();
  expect(writes).toEqual([{ userId, sessionId: seatId }]);
  expect(reads.length).toBeGreaterThan(1);
});

test('Security refuses foreign session source data instead of presenting it as an owned device', async ({ page }) => {
  await page.route('**/api/**', (route) => {
    const procedure = new URL(route.request().url()).pathname.split('/').at(-1);
    return reply(route, procedure === 'listSessions' ? { userId: '33333333-3333-4333-8333-333333333333', sessions: [{ id: seatId, createdAt: '2026-10-08T00:00:00Z', revoked: false }] } : []);
  });
  await mount(page);
  await expect(page.getByText(/Session ownership does not match this account/)).toBeVisible();
  await expect(page.getByRole('button', { name: `Revoke session ${seatId}` })).toHaveCount(0);
});
