/**
 * The stack's TEST HTTPS front for the founder console: a real certificate from openssl, no stack.
 * Run: node --test tooling/scripts/local-test-team-tls.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { certValidUntil, ensureTestCert, httpsGetTrusting, serveTeamTls } from './local-test-team-tls.mjs';

const tempDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-tls-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('makes a private TEST certificate for 127.0.0.1 once, and again only when it is about to expire', (t) => {
  const dir = tempDir(t);
  const { key, cert } = ensureTestCert(dir);
  assert.equal(fs.statSync(key).mode & 0o777, 0o600);
  assert.equal(fs.statSync(cert).mode & 0o777, 0o600);
  const until = certValidUntil(fs.readFileSync(cert, 'utf8'));
  assert.ok(until > Date.now() + 20 * 24 * 3600 * 1000);
  let calls = 0;
  const counting = () => (calls++, { status: 0 });
  ensureTestCert(dir, { run: counting });
  assert.equal(calls, 0, 'a valid certificate is kept');
  ensureTestCert(dir, { run: counting, now: until - 3600 * 1000 });
  assert.equal(calls, 1, 'one with under a day left is made again');
  assert.throws(() => ensureTestCert(dir, { run: () => ({ status: 1, stderr: 'no' }), now: until }), /could not make the TEST certificate/);
  assert.equal(certValidUntil('not a certificate'), 0);
});

test('sends every path on to the console over a certificate a client must trust; an untrusted certificate is refused', async (t) => {
  const { key, cert } = ensureTestCert(tempDir(t));
  const front = await serveTeamTls({ host: '127.0.0.1', port: 0, target: 'http://127.0.0.1:3100', key, cert });
  t.after(() => front.close());
  const at = `https://127.0.0.1:${front.address().port}`;
  assert.deepEqual(await httpsGetTrusting(`${at}/ops?x=1`, cert), { status: 308, location: 'http://127.0.0.1:3100/ops?x=1' });
  assert.deepEqual(await httpsGetTrusting(`${at}//elsewhere.example/x`, cert), { status: 400, location: undefined }, 'never another host');
  const other = ensureTestCert(tempDir(t));
  assert.deepEqual(await httpsGetTrusting(`${at}/ops`, other.cert), { status: 0 }, 'verification stays on');
});
