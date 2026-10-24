#!/usr/bin/env node
/**
 * Try it: the local test stack's Customer app behind a password, for the Try-it workflow (.github/workflows/try-it.yml).
 * TEST money only. Owner decision 48 (23 Oct 2026); the ADR amendment is in docs/adr/2026-08-08-staging-deploy-path.md.
 *
 *   node tooling/scripts/try-it.mjs gate          the password gate on 127.0.0.1:TRY_GATE_PORT (default 8088)
 *   node tooling/scripts/try-it.mjs demo          the demo account: signed up, verified, TEST USDT
 *   node tooling/scripts/try-it.mjs check <url>   prove the gate through <url> (refuses, wrong password, app, API)
 *
 * Env: TRY_PASSWORD (12 to 200 characters; never printed), TRY_PUBLIC_ORIGIN (the link's own origin, for example
 * https://<name>.trycloudflare.com), TRY_ENDS_AT (ISO time the run ends, shown on the start page).
 *
 * The gate is the only door. It refuses every request without its cookie, which only the password sets. With the
 * cookie it forwards to the stack's Customer server as a local caller: Host and Origin become http://127.0.0.1:3210, so
 * the Customer server's DNS-rebinding guard and Edge's origin allow-list stay as they are. Before rewriting, it refuses
 * any Origin other than TRY_PUBLIC_ORIGIN, so a cross-site request is still refused, and the cookie is SameSite=Strict.
 * Docs: docs/LOCAL-TEST-STACK.md, "Try it".
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { localStackState } from './local-test-state.mjs';
import { LOCAL_TEST_DEVICE_KEY } from './local-test-device.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SCRIPT), '..', '..');
export const UPSTREAM = { host: '127.0.0.1', port: 3210 };
export const UPSTREAM_ORIGIN = `http://${UPSTREAM.host}:${UPSTREAM.port}`;
export const GATE_COOKIE = 'try_gate';
export const DEMO = { handle: 'trydemo', email: 'try-demo@local-test.invalid' };
/** Illustrative TEST credit per account, labelled TEST on the page. Not a business figure. */
export const TEST_CREDIT = { asset: 'USDT', amount: '10000' };
export const MAX_FAILURES_PER_MINUTE = 10;
const MAX_SESSIONS = 500;

function fail(msg, code = 1) {
  process.stderr.write(`try-it: ${msg}\n`);
  process.exit(code);
}

/** The password, or a refusal by name. 12 to 200 characters, as identity asks of an account password. */
export function readPassword(env = process.env) {
  const pw = env.TRY_PASSWORD ?? '';
  if (pw.length === 0) throw new Error('TRY_PASSWORD is unset');
  if (pw.length < 12 || pw.length > 200) throw new Error('TRY_PASSWORD must be 12 to 200 characters');
  return pw;
}

export function readPublicOrigin(env = process.env) {
  const raw = env.TRY_PUBLIC_ORIGIN ?? '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('TRY_PUBLIC_ORIGIN must be an origin like https://name.trycloudflare.com');
  }
  if (url.origin !== raw.replace(/\/$/, '') || !['https:', 'http:'].includes(url.protocol)) {
    throw new Error('TRY_PUBLIC_ORIGIN must be an origin like https://name.trycloudflare.com');
  }
  return url.origin;
}

const sha = (s) => crypto.createHash('sha256').update(s).digest();
export const samePassword = (given, want) => crypto.timingSafeEqual(sha(String(given)), sha(want));

export const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The cookie header without the gate's own cookie, so the app never sees it. Null when nothing is left. */
export function withoutGateCookie(header) {
  if (!header) return null;
  const kept = String(header)
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith(`${GATE_COOKIE}=`));
  return kept.length ? kept.join('; ') : null;
}

export function gateToken(header) {
  for (const part of String(header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === GATE_COOKIE) return v.join('=');
  }
  return null;
}

/** Headers for the Customer server: a local caller. Hop-by-hop headers and the gate cookie are dropped. */
export function upstreamHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (['host', 'origin', 'referer', 'cookie', 'connection', 'keep-alive', 'upgrade', 'proxy-connection', 'te', 'trailer'].includes(lk))
      continue;
    if (lk.startsWith('cf-') || lk.startsWith('x-forwarded-') || lk === 'cdn-loop') continue;
    out[lk] = v;
  }
  out.host = `${UPSTREAM.host}:${UPSTREAM.port}`;
  if (headers.origin !== undefined) out.origin = UPSTREAM_ORIGIN;
  const cookie = withoutGateCookie(headers.cookie);
  if (cookie) out.cookie = cookie;
  return out;
}

/** Ten wrong passwords in a minute, from anyone, close the door for the rest of that minute. */
export function createFailureWindow(max = MAX_FAILURES_PER_MINUTE, windowMs = 60_000) {
  let times = [];
  return {
    blocked(now = Date.now()) {
      times = times.filter((t) => now - t < windowMs);
      return times.length >= max;
    },
    record(now = Date.now()) {
      times.push(now);
    },
  };
}

// ── Pages ───────────────────────────────────────────────────────────────────

const STYLE = `<style>
:root{color-scheme:light dark;--bg:#0b0d10;--fg:#e8eaed;--muted:#9aa0a6;--card:#15181d;--line:#2a2f36;--accent:#F5A915}
@media (prefers-color-scheme: light){:root{--bg:#f7f7f5;--fg:#16181b;--muted:#5f6368;--card:#fff;--line:#e2e2de}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px 48px}
.test{background:var(--accent);color:#0b0b0b;font-weight:600;font-size:12px;letter-spacing:.04em;text-align:center;padding:6px 16px}
h1{font-size:22px;margin:16px 0 4px}h2{font-size:16px;margin:28px 0 8px}p{margin:6px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:10px 0}
.muted{color:var(--muted)}code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
input{font:inherit;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);width:100%;max-width:360px}
button,.button{font:inherit;font-weight:600;padding:8px 14px;border-radius:8px;border:0;background:var(--accent);color:#0b0b0b;cursor:pointer;text-decoration:none;display:inline-block;margin-top:8px}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{text-align:left;padding:6px 8px;border-top:1px solid var(--line);vertical-align:top}
.error{color:#e5484d}.ok{color:#30a46c}
</style>`;

// The tunnel's edge rewrites email addresses in HTML into a script-decoded link (email obfuscation), which hid the demo
// account's address from the link check on the first live run. `email_off` comments and `no-transform` turn that off.
const page = (title, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>${STYLE}</head><body>` +
  `<div class="test" role="status">TEST · LOCAL TEST STACK · NOT REAL MONEY</div><main><!--email_off-->${body}<!--/email_off--></main></body></html>`;

export function loginPage({ error = null, next = '/' } = {}) {
  return page(
    'Try INTAFACED',
    `<h1>Try INTAFACED</h1>
<p class="muted">A temporary copy of the latest app, on TEST money only. Enter the password you were given.</p>
<form method="post" action="/__try/login" class="card">
<label for="pw">Password</label><br><input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
<input type="hidden" name="next" value="${escapeHtml(next)}"><br>
<button type="submit">Continue</button>
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
</form>`,
  );
}

/** LOCAL-TEST outbox lines, newest first: who, what, and the code or link the stack would have mailed. */
export function readOutbox(file, max = 40) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('LOCAL-TEST '))
    .map((l) => ({
      purpose: /\bpurpose=(\S+)/.exec(l)?.[1] ?? '?',
      email: /\bemail=(\S+)/.exec(l)?.[1] ?? '?',
      code: /\bcode=(\d{4,8})\b/.exec(l)?.[1] ?? null,
      link: /\blink=(\S+)/.exec(l)?.[1] ?? null,
    }))
    .filter((m) => m.email !== DEMO.email && !m.email.startsWith('test-'))
    .reverse()
    .slice(0, max);
}

export function startPage({ endsAt, outbox, notice = null }) {
  const ends = endsAt ? new Date(endsAt) : null;
  const endsText = ends && !Number.isNaN(ends.getTime()) ? `${ends.toISOString().slice(11, 16)} UTC` : 'when the run stops';
  const rows = outbox.length
    ? outbox
        .map(
          (m) =>
            `<tr><td><code>${escapeHtml(m.email)}</code></td><td>${escapeHtml(m.purpose)}</td><td>${
              m.code
                ? `<code>${escapeHtml(m.code)}</code>`
                : m.link
                  ? `<a href="/${escapeHtml(m.link.replace(/^\//, ''))}">open link</a>`
                  : ''
            }</td></tr>`,
        )
        .join('')
    : '<tr><td colspan="3" class="muted">Nothing yet. Codes for accounts you make appear here.</td></tr>';
  return page(
    'Try INTAFACED',
    `<h1>Try INTAFACED</h1>
<p>The latest app, freshly started, on TEST money only. This copy ends at <strong>${escapeHtml(endsText)}</strong>, and everything in it is deleted then.</p>
${notice ? `<p class="${notice.ok ? 'ok' : 'error'}" role="status">${escapeHtml(notice.text)}</p>` : ''}
<div class="card"><h2 style="margin-top:0">Start with the demo account</h2>
<p>Email <code>${escapeHtml(DEMO.email)}</code>, and the same password you just typed.</p>
<p class="muted">It is verified and holds ${escapeHtml(TEST_CREDIT.amount)} TEST ${escapeHtml(TEST_CREDIT.asset)}, so you can trade at once.</p>
<a class="button" href="/login">Open the app</a></div>

<h2>Or make your own account</h2>
<ol>
<li>Sign up in the app with a made-up email (for example <code>you@local-test.invalid</code>): everyone on this link sees the TEST inbox below, and this copy sends no email. Your code shows there.</li>
<li>To trade, ask for verification in the app (Verification), then press the button here. In the real product an operator reviews it; here the two TEST operators approve every waiting request on this copy.
<form method="post" action="/__try/verify"><button type="submit">Approve my verification request (TEST operators)</button></form></li>
<li>Get TEST money: <form method="post" action="/__try/fund" style="display:inline"><input name="email" type="email" placeholder="your sign-up email" required aria-label="Your sign-up email">
<button type="submit">Add ${escapeHtml(TEST_CREDIT.amount)} TEST ${escapeHtml(TEST_CREDIT.asset)}</button></form><br><span class="muted">Once per account; a second press adds nothing.</span></li>
</ol>

<h2>TEST inbox</h2>
<div class="card"><table><thead><tr><th>To</th><th>What</th><th>Code or link</th></tr></thead><tbody>${rows}</tbody></table>
<p class="muted"><a href="/__try/">Refresh</a></p></div>

<h2>What this copy can't show</h2>
<ul class="muted">
<li>Live streams: this stack runs no stream server, so prices and the book update when a screen polls, not tick by tick.</li>
<li>The founder console, passkeys (they need the local address), and anything that needs a real partner. Those screens refuse and say why.</li>
<li>Everyone on this link shares one rate limit. That is fine for a few people at once.</li>
</ul>`,
  );
}

// ── Tools the page runs ─────────────────────────────────────────────────────

function runTool(script, args, timeout = 120_000) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(REPO, 'tooling', 'scripts', script), ...args], { cwd: REPO, timeout }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: `${stdout}${stderr}` }),
    );
  });
}

/** One business key per account and asset: a second press is the same deposit, so the ledger adds nothing. */
export const fundRef = (email) =>
  `try-it-${crypto.createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 16)}-${TEST_CREDIT.asset.toLowerCase()}`;
const EMAIL = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}$/;

let toolQueue = Promise.resolve();
const serial = (fn) => (toolQueue = toolQueue.then(fn, fn));

// ── The gate ────────────────────────────────────────────────────────────────

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

/**
 * Where to go after the password: a path on this link, or `/`. It is resolved the way a browser would resolve it, so
 * `//x`, `/\\x`, `/..//x` and tab or newline tricks that leave the link fall back to `/`.
 */
export function safeNext(n) {
  if (typeof n !== 'string' || !n.startsWith('/')) return '/';
  const base = 'https://gate.invalid';
  let url;
  try {
    url = new URL(n, base);
  } catch {
    return '/';
  }
  if (url.origin !== base || url.pathname.startsWith('/__try/')) return '/';
  const out = `${url.pathname}${url.search}${url.hash}`;
  // Dot segments collapse (`/..//x` resolves to the path `//x`), so the result is checked again as what it is: a path
  // that a browser resolves on this link and that resolves to itself.
  if (out.startsWith('//') || out.startsWith('/\\')) return '/';
  const again = new URL(out, base);
  return again.origin === base && `${again.pathname}${again.search}${again.hash}` === out ? out : '/';
}

export function createGate({ password, publicOrigin, port = 8088, endsAt = null, stateDir = localStackState(), upstream = UPSTREAM }) {
  const sessions = new Set();
  // Wrong guesses count per visitor (the tunnel names the caller in cf-connecting-ip, and only the tunnel reaches the
  // gate), and in total, so one visitor cannot lock everyone out and many cannot guess fast.
  const perVisitor = new Map();
  const total = createFailureWindow(MAX_FAILURES_PER_MINUTE * 10);
  const visitorWindow = (req) => {
    const who = String(req.headers['cf-connecting-ip'] ?? 'local');
    if (!perVisitor.has(who)) {
      if (perVisitor.size >= 10_000) perVisitor.clear();
      perVisitor.set(who, createFailureWindow());
    }
    return perVisitor.get(who);
  };
  const secure = publicOrigin.startsWith('https:');
  // The link's own name, or the gate's local address when the tunnel forwards with that Host. Nothing else.
  const hosts = new Set([new URL(publicOrigin).host, `127.0.0.1:${port}`]);
  const outboxFile = path.join(stateDir, 'email-outbox.log');

  const send = (res, status, body, type = 'text/html; charset=utf-8', extra = {}) => {
    res.writeHead(status, {
      'content-type': type,
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store, no-transform',
      'referrer-policy': 'same-origin',
      'x-robots-tag': 'noindex',
      'x-frame-options': 'DENY',
      ...extra,
    });
    res.end(body);
  };
  const redirect = (res, to, extra = {}) => send(res, 303, '', 'text/plain', { location: to, ...extra });
  const signedIn = (req) => {
    const t = gateToken(req.headers.cookie);
    return t !== null && sessions.has(t);
  };

  return http.createServer(async (req, res) => {
    // One line per refusal or redirect, for the run log: status, method, path, and whether a gate cookie came and is
    // known. Never the cookie, a query string or a body.
    res.on('finish', () => {
      if (res.statusCode < 300) return;
      const t = gateToken(req.headers.cookie);
      const path = String(req.url ?? '').split('?')[0];
      console.log(`gate ${res.statusCode} ${req.method} ${path} cookie=${t === null ? 'none' : sessions.has(t) ? 'known' : 'unknown'}`);
    });
    // Only these names are served (the same DNS-rebinding guard the Customer server keeps).
    if (!hosts.has(req.headers.host ?? '')) return send(res, 403, 'forbidden', 'text/plain');
    // A request that names an origin must come from the link itself; a cross-site request stops here.
    if (req.headers.origin !== undefined && req.headers.origin !== publicOrigin) return send(res, 403, 'forbidden', 'text/plain');
    const url = new URL(req.url, publicOrigin);
    const p = url.pathname;

    if (p === '/__try/login') {
      if (req.method === 'GET') return send(res, 200, loginPage({ next: safeNext(url.searchParams.get('next')) }));
      if (req.method !== 'POST' || req.headers.origin !== publicOrigin) return send(res, 403, 'forbidden', 'text/plain');
      let form;
      try {
        form = await readBody(req);
      } catch {
        return send(res, 413, 'too large', 'text/plain');
      }
      const next = safeNext(form.get('next'));
      const mine = visitorWindow(req);
      if (mine.blocked() || total.blocked())
        return send(res, 429, loginPage({ next, error: 'Too many wrong passwords. Wait a minute and try again.' }));
      if (!samePassword(form.get('password') ?? '', password)) {
        mine.record();
        total.record();
        return send(res, 401, loginPage({ next, error: 'That password is not right.' }));
      }
      if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.values().next().value);
      const token = crypto.randomBytes(32).toString('base64url');
      sessions.add(token);
      const cookie = `${GATE_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
      return redirect(res, next === '/' ? '/__try/' : next, { 'set-cookie': cookie });
    }

    if (!signedIn(req)) {
      if (req.method === 'GET' && !p.startsWith('/api/') && !p.startsWith('/assets/')) {
        return redirect(res, `/__try/login${p === '/' ? '' : `?next=${encodeURIComponent(p + url.search)}`}`);
      }
      return send(res, 401, JSON.stringify({ error: 'try.password_required' }), 'application/json');
    }

    if (p === '/__try/' || p === '/__try') {
      if (req.method !== 'GET') return send(res, 405, 'method not allowed', 'text/plain');
      const n = url.searchParams.get('n');
      const notices = {
        funded: { ok: true, text: `${TEST_CREDIT.amount} TEST ${TEST_CREDIT.asset} is in that account. A second press adds nothing.` },
        nofund: { ok: false, text: 'No account with that email in this copy. Sign up in the app first, then try again.' },
        verified: { ok: true, text: 'The TEST operators approved every waiting request. Sign in again in the app to trade.' },
        noverify: { ok: false, text: 'The TEST operators could not approve right now. Try again in a minute.' },
      };
      return send(res, 200, startPage({ endsAt, outbox: readOutbox(outboxFile), notice: notices[n] ?? null }));
    }
    if (p === '/__try/fund' || p === '/__try/verify') {
      if (req.method !== 'POST' || req.headers.origin !== publicOrigin) return send(res, 403, 'forbidden', 'text/plain');
      let form;
      try {
        form = await readBody(req);
      } catch {
        return send(res, 413, 'too large', 'text/plain');
      }
      if (p === '/__try/verify') {
        const r = await serial(() => runTool('local-test-gates.mjs', ['verify']));
        return redirect(res, `/__try/?n=${r.ok ? 'verified' : 'noverify'}`);
      }
      const email = (form.get('email') ?? '').trim();
      if (!EMAIL.test(email)) return redirect(res, '/__try/?n=nofund');
      const r = await serial(() =>
        runTool('local-test-stack.mjs', ['fund', email, TEST_CREDIT.asset, TEST_CREDIT.amount, '--ref', fundRef(email)]),
      );
      return redirect(res, `/__try/?n=${r.ok ? 'funded' : 'nofund'}`);
    }
    if (p.startsWith('/__try/')) return send(res, 404, 'not found', 'text/plain');

    const up = http.request({ ...upstream, method: req.method, path: req.url, headers: upstreamHeaders(req.headers) }, (ur) => {
      const headers = { ...ur.headers, 'referrer-policy': 'same-origin', 'x-robots-tag': 'noindex' };
      if (typeof headers.location === 'string' && headers.location.startsWith(UPSTREAM_ORIGIN)) {
        headers.location = headers.location.slice(UPSTREAM_ORIGIN.length) || '/';
      }
      res.writeHead(ur.statusCode ?? 502, headers);
      ur.pipe(res);
    });
    up.on('error', () =>
      res.headersSent ? res.destroy() : send(res, 502, JSON.stringify({ error: 'try.app_unreachable' }), 'application/json'),
    );
    req.pipe(up);
  });
}

// ── Demo account ────────────────────────────────────────────────────────────

/** Signs the demo account up in Chromium as a person would, has the TEST operators verify it, and funds TEST USDT. */
async function cmdDemo() {
  const password = readPassword();
  const { chromium } = await import('@playwright/test');
  const stack = await import(pathToFileURL(path.join(REPO, 'apps/customer/tests/real-app/stack.mjs')).href);
  const who = { ...DEMO, password };
  const browser = await chromium.launch(process.env.JOURNEY_CHROMIUM ? { executablePath: process.env.JOURNEY_CHROMIUM } : {});
  try {
    const page = await (await browser.newContext({ baseURL: UPSTREAM_ORIGIN })).newPage();
    await stack.signUpInBrowser(page, who);
    await page.goto('/verification');
    await page.getByLabel('Level to request').selectOption({ label: 'Full' });
    await page.getByLabel('Country code').fill('DE');
    await page.getByRole('button', { name: 'Review request' }).click();
    await page.getByRole('button', { name: 'Submit this request' }).click();
    await page.getByText('Your reviewed request').waitFor();
  } finally {
    await browser.close();
  }
  const verified = await runTool('local-test-gates.mjs', ['verify']);
  if (!verified.ok) fail(`the TEST operators could not verify the demo account:\n${verified.out.slice(-800)}`);
  const funded = await runTool('local-test-stack.mjs', [
    'fund',
    DEMO.email,
    TEST_CREDIT.asset,
    TEST_CREDIT.amount,
    '--ref',
    fundRef(DEMO.email),
  ]);
  if (!funded.ok) fail(`TEST funding of the demo account failed:\n${funded.out.slice(-800)}`);
  console.log(`demo account ready: ${DEMO.email}, verified, ${TEST_CREDIT.amount} TEST ${TEST_CREDIT.asset}`);
}

// ── Check ───────────────────────────────────────────────────────────────────

/** Proves the gate through `base`: refusal without the cookie, a wrong password refused, then the app and its API. */
async function cmdCheck(base) {
  const password = readPassword();
  const origin = new URL(base).origin;
  const steps = [];
  // On a failure it prints what came back (status, Location, the first part of a body), never a cookie or a token.
  const step = (ok, what, res, body) => {
    steps.push(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
    if (!ok) {
      if (res) steps.push(`     got HTTP ${res.status}${res.headers.get('location') ? ` -> ${res.headers.get('location')}` : ''}`);
      if (typeof body === 'string') steps.push(`     body: ${body.replace(/\s+/g, ' ').slice(0, 300)}`);
      console.log(steps.join('\n'));
      fail(`check failed: ${what}`);
    }
  };
  const get = (p, cookie) => fetch(`${origin}${p}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  const login = (pw) =>
    fetch(`${origin}/__try/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: pw, next: '/' }).toString(),
    });
  const app = await get('/');
  step(
    app.status === 303 && app.headers.get('location')?.startsWith('/__try/login'),
    'the app without the password goes to the password page',
  );
  const api = await get('/api/v1/account/balance');
  step(api.status === 401 && (await api.json()).error === 'try.password_required', 'the API without the password is refused');
  const wrong = await login(`${password}x`);
  step(wrong.status === 401 && !wrong.headers.get('set-cookie'), 'a wrong password is refused and sets no cookie');
  const right = await login(password);
  const cookie = right.headers.get('set-cookie')?.split(';')[0];
  step(right.status === 303 && cookie?.startsWith(`${GATE_COOKIE}=`), 'the right password sets the gate cookie');
  const start = await get('/__try/', cookie);
  const startText = await start.text();
  step(start.status === 200 && startText.includes(DEMO.email), 'the start page names the demo account', start, startText);
  const shell = await get('/', cookie);
  const shellText = await shell.text();
  step(
    shell.status === 200 && shellText.includes('local-test-stack-banner'),
    "the app's own page loads, with the TEST banner",
    shell,
    shellText,
  );
  const signIn = await fetch(`${origin}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin, cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: DEMO.email, password, deviceKey: LOCAL_TEST_DEVICE_KEY }),
  });
  const token = (await signIn.json())?.result?.data?.accessToken;
  step(signIn.status === 200 && Boolean(token), 'the demo account signs in through the link', signIn);
  const bal = await fetch(`${origin}/api/v1/account/balance`, { headers: { origin, cookie, authorization: `Bearer ${token}` } });
  const usdt = bal.status === 200 ? (await bal.json()).balances?.[TEST_CREDIT.asset]?.free : null;
  step(typeof usdt === 'string' && usdt.length > 0, `the demo account reads its TEST ${TEST_CREDIT.asset} through the link`, bal);
  console.log(steps.join('\n'));
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function runningAsCli() {
  try {
    return fs.realpathSync(process.argv[1] ?? '') === fs.realpathSync(SCRIPT);
  } catch {
    return false;
  }
}

if (runningAsCli()) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'gate') {
      const port = Number(process.env.TRY_GATE_PORT ?? 8088);
      const gate = createGate({
        password: readPassword(),
        publicOrigin: readPublicOrigin(),
        port,
        endsAt: process.env.TRY_ENDS_AT ?? null,
      });
      gate.on('upgrade', (_req, socket) => socket.destroy()); // the stack has no stream server to pass a socket to
      gate.listen(port, '127.0.0.1', () => console.log(`try-it gate on 127.0.0.1:${port}`));
    } else if (cmd === 'demo') await cmdDemo();
    else if (cmd === 'check' && rest[0]) await cmdCheck(rest[0]);
    else fail('usage: try-it.mjs gate | demo | check <url>', 2);
  } catch (err) {
    fail(err.message);
  }
}
