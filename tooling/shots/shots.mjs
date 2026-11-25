#!/usr/bin/env node
/**
 * PNPM SHOTS: the key Customer rooms as the beta shows them, at a phone (390), a laptop (1440) and a wide screen (2560),
 * on the demo world (apps/customer/tests/demo-world: the beta's recorded market reads with the venue on, and
 * the look gate's TEST account). No service runs and nothing reaches the network: the built app (apps/customer/dist)
 * is served here and every /api call is answered by the demo world or refused. The clock is frozen at the recording's
 * time, Math.random is seeded and motion is stopped, so two runs on one commit draw the same pictures.
 *
 *   pnpm shots [--out <dir>] [--routes /trade,/home] [--widths 390,1440] [--no-build]
 *
 * Writes <out>/<room>--<signed-in|signed-out>--<width>.png and <out>/shots.json: per picture, the calls nothing
 * answered (each one a panel that shows its refusal) and the panels it found empty.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { securityHeaders } from '../../apps/customer/deployment/render-security-headers.mjs';
import { DEMO_NOW } from '../../apps/customer/tests/demo-world/index.mjs';
import { DEMO_ROOMS, connectDemoWallet, prepareDemoPage, startDemoNode } from '../../apps/customer/tests/demo-world/page.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = join(ROOT, 'apps/customer/dist');
const PORT = Number(process.env.SHOTS_PORT ?? 47390);

/** The key rooms, each signed out or in: the look gate judges the same ones venue-on. */
export const ROOMS = DEMO_ROOMS;
export const WIDTHS = [390, 1440, 2560];
const HEIGHT = { 390: 844, 1440: 900, 2560: 1440 };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
};

/** A picture's file name: the room's path as words, who is looking, and the width. */
export function shotName({ path, signedIn }, width) {
  const room = path === '/' ? 'landing' : path.slice(1).replace(/[/?=&]+/g, '-');
  return `${room}--${signedIn ? 'signed-in' : 'signed-out'}--${width}.png`;
}

function args(argv) {
  const o = { out: join(ROOT, 'shots'), routes: null, widths: WIDTHS, build: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = resolve(argv[++i]);
    else if (a === '--routes') o.routes = argv[++i].split(',');
    else if (a === '--widths') o.widths = argv[++i].split(',').map(Number);
    else if (a === '--no-build') o.build = false;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

function serve() {
  const headers = securityHeaders({});
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) return void res.writeHead(503).end();
    let target = resolve(DIST, `.${decodeURIComponent(url.pathname)}`);
    // `/` resolves to DIST itself, which serves the page like any other route.
    if (target !== DIST && !target.startsWith(DIST + sep)) return void res.writeHead(403).end();
    if (!existsSync(target) || statSync(target).isDirectory()) target = join(DIST, 'index.html');
    res.writeHead(200, { ...headers, 'content-type': MIME[extname(target)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(readFileSync(target));
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(PORT, '127.0.0.1', () => ok(server));
  });
}

const INIT = `(() => {
  let s = 20261125;
  Math.random = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  try { if (localStorage.getItem('intafaced.customer.view.v1') === null) localStorage.setItem('intafaced.customer.view.v1', JSON.stringify({ layoutMode: 'simple' })); } catch {}
})();`;
const FREEZE_CSS = `*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition: none !important; caret-color: transparent !important; } * { scrollbar-width: none !important; }`;

/** Panels a person would read as empty: a heading's panel whose only figures are dashes, or a named empty state. */
const EMPTY_PROBE = () => {
  const out = [];
  for (const el of document.querySelectorAll('[data-testid], section, [role="region"]')) {
    const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 400) continue;
    if (
      /\b(no (markets?|contract|futures contract|print|prices?|balances?|orders?|positions?)\b.*\b(listed|open|yet|found|arrived)|prices have not arrived|not offered|couldn.t read|refused|could not be loaded)/i.test(
        text,
      )
    )
      out.push(`${el.getAttribute('data-testid') ?? el.tagName.toLowerCase()}: ${text.slice(0, 140)}`);
  }
  return [...new Set(out)].slice(0, 20);
};

async function main() {
  const o = args(process.argv.slice(2));
  if (o.build || !existsSync(join(DIST, 'index.html')))
    // Through turbo, so the packages the app imports are built first (a fresh checkout has none built).
    execFileSync('pnpm', ['exec', 'turbo', 'run', 'build', '--filter', '@intafaced/customer'], { cwd: ROOT, stdio: 'inherit' });
  mkdirSync(o.out, { recursive: true });
  const require = createRequire(join(ROOT, 'apps/customer/package.json'));
  const { chromium } = require('@playwright/test');
  const server = await serve();
  // Where the seeded trader's browser wallet (the journeys' TEST wallet, a fixed TEST key) reads the venue's network.
  const node = await startDemoNode();
  const browser = await chromium.launch();
  const report = { at: new Date(DEMO_NOW).toISOString(), recording: 'tooling/shots/recording', shots: [] };
  const rooms = ROOMS.filter((r) => !o.routes || o.routes.includes(r.path));
  try {
    for (const room of rooms)
      for (const width of o.widths) {
        const ctx = await browser.newContext({
          viewport: { width, height: HEIGHT[width] ?? 900 },
          reducedMotion: 'reduce',
          colorScheme: 'dark',
        });
        const page = await ctx.newPage();
        await page.addInitScript({ content: INIT });
        const unanswered = new Set();
        await prepareDemoPage(page, {
          signedIn: room.signedIn,
          node: node.url,
          refusal: { code: 'shots.no_answer', message: 'The demo world has no answer for this call.' },
          onUnanswered: (call) => unanswered.add(call),
        });
        await page.goto(`http://127.0.0.1:${PORT}${room.path}`);
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
        await connectDemoWallet(page, { signedIn: room.signedIn });
        await page.addStyleTag({ content: FREEZE_CSS });
        // A lazy room shows its loading line first; draw what it settles on, as the look gate does.
        await page.waitForFunction(() => !document.querySelector('.loading, [aria-busy="true"]'), null, { timeout: 8_000 }).catch(() => {});
        // From the top with nothing focused, so a sticky header is drawn once and no focus ring shows.
        await page.evaluate(() => {
          document.activeElement?.blur?.();
          window.scrollTo(0, 0);
        });
        // Drawn once the fonts are in and two frames have painted with motion stopped.
        await page.evaluate(() =>
          document.fonts.ready.then(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)))),
        );
        const file = shotName(room, width);
        await page.screenshot({ path: join(o.out, file), fullPage: true });
        const empty = await page.evaluate(EMPTY_PROBE);
        report.shots.push({
          file,
          path: room.path,
          signedIn: room.signedIn,
          width,
          landedOn: new URL(page.url()).pathname,
          unanswered: [...unanswered].sort(),
          empty,
        });
        console.log(`${file}${empty.length ? `  empty: ${empty.length}` : ''}${unanswered.size ? `  unanswered: ${unanswered.size}` : ''}`);
        await ctx.close();
      }
  } finally {
    await browser.close();
    server.close();
    await node.close();
  }
  writeFileSync(join(o.out, 'shots.json'), JSON.stringify(report, null, 1) + '\n');
  console.log(`${report.shots.length} pictures in ${o.out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
