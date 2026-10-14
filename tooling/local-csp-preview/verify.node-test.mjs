// Run while the preview is up:  node --test tooling/local-csp-preview/verify.node-test.mjs
// Proves the headers the preview serves are byte-identical to what the repo's own renderer
// (apps/customer/deployment/render-security-headers.mjs, the one security-headers.node-test.mjs uses) produces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSecurityHeaders } from '../../apps/customer/deployment/render-security-headers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', '..', 'apps', 'customer', 'dist', 'assets');
const BASE = Number(process.env.CSP_PREVIEW_BASE_PORT ?? 18080);
const CONFIGURED = { CUSTOMER_LIVEKIT_ORIGIN: `ws://127.0.0.1:${BASE + 4}`, CUSTOMER_STORAGE_ORIGIN: 'https://storage.csp-preview.invalid' };
const instances = [
  { kind: 'configured', port: BASE, env: CONFIGURED, container: `csp-preview-customer-${BASE}` },
  { kind: 'bare', port: BASE + 1, env: {}, container: `csp-preview-customer-${BASE + 1}` },
  ...(existsSync(join(here, '.state', 'dist-ribbon', 'index.html'))
    ? [
        { kind: 'academyConfigured', port: BASE + 5, env: CONFIGURED, container: `csp-preview-customer-${BASE + 5}` },
        { kind: 'academyBare', port: BASE + 6, env: {}, container: `csp-preview-customer-${BASE + 6}` },
      ]
    : []),
];
const parse = (snippet) =>
  new Map([...snippet.matchAll(/^add_header\s+(\S+)\s+"((?:[^"\\]|\\.)*)"\s+always;/gm)].map((m) => [m[1].toLowerCase(), m[2]]));
const asset = readdirSync(dist).find((f) => f.endsWith('.js'));

for (const { kind, port, env, container } of instances) {
  const expected = parse(renderSecurityHeaders(env));
  test(`${kind}: the snippet nginx rendered in the container is byte-identical to the repo renderer`, () => {
    const inside = spawnSync('docker', ['exec', container, 'cat', '/etc/nginx/snippets/security-headers.conf'], { encoding: 'utf8' });
    assert.equal(inside.status, 0, inside.stderr);
    assert.equal(inside.stdout, renderSecurityHeaders(env));
  });
  for (const path of ['/', '/login', '/index.html', `/assets/${asset}`, '/no-such-room', '/assets/missing.js', '/__csp-preview/', '/customer-deployment.json']) {
    test(`${kind} :${port}${path === `/assets/${asset}` ? '/assets/<hash>.js' : path} carries every shipped header with the exact value`, async () => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      for (const [name, value] of expected) assert.equal(res.headers.get(name), value, name);
      assert.equal(res.headers.get('content-security-policy-report-only'), `${expected.get('content-security-policy')}; report-uri /__csp-report`);
    });
  }
  test(`${kind}: /api responses keep the shipped API snippet (HSTS only, no document CSP)`, async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/markets`);
    assert.equal(res.headers.get('strict-transport-security'), 'max-age=86400');
    assert.equal(res.headers.get('content-security-policy'), null);
    assert.equal(res.headers.get('x-csp-preview'), 'TEST-DATA-STUB');
  });
}
test('configured CSP names the LiveKit and storage origins; bare CSP names none', () => {
  const csp = (env) => parse(renderSecurityHeaders(env)).get('content-security-policy');
  assert.match(csp(CONFIGURED), new RegExp(`connect-src 'self' ws://127\\.0\\.0\\.1:${BASE + 4} http://127\\.0\\.0\\.1:${BASE + 4};`));
  assert.match(csp(CONFIGURED), /media-src 'self' blob: https:\/\/storage\.csp-preview\.invalid;/);
  assert.match(csp({}), /connect-src 'self'; media-src 'self' blob:;/);
});
test('a bad origin variable still stops rendering (the container would refuse to start)', () => {
  assert.throws(() => renderSecurityHeaders({ CUSTOMER_LIVEKIT_ORIGIN: 'wss://x.example.com; script-src *' }));
});
