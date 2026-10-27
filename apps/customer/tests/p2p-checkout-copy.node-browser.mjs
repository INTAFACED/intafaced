// Isolated UI regression check. Run against this worktree's Vite dev server.
// Every API request is fulfilled locally; no account or payment is created.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const baseURL = process.env.P2P_COPY_BASE_URL;
const evidence = process.env.P2P_COPY_EVIDENCE;
assert(baseURL && evidence && isAbsolute(evidence), 'Supply loopback base URL and absolute evidence directory');
const origin = new URL(baseURL);
assert(['localhost', '127.0.0.1'].includes(origin.hostname) && origin.protocol === 'http:');
mkdirSync(evidence, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.P2P_COPY_BROWSER ? { executablePath: process.env.P2P_COPY_BROWSER } : {}),
});
const results = [];
const errors = [];
const mutations = [];
const rpcError = (status, code, message) => ({ status, json: { error: { message, data: { code, httpStatus: status } } } });
const cases = [
  ['link-domain', 'token', rpcError(404, 'pay.link_not_found', 'TEST missing link'), 'Payment link not found'],
  ['link-prefix', 'token', rpcError(404, 'NOT_FOUND', 'pay.link_not_found: TEST missing link'), 'Payment link not found'],
  ['session-domain', 'session', rpcError(404, 'pay.checkout_session_not_found', 'TEST missing session'), 'Payment session not found'],
  [
    'session-prefix',
    'session',
    rpcError(404, 'NOT_FOUND', 'pay.checkout_session_not_found: TEST missing session'),
    'Payment session not found',
  ],
  ['route-missing', 'token', rpcError(404, 'NOT_FOUND', 'TEST route missing'), 'This service is not connected'],
  ['wrong-domain', 'token', rpcError(404, 'pay.checkout_session_not_found', 'TEST wrong domain'), 'This service is not connected'],
  ['signed-out', 'token', rpcError(401, 'UNAUTHORIZED', 'TEST sign in required'), 'Sign in to continue'],
  ['denied', 'token', rpcError(403, 'FORBIDDEN', 'TEST denied'), 'Access is restricted'],
  ['offline', 'token', rpcError(503, 'UNAVAILABLE', 'TEST unavailable'), 'Can’t connect right now'],
  ['misleading-prefix', 'token', rpcError(503, 'NOT_FOUND', 'pay.link_not_found: TEST unavailable'), 'Can’t connect right now'],
];
try {
  for (const width of [1440, 390]) {
    for (const [name, query, failure, title] of cases) {
      const context = await browser.newContext({ viewport: { width, height: width === 1440 ? 900 : 844 } });
      const page = await context.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      let reads = 0;
      await context.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname.startsWith('/api/')) {
          if (request.method() !== 'GET') mutations.push({ name, path: url.pathname, method: request.method() });
          reads++;
          return route.fulfill(failure);
        }
        return url.origin === origin.origin ? route.continue() : route.abort();
      });
      await page.goto(new URL('/pay/checkout?' + query + '=TEST-invalid-lookup', baseURL).href);
      await page.getByRole('heading', { name: title, exact: true }).waitFor();
      if (name.startsWith('session-'))
        assert((await page.locator('main').innerText()).includes('This does not confirm whether a payment completed.'));
      if (name.endsWith('domain') || (name.endsWith('prefix') && !name.startsWith('misleading'))) {
        const details = page.locator('details');
        if (await details.count()) {
          assert.equal(await details.getAttribute('open'), null);
          await details.locator('summary').focus();
          await page.keyboard.press('Enter');
          assert.equal(await details.getAttribute('open'), '');
          assert((await details.innerText()).includes(failure.json.error.message));
          const before = reads;
          await page.getByRole('button', { name: 'Try again', exact: true }).click();
          await page.waitForFunction(() => !document.querySelector('[data-testid="loading"]'));
          await page.getByRole('heading', { name: title, exact: true }).waitFor();
          assert(reads > before, 'Retry must repeat a GET');
        }
      }
      const extent = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
      assert(extent.document <= extent.viewport, JSON.stringify(extent));
      if (name === 'link-prefix' || name === 'session-prefix') await page.screenshot({ path: join(evidence, `${name}-${width}.png`) });
      results.push({ name, width, title, reads, extent });
      await context.close();
    }
  }
  for (const [language, title] of [
    ['es', 'Enlace de pago no encontrado'],
    ['fr', 'Lien de paiement introuvable'],
  ]) {
    const context = await browser.newContext();
    await context.addInitScript((language) => localStorage.setItem('intafaced.customer.view.v1', JSON.stringify({ language })), language);
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await context.route('**/*', (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.pathname.startsWith('/api/')) {
        if (request.method() !== 'GET') mutations.push({ language, path: url.pathname, method: request.method() });
        return route.fulfill(rpcError(404, 'NOT_FOUND', 'pay.link_not_found: TEST missing link'));
      }
      return url.origin === origin.origin ? route.continue() : route.abort();
    });
    await page.goto(new URL('/pay/checkout?token=TEST-invalid-lookup', baseURL).href);
    await page.getByRole('heading', { name: title, exact: true }).waitFor();
    results.push({ language, title });
    await context.close();
  }
  // These routes remain hidden in customer builds; a private Vite dev build
  // exposes them. Authentication here is only an intercepted TEST fixture.
  for (const [language, route, title] of [
    ['en', '/uc/ad/update', 'Edit an offer'],
    ['es', '/uc/ad/update', 'Editar una oferta'],
    ['fr', '/uc/ad/update', 'Modifier une offre'],
    ['en', '/uc/ad/create', 'Create an offer'],
  ]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addInitScript((language) => localStorage.setItem('intafaced.customer.view.v1', JSON.stringify({ language })), language);
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await context.route('**/*', (intercept) => {
      const request = intercept.request(),
        url = new URL(request.url());
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname.endsWith('/auth.login'))
          return intercept.fulfill({
            status: 200,
            json: {
              result: {
                data: {
                  userId: '11111111-1111-4111-8111-111111111111',
                  accessToken: 'TEST-isolated-access',
                  refreshToken: 'TEST-isolated-refresh',
                  expiresAt: '2027-10-16T00:00:00Z',
                },
              },
            },
          });
        if (request.method() !== 'GET') mutations.push({ route, path: url.pathname, method: request.method() });
        return intercept.fulfill(rpcError(503, 'UNAVAILABLE', 'TEST isolated dependency unavailable'));
      }
      return url.origin === origin.origin ? intercept.continue() : intercept.abort();
    });
    await page.goto(new URL('/login?redirect=' + encodeURIComponent(route), baseURL).href);
    await page.locator('input[autocomplete="username"]').fill('TEST-local@example.invalid');
    await page.locator('input[autocomplete="current-password"]').fill('TEST-isolated-password');
    await page.locator('form button[type="submit"]').click();
    await page.getByRole('heading', { name: title, exact: true, level: 1 }).waitFor();
    await page.screenshot({ path: join(evidence, `offer-${language}-${route.endsWith('update') ? 'edit' : 'create'}.png`) });
    results.push({ language, route, title });
    await context.close();
  }
  assert.deepEqual(mutations, [], 'No payment or P2P mutation may be submitted');
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  writeFileSync(join(evidence, 'results.json'), JSON.stringify({ at: new Date().toISOString(), results, errors, mutations }, null, 2));
}
console.log(`VERIFIED: ${results.length} isolated browser cases; no payment/P2P mutations or page errors.`);
