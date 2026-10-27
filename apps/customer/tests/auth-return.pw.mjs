import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
const evidence = process.env.AUTH_RETURN_EVIDENCE;
mkdirSync(evidence, { recursive: true });
const summary = [],
  errors = new WeakMap();
test.beforeEach(async ({ page }) => {
  const list = [];
  errors.set(page, list);
  page.on('pageerror', () => list.push(true));
});
test.afterEach(async ({ page }, info) => {
  expect(errors.get(page).length).toBe(0);
  summary.push({ name: info.title, status: info.status, pageErrors: errors.get(page).length });
});
test.afterAll(() => writeFileSync(evidence + '/native-summary.json', JSON.stringify(summary, null, 2)));

const targets = [
  ['Loan', '/bank/loans?asset=USDT&term=30&note=original%20room'],
  ['Money', '/money?asset=BTC&view=available&note=original%26room'],
  ['Send', '/pay/send?asset=USDT&recipient=opaque%2Froom&note=original%20room'],
];
const invitation = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const key = 'intafaced.customer.public-auth.v1';
async function guest(context, language = 'en') {
  await context.addInitScript((language) => localStorage.setItem('intafaced.customer.view.v1', JSON.stringify({ language })), language);
  const state = { writes: [], pageErrors: 0 };
  await context.route('**/api/**', (route) => {
    const procedure = new URL(route.request().url()).pathname.split('/').at(-1);
    // The boot refresh is not a user write. A guest has no `ifc_rt` cookie, so the server answers session_invalid.
    if (procedure === 'auth.refresh') return route.fulfill({ status: 401, json: refusal });
    if (route.request().method() === 'POST') state.writes.push(procedure);
    return route.fulfill({ status: 503, json: { error: { message: 'Isolated unavailable' } } });
  });
  return state;
}
const refusal = { error: { message: 'Session not found', data: { intafacedCode: 'auth.session_invalid' } } };
const USER = '11111111-1111-4111-8111-111111111111';
/** A browser whose HttpOnly `ifc_rt` cookie is valid (`cookie.valid`): auth.refresh answers with a new access token only. */
async function restorable(context, cookie) {
  const refreshes = [];
  await context.route('**/api/**', (route) => {
    const request = route.request(),
      procedure = new URL(request.url()).pathname.split('/').at(-1);
    if (procedure === 'auth.refresh') {
      refreshes.push({ body: request.postData(), authorization: request.headers().authorization });
      if (!cookie.valid) return route.fulfill({ status: 401, json: refusal });
      return route.fulfill({
        status: 200,
        json: {
          result: {
            data: { userId: USER, accessToken: 'restored-' + refreshes.length, expiresAt: new Date(Date.now() + 900000).toISOString() },
          },
        },
      });
    }
    return route.fulfill({ status: 503, json: { error: { message: 'Isolated unavailable' } } });
  });
  return refreshes;
}
async function matches(page, path, destination, invite) {
  return page.evaluate(
    ({ path, destination, invite }) => {
      const query = new URLSearchParams(location.search);
      return location.pathname === path && query.get('redirect') === destination && query.get('invite') === (invite ?? null);
    },
    { path, destination, invite },
  );
}
async function switched(page, path, destination, invite) {
  await expect(page.locator('.auth-form')).toBeVisible();
  expect(await matches(page, path, destination, invite)).toBe(true);
}
const formSwitch = (page) => page.locator('.public-auth-form-links a');
const headerSwitch = (page) => page.locator('.public-signin');
const recovery = (page) => page.locator('.auth-form form > a[href^="/findPwd"]');
async function fit(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const language of ['en', 'es', 'fr'])
  for (const width of [1440, 390, 320])
    for (const [room, destination] of targets)
      test('full ' + room + ' return survives form/header/recovery round trips ' + language + ' ' + width, async ({ page, context }) => {
        await page.setViewportSize({ width, height: 1000 });
        const state = await guest(context, language);
        await page.goto('/login?redirect=' + encodeURIComponent(destination));
        await formSwitch(page).click();
        await switched(page, '/register', destination);
        await fit(page);
        await formSwitch(page).click();
        await switched(page, '/login', destination);
        await headerSwitch(page).click();
        await switched(page, '/register', destination);
        await headerSwitch(page).click();
        await switched(page, '/login', destination);
        await recovery(page).click();
        expect(await matches(page, '/findPwd', destination)).toBe(true);
        await expect(page.locator('h1')).toBeVisible();
        await fit(page);
        await headerSwitch(page).click();
        await switched(page, '/login', destination);
        await page.goBack();
        expect(await matches(page, '/findPwd', destination)).toBe(true);
        await page.goBack();
        await switched(page, '/login', destination);
        expect(state.writes.length).toBe(0);
        expect(
          await page.evaluate((destination) => !JSON.stringify({ ...localStorage, ...sessionStorage }).includes(destination), destination),
        ).toBe(true);
        expect(
          await page.evaluate(() => /accessToken|refreshToken|ifc_rt/.test(JSON.stringify({ ...localStorage, ...sessionStorage }))),
        ).toBe(false);
      });

for (const [label, target] of [
  ['external', 'https://outside.invalid/'],
  ['protocol relative', '//outside.invalid/'],
  ['Team', '/ops'],
  ['parked', '/chain'],
  ['public', '/help'],
  ['unknown', '/unknown'],
  ['backslash', '/\\outside.invalid/'],
])
  test('invalid ' + label + ' destination stays Money through all auth links', async ({ page, context }) => {
    const state = await guest(context);
    await page.goto('/login?redirect=' + encodeURIComponent(target));
    await formSwitch(page).click();
    await switched(page, '/register', '/money');
    await headerSwitch(page).click();
    await switched(page, '/login', '/money');
    await recovery(page).click();
    await headerSwitch(page).click();
    await switched(page, '/login', '/money');
    expect(state.writes.length).toBe(0);
  });
for (const width of [1440, 390, 320])
  test('legacy full return becomes validated shared context ' + width, async ({ page, context }) => {
    await page.setViewportSize({ width, height: 1000 });
    const state = await guest(context);
    const destination = targets[0][1];
    await page.goto('/login/returnUrl/' + encodeURIComponent(destination));
    await formSwitch(page).click();
    await switched(page, '/register', destination);
    await formSwitch(page).click();
    await switched(page, '/login', destination);
    expect(state.writes.length).toBe(0);
  });
for (const valid of [true, false])
  test('only validated invitation survives form/header/recovery ' + valid, async ({ page, context }) => {
    const state = await guest(context);
    const destination = targets[2][1],
      token = valid ? invitation : 'invalid-invitation';
    await page.goto('/register?redirect=' + encodeURIComponent(destination) + '&invite=' + encodeURIComponent(token));
    await formSwitch(page).click();
    await switched(page, '/login', destination, valid ? invitation : undefined);
    await headerSwitch(page).click();
    await switched(page, '/register', destination, valid ? invitation : undefined);
    await formSwitch(page).click();
    await recovery(page).click();
    await headerSwitch(page).click();
    await switched(page, '/login', destination, valid ? invitation : undefined);
    expect(state.writes.length).toBe(0);
  });
test('public Invitation header validates token and carries safe destination', async ({ page, context }) => {
  const state = await guest(context),
    destination = targets[0][1];
  await page.goto('/invite?token=' + invitation + '&redirect=' + encodeURIComponent(destination));
  await headerSwitch(page).click();
  await switched(page, '/login', destination, invitation);
  expect(state.writes.length).toBe(0);
});
for (const path of ['/login', '/register'])
  test('bare ' + path + ' switch and recovery keep existing defaults', async ({ page, context }) => {
    const state = await guest(context);
    await page.goto(path);
    await formSwitch(page).click();
    expect(await page.evaluate(() => location.search === '')).toBe(true);
    await headerSwitch(page).click();
    expect(await page.evaluate(() => location.search === '')).toBe(true);
    if (path === '/login') {
      await recovery(page).click();
      await headerSwitch(page).click();
      expect(await page.evaluate(() => location.pathname === '/login' && location.search === '')).toBe(true);
    }
    expect(state.writes.length).toBe(0);
  });

async function actual(context, options = {}, intercept) {
  const service = await import(pathToFileURL(process.env.PUBLIC_AUTH_SERVICE_FIXTURE).href);
  const instance = await service.makeService(options),
    state = { instance, writes: [], privateReads: 0 };
  await context.route('**/api/**', async (route) => {
    const request = route.request(),
      procedure = new URL(request.url()).pathname.split('/').at(-1);
    if (request.method() === 'POST') state.writes.push(procedure);
    if (request.method() === 'GET' && request.headers().authorization) state.privateReads++;
    if (['auth.register', 'auth.login'].includes(procedure)) {
      const result = await instance.call(procedure, request.postDataJSON());
      if (intercept) await intercept(procedure);
      return route.fulfill({ status: result.status, json: result.body });
    }
    return route.fulfill({ status: 503, json: { error: { message: 'Isolated unavailable' } } });
  });
  return state;
}
async function fields(page, register = false) {
  if (register) await page.locator('input[name="handle"]').fill('return_context');
  await page.locator('input[name="identifier"]').fill('return-context@example.invalid');
  await page.locator('input[autocomplete="' + (register ? 'new-password' : 'current-password') + '"]').fill('isolated-test-password');
}
const unknown = (page) => page.locator('.public-auth-unknown');
const journal = (page) => page.evaluate((key) => localStorage.getItem(key), key);
for (const [label, destination, invite] of [
  ['bare', undefined, undefined],
  ['room', targets[0][1], undefined],
  ['invitation', targets[2][1], invitation],
])
  test('fresh sign-in preserves ' + label + ' context without certifying unknown registration', async ({ page, context }) => {
    const state = await actual(context, { rankFail: true });
    const params = new URLSearchParams();
    if (destination) params.set('redirect', destination);
    if (invite) params.set('invite', invite);
    await page.goto('/register' + (params.size ? '?' + params : ''));
    await fields(page, true);
    await page.locator('form button[type="submit"]').click();
    await expect(page.getByRole('region', { name: 'Account creation not confirmed', exact: true })).toBeVisible();
    expect(state.instance.counts.accountWrites).toBe(1);
    const saved = await journal(page);
    await unknown(page).locator('a[href^="/login"]').click();
    await switched(page, '/login', destination ?? '/money', invite);
    expect(await journal(page)).toBe(saved);
    await fields(page);
    await page.locator('form button[type="submit"]').click();
    await expect
      .poll(() =>
        page.evaluate(
          ({ destination, invite }) => location.pathname + location.search === (invite ? '/invite?token=' + invite : destination),
          { destination: destination ?? '/money', invite },
        ),
      )
      .toBe(true);
    expect(await journal(page)).toBe(saved);
    expect(state.writes).toEqual(['auth.register', 'auth.login']);
  });
for (const next of ['form', 'recovery'])
  test('held original sign-in cannot apply late session after ' + next + ' departure', async ({ page, context }) => {
    let release;
    const held = new Promise((resolve) => (release = resolve));
    const state = await actual(context, {}, async () => held);
    await page.goto('/login?redirect=' + encodeURIComponent(targets[0][1]));
    await page.locator('input[name="identifier"]').fill('isolated-auth@example.invalid');
    await page.locator('input[autocomplete="current-password"]').fill('isolated-test-password');
    await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
    await expect.poll(() => state.instance.counts.sessionWrites).toBe(1);
    const saved = await journal(page);
    await (next === 'form' ? formSwitch(page) : recovery(page)).click();
    release();
    await page.goBack();
    await expect(unknown(page)).toBeVisible();
    expect(await journal(page)).toBe(saved);
    expect(state.privateReads).toBe(0);
    expect(state.writes).toEqual(['auth.login']);
  });

// These probes deliberately deliver late known replies even after client cancellation.
// The actual production API parser and real isolated AuthService still handle each body.
async function controlledAuth(context, procedure, phase = 'after', mfa = false) {
  const service = await import(pathToFileURL(process.env.PUBLIC_AUTH_SERVICE_FIXTURE).href);
  const instance = await service.makeService();
  const prepared = mfa ? await instance.mfa() : null;
  let release, entered;
  const held = new Promise((resolve) => (release = resolve));
  const arrived = new Promise((resolve) => (entered = resolve));
  const state = {
    instance,
    service,
    release,
    arrived,
    writes: [],
    privateReads: 0,
    codeBefore: instance.counts.codeWrites,
    code: () => prepared.recoveryCodes[0],
  };
  await context.addInitScript((procedure) => {
    const real = window.fetch.bind(window);
    window.__authReturnDelivered = 0;
    window.fetch = async (input, init) => {
      const response = await real(input, { ...init, signal: undefined });
      if (init?.method === 'POST' && String(input).endsWith('/' + encodeURIComponent(procedure))) {
        const text = response.text.bind(response);
        response.text = async () => {
          const body = await text();
          window.__authReturnDelivered++;
          return body;
        };
      }
      return response;
    };
  }, procedure);
  await context.route('**/api/**', async (route) => {
    const request = route.request(),
      name = new URL(request.url()).pathname.split('/').at(-1);
    if (request.method() === 'POST') state.writes.push(name);
    if (request.method() === 'GET' && request.headers().authorization) state.privateReads++;
    if (['auth.login', 'auth.register', 'webauthn.authOptions', 'webauthn.authVerify'].includes(name)) {
      const input = request.postDataJSON();
      if (name === procedure && phase === 'before') {
        entered();
        await held;
      }
      const answer = await instance.call(name, input);
      if (name === procedure && phase === 'after') {
        entered();
        await held;
      }
      return route.fulfill({ status: answer.status, json: answer.body }).catch(() => {});
    }
    return route.fulfill({ status: 503, json: { error: { message: 'Isolated unavailable' } } });
  });
  return state;
}
async function departureReturn(page, mode = 'query') {
  await page.evaluate((mode) => {
    const original = location.pathname + location.search + location.hash;
    const changed = new URL(location.href);
    if (mode === 'hash') changed.hash = 'different-context';
    else changed.searchParams.set('redirect', '/bank/loans?asset=BTC&note=other%20room');
    for (let round = 0; round < (mode === 'mixed' ? 2 : 1); round++) {
      history.pushState(null, '', changed.pathname + changed.search + changed.hash);
      dispatchEvent(new Event(mode === 'hash' || round === 1 ? 'hashchange' : 'popstate'));
      history.pushState(null, '', original);
      dispatchEvent(new Event(mode === 'hash' || round === 1 ? 'hashchange' : 'popstate'));
    }
  }, mode);
}
async function originalLogin(page) {
  await page.goto('/login?redirect=' + encodeURIComponent(targets[0][1]));
  await page.locator('input[name="identifier"]').fill('isolated-auth@example.invalid');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-test-password');
}
async function delivered(page) {
  await page.waitForFunction(() => window.__authReturnDelivered === 1);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function olderUnknown(page) {
  return page.evaluate((key) => {
    const value = JSON.stringify([
      { localRef: crypto.randomUUID(), kind: 'password', createdAt: new Date().toISOString(), target: '/money' },
    ]);
    localStorage.setItem(key, value);
    dispatchEvent(new StorageEvent('storage', { key, storageArea: localStorage }));
    return value;
  }, key);
}
for (const mode of ['query', 'hash', 'mixed'])
  test('held known login across observed ' + mode + ' ABA keeps original unknown', async ({ page, context }) => {
    const state = await controlledAuth(context, 'auth.login');
    await originalLogin(page);
    await olderUnknown(page);
    await page.locator('form button[type="submit"]').click();
    await state.arrived;
    const saved = await journal(page);
    await departureReturn(page, mode);
    expect(await page.locator('input[name="identifier"]').inputValue()).toBe('');
    expect(await page.locator('input[autocomplete="current-password"]').inputValue()).toBe('');
    state.release();
    await delivered(page);
    expect(await page.evaluate(() => location.pathname === '/login')).toBe(true);
    expect(await journal(page)).toBe(saved);
    expect(state.privateReads).toBe(0);
    expect(state.writes).toEqual(['auth.login']);
  });
test('same full URL events preserve legitimate held login and clean only its known record', async ({ page, context }) => {
  const state = await controlledAuth(context, 'auth.login');
  await originalLogin(page);
  const older = await olderUnknown(page);
  await page.locator('form button[type="submit"]').click();
  await state.arrived;
  await page.evaluate(() => {
    dispatchEvent(new PopStateEvent('popstate'));
    dispatchEvent(new Event('hashchange'));
    dispatchEvent(new PopStateEvent('popstate'));
  });
  state.release();
  await delivered(page);
  await expect.poll(() => page.evaluate((destination) => location.pathname + location.search === destination, targets[0][1])).toBe(true);
  expect(await journal(page)).toBe(older);
  expect(state.writes).toEqual(['auth.login']);
});
test('retained rendered submit passkey and input callbacks reject same-task departure return', async ({ page, context }) => {
  const state = await guest(context);
  await originalLogin(page);
  const saved = await olderUnknown(page);
  await page.evaluate(() => {
    const form = document.querySelector('.auth-form form'),
      submit = form.querySelector('button[type="submit"]'),
      passkey = form.querySelector('button[type="button"]');
    const original = location.pathname + location.search;
    history.pushState(null, '', '/login?redirect=%2Fmoney');
    dispatchEvent(new PopStateEvent('popstate'));
    history.pushState(null, '', original);
    dispatchEvent(new PopStateEvent('popstate'));
    submit.click();
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    passkey.click();
  });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  expect(state.writes).toEqual([]);
  expect(await journal(page)).toBe(saved);
  expect(await page.locator('input[name="identifier"]').inputValue()).toBe('');
  expect(await page.locator('input[autocomplete="current-password"]').inputValue()).toBe('');
});
test('held native WebLock callback after ABA cannot save an attempt or dispatch', async ({ page, context }) => {
  const state = await guest(context);
  await originalLogin(page);
  await page.evaluate(() => {
    const real = navigator.locks.request.bind(navigator.locks);
    navigator.locks.request = (name, options, callback) =>
      real(name, options, async (lock) => {
        window.__authLockEntered = true;
        await new Promise((resolve) => (window.__authLockRelease = resolve));
        return callback(lock);
      });
  });
  await page.locator('form button[type="submit"]').click();
  await page.waitForFunction(() => window.__authLockEntered);
  await departureReturn(page);
  await page.evaluate(() => window.__authLockRelease());
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  expect(await journal(page)).toBeNull();
  expect(state.writes).toEqual([]);
});
for (const phase of ['before', 'after'])
  test('held registration ' + phase + ' account commit ABA keeps unknown through separate fresh sign-in', async ({ page, context }) => {
    const state = await controlledAuth(context, 'auth.register', phase);
    await page.goto('/register?redirect=' + encodeURIComponent(targets[0][1]));
    await fields(page, true);
    await page.locator('form button[type="submit"]').click();
    await state.arrived;
    expect(state.instance.counts.accountWrites).toBe(phase === 'before' ? 0 : 1);
    const saved = await journal(page);
    await departureReturn(page);
    state.release();
    await delivered(page);
    await expect(page.getByRole('region', { name: 'Account creation not confirmed', exact: true })).toBeVisible();
    expect(await journal(page)).toBe(saved);
    expect(state.privateReads).toBe(0);
    expect(state.instance.counts.accountWrites).toBe(1);
    await unknown(page).locator('a[href^="/login"]').click();
    await switched(page, '/login', targets[0][1]);
    await fields(page);
    await page.locator('form button[type="submit"]').click();
    await expect.poll(() => page.evaluate((destination) => location.pathname + location.search === destination, targets[0][1])).toBe(true);
    expect(await journal(page)).toBe(saved);
    expect(state.writes).toEqual(['auth.register', 'auth.login']);
  });
test('consumed original MFA code and known session after ABA never replay or clear unknown', async ({ page, context }) => {
  const state = await controlledAuth(context, 'auth.login', 'after', true);
  await originalLogin(page);
  await page.locator('input[name="totp"]').fill(state.code());
  await page.locator('form button[type="submit"]').click();
  await state.arrived;
  expect(state.instance.counts.codeWrites).toBe(state.codeBefore + 1);
  const saved = await journal(page);
  await departureReturn(page, 'mixed');
  state.release();
  await delivered(page);
  expect(await page.locator('input[name="totp"]').inputValue()).toBe('');
  expect(await journal(page)).toBe(saved);
  expect(state.privateReads).toBe(0);
  expect(state.writes).toEqual(['auth.login']);
  expect(await page.evaluate(() => location.pathname === '/login')).toBe(true);
});
async function nativeCredential(context, page, state) {
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
  const options = await state.instance.auth.startWebauthnRegistration(state.service.owner);
  const credential = await page.evaluate(async (options) => {
    const bytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const encode = (b) =>
      btoa(String.fromCharCode(...new Uint8Array(b)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
    const c = await navigator.credentials.create({
      publicKey: { ...options, challenge: bytes(options.challenge), user: { ...options.user, id: bytes(options.user.id) } },
    });
    return {
      id: c.id,
      rawId: encode(c.rawId),
      type: c.type,
      response: {
        clientDataJSON: encode(c.response.clientDataJSON),
        attestationObject: encode(c.response.attestationObject),
        transports: c.response.getTransports(),
      },
      clientExtensionResults: c.getClientExtensionResults(),
    };
  }, options);
  await state.instance.auth.confirmWebauthnRegistration(state.service.owner, credential);
  return cdp;
}
test('late known actual passkey options across ABA keep preparation unknown and start no ceremony', async ({ page, context }) => {
  const state = await controlledAuth(context, 'webauthn.authOptions');
  await originalLogin(page);
  const cdp = await nativeCredential(context, page, state);
  await page.evaluate(() => {
    const real = navigator.credentials.get.bind(navigator.credentials);
    window.__authGetCalls = 0;
    navigator.credentials.get = (options) => {
      window.__authGetCalls++;
      return real(options);
    };
  });
  await page.locator('.auth-form button[type="button"]').click();
  await state.arrived;
  const saved = await journal(page);
  await departureReturn(page);
  state.release();
  await delivered(page);
  expect(await page.evaluate(() => window.__authGetCalls)).toBe(0);
  expect(await journal(page)).toBe(saved);
  expect(state.writes).toEqual(['webauthn.authOptions']);
  expect(state.privateReads).toBe(0);
  await cdp.detach();
});
test('held actual native credential after ABA cannot start verification or alter an older unknown', async ({ page, context }) => {
  const state = await controlledAuth(context, 'auth.login');
  await originalLogin(page);
  const saved = await olderUnknown(page);
  const cdp = await nativeCredential(context, page, state);
  await page.evaluate(() => {
    const real = navigator.credentials.get.bind(navigator.credentials);
    navigator.credentials.get = async (options) => {
      const result = await real({ ...options, signal: undefined });
      window.__authCredentialReady = true;
      await new Promise((resolve) => (window.__authCredentialRelease = resolve));
      return result;
    };
  });
  await page.locator('.auth-form button[type="button"]').click();
  await page.waitForFunction(() => window.__authCredentialReady);
  expect(await journal(page)).toBe(saved);
  await departureReturn(page, 'hash');
  await page.evaluate(() => window.__authCredentialRelease());
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await journal(page)).toBe(saved);
  expect(state.writes).toEqual(['webauthn.authOptions']);
  expect(state.privateReads).toBe(0);
  expect(await page.evaluate(() => location.pathname === '/login')).toBe(true);
  await cdp.detach();
});

test('typing a private URL or reloading keeps the sign-in while the refresh cookie is valid, and stores no token', async ({
  page,
  context,
}) => {
  const cookie = { valid: true },
    refreshes = await restorable(context, cookie);
  await page.goto('/money');
  await expect.poll(() => refreshes.length).toBe(1);
  await expect(page.getByText('Sign in to continue', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect.poll(() => refreshes.length).toBe(2);
  await expect(page.getByText('Sign in to continue', { exact: true })).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe('/money');
  // Cookie only: the page sends no refresh token and no bearer, and keeps none in storage.
  for (const call of refreshes) {
    expect(call.body ?? '{}').not.toMatch(/refreshToken/);
    expect(call.authorization).toBeUndefined();
  }
  expect(
    await page.evaluate(() => /restored-|accessToken|refreshToken|ifc_rt/.test(JSON.stringify({ ...localStorage, ...sessionStorage }))),
  ).toBe(false);
  expect(await page.evaluate(() => document.cookie.includes('ifc_rt'))).toBe(false);
});
test('an expired or missing refresh cookie lands signed out with the return URL kept', async ({ page, context }) => {
  const cookie = { valid: false };
  await restorable(context, cookie);
  await page.goto('/money?asset=BTC');
  await expect(page.getByText('Sign in to continue', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in' }).first()).toHaveAttribute('href', /^\/login\?redirect=%2Fmoney/);
});
