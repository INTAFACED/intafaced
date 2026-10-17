import { expect, test } from '@playwright/test';

const locales = [
  {
    language: 'en',
    help: 'Read public Help',
    missing: 'An invitation link is needed',
    boundary: 'Password reset is not connected. Public guidance cannot restore access; account support tickets require sign-in.',
  },
  {
    language: 'es',
    help: 'Leer la Ayuda pública',
    missing: 'Necesitas un enlace de invitación',
    boundary:
      'El restablecimiento de contraseña no está conectado. La orientación pública no puede recuperar el acceso; las solicitudes de soporte requieren iniciar sesión.',
  },
  {
    language: 'fr',
    help: 'Lire l’Aide publique',
    missing: 'Un lien d’invitation est nécessaire',
    boundary:
      'La réinitialisation du mot de passe n’est pas connectée. Les conseils publics ne rétablissent pas l’accès ; les demandes d’assistance du compte nécessitent une connexion.',
  },
];
const token = '33333333-3333-4333-8333-333333333333';
const account = '11111111-1111-4111-8111-111111111111';
const reply = (route, data) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data } }) });

async function localFixture(page, language) {
  const writes = [];
  await page.addInitScript((language) => localStorage.setItem('intafaced.customer.view.v1', JSON.stringify({ language })), language);
  await page.route('**/api/**', (route) => {
    const request = route.request();
    if (request.method() !== 'GET' && !request.url().includes('/auth.login')) writes.push(new URL(request.url()).pathname);
    if (request.url().includes('/getKb'))
      return reply(route, { id: 'TEST-access', titleKey: 'test.title', bodyKey: 'test.body', version: 1 });
    if (request.url().includes('/auth.login'))
      return reply(route, {
        userId: account,
        accessToken: 'TEST-availability-access',
        refreshToken: 'TEST-availability-refresh',
        expiresAt: '2027-10-16T00:00:00Z',
      });
    if (request.url().includes('/listSessions')) return reply(route, { userId: account, sessions: [] });
    if (request.url().includes('/webauthn.list')) return reply(route, []);
    return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'TEST unavailable' }) });
  });
  return writes;
}

for (const locale of locales) {
  test(`${locale.language}: recovery opens public guidance without a sign-in-only support detour`, async ({ page }) => {
    const writes = await localFixture(page, locale.language);
    await page.goto('/findPwd');
    const action = page.getByRole('main').getByRole('link', { name: new RegExp(locale.help) });
    await expect(action).toHaveAttribute('href', '/help');
    await expect(page.getByRole('main').locator('a[href="/support"]')).toHaveCount(0);
    await action.click();
    await expect(page).toHaveURL(/\/help$/);
    await page.goto('/helpdetail?id=TEST-access&version=1');
    await expect(page.getByText(locale.boundary, { exact: true })).toBeVisible();
    expect(writes).toEqual([]);
  });
  test(`${locale.language}: missing invitation explains the required link and never offers hidden tools`, async ({ page }) => {
    const writes = await localFixture(page, locale.language);
    await page.goto('/invite');
    await expect(page.getByRole('heading', { name: locale.missing, exact: true })).toBeVisible();
    await expect(page.locator('a[href="/uc/promotion"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /accept|aceptar|accepter/i })).toHaveCount(0);
    expect(writes).toEqual([]);
  });
}

test('invalid and valid invitation links retain their distinct safe paths', async ({ page }) => {
  const writes = await localFixture(page, 'en');
  await page.goto('/invite?token=not-a-valid-token');
  await expect(page.getByRole('heading', { name: 'This invitation address is invalid' })).toBeVisible();
  await expect(page.locator('a[href="/uc/promotion"]')).toHaveCount(0);
  await page.goto(`/invite?token=${token}`);
  await expect(page.getByRole('main').locator(`a[href="/login?invite=${token}"]`)).toBeVisible();
  await expect(page.getByRole('main').locator(`a[href="/register?invite=${token}"]`)).toBeVisible();
  expect(writes).toEqual([]);
});

test('security explicitly leaves authenticator status unknown before setup', async ({ page }) => {
  const writes = await localFixture(page, 'en');
  await page.goto('/login?redirect=%2Fuc%2Fsafe');
  await page.getByLabel('Email or handle', { exact: true }).fill('TEST-account@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('TEST-password-not-a-credential');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/uc\/safe$/);
  await expect(
    page.getByText('Status is not available here. The service checks your account when you start setup.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start authenticator setup', exact: true })).toBeVisible();
  expect(writes).toEqual([]);
});

test('signed-in missing, invalid and valid invitations never offer hidden account tools', async ({ page }) => {
  const writes = await localFixture(page, 'en');
  // safeReturnTo refuses a public return path, so sign in through a private page first.
  await page.goto('/login?redirect=%2Fuc%2Fsafe');
  await page.getByLabel('Email or handle', { exact: true }).fill('TEST-account@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('TEST-password-not-a-credential');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/uc\/safe$/);
  for (const route of ['/invite', '/invite?token=not-a-valid-token', `/invite?token=${token}`]) {
    await page.evaluate((route) => {
      history.pushState(null, '', route);
      dispatchEvent(new PopStateEvent('popstate'));
    }, route);
    await expect(page.getByRole('heading', { name: 'Current relationship', exact: true })).toBeVisible();
    await expect(page.locator('a[href="/uc/promotion"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Read current status', exact: true })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'Review invitation', exact: true })).toBeVisible();
  expect(writes).toEqual([]);
});
