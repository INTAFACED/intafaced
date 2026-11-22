import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const production = await import(pathToFileURL(process.env.SECURITY_SERVICE_FIXTURE).href);
const owner = '11111111-1111-4111-8111-111111111111',
  other = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const seat = '22222222-2222-4222-8222-222222222222',
  stamp = '2026-10-10T09:41:00.000Z';
const credential = Buffer.from('isolated-credential-1').toString('base64url');
const securityKey = 'intafaced.customer.security.v1:' + owner,
  seatKey = 'intafaced.customer.session-revoke.v1:' + owner;
const evidence = process.env.SECURITY_EVIDENCE;
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
    if (page && !page.isClosed()) {
      await shot(page, 'failed-' + info.title.replace(/[^a-z0-9]+/gi, '-').slice(0, 90));
      const text = await page.evaluate(() => {
        const copy = document.querySelector('#main')?.cloneNode(true);
        if (!copy) return '';
        copy.querySelectorAll('[data-security-sensitive],input,textarea').forEach((node) => node.remove());
        return copy.textContent;
      });
      writeFileSync(evidence + '/failed-' + info.title.replace(/[^a-z0-9]+/gi, '-').slice(0, 90) + '.txt', text ?? '');
    }
  }
  summary.push({ name: info.title, status: info.status, pageErrors: errors.get(context) });
});
test.afterAll(() => writeFileSync(evidence + '/native-summary.json', JSON.stringify(summary, null, 2)));
async function network(context, options = {}) {
  const instance = production.makeService([owner, other], options);
  const stored = { credentialId: credential, publicKey: 'isolated-list-only', counter: 0, createdAt: stamp, transports: ['internal'] };
  instance.users.get(owner).webauthn_creds = options.empty ? [] : [stored];
  const state = { instance, owner, reads: [], writes: [], privateCalls: [], lastSetup: null, sequence: 0, ...options };
  const tokens = new Map();
  await context.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    const procedure = decodeURIComponent(url.pathname.split('/').at(-1));
    const input = request.method() === 'GET' ? JSON.parse(url.searchParams.get('input') || 'null') : request.postDataJSON();
    const reply = (data) => route.fulfill({ status: 200, json: { result: { data } } });
    // Models the HttpOnly `ifc_rt` cookie: sign-in sets it, logout clears it, and a bare refresh without it is session_invalid.
    if (procedure === 'auth.refresh' && !state.cookie)
      return route.fulfill({
        status: 401,
        json: { error: { message: 'Session not found', data: { intafacedCode: 'auth.session_invalid' } } },
      });
    if (procedure === 'auth.login') state.cookie = true;
    if (procedure === 'auth.logout') state.cookie = false;
    if (procedure === 'auth.login' || procedure === 'auth.refresh') {
      const token = 'isolated-memory-' + ++state.sequence;
      tokens.set(token, state.owner);
      return reply({
        userId: state.owner,
        accessToken: token,
        refreshToken: 'isolated-refresh-' + state.sequence,
        expiresAt: procedure === 'auth.login' ? (state.expiresAt ?? '2027-10-10T09:41:00.000Z') : '2027-10-10T09:41:00.000Z',
      });
    }
    if (procedure === 'auth.logout') return reply({ ok: true });
    const actor = tokens.get(request.headers().authorization?.replace('Bearer ', ''));
    if (request.method() === 'GET')
      state.reads.push({ procedure, owner: actor, ...(procedure === 'webauthn.list' ? { limit: input.limit } : {}) });
    else {
      state.writes.push({ procedure, owner: actor, ...(procedure === 'webauthn.remove' ? { credentialId: input.credentialId } : {}) });
      state.privateCalls.push({ procedure, input });
    }
    if (state[procedure]) return state[procedure](route, input, reply, actor);
    if (procedure === 'listSessions') {
      const value = await production.listSessions(instance.sql, input.userId, input.limit);
      return reply({ ...value, sessions: value.sessions.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })) });
    }
    if (procedure === 'revokeSession')
      return reply(await production.revokeNamedSession(instance.sql, actor, input.userId, input.sessionId));
    if (
      [
        'webauthn.list',
        'webauthn.registerOptions',
        'webauthn.registerVerify',
        'webauthn.remove',
        'totp.enrol',
        'totp.confirm',
        'auth.logoutAll',
      ].includes(procedure)
    ) {
      const result = await instance.call(actor, procedure, input);
      if (procedure === 'totp.enrol' && result.status === 200) state.lastSetup = result.body.result.data;
      return route.fulfill({ status: result.status, json: result.body });
    }
    return fail(route);
  });
  return state;
}
async function login(page, path = '/uc/safe') {
  await page.goto('/login?redirect=' + encodeURIComponent(path));
  await page.locator('input[name="identifier"]').fill('isolated-owner');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
  await expect(page).toHaveURL(new URL(path, test.info().project.use.baseURL).href);
}
async function nativeSignOut(page) {
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
}
async function returnLogin(page) {
  await page.locator('#main').getByRole('link', { name: 'Sign in', exact: true }).click();
  await page.locator('input[name="identifier"]').fill('isolated-owner');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
}
const keys = (page) => page.getByRole('region', { name: 'Passkeys', exact: true });
const auth = (page) => page.getByRole('region', { name: 'Authenticator app', exact: true });
const seats = (page) => page.getByRole('region', { name: 'Where you’re signed in', exact: true });
const unknown = (page) => page.getByRole('region', { name: 'Confirmation not received', exact: true });
const prepUnknown = (page) => page.getByRole('region', { name: 'Setup result not received', exact: true });
const receipt = (page) => page.getByRole('region', { name: 'Security action result', exact: true });
const fail = (route, status = 503, message = 'Isolated response lost', code = 'ISOLATED_REFUSAL') =>
  route.fulfill({ status, json: { error: { message, data: { cause: { code } } } } });
const writeCount = (state, procedure) => state.writes.filter((row) => row.procedure === procedure).length;
async function remove(page) {
  await keys(page)
    .getByRole('button', { name: 'Remove passkey ' + credential, exact: true })
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove passkey', exact: true }).click();
}
async function add(page) {
  await keys(page).getByRole('button', { name: 'Add passkey', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Add passkey', exact: true }).click();
}
async function setup(page) {
  await auth(page).getByRole('button', { name: 'Start authenticator setup', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Start authenticator setup', exact: true }).click();
  await expect(auth(page).getByRole('textbox', { name: 'Six-digit authenticator code', exact: true })).toBeVisible();
}
async function confirm(page, value) {
  await auth(page).getByRole('textbox', { name: 'Six-digit authenticator code', exact: true }).fill(value);
  await auth(page).getByRole('button', { name: 'Confirm authenticator', exact: true }).click();
}
async function global(page) {
  await page.getByRole('button', { name: 'Sign out everywhere', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sign out everywhere', exact: true }).click();
}
async function journal(page, key = securityKey) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) || 'null'), key);
}
async function shot(page, name) {
  await page.screenshot({
    path: evidence + '/' + name + '.png',
    fullPage: true,
    mask: [page.locator('[data-security-sensitive], input[autocomplete="current-password"], input[autocomplete="username"]')],
  });
}
async function viewLocale(context, locale) {
  const view = await context.newPage();
  await login(view, '/view');
  await view
    .locator('select')
    .filter({ has: view.locator('option[value="es"]') })
    .selectOption(locale);
  return view;
}
async function virtual(context, page) {
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
  return cdp;
}
function hold() {
  let resolve;
  return {
    promise: new Promise((r) => {
      resolve = r;
    }),
    release: () => resolve(),
  };
}

test('guest boundary offers native sign-in and performs no private reads', async ({ page, context }) => {
  const state = await network(context);
  await page.goto('/uc/safe');
  await expect(page.locator('#main').getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  expect(state.reads).toEqual([]);
  expect(state.writes).toEqual([]);
});
test('native bounded passkey discovery retains full credential and exact read scope', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await expect(keys(page)).toContainText(credential);
  await expect(keys(page)).toContainText('Showing up to 50');
  expect(state.reads.filter((r) => r.procedure === 'webauthn.list')).toEqual([{ procedure: 'webauthn.list', owner, limit: 50 }]);
  expect(state.writes).toEqual([]);
  await shot(page, 'desktop');
});
test('native empty credentials are compact with useful add and refresh', async ({ page, context }) => {
  await network(context, { empty: true });
  await login(page);
  await expect(keys(page)).toContainText('No passkeys yet');
  await expect(keys(page).getByRole('button', { name: 'Add passkey', exact: true })).toBeEnabled();
  await expect(keys(page).getByRole('button', { name: 'Refresh passkeys', exact: true })).toBeEnabled();
});
for (const [name, row] of [
  ['malformed date', { credentialId: credential, createdAt: 'not-a-date' }],
  ['impossible calendar', { credentialId: credential, createdAt: '2026-02-30T09:41:00.000Z' }],
  ['noncanonical credential', { credentialId: credential + '=', createdAt: stamp }],
])
  test(name + ' rejects credential action rather than rendering it', async ({ page, context }) => {
    await network(context, { 'webauthn.list': (_r, _i, reply) => reply([row]) });
    await login(page);
    await expect(keys(page)).toContainText('Information could not be verified');
    await expect(keys(page).getByRole('button', { name: /^Remove passkey / })).toHaveCount(0);
    await expect(keys(page)).not.toContainText('Invalid Date');
  });
test('duplicate credentials reject ambiguous removal actions', async ({ page, context }) => {
  await network(context, {
    'webauthn.list': (_r, _i, reply) =>
      reply([
        { credentialId: credential, createdAt: stamp },
        { credentialId: credential, createdAt: stamp },
      ]),
  });
  await login(page);
  await expect(keys(page)).toContainText('Information could not be verified');
  await expect(keys(page).getByRole('button', { name: /^Remove passkey / })).toHaveCount(0);
});
test('failed credential read retries GET then restores bounded inspection', async ({ page, context }) => {
  let count = 0;
  const state = await network(context, {
    'webauthn.list': async (route, input, reply, actor) =>
      ++count === 1 ? fail(route) : reply(await state.instance.auth.listWebauthnCredentials(actor, input.limit)),
  });
  await login(page);
  await keys(page).getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(keys(page)).toContainText(credential);
  expect(state.writes).toEqual([]);
});
test('credential window expands to 200 without claiming all-history completeness', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  for (const limit of [100, 150, 200]) {
    await keys(page).getByRole('button', { name: 'Show more', exact: true }).click();
    await expect(keys(page)).toContainText('Showing up to ' + limit);
  }
  await expect(keys(page)).toContainText('Older credentials are not represented');
  expect(state.reads.filter((r) => r.procedure === 'webauthn.list').map((r) => r.limit)).toEqual([50, 100, 150, 200]);
  expect(state.writes).toEqual([]);
});
test('reviewed real service removal changes only original credential and no sessions', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await remove(page);
  await expect(receipt(page)).toContainText('The service removed the reviewed credential.');
  await expect(receipt(page)).toContainText(credential);
  expect(state.instance.counts.credentialWrites).toBe(1);
  expect(state.instance.counts.seatWrites).toBe(0);
  expect(await journal(page)).toBeNull();
});
test('matching false removal means no credential changed rather than unknown recovery', async ({ page, context }) => {
  const state = await network(context, { 'webauthn.remove': (_r, _i, reply) => reply({ removed: false }) });
  await login(page);
  await remove(page);
  await expect(receipt(page)).toContainText('No credential was removed');
  expect(state.instance.counts.credentialWrites).toBe(0);
  expect(await journal(page)).toBeNull();
});
test('fresh original credential changed prevents removal dispatch', async ({ page, context }) => {
  let reads = 0;
  const state = await network(context, {
    'webauthn.list': (_r, _i, reply) =>
      reply([{ credentialId: credential, createdAt: ++reads === 1 ? stamp : '2026-10-09T09:41:00.000Z' }]),
  });
  await login(page);
  await remove(page);
  await expect(page.locator('#main')).toContainText('No removal was sent');
  expect(writeCount(state, 'webauthn.remove')).toBe(0);
});
test('lost removal remains original across independent setup, Support and native history', async ({ page, context }) => {
  const state = await network(context, { 'webauthn.remove': (r) => fail(r) });
  await login(page);
  await remove(page);
  await expect(unknown(page)).toContainText(credential);
  const before = await journal(page);
  await setup(page);
  await expect(unknown(page)).toContainText(credential);
  expect(await journal(page).then((r) => r.find((x) => x.kind === 'remove'))).toEqual(before[0]);
  await unknown(page).getByRole('link', { name: 'Contact Support', exact: true }).click();
  await expect(page).toHaveURL(new URL('/support', test.info().project.use.baseURL).href);
  await page.goBack();
  await expect(unknown(page)).toContainText(credential);
  expect(writeCount(state, 'webauthn.remove')).toBe(1);
});
test('list absence cannot clear original unknown removal', async ({ page, context }) => {
  const state = await network(context, { 'webauthn.remove': (r) => fail(r) });
  await login(page);
  await remove(page);
  await expect(unknown(page)).toBeVisible();
  state['webauthn.list'] = (_r, _i, reply) => reply([]);
  await keys(page).getByRole('button', { name: 'Refresh passkeys', exact: true }).click();
  await expect(keys(page)).toContainText('No passkeys yet');
  await expect(unknown(page)).toContainText(credential);
  await expect(keys(page).getByRole('button', { name: 'Add passkey', exact: true })).toBeDisabled();
});
test('storage write failure refuses original removal before POST', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('intafaced.customer.security.')) throw Error('isolated storage failure');
      return original.call(this, key, value);
    };
  });
  await remove(page);
  await expect(page.locator('#main')).toContainText('cannot be safely saved');
  expect(writeCount(state, 'webauthn.remove')).toBe(0);
});
test('missing Web Locks refuses removal before consequential dispatch', async ({ page, context }) => {
  const state = await network(context);
  await context.addInitScript(() => Object.defineProperty(navigator, 'locks', { value: undefined }));
  await login(page);
  await remove(page);
  await expect(page.locator('#main')).toContainText('Safe coordination between tabs is unavailable');
  expect(writeCount(state, 'webauthn.remove')).toBe(0);
});
test('real browser WebAuthn ceremony verifies original UTF8 owner and canonical raw ID', async ({ page, context }) => {
  const state = await network(context, { empty: true });
  await login(page);
  await virtual(context, page);
  await add(page);
  await expect(receipt(page)).toContainText('The service registered the original browser credential.');
  expect(writeCount(state, 'webauthn.registerOptions')).toBe(1);
  expect(writeCount(state, 'webauthn.registerVerify')).toBe(1);
  expect(state.instance.counts.credentialWrites).toBe(1);
  const calls = state.privateCalls;
  const id = calls.find((r) => r.procedure === 'webauthn.registerVerify').input.rawId;
  expect(state.instance.users.get(owner).webauthn_creds[0].credentialId === id).toBe(true);
  expect(await journal(page)).toBeNull();
});
test('lost options remain preparation-only and allow an explicit new add', async ({ page, context }) => {
  let calls = 0;
  const state = await network(context, {
    empty: true,
    'webauthn.registerOptions': async (route, input, _reply, actor) => {
      if (++calls === 1) return fail(route);
      const result = await state.instance.call(actor, 'webauthn.registerOptions', input);
      return route.fulfill({ status: result.status, json: result.body });
    },
  });
  await login(page);
  await virtual(context, page);
  await add(page);
  await expect(prepUnknown(page)).toContainText('no account credential registration was sent');
  await add(page);
  await expect(receipt(page)).toContainText('registered');
  await expect(prepUnknown(page)).toBeVisible();
  expect(writeCount(state, 'webauthn.registerVerify')).toBe(1);
  expect((await journal(page)).map((r) => r.kind)).toEqual(['options']);
});
test('wrong owner registration options never start native ceremony or verification', async ({ page, context }) => {
  const state = await network(context, {
    'webauthn.registerOptions': async (_route, _input, reply) => reply(await state.instance.auth.startWebauthnRegistration(other)),
  });
  await login(page);
  await virtual(context, page);
  await add(page);
  await expect(prepUnknown(page)).toBeVisible();
  expect(writeCount(state, 'webauthn.registerVerify')).toBe(0);
});
test('native ceremony cancellation sends no account registration', async ({ page, context }) => {
  const state = await network(context);
  await context.addInitScript(() => {
    navigator.credentials.create = async () => {
      throw new DOMException('isolated cancellation', 'NotAllowedError');
    };
  });
  await login(page);
  await add(page);
  await expect(page.locator('#main')).toContainText('The browser ceremony stopped');
  expect(writeCount(state, 'webauthn.registerVerify')).toBe(0);
  expect(await journal(page)).toBeNull();
});
test('unsupported native browser sends neither options nor registration', async ({ page, context }) => {
  const state = await network(context);
  await context.addInitScript(() => Object.defineProperty(window, 'PublicKeyCredential', { value: undefined }));
  await login(page);
  await add(page);
  await expect(page.locator('#main')).toContainText('Passkeys require');
  expect(state.writes).toEqual([]);
});
test('mismatched canonical verification receipt stays unknown and cannot repeat', async ({ page, context }) => {
  const state = await network(context, { empty: true, 'webauthn.registerVerify': (_r, _i, reply) => reply({ credentialId: credential }) });
  await login(page);
  await virtual(context, page);
  await add(page);
  await expect(unknown(page)).toContainText('Passkey registration');
  await expect(keys(page).getByRole('button', { name: 'Add passkey', exact: true })).toBeDisabled();
  expect(writeCount(state, 'webauthn.registerVerify')).toBe(1);
});
test('held actual native ceremony after route departure never verifies account', async ({ page, context }) => {
  const state = await network(context, { empty: true });
  await context.addInitScript(() => {
    const create = navigator.credentials.create.bind(navigator.credentials);
    navigator.credentials.create = async (...args) => {
      const result = await create(...args);
      window.securityCeremonyReady = true;
      await new Promise((r) => {
        window.releaseSecurityCeremony = r;
      });
      return result;
    };
  });
  await login(page);
  await virtual(context, page);
  await add(page);
  await expect.poll(() => page.evaluate(() => Boolean(window.securityCeremonyReady))).toBe(true);
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.getByRole('link', { name: 'View and language', exact: true }).click();
  await page.evaluate(() => window.releaseSecurityCeremony());
  await expect(page).toHaveURL(new URL('/view', test.info().project.use.baseURL).href);
  expect(writeCount(state, 'webauthn.registerVerify')).toBe(0);
});
test('real authenticator setup and matching code confirm without persisting any secret', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await setup(page);
  await confirm(page, production.totp(state.lastSetup.secret));
  await expect(auth(page)).toContainText('service accepted the original authenticator confirmation');
  expect(state.instance.counts.totpWrites).toBe(1);
  expect(state.instance.counts.rankCalls).toBe(1);
  const safe = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(
    safe.includes(state.lastSetup.secret) ||
      safe.includes(state.lastSetup.uri) ||
      state.lastSetup.recoveryCodes.some((code) => safe.includes(code)),
  ).toBe(false);
  expect((await journal(page)).map((r) => r.state)).toEqual(['prepared']);
});
test('actual missing TOTP sealing key is typed refusal before pending or user writes', async ({ page, context }) => {
  const state = await network(context, { keyMissing: true });
  await login(page);
  await auth(page).getByRole('button', { name: 'Start authenticator setup', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Start authenticator setup', exact: true }).click();
  await expect(page.locator('#main')).toContainText('auth.totp_key_missing');
  expect(state.instance.pending.size).toBe(0);
  expect(state.instance.counts.totpWrites).toBe(0);
  expect(await journal(page)).toBeNull();
});
test('lost setup response allows explicit replacement while retaining original setup request', async ({ page, context }) => {
  let calls = 0;
  const state = await network(context, {
    'totp.enrol': async (route, input, _reply, actor) => {
      const result = await state.instance.call(actor, 'totp.enrol', input);
      if (++calls === 1) return fail(route);
      state.lastSetup = result.body.result.data;
      return route.fulfill({ status: result.status, json: result.body });
    },
  });
  await login(page);
  await auth(page).getByRole('button', { name: 'Start authenticator setup', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Start authenticator setup', exact: true }).click();
  await expect(prepUnknown(page)).toContainText('no authenticator confirmation was sent');
  await setup(page);
  expect(writeCount(state, 'totp.enrol')).toBe(2);
  expect(writeCount(state, 'totp.confirm')).toBe(0);
  expect((await journal(page)).filter((r) => r.state === 'sent').map((r) => r.kind)).toEqual(['setup']);
});
test('post-write confirm failure retains original uncertainty and blocks new setup', async ({ page, context }) => {
  const state = await network(context, { rankFail: true });
  await login(page);
  await setup(page);
  await confirm(page, production.totp(state.lastSetup.secret));
  await expect(unknown(page)).toContainText('Authenticator confirmation');
  expect(state.instance.counts.totpWrites).toBe(1);
  expect(state.instance.pending.size).toBe(0);
  await expect(auth(page).getByRole('button', { name: 'Review a new setup', exact: true })).toBeDisabled();
  await expect(auth(page).getByRole('button', { name: 'Confirm authenticator', exact: true })).toBeDisabled();
  await unknown(page).getByRole('link', { name: 'Contact Support', exact: true }).click();
  await page.goBack();
  await expect(unknown(page)).toContainText(owner);
  expect(writeCount(state, 'totp.confirm')).toBe(1);
});
test('actual invalid-code401 clears only original login and releases exact known-refused marker', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await setup(page);
  const valid = production.totp(state.lastSetup.secret);
  await confirm(page, valid === '000000' ? '000001' : '000000');
  await expect(page.locator('#main').getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  expect((await journal(page)).some((r) => r.kind === 'confirm')).toBe(false);
  await returnLogin(page);
  await expect(auth(page).getByRole('button', { name: 'Start authenticator setup', exact: true })).toBeVisible();
  expect(state.instance.counts.totpWrites).toBe(0);
});
test('same-owner real token refresh discards original secret before any confirmation', async ({ page, context }) => {
  const state = await network(context, { expiresAt: new Date(Date.now() + 33_000).toISOString() });
  await login(page);
  await setup(page);
  await auth(page).getByRole('button', { name: 'Show setup key', exact: true }).click();
  await expect.poll(() => state.sequence).toBe(2);
  await expect(auth(page).getByRole('textbox', { name: 'Authenticator setup key', exact: true })).toHaveCount(0);
  await expect(auth(page).getByRole('textbox', { name: 'Six-digit authenticator code', exact: true })).toHaveCount(0);
  expect(writeCount(state, 'totp.confirm')).toBe(0);
});
test('explicit new setup in another native-login tab invalidates older memory secret', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await setup(page);
  await auth(page).getByRole('button', { name: 'Show setup key', exact: true }).click();
  const second = await context.newPage();
  await login(second);
  await setup(second);
  await expect(auth(page).getByRole('textbox', { name: 'Authenticator setup key', exact: true })).toHaveCount(0);
  await expect(auth(page).getByRole('textbox', { name: 'Six-digit authenticator code', exact: true })).toHaveCount(0);
  expect(writeCount(state, 'totp.confirm')).toBe(0);
});
test('late old401 after native new actor sign-in cannot sign out newer session or show old secret', async ({ page, context }) => {
  const held = hold();
  const state = await network(context, {
    'totp.confirm': async (route, input, _reply, actor) => {
      const result = await state.instance.call(actor, 'totp.confirm', input);
      await held.promise;
      return route.fulfill({ status: result.status, json: result.body });
    },
  });
  await login(page);
  await setup(page);
  const valid = production.totp(state.lastSetup.secret);
  await confirm(page, valid === '000000' ? '000001' : '000000');
  await expect.poll(() => writeCount(state, 'totp.confirm')).toBe(1);
  await nativeSignOut(page);
  state.owner = other;
  await returnLogin(page);
  held.release();
  await expect(auth(page).getByRole('button', { name: 'Start authenticator setup', exact: true })).toBeVisible();
  await expect(page.locator('#main').getByRole('link', { name: 'Sign in', exact: true })).toHaveCount(0);
  await expect(auth(page).getByRole('textbox', { name: 'Authenticator setup key', exact: true })).toHaveCount(0);
  await expect.poll(async () => (await journal(page)).some((r) => r.kind === 'confirm')).toBe(false);
});
test('known global sign-out invokes only original principal and clears current memory login', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await global(page);
  await expect(page.locator('#main').getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  expect(writeCount(state, 'auth.logoutAll')).toBe(1);
  expect(state.instance.counts.seatWrites).toBe(1);
  expect(await journal(page)).toBeNull();
});
test('late known global reply cannot clear a newer native actor', async ({ page, context }) => {
  const held = hold();
  const state = await network(context, {
    'auth.logoutAll': async (route, input, _reply, actor) => {
      const result = await state.instance.call(actor, 'auth.logoutAll', input);
      await held.promise;
      return route.fulfill({ status: result.status, json: result.body });
    },
  });
  await login(page);
  await global(page);
  await expect.poll(() => writeCount(state, 'auth.logoutAll')).toBe(1);
  await nativeSignOut(page);
  state.owner = other;
  await returnLogin(page);
  held.release();
  await expect(keys(page).getByRole('button', { name: 'Add passkey', exact: true })).toBeVisible();
  await expect(page.locator('#main').getByRole('link', { name: 'Sign in', exact: true })).toHaveCount(0);
  expect((await journal(page)).map((r) => r.kind)).toEqual(['logout']);
});
test('unknown global sign-out preserves inspection and blocks seat/global replay', async ({ page, context }) => {
  const state = await network(context, { 'auth.logoutAll': (r) => fail(r) });
  await login(page);
  await global(page);
  await expect(unknown(page)).toContainText('Global sign-out');
  await expect(seats(page).getByRole('button', { name: 'Sign out session ' + seat, exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Sign out everywhere', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Refresh session inspection', exact: true }).click();
  await expect(seats(page)).toContainText(seat);
  expect(writeCount(state, 'revokeSession')).toBe(0);
  expect(writeCount(state, 'auth.logoutAll')).toBe(1);
});
test('unknown original seat journal survives a separate known global sign-out', async ({ page, context }) => {
  const state = await network(context, { revokeSession: (r) => fail(r) });
  await login(page);
  await seats(page)
    .getByRole('button', { name: 'Sign out session ' + seat, exact: true })
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sign out this session', exact: true }).click();
  await expect(seats(page)).toContainText('Original revoke is not confirmed');
  const before = await journal(page, seatKey);
  await global(page);
  await expect(page.locator('#main').getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  expect(await journal(page, seatKey)).toEqual(before);
  expect(writeCount(state, 'revokeSession')).toBe(1);
});
test('held child fresh-read excludes unsafe global dispatch under the same owner lock', async ({ page, context }) => {
  const held = hold();
  let reads = 0;
  const state = await network(context, {
    listSessions: async (_route, input, reply) => {
      if (++reads === 2) await held.promise;
      const value = await production.listSessions(state.instance.sql, input.userId, input.limit);
      return reply({ ...value, sessions: value.sessions.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })) });
    },
  });
  await login(page);
  await seats(page)
    .getByRole('button', { name: 'Sign out session ' + seat, exact: true })
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sign out this session', exact: true }).click();
  await expect.poll(() => reads).toBe(2);
  await global(page);
  await expect(page.locator('#main')).toContainText('Another tab is preparing');
  expect(writeCount(state, 'auth.logoutAll')).toBe(0);
  held.release();
  await expect.poll(() => writeCount(state, 'revokeSession')).toBe(1);
});
test('held global dispatch cancels same-view child review and excludes second native tab revoke', async ({ page, context }) => {
  const held = hold();
  const state = await network(context, {
    'auth.logoutAll': async (r) => {
      await held.promise;
      return fail(r);
    },
  });
  await login(page);
  const second = await context.newPage();
  await login(second);
  await global(page);
  await expect.poll(() => writeCount(state, 'auth.logoutAll')).toBe(1);
  await expect(seats(second).getByRole('button', { name: 'Sign out session ' + seat, exact: true })).toBeDisabled();
  expect(writeCount(state, 'revokeSession')).toBe(0);
  held.release();
  await expect(unknown(page)).toBeVisible();
});
for (const locale of ['es', 'fr'])
  test('original unknown and authored controls follow native View ' + locale, async ({ page, context }) => {
    const state = await network(context, { 'webauthn.remove': (r) => fail(r) });
    await login(page);
    await remove(page);
    await expect(unknown(page)).toBeVisible();
    const before = await journal(page);
    const view = await viewLocale(context, locale);
    await expect(page.getByRole('heading', { name: locale === 'es' ? 'Seguridad' : 'Sécurité', exact: true })).toBeVisible();
    const result = page.getByRole('region', {
      name: locale === 'es' ? 'No se recibió confirmación' : 'Confirmation non reçue',
      exact: true,
    });
    await expect(result).toContainText(credential);
    expect(await result.evaluate((node) => node.closest('[lang]')?.lang)).toBe(locale);
    expect(await journal(page)).toEqual(before);
    expect(writeCount(state, 'webauthn.remove')).toBe(1);
    await view.close();
    await shot(page, 'unknown-' + locale);
  });
for (const width of [320, 390, 768])
  test('whole Security composition has no overflow and keyboard actions stay above fixed doors at ' + width, async ({ page, context }) => {
    await network(context, { empty: true });
    await page.setViewportSize({ width, height: 844 });
    await login(page);
    await expect(keys(page)).toContainText('No passkeys yet');
    const measure = await page.evaluate(() => ({
      body: document.documentElement.scrollWidth,
      viewport: innerWidth,
      rail: getComputedStyle(document.querySelector('.rail')).display,
      doors: document.querySelector('.mobile-doors').getBoundingClientRect().top,
    }));
    expect(measure.body <= measure.viewport).toBe(true);
    const button = page.getByRole('button', { name: 'Sign out everywhere', exact: true });
    await button.focus();
    await page.keyboard.press('Tab');
    await button.focus();
    await expect
      .poll(async () =>
        button.evaluate((node) => {
          const r = node.getBoundingClientRect(),
            nav = document.querySelector('.mobile-doors').getBoundingClientRect();
          return r.bottom <= nav.top + 1 && r.top >= 0;
        }),
      )
      .toBe(true);
    await shot(page, 'whole-phone-' + width);
  });
test('Security native keyboard review and bounded accessibility scan', async ({ page, context }) => {
  await network(context);
  await login(page);
  const button = keys(page).getByRole('button', { name: 'Remove passkey ' + credential, exact: true });
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toContainText(credential);
  await page.keyboard.press('Escape');
  await expect(button).toBeFocused();
  const result = await new AxeBuilder({ page }).include('.security').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(result.violations.map((r) => ({ id: r.id, count: r.nodes.length }))).toEqual([]);
});
test('held removal fresh-read after native route departure sends no mutation or phantom guard', async ({ page, context }) => {
  const held = hold();
  let reads = 0;
  const state = await network(context, {
    'webauthn.list': async (_route, input, reply, actor) => {
      if (++reads === 2) await held.promise;
      return reply(await state.instance.auth.listWebauthnCredentials(actor, input.limit));
    },
  });
  await login(page);
  await remove(page);
  await expect.poll(() => reads).toBe(2);
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.getByRole('link', { name: 'View and language', exact: true }).click();
  held.release();
  await expect(page).toHaveURL(new URL('/view', test.info().project.use.baseURL).href);
  expect(writeCount(state, 'webauthn.remove')).toBe(0);
  expect(await journal(page)).toBeNull();
});
test('malformed removal response preserves exact original unknown', async ({ page, context }) => {
  const state = await network(context, { 'webauthn.remove': (_r, _i, reply) => reply({ removed: 'true' }) });
  await login(page);
  await remove(page);
  await expect(unknown(page)).toContainText(credential);
  expect((await journal(page)).map((r) => r.kind)).toEqual(['remove']);
  expect(writeCount(state, 'webauthn.remove')).toBe(1);
});
test('unsafe global result stays unknown instead of clearing login', async ({ page, context }) => {
  const state = await network(context, { 'auth.logoutAll': (_r, _i, reply) => reply({ revoked: 9007199254740992 }) });
  await login(page);
  await global(page);
  await expect(unknown(page)).toContainText('Global sign-out');
  await expect(keys(page)).toBeVisible();
  expect(writeCount(state, 'auth.logoutAll')).toBe(1);
});
test('real expired pending setup refusal401 has no invented countdown or MFA write', async ({ page, context }) => {
  const state = await network(context, { pendingTtl: -1 });
  await login(page);
  await setup(page);
  await expect(auth(page)).not.toContainText('minutes');
  await confirm(page, production.totp(state.lastSetup.secret));
  await expect(page.locator('#main').getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  expect(state.instance.counts.totpWrites).toBe(0);
  expect((await journal(page)).some((r) => r.kind === 'confirm')).toBe(false);
});
test('six-digit leading-zero code stays a string bound to original setup', async ({ page, context }) => {
  let bound = false;
  const state = await network(context, {
    'totp.confirm': (_r, input, reply) => {
      bound = input.code === '000123' && typeof input.code === 'string' && input.secret === state.lastSetup.secret;
      return reply({ ok: true });
    },
  });
  await login(page);
  await setup(page);
  await confirm(page, '000123');
  await expect(auth(page)).toContainText('service accepted');
  expect(bound).toBe(true);
});
test('known old setup response after native account switch reveals no secret in new actor', async ({ page, context }) => {
  const held = hold();
  const state = await network(context, {
    'totp.enrol': async (route, input, _reply, actor) => {
      const result = await state.instance.call(actor, 'totp.enrol', input);
      await held.promise;
      return route.fulfill({ status: result.status, json: result.body });
    },
  });
  await login(page);
  await auth(page).getByRole('button', { name: 'Start authenticator setup', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Start authenticator setup', exact: true }).click();
  await expect.poll(() => writeCount(state, 'totp.enrol')).toBe(1);
  await nativeSignOut(page);
  state.owner = other;
  await returnLogin(page);
  held.release();
  await expect(auth(page).getByRole('button', { name: 'Start authenticator setup', exact: true })).toBeVisible();
  await expect(auth(page).getByRole('textbox', { name: 'Authenticator setup key', exact: true })).toHaveCount(0);
  await expect(auth(page).getByRole('textbox', { name: 'Six-digit authenticator code', exact: true })).toHaveCount(0);
  expect(writeCount(state, 'totp.confirm')).toBe(0);
});

test('Spec2 regression older unknown stays uncertain while unrelated setup alone is Sending', async ({ page, context }) => {
  const held = hold();
  const state = await network(context, {
    'webauthn.remove': (r) => fail(r),
    'totp.enrol': async (route, input, _reply, actor) => {
      await held.promise;
      const result = await state.instance.call(actor, 'totp.enrol', input);
      return route.fulfill({ status: result.status, json: result.body });
    },
  });
  await login(page);
  await remove(page);
  await expect(unknown(page)).toBeVisible();
  const old = await journal(page);
  await auth(page).getByRole('button', { name: 'Start authenticator setup', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Start authenticator setup', exact: true }).click();
  await expect.poll(() => writeCount(state, 'totp.enrol')).toBe(1);
  const oldCard = page.locator('.security__unknown').filter({ hasText: credential });
  await expect(oldCard.getByRole('heading', { name: 'Confirmation not received', exact: true })).toBeVisible();
  await expect(oldCard.getByRole('heading', { name: 'Sending the original action', exact: true })).toHaveCount(0);
  await expect(
    page
      .locator('.security__unknown')
      .filter({ hasText: 'Authenticator setup' })
      .getByRole('heading', { name: 'Sending the original action', exact: true }),
  ).toBeVisible();
  expect((await journal(page)).find((r) => r.kind === 'remove')).toEqual(old[0]);
  held.release();
});
for (const [name, respond] of [
  ['raw400', (route) => route.fulfill({ status: 400, contentType: 'text/plain', body: 'opaque response' })],
  ['opaque403', (route) => route.fulfill({ status: 403, json: { error: { message: 'Isolated opaque refusal' } } })],
  ['unclassified401', (route) => route.fulfill({ status: 401, json: { error: { message: 'Isolated unclassified unauthorized' } } })],
  ['contradictoryTyped403', (route) => fail(route, 403, 'Isolated contradictory status', 'auth.not_found')],
  ['wrongKindTyped401', (route) => fail(route, 401, 'Isolated wrong action code', 'auth.mfa_invalid')],
  ['malformedTyped404', (route) => route.fulfill({ status: 404, json: { error: { data: { cause: { code: 'auth.not_found' } } } } })],
])
  test('Standards2 regression original ' + name + ' removal remains uncertain through return', async ({ page, context }) => {
    const state = await network(context, { 'webauthn.remove': respond });
    await login(page);
    await remove(page);
    await expect.poll(async () => (await journal(page))?.some((r) => r.kind === 'remove') ?? false).toBe(true);
    if (name === 'unclassified401' || name === 'wrongKindTyped401') {
      await expect(page.locator('#main').getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
      await returnLogin(page);
    } else {
      await unknown(page).getByRole('link', { name: 'Contact Support', exact: true }).click();
      await page.goBack();
    }
    await expect(unknown(page)).toContainText(credential);
    expect(writeCount(state, 'webauthn.remove')).toBe(1);
  });
test('source-verified missing owner404 is known before original credential removal', async ({ page, context }) => {
  const state = await network(context, {
    'webauthn.remove': async (route, input, _reply, actor) => {
      state.instance.users.delete(actor);
      const result = await state.instance.call(actor, 'webauthn.remove', input);
      return route.fulfill({ status: result.status, json: result.body });
    },
  });
  await login(page);
  await remove(page);
  await expect(page.locator('#main')).toContainText('auth.not_found');
  expect(await journal(page)).toBeNull();
  expect(state.instance.counts.credentialWrites).toBe(0);
  expect(writeCount(state, 'webauthn.remove')).toBe(1);
});
test('real invalid WebAuthn401 is pre-credential-write and clears only exact original marker', async ({ page, context }) => {
  const state = await network(context, {
    empty: true,
    'webauthn.registerVerify': async (route, input, _reply, actor) => {
      const client = JSON.parse(Buffer.from(input.response.clientDataJSON, 'base64url').toString());
      const invalid = {
        ...input,
        response: {
          ...input.response,
          clientDataJSON: Buffer.from(JSON.stringify({ ...client, origin: 'http://isolated-invalid-origin.invalid' })).toString(
            'base64url',
          ),
        },
      };
      const result = await state.instance.call(actor, 'webauthn.registerVerify', invalid);
      return route.fulfill({ status: result.status, json: result.body });
    },
  });
  await login(page);
  await virtual(context, page);
  await add(page);
  await expect(page.locator('#main').getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  await expect.poll(async () => (await journal(page))?.some((r) => r.kind === 'register') ?? false).toBe(false);
  expect(state.instance.counts.credentialWrites).toBe(0);
  expect(writeCount(state, 'webauthn.registerVerify')).toBe(1);
  await returnLogin(page);
  await expect(keys(page).getByRole('button', { name: 'Add passkey', exact: true })).toBeEnabled();
});
for (const target of ['replacementOriginalOwner', 'laterActor'])
  test('held known typed401 preserves ' + target + ' saved guard and later native session', async ({ page, context }) => {
    const held = hold();
    let replied = false;
    const state = await network(context, {
      'totp.confirm': async (route, input, _reply, actor) => {
        const result = await state.instance.call(actor, 'totp.confirm', input);
        await held.promise;
        await route.fulfill({ status: result.status, json: result.body });
        replied = true;
      },
    });
    await login(page);
    await setup(page);
    const valid = production.totp(state.lastSetup.secret);
    await confirm(page, valid === '000000' ? '000001' : '000000');
    await expect.poll(() => writeCount(state, 'totp.confirm')).toBe(1);
    const originalRecord = (await journal(page)).find((r) => r.kind === 'confirm');
    await nativeSignOut(page);
    state.owner = other;
    await returnLogin(page);
    const markerOwner = target === 'laterActor' ? other : owner;
    const replacement = { ...originalRecord, owner: markerOwner, requestId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' };
    // An isolated nonsecret valid replacement record stresses old-callback equality; no additional provider action is fabricated.
    const guardTab = await context.newPage();
    await login(guardTab);
    await guardTab.evaluate(({ key, record }) => localStorage.setItem(key, JSON.stringify([record])), {
      key: 'intafaced.customer.security.v1:' + markerOwner,
      record: replacement,
    });
    held.release();
    await expect.poll(() => replied).toBe(true);
    expect(await journal(page, 'intafaced.customer.security.v1:' + markerOwner)).toEqual([replacement]);
    if (target === 'laterActor') await expect(unknown(page)).toContainText(replacement.requestId);
    await expect(page.locator('#main').getByRole('link', { name: 'Sign in', exact: true })).toHaveCount(0);
    await expect(auth(page).getByRole('textbox', { name: 'Authenticator setup key', exact: true })).toHaveCount(0);
  });
test('actual post-write Rank port domain400 remains uncertain with consumed pending setup', async ({ page, context }) => {
  const state = await network(context, { rankDomainFail: true });
  await login(page);
  await setup(page);
  await confirm(page, production.totp(state.lastSetup.secret));
  await expect(unknown(page)).toContainText('Authenticator confirmation');
  await expect(page.locator('#main')).toContainText('isolated.rank.post_write_refusal');
  expect(state.instance.counts.totpWrites).toBe(1);
  expect(state.instance.pending.size).toBe(0);
  await expect(auth(page).getByRole('button', { name: 'Confirm authenticator', exact: true })).toBeDisabled();
  await expect(auth(page).getByRole('button', { name: 'Review a new setup', exact: true })).toBeDisabled();
  expect((await journal(page)).filter((r) => r.kind === 'confirm')).toHaveLength(1);
  expect(writeCount(state, 'totp.confirm')).toBe(1);
});

// Candidate 4: readiness is nonsecret and belongs only to the original current setup.
async function keyboardSetup(page) {
  await auth(page).getByRole('button', { name: 'Start authenticator setup', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('dialog').getByRole('button', { name: 'Start authenticator setup', exact: true }).focus();
  await page.keyboard.press('Enter');
}
const readyMessage = 'Authenticator setup is ready. Confirmation is still required.';
test('setup readiness announces only nonsecret preparation and continues keyboard focus', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  const announcement = auth(page).getByRole('status');
  await expect(announcement).toBeEmpty();
  const originalLiveNode = await announcement.elementHandle();
  await keyboardSetup(page);
  const heading = auth(page).getByRole('heading', { name: 'Continue this authenticator setup', exact: true });
  await expect(heading).toBeFocused();
  await expect(announcement).toHaveText(readyMessage);
  await expect(announcement).toHaveAttribute('aria-live', 'polite');
  await expect(announcement).toHaveAttribute('aria-atomic', 'true');
  expect(await originalLiveNode.evaluate((node) => node.isConnected && node === document.querySelector('.security__announcement'))).toBe(
    true,
  );
  expect(await announcement.evaluate((node, secret) => !node.textContent.includes(secret), state.lastSetup.secret)).toBe(true);
  expect(await announcement.evaluate((node, uri) => !node.textContent.includes(uri), state.lastSetup.uri)).toBe(true);
  expect(state.lastSetup.recoveryCodes.some((value) => readyMessage.includes(value))).toBe(false);
  expect(writeCount(state, 'totp.enrol')).toBe(1);
  expect(writeCount(state, 'totp.confirm')).toBe(0);
  expect((await journal(page)).map((record) => [record.owner, record.kind, record.state])).toEqual([[owner, 'setup', 'prepared']]);
  await page.keyboard.press('Tab');
  await expect(auth(page).getByRole('button', { name: 'Show setup key', exact: true })).toBeFocused();
});
test('held setup readiness preserves a user-selected read control and still announces readiness', async ({ page, context }) => {
  const held = hold();
  const state = await network(context, {
    'totp.enrol': async (route, input, _reply, actor) => {
      const result = await state.instance.call(actor, 'totp.enrol', input);
      state.lastSetup = result.body.result.data;
      await held.promise;
      return route.fulfill({ status: result.status, json: result.body });
    },
  });
  await login(page);
  await keyboardSetup(page);
  await expect.poll(() => writeCount(state, 'totp.enrol')).toBe(1);
  const chosen = keys(page).getByRole('button', { name: 'Refresh passkeys', exact: true });
  await expect(chosen).toBeEnabled();
  await chosen.focus();
  await page.keyboard.press('Enter');
  await expect(chosen).toBeFocused();
  held.release();
  await expect(auth(page).getByRole('status')).toHaveText(readyMessage);
  await expect(chosen).toBeFocused();
  await expect(auth(page).getByRole('heading', { name: 'Continue this authenticator setup', exact: true })).not.toBeFocused();
  expect(writeCount(state, 'totp.enrol')).toBe(1);
  expect(writeCount(state, 'totp.confirm')).toBe(0);
});
test('late old-owner setup cannot announce readiness or move focus in the new native session', async ({ page, context }) => {
  const held = hold();
  const state = await network(context, {
    'totp.enrol': async (route, input, _reply, actor) => {
      const result = await state.instance.call(actor, 'totp.enrol', input);
      await held.promise;
      return route.fulfill({ status: result.status, json: result.body });
    },
  });
  await login(page);
  await keyboardSetup(page);
  await expect.poll(() => writeCount(state, 'totp.enrol')).toBe(1);
  const saved = await journal(page);
  await nativeSignOut(page);
  state.owner = other;
  await returnLogin(page);
  const chosen = auth(page).getByRole('button', { name: 'Start authenticator setup', exact: true });
  await chosen.focus();
  held.release();
  await expect(auth(page).getByRole('status')).toBeEmpty();
  await expect(chosen).toBeFocused();
  await expect(auth(page).getByRole('heading', { name: 'Continue this authenticator setup', exact: true })).toHaveCount(0);
  await expect(auth(page).getByRole('textbox', { name: 'Six-digit authenticator code', exact: true })).toHaveCount(0);
  expect(await journal(page)).toEqual(saved);
  expect(await journal(page, 'intafaced.customer.security.v1:' + other)).toBeNull();
  expect(writeCount(state, 'totp.confirm')).toBe(0);
});
for (const locale of ['es', 'fr'])
  test('known setup readiness follows native View ' + locale + ' without changing the original setup', async ({ page, context }) => {
    const state = await network(context);
    await login(page);
    await keyboardSetup(page);
    await expect(auth(page).getByRole('status')).toHaveText(readyMessage);
    const saved = await journal(page);
    const view = await viewLocale(context, locale);
    const region = page.getByRole('region', {
      name: locale === 'es' ? 'Aplicación de autenticación' : 'Application d’authentification',
      exact: true,
    });
    const expected =
      locale === 'es'
        ? 'La configuración del autenticador está lista. Aún debes confirmarla.'
        : 'La configuration de l’authentificateur est prête. La confirmation reste nécessaire.';
    await expect(region.getByRole('status')).toHaveText(expected);
    await expect(region.getByRole('status').locator('span')).toHaveAttribute('lang', locale);
    await expect(
      region.getByRole('heading', {
        name: locale === 'es' ? 'Continuar esta configuración' : 'Continuer cette configuration',
        exact: true,
      }),
    ).toBeVisible();
    expect(await journal(page)).toEqual(saved);
    expect(writeCount(state, 'totp.enrol')).toBe(1);
    expect(writeCount(state, 'totp.confirm')).toBe(0);
    await view.close();
  });
for (const width of [320, 390, 768])
  test('ready continuation keyboard focus stays visible above phone doors at ' + width, async ({ page, context }) => {
    const state = await network(context, { empty: true });
    await page.setViewportSize({ width, height: 844 });
    await login(page);
    await keyboardSetup(page);
    const heading = auth(page).getByRole('heading', { name: 'Continue this authenticator setup', exact: true });
    await expect(heading).toBeFocused();
    await expect
      .poll(() =>
        heading.evaluate((node) => {
          const box = node.getBoundingClientRect(),
            doors = document.querySelector('.mobile-doors').getBoundingClientRect();
          return box.top >= 0 && box.bottom <= doors.top + 1 && document.documentElement.scrollWidth <= innerWidth;
        }),
      )
      .toBe(true);
    expect(await heading.evaluate((node) => getComputedStyle(node).outlineWidth)).toBe('2px');
    await expect(auth(page).getByRole('status')).toHaveText(readyMessage);
    await page.keyboard.press('Tab');
    const reveal = auth(page).getByRole('button', { name: 'Show setup key', exact: true });
    await expect(reveal).toBeFocused();
    await expect
      .poll(() =>
        reveal.evaluate((node) => {
          const box = node.getBoundingClientRect(),
            doors = document.querySelector('.mobile-doors').getBoundingClientRect();
          return box.top >= 0 && box.bottom <= doors.top + 1 && box.height >= 44;
        }),
      )
      .toBe(true);
    expect(writeCount(state, 'totp.enrol')).toBe(1);
    expect(writeCount(state, 'totp.confirm')).toBe(0);
    await shot(page, 'ready-phone-' + width);
  });
