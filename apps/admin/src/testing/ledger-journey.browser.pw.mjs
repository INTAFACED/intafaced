import { test as base, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, writeFile } from 'node:fs/promises';
const evidence = process.env.TEAM_LEDGER_EVIDENCE;
const actor = 'env:LEDGER_POSTING_ENABLED';
const reason = 'Isolated ledger incident — opaque <script>never execute</script> & Δ\nExact second line';
const changedAt = '2026-10-09T16:00:00.000Z';
const frozen = { frozen: true, reason, actor, changedAt };
const openState = { frozen: false, reason: null, actor: null, changedAt };
const wire = (state = frozen) => ({ ok: true, status: 200, kind: 'reachable', state, detail: null });
const test = base.extend({
  observation: [
    async ({ context }, use, info) => {
      const data = {
        title: info.title,
        primary: { pageErrors: [], consoleErrors: [] },
        future: [],
        privilegedPosts: [],
        externalRequests: [],
        requests: [],
      };
      const seen = new WeakSet();
      let registered = 0;
      const watch = (page) => {
        if (seen.has(page)) return;
        seen.add(page);
        const lane = registered++ === 0 ? data.primary : { pageErrors: [], consoleErrors: [] };
        if (lane !== data.primary) data.future.push(lane);
        page.on('pageerror', (e) => lane.pageErrors.push(String(e)));
        page.on('console', (msg) => {
          if (msg.type() === 'error') lane.consoleErrors.push(msg.text());
        });
      };
      context.on('page', watch);
      for (const p of context.pages()) watch(p);
      context.on('request', (req) => {
        const url = new URL(req.url());
        data.requests.push({ method: req.method(), path: url.pathname });
        if (req.method() === 'POST' && url.pathname.startsWith('/api/')) data.privilegedPosts.push(url.pathname);
      });
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port === '3154') return route.fallback();
        data.externalRequests.push(url.origin);
        return route.abort('blockedbyclient');
      });
      await use(data);
      context.off('page', watch);
      await mkdir(evidence, { recursive: true });
      await writeFile(`${evidence}/observer-${info.testId}.json`, JSON.stringify(data, null, 2));
      await info.attach('actual-page-observers', { body: JSON.stringify(data), contentType: 'application/json' });
      expect(data.primary.pageErrors).toEqual([]);
      expect(data.future.flatMap((x) => x.pageErrors)).toEqual([]);
      expect(data.privilegedPosts).toEqual([]);
      expect(data.externalRequests).toEqual([]);
    },
    { auto: true },
  ],
});
const desk = (page) => page.locator('.lo');
const record = (page) => desk(page).getByTestId('posting-record');
async function fixture(page, body = wire(), status = 200) {
  await page.route('**/api/ledger-freeze', (route) => route.fulfill({ status, json: body }));
}
async function visit(page) {
  await page.goto('/ledger');
  await expect(page.getByRole('heading', { level: 1, name: 'Ledger operations', exact: true })).toBeVisible();
}
async function unavailableWrites(page) {
  await expect(desk(page).getByRole('button', { name: 'Freeze ledger', exact: true })).toBeDisabled();
  await expect(desk(page).getByRole('button', { name: 'Unfreeze ledger', exact: true })).toBeDisabled();
}
async function noStale(page) {
  await expect(record(page)).toHaveCount(0);
  await expect(desk(page).getByText(actor, { exact: true })).toHaveCount(0);
  await expect(desk(page).getByText(reason, { exact: true })).toHaveCount(0);
  await expect(desk(page).locator('time')).toHaveCount(0);
}
for (const width of [320, 390, 768, 1440])
  test(`exact standing frozen record, full parent and readable fit at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await fixture(page);
    await visit(page);
    await expect(record(page)).toBeVisible();
    await expect(record(page).locator('dd').nth(0)).toHaveText(reason);
    await expect(record(page).locator('dd').nth(1)).toHaveText(actor);
    await expect(record(page).locator('time')).toHaveText(changedAt);
    await expect(desk(page).getByText('Last change · not read time', { exact: true })).toBeVisible();
    await unavailableWrites(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const values = await record(page)
      .locator('dd')
      .evaluateAll((nodes) =>
        nodes.map((n) => ({
          text: n.textContent,
          font: parseFloat(getComputedStyle(n).fontSize),
          width: n.getBoundingClientRect().width,
          scroll: n.scrollWidth,
        })),
      );
    expect(values.every((x) => x.font >= 16 && x.scroll <= x.width + 1)).toBe(true);
    await expect(page.getByRole('link', { name: 'Ledger ops', exact: true })).toHaveAttribute('aria-current', 'page');
    await page.screenshot({ path: `${evidence}/ledger-frozen-${width}.png`, fullPage: true });
  });
test('valid not-frozen/null record is exact bounded state, never accepting/live health/receipt', async ({ page }) => {
  await fixture(page, wire(openState));
  await visit(page);
  await expect(record(page)).toBeVisible();
  await expect(desk(page).getByText('Posting not frozen', { exact: true })).toBeVisible();
  await expect(record(page).getByText('No reason recorded (null)', { exact: true })).toBeVisible();
  await expect(record(page).getByText('No actor recorded (null)', { exact: true })).toBeVisible();
  await unavailableWrites(page);
  await expect(desk(page).getByText('Service command receipt', { exact: true })).toHaveCount(0);
  await expect(desk(page).getByText('ACCEPTING', { exact: true })).toHaveCount(0);
});
const malformed = [
  ['missing frozen', { reason: null, actor: null, changedAt }],
  ['numeric frozen', { ...frozen, frozen: 0 }],
  ['missing reason', { frozen: true, actor, changedAt }],
  ['missing actor', { frozen: true, reason, changedAt }],
  ['missing last change', { frozen: true, reason, actor }],
  ['null last change', { ...frozen, changedAt: null }],
  ['opaque-object actor', { ...frozen, actor: {} }],
  ['opaque-object reason', { ...frozen, reason: {} }],
  ['impossible calendar', { ...frozen, changedAt: '2026-02-30T09:00:00.000Z' }],
  ['non-leap day', { ...frozen, changedAt: '2025-02-29T00:00:00Z' }],
  ['invalid offset', { ...frozen, changedAt: '2026-10-09T00:00:00+24:00' }],
  ['invalid time', { ...frozen, changedAt: '2026-10-09T24:00:00Z' }],
  ['array record', []],
  ['null record', null],
];
for (const [name, state] of malformed)
  test(`malformed200 ${name} refuses read and hides all fields`, async ({ page }) => {
    await fixture(page, wire(state));
    await visit(page);
    await expect(desk(page).getByText('Invalid posting response', { exact: true })).toBeVisible();
    await noStale(page);
    await unavailableWrites(page);
    await expect(desk(page).getByRole('button', { name: 'Retry read', exact: true })).toBeVisible();
  });
for (const [name, body] of [
  ['false success', { ...wire(), ok: false }],
  ['status mismatch', { ...wire(), status: 403 }],
  ['kind mismatch', { ...wire(), kind: 'refused' }],
  ['untyped body', {}],
])
  test(`contradictory200 ${name} cannot render standing state`, async ({ page }) => {
    await fixture(page, body);
    await visit(page);
    await expect(desk(page).getByText('Invalid posting response', { exact: true })).toBeVisible();
    await noStale(page);
  });
for (const [status, code, label] of [
  [404, 'edge.no_route', 'Read route unavailable'],
  [403, 'scope.denied', 'Read refused'],
  [401, 'admin.bff_gate', 'Read refused'],
  [503, 'admin.bff_gate_unconfigured', 'Read unavailable'],
  [500, 'ledger.operator_request_failed', 'Read unreachable'],
])
  test(`read ${status}/${code} remains honest with GET retry`, async ({ page }) => {
    await fixture(page, { error: 'Isolated opaque read refusal', code }, status);
    await visit(page);
    await expect(desk(page).getByText(label, { exact: true })).toBeVisible();
    await noStale(page);
    await expect(desk(page).getByText(`HTTP ${status} · ${code}`, { exact: true })).toBeVisible();
    await unavailableWrites(page);
  });
test('unreadable HTML200 is invalid, never assumed not frozen', async ({ page }) => {
  await page.route('**/api/ledger-freeze', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<html>isolated proxy page</html>' }),
  );
  await visit(page);
  await expect(desk(page).getByText('Invalid posting response', { exact: true })).toBeVisible();
  await noStale(page);
});
test('transport failure is unreachable, no stale or replay', async ({ page }) => {
  await page.route('**/api/ledger-freeze', (route) => route.abort('failed'));
  await visit(page);
  await expect(desk(page).getByText('Read unreachable', { exact: true })).toBeVisible();
  await noStale(page);
  await unavailableWrites(page);
});
test('failure retry GET recovers exact standing record without changing command availability', async ({ page, observation }) => {
  let reads = 0;
  await page.route('**/api/ledger-freeze', (route) =>
    ++reads === 1
      ? route.fulfill({ status: 403, json: { error: 'Isolated read refusal', code: 'scope.denied' } })
      : route.fulfill({ json: wire() }),
  );
  await visit(page);
  await expect(desk(page).getByText('Read refused', { exact: true })).toBeVisible();
  await noStale(page);
  await desk(page).getByRole('button', { name: 'Retry read', exact: true }).click();
  await expect(record(page)).toBeVisible();
  await unavailableWrites(page);
  expect(observation.requests.filter((r) => r.path === '/api/ledger-freeze').every((r) => r.method === 'GET')).toBe(true);
});
test('refresh hides the old record immediately; failed read cannot retain reason/actor/time', async ({ page }) => {
  let reads = 0;
  let release;
  await page.route('**/api/ledger-freeze', (route) => {
    if (++reads === 1) return route.fulfill({ json: wire() });
    release = () => route.fulfill({ status: 404, json: { error: 'Isolated missing route', code: 'edge.no_route' } });
  });
  await visit(page);
  await expect(record(page)).toBeVisible();
  await desk(page).getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(desk(page).getByText('Reading posting record…', { exact: true })).toBeVisible();
  await noStale(page);
  await expect.poll(() => typeof release).toBe('function');
  await release();
  await expect(desk(page).getByText('Read route unavailable', { exact: true })).toBeVisible();
  await noStale(page);
});
test('late earlier read cannot replace newer original standing selection', async ({ page }) => {
  let reads = 0;
  let release;
  await page.route('**/api/ledger-freeze', (route) => {
    if (++reads === 1) {
      release = () => route.fulfill({ json: wire(frozen) }).catch(() => {});
      return;
    }
    return route.fulfill({ json: wire({ ...openState, actor: 'Newer opaque attribution', changedAt: '2026-10-09T17:00:00.000Z' }) });
  });
  await visit(page);
  await expect(desk(page).getByText('Reading posting record…', { exact: true })).toBeVisible();
  await expect.poll(() => typeof release).toBe('function');
  await desk(page).getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(record(page)).toBeVisible();
  await expect(record(page).getByText('Newer opaque attribution', { exact: true })).toBeVisible();
  await release();
  await expect(record(page).getByText('Newer opaque attribution', { exact: true })).toBeVisible();
  await expect(record(page).getByText(actor, { exact: true })).toHaveCount(0);
});
for (const width of [320, 390, 1440])
  test(`keyboard requirements preserve disabled controls and exact phrases at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await fixture(page);
    await visit(page);
    await expect(record(page)).toBeVisible();
    const summary = desk(page).locator('summary');
    await expect(summary).toHaveCount(1);
    await summary.focus();
    await page.keyboard.press('Space');
    await expect(desk(page).locator('details')).toHaveAttribute('open', '');
    for (const id of ['freeze-reason', 'freeze-confirm', 'unfreeze-confirm']) await expect(desk(page).locator(`#${id}`)).toBeDisabled();
    await expect(desk(page).getByText('FREEZE LEDGER', { exact: true })).toBeVisible();
    await expect(desk(page).getByText('UNFREEZE LEDGER', { exact: true })).toBeVisible();
    await expect(desk(page).locator('input[type=checkbox]')).toHaveCount(2);
    await unavailableWrites(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await summary.focus();
    await page.keyboard.press('Space');
    await expect(desk(page).locator('details')).not.toHaveAttribute('open', '');
  });
test('local reconcile preview sends nothing and shows not-counted instead of fake zero book totals', async ({ page, observation }) => {
  await fixture(page);
  await visit(page);
  await expect(record(page)).toBeVisible();
  await desk(page).getByRole('button', { name: 'Inspect simulated reconciliation', exact: true }).click();
  const preview = desk(page).getByTestId('reconcile-preview');
  await expect(preview).toBeVisible();
  await expect(preview.getByText('Nothing was sent', { exact: true })).toBeVisible();
  await expect(preview.locator('dd')).toHaveText(['Not counted', 'Not counted', 'Not checked']);
  expect(observation.requests.filter((r) => r.method === 'POST')).toEqual([]);
});
test('history absence never claims no commands, original resolution or current human ownership', async ({ page }) => {
  await fixture(page, wire(openState));
  await visit(page);
  await expect(record(page)).toBeVisible();
  await expect(desk(page).getByText('Original operations', { exact: true })).toBeVisible();
  await expect(desk(page).getByText(/Earlier transient outcomes cannot be recovered/)).toBeVisible();
  await expect(desk(page).getByText(/Original private inputs are not displayed/)).toBeVisible();
  await expect(desk(page).getByText('Not applied', { exact: true })).toHaveCount(0);
});
test('native Ledger navigation, reload and future tab preserve read boundary and never arm writes', async ({
  page,
  context,
  observation,
}) => {
  await context.route('**/api/ledger-freeze', (route) => route.fulfill({ json: wire() }));
  await page.goto('/');
  await page.getByRole('link', { name: 'Ledger ops', exact: true }).click();
  await expect(record(page)).toBeVisible();
  await unavailableWrites(page);
  await page.reload();
  await expect(record(page)).toBeVisible();
  const tab = await context.newPage();
  await tab.goto('/ledger');
  await expect(record(tab)).toBeVisible();
  await unavailableWrites(tab);
  expect(observation.future).toHaveLength(1);
});
test('ordinary compiled unconfigured boundary stays unavailable with actual BFF refusal and no seeded human identity', async ({ page }) => {
  await visit(page);
  await expect(desk(page).getByText('Read unavailable', { exact: true })).toBeVisible();
  await expect(desk(page).getByText('HTTP 503 · admin.bff_gate_unconfigured', { exact: true })).toBeVisible();
  await noStale(page);
  await unavailableWrites(page);
});
test('standing desktop has no serious/critical accessibility violations', async ({ page }) => {
  await fixture(page);
  await visit(page);
  await expect(record(page)).toBeVisible();
  const result = await new AxeBuilder({ page }).include('.lo').analyze();
  expect(result.violations.filter((v) => ['serious', 'critical'].includes(v.impact))).toEqual([]);
});

test('language boundaries in actual mounted EN preserve supplied prose and nonlinguistic record tokens', async ({ page }) => {
  const supplied = 'Razón opaca sin idioma publicado — <script>no ejecutar</script> & Δ';
  await fixture(page, wire({ ...frozen, reason: supplied }));
  await visit(page);
  await expect(record(page)).toBeVisible();
  const fields = record(page).locator('dd');
  await expect(fields.nth(0)).toHaveText(supplied);
  await expect(fields.nth(0)).toHaveAttribute('lang', 'und');
  await expect(fields.nth(1)).toHaveText(actor);
  await expect(fields.nth(1)).toHaveAttribute('lang', 'zxx');
  await expect(fields.nth(2)).toHaveAttribute('lang', 'zxx');
  await expect(fields.nth(2).locator('time')).toHaveText(changedAt);
  await expect(desk(page)).toHaveAttribute('lang', 'en');
  await unavailableWrites(page);
});
test('language boundaries keep supplied failure prose unknown and HTTP/code references nonlinguistic', async ({ page }) => {
  const supplied = 'Diagnóstico opaco sin idioma publicado — conservar bytes';
  await fixture(page, { error: supplied, code: 'scope.denied' }, 403);
  await visit(page);
  await expect(desk(page).locator('.lo-status p')).toHaveText(supplied);
  await expect(desk(page).locator('.lo-status p')).toHaveAttribute('lang', 'und');
  await expect(desk(page).locator('.lo-diagnostic')).toHaveText('HTTP 403 · scope.denied');
  await expect(desk(page).locator('.lo-diagnostic')).toHaveAttribute('lang', 'zxx');
  await noStale(page);
});
test('language boundaries retain actual EN authored null fallback labels', async ({ page }) => {
  await fixture(page, wire(openState));
  await visit(page);
  await expect(record(page)).toBeVisible();
  const fields = record(page).locator('dd');
  await expect(fields.nth(0)).toHaveText('No reason recorded (null)');
  await expect(fields.nth(1)).toHaveText('No actor recorded (null)');
  const scopes = await fields.evaluateAll((nodes) =>
    nodes.map((n) => ({ own: n.getAttribute('lang'), nearest: n.closest('[lang]')?.getAttribute('lang') })),
  );
  expect(scopes.slice(0, 2)).toEqual([
    { own: null, nearest: 'en' },
    { own: null, nearest: 'en' },
  ]);
  expect(scopes[2]).toEqual({ own: 'zxx', nearest: 'zxx' });
});
test('language boundaries retain fixed English confirmation phrases and nonlinguistic deployment names', async ({ page }) => {
  await fixture(page);
  await visit(page);
  await expect(record(page)).toBeVisible();
  await expect(desk(page).locator('.lo-transport span[lang=zxx]')).toHaveText('EDGE_URL, ADMIN_TREASURY_TOKEN');
  await desk(page).locator('summary').click();
  for (const phrase of ['FREEZE LEDGER', 'UNFREEZE LEDGER'])
    await expect(desk(page).getByText(phrase, { exact: true })).toHaveAttribute('lang', 'en');
  await unavailableWrites(page);
});
