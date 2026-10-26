import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installSnippets, renderSecurityHeaders } from './render-security-headers.mjs';

const customer = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (name) => readFileSync(join(customer, name), 'utf8');
// Comments removed first: a commented-out include must not count.
const conf = read('nginx.conf').replace(/#.*$/gm, '');
const FULL = '/etc/nginx/snippets/security-headers.conf';
const API = '/etc/nginx/snippets/security-headers-api.conf';

/** Brace-matched `location ... { }` blocks of the server, with their match expression. */
function locations(source) {
  const found = [];
  const start = /^\s*location\s+([^{]+?)\s*\{/gm;
  let match;
  while ((match = start.exec(source))) {
    let depth = 1,
      i = start.lastIndex;
    while (depth && i < source.length) ((depth += source[i] === '{' ? 1 : source[i] === '}' ? -1 : 0), i++);
    found.push({ match: match[1], body: source.slice(start.lastIndex, i - 1) });
  }
  return found;
}
const headers = (snippet) =>
  [...snippet.matchAll(/^add_header\s+(\S+)\s+"((?:[^"\\]|\\.)*)"\s+always;/gm)].map((m) => [m[1].toLowerCase(), m[2]]);

test('every nginx location that sets add_header includes a security-headers snippet', () => {
  const all = locations(conf);
  assert.ok(all.length >= 6, 'parsed the location blocks');
  assert.ok(conf.includes(`include ${FULL};`), 'server level include');
  for (const { match, body } of all) {
    if (!/\badd_header\b/.test(body)) continue;
    // add_header in a location replaces the server-level ones, so the include must be repeated here.
    assert.ok(body.includes(`include ${match.startsWith('^~ /api/') ? API : FULL};`), `location ${match} drops the security headers`);
  }
  const included = [...conf.matchAll(/include (\/etc\/nginx\/snippets\/[^;]+);/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(included)].sort(), [API, FULL].sort(), 'only the two shipped snippets are included');
});

test('snippets carry every required header, with non-empty values', () => {
  const full = new Map(headers(renderSecurityHeaders()));
  assert.equal(full.get('strict-transport-security'), 'max-age=86400');
  assert.equal(full.get('x-content-type-options'), 'nosniff');
  assert.equal(full.get('x-frame-options'), 'DENY');
  assert.equal(full.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(full.get('cross-origin-opener-policy'), 'same-origin');
  for (const [name, value] of full) assert.ok(value.trim(), `${name} is not empty`);
  assert.doesNotMatch(full.get('strict-transport-security'), /preload|includeSubDomains/);

  const permissions = full.get('permissions-policy');
  for (const denied of ['geolocation=()', 'payment=()']) assert.ok(permissions.includes(denied), denied);
  // Academy live sessions publish camera, mic and screen; passkeys must keep their default allowlist.
  for (const kept of ['camera=(self)', 'microphone=(self)', 'display-capture=(self)']) assert.ok(permissions.includes(kept), kept);
  assert.doesNotMatch(permissions, /publickey-credentials/);

  const csp = new Map(
    full
      .get('content-security-policy')
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .map(([name, ...sources]) => [name, sources]),
  );
  assert.deepEqual(csp.get('default-src'), ["'self'"]);
  assert.deepEqual(csp.get('script-src'), ["'self'"]);
  assert.deepEqual(csp.get('frame-ancestors'), ["'none'"]);
  assert.deepEqual(csp.get('base-uri'), ["'self'"]);
  assert.deepEqual(csp.get('form-action'), ["'self'"]);
  assert.deepEqual(csp.get('object-src'), ["'none'"]);
  assert.ok(csp.get('connect-src').includes("'self'"));
  assert.ok(csp.get('style-src').includes("'unsafe-inline'"));
  assert.ok(!JSON.stringify([...csp]).includes('unsafe-eval'));

  assert.deepEqual(headers(read('security-headers-api.conf')), [['strict-transport-security', 'max-age=86400']]);
});

test('the built index.html has no inline script, so script-src needs no hash or nonce', () => {
  let html;
  try {
    html = readFileSync(join(customer, 'dist/index.html'), 'utf8');
  } catch {
    return; // not built; the proxy test requires dist as well
  }
  assert.deepEqual(
    [...html.matchAll(/<script\b([^>]*)>/g)].filter((m) => !/\bsrc="\/assets\//.test(m[1])).map((m) => m[0]),
    [],
  );
  assert.doesNotMatch(html, /\son[a-z]+="/i, 'no inline event handlers');
});

test('nginx accepts the config with the snippets in place', (t) => {
  const probe = spawnSync(process.env.NGINX_BINARY || 'nginx', ['-v'], { encoding: 'utf8' });
  if (probe.error) return t.skip('nginx is not installed');
  const temp = mkdtempSync(join(tmpdir(), 'intafaced-customer-headers-'));
  try {
    installSnippets(join(temp, 'snippets'), {
      CUSTOMER_LIVEKIT_ORIGIN: 'wss://lk.example.com',
      CUSTOMER_STORAGE_ORIGIN: 'https://s3.example.com',
    });
    const source = conf
      .replaceAll('/etc/nginx/snippets/', `${join(temp, 'snippets')}/`)
      .replace('/usr/share/nginx/html', temp)
      .replaceAll('svc-edge:4000', '127.0.0.1:1')
      .replaceAll('svc-ws:4014', '127.0.0.1:1')
      // nginx -t binds the listen sockets; port 80 needs root, which a CI runner's user is not.
      .replace(/listen 80;/, 'listen 127.0.0.1:18080;')
      .replace(/listen \[::\]:80;/, 'listen 127.0.0.1:18081;');
    const config = join(temp, 'nginx.conf');
    writeFileSync(
      config,
      `daemon off;\npid ${temp}/nginx.pid;\nerror_log ${temp}/error.log;\nevents {}\nhttp { access_log off;\n${source}\n}`,
    );
    const syntax = spawnSync(process.env.NGINX_BINARY || 'nginx', ['-t', '-p', temp, '-c', config], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

const cspOf = (rendered) =>
  Object.fromEntries(
    rendered
      .match(/Content-Security-Policy "([^"]+)"/)[1]
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .map(([name, ...sources]) => [name, sources]),
  );

test('unset deploy variables give the tight default: no external connect or media origin, no bare wss:', () => {
  const csp = cspOf(renderSecurityHeaders());
  assert.deepEqual(csp['connect-src'], ["'self'"]);
  assert.deepEqual(csp['media-src'], ["'self'", 'blob:']);
});

test('deploy variables name the LiveKit and storage origins exactly, never a wildcard scheme', () => {
  const csp = cspOf(
    renderSecurityHeaders({
      CUSTOMER_LIVEKIT_ORIGIN: 'wss://lk.example.com',
      CUSTOMER_STORAGE_ORIGIN: 'https://s3.eu-west-1.amazonaws.com',
      CUSTOMER_MEDIA_ORIGINS: 'https://a.example.com https://*.cdn.example.com',
    }),
  );
  assert.deepEqual(csp['connect-src'], ["'self'", 'wss://lk.example.com', 'https://lk.example.com']);
  assert.deepEqual(csp['media-src'], [
    "'self'",
    'blob:',
    'https://s3.eu-west-1.amazonaws.com',
    'https://a.example.com',
    'https://*.cdn.example.com',
  ]);
  for (const sources of Object.values(csp)) assert.ok(!sources.some((source) => /^(wss?|https?):$/.test(source)), 'no bare scheme source');
  assert.deepEqual(cspOf(renderSecurityHeaders({ CUSTOMER_LIVEKIT_ORIGIN: 'lk.example.com:7443' }))['connect-src'], [
    "'self'",
    'wss://lk.example.com:7443',
    'https://lk.example.com:7443',
  ]);
  assert.deepEqual(cspOf(renderSecurityHeaders({ CUSTOMER_LIVEKIT_ORIGIN: 'ws://localhost:7880' }))['connect-src'], [
    "'self'",
    'ws://localhost:7880',
    'http://localhost:7880',
  ]);
});

test('an invalid origin stops rendering instead of widening the policy', () => {
  for (const env of [
    { CUSTOMER_STORAGE_ORIGIN: "https://x.example.com; script-src 'unsafe-inline'" },
    { CUSTOMER_STORAGE_ORIGIN: 'http://insecure.example.com' },
    { CUSTOMER_MEDIA_ORIGINS: 'https://' },
    { CUSTOMER_MEDIA_ORIGINS: '*' },
    { CUSTOMER_LIVEKIT_ORIGIN: 'wss://lk.example.com/path' },
    { CUSTOMER_LIVEKIT_ORIGIN: 'ftp://lk.example.com' },
    { CUSTOMER_LIVEKIT_ORIGIN: 'wss:' },
    // A newline lets a second line smuggle directives past a line-by-line grep; the character whitelist refuses it.
    { CUSTOMER_LIVEKIT_ORIGIN: 'lk.example.com\nevil.example; worker-src *; report-uri /r' },
    { CUSTOMER_LIVEKIT_ORIGIN: 'lk.example.com\n' },
    { CUSTOMER_LIVEKIT_ORIGIN: 'wss://lk.example.com extra.example.com' },
    { CUSTOMER_STORAGE_ORIGIN: 'https://s3.example.com\nx; worker-src *' },
    { CUSTOMER_MEDIA_ORIGINS: 'https://a.example.com\nhttps://b.example.com;x' },
  ]) {
    assert.throws(() => renderSecurityHeaders(env), /customer csp/, JSON.stringify(env));
  }
});

test('the template substitutes only its two CUSTOMER_CSP_ placeholders, so nginx $variables stay untouched', () => {
  const template = read('security-headers.conf.template').replace(/#.*$/gm, '');
  assert.deepEqual([...new Set([...template.matchAll(/\$\{?([A-Za-z_]+)/g)].map((m) => m[1]))].sort(), [
    'CUSTOMER_CSP_CONNECT_SRC',
    'CUSTOMER_CSP_MEDIA_SRC',
  ]);
  assert.doesNotMatch(renderSecurityHeaders(), /\$\{/);
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /NGINX_ENVSUBST_FILTER=\^CUSTOMER_CSP_/);
  assert.match(dockerfile, /NGINX_ENVSUBST_OUTPUT_DIR=\/etc\/nginx\/snippets/);
});

test('securityHeaders gives a non-nginx server the same headers, word for word', async () => {
  const { securityHeaders } = await import('./render-security-headers.mjs');
  const fromNginx = Object.fromEntries(headers(renderSecurityHeaders({})).map(([k, v]) => [k, v]));
  const local = Object.fromEntries(Object.entries(securityHeaders()).map(([k, v]) => [k.toLowerCase(), v]));
  assert.deepEqual(local, fromNginx, 'with no origins it equals the container render');
  const withMedia = securityHeaders({ mediaSrc: "'self' blob: http://127.0.0.1:3240", reportUri: '/__csp-report' });
  const csp = withMedia['Content-Security-Policy'];
  assert.match(csp, /media-src 'self' blob: http:\/\/127\.0\.0\.1:3240;/);
  assert.match(csp, /script-src 'self';/);
  assert.match(csp, /; report-uri \/__csp-report$/);
  for (const bad of ["'self'; script-src *", "'self' 'unsafe-eval'", '*', 'https://*.example.com', "'self'  blob:"])
    assert.throws(() => securityHeaders({ connectSrc: bad }), /cannot hold/, bad);
  assert.doesNotThrow(() => securityHeaders({ connectSrc: "'self' wss://lk.example.com https://s3.example.com:9000" }));
  assert.throws(() => securityHeaders({ reportUri: 'https://evil.test/r' }), /same-origin path/);
});

test('apiSecurityHeaders is the /api/ snippet', async () => {
  const { apiSecurityHeaders } = await import('./render-security-headers.mjs');
  const api = Object.entries(apiSecurityHeaders()).map(([k, v]) => [k.toLowerCase(), v]);
  assert.deepEqual(api, headers(read('security-headers-api.conf')));
});
