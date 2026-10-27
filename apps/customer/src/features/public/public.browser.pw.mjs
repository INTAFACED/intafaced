import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

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
  await page.route('**/api/**', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Unavailable' }),
    }),
  );
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

test('French registration submits canonical identity fields and preserves an invitation', async ({ page }) => {
  await setup(page, 'fr');
  const invitation = '33333333-3333-4333-8333-333333333333';
  let submitted;
  await page.route('**/api/identity/trpc/auth.register', (route) => {
    submitted = route.request().postDataJSON();
    return reply(route, session);
  });
  await page.goto(`/register?invite=${invitation}`);
  await page.getByLabel('Nom d’utilisateur', { exact: true }).fill('locale_user');
  await page.getByLabel('Adresse e-mail', { exact: true }).fill('locale@example.invalid');
  await page.getByLabel('Mot de passe', { exact: true }).fill('test-password-123');
  await page.getByLabel('Code pays (facultatif)', { exact: true }).fill('fr');
  await page.getByRole('button', { name: 'Créer un compte', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/invite\\?token=${invitation}$`));
  await expect(page.getByRole('button', { name: 'Accepter l’invitation' })).toBeVisible();
  expect(submitted).toEqual({ handle: 'locale_user', email: 'locale@example.invalid', password: 'test-password-123', region: 'FR' });
});

test('translated Trade doors and the room search preserve explicit Paper mode', async ({ page }) => {
  await setup(page, 'es');
  await page.goto('/exchange?simulated=true');
  await expect(
    page.getByRole('navigation', { name: 'Secciones del cliente', exact: true }).getByRole('link', { name: 'Operar', exact: true }),
  ).toHaveAttribute('href', '/exchange?simulated=true');
  await page.keyboard.press('Control+k');
  const search = page.getByRole('dialog', { name: 'Buscar en Intafaced' });
  await search.getByLabel('Busca una sección o acción').fill('spot trading terminal');
  await expect(search.getByRole('link', { name: /Operar/ })).toHaveAttribute('href', '/exchange?simulated=true');
});

test('changing View language updates keyboard search, while canonical English search and exclusions remain intact', async ({ page }) => {
  await setup(page, 'en');
  await page.goto('/login?redirect=%2Fview');
  await page.getByLabel('Email or handle', { exact: true }).fill('locale@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Language', { exact: true }).selectOption('es');
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await expect(page).toHaveTitle('Vista · Intafaced');
  await page.keyboard.press('Control+k');
  const spanishSearch = page.getByRole('dialog', { name: 'Buscar en Intafaced' });
  const spanishInput = spanishSearch.getByLabel('Busca una sección o acción');
  await expect(spanishInput).toBeFocused();
  await spanishInput.fill('transferencias');
  await expect(spanishSearch.locator('a[href="/bank/transfers"]')).toContainText('Transferencias');
  await spanishInput.fill('transfers');
  await expect(spanishSearch.locator('a[href="/bank/transfers"]')).toBeVisible();
  for (const query of ['merchant', 'operador', 'cadena']) {
    await spanishInput.fill(query);
    await expect(spanishSearch.getByRole('link')).toHaveCount(0);
  }
  await page.keyboard.press('Escape');
  const language = page.locator('select').filter({ has: page.locator('option[value="fr"]') });
  await language.selectOption('fr');
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(page).toHaveTitle('Affichage · Intafaced');
  await page.keyboard.press('Control+k');
  const frenchSearch = page.getByRole('dialog', { name: 'Rechercher dans Intafaced' });
  await frenchSearch.getByLabel('Trouver un espace ou une action').fill('sécurité');
  const security = frenchSearch.locator('a[href="/uc/safe"]');
  await expect(security).toContainText('Sécurité');
  await security.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/uc\/safe$/);
  await expect(frenchSearch).toHaveCount(0);
});

test('published help uses available translations and marks English article fallback without rewriting the search query', async ({
  page,
}) => {
  await setup(page, 'es');
  const requests = [];
  await page.route('**/api/support/trpc/searchKb?*', (route) => {
    requests.push(JSON.parse(new URL(route.request().url()).searchParams.get('input')));
    return reply(route, [
      { id: 'published-article', titleKey: 'auth.login.title', bodyKey: 'support.kb.account_access.body', published: true },
    ]);
  });
  await page.goto('/help');
  const article = page.getByTestId('help-articles').locator('article');
  await expect(article.getByRole('heading')).toHaveText('Iniciar sesión');
  await expect(article.getByRole('heading')).toHaveAttribute('lang', 'es');
  await expect(article.locator('p')).toHaveAttribute('lang', 'en');
  await page.getByLabel('Buscar ayuda', { exact: true }).fill('transferencias BTC');
  await page.getByRole('button', { name: 'Buscar', exact: true }).click();
  await expect.poll(() => requests.at(-1)).toEqual({ q: 'transferencias BTC', limit: 100 });
});

test('public translated routes fit desktop and narrow phone with honest absences and accessible forms', async ({ page }) => {
  await setup(page, 'fr');
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ['/', '/register', '/help', '/findPwd', '/about-us', '/app', '/partner', '/lab']) {
      await page.goto(path);
      await expect(page.getByRole('main')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${path} at ${width}px`).toBe(true);
    }
  }
  await page.goto('/register');
  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(scan.violations.filter((item) => ['serious', 'critical'].includes(item.impact))).toEqual([]);
  await page.screenshot({ path: '/tmp/intafaced-public-locale-register-fr-320.png', fullPage: true });
});
