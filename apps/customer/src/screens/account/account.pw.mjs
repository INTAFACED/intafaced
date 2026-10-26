import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiKeys, failure, kyc, kycRecord, passkeys, perks, rank, sessions, trpc } from './account.fixtures.mjs';

const shots = process.env.ACCOUNT_SHOTS ?? join(tmpdir(), 'intafaced-account-shots');
mkdirSync(shots, { recursive: true });

const forbidden =
  /unavailable|not connected|restricted|fixture|lifecycle|\bspaces?\b|\broom\b|\bledger\b|\btier\b|partition|identity service/i;
const preferenceKey = 'intafaced.customer.view.v1';

const defaults = {
  'rank.get': () => rank(),
  'rank.perks': () => perks(),
  'subAccounts.list': () => [],
  me: () => ({ userId: '00000000-0000-4000-8000-000000000001', handle: 'test_friend' }),
  'webauthn.list': () => passkeys(),
  listSessions: () => sessions(),
  'kyc.status': () => kyc('basic', [kycRecord()]),
  'apiKeys.list': () => apiKeys(),
};

/**
 * Answer the identity calls (/api/identity/trpc/<procedure>) the screen makes. An override is a function of the
 * request input, `null` to hold the request until `release()`, 'refuse' for a 503, or a plain value. No service is contacted.
 */
async function mock(page, overrides = {}) {
  const served = { ...defaults, ...overrides };
  const held = [];
  const seen = [];
  await page.route('**/api/identity/trpc/**', async (route) => {
    const url = new URL(route.request().url());
    const procedure = decodeURIComponent(url.pathname.split('/trpc/')[1]);
    const input = url.searchParams.get('input') ? JSON.parse(url.searchParams.get('input')) : undefined;
    seen.push({ procedure, input, method: route.request().method() });
    if (!(procedure in served)) return route.fulfill({ status: 404, json: { error: { message: 'not mocked' } } });
    const value = served[procedure];
    if (value === null) return void held.push({ route, procedure, input });
    if (value === 'refuse') return route.fulfill({ status: failure.status, json: failure.json });
    return route.fulfill({ status: 200, json: trpc(typeof value === 'function' ? value(input) : value) });
  });
  return {
    seen,
    calls: (procedure) => seen.filter((call) => call.procedure === procedure),
    release: async () => {
      for (const { route, procedure, input } of held.splice(0)) {
        const value = defaults[procedure];
        await route.fulfill({ status: 200, json: trpc(value(input)) });
      }
    },
  };
}

const open = async (page, path) => {
  await page.goto(path);
  await page.getByTestId('acct').waitFor();
};
const snap = async (page, name) => {
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
};
async function shootBoth(page, name) {
  for (const size of [
    { width: 1440, height: 900 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(size);
    await snap(page, `${name}-${size.width}x${size.height}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}
const watch = (page) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
};
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test('layout: 220 px sub-nav, 760 px content, current link marked, links stay on live screens', async ({ page }) => {
  const errors = watch(page);
  await mock(page);
  await open(page, '/uc/account');
  const nav = page.getByTestId('acct-nav');
  expect(Math.round((await nav.boundingBox()).width)).toBe(220);
  expect(Math.round((await page.getByTestId('acct-body').boundingBox()).width)).toBe(760);
  const links = page.getByTestId('acct-nav').locator('a');
  expect(await links.allTextContents()).toEqual(['Account', 'Security', 'Verification', 'Display']);
  expect(await links.evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().height)))).toEqual([
    40, 40, 40, 40,
  ]);
  expect(await links.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')))).toEqual([
    '/uc/account',
    '/uc/safe',
    '/verification',
    '/view',
  ]);
  await expect(page.getByTestId('acct-nav').locator('a[aria-current="page"]')).toHaveText('Account');
  // Walking the sub-nav changes the content and the marked link without a reload.
  await links.nth(1).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Security' })).toBeVisible();
  await expect(page.getByTestId('acct-nav').locator('a[aria-current="page"]')).toHaveText('Security');
  await links.nth(3).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Display' })).toBeVisible();
  await expect(page.getByTestId('acct-nav').locator('a[aria-current="page"]')).toHaveText('Display');
  expect(await noOverflow(page)).toBe(true);
  expect(errors).toEqual([]);
});

test('account: ID in mono with Copy, rank card, no old cross-links, plain words', async ({ page, context }) => {
  const errors = watch(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await mock(page);
  await open(page, '/uc/account');
  const handle = page.locator('section[aria-label="Handle"]');
  await expect(handle).toContainText('@test_friend');
  const id = page.locator('section[aria-label="Account ID"]');
  await expect(id).toContainText('Account ID');
  await expect(id.getByTestId('subaccounts__ref')).toHaveText('00000000-0000-4000-8000-000000000001');
  expect(await id.getByTestId('subaccounts__ref').evaluate((node) => getComputedStyle(node).fontFamily)).toMatch(/mono/i);
  await id.getByRole('button', { name: 'Copy account ID' }).click();
  await expect(id.getByRole('button', { name: 'Copy account ID' })).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('00000000-0000-4000-8000-000000000001');
  await expect(page.getByTestId('rank-perks')).toContainText('Rank 2');
  // Perks of hidden features and the strategy subaccounts are not shown; the fee discount reads as a percent.
  await expect(page.getByTestId('rank-perks')).toContainText('Trading fee discount');
  await expect(page.getByTestId('rank-perks')).toContainText('0.5%');
  await expect(page.getByTestId('rank-perks')).not.toContainText(/Card level|Copy follower cap|Lobby host|OTC access|Launchpad|P2P limit/);
  await expect(page.locator('[data-testid="subaccounts__list"], [data-testid="subaccounts__create"]')).toHaveCount(0);
  expect(
    await page.locator('[data-testid="acct-body"] a[href="/uc/safe"], [data-testid="acct-body"] a[href="/verification"]').count(),
  ).toBe(0);
  expect(await page.getByTestId('acct').innerText()).not.toMatch(forbidden);
  await shootBoth(page, 'account-loaded');
  expect(errors).toEqual([]);
});

test('account: loading, error and empty states sit inside their cards', async ({ page }) => {
  const errors = watch(page);
  const api = await mock(page, { 'rank.get': null });
  await open(page, '/uc/account');
  await expect(page.getByTestId('rank-perks')).toContainText('Loading your rank');
  await shootBoth(page, 'account-loading');
  await api.release();
  await expect(page.getByTestId('rank-perks')).toContainText('Rank 2');
  // Strategy subaccounts are a hidden feature, so there is no empty list to show.
  await expect(page.getByTestId('subaccounts__list')).toHaveCount(0);
  await shootBoth(page, 'account-empty');
  // Error: the rank read fails; the rest of the page still works.
  const failed = await page.context().newPage();
  await mock(failed, { 'rank.get': 'refuse' });
  await failed.goto('/uc/account');
  await failed.getByTestId('acct').waitFor();
  await expect(failed.getByTestId('rank-perks')).toContainText('Couldn’t read your rank');
  await expect(failed.locator('section[aria-label="Account ID"]')).toContainText('Account ID');
  await shootBoth(failed, 'account-error');
  expect(errors).toEqual([]);
});

test('security: passkeys visible, sessions with Sign out, Sign out everywhere, no empty two-factor status line', async ({ page }) => {
  const errors = watch(page);
  await mock(page);
  await open(page, '/uc/safe');
  const keys = page.getByRole('region', { name: 'Passkeys', exact: true });
  await expect(keys.getByRole('button', { name: 'Add passkey', exact: true })).toBeVisible();
  await expect(keys).toContainText('Added');
  await expect(keys.getByRole('button', { name: /^Remove passkey / })).toHaveCount(1);
  const seats = page.getByRole('region', { name: 'Where you’re signed in', exact: true });
  await expect(seats.getByRole('button', { name: /^Sign out session / })).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Sign out everywhere', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Authenticator app', exact: true })).toBeVisible();
  await expect(page.getByTestId('acct')).not.toContainText('Status is not available here');
  expect(await page.getByTestId('acct').innerText()).not.toMatch(forbidden);
  // Raw session and passkey codes are not drawn on screen (they stay in the accessible names).
  const visibleIds = await page
    .locator('[data-testid="identity-sessions__ref"], [data-testid="security__rows"] [data-testid="security__ref"]')
    .evaluateAll((nodes) => nodes.filter((node) => node.getBoundingClientRect().width > 2).length);
  expect(visibleIds).toBe(0);
  await shootBoth(page, 'security-loaded');
  // Per-session sign-out asks first.
  await seats.getByRole('button', { name: /^Sign out session 1111/ }).click();
  await expect(page.getByRole('dialog')).toContainText('Sign out this session?');
  await page.getByRole('dialog').getByRole('button', { name: 'Sign out this session' }).waitFor();
  await snap(page, 'security-dialog');
  expect(errors).toEqual([]);
});

test('security: empty and error states', async ({ page }) => {
  const errors = watch(page);
  await mock(page, {
    'webauthn.list': () => [],
    listSessions: () => ({ userId: '00000000-0000-4000-8000-000000000001', sessions: [] }),
    'apiKeys.list': () => [],
  });
  await open(page, '/uc/safe');
  const keys = page.getByRole('region', { name: 'Passkeys', exact: true });
  await expect(keys).toContainText('No passkeys yet');
  await expect(keys.getByRole('button', { name: 'Add passkey', exact: true })).toBeVisible();
  await expect(page.getByTestId('identity-sessions')).toContainText('No active sessions');
  await shootBoth(page, 'security-empty');
  const failed = await page.context().newPage();
  await mock(failed, { 'webauthn.list': 'refuse', listSessions: 'refuse' });
  await failed.goto('/uc/safe');
  await failed.getByTestId('acct').waitFor();
  await expect(
    failed.getByRole('region', { name: 'Passkeys', exact: true }).getByRole('button', { name: /try again|retry/i }),
  ).toBeVisible();
  await shootBoth(failed, 'security-error');
  expect(errors).toEqual([]);
});

test('security: loading state', async ({ page }) => {
  const api = await mock(page, { 'webauthn.list': null, listSessions: null });
  await open(page, '/uc/safe');
  await expect(page.getByRole('region', { name: 'Passkeys', exact: true })).toBeVisible();
  await shootBoth(page, 'security-loading');
  await api.release();
  await expect(page.getByRole('region', { name: 'Passkeys', exact: true })).toContainText('Added');
});

for (const [tier, tag, status] of [
  ['none', 'Not verified', 'working'],
  ['basic', 'Basic', 'filled'],
  ['full', 'Full', 'filled'],
]) {
  test(`verification: level "${tag}" as a big tag, then the request form, in plain words`, async ({ page }) => {
    const errors = watch(page);
    await mock(page, { 'kyc.status': () => kyc(tier, tier === 'none' ? [] : [kycRecord()]) });
    await open(page, '/verification');
    const level = page.locator('[data-slot="status-tag"].verification__level-tag');
    await expect(level).toHaveText(tag);
    await expect(level).toHaveAttribute('data-status', status);
    expect(Math.round((await level.boundingBox()).height)).toBe(40);
    // Order: level, then the request form, then the requests.
    const top = async (selector) => Math.round((await page.locator(selector).boundingBox()).y);
    const [tierTop, formTop, recordsTop] = [
      await top('[data-testid="verification__tier"]'),
      await top('[data-testid="verification__request"]'),
      await top('[data-testid="verification__records"]'),
    ];
    expect(tierTop).toBeLessThan(formTop);
    expect(formTop).toBeLessThan(recordsTop);
    await expect(page.getByTestId('verification__request')).toContainText(
      'Sending this asks for a review. It doesn’t change your level unless it’s approved.',
    );
    await expect(page.getByTestId('acct')).not.toContainText('Submitting does not approve');
    // Only levels above the current one can be asked for, and the orphan "Read current records" button is gone.
    const asks = { none: ['Basic', 'Full', 'Institutional'], basic: ['Full', 'Institutional'], full: ['Institutional'] };
    expect(await page.getByTestId('verification__request').locator('select option').allTextContents()).toEqual(asks[tier]);
    await expect(page.getByRole('button', { name: 'Read current records' })).toHaveCount(0);
    await expect(page.getByTestId('verification__request').locator('a[data-testid="text-link"]')).toHaveAttribute('href', '/support');
    expect(await page.getByTestId('acct').innerText()).not.toMatch(forbidden);
    await shootBoth(page, `verification-${tier}`);
    expect(errors).toEqual([]);
  });
}

test('verification: empty and error states', async ({ page }) => {
  await mock(page, { 'kyc.status': () => kyc('none', []) });
  await open(page, '/verification');
  await expect(page.getByTestId('verification__records')).toContainText('No requests yet');
  await shootBoth(page, 'verification-empty');
  const failed = await page.context().newPage();
  await mock(failed, { 'kyc.status': 'refuse' });
  await failed.goto('/verification');
  await failed.getByTestId('acct').waitFor();
  await expect(failed.getByTestId('verification__list')).toContainText(/Couldn.t|can.t|try again/i);
  await shootBoth(failed, 'verification-error');
});

test('verification: loading state', async ({ page }) => {
  const api = await mock(page, { 'kyc.status': null });
  await open(page, '/verification');
  await shootBoth(page, 'verification-loading');
  await api.release();
  await expect(page.getByTestId('verification__level-tag')).toHaveText('Basic');
});

test('display: dark only, six choices that save to this device, no internal words', async ({ page }) => {
  const errors = watch(page);
  await mock(page);
  await open(page, '/view');
  const body = page.getByTestId('acct-body');
  await expect(body.getByRole('heading', { level: 1, name: 'Display' })).toBeVisible();
  // Dark only: no theme choice at all.
  await expect(body.getByLabel('Theme')).toHaveCount(0);
  await expect(body).not.toContainText('Light');
  await expect(body).not.toContainText('Match device');
  // Settings that change nothing in the new screens are not offered.
  await expect(body).not.toContainText(
    /Display currency|Chart on phone|Daily chart|working orders|old fills|confirm before|Favorites view/i,
  );
  // Only languages with written copy are a real choice.
  expect(await body.getByRole('combobox', { name: 'Language', exact: true }).locator('option').count()).toBeLessThanOrEqual(4);
  // The six choices.
  const language = body.getByRole('combobox', { name: 'Language', exact: true });
  const upColour = body.getByRole('combobox', { name: 'Up colour', exact: true });
  const mode = body.getByRole('group', { name: 'Default view', exact: true });
  const hide = body.getByRole('checkbox', { name: 'Hide balance values', exact: true });
  const zone = body.getByRole('combobox', { name: 'Time zone', exact: true });
  for (const control of [language, upColour, mode, hide, zone]) await expect(control).toBeVisible();
  await upColour.selectOption('red');
  await mode.getByRole('button', { name: 'Pro', exact: true }).click();
  await hide.check();
  await zone.selectOption('UTC+8');
  const saved = JSON.parse(await page.evaluate((key) => localStorage.getItem(key), preferenceKey));
  expect(saved).toMatchObject({ upColor: 'red', layoutMode: 'pro', hideBalances: true, timeZone: 'UTC+8', theme: 'dark' });
  expect(await body.innerText()).not.toMatch(forbidden);
  await shootBoth(page, 'display-loaded');
  await body.getByRole('button', { name: 'Restore defaults' }).click();
  const restored = JSON.parse(await page.evaluate((key) => localStorage.getItem(key), preferenceKey));
  expect(restored).toMatchObject({ upColor: 'green', layoutMode: 'pro', hideBalances: false, theme: 'dark' });
  expect(errors).toEqual([]);
});

test('keyboard: Tab reaches the sub-nav links first and the focus ring shows', async ({ page }) => {
  await mock(page);
  await open(page, '/uc/safe');
  await page.locator('[data-testid="harness-bar"] a').last().focus();
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => ({
    text: document.activeElement?.textContent,
    outline: getComputedStyle(document.activeElement).outlineStyle,
  }));
  expect(focused.text).toBe('Account');
  expect(focused.outline).toBe('solid');
});
