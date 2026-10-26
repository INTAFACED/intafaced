#!/usr/bin/env node
/**
 * LOOK GATE — renders the kit gallery and every Customer room from their built folders, under the production security
 * headers, and checks what a person would see. No service runs: every `/api/` call answers a typed refusal, so each room
 * shows its honest refuse state, the state every room must have.
 *
 * Each page is opened at a phone (390x844) and a computer (1440x900), with the clock frozen, Math.random seeded, motion
 * reduced and animations stopped, then checked for:
 *   axe          WCAG 2.2 A/AA, serious and critical findings;
 *   contrast     the worst background pixel under every text box (a shot with all text hidden), 4.5:1, or 3:1 for
 *                large text (B4 rules, section 1);
 *   money        a money figure (`[data-slot="money"]`) on a panel less than 80% opaque;
 *   targets      a control smaller than 24x24 px with no 24 px of clear space (WCAG 2.5.8);
 *   focus        a focused control hidden under a `data-obscures` bar (WCAG 2.4.11), over the first 25 tab stops;
 *   csp          any Content-Security-Policy violation (in-page events and report-uri reports);
 *   font         text drawn in a system fallback instead of the web font its font-family names first (a Geist→Arial
 *                swap, a font file that failed to load, a blocked font);
 *   legal        every legal slot (`data-moment` + `data-jurisdiction`): the registry's exact wording, body size, bold
 *                and opaque and pinned to the top for a risk band, 4.5:1, never clipped (policy.mjs `judgeLegal`);
 *   baseline     a pixel difference from `<package>/look-baselines/<room>/<viewport>.png` (no baseline: reported, the
 *                shot is in the artifact to commit with a `Baseline-change:` line).
 * On the phone it also renders right-to-left, at 200% text size and in forced colours, and reports axe, sideways
 * overflow and obscured focus there.
 *
 * Reports for two weeks; then a failure on the kit gallery or on a page drawn in the new look blocks a pull request
 * that changes the kit, a baseline, a legal-slot file or a migrated room (policy.mjs). CI runs main's copy.
 *
 * Not checked yet, said so in every report: the founder console (apps/admin) shots, filled-in states from contract
 * fixtures (rooms show their refuse state), 130% copy.
 *
 *   node tooling/ci/look-gate/look-gate.mjs [--shard 1/4] [--out <dir>] [--only gallery|customer] [--routes /a,/b]
 *        [--update-baselines] [--changed-from origin/main]
 *   node tooling/ci/look-gate/look-gate.mjs --self-test
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, statSync } from 'node:fs';
import http from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { securityHeaders } from '../../../apps/customer/deployment/render-security-headers.mjs';
import { crop, decodePng, encodePng } from './png.mjs';
import * as policy from './policy.mjs';
import { sweepRoutes } from '../../../apps/customer/tests/real-app/routes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const VIEWPORTS = { phone: { width: 390, height: 844 }, computer: { width: 1440, height: 900 } };
const FROZEN = new Date('2026-01-15T12:00:00Z');
const SEED = 20261026;
const REPORT_PATH = '/__csp-report';
const REFUSAL = { code: 'look_gate.no_services', message: 'The look gate renders rooms without services.' };
const REGISTRY_PATH = 'packages/ui/src/lit/templates/legal/registry.json';

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
    else if (a === '--only') out.only = argv[++i];
    else if (a === '--routes') out.routes = argv[++i].split(',');
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
function serve(dir, reports) {
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
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}

const INIT = `(() => {
  Math.random = (${policy.mulberry32.toString()})(${SEED});
  window.__lookCsp = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    window.__lookCsp.push({ directive: e.effectiveDirective, blocked: e.blockedURI, source: e.sourceFile, line: e.lineNumber, sample: e.sample });
  });
})();`;

const FREEZE_CSS = `*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition: none !important; caret-color: transparent !important; }`;
const HIDE_TEXT_CSS = `* { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; text-decoration-color: transparent !important; } ::placeholder { color: transparent !important; }`;

/** Text boxes, money figures, controls, legal slots and font probes, measured in the page. Runs in the browser. */
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
      legal: !!el.closest('[data-moment][data-jurisdiction], [data-legal-slot]'),
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

  const bodySize = parseFloat(getComputedStyle(document.body).fontSize) || 16;
  const legal = [...document.querySelectorAll('[data-moment][data-jurisdiction], [data-legal-slot]')].map((el) => {
    const c = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    let opaqueWhy = '';
    const bg = rgba(c.backgroundColor);
    if (!bg || bg[3] < 1) opaqueWhy = `background ${c.backgroundColor}`;
    if (c.backdropFilter && c.backdropFilter !== 'none') opaqueWhy ||= `backdrop-filter ${c.backdropFilter}`;
    let pinned = null;
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (Number(s.opacity) < 1) opaqueWhy ||= `opacity ${s.opacity} on ${nameOf(n)}`;
      if (n !== el && s.backdropFilter && s.backdropFilter !== 'none') opaqueWhy ||= `backdrop-filter on ${nameOf(n)}`;
      if (!pinned && (s.position === 'sticky' || s.position === 'fixed')) pinned = s;
    }
    return {
      key: el.getAttribute('data-moment') || el.getAttribute('data-legal-slot'),
      jurisdiction: el.getAttribute('data-jurisdiction') || 'uk',
      type: el.getAttribute('data-type') || el.getAttribute('data-legal-slot-type') || '',
      missing: el.hasAttribute('data-missing') || el.getAttribute('data-legal-slot-state') === 'refused',
      text: el.innerText,
      fontSize: parseFloat(c.fontSize),
      fontWeight: Number(c.fontWeight) || 400,
      bold: el.hasAttribute('data-bold') || !!el.querySelector('[data-bold]') || Number(c.fontWeight) >= 700,
      opaque: !opaqueWhy,
      opaqueWhy,
      pinnedTop: !!pinned && parseFloat(pinned.top) <= 1 && r.top <= 1,
      position: pinned?.position ?? c.position,
      top: Math.round(r.top),
      clipped: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1 || r.left < 0 || r.right > innerWidth + 1,
      visible: visible(el),
      rects: [box(r)],
    };
  });

  const declared = [...new Set([...document.fonts].map((f) => f.family.replace(/^['"]|['"]$/g, '')))];
  const lit = !!document.querySelector('[data-look="lit"]');
  return { texts, money, small, legal, bodySize, declared, lit, overflowX: Math.max(0, document.documentElement.scrollWidth - innerWidth) };
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

/** Tab through the first stops; a focused box under a `data-obscures` bar fails. Runs in the browser after each Tab. */
function focusState() {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const r = el.getBoundingClientRect();
  const tops = [...document.querySelectorAll('[data-obscures="top"]')].map((b) => b.getBoundingClientRect().bottom);
  const bottoms = [...document.querySelectorAll('[data-obscures="bottom"]')].map((b) => b.getBoundingClientRect().top);
  const top = Math.max(0, ...tops);
  const bottom = Math.min(innerHeight, ...bottoms);
  const covered = (tops.length || bottoms.length) && (r.top < top - 0.5 || r.bottom > bottom + 0.5) && !el.closest('[data-obscures]');
  return {
    name: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)}"`,
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

/** Which text probes the font check reads: headings, controls, body copy, figures and legal text, a few of each. */
function fontProbes(texts) {
  const picked = [];
  const kinds = new Map();
  texts.forEach((t, i) => {
    const kind = t.legal ? 'legal' : t.name.split(/[.#]/)[0];
    const n = kinds.get(kind) ?? 0;
    if (n < 3) picked.push(i);
    kinds.set(kind, n + 1);
  });
  return picked.slice(0, 40);
}

/** The same start for every page: frozen clock, seeded random, CSP listener, every service call refused. */
async function prepare(page) {
  await page.clock.setFixedTime(FROZEN);
  await page.addInitScript({ content: INIT });
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(REFUSAL) }));
  await page.routeWebSocket(/\/ws(\/|$)/, (ws) => ws.close({ code: 1011, reason: REFUSAL.code }));
}

async function check(context, origin, target, vpName, opts, registry) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) =>
    errors.push(
      String(e.message ?? e)
        .split('\n')[0]
        .slice(0, 160),
    ),
  );
  await prepare(page);
  const row = { target: target.name, viewport: vpName, findings: {}, notes: [] };
  const add = (kind, items) => items.length && (row.findings[kind] = items);
  try {
    await page.goto(origin + target.path, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {});
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

    // legal slots
    const legal = [];
    if (m.legal.length && !registry) row.notes.push(`legal slots present but ${REGISTRY_PATH} is not on this branch`);
    for (const slot of m.legal) {
      // The worst text box inside this slot (text boxes are page coordinates, as is the slot's box).
      const [sb] = slot.rects;
      const inside = m.texts.filter(
        (t) =>
          t.legal &&
          t.rects.some(
            (r) => r.x >= sb.x - 1 && r.y >= sb.y - 1 && r.x + r.width <= sb.x + sb.width + 1 && r.y + r.height <= sb.y + sb.height + 1,
          ),
      );
      slot.contrast = inside.length ? Math.min(...inside.map((t) => worstOf(t).ratio)) : null;
      for (const why of policy.judgeLegal(slot, registry ?? {}, { bodySize: m.bodySize }))
        legal.push(`${slot.key}/${slot.jurisdiction}: ${why}`);
    }
    if (!m.legal.length) row.notes.push('no legal slots on this page');
    add('legal', legal);

    // focus not obscured
    const focus = [];
    if (!target.scope) {
      await page.setViewportSize(viewport);
      for (let i = 0; i < 25; i++) {
        await page.keyboard.press('Tab');
        const f = await page.evaluate(focusState);
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

/** The phone-only variants: right-to-left, 200% text, forced colours. axe, sideways overflow and obscured focus. */
async function variants(browser, origin, target) {
  const out = [];
  for (const [name, setup] of [
    ['rtl', { css: '', attr: true }],
    ['text-200', { css: 'html { font-size: 200% !important; }' }],
    ['forced-colors', { forced: true }],
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
      await prepare(page);
      await page.goto(origin + target.path, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {});
      await page.addStyleTag({ content: FREEZE_CSS });
      if (setup.attr) await page.evaluate(() => document.documentElement.setAttribute('dir', 'rtl'));
      if (setup.css) await page.addStyleTag({ content: setup.css });
      if (!(await settle(page))) row.notes.push('layout still moving after 6 s');
      const { default: AxeBuilder } = await import('@axe-core/playwright');
      const axeBuilder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']);
      if (target.scope) axeBuilder.include(target.scope);
      const axe = await axeBuilder.analyze();
      const serious = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      if (serious.length) row.findings.axe = serious.map((v) => `${v.id} ×${v.nodes.length}`);
      const overflow = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth));
      if (overflow > 0) row.findings.overflow = [`${overflow}px wider than the screen`];
      const focus = [];
      if (!target.scope)
        for (let i = 0; i < 15; i++) {
          await page.keyboard.press('Tab');
          const f = await page.evaluate(focusState);
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

function report(rows, opts, meta) {
  const failing = rows.filter((r) => Object.keys(r.findings).length);
  // A target is drawn in the new look when any of its shots found it so: its variant and error rows count too.
  const litTargets = new Set(rows.filter((r) => r.lit).map((r) => r.target));
  const blockable = failing.filter((r) => r.target.startsWith('kit ') || litTargets.has(r.target) || r.findings.legal);
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
    `Not checked yet: founder console (apps/admin) shots; filled-in states from contract fixtures (rooms show their refuse state); 130% copy. Legal registry: ${meta.registry ? REGISTRY_PATH : 'not on this branch'}.`,
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
  const registry = existsSync(join(ROOT, REGISTRY_PATH)) ? JSON.parse(readFileSync(join(ROOT, REGISTRY_PATH), 'utf8')) : null;
  const reports = [];
  const servers = [];
  const targets = [];
  const browser = await chromium.launch(process.env.LOOK_GATE_CHROMIUM ? { executablePath: process.env.LOOK_GATE_CHROMIUM } : {});

  if (opts.only !== 'customer') {
    if (!existsSync(join(galleryDist, 'index.html')))
      throw new Error(`no kit gallery build in ${galleryDist}: pnpm --filter @intafaced/ui gallery:build`);
    const g = await serve(galleryDist, reports);
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
  if (opts.only !== 'gallery') {
    if (!existsSync(join(customerDist, 'index.html')))
      throw new Error(`no Customer build in ${customerDist}: pnpm turbo run build --filter=@intafaced/customer`);
    const c = await serve(customerDist, reports);
    servers.push(c.server);
    for (const route of opts.routes ?? customerRoutes())
      targets.push({ name: route, origin: c.origin, path: route, room: roomName(route), baselines: 'apps/customer/look-baselines' });
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
        out.push(await check(context, target.origin, target, vpName, opts, registry));
        await context.close();
      }
      out.push(...(await variants(browser, target.origin, target)));
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
  const v = report(rows, opts, { registry: !!registry });
  if (v.mode === 'block') process.exit(1);
}

function selfTest() {
  let n = 0;
  const eq = (got, want, what) => {
    n++;
    if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  };
  const ok = (cond, what) => eq(!!cond, true, what);
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
  // legal
  const registry = {
    'crypto-risk-band': {
      type: 'risk-band',
      uk: {
        status: 'fixed',
        runs: [{ text: 'Don’t invest unless', bold: true }, { text: ' ' }, { text: 'Take 2 mins to learn more', link: true }],
      },
      eu: { status: 'lawyer' },
    },
    'cfd-warning': { type: 'risk-band', uk: { status: 'fixed', runs: [{ text: '{percent}% of retail accounts lose money.' }] } },
  };
  const good = {
    key: 'crypto-risk-band',
    jurisdiction: 'uk',
    type: 'risk-band',
    missing: false,
    text: 'Don’t invest unless  Take 2 mins to learn more',
    fontSize: 16,
    fontWeight: 700,
    bold: true,
    opaque: true,
    pinnedTop: true,
    clipped: false,
    visible: true,
    contrast: 7,
  };
  eq(policy.judgeLegal(good, registry), [], 'a correct risk band passes');
  eq(policy.judgeLegal({ ...good, text: 'Crypto is risky' }, registry).length, 1, 'changed wording fails');
  eq(
    policy.judgeLegal({ ...good, opaque: false, opaqueWhy: 'backdrop-filter blur(20px)' }, registry),
    ['background not opaque: backdrop-filter blur(20px)'],
    'glass band fails',
  );
  eq(policy.judgeLegal({ ...good, bold: false }, registry).length, 1, 'not bold fails');
  eq(policy.judgeLegal({ ...good, pinnedTop: false }, registry).length, 1, 'scrolls away fails');
  eq(policy.judgeLegal({ ...good, fontSize: 12 }, registry).length, 1, 'small print fails');
  eq(policy.judgeLegal({ ...good, contrast: 3.1 }, registry).length, 1, 'low contrast fails');
  eq(policy.judgeLegal({ ...good, clipped: true }, registry), ['clipped'], 'clipped fails');
  eq(policy.judgeLegal({ ...good, jurisdiction: 'eu' }, registry).length, 1, 'a lawyer wording drawn as text fails');
  eq(
    policy.judgeLegal({ ...good, jurisdiction: 'eu', missing: true, text: 'Wording pending' }, registry),
    [],
    'its designed refusal passes',
  );
  eq(
    policy.judgeLegal({ ...good, key: 'cfd-warning', text: '74% of retail accounts lose money.' }, registry),
    [],
    'a filled placeholder passes',
  );
  eq(
    policy.judgeLegal({ ...good, key: 'cfd-warning', text: '% of retail accounts lose money.' }, registry).length,
    1,
    'an empty placeholder fails',
  );
  eq(policy.judgeLegal({ ...good, key: 'made-up' }, registry), ['no registry entry "made-up"'], 'unknown moment fails');
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
  eq(roomName('/trade/spot/BTC-USDT'), 'trade-spot-btc-usdt', 'route room');
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
  console.log(`✓ look-gate --self-test OK (${n} checks)`);
}

const opts = args(process.argv.slice(2));
if (opts.selfTest) selfTest();
else await main(opts);
