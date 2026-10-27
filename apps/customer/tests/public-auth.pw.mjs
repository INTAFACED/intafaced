import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const service = await import(pathToFileURL(process.env.PUBLIC_AUTH_SERVICE_FIXTURE).href);
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
const evidence = process.env.PUBLIC_AUTH_EVIDENCE,
  key = 'intafaced.customer.public-auth.v1';
mkdirSync(evidence, { recursive: true });
const errors = new WeakMap(),
  summary = [];
test.beforeEach(async ({ context }) => {
  const list = [];
  errors.set(context, list);
  const observe = (page) => page.on('pageerror', (error) => list.push(error.message));
  context.pages().forEach(observe);
  context.on('page', observe);
});
test.afterEach(async ({ context }, info) => {
  expect(errors.get(context)).toEqual([]);
  if (info.status !== info.expectedStatus) {
    const page = context.pages()[0];
    if (page && !page.isClosed()) await shot(page, 'failed-' + info.title.replace(/[^a-z0-9]+/gi, '-').slice(0, 90));
  }
  summary.push({ name: info.title, status: info.status, pageErrors: errors.get(context) });
});
test.afterAll(() => {
  const path = evidence + '/native-summary.json';
  const previous = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
  writeFileSync(path, JSON.stringify([...previous, ...summary], null, 2));
});
/** Runs a fixture auth call the way the cookie would: refresh/logout take the token from the fake cookie, not the body. */
async function refreshCall(state, procedure, input) {
  if (procedure === 'auth.refresh' && !input?.refreshToken) {
    if (!state.cookie.token)
      return { status: 401, body: { error: { message: 'Session not found', data: { intafacedCode: 'auth.session_invalid' } } } };
    input = { refreshToken: state.cookie.token };
  }
  const result = await state.instance.call(procedure, input);
  const data = result.status === 200 ? result.body?.result?.data : undefined;
  if (data?.refreshToken) state.cookie.token = data.refreshToken;
  if (procedure === 'auth.logout') state.cookie.token = null;
  if (data?.refreshToken) data.refreshToken = undefined;
  return result;
}
async function network(context, options = {}) {
  const instance = await service.makeService(options),
    tokens = new Map();
  // Models the HttpOnly `ifc_rt` cookie: login/register/passkey sets it from the reply, logout clears it, refresh reads it.
  // The page never sends a refresh token, so a bare refresh with no cookie is `auth.session_invalid`.
  const cookie = { token: null };
  const state = { instance, cookie, writes: [], privateReads: 0, ...options };
  await context.route('**/api/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      procedure = decodeURIComponent(url.pathname.split('/').at(-1));
    const input = req.method() === 'GET' ? JSON.parse(url.searchParams.get('input') || 'null') : req.postDataJSON();
    if (req.method() !== 'GET') state.writes.push(procedure);
    if (req.method() === 'GET' && req.headers().authorization) state.privateReads++;
    const reply = (data) => route.fulfill({ status: 200, json: { result: { data } } });
    if (state[procedure]) return state[procedure](route, input, reply);
    if (['auth.login', 'auth.register', 'auth.refresh', 'auth.logout', 'webauthn.authOptions', 'webauthn.authVerify'].includes(procedure)) {
      const result = await refreshCall(state, procedure, input);
      if (result.status === 200 && result.body.result.data?.accessToken)
        tokens.set(result.body.result.data.accessToken, result.body.result.data.userId);
      return route.fulfill({ status: result.status, json: result.body });
    }
    if (procedure === 'kb.search') return reply([]);
    return route.fulfill({ status: 503, json: { error: { message: 'Isolated unavailable' } } });
  });
  return state;
}
const count = (state, procedure) => state.writes.filter((p) => p === procedure).length;
async function fields(page, register = false, details = {}) {
  if (register) await page.getByRole('textbox', { name: 'Handle', exact: true }).fill(details.handle || 'fresh_auth');
  await page
    .getByRole('textbox', { name: register ? 'Email' : 'Email or handle', exact: true })
    .fill(details.identifier || (register ? 'fresh-auth@example.invalid' : 'isolated-auth@example.invalid'));
  await page
    .locator('input[autocomplete="' + (register ? 'new-password' : 'current-password') + '"]')
    .fill(details.password || 'isolated-test-password');
}
const submit = (page) => page.locator('form:has(input[name="identifier"]) button[type="submit"]');
const unknown = (page) => page.getByRole('region', { name: 'Sign-in not confirmed', exact: true });
const registerUnknown = (page) => page.getByRole('region', { name: 'Account creation not confirmed', exact: true });
const optionsUnknown = (page) => page.getByRole('region', { name: 'Passkey preparation not confirmed', exact: true });
async function journal(page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) || 'null'), key);
}
async function shot(page, name) {
  await page.screenshot({
    path: evidence + '/' + name + '.png',
    fullPage: true,
    mask: [page.locator('input, textarea, [data-public-auth-sensitive]')],
  });
}
async function helpBack(page) {
  await page.locator('.public-header').getByRole('link', { name: 'Help', exact: true }).click();
  await expect(page).toHaveURL(new URL('/help', test.info().project.use.baseURL).href);
  await page.goBack();
}
function hold() {
  let resolve;
  return { promise: new Promise((r) => (resolve = r)), release: () => resolve() };
}
const failure = (route, status = 503, code = 'isolated.unknown') =>
  route.fulfill({ status, json: { error: { message: 'Isolated response not confirmed', data: { cause: { code } } } } });
async function login(page, path = '/money') {
  await page.goto('/login?redirect=' + encodeURIComponent(path));
  await fields(page);
  await submit(page).click();
  await expect(page).toHaveURL(new URL(path, test.info().project.use.baseURL).href);
}
// The only history adapter seeds a same-document URL entry; Back and App rendering remain native.
async function historyEntry(page, url) {
  await page.evaluate((url) => {
    history.pushState(null, '', url);
    dispatchEvent(new PopStateEvent('popstate'));
  }, url);
}
async function nativeKey(context, page, state) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  const options = await state.instance.auth.startWebauthnRegistration(service.owner);
  const payload = await page.evaluate(async (options) => {
    const decode = (value) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (x) => x.charCodeAt(0));
    const encode = (buffer) =>
      btoa(String.fromCharCode(...new Uint8Array(buffer)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
    const c = await navigator.credentials.create({
      publicKey: { ...options, challenge: decode(options.challenge), user: { ...options.user, id: decode(options.user.id) } },
    });
    return {
      id: c.id,
      rawId: encode(c.rawId),
      type: 'public-key',
      response: {
        clientDataJSON: encode(c.response.clientDataJSON),
        attestationObject: encode(c.response.attestationObject),
        transports: c.response.getTransports(),
      },
      clientExtensionResults: c.getClientExtensionResults(),
    };
  }, options);
  await state.instance.auth.confirmWebauthnRegistration(service.owner, payload);
  return cdp;
}

for (const identifier of ['', '   ']) {
  test(`passkey ${identifier ? 'whitespace' : 'blank'} identifier shows a field error without starting authentication`, async ({
    page,
    context,
  }) => {
    const state = await network(context);
    await page.goto('/login');
    const email = page.getByRole('textbox', { name: 'Email or handle', exact: true });
    await email.fill(identifier);
    await page.getByRole('button', { name: 'Use a passkey', exact: true }).click();
    await expect(email).toHaveAttribute('aria-invalid', 'true');
    await expect(email).toHaveAccessibleDescription('Enter your email or handle before using a passkey.');
    await expect(email).toBeFocused();
    await expect(page.locator('.failure')).toHaveCount(0);
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
    expect(state.writes).toEqual([]);
    expect(await journal(page)).toBeNull();
    await email.fill('passkey-click@example.invalid');
    await expect(email).toHaveAttribute('aria-invalid', 'false');
    await expect(page.getByText('Enter your email or handle before using a passkey.', { exact: true })).toHaveCount(0);
    expect(state.writes).toEqual([]);
  });
}
test('passkey captures autofill without an input event on the same click, with an empty password', async ({ page, context }) => {
  let captured;
  const state = await network(context, {
    'webauthn.authOptions': async (route, input) => {
      captured = input;
      return failure(route);
    },
  });
  await page.goto('/login');
  const email = page.getByRole('textbox', { name: 'Email or handle', exact: true });
  await page.getByRole('button', { name: 'Use a passkey', exact: true }).click();
  await email.evaluate((input) => {
    input.value = '  passkey-click@example.invalid  ';
  });
  await page.getByRole('button', { name: 'Use a passkey', exact: true }).click();
  await expect.poll(() => count(state, 'webauthn.authOptions')).toBe(1);
  expect(captured).toEqual({ identifier: 'passkey-click@example.invalid' });
  expect(state.writes).toEqual(['webauthn.authOptions']);
  await expect(email).toHaveAttribute('aria-invalid', 'false');
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Use a passkey', exact: true })).toBeEnabled();
});

test('actual password sign-in returns to the original supported room and persists no credentials', async ({ page, context }) => {
  const state = await network(context);
  await login(page, '/uc/safe');
  expect(count(state, 'auth.login')).toBe(1);
  expect(state.instance.counts.sessionWrites).toBe(1);
  expect(await journal(page)).toBeNull();
  expect(
    await page.evaluate(() =>
      Object.values(localStorage).every(
        (v) =>
          !v.includes('isolated-test-password') &&
          !v.includes('accessToken') &&
          !v.includes('refreshToken') &&
          !v.includes('isolated-auth@example.invalid'),
      ),
    ),
  ).toBe(true);
});
for (const form of ['withoutFraction', 'utcOffset', 'longFraction'])
  test('valid SessionSchema expiry ' + form + ' admits only the original sign-in destination', async ({ page, context }) => {
    const state = await network(context, {
      'auth.login': async (_route, input, reply) => {
        const result = await state.instance.call('auth.login', input);
        const session = result.body.result.data;
        if (form === 'withoutFraction') session.expiresAt = session.expiresAt.replace(/\.\d+Z$/, 'Z');
        if (form === 'utcOffset') session.expiresAt = session.expiresAt.replace('Z', '+00:00');
        if (form === 'longFraction') session.expiresAt = session.expiresAt.replace('Z', '456Z');
        return reply(session);
      },
    });
    await login(page, '/uc/safe');
    expect(count(state, 'auth.login')).toBe(1);
    expect(await journal(page)).toBeNull();
  });
for (const target of ['https://outside.invalid/', '//outside.invalid/', '/ops', '/chain', '/help', '/unknown'])
  test('unsafe or unsupported destination safely falls back to Money: ' + target, async ({ page, context }) => {
    await network(context);
    await page.goto('/login?redirect=' + encodeURIComponent(target));
    await fields(page);
    await submit(page).click();
    await expect(page).toHaveURL(new URL('/money', test.info().project.use.baseURL).href);
  });
test('legacy original return URL remains supported', async ({ page, context }) => {
  await network(context);
  await page.goto('/login/returnUrl/' + encodeURIComponent('/uc/safe'));
  await fields(page);
  await submit(page).click();
  await expect(page).toHaveURL(new URL('/uc/safe', test.info().project.use.baseURL).href);
});
test('actual registration creates one account/session and keeps invitation precedence', async ({ page, context }) => {
  const state = await network(context),
    invite = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  await page.goto('/register?invite=' + invite + '&redirect=%2Fuc%2Fsafe');
  await fields(page, true);
  await submit(page).click();
  await expect(page).toHaveURL(new URL('/invite?token=' + invite, test.info().project.use.baseURL).href);
  expect(state.instance.counts.accountWrites).toBe(1);
  expect(state.instance.counts.sessionWrites).toBe(1);
  expect(await journal(page)).toBeNull();
});
test('same-path native Back invalidates original destination before any old session commit', async ({ page, context }) => {
  const held = hold(),
    state = await network(context, {
      'auth.login': async (route, input) => {
        const result = await state.instance.call('auth.login', input);
        await held.promise;
        return route.fulfill({ status: result.status, json: result.body });
      },
    });
  await page.goto('/login?redirect=%2Fmoney');
  await historyEntry(page, '/login?redirect=%2Fuc%2Fsafe');
  await fields(page);
  await submit(page).click();
  await expect.poll(() => count(state, 'auth.login')).toBe(1);
  await page.goBack();
  await expect(page).toHaveURL(new URL('/login?redirect=%2Fmoney', test.info().project.use.baseURL).href);
  held.release();
  await expect(unknown(page)).toBeVisible();
  expect(state.privateReads).toBe(0);
  expect((await journal(page)).map((r) => r.target)).toEqual(['/uc/safe']);
  await expect(unknown(page).getByText('After sign-in · Security', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Email or handle', exact: true })).toHaveValue('');
});
test('held original login cannot replace a real SessionProvider-refreshed API', async ({ page, context }) => {
  const held = hold();
  let logins = 0,
    refreshes = 0;
  const state = await network(context, {
    'auth.login': async (route, input) => {
      const result = await refreshCall(state, 'auth.login', input);
      if (++logins === 1) result.body.result.data.expiresAt = new Date(Date.now() + 33000).toISOString();
      else await held.promise;
      return route.fulfill({ status: result.status, json: result.body });
    },
    'auth.refresh': async (route, input) => {
      // The boot refresh of a signed-out page (no cookie yet) is not the silent refresh this test counts.
      if (state.cookie.token) refreshes++;
      const result = await refreshCall(state, 'auth.refresh', input);
      return route.fulfill({ status: result.status, json: result.body });
    },
  });
  await login(page);
  await historyEntry(page, '/login');
  await fields(page);
  await submit(page).click();
  await expect.poll(() => logins).toBe(2);
  await expect.poll(() => refreshes).toBe(1);
  held.release();
  await expect(page).toHaveURL(new URL('/login', test.info().project.use.baseURL).href);
  await expect(unknown(page)).toBeVisible();
  expect(count(state, 'auth.login')).toBe(2);
});
test('held registration after native Help departure keeps original unknown on return', async ({ page, context }) => {
  const held = hold(),
    state = await network(context, {
      'auth.register': async (route, input) => {
        const result = await state.instance.call('auth.register', input);
        await held.promise;
        return route.fulfill({ status: result.status, json: result.body });
      },
    });
  await page.goto('/register');
  await fields(page, true);
  await submit(page).click();
  await expect.poll(() => count(state, 'auth.register')).toBe(1);
  await expect.poll(() => state.instance.counts.accountWrites).toBe(1);
  await helpBack(page);
  held.release();
  await expect(registerUnknown(page)).toBeVisible();
  expect(state.instance.counts.accountWrites).toBe(1);
  expect(state.privateReads).toBe(0);
  expect(count(state, 'auth.register')).toBe(1);
});
test('unknown registration survives Help/remount; fresh sign-in never certifies that registration', async ({ page, context }) => {
  const state = await network(context, { rankFail: true });
  await page.goto('/register');
  await fields(page, true);
  await submit(page).click();
  await expect(registerUnknown(page)).toBeVisible();
  expect(state.instance.counts.accountWrites).toBe(1);
  expect(state.instance.counts.sessionWrites).toBe(0);
  const saved = await journal(page);
  await expect(page.locator('input[autocomplete="new-password"]')).toHaveValue('');
  await helpBack(page);
  await expect(registerUnknown(page)).toBeVisible();
  await page.locator('.auth-form').getByRole('link', { name: 'Sign in', exact: true }).click();
  await fields(page, false, { identifier: 'fresh-auth@example.invalid' });
  await submit(page).click();
  await expect(page).toHaveURL(new URL('/money', test.info().project.use.baseURL).href);
  expect(await journal(page)).toEqual(saved);
  expect(count(state, 'auth.register')).toBe(1);
  expect(count(state, 'auth.login')).toBe(1);
});
test('new registration uniqueness refusal cannot clear an earlier unknown creation', async ({ page, context }) => {
  const state = await network(context, { busFail: true });
  await page.goto('/register');
  await fields(page, true);
  await submit(page).click();
  await expect(registerUnknown(page)).toBeVisible();
  const saved = await journal(page);
  await fields(page, true);
  await submit(page).click();
  await expect(page.getByText('auth.handle_taken', { exact: true })).toBeVisible();
  expect(await journal(page)).toEqual(saved);
  expect(state.instance.counts.accountWrites).toBe(1);
  expect(count(state, 'auth.register')).toBe(2);
});
for (const [label, status, code] of [
  ['raw400', 400, undefined],
  ['opaque403', 403, 'FORBIDDEN'],
  ['generic401', 401, 'UNAUTHORIZED'],
  ['wrongKind409', 409, 'auth.handle_taken'],
])
  test('unclassified or wrong-kind ' + label + ' preserves original password uncertainty', async ({ page, context }) => {
    const state = await network(context, {
      'auth.login': (route) => (code ? failure(route, status, code) : route.fulfill({ status, body: 'unclassified refusal' })),
    });
    await page.goto('/login');
    await fields(page);
    await submit(page).click();
    await expect(unknown(page)).toBeVisible();
    const saved = await journal(page);
    await helpBack(page);
    await expect(unknown(page)).toBeVisible();
    expect(await journal(page)).toEqual(saved);
    expect(count(state, 'auth.login')).toBe(1);
  });
test('actual wrong password is a typed pre-session refusal and fresh correct sign-in is usable', async ({ page, context }) => {
  const state = await network(context);
  await page.goto('/login');
  await fields(page, false, { password: 'incorrect-isolated-password' });
  await submit(page).click();
  await expect(page.locator('small[lang="zxx"]').getByText('auth.invalid_credentials', { exact: true })).toBeVisible();
  expect(await journal(page)).toBeNull();
  expect(state.instance.counts.sessionWrites).toBe(0);
  await fields(page);
  await submit(page).click();
  await expect(page).toHaveURL(new URL('/money', test.info().project.use.baseURL).href);
});
test('actual one-use recovery consumption then session failure remains unknown without code replay', async ({ page, context }) => {
  const state = await network(context, { issueFail: true });
  const prepared = await state.instance.mfa();
  state.instance.counts.codeWrites = 0;
  state['auth.login'] = async (route, input) => {
    const old = state.instance.users.get(service.owner).recovery_code_hashes.length;
    const result = await state.instance.call('auth.login', input);
    const consumed = state.instance.users.get(service.owner).recovery_code_hashes.length === old - 1;
    state.consumed = consumed;
    expect(result.status).toBe(400);
    expect(result.body.error.data.cause.code).toBe('isolated.session_after_write');
    return route.fulfill({ status: result.status, json: result.body });
  };
  await page.goto('/login');
  await fields(page);
  await page.locator('input[autocomplete="one-time-code"]').fill(prepared.recoveryCodes[0]);
  await submit(page).click();
  await expect(unknown(page)).toBeVisible();
  expect(state.consumed).toBe(true);
  expect(state.instance.counts.sessionWrites).toBe(1);
  await expect(page.locator('input[autocomplete="one-time-code"]')).toHaveValue('');
  const saved = await journal(page);
  await helpBack(page);
  expect(await journal(page)).toEqual(saved);
  expect(count(state, 'auth.login')).toBe(1);
});
for (const value of ['emptyToken', 'impossibleDate', 'expired', 'badOwner'])
  test('malformed or unusable session ' + value + ' cannot commit and stays original unknown', async ({ page, context }) => {
    const state = await network(context, {
      'auth.login': async (_route, input, reply) => {
        const r = await state.instance.call('auth.login', input),
          v = r.body.result.data;
        if (value === 'emptyToken') v.accessToken = ' ';
        if (value === 'impossibleDate') v.expiresAt = '2027-02-30T00:00:00.000Z';
        if (value === 'expired') v.expiresAt = '2020-01-01T00:00:00.000Z';
        if (value === 'badOwner') v.userId = 'not-a-user';
        return reply(v);
      },
    });
    await page.goto('/login');
    await fields(page);
    await submit(page).click();
    await expect(unknown(page)).toBeVisible();
    expect(state.privateReads).toBe(0);
    expect(count(state, 'auth.login')).toBe(1);
  });
test('storage failure refuses password dispatch while public Help remains usable', async ({ page, context }) => {
  const state = await network(context);
  await page.goto('/login');
  await fields(page);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (k === 'intafaced.customer.public-auth.v1') throw Error('Isolated storage refusal');
      return original.call(this, k, v);
    };
  });
  await submit(page).click();
  await expect(page.getByRole('status').filter({ hasText: 'cannot safely save' })).toBeVisible();
  expect(count(state, 'auth.login')).toBe(0);
  await page.locator('.public-header').getByRole('link', { name: 'Help', exact: true }).click();
  await expect(page).toHaveURL(new URL('/help', test.info().project.use.baseURL).href);
});
test('two native tabs coordinate only pending work and fresh intent survives an older unknown', async ({ page, context }) => {
  const held = hold(),
    state = await network(context, {
      'auth.login': async (route) => {
        await held.promise;
        return failure(route);
      },
    });
  await page.goto('/login');
  await fields(page);
  await submit(page).click();
  await expect.poll(() => count(state, 'auth.login')).toBe(1);
  const second = await context.newPage();
  await second.goto('/login');
  await fields(second);
  await submit(second).click();
  await expect(second.getByRole('status').filter({ hasText: 'Another tab' })).toBeVisible();
  expect(count(state, 'auth.login')).toBe(1);
  held.release();
  await expect(unknown(page)).toBeVisible();
  delete state['auth.login'];
  await fields(second);
  await submit(second).click();
  await expect(second).toHaveURL(new URL('/money', test.info().project.use.baseURL).href);
  expect((await journal(second)).length).toBe(1);
});
test('native passkey ceremony and actual service verification issue an original session', async ({ page, context }) => {
  const state = await network(context);
  await page.goto('/login?redirect=%2Fuc%2Fsafe');
  await nativeKey(context, page, state);
  await page.getByRole('textbox', { name: 'Email or handle', exact: true }).fill('isolated-auth@example.invalid');
  await page.getByRole('button', { name: 'Use a passkey', exact: true }).click();
  await expect(page).toHaveURL(new URL('/uc/safe', test.info().project.use.baseURL).href);
  expect(count(state, 'webauthn.authOptions')).toBe(1);
  expect(count(state, 'webauthn.authVerify')).toBe(1);
  expect(state.instance.counts.sessionWrites).toBe(1);
  expect(await journal(page)).toBeNull();
});
test('held passkey options after native Help cannot invoke get or verification', async ({ page, context }) => {
  const held = hold(),
    state = await network(context, {
      'webauthn.authOptions': async (route, input) => {
        const r = await state.instance.call('webauthn.authOptions', input);
        await held.promise;
        return route.fulfill({ status: r.status, json: r.body });
      },
    });
  await page.goto('/login');
  await nativeKey(context, page, state);
  await page.evaluate(() => {
    const get = navigator.credentials.get.bind(navigator.credentials);
    window.nativeGets = 0;
    navigator.credentials.get = (...args) => {
      window.nativeGets++;
      return get(...args);
    };
  });
  await page.getByRole('textbox', { name: 'Email or handle', exact: true }).fill('isolated-auth@example.invalid');
  await page.getByRole('button', { name: 'Use a passkey', exact: true }).click();
  await expect.poll(() => count(state, 'webauthn.authOptions')).toBe(1);
  await helpBack(page);
  held.release();
  await expect(optionsUnknown(page)).toBeVisible();
  expect(await page.evaluate(() => window.nativeGets)).toBe(0);
  expect(count(state, 'webauthn.authVerify')).toBe(0);
});
test('held native passkey result after route departure sends no verification', async ({ page, context }) => {
  const state = await network(context);
  await page.goto('/login');
  await nativeKey(context, page, state);
  await page.evaluate(() => {
    const get = navigator.credentials.get.bind(navigator.credentials);
    window.releaseNative = null;
    navigator.credentials.get = async (...args) => {
      const c = await get(...args);
      await new Promise((r) => (window.releaseNative = r));
      return c;
    };
  });
  await page.getByRole('textbox', { name: 'Email or handle', exact: true }).fill('isolated-auth@example.invalid');
  await page.getByRole('button', { name: 'Use a passkey', exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof window.releaseNative === 'function')).toBe(true);
  await page.locator('.public-header').getByRole('link', { name: 'Help', exact: true }).click();
  await page.evaluate(() => window.releaseNative());
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Sign in to your account', exact: true })).toBeVisible();
  expect(count(state, 'webauthn.authVerify')).toBe(0);
  expect(await journal(page)).toBeNull();
});
test('unknown passkey verification stays prior original while an explicit new challenge works', async ({ page, context }) => {
  const state = await network(context, { 'webauthn.authVerify': (route) => failure(route) });
  await page.goto('/login');
  await nativeKey(context, page, state);
  await page.getByRole('textbox', { name: 'Email or handle', exact: true }).fill('isolated-auth@example.invalid');
  await page.getByRole('button', { name: 'Use a passkey', exact: true }).click();
  await expect(unknown(page)).toBeVisible();
  const saved = await journal(page);
  delete state['webauthn.authVerify'];
  await page.getByRole('button', { name: 'Use a passkey', exact: true }).click();
  await expect(page).toHaveURL(new URL('/money', test.info().project.use.baseURL).href);
  expect(await journal(page)).toEqual(saved);
  expect(count(state, 'webauthn.authOptions')).toBe(2);
  expect(count(state, 'webauthn.authVerify')).toBe(2);
});
for (const mode of ['unsupported', 'malformedOptions', 'cancelled'])
  test('passkey ' + mode + ' never invents verification', async ({ page, context }) => {
    const state = await network(
      context,
      mode === 'malformedOptions'
        ? { 'webauthn.authOptions': (_r, _i, reply) => reply({ challenge: 'not canonical!', rpId: 'localhost' }) }
        : {},
    );
    await page.goto('/login');
    if (mode === 'unsupported') await page.evaluate(() => Object.defineProperty(window, 'PublicKeyCredential', { value: undefined }));
    if (mode === 'cancelled')
      await page.evaluate(() => {
        navigator.credentials.get = async () => {
          throw new DOMException('Isolated cancellation', 'NotAllowedError');
        };
      });
    await page.getByRole('textbox', { name: 'Email or handle', exact: true }).fill('isolated-auth@example.invalid');
    await page.getByRole('button', { name: 'Use a passkey', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Use a passkey', exact: true })).toBeEnabled();
    expect(count(state, 'webauthn.authVerify')).toBe(0);
    if (mode === 'unsupported') expect(count(state, 'webauthn.authOptions')).toBe(0);
    if (mode === 'malformedOptions') await expect(optionsUnknown(page)).toBeVisible();
    else expect(await journal(page)).toBeNull();
  });
for (const locale of ['es', 'fr'])
  test('prior original context follows native View ' + locale + ' without journal rewrite', async ({ page, context }) => {
    const state = await network(context, { 'auth.register': (route) => failure(route) });
    await page.goto('/register');
    await fields(page, true);
    await submit(page).click();
    await expect(registerUnknown(page)).toBeVisible();
    const saved = await journal(page);
    const view = await context.newPage();
    await login(view, '/view');
    await view
      .locator('select')
      .filter({ has: view.locator('option[value="es"]') })
      .selectOption(locale);
    const region = page.getByRole('region', {
      name: locale === 'es' ? 'Creación de cuenta sin confirmar' : 'Création du compte non confirmée',
      exact: true,
    });
    await expect(region).toBeVisible();
    expect(await journal(page)).toEqual(saved);
    await expect(region.locator('h2 span')).toHaveAttribute('lang', locale);
    await expect(
      region.getByRole('link', {
        name: locale === 'es' ? 'Obtener ayuda con la cuenta ↗' : 'Obtenir de l’aide pour le compte ↗',
        exact: true,
      }),
    ).toBeVisible();
    await view.close();
    await shot(page, 'unknown-' + locale);
  });
for (const width of [320, 390, 768, 1440])
  test('public whole-room phone fit and keyboard submit at ' + width, async ({ page, context }) => {
    await network(context);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/login');
    await fields(page);
    await submit(page).focus();
    await expect(submit(page)).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await submit(page).evaluate((n) => n.getBoundingClientRect().height >= 44)).toBe(true);
    await shot(page, 'public-phone-' + width);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new URL('/money', test.info().project.use.baseURL).href);
  });
test('public authentication semantic controls have no serious accessibility violations', async ({ page, context }) => {
  await network(context);
  await page.goto('/login');
  const result = await new AxeBuilder({ page }).include('.auth-layout').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(result.violations.map((v) => ({ id: v.id, count: v.nodes.length }))).toEqual([]);
});
for (const width of [320, 390])
  test('unknown registration preserves its full reference and keyboard Help recovery at ' + width, async ({ page, context }) => {
    const state = await network(context, { 'auth.register': (route) => failure(route) });
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/register?redirect=%2Fuc%2Fsafe');
    await fields(page, true);
    await submit(page).click();
    const region = registerUnknown(page);
    await expect(region).toBeVisible();
    const saved = await journal(page);
    await expect(region.locator('small span[lang="zxx"]')).toHaveText(saved[0].localRef);
    await expect(region.getByText('After sign-in · Security', { exact: true })).toBeVisible();
    await expect(page.locator('input[autocomplete="new-password"]')).toHaveValue('');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const help = region.getByRole('link', { name: 'Get account help ↗', exact: true });
    await help.focus();
    await expect(help).toBeFocused();
    expect(await help.evaluate((n) => n.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    await shot(page, 'public-unknown-phone-' + width);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new URL('/help', test.info().project.use.baseURL).href);
    await page.goBack();
    await expect(registerUnknown(page)).toBeVisible();
    expect(await journal(page)).toEqual(saved);
    expect(count(state, 'auth.register')).toBe(1);
  });

async function seedPriorAttempts(page, amount = 200) {
  const records = await page.evaluate(
    ({ key, amount }) => {
      const records = Array.from({ length: amount }, (_, index) => ({
        localRef: crypto.randomUUID(),
        kind: 'password',
        createdAt: new Date(Date.now() - (amount - index) * 1000).toISOString(),
        target: '/money',
      }));
      localStorage.setItem(key, JSON.stringify(records));
      return records;
    },
    { key, amount },
  );
  await page.reload();
  return records;
}
for (const width of [320, 390])
  test('healthy200 originals remain selectable while independent password sign-in works at ' + width, async ({ page, context }) => {
    const state = await network(context);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/login?redirect=%2Fuc%2Fsafe');
    const records = await seedPriorAttempts(page);
    const selector = page.getByRole('combobox', { name: 'Earlier attempt', exact: true });
    await expect(selector.locator('option')).toHaveCount(200);
    await selector.focus();
    // Native typeahead is supported by this Chromium control; End is not a selection command on macOS.
    await page.keyboard.type(records[0].localRef.slice(0, 8), { delay: 60 });
    await page.keyboard.press('Tab');
    await expect(selector).toHaveValue(records[0].localRef);
    await expect(unknown(page).locator('small span[lang="zxx"]')).toHaveText(records[0].localRef);
    await expect(
      page.getByText('Showing one of 200 earlier attempts. Choose a reference to inspect another.', { exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await fields(page);
    await submit(page).focus();
    await expect(submit(page)).toBeFocused();
    await shot(page, '200-originals-' + width);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new URL('/uc/safe', test.info().project.use.baseURL).href);
    expect(count(state, 'auth.login')).toBe(1);
    expect(await journal(page)).toEqual(records);
  });
test('healthy200 prior originals allow a separate new native challenge without inventing signature success', async ({ page, context }) => {
  const state = await network(context);
  await page.goto('/login');
  await nativeKey(context, page, state);
  const records = await seedPriorAttempts(page);
  await page.getByRole('textbox', { name: 'Email or handle', exact: true }).fill('isolated-auth@example.invalid');
  await page.getByRole('button', { name: 'Use a passkey', exact: true }).click();
  await expect(page.locator('small[lang="zxx"]').getByText('auth.invalid_credentials', { exact: true })).toBeVisible();
  expect(count(state, 'webauthn.authOptions')).toBe(1);
  expect(count(state, 'webauthn.authVerify')).toBe(1);
  expect(state.instance.counts.sessionWrites).toBe(0);
  expect(await journal(page)).toEqual(records);
  await expect(page.getByRole('combobox', { name: 'Earlier attempt', exact: true }).locator('option')).toHaveCount(200);
});
test('healthy200 originals also allow a separately requested registration without certifying them', async ({ page, context }) => {
  const state = await network(context);
  await page.goto('/register?redirect=%2Fuc%2Fsafe');
  const records = await seedPriorAttempts(page);
  await fields(page, true);
  await submit(page).click();
  await expect(page).toHaveURL(new URL('/uc/safe', test.info().project.use.baseURL).href);
  expect(count(state, 'auth.register')).toBe(1);
  expect(state.instance.counts.accountWrites).toBe(1);
  expect(await journal(page)).toEqual(records);
});
test('a selected older original survives a held new attempt, appended unknown, native View and Help return', async ({ page, context }) => {
  const held = hold(),
    state = await network(context, {
      'auth.login': async (route) => {
        await held.promise;
        return failure(route);
      },
    });
  await page.goto('/login');
  const records = await seedPriorAttempts(page);
  const selector = page.getByRole('combobox', { name: 'Earlier attempt', exact: true });
  await selector.selectOption(records[0].localRef);
  await fields(page);
  await submit(page).click();
  await expect.poll(() => count(state, 'auth.login')).toBe(1);
  await expect(selector.locator('option')).toHaveCount(201);
  await expect(selector).toHaveValue(records[0].localRef);
  await expect(unknown(page).locator('small span[lang="zxx"]')).toHaveText(records[0].localRef);
  held.release();
  await expect(submit(page)).toBeEnabled();
  const saved = await journal(page);
  expect(saved.slice(0, 200)).toEqual(records);
  expect(saved).toHaveLength(201);
  delete state['auth.login'];
  const view = await context.newPage();
  await login(view, '/view');
  await view
    .locator('select')
    .filter({ has: view.locator('option[value="es"]') })
    .selectOption('es');
  const translated = page.getByRole('combobox', { name: 'Intento anterior', exact: true });
  await expect(translated).toHaveValue(records[0].localRef);
  await expect(
    page.getByRole('region', { name: 'Inicio de sesión sin confirmar', exact: true }).locator('small span[lang="zxx"]'),
  ).toHaveText(records[0].localRef);
  await view
    .locator('select')
    .filter({ has: view.locator('option[value="es"]') })
    .selectOption('en');
  await view.close();
  await helpBack(page);
  expect(await journal(page)).toEqual(saved);
  await page.getByRole('combobox', { name: 'Earlier attempt', exact: true }).selectOption(records[0].localRef);
  await expect(unknown(page).locator('small span[lang="zxx"]')).toHaveText(records[0].localRef);
});
test('actual quota failure with200 healthy originals sends nothing and preserves all prior metadata', async ({ page, context }) => {
  const state = await network(context);
  await page.goto('/login');
  const records = await seedPriorAttempts(page);
  await fields(page);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (k === 'intafaced.customer.public-auth.v1') throw new DOMException('Isolated full storage', 'QuotaExceededError');
      return original.call(this, k, v);
    };
  });
  await submit(page).click();
  await expect(page.getByRole('status').filter({ hasText: 'cannot safely save' })).toBeVisible();
  expect(count(state, 'auth.login')).toBe(0);
  expect(await journal(page)).toEqual(records);
});
for (const invitation of [false, true])
  test(
    'unknown registration explicit fresh Sign in retains current valid ' +
      (invitation ? 'invitation' : 'return') +
      ' without resolving original',
    async ({ page, context }) => {
      const state = await network(context, { rankFail: true });
      const token = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      const returnTo = '/uc/safe?return=original';
      await page.goto('/register?redirect=' + encodeURIComponent(returnTo) + (invitation ? '&invite=' + token : ''));
      await fields(page, true);
      await submit(page).click();
      const region = registerUnknown(page);
      await expect(region).toBeVisible();
      const saved = await journal(page);
      const fresh = region.getByRole('link', { name: 'Start a fresh sign-in ↗', exact: true });
      await fresh.focus();
      await expect(fresh).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(
        (url) =>
          url.pathname === '/login' &&
          url.searchParams.get('redirect') === returnTo &&
          url.searchParams.get('invite') === (invitation ? token : null),
      );
      expect(await journal(page)).toEqual(saved);
      await expect(page.locator('input[autocomplete="current-password"]')).toHaveValue('');
      await fields(page, false, { identifier: 'fresh-auth@example.invalid' });
      await submit(page).click();
      await expect(page).toHaveURL(new URL(invitation ? '/invite?token=' + token : returnTo, test.info().project.use.baseURL).href);
      expect(await journal(page)).toEqual(saved);
      expect(count(state, 'auth.register')).toBe(1);
      expect(count(state, 'auth.login')).toBe(1);
      expect(count(state, 'invitations.accept')).toBe(0);
    },
  );
for (const [locale, width] of [
  ['es', 320],
  ['fr', 390],
])
  test('registration recovery fresh sign-in action follows native ' + locale + ' at ' + width, async ({ page, context }) => {
    const state = await network(context, { rankFail: true });
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/register?redirect=%2Fuc%2Fsafe');
    await fields(page, true);
    await submit(page).click();
    await expect(registerUnknown(page)).toBeVisible();
    const saved = await journal(page);
    const view = await context.newPage();
    await login(view, '/view');
    await view
      .locator('select')
      .filter({ has: view.locator('option[value="es"]') })
      .selectOption(locale);
    const region = page.getByRole('region', {
      name: locale === 'es' ? 'Creación de cuenta sin confirmar' : 'Création du compte non confirmée',
      exact: true,
    });
    const fresh = region.getByRole('link', {
      name: locale === 'es' ? 'Iniciar una nueva sesión ↗' : 'Démarrer une nouvelle connexion ↗',
      exact: true,
    });
    await expect(fresh).toBeVisible();
    await expect(fresh.locator('span')).toHaveAttribute('lang', locale);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await fresh.evaluate((n) => n.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    await fresh.focus();
    await expect(fresh).toBeFocused();
    await shot(page, 'registration-fresh-' + locale + '-' + width);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL((url) => url.pathname === '/login' && url.searchParams.get('redirect') === '/uc/safe');
    expect(await journal(page)).toEqual(saved);
    expect(count(state, 'auth.register')).toBe(1);
    await expect(page.locator('input[autocomplete="current-password"]')).toBeVisible();
    await view.close();
  });
