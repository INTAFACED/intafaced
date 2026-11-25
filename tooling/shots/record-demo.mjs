#!/usr/bin/env node
/**
 * RECORD THE DEMO WORLD from the hosted beta (the venue on: Hyperliquid's test network, every figure TEST). It runs on the
 * box where the beta runs, as project-state's tooling/beta/ready.mjs does: a browser asks for the beta's public name and
 * the beta's front on the box (127.0.0.1:6211) answers. It signs a new TEST tester up with the agents' invited token,
 * asks for Full verification (the beta approves an invited tester), walks the key rooms signed out and signed in, and
 * keeps every market read the rooms make (`GET /api/v1/...`) with its answer. Nothing about the tester is kept: identity,
 * bank and every other module's calls are never recorded, and the tester's address, handle and email are replaced in
 * what is.
 *
 *   pnpm shots:record   (node tooling/shots/record-demo.mjs [--out tooling/shots/recording]
 *
 * Then, for every market the beta's venue lists, it records the venue's own public feed (book, best prices, prints and
 * candles) straight from Hyperliquid's test network through our adapter (packages/venue-hyperliquid, built), in the
 * exact answer svc-trade's door gives (`{ venueId, value, asOf, reportedAt, test }`, wire-encoded), so a desk has a
 * live-looking book, tape and chart even where the beta's own read was refused or never made.
 *
 * The shots (tooling/shots/shots.mjs) replay this file; `pnpm shots` never reaches the network.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BETA = join(homedir(), '.intafaced', 'beta');
const PUBLIC = 'https://beta.intafaced.com';
const FRONT = process.env.BETA_FRONT ?? 'http://127.0.0.1:6211';
const MAIL = process.env.BETA_MAIL ?? 'http://127.0.0.1:6290';
const argOut = process.argv.indexOf('--out');
const OUT = resolve(ROOT, argOut > 0 ? process.argv[argOut + 1] : 'tooling/shots/recording');

/** The rooms walked, signed out and then signed in; a desk is walked once for each market whose reads it keeps. */
export const WALK = [
  '/',
  '/trade',
  '/trade/spot/BTC-USDC',
  '/trade/futures',
  '/trade/futures?symbol=ETH-PERP',
  '/trade/convert',
  '/money',
  '/uc/recharge',
  '/verification',
  '/fees',
];

/** The reads kept: market and venue reads under /api/v1. Every other call (identity, bank, notify...) is the TEST account's. */
export const KEPT = /^\/api\/v1\//;

/** The public feed recorded per venue market: each read as the desks ask it, and every chart interval they offer. */
export const FEED = { bookDepth: [10, 20], tradeLimit: [30, 50], candleIntervals: ['15m', '1h', '4h', '1d'], candleLimit: 240 };

/** The venue's public feed for each of `symbols`, keyed as the door's routes answer it, wire-encoded: one map a market. */
async function venueFeeds(symbols) {
  const dist = (pkg) => pathToFileURL(join(ROOT, 'packages', pkg, 'dist/index.js')).href;
  const { HyperliquidTestnetUserVenue } = await import(dist('venue-hyperliquid'));
  const { encodeVenueWire } = await import(dist('venue-contracts'));
  const venue = new HyperliquidTestnetUserVenue({ appEnv: 'dev' });
  if (!venue.trades || !venue.candles || !venue.bestPrices)
    throw new Error('the built adapter reads no prints, candles or best prices: build packages/venue-hyperliquid first');
  const door = (read) => ({ status: 200, json: encodeVenueWire({ ...read, test: true }) });
  const feeds = {};
  for (const symbol of symbols) {
    const out = (feeds[symbol] = {});
    for (const depth of FEED.bookDepth) {
      out[callKey('GET', `/api/v1/venue/book?symbol=${symbol}&depth=${depth}`)] = door(await venue.book(symbol, depth));
      out[callKey('GET', `/api/v1/venue/public-book?symbol=${symbol}&depth=${depth}`)] = door(await venue.book(symbol, depth));
    }
    // The door adds the owner's price protection beside the venue's prices; not read here, it is not known (never guessed).
    const best = door(await venue.bestPrices(symbol));
    out[callKey('GET', `/api/v1/venue/best-prices?symbol=${symbol}`)] = {
      ...best,
      json: { ...best.json, slippageCapBps: { known: false }, spreadLimitBps: { known: false } },
    };
    for (const limit of FEED.tradeLimit)
      out[callKey('GET', `/api/v1/venue/trades?symbol=${symbol}&limit=${limit}`)] = door(await venue.trades(symbol, limit));
    for (const interval of FEED.candleIntervals)
      out[callKey('GET', `/api/v1/venue/candles?symbol=${symbol}&interval=${interval}&limit=${FEED.candleLimit}`)] = door(
        await venue.candles(symbol, interval, FEED.candleLimit),
      );
  }
  return feeds;
}

/** A call's key: the method, the path and its query in name order, so one read made twice is one entry. */
export function callKey(method, href) {
  const u = new URL(href, 'http://x');
  const q = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  return `${method} ${u.pathname}${q.length ? `?${new URLSearchParams(q)}` : ''}`;
}

async function main() {
  const invited = JSON.parse(readFileSync(join(BETA, 'invited.json'), 'utf8')).tokens ?? {};
  const token = Object.keys(invited).find((t) => t.startsWith('zenyoda'));
  if (!token) throw new Error("the agents' invited token is not in invited.json");
  const stamp = Date.now().toString(36);
  const who = {
    email: `${token}.demo${stamp}@local-test.invalid`,
    handle: `demo${stamp}`,
    password: `TEST-${randomBytes(12).toString('base64url')}-9a`,
  };
  const hidden = [who.email, who.email.split('@')[0], who.handle, token];
  const require = createRequire(join(BETA, 'checkout', 'package.json'));
  const { chromium } = require('@playwright/test');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route(`${PUBLIC}/**`, async (route) => {
    const u = new URL(route.request().url());
    try {
      await route.fulfill({
        response: await route.fetch({
          url: FRONT + u.pathname + u.search,
          headers: { ...route.request().headers(), host: 'beta.intafaced.com' },
          maxRedirects: 0,
        }),
      });
    } catch {
      await route.abort();
    }
  });
  await ctx.routeWebSocket(/^wss:\/\/beta\.intafaced\.com\//, (ws) => ws.close());
  const calls = { signedOut: {}, signedIn: {} };
  let phase = 'signedOut';
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  page.on('response', async (r) => {
    const u = new URL(r.url());
    if (r.request().method() !== 'GET' || !KEPT.test(u.pathname)) return;
    try {
      calls[phase][callKey('GET', u.pathname + u.search)] = { status: r.status(), json: await r.json() };
    } catch {
      // An answer with no JSON body (a redirect, a dropped read) is not kept.
    }
  });
  const settle = async () => {
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  };
  const walk = async () => {
    for (const path of WALK) {
      await page.goto(PUBLIC + path);
      await settle();
    }
  };
  // The box's TEST mailbox lists each code as a table row: reload until the row for this tester and purpose is there.
  const mailed = async (purpose) => {
    const m = await ctx.newPage();
    try {
      for (let i = 0; i < 40; i++) {
        await m.goto(`${MAIL}/`);
        const row = m
          .locator('tbody tr')
          .filter({ has: m.getByRole('cell', { name: who.email, exact: true }) })
          .filter({ has: m.getByRole('cell', { name: purpose, exact: true }) })
          .first();
        if (
          await row.waitFor({ timeout: 1500 }).then(
            () => true,
            () => false,
          )
        ) {
          const code = (await row.locator('td').nth(2).innerText()).trim();
          if (code) return code;
        }
      }
      throw new Error(`no ${purpose} mail in 60 s`);
    } finally {
      await m.close();
    }
  };

  await walk();
  await page.goto(PUBLIC + '/');
  await settle();
  await page.getByRole('link', { name: 'Create your account' }).first().click();
  await settle();
  await page.getByLabel('Email address').fill(who.email);
  await page.getByLabel('Handle').fill(who.handle);
  await page.getByLabel('Password', { exact: true }).fill(who.password);
  await page.getByLabel('Country you live in').selectOption('DE');
  await page.getByRole('radio', { name: 'No, I am not a US person' }).check();
  await page.getByLabel('Date of birth').fill('1990-05-01');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('heading', { name: 'Check your email' }).waitFor();
  await page.getByLabel('Code from the email').fill(await mailed('signup-code'));
  await page.getByRole('button', { name: 'Confirm and open my account' }).click();
  await page.waitForURL((u) => u.pathname !== '/register');
  await settle();
  // Full verification, as a tester asks for it; the beta approves an invited tester's request.
  await page
    .getByRole('link', { name: /Verify your identity/ })
    .first()
    .click();
  await page.getByLabel('Level to request').selectOption({ label: 'Full' });
  await page.getByLabel('Country code').fill('DE');
  await page.getByRole('button', { name: 'Review request' }).click();
  await page.getByRole('button', { name: 'Submit this request' }).click();
  await page.getByText('Your reviewed request').waitFor();
  const approved = page.getByText('Approved', { exact: true }).first();
  // The beta approves an invited tester on its own clock: refresh the records until Approved shows, at most 2 minutes.
  for (
    let i = 0;
    i < 24 &&
    !(await approved.waitFor({ timeout: 5000 }).then(
      () => true,
      () => false,
    ));
    i++
  ) {
    await page
      .getByRole('button', { name: 'Refresh records' })
      .click()
      .catch(() => {});
    await settle();
  }
  if (!(await approved.isVisible().catch(() => false))) throw new Error('Full verification was not approved within 2 minutes');
  // Signed out and in once, so the session carries the new level.
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await settle();
  await page
    .getByRole('link', { name: /^Sign in/ })
    .first()
    .click();
  await page.locator('input[name=identifier]').fill(who.email);
  await page.locator('input[name=password]').fill(who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  const device = page.getByRole('heading', { name: 'Authorise this device' });
  await Promise.race([device.waitFor(), page.waitForURL((u) => !u.pathname.startsWith('/login'))]);
  if (await device.isVisible()) {
    await page.getByLabel('Device code from the email').fill(await mailed('new-device-code'));
    await page.getByRole('button', { name: 'Approve this device' }).click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  }
  await settle();
  phase = 'signedIn';
  await walk();
  await browser.close();

  // The venue's own public feed for every market the beta lists there, signed in or out alike.
  const states =
    calls.signedIn[callKey('GET', '/api/v1/venue/market-states')] ?? calls.signedOut[callKey('GET', '/api/v1/venue/market-states')];
  const symbols = (states?.json?.value?.markets ?? []).map((m) => m.symbol);
  if (symbols.length === 0) throw new Error('the beta listed no venue market: nothing to record a feed for');
  const feeds = await venueFeeds(symbols);

  // One file for the beta's own reads and one a market for its feed, each small enough for the CI review to read.
  const at = new Date().toISOString();
  const files = {
    'beta.json': { label: 'TEST', at, source: 'the hosted beta, venue on (TEST venue: testnet)', calls },
    ...Object.fromEntries(
      Object.entries(feeds).map(([symbol, feed]) => [
        `feed-${symbol}.json`,
        { label: 'TEST', at, source: `the venue's public feed for ${symbol} (TEST venue: testnet)`, calls: feed },
      ]),
    ),
  };
  mkdirSync(OUT, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    let text = JSON.stringify(body);
    for (const h of hidden) text = text.split(h).join('demo-tester');
    writeFileSync(join(OUT, name), text + '\n');
  }
  execFileSync('pnpm', ['exec', 'prettier', '--write', OUT], { cwd: ROOT, stdio: 'ignore' }); // the format check's own layout
  const n = (p) => Object.keys(calls[p]).length;
  console.log(`recorded ${n('signedOut')} signed-out and ${n('signedIn')} signed-in reads and ${symbols.length} market feeds to ${OUT}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
