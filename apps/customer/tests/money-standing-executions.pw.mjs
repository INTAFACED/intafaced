// Ordinary compiled App/Login and mounted-contract fixture foundation.
// Isolated responses do not establish live SQL/scheduler/ledger authority.
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const fixedFixtureSource = '961599336b47ba9db9fb1ed02dfd12b5fd8bb942';
const ownerA = '11111111-1111-4111-8111-111111111111';
const ownerB = '99999999-9999-4999-8999-999999999999';
const primaryId = '22222222-2222-4222-8222-222222222222';
const destinationSpaceId = '33333333-3333-4333-8333-333333333333';
const originalReference = '77777777-7777-4777-8777-777777777777';
const bankOriginalKey = `intafaced.customer.bank-unconfirmed.v1:${ownerA}`;
const bankOriginalRaw = ` [ ${JSON.stringify({ reference: originalReference, title: 'Original transfer', procedure: 'transfers.create', recordRefs: { transferId: originalReference, fromSpaceId: primaryId } })} ] `;
const main = (page) => page.locator('#main');
const currentURL = (page) => page.evaluate(() => location.pathname + location.search + location.hash);

function instructionRows(principal = ownerA, count = 20) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${principal === ownerA ? '60000000' : '70000000'}-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    assetId: 'USDT',
    amount: `${index + 11}.${String(index + 1).padStart(18, '0')}`,
    cadence: 'monthly',
    startsAt: `2026-11-${String((index % 20) + 1).padStart(2, '0')}T12:00:00.000Z`,
    endsAt: null,
    nextRunAt: `2026-11-${String((index % 20) + 1).padStart(2, '0')}T12:00:00.000Z`,
    status: 'active',
    revision: 1,
  }));
}
function executionRows(instruction, count = 4) {
  const kinds = ['settled', 'rejected', 'pending', 'skipped'];
  return Array.from({ length: count }, (_, occurrence) => ({
    occurrence,
    amount: instruction.amount,
    status: kinds[occurrence % kinds.length],
    ledgerTxId: occurrence % 4 === 0 ? `88000000-0000-4000-8000-${String(occurrence + 1).padStart(12, '0')}` : null,
    rejectionCode: occurrence % 4 === 1 ? 'ledger.insufficient_funds' : occurrence % 4 === 3 ? 'bank.schedule_paused' : null,
  }));
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

// Mirror the mounted formatter's nested data. Named BankError codes belong in
// cause.code; intafacedCode is for AuthError/JurisdictionError, not BankError.
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
const readRefusals = {
  missing: () =>
    trpcRefusal(404, 'Schedule not found', {
      domainCode: 'bank.schedule_not_found',
    }),
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

async function standingNetwork(context) {
  const state = {
    owner: ownerA,
    reads: [],
    writes: [],
    logins: [],
    documents: [],
    errors: [],
    fixtureErrors: [],
    transportErrors: [],
    held: [],
    instructions: new Map([
      [ownerA, instructionRows(ownerA)],
      [ownerB, instructionRows(ownerB)],
    ]),
    results: new Map(),
  };
  for (const rows of state.instructions.values()) for (const row of rows) state.results.set(row.id, executionRows(row));
  state.listReply = async ({ principal, input }) => ({
    status: 200,
    data: state.instructions.get(principal).slice(0, input.limit),
  });
  state.executionReply = async ({ input }) => ({
    status: 200,
    data: state.results.get(input.scheduleId).slice(0, input.limit),
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
      const token = `isolated-standing-token-${state.logins.length + 1}`;
      state.logins.push({
        owner: state.owner,
        token,
        input: request.postDataJSON(),
      });
      return rpc({
        userId: state.owner,
        accessToken: token,
        refreshToken: `isolated-standing-refresh-${state.logins.length}`,
        expiresAt: '2027-10-10T00:00:00Z',
      });
    }
    if (procedure === 'auth.logout') return rpc({ ok: true });
    if (request.method() !== 'GET') {
      state.writes.push({
        path: url.pathname,
        method: request.method(),
        body: request.postData(),
      });
      return send(trpcRefusal(503, 'This bounded standing fixture supplies no financial dispatch.'));
    }
    const input = JSON.parse(url.searchParams.get('input') || 'null');
    const authorization = request.headers().authorization ?? null;
    const principal = state.logins.find((login) => `Bearer ${login.token}` === authorization)?.owner;
    const read = { path: url.pathname, input, authorization, principal };
    state.reads.push(read);
    if (!state.instructions.has(principal)) {
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
      if (['spaces.list', 'transfers.listSchedules', 'transfers.executions'].includes(procedure)) {
        if (!Number.isInteger(input?.limit) || input.limit < 1 || input.limit > 200) {
          state.fixtureErrors.push({
            path: url.pathname,
            input,
            reason: 'Mounted read requires explicit limit1..200.',
          });
          read.refusal = trpcRefusal(400, 'Invalid isolated owner-read limit');
          return send(read.refusal);
        }
        if (procedure === 'spaces.list') {
          read.reply = ownerSpaces(principal).slice(0, input.limit);
          return rpc(read.reply);
        }
        if (procedure === 'transfers.listSchedules') {
          const reply = await state.listReply({ input, read, principal });
          if (reply.status === 200) read.reply = reply.data;
          else read.refusal = reply;
          return send(reply);
        }
        const owned = state.instructions.get(principal).some((row) => row.id === input.scheduleId);
        if (!owned) {
          const foreign = [...state.instructions.values()].some((rows) => rows.some((row) => row.id === input.scheduleId));
          read.refusal = foreign ? readRefusals.owner() : readRefusals.missing();
          return send(read.refusal);
        }
        const reply = await state.executionReply({ input, read, principal });
        if (reply.status === 200) read.reply = reply.data;
        else read.refusal = reply;
        return send(reply);
      }
      read.refusal = readRefusals.unavailable();
      return send(read.refusal);
    } catch (error) {
      // Native context departure may abort an intentionally held reply. Keep the
      // raw transport outcome; do not filter pageerrors or turn it into pass.
      state.transportErrors.push({
        path: url.pathname,
        input,
        message: error.message,
      });
    }
  });
  return state;
}

async function submitLogin(page, destination) {
  await page.locator('input[name="identifier"]').fill('standing-owner@example.invalid');
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
      window.__standingOriginalGet = Storage.prototype.getItem;
      if (unreadable)
        Storage.prototype.getItem = function (candidate) {
          if (candidate === key) throw new DOMException('Isolated getItem-only refusal', 'SecurityError');
          return window.__standingOriginalGet.call(this, candidate);
        };
    },
    { key: bankOriginalKey, raw: bankOriginalRaw, unreadable },
  );
}
function readBankOriginalRaw(page) {
  return page.evaluate((key) => (window.__standingOriginalGet ?? Storage.prototype.getItem).call(localStorage, key), bankOriginalKey);
}
async function restoreOriginalRead(page) {
  await page.evaluate(() => {
    if (window.__standingOriginalGet) Storage.prototype.getItem = window.__standingOriginalGet;
  });
}

const baseURL = process.env.MONEY_STANDING_EXECUTIONS_BASE_URL;
const evidence = process.env.MONEY_STANDING_EXECUTIONS_EVIDENCE;
if (!baseURL || !evidence) throw new Error('Use the verified ordinary App origin and a new evidence directory.');
mkdirSync(evidence, { recursive: true });
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
const ui = {
  en: {
    outcomes: 'Execution outcomes',
    returned: 'Returned occurrences',
    inspect: (id) => `Inspect execution history for instruction ${id}`,
    occurrence: (n) => `Occurrence ${n}`,
    refresh: 'Refresh instructions',
    refreshOutcomes: 'Refresh outcomes',
    return: 'Back to instructions',
    missing: 'Instruction not in this response',
    conflict: 'Instruction could not be identified',
    notFound: 'Instruction not found by this read',
    empty: 'No occurrences returned',
    noLedger: 'No ledger reference returned',
    emptyReference: 'An empty reference was returned',
    hide: 'Hide amounts',
    show: 'Show amounts',
  },
  es: {
    outcomes: 'Resultados de ejecución',
    returned: 'Ejecuciones devueltas',
    inspect: (id) => `Consultar ejecuciones de la instrucción ${id}`,
    occurrence: (n) => `Ejecución ${n}`,
    refresh: 'Actualizar instrucciones',
    refreshOutcomes: 'Actualizar resultados',
    return: 'Volver a las instrucciones',
    noLedger: 'No se devolvió referencia del libro mayor',
    emptyReference: 'Se devolvió una referencia vacía',
    hide: 'Ocultar importes',
    show: 'Mostrar importes',
  },
  fr: {
    outcomes: 'Résultats d’exécution',
    returned: 'Exécutions renvoyées',
    inspect: (id) => `Consulter les exécutions de l’instruction ${id}`,
    occurrence: (n) => `Exécution ${n}`,
    refresh: 'Actualiser les instructions',
    refreshOutcomes: 'Actualiser les résultats',
    return: 'Retour aux instructions',
    noLedger: 'Aucune référence du grand livre renvoyée',
    emptyReference: 'Une référence vide a été renvoyée',
    hide: 'Masquer les montants',
    show: 'Afficher les montants',
  },
};
const selection = (page, locale = 'en') => main(page).getByRole('region', { name: ui[locale].outcomes, exact: true });
const historyRegion = (page, locale = 'en') => selection(page, locale).getByRole('region', { name: ui[locale].returned, exact: true });
const inspector = (page, row, locale = 'en') => main(page).getByRole('button', { name: ui[locale].inspect(row.id), exact: true });
const listReads = (state) => state.reads.filter((row) => row.path.endsWith('/transfers.listSchedules'));
const executionReads = (state) => state.reads.filter((row) => row.path.endsWith('/transfers.executions'));
const frames = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const exactFunds = (value, asset) =>
  `${value.split('.')[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${value.includes('.') ? '.' + value.split('.')[1] : ''} ${asset}`;
async function aboveFooter(locator, minimum = 0) {
  await expect
    .poll(() =>
      locator.evaluate((node, minimum) => {
        const b = node.getBoundingClientRect();
        const nav = document.querySelector('[data-testid="mobile-doors"]');
        const n = nav?.getBoundingClientRect();
        const edge = nav && getComputedStyle(nav).display !== 'none' && n.height > 0 ? n.top : innerHeight;
        return {
          left: b.left >= -0.5,
          right: b.right <= innerWidth + 0.5,
          top: b.top >= 0,
          bottom: b.bottom <= edge + 0.5,
          height: b.height >= minimum,
        };
      }, minimum),
    )
    .toEqual({ left: true, right: true, top: true, bottom: true, height: true });
}
async function snapshot(page, state, name, locale = 'en') {
  await page.evaluate(() => document.fonts.ready);
  const observation = await page.evaluate(() => {
    const selected = document.getElementById('money-selected-instruction-heading')?.closest('section');
    const nav = document.querySelector('[data-testid="mobile-doors"]'),
      n = nav?.getBoundingClientRect();
    const box = (node) => {
      const b = node?.getBoundingClientRect();
      return b ? { top: b.top, bottom: b.bottom, left: b.left, right: b.right, height: b.height, width: b.width } : null;
    };
    return {
      href: location.pathname + location.search + location.hash,
      timeOrigin: performance.timeOrigin,
      width: innerWidth,
      height: innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      scrollY,
      footerTop: nav && getComputedStyle(nav).display !== 'none' && n.height ? n.top : innerHeight,
      active: document.activeElement?.outerHTML,
      heading: box(document.getElementById('money-selected-instruction-heading')),
      reference: box(selected?.querySelector('[data-testid="money-standing-reference"] dd')),
      firstOutcome: box(selected?.querySelector('[data-testid="money-execution-outcome"]')),
      selectedDOM: selected?.outerHTML,
      mainDOM: document.querySelector('#main')?.outerHTML,
    };
  });
  state.observations ??= [];
  state.observations.push({ name, locale, ...observation });
  writeFileSync(
    join(evidence, `${name}.json`),
    JSON.stringify({ ...observation, locale, reads: state.reads, writes: state.writes, errors: state.errors }, null, 2),
    { flag: 'wx' },
  );
  await page.screenshot({ path: join(evidence, `${name}-viewport.png`) });
  await page.screenshot({ path: join(evidence, `${name}-whole.png`), fullPage: true });
  return observation;
}
async function scenario(browser, name, run, width = 1440, height = 1000) {
  const context = await browser.newContext({ baseURL, viewport: { width, height }, timezoneId: 'UTC' });
  const state = await standingNetwork(context);
  const page = await context.newPage();
  try {
    await run({ page, state });
    expect(state.writes).toEqual([]);
    expect(state.errors).toEqual([]);
    expect(state.fixtureErrors).toEqual([]);
    for (const read of [...listReads(state), ...executionReads(state)]) {
      expect(read.input.limit).toBeGreaterThanOrEqual(1);
      expect(read.input.limit).toBeLessThanOrEqual(200);
      expect(read.principal).toBeTruthy();
      expect(read.authorization).toMatch(/^Bearer isolated-standing-token-/);
    }
  } finally {
    state.held.forEach((held) => held.release());
    writeFileSync(
      join(evidence, `${name}-raw.json`),
      JSON.stringify(
        {
          fixedFixtureSource,
          qualification:
            'Self-authored native: ordinary compiled App/Login with isolated mounted DTOs/errors; no live SQL/Edge/scheduler/ledger authority, financial dispatch, public lookup, or original settlement. Actual candidate inputs/build/results are separately pinned by root.',
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
      ),
      { flag: 'wx' },
    );
    await context.close();
  }
}
async function enterTransfers(page) {
  await main(page).locator('[data-testid="money-bank-nav"] a[href="/bank/transfers"]').click();
  await expect.poll(() => currentURL(page)).toBe('/bank/transfers');
}
async function viewLocale(page, requested) {
  await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
  await page.getByRole('dialog').locator('a[href="/view"]').click();
  const language = page.locator('select').filter({ has: page.locator('option[value="ar"]') });
  await language.selectOption(requested);
  await expect(language).toHaveValue(requested);
  await page.locator('a[href="/money"]:visible').first().click();
  await expect.poll(() => currentURL(page)).toBe('/money');
  await main(page).locator('a[href="/bank"]').click();
  await expect.poll(() => currentURL(page)).toBe('/bank');
  await expect(page.locator('html')).toHaveAttribute('lang', requested === 'ar' ? 'en' : requested);
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
}
async function inspect(page, row, locale = 'en', keyboard = false) {
  const button = inspector(page, row, locale);
  await expect(button).toHaveCount(1);
  if (keyboard) {
    for (let step = 0; step < 45 && !(await button.evaluate((node) => node === document.activeElement)); step++)
      await page.keyboard.press('Tab');
    await expect(button).toBeFocused();
    await aboveFooter(button, 44);
    await page.keyboard.press('Enter');
  } else await button.click();
  await expect(selection(page, locale)).toHaveCount(1);
}
async function ready(page, row, rows, locale = 'en', hidden = false, requested = locale) {
  const panel = selection(page, locale),
    returned = historyRegion(page, locale);
  await expect(panel.locator('[data-testid="money-standing-reference"] dd')).toHaveText(row.id);
  await expect(panel.locator('[data-testid="money-standing-facts"] [data-testid="numeric"]')).toHaveText(
    hidden ? `•••• ${row.assetId}` : exactFunds(row.amount, row.assetId),
  );
  await expect(panel.locator('[data-testid="money-standing-facts"] time')).toHaveAttribute('datetime', row.nextRunAt);
  await expect(panel.locator('[data-testid="money-standing-facts"] dd[lang="und"]')).toHaveText(`${row.cadence} · ${row.status}`);
  await expect(returned.getByRole('article')).toHaveCount(rows.length);
  for (const item of rows.length <= 4 ? rows : [rows[0], rows.at(-1)]) {
    const occurrenceNumber = new Intl.NumberFormat(requested === 'ar' ? 'ar-EG' : requested, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 3,
      useGrouping: true,
      notation: 'standard',
    }).format(item.occurrence);
    const article = returned.getByRole('article', { name: ui[locale].occurrence(occurrenceNumber), exact: true });
    await expect(article).toHaveCount(1);
    await expect(article.locator('[data-testid="money-execution-status"] dd')).toHaveText(item.status);
    await expect(article.locator('[data-testid="money-execution-quantity"] dd')).toHaveText(
      hidden ? `•••• ${row.assetId}` : exactFunds(item.amount, row.assetId),
    );
    await expect(article.getByTestId('money-execution-refusal')).toHaveCount(item.rejectionCode === null ? 0 : 1);
    if (item.rejectionCode !== null)
      await expect(article.locator('[data-testid="money-execution-refusal"] dd')).toHaveText(
        item.rejectionCode === '' ? ui[locale].emptyReference : item.rejectionCode,
      );
    await expect(article.locator('[data-testid="money-execution-ledger"] dd')).toHaveText(
      item.ledgerTxId === null ? ui[locale].noLedger : item.ledgerTxId === '' ? ui[locale].emptyReference : item.ledgerTxId,
    );
  }
  return panel;
}
async function captureHandler(locator, key) {
  await locator.evaluate((node, key) => {
    const propsKey = Object.keys(node).find((key) => key.startsWith('__reactProps'));
    const handler = propsKey && node[propsKey]?.onClick;
    if (typeof handler !== 'function') throw new Error('Retained-control probe requires the actual rendered React click handler.');
    window[key] = handler;
  }, key);
}
const invoke = (page, key) => page.evaluate((key) => window[key](), key);
async function refreshOutcomes(page) {
  await historyRegion(page).getByRole('button', { name: ui.en.refreshOutcomes, exact: true }).click();
}
async function retryOutcomes(page) {
  await historyRegion(page).getByRole('button', { name: 'Try again', exact: true }).click();
}
async function refreshInstructions(page) {
  await main(page).getByRole('button', { name: ui.en.refresh, exact: true }).last().click();
}
async function storage(page) {
  return page.evaluate(() => ({
    local: Object.fromEntries(Object.entries(localStorage)),
    session: Object.fromEntries(Object.entries(sessionStorage)),
    history: history.state,
    href: location.href,
  }));
}

test('four widths identify the current instruction and readable outcomes through native inspection, privacy and honest locale fallback', async ({
  browser,
}) => {
  for (const [width, requested] of [
    [320, 'en'],
    [390, 'fr'],
    [768, 'es'],
    [1440, 'ar'],
  ]) {
    const locale = requested === 'ar' ? 'en' : requested;
    await scenario(
      browser,
      `standing-${width}-${requested}`,
      async ({ page, state }) => {
        const row = state.instructions.get(ownerA)[3];
        if (width === 390) row.assetId = 'ASSET12345678901';
        const results = state.results.get(row.id);
        results[0].ledgerTxId = 'ledger-reference:88888888-8888-4888-8888-888888888888:full-opaque-reference-end';
        await login(page);
        await ownerProof(page);
        const origin = await page.evaluate(() => performance.timeOrigin);
        if (requested !== 'en') await viewLocale(page, requested);
        await enterTransfers(page);
        expect(
          await main(page)
            .locator('[data-testid="money-bank-nav"] a')
            .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href'))),
        ).toEqual(paths);
        await inspect(page, row, locale, width >= 768);
        const panel = await ready(page, row, results, locale, false, requested);
        await snapshot(page, state, `standing-${width}-${requested}-arrival`, locale);
        await expect(panel.getByRole('heading', { name: ui[locale].outcomes, exact: true })).toBeFocused();
        await aboveFooter(panel.getByRole('heading', { name: ui[locale].outcomes, exact: true }));
        await aboveFooter(panel.locator('[data-testid="money-standing-reference"] dd'));
        await aboveFooter(historyRegion(page, locale).getByRole('article').first());
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await expect(panel.locator('[data-testid="money-standing-reference"] dd')).toHaveAttribute('lang', 'zxx');
        await expect(
          historyRegion(page, locale).getByRole('article').first().locator('[data-testid="money-execution-status"] dd'),
        ).toHaveAttribute('lang', 'und');
        const b = state.instructions.get(ownerA)[7];
        await inspect(page, b, locale);
        await ready(page, b, state.results.get(b.id), locale, false, requested);
        expect(executionReads(state).at(-1).input).toEqual({ scheduleId: b.id, limit: 50 });
        await main(page).locator('[data-testid="money-bank-nav"] a[href="/bank"]').click();
        await main(page).getByRole('button', { name: ui[locale].hide, exact: true }).click();
        await enterTransfers(page);
        await inspect(page, row, locale);
        await ready(page, row, results, locale, true, requested);
        await snapshot(page, state, `standing-${width}-${requested}-hidden`, locale);
        await main(page).locator('[data-testid="money-bank-nav"] a[href="/bank"]').click();
        await main(page).getByRole('button', { name: ui[locale].show, exact: true }).click();
        await enterTransfers(page);
        await inspect(page, row, locale);
        await ready(page, row, results, locale, false, requested);
        expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin);
        expect(state.documents).toHaveLength(1);
      },
      width,
      width < 768 ? 844 : 1000,
    );
  }
});

test('current execution reads recover from real-shaped refusals and respect owner windows and the oldest200 cap', async ({ browser }) => {
  await scenario(browser, 'standing-read-recovery', async ({ page, state }) => {
    const a = state.instructions.get(ownerA)[3],
      b = state.instructions.get(ownerA)[7];
    const normal = state.executionReply;
    await login(page, '/bank/transfers');
    await ownerProof(page);
    await inspect(page, a);
    await ready(page, a, state.results.get(a.id));
    const listHold = deferred();
    state.held.push(listHold);
    const originalList = state.listReply;
    await captureHandler(inspector(page, b), '__preRevalidationInspect');
    state.listReply = async (args) => {
      const reply = await originalList(args);
      await listHold.promise;
      return reply;
    };
    await refreshInstructions(page);
    await expect(selection(page).getByTestId('money-standing-facts')).toHaveCount(0);
    await expect(historyRegion(page)).toHaveCount(0);
    const beforeRetired = executionReads(state).length;
    await invoke(page, '__preRevalidationInspect');
    await frames(page);
    expect(executionReads(state)).toHaveLength(beforeRetired);
    await snapshot(page, state, 'standing-list-revalidation-before-response');
    state.listReply = originalList;
    listHold.release();
    await ready(page, a, state.results.get(a.id));
    for (const [name, refusal] of [
      ['service503', readRefusals.unavailable],
      ['scope403', readRefusals.scope],
      ['owner403', readRefusals.owner],
    ]) {
      state.executionReply = async () => refusal();
      await refreshOutcomes(page);
      await expect(historyRegion(page).getByTestId('failure')).toBeVisible();
      await expect(historyRegion(page).getByRole('article')).toHaveCount(0);
      await snapshot(page, state, `standing-${name}-before-retry`);
      state.executionReply = normal;
      await retryOutcomes(page);
      await ready(page, a, state.results.get(a.id));
      expect(executionReads(state).at(-1).input.scheduleId).toBe(a.id);
    }
    state.executionReply = async () => readRefusals.missing();
    await refreshOutcomes(page);
    await expect(historyRegion(page).getByRole('heading', { name: ui.en.notFound, exact: true })).toBeVisible();
    await expect(historyRegion(page).getByRole('article')).toHaveCount(0);
    await historyRegion(page).getByText('Service detail', { exact: true }).click();
    await expect(historyRegion(page).getByText('bank.schedule_not_found', { exact: true })).toBeVisible();
    await expect(historyRegion(page)).toContainText('does not establish that the instruction was deleted');
    await snapshot(page, state, 'standing-domain404-before-owner-list-refresh');
    state.listReply = async ({ principal, input }) => ({
      status: 200,
      data: state.instructions
        .get(principal)
        .filter((row) => row.id !== a.id)
        .slice(0, input.limit),
    });
    state.executionReply = normal;
    await historyRegion(page).getByRole('button', { name: ui.en.refresh, exact: true }).click();
    await expect(selection(page).getByRole('heading', { name: ui.en.missing, exact: true })).toBeVisible();
    await expect(selection(page).getByTestId('money-standing-facts')).toHaveCount(0);
    await expect(historyRegion(page)).toHaveCount(0);
    await inspect(page, b);
    await ready(page, b, state.results.get(b.id));
    const listNormal = async ({ principal, input }) => ({ status: 200, data: state.instructions.get(principal).slice(0, input.limit) });
    state.listReply = async () => ({ status: 200, data: [b, { ...b, amount: '99' }] });
    await refreshInstructions(page);
    await expect(selection(page).getByRole('heading', { name: ui.en.conflict, exact: true })).toBeVisible();
    await expect(selection(page).getByTestId('money-standing-facts')).toHaveCount(0);
    await expect(historyRegion(page)).toHaveCount(0);
    await expect(inspector(page, b)).toHaveCount(2);
    for (const button of await inspector(page, b).all()) await expect(button).toBeDisabled();
    state.listReply = listNormal;
    await refreshInstructions(page);
    await ready(page, b, state.results.get(b.id));
    state.executionReply = async () => ({
      status: 200,
      data: [{ occurrence: 0, amount: 'NaN', status: 'settled', ledgerTxId: null, rejectionCode: null }],
    });
    await refreshOutcomes(page);
    await expect(historyRegion(page).getByTestId('failure')).toBeVisible();
    await expect(historyRegion(page).getByRole('article')).toHaveCount(0);
    state.executionReply = normal;
    await retryOutcomes(page);
    await ready(page, b, state.results.get(b.id));
    state.executionReply = async () => ({ status: 200, data: [] });
    await refreshOutcomes(page);
    await expect(historyRegion(page).getByRole('heading', { name: ui.en.empty, exact: true })).toBeVisible();
    await expect(historyRegion(page)).toContainText('not confirmation of a transfer outcome');
    await snapshot(page, state, 'standing-empty-before-current-refresh');
    state.executionReply = async () => readRefusals.unauthorized();
    await refreshOutcomes(page);
    await expect(main(page).getByRole('heading', { name: 'Sign in to continue', exact: true })).toBeVisible();
    await expect(selection(page)).toHaveCount(0);
    await snapshot(page, state, 'standing-401-guest-before-login');
    const signIn = main(page).getByRole('link', { name: 'Sign in', exact: true });
    expect(new URL(await signIn.getAttribute('href'), baseURL).searchParams.get('redirect')).toBe('/bank/transfers');
    state.executionReply = normal;
    await signIn.click();
    await submitLogin(page, '/bank/transfers');
    await ownerProof(page);
    await expect(selection(page)).toHaveCount(0);
    await inspect(page, b);
    await ready(page, b, state.results.get(b.id));
    expect(executionReads(state).at(-1).authorization).toBe(`Bearer ${state.logins.at(-1).token}`);
    expect(state.documents).toHaveLength(1);
  });
  await scenario(browser, 'standing-bounded200', async ({ page, state }) => {
    state.instructions.set(ownerA, instructionRows(ownerA, 200));
    for (const row of state.instructions.get(ownerA)) state.results.set(row.id, executionRows(row, 200));
    await login(page, '/bank/transfers');
    await ownerProof(page);
    await expect(main(page).getByTestId('money-standing-record')).toHaveCount(50);
    const ownerArrivalReads = listReads(state).length;
    expect(ownerArrivalReads).toBeGreaterThanOrEqual(1);
    expect(listReads(state).map((read) => read.input.limit)).toEqual(Array(ownerArrivalReads).fill(50));
    for (const read of listReads(state)) {
      expect(read.principal).toBe(ownerA);
      expect(read.authorization).toBe(`Bearer ${state.logins.at(-1).token}`);
    }
    for (const limit of [100, 150, 200]) {
      await main(page)
        .locator('[data-testid="money-standing-orders"] [data-testid="money-continuation"]')
        .getByRole('button', { name: `Load up to ${limit}`, exact: true })
        .click();
      await expect(main(page).getByTestId('money-standing-record')).toHaveCount(limit);
    }
    const row = state.instructions.get(ownerA)[3];
    await inspect(page, row);
    await ready(page, row, state.results.get(row.id).slice(0, 50));
    for (const limit of [100, 150, 200]) {
      await historyRegion(page)
        .getByRole('button', { name: `Load up to ${limit}`, exact: true })
        .click();
      await ready(page, row, state.results.get(row.id).slice(0, limit));
    }
    await expect(historyRegion(page)).toContainText('History beyond the first 200 occurrences is unavailable here.');
    await expect(historyRegion(page).getByRole('button', { name: /^Load up to/ })).toHaveCount(0);
    expect(executionReads(state).map((read) => read.input.limit)).toEqual([50, 100, 150, 200]);
    expect(
      listReads(state)
        .slice(ownerArrivalReads)
        .map((read) => read.input.limit),
    ).toEqual([100, 150, 200]);
    await snapshot(page, state, 'standing-oldest200-current-cap');
  });
});

test('late and retired instruction controls preserve current URL, actor, dialog focus and the original bank guard', async ({ browser }) => {
  await scenario(browser, 'standing-late-url-dialog', async ({ page, state }) => {
    const a = state.instructions.get(ownerA)[3],
      b = state.instructions.get(ownerA)[7];
    const hold = deferred();
    state.held.push(hold);
    const normal = state.executionReply;
    let first = true;
    state.executionReply = async (args) => {
      const reply = await normal(args);
      if (first && args.input.scheduleId === a.id) {
        first = false;
        await hold.promise;
      }
      return reply;
    };
    await login(page, '/bank/transfers');
    await inspect(page, a);
    await expect.poll(() => executionReads(state).length).toBe(1);
    await expect(historyRegion(page).getByRole('article')).toHaveCount(0);
    await inspect(page, b);
    await ready(page, b, state.results.get(b.id));
    hold.release();
    await frames(page);
    await expect(selection(page).locator('[data-testid="money-standing-reference"] dd')).toHaveText(b.id);
    for (const mode of ['query', 'hash-aba', 'query-aba', 'pathname']) {
      await captureHandler(historyRegion(page).getByRole('button', { name: ui.en.refreshOutcomes, exact: true }), '__oldStandingRefresh');
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
          history.pushState({}, '', '/bank/transfers');
          window.dispatchEvent(new PopStateEvent('popstate'));
        });
      }
      await expect.poll(() => currentURL(page)).toBe('/bank/transfers');
      await expect(inspector(page, b)).toBeVisible();
      const count = executionReads(state).length;
      await invoke(page, '__oldStandingRefresh');
      await frames(page);
      expect(executionReads(state)).toHaveLength(count);
      await expect(selection(page)).toHaveCount(0);
      await inspect(page, b);
      await ready(page, b, state.results.get(b.id));
    }
    const focusHold = deferred();
    state.held.push(focusHold);
    state.executionReply = async (args) => {
      const reply = await normal(args);
      await focusHold.promise;
      return reply;
    };
    await captureHandler(historyRegion(page).getByRole('button', { name: ui.en.refreshOutcomes, exact: true }), '__preHeldRefresh');
    await refreshOutcomes(page);
    await expect(historyRegion(page).getByRole('article')).toHaveCount(0);
    const heldCount = executionReads(state).length;
    await invoke(page, '__preHeldRefresh');
    await frames(page);
    expect(executionReads(state)).toHaveLength(heldCount);
    await main(page).getByLabel('From your space', { exact: true }).selectOption(primaryId);
    await main(page).getByRole('button', { name: 'Continue', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.locator('input[name="toSpaceId"]').fill(destinationSpaceId);
    const amount = dialog.locator('input[name="amount"]');
    await amount.fill('0.000000000000000007');
    focusHold.release();
    await ready(page, b, state.results.get(b.id));
    await frames(page);
    await expect(amount).toBeFocused();
    await expect(amount).toHaveValue('0.000000000000000007');
    await expect(dialog).toBeVisible();
    expect(JSON.stringify(await storage(page))).not.toContain('0.000000000000000007');
    await snapshot(page, state, 'standing-late-read-current-dialog-preserved');
    await page.keyboard.press('Escape');
    state.executionReply = normal;
    await refreshOutcomes(page);
    await ready(page, b, state.results.get(b.id));
  });
  for (const nextOwner of [ownerA, ownerB])
    await scenario(browser, `standing-owner-${nextOwner === ownerA ? 'new-token' : 'different'}`, async ({ page, state }) => {
      const a = state.instructions.get(ownerA)[3];
      await login(page, '/bank/transfers');
      await inspect(page, a);
      await ready(page, a, state.results.get(a.id));
      await captureHandler(historyRegion(page).getByRole('button', { name: ui.en.refreshOutcomes, exact: true }), '__oldStandingOwner');
      const origin = await page.evaluate(() => performance.timeOrigin);
      await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(selection(page)).toHaveCount(0);
      state.owner = nextOwner;
      await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
      await page.getByRole('dialog').getByRole('link', { name: 'Sign in', exact: true }).click();
      await submitLogin(page, '/money');
      await ownerProof(page, nextOwner);
      const count = executionReads(state).length;
      await invoke(page, '__oldStandingOwner');
      await frames(page);
      expect(executionReads(state)).toHaveLength(count);
      await main(page).locator('a[href="/bank"]').click();
      await enterTransfers(page);
      const current = state.instructions.get(nextOwner)[3];
      await inspect(page, current);
      await ready(page, current, state.results.get(current.id));
      expect(executionReads(state).at(-1).authorization).toBe(`Bearer ${state.logins.at(-1).token}`);
      expect(state.logins[0].token).not.toBe(state.logins[1].token);
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin);
      expect(state.documents).toHaveLength(1);
    });
  for (const unreadable of [false, true])
    await scenario(
      browser,
      `standing-original-${unreadable ? 'unreadable' : 'unknown'}`,
      async ({ page, state }) => {
        const row = state.instructions.get(ownerA)[3];
        await login(page);
        await seedBankOriginal(page, unreadable);
        await enterTransfers(page);
        const recovery = main(page).locator('#bank-unconfirmed');
        await expect(recovery).toHaveAttribute('role', 'alert');
        expect(await readBankOriginalRaw(page)).toBe(bankOriginalRaw);
        await inspect(page, row);
        await ready(page, row, state.results.get(row.id));
        await selection(page).getByRole('button', { name: 'Pause', exact: true }).click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(recovery).toContainText('Bank writes are paused');
        await aboveFooter(recovery.getByRole('heading'));
        expect(await readBankOriginalRaw(page)).toBe(bankOriginalRaw);
        await snapshot(page, state, `standing-original-${unreadable ? 'unreadable' : 'unknown'}-guard`);
        await restoreOriginalRead(page);
        await main(page).locator('[data-testid="money-bank-nav"] a[href="/bank"]').click();
        await enterTransfers(page);
        await inspect(page, row);
        await ready(page, row, state.results.get(row.id));
        await expect(recovery).toContainText(originalReference);
        const normal = state.executionReply;
        state.executionReply = async () => readRefusals.unavailable();
        await refreshOutcomes(page);
        await expect(historyRegion(page).getByTestId('failure')).toBeVisible();
        expect(await readBankOriginalRaw(page)).toBe(bankOriginalRaw);
        state.executionReply = normal;
        await retryOutcomes(page);
        await ready(page, row, state.results.get(row.id));
        expect(await readBankOriginalRaw(page)).toBe(bankOriginalRaw);
        await expect(recovery).toContainText(originalReference);
      },
      320,
      844,
    );
});
