/**
 * The stack's TEST HTTPS front for the founder console: a real certificate from openssl, a real upstream, no stack.
 * Run: node --test tooling/scripts/local-test-team-tls.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { certValidUntil, ensureTestCert, httpsGetTrusting, serveTeamTls } from './local-test-team-tls.mjs';

test('makes a private TEST certificate for 127.0.0.1 once, and again only when it is about to expire', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-tls-'));
  const { key, cert } = ensureTestCert(dir);
  assert.equal(fs.statSync(key).mode & 0o777, 0o600);
  assert.equal(fs.statSync(cert).mode & 0o777, 0o600);
  const until = certValidUntil(fs.readFileSync(cert, 'utf8'));
  assert.ok(until > Date.now() + 20 * 24 * 3600 * 1000);
  let calls = 0;
  const counting = (...args) => (calls++, { status: 0 });
  ensureTestCert(dir, { run: counting });
  assert.equal(calls, 0, 'a valid certificate is kept');
  ensureTestCert(dir, { run: counting, now: until - 3600 * 1000 });
  assert.equal(calls, 1, 'one with under a day left is made again');
  assert.throws(() => ensureTestCert(dir, { run: () => ({ status: 1, stderr: 'no' }), now: until }), /could not make the TEST certificate/);
  assert.equal(certValidUntil('not a certificate'), 0);
});

test('passes requests to the plain-http console over HTTPS, telling it the scheme, and refuses an untrusted client', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-tls-'));
  const { key, cert } = ensureTestCert(dir);
  let seen;
  const upstream = http.createServer((req, res) => {
    seen = { url: req.url, proto: req.headers['x-forwarded-proto'], host: req.headers.host };
    res.writeHead(201).end('ok');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const front = await serveTeamTls({ host: '127.0.0.1', port: 0, upstream: `http://127.0.0.1:${upstream.address().port}`, key, cert });
  t.after(() => (front.close(), upstream.close()));
  const url = `https://127.0.0.1:${front.address().port}/ops?x=1`;
  assert.deepEqual(await httpsGetTrusting(url, cert), { status: 201 });
  assert.deepEqual(seen, { url: '/ops?x=1', proto: 'https', host: `127.0.0.1:${front.address().port}` });
  const other = ensureTestCert(fs.mkdtempSync(path.join(os.tmpdir(), 'team-tls-')));
  assert.deepEqual(await httpsGetTrusting(url, other.cert), { status: 0 }, 'verification stays on: another certificate is refused');
  upstream.close();
  await new Promise((r) => upstream.once('close', r));
  assert.deepEqual(await httpsGetTrusting(url, cert), { status: 502 }, 'a console that is down is a 502, not a hang');
});
