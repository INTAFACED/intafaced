import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export const owner = '11111111-1111-4111-8111-111111111111',
  orderId = '77777777-7777-4777-8777-777777777777';
export const destination = '/chat?tradeId=' + orderId;
const evidence = process.env.P2P_ORDER_EVIDENCE;
mkdirSync(evidence, { recursive: true });
export const order = {
  id: orderId,
  offerId: '88888888-8888-4888-8888-888888888888',
  sellerId: owner,
  buyerId: '22222222-2222-4222-8222-222222222222',
  asset: 'USDT',
  amount: '12.345678901234567801',
  fiatCurrency: 'USD',
  fiatAmount: '13.580246791358024581',
  price: '1.1',
  method: 'bank-transfer',
  status: 'fiat_sent',
  resolution: null,
  deadlineAt: '2026-10-11T06:00:00Z',
  createdAt: '2026-10-10T12:00:00Z',
  escrowedAt: '2026-10-10T12:00:05Z',
  resolvedAt: null,
  settledAt: null,
};
export async function fixture(context) {
  const state = {
    owner,
    order: { ...order },
    reads: [],
    writes: [],
    errors: [],
    fixtureErrors: [],
    documents: [],
    pauseNext: false,
    finish: null,
    logins: [],
    transportErrors: [],
  };
  context.on('page', (page) => {
    page.on('pageerror', (e) => state.errors.push(e.message));
    page.on('request', (r) => {
      if (r.isNavigationRequest() && r.frame() === page.mainFrame()) state.documents.push(r.url());
    });
  });
  const failure = (route, status = 503) =>
    route.fulfill({
      status,
      json: {
        error: {
          message: 'Isolated P2P service response unavailable',
          data: { code: 'SERVICE_UNAVAILABLE', httpStatus: status, cause: { code: 'p2p.isolated_unavailable' } },
        },
      },
    });
  state.replyTrade = async () => ({ status: 200, data: { ...state.order } });
  state.replyWrite = async () => ({ status: 503 });
  state.replyDestination = async () => ({ status: 503 });
  await context.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      procedure = decodeURIComponent(url.pathname.split('/').at(-1));
    const rpc = (data) => route.fulfill({ status: 200, json: { result: { data } } });
    const send = (reply) => (reply.status === 200 ? rpc(reply.data) : failure(route, reply.status));
    if (procedure === 'auth.login') {
      const token = state.logins.length ? 'isolated-p2p-owner-' + state.logins.length : 'isolated-p2p-owner';
      state.logins.push({ owner: state.owner, token });
      return rpc({
        userId: state.owner,
        accessToken: token,
        refreshToken: 'isolated-p2p-refresh',
        expiresAt: '2027-10-10T00:00:00Z',
      });
    }
    if (procedure === 'auth.logout') return rpc({ ok: true });
    if (request.method() !== 'GET') {
      state.writes.push({ procedure, body: request.postData() });
      return send(await state.replyWrite({ procedure, input: JSON.parse(request.postData() || 'null') }));
    }
    const input = JSON.parse(url.searchParams.get('input') || 'null');
    const principal = state.logins.find((login) => request.headers().authorization === 'Bearer ' + login.token)?.owner;
    const read = { procedure, input, principal };
    state.reads.push(read);
    if (procedure === 'trades.get') {
      if (input?.tradeId !== orderId || !principal) {
        state.fixtureErrors.push({ procedure, input });
        return failure(route, 400);
      }
      if (state.pauseNext) {
        state.pauseNext = false;
        await new Promise((r) => (state.finish = r));
      }
      const reply = await state.replyTrade(read);
      read.reply = reply;
      return send(reply);
    }
    if (procedure === 'trades.paymentInstrument') return send(await state.replyDestination(read));
    return failure(route);
  });
  return state;
}
export async function login(page, arrival = 'Release escrow', documentLoad = true) {
  const url = '/login?redirect=' + encodeURIComponent(destination);
  if (documentLoad) await page.goto(url);
  else
    await page.evaluate((url) => {
      history.pushState(null, '', url);
      dispatchEvent(new PopStateEvent('popstate'));
    }, url);
  await page.locator('input[name="identifier"]').fill('isolated-owner@example.invalid');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
  await expect(page).toHaveURL(new URL(destination, process.env.P2P_ORDER_BASE_URL).href);
  if (arrival) await expect(page.getByRole('button', { name: arrival, exact: true })).toBeVisible();
  else await expect(page.locator('#main h1')).toBeVisible();
}
export async function scenario(browser, name, run, width = 390, seed) {
  const context = await browser.newContext({
    baseURL: process.env.P2P_ORDER_BASE_URL,
    viewport: { width, height: 844 },
    timezoneId: 'UTC',
  });
  const state = await fixture(context);
  if (seed) await context.addInitScript(seed.script, seed.args);
  const page = await context.newPage();
  try {
    await run({ page, context, state });
    expect(state.errors).toEqual([]);
    expect(state.fixtureErrors).toEqual([]);
    expect(state.transportErrors).toEqual([]);
  } finally {
    writeFileSync(
      join(evidence, name + '-raw.json'),
      JSON.stringify(
        {
          ...state,
          finish: undefined,
          qualification:
            'Actual compiled App, ordinary login and isolated owner/contract replies. Not live authority/escrow/payment/original settlement proof.',
        },
        null,
        2,
      ) + '\n',
    );
    await context.close();
  }
}
const confirm = (page) => page.getByRole('dialog').getByRole('button', { name: 'Confirm release escrow', exact: true });
const stable = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
test('observed batched URL departure retires the actual prior confirm handler before a write', async ({ browser }) => {
  await scenario(browser, 'retired-handler', async ({ page, state }) => {
    await login(page);
    await page.getByRole('button', { name: 'Release escrow', exact: true }).click();
    await confirm(page).evaluate((b) => {
      const k = Object.keys(b).find((k) => k.startsWith('__reactProps$'));
      if (!k || typeof b[k].onClick !== 'function') throw Error('Actual confirm handler missing');
      window.__priorConfirm = b[k].onClick;
    });
    await page.evaluate((url) => {
      history.pushState(null, '', url + '&departed=1#changed');
      dispatchEvent(new PopStateEvent('popstate'));
      history.pushState(null, '', url);
      dispatchEvent(new PopStateEvent('popstate'));
      window.__priorConfirm();
    }, destination);
    await stable(page);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(state.writes).toEqual([]);
    expect(state.documents).toHaveLength(1);
  });
});
test('late preflight after an observed departure and return cannot submit the old review', async ({ browser }) => {
  await scenario(browser, 'late-preflight', async ({ page, state }) => {
    await login(page);
    await page.getByRole('button', { name: 'Release escrow', exact: true }).click();
    state.pauseNext = true;
    await confirm(page).click();
    await expect.poll(() => typeof state.finish).toBe('function');
    await page.evaluate((url) => {
      history.pushState(null, '', url + '&departed=2');
      dispatchEvent(new PopStateEvent('popstate'));
      history.pushState(null, '', url);
      dispatchEvent(new PopStateEvent('popstate'));
    }, destination);
    state.finish();
    await stable(page);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(state.writes).toEqual([]);
    expect(state.documents).toHaveLength(1);
  });
});
const originalKey = 'pay.unresolved:' + owner + ':trade:' + orderId;
const unknownRaw = JSON.stringify({ status: 'uncertain', reference: 'confirmReceived' });
const seedOriginal = (raw = unknownRaw) => ({
  script: ({ key, raw }) => {
    if (location.protocol === 'http:') localStorage.setItem(key, raw);
  },
  args: { key: originalKey, raw },
});
async function savedHandler(locator, slot = '__savedP2P') {
  await locator.evaluate((button, slot) => {
    const key = Object.keys(button).find((key) => key.startsWith('__reactProps$'));
    if (!key || typeof button[key].onClick !== 'function') throw Error('Actual React handler missing');
    window[slot] = button[key].onClick;
  }, slot);
}
async function invoke(page, slot = '__savedP2P') {
  await page.evaluate((slot) => window[slot](), slot);
  await stable(page);
}
async function capture(page, name) {
  const facts = await page.locator('#main').evaluate((main) => {
    const button = [...main.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Release escrow');
    const footer = document.querySelector('.mobile-doors');
    return {
      viewport: { width: innerWidth, height: innerHeight },
      scrollY,
      scrollWidth: document.documentElement.scrollWidth,
      footerTop: footer && getComputedStyle(footer).display !== 'none' ? footer.getBoundingClientRect().top : innerHeight,
      release: button?.getBoundingClientRect().toJSON(),
      html: main.outerHTML,
      dialog: document.querySelector('dialog')?.outerHTML,
      active: document.activeElement?.outerHTML,
      originals: Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith('pay.unresolved:'))),
    };
  });
  writeFileSync(join(evidence, name + '-geometry.json'), JSON.stringify(facts, null, 2) + '\n');
  await page.screenshot({ path: join(evidence, name + '.png') });
  return facts;
}
const original = (page) => page.locator('.p2p-original');
const checkOriginal = (page) => page.getByRole('button', { name: 'Check original order action', exact: true });

test('seller arrival and critical review preserve identity exact quantities and reachable actions at four widths', async ({ browser }) => {
  for (const width of [320, 390, 768, 1440]) {
    await scenario(
      browser,
      'seller-fit-' + width,
      async ({ page, state }) => {
        await login(page);
        const core = page.locator('.p2p-order-core');
        await expect(core).toContainText(orderId);
        await expect(core).toContainText('You are the seller');
        await expect(core).toContainText('USDT');
        await expect(core).toContainText('USD');
        await expect(core.locator('[data-exact-amount]')).toHaveCount(2);
        const arrival = await capture(page, 'seller-arrival-' + width);
        expect(arrival.scrollWidth).toBeLessThanOrEqual(width);
        expect(arrival.release.bottom).toBeLessThanOrEqual(arrival.footerTop);
        expect(arrival.release.height).toBeGreaterThanOrEqual(44);
        await page.getByRole('button', { name: 'Release escrow', exact: true }).press('Enter');
        const dialog = page.getByRole('dialog');
        await expect(dialog).toContainText(orderId);
        await expect(dialog).toContainText(order.buyerId);
        await expect(dialog).toContainText('gross');
        await expect(dialog).toContainText('fee and net asset amount');
        await expect(dialog.locator('[data-exact-amount="' + order.amount + '"]')).toHaveCount(1);
        await expect(dialog.locator('[data-exact-amount="' + order.fiatAmount + '"]')).toHaveCount(1);
        await capture(page, 'seller-review-' + width);
        await savedHandler(confirm(page));
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await invoke(page);
        expect(state.writes).toEqual([]);
        await expect(page.getByRole('button', { name: 'Release escrow', exact: true })).toBeFocused();
        expect(state.documents).toHaveLength(1);
      },
      width,
    );
  }
});

test('a handler retained from a closed cancellation cannot submit when a new review opens', async ({ browser }) => {
  await scenario(browser, 'reopened-review-handler', async ({ page, state }) => {
    await login(page);
    await page.locator('.p2p-order-other summary').click();
    const reason = page.getByLabel('Cancellation reason', { exact: true });
    await reason.fill('first private reason');
    await page.getByRole('button', { name: 'Cancel order', exact: true }).click();
    await savedHandler(page.getByRole('dialog').getByRole('button', { name: 'Confirm cancel order', exact: true }));
    await page.keyboard.press('Escape');
    await reason.fill('second private reason');
    await page.getByRole('button', { name: 'Cancel order', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('second private reason');
    await invoke(page);
    expect(state.writes).toEqual([]);
    await expect(page.getByRole('dialog')).toContainText('second private reason');
  });
});

test('current GET and preflight reject wrong identity ownership malformed data and changed reviewed terms', async ({ browser }) => {
  const invalid = [
    ['wrong-id', { ...order, id: '99999999-9999-4999-8999-999999999999' }],
    ['wrong-owner', { ...order, sellerId: order.buyerId }],
    ['malformed', { ...order, amount: 12.34 }],
  ];
  for (const [name, data] of invalid)
    await scenario(browser, 'current-' + name, async ({ page, state }) => {
      state.replyTrade = async () => ({ status: 200, data });
      await login(page, null);
      await expect(page.locator('.p2p-order .failure')).toBeVisible();
      await expect(page.locator('.p2p-order-identity')).toHaveCount(0);
      expect(state.writes).toEqual([]);
    });
  for (const [name, changed] of [
    ['amount', { amount: '12.345678901234567802' }],
    ['method', { method: 'changed-method' }],
    ['status', { status: 'disputed' }],
    ['deadline', { deadlineAt: '2026-10-12T00:00:00Z' }],
  ])
    await scenario(browser, 'preflight-' + name, async ({ page, state }) => {
      await login(page);
      await page.getByRole('button', { name: 'Release escrow', exact: true }).click();
      state.order = { ...order, ...changed };
      await confirm(page).click();
      await expect(page.locator('.p2p-order')).toContainText('changed');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(state.writes).toEqual([]);
      expect(await page.evaluate((key) => localStorage.getItem(key), originalKey)).toBeNull();
    });
});

test('an unknown dispatched original survives source failure reload tab closure and a same-owner tab without replay', async ({
  browser,
}) => {
  await scenario(browser, 'unknown-original-lifetime', async ({ page, state, context }) => {
    await login(page);
    const peer = await context.newPage();
    await login(peer);
    await peer.getByRole('button', { name: 'Release escrow', exact: true }).click();
    await savedHandler(confirm(peer), '__peerReview');
    state.replyWrite = async () => {
      state.replyTrade = async () => ({ status: 503 });
      return { status: 503 };
    };
    await page.getByRole('button', { name: 'Release escrow', exact: true }).click();
    await confirm(page).click();
    await expect(original(page)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Can’t connect right now', exact: true })).toBeVisible();
    await expect(page.locator('.p2p-order-identity')).toHaveCount(0);
    await expect.poll(() => state.writes.length).toBe(1);
    expect(await page.evaluate((key) => localStorage.getItem(key), originalKey)).toBe(unknownRaw);
    await invoke(peer, '__peerReview');
    expect(state.writes).toHaveLength(1);
    const facts = await capture(page, 'unknown-current-failure-390');
    const check = await checkOriginal(page).boundingBox();
    expect(check.y + check.height).toBeLessThanOrEqual(facts.footerTop);
    await checkOriginal(page).click();
    await expect(original(page)).toBeVisible();
    expect(state.writes).toHaveLength(1);
    await page.reload();
    state.replyTrade = async () => ({ status: 200, data: { ...order } });
    await login(page, null);
    await expect(original(page)).toBeVisible();
    expect(await page.evaluate((key) => localStorage.getItem(key), originalKey)).toBe(unknownRaw);
    await page.close();
    await expect(original(peer)).toBeVisible();
    await checkOriginal(peer).click();
    await expect(peer.locator('.p2p-order')).toContainText('still unresolved');
    expect(await peer.evaluate((key) => localStorage.getItem(key), originalKey)).toBe(unknownRaw);
    expect(state.writes).toHaveLength(1);
  });
});

test('only matching terminal settlement evidence clears an original; late proof and unreadable bytes retain it', async ({ browser }) => {
  await scenario(
    browser,
    'feature-specific-recovery',
    async ({ page, state }) => {
      await login(page, null);
      await expect(original(page)).toBeVisible();
      for (const data of [
        { ...order, status: 'released', resolution: 'released', settledAt: null },
        { ...order, status: 'released', resolution: 'refunded', settledAt: '2026-10-11T00:00:00Z' },
        { ...order, status: 'released', resolution: 'released', settledAt: 'unreadable-date' },
        { ...order, status: 'released', resolution: 'released', settledAt: '0' },
        { ...order, status: 'released', resolution: 'released', settledAt: '2026-10-11T00:00:00Z', id: order.offerId },
      ]) {
        state.order = data;
        await checkOriginal(page).click();
        await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), originalKey)).toBe(unknownRaw);
        await expect(page.getByRole('button', { name: 'Check original order action', exact: true })).toBeEnabled();
      }
      state.order = { ...order, status: 'released', resolution: 'released', settledAt: '2026-10-11T00:00:00Z' };
      await checkOriginal(page).click();
      await expect(original(page)).toHaveCount(0);
      expect(await page.evaluate((key) => localStorage.getItem(key), originalKey)).toBeNull();
      await expect(page.locator('.p2p-original-result')).toContainText('Current order state checked');
      expect(state.writes).toEqual([]);
      await capture(page, 'matching-original-proof-390');
    },
    390,
    seedOriginal(),
  );
  await scenario(
    browser,
    'retired-proof-original',
    async ({ page, state }) => {
      await login(page, null);
      await expect(original(page)).toBeVisible();
      state.pauseNext = true;
      state.order = { ...order, status: 'released', resolution: 'released', settledAt: '2026-10-11T00:00:00Z' };
      await checkOriginal(page).click();
      await expect.poll(() => typeof state.finish).toBe('function');
      await page.evaluate((url) => {
        history.pushState(null, '', url + '&departure=proof');
        dispatchEvent(new PopStateEvent('popstate'));
        history.pushState(null, '', url);
        dispatchEvent(new PopStateEvent('popstate'));
      }, destination);
      state.finish();
      await stable(page);
      await expect(original(page)).toBeVisible();
      expect(await page.evaluate((key) => localStorage.getItem(key), originalKey)).toBe(unknownRaw);
      expect(state.writes).toEqual([]);
    },
    390,
    seedOriginal(),
  );
  await scenario(
    browser,
    'unreadable-original',
    async ({ page, state }) => {
      await login(page, null);
      await expect(original(page)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Release escrow', exact: true })).toHaveCount(0);
      await checkOriginal(page).click();
      await expect(original(page)).toBeVisible();
      expect(await page.evaluate((key) => localStorage.getItem(key), originalKey)).toBe('opaque-unreadable-original');
      expect(state.writes).toEqual([]);
    },
    320,
    seedOriginal('opaque-unreadable-original'),
  );
});

test('wrong or malformed financial replies retain a minimal unknown original', async ({ browser }) => {
  for (const [name, reply] of [
    ['wrong-order', { ...order, id: order.offerId }],
    ['wrong-terms', { ...order, amount: '99' }],
    ['unchanged-action-state', { ...order }],
    ['malformed', { accepted: true }],
  ])
    await scenario(browser, 'mutation-' + name, async ({ page, state }) => {
      await login(page);
      state.replyWrite = async () => ({ status: 200, data: reply });
      await page.getByRole('button', { name: 'Release escrow', exact: true }).click();
      await confirm(page).click();
      await expect(original(page)).toBeVisible();
      expect(state.writes).toHaveLength(1);
      expect(await page.evaluate((key) => localStorage.getItem(key), originalKey)).toBe(unknownRaw);
      await capture(page, 'mutation-' + name);
    });
});

test('seller sent-payment cancellation and buyer sent-payment restrictions match the real participant contract', async ({ browser }) => {
  await scenario(browser, 'seller-cancel-sent', async ({ page, state }) => {
    await login(page);
    await page.locator('.p2p-order-other summary').click();
    await page.getByLabel('Cancellation reason', { exact: true }).fill('Receipt not confirmed');
    await page.getByRole('button', { name: 'Cancel order', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('does not refund an external bank payment');
    await expect(page.getByRole('dialog')).toContainText(order.sellerId);
    state.replyWrite = async () => {
      state.order = { ...order, status: 'cancelled', resolution: 'refunded', settledAt: '2026-10-11T00:00:00Z' };
      return { status: 200, data: { ...state.order } };
    };
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm cancel order', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0].procedure).toBe('trades.cancel');
    expect(JSON.parse(state.writes[0].body)).toEqual({ tradeId: orderId, reason: 'Receipt not confirmed' });
    expect(await page.evaluate((key) => localStorage.getItem(key), originalKey)).toBeNull();
  });
  await scenario(browser, 'buyer-sent-restrictions', async ({ page, state }) => {
    state.owner = order.buyerId;
    await login(page, null);
    await expect(page.locator('.p2p-order-core')).toContainText('You are the buyer');
    await expect(page.getByRole('button', { name: 'Cancel order', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Release escrow', exact: true })).toHaveCount(0);
    expect(state.writes).toEqual([]);
  });
});

test('payment details use deliberate current recovery and refuse unrelated instrument replies', async ({ browser }) => {
  const details = {
    tradeId: orderId,
    methodId: order.method,
    country: 'US',
    fiatCurrency: 'USD',
    label: 'Agreed bank account',
    details: { account: 'private-bank-reference' },
    attachedAt: '2026-10-10T12:00:05Z',
  };
  await scenario(browser, 'private-instrument-current', async ({ page, state }) => {
    await login(page);
    expect(state.reads.filter((r) => r.procedure === 'trades.paymentInstrument')).toHaveLength(0);
    await page.getByRole('button', { name: 'Reveal agreed payment details', exact: true }).click();
    const section = page
      .locator('.pay-section')
      .filter({ has: page.getByRole('heading', { name: 'External payment destination', exact: true }) });
    await expect(section.locator('.failure')).toBeVisible();
    state.replyDestination = async () => ({ status: 200, data: details });
    await section.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(section).toContainText(details.details.account);
    state.replyTrade = async () => ({ status: 503 });
    await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
    await expect(page.locator('#main')).not.toContainText(details.details.account);
    state.replyTrade = async () => ({ status: 200, data: { ...order } });
    await page.locator('.p2p-order .failure').getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Reveal agreed payment details', exact: true })).toBeVisible();
    for (const changed of [{ tradeId: order.offerId }, { methodId: 'unrelated-method' }, { fiatCurrency: 'EUR' }]) {
      state.replyDestination = async () => ({ status: 200, data: { ...details, ...changed } });
      if (await page.getByRole('button', { name: 'Reveal agreed payment details', exact: true }).count())
        await page.getByRole('button', { name: 'Reveal agreed payment details', exact: true }).click();
      else await section.getByRole('button', { name: 'Try again', exact: true }).click();
      await expect(section.locator('.failure')).toBeVisible();
      await expect(page.locator('#main')).not.toContainText(details.details.account);
    }
    expect(state.writes).toEqual([]);
  });
});

test('passive locale changes retain focus and long exact terms remain inspectable with their units', async ({ browser }) => {
  await scenario(
    browser,
    'locale-long-exact',
    async ({ page, context, state }) => {
      state.order = { ...order, amount: '99999999999999999999.999999999999999999' };
      await login(page);
      const refresh = page.locator('.p2p-order-role button');
      await refresh.focus();
      const peer = await context.newPage();
      await peer.goto('/help');
      for (const [language, label] of [
        ['es', 'Eres el vendedor'],
        ['fr', 'Vous êtes le vendeur'],
        ['ar', 'You are the seller'],
      ]) {
        await peer.evaluate((language) => {
          const key = 'intafaced.customer.view.v1';
          localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) || '{}'), language, hideBalances: true }));
        }, language);
        await expect(page.locator('.p2p-order')).toContainText(label);
        await expect(refresh).toBeFocused();
        await expect(page.locator('.p2p-order')).toHaveAttribute('lang', language === 'ar' ? 'en' : language);
      }
      await peer.evaluate(() =>
        localStorage.setItem('intafaced.customer.view.v1', JSON.stringify({ language: 'en', hideBalances: false })),
      );
      const region = page.locator('.p2p-order-core .pay-amount-scroll').first();
      await expect(region).toHaveAttribute('tabindex', '0');
      await region.focus();
      await region.press('End');
      expect(await region.evaluate((n) => n.scrollLeft)).toBeGreaterThan(0);
      await expect(page.locator('.p2p-order-core .pay-amount-unit').first()).toHaveText('USDT');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
      await capture(page, 'long-exact-locale-320');
      const longFit = await capture(page, 'long-exact-primary-fit-320');
      expect(longFit.release.bottom).toBeLessThanOrEqual(longFit.footerTop);
      expect(longFit.release.height).toBeGreaterThanOrEqual(44);
      expect(state.writes).toEqual([]);
    },
    320,
  );
});

test('described hash departures owner changes and late dispatched replies preserve unknown originals', async ({ browser }) => {
  await scenario(browser, 'hash-departure', async ({ page, state }) => {
    await login(page);
    await page.getByRole('button', { name: 'Release escrow', exact: true }).click();
    await savedHandler(confirm(page));
    await page.evaluate((url) => {
      dispatchEvent(new HashChangeEvent('hashchange', { oldURL: location.href, newURL: new URL(url + '#departed', location.origin).href }));
      dispatchEvent(new HashChangeEvent('hashchange', { oldURL: new URL(url + '#departed', location.origin).href, newURL: location.href }));
      window.__savedP2P();
    }, destination);
    await stable(page);
    expect(state.writes).toEqual([]);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
  await scenario(browser, 'owner-retired-handler', async ({ page, state }) => {
    await login(page);
    await page.getByRole('button', { name: 'Release escrow', exact: true }).click();
    await savedHandler(confirm(page));
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    state.owner = order.buyerId;
    await login(page, null, false);
    await expect(page.locator('.p2p-order-core')).toContainText('You are the buyer');
    await invoke(page);
    expect(state.writes).toEqual([]);
    await expect(page.getByRole('button', { name: 'Release escrow', exact: true })).toHaveCount(0);
  });
  await scenario(browser, 'late-dispatched-original', async ({ page, state }) => {
    await login(page);
    let finish;
    state.replyWrite = async () => {
      await new Promise((r) => (finish = r));
      return { status: 200, data: { ...order, status: 'released', resolution: 'released', settledAt: '2026-10-11T00:00:00Z' } };
    };
    await page.getByRole('button', { name: 'Release escrow', exact: true }).click();
    await confirm(page).click();
    await expect.poll(() => typeof finish).toBe('function');
    expect(await page.evaluate((key) => localStorage.getItem(key), originalKey)).toBe(unknownRaw);
    await page.evaluate((url) => {
      history.pushState(null, '', url + '&departed=post');
      dispatchEvent(new PopStateEvent('popstate'));
      history.pushState(null, '', url);
      dispatchEvent(new PopStateEvent('popstate'));
    }, destination);
    finish();
    await stable(page);
    await expect(original(page)).toBeVisible();
    expect(await page.evaluate((key) => localStorage.getItem(key), originalKey)).toBe(unknownRaw);
    expect(state.writes).toHaveLength(1);
  });
});

test('a known original reply with failed device cleanup recovers locally without another POST', async ({ browser }) => {
  await scenario(browser, 'known-reply-cleanup', async ({ page, state }) => {
    await login(page);
    await page.evaluate((key) => {
      const real = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function (candidate) {
        if (this === localStorage && candidate === key) throw Error('Isolated device cleanup refused');
        return real.call(this, candidate);
      };
      window.__restoreP2PCleanup = () => (Storage.prototype.removeItem = real);
    }, originalKey);
    state.order = { ...order };
    state.replyWrite = async () => {
      state.order = { ...order, status: 'released', resolution: 'released', settledAt: '2026-10-11T00:00:00Z' };
      return { status: 200, data: { ...state.order } };
    };
    await page.getByRole('button', { name: 'Release escrow', exact: true }).click();
    await confirm(page).click();
    await expect(original(page)).toBeVisible();
    await expect(page.locator('.p2p-order-core')).toContainText('released');
    const reads = state.reads.filter((r) => r.procedure === 'trades.get').length;
    await page.evaluate(() => window.__restoreP2PCleanup());
    await checkOriginal(page).click();
    await expect(original(page)).toHaveCount(0);
    await expect(page.locator('.p2p-order-core')).toContainText('released');
    expect(await page.evaluate((key) => localStorage.getItem(key), originalKey)).toBeNull();
    expect(state.writes).toHaveLength(1);
    // One ordinary fresh GET after successful local cleanup; no proof GET or replay.
    await expect.poll(() => state.reads.filter((r) => r.procedure === 'trades.get').length).toBe(reads + 1);
  });
});

test('buyer escrowed review authorizes the exact external payment and terminal roles do not offer financial actions', async ({
  browser,
}) => {
  await scenario(browser, 'buyer-escrowed', async ({ page, state }) => {
    state.owner = order.buyerId;
    state.order = { ...order, status: 'escrowed' };
    await login(page, 'Mark payment sent');
    await page.getByRole('button', { name: 'Mark payment sent', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(orderId);
    await expect(dialog).toContainText('Buyer');
    await expect(dialog.locator('[data-exact-amount="' + order.fiatAmount + '"]')).toHaveCount(1);
    await expect(dialog).toContainText(order.method);
    await page.keyboard.press('Escape');
    expect(state.writes).toEqual([]);
    await capture(page, 'buyer-escrowed-390');
  });
  for (const status of ['created', 'escrowed', 'released', 'cancelled', 'disputed']) {
    await scenario(browser, 'seller-status-' + status, async ({ page, state }) => {
      state.order = { ...order, status };
      await login(page, null);
      await expect(page.locator('.p2p-order-identity')).toContainText(status.replaceAll('_', ' '));
      await expect(page.getByRole('button', { name: 'Release escrow', exact: true })).toHaveCount(0);
      if (['released', 'cancelled', 'disputed'].includes(status))
        await expect(page.getByRole('button', { name: 'Cancel order', exact: true })).toHaveCount(0);
      await page.locator('.p2p-order-facts summary').click();
      await expect(page.locator('.p2p-order-facts')).toContainText('Not confirmed');
      expect(state.writes).toEqual([]);
    });
  }
});

test('unreadable journal storage refuses financial admission while current order inspection remains readable', async ({ browser }) => {
  await scenario(
    browser,
    'unreadable-journal-storage',
    async ({ page, state }) => {
      await login(page, null);
      await expect(original(page)).toBeVisible();
      await expect(page.locator('.p2p-order-core')).toContainText(orderId);
      await expect(page.getByRole('button', { name: 'Release escrow', exact: true })).toHaveCount(0);
      await checkOriginal(page).click();
      await expect(page.locator('.p2p-order')).toContainText('storage is unavailable');
      expect(state.writes).toEqual([]);
      await capture(page, 'unreadable-journal-current-320');
    },
    320,
    {
      script: (key) => {
        const real = Storage.prototype.getItem;
        Storage.prototype.getItem = function (candidate) {
          if (candidate === key) throw Error('Isolated original storage unreadable');
          return real.call(this, candidate);
        };
      },
      args: originalKey,
    },
  );
});

test('participant refund recovery requires its own matching cancelled resolution and settlement stamp', async ({ browser }) => {
  const raw = JSON.stringify({ status: 'uncertain', reference: 'cancel' });
  await scenario(
    browser,
    'cancel-specific-recovery',
    async ({ page, state }) => {
      await login(page, null);
      await expect(original(page)).toBeVisible();
      for (const data of [
        { ...order, status: 'cancelled', resolution: 'refunded', settledAt: null },
        { ...order, status: 'released', resolution: 'released', settledAt: '2026-10-11T00:00:00Z' },
        { ...order, status: 'cancelled', resolution: 'voided', settledAt: null },
      ]) {
        state.order = data;
        await checkOriginal(page).click();
        await expect(checkOriginal(page)).toBeEnabled();
        expect(await page.evaluate((key) => localStorage.getItem(key), originalKey)).toBe(raw);
      }
      state.order = { ...order, status: 'cancelled', resolution: 'refunded', settledAt: '2026-10-11T00:00:00Z' };
      await checkOriginal(page).click();
      await expect(original(page)).toHaveCount(0);
      await expect(page.locator('.p2p-original-result')).toContainText('cancelled');
      expect(await page.evaluate((key) => localStorage.getItem(key), originalKey)).toBeNull();
      expect(state.writes).toEqual([]);
    },
    390,
    seedOriginal(raw),
  );
});

test('all five P2P rooms remain reachable by natural keyboard on the current phone order', async ({ browser }) => {
  await scenario(
    browser,
    'p2p-rooms-keyboard',
    async ({ page, state }) => {
      await login(page);
      const nav = page.locator('.pay-order-tabs'),
        links = nav.locator('a');
      await expect(links).toHaveCount(5);
      await expect(nav.locator('[aria-current="page"]')).toHaveText('Your orders');
      await links.first().focus();
      for (let index = 0; index < 5; index++) {
        const link = links.nth(index);
        await expect(link).toBeFocused();
        const before = await link.evaluate((n) => ({ rect: n.getBoundingClientRect().toJSON(), scrollLeft: n.parentElement.scrollLeft }));
        await stable(page);
        const lane = await link.evaluate((n) => ({
          link: n.getBoundingClientRect().toJSON(),
          nav: n.parentElement.getBoundingClientRect().toJSON(),
        }));
        (state.navFocus ??= []).push({ index, before, after: lane });
        expect(lane.link.left).toBeGreaterThanOrEqual(lane.nav.left - 1);
        expect(lane.link.right).toBeLessThanOrEqual(lane.nav.right + 1);
        await link.press('Tab');
      }
      expect(state.writes).toEqual([]);
      expect(state.documents).toHaveLength(1);
    },
    320,
  );
});
