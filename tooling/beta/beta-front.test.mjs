import assert from 'node:assert/strict';
import test from 'node:test';
import { PUBLIC_ORIGIN, VIEWER_HEADER, appRequestHeaders, publicLocation, viewerFromAccess, viewerToken } from './beta-front.mjs';
import { viewerRows } from './beta-host.mjs';

test('the public origin becomes the stack loopback origin; any other origin passes unchanged, so Edge still refuses it', () => {
  assert.equal(appRequestHeaders({ origin: PUBLIC_ORIGIN, host: 'beta.intafaced.com' }).origin, 'http://localhost:6210');
  assert.equal(appRequestHeaders({ origin: 'https://evil.example' }).origin, 'https://evil.example');
  assert.equal(appRequestHeaders({ origin: `${PUBLIC_ORIGIN}.evil.example` }).origin, `${PUBLIC_ORIGIN}.evil.example`);
  assert.equal(appRequestHeaders({ origin: 'http://beta.intafaced.com' }).origin, 'http://beta.intafaced.com');
  assert.equal(appRequestHeaders({}).host, 'localhost:6210');
  assert.equal(appRequestHeaders({ referer: `${PUBLIC_ORIGIN}/trade` }).referer, 'http://localhost:6210/trade');
  assert.equal(appRequestHeaders({ referer: `${PUBLIC_ORIGIN}.evil.example/x` }).referer, `${PUBLIC_ORIGIN}.evil.example/x`);
});

test("Cloudflare Access's token never reaches the stack; the app's own cookies do", () => {
  const h = appRequestHeaders({ 'cf-access-jwt-assertion': 'jwt', cookie: 'CF_Authorization=jwt; ifc_rt=r' });
  assert.equal(h['cf-access-jwt-assertion'], undefined);
  assert.equal(h.cookie, 'ifc_rt=r');
  assert.equal(appRequestHeaders({ cookie: 'CF_Authorization=jwt' }).cookie, undefined);
});

test('hop-by-hop headers are dropped, except on a WebSocket handshake', () => {
  assert.equal(appRequestHeaders({ connection: 'keep-alive', upgrade: 'websocket' }).upgrade, undefined);
  assert.equal(appRequestHeaders({ connection: 'Upgrade', upgrade: 'websocket' }, { upgrade: true }).upgrade, 'websocket');
});

test('a Location on the loopback origin points at the public origin; others stay', () => {
  assert.equal(publicLocation('http://localhost:6210/home'), `${PUBLIC_ORIGIN}/home`);
  assert.equal(publicLocation('http://127.0.0.1:6210'), PUBLIC_ORIGIN);
  assert.equal(publicLocation('https://evil.example/x'), 'https://evil.example/x');
  assert.equal(publicLocation('http://localhost:62100/x'), 'http://localhost:62100/x');
});

test("the mailbox's viewer comes from the Access token's email; without a token there is no viewer", () => {
  const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
  assert.equal(viewerToken('Alice@Gmail.com'), viewerToken('alice@gmail.com'));
  assert.match(viewerToken('alice@gmail.com'), /^alice-gmail-com-[0-9a-f]{10}$/);
  assert.equal(viewerToken('no at sign'), null);
  assert.equal(viewerFromAccess({ 'cf-access-jwt-assertion': jwt({ email: 'alice@gmail.com' }) }), viewerToken('alice@gmail.com'));
  assert.equal(viewerFromAccess({ cookie: `x=1; CF_Authorization=${jwt({ email: 'bob@x.io' })}` }), viewerToken('bob@x.io'));
  assert.equal(viewerFromAccess({}), null);
  assert.equal(viewerFromAccess({ 'cf-access-jwt-assertion': 'not-a-jwt' }), null);
  assert.equal(viewerFromAccess({ 'cf-access-jwt-assertion': jwt({ sub: 'no email' }) }), null);
  assert.equal(VIEWER_HEADER, 'x-beta-viewer');
});

test("each viewer sees only the mail of the TEST addresses they created; no token reaches another viewer's", () => {
  const people = ['alice@gmail.com', 'alice@gmail.com.au', 'john.smith@outlook.com', 'john_smith@outlook.com', 'a.b@x.io', 'a@b.x.io'];
  const tokens = people.map(viewerToken);
  assert.equal(new Set(tokens).size, people.length, 'one token per email');
  const rows = tokens.flatMap((t, i) => [
    { email: `${t}@local-test.invalid`, code: `${i}a` },
    { email: `${t}.2@local-test.invalid`, code: `${i}b` },
  ]);
  rows.push({ email: 'nino1@local-test.invalid', code: 'old' });
  tokens.forEach((t, i) =>
    assert.deepEqual(
      viewerRows(rows, t).map((r) => r.code),
      [`${i}a`, `${i}b`],
      people[i],
    ),
  );
  assert.deepEqual(viewerRows(rows, ''), []);
  assert.deepEqual(viewerRows(rows, null), []);
});
