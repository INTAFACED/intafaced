import assert from 'node:assert/strict';
import test from 'node:test';
import { PUBLIC_ORIGIN, appRequestHeaders, publicLocation } from './beta-front.mjs';

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
