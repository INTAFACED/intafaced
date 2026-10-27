#!/usr/bin/env node
/**
 * LOOK GATE — renders the kit gallery and every Customer room from their built folders, under the production security
 * headers, and checks what a person would see. No service runs. A Customer room is the TEST account's
 * (apps/customer/tests/real-app/look-fixtures.mjs: signed in, with the screen tests' wire fixtures), and every `/api/`
 * call that account has no fixture for answers a typed refusal, so a room without fixtures shows its honest refuse state.
 *
 * Each page is opened at a phone (390x844) and a computer (1440x900), with the clock frozen, Math.random seeded, motion
 * reduced and animations stopped, then checked for:
 *   axe          WCAG 2.2 A/AA, serious and critical findings;
 *   contrast     the worst background pixel under every text box (a shot with all text hidden), 4.5:1, or 3:1 for
 *                large text (B4 rules, section 1);
 *   money        a money figure (`[data-slot="money"]`) on a panel less than 80% opaque;
 *   gpu          the GPU budget (gpu-budget.mjs): blur only on nav and sheet layers, at most 3 blurred surfaces and one
 *                3D canvas a screenful, a canvas at most 1.5x its box, no 3D on a confirm or review step;
 *   targets      a control smaller than 24x24 px with no 24 px of clear space (WCAG 2.5.8);
 *   focus        a focused control hidden under a `data-obscures` bar (WCAG 2.4.11), over the first 25 tab stops;
 *   csp          any Content-Security-Policy violation (in-page events and report-uri reports);
 *   font         text drawn in a system fallback instead of the web font its font-family names first (a Geist→Arial
 *                swap, a font file that failed to load, a blocked font);
 *   baseline     a pixel difference from `<package>/look-baselines/<room>/<viewport>.png` (no baseline: reported, the
 *                shot is in the artifact to commit with a `Baseline-change:` line).
 * On the phone it also renders right-to-left, at 200% text size, in forced colours and with every string in
 * pseudo-English 130% long (@intafaced/i18n/fixtures: text, placeholders and button values; not aria labels or CSS
 * content), and reports axe, sideways overflow and obscured focus there, and for 130% copy any box that cuts off its
 * text at the phone's height.
 *
 * Reports for two weeks; then a failure on the kit gallery or on a page drawn in the new look blocks a pull request
 * that changes the kit, a baseline or a migrated room (policy.mjs). CI runs main's copy.
 *
 * The founder console (apps/admin) is shot too, signed in as a TEST founder against a stand-in Edge (admin.mjs), at a
 * phone and a computer with no variants: its baselines catch a kit change that moves it. Rooms whose calls have no
 * fixture in look-fixtures.mjs still show their refuse state, said so in every report.
 *
 *   node tooling/ci/look-gate/look-gate.mjs [--shard 1/4] [--out <dir>] [--only gallery|customer|admin] [--routes /a,/b]
 *        [--update-baselines] [--changed-from origin/main]
 *   node tooling/ci/look-gate/look-gate.mjs --self-test
 */
import { execFileSync } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, statSync } from 'node:fs';
import http from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { securityHeaders } from '../../../apps/customer/deployment/render-security-headers.mjs';
import { crop, decodePng, encodePng } from './png.mjs';
import * as policy from './policy.mjs';
import * as gpu from './gpu-budget.mjs';
import { sweepRoutes } from '../../../apps/customer/tests/real-app/routes.mjs';
import * as world from '../../../apps/customer/tests/real-app/look-fixtures.mjs';
import { fixtureAnswer as answerAt } from './fixture-answer.mjs';
import { adminRoutes, edgeAnswer, sealSession, startAdmin } from './admin.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const VIEWPORTS = { phone: { width: 390, height: 844 }, computer: { width: 1440, height: 900 } };
// After the newest date in the screen fixtures the TEST account is built from (look-fixtures.mjs).
const FROZEN = new Date('2026-10-21T12:00:00Z');
const SEED = 20261026;
const REPORT_PATH = '/__csp-report';
// The gate's fixed ports: the app, the gallery, then the console and its stand-in Edge (admin.mjs). LOOK_GATE_PORT_BASE
// moves them for a second run on the same machine; its shots then show other addresses, so no baseline comes from it.
const PORT_BASE = Number(process.env.LOOK_GATE_PORT_BASE ?? 47300);
const REFUSAL = { code: 'look_gate.no_services', message: 'The look gate renders rooms without services.' };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function args(argv) {
  const out = { shard: [1, 1], out: join(ROOT, 'look-gate-out'), only: null, routes: null, update: false, changedFrom: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--shard') {
      const [k, n] = argv[++i].split('/').map(Number);
      if (!(k >= 1 && n >= k)) throw new Error(`--shard wants k/n, got ${argv[i]}`);
      out.shard = [k, n];
    } else if (a === '--out') out.out = resolve(argv[++i]);
    else if (a === '--only') {
      out.only = argv[++i];
      if (!['gallery', 'customer', 'admin'].includes(out.only)) throw new Error(`--only takes gallery, customer or admin, not ${out.only}`);
    } else if (a === '--routes') out.routes = argv[++i].split(',');
    else if (a === '--update-baselines') out.update = true;
    else if (a === '--changed-from') out.changedFrom = argv[++i];
    else if (a === '--self-test') out.selfTest = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

/** Every route the Customer app's navigation and menus name: the room report's own list. */
export const customerRoutes = sweepRoutes;

/** The baseline room name of a route: `/` is `root`, `/trade/spot/BTC-USDT` is `trade-spot-btc-usdt`. */
export function roomName(route) {
  return route === '/'
    ? 'root'
    : route
        .replace(/^\/+/, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/-$/, '');
}

/** A static server for a built folder, with the production headers and a report endpoint. SPA fallback to index.html. */
function serve(dir, reports, port) {
  const headers = securityHeaders({ reportUri: REPORT_PATH });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === REPORT_PATH && req.method === 'POST') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => (body += c.length + body.length < 65536 ? c : ''));
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          for (const r of Array.isArray(parsed) ? parsed.map((x) => x.body ?? x) : [parsed['csp-report'] ?? parsed]) reports.push(r);
        } catch {
          reports.push({ 'effective-directive': 'unreadable report', 'blocked-uri': body.slice(0, 80) });
        }
        res.writeHead(204, headers).end();
      });
      return;
    }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) {
      res.writeHead(503, { ...headers, 'content-type': 'application/json' }).end(JSON.stringify(REFUSAL));
      return;
    }
    let target;
    try {
      target = resolve(dir, `.${decodeURIComponent(url.pathname)}`);
    } catch {
      return void res.writeHead(400, headers).end();
    }
    if (!target.startsWith(dir + sep) && target !== dir) return void res.writeHead(403, headers).end();
    if (!existsSync(target) || statSync(target).isDirectory()) target = join(dir, 'index.html');
    res.writeHead(200, { ...headers, 'content-type': MIME[extname(target)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(readFileSync(target));
  });
  // A fixed port: a room can print its own address (Receive's QR code holds a link), so a port drawn per run would
  // change the shot.
  return new Promise((ok, fail) => {
    server.once('error', (error) => fail(new Error(`the look gate needs port ${port}: ${error.message}`)));
    server.listen(port, '127.0.0.1', () => ok({ server, origin: `http://127.0.0.1:${port}` }));
  });
}

const INIT = `(() => {
  Math.random = (${policy.mulberry32.toString()})(${SEED});
  // Ids drawn for a form (a request id) count up per page, so a shot never shows a fresh one.
  if (window.crypto?.randomUUID) {
    let n = 0;
    crypto.randomUUID = () => '00000000-0000-4000-8000-' + String(++n).padStart(12, '0');
  }
  window.__lookCsp = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    window.__lookCsp.push({ directive: e.effectiveDirective, blocked: e.blockedURI, source: e.sourceFile, line: e.lineNumber, sample: e.sample });
  });
})();`;

// Scrollbars hidden too: an overlay scrollbar fades on its own clock, so a shot could catch it half drawn.
const FREEZE_CSS = `*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition: none !important; caret-color: transparent !important; } * { scrollbar-width: none !important; }`;
const HIDE_TEXT_CSS = `* { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; text-decoration-color: transparent !important; } ::placeholder { color: transparent !important; }`;

/** Text boxes, money figures, controls and font probes, measured in the page. Runs in the browser. */
function measure({ maxText }) {
  // Any computed colour (rgb, color(srgb ...), oklch, a color-mix result) as sRGB 0-255 and alpha 0-1, read back from
  // a canvas so the browser does the conversion.
  const ctx = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
  const seenColours = new Map();
  const rgba = (s) => {
    if (!s) return null;
    if (seenColours.has(s)) return seenColours.get(s);
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = s;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    const out = [r, g, b, a / 255];
    seenColours.set(s, out);
    return out;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const c = getComputedStyle(el);
    return c.visibility !== 'hidden' && c.display !== 'none' && Number(c.opacity) > 0.05;
  };
  const sy = window.scrollY;
  const sx = window.scrollX;
  const box = (r) => ({ x: r.left + sx, y: r.top + sy, width: r.width, height: r.height });
  const nameOf = (el) => {
    const id = el.getAttribute('data-testid') || el.id;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
    return `${el.tagName.toLowerCase()}${id ? `#${id}` : cls ? `.${cls}` : ''}`;
  };

  const texts = [];
  let probe = 0;
  for (const el of document.querySelectorAll('body *')) {
    if (texts.length >= maxText) break;
    if (el.closest('script,style,noscript,svg,[aria-hidden="true"]') || !visible(el)) continue;
    const nodes = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim());
    if (!nodes.length) continue;
    const c = getComputedStyle(el);
    const colour = rgba(c.color);
    if (!colour || colour[3] === 0) continue;
    // Text cut off by an ancestor (an ellipsis chip, a scroller) is drawn only inside that ancestor's box.
    // and a line box taller than its own element (a pill button) is drawn inside that element's border.
    const own = el.getBoundingClientRect();
    const bw = (side) => parseFloat(c[`border${side}Width`]) || 0;
    let clip = { left: own.left + bw('Left'), top: own.top + bw('Top'), right: own.right - bw('Right'), bottom: own.bottom - bw('Bottom') };
    if (c.display === 'inline') clip = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.overflowX !== 'visible' || s.overflowY !== 'visible') {
        const b = n.getBoundingClientRect();
        clip = {
          left: Math.max(clip.left, b.left),
          top: Math.max(clip.top, b.top),
          right: Math.min(clip.right, b.right),
          bottom: Math.min(clip.bottom, b.bottom),
        };
      }
    }
    const rects = [];
    for (const n of nodes) {
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) {
        const left = Math.max(r.left, clip.left);
        const top = Math.max(r.top, clip.top);
        const right = Math.min(r.right, clip.right);
        const bottom = Math.min(r.bottom, clip.bottom);
        if (right - left >= 1 && bottom - top >= 1) rects.push(box({ left, top, width: right - left, height: bottom - top }));
      }
    }
    if (!rects.length) continue;
    el.setAttribute('data-look-font', String(probe++));
    texts.push({
      name: nameOf(el),
      text: el.textContent.trim().slice(0, 40),
      colour,
      fontSize: parseFloat(c.fontSize),
      fontWeight: Number(c.fontWeight) || 400,
      fontFamily: c.fontFamily,
      rects,
    });
  }

  const opaqueBehind = (el) => {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const bg = rgba(getComputedStyle(n).backgroundColor);
      if (bg && bg[3] > 0) return bg[3];
    }
    return 1;
  };
  const money = [...document.querySelectorAll('[data-slot="money"]')]
    .filter(visible)
    .map((el) => ({ name: nameOf(el), text: el.textContent.trim().slice(0, 30), alpha: opaqueBehind(el) }))
    .filter((m) => m.alpha < 0.8);

  const CONTROL =
    'button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="switch"], [tabindex]:not([tabindex="-1"])';
  const controls = [...document.querySelectorAll(CONTROL)].filter(visible).map((el) => ({ el, r: el.getBoundingClientRect() }));
  const inText = (el) =>
    el.tagName === 'A' && [...el.parentElement.childNodes].some((n) => n !== el && n.nodeType === 3 && n.textContent.trim());
  const small = [];
  for (const { el, r } of controls) {
    if (r.width >= 24 && r.height >= 24) continue;
    // A visually hidden input (1x1, the sr-only pattern) is not the target: its label is.
    if (r.width <= 2 || r.height <= 2) continue;
    if (inText(el)) continue;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const clash = controls.some(({ el: other, r: o }) => {
      if (other === el || other.contains(el) || el.contains(other)) return false;
      const dx = Math.max(o.left - cx, 0, cx - o.right);
      const dy = Math.max(o.top - cy, 0, cy - o.bottom);
      return Math.hypot(dx, dy) < 12;
    });
    if (clash) small.push(`${nameOf(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
  }

  const declared = [...new Set([...document.fonts].map((f) => f.family.replace(/^['"]|['"]$/g, '')))];
  const lit = !!document.querySelector('[data-look="lit"]');
  return { texts, money, small, declared, lit, overflowX: Math.max(0, document.documentElement.scrollWidth - innerWidth) };
}

/** Wait until the page's size and text stop changing for a second (at most 6 s); false when they never do. */
async function settle(page) {
  let last = '';
  let stableSince = Date.now();
  const end = Date.now() + 6_000;
  while (Date.now() < end) {
    const now = await page.evaluate(
      () => `${document.documentElement.scrollHeight}:${document.body.innerText.length}:${document.querySelectorAll('*').length}`,
    );
    if (now !== last) ((last = now), (stableSince = Date.now()));
    else if (Date.now() - stableSince >= 1_000) return true;
    await page.waitForTimeout(150);
  }
  return false;
}

/**
 * A generated id (React's useId on the client `_r_…_` or server `_R_…_`, base-ui, Radix) changes between pages and
 * renders, so a control named by it would be listed once per id. Passed into the page as a source string.
 */
const GENERATED_ID = String.raw`[:«»]|^(?:base-ui|radix)-|^_r_\w*_$`;

/**
 * Tab through the first stops; a focused box a `data-obscures` bar paints over fails (inside the bar's band and under
 * it in the stacking order). Runs in the browser after each Tab.
 */
function focusState(generatedId) {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const r = el.getBoundingClientRect();
  const tops = [...document.querySelectorAll('[data-obscures="top"]')].map((b) => b.getBoundingClientRect().bottom);
  const bottoms = [...document.querySelectorAll('[data-obscures="bottom"]')].map((b) => b.getBoundingClientRect().top);
  const top = Math.max(0, ...tops);
  const bottom = Math.min(innerHeight, ...bottoms);
  const under = (tops.length || bottoms.length) && (r.top < top - 0.5 || r.bottom > bottom + 0.5) && !el.closest('[data-obscures]');
  // Under a bar's band is not yet hidden: the bar must paint over it there. A control stacked above the bar (the skip
  // link, fixed at z-index 100) stays seen.
  // The middle of each overlap with a band, at its two ends and centre. elementFromPoint skips `pointer-events: none`
  // layers, so a bar must take pointer events over the part that hides a control (the kit's bars do).
  const inset = Math.min(2, r.width / 4);
  const xs = [r.left + inset, (r.left + r.right) / 2, r.right - inset];
  const ys = [
    ...(r.top < top ? [(r.top + Math.min(r.bottom, top)) / 2] : []),
    ...(r.bottom > bottom ? [(Math.max(r.top, bottom) + r.bottom) / 2] : []),
  ];
  const covered =
    under &&
    ys.some((y) =>
      xs.some((x) => {
        const hit = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight ? document.elementFromPoint(x, y) : null;
        return hit && !el.contains(hit) && !!hit.closest('[data-obscures]');
      }),
    );
  return {
    name: `${el.tagName.toLowerCase()}${el.id && !new RegExp(generatedId, 'i').test(el.id) ? `#${el.id}` : ''} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)}"`,
    covered: !!covered,
  };
}

/** The platform fonts drawing each probed text node, through the DevTools protocol. */
async function renderedFonts(page, ids) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
    const out = new Map();
    for (const id of ids) {
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: `[data-look-font="${id}"]` });
      if (!nodeId) continue;
      const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
      out.set(String(id), fonts);
    }
    return out;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** Which text probes the font check reads: headings, controls, body copy and figures, a few of each. */
function fontProbes(texts) {
  const picked = [];
  const kinds = new Map();
  texts.forEach((t, i) => {
    const kind = t.name.split(/[.#]/)[0];
    const n = kinds.get(kind) ?? 0;
    if (n < 3) picked.push(i);
    kinds.set(kind, n + 1);
  });
  return picked.slice(0, 40);
}

/** The TEST account's answer at the gate's frozen time (fixture-answer.mjs). */
const fixtureAnswer = (href, method, body, { signedIn }) => answerAt(href, method, body, { signedIn, now: FROZEN.getTime() });

/**
 * The same start for every page: frozen clock, seeded random, CSP listener, no socket. A Customer room is the TEST
 * account's (signed in unless look-fixtures.mjs lists it as signed out, in its default view); every service call that
 * account has no fixture for is refused.
 */
async function prepare(page, target = {}) {
  await page.clock.setFixedTime(FROZEN);
  await page.addInitScript({ content: INIT });
  if (target.customer)
    await page.addInitScript(
      ([key, view]) => {
        try {
          localStorage.getItem(key) ?? localStorage.setItem(key, JSON.stringify(view));
        } catch {
          // A frame with no storage (about:blank, sandboxed) keeps the app's own default.
        }
      },
      ['intafaced.customer.view.v1', world.VIEW],
    );
  const signedIn = Boolean(target.customer) && !world.SIGNED_OUT.includes(target.path);
  // The console's own /api is its server talking to the stand-in Edge (admin.mjs), which already refuses.
  if (!target.admin)
    await page.route('**/api/**', (route) => {
      const request = route.request();
      const answer = target.customer ? fixtureAnswer(request.url(), request.method(), request.postData(), { signedIn }) : null;
      if (answer) return route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.json) });
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(REFUSAL) });
    });
  await page.routeWebSocket(/\/ws(\/|$)/, (ws) => ws.close({ code: 1011, reason: REFUSAL.code }));
}

async function check(context, origin, target, vpName, opts) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) =>
    errors.push(
      String(e.message ?? e)
        .split('\n')[0]
        .slice(0, 160),
    ),
  );
  await prepare(page, target);
  const row = { target: target.name, viewport: vpName, findings: {}, notes: [] };
  const add = (kind, items) => items.length && (row.findings[kind] = items);
  try {
    await page.goto(origin + target.path, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {});
    if (target.admin && target.path !== '/login' && new URL(page.url()).pathname === '/login')
      add('signin', ['landed on /login: the console refused the TEST founder session (admin.mjs seals it as founder-session.ts)']);
    row.lit = await page.evaluate(() => !!document.querySelector('[data-look="lit"], [data-moment][data-jurisdiction]'));
    await page.addStyleTag({ content: FREEZE_CSS });
    // A lazy room shows its loading line first; measure what it settles on.
    await page
      .waitForFunction(() => !document.querySelector('.loading, [aria-busy="true"]'), null, { timeout: 8_000 })
      .catch(() => row.notes.push('still loading after 8 s'));
    await page.evaluate(() => document.fonts.ready);
    // The whole page in one viewport, so the boxes measured are where the shot draws them (a full-page shot resizes the
    // viewport, which moves fixed bars and anything sized in vh).
    const viewport = page.viewportSize();
    const fullHeight = await page.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
    if (!target.scope && fullHeight > viewport.height)
      await page.setViewportSize({ width: viewport.width, height: Math.min(fullHeight, 12_000) });
    if (target.scope) await page.addStyleTag({ content: 'header.sticky{display:none !important}' });
    if (!(await settle(page))) row.notes.push('layout still moving after 6 s');

    // The shots and the measurement back to back, so the boxes are where the pictures draw them.
    const shotOpts = { animations: 'disabled', caret: 'hide', timeout: 30_000 };
    const shoot = (o) => (target.scope ? page.locator(target.scope).screenshot(o) : page.screenshot(o));
    const seen = await shoot(shotOpts);
    const m = await page.evaluate(measure, { maxText: 400 });
    const hide = await page.addStyleTag({ content: HIDE_TEXT_CSS });
    const blankPng = await shoot(shotOpts);
    await hide.evaluate((el) => el.remove());
    const blank = decodePng(blankPng);
    if (process.env.LOOK_GATE_DEBUG) {
      mkdirSync(join(opts.out, 'blank', target.room), { recursive: true });
      writeFileSync(join(opts.out, 'blank', target.room, `${vpName}.png`), blankPng);
    }
    row.lit ||= m.lit;

    // axe
    const { default: AxeBuilder } = await import('@axe-core/playwright');
    const axeBuilder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']);
    if (target.scope) axeBuilder.include(target.scope);
    const axe = await axeBuilder.analyze();
    add(
      'axe',
      axe.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => `${v.id} ×${v.nodes.length}: ${v.nodes[0]?.target?.join(' ') ?? ''}`),
    );

    // worst-pixel contrast, from the shot taken with all text hidden
    let offset = { x: 0, y: 0 };
    if (target.scope) {
      const b = await page.locator(target.scope).boundingBox();
      const s = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
      offset = { x: b.x + s.x, y: b.y + s.y };
    }
    const contrast = [];
    const worstOf = (t) => {
      let worst = { ratio: Infinity };
      for (const r of t.rects) {
        const px = crop(blank, { ...r, x: r.x - offset.x, y: r.y - offset.y });
        if (!px.length) continue;
        const w = policy.worstContrast(t.colour, px);
        if (w.ratio < worst.ratio) worst = w;
      }
      return worst;
    };
    for (const t of m.texts) {
      const w = worstOf(t);
      const min = policy.minimumFor(t);
      const [r0] = t.rects;
      if (w.ratio < min)
        contrast.push(
          `${t.name} "${t.text}" ${(Math.floor(w.ratio * 100) / 100).toFixed(2)} < ${min} (worst pixel under it rgb(${w.at.join(',')}), box at ${Math.round(r0.x)},${Math.round(r0.y)})`,
        );
    }
    add('contrast', contrast.slice(0, 30).concat(contrast.length > 30 ? [`… ${contrast.length - 30} more`] : []));
    add(
      'money',
      m.money.map((x) => `${x.name} "${x.text}" on a panel ${Math.round(x.alpha * 100)}% opaque (needs 80%+)`),
    );
    add('gpu', gpu.judgeGpu(await page.evaluate(gpu.measureGpu), viewport.height));
    add('targets', m.small.slice(0, 20));

    // rendered font
    const probes = fontProbes(m.texts);
    const fonts = await renderedFonts(page, probes);
    const fontFails = [];
    for (const i of probes) {
      const t = m.texts[i];
      // Nothing drawn (text inside a closed <details>, say) is not drawn in the wrong font.
      if (!(fonts.get(String(i)) ?? []).length) continue;
      const why = policy.judgeFont({ fontFamily: t.fontFamily, declared: m.declared, platform: fonts.get(String(i)) ?? [] });
      if (why) fontFails.push(`${t.name} "${t.text}": ${why}`);
    }
    add('font', [...new Set(fontFails)].slice(0, 15));

    // focus not obscured
    const focus = [];
    if (!target.scope) {
      await page.setViewportSize(viewport);
      for (let i = 0; i < 25; i++) {
        await page.keyboard.press('Tab');
        const f = await page.evaluate(focusState, GENERATED_ID);
        if (f?.covered) focus.push(`${f.name} is under a fixed bar`);
      }
    }
    add('focus', [...new Set(focus)]);

    // csp
    const inPage = await page.evaluate(() => window.__lookCsp ?? []);
    add(
      'csp',
      inPage.map((v) => `${v.directive} blocked ${v.blocked || '(inline)'}${v.source ? ` from ${v.source}:${v.line}` : ''}`),
    );
    if (errors.length) row.notes.push(`page errors: ${errors.slice(0, 3).join(' | ')}`);

    // baseline
    const shotPath = join(opts.out, 'shots', target.room, `${vpName}.png`);
    mkdirSync(dirname(shotPath), { recursive: true });
    writeFileSync(shotPath, seen);
    const basePath = join(ROOT, target.baselines, target.room, `${vpName}.png`);
    if (opts.update) {
      mkdirSync(dirname(basePath), { recursive: true });
      writeFileSync(basePath, seen);
      row.notes.push('baseline written');
    } else if (!existsSync(basePath)) row.notes.push(`no baseline (${target.baselines}/${target.room}/${vpName}.png)`);
    else {
      const a = decodePng(readFileSync(basePath));
      const b = decodePng(seen);
      const diff = new Uint8Array(b.data);
      const d = a.width === b.width && a.height === b.height ? policy.pixelDiff(a.data, b.data, a, 2, diff) : { sizeChanged: true };
      if (d.sizeChanged) add('baseline', [`size ${a.width}x${a.height} → ${b.width}x${b.height}`]);
      else if (d.differing > 0) {
        writeFileSync(shotPath.replace(/\.png$/, '.diff.png'), encodePng({ width: b.width, height: b.height, data: diff }));
        add('baseline', [`${d.differing} pixels differ (diff in the artifact)`]);
      }
    }
  } catch (error) {
    row.findings.error = [
      String(error?.message ?? error)
        .split('\n')[0]
        .slice(0, 200),
    ];
  } finally {
    await page.close();
  }
  return row;
}

const I18N_FIXTURES = 'packages/i18n/dist/fixtures.js';

/**
 * Whether a string is copy a translation would lengthen. A figure (no letter), a ticker or pair (BTC, BTC-USDT), an
 * amount with its code after it (+50 USDT, 0.1 BTC) and the wordmark keep their text, and so does pseudo copy already
 * applied (a second pass after a re-render).
 */
export function isCopy(text) {
  const amount = /^[+\-−]?\p{Sc}?\d[\d.,\s]*\s?[A-Z][A-Z0-9]{1,9}$/u.test(text);
  return (
    /\p{L}/u.test(text) && !amount && !/^[A-Z0-9][A-Z0-9./-]{0,11}$/.test(text) && !/^intafaced\W*$/i.test(text) && !text.startsWith('⟦')
  );
}

/**
 * Pseudo-English at 130% (B4's `pseudoLocalize`, packages/i18n/src/fixtures.ts) on every visible string: text nodes,
 * placeholders and button values. A money slot and anything marked translate="no" keep theirs. Returns how many
 * strings it changed; run it again after a re-render to catch what React wrote back.
 */
async function pseudoCopy(page) {
  const { pseudoLocalize } = await import(pathToFileURL(join(ROOT, I18N_FIXTURES)).href);
  const found = await page.evaluate(() => {
    const kept = 'script,style,noscript,[data-slot="money"],[translate="no"]';
    const spots = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode())
      if (n.parentElement && !n.parentElement.closest(kept) && n.textContent.trim()) spots.push({ node: n, text: n.textContent.trim() });
    for (const el of document.querySelectorAll('[placeholder], input[type="submit"], input[type="button"], input[type="reset"]')) {
      if (el.closest(kept)) continue;
      const attr = el.hasAttribute('placeholder') ? 'placeholder' : 'value';
      const text = (el.getAttribute(attr) ?? el.value ?? '').trim();
      if (text) spots.push({ el, attr, text });
    }
    window.__lookGateCopy = spots;
    return [...new Set(spots.map((s) => s.text))];
  });
  // The fixture pads with one unbroken run (~·ẅ~·ẅ…), which no translation has: a long sentence's run would spill out
  // of any box. A zero-width space every two groups lets it wrap like words, without making it longer.
  const wrap = (text) => text.replace(/(?:~·ẅ){2}(?=~)/g, '$&\u200B');
  const copy = Object.fromEntries(found.filter(isCopy).map((s) => [s, wrap(pseudoLocalize(s))]));
  return page.evaluate((copy) => {
    let n = 0;
    for (const spot of window.__lookGateCopy ?? []) {
      if (!Object.hasOwn(copy, spot.text)) continue;
      const next = copy[spot.text];
      if (spot.node) {
        if (!spot.node.isConnected) continue;
        spot.node.textContent = spot.node.textContent.replace(spot.text, () => next);
        spot.node.parentElement?.setAttribute('data-look-gate-copy', '');
      } else {
        spot.el.setAttribute(spot.attr, next);
        if (spot.attr === 'value') spot.el.value = next;
        spot.el.setAttribute('data-look-gate-copy', '');
      }
      n++;
    }
    delete window.__lookGateCopy;
    return n;
  }, copy);
}

/**
 * Pseudo copy a person cannot read whole at 130%, as `[box, how]`: its box cuts it off (hidden or clipped overflow, an
 * ellipsis or a line clamp), it spills sideways out of its box over its neighbours, or a box around it that cannot
 * scroll there (a tab list, a clipped row) hides part of it.
 */
const CLIPPED_COPY = (generatedId) => {
  // A generated id (GENERATED_ID): name the box by its tag and class instead.
  const stable = (id) => id && !new RegExp(generatedId, 'i').test(id);
  const name = (el) => {
    const id = el.getAttribute('data-testid') || (stable(el.id) ? el.id : '');
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
    return `${el.tagName.toLowerCase()}${id ? `#${id}` : cls ? `.${cls}` : ''}`;
  };
  const cuts = (v) => v === 'hidden' || v === 'clip';
  const out = new Map();
  for (const own of document.querySelectorAll('[data-look-gate-copy]')) {
    // An inline or display: contents element has no box of its own: judge the block that holds it.
    let el = own;
    while (el.parentElement && ['inline', 'contents'].includes(getComputedStyle(el).display)) el = el.parentElement;
    const c = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    // Hidden, or visually hidden for screen readers (a 1 px clipped box): nobody sees it cut.
    if (c.visibility === 'hidden' || r.width <= 1 || r.height <= 1 || c.clipPath.startsWith('inset(50%')) continue;
    const clamp = c.webkitLineClamp && c.webkitLineClamp !== 'none';
    const wide = (cuts(c.overflowX) || c.textOverflow === 'ellipsis') && el.scrollWidth > el.clientWidth + 1;
    const tall = (cuts(c.overflowY) || clamp) && el.scrollHeight > el.clientHeight + 1;
    let how = wide || tall ? 'cuts off its text' : '';
    if (!how && own.matches('input, textarea')) continue;
    // The text's own extent: the marked element's own text nodes, never a child box (a tooltip, a caret) placed elsewhere.
    const t = { left: Infinity, right: -Infinity, width: 0 };
    for (const node of own.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const b = range.getBoundingClientRect();
      if (!b.width) continue;
      t.left = Math.min(t.left, b.left);
      t.right = Math.max(t.right, b.right);
      t.width = t.right - t.left;
    }
    if (!how && t.width > 0 && (t.left < r.left - 1 || t.right > r.right + 1)) how = 'spills out of its box';
    // A box further out that clips this text where it cannot scroll to show it. A fixed box escapes every clip above it
    // (its own still cuts: the dock, the top bar); an absolute one escapes the boxes between it and its containing block
    // (the nearest positioned box).
    let escaped = c.position === 'absolute';
    for (let a = el.parentElement; !how && a && a !== document.body && c.position !== 'fixed'; a = a.parentElement) {
      const ac = getComputedStyle(a);
      const last = ac.position === 'fixed';
      const skip = escaped && ac.position === 'static';
      if (ac.position !== 'static') escaped = ac.position === 'absolute';
      if (skip || (ac.overflowX === 'visible' && ac.overflowY === 'visible')) {
        if (last) break;
        continue;
      }
      const ar = a.getBoundingClientRect();
      const scrolls = (v) => v === 'auto' || v === 'scroll';
      const x = Math.abs(a.scrollLeft);
      const room = a.scrollWidth - a.clientWidth;
      // Scrollable toward the hidden part counts as reachable; the start of a centred row that overflows never is.
      const startHidden = t.left < ar.left - 1 && !(scrolls(ac.overflowX) && x > 0);
      const endHidden = t.right > ar.right + 1 && !(scrolls(ac.overflowX) && x < room - 1);
      // Text wholly outside the box (a slide not shown, a closed panel) is hidden, not cut.
      const overlaps = t.right > ar.left && t.left < ar.right;
      if (t.width > 0 && overlaps && (startHidden || endHidden)) how = `is cut by ${name(a)}`;
      if (last) break;
    }
    if (how && !out.has(name(el))) out.set(name(el), how);
    if (out.size >= 12) break;
  }
  return [...out];
};

/**
 * The phone-only variants: right-to-left, 200% text, forced colours and 130% copy. axe, sideways overflow and obscured
 * focus; for 130% copy also text its box cuts off, and a shot in the artifact (`shots/<room>/phone-copy-130.png`).
 */
async function variants(browser, origin, target, opts) {
  const out = [];
  for (const [name, setup] of [
    ['rtl', { css: '', attr: true }],
    ['text-200', { css: 'html { font-size: 200% !important; }' }],
    ['forced-colors', { forced: true }],
    ['copy-130', { pseudo: true }],
  ]) {
    const context = await browser.newContext({
      viewport: VIEWPORTS.phone,
      reducedMotion: 'reduce',
      forcedColors: setup.forced ? 'active' : 'none',
      timezoneId: 'UTC',
      locale: 'en-GB',
    });
    const page = await context.newPage();
    const row = { target: target.name, viewport: `phone ${name}`, findings: {}, notes: [] };
    try {
      await prepare(page, target);
      await page.goto(origin + target.path, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {});
      await page.addStyleTag({ content: FREEZE_CSS });
      if (setup.attr) await page.evaluate(() => document.documentElement.setAttribute('dir', 'rtl'));
      if (setup.pseudo) {
        // A lazy room shows its loading line first; lengthen what it settles on.
        await page
          .waitForFunction(() => !document.querySelector('.loading, [aria-busy="true"]'), null, { timeout: 8_000 })
          .catch(() => row.notes.push('still loading after 8 s'));
        row.notes.push(`${await pseudoCopy(page)} strings at 130%`);
      }
      if (setup.css) await page.addStyleTag({ content: setup.css });
      if (!(await settle(page))) row.notes.push('layout still moving after 6 s');
      // What a re-render wrote back in English while the layout settled.
      if (setup.pseudo && (await pseudoCopy(page)) && !(await settle(page))) row.notes.push('layout still moving after 6 s');
      const { default: AxeBuilder } = await import('@axe-core/playwright');
      const axeBuilder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']);
      if (target.scope) axeBuilder.include(target.scope);
      const axe = await axeBuilder.analyze();
      const serious = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      if (serious.length) row.findings.axe = serious.map((v) => `${v.id} ×${v.nodes.length}`);
      const overflow = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth));
      if (overflow > 0) row.findings.overflow = [`${overflow}px wider than the screen`];
      if (setup.pseudo) {
        const clipped = await page.evaluate(CLIPPED_COPY, GENERATED_ID);
        if (clipped.length) row.findings.copy = clipped.map(([box, how]) => `${box} ${how} at 130%`);
        const dir = join(opts.out, 'shots', target.room);
        mkdirSync(dir, { recursive: true });
        // The whole page in one viewport, as the main shots are, so fixed bars stay where a person sees them.
        const height = await page.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
        if (!target.scope && height > VIEWPORTS.phone.height)
          await page.setViewportSize({ width: VIEWPORTS.phone.width, height: Math.min(height, 12_000) });
        await settle(page);
        const path = join(dir, 'phone-copy-130.png');
        const shotOpts = { path, animations: 'disabled', caret: 'hide', timeout: 30_000 };
        await (target.scope ? page.locator(target.scope).screenshot(shotOpts) : page.screenshot(shotOpts));
        // Back to the phone, so the focus walk below sees bars where a person does.
        await page.setViewportSize(VIEWPORTS.phone);
      }
      const focus = [];
      if (!target.scope)
        for (let i = 0; i < 15; i++) {
          await page.keyboard.press('Tab');
          const f = await page.evaluate(focusState, GENERATED_ID);
          if (f?.covered) focus.push(`${f.name} is under a fixed bar`);
        }
      if (focus.length) row.findings.focus = [...new Set(focus)];
    } catch (error) {
      row.findings.error = [
        String(error?.message ?? error)
          .split('\n')[0]
          .slice(0, 200),
      ];
    } finally {
      await context.close();
    }
    out.push(row);
  }
  return out;
}

/** The pull request's changed paths, or null when git cannot say (no base, a shallow clone): never an empty list. */
function changedFiles(base) {
  try {
    return execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch (error) {
    console.error(`::warning::look gate: could not list the changed paths against ${base}: ${String(error.message).split('\n')[0]}`);
    return null;
  }
}

/** Whether a Customer room folder imports the new look's kit. */
function importsLit(folder) {
  try {
    return (
      execFileSync('git', ['grep', '-l', '-E', "from '@intafaced/ui/lit|from '@intafaced/ui/src/lit", '--', folder], {
        cwd: ROOT,
        encoding: 'utf8',
      }).trim().length > 0
    );
  } catch {
    return false;
  }
}

/** Whether a row's findings count toward the verdict: the kit gallery or a page drawn in the new look. */
export function isBlockable(r, litTargets) {
  return r.target.startsWith('kit ') || litTargets.has(r.target);
}

/**
 * Old-room focus debt, for stage C: each control an old room's bar paints over when it takes focus, once. Report only;
 * the same finding on a new-look page blocks with the rest.
 */
export function focusDebt(rows, litTargets) {
  const seen = new Map();
  for (const r of rows)
    if (!isBlockable(r, litTargets))
      for (const f of r.findings.focus ?? []) {
        const key = `${r.target}: ${f}`;
        // The first viewport that shows it, in row order (the plain phone before its variants).
        if (!seen.has(key)) seen.set(key, `${r.target} (${r.viewport}): ${f}`);
      }
  if (!seen.size) return [];
  return [`## Old-room focus debt (stage C): ${seen.size}`, '', ...[...seen.values()].map((l) => `- ${l.replace(/\|/g, '/')}`), ''];
}

function report(rows, opts) {
  const failing = rows.filter((r) => Object.keys(r.findings).length);
  // A target is drawn in the new look when any of its shots found it so: its variant and error rows count too.
  const litTargets = new Set(rows.filter((r) => r.lit).map((r) => r.target));
  const blockable = failing.filter((r) => isBlockable(r, litTargets));
  const kinds = {};
  for (const r of failing) for (const k of Object.keys(r.findings)) kinds[k] = (kinds[k] ?? 0) + 1;
  const changed = opts.changedFrom ? changedFiles(opts.changedFrom) : [];
  const v = policy.verdict({ failures: blockable.length, changed, today: new Date().toISOString().slice(0, 10), importsLit });
  const lines = [
    `# Look gate (shard ${opts.shard.join('/')})`,
    '',
    `${rows.length} page shots, ${failing.length} with findings (${
      Object.entries(kinds)
        .map(([k, n]) => `${k} ${n}`)
        .join(', ') || 'none'
    }). Blockable (kit gallery or new-look pages): ${blockable.length}.`,
    '',
    `Verdict: **${v.mode}**${v.why ? ` (${v.why})` : ''}${v.blocking?.length ? `; blocking paths changed: ${v.blocking.slice(0, 5).join(', ')}` : ''}.`,
    '',
    `Not checked yet: rooms with no fixture in apps/customer/tests/real-app/look-fixtures.mjs show their refuse state.`,
    '',
    ...focusDebt(rows, litTargets),
    '## Every page',
    '',
    '| Page | Viewport | Findings | Notes |',
    '| --- | --- | --- | --- |',
    ...rows.map(
      (r) =>
        `| ${r.target} | ${r.viewport} | ${Object.entries(r.findings)
          .map(([k, list]) => `**${k}** ${list.length}: ${list.slice(0, 2).join('; ')}`)
          .join('<br>')
          .replace(/\|/g, '/')} | ${r.notes.join('; ').replace(/\|/g, '/')} |`,
    ),
  ];
  const md = lines.join('\n');
  mkdirSync(opts.out, { recursive: true });
  writeFileSync(join(opts.out, `report-${opts.shard.join('-of-')}.md`), md + '\n');
  writeFileSync(join(opts.out, `report-${opts.shard.join('-of-')}.json`), JSON.stringify({ verdict: v, rows }, null, 2) + '\n');
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.slice(0, 900_000) + '\n');
  console.log(lines.slice(0, 6).join('\n'));
  for (const r of failing.slice(0, 40)) console.log(`  ${r.target} ${r.viewport}: ${Object.keys(r.findings).join(', ')}`);
  return v;
}

async function main(opts) {
  const { chromium } = await import('@playwright/test');
  const customerDist = join(ROOT, 'apps/customer/dist');
  const galleryDist = join(ROOT, 'packages/ui/.gallery-dist');
  const reports = [];
  const servers = [];
  const targets = [];
  const browser = await chromium.launch(process.env.LOOK_GATE_CHROMIUM ? { executablePath: process.env.LOOK_GATE_CHROMIUM } : {});

  if (!existsSync(join(ROOT, I18N_FIXTURES)))
    throw new Error(`no @intafaced/i18n build for the 130% copy pass (${I18N_FIXTURES}): pnpm --filter @intafaced/i18n build`);
  if (!opts.only || opts.only === 'gallery') {
    if (!existsSync(join(galleryDist, 'index.html')))
      throw new Error(`no kit gallery build in ${galleryDist}: pnpm --filter @intafaced/ui gallery:build`);
    const g = await serve(galleryDist, reports, PORT_BASE + 1);
    servers.push(g.server);
    const page = await browser.newPage();
    await page.goto(g.origin + '/', { waitUntil: 'networkidle' });
    const ids = await page.$$eval('[data-kit-section]', (els) => els.map((e) => e.getAttribute('data-kit-section')));
    await page.close();
    for (const id of ids)
      targets.push({
        name: `kit ${id}`,
        origin: g.origin,
        path: `/?only=${id}`,
        scope: `[data-kit-section="${id}"]`,
        room: `kit-${id}`,
        baselines: 'packages/ui/look-baselines',
      });
  }
  if (!opts.only || opts.only === 'customer') {
    if (!existsSync(join(customerDist, 'index.html')))
      throw new Error(`no Customer build in ${customerDist}: pnpm turbo run build --filter=@intafaced/customer`);
    const c = await serve(customerDist, reports, PORT_BASE);
    servers.push(c.server);
    for (const route of opts.routes ?? customerRoutes())
      targets.push({
        name: route,
        origin: c.origin,
        path: route,
        room: roomName(route),
        baselines: 'apps/customer/look-baselines',
        customer: true,
      });
  }
  // `--routes` narrows a run to those Customer rooms, so the console runs only when asked for or in a whole run.
  if (opts.only === 'admin' || (!opts.only && !opts.routes)) {
    const a = await startAdmin(ROOT, { now: FROZEN.getTime(), port: PORT_BASE + 10 });
    servers.push({ close: a.stop });
    for (const route of adminRoutes(ROOT))
      targets.push({
        name: `admin ${route}`,
        origin: a.origin,
        path: route,
        room: `admin-${roomName(route)}`,
        baselines: 'apps/admin/look-baselines',
        admin: true,
        cookie: a.cookie,
      });
  }

  const [k, n] = opts.shard;
  const mine = targets.filter((_, i) => i % n === k - 1);
  // Pages in parallel (each in its own browser context), rows kept in target order.
  const perTarget = new Array(mine.length);
  let next = 0;
  const worker = async () => {
    while (next < mine.length) {
      const i = next++;
      const target = mine[i];
      const out = [];
      for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
        const context = await browser.newContext({
          viewport,
          deviceScaleFactor: 1,
          reducedMotion: 'reduce',
          timezoneId: 'UTC',
          locale: 'en-GB',
        });
        if (target.cookie) await context.addCookies([target.cookie]);
        out.push(await check(context, target.origin, target, vpName, opts));
        await context.close();
      }
      // The console's baselines are what it checks; its variants belong to its own redesign.
      if (!target.admin) out.push(...(await variants(browser, target.origin, target, opts)));
      perTarget[i] = out;
      process.stdout.write('.');
    }
  };
  await Promise.all(Array.from({ length: Number(process.env.LOOK_GATE_WORKERS ?? 3) }, worker));
  const rows = perTarget.flat();
  process.stdout.write('\n');
  await browser.close();
  for (const s of servers) s.close();
  if (reports.length) {
    const r = {
      target: 'all pages (report-uri)',
      viewport: '-',
      findings: {
        csp: reports.map(
          (x) =>
            `${x['effective-directive'] ?? x.effectiveDirective} blocked ${x['blocked-uri'] ?? x.blockedURL ?? ''} on ${x['document-uri'] ?? x.documentURL ?? ''}`,
        ),
      },
      notes: [],
      lit: false,
    };
    rows.push(r);
  }
  const v = report(rows, opts);
  if (v.mode === 'block') process.exit(1);
}

/** The copy finder on small fixed pages, in a real browser: what only layout can show. */
async function selfTestBrowser(eq) {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch(process.env.LOOK_GATE_CHROMIUM ? { executablePath: process.env.LOOK_GATE_CHROMIUM } : {});
  try {
    const page = await browser.newPage({ viewport: { width: 400, height: 400 } });
    const cut = (outer) =>
      page.setContent(
        `<body style="margin:0">${outer.replace('%', '<span class="label" data-look-gate-copy style="display:block;width:max-content">A long pseudo label that runs on</span>')}</body>`,
      );
    const box = 'width:120px;overflow:hidden';
    await cut(`<div class="row" style="${box}">%</div>`);
    eq(await page.evaluate(CLIPPED_COPY, GENERATED_ID), [['span.label', 'is cut by div.row']], 'a clipping row cuts its label');
    await cut(`<nav class="dock" style="position:fixed;bottom:0;${box}">%</nav>`);
    eq(await page.evaluate(CLIPPED_COPY, GENERATED_ID), [['span.label', 'is cut by nav.dock']], 'a fixed bar cuts its own label');
    await cut(`<div class="row" style="${box}"><nav class="dock" style="position:fixed;top:0;left:0;width:400px">%</nav></div>`);
    eq(await page.evaluate(CLIPPED_COPY, GENERATED_ID), [], 'a fixed bar escapes the row around it');
    await cut(`<div class="row" style="${box}"><div style="transform:translateX(300px)">%</div></div>`);
    eq(await page.evaluate(CLIPPED_COPY, GENERATED_ID), [], 'text wholly outside the row is hidden, not cut');
  } finally {
    await browser.close();
  }
}

async function selfTest() {
  let n = 0;
  const eq = (got, want, what) => {
    n++;
    if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  };
  const ok = (cond, what) => eq(!!cond, true, what);
  gpu.selfTest(eq);
  // contrast
  eq(Number(policy.contrast([0, 0, 0], [255, 255, 255]).toFixed(1)), 21, 'black on white is 21:1');
  eq(Number(policy.contrast([118, 118, 118], [255, 255, 255]).toFixed(2)), 4.54, '#767676 on white is 4.54:1');
  const glass = new Uint8Array([20, 20, 30, 255, 200, 200, 210, 255]);
  ok(policy.worstContrast([255, 255, 255, 1], glass).ratio < 2, 'white text over a bright glass pixel: the worst pixel decides');
  eq(policy.worstContrast([255, 255, 255, 1], glass).at, [200, 200, 210], 'the worst pixel is named');
  eq(policy.minimumFor({ fontSize: 16, fontWeight: 400 }), 4.5, 'body text needs 4.5');
  eq(policy.minimumFor({ fontSize: 19, fontWeight: 700 }), 3, 'large bold text needs 3');
  eq(policy.minimumFor({ fontSize: 18.6, fontWeight: 700 }), 4.5, 'just under the large bold size needs 4.5');
  ok(
    policy.worstContrast([255, 255, 255, 0.5], new Uint8Array([255, 255, 255, 255])).ratio < 1.01,
    'translucent text is blended over the pixel',
  );
  // font
  const declared = ['Geist Variable', 'Geist Mono Variable'];
  eq(
    policy.judgeFont({
      fontFamily: "'Geist Variable', Geist, sans-serif",
      declared,
      platform: [{ familyName: 'Geist', isCustomFont: true, glyphCount: 12 }],
    }),
    null,
    'the web font draws the text',
  );
  ok(
    /instead of Geist Variable/.test(
      policy.judgeFont({
        fontFamily: "'Geist Variable', sans-serif",
        declared,
        platform: [{ familyName: 'Liberation Sans', isCustomFont: false, glyphCount: 12 }],
      }),
    ),
    'a font file that never loaded: drawn in a fallback',
  );
  ok(
    /not a web font/.test(
      policy.judgeFont({
        fontFamily: 'Arial, sans-serif',
        declared,
        platform: [{ familyName: 'Arial', isCustomFont: false, glyphCount: 9 }],
      }),
    ),
    'a Geist→Arial swap fails',
  );
  ok(/no glyphs/.test(policy.judgeFont({ fontFamily: 'Geist Variable', declared, platform: [] })), 'nothing drawn');
  eq(policy.firstFamily(`"Inter Variable", Inter`), 'Inter Variable', 'first family unquoted');
  // pixels and png
  eq(
    policy.pixelDiff(new Uint8Array([1, 2, 3, 255]), new Uint8Array([2, 3, 4, 255]), { width: 1, height: 1 }).differing,
    0,
    'anti-alias noise within 2 passes',
  );
  eq(
    policy.pixelDiff(new Uint8Array([1, 2, 3, 255]), new Uint8Array([9, 2, 3, 255]), { width: 1, height: 1 }).differing,
    1,
    'a changed pixel fails',
  );
  const img = { width: 3, height: 2, data: new Uint8Array([...Array(24).keys()].map((i) => (i * 37) % 256)) };
  const back = decodePng(encodePng(img));
  eq([back.width, back.height, [...back.data]], [3, 2, [...img.data]], 'PNG round trip');
  eq([...crop(img, { x: 1, y: 1, width: 1, height: 1 })], [...img.data.slice(16, 20)], 'crop one pixel');
  // policy
  eq(
    policy.verdict({ failures: 3, changed: ['packages/ui/src/lit/x.css'], today: '2026-11-01' }).mode,
    'report',
    'report-only for two weeks',
  );
  eq(
    policy.verdict({ failures: 3, changed: ['packages/ui/src/lit/x.css'], today: '2026-11-09' }).mode,
    'block',
    'then a kit change blocks',
  );
  eq(
    policy.verdict({ failures: 3, changed: ['apps/customer/src/screens/home/x.tsx'], today: '2026-12-01' }).mode,
    'report',
    'an unmigrated room never blocks',
  );
  eq(
    policy.verdict({ failures: 3, changed: ['apps/customer/src/screens/home/x.tsx'], today: '2026-12-01', importsLit: () => true }).mode,
    'block',
    'a migrated room blocks',
  );
  eq(
    policy.verdict({ failures: 1, changed: ['apps/customer/look-baselines/home/phone.png'], today: '2026-12-01' }).mode,
    'block',
    'a baseline change blocks',
  );
  eq(policy.verdict({ failures: 0, changed: ['packages/ui/src/lit/x.css'], today: '2026-12-01' }).mode, 'pass', 'nothing failing passes');
  eq(policy.verdict({ failures: 2, changed: null, today: '2026-12-01' }).mode, 'block', 'unreadable changed paths never pass silently');
  eq(policy.verdict({ failures: 2, changed: null, today: '2026-11-01' }).mode, 'report', 'but only report while report-only');
  eq(roomName('/'), 'root', 'root room');
  // The TEST account: signed in, its fixtures wrapped as tRPC results, at the frozen time, and nothing it has no fixture for.
  const api = (path, method = 'GET', body = null, signedIn = true) => fixtureAnswer('http://x' + path, method, body, { signedIn });
  eq(api('/api/identity/trpc/auth.refresh', 'POST', '{}')?.json.result.data.userId, world.session(0).userId, 'signed in');
  eq(api('/api/identity/trpc/auth.refresh', 'POST', '{}', false), null, 'signed out leaves the refresh refused');
  eq(api('/api/bank/trpc/auth.refresh', 'POST', '{}'), null, 'only identity signs in');
  const balance = api('/api/v1/account/balance')?.json;
  eq([balance?.timestamp, balance?.balances.USDT.total], [FROZEN.getTime(), '4100.00'], 'REST fixture at the frozen time');
  const one = api('/api/bank/trpc/activity.list?input=' + encodeURIComponent(JSON.stringify({ limit: 1 })))?.json.result.data;
  eq(one?.items.length, 1, 'tRPC input reaches the fixture');
  eq(api('/api/v1/ohlcv/BTC-USDT')?.json.at(-1)[4], '67812.40', 'candles by symbol');
  eq(api('/api/bank/trpc/transfers.create', 'POST', '{}'), null, 'a call with no fixture is refused');
  eq([api('/api/v1/constructor'), api('/api/bank/trpc/constructor')], [null, null], 'no prototype key is a fixture');
  eq(api('/api/identity/trpc/me')?.status, 200, 'a module answers its own procedure');
  eq(api('/api/trade/trpc/me'), null, 'and no other module answers it');
  eq(api('/api/pay/trpc/workItems.list')?.json.result.data.items, [], 'every owner answers the work list');
  eq(api('/api/v1/orders/open', 'DELETE'), null, 'only reads are fixtures');
  eq(api('/api/bank/trpc/%E0'), null, 'a malformed call is refused');
  const money = (input) => api('/api/bank/trpc/activity.list?input=' + encodeURIComponent(JSON.stringify(input)))?.json.result.data;
  ok(money({}).nextCursor && money({ cursor: money({}).nextCursor }).nextCursor === null, 'the history pages end');
  ok(
    money({ direction: 'out' }).items.every((i) => i.direction === 'out'),
    'the history filters by direction',
  );
  ok(world.SIGNED_OUT.includes('/') && world.SIGNED_OUT.every((r) => customerRoutes().includes(r)), 'signed-out rooms are swept routes');
  eq(roomName('/trade/spot/BTC-USDT'), 'trade-spot-btc-usdt', 'route room');
  eq(
    focusDebt(
      [
        { target: '/pay', viewport: 'phone', findings: { focus: ['a "Send" is under a fixed bar'] } },
        { target: '/pay', viewport: 'phone rtl', findings: { focus: ['a "Send" is under a fixed bar'] } },
        { target: '/lit', viewport: 'phone', findings: { focus: ['a "x" is under a fixed bar'] } },
      ],
      new Set(['/lit']),
    ).filter((l) => l.startsWith('- ')),
    ['- /pay (phone): a "Send" is under a fixed bar'],
    'old-room focus debt: one line per control at its first viewport, new-look pages left to the blocking list',
  );
  // The founder console: its rooms, the founder check the stand-in Edge answers, and a cookie the console can open.
  const consoleRooms = adminRoutes(ROOT);
  ok(['/', '/login', '/ledger'].every((r) => consoleRooms.includes(r)) && !consoleRooms.some((r) => /[[(]/.test(r)), 'console rooms');
  eq(edgeAnswer('/api/identity/trpc/accountControls.operatorStatus?input=%7B%7D').json.result.data.status, 'enabled', 'founder check');
  eq(edgeAnswer('/api/ops/trpc/consoleMode.get').status, 503, 'every other console call is refused');
  const sealKey = Buffer.alloc(32, 7);
  const sealed = Buffer.from(sealSession({ a: 1 }, sealKey, 'http://127.0.0.1:1'), 'base64url');
  const opened = createDecipheriv('aes-256-gcm', sealKey, sealed.subarray(0, 12));
  opened.setAuthTag(sealed.subarray(12, 28));
  opened.setAAD(Buffer.from('__Host-intafaced-admin\nhttp://127.0.0.1:1\nv1'));
  eq(JSON.parse(Buffer.concat([opened.update(sealed.subarray(28)), opened.final()]).toString()), { a: 1 }, 'the session seal opens');
  eq(
    [
      'Send money',
      'Bitcoin',
      'BTC',
      'BTC-USDT',
      '12,481.91',
      'intafaced·',
      '⟦Šéñð ~·⟧',
      'Send',
      '+50 USDT',
      '0.1 BTC',
      'Send 50 BTC',
      'TOP 10',
    ].map(isCopy),
    [true, true, false, false, false, false, false, true, false, false, true, true],
    '130% copy lengthens words, not tickers, figures, amounts, the wordmark or copy it already lengthened',
  );
  ok(customerRoutes().length > 50 && customerRoutes().includes('/coin/BTC'), 'routes are the room report list');
  const fakeMark = new Uint8Array(8);
  eq(
    policy.pixelDiff(
      new Uint8Array([0, 0, 0, 255, 9, 9, 9, 255]),
      new Uint8Array([0, 0, 0, 255, 90, 9, 9, 255]),
      { width: 2, height: 1 },
      2,
      fakeMark,
    ).differing,
    1,
    'diff counted once',
  );
  eq([...fakeMark], [0, 0, 0, 0, 255, 0, 80, 255], 'and the differing pixel is marked');
  const h = securityHeaders({ reportUri: REPORT_PATH })['Content-Security-Policy'];
  ok(/script-src 'self';/.test(h) && /font-src 'self';/.test(h), 'the gate serves the production policy');
  await selfTestBrowser(eq);
  console.log(`✓ look-gate --self-test OK (${n} checks)`);
}

const opts = args(process.argv.slice(2));
if (opts.selfTest) await selfTest();
else await main(opts);
