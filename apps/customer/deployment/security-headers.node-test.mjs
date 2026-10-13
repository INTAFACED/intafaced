import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const full = new Map(headers(read('security-headers.conf')));
  assert.equal(full.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
  assert.equal(full.get('x-content-type-options'), 'nosniff');
  assert.equal(full.get('x-frame-options'), 'DENY');
  assert.equal(full.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(full.get('cross-origin-opener-policy'), 'same-origin');
  for (const [name, value] of full) assert.ok(value.trim(), `${name} is not empty`);
  assert.doesNotMatch(full.get('strict-transport-security'), /preload/);

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

  assert.deepEqual(headers(read('security-headers-api.conf')), [['strict-transport-security', 'max-age=31536000; includeSubDomains']]);
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
    const source = conf
      .replaceAll('/etc/nginx/snippets/', `${customer}/`)
      .replace('/usr/share/nginx/html', temp)
      .replaceAll('svc-edge:4000', '127.0.0.1:1')
      .replaceAll('svc-ws:4014', '127.0.0.1:1');
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
