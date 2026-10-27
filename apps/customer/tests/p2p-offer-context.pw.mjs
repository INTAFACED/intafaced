import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const evidence = process.env.P2P_OFFER_EVIDENCE;
mkdirSync(evidence, { recursive: true });
const owner = '11111111-1111-4111-8111-111111111111',
  other = '22222222-2222-4222-8222-222222222222';
const offerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const originalKey = `pay.unresolved:${owner}:offer:${offerId}`;
const template = {
  id: offerId,
  makerId: other,
  side: 'sell',
  asset: 'USDT',
  fiatCurrency: 'USD',
  priceType: 'fixed',
  price: '1.1',
  minAmount: '1',
  maxAmount: '50',
  remainingAmount: '12.345678901234567801',
  methods: ['bank-transfer'],
  terms: 'Listed payment terms',
  status: 'active',
  createdAt: '2026-10-10T12:00:00Z',
};
async function fixture(context) {
  const state = {
    owner,
    listed: { ...template },
    current: { ...template, terms: 'Current payment terms', status: 'paused' },
    reads: [],
    writes: [],
    errors: [],
    fixtureErrors: [],
    transportErrors: [],
    observations: [],
    pauseNext: false,
    finish: null,
    limitEmpty: false,
  };
  state.replyGet = async () => ({ status: 200, data: { ...state.current } });
  state.replyWrite = async () => ({ status: 503 });
  context.on('page', (page) => page.on('pageerror', (error) => state.errors.push(error.message)));
  const refusal = (route, status = 503) =>
    route.fulfill({
      status,
      json: {
        error: {
          message: 'Isolated offer service unavailable',
          data: { code: 'SERVICE_UNAVAILABLE', httpStatus: status, cause: { code: 'p2p.isolated_unavailable' } },
        },
      },
    });
  await context.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      procedure = decodeURIComponent(url.pathname.split('/').at(-1));
    const rpc = (data) => route.fulfill({ status: 200, json: { result: { data } } });
    const send = (reply) => (reply.status === 200 ? rpc(reply.data) : refusal(route, reply.status));
    try {
      if (procedure === 'auth.login')
        return rpc({
          userId: state.owner,
          accessToken: 'isolated-offer-owner',
          refreshToken: 'isolated-offer-refresh',
          expiresAt: '2027-10-10T00:00:00Z',
        });
      if (procedure === 'auth.logout') return rpc({ ok: true });
      if (request.method() !== 'GET') {
        const input = JSON.parse(request.postData() || 'null');
        state.writes.push({ procedure, input });
        return send(await state.replyWrite({ procedure, input }));
      }
      const input = JSON.parse(url.searchParams.get('input') || 'null');
      state.reads.push({ procedure, input });
      if (procedure === 'offers.list') {
        if (
          ![50, 200].includes(input?.limit) ||
          Object.keys(input).some((key) => !['asset', 'fiatCurrency', 'side', 'limit'].includes(key))
        )
          state.fixtureErrors.push({ procedure, input });
        return rpc(
          state.limitEmpty
            ? input.limit === 200
              ? []
              : Array.from({ length: 50 }, (_, index) => ({
                  ...state.listed,
                  id: index === 0 ? offerId : 'bbbbbbbb-bbbb-4bbb-8bbb-' + String(index).padStart(12, '0'),
                }))
            : state.listed.status === 'active'
              ? [{ ...state.listed }]
              : [],
        );
      }
      if (procedure === 'offers.get') {
        if (input?.offerId !== offerId || Object.keys(input).length !== 1) state.fixtureErrors.push({ procedure, input });
        if (state.pauseNext) {
          state.pauseNext = false;
          await new Promise((resolve) => (state.finish = resolve));
        }
        return send(await state.replyGet());
      }
      if (procedure === 'fiat.list') return rpc([{ code: 'USD', name: 'US Dollar', symbol: '$', minorUnits: 2 }]);
      return refusal(route);
    } catch (error) {
      state.transportErrors.push(String(error));
      throw error;
    }
  });
  return state;
}
async function login(page, path = '/p2p') {
  await page.goto('/login?redirect=' + encodeURIComponent(path));
  await page.locator('input[name="identifier"]').fill('offer-owner@example.invalid');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
  await expect(page.locator('.pay-room-tabs')).toBeVisible();
}
const stable = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const inspector = (page) => page.locator('.p2p-offer-inspector');
const firstInspect = (page) => page.locator('.p2p-offer-row').first().getByRole('button', { name: 'Inspect current offer', exact: true });
async function inspect(page) {
  await firstInspect(page).click();
  await expect(inspector(page).locator('.pay-details dd').getByText('Current payment terms', { exact: true })).toBeVisible();
}
async function save(page, locator, name) {
  await locator.evaluate((node, key) => {
    const props = Object.keys(node).find((value) => value.startsWith('__reactProps$'));
    if (!props || typeof node[props].onClick !== 'function') throw Error('Actual React handler missing');
    window[key] = node[props].onClick;
  }, name);
}
async function journal(page) {
  return page.evaluate((key) => localStorage.getItem(key), originalKey);
}
async function scenario(browser, name, run, width = 390, seed) {
  const context = await browser.newContext({
    baseURL: process.env.P2P_OFFER_BASE_URL,
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
    state.finish?.();
    writeFileSync(
      join(evidence, name + '-raw.json'),
      JSON.stringify(
        {
          ...state,
          finish: undefined,
          qualification:
            'Actual compiled App, ordinary Login, isolated real contract-shaped reads/mutations. No live KMS/quote/fee/escrow/authority proof.',
        },
        null,
        2,
      ) + '\n',
    );
    await context.close();
  }
}
test('offer arrival and current inspection are readable at four widths', async ({ browser }) => {
  for (const width of [320, 390, 768, 1440])
    await scenario(
      browser,
      'arrival-' + width,
      async ({ page, state }) => {
        await login(page);
        await expect(firstInspect(page)).toBeVisible();
        await stable(page);
        const fit = await firstInspect(page).evaluate((button) => ({
          rect: button.getBoundingClientRect().toJSON(),
          width: innerWidth,
          footer: document.querySelector('.mobile-doors')?.getBoundingClientRect().top || innerHeight,
          scrollWidth: document.documentElement.scrollWidth,
          filtersOpen: document.querySelector('.p2p-offer-filters')?.open,
        }));
        state.observations.push(fit);
        expect(fit.rect.left).toBeGreaterThanOrEqual(0);
        expect(fit.rect.right).toBeLessThanOrEqual(width);
        expect(fit.rect.height).toBeGreaterThanOrEqual(44);
        expect(fit.rect.bottom).toBeLessThanOrEqual(fit.footer);
        expect(fit.scrollWidth).toBeLessThanOrEqual(width);
        expect(fit.filtersOpen).toBe(false);
        await page.screenshot({ path: join(evidence, 'arrival-' + width + '.png') });
        await inspect(page);
        await expect(inspector(page)).not.toContainText('Listed payment terms');
        await expect(inspector(page).locator('.pay-status')).toHaveText('paused');
        await expect(inspector(page)).toContainText('USD / USDT');
        expect(state.reads.filter((read) => read.procedure === 'offers.get')).toHaveLength(1);
        await expect(inspector(page).locator('h2')).toBeFocused();
        await page.screenshot({ path: join(evidence, 'current-' + width + '.png') });
        await inspector(page).getByRole('button', { name: 'Back to offers', exact: true }).click();
        await expect(firstInspect(page)).toBeFocused();
        expect(state.writes).toEqual([]);
      },
      width,
    );
});
test('floating multiplier uses reference dimensions without a fabricated fiat price', async ({ browser }) => {
  await scenario(
    browser,
    'float-320',
    async ({ page, state }) => {
      state.listed.priceType = 'float';
      state.listed.price = '1.02';
      state.current = { ...state.current, priceType: 'float', price: '1.02' };
      await login(page);
      await expect(firstInspect(page)).toBeVisible();
      await inspect(page);
      const price = inspector(page).locator('.p2p-offer-price');
      await expect(price).toContainText('1.02');
      await expect(price).toContainText('× reference price');
      await expect(price).toContainText('Resolved USD / USDT price is not returned.');
      await expect(price).not.toContainText('1.02 USD');
      await expect(inspector(page).getByRole('heading', { name: 'New order review is unavailable' })).toBeVisible();
      await page.screenshot({ path: join(evidence, 'floating-current-320.png') });
      expect(state.writes).toEqual([]);
    },
    320,
  );
});
test('failed and mismatched current records remove old facts; a current retry recovers', async ({ browser }) => {
  for (const [name, reply] of [
    ['failed', { status: 503 }],
    ['wrong-id', { status: 200, data: { ...template, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' } }],
    ['bad-amount', { status: 200, data: { ...template, price: 1.1 } }],
  ]) {
    await scenario(browser, name, async ({ page, state }) => {
      await login(page);
      await inspect(page);
      state.replyGet = async () => reply;
      await inspector(page).getByRole('button', { name: 'Refresh current offer', exact: true }).click();
      await expect(inspector(page)).toContainText('Current price, terms and availability are not shown');
      await expect(inspector(page).locator('.pay-details dd').getByText('Current payment terms', { exact: true })).toHaveCount(0);
      await expect(inspector(page).locator('.p2p-offer-price')).toHaveCount(0);
      state.replyGet = async () => ({ status: 200, data: { ...state.current } });
      await inspector(page).getByRole('button', { name: 'Refresh current offer', exact: true }).click();
      await expect(inspector(page).locator('.pay-details dd').getByText('Current payment terms', { exact: true })).toBeVisible();
      expect(state.writes).toEqual([]);
    });
  }
});
test('owner selected current record survives a bounded market window becoming empty', async ({ browser }) => {
  await scenario(
    browser,
    'owner-window',
    async ({ page, state }) => {
      state.listed.makerId = owner;
      state.current.makerId = owner;
      state.limitEmpty = true;
      await login(page, '/uc/ad');
      await inspect(page);
      await expect(inspector(page).getByRole('button', { name: 'Resume offer', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Show up to 200', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'No offers returned for these filters' })).toBeVisible();
      await expect(inspector(page).locator('.pay-details dd').getByText('Current payment terms', { exact: true })).toBeVisible();
      expect(state.reads.filter((read) => read.procedure === 'offers.get')).toHaveLength(1);
      expect(state.writes).toEqual([]);
    },
    1440,
  );
});
test('retired local reviews and batched URL/hash departures never dispatch saved or late handlers', async ({ browser }) => {
  for (const mode of ['closed', 'depart-return', 'hash-return', 'closed-late'])
    await scenario(browser, mode, async ({ page, state }) => {
      state.listed.makerId = owner;
      state.current = { ...state.current, makerId: owner, status: 'active' };
      await login(page);
      await inspect(page);
      await inspector(page).getByRole('button', { name: 'Pause offer', exact: true }).click();
      const confirm = page.getByRole('dialog').getByRole('button', { name: 'Confirm pause offer', exact: true });
      await save(page, confirm, '__oldConfirm');
      if (mode === 'closed') {
        await page.keyboard.press('Escape');
        await page.evaluate(() => window.__oldConfirm());
      } else if (mode === 'closed-late') {
        await save(page, inspector(page).getByRole('button', { name: 'Back to offers', exact: true }), '__oldBack');
        state.pauseNext = true;
        await confirm.click();
        await expect.poll(() => Boolean(state.finish)).toBe(true);
        await page.evaluate(() => window.__oldBack());
        state.finish();
        await stable(page);
      } else {
        await page.evaluate((mode) => {
          const href = location.href,
            away = mode === 'hash-return' ? href + '#departed' : href + '?departed=1';
          history.pushState(null, '', away);
          dispatchEvent(
            mode === 'hash-return' ? new HashChangeEvent('hashchange', { oldURL: href, newURL: away }) : new PopStateEvent('popstate'),
          );
          history.pushState(null, '', href);
          dispatchEvent(
            mode === 'hash-return' ? new HashChangeEvent('hashchange', { oldURL: away, newURL: href }) : new PopStateEvent('popstate'),
          );
          window.__oldConfirm();
        }, mode);
      }
      await stable(page);
      expect(state.writes).toEqual([]);
      expect(await journal(page)).toBeNull();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    });
});
test('changed reviewed terms and wrong successful mutation replies keep original intent', async ({ browser }) => {
  await scenario(browser, 'changed-terms', async ({ page, state }) => {
    state.current = { ...state.current, makerId: owner, status: 'active' };
    state.listed.makerId = owner;
    await login(page);
    await inspect(page);
    await inspector(page).getByRole('button', { name: 'Pause offer', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText(offerId);
    await expect(page.getByRole('dialog')).toContainText('12.345678901234567801');
    state.current.terms = 'Changed after review';
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm pause offer', exact: true }).click();
    await expect(inspector(page).getByText('Changed after review', { exact: true })).toBeVisible();
    expect(state.writes).toEqual([]);
    expect(await journal(page)).toBeNull();
  });
  for (const kind of ['wrong-id', 'unchanged'])
    await scenario(browser, 'reply-' + kind, async ({ page, state }) => {
      state.current = { ...state.current, makerId: owner, status: 'active' };
      state.listed.makerId = owner;
      state.replyWrite = async () => ({
        status: 200,
        data: { ...state.current, ...(kind === 'wrong-id' ? { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', status: 'paused' } : {}) },
      });
      await login(page);
      await inspect(page);
      await inspector(page).getByRole('button', { name: 'Pause offer', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Confirm pause offer', exact: true }).click();
      await expect(inspector(page).getByRole('heading', { name: 'Original offer action is unresolved' })).toBeVisible();
      expect(JSON.parse(await journal(page))).toEqual({ status: 'uncertain', reference: 'pause' });
      expect(state.writes).toHaveLength(1);
    });
});
test('unknown originals survive tab closure, independent owner entry and failed current reads; only matching feature proof clears', async ({
  browser,
}) => {
  await scenario(browser, 'original-life', async ({ page, context, state }) => {
    state.current = { ...state.current, makerId: owner, status: 'active' };
    state.listed.makerId = owner;
    await login(page);
    await inspect(page);
    await inspector(page).getByRole('button', { name: 'Pause offer', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm pause offer', exact: true }).click();
    await expect(inspector(page).getByRole('heading', { name: 'Original offer action is unresolved' })).toBeVisible();
    const original = await journal(page);
    expect(JSON.parse(original)).toEqual({ status: 'uncertain', reference: 'pause' });
    expect(original).not.toContain('payment');
    await page.close();
    const returned = await context.newPage();
    state.replyGet = async () => ({ status: 503 });
    await login(returned);
    await returned.locator('.p2p-offer-device').getByRole('button', { name: offerId, exact: true }).click();
    await expect(inspector(returned).getByRole('button', { name: 'Check original offer action', exact: true })).toBeVisible();
    await expect(inspector(returned)).toContainText('Current price, terms and availability are not shown');
    expect(await journal(returned)).toBe(original);
    await pageScreenshot(returned, 'original-failed.png');
    await inspector(returned).getByRole('button', { name: 'Check original offer action', exact: true }).click();
    await stable(returned);
    expect(await journal(returned)).toBe(original);
    state.current.status = 'paused';
    state.replyGet = async () => ({ status: 200, data: { ...state.current } });
    await inspector(returned).getByRole('button', { name: 'Check original offer action', exact: true }).click();
    await expect.poll(() => journal(returned)).toBeNull();
    expect(state.writes).toHaveLength(1);
  });
});
async function pageScreenshot(page, name) {
  await page.screenshot({ path: join(evidence, name) });
}
test('a known paused reference can resume and close with current full reviews', async ({ browser }) => {
  await scenario(browser, 'resume-close-known', async ({ page, state }) => {
    state.listed = { ...state.listed, makerId: owner, status: 'paused' };
    state.current = { ...state.current, makerId: owner, status: 'paused' };
    state.replyWrite = async ({ procedure, input }) => {
      expect(input).toEqual({ offerId });
      expect(['offers.resume', 'offers.close']).toContain(procedure);
      state.current.status = procedure === 'offers.resume' ? 'active' : 'closed';
      state.listed.status = state.current.status;
      return { status: 200, data: { ...state.current } };
    };
    await login(page, '/uc/ad');
    await page.locator('.p2p-offer-known > summary').click();
    await page.locator('.p2p-offer-known input').fill(offerId);
    await page.locator('.p2p-offer-known button').click();
    await expect(inspector(page).locator('.pay-details dd').getByText('Current payment terms', { exact: true })).toBeVisible();
    await inspector(page).getByRole('button', { name: 'Resume offer', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText(offerId);
    await expect(page.getByRole('dialog')).toContainText('Current payment terms');
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm resume offer', exact: true }).click();
    await expect(inspector(page).locator('.p2p-offer-role .pay-status')).toHaveText('active');
    expect(await journal(page)).toBeNull();
    await expect.poll(() => state.reads.filter((read) => read.procedure === 'offers.list').length).toBe(2);
    await inspector(page).getByRole('button', { name: 'Close offer', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('Existing order escrow remains governed by each order.');
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm close offer', exact: true }).click();
    await expect(inspector(page).locator('.p2p-offer-role .pay-status')).toHaveText('closed');
    await expect(inspector(page).getByRole('button', { name: 'Resume offer', exact: true })).toHaveCount(0);
    expect(await journal(page)).toBeNull();
    expect(state.writes.map((write) => write.procedure)).toEqual(['offers.resume', 'offers.close']);
    await page.screenshot({ path: join(evidence, 'known-closed-390.png') });
  });
});
test('unreadable original storage prevents owner availability submission', async ({ browser }) => {
  await scenario(
    browser,
    'storage-unreadable',
    async ({ page, state }) => {
      state.current = { ...state.current, makerId: owner, status: 'active' };
      state.listed.makerId = owner;
      await login(page);
      await inspect(page);
      await expect(inspector(page).getByRole('heading', { name: 'Recovery storage unavailable' })).toBeVisible();
      await expect(inspector(page).getByRole('button', { name: 'Pause offer', exact: true })).toHaveCount(0);
      await inspector(page).getByRole('button', { name: 'Check original offer action', exact: true }).click();
      expect(state.writes).toEqual([]);
    },
    390,
    {
      script: () => {
        const read = Storage.prototype.getItem;
        Storage.prototype.getItem = function (key) {
          if (key.startsWith('pay.unresolved:')) throw new DOMException('Isolated unreadable original storage', 'SecurityError');
          return read.call(this, key);
        };
      },
    },
  );
});
test('a known original reply with failed local cleanup is recovered without another POST', async ({ browser }) => {
  await scenario(browser, 'known-cleanup', async ({ page, state }) => {
    state.current = { ...state.current, makerId: owner, status: 'active' };
    state.listed.makerId = owner;
    state.replyWrite = async () => {
      state.current.status = 'paused';
      state.listed.status = 'paused';
      return { status: 200, data: { ...state.current } };
    };
    await login(page);
    await inspect(page);
    await page.evaluate((key) => {
      const remove = Storage.prototype.removeItem;
      window.__blockCleanup = true;
      Storage.prototype.removeItem = function (value) {
        if (window.__blockCleanup && value === key) throw new DOMException('Isolated cleanup failure', 'SecurityError');
        return remove.call(this, value);
      };
    }, originalKey);
    await inspector(page).getByRole('button', { name: 'Pause offer', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm pause offer', exact: true }).click();
    await expect(inspector(page).getByRole('heading', { name: 'Original reply received · recovery record retained' })).toBeVisible();
    await expect.poll(() => state.reads.filter((read) => read.procedure === 'offers.list').length).toBe(2);
    expect(JSON.parse(await journal(page))).toEqual({ status: 'uncertain', reference: 'pause' });
    await page.evaluate(() => (window.__blockCleanup = false));
    await inspector(page).getByRole('button', { name: 'Retry local cleanup', exact: true }).click();
    await expect.poll(() => journal(page)).toBeNull();
    expect(state.writes).toHaveLength(1);
  });
});
test('a batched current-record refresh retires the saved review before its preflight', async ({ browser }) => {
  await scenario(browser, 'refresh-retired', async ({ page, state }) => {
    state.current = { ...state.current, makerId: owner, status: 'active' };
    state.listed.makerId = owner;
    await login(page);
    await inspect(page);
    await inspector(page).getByRole('button', { name: 'Pause offer', exact: true }).click();
    await save(page, page.getByRole('dialog').getByRole('button', { name: 'Confirm pause offer', exact: true }), '__oldConfirm');
    await save(page, inspector(page).getByRole('button', { name: 'Refresh current offer', exact: true }), '__refresh');
    await page.evaluate(() => {
      window.__refresh();
      window.__oldConfirm();
    });
    await stable(page);
    expect(state.writes).toEqual([]);
    expect(await journal(page)).toBeNull();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});
test('passive locale changes preserve focus, exact quantities, all destinations and translated input errors', async ({ browser }) => {
  await scenario(
    browser,
    'locale-long',
    async ({ page, context, state }) => {
      state.current.remainingAmount = '12345678901234567890.123456789012345678';
      state.listed.remainingAmount = state.current.remainingAmount;
      await login(page);
      await inspect(page);
      const refresh = inspector(page).getByRole('button', { name: 'Refresh current offer', exact: true });
      await refresh.focus();
      await page.evaluate(() => {
        window.__focusBefore = document.activeElement;
      });
      const peer = await context.newPage();
      await peer.goto('/help');
      await peer.evaluate(() => {
        const key = 'intafaced.customer.view.v1';
        localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) || '{}'), language: 'es' }));
      });
      await expect(inspector(page)).toContainText('Oferta actual');
      expect(await page.evaluate(() => document.activeElement === window.__focusBefore)).toBe(true);
      const exact = inspector(page)
        .locator('.pay-amount-scroll[tabindex="0"]')
        .filter({
          has: page.locator(`[data-exact-amount="${state.current.remainingAmount}"]`),
        });
      await expect(exact).toBeVisible();
      await exact.focus();
      await page.keyboard.press('End');
      expect(await exact.evaluate((n) => n.scrollLeft)).toBeGreaterThan(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
      await expect(exact.locator('.pay-amount-digits')).toHaveAttribute('data-exact-amount', state.current.remainingAmount);
      expect((await exact.textContent()).replaceAll(',', '')).toBe(state.current.remainingAmount);
      await expect(page.locator('.pay-room-tabs a')).toHaveCount(5);
      await inspector(page).getByRole('button', { name: 'Volver a las ofertas', exact: true }).click();
      await page.locator('.p2p-offer-known > summary').click();
      await page.locator('.p2p-offer-known input').fill('invalid');
      await page.locator('.p2p-offer-known button').click();
      await expect(page.getByRole('alert')).toContainText('Introduce un ID de oferta válido.');
      await peer.evaluate(() => localStorage.setItem('intafaced.customer.view.v1', JSON.stringify({ language: 'fr' })));
      await expect(page.getByRole('alert')).toContainText('Saisissez un ID d’offre valide.');
      const links = page.locator('.pay-room-tabs a');
      await links.first().focus();
      for (let index = 0; index < 5; index++) {
        if (index) await page.keyboard.press('Tab');
        await expect(links.nth(index)).toBeFocused();
        await stable(page);
        const rect = await links.nth(index).boundingBox();
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.width).toBeLessThanOrEqual(320);
      }
      expect(state.writes).toEqual([]);
    },
    320,
  );
});
test('unreadable original and retired late proof refuse without destroying original storage', async ({ browser }) => {
  await scenario(
    browser,
    'opaque',
    async ({ page, state }) => {
      state.current = { ...state.current, makerId: owner, status: 'active' };
      state.listed.makerId = owner;
      await login(page);
      await inspect(page);
      await expect(inspector(page).getByRole('heading', { name: 'Original offer action is unresolved' })).toBeVisible();
      await expect(inspector(page).getByRole('button', { name: 'Pause offer', exact: true })).toHaveCount(0);
      await inspector(page).getByRole('button', { name: 'Check original offer action', exact: true }).click();
      expect(await journal(page)).toBe('opaque-unreadable-original');
      expect(state.writes).toEqual([]);
    },
    390,
    {
      script: ({ key }) => {
        if (location.protocol !== 'http:') return;
        localStorage.setItem(key, 'opaque-unreadable-original');
      },
      args: { key: originalKey },
    },
  );
  await scenario(
    browser,
    'late-proof',
    async ({ page, state }) => {
      state.current = { ...state.current, makerId: owner, status: 'paused' };
      state.listed.makerId = owner;
      await login(page);
      await inspect(page);
      const original = await journal(page);
      state.pauseNext = true;
      await inspector(page).getByRole('button', { name: 'Check original offer action', exact: true }).click();
      await expect.poll(() => Boolean(state.finish)).toBe(true);
      await inspector(page).getByRole('button', { name: 'Back to offers', exact: true }).click();
      state.finish();
      await stable(page);
      expect(await journal(page)).toBe(original);
      expect(state.writes).toEqual([]);
    },
    390,
    {
      script: ({ key }) => {
        if (location.protocol !== 'http:') return;
        localStorage.setItem(key, JSON.stringify({ status: 'uncertain', reference: 'pause' }));
      },
      args: { key: originalKey },
    },
  );
});
