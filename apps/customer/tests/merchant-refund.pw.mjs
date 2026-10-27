import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
const evidence = process.env.REFUND_EVIDENCE;
mkdirSync(evidence, { recursive: true });
const summaries = [],
  errors = new WeakMap();
test.beforeEach(({ page, context }) => {
  const failures = [];
  errors.set(page, failures);
  page.on('pageerror', () => failures.push(true));
  context.on('page', (other) => other.on('pageerror', () => failures.push(true)));
});
test.afterEach(({ page }, info) => {
  expect(errors.get(page).length).toBe(0);
  summaries.push({ name: info.title, status: info.status, pageErrors: errors.get(page).length });
});
test.afterAll(() => writeFileSync(evidence + '/native-summary.json', JSON.stringify(summaries, null, 2)));
const userId = '11111111-1111-4111-8111-111111111111',
  merchantId = '22222222-2222-4222-8222-222222222222',
  paymentId = '33333333-3333-4333-8333-333333333333';
const key = `pay.unresolved:${userId}:payment:${paymentId}`,
  reference = `refund:${paymentId}:44444444-4444-4444-8444-444444444444`;
const merchant = {
  id: merchantId,
  userId,
  mode: 'gateway',
  status: 'active',
  kybStatus: 'approved',
  kybRef: 'isolated-approval',
  feeBps: null,
};
const payment = {
  id: paymentId,
  merchantId,
  profileId: null,
  amount: '100',
  assetId: 'USDT',
  method: 'isolated-method',
  railAdapter: 'isolated-rail',
  railRef: 'isolated-ref',
  status: 'captured',
  capturedAmount: '100',
  refundedAmount: '0',
  createdAt: '2026-10-10T09:00:00Z',
};
const historyEvent = (kind, refundId, amount = '25', ts = '2026-10-10T09:42:00Z') => ({
  id: '55555555-5555-4555-8555-555555555555',
  event: kind,
  payload: { refundId, amount },
  railEventId: null,
  ts,
});
const reply = (route, data) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data } }) });
async function prepareDevice(page, { locale = 'en', raw, fault } = {}) {
  await page.addInitScript(
    ({ locale, raw, key, fault }) => {
      localStorage.setItem('intafaced.customer.view.v1', JSON.stringify({ language: locale }));
      if (raw !== undefined) localStorage.setItem(key, raw);
      window.refundFault = fault || '';
      for (const method of ['getItem', 'setItem', 'removeItem']) {
        const original = Storage.prototype[method];
        Storage.prototype[method] = function (key, ...args) {
          if (key.startsWith('pay.unresolved:')) {
            if (window.refundFault === method) throw new Error('Isolated storage denial');
            if (window.refundFault === 'silent-' + method) return;
          }
          return original.call(this, key, ...args);
        };
      }
    },
    { locale, raw, key, fault },
  );
}
async function routes(page, state) {
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      name = new URL(request.url()).pathname.split('/').at(-1);
    state.requests.push({ name, method: request.method() });
    if (name === 'auth.login')
      return reply(route, {
        userId,
        accessToken: 'isolated-refund-session',
        refreshToken: 'isolated-refund-refresh',
        expiresAt: '2027-10-10T00:00:00Z',
      });
    if (name === 'merchant.me') {
      if (state.holdMerchant) {
        state.heldMerchant = route;
        return;
      }
      return reply(route, merchant);
    }
    if (name === 'payment.list') return reply(route, { items: [payment], nextCursor: null });
    if (name === 'railHealth') return reply(route, []);
    if (name === 'payment.get') return reply(route, state.payment || payment);
    if (name === 'payment.history') {
      if (state.holdHistory && new URL(request.url()).searchParams.get('input')?.includes('200')) {
        state.heldHistory = route;
        return;
      }
      return reply(route, state.history || []);
    }
    if (name === 'payment.refund') {
      state.posts.push(request.postDataJSON());
      if (state.holdPost) {
        state.heldPost = route;
        return;
      }
      if (state.terminal) state.history = [historyEvent(state.terminal, state.posts.at(-1).refundId)];
      return state.postStatus
        ? route.fulfill({
            status: state.postStatus,
            json: { error: { message: 'Isolated refund refusal', data: { intafacedCode: 'pay.refund_rail_failed' } } },
          })
        : reply(route, payment);
    }
    state.unexpected++;
    return route.fulfill({ status: 503, json: { error: { message: 'Isolated unavailable' } } });
  });
}
function fixtureState(extra = {}) {
  return { posts: [], requests: [], unexpected: 0, ...extra };
}
async function mount(page, state, options = {}) {
  await prepareDevice(page, options);
  await routes(page, state);
  await page.goto('/refund-fixture.html');
  await page.waitForFunction(() => Boolean(window.refundFixture));
  await page.evaluate(() => window.refundFixture.signIn());
  await page.getByRole('button', { name: /^(Open|Abrir|Ouvrir)$/ }).click();
  await expect(page.locator('section[data-testid="merchant-refund"]').first()).toBeVisible();
}
async function review(page, value = '25') {
  await page.locator('[data-testid="merchant-refund"] input').fill(value);
  await page
    .locator('[data-testid="merchant-refund"] > button')
    .filter({ hasText: /Review refund|Revisar reembolso|Vérifier le remboursement/ })
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
}
function confirm(page) {
  return page.getByRole('dialog').getByRole('button', { name: /Confirm refund|Confirmar reembolso|Confirmer le remboursement/ });
}
async function saved(page) {
  return page.evaluate((key) => localStorage.getItem(key), key);
}
async function retain(page, name, selector) {
  await page.evaluate(
    ({ name, selector }) => {
      const node = document.querySelector(selector);
      if (!node) throw Error('Missing source-derived control');
      const key = Object.keys(node).find((key) => key.startsWith('__reactProps'));
      window[name] = node[key].onClick;
    },
    { name, selector },
  );
}

test('actual ordinary Customer stays unactivated with no Business provider or merchant calls', async ({ page }) => {
  const state = fixtureState();
  await routes(page, state);
  await page.goto('/login?redirect=' + encodeURIComponent('/pay/payments'));
  await page.getByLabel('Email or handle', { exact: true }).fill('refund@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('isolated-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/pay\/payments/);
  await expect(page.locator('section[data-testid="merchant-refund"]')).toHaveCount(0);
  expect(state.requests.filter((r) => r.name === 'merchant.me' || r.name === 'payment.refund')).toEqual([]);
});
test('unknown original survives independent reload with no amount/body persistence or blind replay', async ({ page }) => {
  const state = fixtureState({ postStatus: 503 });
  await mount(page, state);
  await review(page, '25.000000000000000001');
  await confirm(page).click();
  await expect(page.locator('section[data-testid="merchant-refund"]')).toContainText('Refund outcome unknown');
  const raw = await saved(page);
  expect(JSON.parse(raw)).toEqual({ status: 'uncertain', reference: state.posts[0].refundId });
  expect(raw).not.toContain('amount');
  await page.reload();
  await page.waitForFunction(() => window.refundFixture);
  await page.evaluate(() => window.refundFixture.signIn());
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.locator('section[data-testid="merchant-refund"]')).toContainText(state.posts[0].refundId);
  await expect(page.locator('[data-testid="merchant-refund"] input')).toHaveCount(0);
  expect(state.posts).toHaveLength(1);
});
for (const terminal of ['refunded', 'refund.reversed'])
  test(`exact ${terminal} keeps a known receipt after failed cleanup and retries only locally`, async ({ page }) => {
    const state = fixtureState({ terminal, postStatus: terminal === 'refund.reversed' ? 400 : 0 });
    await mount(page, state, { fault: 'removeItem' });
    await review(page);
    await confirm(page).click();
    await expect(page.locator('section[data-testid="merchant-refund"]')).toContainText(
      terminal === 'refunded' ? 'Refund recorded' : 'Refund reversed',
    );
    await expect(page.locator('section[data-testid="merchant-refund"]')).toContainText('Local recovery record retained');
    const ref = state.posts[0].refundId,
      reads = state.requests.length;
    state.history = [];
    await page.evaluate(() => {
      window.refundFault = '';
    });
    await page.getByRole('button', { name: 'Retry local cleanup', exact: true }).click();
    await expect.poll(() => saved(page)).toBe(null);
    expect(state.posts).toHaveLength(1);
    expect(state.requests.length).toBe(reads);
    await expect(page.locator('section[data-testid="merchant-refund"]')).toContainText(ref);
    await expect(page.getByRole('button', { name: 'Review a new refund', exact: true })).toBeEnabled();
  });
for (const fault of ['getItem', 'setItem', 'silent-setItem'])
  test(`native ${fault} storage failure sends no refund`, async ({ page }) => {
    const state = fixtureState();
    await mount(page, state, { fault });
    if (fault !== 'getItem') {
      await review(page);
      await confirm(page).click();
    }
    await expect(page.locator('section[data-testid="merchant-refund"]')).toContainText(
      /Cannot read the saved refund|could not be verified/,
    );
    expect(state.posts).toHaveLength(0);
  });
test('legacy lost original identity cannot be reconstructed from successful payment status or history', async ({ page }) => {
  const state = fixtureState({
    payment: { ...payment, status: 'refunded', refundedAmount: '100' },
    history: [historyEvent('refunded', reference)],
  });
  await mount(page, state, { raw: 'uncertain' });
  await expect(page.locator('section[data-testid="merchant-refund"]')).toContainText('no original refund reference');
  await page.getByRole('button', { name: 'Check original refund', exact: true }).click();
  expect(await saved(page)).toBe('uncertain');
  expect(state.posts).toHaveLength(0);
});
test('200 oldest-first intermediate events do not settle the original', async ({ page }) => {
  const state = fixtureState({
    history: Array.from({ length: 200 }, (_, i) => ({
      ...historyEvent('refund.posted', reference),
      id: `${String(i).padStart(8, '0')}-5555-4555-8555-555555555555`,
    })),
  });
  await mount(page, state, { raw: JSON.stringify({ status: 'uncertain', reference }) });
  await page.getByRole('button', { name: 'Check original refund', exact: true }).click();
  await expect(page.locator('section[data-testid="merchant-refund"]')).toContainText('first 200 recorded payment events');
  expect(await saved(page)).toBe(JSON.stringify({ status: 'uncertain', reference }));
  expect(state.posts).toHaveLength(0);
});
test('malformed terminal offset preserves the original without room errors', async ({ page }) => {
  const state = fixtureState({ history: [historyEvent('refunded', reference, '25', '2026-10-10T09:42:00+24:00')] });
  await mount(page, state, { raw: JSON.stringify({ status: 'uncertain', reference }) });
  await page.getByRole('button', { name: 'Check original refund', exact: true }).click();
  await expect(page.locator('section[data-testid="merchant-refund"]')).toContainText('No matching outcome returned');
  expect(await saved(page)).not.toBe(null);
});
test('retired review A Confirm/Edit/Close cannot dispatch or clear current review B', async ({ page }) => {
  const state = fixtureState();
  await mount(page, state);
  await review(page, '25');
  await retain(page, 'oldConfirm', 'dialog [data-testid="merchant-refund-actions"] button:first-child');
  await retain(page, 'oldEdit', 'dialog [data-testid="merchant-refund-actions"] button:last-child');
  await retain(page, 'oldClose', 'dialog > header button');
  await page.getByRole('dialog').getByRole('button', { name: 'Edit amount', exact: true }).click();
  await review(page, '30');
  const refB = await page.getByRole('dialog').locator('dd').last().textContent();
  await page.evaluate(() => {
    window.oldConfirm();
    window.oldEdit();
    window.oldClose();
  });
  await expect(page.getByRole('dialog')).toContainText(refB);
  expect(state.posts).toHaveLength(0);
  await confirm(page).click();
  await expect.poll(() => state.posts.length).toBe(1);
  expect(state.posts[0]).toMatchObject({ amount: '30', refundId: refB });
});
test('retired original A Check cannot read or clear original B; current B Check can', async ({ page }) => {
  const state = fixtureState();
  await mount(page, state, { raw: JSON.stringify({ status: 'uncertain', reference }) });
  await retain(page, 'oldOriginalCheck', 'section[data-testid="merchant-refund"] > button:first-of-type');
  state.history = [historyEvent('refunded', reference)];
  await page.getByRole('button', { name: 'Check original refund', exact: true }).click();
  await page.getByRole('button', { name: 'Review a new refund', exact: true }).click();
  state.history = [];
  await review(page, '30');
  await confirm(page).click();
  await expect(page.locator('section[data-testid="merchant-refund"]')).toContainText('Refund outcome unknown');
  const rawB = await saved(page),
    refB = JSON.parse(rawB).reference;
  expect(refB).not.toBe(reference);
  state.history = [historyEvent('refunded', refB, '30')];
  const readsBefore = state.requests.length;
  await page.evaluate(() => window.oldOriginalCheck());
  await page.waitForTimeout(100);
  expect(state.requests.length).toBe(readsBefore);
  expect(await saved(page)).toBe(rawB);
  expect(state.posts).toHaveLength(1);
  await page.getByRole('button', { name: 'Check original refund', exact: true }).click();
  await expect(page.locator('section[data-testid="merchant-refund"]')).toContainText('Refund recorded');
  expect(await saved(page)).toBe(null);
  expect(state.posts).toHaveLength(1);
});
test('same-task observed query/hash ABA retires retained Confirm before private dispatch', async ({ page }) => {
  const state = fixtureState();
  await mount(page, state);
  await review(page);
  await retain(page, 'oldConfirm', 'dialog [data-testid="merchant-refund-actions"] button:first-child');
  const privateRemoved = await page.evaluate(() => {
    const href = location.href;
    history.replaceState(null, '', href + '?other=1#departed');
    dispatchEvent(new PopStateEvent('popstate'));
    history.replaceState(null, '', href);
    dispatchEvent(new HashChangeEvent('hashchange'));
    window.oldConfirm();
    return !document.querySelector('dialog');
  });
  expect(privateRemoved).toBe(true);
  expect(state.posts).toHaveLength(0);
  await expect(page.locator('[data-testid="merchant-refund"] input')).toBeVisible();
  await review(page, '26');
  await confirm(page).click();
  await expect.poll(() => state.posts.length).toBe(1);
});
test('held merchant preflight after Edit cannot post A; a current B review can post', async ({ page }) => {
  const state = fixtureState();
  await mount(page, state);
  await review(page);
  state.holdMerchant = true;
  await confirm(page).click();
  await expect.poll(() => Boolean(state.heldMerchant)).toBe(true);
  await page.getByRole('dialog').getByRole('button', { name: 'Edit amount', exact: true }).click();
  await review(page, '30');
  state.holdMerchant = false;
  await reply(state.heldMerchant, merchant);
  await expect(page.getByRole('dialog')).toContainText('30');
  expect(state.posts).toHaveLength(0);
  expect(await saved(page)).toBe(null);
  await confirm(page).click();
  await expect.poll(() => state.posts.length).toBe(1);
  expect(state.posts[0].amount).toBe('30');
});
test('synchronous actual Session clear prevents retained Confirm and private back navigation before rerender', async ({ page }) => {
  const state = fixtureState();
  await mount(page, state);
  await review(page);
  await retain(page, 'oldConfirm', 'dialog [data-testid="merchant-refund-actions"] button:first-child');
  await retain(page, 'oldBack', '[data-testid="merchant-refund"] > button:last-of-type');
  const href = page.url();
  await page.evaluate(() => {
    window.refundFixture.clearSameTask(() => {
      window.oldConfirm();
      window.oldBack();
    });
  });
  expect(page.url()).toBe(href);
  expect(state.posts).toHaveLength(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
test('held history after actual owner replacement cannot publish or clean the departed original', async ({ page }) => {
  const raw = JSON.stringify({ status: 'uncertain', reference });
  const state = fixtureState({ history: [historyEvent('refunded', reference)] });
  await mount(page, state, { raw });
  state.holdHistory = true;
  await page.getByRole('button', { name: 'Check original refund', exact: true }).click();
  await expect.poll(() => Boolean(state.heldHistory)).toBe(true);
  await page.evaluate(() => window.refundFixture.replaceOwner());
  state.holdHistory = false;
  await reply(state.heldHistory, state.history);
  await expect(page.locator('section[data-testid="merchant-refund"]')).toHaveCount(0);
  expect(await saved(page)).toBe(raw);
  expect(state.posts).toHaveLength(0);
});
test('independent same-owner tabs share native admission and preserve one original', async ({ page, context }) => {
  const state = fixtureState();
  await mount(page, state);
  const other = await context.newPage();
  await mount(other, state);
  await review(page, '25');
  await review(other, '30');
  state.holdMerchant = true;
  await confirm(page).click();
  await expect.poll(() => Boolean(state.heldMerchant)).toBe(true);
  await confirm(other).click();
  expect(state.posts).toHaveLength(0);
  state.holdMerchant = false;
  await reply(state.heldMerchant, merchant);
  await expect.poll(() => state.posts.length).toBe(1);
  await expect(other.locator('section[data-testid="merchant-refund"]')).toContainText(state.posts[0].refundId);
  expect(JSON.parse(await saved(other)).reference).toBe(state.posts[0].refundId);
  await other.close();
});
for (const locale of ['en', 'es', 'fr'])
  for (const width of [320, 390])
    test(`${locale} ${width}px long-reference review/recovery fits with keyboard controls`, async ({ page }) => {
      const state = fixtureState();
      await page.setViewportSize({ width, height: 1000 });
      await mount(page, state, { locale });
      await review(page, '25.000000000000000001');
      await expect(confirm(page)).toBeVisible();
      await page.keyboard.press('Tab');
      const focusVisible = await page.evaluate(() => document.activeElement?.matches(':focus-visible'));
      expect(focusVisible).toBe(true);
      const fit = await page
        .getByRole('dialog')
        .evaluate((node) => node.getBoundingClientRect().right <= innerWidth && node.scrollWidth <= node.clientWidth + 1);
      expect(fit).toBe(true);
      await page.screenshot({ path: `${evidence}/${locale}-${width}-review.png`, fullPage: true });
      await confirm(page).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      const root = page.locator('section[data-testid="merchant-refund"]');
      const recoveryFit = await root.evaluate(
        (node) => node.getBoundingClientRect().right <= innerWidth + 1 && node.scrollWidth <= node.clientWidth + 1,
      );
      expect(recoveryFit).toBe(true);
      await expect(root.locator('input')).toHaveCount(0);
      expect(state.posts).toHaveLength(1);
      await root.screenshot({ path: `${evidence}/${locale}-${width}-unknown.png` });
    });
