import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir } from 'node:fs/promises';

const HEADINGS = {
  '/': 'Kill-switches',
  '/launch': 'Launch sequence',
  '/jurisdiction': 'Jurisdiction matrix',
  '/ledger': 'Ledger operations',
  '/tools': 'Operator tools',
  '/ops': 'Business operations',
};
async function openJob(page, path) {
  await page.goto(path);
  await expect(page.getByRole('heading', { name: HEADINGS[path], exact: true, level: 1 })).toBeVisible();
  await page.waitForLoadState('networkidle');
}

test('keyboard operators bypass the header and reach a usable narrow navigation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openJob(page, '/launch');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to operator workspace' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
  const routes = page.getByRole('navigation', { name: 'Operator console' }).getByRole('link');
  await expect(routes).toHaveCount(6);
  for (const route of await routes.all()) {
    const box = await route.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
});

test('operators preview a launch drop and type a jurisdiction decision', async ({ page }) => {
  await openJob(page, '/launch');
  // Headless Chromium on macOS does not commit native popup selections from
  // synthesized arrow keys. Keep the native select and use its public seam.
  await page.getByLabel('Preview drop').selectOption('I');
  await expect(page.getByLabel('Preview drop')).toHaveValue('I');
  await expect(page.getByText('Previewing', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Jurisdiction', exact: true }).click();
  await page.getByLabel('Region (ISO-3166 alpha-2)').fill('');
  await page.getByLabel('Region (ISO-3166 alpha-2)').focus();
  await page.keyboard.type('zz');
  await expect(page.getByLabel('Region (ISO-3166 alpha-2)')).toHaveValue('ZZ');
  await page.getByLabel('Module', { exact: true }).selectOption('trade');
  await expect(page.getByRole('heading', { name: 'Live decision — checkAccess()' })).toBeVisible();
});

test('ledger, tools and Ops failures stay explicit and cannot issue unconfigured commands', async ({ page, request }) => {
  await page.goto('/ledger');
  await expect(page.getByRole('button', { name: 'Freeze ledger', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Unfreeze ledger', exact: true })).toBeDisabled();
  await expect(page.getByText('UNKNOWN', { exact: true }).first()).toBeVisible();
  await page.goto('/tools');
  await page.getByRole('button', { name: 'Refresh wire status' }).click();
  await expect(page.getByText(/Load error:/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Invoke', exact: true })).toHaveCount(0);
  await page.goto('/ops');
  await expect(page.getByRole('heading', { name: 'Read unavailable' })).toHaveCount(0);
  await expect(page.getByText('Read unavailable', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create record' })).toBeDisabled();
  const response = await request.get('/api/business-ops?view=contacts&limit=50');
  expect(response.status()).toBe(503);
  expect(await response.json()).toMatchObject({ code: 'admin.bff_gate_unconfigured' });
});

test('Ops rejects malformed read projections and retains an uncertain create across reload', async ({ page }) => {
  let posts = 0;
  await page.route('**/api/business-ops**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'POST') {
      posts++;
      expect(request.postDataJSON()).toEqual({
        operation: 'projects.create',
        input: { title: 'Test-only project' },
        acknowledged: true,
        confirmation: 'CREATE projects.create',
      });
      return route.fulfill({ status: 502, json: { ok: false, status: 502, code: 'admin.ops_network_unavailable', uncertain: true } });
    }
    if (url.searchParams.get('view') === 'authority')
      return route.fulfill({
        json: { ok: true, status: 200, authority: { readConfigured: true, writeConfigured: true, missingRead: [], missingWrite: [] } },
      });
    if (url.searchParams.get('view') === 'contacts')
      return route.fulfill({
        json: { ok: true, status: 200, data: { contacts: [], identity: { status: 'absent' }, support: { status: 'absent' } } },
      });
    if (url.searchParams.get('view') === 'fundraising')
      return route.fulfill({
        json: { ok: true, status: 200, data: { raises: [{ id: 'test-only-raise', name: 'Test-only raise', targetAmount: 123 }] } },
      });
    return route.fulfill({ json: { ok: true, status: 200, data: { projects: [] } } });
  });
  await page.goto('/ops');
  await page.getByRole('button', { name: 'Fundraising', exact: true }).click();
  await expect(page.getByText('admin.ops_invalid_response', { exact: true })).toBeVisible();
  await expect(page.getByText('Test-only raise', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByLabel('Project title').fill('Test-only project');
  await page.getByLabel(/I reviewed this new service record/).check();
  await expect(page.getByRole('button', { name: 'Create record' })).toBeDisabled();
  await page.getByLabel('Type CREATE projects.create to confirm').fill('CREATE projects.create');
  await page.getByRole('button', { name: 'Create record' }).click();
  await expect(page.getByText('Command outcome unresolved', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Create record' })).toBeDisabled();
  expect(posts).toBe(1);
});

test('all operator jobs fit desktop, tablet and narrow phones with readable controls', async ({ page }) => {
  const proof = '/Users/Nitro/Desktop/intafaced-interface-overview/named-look/build/team-proof';
  await mkdir(proof, { recursive: true });
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ['/', '/launch', '/jurisdiction', '/ledger', '/tools', '/ops']) {
      await openJob(page, path);
      await expect(page.getByRole('main')).toBeVisible();
      if (path === '/ops') await expect(page.getByText('Read unavailable', { exact: true })).toBeVisible();
      const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(documentWidth, `${path} at ${width}px`).toBeLessThanOrEqual(width);
      if (width === 1440 || width === 390)
        await page.screenshot({ path: `${proof}/${path === '/' ? 'kill-switches' : path.slice(1)}-${width}.png` });
    }
  }
});

test('operator screens meet accessible names, contrast and scroll access', async ({ page }) => {
  for (const path of ['/', '/launch', '/jurisdiction', '/ledger', '/tools', '/ops']) {
    await page.setViewportSize({ width: 390, height: 844 });
    await openJob(page, path);
    if (path === '/ops') await expect(page.getByText('Read unavailable', { exact: true })).toBeVisible();
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(
      result.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
      path,
    ).toEqual([]);
  }
});
