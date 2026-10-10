import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
const evidence = process.env.SEND_CONTEXT_EVIDENCE;
mkdirSync(evidence, { recursive: true });
const summaries = [];
const errors = new WeakMap();
test.beforeEach(({ page }) => {
  const list = [];
  errors.set(page, list);
  page.on('pageerror', () => list.push(true));
});
test.afterEach(({ page }, info) => {
  expect(errors.get(page).length).toBe(0);
  summaries.push({ name: info.title, status: info.status, pageErrors: errors.get(page).length });
});
test.afterAll(() => writeFileSync(evidence + '/native-summary.json', JSON.stringify(summaries, null, 2)));
const userId = '11111111-1111-4111-8111-111111111111';
const recipient = '33333333-3333-4333-8333-333333333333';
const usdcId = '22222222-2222-4222-8222-222222222222';
const usdtId = '44444444-4444-4444-8444-444444444444';
const amount = '0.000000000000000001';
const source = (id, assetId) => ({
  id,
  assetId,
  kind: 'primary',
  name: 'Main',
  goalTarget: null,
  lockedUntil: null,
  balance: '9999999999999999999.000000000000000001',
  ledgerAccount: { ownerType: 'user', ownerId: userId, assetId, kind: 'bank:primary' },
});
const reply = (route, data) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data } }) });
async function setup(page, options = {}) {
  const state = { posts: [], reads: 0, unexpected: 0, held: null, actor: userId };
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      procedure = new URL(request.url()).pathname.split('/').at(-1);
    if (procedure === 'auth.logout') return reply(route, { ok: true });
    if (procedure === 'auth.login')
      return reply(route, {
        userId: state.actor,
        accessToken: 'isolated-native-send',
        refreshToken: 'isolated-native-refresh',
        expiresAt: '2027-10-08T00:00:00Z',
      });
    if (procedure === 'spaces.list') {
      state.reads++;
      if (options.sources) return options.sources(route, state);
      return reply(
        route,
        [source(usdcId, 'USDC'), source(usdtId, 'USDT')].map((row) => ({
          ...row,
          ledgerAccount: { ...row.ledgerAccount, ownerId: state.actor },
        })),
      );
    }
    if (options.p2p && procedure.startsWith('offers.')) return options.p2p(route, state, procedure);
    if (options.p2p && procedure === 'fiat.list') return reply(route, []);
    if (procedure === 'transfers.toUser') {
      state.posts.push(request.postDataJSON());
      if (options.transfer) return options.transfer(route, state);
      return reply(route, { ledgerTxId: 'isolated-original-ledger', amount: state.posts.at(-1).amount });
    }
    if (request.method() === 'POST') state.unexpected++;
    return route.fulfill({ status: 503, json: { error: { message: 'Isolated unavailable' } } });
  });
  await page.goto('/login?redirect=' + encodeURIComponent('/pay/send?asset=USDC'));
  await page.getByLabel('Email or handle', { exact: true }).fill('send@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('isolated-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('input[name="recipient"]')).toBeVisible();
  return state;
}
async function review(page, value = amount) {
  await page.locator('input[name="recipient"]').fill(recipient);
  await page.locator('input[name="send-amount"]').fill(value);
  await page.locator('form.pay-form button[type="submit"]').click();
  await expect(page.getByRole('dialog')).toBeVisible();
}
async function navigation(page, kind = 'query') {
  return page.evaluate((kind) => {
    const original = location.href;
    const oldForm = document.querySelector('form.pay-form');
    const oldConfirm = document.querySelector('.pay-transfer-actions button:last-child');
    const next = new URL(original);
    if (kind === 'query' || kind === 'mixed') next.searchParams.set('asset', 'USDT');
    if (kind === 'hash' || kind === 'mixed') next.hash = 'other';
    history.replaceState(null, '', kind === 'same' ? original : next.href);
    dispatchEvent(new PopStateEvent('popstate'));
    if (kind !== 'same') {
      history.replaceState(null, '', original);
      dispatchEvent(new PopStateEvent(kind === 'hash' ? 'hashchange' : 'popstate'));
    }
    const privateRemovedSynchronously =
      !document.querySelector('dialog') && !document.body.textContent.includes('33333333-3333-4333-8333-333333333333');
    oldConfirm?.click();
    oldForm?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return { privateRemovedSynchronously };
  }, kind);
}
test('observed query departure and return discards original review before retained controls dispatch', async ({ page }) => {
  const state = await setup(page);
  await review(page);
  expect((await navigation(page)).privateRemovedSynchronously).toBe(true);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(state.posts.length).toBe(0);
  expect(state.unexpected).toBe(0);
  await expect(page.locator('input[name="recipient"]')).toHaveValue('');
  await review(page);
  await page.locator('.pay-transfer-actions button:last-child').click();
  await expect(page.getByRole('heading', { name: 'Transfer confirmed', exact: true })).toBeVisible();
  expect(state.posts.length).toBe(1);
});
test('same full URL retains legitimate original review and exact one dispatch', async ({ page }) => {
  const state = await setup(page);
  await review(page);
  await navigation(page, 'same');
  await expect(page.getByRole('heading', { name: 'Transfer confirmed', exact: true })).toBeVisible();
  expect(state.posts.length).toBe(1);
  expect(state.posts[0].amount === amount).toBe(true);
  expect(state.unexpected).toBe(0);
});

for (const kind of ['hash', 'mixed'])
  test('observed ' + kind + ' ABA removes private review and fresh Send remains usable', async ({ page }) => {
    const state = await setup(page);
    await review(page);
    expect((await navigation(page, kind)).privateRemovedSynchronously).toBe(true);
    await expect(page.locator('input[name="recipient"]')).toHaveValue('');
    expect(state.posts.length).toBe(0);
    await review(page);
    await page.locator('.pay-transfer-actions button:last-child').click();
    await expect(page.getByRole('heading', { name: 'Transfer confirmed', exact: true })).toBeVisible();
    expect(state.posts.length).toBe(1);
  });
async function journal(page) {
  return page.evaluate((userId) => localStorage.getItem('pay.unresolved:' + userId + ':send'), userId);
}
test('held fresh source read cannot save or dispatch a discarded review and late settlement cannot clobber a new action', async ({
  page,
}) => {
  let release;
  const state = await setup(page, {
    sources: async (route, state) => {
      if (state.reads === 2)
        await new Promise((resolve) => {
          release = resolve;
        });
      return reply(route, [source(usdcId, 'USDC'), source(usdtId, 'USDT')]);
    },
  });
  await review(page);
  await page.locator('.pay-transfer-actions button:last-child').click();
  await expect.poll(() => Boolean(release)).toBe(true);
  expect((await navigation(page, 'mixed')).privateRemovedSynchronously).toBe(true);
  await expect(page.locator('input[name="recipient"]')).toHaveValue('');
  await review(page, '9999999999999999999.000000000000000001');
  release();
  await page.locator('.pay-transfer-actions button:last-child').click();
  await expect(page.getByRole('heading', { name: 'Transfer confirmed', exact: true })).toBeVisible();
  expect(state.posts.length).toBe(1);
  expect(state.posts[0].amount === '9999999999999999999.000000000000000001').toBe(true);
  expect(await journal(page)).toBe(null);
  expect(state.unexpected).toBe(0);
});
for (const outcome of ['known', 'unknown', 'malformed'])
  test('departed dispatched ' + outcome + ' response retains original minimal journal byte for byte', async ({ page }) => {
    let release;
    const state = await setup(page, {
      transfer: async (route, state) => {
        await new Promise((resolve) => {
          release = resolve;
        });
        if (outcome === 'unknown') return route.fulfill({ status: 503, json: { error: 'Isolated unknown' } });
        return reply(route, { ledgerTxId: 'isolated-original-ledger', amount: outcome === 'malformed' ? '2' : state.posts[0].amount });
      },
    });
    await review(page);
    await page.locator('.pay-transfer-actions button:last-child').click();
    await expect.poll(() => state.posts.length).toBe(1);
    const bytes = await journal(page);
    expect(Boolean(bytes)).toBe(true);
    expect(Object.keys(JSON.parse(bytes)).sort()).toEqual(['reference', 'status']);
    await navigation(page, 'hash');
    release();
    await expect(page.getByRole('heading', { name: 'Original transfer is unresolved', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Transfer confirmed', exact: true })).toHaveCount(0);
    expect((await journal(page)) === bytes).toBe(true);
    await page.locator('input[name="recipient"]').fill(recipient);
    await page.locator('input[name="send-amount"]').fill(amount);
    await expect(page.locator('form.pay-form button[type="submit"]')).toBeDisabled();
    expect(state.posts.length).toBe(1);
  });
for (const mode of ['failed', 'empty'])
  test('current confirmed receipt survives ' + mode + ' refreshed source reads', async ({ page }) => {
    const state = await setup(page, {
      sources: (route, state) =>
        state.reads <= 2
          ? reply(route, [source(usdcId, 'USDC')])
          : mode === 'empty'
            ? reply(route, [])
            : route.fulfill({ status: 503, json: { error: 'Isolated source unavailable' } }),
    });
    await review(page);
    await page.locator('.pay-transfer-actions button:last-child').click();
    await expect(page.getByRole('heading', { name: 'Transfer confirmed', exact: true })).toBeVisible();
    await expect.poll(() => state.reads).toBe(3);
    await expect(page.locator('.pay-transfer-outcome')).toContainText('isolated-original-ledger');
    expect(state.posts.length).toBe(1);
    expect(await journal(page)).toBe(null);
  });
test('holding asset switch filters source and resets private input without dispatch', async ({ page }) => {
  const state = await setup(page);
  await review(page);
  await page.evaluate(() => {
    history.pushState(null, '', '/pay/send?asset=USDT');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.locator('input[name="recipient"]')).toHaveValue('');
  await expect(page.locator('select[aria-label="Source account"]')).toHaveValue(usdtId);
  await expect(page.locator('select[aria-label="Source account"] option')).toHaveCount(2);
  await review(page);
  await page.locator('.pay-transfer-actions button:last-child').click();
  await expect(page.getByRole('heading', { name: 'Transfer confirmed', exact: true })).toBeVisible();
  expect(state.posts.length).toBe(1);
  expect(state.posts[0].fromSpaceId === usdtId).toBe(true);
});
for (const language of ['en', 'es', 'fr'])
  test('native ' + language + ' exact review and recovery copy remains legible on phone', async ({ page }) => {
    await setup(page, { transfer: (route) => route.fulfill({ status: 503, json: { error: 'Isolated unknown' } }) });
    await page.evaluate((language) => {
      const key = 'intafaced.customer.view.v1';
      const oldValue = localStorage.getItem(key);
      const newValue = JSON.stringify({ language });
      localStorage.setItem(key, newValue);
      dispatchEvent(new StorageEvent('storage', { key, oldValue, newValue, storageArea: localStorage }));
    }, language);
    await expect(page.locator('html')).toHaveAttribute('lang', language);
    await review(page);
    await expect(page.locator('.pay-transfer-value')).toContainText(amount);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('.pay-transfer-actions button:last-child').click();
    await expect(page.locator('.pay-transfer-recovery-actions')).toBeVisible();
    await expect(page.locator('.pay-transfer-recovery-actions a')).toHaveCount(2);
    expect(await page.evaluate(() => !/pay\.[a-z_]+|invalidSendInput|originalTransferIsUnresolved/.test(document.body.textContent))).toBe(
      true,
    );
  });

for (const phase of ['preflight', 'dispatched'])
  test('new owner cannot dispatch or receive original ' + phase + ' action', async ({ page }) => {
    let release;
    const options =
      phase === 'preflight'
        ? {
            sources: async (route, state) => {
              if (state.reads === 2)
                await new Promise((resolve) => {
                  release = resolve;
                });
              return reply(
                route,
                [source(usdcId, 'USDC'), source(usdtId, 'USDT')].map((row) => ({
                  ...row,
                  ledgerAccount: { ...row.ledgerAccount, ownerId: state.actor },
                })),
              );
            },
          }
        : {
            transfer: async (route, state) => {
              await new Promise((resolve) => {
                release = resolve;
              });
              return reply(route, { ledgerTxId: 'isolated-old-owner', amount: state.posts[0].amount });
            },
          };
    const state = await setup(page, options);
    await review(page);
    await page.locator('.pay-transfer-actions button:last-child').click();
    await expect.poll(() => Boolean(release)).toBe(true);
    const originalBytes = await journal(page);
    await page.evaluate(() => {
      history.pushState(null, '', '/money');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await page.getByRole('button', { name: 'Open person menu' }).click();
    await page.getByRole('dialog', { name: 'Your account' }).getByRole('button', { name: 'Sign out', exact: true }).click();
    state.actor = recipient;
    await page.evaluate(() => {
      history.pushState(null, '', '/login?redirect=' + encodeURIComponent('/pay/send?asset=USDC'));
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await page.getByLabel('Email or handle', { exact: true }).fill('second-owner');
    await page.getByLabel('Password', { exact: true }).fill('isolated-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.locator('input[name="recipient"]')).toHaveValue('');
    release();
    await expect(page.getByRole('heading', { name: 'Transfer confirmed', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Original transfer is unresolved', exact: true })).toHaveCount(0);
    expect(state.posts.length).toBe(phase === 'dispatched' ? 1 : 0);
    expect((await journal(page)) === originalBytes).toBe(true);
  });

const originalId = '66666666-6666-4666-8666-666666666666';
async function recoveryFault(page, mode, seed = false) {
  await page.addInitScript(
    ({ mode, seed, userId, originalId }) => {
      const key = 'pay.unresolved:' + userId + ':send';
      const get = Storage.prototype.getItem,
        set = Storage.prototype.setItem,
        remove = Storage.prototype.removeItem;
      if (seed) sessionStorage.setItem(key, JSON.stringify({ status: 'uncertain', reference: originalId }));
      window.__recoveryOriginalIntact = () =>
        get.call(sessionStorage, key) === JSON.stringify({ status: 'uncertain', reference: originalId });
      window.__allowRecovery = false;
      Storage.prototype.getItem = function (name) {
        if (name === key && mode === 'read' && !window.__allowRecovery) throw new Error('Isolated read denied');
        return get.call(this, name);
      };
      Storage.prototype.setItem = function (name, value) {
        if (name === key && this === localStorage && !window.__allowRecovery) {
          if (mode === 'quota') throw new Error('Isolated quota');
          if (mode === 'silent-save') return;
        }
        return set.call(this, name, value);
      };
      Storage.prototype.removeItem = function (name) {
        if (name === key && this === localStorage && !window.__allowRecovery) {
          if (mode === 'remove') throw new Error('Isolated removal denied');
          if (mode === 'silent-remove') return;
        }
        return remove.call(this, name);
      };
    },
    { mode, seed, userId, originalId },
  );
}

test('durability: originating tab close leaves original unknown in independent same-owner tab', async ({ page, context }) => {
  const first = await setup(page, { transfer: (route) => route.fulfill({ status: 503, json: { error: 'Isolated unknown' } }) });
  await review(page);
  await page.locator('.pay-transfer-actions button:last-child').click();
  await expect(page.getByRole('heading', { name: 'Original transfer is unresolved', exact: true })).toBeVisible();
  const raw = await journal(page);
  expect(Boolean(raw)).toBe(true);
  await page.close();
  const independent = await context.newPage();
  let pageErrors = 0;
  independent.on('pageerror', () => pageErrors++);
  const second = await setup(independent);
  await expect(independent.getByRole('heading', { name: 'Original transfer is unresolved', exact: true })).toBeVisible();
  await independent.locator('input[name="recipient"]').fill(recipient);
  await independent.locator('input[name="send-amount"]').fill(amount);
  await expect(independent.locator('form.pay-form button[type="submit"]')).toBeDisabled();
  await independent
    .locator('form.pay-form')
    .evaluate((form) => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await expect(independent.getByRole('dialog')).toHaveCount(0);
  expect([first.posts.length, second.posts.length, pageErrors]).toEqual([1, 0, 0]);
  expect(await journal(independent)).toBe(raw);
});

for (const mode of ['read', 'quota', 'silent-save'])
  test('durability: ' + mode + ' refuses review or dispatch and keeps any surviving original', async ({ page }) => {
    const seed = mode !== 'quota';
    await recoveryFault(page, mode, seed);
    const state = await setup(page);
    if (mode === 'quota') {
      await review(page);
      await page.locator('.pay-transfer-actions button:last-child').click();
    }
    await expect(page.getByRole('heading', { name: 'Recovery storage unavailable', exact: true })).toBeVisible();
    expect(state.posts.length).toBe(0);
    if (seed) expect(await page.evaluate(() => window.__recoveryOriginalIntact())).toBe(true);
    await expect(page.locator('form.pay-form button[type="submit"]')).toBeDisabled();
    await page.evaluate(() => {
      window.__allowRecovery = true;
    });
    await page.getByRole('button', { name: 'Retry recovery', exact: true }).click();
    if (seed) {
      await expect(page.getByRole('heading', { name: 'Original transfer is unresolved', exact: true })).toBeVisible();
      expect(JSON.parse(await journal(page)).reference === originalId).toBe(true);
    } else {
      await expect(page.locator('form.pay-form button[type="submit"]')).toBeEnabled();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.locator('input[name="recipient"]')).toHaveValue('');
      await review(page);
      await page.locator('.pay-transfer-actions button:last-child').click();
      await expect(page.getByRole('heading', { name: 'Transfer confirmed', exact: true })).toBeVisible();
      expect(state.posts.length).toBe(1);
    }
  });

for (const mode of ['remove', 'silent-remove'])
  test(
    'durability: current known ' + mode + ' failure preserves receipt through failed source reload and retries only local cleanup',
    async ({ page }) => {
      await recoveryFault(page, mode);
      const state = await setup(page, {
        sources: (route, state) =>
          state.reads <= 2
            ? reply(route, [source(usdcId, 'USDC')])
            : route.fulfill({ status: 503, json: { error: 'Isolated source unavailable' } }),
      });
      await review(page);
      await page.locator('.pay-transfer-actions button:last-child').click();
      await expect(page.getByRole('heading', { name: 'Transfer confirmed', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Transfer confirmed · recovery record retained', exact: true })).toBeVisible();
      await expect(page.locator('.pay-transfer-outcome')).toContainText('isolated-original-ledger');
      await expect(page.locator('.pay-transfer-outcome')).toContainText(amount);
      const raw = await journal(page);
      expect(JSON.parse(raw).reference === state.posts[0].transferId).toBe(true);
      await expect.poll(() => state.reads).toBe(3);
      await page.getByRole('button', { name: 'Retry local cleanup', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Retry local cleanup', exact: true })).toBeEnabled();
      expect(await journal(page)).toBe(raw);
      expect(state.posts.length).toBe(1);
      await page.evaluate(() => {
        window.__allowRecovery = true;
      });
      await page.getByRole('button', { name: 'Retry local cleanup', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Transfer confirmed · recovery record retained', exact: true })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Transfer confirmed', exact: true })).toBeVisible();
      expect([await journal(page), state.posts.length]).toEqual([null, 1]);
    },
  );

test('durability: prepared same-owner reviews recheck admission after another tab dispatches', async ({ page, context }) => {
  let release;
  const first = await setup(page, {
    transfer: async (route) => {
      await new Promise((resolve) => {
        release = resolve;
      });
      return route.fulfill({ status: 503, json: { error: 'Isolated unknown' } });
    },
  });
  const secondPage = await context.newPage();
  let errors = 0;
  secondPage.on('pageerror', () => errors++);
  const second = await setup(secondPage);
  await review(page);
  await review(secondPage);
  await page.locator('.pay-transfer-actions button:last-child').click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await secondPage
    .locator('.pay-transfer-actions button:last-child')
    .evaluate((button) => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect([first.posts.length, second.posts.length]).toEqual([1, 0]);
  release();
  await expect(page.getByRole('heading', { name: 'Original transfer is unresolved', exact: true })).toBeVisible();
  expect(await journal(secondPage)).toBe(await journal(page));
  expect(errors).toBe(0);
});

test('durability: unavailable native Web Locks blocks writes while source reads remain usable', async ({ page }) => {
  const state = await setup(page);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    dispatchEvent(new Event('focus'));
  });
  await expect(page.getByRole('heading', { name: 'Recovery storage unavailable', exact: true })).toBeVisible();
  await expect(page.locator('select[aria-label="Source account"]')).toHaveValue(usdcId);
  await expect(page.locator('form.pay-form button[type="submit"]')).toBeDisabled();
  expect(state.posts.length).toBe(0);
});

test('durability: conflicting original stores retain both readable IDs and refuse Send', async ({ page }) => {
  await page.addInitScript(
    ({ userId, originalId }) => {
      const key = 'pay.unresolved:' + userId + ':send';
      sessionStorage.setItem(key, JSON.stringify({ status: 'uncertain', reference: originalId }));
      localStorage.setItem(key, JSON.stringify({ status: 'uncertain', reference: '77777777-7777-4777-8777-777777777777' }));
    },
    { userId, originalId },
  );
  const state = await setup(page);
  await expect(
    page.getByText('Recovery records disagree. Sending stays blocked and both stored originals are retained.', { exact: true }),
  ).toBeVisible();
  expect(
    await page.locator('.pay-notice').filter({ hasText: 'Recovery records disagree.' }).getByText(originalId, { exact: true }).count(),
  ).toBe(1);
  await expect(page.locator('form.pay-form button[type="submit"]')).toBeDisabled();
  expect(state.posts.length).toBe(0);
  expect(
    await page.evaluate((userId) => {
      const key = 'pay.unresolved:' + userId + ':send';
      return sessionStorage.getItem(key) !== localStorage.getItem(key) && Boolean(sessionStorage.getItem(key));
    }, userId),
  ).toBe(true);
});

test('durability: busy native Web Lock refuses admission until explicit recovery succeeds', async ({ page }) => {
  const state = await setup(page);
  await page.evaluate((userId) => {
    window.__lockHeld = false;
    window.__lockFinished = false;
    void navigator.locks
      .request('intafaced.original:pay.unresolved:' + userId + ':send', async () => {
        window.__lockHeld = true;
        await new Promise((resolve) => {
          window.__releaseLock = resolve;
        });
      })
      .then(() => {
        window.__lockFinished = true;
      });
  }, userId);
  await expect.poll(() => page.evaluate(() => window.__lockHeld)).toBe(true);
  await review(page);
  await page.locator('.pay-transfer-actions button:last-child').click();
  await expect(page.getByRole('heading', { name: 'Recovery storage unavailable', exact: true })).toBeVisible();
  expect(state.posts.length).toBe(0);
  await page.evaluate(() => window.__releaseLock());
  await expect.poll(() => page.evaluate(() => window.__lockFinished)).toBe(true);
  await page.getByRole('button', { name: 'Retry recovery', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry recovery', exact: true })).toHaveCount(0);
  await expect(page.locator('form.pay-form button[type="submit"]')).toBeEnabled();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await review(page);
  await page.locator('.pay-transfer-actions button:last-child').click();
  await expect(page.getByRole('heading', { name: 'Transfer confirmed', exact: true })).toBeVisible();
  expect(state.posts.length).toBe(1);
});

for (const [language, title, cleanup] of [
  ['en', 'Transfer confirmed · recovery record retained', 'Retry local cleanup'],
  ['es', 'Transferencia confirmada · registro de recuperación conservado', 'Reintentar limpieza local'],
  ['fr', 'Transfert confirmé · enregistrement de récupération conservé', 'Réessayer le nettoyage local'],
])
  test('durability: ' + language + ' authored known-cleanup notice and local action fit phone', async ({ page }) => {
    await recoveryFault(page, 'remove');
    const state = await setup(page);
    await page.evaluate((language) => {
      const key = 'intafaced.customer.view.v1',
        oldValue = localStorage.getItem(key),
        newValue = JSON.stringify({ language });
      localStorage.setItem(key, newValue);
      dispatchEvent(new StorageEvent('storage', { key, oldValue, newValue, storageArea: localStorage }));
    }, language);
    await expect(page.locator('html')).toHaveAttribute('lang', language);
    await review(page);
    await page.locator('.pay-transfer-actions button:last-child').click();
    const heading = page.getByRole('heading', { name: title, exact: true });
    await expect(heading).toBeVisible();
    expect(await heading.evaluate((element) => element.closest('[lang]')?.getAttribute('lang') === document.documentElement.lang)).toBe(
      true,
    );
    await expect(page.getByRole('button', { name: cleanup, exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.evaluate(() => !/pay\.[a-z_]+|knownRecoveryBody|retryLocalCleanup/.test(document.body.textContent))).toBe(true);
    expect(state.posts.length).toBe(1);
  });

test('durability: corrupt durable original refuses Send without guessing its identity', async ({ page }) => {
  await page.addInitScript((userId) => localStorage.setItem('pay.unresolved:' + userId + ':send', '{'), userId);
  const state = await setup(page);
  await expect(page.getByRole('heading', { name: 'Recovery storage unavailable', exact: true })).toBeVisible();
  await expect(page.locator('form.pay-form button[type="submit"]')).toBeDisabled();
  expect([await journal(page), state.posts.length]).toEqual(['{', 0]);
});

test('durability: loss of a dispatched original in current RAM refuses a fresh Send', async ({ page }) => {
  const state = await setup(page, { transfer: (route) => route.fulfill({ status: 503, json: { error: 'Isolated unknown' } }) });
  await review(page);
  await page.locator('.pay-transfer-actions button:last-child').click();
  await expect(page.getByRole('heading', { name: 'Original transfer is unresolved', exact: true })).toBeVisible();
  await page.evaluate((userId) => {
    const key = 'pay.unresolved:' + userId + ':send';
    localStorage.removeItem(key);
    dispatchEvent(new StorageEvent('storage', { key, storageArea: localStorage }));
  }, userId);
  await expect(page.getByRole('heading', { name: 'Recovery storage unavailable', exact: true })).toBeVisible();
  await expect(page.locator('form.pay-form button[type="submit"]')).toBeDisabled();
  expect(state.posts.length).toBe(1);
});

test('durability: a known refusal with failed cleanup never claims a confirmed transfer or resubmits', async ({ page }) => {
  await recoveryFault(page, 'remove');
  const state = await setup(page, {
    transfer: (route) => route.fulfill({ status: 400, json: { error: { message: 'Isolated original refusal' } } }),
  });
  await review(page);
  await page.locator('.pay-transfer-actions button:last-child').click();
  await expect(page.getByRole('heading', { name: 'Transfer confirmed', exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Original transfer reply received · recovery record retained', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('Isolated original refusal');
  await page.getByRole('dialog').getByRole('button', { name: 'Close dialog' }).click();
  await page.evaluate(() => {
    window.__allowRecovery = true;
  });
  await page.getByRole('button', { name: 'Retry local cleanup', exact: true }).click();
  await expect(page.locator('form.pay-form button[type="submit"]')).toBeEnabled();
  expect([state.posts.length, await journal(page)]).toEqual([1, null]);
});

for (const kind of ['same', 'hash'])
  test('durability: known-cleanup ' + kind + ' URL control binds local proof to its originating context', async ({ page }) => {
    await recoveryFault(page, 'remove');
    const state = await setup(page);
    await review(page);
    await page.locator('.pay-transfer-actions button:last-child').click();
    await expect(page.getByRole('heading', { name: 'Transfer confirmed', exact: true })).toBeVisible();
    const raw = await journal(page);
    await navigation(page, kind);
    if (kind === 'same') {
      await expect(page.getByRole('heading', { name: 'Transfer confirmed', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Retry local cleanup', exact: true })).toBeVisible();
    } else {
      await expect(page.getByRole('heading', { name: 'Transfer confirmed', exact: true })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Original transfer is unresolved', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Retry local cleanup', exact: true })).toHaveCount(0);
    }
    expect([await journal(page), state.posts.length]).toEqual([raw, 1]);
  });

test('durability: retained original cleanup callback cannot clear a fresh known transfer in the same Send context', async ({ page }) => {
  await recoveryFault(page, 'remove');
  const state = await setup(page);
  await review(page);
  await page.locator('.pay-transfer-actions button:last-child').click();
  await expect(page.getByRole('button', { name: 'Retry local cleanup', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry local cleanup', exact: true }).evaluate((button) => {
    const propsKey = Object.keys(button).find((key) => key.startsWith('__reactProps'));
    window.__retainedCleanupCallback = button[propsKey].onClick;
  });
  await page.evaluate(() => {
    window.__allowRecovery = true;
  });
  await page.getByRole('button', { name: 'Retry local cleanup', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry local cleanup', exact: true })).toHaveCount(0);
  await expect(page.locator('form.pay-form button[type="submit"]')).toBeEnabled();
  await page.evaluate(() => {
    window.__allowRecovery = false;
  });
  await review(page);
  await page.locator('.pay-transfer-actions button:last-child').click();
  await expect(page.getByRole('button', { name: 'Retry local cleanup', exact: true })).toBeVisible();
  const replacement = await journal(page);
  expect(state.posts.length).toBe(2);
  expect(state.posts[0].transferId !== state.posts[1].transferId).toBe(true);
  await page.evaluate(() => {
    window.__allowRecovery = true;
    window.__retainedCleanupCallback();
  });
  await expect(page.getByRole('button', { name: 'Retry local cleanup', exact: true })).toBeEnabled();
  expect(await journal(page)).toBe(replacement);
  await page.getByRole('button', { name: 'Retry local cleanup', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry local cleanup', exact: true })).toHaveCount(0);
  expect([await journal(page), state.posts.length]).toEqual([null, 2]);
});

test('reconciliation: mounted held Offer check retains its original and blocks a parallel check before replacement admission', async ({
  page,
}) => {
  let release;
  const offer = {
    id: usdcId,
    makerId: userId,
    side: 'sell',
    asset: 'USDT',
    fiatCurrency: 'USD',
    priceType: 'fixed',
    price: '1',
    minAmount: '1',
    maxAmount: '2',
    remainingAmount: '2',
    methods: ['operator'],
    terms: '',
    status: 'paused',
    createdAt: '2026-10-10T00:00:00Z',
  };
  const state = await setup(page, {
    p2p: async (route, state, procedure) => {
      if (procedure === 'offers.list') return reply(route, [offer]);
      if (procedure === 'offers.get') {
        state.offerReads = (state.offerReads ?? 0) + 1;
        if (state.offerReads === 1)
          await new Promise((resolve) => {
            release = resolve;
          });
        return reply(route, offer);
      }
      state.unexpected++;
      return route.fulfill({ status: 503, json: { error: 'Isolated unsupported offer operation' } });
    },
  });
  const raw = JSON.stringify({ status: 'uncertain', reference: 'pause' });
  await page.evaluate(
    ({ userId, offerId, raw }) => {
      localStorage.setItem('pay.unresolved:' + userId + ':offer:' + offerId, raw);
      history.pushState(null, '', '/uc/ad');
      dispatchEvent(new PopStateEvent('popstate'));
    },
    { userId, offerId: usdcId, raw },
  );
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  const check = page.getByRole('button', { name: 'Check original offer action', exact: true });
  await check.click();
  await expect.poll(() => Boolean(release)).toBe(true);
  try {
    await check.click();
    await expect(page.getByRole('heading', { name: 'Outcome not confirmed', exact: true })).toBeVisible();
    expect(state.offerReads).toBe(1);
    expect(
      await page.evaluate(({ userId, offerId }) => localStorage.getItem('pay.unresolved:' + userId + ':offer:' + offerId), {
        userId,
        offerId: usdcId,
      }),
    ).toBe(raw);
    await expect(page.getByRole('button', { name: 'Resume offer', exact: true })).toBeDisabled();
    expect(state.unexpected).toBe(0);
  } finally {
    release();
  }
  await expect(check).toHaveCount(0);
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume offer', exact: true })).toBeEnabled();
  expect(
    await page.evaluate(({ userId, offerId }) => localStorage.getItem('pay.unresolved:' + userId + ':offer:' + offerId), {
      userId,
      offerId: usdcId,
    }),
  ).toBe(null);
  expect(state.posts.length).toBe(0);
});

async function retainReviewHandlers(page) {
  await page.evaluate(() => {
    const props = (element) => element[Object.keys(element).find((key) => key.startsWith('__reactProps$'))];
    window.__retiredReviewHandlers = {
      confirm: props(document.querySelector('.pay-transfer-actions button:last-child')).onClick,
      edit: props(document.querySelector('.pay-transfer-actions button:first-child')).onClick,
      close: props(document.querySelector('dialog header button')).onClick,
      recipient: props(document.querySelector('input[name="recipient"]')).onChange,
      amount: props(document.querySelector('input[name="send-amount"]')).onChange,
      source: props(document.querySelector('form.pay-form select')).onChange,
    };
  });
}
for (const obsolete of ['confirm', 'edit-close-fields']) {
  test('same-URL retired ' + obsolete + ' handlers preserve the replacement review and admit only its current terms', async ({ page }) => {
    const state = await setup(page);
    await review(page);
    const originalId = await page.locator('.pay-transfer-reference').textContent();
    await retainReviewHandlers(page);
    await page.getByRole('button', { name: 'Edit transfer', exact: true }).click();
    const replacementAmount = '0.000000000000000002';
    await review(page, replacementAmount);
    const replacementId = await page.locator('.pay-transfer-reference').textContent();
    expect(replacementId !== originalId).toBe(true);
    await page.evaluate(
      ({ obsolete, usdtId, userId }) => {
        const old = window.__retiredReviewHandlers;
        if (obsolete === 'edit-close-fields') {
          old.edit();
          old.close();
          old.recipient({ target: { value: userId } });
          old.amount({ target: { value: '3' } });
          old.source({ target: { value: usdtId } });
        }
        old.confirm();
      },
      { obsolete, usdtId, userId },
    );
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.locator('.pay-transfer-reference')).toHaveText(replacementId);
    await expect(page.locator('input[name="recipient"]')).toHaveValue(recipient);
    await expect(page.locator('input[name="send-amount"]')).toHaveValue(replacementAmount);
    expect([state.posts.length, state.reads, await journal(page)]).toEqual([0, 1, null]);
    await page.locator('.pay-transfer-actions button:last-child').click();
    await expect(page.getByRole('heading', { name: 'Transfer confirmed', exact: true })).toBeVisible();
    expect(state.posts.length).toBe(1);
    expect(state.posts[0].transferId === replacementId && state.posts[0].amount === replacementAmount).toBe(true);
    expect(state.unexpected).toBe(0);
  });
}
for (const retirement of ['Edit transfer', 'Close dialog']) {
  test('same-URL held source preflight retired by ' + retirement + ' cannot dispatch or clobber a replacement action', async ({ page }) => {
    let releaseOriginal, releaseReplacement;
    const state = await setup(page, {
      sources: async (route, state) => {
        const read = state.reads;
        if (read === 2)
          await new Promise((resolve) => {
            releaseOriginal = resolve;
          });
        if (read === 3)
          await new Promise((resolve) => {
            releaseReplacement = resolve;
          });
        return reply(route, [source(usdcId, 'USDC'), source(usdtId, 'USDT')]);
      },
    });
    await review(page);
    await page.locator('.pay-transfer-actions button:last-child').click();
    await expect.poll(() => Boolean(releaseOriginal)).toBe(true);
    await page.getByRole('button', { name: retirement, exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const replacementAmount = '0.000000000000000002';
    await review(page, replacementAmount);
    const replacementId = await page.locator('.pay-transfer-reference').textContent();
    await page.locator('.pay-transfer-actions button:last-child').click();
    await expect.poll(() => Boolean(releaseReplacement)).toBe(true);
    const originalResponse = page.waitForResponse((response) => response.url().includes('spaces.list'));
    releaseOriginal();
    await (await originalResponse).finished();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator('.pay-transfer-reference')).toHaveText(replacementId);
    await expect(page.locator('.pay-transfer-actions button:last-child')).toBeDisabled();
    expect([state.posts.length, await journal(page)]).toEqual([0, null]);
    releaseReplacement();
    await expect(page.getByRole('heading', { name: 'Transfer confirmed', exact: true })).toBeVisible();
    expect(state.posts.length).toBe(1);
    expect(state.posts[0].transferId === replacementId && state.posts[0].amount === replacementAmount).toBe(true);
    expect([await journal(page), state.unexpected]).toEqual([null, 0]);
  });
}
test('wrong-ID mounted Offer reply preserves original bytes until the exact original row proves its action', async ({ page }) => {
  const offer = {
    id: usdcId,
    makerId: userId,
    side: 'sell',
    asset: 'USDT',
    fiatCurrency: 'USD',
    priceType: 'fixed',
    price: '1',
    minAmount: '1',
    maxAmount: '2',
    remainingAmount: '2',
    methods: ['operator'],
    terms: '',
    status: 'paused',
    createdAt: '2026-10-10T00:00:00Z',
  };
  let wrongId = true;
  const state = await setup(page, {
    p2p: async (route, state, procedure) => {
      if (procedure === 'offers.list') return reply(route, [offer]);
      if (procedure === 'offers.get') return reply(route, { ...offer, id: wrongId ? usdtId : usdcId });
      state.unexpected++;
      return route.fulfill({ status: 503, json: { error: 'Isolated unsupported offer operation' } });
    },
  });
  const raw = JSON.stringify({ status: 'uncertain', reference: 'pause' });
  await page.evaluate(
    ({ userId, offerId, raw }) => {
      localStorage.setItem('pay.unresolved:' + userId + ':offer:' + offerId, raw);
      history.pushState(null, '', '/uc/ad');
      dispatchEvent(new PopStateEvent('popstate'));
    },
    { userId, offerId: usdcId, raw },
  );
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  const check = page.getByRole('button', { name: 'Check original offer action', exact: true });
  await check.click();
  await expect(page.getByRole('heading', { name: 'Information could not be verified', exact: true })).toBeVisible();
  const original = () =>
    page.evaluate(({ userId, offerId }) => localStorage.getItem('pay.unresolved:' + userId + ':offer:' + offerId), {
      userId,
      offerId: usdcId,
    });
  expect(await original()).toBe(raw);
  await expect(page.getByRole('button', { name: 'Resume offer', exact: true })).toBeDisabled();
  wrongId = false;
  await check.click();
  await expect(check).toHaveCount(0);
  expect(await original()).toBe(null);
  expect([state.posts.length, state.unexpected]).toEqual([0, 0]);
});
