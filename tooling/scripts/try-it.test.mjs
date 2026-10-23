// Proves the Try-it password gate without the stack: a fake Customer server stands behind it.
// Run: node tooling/scripts/try-it.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  GATE_COOKIE,
  MAX_FAILURES_PER_MINUTE,
  UPSTREAM_ORIGIN,
  createFailureWindow,
  createGate,
  escapeHtml,
  fundRef,
  gateToken,
  readOutbox,
  readPassword,
  readPublicOrigin,
  startPage,
  upstreamHeaders,
  withoutGateCookie,
} from './try-it.mjs';

// ── Pure parts ──────────────────────────────────────────────────────────────

assert.throws(() => readPassword({}), /TRY_PASSWORD is unset/);
assert.throws(() => readPassword({ TRY_PASSWORD: 'short' }), /12 to 200/);
assert.equal(readPassword({ TRY_PASSWORD: 'twelve-chars' }), 'twelve-chars');
assert.equal(readPublicOrigin({ TRY_PUBLIC_ORIGIN: 'https://a-b.trycloudflare.com' }), 'https://a-b.trycloudflare.com');
for (const bad of ['', 'a-b.trycloudflare.com', 'https://x.example/path', 'ftp://x.example']) {
  assert.throws(() => readPublicOrigin({ TRY_PUBLIC_ORIGIN: bad }), /TRY_PUBLIC_ORIGIN/, bad);
}
assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
assert.equal(withoutGateCookie(`a=1; ${GATE_COOKIE}=t; b=2`), 'a=1; b=2');
assert.equal(withoutGateCookie(`${GATE_COOKIE}=t`), null);
assert.equal(gateToken(`a=1; ${GATE_COOKIE}=abc=; b=2`), 'abc=');
assert.equal(gateToken('a=1'), null);
// One key per account: case does not make a second deposit, and the key fits the fund tool's --ref rule.
assert.equal(fundRef('A@x.test'), fundRef('a@x.test'));
assert.match(fundRef('a@x.test'), /^[A-Za-z0-9-]{4,64}$/);
assert.notEqual(fundRef('a@x.test'), fundRef('b@x.test'));

const h = upstreamHeaders({
  host: 'n.trycloudflare.com',
  origin: 'https://n.trycloudflare.com',
  referer: 'https://n.trycloudflare.com/x',
  cookie: `${GATE_COOKIE}=t; refresh=r`,
  authorization: 'Bearer app-token',
  'x-forwarded-for': '203.0.113.9',
  'cf-connecting-ip': '203.0.113.9',
  connection: 'keep-alive',
  'content-type': 'application/json',
});
assert.deepEqual(h, {
  host: '127.0.0.1:3210',
  origin: UPSTREAM_ORIGIN,
  cookie: 'refresh=r',
  authorization: 'Bearer app-token',
  'content-type': 'application/json',
});
assert.equal(upstreamHeaders({ host: 'x' }).origin, undefined, 'no Origin is invented');

const win = createFailureWindow(3, 1000);
for (let i = 0; i < 3; i++) win.record(0);
assert.equal(win.blocked(500), true);
assert.equal(win.blocked(1500), false, 'the window lets go after a minute');

// The outbox shows people's own mail, newest first, never the demo's or the stack's TEST traders'.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'try-it-'));
fs.writeFileSync(
  path.join(dir, 'email-outbox.log'),
  [
    'LOCAL-TEST purpose=email-confirm email=test-taker@local-test.invalid link=confirm-email?token=t1',
    'LOCAL-TEST purpose=signup-code email=try-demo@local-test.invalid code=111111 expires=x',
    'LOCAL-TEST purpose=signup-code email=p@x.test code=123456 expires=x',
    'LOCAL-TEST purpose=email-confirm email=p@x.test expires=x link=confirm-email?token=abc',
    'something else',
  ].join('\n'),
);
assert.deepEqual(readOutbox(path.join(dir, 'email-outbox.log')), [
  { purpose: 'email-confirm', email: 'p@x.test', code: null, link: 'confirm-email?token=abc' },
  { purpose: 'signup-code', email: 'p@x.test', code: '123456', link: null },
]);
assert.ok(!startPage({ endsAt: null, outbox: [{ purpose: 'x', email: '<script>', code: null, link: null }] }).includes('<script>'));

// ── The gate in front of a fake Customer server ─────────────────────────────

const seen = [];
const upstream = http.createServer((req, res) => {
  seen.push({ method: req.method, url: req.url, headers: req.headers });
  if (req.url === '/redirect') {
    res.writeHead(302, { location: `${UPSTREAM_ORIGIN}/somewhere` });
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'refresh=r2; Path=/api; HttpOnly' });
  res.end(`app ${req.url}`);
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const PUBLIC = 'https://n.trycloudflare.com';
const PASSWORD = 'correct horse battery';
const gate = createGate({
  password: PASSWORD,
  publicOrigin: PUBLIC,
  port: 8088,
  stateDir: dir,
  upstream: { host: '127.0.0.1', port: upstream.address().port },
});
await new Promise((r) => gate.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${gate.address().port}`;
// fetch cannot send a custom Host header, so the gate is driven over http.request instead.
function raw(p, { method = 'GET', host = 'n.trycloudflare.com', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: gate.address().port, method, path: p, headers: { host, ...headers } }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
const form = (o) => ({
  method: 'POST',
  headers: { origin: PUBLIC, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(o).toString(),
});

try {
  // Foreign Host and foreign Origin are refused before anything else.
  assert.equal((await raw('/', { host: 'evil.example' })).status, 403);
  assert.equal((await raw('/', { headers: { origin: 'https://evil.example' } })).status, 403);
  // Without the cookie: pages go to the password page, the API is refused, and nothing reaches the app.
  const home = await raw('/');
  assert.equal(home.status, 303);
  assert.equal(home.headers.location, '/__try/login');
  assert.equal((await raw('/trade?x=1')).headers.location, `/__try/login?next=${encodeURIComponent('/trade?x=1')}`);
  const api = await raw('/api/v1/account/balance');
  assert.equal(api.status, 401);
  assert.equal(JSON.parse(api.text).error, 'try.password_required');
  assert.equal((await raw('/__try/', {})).status, 303);
  assert.equal(seen.length, 0);
  // A forged cookie is not a session.
  assert.equal((await raw('/api/x', { headers: { cookie: `${GATE_COOKIE}=forged` } })).status, 401);
  // The login form needs the link's own Origin.
  assert.equal(
    (await raw('/__try/login', { ...form({ password: PASSWORD }), headers: { 'content-type': 'application/x-www-form-urlencoded' } }))
      .status,
    403,
  );
  // A wrong password sets no cookie; after the limit even the right one waits out the minute.
  const wrong = await raw('/__try/login', form({ password: 'nope' }));
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers['set-cookie'], undefined);
  assert.match(wrong.text, /That password is not right/);
  for (let i = 1; i < MAX_FAILURES_PER_MINUTE; i++) await raw('/__try/login', form({ password: 'nope' }));
  const locked = await raw('/__try/login', form({ password: PASSWORD }));
  assert.equal(locked.status, 429);
  assert.equal(locked.headers['set-cookie'], undefined);
  assert.equal(seen.length, 0);
} finally {
  gate.close();
}

// A fresh gate for the signed-in path (the first one is locked for a minute, as it should be).
const gate2 = createGate({
  password: PASSWORD,
  publicOrigin: PUBLIC,
  port: 8088,
  stateDir: dir,
  upstream: { host: '127.0.0.1', port: upstream.address().port },
});
await new Promise((r) => gate2.listen(0, '127.0.0.1', r));
const raw2 = (p, o = {}) =>
  new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: '127.0.0.1',
        port: gate2.address().port,
        method: o.method ?? 'GET',
        path: p,
        headers: { host: o.host ?? 'n.trycloudflare.com', ...(o.headers ?? {}) },
      },
      (res) => {
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      },
    );
    r.on('error', reject);
    if (o.body) r.write(o.body);
    r.end();
  });
try {
  const ok = await raw2('/__try/login', form({ password: PASSWORD, next: '//evil.example' }));
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.location, '/__try/', 'an off-site next is ignored');
  const setCookie = ok.headers['set-cookie'][0];
  assert.match(setCookie, new RegExp(`^${GATE_COOKIE}=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; SameSite=Strict; Secure$`));
  const cookie = setCookie.split(';')[0];
  // The start page, then the app: Host and Origin become the local ones, the gate cookie never reaches the app.
  const start = await raw2('/__try/', { headers: { cookie } });
  assert.equal(start.status, 200);
  assert.match(start.text, /try-demo@local-test\.invalid/);
  assert.match(start.text, /123456/);
  const app = await raw2('/api/v1/x', {
    method: 'POST',
    headers: { cookie: `${cookie}; refresh=r`, origin: PUBLIC, authorization: 'Bearer t', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(app.status, 200);
  assert.equal(app.text, 'app /api/v1/x');
  assert.deepEqual(app.headers['set-cookie'], ['refresh=r2; Path=/api; HttpOnly']);
  const got = seen.at(-1);
  assert.equal(got.headers.host, '127.0.0.1:3210');
  assert.equal(got.headers.origin, UPSTREAM_ORIGIN);
  assert.equal(got.headers.cookie, 'refresh=r');
  assert.equal(got.headers.authorization, 'Bearer t');
  // The tunnel may forward with the gate's own address as Host; that is served too.
  assert.equal((await raw2('/app', { host: '127.0.0.1:8088', headers: { cookie } })).status, 200);
  // A redirect to the local origin comes back as a path on the link.
  assert.equal((await raw2('/redirect', { headers: { cookie } })).headers.location, '/somewhere');
  // The page's forms need the link's Origin, and a bad email runs no tool.
  assert.equal((await raw2('/__try/fund', { method: 'POST', headers: { cookie } })).status, 403);
  const before = seen.length;
  const bad = await raw2('/__try/fund', { ...form({ email: 'not an email' }), headers: { ...form({}).headers, cookie } });
  assert.equal(bad.status, 303);
  assert.equal(bad.headers.location, '/__try/?n=nofund');
  assert.equal(seen.length, before);
  assert.equal((await raw2('/__try/nothing', { headers: { cookie } })).status, 404);
} finally {
  gate2.close();
  upstream.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('try-it: gate checks passed');
