import { test, expect } from '@playwright/test';

for (const identifier of ['', '   ']) {
  test(`passkey ${identifier ? 'whitespace' : 'blank'} identifier gives actionable feedback without starting authentication`, async ({
    page,
  }) => {
    const requests = [];
    page.on('request', (request) => {
      if (/\/(webauthn\.authOptions|webauthn\.authVerify|auth\.login)$/.test(new URL(request.url()).pathname)) requests.push(request.url());
    });
    await page.goto('/login');
    const email = page.getByRole('textbox', { name: 'Email or handle', exact: true });
    await email.fill(identifier);
    await page.getByRole('button', { name: 'Use a passkey', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Enter your email or handle before using a passkey.' })).toBeVisible();
    await expect(email).toBeFocused();
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
    expect(requests).toEqual([]);
  });
}

test('passkey filled identifier reaches preparation with no password and can recover after blank input', async ({ page }) => {
  const writes = [];
  await page.route('**/api/**', (route) => {
    const request = route.request();
    if (request.method() !== 'GET') writes.push({ path: new URL(request.url()).pathname, input: request.postDataJSON() });
    return route.fulfill({
      status: 503,
      json: { error: { message: 'Isolated unavailable response', data: { cause: { code: 'isolated.unavailable' } } } },
    });
  });
  await page.goto('/login');
  await page.getByRole('button', { name: 'Use a passkey', exact: true }).click();
  await page.getByRole('textbox', { name: 'Email or handle', exact: true }).fill('  passkey-click@example.invalid  ');
  await page.getByRole('button', { name: 'Use a passkey', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes).toEqual([{ path: '/api/identity/trpc/webauthn.authOptions', input: { identifier: 'passkey-click@example.invalid' } }]);
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Use a passkey', exact: true })).toBeEnabled();
});
