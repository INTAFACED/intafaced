// app-token.mjs: the App's JWT verifies only with its key, and a minted token is refused unless GitHub grants exactly
// the permissions asked for (metadata aside). Moved from the removed factory-builder.test.mjs. tooling-tests.mjs runs it.
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { appJwt, mintToken } from './app-token.mjs';
import { REVERT_TOKEN } from './journeys-revert.mjs';

const KEYS = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = KEYS.privateKey.export({ type: 'pkcs1', format: 'pem' });

/** A JWT's claims, if its RS256 signature verifies with the public key; else null. */
function verifiedClaims(jwt, publicKey = KEYS.publicKey) {
  const [h, c, sig] = String(jwt).split('.');
  const ok = createVerify('RSA-SHA256')
    .update(`${h}.${c}`)
    .verify(publicKey, Buffer.from(sig ?? '', 'base64url'));
  return ok ? JSON.parse(Buffer.from(c, 'base64url').toString()) : null;
}

test("the App's JWT is RS256 by its client id, nine minutes long, and verifies only with its key", () => {
  const now = Date.UTC(2026, 10, 8, 15, 0, 0);
  const claims = verifiedClaims(appJwt(PEM, now));
  assert.deepEqual(claims, { iat: now / 1000 - 60, exp: now / 1000 - 60 + 540, iss: 'Iv23lihKJK3UhiuiTgLa' });
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.equal(verifiedClaims(appJwt(PEM, now), other.publicKey), null, 'another key does not verify it');
});

test('a minted token is refused unless GitHub grants exactly what was asked (metadata aside)', async () => {
  const spec = REVERT_TOKEN;
  const fake = (granted) => (token) => ({
    json: async (path) => {
      assert.equal(path, '/repos/o/r/installation');
      assert.ok(verifiedClaims(token), 'the installation is looked up with the signed JWT');
      return { id: 7 };
    },
    send: async (method, path, body) => {
      assert.equal(`${method} ${path}`, 'POST /app/installations/7/access_tokens');
      assert.deepEqual(body, spec);
      return { token: 'ghs_x', permissions: granted };
    },
  });
  assert.equal(await mintToken({ pem: PEM, repo: 'o/r', spec, apiFor: fake({ ...spec.permissions, metadata: 'read' }) }), 'ghs_x');
  await assert.rejects(
    mintToken({ pem: PEM, repo: 'o/r', spec, apiFor: fake({ ...spec.permissions, workflows: 'write' }) }),
    /a permission it was not asked for/,
  );
  await assert.rejects(
    mintToken({ pem: PEM, repo: 'o/r', spec, apiFor: fake({ ...spec.permissions, contents: 'read' }) }),
    /contents permission is read, not write/,
  );
});
