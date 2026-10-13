#!/usr/bin/env node
// Customer-app redesign: end-to-end screenshot and assertion harness (UI-SPEC 7.4).
//
//   node tooling/scripts/redesign-shots.mjs --milestone M1|M2|M3 \
//     --base http://127.0.0.1:3210 --out <dir> --refs <redesign-refs.json>
//
// Safety:
//  - Only ever talks to http(s)://127.0.0.1 (the local test stack). Anything else exits 2 before a browser starts.
//  - Test credentials are read from ~/.intafaced/local-test-stack/world-accounts.json at run time, are typed into
//    the sign-in form only, and are never printed, logged or written to report.json.
//  - Reference images (OKX / Robinhood) are read from the evidence folder and composed OUTSIDE the repo: an --out
//    directory inside this repository is refused.
//  - Stub flows (M2/M3) never place orders or move money; they skip with a message.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');

// ---------------------------------------------------------------------------------------------
// Constants (spec 7.4)
// ---------------------------------------------------------------------------------------------
export const MILESTONES = ['M1', 'M2', 'M3'];
export const ALLOWED_HOST = '127.0.0.1';
export const DEFAULT_BASE = 'http://127.0.0.1:3210';
export const REQUEST_BUDGET_PER_MIN = 120;
export const OURS_LABEL = 'INTAFACED (local test)';
export const CAPTURE_DATE = '2026-10-13';
export const BANNED_WORDS_SOURCE = 'unavailable|not connected|restricted|fixture|lifecycle';
export const BANNED_WORDS_RE = new RegExp(BANNED_WORDS_SOURCE, 'i');
// Exactly the expression in spec 7.4 step 2 (U+2212 minus sign, U+2014 em dash, U+2022 bullets).
export const MONEY_RE = /^[−+]?[$]?[\d,]+(\.\d+)?[%A-Z ]*$|^—$|^••••$/;
export const LIME_RGB = [200, 246, 74]; // #C8F64A
export const VIEWPORTS = {
  desktopFirst: { width: 1440, height: 900, name: '1440x900' },
  laptop: { width: 1280, height: 800, name: '1280x800' },
  phone: { width: 390, height: 844, name: '390x844' },
};
const STEP_KEYS = new Set([
  'press',
  'repeat',
  'tabTo',
  'max',
  'focus',
  'focusLast',
  'mark',
  'expect',
  'expectVisible',
  'expectHidden',
  'expectFocusWithin',
  'expectFocusOnMark',
  'note',
]);
const MATCHER_KEYS = new Set(['name', 'href', 'within', 'tag', 'role', 'lime', 'outline']);

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

// ---------------------------------------------------------------------------------------------
// Arguments and guards
// ---------------------------------------------------------------------------------------------
export const USAGE = `Usage: node tooling/scripts/redesign-shots.mjs --milestone M1|M2|M3 --base ${DEFAULT_BASE} --out <dir> --refs <redesign-refs.json>
Options:
  --milestone  M1, M2 or M3 (required)
  --base       local app origin; must be http(s)://127.0.0.1[:port] (default ${DEFAULT_BASE})
  --out        output directory, outside this repository (required)
  --refs       redesign-refs.json: route -> reference images and keyboard paths (required)
  --account    key in world-accounts.json to sign in as (default: first non-"friend" account, else "friend")
  --only       comma list of route ids to run (debugging)
  --idle-seconds  idle window for the request-count check (default 60; the limit scales with it)
  --help
`;

export function parseArgs(argv) {
  const known = new Set(['milestone', 'base', 'out', 'refs', 'account', 'only', 'idle-seconds', 'help']);
  const raw = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new UsageError(`Unexpected argument "${token}".`);
    let key = token.slice(2);
    let value;
    const eq = key.indexOf('=');
    if (eq !== -1) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    if (!known.has(key)) throw new UsageError(`Unknown option --${key}.`);
    if (key === 'help') {
      raw.help = true;
      continue;
    }
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`Option --${key} needs a value.`);
    }
    raw[key] = value;
  }
  if (raw.help) return { help: true };
  const milestone = String(raw.milestone ?? '').toUpperCase();
  if (!MILESTONES.includes(milestone)) throw new UsageError('--milestone must be M1, M2 or M3.');
  if (!raw.out) throw new UsageError('--out <dir> is required.');
  if (!raw.refs) throw new UsageError('--refs <redesign-refs.json> is required.');
  const idleSeconds = raw['idle-seconds'] === undefined ? 60 : Number(raw['idle-seconds']);
  if (!Number.isInteger(idleSeconds) || idleSeconds < 5 || idleSeconds > 600) {
    throw new UsageError('--idle-seconds must be a whole number from 5 to 600.');
  }
  return {
    help: false,
    milestone,
    base: assertLoopbackBase(raw.base ?? DEFAULT_BASE),
    out: resolve(raw.out),
    refs: resolve(raw.refs),
    account: raw.account ?? null,
    only: raw.only
      ? raw.only
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : null,
    idleSeconds,
  };
}

/** Returns the normalised origin, or throws. Only the literal host 127.0.0.1 is allowed. */
export function assertLoopbackBase(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new UsageError(`--base is not a URL: "${raw}".`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UsageError(`Refusing --base ${url.protocol}// : only http or https on 127.0.0.1.`);
  }
  if (url.hostname !== ALLOWED_HOST) {
    throw new UsageError(
      `Refusing to run against host "${url.hostname}". This harness only runs against ${ALLOWED_HOST} (the local test stack).`,
    );
  }
  if (url.username || url.password) throw new UsageError('Refusing --base with credentials in the URL.');
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new UsageError('--base must be an origin only, for example http://127.0.0.1:3210.');
  }
  return url.origin;
}

/** True when `dir` is the repository root or inside it (reference images must never land in the repo). */
export function isInsideRepo(dir, repoRoot = REPO_ROOT) {
  const a = resolve(dir);
  const b = resolve(repoRoot);
  return a === b || a.startsWith(b + sep);
}

export function isLoopbackUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return true;
    return u.hostname === ALLOWED_HOST;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Pure checks
// ---------------------------------------------------------------------------------------------
export function findBannedWords(text) {
  const out = [];
  const re = new RegExp(BANNED_WORDS_SOURCE, 'gi');
  let m;
  while ((m = re.exec(text ?? '')) !== null) {
    const from = Math.max(0, m.index - 30);
    out.push({
      word: m[0],
      context: text
        .slice(from, m.index + m[0].length + 30)
        .replace(/\s+/g, ' ')
        .trim(),
    });
  }
  return out;
}

export function isMoneyFormat(text) {
  return MONEY_RE.test(
    String(text ?? '')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

export function requestLimitFor(idleSeconds) {
  return Math.ceil((REQUEST_BUDGET_PER_MIN * idleSeconds) / 60);
}

export function referenceLabel(ref) {
  const when = ref.source ? ref.source : `captured ${ref.captured ?? CAPTURE_DATE}`;
  return `Reference: ${ref.vendor}, ${when}`;
}

/** Compare a location with an expected "to" (path must match; query params named in `to` must match). */
export function locationMatches(actual, expected) {
  const a = new URL(actual, 'http://x');
  const e = new URL(expected, 'http://x');
  if (a.pathname !== e.pathname) return false;
  for (const [k, v] of e.searchParams) if (a.searchParams.get(k) !== v) return false;
  return true;
}

function parseRgbs(text) {
  const out = [];
  const re = /rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)(?:[ ,/]+([\d.]+))?\s*\)/g;
  let m;
  while ((m = re.exec(text ?? '')) !== null) {
    out.push({ r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] });
  }
  return out;
}

export function hasLimeColor(text, tolerance = 24) {
  return parseRgbs(text).some(
    (c) =>
      c.a > 0 &&
      Math.abs(c.r - LIME_RGB[0]) <= tolerance &&
      Math.abs(c.g - LIME_RGB[1]) <= tolerance &&
      Math.abs(c.b - LIME_RGB[2]) <= tolerance,
  );
}

/** Pure matcher: does the focused element described by `info` satisfy matcher `m`? */
export function matchFocus(info, m = {}) {
  const reasons = [];
  if (!info || info.none) return { ok: false, reasons: ['nothing has focus'] };
  if (m.name !== undefined && !new RegExp(m.name, 'i').test(info.name ?? ''))
    reasons.push(`name "${info.name}" does not match /${m.name}/i`);
  if (m.href !== undefined && !new RegExp(m.href).test(info.href ?? ''))
    reasons.push(`href "${info.href ?? ''}" does not match /${m.href}/`);
  if (m.tag !== undefined && String(info.tag).toLowerCase() !== String(m.tag).toLowerCase())
    reasons.push(`tag ${info.tag} is not ${m.tag}`);
  if (m.role !== undefined && info.role !== m.role) reasons.push(`role "${info.role}" is not "${m.role}"`);
  if (m.within !== undefined && !info.within) reasons.push(`not inside ${m.within}`);
  if (m.outline !== false && !info.outlineVisible) reasons.push('no visible focus outline');
  if (m.lime && !info.limeOk) reasons.push('focus outline is not lime');
  return { ok: reasons.length === 0, reasons };
}

function checkMatcher(m, where, problems) {
  if (!m || typeof m !== 'object') return problems.push(`${where}: matcher must be an object`);
  for (const k of Object.keys(m)) if (!MATCHER_KEYS.has(k)) problems.push(`${where}: unknown matcher key "${k}"`);
  for (const k of ['name', 'href']) {
    if (m[k] === undefined) continue;
    try {
      new RegExp(m[k]);
    } catch {
      problems.push(`${where}: ${k} is not a valid regular expression`);
    }
  }
}

export function validateKeyboardSteps(steps, where = 'keyboard') {
  const problems = [];
  if (steps === null || steps === undefined) return problems;
  if (!Array.isArray(steps)) return [`${where}: must be an array or null`];
  steps.forEach((step, i) => {
    const w = `${where}[${i}]`;
    if (!step || typeof step !== 'object') return problems.push(`${w}: step must be an object`);
    for (const k of Object.keys(step)) if (!STEP_KEYS.has(k)) problems.push(`${w}: unknown key "${k}"`);
    const actions = ['press', 'tabTo', 'focus', 'focusLast', 'mark'].filter((k) => step[k] !== undefined);
    if (actions.length !== 1) problems.push(`${w}: needs exactly one of press, tabTo, focus, focusLast, mark`);
    if (step.press !== undefined && typeof step.press !== 'string') problems.push(`${w}: press must be a key name`);
    if (step.repeat !== undefined && !(Number.isInteger(step.repeat) && step.repeat >= 1 && step.repeat <= 50))
      problems.push(`${w}: repeat must be 1..50`);
    if (step.max !== undefined && !(Number.isInteger(step.max) && step.max >= 1 && step.max <= 100))
      problems.push(`${w}: max must be 1..100`);
    if (step.tabTo !== undefined) checkMatcher(step.tabTo, `${w}.tabTo`, problems);
    if (step.expect !== undefined) checkMatcher(step.expect, `${w}.expect`, problems);
  });
  return problems;
}

export function validateRefs(refs) {
  const problems = [];
  if (!refs || typeof refs !== 'object') return ['refs: not an object'];
  if (refs.version !== 1) problems.push('refs.version must be 1');
  if (!Array.isArray(refs.routes) || refs.routes.length === 0) return [...problems, 'refs.routes must be a non-empty array'];
  const ids = new Set();
  for (const r of refs.routes) {
    const w = `route "${r?.id}"`;
    if (!r || typeof r.id !== 'string' || !/^[a-z0-9-]+$/.test(r.id)) {
      problems.push(`${w}: id must be lowercase letters, digits, dashes`);
      continue;
    }
    if (ids.has(r.id)) problems.push(`${w}: duplicate id`);
    ids.add(r.id);
    if (!MILESTONES.includes(r.milestone)) problems.push(`${w}: milestone must be M1, M2 or M3`);
    if (typeof r.path !== 'string' || !r.path.startsWith('/')) problems.push(`${w}: path must start with /`);
    if (!Array.isArray(r.references)) problems.push(`${w}: references must be an array (may be empty)`);
    for (const ref of r.references ?? []) {
      if (!['OKX', 'Robinhood'].includes(ref.vendor)) problems.push(`${w}: reference vendor must be OKX or Robinhood`);
      for (const k of ['image', 'full']) {
        if (ref[k] !== undefined && !isAbsolute(ref[k])) problems.push(`${w}: reference ${k} must be an absolute path`);
      }
      if (typeof ref.image !== 'string') problems.push(`${w}: reference needs an image`);
    }
    problems.push(...validateKeyboardSteps(r.keyboard, `${w} keyboard`));
    for (const phase of ['setup', 'teardown']) {
      for (const s of r[phase] ?? []) if (!s?.click?.name) problems.push(`${w}: ${phase} steps must be {click:{name}}`);
    }
  }
  for (const d of refs.redirects ?? []) {
    if (!MILESTONES.includes(d.milestone) || !String(d.from).startsWith('/') || !String(d.to).startsWith('/')) {
      problems.push(`redirect ${JSON.stringify(d)}: needs milestone, from and to paths`);
    }
  }
  return problems;
}

export function missingReferenceFiles(refs, fileExists = existsSync) {
  const missing = [];
  for (const r of refs.routes) {
    for (const ref of r.references ?? []) {
      for (const k of ['image', 'full']) if (ref[k] && !fileExists(ref[k])) missing.push({ route: r.id, path: ref[k] });
    }
  }
  return missing;
}

// ---------------------------------------------------------------------------------------------
// Credentials (never printed)
// ---------------------------------------------------------------------------------------------
export function pickAccount(file, wanted) {
  const entries = Object.entries(file ?? {}).filter(([, v]) => v && typeof v === 'object' && v.email && v.password);
  if (entries.length === 0) throw new UsageError('world-accounts.json has no account with an email and password.');
  if (wanted) {
    const hit = entries.find(([k]) => k === wanted);
    if (!hit) throw new UsageError(`No account "${wanted}" in world-accounts.json (have: ${entries.map(([k]) => k).join(', ')}).`);
    return { key: hit[0], email: hit[1].email, password: hit[1].password };
  }
  const preferred = entries.find(([k]) => k !== 'friend') ?? entries[0];
  return { key: preferred[0], email: preferred[1].email, password: preferred[1].password };
}

export function loadAccount(wanted, home = homedir()) {
  const path = join(home, '.intafaced', 'local-test-stack', 'world-accounts.json');
  if (!existsSync(path)) throw new UsageError(`Test accounts file not found: ${path}. Run the local world seed first.`);
  return pickAccount(JSON.parse(readFileSync(path, 'utf8')), wanted);
}

// ---------------------------------------------------------------------------------------------
// Side-by-side composer
// ---------------------------------------------------------------------------------------------
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function toDataUrl(path) {
  const mime = MIME[extname(path).toLowerCase()];
  if (!mime) throw new Error(`Unsupported image type: ${path}`);
  return `data:${mime};base64,${readFileSync(path).toString('base64')}`;
}

/** Ours on the left, reference on the right, both scaled to `width` px wide, each under a label bar. */
export function buildComposerHtml({
  oursSrc,
  refSrc,
  oursLabel = OURS_LABEL,
  refLabel,
  width = 1440,
  gap = 16,
  labelHeight = 48,
  maxHeight = 2400,
}) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#0b0c0e;font:600 20px/1 -apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;color:#f2f3f5}
.row{display:flex;gap:${gap}px;align-items:flex-start;width:${width * 2 + gap}px}
.col{width:${width}px;flex:none}
.label{height:${labelHeight}px;line-height:${labelHeight}px;padding:0 20px;box-sizing:border-box;background:#17181c;border-bottom:2px solid #C8F64A;white-space:nowrap;overflow:hidden}
.col.ref .label{border-bottom-color:#6b6f78}
.frame{width:${width}px;max-height:${maxHeight}px;overflow:hidden;background:#000}
.frame img{display:block;width:${width}px;height:auto}
</style></head><body><div class="row">
<div class="col ours"><div class="label" data-side="ours">${escapeHtml(oursLabel)}</div><div class="frame"><img alt="" src="${oursSrc}"></div></div>
<div class="col ref"><div class="label" data-side="ref">${escapeHtml(refLabel)}</div><div class="frame"><img alt="" src="${refSrc}"></div></div>
</div></body></html>`;
}

export async function composeSideBySide(
  browser,
  { oursPath, refPath, outPath, refLabel, oursLabel = OURS_LABEL, maxHeight = 2400, width = 1440, gap = 16 },
) {
  const html = buildComposerHtml({ oursSrc: toDataUrl(oursPath), refSrc: toDataUrl(refPath), oursLabel, refLabel, width, gap, maxHeight });
  const context = await browser.newContext({ viewport: { width: width * 2 + gap, height: 900 } });
  try {
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => Promise.all([...document.images].map((img) => img.decode().catch(() => undefined))));
    mkdirSync(dirname(outPath), { recursive: true });
    await page.screenshot({ path: outPath, fullPage: true, animations: 'disabled' });
  } finally {
    await context.close();
  }
  return outPath;
}

// ---------------------------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------------------------
export function findChromiumExecutable({
  env = process.env,
  home = homedir(),
  listDir = (d) => {
    try {
      return readdirSync(d);
    } catch {
      return [];
    }
  },
  isFile = (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
} = {}) {
  const roots = [
    env.PLAYWRIGHT_BROWSERS_PATH,
    join(home, 'Library', 'Caches', 'ms-playwright'),
    join(home, '.cache', 'ms-playwright'),
  ].filter(Boolean);
  const byRevision = (re) => (a, b) => Number(b.match(re)[1]) - Number(a.match(re)[1]);
  const shell = [
    'chrome-headless-shell-mac-arm64/chrome-headless-shell',
    'chrome-headless-shell-mac-x64/chrome-headless-shell',
    'chrome-headless-shell-linux64/chrome-headless-shell',
    'chrome-headless-shell-win64/chrome-headless-shell.exe',
  ];
  const full = [
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-linux64/chrome',
    'chrome-win64/chrome.exe',
  ];
  for (const root of roots) {
    const names = listDir(root);
    const groups = [
      [names.filter((n) => /^chromium_headless_shell-\d+$/.test(n)).sort(byRevision(/-(\d+)$/)), shell],
      [names.filter((n) => /^chromium-\d+$/.test(n)).sort(byRevision(/-(\d+)$/)), full],
    ];
    for (const [dirs, rels] of groups) {
      for (const d of dirs) for (const rel of rels) if (isFile(join(root, d, ...rel.split('/')))) return join(root, d, ...rel.split('/'));
    }
  }
  return undefined;
}

export async function launchBrowser(chromium) {
  try {
    return await chromium.launch();
  } catch (error) {
    if (!/Executable doesn't exist|browserType\.launch/.test(String(error?.message))) throw error;
    const executablePath = findChromiumExecutable();
    if (!executablePath) {
      throw new Error(
        "No Chromium found for Playwright. Install one with 'pnpm exec playwright install chromium' (the harness never installs anything itself).",
      );
    }
    return chromium.launch({ executablePath });
  }
}

// ---------------------------------------------------------------------------------------------
// In-page helpers
// ---------------------------------------------------------------------------------------------
async function spaNavigate(page, path) {
  // A full reload signs you out (session lives in memory), so navigate with the app's own router contract.
  await page.evaluate((p) => {
    history.pushState(null, '', p);
    window.dispatchEvent(new PopStateEvent('popstate'));
    window.scrollTo(0, 0);
  }, path);
}

async function settle(page, state, { quietMs = 700, maxMs = 10000 } = {}) {
  const start = Date.now();
  let lastBusy = Date.now();
  while (Date.now() - start < maxMs) {
    if (state.inflight > 0) lastBusy = Date.now();
    else if (Date.now() - lastBusy >= quietMs) break;
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(250);
}

async function focusInfo(page, within) {
  return page.evaluate((withinSelector) => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return { none: true };
    const cs = getComputedStyle(el);
    const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
    let name = el.getAttribute('aria-label');
    if (!name) {
      const ids = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
      name = ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    }
    if (!clean(name)) {
      // Accessible name from content: decorative parts (aria-hidden, e.g. a "$" glyph or an arrow) do not count.
      const copy = el.cloneNode(true);
      if (copy.querySelectorAll) copy.querySelectorAll('[aria-hidden="true"]').forEach((node) => node.remove());
      const parts = [];
      const walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) parts.push(walker.currentNode.textContent ?? '');
      name = parts.join(' ') || el.getAttribute('title') || el.getAttribute('alt') || el.value || el.getAttribute('placeholder') || '';
    }
    const anchor = el.closest('a[href]');
    const outlineVisible =
      (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 && !/rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)/.test(cs.outlineColor)) ||
      (cs.boxShadow !== 'none' && !/^rgba\(0, 0, 0, 0\)/.test(cs.boxShadow));
    return {
      tag: el.tagName,
      role: el.getAttribute('role') ?? '',
      name: clean(name),
      href: anchor ? anchor.getAttribute('href') : (el.getAttribute('href') ?? null),
      within: withinSelector ? el.closest(withinSelector) !== null : true,
      outlineVisible,
      colors: `${cs.outlineStyle !== 'none' ? cs.outlineColor : ''} ${cs.boxShadow}`,
    };
  }, within ?? null);
}

export async function runKeyboard(page, steps) {
  const log = [];
  const check = async (matcher, label) => {
    const info = await focusInfo(page, matcher.within);
    info.limeOk = hasLimeColor(info.colors);
    const result = matchFocus(info, matcher);
    log.push(
      `${label}: ${info.none ? '(nothing focused)' : `${info.tag.toLowerCase()} "${(info.name ?? '').slice(0, 40)}"`}${result.ok ? '' : ' !! ' + result.reasons.join('; ')}`,
    );
    return result;
  };
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.activeElement?.blur?.();
  });
  for (const [i, step] of steps.entries()) {
    const label = `step ${i + 1}`;
    if (step.focus !== undefined || step.focusLast !== undefined) {
      const loc = page.locator(step.focus ?? step.focusLast);
      const target = step.focus !== undefined ? loc.first() : loc.last();
      if ((await loc.count()) === 0) return { ok: false, detail: `${label}: nothing matches ${step.focus ?? step.focusLast}`, log };
      await target.focus();
      log.push(`${label}: focused ${step.focus ?? step.focusLast}`);
      continue;
    }
    if (step.mark) {
      await page.evaluate(() => {
        window.__shotsMark = document.activeElement;
      });
      log.push(`${label}: marked focused element`);
      continue;
    }
    if (step.tabTo) {
      const max = step.max ?? 10;
      let found = false;
      for (let n = 1; n <= max; n++) {
        await page.keyboard.press('Tab');
        await page.waitForTimeout(60);
        const info = await focusInfo(page, step.tabTo.within);
        info.limeOk = hasLimeColor(info.colors);
        if (matchFocus(info, { ...step.tabTo, outline: false }).ok) {
          log.push(`${label}: reached "${(info.name ?? '').slice(0, 40)}" after ${n} Tab`);
          const strict = matchFocus(info, step.tabTo);
          if (!strict.ok) return { ok: false, detail: `${label}: reached the element but ${strict.reasons.join('; ')}`, log };
          found = true;
          break;
        }
      }
      if (!found) return { ok: false, detail: `${label}: did not reach ${JSON.stringify(step.tabTo)} within ${max} Tab presses`, log };
      continue;
    }
    if (step.press) {
      const times = step.repeat ?? 1;
      for (let n = 1; n <= times; n++) {
        await page.keyboard.press(step.press);
        await page.waitForTimeout(80);
        if (step.expect) {
          const r = await check(step.expect, `${label}${times > 1 ? `.${n}` : ''} ${step.press}`);
          if (!r.ok) return { ok: false, detail: `${label} (${step.press}${times > 1 ? ` #${n}` : ''}): ${r.reasons.join('; ')}`, log };
        }
        if (step.expectFocusWithin) {
          const info = await focusInfo(page, step.expectFocusWithin);
          if (!info.within || info.none) return { ok: false, detail: `${label}: focus left ${step.expectFocusWithin}`, log };
        }
      }
      try {
        if (step.expectVisible) await page.locator(step.expectVisible).first().waitFor({ state: 'visible', timeout: 2000 });
        if (step.expectHidden) await page.locator(step.expectHidden).first().waitFor({ state: 'hidden', timeout: 2000 });
      } catch {
        return {
          ok: false,
          detail: `${label}: after ${step.press}, expected ${step.expectVisible ? 'visible ' + step.expectVisible : 'hidden ' + step.expectHidden}`,
          log,
        };
      }
      if (step.expectFocusOnMark) {
        const same = await page.evaluate(() => window.__shotsMark && document.activeElement === window.__shotsMark);
        if (!same) return { ok: false, detail: `${label}: focus did not return to the marked element`, log };
      }
    }
  }
  return { ok: true, detail: `${steps.length} steps`, log };
}

export async function pageChecks(page) {
  return page.evaluate(() => {
    const main = document.querySelector('main, [role="main"]');
    const overflow = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0) - document.documentElement.clientWidth;
    const money = [...document.querySelectorAll('[data-money]')]
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim());
    return {
      hasMain: Boolean(main),
      mainText: main ? main.innerText : '',
      overflow,
      money,
      notFound: /page not found/i.test((main ? main.innerText : document.body.innerText).slice(0, 400)),
      pathname: location.pathname + location.search,
      title: document.title,
    };
  });
}

async function clickByName(page, step) {
  const { role, name, alt } = step.click;
  const re = new RegExp(name, 'i');
  const candidates = [page.getByRole(role ?? 'button', { name: re })];
  if (alt) candidates.push(page.locator(alt).filter({ hasText: re }));
  for (const c of candidates) {
    if ((await c.count()) > 0) {
      await c.first().click({ timeout: 3000 });
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------
function makeState() {
  return { inflight: 0, counting: false, count: 0, console: [], fiveXX: [], fourXX: [], external: [], wsAbsent: 0 };
}

function resetCollectors(state) {
  state.console = [];
  state.fiveXX = [];
  state.fourXX = [];
  state.wsAbsent = 0;
}

async function signIn(page, base, account) {
  await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[name="identifier"], input[autocomplete="username"]').first().fill(account.email);
  await page.locator('input[name="password"], input[type="password"]').first().fill(account.password);
  await page.locator('button[type="submit"]').first().click();
  try {
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
  } catch {
    throw new Error('Sign-in did not complete (still on /login after 20 s). Is the local stack running with the world seeded?');
  }
}

async function runRoute(ctx, route) {
  const { page, state, opts, shotsDir } = ctx;
  const rec = {
    id: route.id,
    path: route.path,
    title: route.title,
    spec: route.spec,
    provisionalKeyboard: Boolean(route.provisional),
    assertions: [],
    screenshots: {},
    sideBySide: [],
    finalUrl: null,
  };
  const add = (name, status, detail = '', extra = {}) => rec.assertions.push({ name, status, detail, ...extra });
  const skipped = new Set(route.skipChecks ?? []);
  const dir = join(shotsDir, route.id);
  mkdirSync(dir, { recursive: true });
  resetCollectors(state);
  try {
    await page.setViewportSize({ width: VIEWPORTS.desktopFirst.width, height: VIEWPORTS.desktopFirst.height });
    await spaNavigate(page, route.path);
    await settle(page, state);
    for (const step of route.setup ?? []) {
      const ok = await clickByName(page, step);
      if (!ok) add('route-setup', 'fail', `could not find control ${JSON.stringify(step.click.name)}`);
      await settle(page, state);
    }
    const first = await pageChecks(page);
    rec.finalUrl = first.pathname;
    if (first.pathname.startsWith('/login')) throw new Error('signed out: the app sent the page to /login');
    add('landed-on-route', locationMatches(first.pathname, route.path) ? 'pass' : 'fail', `final location ${first.pathname}`);

    // 1440 x 900 first screen, then 1440 full page
    const file1 = join(dir, `${VIEWPORTS.desktopFirst.name}-first.png`);
    await page.screenshot({ path: file1, animations: 'disabled' });
    const file2 = join(dir, '1440-full.png');
    await page.screenshot({ path: file2, fullPage: true, animations: 'disabled' });
    rec.screenshots.first1440 = file1;
    rec.screenshots.full1440 = file2;

    // text assertions at 1440
    add(
      'not-a-404',
      first.notFound ? 'fail' : 'pass',
      first.notFound ? 'the screen shows "Page not found": this route does not exist on this build' : '',
    );
    add('main-landmark', first.hasMain ? 'pass' : 'fail', first.hasMain ? '' : 'no <main> element: banned-words cannot be scoped');
    if (skipped.has('banned-words')) add('banned-words', 'skip', route.skipReason ?? 'skipped by refs');
    else if (!first.hasMain) add('banned-words', 'fail', 'no <main> to scan');
    else {
      const hits = findBannedWords(first.mainText);
      add(
        'banned-words',
        hits.length ? 'fail' : 'pass',
        hits.length ? `${hits.length} hit(s), e.g. "${hits[0].context}"` : '',
        hits.length ? { hits: hits.slice(0, 5) } : {},
      );
    }
    if (route.expectMoney) {
      const bad = first.money.filter((t) => !isMoneyFormat(t));
      if (first.money.length === 0) add('money-format', 'fail', 'no visible [data-money] elements found on this screen');
      else
        add(
          'money-format',
          bad.length ? 'fail' : 'pass',
          bad.length
            ? `${bad.length} of ${first.money.length} [data-money] values do not match, e.g. "${bad[0]}"`
            : `${first.money.length} values ok`,
          bad.length ? { bad: bad.slice(0, 5) } : {},
        );
    } else {
      const bad = first.money.filter((t) => !isMoneyFormat(t));
      add(
        'money-format',
        first.money.length === 0 ? 'skip' : bad.length ? 'fail' : 'pass',
        first.money.length === 0 ? 'no [data-money] on this screen' : bad.length ? `e.g. "${bad[0]}"` : `${first.money.length} values ok`,
      );
    }

    // idle request count at 1440
    await page.waitForTimeout(500);
    state.count = 0;
    state.counting = true;
    await page.waitForTimeout(opts.idleSeconds * 1000);
    state.counting = false;
    const limit = requestLimitFor(opts.idleSeconds);
    add(
      'request-count-idle',
      state.count <= limit ? 'pass' : 'fail',
      `${state.count} requests in ${opts.idleSeconds} s idle (limit ${limit})`,
      { count: state.count, limit, seconds: opts.idleSeconds },
    );

    // 1280 x 800
    await page.setViewportSize({ width: VIEWPORTS.laptop.width, height: VIEWPORTS.laptop.height });
    await settle(page, state, { quietMs: 400, maxMs: 4000 });
    const laptop = await pageChecks(page);
    const file3 = join(dir, `${VIEWPORTS.laptop.name}-first.png`);
    await page.screenshot({ path: file3, animations: 'disabled' });
    rec.screenshots.first1280 = file3;
    add(
      'no-horizontal-scroll@1280',
      laptop.overflow <= 1 ? 'pass' : 'fail',
      laptop.overflow > 1 ? `page is ${laptop.overflow}px wider than the window` : '',
    );

    // 390 x 844 full page
    await page.setViewportSize({ width: VIEWPORTS.phone.width, height: VIEWPORTS.phone.height });
    await settle(page, state, { quietMs: 400, maxMs: 4000 });
    const phone = await pageChecks(page);
    const file4 = join(dir, `${VIEWPORTS.phone.name}-full.png`);
    await page.screenshot({ path: file4, fullPage: true, animations: 'disabled' });
    rec.screenshots.full390 = file4;
    add(
      'no-horizontal-scroll@390',
      phone.overflow <= 1 ? 'pass' : 'fail',
      phone.overflow > 1 ? `page is ${phone.overflow}px wider than the window` : '',
    );

    // keyboard path at 1440
    await page.setViewportSize({ width: VIEWPORTS.desktopFirst.width, height: VIEWPORTS.desktopFirst.height });
    await page.waitForTimeout(300);
    if (skipped.has('keyboard-path')) add('keyboard-path', 'skip', route.skipReason ?? 'skipped by refs');
    else if (!route.keyboard || route.keyboard.length === 0)
      add('keyboard-path', 'skip', 'no keyboard sequence listed for this screen in refs');
    else {
      const result = await runKeyboard(page, route.keyboard);
      add('keyboard-path', result.ok ? 'pass' : 'fail', result.ok ? result.detail : result.detail, {
        log: result.log,
        provisional: Boolean(route.provisional),
      });
      await page.keyboard.press('Escape').catch(() => undefined);
    }

    for (const step of route.teardown ?? []) await clickByName(page, step).catch(() => false);
  } catch (error) {
    add('route-load', 'fail', String(error?.message ?? error).split('\n')[0]);
  } finally {
    state.counting = false;
  }

  const errs = state.console.filter((m) => !m.blocked);
  add(
    'console-errors',
    errs.length ? 'fail' : 'pass',
    errs.length ? `${errs.length} error(s), e.g. ${errs[0].text.slice(0, 160)}` : '',
    errs.length ? { samples: errs.slice(0, 5).map((e) => e.text.slice(0, 300)) } : {},
  );
  add(
    'no-5xx',
    state.fiveXX.length ? 'fail' : 'pass',
    state.fiveXX.length ? `${state.fiveXX.length} response(s), e.g. ${state.fiveXX[0]}` : '',
    state.fiveXX.length ? { samples: state.fiveXX.slice(0, 5) } : {},
  );
  if (state.fourXX.length) rec.info4xx = state.fourXX.slice(0, 10);
  if (state.wsAbsent)
    rec.infoWsAbsent = `${state.wsAbsent} WebSocket handshake(s) answered 503: the local test stack has no WebSocket service`;
  return rec;
}

async function runRedirect(ctx, d) {
  const { page, state } = ctx;
  const result = { from: d.from, to: d.to, status: 'fail', detail: '' };
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await spaNavigate(page, d.from);
    await settle(page, state, { quietMs: 400, maxMs: 5000 });
    const where = await page.evaluate(() => location.pathname + location.search);
    result.actual = where;
    result.status = locationMatches(where, d.to) ? 'pass' : 'fail';
    result.detail = result.status === 'pass' ? '' : `landed on ${where}`;
  } catch (error) {
    result.detail = String(error?.message ?? error).split('\n')[0];
  }
  return result;
}

// Flow stubs: M2/M3 flows move money (orders, conversions, transfers) so they stay stubs until their screens
// exist and an Opus reviewer has passed the money path. Each stub reports whether its entry screen exists yet.
export const FLOWS = {
  M1: [
    {
      // Critic H3: a link with a "#" used to be handed to the browser, which reloaded the page and dropped the
      // in-memory sign-in. Real flow, no money moves: a marker on window survives only if there was no reload.
      id: 'home-rows-stay-signed-in',
      title: 'Cash and Crypto rows open Money without a reload',
      kind: 'noReload',
      path: '/home',
      click: '.home-holdings__row',
      expectPath: '/money',
    },
  ],
  M2: [
    {
      id: 'limit-buy-cancel-btc-usdt',
      title: 'Limit buy and cancel on BTC-USDT',
      needs: 'Pro desk (B7)',
      probe: { path: '/trade/spot/BTC-USDT', role: 'button', name: '^Buy BTC$' },
    },
    {
      id: 'convert',
      title: 'Convert',
      needs: 'Convert (B8)',
      probe: { path: '/trade/convert', role: 'button', name: '^Preview conversion$' },
    },
    {
      id: 'simple-buy',
      title: 'Buy (only if the spread stand-in is set)',
      needs: 'Simple Buy (B8)',
      probe: { path: '/trade/buy?asset=BTC&side=buy', role: 'button', name: '^Review (buy|sell)$' },
    },
    {
      id: 'activity-shows-fill',
      title: 'Activity shows the fill',
      needs: 'Money activity (B9)',
      probe: { path: '/money/activity', role: 'tab', name: '^Trades$' },
    },
  ],
  M3: [
    {
      id: 'send-1-usdt-to-friend',
      title: 'Send 1 USDT to friend',
      needs: 'Pay (B14)',
      probe: { path: '/pay/send', role: 'button', name: '^Review$' },
    },
  ],
};

async function runNoReload(ctx, flow) {
  const result = { id: flow.id, title: flow.title, status: 'fail', detail: '' };
  try {
    await ctx.page.setViewportSize({ width: 1440, height: 900 });
    await spaNavigate(ctx.page, flow.path);
    await settle(ctx.page, ctx.state, { quietMs: 400, maxMs: 6000 });
    await ctx.page.evaluate(() => {
      window.__noReloadMark = 'alive';
    });
    await ctx.page.locator(flow.click).first().click({ timeout: 5000 });
    await settle(ctx.page, ctx.state, { quietMs: 400, maxMs: 6000 });
    const after = await ctx.page.evaluate(() => ({
      mark: window.__noReloadMark ?? null,
      path: location.pathname,
      signedOut: /sign in to continue/i.test(document.body.innerText),
    }));
    const problems = [];
    if (after.mark !== 'alive') problems.push('the page reloaded');
    if (after.path !== flow.expectPath) problems.push(`landed on ${after.path}, expected ${flow.expectPath}`);
    if (after.signedOut) problems.push('the screen asks to sign in');
    result.status = problems.length ? 'fail' : 'pass';
    result.detail = problems.join('; ');
  } catch (error) {
    result.detail = String(error?.message ?? error).split('\n')[0];
  }
  return result;
}

async function runFlows(ctx, milestone) {
  const out = [];
  for (const flow of FLOWS[milestone] ?? []) {
    if (flow.kind === 'noReload') {
      out.push(await runNoReload(ctx, flow));
      continue;
    }
    let present = false;
    try {
      await spaNavigate(ctx.page, flow.probe.path);
      await settle(ctx.page, ctx.state, { quietMs: 400, maxMs: 4000 });
      present = (await ctx.page.getByRole(flow.probe.role, { name: new RegExp(flow.probe.name, 'i') }).count()) > 0;
    } catch {
      present = false;
    }
    out.push({
      id: flow.id,
      title: flow.title,
      status: 'skip',
      detail: present
        ? `SKIPPED: the entry control exists, but this harness version only has a stub for "${flow.title}". It moves money, so write the flow after the ${flow.needs} reviewer pass.`
        : `SKIPPED: "${flow.title}" needs the ${flow.needs} screen, which is not on this build yet (entry control not found at ${flow.probe.path}).`,
      screenDetected: present,
    });
  }
  return out;
}

function summarize(routes, redirects, flows) {
  const counts = { pass: 0, fail: 0, skip: 0 };
  const failures = {};
  for (const r of routes) {
    for (const a of r.assertions) {
      counts[a.status]++;
      if (a.status === 'fail') (failures[a.name] ??= []).push(r.id);
    }
  }
  for (const d of redirects) {
    counts[d.status]++;
    if (d.status === 'fail') (failures.redirect ??= []).push(d.from);
  }
  for (const f of flows) counts[f.status]++;
  for (const r of routes) for (const s of r.sideBySide) counts[s.status]++;
  for (const r of routes) for (const s of r.sideBySide) if (s.status === 'fail') (failures['side-by-side'] ??= []).push(r.id);
  const topFailures = Object.entries(failures)
    .map(([name, where]) => ({ name, count: where.length, where }))
    .sort((a, b) => b.count - a.count);
  return { ...counts, total: counts.pass + counts.fail + counts.skip, topFailures };
}

export async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
    if (opts.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    if (isInsideRepo(opts.out))
      throw new UsageError('Refusing --out inside this repository: reference images must never be committed. Use the evidence folder.');
    if (!existsSync(opts.refs)) throw new UsageError(`--refs file not found: ${opts.refs}`);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }

  let refs;
  let account;
  try {
    refs = JSON.parse(readFileSync(opts.refs, 'utf8'));
    const problems = validateRefs(refs);
    if (problems.length) throw new UsageError(`Invalid refs file:\n  ${problems.join('\n  ')}`);
    account = loadAccount(opts.account);
  } catch (error) {
    process.stderr.write(`${error instanceof UsageError ? error.message : `Could not read inputs: ${error.message}`}\n`);
    return 2;
  }

  const routes = refs.routes.filter((r) => r.milestone === opts.milestone && (!opts.only || opts.only.includes(r.id)));
  const redirects = (refs.redirects ?? []).filter((d) => d.milestone === opts.milestone && !opts.only);
  if (routes.length === 0) {
    process.stderr.write(
      `No routes for ${opts.milestone}${opts.only ? ` matching --only ${opts.only.join(',')}` : ''} in the refs file.\n`,
    );
    return 2;
  }
  const missing = missingReferenceFiles({ routes });

  mkdirSync(opts.out, { recursive: true });
  const shotsDir = join(opts.out, 'shots');
  const sbsDir = join(opts.out, 'side-by-side');
  const { chromium } = await import('@playwright/test');
  const browser = await launchBrowser(chromium);
  const startedAt = new Date().toISOString();
  const state = makeState();
  let routeResults = [];
  let redirectResults = [];
  let flowResults = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', deviceScaleFactor: 1 });
    // Stay on 127.0.0.1 even if the page tries to leave: block and record anything else.
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (isLoopbackUrl(url)) return route.continue();
      state.external.push(url);
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    page.on('request', () => {
      state.inflight++;
      if (state.counting) state.count++;
    });
    page.on('requestfinished', () => {
      state.inflight = Math.max(0, state.inflight - 1);
    });
    page.on('requestfailed', () => {
      state.inflight = Math.max(0, state.inflight - 1);
    });
    page.on('response', (response) => {
      const status = response.status();
      const line = `${status} ${response.request().method()} ${new URL(response.url()).pathname}`;
      if (status >= 500) state.fiveXX.push(line);
      else if (status >= 400) state.fourXX.push(line);
    });
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      const loc = msg.location()?.url ?? '';
      // A 4xx the app handled is a typed refusal, not a console error (5xx is asserted separately).
      if (/Failed to load resource: the server responded with a status of 4\d\d/.test(text)) return;
      // The local test stack has no WebSocket service on purpose: its server answers every /ws/ upgrade with 503.
      // That is the environment, not the screen, so it is counted and reported (info), not failed.
      if (/WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/ws\/.*Unexpected response code: 503/.test(text)) {
        state.wsAbsent++;
        return;
      }
      state.console.push({ text, blocked: Boolean(loc) && !isLoopbackUrl(loc) });
    });
    page.on('pageerror', (error) => state.console.push({ text: `uncaught: ${error.message}`, blocked: false }));

    process.stdout.write(`Signing in as test account "${account.key}" on ${opts.base} ...\n`);
    await signIn(page, opts.base, account);
    await settle(page, state);

    const ctx = { page, state, opts, shotsDir };
    for (const route of routes) {
      process.stdout.write(`Route ${route.id} (${route.path}) ...\n`);
      const rec = await runRoute(ctx, route);
      routeResults.push(rec);
      const f = rec.assertions.filter((a) => a.status === 'fail').map((a) => a.name);
      process.stdout.write(`  ${f.length ? `FAIL: ${f.join(', ')}` : 'ok'}\n`);
    }
    for (const d of redirects) redirectResults.push(await runRedirect(ctx, d));
    flowResults = await runFlows(ctx, opts.milestone);
    await context.close();

    // Side-by-side after the app session is closed.
    for (const rec of routeResults) {
      const route = routes.find((r) => r.id === rec.id);
      if (!route.references?.length) {
        rec.sideBySide.push({
          status: 'skip',
          detail: 'no reference image for this screen in the spec (checked against its Layout list instead)',
        });
        continue;
      }
      for (const [i, ref] of route.references.entries()) {
        const label = referenceLabel(ref);
        const suffix = i === 0 ? '' : `-ref${i + 1}`;
        const jobs = [
          { kind: 'first', ours: rec.screenshots.first1440, ref: ref.image, out: join(sbsDir, `${rec.id}${suffix}.png`), max: 2400 },
        ];
        if (ref.full)
          jobs.push({
            kind: 'full',
            ours: rec.screenshots.full1440,
            ref: ref.full,
            out: join(sbsDir, `${rec.id}${suffix}-full.png`),
            max: 14000,
          });
        for (const job of jobs) {
          try {
            if (!job.ours) throw new Error('our screenshot was not taken (route failed to load)');
            if (!existsSync(job.ref)) throw new Error(`reference image missing: ${job.ref}`);
            await composeSideBySide(browser, {
              oursPath: job.ours,
              refPath: job.ref,
              outPath: job.out,
              refLabel: label,
              maxHeight: job.max,
            });
            rec.sideBySide.push({ status: 'pass', kind: job.kind, file: job.out, refLabel: label, reference: job.ref });
          } catch (error) {
            rec.sideBySide.push({ status: 'fail', kind: job.kind, detail: String(error.message).split('\n')[0], reference: job.ref });
          }
        }
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
  }

  const summary = summarize(routeResults, redirectResults, flowResults);
  const report = {
    tool: 'tooling/scripts/redesign-shots.mjs',
    spec: 'UI-SPEC.md section 7.4',
    milestone: opts.milestone,
    base: opts.base,
    startedAt,
    finishedAt: new Date().toISOString(),
    account: { key: account.key },
    idleSeconds: opts.idleSeconds,
    requestLimit: requestLimitFor(opts.idleSeconds),
    refsFile: opts.refs,
    summary,
    missingReferenceFiles: missing,
    blockedExternalRequests: [...new Set(state.external)].slice(0, 20),
    routes: routeResults,
    redirects: redirectResults,
    flows: flowResults,
  };
  writeFileSync(join(opts.out, 'report.json'), JSON.stringify(report, null, 2) + '\n');

  process.stdout.write(
    `\n${opts.milestone}: ${summary.pass} passed, ${summary.fail} failed, ${summary.skip} skipped (of ${summary.total}).\n`,
  );
  for (const f of summary.topFailures.slice(0, 8)) process.stdout.write(`  ${f.count}x ${f.name}: ${f.where.slice(0, 6).join(', ')}\n`);
  process.stdout.write(`Report: ${join(opts.out, 'report.json')}\n`);
  return summary.fail > 0 ? 1 : 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`redesign-shots failed: ${error?.message ?? error}\n`);
      process.exit(1);
    },
  );
}
