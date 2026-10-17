// Usage: node crawl.mjs [--port=4658] [--only=money,payments]
// Clicks through the portal the way a person would: every menu item, tile, row link and header action on every board
// page. For each target it records where it landed and fails on: "Page not found", "Access is restricted" for an
// owner, engineer words in the page, sideways scrolling at phone width, and lime outside the primary action, the
// active tab and the focus ring. Exit code 1 when anything failed. TEST data throughout.
import { allRoutes, go, launch, openPortal, parseArgs, startServer } from './harness.mjs';
import { lintRenderedText } from './lint.mjs';

const args = parseArgs(process.argv.slice(2));
const BANNED = [
  /(?<![-\w])W\d+[a-z]?\b/,
  /\bback-?end\b/i,
  /\bstubs?\b/i,
  /\bcursors?\b/i,
  /\bservers?\b/i,
  /\bprocedures?\b/i,
  /\bprojections?\b/i,
  /\bfixtures?\b/i,
  /\barrives?\b/i,
  /\bpay\.[a-z_]{3,}/,
  /\b[a-z]+_[a-z]+_[a-z]+\b/,
];

const REDIRECTS = { '/pay/settings/team': '/pay/team', '/pay/exports': '/pay/reports/exports', '/pay/developer': '/pay/developer/keys' };
const failures = [];
const warnings = [];
const edges = [];
const fail = (where, what) => {
  failures.push(`${where}: ${what}`);
  console.log(`FAIL ${where}: ${what}`);
};

/** Link targets a person can click on this page. */
const targetsOf = (page) =>
  page.$$eval(
    '.plo-navigation a[href^="/pay"], .plo-heading a[href^="/pay"], a.pp-kpi--link[href^="/pay"], .pe-row a[href^="/pay"], .plo-content table a[href^="/pay"]',
    (links) => [...new Set(links.map((a) => a.getAttribute('href')))],
  );

async function inspect(page, where, who, width) {
  const text = await page.evaluate(() => document.querySelector('main')?.innerText ?? document.body.innerText);
  if (/Page not found/.test(text)) fail(where, 'shows "Page not found"');
  if (who === 'owner' && /Access is restricted/i.test(text)) fail(where, 'tells an owner "Access is restricted"');
  for (const pattern of BANNED) {
    const m = text.match(pattern);
    if (m) fail(where, `engineer word "${m[0]}"`);
  }
  const path = [...where.matchAll(/\/pay\/[^\s@:]*/g)].at(-1)?.[0] ?? '';
  for (const problem of lintRenderedText(text, path)) fail(where, `rendered text has ${problem}`);
  if (width < 700) {
    const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    if (over > 1) fail(where, `scrolls sideways by ${over}px at phone width`);
  }
  const lime = await page.evaluate(() => {
    const isLime = (c) => {
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(c);
      return Boolean(m) && +m[1] === 200 && +m[2] === 246 && +m[3] === 74 && (m[4] === undefined || +m[4] > 0);
    };
    const bad = [];
    let primaries = 0;
    for (const el of document.querySelectorAll('main *, header *')) {
      // The wordmark's dot is the brand, not an action.
      if (el.closest('.pfo-brand')) continue;
      for (const pseudo of [null, '::before', '::after']) {
        const s = getComputedStyle(el, pseudo);
        const hit = [s.color, s.backgroundColor, s.borderTopColor, s.outlineStyle === 'none' ? '' : s.outlineColor].some(isLime);
        if (!hit) continue;
        if (el.matches('[class*="bg-lime"]')) {
          if (!pseudo && el.matches('a, button')) primaries += 1;
          continue;
        }
        if (el.closest('[aria-current]') || el.matches('[aria-current]')) continue;
        bad.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}${pseudo ?? ''}`);
      }
    }
    return { bad: [...new Set(bad)].slice(0, 5), primaries };
  });
  if (lime.bad.length) fail(where, `lime outside the allowed places: ${lime.bad.join(', ')}`);
  if (lime.primaries > 1) {
    warnings.push(where);
    console.log(`WARN ${where}: ${lime.primaries} primary actions on one page`);
  }
}

const server = await startServer(args.port);
let browser;
try {
  browser = await launch();
  const routes = allRoutes().filter((r) => !args.only || args.only.includes(r.pkg));
  const sessions = new Map();
  const session = async (who, width) => {
    const key = `${who}:${width}`;
    if (!sessions.has(key)) sessions.set(key, await openPortal(browser, server.url, { who, width, height: width < 700 ? 844 : 900 }));
    return sessions.get(key).page;
  };
  const visited = new Set();
  for (const route of routes) {
    const page = await session(route.who, 1440);
    await go(page, route.path);
    await inspect(page, `${route.id} ${route.path} @1440`, route.who, 1440);
    for (const href of await targetsOf(page)) {
      const edge = `${route.path} -> ${href}`;
      if (visited.has(edge)) continue;
      visited.add(edge);
      await go(page, href);
      const landed = await page.evaluate(() => location.pathname + location.search);
      const wantPath = href.split('#')[0].split('?')[0];
      const want = REDIRECTS[wantPath] ?? wantPath;
      edges.push({ from: route.path, to: href, landed });
      if (landed.split('?')[0] !== want) fail(`${route.path} -> ${href}`, `landed on ${landed}`);
      await inspect(page, `${route.path} -> ${href}`, route.who, 1440);
    }
    if (route.phone) {
      const phone = await session(route.who, 390);
      await go(phone, route.path);
      await inspect(phone, `${route.id} ${route.path} @390`, route.who, 390);
    }
  }
  // A signed-in person with no business account: every business page is one calm state, nothing to press that cannot work.
  const nobody = await openPortal(browser, server.url, { who: 'none', width: 1440 });
  for (const route of routes) {
    if (route.path.startsWith('/pay/onboarding') || route.path === '/') continue;
    await go(nobody.page, route.path);
    const where = `${route.id} ${route.path} (no business)`;
    const text = await nobody.page.evaluate(() => document.querySelector('main')?.innerText ?? document.body.innerText);
    if (!/No business account yet/.test(text)) fail(where, 'does not show "No business account yet"');
    if (/not allowed|forbidden|Try again|Page not found/i.test(text)) fail(where, 'shows a refusal sentence');
    const start = await nobody.page.$('a[href="/pay/onboarding"]');
    if (!start) fail(where, 'has no way to start setup');
    const live = await nobody.page.$$eval(
      'main button:not([disabled]):not([aria-disabled="true"]):not(.pfo-nobiz *), main a[href$="/new"]',
      (els) => els.map((el) => (el.textContent ?? '').trim()).filter(Boolean),
    );
    if (live.length) fail(where, `has something to press that cannot work: ${live.join(', ')}`);
    await inspect(nobody.page, where, 'none', 1440);
  }
  await nobody.context.close();
  for (const s of sessions.values()) await s.context.close();
} finally {
  await browser?.close();
  server.stop();
}
console.log(`${edges.length} clicks recorded, ${failures.length} failures, ${warnings.length} pages with more than one primary action`);
process.exit(failures.length ? 1 : 0);
