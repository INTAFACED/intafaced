// Shared by shoot.mjs and crawl.mjs: a throwaway dev server on a port this work owns, a headless browser with a
// throwaway profile, and a signed-in page talking to the stand-in. Every figure is TEST data.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { board as money } from '../money/board.mjs';
import { board as payments } from '../payments/board.mjs';
import { board as settings } from '../settings/board.mjs';
import { USER_ID, createPortalMock } from '../portal.mock.mjs';

/** Ports this work may use. 4400, 4401, 4620, 4621, 4656 and 4657 belong to other people and are never touched. */
export const ALLOWED_PORTS = [4658, 4659, 4660, 4661, 4662];
export const repoRoot = fileURLToPath(new URL('../../../../../../..', import.meta.url));
export const packages = { money, payments, settings };

export function assertPort(port) {
  if (!ALLOWED_PORTS.includes(port)) throw new Error(`Port ${port} is not one of ${ALLOWED_PORTS.join(', ')}`);
}

/** Starts the customer app's dev server. `stop()` ends only the process started here, by its PID. */
export async function startServer(port) {
  assertPort(port);
  const child = spawn(
    'pnpm',
    ['--filter', '@intafaced/customer', 'exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    {
      cwd: repoRoot,
      stdio: 'ignore',
      detached: true,
    },
  );
  const url = `http://127.0.0.1:${port}`;
  const started = Date.now();
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() - started > 240_000) {
      stopChild(child);
      throw new Error(`The dev server did not come up on ${url}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { url, stop: () => stopChild(child) };
}
function stopChild(child) {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
}

/** The newest chrome-headless-shell Playwright has downloaded, for when the build this package wants is not on the machine. */
function installedHeadlessShell() {
  const root = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  if (!existsSync(root)) return undefined;
  const found = readdirSync(root)
    .filter((name) => name.startsWith('chromium_headless_shell-'))
    .sort()
    .reverse()
    .map((name) => join(root, name, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'))
    .find((path) => existsSync(path));
  return found;
}

export async function launch() {
  // Playwright's headless shell with a throwaway profile; the daily browser is never opened.
  const executablePath = process.env.PORTAL_CHROMIUM ?? installedHeadlessShell();
  return chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
}

const session = { userId: USER_ID, accessToken: 'board-test-only', refreshToken: 'board-test-only', expiresAt: '2099-10-08T00:00:00Z' };
const reply = (route, data) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data } }) });

/** A signed-in page. `who` is 'owner' (default), 'payfac', 'finance', 'viewer', or 'none' (signed in, no business account). */
export async function openPortal(browser, baseUrl, { who = 'owner', scenario = 'active', width = 1440, height = 900 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, baseURL: baseUrl });
  const page = await context.newPage();
  await page.route('**/api/**', (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Unavailable' }) }),
  );
  await page.route('**/api/identity/trpc/auth.login', (route) => reply(route, session));
  await page.route('**/api/identity/trpc/webauthn.list?*', (route) => reply(route, []));
  const mock = createPortalMock(
    who === 'none' ? 'new' : scenario,
    who === 'owner' ? {} : who === 'payfac' ? { myAccess: 'payfac' } : { myAccess: who, role: who },
  );
  await mock.install(page);
  await page.goto('/login?redirect=%2Fpay%2Fmerchant');
  await page.getByLabel('Email or handle', { exact: true }).fill('board@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('board-test-only');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/pay/merchant');
  return { page, mock, context };
}

/** In-app navigation keeps the in-memory sign-in; a reload would drop it. */
export async function go(page, path) {
  await page.evaluate((to) => {
    history.pushState(null, '', to);
    dispatchEvent(new PopStateEvent('popstate'));
  }, path);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(250);
}

/** Every board row as { pkg, id, title, path, phone, who }. */
export function allRoutes() {
  return Object.entries(packages).flatMap(([pkg, rows]) =>
    rows.map(([id, title, path, phone, who]) => ({ pkg, id, title, path, phone: Boolean(phone), who: who ?? 'owner' })),
  );
}
export function parseArgs(argv) {
  const out = { port: 4658, only: null };
  for (const arg of argv) {
    if (arg.startsWith('--port=')) out.port = Number(arg.slice(7));
    else if (arg.startsWith('--only=')) out.only = arg.slice(7).split(',');
    else if (arg.startsWith('--out=')) out.out = arg.slice(6);
  }
  assertPort(out.port);
  return out;
}
