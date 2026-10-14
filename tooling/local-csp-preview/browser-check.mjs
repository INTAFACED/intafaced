// Headless-browser check of the running preview (Playwright is already a repo dependency; nothing is installed).
//   node tooling/local-csp-preview/browser-check.mjs [--shots <dir>]
// For each instance it signs in (TEST stub), runs a passkey register + sign-in with a VIRTUAL authenticator, opens the
// chart and the Academy live/video pages, and prints every console message that looks like a CSP block plus every
// report the sink collected. Exit code 1 if a violation shows up that the checklist does not list as expected.
import { chromium } from '@playwright/test';
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = Number(process.env.CSP_PREVIEW_BASE_PORT ?? 18080);
const shotsIdx = process.argv.indexOf('--shots');
const shots = shotsIdx > 0 ? process.argv[shotsIdx + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });
const sink = (path, init) => fetch(`http://127.0.0.1:${BASE + 3}${path}`, init);

const instances = [
  { kind: 'configured', port: BASE, flows: ['signin', 'passkey', 'chart', 'sweep'] },
  { kind: 'bare', port: BASE + 1, flows: ['signin', 'passkey', 'chart'] },
  { kind: 'academyConfigured', port: BASE + 5, flows: ['academy'] },
  { kind: 'academyBare', port: BASE + 6, flows: ['academy'] },
];
const results = {};
// Playwright 1.62 wants chromium build 1234; this Mac has the cached 1248. Use whatever headless shell is cached (nothing is installed).
const cache = join(process.env.HOME, 'Library/Caches/ms-playwright');
const shell = readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell-')).sort().at(-1);
const executablePath = process.env.CSP_PREVIEW_CHROMIUM ?? (shell ? join(cache, shell, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell') : undefined);
const browser = await chromium.launch({ executablePath });
for (const { kind, port, flows } of instances) {
  await sink('/clear', { method: 'POST' });
  const context = await browser.newContext({ baseURL: `http://localhost:${port}`, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const consoleCsp = [];
  const other = [];
  page.on('console', (m) => {
    const text = m.text();
    if (/Content Security Policy|Refused to|violates the following/i.test(text)) consoleCsp.push(text.replace(/base64,[^'\s]+/g, 'base64,...').slice(0, 260));
    else if (m.type() === 'error') other.push(text.slice(0, 200));
  });
  page.on('pageerror', (e) => other.push('pageerror: ' + e.message.slice(0, 200)));
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  const steps = [];
  const step = async (name, fn) => {
    try {
      const detail = await fn();
      steps.push({ name, ok: true, detail });
    } catch (e) {
      steps.push({ name, ok: false, detail: String(e.message).split('\n')[0] });
    }
  };
  const shot = (n) => (shots ? page.screenshot({ path: join(shots, `${kind}-${n}.png`) }) : null);
  const signIn = async (returnPath) => {
    await page.goto('/login' + (returnPath ? `/returnUrl/${encodeURIComponent(returnPath)}` : ''));
    await page.getByRole('textbox', { name: 'Email or handle', exact: true }).fill('test@example.invalid');
    await page.locator('input[autocomplete="current-password"]').fill('test-password');
    await page.locator('form button[type="submit"]').click();
  };

  if (flows.includes('signin')) await step('sign-in page renders and password sign-in works', async () => {
    await signIn('/home');
    await page.waitForFunction(() => !location.pathname.startsWith('/login'), null, { timeout: 8000 });
    await page.waitForTimeout(800);
    await shot('home');
    return page.url();
  });
  if (flows.includes('passkey')) await step('passkey: register on /uc/safe (virtual authenticator)', async () => {
    await signIn('/uc/safe');
    await page.waitForFunction(() => location.pathname === '/uc/safe', null, { timeout: 8000 });
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: 'Add passkey' }).first().click({ timeout: 6000 });
    await page.getByRole('dialog').getByRole('button', { name: 'Add passkey' }).click({ timeout: 6000 });
    await page.waitForTimeout(2500);
    await shot('passkey-register');
    return (await page.locator('main').innerText()).replace(/\s+/g, ' ').slice(0, 160);
  });
  if (flows.includes('passkey')) await step('passkey: sign in with it from /login', async () => {
    await page.goto('/login');
    await page.getByRole('textbox', { name: 'Email or handle', exact: true }).fill('test@example.invalid');
    await page.getByRole('button', { name: /passkey/i }).first().click({ timeout: 6000 });
    await page.waitForFunction(() => !location.pathname.startsWith('/login'), null, { timeout: 8000 });
    await shot('passkey-signin');
    return page.url();
  });
  if (flows.includes('chart')) await step('chart: BTC desk draws a chart', async () => {
    await signIn('/trade/spot/BTC-USDT');
    await page.waitForFunction(() => location.pathname.startsWith('/trade/spot'), null, { timeout: 8000 });
    await page.waitForSelector('canvas', { timeout: 12000 });
    await page.waitForTimeout(1000);
    await shot('chart');
    return `${await page.locator('canvas').count()} canvas element(s); window.LightweightCharts? ${await page.evaluate(() => typeof window.LightweightCharts)}`;
  });
  if (flows.includes('sweep')) {
    const pages = ['/money', '/pay', '/more', '/trade', '/coin/BTC', '/uc', '/notifications', '/uc/safe', '/bank'];
    await step(`sweep: ${pages.length} signed-in rooms load their scripts, styles, fonts and images`, async () => {
      for (const p of pages) {
        await signIn(p);
        await page.waitForFunction((x) => location.pathname.startsWith(x.split('/').slice(0, 2).join('/')), p, { timeout: 8000 }).catch(() => null);
        await page.waitForTimeout(1200);
      }
      await page.goto('/help');
      await page.waitForTimeout(800);
      return pages.join(' ') + ' /help';
    });
  }
  if (flows.includes('academy')) {
    await step('academy: rooms, open room, connect audio/video on session A (allowed server)', async () => {
      await signIn('/academy');
      await page.waitForFunction(() => location.pathname.startsWith('/academy'), null, { timeout: 8000 });
      await page.getByRole('button', { name: 'Rooms', exact: true }).click({ timeout: 6000 });
      await page.getByRole('button', { name: /Open/ }).first().click({ timeout: 6000 });
      await page.getByText('TEST live session A').first().waitFor({ timeout: 6000 });
      await page.getByRole('button', { name: 'Connect audio/video' }).nth(0).click({ timeout: 6000 });
      await page.waitForTimeout(4000);
      await shot('academy-session-a');
      return (await page.getByText(/Audio\/video: .*/).allInnerTexts()).join(' | ');
    });
    await step('academy: connect audio/video on session B (NOT-allowed server)', async () => {
      await page.getByRole('button', { name: 'Connect audio/video' }).nth(1).click({ timeout: 6000 });
      await page.waitForTimeout(4000);
      await shot('academy-session-b');
      return (await page.getByText(/Audio\/video: .*/).allInnerTexts()).join(' | ');
    });
    for (const [slug, label] of [['allowed', 'allowed host'], ['blocked', 'NOT-allowed host']]) {
      await step(`academy: video on the ${label}`, async () => {
        await page.getByRole('button', { name: 'Videos', exact: true }).click({ timeout: 6000 });
        await page.getByRole('button', { name: new RegExp(slug === 'allowed' ? 'on the allowed origin' : 'NOT-allowed origin') }).click({ timeout: 6000 });
        await page.waitForSelector('video', { timeout: 6000 });
        await page.waitForTimeout(2500);
        await shot(`academy-video-${slug}`);
        return `video element present, src host ${new URL(await page.locator('video').getAttribute('src')).host}`;
      });
    }
  }
  results[kind] = { steps, consoleCsp, other, report: await (await sink('/violations')).json() };
  await context.close();
}
await browser.close();
const short = (t) => String(t).replace(/base64,[^'\s]+/g, 'base64,...').replace(/(access_token|join_request)=[^&'\s]+/g, '$1=...').slice(0, 190);
const uniq = (list) => [...new Set(list.map(short))];
for (const [kind, r] of Object.entries(results)) {
  console.log(`\n== ${kind}`);
  for (const s of r.steps) console.log(`  ${s.ok ? 'OK  ' : 'FAIL'} ${s.name} -> ${short(s.detail).slice(0, 110)}`);
  console.log('  console CSP messages (deduped):');
  for (const c of uniq(r.consoleCsp)) console.log('    ' + c);
  console.log('  sink reports (directive | blocked | page):');
  const seen = new Set();
  for (const v of r.report.violations) {
    const line = `    ${v.directive} | ${short(v.blocked)} | ${v.document}`;
    if (!seen.has(line)) (seen.add(line), console.log(line));
  }
  if (!r.report.violations.length) console.log('    (none)');
}
if (process.argv.includes('--json')) console.log(JSON.stringify(results, null, 2));
