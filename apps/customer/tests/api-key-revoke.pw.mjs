import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

// Ordinary App authentication and mounted HTTP shapes; all responses are
// isolated browser fixtures. This suite does not certify live SQL authority.
const baseURL = process.env.API_KEY_REVOKE_BASE_URL;
const evidence = process.env.API_KEY_REVOKE_EVIDENCE;
if (!baseURL || !evidence) throw new Error('Use the explicit verified-stage environment from the revoke config.');
mkdirSync(evidence, { recursive: true });
const ownerA = '11111111-1111-4111-8111-111111111111';
const ownerB = '22222222-2222-4222-8222-222222222222';
const keyA = '33333333-3333-4333-8333-333333333333';
const keyB = '44444444-4444-4444-8444-444444444444';
const localId = '55555555-5555-4555-8555-555555555555';
const record = {
  id: keyA,
  name: 'Notebook <reader> / propriétaire',
  prefix: 'if_live_f3a9',
  scopes: ['identity:read', 'arbitrary:opaque'],
  lastUsedAt: '2026-10-10T08:00:00.000Z',
  revoked: false,
  mode: 'live',
};
const storageKey = (owner = ownerA) => `intafaced.customer.api-key-revoke.v1:${owner}`;
const original = (owner = ownerA, keyId = keyA) => ({
  kind: 'api-key-revoke',
  owner,
  keyId,
  originalId: localId,
  createdAt: '2026-10-10T08:00:00.000Z',
});
const originalRaw = ` \n${JSON.stringify(original())}\n `;
const section = (page) => page.locator('.api-key-records');
const readButton = (page) => section(page).locator('.api-key-records__controls').getByRole('button');
const rows = (page) => section(page).locator('.api-key-records__row');
const row = (page, id = keyA) => rows(page).filter({ has: page.getByText(id, { exact: true }) });
const reviewButton = (page, id = keyA) => row(page, id).locator('.api-key-revoke__row-action');
const dialog = (page) => page.getByRole('dialog').filter({ has: page.locator('.api-key-revoke__review') });
const confirmButton = (page) => dialog(page).locator('.api-key-revoke__actions').getByRole('button').first();
const known = (page) => page.locator('.api-key-revoke--known');
const unknown = (page) => page.locator('.api-key-revoke--unknown');
const unavailable = (page) => page.locator('.api-key-revoke--unavailable');
const currentRead = (page) => page.locator('.api-key-revoke__current').getByRole('button');
const cleanupButton = (page) => known(page).getByRole('button');
const pause = () => {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

async function network(context) {
  const state = { owner: ownerA, token: 1, reads: [], keyReads: [], writes: [], unexpectedWrites: [], errors: [], cancelled: [] };
  state.list = async () => ({ status: 200, data: [record] });
  state.revoke = async () => ({ status: 200, data: { revoked: true } });
  const observe = (page) => page.on('pageerror', (error) => state.errors.push(error.message));
  context.pages().forEach(observe);
  context.on('page', observe);
  await context.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const procedure = decodeURIComponent(url.pathname.split('/').at(-1));
    const input = request.method() === 'GET' ? JSON.parse(url.searchParams.get('input') || 'null') : null;
    const reply = (data) => route.fulfill({ status: 200, json: { result: { data } } });
    if (procedure === 'auth.login')
      return reply({
        userId: state.owner,
        accessToken: `isolated-owner-key-token-${state.token}`,
        refreshToken: `isolated-owner-key-refresh-${state.token}`,
        expiresAt: '2027-10-10T08:00:00Z',
      });
    if (procedure === 'auth.logout') return reply({ ok: true });
    if (procedure === 'apiKeys.revoke') {
      state.writes.push({
        procedure,
        method: request.method(),
        path: url.pathname,
        body: request.postDataJSON(),
        idempotency: request.headers()['idempotency-key'] ?? null,
      });
      const answer = await state.revoke(state.writes.length);
      try {
        return await route.fulfill({
          status: answer.status,
          json:
            answer.status === 200
              ? { result: { data: answer.data } }
              : { error: { message: 'Isolated revoke refusal', data: { intafacedCode: answer.code ?? 'other.refusal' } } },
        });
      } catch (error) {
        state.cancelled.push(error.message);
        return;
      }
    }
    if (request.method() !== 'GET') {
      state.unexpectedWrites.push(procedure);
      return route.fulfill({ status: 503, json: { message: 'No unrelated fixture writes' } });
    }
    state.reads.push({ procedure, input });
    if (procedure === 'apiKeys.list') {
      state.keyReads.push({ input, path: url.pathname });
      const answer = await state.list(input, state.keyReads.length);
      try {
        return await route.fulfill({
          status: answer.status,
          json: answer.status === 200 ? { result: { data: answer.data } } : { message: 'Isolated current owner read refused' },
        });
      } catch (error) {
        state.cancelled.push(error.message);
        return;
      }
    }
    if (procedure === 'webauthn.list' || procedure === 'listSessions') return reply([]);
    return route.fulfill({ status: 503, json: { message: 'Isolated unrelated read unavailable' } });
  });
  return state;
}
async function scenario(browser, name, run, init = null) {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 }, timezoneId: 'UTC' });
  const state = await network(context);
  if (init) await context.addInitScript(init.fn, init.arg);
  const page = await context.newPage();
  try {
    await run({ page, context, state });
    expect(state.unexpectedWrites).toEqual([]);
    expect(state.errors).toEqual([]);
    expect(state.reads.some(({ procedure }) => /merchant|provider|company|pay\./i.test(procedure))).toBe(false);
  } finally {
    writeFileSync(
      `${evidence}/${name}.json`,
      JSON.stringify(state, (_key, value) => (typeof value === 'function' ? undefined : value), 2),
    );
    await context.close();
  }
}
async function login(page, destination = '/uc/safe', newDocument = true) {
  if (newDocument) await page.goto('/login?redirect=' + encodeURIComponent(destination));
  else await page.locator('a.button[href^="/login?redirect="]').click();
  await page.locator('input[name="identifier"]').fill('isolated-owner');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
  await expect.poll(() => page.evaluate(() => location.pathname + location.search + location.hash)).toBe(destination);
  if (destination.startsWith('/uc/safe')) await expect(section(page)).toBeVisible();
}
async function read(page, id = keyA) {
  await readButton(page).click();
  await expect(row(page, id)).toBeVisible();
}
async function review(page, id = keyA) {
  await reviewButton(page, id).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByText(id, { exact: true })).toBeVisible();
}
async function close(page, escape = false) {
  if (escape) await page.keyboard.press('Escape');
  else await dialog(page).locator('header').getByRole('button').click();
  await expect(dialog(page)).toHaveCount(0);
}
// Explicit retained-callback probes supplement actual pointer controls. They
// call the actual mounted handler and do not replace auth, context or locks.
async function capture(locator, name, event = 'onClick') {
  await locator.evaluate(
    (node, { name, event }) => {
      const key = Object.keys(node).find((candidate) => candidate.startsWith('__reactProps$'));
      if (!key || typeof node[key][event] !== 'function') throw new Error(`No actual ${event} handler on this control`);
      window[name] = node[key][event];
    },
    { name, event },
  );
}
const seed = (raw = originalRaw) => ({
  fn: ({ key, raw, origin }) => {
    if (location.origin !== origin) return;
    localStorage.setItem(key, raw);
  },
  arg: { key: storageKey(), raw, origin: new URL(baseURL).origin },
});
async function raw(page, owner = ownerA) {
  return page.evaluate(
    (key) => (window.revokeNativeStorage ? window.revokeNativeStorage.get.call(localStorage, key) : localStorage.getItem(key)),
    storageKey(owner),
  );
}
async function saved(page, owner = ownerA) {
  await expect.poll(() => raw(page, owner)).not.toBeNull();
  const value = await raw(page, owner);
  const decoded = JSON.parse(value);
  expect(Object.keys(decoded).sort()).toEqual(['createdAt', 'keyId', 'kind', 'originalId', 'owner']);
  expect(decoded).toMatchObject({ kind: 'api-key-revoke', owner, keyId: owner === ownerA ? keyA : keyB });
  expect(decoded.originalId).toMatch(/^[a-f0-9-]{36}$/);
  expect(new Date(decoded.createdAt).toISOString()).toBe(decoded.createdAt);
  expect(value).not.toContain(record.name);
  expect(value).not.toContain(record.prefix);
  expect(value).not.toContain('isolated-owner-key-token');
  return value;
}
function faultInit({ key, raw, fault, origin }) {
  if (location.origin !== origin) return;
  const native = { get: Storage.prototype.getItem, set: Storage.prototype.setItem, remove: Storage.prototype.removeItem };
  if (raw !== null) native.set.call(localStorage, key, raw);
  window.revokeNativeStorage = native;
  window.revokeFault = fault;
  let wrote = false;
  let removed = false;
  Storage.prototype.getItem = function (candidate) {
    if (candidate === key && (window.revokeFault === 'get' || (window.revokeFault === 'remove-readback' && removed)))
      throw new DOMException('Isolated getItem refusal', 'SecurityError');
    if (candidate === key && window.revokeFault === 'write-readback' && wrote) return null;
    return native.get.call(this, candidate);
  };
  Storage.prototype.setItem = function (candidate, value) {
    if (candidate === key && window.revokeFault === 'set') throw new DOMException('Isolated write refusal', 'QuotaExceededError');
    native.set.call(this, candidate, value);
    if (candidate === key) wrote = true;
  };
  Storage.prototype.removeItem = function (candidate) {
    if (candidate === key && window.revokeFault === 'remove') throw new DOMException('Isolated remove refusal', 'SecurityError');
    native.remove.call(this, candidate);
    if (candidate === key) removed = true;
  };
  if (fault === 'locks') Object.defineProperty(navigator, 'locks', { configurable: true, get: () => undefined });
}
const fault = (kind, raw = null) => ({ fn: faultInit, arg: { key: storageKey(), raw, fault: kind, origin: new URL(baseURL).origin } });
async function restore(page) {
  await page.evaluate(() => {
    window.revokeFault = null;
    delete navigator.locks;
  });
}
function wire(state, count = 1, keyId = keyA) {
  expect(state.writes).toHaveLength(count);
  for (const write of state.writes)
    expect(write).toEqual({
      procedure: 'apiKeys.revoke',
      method: 'POST',
      path: '/api/identity/trpc/apiKeys.revoke',
      body: { keyId },
      idempotency: null,
    });
}

test('exact immutable UUID review, minimal saved original and one current request prove true, false or typed scope refusal', async ({
  browser,
}) => {
  for (const [name, answer, heading] of [
    ['true', { status: 200, data: { revoked: true } }, 'Key marked revoked'],
    ['false', { status: 200, data: { revoked: false } }, 'No matching record changed'],
    ['scope', { status: 403, code: 'scope.denied' }, 'Revoke access refused'],
  ])
    await scenario(browser, `direct-${name}`, async ({ page, state }) => {
      const held = pause();
      state.list = async () => ({ status: 200, data: [record, { ...record, id: 'not-a-uuid' }, { ...record, id: keyB, revoked: true }] });
      state.revoke = async () => {
        await held.promise;
        return answer;
      };
      await login(page);
      expect(state.keyReads).toEqual([]);
      await read(page);
      await expect(row(page, 'not-a-uuid').getByRole('button')).toHaveCount(0);
      await expect(row(page, keyB).getByRole('button')).toHaveCount(0);
      await review(page);
      await expect(dialog(page).getByText(record.name, { exact: true })).toBeVisible();
      await capture(confirmButton(page), 'retiredConfirm');
      await confirmButton(page).click();
      await expect.poll(() => state.writes.length).toBe(1);
      const marker = await saved(page);
      await page.evaluate(() => window.retiredConfirm());
      wire(state);
      held.release();
      await expect(known(page).getByRole('heading', { name: heading, exact: true })).toBeVisible();
      await close(page, name === 'false');
      await expect.poll(() => raw(page)).toBeNull();
      await expect(cleanupButton(page)).toHaveCount(0);
      if (name === 'true')
        await expect(known(page).getByText('Previously issued access tokens may remain valid.', { exact: true })).toBeVisible();
      if (name === 'false')
        await expect(
          known(page).getByText('The response does not identify whether the key is absent, already revoked, or outside this account.', {
            exact: true,
          }),
        ).toBeVisible();
      state.savedOriginal = JSON.parse(marker);
      wire(state);
      if (name === 'true') {
        state.list = async () => ({ status: 200, data: [{ ...record, id: keyB }] });
        state.revoke = async () => ({ status: 503 });
        await read(page, keyB);
        await review(page, keyB);
        await confirmButton(page).click();
        await expect(unknown(page)).toBeVisible();
        await close(page);
        await expect(unknown(page).getByText(keyB, { exact: true })).toBeVisible();
        await expect(known(page)).toHaveCount(0);
        expect(JSON.parse(await raw(page)).keyId).toBe(keyB);
        expect(state.writes.map(({ body }) => body)).toEqual([{ keyId: keyA }, { keyId: keyB }]);
      }
    });
});

test('unverified response shapes and status/code pairs retain the original; 401 returns through real Login without replay', async ({
  browser,
}) => {
  for (const [name, answer] of [
    ['malformed', { status: 200, data: { revoked: true, extra: 'unverified' } }],
    ['generic403', { status: 403, code: 'FORBIDDEN' }],
    ['404', { status: 404, code: 'scope.denied' }],
    ['500', { status: 500, code: 'scope.denied' }],
    ['401', { status: 401, code: 'scope.denied' }],
  ])
    await scenario(browser, `uncertain-${name}`, async ({ page, state }) => {
      const destination = '/uc/safe?revoke=owner%2Bkey#exact-record';
      state.revoke = async () => answer;
      await login(page, destination);
      await read(page);
      await review(page);
      await confirmButton(page).click();
      await expect.poll(() => state.writes.length).toBe(1);
      const marker = await saved(page);
      if (name === '401') {
        await expect(section(page)).toHaveCount(0);
        await expect(page.locator('a.button[href^="/login?redirect="]')).toHaveAttribute(
          'href',
          '/login?redirect=' + encodeURIComponent(destination),
        );
        state.token = 2;
        await login(page, destination, false);
      } else await close(page);
      await expect(unknown(page)).toBeVisible();
      await expect(known(page)).toHaveCount(0);
      await expect(currentRead(page)).toBeEnabled();
      await currentRead(page).click();
      await expect(unknown(page).getByText('Exact target is not marked revoked.', { exact: true })).toBeVisible();
      expect(await raw(page)).toBe(marker);
      wire(state);
    });
});

test('real native Web Locks exclude a second owner tab and a closed sending tab leaves one shared unknown original', async ({
  browser,
}) => {
  await scenario(browser, 'concurrent-tabs-native-lock', async ({ page, context, state }) => {
    const other = await context.newPage();
    await login(page);
    await login(other);
    await read(page);
    await read(other);
    await review(page);
    await review(other);
    await page.evaluate((key) => {
      window.nativeLockHeld = false;
      window.nativeLockTask = navigator.locks.request(`intafaced.original:${key}`, async () => {
        window.nativeLockHeld = true;
        await new Promise((resolve) => {
          window.releaseNativeLock = resolve;
        });
      });
    }, storageKey());
    await expect.poll(() => page.evaluate(() => window.nativeLockHeld)).toBe(true);
    await confirmButton(other).click();
    await expect(
      dialog(other).getByText(
        'The request could not be admitted or its saved reference could not be verified. Read the saved state again before another revoke.',
        { exact: true },
      ),
    ).toBeVisible();
    expect(state.writes).toEqual([]);
    expect(await raw(other)).toBeNull();
    await close(other);
    await page.evaluate(async () => {
      window.releaseNativeLock();
      await window.nativeLockTask;
    });
    const held = pause();
    state.revoke = async () => {
      await held.promise;
      return { status: 200, data: { revoked: true } };
    };
    await confirmButton(page).click();
    await expect.poll(() => state.writes.length).toBe(1);
    const marker = await saved(page);
    await expect(unknown(other)).toBeVisible();
    await currentRead(other).click();
    await expect(unknown(other).getByText('Exact target is not marked revoked.', { exact: true })).toBeVisible();
    await page.close();
    held.release();
    expect(await raw(other)).toBe(marker);
    await expect(unknown(other)).toBeVisible();
    await expect(known(other)).toHaveCount(0);
    wire(state);
  });
});

test('getItem-only unreadability, malformed and foreign originals refuse revoke while owner GET stays usable', async ({ browser }) => {
  for (const [name, init, expected] of [
    ['get-only', fault('get', originalRaw), originalRaw],
    ['corrupt', seed(' {not-json '), ' {not-json '],
    ['foreign-owner', seed(JSON.stringify(original(ownerB))), JSON.stringify(original(ownerB))],
  ])
    await scenario(
      browser,
      `unreadable-${name}`,
      async ({ page, state }) => {
        await login(page);
        await expect(unavailable(page)).toBeVisible();
        await read(page);
        await expect(reviewButton(page)).toBeDisabled();
        expect(await raw(page)).toBe(expected);
        expect(state.writes).toEqual([]);
        if (name === 'get-only') {
          await restore(page);
          await unavailable(page).getByRole('button', { name: 'Retry local read', exact: true }).click();
          await expect(unknown(page)).toBeVisible();
          expect(await raw(page)).toBe(originalRaw);
          await expect(reviewButton(page)).toBeDisabled();
        }
      },
      init,
    );
});

test('write, readback and unavailable-lock admission failures make zero POSTs and preserve any written original', async ({ browser }) => {
  for (const name of ['set', 'write-readback', 'locks'])
    await scenario(
      browser,
      `admission-${name}`,
      async ({ page, state }) => {
        await login(page);
        await read(page);
        await review(page);
        if (name === 'locks')
          await page.evaluate(() => Object.defineProperty(navigator, 'locks', { configurable: true, get: () => undefined }));
        await confirmButton(page).click();
        await expect(
          dialog(page).getByText(
            'The request could not be admitted or its saved reference could not be verified. Read the saved state again before another revoke.',
            { exact: true },
          ),
        ).toBeVisible();
        expect(state.writes).toEqual([]);
        const marker = await raw(page);
        if (name === 'write-readback') expect(JSON.parse(marker).keyId).toBe(keyA);
        else expect(marker).toBeNull();
        await restore(page);
        await close(page);
        if (name === 'write-readback') {
          await expect(unknown(page)).toBeVisible();
          await expect(reviewButton(page)).toBeDisabled();
          expect(await raw(page)).toBe(marker);
        } else {
          await read(page);
          await review(page);
          await confirmButton(page).click();
          await expect(known(page)).toBeVisible();
          await close(page);
          wire(state);
        }
      },
      fault(name === 'locks' ? null : name),
    );
});

test('same-task full-query/hash ABA retires actual Review, Confirm and window handlers before a current pointer request succeeds', async ({
  browser,
}) => {
  await scenario(browser, 'retained-review-confirm-url-aba', async ({ page, state }) => {
    await login(page, '/uc/safe?revoke=original#record');
    await read(page);
    await capture(reviewButton(page), 'retiredReview');
    await capture(section(page).getByRole('combobox'), 'retiredWindow', 'onChange');
    await review(page);
    await capture(confirmButton(page), 'retiredConfirm');
    await page.evaluate(() => {
      const before = location.pathname + location.search + location.hash;
      history.pushState(null, '', '/uc/safe?revoke=departed#other');
      history.replaceState(null, '', before);
      window.retiredConfirm();
      window.retiredReview();
      window.retiredWindow({ target: { value: '150' } });
    });
    await expect(dialog(page)).toHaveCount(0);
    await expect(section(page).getByRole('combobox')).toHaveValue('50');
    expect(state.writes).toEqual([]);
    expect(await raw(page)).toBeNull();
    await read(page);
    await review(page);
    await confirmButton(page).click();
    await expect(known(page)).toBeVisible();
    await close(page);
    wire(state);
  });
});

test('held late Response.text after Close and window/context retirement cannot turn an unknown into proof or replay', async ({
  browser,
}) => {
  await scenario(browser, 'held-text-close-window', async ({ page, state }) => {
    await page.addInitScript(() => {
      const nativeFetch = window.fetch;
      window.fetch = async (...args) => {
        const response = await nativeFetch(...args);
        if (String(args[0]).includes('/api/identity/trpc/apiKeys.revoke')) {
          const text = response.text.bind(response);
          response.text = async () => {
            const body = await text();
            window.revokeTextHeld = true;
            await new Promise((resolve) => {
              window.releaseRevokeText = resolve;
            });
            return body;
          };
        }
        return response;
      };
    });
    await login(page);
    await read(page);
    await review(page);
    await capture(confirmButton(page), 'retiredConfirm');
    await confirmButton(page).click();
    await expect.poll(() => page.evaluate(() => !!window.revokeTextHeld)).toBe(true);
    const marker = await saved(page);
    await close(page, true);
    await section(page).getByRole('combobox').selectOption('100');
    await page.evaluate(() => {
      window.retiredConfirm();
      window.releaseRevokeText();
    });
    await expect(unknown(page)).toBeVisible();
    await expect(known(page)).toHaveCount(0);
    await currentRead(page).click();
    await expect(unknown(page).getByText('Exact target is not marked revoked.', { exact: true })).toBeVisible();
    expect(state.keyReads.at(-1).input).toEqual({ limit: 100 });
    expect(await raw(page)).toBe(marker);
    wire(state);
    await page.locator('.person-trigger').click();
    await page.getByRole('dialog').locator('a[href="/view"]').click();
    await expect(section(page)).toHaveCount(0);
    await page.locator('.person-trigger').click();
    await page.getByRole('dialog').locator('a[href="/uc/safe"]').click();
    await expect(unknown(page)).toBeVisible();
    await expect(known(page)).toHaveCount(0);
    await page.evaluate(() => window.retiredConfirm());
    wire(state);
  });
});

test('actual same-task signout retires Review/Confirm across same-owner new sessions and a different owner/API', async ({ browser }) => {
  for (const nextOwner of [ownerA, ownerB])
    await scenario(browser, `retained-session-${nextOwner === ownerA ? 'same' : 'other'}`, async ({ page, state }) => {
      await login(page);
      await read(page);
      const timeOrigin = await page.evaluate(() => performance.timeOrigin);
      await capture(reviewButton(page), 'retiredReview');
      await page.locator('.person-trigger').click();
      await capture(page.getByRole('button', { name: 'Sign out', exact: true }), 'actualSignOut');
      await page.keyboard.press('Escape');
      await review(page);
      await capture(confirmButton(page), 'retiredConfirm');
      await page.evaluate(() => {
        window.actualSignOut();
        window.retiredConfirm();
        window.retiredReview();
      });
      await expect(section(page)).toHaveCount(0);
      expect(state.writes).toEqual([]);
      expect(await raw(page)).toBeNull();
      state.owner = nextOwner;
      state.token = 2;
      const target = nextOwner === ownerA ? keyA : keyB;
      state.list = async () => ({ status: 200, data: [{ ...record, id: target }] });
      await login(page, '/uc/safe', false);
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
      await page.evaluate(() => {
        window.retiredConfirm();
        window.retiredReview();
      });
      expect(state.writes).toEqual([]);
      await read(page, target);
      await review(page, target);
      await confirmButton(page).click();
      await expect(known(page)).toBeVisible();
      await close(page);
      wire(state, 1, target);
    });
});

test('exact current row states, different IDs and bounded absence never settle a saved attempt; retired window reads cannot publish', async ({
  browser,
}) => {
  await scenario(
    browser,
    'current-state-is-not-settlement',
    async ({ page, state }) => {
      await login(page);
      await expect(unknown(page)).toBeVisible();
      for (const [data, text] of [
        [[{ ...record, revoked: true }], 'Exact target is marked revoked.'],
        [[record], 'Exact target is not marked revoked.'],
        [[{ ...record, id: keyB, revoked: true }], 'Exact target was not returned in this read window.'],
        [[], 'Exact target was not returned in this read window.'],
      ]) {
        state.list = async () => ({ status: 200, data });
        await currentRead(page).click();
        await expect(unknown(page).getByText(text, { exact: true })).toBeVisible();
        expect(await raw(page)).toBe(originalRaw);
        await expect(known(page)).toHaveCount(0);
        expect(state.writes).toEqual([]);
      }
      state.list = async () => ({ status: 200, data: [{ ...record, revoked: 'unverified' }] });
      await currentRead(page).click();
      await expect(unknown(page).getByText('Exact target was not returned in this read window.', { exact: true })).toHaveCount(0);
      await expect(unknown(page).getByText('Exact target is marked revoked.', { exact: true })).toHaveCount(0);
      await expect(currentRead(page)).toBeEnabled();
      const held = pause();
      state.list = async () => {
        await held.promise;
        return { status: 200, data: [{ ...record, revoked: true }] };
      };
      await capture(currentRead(page), 'retiredCurrent');
      const before = state.keyReads.length;
      await currentRead(page).click();
      await expect(currentRead(page)).toBeDisabled();
      await expect.poll(() => state.keyReads.length).toBe(before + 1);
      await page.evaluate(() => window.retiredCurrent());
      const count = before + 1;
      expect(state.keyReads).toHaveLength(count);
      await section(page).getByRole('combobox').selectOption('100');
      await page.evaluate(() => window.retiredCurrent());
      expect(state.keyReads).toHaveLength(count);
      state.list = async () => ({ status: 200, data: [record] });
      await currentRead(page).click();
      await expect(unknown(page).getByText('Exact target is not marked revoked.', { exact: true })).toBeVisible();
      held.release();
      await expect(unknown(page).getByText('Exact target is marked revoked.', { exact: true })).toHaveCount(0);
      expect(state.keyReads.at(-1).input).toEqual({ limit: 100 });
      expect(await raw(page)).toBe(originalRaw);
      expect(state.writes).toEqual([]);
    },
    seed(),
  );
});

test('known cleanup remains reachable after Close/Escape without POST; reload loses private proof and replacements are never deleted', async ({
  browser,
}) => {
  for (const name of ['remove', 'remove-readback'])
    await scenario(
      browser,
      `cleanup-${name}`,
      async ({ page, state }) => {
        await login(page);
        await read(page);
        await review(page);
        await confirmButton(page).click();
        await expect(known(page).getByRole('heading', { name: 'Saved request could not be cleared', exact: true })).toBeVisible();
        await close(page, name === 'remove-readback');
        await expect(cleanupButton(page)).toBeEnabled();
        await cleanupButton(page).scrollIntoViewIfNeeded();
        await restore(page);
        await cleanupButton(page).click();
        await expect(cleanupButton(page)).toHaveCount(0);
        expect(await raw(page)).toBeNull();
        wire(state);
      },
      fault(name),
    );
  await scenario(
    browser,
    'cleanup-reload-proof-loss',
    async ({ page, state }) => {
      await login(page);
      await read(page);
      await review(page);
      await confirmButton(page).click();
      await expect(cleanupButton(page)).toBeVisible();
      await close(page);
      const marker = await saved(page);
      await page.reload();
      await expect(section(page)).toHaveCount(0);
      state.token = 2;
      await login(page, '/uc/safe', false);
      await expect(unknown(page)).toBeVisible();
      await expect(known(page)).toHaveCount(0);
      expect(await raw(page)).toBe(marker);
      wire(state);
    },
    fault('remove'),
  );
  await scenario(
    browser,
    'cleanup-exact-replacement-guard',
    async ({ page, state }) => {
      await login(page);
      await read(page);
      await review(page);
      await confirmButton(page).click();
      await expect(cleanupButton(page)).toBeVisible();
      await close(page);
      await capture(cleanupButton(page), 'retiredCleanup');
      await restore(page);
      const replacement = JSON.stringify({ ...original(), originalId: '66666666-6666-4666-8666-666666666666' });
      await page.evaluate(
        ({ key, replacement }) => {
          localStorage.setItem(key, replacement);
          window.retiredCleanup();
        },
        { key: storageKey(), replacement },
      );
      expect(await raw(page)).toBe(replacement);
      wire(state);
    },
    fault('remove'),
  );
});

test('actual View EN/ES/FR and Arabic fallback keep opaque review and known cleanup usable at320/390/desktop', async ({ browser }) => {
  const labels = {
    en: { review: 'Review revoke', confirm: 'Confirm revoke', marked: 'Key marked revoked' },
    es: { review: 'Revisar revocación', confirm: 'Confirmar revocación', marked: 'Clave marcada como revocada' },
    fr: { review: 'Examiner la révocation', confirm: 'Confirmer la révocation', marked: 'Clé marquée comme révoquée' },
    ar: { review: 'Review revoke', confirm: 'Confirm revoke', marked: 'Key marked revoked' },
  };
  for (const [locale, width] of [
    ['en', 320],
    ['es', 390],
    ['fr', 320],
    ['fr', 1440],
    ['ar', 390],
  ])
    await scenario(
      browser,
      `locale-${locale}-${width}`,
      async ({ page, state }) => {
        const long = {
          ...record,
          name: 'Opaque <script> propriétaire / ' + 'name-'.repeat(12),
          prefix: 'if_live_' + 'abcdef'.repeat(16),
          scopes: ['identity:read', 'arbitrary:scope/' + 'x'.repeat(100)],
        };
        state.list = async () => ({ status: 200, data: [long] });
        await page.setViewportSize({ width, height: 1000 });
        await login(page, '/view');
        await page
          .locator('select')
          .filter({ has: page.locator('option[value="ar"]') })
          .selectOption(locale);
        await page.locator('.person-trigger').click();
        await page.getByRole('dialog').locator('a[href="/uc/safe"]').click();
        await read(page);
        const button = reviewButton(page);
        await expect(button).toHaveText(labels[locale].review);
        await button.focus();
        await page.keyboard.press('Enter');
        await expect(dialog(page)).toBeVisible();
        await expect(dialog(page).getByText(long.id, { exact: true })).toBeVisible();
        await expect(dialog(page).getByText(long.name, { exact: true })).toBeVisible();
        await expect(dialog(page).getByText(long.prefix, { exact: true })).toBeVisible();
        const confirm = confirmButton(page);
        await expect(confirm).toHaveText(labels[locale].confirm);
        await page.keyboard.press('Tab');
        await expect(confirm).toBeFocused();
        await confirm.scrollIntoViewIfNeeded();
        const bounds = await dialog(page).evaluate((node) => {
          const button = node.querySelector('.api-key-revoke__actions button');
          const rect = button.getBoundingClientRect();
          const label = button.querySelector('[data-i18n]');
          return {
            width: innerWidth,
            height: innerHeight,
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            buttonHeight: rect.height,
            scroll: document.documentElement.scrollWidth,
            client: document.documentElement.clientWidth,
            labelLanguage: label.lang,
            labelDirection: label.dir,
            opaqueLanguages: [...node.querySelectorAll('bdi')].map((value) => value.lang),
          };
        });
        expect(bounds.scroll).toBeLessThanOrEqual(bounds.client);
        expect(bounds.left).toBeGreaterThanOrEqual(0);
        expect(bounds.right).toBeLessThanOrEqual(width);
        expect(bounds.top).toBeGreaterThanOrEqual(0);
        expect(bounds.bottom).toBeLessThanOrEqual(1000);
        expect(bounds.buttonHeight).toBeGreaterThanOrEqual(44);
        expect(bounds.labelLanguage).toBe(locale === 'ar' ? 'en' : locale);
        expect(bounds.labelDirection).toBe('ltr');
        expect(bounds.opaqueLanguages.every((language) => language === 'und')).toBe(true);
        state.geometry = bounds;
        await dialog(page).screenshot({ path: `${evidence}/review-${locale}-${width}.png` });
        await confirm.click();
        await expect(known(page).getByRole('heading', { name: labels[locale].marked, exact: true })).toBeVisible();
        await close(page);
        await expect(cleanupButton(page)).toBeEnabled();
        await cleanupButton(page).scrollIntoViewIfNeeded();
        await restore(page);
        await cleanupButton(page).click();
        await expect(cleanupButton(page)).toHaveCount(0);
        expect(await raw(page)).toBeNull();
        expect(await page.evaluate((name) => Object.values(localStorage).some((value) => value.includes(name)), long.name)).toBe(false);
        wire(state);
      },
      fault('remove'),
    );
});

test('four-key320/1440 Close and Escape arrive at visible current outcomes; deliberate Refresh and retired focus handlers preserve the next journey', async ({
  browser,
}) => {
  for (const width of [320, 1440]) {
    for (const channel of ['pointer', 'escape']) {
      await scenario(browser, `multi-key-arrival-${width}-${channel}`, async ({ page, state }) => {
        const records = [keyA, keyB, '77777777-7777-4777-8777-777777777777', '88888888-8888-4888-8888-888888888888'].map((id, index) => ({
          ...record,
          id,
          name: `Notebook reader ${index}`,
          prefix: `${record.prefix}_${index}`,
          lastUsedAt: null,
        }));
        state.list = async () => ({ status: 200, data: records });
        await page.setViewportSize({ width, height: 1000 });
        await login(page, '/uc/safe?revoke=owner%2Bkey#original');
        await read(page);
        await expect(rows(page)).toHaveCount(4);
        // Pre-effect cancellation keeps normal source focus and writes nothing.
        await review(page);
        await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(dialog(page)).toHaveCount(0);
        await expect(reviewButton(page)).toBeFocused();
        expect(state.writes).toEqual([]);
        expect(await raw(page)).toBeNull();
        await review(page);
        await confirmButton(page).click();
        await expect(known(page)).toBeVisible();
        await expect(dialog(page).locator('.api-key-revoke__actions').getByRole('button')).toHaveCount(1);
        await capture(dialog(page).locator('header').getByRole('button'), 'retiredDoneClose');
        await close(page, channel === 'escape');
        const heading = known(page).locator('.api-key-revoke__outcome-heading');
        // No test scroll/focus call supplies this arrival proof.
        await expect(heading).toBeFocused();
        const measure = async (locator) =>
          locator.evaluate((node) => {
            const rect = node.getBoundingClientRect();
            const nav = document.querySelector('.mobile-doors');
            const navRect = nav?.getBoundingClientRect();
            const navVisible = nav && getComputedStyle(nav).display !== 'none' && navRect.height > 0;
            return {
              top: rect.top,
              bottom: rect.bottom,
              left: rect.left,
              right: rect.right,
              viewport: innerHeight,
              clearBottom: navVisible ? navRect.top : innerHeight,
              focused: document.activeElement === node,
            };
          });
        const resultGeometry = await measure(heading);
        expect(resultGeometry.focused).toBe(true);
        expect(resultGeometry.top).toBeGreaterThanOrEqual(0);
        expect(resultGeometry.bottom).toBeLessThanOrEqual(resultGeometry.clearBottom);
        expect(resultGeometry.left).toBeGreaterThanOrEqual(0);
        expect(resultGeometry.right).toBeLessThanOrEqual(width);
        await expect(known(page).getByText('Refresh records before reviewing another revoke.', { exact: true })).toBeVisible();
        await expect(section(page).locator('.api-key-revoke__row-action')).toHaveCount(4);
        for (const button of await section(page).locator('.api-key-revoke__row-action').all()) await expect(button).toBeDisabled();
        expect(state.keyReads).toHaveLength(1);
        wire(state);
        expect(await raw(page)).toBeNull();
        await page.screenshot({ path: `${evidence}/arrival-${width}-${channel}.png` });
        state.geometry = { known: resultGeometry };
        // Only this actual explicit Refresh admits the new receipt/review.
        state.list = async () => ({ status: 200, data: records.map((value) => ({ ...value, revoked: value.id === keyA })) });
        await read(page, keyB);
        expect(state.keyReads).toHaveLength(2);
        await expect(row(page).getByRole('button')).toHaveCount(0);
        await review(page, keyB);
        const freshHeader = dialog(page).locator('header').getByRole('button');
        await expect(freshHeader).toBeFocused();
        await page.evaluate(() => window.retiredDoneClose());
        await expect(freshHeader).toBeFocused();
        await expect(dialog(page)).toBeVisible();
        wire(state);
        const held = pause();
        state.revoke = async () => {
          await held.promise;
          return { status: 200, data: { revoked: true } };
        };
        await confirmButton(page).click();
        await expect.poll(() => state.writes.length).toBe(2);
        await capture(dialog(page).locator('header').getByRole('button'), 'retiredSendingClose');
        const marker = await raw(page);
        expect(JSON.parse(marker).keyId).toBe(keyB);
        await close(page, channel !== 'escape');
        const unknownHeading = unknown(page).locator('.api-key-revoke__outcome-heading');
        await expect(unknownHeading).toBeFocused();
        const unknownGeometry = await measure(unknownHeading);
        expect(unknownGeometry.top).toBeGreaterThanOrEqual(0);
        expect(unknownGeometry.bottom).toBeLessThanOrEqual(unknownGeometry.clearBottom);
        held.release();
        await expect(known(page)).toHaveCount(0);
        expect(await raw(page)).toBe(marker);
        expect(state.keyReads).toHaveLength(2);
        expect(state.writes.map(({ body }) => body)).toEqual([{ keyId: keyA }, { keyId: keyB }]);
        state.geometry.unknown = unknownGeometry;
        await page.locator('.person-trigger').click();
        await page.getByRole('dialog').locator('a[href="/view"]').click();
        const locale = page.locator('select').filter({ has: page.locator('option[value="ar"]') });
        await locale.click();
        await page.keyboard.press('Escape');
        await expect(locale).toBeFocused();
        await page.evaluate(() => {
          window.retiredDoneClose();
          window.retiredSendingClose();
        });
        await expect(locale).toBeFocused();
        await expect(section(page)).toHaveCount(0);
        expect(await raw(page)).toBe(marker);
        if (width === 1440 && channel === 'escape') {
          await page.locator('.person-trigger').click();
          await page.getByRole('button', { name: 'Sign out', exact: true }).click();
          state.owner = ownerB;
          state.token = 2;
          await login(page, '/view', false);
          await page.locator('.person-trigger').click();
          await page.getByRole('dialog').locator('a[href="/uc/safe"]').click();
          await read(page, keyB);
          await review(page, keyB);
          const ownerHeader = dialog(page).locator('header').getByRole('button');
          await expect(ownerHeader).toBeFocused();
          await page.evaluate(() => {
            window.retiredDoneClose();
            window.retiredSendingClose();
          });
          await expect(ownerHeader).toBeFocused();
          await expect(dialog(page)).toBeVisible();
          await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
          await expect(reviewButton(page, keyB)).toBeFocused();
          expect(await raw(page, ownerB)).toBeNull();
          expect(await raw(page)).toBe(marker);
          expect(state.writes).toHaveLength(2);
        }
      });
    }
  }
});
