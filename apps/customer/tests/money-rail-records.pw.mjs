import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const owner = '11111111-1111-4111-8111-111111111111';
const evidence = process.env.RAIL_RECORDS_EVIDENCE;
mkdirSync(evidence, { recursive: true });
export const programme = {
  id: 'none',
  simulated: true,
  displayName: 'No bank ramp programme',
  cryptoRail: null,
  fiatLeg: 'socket.psp-partners',
  fiatVia: 'svc-pay.RailAdapter',
};
export function records(direction, count = 20, principal = owner) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${principal === owner ? '81' : '91'}${direction === 'in' ? '00' : '10'}0000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    assetId: 'USDT',
    amount: '12.345678901234567801',
    kind: 'crypto',
    rail: 'bank-crypto-ledger',
    simulated: true,
    status: index % 3 === 0 ? 'pending' : index % 3 === 1 ? 'settled' : 'rejected',
    createdAt: new Date(Date.UTC(2026, 9, 10, 12, 0) - index * 60000).toISOString(),
    ...(direction === 'in'
      ? {
          railRef: `deposit-rail-reference-${String(index + 1).padStart(4, '0')}`,
          ledgerTxId: index % 3 === 1 ? `ledger-deposit-${index + 1}` : null,
        }
      : {
          destinationRef: '0x1111111111111111111111111111111111111111',
          clientRef: `withdraw-client-${index + 1}`,
          holdLedgerTxId: index % 3 === 2 ? null : `ledger-hold-${index + 1}`,
          settleLedgerTxId: index % 3 === 1 ? `ledger-settle-${index + 1}` : null,
        }),
  }));
}
export async function network(context) {
  const state = {
    owner,
    rows: { in: records('in'), out: records('out') },
    reads: [],
    writes: [],
    documents: [],
    errors: [],
    fixtureErrors: [],
    transportErrors: [],
    logins: [],
  };
  const observe = (page) => {
    page.on('pageerror', (e) => state.errors.push(e.message));
    page.on('request', (r) => {
      if (r.isNavigationRequest() && r.frame() === page.mainFrame()) state.documents.push(r.url());
    });
  };
  context.pages().forEach(observe);
  context.on('page', observe);
  const refusal = (status, code, message) => ({
    status,
    json: {
      error: {
        message,
        data: {
          code: status === 401 ? 'UNAUTHORIZED' : status === 403 ? 'FORBIDDEN' : status === 400 ? 'BAD_REQUEST' : 'SERVICE_UNAVAILABLE',
          httpStatus: status,
          cause: { code },
        },
      },
    },
  });
  state.refusal = refusal;
  state.reply = async (direction) => ({ status: 200, data: state.rows[direction] });
  await context.route('**/api/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      procedure = decodeURIComponent(url.pathname.split('/').at(-1));
    const rpc = (data) => route.fulfill({ status: 200, json: { result: { data } } });
    const send = (reply) => (reply.status === 200 ? rpc(reply.data) : route.fulfill({ status: reply.status, json: reply.json }));
    if (procedure === 'auth.login') {
      const token = `rail-owner-token-${state.logins.length + 1}`;
      state.logins.push({ owner: state.owner, token });
      return rpc({
        userId: state.owner,
        accessToken: token,
        refreshToken: `rail-refresh-${state.logins.length}`,
        expiresAt: '2027-10-10T00:00:00Z',
      });
    }
    if (procedure === 'auth.logout') return rpc({ ok: true });
    if (req.method() !== 'GET') {
      state.writes.push({ procedure, body: req.postData() });
      return send(refusal(503, 'fixture.no_dispatch', 'No financial dispatch is supplied'));
    }
    const input = JSON.parse(url.searchParams.get('input') || 'null'),
      authorization = req.headers().authorization;
    const principal = state.logins.find((l) => `Bearer ${l.token}` === authorization)?.owner;
    const read = { procedure, input, principal, authorization };
    state.reads.push(read);
    if (!principal) return send(refusal(401, 'auth.required', 'Authentication required'));
    try {
      if (procedure === 'ramps.programme') return rpc(programme);
      if (procedure === 'ramps.fiatSettle')
        return send(refusal(400, 'bank.fiat_ramp_socket', 'Fiat partner and programme authority are not connected'));
      if (procedure === 'ramps.onramps' || procedure === 'ramps.offramps') {
        if (
          !input ||
          Object.keys(input).some((k) => k !== 'limit') ||
          !Number.isInteger(input.limit) ||
          input.limit < 1 ||
          input.limit > 200
        ) {
          state.fixtureErrors.push(read);
          return send(refusal(400, 'fixture.invalid_input', 'Explicit owner limit required'));
        }
        const reply = await state.reply(procedure === 'ramps.onramps' ? 'in' : 'out', { read, principal, input });
        read.reply = reply;
        return send(reply.status === 200 && Array.isArray(reply.data) ? { ...reply, data: reply.data.slice(0, input.limit) } : reply);
      }
      if (url.pathname.endsWith('/account/balance'))
        return route.fulfill({ status: 200, json: { timestamp: 1791621900000, datetime: '2026-10-10T08:45:00.000Z', balances: {} } });
      return send(refusal(503, 'fixture.unsupplied_read', 'This isolated read is not supplied'));
    } catch (e) {
      state.transportErrors.push({ procedure, message: e.message });
    }
  });
  return state;
}
export async function login(page, destination = '/bank/ramps') {
  await page.goto(`/login?redirect=${encodeURIComponent(destination)}`);
  await page.locator('input[name="identifier"]').fill('rail-owner@example.invalid');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
  await expect.poll(() => page.evaluate(() => location.pathname + location.search + location.hash)).toBe(destination);
  await expect(page.locator('#main h1')).toBeVisible();
}

async function scenario(browser, name, run, width = 320, seed) {
  const context = await browser.newContext({
    baseURL: process.env.RAIL_RECORDS_BASE_URL,
    viewport: { width, height: width < 768 ? 844 : 1000 },
    timezoneId: 'UTC',
  });
  const state = await network(context);
  if (seed) await context.addInitScript(seed.script, seed.args);
  const page = await context.newPage();
  try {
    await run({ page, context, state });
    expect(state.errors).toEqual([]);
    expect(state.fixtureErrors).toEqual([]);
    expect(state.transportErrors).toEqual([]);
    expect(state.writes).toEqual([]);
  } finally {
    writeFileSync(
      join(evidence, name + '-raw.json'),
      JSON.stringify(
        {
          ...state,
          qualification:
            'Actual compiled App with isolated principal/contract-shaped replies; not live provider/SQL/custody/original settlement authority.',
        },
        null,
        2,
      ),
    );
    await context.close();
  }
}
async function capture(page, state, name) {
  const geometry = await page.locator('#main').evaluate((n) => ({
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    scrollY,
    footerTop: document.querySelector('.mobile-doors')?.getClientRects().length
      ? document.querySelector('.mobile-doors').getBoundingClientRect().top
      : innerHeight,
    selected: n.querySelector('.money-selected-ramp')?.getBoundingClientRect().toJSON(),
    facts: n.querySelector('.money-ramp-facts')?.getBoundingClientRect().toJSON(),
    first: n.querySelector('.money-ramp-record')?.getBoundingClientRect().toJSON(),
    heading: n.querySelector('#money-selected-ramp-heading')?.getBoundingClientRect().toJSON(),
    active: document.activeElement?.id,
    dom: n.outerHTML,
  }));
  state.geometry ??= [];
  state.geometry.push({ name, ...geometry });
  await page.screenshot({ path: join(evidence, name + '-viewport.png') });
  await page.screenshot({ path: join(evidence, name + '-whole.png'), fullPage: true });
  return geometry;
}
const select = async (page, id, keyboard = false) => {
  const b = page.getByRole('button', { name: 'Inspect rail record ' + id, exact: true });
  if (keyboard) {
    await b.focus();
    await page.keyboard.press('Enter');
  } else await b.click();
  await expect(page.locator('.money-selected-ramp')).toContainText(id);
};
test('current owner incoming and outgoing inspection preserves whole reference and exact quantity at four widths', async ({ browser }) => {
  for (const direction of ['in', 'out'])
    for (const width of [320, 390, 768, 1440])
      await scenario(
        browser,
        direction + '-arrival-' + width,
        async ({ page, state }) => {
          await login(page);
          if (direction === 'out') await page.getByRole('button', { name: 'Outgoing', exact: true }).click();
          const row = state.rows[direction][0];
          await expect(page.locator('.money-ramp-record')).toHaveCount(20);
          const before = await capture(page, state, direction + '-list-' + width);
          expect(before.first.bottom).toBeLessThanOrEqual(before.footerTop);
          await select(page, row.id, width !== 320);
          const panel = page.locator('.money-selected-ramp');
          await expect(panel).toContainText('12.345678901234567801');
          await expect(panel).toContainText('USDT');
          await expect(panel).toContainText('pending');
          await expect(panel).toContainText('Reference not returned');
          await expect(panel).not.toContainText('Not posted');
          await expect(panel).toContainText('Simulation record');
          await expect(panel).toContainText('do not confirm live delivery');
          if (direction === 'in') await expect(panel).toContainText(row.railRef);
          else for (const value of [row.destinationRef, row.clientRef, row.holdLedgerTxId]) await expect(panel).toContainText(value);
          const arrival = await capture(page, state, direction + '-selected-' + width);
          expect(arrival.heading.top).toBeGreaterThanOrEqual(0);
          expect(arrival.facts.bottom).toBeLessThanOrEqual(arrival.footerTop);
          expect(arrival.scrollWidth).toBeLessThanOrEqual(width);
          expect(arrival.active).toBe('money-selected-ramp-heading');
          expect(state.documents).toHaveLength(1);
          expect(
            state.reads
              .filter((r) => r.procedure === 'ramps.' + (direction === 'in' ? 'onramps' : 'offramps'))
              .every((r) => r.input.limit === 50 && r.principal === owner),
          ).toBe(true);
        },
        width,
      );
});
test('current record reads retire facts on failure missing conflict and malformed replies and recover through current controls', async ({
  browser,
}) => {
  await scenario(browser, 'current-read-recovery', async ({ page, state }) => {
    await login(page);
    const row = state.rows.in[0];
    await select(page, row.id);
    const panel = page.locator('.money-selected-ramp');
    state.reply = async () => state.refusal(400, 'bank.ramp_read_unavailable', 'Isolated current record read failed');
    await page.getByRole('button', { name: 'Refresh records', exact: true }).click();
    await expect(panel).toContainText('Isolated current record read failed');
    await expect(panel.locator('.money-ramp-facts')).toHaveCount(0);
    await expect(panel).toContainText(row.id);
    await capture(page, state, 'current-read-failure-320');
    state.reply = async () => ({ status: 200, data: [row] });
    await panel.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(panel).toContainText(row.railRef);
    state.reply = async () => ({ status: 200, data: [] });
    await page.getByRole('button', { name: 'Refresh records', exact: true }).click();
    await expect(panel).toContainText('Record not in this response');
    await expect(panel).not.toContainText(row.railRef);
    state.reply = async () => ({ status: 200, data: [row, { ...row, id: row.id.toUpperCase() }] });
    await panel.getByRole('button', { name: 'Refresh records', exact: true }).click();
    await expect(panel).toContainText('Record could not be identified');
    await expect(panel.locator('.money-ramp-facts')).toHaveCount(0);
    state.reply = async () => ({ status: 200, data: [{ ...row, amount: 12.3 }] });
    await panel.getByRole('button', { name: 'Refresh records', exact: true }).click();
    await expect(panel.locator('.money-ramp-facts')).toHaveCount(0);
    await expect(panel).not.toContainText(row.railRef);
    state.reply = async () => ({ status: 200, data: [row] });
    await panel.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(panel).toContainText(row.railRef);
    await page.getByRole('button', { name: 'All records', exact: true }).click();
    await expect(page.locator('.money-selected-ramp')).toHaveCount(0);
    await expect(page.locator('#money-ramp-list-heading')).toBeFocused();

    expect(state.documents).toHaveLength(1);
  });
  await scenario(
    browser,
    'bounded-current-window',
    async ({ page, state }) => {
      state.rows.in = records('in', 200);
      await login(page);
      await expect(page.locator('.money-ramp-record')).toHaveCount(50);
      for (const count of [100, 150, 200]) {
        await page.getByRole('button', { name: 'Load up to ' + count, exact: true }).click();
        await expect(page.locator('.money-ramp-record')).toHaveCount(count);
      }
      await expect(page.getByRole('button', { name: /^Load up to / })).toHaveCount(0);
      const limits = state.reads.filter((r) => r.procedure === 'ramps.onramps').map((r) => r.input.limit);
      expect(limits.filter((v, i) => i === 0 || limits[i - 1] !== v)).toEqual([50, 100, 150, 200]);
      expect(limits.every((v) => [50, 100, 150, 200].includes(v))).toBe(true);
      await select(page, state.rows.in[199].id, true);
      await expect(page.locator('.money-selected-ramp')).toContainText(state.rows.in[199].railRef);
    },
    1440,
  );
});

test('URL departures late responses and owner changes retire inspector handlers while originals remain durable', async ({ browser }) => {
  await scenario(browser, 'url-and-late-response', async ({ page, state }) => {
    await login(page);
    const row = state.rows.in[0];
    await expect(page.locator('.money-ramp-record')).toHaveCount(20);
    await page.getByRole('button', { name: 'Inspect rail record ' + row.id, exact: true }).evaluate((b) => {
      const p = Object.keys(b).find((k) => k.startsWith('__reactProps$'));
      if (!p || typeof b[p].onClick !== 'function') throw Error('Current native inspector handler unavailable');
      window.__savedRailInspect = b[p].onClick;
    });
    await page.evaluate(() => {
      history.pushState({}, '', '/bank/ramps?departed=1#changed');
      dispatchEvent(new PopStateEvent('popstate'));
      history.pushState({}, '', '/bank/ramps');
      dispatchEvent(new PopStateEvent('popstate'));
      window.__savedRailInspect();
    });
    await expect(page.locator('.money-selected-ramp')).toHaveCount(0);
    await expect(page.locator('.money-ramp-record')).toHaveCount(20);
    await select(page, row.id);
    let finish;
    state.reply = (direction) =>
      direction === 'in'
        ? new Promise((r) => {
            finish = r;
          })
        : Promise.resolve({ status: 200, data: state.rows.out });
    await page.getByRole('button', { name: 'Refresh records', exact: true }).click();
    await expect.poll(() => typeof finish).toBe('function');
    await page.getByRole('button', { name: 'Outgoing', exact: true }).click();
    await expect(page.locator('.money-ramp-record')).toHaveCount(20);
    finish({ status: 200, data: [{ ...row, railRef: 'retired-private-rail-reference' }] });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await expect(page.locator('#main')).not.toContainText('retired-private-rail-reference');
    await expect(page.locator('.money-selected-ramp')).toHaveCount(0);
    await capture(page, state, 'late-prior-direction-320');
  });
  const originalKey = 'intafaced.customer.bank-unconfirmed.v1:' + owner;
  const saved = [
    {
      reference: '77777777-7777-4777-8777-777777777777',
      title: 'Unknown original',
      procedure: 'transfers.create',
      recordRefs: { fromSpaceId: '55555555-5555-4555-8555-555555555555', toSpaceId: '66666666-6666-4666-8666-666666666666' },
    },
  ];
  await scenario(
    browser,
    'original-and-owner',
    async ({ page, state }) => {
      await login(page);
      const row = state.rows.in[0];
      await select(page, row.id);
      expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), originalKey)).toEqual(saved);
      const serialized = await page.evaluate(() =>
        JSON.stringify({
          local: Object.fromEntries(Object.entries(localStorage)),
          session: Object.fromEntries(Object.entries(sessionStorage)),
        }),
      );
      expect(serialized).not.toContain(row.amount);
      expect(serialized).not.toContain(row.railRef);
      await page.getByRole('button', { name: 'All records', exact: true }).click();
      await page.getByRole('button', { name: 'Inspect rail record ' + row.id, exact: true }).evaluate((b) => {
        const p = Object.keys(b).find((k) => k.startsWith('__reactProps$'));
        window.__savedRailInspect = b[p].onClick;
      });
      await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(page.locator('.money-ramp-record')).toHaveCount(0);
      state.owner = '22222222-2222-4222-8222-222222222222';
      state.rows = { in: records('in', 20, state.owner), out: records('out', 20, state.owner) };
      await page.evaluate(() => {
        history.pushState({}, '', '/login?redirect=%2Fbank%2Framps');
        dispatchEvent(new PopStateEvent('popstate'));
      });
      await page.locator('input[name="identifier"]').fill('other-owner@example.invalid');
      await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
      await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
      await expect(page.locator('.money-ramp-record')).toHaveCount(20);
      await page.evaluate(() => window.__savedRailInspect());
      await expect(page.locator('.money-selected-ramp')).toHaveCount(0);
      await expect(page.locator('#main')).not.toContainText(row.id);
      expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), originalKey)).toEqual(saved);
      await capture(page, state, 'new-owner-retired-inspector-390');
    },
    390,
    {
      script: ({ key, value }) => {
        if (location.origin !== 'null') localStorage.setItem(key, JSON.stringify(value));
      },
      args: { key: originalKey, value: saved },
    },
  );
});

test('passive display changes long references and unreadable original storage preserve honest read-only inspection', async ({
  browser,
}) => {
  await scenario(
    browser,
    'passive-display-390',
    async ({ page, context, state }) => {
      await login(page);
      const row = state.rows.in[0];
      await select(page, row.id);
      const panel = page.locator('.money-selected-ramp');
      const focused = panel.locator('header button');
      await focused.focus();
      const peer = await context.newPage();
      await peer.goto('/help');
      const preferences = async (language, hideBalances) => {
        await peer.evaluate(
          ({ language, hideBalances }) => {
            const key = 'intafaced.customer.view.v1';
            localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) || '{}'), language, hideBalances }));
          },
          { language, hideBalances },
        );
      };
      for (const language of ['es', 'fr', 'ar']) {
        await preferences(language, true);
        await expect(panel.locator('.numeric')).toHaveText('••••');
        await expect(panel).not.toContainText(row.amount);
        await expect(panel).toContainText(row.railRef);
        await expect(page.locator('.money-rail-window')).toHaveAttribute('lang', language === 'ar' ? 'en' : language);
        await expect(page.locator('.money-rail-window')).toHaveAttribute('dir', 'ltr');
        await expect(focused).toBeFocused();
      }
      await preferences('en', false);
      await expect(panel.locator('.numeric')).toHaveText(row.amount);
      await expect(focused).toBeFocused();
      const refresh = page.getByRole('button', { name: 'Refresh records', exact: true });
      state.rows.in = [{ ...row, railRef: 'current-response-reference' }];
      await refresh.click();
      await expect(panel).toContainText('current-response-reference');
      await expect(refresh).toBeFocused();
      await capture(page, state, 'passive-current-response-390');
    },
    390,
  );
  await scenario(browser, 'long-and-missing-values-320', async ({ page, state }) => {
    const row = {
      ...state.rows.in[0],
      assetId: 'CHAIN_ASSET_WITH_AN_EXTENDED_SERVICE_IDENTIFIER_'.repeat(3),
      railRef: 'service-reference:'.repeat(20),
      rail: 'a-very-long-reported-rail-'.repeat(6),
      status: 'a-long-status-reported-by-the-service',
      amount: '12345678901234567890.123456789012345678',
    };
    state.rows.in = [row];
    await login(page);
    await select(page, row.id, true);
    const panel = page.locator('.money-selected-ramp');
    await expect(panel).toContainText(row.assetId);
    await expect(panel).toContainText(row.railRef);
    await expect(panel.locator('.numeric')).toHaveText('12,345,678,901,234,567,890.123456789012345678');
    const frame = await capture(page, state, 'long-selected-320');
    expect(frame.scrollWidth).toBeLessThanOrEqual(320);
    expect(frame.heading.top).toBeGreaterThanOrEqual(0);
    await panel.locator('.money-ramp-notes p').last().scrollIntoViewIfNeeded();
    await page.evaluate(() => scrollBy(0, 84));
    const last = await panel.locator('.money-ramp-notes p').last().boundingBox();
    expect(last.y + last.height).toBeLessThanOrEqual(775);
    state.rows.in = [{ ...row, assetId: '', railRef: '', rail: '', status: '' }];
    await page.getByRole('button', { name: 'Refresh records', exact: true }).click();
    await expect(panel).toContainText('Asset not returned');
    await expect(panel).toContainText('Value not returned');
    await expect(panel.locator('.numeric')).toHaveCount(0);
    await capture(page, state, 'missing-values-320');
  });
  await scenario(
    browser,
    'unreadable-original-read-only-320',
    async ({ page, state }) => {
      await login(page);
      await select(page, state.rows.in[0].id);
      await expect(page.locator('.money-selected-ramp')).toContainText(state.rows.in[0].railRef);
      await capture(page, state, 'unreadable-original-inspection-320');
    },
    320,
    {
      script: () => {
        const original = Storage.prototype.getItem;
        Storage.prototype.getItem = function (key) {
          if (key.startsWith('intafaced.customer.bank-unconfirmed.v1:'))
            throw new DOMException('Original storage unreadable', 'SecurityError');
          return original.call(this, key);
        };
      },
    },
  );
});

test('funding destinations remain reachable by keyboard without discarding the unknown original', async ({ browser }) => {
  const key = 'intafaced.customer.bank-unconfirmed.v1:' + owner;
  const saved = [{ reference: '77777777-7777-4777-8777-777777777777', title: 'Unknown original', procedure: 'transfers.create' }];
  for (const target of ['/uc/recharge', '/uc/withdraw']) {
    await scenario(
      browser,
      target.endsWith('recharge') ? 'deposit-destination-320' : 'withdrawal-destination-320',
      async ({ page, state }) => {
        await login(page);
        await expect(page.locator('.money-ramp-record')).toHaveCount(20);
        for (const path of [
          '/bank',
          '/bank/spaces',
          '/bank/transfers',
          '/bank/earn',
          '/bank/loans',
          '/bank/cards',
          '/bank/ramps',
          '/bank/analytics',
          '/bank/business',
        ])
          await expect(page.locator('.money-bank-nav a[href="' + path + '"]')).toHaveCount(1);
        await page.locator('.money-ramp-entry a[href="' + target + '"]').focus();
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(new URL(target, process.env.RAIL_RECORDS_BASE_URL).href);
        await expect(page.locator('#main h1')).toBeVisible();
        await expect(page.locator('#main')).toBeFocused();
        await expect(page.locator('.money-ramp-record')).toHaveCount(0);
        expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), key)).toEqual(saved);
        await capture(page, state, target.endsWith('recharge') ? 'deposit-arrival-320' : 'withdrawal-arrival-320');
      },
      320,
      {
        script: ({ key, saved }) => {
          if (location.origin !== 'null') localStorage.setItem(key, JSON.stringify(saved));
        },
        args: { key, saved },
      },
    );
  }
});
