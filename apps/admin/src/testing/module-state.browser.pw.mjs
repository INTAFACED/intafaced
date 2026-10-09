import { test as base, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { MODULE_IDS } from '@intafaced/config';
import { writeFile, mkdir } from 'node:fs/promises';
const evidence = process.env.TEAM_MODULE_EVIDENCE;
const zero = { disabledModules: [], reasons: {}, audit: [] };
const actor = '00000000-0000-4000-8000-000000000091';
const confirmer = '00000000-0000-4000-8000-000000000092';
const reason = 'Isolated historical incident — opaque <script>never execute</script> & Δ';
const event = {
  at: '2026-10-09T16:00:00.000Z',
  module: 'trade',
  actor,
  confirmOperatorId: confirmer,
  reason,
  previous: false,
  next: true,
  changed: true,
};
const nonzero = { disabledModules: ['trade'], reasons: { trade: 'Isolated current incident — original module trade' }, audit: [event] };
const envelope = (snapshot) => ({ status: 'reachable', snapshot, detail: null });
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
      const watch = (page) => {
        if (seen.has(page)) return;
        seen.add(page);
        const entry = { pageErrors: [], consoleErrors: [] };
        const lane = data.registered ? (data.future.push(entry), entry) : data.primary;
        data.registered = (data.registered ?? 0) + 1;
        page.on('pageerror', (error) => lane.pageErrors.push(String(error)));
        page.on('console', (msg) => {
          if (msg.type() === 'error') lane.consoleErrors.push(msg.text());
        });
      };
      context.on('page', watch);
      for (const page of context.pages()) watch(page);
      context.on('request', (req) => {
        const url = new URL(req.url());
        data.requests.push({ method: req.method(), path: url.pathname });
        if (req.method() === 'POST' && url.pathname.startsWith('/api/')) data.privilegedPosts.push(url.pathname);
      });
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port === '3153') return route.fallback();
        data.externalRequests.push(url.origin);
        return route.abort('blockedbyclient');
      });
      await use(data);
      context.off('page', watch);
      await mkdir(evidence, { recursive: true });
      await writeFile(`${evidence}/observer-${info.testId}.json`, JSON.stringify(data, null, 2));
      await info.attach('actual-page-observers', { body: JSON.stringify(data), contentType: 'application/json' });
      expect(data.primary.pageErrors).toEqual([]);
      expect(data.future.flatMap((p) => p.pageErrors)).toEqual([]);
      expect(data.privilegedPosts).toEqual([]);
      expect(data.externalRequests).toEqual([]);
    },
    { auto: true },
  ],
});
const inspector = (page) => page.locator('.module-inspector');
const original = (page) => inspector(page).locator('#original-module-state');
const current = (page) => inspector(page).getByTestId('current-module-state');
async function fixture(page, body = envelope(nonzero), status = 200) {
  await page.route('**/api/kill-switch', (route) => route.fulfill({ status, json: body }));
}
async function open(page, hash = '') {
  await page.goto('/' + hash);
  await expect(page.getByRole('heading', { name: 'Kill-switches', level: 1, exact: true })).toBeVisible();
}
async function ready(page) {
  await expect(current(page)).toBeVisible();
}
async function noStale(page) {
  await expect(current(page)).toHaveCount(0);
  await expect(inspector(page).locator('.mi-audit')).toHaveCount(0);
}
async function geometry(page, width) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  for (const element of await inspector(page).locator('button:visible, select:visible').all()) {
    const box = await element.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
}
test('ordinary production gate is unavailable, with GET-only retry and no seeded identity', async ({ page, request }) => {
  await open(page);
  await expect(inspector(page).getByText('admin.bff_gate_unconfigured', { exact: true })).toBeVisible();
  await noStale(page);
  await inspector(page).getByRole('button', { name: 'Retry module read', exact: true }).click();
  await expect(inspector(page).getByText('admin.bff_gate_unconfigured', { exact: true })).toBeVisible();
  await expect(inspector(page).getByRole('button', { name: 'Kill / re-enable unavailable', exact: true })).toBeDisabled();
  const response = await request.get('/api/kill-switch');
  expect(response.status()).toBe(503);
  expect(await response.json()).toMatchObject({ code: 'admin.bff_gate_unconfigured' });
  await page.screenshot({ path: `${evidence}/ordinary-production.png`, fullPage: true });
});
test('valid zero is observed zero without a service-health or command success claim', async ({ page }) => {
  await fixture(page, envelope(zero));
  await open(page);
  await ready(page);
  await expect(current(page).getByRole('heading', { name: 'Not listed as killed in this snapshot', exact: true })).toBeVisible();
  await expect(inspector(page).getByText('No historical audit for this module was returned.', { exact: true })).toBeVisible();
  await expect(inspector(page).getByRole('button', { name: 'Kill / re-enable unavailable', exact: true })).toBeDisabled();
});
test('original module exact reason/time/actor/confirming operator remain historical and opaque', async ({ page }) => {
  await fixture(page);
  await open(page);
  await ready(page);
  await expect(current(page)).toContainText(nonzero.reasons.trade);
  const history = inspector(page).getByRole('region', { name: 'Historical audit for trade', exact: true });
  await expect(history).toContainText(actor);
  await expect(history).toContainText(confirmer);
  await expect(history.locator('time')).toHaveText(event.at);
  await expect(history).toContainText(reason);
  expect(await page.locator('script').filter({ hasText: 'never execute' }).count()).toBe(0);
  await expect(history).toContainText('No original-operation lookup is available here.');
});
test('state filters never replace an original selection excluded from the list', async ({ page }) => {
  await fixture(page);
  await open(page);
  await ready(page);
  await inspector(page).getByLabel('Show returned state', { exact: true }).selectOption('not-listed');
  await expect(inspector(page).getByRole('button', { name: 'Inspect trade', exact: true })).toHaveCount(0);
  await expect(original(page).getByRole('heading', { name: 'trade', exact: true })).toBeVisible();
  await expect(current(page)).toContainText(nonzero.reasons.trade);
  await inspector(page).getByRole('button', { name: 'Refresh module state', exact: true }).click();
  await ready(page);
  await expect(original(page).getByRole('heading', { name: 'trade', exact: true })).toBeVisible();
});
test('public original ModuleId survives reload, route history and a future tab without private persistence', async ({
  page,
  context,
  observation,
}) => {
  await context.route('**/api/kill-switch', (route) => route.fulfill({ json: envelope(nonzero) }));
  await open(page);
  await ready(page);
  await inspector(page).getByLabel('Inspect module', { exact: true }).selectOption('pay');
  await ready(page);
  await expect(page).toHaveURL(/#module=pay$/);
  await page.reload();
  await ready(page);
  await expect(original(page).getByRole('heading', { name: 'pay', exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'Operator console' }).getByRole('link', { name: 'Launch sequence', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Launch sequence', level: 1 })).toBeVisible();
  await page.goBack();
  await ready(page);
  await expect(original(page).getByRole('heading', { name: 'pay', exact: true })).toBeVisible();
  const future = await context.newPage();
  await open(future, '#module=identity');
  await ready(future);
  await expect(original(future).getByRole('heading', { name: 'identity', exact: true })).toBeVisible();
  expect(observation.future.length).toBe(1);
  expect(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }))).toEqual({ local: {}, session: {} });
});
test('unknown hash cannot invent a module ID', async ({ page }) => {
  await fixture(page);
  await open(page, '#module=invented');
  await ready(page);
  await expect(original(page).getByRole('heading', { name: 'trade', exact: true })).toBeVisible();
});
test('history is bounded and expansion never includes another module or invents a cursor', async ({ page }) => {
  const audit = Array.from({ length: 25 }, (_, i) => ({ ...event, reason: `Isolated returned history ${i}` }));
  audit.push({ ...event, module: 'pay', actor: 'another-module-actor' });
  await fixture(page, envelope({ ...nonzero, audit }));
  await open(page);
  await ready(page);
  await expect(inspector(page).locator('.mi-audit')).toHaveCount(12);
  await inspector(page).getByRole('button', { name: 'Show more returned history', exact: true }).click();
  await expect(inspector(page).locator('.mi-audit')).toHaveCount(24);
  await inspector(page).getByRole('button', { name: 'Show more returned history', exact: true }).click();
  await expect(inspector(page).locator('.mi-audit')).toHaveCount(25);
  await expect(inspector(page).getByText('another-module-actor', { exact: true })).toHaveCount(0);
  await expect(inspector(page).getByRole('button', { name: 'Show more returned history', exact: true })).toHaveCount(0);
});
const malformed = [
  ['absent snapshot', { status: 'reachable', detail: null }],
  ['absent fields', envelope({})],
  ['unknown module', envelope({ ...zero, disabledModules: ['invented'] })],
  ['duplicate module', envelope({ ...zero, disabledModules: ['trade', 'trade'] })],
  ['numeric reason', envelope({ ...zero, reasons: { trade: 123 } })],
  ['unknown reason module', envelope({ ...zero, reasons: { invented: 'Isolated' } })],
  ['malformed audit array', envelope({ ...zero, audit: {} })],
  ['malformed time', envelope({ ...zero, audit: [{ ...event, at: 'yesterday' }] })],
  ['impossible calendar date', envelope({ ...zero, audit: [{ ...event, at: '2026-02-30T09:00:00.000Z' }] })],
  ['non-leap February29', envelope({ ...zero, audit: [{ ...event, at: '2026-02-29T09:00:00.000Z' }] })],
  ['malformed boolean', envelope({ ...zero, audit: [{ ...event, next: 'true' }] })],
  ['inconsistent changed', envelope({ ...zero, audit: [{ ...event, changed: false }] })],
  ['missing actor', envelope({ ...zero, audit: [{ ...event, actor: '' }] })],
  ['malformed confirmer', envelope({ ...zero, audit: [{ ...event, confirmOperatorId: 17 }] })],
  ['wrong envelope status', { ...envelope(zero), status: 'unconfigured' }],
  ['wrong detail type', { ...envelope(zero), detail: 7 }],
];
for (const [name, body] of malformed)
  test(`malformed200 ${name} hides stale state and retries the original module`, async ({ page }) => {
    let invalid = false;
    await page.route('**/api/kill-switch', (route) => route.fulfill({ json: invalid ? body : envelope(nonzero) }));
    await open(page);
    await ready(page);
    invalid = true;
    await inspector(page).getByRole('button', { name: 'Refresh module state', exact: true }).click();
    await expect(inspector(page).getByText('admin.kill_invalid_response', { exact: true })).toBeVisible();
    await noStale(page);
    await expect(original(page).getByRole('heading', { name: 'trade', exact: true })).toBeVisible();
    invalid = false;
    await inspector(page).getByRole('button', { name: 'Retry module read', exact: true }).click();
    await ready(page);
    await expect(current(page)).toContainText(nonzero.reasons.trade);
  });
test('unreadable HTTP200 cannot report an empty live platform', async ({ page }) => {
  await page.route('**/api/kill-switch', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html>Isolated unreadable body</html>' }),
  );
  await open(page);
  await expect(inspector(page).getByText('admin.kill_invalid_response', { exact: true })).toBeVisible();
  await noStale(page);
});
for (const [status, code] of [
  [401, 'admin.bff_gate'],
  [403, 'scope.insufficient'],
  [503, 'admin.bff_gate_unconfigured'],
  [502, 'admin.kill_read_unreachable'],
])
  test(`HTTP${status} ${code} preserves original ID and refusal through GET recovery`, async ({ page }) => {
    let failed = false;
    await page.route('**/api/kill-switch', (route) =>
      route.fulfill({
        status: failed ? status : 200,
        json: failed ? { code, error: 'Isolated authoritative refusal' } : envelope(nonzero),
      }),
    );
    await open(page, '#module=pay');
    await ready(page);
    failed = true;
    await inspector(page).getByRole('button', { name: 'Refresh module state', exact: true }).click();
    await expect(inspector(page).getByText(code, { exact: true })).toBeVisible();
    await expect(inspector(page).getByText(`HTTP ${status}`, { exact: true })).toBeVisible();
    await noStale(page);
    await expect(original(page).getByRole('heading', { name: 'pay', exact: true })).toBeVisible();
    failed = false;
    await inspector(page).getByRole('button', { name: 'Retry module read', exact: true }).click();
    await ready(page);
    await expect(original(page).getByRole('heading', { name: 'pay', exact: true })).toBeVisible();
  });
test('network failure remains unknown and a read retry never becomes a kill replay', async ({ page }) => {
  let failed = true;
  await page.route('**/api/kill-switch', (route) => (failed ? route.abort('failed') : route.fulfill({ json: envelope(nonzero) })));
  await open(page, '#module=trade');
  await expect(inspector(page).getByText('admin.kill_read_unreachable', { exact: true })).toBeVisible();
  await noStale(page);
  failed = false;
  await inspector(page).getByRole('button', { name: 'Retry module read', exact: true }).click();
  await ready(page);
  await expect(inspector(page).getByRole('button', { name: 'Kill / re-enable unavailable', exact: true })).toBeDisabled();
});
test('held refresh hides current and history immediately while retaining original module', async ({ page }) => {
  let held,
    wait = false;
  await page.route('**/api/kill-switch', (route) => (wait ? (held = route) : route.fulfill({ json: envelope(nonzero) })));
  await open(page);
  await ready(page);
  wait = true;
  await inspector(page).getByRole('button', { name: 'Refresh module state', exact: true }).click();
  await expect(inspector(page).getByRole('heading', { name: 'Reading module state', exact: true })).toBeVisible();
  await noStale(page);
  expect(held).toBeTruthy();
  await held.fulfill({ json: envelope(zero) });
  await ready(page);
  await expect(current(page)).toContainText('Not listed as killed in this snapshot');
});
test('late aborted earlier GET cannot replace a newer original selection or state', async ({ page }) => {
  let count = 0,
    old;
  await page.route('**/api/kill-switch', (route) => {
    count++;
    if (count === 2) {
      old = route;
      return;
    }
    return route.fulfill({ json: envelope(count >= 3 ? zero : nonzero) });
  });
  await open(page);
  await ready(page);
  await inspector(page).getByLabel('Inspect module', { exact: true }).selectOption('pay');
  await expect(inspector(page).getByRole('heading', { name: 'Reading module state', exact: true })).toBeVisible();
  expect(old).toBeTruthy();
  await inspector(page).getByLabel('Inspect module', { exact: true }).selectOption('identity');
  await ready(page);
  await expect(original(page).getByRole('heading', { name: 'identity', exact: true })).toBeVisible();
  await old.fulfill({ json: envelope(nonzero) }).catch(() => {});
  await expect(current(page)).toContainText('Not listed as killed in this snapshot');
  await expect(original(page).getByRole('heading', { name: 'identity', exact: true })).toBeVisible();
});
test('registry remains available and native keyboard can preview a flag without a module write', async ({ page }) => {
  await fixture(page);
  await open(page);
  await ready(page);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to operator workspace', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
  await ready(page);
  const summary = page.locator('summary').filter({ hasText: 'Flag registry and session previews' });
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(summary.locator('..')).toHaveAttribute('open', '');
  const registry = summary.locator('..');
  const moduleSwitches = registry.locator('.adm-subhead .adm-switch');
  expect(await moduleSwitches.count()).toBeGreaterThan(0);
  for (const control of await moduleSwitches.all()) await expect(control).toBeDisabled();
  const row = registry.getByRole('row').filter({ has: page.getByRole('cell', { name: 'matching.engine', exact: true }) });
  const preview = row.getByRole('button', { name: 'On Off', exact: true });
  await expect(preview).toHaveAttribute('data-preview', 'true');
  await expect(preview).toBeEnabled();
  const before = await preview.getAttribute('aria-pressed');
  await preview.focus();
  await page.keyboard.press('Space');
  await expect(preview).toHaveAttribute('aria-pressed', before === 'true' ? 'false' : 'true');
  await page.getByRole('button', { name: 'Reset staged flags', exact: true }).click();
  await expect(preview).toHaveAttribute('aria-pressed', before);
  await expect(page.getByText('Flags by module', { exact: true })).toBeVisible();
});
for (const width of [1440, 390, 320])
  test(`exact original module and long historical IDs fit ${width}px with keyboard controls`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await fixture(page);
    await open(page);
    await ready(page);
    await geometry(page, width);
    await expect(inspector(page).locator('.mi-audit dd').nth(0)).toHaveText(actor);
    await expect(inspector(page).locator('.mi-audit dd').nth(1)).toHaveText(confirmer);
    await expect(inspector(page).locator('.mi-audit dd').nth(2)).toHaveText(reason);
    await inspector(page).getByLabel('Inspect module', { exact: true }).focus();
    await expect(inspector(page).getByLabel('Inspect module', { exact: true })).toBeFocused();
    await page.screenshot({ path: `${evidence}/read-history-${width}.png`, fullPage: true });
    const result = await new AxeBuilder({ page }).include('.module-inspector').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(result.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) }))).toEqual([]);
  });

test('valid leap-day offset audit time remains exact in the native historical lane', async ({ page }) => {
  const at = '2024-02-29T09:00:00.000+05:30';
  await fixture(page, envelope({ ...nonzero, audit: [{ ...event, at }] }));
  await open(page);
  await ready(page);
  await expect(inspector(page).locator('.mi-audit time')).toHaveText(at);
  await expect(inspector(page).getByRole('button', { name: 'Kill / re-enable unavailable', exact: true })).toBeDisabled();
});

test('bounded desktop catalogue contains every canonical module and exposes the registry after the detail', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await fixture(page);
  await open(page);
  await ready(page);
  const catalogue = inspector(page).getByRole('region', { name: 'Known modules', exact: true });
  expect(await catalogue.getByRole('button').allTextContents()).toHaveLength(MODULE_IDS.length);
  expect(
    await inspector(page)
      .getByLabel('Inspect module', { exact: true })
      .locator('option')
      .evaluateAll((options) => options.map((option) => option.value)),
  ).toEqual([...MODULE_IDS]);
  for (const id of MODULE_IDS) await expect(catalogue.getByRole('button', { name: `Inspect ${id}`, exact: true })).toHaveCount(1);
  const shape = await catalogue.evaluate((el) => ({
    height: el.getBoundingClientRect().height,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  expect(shape.height).toBeLessThanOrEqual(392);
  expect(shape.scrollHeight).toBeGreaterThan(shape.clientHeight);
  const summary = page.locator('summary').filter({ hasText: 'Flag registry and session previews' });
  const layout = await inspector(page).locator('.mi-layout').boundingBox();
  const discovery = await inspector(page).locator('.mi-discovery').boundingBox();
  const detail = await original(page).boundingBox();
  // The selected detail/history determines this fixture's row, rather than
  // the natural height of all 27 catalogue rows burying the existing tools.
  expect(detail.height).toBeGreaterThanOrEqual(discovery.height);
  expect(Math.abs(layout.height - Math.max(discovery.height, detail.height))).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.y - detail.y)).toBeLessThanOrEqual(1);
  const panel = await inspector(page).boundingBox();
  const registry = await summary.boundingBox();
  const workspaceGap = await summary.evaluate((el) => Number.parseFloat(getComputedStyle(el.parentElement.parentElement).rowGap));
  expect(Number.isFinite(workspaceGap)).toBe(true);
  expect(Math.abs(registry.y - (panel.y + panel.height) - workspaceGap)).toBeLessThanOrEqual(1);
  await writeFile(
    `${evidence}/bounded-catalogue-geometry.json`,
    JSON.stringify({ shape, layout, discovery, detail, panel, registry, workspaceGap }, null, 2),
  );
  await page.screenshot({ path: `${evidence}/bounded-catalogue-desktop.png`, fullPage: true });
  await catalogue.focus();
  await page.keyboard.press('End');
  await expect.poll(() => catalogue.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(1);
  await expect(catalogue.getByRole('button', { name: 'Inspect dex', exact: true })).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(catalogue).toBeFocused();
  await expect(original(page).getByRole('heading', { name: 'trade', exact: true })).toBeVisible();
  await page.screenshot({ path: `${evidence}/bounded-catalogue-keyboard-end.png`, fullPage: true });
  await catalogue.getByRole('button', { name: 'Inspect dex', exact: true }).focus();
  await page.keyboard.press('Enter');
  await ready(page);
  await expect(page).toHaveURL(/#module=dex$/);
  await expect(original(page).getByRole('heading', { name: 'dex', exact: true })).toBeVisible();
  await expect(inspector(page).getByRole('button', { name: 'Kill / re-enable unavailable', exact: true })).toBeDisabled();
});
test('every full native select option still selects its original module without privileged requests', async ({ page }) => {
  await fixture(page, envelope(zero));
  await open(page);
  await ready(page);
  for (const id of MODULE_IDS) {
    await inspector(page).getByLabel('Inspect module', { exact: true }).selectOption(id);
    await ready(page);
    await expect(original(page).getByRole('heading', { name: id, exact: true })).toBeVisible();
  }
});
test('catalogue filtering is bounded while missing selected rows never replace original history', async ({ page }) => {
  await fixture(page);
  await open(page);
  await ready(page);
  const catalogue = inspector(page).getByRole('region', { name: 'Known modules', exact: true });
  await inspector(page).getByLabel('Show returned state', { exact: true }).selectOption('killed');
  await expect(catalogue.getByRole('button')).toHaveCount(1);
  await expect(catalogue).toContainText('trade');
  expect((await catalogue.boundingBox()).height).toBeLessThan(100);
  await inspector(page).getByLabel('Show returned state', { exact: true }).selectOption('not-listed');
  await expect(catalogue.getByRole('button')).toHaveCount(MODULE_IDS.length - 1);
  await expect(original(page).getByRole('heading', { name: 'trade', exact: true })).toBeVisible();
  await expect(inspector(page).locator('.mi-audit')).toContainText(actor);
});
for (const width of [390, 320])
  test(`phone${width} keeps the full selector and hides the desktop catalogue`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await fixture(page);
    await open(page);
    await ready(page);
    await expect(inspector(page).locator('.mi-modules')).toBeHidden();
    await expect(inspector(page).locator('.mi-catalogue-hint')).toBeHidden();
    await expect(inspector(page).getByLabel('Inspect module', { exact: true }).locator('option')).toHaveCount(MODULE_IDS.length);
    await geometry(page, width);
  });
test('ordinary banner names missing deployment facts without claiming usable module or treasury actions', async ({ page }) => {
  await open(page);
  const boundary = page.locator('.mi-console-boundary');
  await expect(boundary.getByText('Module writes unavailable', { exact: true })).toBeVisible();
  await expect(boundary.locator('.mi-boundary-summary')).toContainText('Personal operator session and identity-issued approval');
  const deployment = boundary.locator('.mi-deployment');
  await deployment.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(deployment.locator('.mi-deployment-facts')).toContainText('Deployment configuration does not establish action availability');
  await expect(deployment.locator('.mi-deployment-facts')).toBeVisible();
  await expect(page.locator('.adm-alertstrip')).not.toContainText('Every switch below is inert');
  await page.getByRole('navigation', { name: 'Operator console' }).getByRole('link', { name: 'Ledger ops', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ledger operations', level: 1, exact: true })).toBeVisible();
  await expect(page.getByText('Credential transport', { exact: true })).toBeVisible();
  await expect(
    page
      .getByRole('main')
      .getByText(
        'Ledger freeze and unfreeze retain treasury, live-session, identity-issued approval and original operation guards; configuration alone does not establish those prerequisites.',
        { exact: true },
      ),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Freeze ledger', exact: true })).toBeDisabled();
});

for (const width of [1440, 390])
  test(`full Team parent${width} leads with module state and keeps registry engineering beside its tools`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await fixture(page);
    await open(page);
    await ready(page);
    const navigation = page.getByRole('navigation', { name: 'Operator console', exact: true });
    await expect(navigation.getByRole('link')).toHaveCount(6);
    const room = page.locator('.mi-room-intro');
    await expect(room).toHaveText(
      'Inspect the selected module’s current edge state and historical audit. Module writes remain unavailable.',
    );
    await expect(room).not.toContainText('§11');
    const registry = page.locator('.mi-registry');
    await expect(registry).not.toHaveAttribute('open', '');
    await expect(registry.locator('.mi-registry-intro')).toBeHidden();
    await expect(registry.getByRole('button', { name: 'Reset staged flags', exact: true, includeHidden: true })).toBeHidden();
    const order = await page.evaluate(() => {
      const box = (selector) => {
        const r = document.querySelector(selector).getBoundingClientRect();
        return { y: r.y, bottom: r.bottom };
      };
      return {
        nav: box('.adm-topbar'),
        access: box('.adm-access-notice'),
        boundary: box('.mi-console-boundary'),
        room: box('.mi-room-intro'),
        inspector: box('.module-inspector'),
        registry: box('.mi-registry'),
      };
    });
    expect(order.nav.bottom).toBeLessThanOrEqual(order.access.y);
    expect(order.access.bottom).toBeLessThanOrEqual(order.boundary.y);
    expect(order.boundary.bottom).toBeLessThan(order.room.y);
    expect(order.room.bottom).toBeLessThan(order.inspector.y);
    expect(order.inspector.bottom).toBeLessThan(order.registry.y);
    if (width === 1440) await expect(current(page)).toBeInViewport();
    await geometry(page, width);
    await page.screenshot({ path: `${evidence}/full-team-parent-${width}.png`, fullPage: true });
  });

for (const width of [1440, 390, 320])
  test(`native Deployment configuration${width} opens and closes without replacing original state or granting writes`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await fixture(page);
    await open(page);
    await ready(page);
    const deployment = page.locator('.mi-deployment');
    const summary = deployment.locator('summary');
    const facts = deployment.locator('.mi-deployment-facts');
    await expect(summary).toHaveText('Deployment configuration');
    await expect(facts).toBeHidden();
    expect((await summary.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(deployment).toHaveAttribute('open', '');
    await expect(facts).toBeVisible();
    for (const field of ['EDGE_URL', 'ADMIN_OPERATOR_TOKEN', 'ADMIN_TREASURY_TOKEN', 'ADMIN_BFF_SHARED_SECRET'])
      await expect(facts).toContainText(field);
    await expect(facts).toContainText('configuration alone does not establish those prerequisites');
    await expect(facts).toContainText('Only missing variable names are shown, never credentials');
    const accessibility = await new AxeBuilder({ page }).include('.mi-console-boundary').analyze();
    expect(accessibility.violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await expect(original(page).getByRole('heading', { name: 'trade', exact: true })).toBeVisible();
    await expect(inspector(page).locator('.mi-audit')).toContainText(actor);
    await expect(inspector(page).getByRole('button', { name: 'Kill / re-enable unavailable', exact: true })).toBeDisabled();
    await page.screenshot({ path: `${evidence}/deployment-open-${width}.png`, fullPage: true });
    await page.keyboard.press('Space');
    await expect(deployment).not.toHaveAttribute('open', '');
    await expect(facts).toBeHidden();
    await expect(summary).toBeFocused();
    await expect(original(page).getByRole('heading', { name: 'trade', exact: true })).toBeVisible();
    await expect(inspector(page).locator('.mi-audit')).toContainText(actor);
  });

test('registry disclosure retains original engineering text and Reset next to native session preview tools', async ({ page }) => {
  await fixture(page);
  await open(page);
  await ready(page);
  const registry = page.locator('.mi-registry');
  const summary = registry.locator('summary');
  await summary.focus();
  await page.keyboard.press('Space');
  await expect(registry).toHaveAttribute('open', '');
  const intro = registry.locator('.mi-registry-intro');
  await expect(intro).toContainText('Every flag declared in the registry, grouped by the module that owns it.');
  await expect(intro).toContainText('Resolved at 0 · Tease from the registry.');
  await expect(intro).toContainText('11 of 50');
  await expect(intro).toContainText('§11 launch-plan entries');
  await expect(intro).toContainText('none is enforced from here');
  await expect(intro).toContainText('Per-flag overrides stay session-staged until the flag store lands.');
  await expect(intro.getByRole('button', { name: 'Reset staged flags', exact: true })).toBeVisible();
  const row = registry.getByRole('row').filter({ has: page.getByRole('cell', { name: 'matching.engine', exact: true }) });
  await expect(row.getByRole('button', { name: 'On Off', exact: true })).toBeEnabled();
  await summary.focus();
  await page.keyboard.press('Space');
  await expect(intro).toBeHidden();
  await expect(original(page).getByRole('heading', { name: 'trade', exact: true })).toBeVisible();
  await expect(inspector(page).locator('.mi-audit')).toContainText(actor);
});

test('expanded registry preserves the ledger inspection link and refuses an operational capability claim', async ({ page }) => {
  await fixture(page);
  await open(page);
  await ready(page);
  const summary = page.locator('summary').filter({ hasText: 'Flag registry and session previews' });
  await summary.focus();
  await page.keyboard.press('Enter');
  const registry = summary.locator('..');
  await expect(registry).not.toContainText('the freeze that works');
  await expect(registry).not.toContainText('To halt all value movement use Ledger ops');
  const link = registry.getByRole('link', { name: 'Ledger posting status and freeze prerequisites', exact: true });
  await expect(link).toHaveAttribute('href', '/ledger');
  await link.click();
  await expect(page.getByRole('heading', { name: 'Ledger operations', level: 1, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Freeze ledger', exact: true })).toBeDisabled();
});
