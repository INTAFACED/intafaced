/**
 * Pass 3 — auth fixture + S5/S7 empty-vs-error on account surface.
 * Runs only when browsers can launch (outside agent SEGV sandbox → launchd).
 */
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  bootShell,
  establishAuth,
  installAuth,
  navigateAuthed,
  mockWalletAndOrdersEmpty,
  mockWalletAndOrdersDown,
} from './auth-fixture.mjs';

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();
const ARTIFACTS = join(REPO_ROOT, '.artifacts', 'uiproof');
const SHOTS = join(ARTIFACTS, 'shots-auth');
mkdirSync(SHOTS, { recursive: true });

const ERROR_SNIPPETS = [/Account services did not respond/i, /unknown, not zero/i, /Wallet service did not respond/i, /are unknown/i];

function accountState(page) {
  return page.locator('.ix-terminal').evaluate((terminal) => ({
    loading: terminal.__vue__.accountLoading,
    walletReachable: terminal.__vue__.walletReachable,
    ordersReachable: terminal.__vue__.ordersReachable,
    accountError: terminal.__vue__.accountError,
  }));
}

async function reloadAccount(page) {
  await page.locator('.ix-terminal').evaluate(async (terminal) => {
    await terminal.__vue__.$nextTick();
    await terminal.__vue__.loadAccount();
    await terminal.__vue__.$nextTick();
  });
}

test.describe('Pass 3 auth fixture', () => {
  test('logged-in /uc/account is reachable (not login gate)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installAuth(page);
    await navigateAuthed(page, '/uc/account');

    const url = page.url();
    expect(url, `should stay in member center; url=${url}`).not.toMatch(/\/login(?:\/|$|\?)/);

    const body = (await page.locator('body').innerText()).trim();
    expect(body.length, 'member center should render content').toBeGreaterThan(20);
    await expect(page.getByText('uipr…').first()).toBeVisible();
    expect(
      await page.evaluate(() => ({ token: localStorage.getItem('TOKEN'), member: localStorage.getItem('MEMBER') })),
      'sign-in lives in memory plus the HttpOnly refresh cookie: no token or member key in localStorage',
    ).toEqual({ token: null, member: null });

    await page.screenshot({
      path: join(SHOTS, 'uc-account__authed-desktop.png'),
      fullPage: true,
    });
  });

  test('S5/S7 error: wallet+orders down → unknown, not zero', async ({ page }) => {
    await mockWalletAndOrdersDown(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await bootShell(page, '/exchange/btc_usdt');
    await establishAuth(page);
    await reloadAccount(page);
    await expect
      .poll(() => accountState(page), { message: 'failed account reads must settle as unavailable' })
      .toMatchObject({ loading: false, walletReachable: false, ordersReachable: false });
    await expect(page.locator('.ix-account')).toContainText(/unknown/i);

    const body = await page.locator('body').innerText();
    const hits = ERROR_SNIPPETS.some((re) => re.test(body));
    expect(hits, `logged-in account pane must name unknown/error when services down; body snippet: ${body.slice(0, 400)}`).toBeTruthy();

    // Must not sell a full account strip as empty success with no error language.
    expect(body).not.toMatch(/Nothing here yet/);

    await page.screenshot({
      path: join(SHOTS, 'exchange__wallet-error-desktop.png'),
      fullPage: true,
    });
  });

  test('S5/S7 empty: wallet+orders reachable empty → not the error copy', async ({ page }) => {
    await mockWalletAndOrdersEmpty(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await bootShell(page, '/exchange/btc_usdt');
    await establishAuth(page);
    await reloadAccount(page);
    await expect
      .poll(() => accountState(page), { message: 'successful empty account reads must settle as reachable' })
      .toMatchObject({ loading: false, walletReachable: true, ordersReachable: true, accountError: '' });
    await expect(page.locator('.ix-account')).toContainText(/The ledger holds no balance for this account yet/i);

    const body = await page.locator('body').innerText();

    // Error/unknown copy must not appear when services answered with empty data.
    expect(body).not.toMatch(/Account services did not respond/i);
    expect(body).not.toMatch(/Wallet service did not respond/i);
    expect(body).not.toMatch(/are unknown, not zero/i);

    // Honest empty (zero balance display is OK when reachable) or empty-tab copy.
    const emptyOk = /The ledger holds no balance for this account yet/i.test(body);
    expect(emptyOk, `empty reachable account should show zero/empty UI; snippet: ${body.slice(0, 400)}`).toBeTruthy();

    await page.screenshot({
      path: join(SHOTS, 'exchange__wallet-empty-desktop.png'),
      fullPage: true,
    });
  });
});
