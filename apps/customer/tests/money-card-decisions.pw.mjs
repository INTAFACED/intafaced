import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// External fixture-only draft. No test case, future Cards selector or execution.
// Inline into the eventual two root-assigned native files after fixed renderer review.
import { createHash } from 'node:crypto';

const fixedFixtureSource = 'ea4fbd9599e09a31f8e4534ffeb4e8b2f9790cce';
const ownerA = '11111111-1111-4111-8111-111111111111';
const ownerB = '99999999-9999-4999-8999-999999999999';
const primaryId = '22222222-2222-4222-8222-222222222222';
const destinationSpaceId = '33333333-3333-4333-8333-333333333333';
const originalReference = '77777777-7777-4777-8777-777777777777';
const bankOriginalKey = `intafaced.customer.bank-unconfirmed.v1:${ownerA}`;
const bankOriginalRaw = ` [ ${JSON.stringify({ reference: originalReference, title: 'Original transfer', procedure: 'transfers.create', recordRefs: { transferId: originalReference, fromSpaceId: primaryId } })} ] `;
const main = (page) => page.locator('#main');
const currentURL = (page) => page.evaluate(() => location.pathname + location.search + location.hash);
const absentProgramme = { id: 'none', simulated: true, displayName: 'No card programme' };
const simulatedProgramme = { id: 'card-sim', simulated: true, displayName: 'Simulated card (no card programme)' };

function cardRows(principal = ownerA, count = 20, assetId = 'USDT') {
  return Array.from({ length: count }, (_, index) => {
    const id =
      principal === ownerA && index === 8
        ? '61000000-0000-4000-8000-000000028537'
        : `${principal === ownerA ? '61000000' : '71000000'}-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    return {
      id,
      assetId,
      settlementAssetId: index === 3 ? 'EUR' : assetId,
      issuer: 'card-sim',
      simulated: true,
      panTail: String(parseInt(createHash('sha256').update(id).digest('hex').slice(0, 8), 16) % 10000).padStart(4, '0'),
      status: index === 10 ? 'frozen' : index === 15 ? 'closed' : 'active',
      cashbackBps: 100,
      perAuthorizationLimit: `${index + 11}.${String(index + 1).padStart(18, '0')}`,
    };
  });
}
function decisionRows(card, count = 3) {
  return Array.from({ length: count }, (_, index) => {
    const declined = index % 3 === 1;
    const conversion = card.settlementAssetId !== card.assetId;
    const amount = index % 3 === 2 || declined ? '3.000000000000000009' : '12.345678901234567801';
    const decidedEpoch = Date.UTC(2026, 9, 10, 12, 0, 0) - index * 60000;
    return {
      id: `${card.id.startsWith('61') ? '62000000' : '72000000'}-0000-4000-8000-${String(BigInt(card.id.slice(-12)) * 1000n + BigInt(index + 1)).padStart(12, '0')}`,
      authorizationRef: `card-auth-${card.id}-${String(index + 1).padStart(3, '0')}-opaque-reference`,
      amount,
      merchantCategory: declined ? null : '5411',
      decision: declined ? 'declined' : 'approved',
      declineCode: declined ? 'ledger.insufficient_funds' : null,
      status: declined ? 'rejected' : 'settled',
      decidedAt: new Date(decidedEpoch).toISOString(),
      conversion: conversion
        ? {
            settlementAssetId: card.settlementAssetId,
            settlementAmount: amount === '3.000000000000000009' ? '6.000000000000000018' : '24.691357802469135602',
            rate: '2',
            rateQuality: 'mid',
            rateAsOf: new Date(decidedEpoch - 5000).toISOString(),
          }
        : null,
    };
  });
}

function ownerSpaces(principal = ownerA) {
  return [
    {
      id: primaryId,
      assetId: 'USDT',
      kind: 'primary',
      name: 'Main USDT',
      balance: '7500',
      goalTarget: null,
      lockedUntil: null,
      ledgerAccount: {
        ownerType: 'user',
        ownerId: principal,
        assetId: 'USDT',
        kind: 'available',
      },
    },
    {
      id: destinationSpaceId,
      assetId: 'USDT',
      kind: 'named',
      name: 'Current destination space',
      balance: '1',
      goalTarget: null,
      lockedUntil: null,
      ledgerAccount: {
        ownerType: 'subaccount',
        ownerId: destinationSpaceId,
        assetId: 'USDT',
        kind: 'available',
      },
    },
  ];
}

function trpcRefusal(status, message, { protocolCode, authCode, domainCode } = {}) {
  const protocol =
    protocolCode ??
    {
      400: 'BAD_REQUEST',
      401: 'UNAUTHORIZED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      503: 'SERVICE_UNAVAILABLE',
    }[status] ??
    'INTERNAL_SERVER_ERROR';
  return {
    status,
    json: {
      error: {
        message,
        data: {
          code: protocol,
          httpStatus: status,
          ...(authCode ? { intafacedCode: authCode, cause: { code: authCode } } : domainCode ? { cause: { code: domainCode } } : {}),
        },
      },
    },
  };
}

// BankError lives in data.cause.code. Auth scope denial also has intafacedCode.
const readRefusals = {
  missing: () => trpcRefusal(400, 'Card not found', { domainCode: 'bank.card_not_found' }),
  scope: () => trpcRefusal(403, 'Required scope is missing', { authCode: 'scope.denied' }),
  owner: () => trpcRefusal(403, 'This account belongs to another user'),
  unauthorized: () => trpcRefusal(401, 'Authentication required'),
  unavailable: () => trpcRefusal(503, 'Isolated current read is temporarily unavailable'),
};
function deferred() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function cardsNetwork(context) {
  const state = {
    owner: ownerA,
    reads: [],
    writes: [],
    logins: [],
    documents: [],
    errors: [],
    fixtureErrors: [],
    transportErrors: [],
    unsuppliedReads: [],
    held: [],
    cardsByOwner: new Map([
      [ownerA, cardRows(ownerA)],
      [ownerB, cardRows(ownerB)],
    ]),
    authorizationsByCard: new Map(),
    programme: absentProgramme,
  };
  for (const rows of state.cardsByOwner.values()) for (const card of rows) state.authorizationsByCard.set(card.id, decisionRows(card));
  state.listReply = async ({ principal, input }) => ({ status: 200, data: state.cardsByOwner.get(principal).slice(0, input.limit) });
  state.authorizationReply = async ({ input }) => ({
    status: 200,
    data: state.authorizationsByCard.get(input.cardId).slice(0, input.limit),
  });
  const observe = (page) => {
    page.on('pageerror', (error) => state.errors.push(error.message));
    page.on('request', (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) state.documents.push(request.url());
    });
  };
  context.pages().forEach(observe);
  context.on('page', observe);
  await context.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const procedure = decodeURIComponent(url.pathname.split('/').at(-1));
    const rpc = (data) => route.fulfill({ status: 200, json: { result: { data } } });
    const send = (reply) => (reply.status === 200 ? rpc(reply.data) : route.fulfill({ status: reply.status, json: reply.json }));
    if (procedure === 'auth.login') {
      const token = `isolated-card-read-token-${state.logins.length + 1}`;
      state.logins.push({ owner: state.owner, token, input: request.postDataJSON() });
      return rpc({
        userId: state.owner,
        accessToken: token,
        refreshToken: `isolated-card-read-refresh-${state.logins.length}`,
        expiresAt: '2027-10-10T00:00:00Z',
      });
    }
    if (procedure === 'auth.logout') return rpc({ ok: true });
    if (request.method() !== 'GET') {
      state.writes.push({ path: url.pathname, method: request.method(), body: request.postData() });
      return send(trpcRefusal(503, 'This Cards fixture supplies no financial or issuer dispatch.'));
    }
    const input = JSON.parse(url.searchParams.get('input') || 'null');
    const authorization = request.headers().authorization ?? null;
    const principal = state.logins.find((login) => `Bearer ${login.token}` === authorization)?.owner;
    const read = { path: url.pathname, input, authorization, principal };
    state.reads.push(read);
    if (!state.cardsByOwner.has(principal)) {
      read.refusal = readRefusals.unauthorized();
      return send(read.refusal);
    }
    try {
      if (url.pathname.endsWith('/account/balance')) {
        read.reply = {
          timestamp: 1791621900000,
          datetime: '2026-10-10T08:45:00.000Z',
          balances: { USDT: { total: '8000', free: '7500', used: '500' } },
        };
        return route.fulfill({ status: 200, json: read.reply });
      }
      if (procedure === 'spaces.unnamed') {
        read.reply = [];
        return rpc(read.reply);
      }
      if (procedure === 'cards.programme') {
        read.reply = state.programme;
        return rpc(read.reply);
      }
      if (['spaces.list', 'cards.list', 'cards.authorizations'].includes(procedure)) {
        const keys = procedure === 'cards.authorizations' ? ['cardId', 'limit'] : ['limit'];
        const validInput =
          input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).every((key) => keys.includes(key));
        if (
          !validInput ||
          !Number.isInteger(input.limit) ||
          input.limit < 1 ||
          input.limit > 200 ||
          (procedure === 'cards.authorizations' &&
            !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.cardId ?? ''))
        ) {
          state.fixtureErrors.push({
            path: url.pathname,
            input,
            reason: 'Mounted explicit limit1..200/UUID input required, without client userId.',
          });
          read.refusal = trpcRefusal(400, 'Invalid isolated owner-read input');
          return send(read.refusal);
        }
        if (procedure === 'spaces.list') {
          read.reply = ownerSpaces(principal).slice(0, input.limit);
          return rpc(read.reply);
        }
        if (procedure === 'cards.list') {
          const reply = await state.listReply({ input, read, principal });
          if (reply.status === 200) read.reply = reply.data;
          else read.refusal = reply;
          return send(reply);
        }
        const owned = state.cardsByOwner.get(principal).some((card) => card.id === input.cardId);
        if (!owned) {
          const foreign = [...state.cardsByOwner.values()].some((rows) => rows.some((card) => card.id === input.cardId));
          read.refusal = foreign ? readRefusals.owner() : readRefusals.missing();
          return send(read.refusal);
        }
        const reply = await state.authorizationReply({ input, read, principal });
        if (reply.status === 200) read.reply = reply.data;
        else read.refusal = reply;
        return send(reply);
      }
      state.unsuppliedReads.push({ path: url.pathname, input });
      read.refusal = readRefusals.unavailable();
      return send(read.refusal);
    } catch (error) {
      // Preserve aborted intentionally held transport outcomes; do not filter pageerrors.
      state.transportErrors.push({ path: url.pathname, input, intentionallyHeld: read.intentionallyHeld === true, message: error.message });
    }
  });
  return state;
}

async function submitLogin(page, destination) {
  await page.locator('input[name="identifier"]').fill('card-owner@example.invalid');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
  await expect.poll(() => currentURL(page)).toBe(destination);
  await expect(main(page).getByRole('heading', { level: 1 })).toBeVisible();
}
async function login(page, destination = '/bank') {
  await page.goto(`/login?redirect=${encodeURIComponent(destination)}`);
  await submitLogin(page, destination);
}
async function ownerProof(page, principal = ownerA) {
  await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
  await expect(page.getByRole('dialog').getByText(principal, { exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close dialog', exact: true }).click();
}
async function seedBankOriginal(page, unreadable = false) {
  await page.evaluate(
    ({ key, raw, unreadable }) => {
      localStorage.setItem(key, raw);
      window.__cardOriginalGet = Storage.prototype.getItem;
      if (unreadable)
        Storage.prototype.getItem = function (candidate) {
          if (candidate === key) throw new DOMException('Isolated getItem-only refusal', 'SecurityError');
          return window.__cardOriginalGet.call(this, candidate);
        };
    },
    { key: bankOriginalKey, raw: bankOriginalRaw, unreadable },
  );
}
function readBankOriginalRaw(page) {
  return page.evaluate((key) => (window.__cardOriginalGet ?? Storage.prototype.getItem).call(localStorage, key), bankOriginalKey);
}
async function restoreOriginalRead(page) {
  await page.evaluate(() => {
    if (window.__cardOriginalGet) Storage.prototype.getItem = window.__cardOriginalGet;
  });
}

const baseURL = process.env.MONEY_CARD_DECISIONS_BASE_URL;
const evidence = process.env.MONEY_CARD_DECISIONS_EVIDENCE;
if (!baseURL || !evidence) throw new Error('Root must provide the verified compiled origin and new evidence path.');
mkdirSync(evidence, { recursive: true });
const ui = {
  en: {
    selected: 'Selected card',
    decisions: 'Card decisions',
    inspect: (id) => `Inspect decisions for card ${id}`,
    refresh: 'Refresh cards',
    refreshDecisions: 'Refresh decisions',
    hide: 'Hide amounts',
    show: 'Show amounts',
  },
  fr: {
    selected: 'Carte sélectionnée',
    decisions: 'Décisions de la carte',
    inspect: (id) => `Consulter les décisions de la carte ${id}`,
    refresh: 'Actualiser les cartes',
    refreshDecisions: 'Actualiser les décisions',
    hide: 'Masquer les montants',
    show: 'Afficher les montants',
  },
  es: {
    selected: 'Tarjeta seleccionada',
    decisions: 'Decisiones de la tarjeta',
    inspect: (id) => `Consultar decisiones de la tarjeta ${id}`,
    refresh: 'Actualizar tarjetas',
    refreshDecisions: 'Actualizar decisiones',
    hide: 'Ocultar importes',
    show: 'Mostrar importes',
  },
};
const paths = [
  '/bank',
  '/bank/spaces',
  '/bank/transfers',
  '/bank/earn',
  '/bank/loans',
  '/bank/cards',
  '/bank/ramps',
  '/bank/analytics',
  '/bank/business',
];
const panel = (page) => main(page).locator('.money-selected-card');
const historyPanel = (page, locale = 'en') => panel(page).getByRole('region', { name: ui[locale].decisions, exact: true });
const inspector = (page, row, locale = 'en') => main(page).getByRole('button', { name: ui[locale].inspect(row.id), exact: true });
const listReads = (state) => state.reads.filter((r) => r.path.endsWith('/cards.list'));
const decisionReads = (state) => state.reads.filter((r) => r.path.endsWith('/cards.authorizations'));
const frames = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const quantity = (value) =>
  value.split('.')[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (value.includes('.') ? '.' + value.split('.')[1] : '');
const refreshCards = (page, locale = 'en') => main(page).getByRole('button', { name: ui[locale].refresh, exact: true }).last().click();
const refreshDecisions = (page, locale = 'en') =>
  historyPanel(page, locale).getByRole('button', { name: ui[locale].refreshDecisions, exact: true }).click();
const retry = (page) => historyPanel(page).getByRole('button', { name: 'Try again', exact: true }).click();
const enterCards = (page) => main(page).locator('.money-bank-nav a[href="/bank/cards"]').click();
async function aboveFooter(locator, minimum = 0) {
  await expect
    .poll(() =>
      locator.evaluate((node, minimum) => {
        const b = node.getBoundingClientRect(),
          n = document.querySelector('.mobile-doors'),
          r = n?.getBoundingClientRect();
        const bottom = n && getComputedStyle(n).display !== 'none' && r.height ? r.top : innerHeight;
        return b.left >= -0.5 && b.right <= innerWidth + 0.5 && b.top >= 0 && b.bottom <= bottom + 0.5 && b.height >= minimum;
      }, minimum),
    )
    .toBe(true);
}
async function inspect(page, row, locale = 'en', keyboard = false) {
  const button = inspector(page, row, locale);
  await expect(button).toHaveCount(1);
  if (keyboard) {
    for (let i = 0; i < 160 && !(await button.evaluate((n) => n === document.activeElement)); i++) await page.keyboard.press('Tab');
    await expect(button).toBeFocused();
    await aboveFooter(button, 44);
    await page.keyboard.press('Enter');
  } else await button.click();
  await expect(panel(page)).toHaveCount(1);
}
async function ready(page, card, rows, locale = 'en', hidden = false) {
  const p = panel(page),
    h = historyPanel(page, locale);
  await expect(p.locator('.money-card-reference dd')).toHaveText(card.id);
  await expect(p.locator('.money-card-identity')).toContainText(card.panTail);
  await expect(p.locator('.money-card-identity')).toContainText(card.assetId);
  await expect(p.locator('.money-card-identity')).toContainText(card.settlementAssetId);
  await expect(h.getByRole('article')).toHaveCount(rows.length);
  for (const [index, row] of rows.length <= 3
    ? rows.map((r, i) => [i, r])
    : [
        [0, rows[0]],
        [rows.length - 1, rows.at(-1)],
      ]) {
    const a = h.getByRole('article').nth(index);
    await expect(a.locator('h4')).toHaveText(row.decision);
    await expect(a.locator('.money-card-status dd')).toHaveText(row.status);
    await expect(a.locator('.money-card-funding .numeric')).toHaveText(hidden ? '••••' : quantity(row.amount));
    await expect(a.locator('.money-card-funding .money-caption')).toHaveText(card.assetId);
    await expect(a.locator('.money-card-decision-time time')).toHaveAttribute('datetime', row.decidedAt);
    await expect(a.locator('.money-card-decision-time time')).toHaveAttribute('dir', 'auto');
    await expect(a.locator('.money-card-authorization dd')).toHaveText(row.authorizationRef);
    await expect(a.locator('.money-card-decline')).toHaveCount(row.declineCode === null ? 0 : 1);
    if (row.declineCode !== null) await expect(a.locator('.money-card-decline dd')).toHaveText(row.declineCode);
    await expect(a.locator('.money-card-conversion')).toHaveCount(row.conversion === null ? 0 : 1);
    if (row.conversion) {
      const c = a.locator('.money-card-conversion');
      await expect(c.locator('.numeric')).toHaveText(hidden ? '••••' : quantity(row.conversion.settlementAmount));
      await expect(c).toContainText(row.conversion.settlementAssetId);
      await expect(c).toContainText(`${quantity(row.conversion.rate)} ${row.conversion.settlementAssetId} / ${card.assetId}`);
      await expect(c).toContainText(row.conversion.rateQuality);
      await expect(c.locator('time')).toHaveAttribute('datetime', row.conversion.rateAsOf);
    }
  }
  return p;
}
async function snapshot(page, state, name) {
  await page.evaluate(() => document.fonts.ready);
  const observation = await page.evaluate(() => {
    const p = document.querySelector('.money-selected-card'),
      n = document.querySelector('.mobile-doors'),
      nr = n?.getBoundingClientRect();
    const box = (e) => {
      const b = e?.getBoundingClientRect();
      return b ? { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height } : null;
    };
    const glyphs = [...(p?.querySelectorAll('.money-card-funding .numeric') ?? [])].slice(0, 1).map((e) => {
      const range = document.createRange();
      range.selectNodeContents(e);
      return {
        bounds: box(e),
        rects: [...range.getClientRects()].map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom })),
      };
    });
    return {
      href: location.pathname + location.search + location.hash,
      timeOrigin: performance.timeOrigin,
      width: innerWidth,
      height: innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      scrollY,
      footerTop: n && getComputedStyle(n).display !== 'none' && nr.height ? nr.top : innerHeight,
      heading: box(document.getElementById('money-selected-card-heading')),
      reference: box(p?.querySelector('.money-card-reference dd')),
      firstDecision: box(p?.querySelector('.money-card-decision')),
      glyphs,
      active: document.activeElement?.outerHTML,
      selectedDOM: p?.outerHTML,
      mainDOM: document.querySelector('#main')?.outerHTML,
    };
  });
  state.observations ??= [];
  state.observations.push({ name, ...observation });
  writeFileSync(join(evidence, name + '.json'), JSON.stringify(observation, null, 2) + '\n', { flag: 'wx' });
  await page.screenshot({ path: join(evidence, name + '-viewport.png') });
  await page.screenshot({ path: join(evidence, name + '-whole.png'), fullPage: true });
  return observation;
}
async function scenario(browser, name, run, width = 1440, height = 1000) {
  const context = await browser.newContext({ baseURL, viewport: { width, height }, timezoneId: 'UTC' }),
    state = await cardsNetwork(context),
    page = await context.newPage();
  try {
    await run({ page, state });
    expect(state.writes).toEqual([]);
    expect(state.errors).toEqual([]);
    expect(state.fixtureErrors).toEqual([]);
    expect(state.transportErrors).toEqual([]);
    for (const r of [...listReads(state), ...decisionReads(state)]) {
      expect(r.input.limit).toBeGreaterThanOrEqual(1);
      expect(r.input.limit).toBeLessThanOrEqual(200);
      expect(r.principal).toBeTruthy();
      expect(r.authorization).toMatch(/^Bearer isolated-card-read-token-/);
    }
  } finally {
    state.held.forEach((h) => h.release());
    await frames(page).catch(() => {});
    writeFileSync(
      join(evidence, name + '-raw.json'),
      JSON.stringify(
        {
          fixedFixtureSource,
          qualification:
            'Root self-authored native; reviewed foundation2 and actual ordinary compiled App/Login. Isolated DTOs/errors do not prove SQL/JWT/Edge/issuer/funding/capture/fullhistory/settlement. Original terms remainRAM; no product sample adapter.',
          ...state,
        },
        (key, value) =>
          typeof value === 'function'
            ? undefined
            : value instanceof Map
              ? Object.fromEntries(value)
              : key === 'held'
                ? value.length
                : value,
        2,
      ) + '\n',
      { flag: 'wx' },
    );
    await context.close();
  }
}
async function viewLocale(page, requested) {
  await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
  await page.getByRole('dialog').locator('a[href="/view"]').click();
  const language = page.locator('select').filter({ has: page.locator('option[value="ar"]') });
  await language.selectOption(requested);
  await page.locator('a[href="/money"]:visible').first().click();
  await main(page).locator('a[href="/bank"]').click();
  await expect(page.locator('html')).toHaveAttribute('lang', requested === 'ar' ? 'en' : requested);
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
}
async function captureHandler(locator, key) {
  await locator.evaluate((node, key) => {
    const k = Object.keys(node).find((k) => k.startsWith('__reactProps'));
    const h = k && node[k]?.onClick;
    if (typeof h !== 'function') throw Error('Actual rendered React handler required');
    window[key] = h;
  }, key);
}
const invoke = (page, key) => page.evaluate((key) => window[key](), key);
const storage = (page) =>
  page.evaluate(() => ({
    local: Object.fromEntries(Object.entries(localStorage)),
    session: Object.fromEntries(Object.entries(sessionStorage)),
    history: history.state,
  }));

test('current full card identity, exact decisions and natural arrival at four widths', async ({ browser }) => {
  for (const [width, requested] of [
    [320, 'en'],
    [390, 'fr'],
    [768, 'es'],
    [1440, 'ar'],
  ])
    await scenario(
      browser,
      `cards-${width}-${requested}`,
      async ({ page, state }) => {
        const locale = requested === 'ar' ? 'en' : requested,
          a = state.cardsByOwner.get(ownerA)[3],
          b = state.cardsByOwner.get(ownerA)[8];
        if (width === 320) {
          a.settlementAssetId = a.assetId;
          state.authorizationsByCard.set(a.id, [
            {
              id: '62000000-0000-4000-8000-000000000001',
              authorizationRef: 'card-auth-approved-0004',
              amount: '12.345678901234567801',
              merchantCategory: '5411',
              decision: 'approved',
              declineCode: null,
              status: 'settled',
              decidedAt: '2026-10-10T10:20:00.000Z',
              conversion: null,
            },
            {
              id: '62000000-0000-4000-8000-000000000002',
              authorizationRef: 'card-auth-declined-0004',
              amount: '3.000000000000000009',
              merchantCategory: null,
              decision: 'declined',
              declineCode: 'ledger.insufficient_funds',
              status: 'rejected',
              decidedAt: '2026-10-10T09:10:00.000Z',
              conversion: null,
            },
          ]);
        } else {
          if (width === 390) a.assetId = 'ASSET123456789012';
          const rows = decisionRows(a);
          rows[2].status = 'pending';
          state.authorizationsByCard.set(a.id, rows);
        }
        const rows = state.authorizationsByCard.get(a.id);
        await login(page);
        await ownerProof(page);
        const origin = await page.evaluate(() => performance.timeOrigin);
        if (requested !== 'en') await viewLocale(page, requested);
        await enterCards(page);
        await expect.poll(() => currentURL(page)).toBe('/bank/cards');
        expect(
          await main(page)
            .locator('.money-bank-nav a')
            .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('href'))),
        ).toEqual(paths);
        await inspect(page, a, locale, width >= 768);
        const p = await ready(page, a, rows, locale);
        await expect(p.getByRole('heading', { name: ui[locale].selected, exact: true })).toBeFocused();
        await aboveFooter(p.getByRole('heading', { name: ui[locale].selected, exact: true }));
        await aboveFooter(p.locator('.money-card-reference dd'));
        await aboveFooter(historyPanel(page, locale).getByRole('article').first());
        const obs = await snapshot(page, state, `cards-${width}-${requested}-arrival`);
        expect(obs.scrollWidth).toBeLessThanOrEqual(width);
        for (const g of obs.glyphs)
          for (const r of g.rects) {
            expect(r.left).toBeGreaterThanOrEqual(g.bounds.left - 0.5);
            expect(r.right).toBeLessThanOrEqual(g.bounds.right + 0.5);
          }
        await expect(p.locator('.money-card-configuration .numeric')).toHaveText(quantity(a.perAuthorizationLimit));
        await expect(p.locator('.money-card-reference dd')).toHaveAttribute('lang', 'zxx');
        await expect(historyPanel(page, locale).getByRole('article').first().locator('.money-card-status dd')).toHaveAttribute(
          'lang',
          'und',
        );
        expect(decisionReads(state).at(-1).input).toEqual({ cardId: a.id, limit: 50 });
        await expect(p.getByRole('button', { name: /Freeze|Unfreeze|Close card/ })).toHaveCount(0);
        await expect(main(page).locator('.money-card-programme')).toBeVisible();
        await p
          .getByRole('button', {
            name: requested === 'fr' ? 'Tous les enregistrements' : requested === 'es' ? 'Todos los registros' : 'All records',
            exact: true,
          })
          .click();
        await expect(panel(page)).toHaveCount(0);
        await expect(main(page).locator('#money-card-list-heading')).toBeFocused();
        await aboveFooter(main(page).locator('#money-card-list-heading'));
        await inspect(page, b, locale);
        await ready(page, b, state.authorizationsByCard.get(b.id), locale);
        expect(b.panTail).toBe(a.panTail);
        expect(b.id).not.toBe(a.id);
        expect(decisionReads(state).at(-1).input.cardId).toBe(b.id);
        await main(page).locator('.money-bank-nav a[href="/bank"]').click();
        await main(page).getByRole('button', { name: ui[locale].hide, exact: true }).click();
        await enterCards(page);
        await inspect(page, a, locale);
        await ready(page, a, rows, locale, true);
        await snapshot(page, state, `cards-${width}-${requested}-hidden`);
        await main(page).locator('.money-bank-nav a[href="/bank"]').click();
        await main(page).getByRole('button', { name: ui[locale].show, exact: true }).click();
        await enterCards(page);
        await inspect(page, a, locale);
        await ready(page, a, rows, locale);
        expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin);
        expect(state.documents).toHaveLength(1);
      },
      width,
      width < 768 ? 844 : 1000,
    );
});

test('current owner-window and real-shaped card failures recover with bounded newest history', async ({ browser }) => {
  await scenario(
    browser,
    'cards-recovery',
    async ({ page, state }) => {
      const a = state.cardsByOwner.get(ownerA)[3],
        b = state.cardsByOwner.get(ownerA)[8],
        normal = state.authorizationReply,
        listNormal = state.listReply;
      await login(page, '/bank/cards?context=decisions#review');
      await ownerProof(page);
      await inspect(page, a);
      await ready(page, a, state.authorizationsByCard.get(a.id));
      const hold = deferred();
      state.held.push(hold);
      state.listReply = async (args) => {
        args.read.intentionallyHeld = true;
        const result = await listNormal(args);
        await hold.promise;
        return result;
      };
      await captureHandler(inspector(page, b), '__oldCardsInspect');
      await refreshCards(page);
      await expect(panel(page).locator('.money-card-identity')).toHaveCount(0);
      await expect(historyPanel(page)).toHaveCount(0);
      const before = decisionReads(state).length;
      await invoke(page, '__oldCardsInspect');
      await frames(page);
      expect(decisionReads(state)).toHaveLength(before);
      state.listReply = listNormal;
      hold.release();
      await ready(page, a, state.authorizationsByCard.get(a.id));
      for (const [name, make] of [
        ['service503', readRefusals.unavailable],
        ['scope403', readRefusals.scope],
        ['owner403', readRefusals.owner],
      ]) {
        state.authorizationReply = async () => make();
        await refreshDecisions(page);
        await expect(historyPanel(page).locator('.failure')).toBeVisible();
        await expect(historyPanel(page).getByRole('article')).toHaveCount(0);
        await snapshot(page, state, 'cards-' + name);
        await captureHandler(historyPanel(page).getByRole('button', { name: 'Try again', exact: true }), '__oldCardRetry');
        state.authorizationReply = normal;
        await retry(page);
        await ready(page, a, state.authorizationsByCard.get(a.id));
        const beforeOldRetry = decisionReads(state).length;
        await invoke(page, '__oldCardRetry');
        await frames(page);
        expect(decisionReads(state)).toHaveLength(beforeOldRetry);
        expect(decisionReads(state).at(-1).input.cardId).toBe(a.id);
      }
      state.authorizationReply = async () => readRefusals.missing();
      await refreshDecisions(page);
      await expect(historyPanel(page).getByRole('heading', { name: 'Card not found by this read', exact: true })).toBeVisible();
      await expect(panel(page).locator('.money-card-identity')).toHaveCount(0);
      await historyPanel(page).getByText('Service detail', { exact: true }).click();
      await expect(historyPanel(page).getByText('bank.card_not_found', { exact: true })).toBeVisible();
      expect(decisionReads(state).at(-1).refusal.status).toBe(400);
      await snapshot(page, state, 'cards-domain400-current-recovery');
      const missHold = deferred();
      state.held.push(missHold);
      state.authorizationReply = async (args) => {
        args.read.intentionallyHeld = true;
        const r = await normal(args);
        await missHold.promise;
        return r;
      };
      await retry(page);
      await expect(panel(page).locator('.money-card-identity')).toHaveCount(0);
      missHold.release();
      state.authorizationReply = normal;
      await ready(page, a, state.authorizationsByCard.get(a.id));
      state.listReply = async ({ principal, input }) => ({
        status: 200,
        data: state.cardsByOwner
          .get(principal)
          .filter((r) => r.id !== a.id)
          .slice(0, input.limit),
      });
      await refreshCards(page);
      await expect(panel(page).getByRole('heading', { name: 'Card not in this response', exact: true })).toBeVisible();
      await expect(panel(page).locator('.money-card-identity')).toHaveCount(0);
      await expect(historyPanel(page)).toHaveCount(0);
      await snapshot(page, state, 'cards-current-window-absent');
      await inspect(page, b);
      await ready(page, b, state.authorizationsByCard.get(b.id));
      state.listReply = async () => ({ status: 200, data: [b, { ...b, id: b.id.toUpperCase() }] });
      await refreshCards(page);
      await expect(panel(page).getByRole('heading', { name: 'Card could not be identified', exact: true })).toBeVisible();
      for (const button of await inspector(page, b).all()) await expect(button).toBeDisabled();
      await expect(panel(page).locator('.money-card-identity')).toHaveCount(0);
      state.listReply = listNormal;
      await refreshCards(page);
      await ready(page, b, state.authorizationsByCard.get(b.id));
      for (const reply of [readRefusals.unavailable(), { status: 200, data: [{ ...b, perAuthorizationLimit: 'NaN' }] }]) {
        state.listReply = async () => reply;
        await refreshCards(page);
        await expect(panel(page).locator('.failure')).toBeVisible();
        await expect(panel(page).locator('.money-card-identity')).toHaveCount(0);
        await expect(historyPanel(page)).toHaveCount(0);
        await expect(panel(page).locator('.money-card-reference dd')).toHaveText(b.id);
        state.listReply = listNormal;
        await panel(page).locator('.failure').getByRole('button', { name: 'Try again', exact: true }).click();
        await ready(page, b, state.authorizationsByCard.get(b.id));
      }
      state.authorizationReply = async () => ({ status: 200, data: [{ ...decisionRows(b)[0], amount: 'NaN' }] });
      await refreshDecisions(page);
      await expect(historyPanel(page).locator('.failure')).toBeVisible();
      state.authorizationReply = normal;
      await retry(page);
      await ready(page, b, state.authorizationsByCard.get(b.id));
      state.authorizationReply = async () => ({ status: 200, data: [] });
      await refreshDecisions(page);
      await expect(historyPanel(page).getByRole('heading', { name: 'No card decisions returned', exact: true })).toBeVisible();
      await expect(historyPanel(page)).toContainText('does not confirm a purchase outcome');
      state.authorizationReply = async () => readRefusals.unauthorized();
      await refreshDecisions(page);
      await expect(main(page).getByRole('heading', { name: 'Sign in to continue', exact: true })).toBeVisible();
      await expect(panel(page)).toHaveCount(0);
      const signIn = main(page).getByRole('link', { name: 'Sign in', exact: true });
      expect(new URL(await signIn.getAttribute('href'), baseURL).searchParams.get('redirect')).toBe('/bank/cards?context=decisions#review');
      state.authorizationReply = normal;
      await signIn.click();
      await submitLogin(page, '/bank/cards?context=decisions#review');
      await inspect(page, b);
      await ready(page, b, state.authorizationsByCard.get(b.id));
      expect(decisionReads(state).at(-1).authorization).toBe(`Bearer ${state.logins.at(-1).token}`);
      expect(state.documents).toHaveLength(1);
    },
    390,
    844,
  );
  await scenario(browser, 'cards-newest200', async ({ page, state }) => {
    const rows = cardRows(ownerA, 200);
    state.cardsByOwner.set(ownerA, rows);
    for (const row of rows) state.authorizationsByCard.set(row.id, decisionRows(row, 200));
    await login(page, '/bank/cards');
    await expect(main(page).locator('.money-card-record')).toHaveCount(50);
    const initial = listReads(state).length;
    expect(initial).toBeGreaterThanOrEqual(1);
    expect(listReads(state).map((r) => r.input.limit)).toEqual(Array(initial).fill(50));
    await captureHandler(
      main(page)
        .locator('.money-owner-cards > .money-section .money-continuation')
        .getByRole('button', { name: 'Load up to 100', exact: true }),
      '__oldCardListMore',
    );
    for (const limit of [100, 150, 200]) {
      await main(page)
        .locator('.money-owner-cards > .money-section .money-continuation')
        .getByRole('button', { name: `Load up to ${limit}`, exact: true })
        .click();
      await expect(main(page).locator('.money-card-record')).toHaveCount(limit);
      if (limit === 150) {
        const before = listReads(state).length;
        await invoke(page, '__oldCardListMore');
        await frames(page);
        expect(listReads(state)).toHaveLength(before);
        await expect(main(page).locator('.money-card-record')).toHaveCount(150);
      }
    }
    const row = rows[3];
    await inspect(page, row);
    for (const limit of [50, 100, 150, 200]) {
      if (limit !== 50)
        await historyPanel(page)
          .getByRole('button', { name: `Load up to ${limit}`, exact: true })
          .click();
      await ready(page, row, state.authorizationsByCard.get(row.id).slice(0, limit));
      if (limit === 50)
        await captureHandler(historyPanel(page).getByRole('button', { name: 'Load up to 100', exact: true }), '__oldCardHistoryMore');
      if (limit === 150) {
        const before = decisionReads(state).length;
        await invoke(page, '__oldCardHistoryMore');
        await frames(page);
        expect(decisionReads(state)).toHaveLength(before);
        await expect(historyPanel(page).getByRole('article')).toHaveCount(150);
      }
    }
    await expect(historyPanel(page)).toContainText('History beyond the newest 200 decisions is unavailable here.');
    await expect(historyPanel(page).getByRole('button', { name: /^Load up to/ })).toHaveCount(0);
    expect(decisionReads(state).map((r) => r.input.limit)).toEqual([50, 100, 150, 200]);
    expect(
      listReads(state)
        .slice(initial)
        .map((r) => r.input.limit),
    ).toEqual([100, 150, 200]);
    const returned = state.authorizationsByCard.get(row.id);
    expect(returned.every((r, i) => i === 0 || Date.parse(returned[i - 1].decidedAt) > Date.parse(r.decidedAt))).toBe(true);
    await snapshot(page, state, 'cards-newest200');
  });
});

test('retired card callbacks, late responses and unknown originals preserve the current private context', async ({ browser }) => {
  await scenario(browser, 'cards-late-url-dialog', async ({ page, state }) => {
    const a = state.cardsByOwner.get(ownerA)[3],
      b = state.cardsByOwner.get(ownerA)[8],
      normal = state.authorizationReply,
      hold = deferred();
    state.held.push(hold);
    let first = true;
    state.authorizationReply = async (args) => {
      const r = await normal(args);
      if (first && args.input.cardId === a.id) {
        first = false;
        args.read.intentionallyHeld = true;
        await hold.promise;
      }
      return r;
    };
    await login(page, '/bank/cards');
    await inspect(page, a);
    await expect.poll(() => decisionReads(state).length).toBe(1);
    await inspect(page, b);
    await ready(page, b, state.authorizationsByCard.get(b.id));
    hold.release();
    await frames(page);
    await expect(panel(page).locator('.money-card-reference dd')).toHaveText(b.id);
    for (const mode of ['query', 'hash-aba', 'query-aba', 'pathname']) {
      await captureHandler(historyPanel(page).getByRole('button', { name: 'Refresh decisions', exact: true }), '__oldCardsRefresh');
      await captureHandler(main(page).getByRole('button', { name: 'Refresh cards', exact: true }).last(), '__oldCardsList');
      await captureHandler(inspector(page, a), '__oldCardsChoice');
      await page.evaluate((mode) => {
        const start = location.pathname + location.search + location.hash;
        const move = (target) => {
          history.pushState({}, '', target);
          window.dispatchEvent(new PopStateEvent('popstate'));
        };
        if (mode === 'hash-aba') {
          const oldURL = location.href;
          history.pushState({}, '', start + '#away');
          window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: location.href }));
          const away = location.href;
          history.pushState({}, '', start);
          window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL: away, newURL: location.href }));
        } else {
          move(mode === 'pathname' ? '/bank' : start + '?away=1');
          if (mode !== 'query') move(start);
        }
      }, mode);
      if (mode === 'query') {
        await frames(page);
        await page.evaluate(() => {
          history.pushState({}, '', '/bank/cards');
          window.dispatchEvent(new PopStateEvent('popstate'));
        });
      }
      await expect.poll(() => currentURL(page)).toBe('/bank/cards');
      await expect(inspector(page, b)).toBeVisible();
      const count = state.reads.length;
      for (const key of ['__oldCardsRefresh', '__oldCardsList', '__oldCardsChoice']) await invoke(page, key);
      await frames(page);
      expect(state.reads).toHaveLength(count);
      await expect(panel(page)).toHaveCount(0);
      await inspect(page, b);
      await ready(page, b, state.authorizationsByCard.get(b.id));
    }
    const focusHold = deferred();
    state.held.push(focusHold);
    state.authorizationReply = async (args) => {
      const r = await normal(args);
      args.read.intentionallyHeld = true;
      await focusHold.promise;
      return r;
    };
    await captureHandler(historyPanel(page).getByRole('button', { name: 'Refresh decisions', exact: true }), '__beforeLoading');
    await refreshDecisions(page);
    await expect(historyPanel(page).getByRole('article')).toHaveCount(0);
    const before = decisionReads(state).length;
    await invoke(page, '__beforeLoading');
    await frames(page);
    expect(decisionReads(state)).toHaveLength(before);
    await main(page).locator('.money-bank-nav a[href="/bank/transfers"]').click();
    await main(page).getByLabel('From your space', { exact: true }).selectOption(primaryId);
    await main(page).getByRole('button', { name: 'Continue', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('input[name="toSpaceId"]').fill(destinationSpaceId);
    const amount = dialog.locator('input[name="amount"]');
    await amount.fill('0.000000000000000007');
    focusHold.release();
    await frames(page);
    await expect(amount).toBeFocused();
    await expect(amount).toHaveValue('0.000000000000000007');
    await expect(dialog).toBeVisible();
    expect(JSON.stringify(await storage(page))).not.toContain('0.000000000000000007');
    await snapshot(page, state, 'cards-late-private-transfer');
    await page.keyboard.press('Escape');
  });
  for (const nextOwner of [ownerA, ownerB])
    await scenario(browser, `cards-owner-${nextOwner === ownerA ? 'new-token' : 'different'}`, async ({ page, state }) => {
      const a = state.cardsByOwner.get(ownerA)[3];
      await login(page, '/bank/cards');
      await inspect(page, a);
      await ready(page, a, state.authorizationsByCard.get(a.id));
      await captureHandler(historyPanel(page).getByRole('button', { name: 'Refresh decisions', exact: true }), '__oldCardsOwner');
      const origin = await page.evaluate(() => performance.timeOrigin);
      const ownerHold = deferred();
      state.held.push(ownerHold);
      const normalOwnerReply = state.authorizationReply;
      state.authorizationReply = async (args) => {
        const reply = await normalOwnerReply(args);
        if (args.read.authorization === `Bearer ${state.logins[0].token}`) {
          args.read.intentionallyHeld = true;
          await ownerHold.promise;
        }
        return reply;
      };
      await refreshDecisions(page);
      await expect(historyPanel(page).getByRole('article')).toHaveCount(0);
      await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Sign out', exact: true }).click();
      state.owner = nextOwner;
      await expect(panel(page)).toHaveCount(0);
      await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
      await page.getByRole('dialog').getByRole('link', { name: 'Sign in', exact: true }).click();
      await submitLogin(page, '/money');
      await ownerProof(page, nextOwner);
      const before = state.reads.length;
      await invoke(page, '__oldCardsOwner');
      await frames(page);
      expect(state.reads).toHaveLength(before);
      await main(page).locator('a[href="/bank"]').click();
      await enterCards(page);
      const b = state.cardsByOwner.get(nextOwner)[nextOwner === ownerA ? 8 : 3];
      await inspect(page, b);
      await ready(page, b, state.authorizationsByCard.get(b.id));
      ownerHold.release();
      await frames(page);
      await ready(page, b, state.authorizationsByCard.get(b.id));
      await expect(panel(page).locator('.money-card-reference dd')).toHaveText(b.id);
      expect(decisionReads(state).at(-1).authorization).toBe(`Bearer ${state.logins.at(-1).token}`);
      expect(state.logins[0].token).not.toBe(state.logins.at(-1).token);
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin);
      expect(state.documents).toHaveLength(1);
    });
  for (const unreadable of [false, true])
    await scenario(browser, `cards-original-${unreadable ? 'unreadable' : 'unknown'}`, async ({ page, state }) => {
      const a = state.cardsByOwner.get(ownerA)[3];
      await login(page);
      await seedBankOriginal(page, unreadable);
      await enterCards(page);
      const recovery = main(page).locator('#bank-unconfirmed');
      await expect(recovery).toHaveAttribute('role', 'alert');
      expect(await readBankOriginalRaw(page)).toBe(bankOriginalRaw);
      await inspect(page, a);
      await ready(page, a, state.authorizationsByCard.get(a.id));
      expect(await readBankOriginalRaw(page)).toBe(bankOriginalRaw);
      await snapshot(page, state, `cards-original-${unreadable ? 'unreadable' : 'unknown'}`);
      await main(page).locator('.money-bank-nav a[href="/bank/transfers"]').click();
      await main(page).getByLabel('From your space', { exact: true }).selectOption(primaryId);
      await main(page).getByRole('button', { name: 'Continue', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(recovery).toContainText('Bank writes are paused');
      expect(await readBankOriginalRaw(page)).toBe(bankOriginalRaw);
      await restoreOriginalRead(page);
      await enterCards(page);
      await inspect(page, a);
      await ready(page, a, state.authorizationsByCard.get(a.id));
      expect(await readBankOriginalRaw(page)).toBe(bankOriginalRaw);
      await expect(recovery).toContainText(originalReference);
    });
});
