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
  assert.equal(viewerToken('Alice@Gmail.com'), 'alice-gmail-com');
  assert.equal(viewerFromAccess({ 'cf-access-jwt-assertion': jwt({ email: 'alice@gmail.com' }) }), 'alice-gmail-com');
  assert.equal(viewerFromAccess({ cookie: `x=1; CF_Authorization=${jwt({ email: 'bob@x.io' })}` }), 'bob-x-io');
  assert.equal(viewerFromAccess({}), null);
  assert.equal(viewerFromAccess({ 'cf-access-jwt-assertion': 'not-a-jwt' }), null);
  assert.equal(viewerFromAccess({ 'cf-access-jwt-assertion': jwt({ sub: 'no email' }) }), null);
  assert.equal(VIEWER_HEADER, 'x-beta-viewer');
});

test("each viewer sees only the mail of the TEST addresses they created; one token never reaches another's", () => {
  const rows = [
    { email: 'alice-gmail-com@local-test.invalid', code: '111111' },
    { email: 'alice-gmail-com.2@local-test.invalid', code: '222222' },
    { email: 'alice-gmail-com-au.1@local-test.invalid', code: '333333' },
    { email: 'nino1@local-test.invalid', code: '444444' },
  ];
  const codes = (token) => viewerRows(rows, token).map((r) => r.code);
  assert.deepEqual(codes(viewerToken('alice@gmail.com')), ['111111', '222222']);
  assert.deepEqual(codes(viewerToken('alice@gmail.com.au')), ['333333']);
  assert.deepEqual(codes(''), []);
  assert.deepEqual(codes(null), []);
});
