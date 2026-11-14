import test from 'node:test';
import assert from 'node:assert/strict';
import { keptSession, tokenEnds, KEEP_MARGIN_MS } from './kept-session.mjs';

const jwt = (exp) => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;

test('a token is read for its end from its exp', () => {
  assert.equal(tokenEnds(jwt(1_000)), 1_000_000);
  assert.equal(tokenEnds('not-a-jwt'), null);
  assert.equal(tokenEnds(`h.${Buffer.from('{}').toString('base64url')}.s`), null);
});

test('twenty reads on one session sign in once, so they wait for one authenticator code, not twenty', async () => {
  let now = 0;
  let signIns = 0;
  const token = keptSession(async () => jwt(900 + 900 * signIns++), { now: () => now });
  for (let i = 0; i < 20; i += 1) {
    assert.equal(await token(), jwt(900));
    now += 30_000;
  }
  assert.equal(signIns, 1);
});

test('a token near its end, a dropped one, or one with no end is signed in again', async () => {
  let now = 0;
  let signIns = 0;
  const token = keptSession(async () => jwt(900 * ++signIns), { now: () => now });
  assert.equal(await token(), jwt(900));
  now = 900_000 - KEEP_MARGIN_MS;
  assert.equal(await token(), jwt(1_800), 'within the margin of its end, a new sign-in');
  token.drop();
  assert.equal(await token(), jwt(2_700), 'dropped after a 401, a new sign-in');
  assert.equal(signIns, 3);

  let plain = 0;
  const opaque = keptSession(async () => `opaque-${++plain}`);
  assert.equal(await opaque(), 'opaque-1');
  assert.equal(await opaque(), 'opaque-2', 'a token with no readable end is never kept');
  await assert.rejects(keptSession(async () => null)(), /no access token/);
});

test('reads that ask at once share one sign-in', async () => {
  let signIns = 0;
  const token = keptSession(async () => {
    signIns += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return jwt(Date.now() / 1000 + 900);
  });
  const [a, b] = await Promise.all([token(), token()]);
  assert.equal(a, b);
  assert.equal(signIns, 1);
});
