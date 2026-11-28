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

// #11027: the address each caller reaches the stack with. Cloudflare's Cf-Connecting-Ip, else the front's own peer; every
// forwarding header a caller sent is dropped, so nobody names another address.
test('the front sends the caller address from Cf-Connecting-Ip and drops every forwarding header a caller sent', () => {
  const h = appRequestHeaders(
    {
      'cf-connecting-ip': '203.0.113.10',
      'x-forwarded-for': '192.0.2.1',
      'x-real-ip': '192.0.2.1',
      forwarded: 'for=192.0.2.1',
      'x-forwarded-host': 'evil.example',
    },
    { peer: '127.0.0.1' },
  );
  assert.equal(h['x-forwarded-for'], '203.0.113.10');
  assert.equal(h['x-real-ip'], undefined);
  assert.equal(h.forwarded, undefined);
  assert.equal(h['x-forwarded-host'], undefined);
  assert.equal(appRequestHeaders({ 'x-forwarded-for': '192.0.2.1' }, { peer: '127.0.0.1' })['x-forwarded-for'], '127.0.0.1');
  assert.equal(appRequestHeaders({ 'cf-connecting-ip': 'not-an-ip' }, { peer: '127.0.0.1' })['x-forwarded-for'], '127.0.0.1');
  assert.equal(
    appRequestHeaders({ 'cf-connecting-ip': '2001:db8::1' }, { upgrade: true, peer: '127.0.0.1' })['x-forwarded-for'],
    '2001:db8::1',
  );
});

test("two callers through the front get two of Edge's rate-limit buckets; a spoofed forwarded header is ignored", async () => {
  const { createRequire } = await import('node:module');
  const http = await import('node:http');
  const { frontApp } = await import('./beta-front.mjs');
  const { forwardedFor } = await import('../scripts/local-test-stack.mjs');
  const edgeRequire = createRequire(new URL('../../services/svc-edge/package.json', import.meta.url));
  const Fastify = edgeRequire('fastify');
  const rateLimit = edgeRequire('@fastify/rate-limit');
  const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

  // Edge as the beta stack starts it: trustProxy is EDGE_TRUST_PROXY (tooling/scripts/local-stack-services/edge.mjs).
  const edgeDefs = (await import('../scripts/local-stack-services/edge.mjs')).default;
  const edgeEnv = (origin) =>
    edgeDefs({
      c: () => ({}),
      secrets: {},
      urlOf: () => 'http://127.0.0.1:1',
      PORTS: { edge: 1 },
      P: { data: '/x' },
      UNUSED: 'x',
      PUBLIC_ORIGIN: origin,
      EDGE_UPSTREAMS: {},
      EDGE_ABSENT: {},
    }).env();
  assert.equal(edgeEnv(null).EDGE_TRUST_PROXY, undefined, 'a stack reached directly trusts no forwarded header');
  const edge = Fastify({ trustProxy: edgeEnv('https://beta.intafaced.com').EDGE_TRUST_PROXY });
  await edge.register(rateLimit, { max: 1, timeWindow: 60_000 });
  edge.get('/api/x', async (req) => ({ ip: req.ip }));
  await edge.listen({ port: 0, host: '127.0.0.1' });
  const edgePort = edge.server.address().port;

  // The stack's Customer server's forwarding, behind a front (LOCAL_STACK_PUBLIC_ORIGIN set).
  const customer = http.createServer((req, res) => {
    const headers = { ...req.headers, 'x-forwarded-for': forwardedFor(req.headers['x-forwarded-for'], req.socket.remoteAddress, true) };
    const up = http.request({ host: '127.0.0.1', port: edgePort, method: req.method, path: req.url, headers }, (ur) => {
      res.writeHead(ur.statusCode, ur.headers);
      ur.pipe(res);
    });
    req.pipe(up);
  });
  const customerPort = await listen(customer);
  const front = frontApp({ upstream: customerPort, statusFile: '/nonexistent/status.json' });
  const frontPort = await listen(front);

  const call = (headers) =>
    new Promise((resolve, reject) => {
      const r = http.request(
        {
          host: '127.0.0.1',
          port: frontPort,
          path: '/api/x',
          headers: { host: 'beta.intafaced.com', accept: 'application/json', ...headers },
        },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode, body }));
        },
      );
      r.on('error', reject);
      r.end();
    });
  try {
    const a1 = await call({ 'cf-connecting-ip': '203.0.113.10' });
    assert.equal(a1.status, 200);
    assert.equal(JSON.parse(a1.body).ip, '203.0.113.10');
    const b1 = await call({ 'cf-connecting-ip': '198.51.100.7' });
    assert.equal(b1.status, 200, 'a second caller has a bucket of its own');
    assert.equal(JSON.parse(b1.body).ip, '198.51.100.7');
    // The first caller, spent, claims a fresh address in a forwarded header: still its own bucket, refused.
    const a2 = await call({ 'cf-connecting-ip': '203.0.113.10', 'x-forwarded-for': '192.0.2.99', 'x-real-ip': '192.0.2.99' });
    assert.equal(a2.status, 429);
  } finally {
    front.close();
    customer.close();
    await edge.close();
  }
});

// #11217: on the beta, a sign-up only works with the viewer's own TEST address, the only one whose code the mailbox
// shows them; any other address is refused before it reaches the stack, with the address to use and the mailbox.
test("a sign-up with any address but the viewer's TEST address is refused at the front, naming the address and the mailbox", async () => {
  const http = await import('node:http');
  const { frontApp, MAILBOX_URL } = await import('./beta-front.mjs');
  const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"result":{"data":{"accepted":true}}}');
    });
  });
  const upPort = await listen(upstream);
  const front = frontApp({ upstream: upPort, statusFile: '/nonexistent/status.json' });
  const frontPort = await listen(front);
  const token = viewerToken('alice@gmail.com');
  const signUp = (input, headers = {}) =>
    new Promise((resolve, reject) => {
      const body = JSON.stringify(input);
      const r = http.request(
        {
          host: '127.0.0.1',
          port: frontPort,
          method: 'POST',
          path: '/api/identity/trpc/auth.signUpStart',
          headers: {
            host: 'beta.intafaced.com',
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            ...headers,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      r.on('error', reject);
      r.end(body);
    });
  const alice = { cookie: `CF_Authorization=${jwt({ email: 'alice@gmail.com' })}` };
  const form = { channel: 'email', handle: 'alice1', password: 'x', country: 'DE', dateOfBirth: '1990-01-01', accountType: 'individual' };
  try {
    for (const email of [
      'alice@gmail.com',
      `${viewerToken('bob@x.io')}.1@local-test.invalid`,
      `${token}.1@example.com`,
      `${token}x@local-test.invalid`,
    ]) {
      const answer = await signUp({ ...form, email }, alice);
      assert.equal(answer.status, 400, email);
      const error = JSON.parse(answer.text).error;
      assert.equal(error.data.code, 'beta.signup_address_not_yours', email);
      assert.ok(error.message.includes(`${token}.1@local-test.invalid`), `names the address to use: ${error.message}`);
      assert.ok(error.message.includes(MAILBOX_URL), `names the mailbox: ${error.message}`);
    }
    assert.equal(seen.length, 0, 'a refused sign-up never reaches the stack');
    for (const email of [`${token}.1@local-test.invalid`, `${token}@local-test.invalid`, `${token.toUpperCase()}.Two@Local-Test.Invalid`]) {
      const answer = await signUp({ ...form, email }, alice);
      assert.equal(answer.status, 200, email);
      assert.equal(JSON.parse(seen.at(-1).body).email, email, 'the body reaches the stack unchanged');
    }
    // No Access token (the box's own loopback): the front names no viewer and leaves the stack to answer.
    assert.equal((await signUp({ ...form, email: 'alice@gmail.com' })).status, 200);
    assert.equal(seen.length, 4);
  } finally {
    front.close();
    upstream.close();
  }
});
