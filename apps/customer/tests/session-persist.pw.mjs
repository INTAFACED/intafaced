import { expect, test } from '@playwright/test';

/**
 * Real Chromium, real cookie jar, real Web Locks and BroadcastChannel, against the real customer app.
 *
 * Only the edge is stood in (context.route): it sets and rotates an HttpOnly cookie exactly as
 * services/svc-edge/src/session-cookie.ts does, and, like svc-identity, treats a retired refresh
 * token shown again as theft. The proof is what the browser did: reload, second tab, both tabs at
 * once, logout in one tab.
 */
const USER = '11111111-1111-4111-8111-111111111111';
const COOKIE = 'intafaced_rt';
const HINT = 'intafaced.customer.session-hint.v1';

function fakeEdge() {
  const state = { live: new Map(), retired: new Map(), revoked: new Set(), refreshes: 0, reuse: 0, logouts: 0, n: 0, refreshHeaders: [] };
  const mint = (family) => {
    const refresh = `rt${++state.n}x${Math.random().toString(36).slice(2).padEnd(24, 'a')}`;
    state.live.set(refresh, family);
    return {
      cookie: `${COOKIE}=${refresh}; Path=/api/identity/session; HttpOnly; SameSite=Strict; Max-Age=2592000`,
      body: { accessToken: `access-${state.n}`, expiresAt: new Date(Date.now() + 900_000).toISOString(), userId: USER },
    };
  };
  const json = (status, body, cookie) => ({
    status,
    contentType: 'application/json',
    headers: cookie ? { 'set-cookie': cookie } : {},
    body: JSON.stringify(body),
  });
  const refusal = (code, cookie) =>
    json(401, { error: { message: code, code: -32001, data: { code: 'UNAUTHORIZED', httpStatus: 401, intafacedCode: code } } }, cookie);
  const clearing = `${COOKIE}=; Path=/api/identity/session; HttpOnly; SameSite=Strict; Max-Age=0`;
  async function install(context) {
    await context.route('**/api/identity/trpc/auth.login', (route) => {
      const { cookie, body } = mint(`family${++state.n}`);
      return route.fulfill(json(200, { result: { data: body } }, cookie));
    });
    await context.route('**/api/identity/session/refresh', async (route) => {
      const headers = await route.request().allHeaders();
      state.refreshHeaders.push(headers);
      state.refreshes += 1;
      await new Promise((r) => setTimeout(r, 120)); // a network, so two tabs can really overlap
      const sent = /intafaced_rt=([^;]+)/.exec(headers.cookie ?? '')?.[1];
      if (!sent) return route.fulfill(refusal('session.no_cookie'));
      if (state.retired.has(sent)) {
        state.reuse += 1;
        state.revoked.add(state.retired.get(sent));
        return route.fulfill(refusal('auth.session_reused', clearing));
      }
      const family = state.live.get(sent);
      if (!family || state.revoked.has(family)) return route.fulfill(refusal('auth.session_invalid', clearing));
      state.live.delete(sent);
      state.retired.set(sent, family);
      const { cookie, body } = mint(family);
      return route.fulfill(json(200, { result: { data: body } }, cookie));
    });
    await context.route('**/api/identity/session/logout', async (route) => {
      state.logouts += 1;
      const sent = /intafaced_rt=([^;]+)/.exec((await route.request().allHeaders()).cookie ?? '')?.[1];
      const family = sent && state.live.get(sent);
      if (family) state.revoked.add(family);
      return route.fulfill(json(200, { result: { data: { ok: true } } }, clearing));
    });
    // Everything else the signed-in app asks for: an empty, honest answer.
    await context.route(/\/api\/(?!identity\/(session|trpc\/auth\.login))/, (route) =>
      route.fulfill(json(200, { result: { data: null } })),
    );
  }
  return { state, install };
}

async function signInOnce(page) {
  await page.goto('/sign-in');
  await page.evaluate(async () => {
    const response = await fetch('/api/identity/trpc/auth.login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-transport': 'cookie' },
      body: '{}',
    });
    if (!response.ok) throw new Error('login stand-in failed');
    localStorage.setItem('intafaced.customer.session-hint.v1', '1');
  });
}
const signedIn = (page) => page.getByRole('button', { name: 'Account menu' });
const signedOut = (page) => page.getByRole('link', { name: 'Log in' });

test('reload, second tab and both at once keep you signed in without a login or a reuse alarm', async ({ context, page }) => {
  const edge = fakeEdge();
  await edge.install(context);
  await signInOnce(page);

  // The cookie is the browser's, not the page's.
  const [cookie] = (await context.cookies()).filter((c) => c.name === COOKIE);
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/api/identity/session', secure: false });
  expect(await page.evaluate(() => document.cookie)).not.toContain(COOKIE);

  // 1. Reload: the page starts empty and the cookie turns into a session.
  await page.goto('/');
  await expect(signedIn(page)).toBeVisible();
  await expect(page).toHaveURL(/\/home/);
  expect(edge.state.refreshes).toBe(1);

  // 2. A second tab (a pop-out window) opens already signed in.
  const second = await context.newPage();
  await second.goto('/');
  await expect(signedIn(second)).toBeVisible();

  // 3. Both tabs reloaded at the same instant: no reuse, nobody signed out.
  await Promise.all([page.reload(), second.reload()]);
  await expect(signedIn(page)).toBeVisible();
  await expect(signedIn(second)).toBeVisible();
  expect(edge.state.reuse).toBe(0);

  // 4. The refresh request names the cookie only: no bearer token, and the CSRF marker is present.
  for (const headers of edge.state.refreshHeaders) {
    expect(headers.authorization).toBeUndefined();
    expect(headers['x-session-request']).toBe('1');
  }

  // 5. Nothing secret in web storage.
  for (const tab of [page, second]) {
    const stored = await tab.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
    expect(stored).not.toMatch(/rt\d+x|access-\d+/);
  }
});

test('signing out in one tab signs the other out, clears the cookie and kills the old one', async ({ context, page }) => {
  const edge = fakeEdge();
  await edge.install(context);
  await signInOnce(page);
  await page.goto('/');
  await expect(signedIn(page)).toBeVisible();
  const second = await context.newPage();
  await second.goto('/');
  await expect(signedIn(second)).toBeVisible();
  const [before] = (await context.cookies()).filter((c) => c.name === COOKIE);

  await signedIn(page).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(signedOut(page)).toBeVisible();
  await expect(signedOut(second)).toBeVisible(); // told over the BroadcastChannel, no reload
  expect(edge.state.logouts).toBe(1);
  expect((await context.cookies()).filter((c) => c.name === COOKIE)).toEqual([]);
  expect(await page.evaluate((key) => localStorage.getItem(key), HINT)).toBeNull();

  // A reload now stays signed out, and the cookie someone kept is dead.
  await page.reload();
  await expect(signedOut(page)).toBeVisible();
  await context.addCookies([{ ...before, url: undefined, domain: '127.0.0.1' }]);
  await page.evaluate((key) => localStorage.setItem(key, '1'), HINT);
  await page.reload();
  await expect(signedOut(page)).toBeVisible();
});
