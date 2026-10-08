import { expect, test } from '@playwright/test';

const session = {
  userId: '11111111-1111-4111-8111-111111111111',
  accessToken: 'public-locale-test',
  refreshToken: 'public-locale-refresh-test',
  expiresAt: '2027-10-08T00:00:00Z',
};
const reply = (route, data) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data } }) });
async function setup(page, language) {
  await page.addInitScript((language) => {
    localStorage.setItem('intafaced.customer.view.v1', JSON.stringify({ language }));
  }, language);
  await page.route('**/api/**', (route) => route.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Unavailable' }),
  }));
  await page.route('**/api/identity/trpc/auth.login', (route) => reply(route, session));
  await page.route('**/api/v1/markets*', (route) => {
    expect(new URL(route.request().url()).searchParams.get('limit')).toBe('500');
    return route.fulfill({ contentType: 'application/json', body: '[]' });
  });
}

test('Spanish public sign-in keeps canonical request fields and requested destination', async ({ page }) => {
  await setup(page, 'es');
  let submitted;
  await page.route('**/api/identity/trpc/auth.login', (route) => {
    submitted = route.request().postDataJSON();
    return reply(route, session);
  });
  await page.goto('/login?redirect=%2Fbank%2Ftransfers');
  await expect(page.getByRole('heading', { name: 'Inicia sesión en tu cuenta' })).toBeVisible();
  await page.getByLabel('Correo o usuario', { exact: true }).fill('locale@example.invalid');
  await page.getByLabel('Contraseña', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await expect(page).toHaveURL(/\/bank\/transfers$/);
  expect(submitted).toEqual({ identifier: 'locale@example.invalid', password: 'test-password' });
  await expect(page.getByRole('navigation', { name: 'Secciones del cliente', exact: true })).toContainText('Dinero');
});
