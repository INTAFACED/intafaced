import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installSnippets } from './render-security-headers.mjs';

const customer = dirname(dirname(fileURLToPath(import.meta.url)));
const binary = process.env.NGINX_BINARY || 'nginx';
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const stop = (server) =>
  new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });

const securityHeaders = {
  'strict-transport-security': 'max-age=86400',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'cross-origin-opener-policy': 'same-origin',
};
function assertSecurityHeaders(response, label) {
  for (const [name, value] of Object.entries(securityHeaders)) assert.equal(response.headers.get(name), value, `${label}: ${name}`);
  const csp = response.headers.get('content-security-policy');
  assert.match(csp, /(^|; )script-src 'self'(;|$)/, `${label}: script-src is self only`);
  assert.doesNotMatch(csp.match(/script-src [^;]*/)[0], /unsafe-inline|unsafe-eval/, label);
  assert.match(csp, /frame-ancestors 'none'/, label);
  const permissions = response.headers.get('permissions-policy');
  assert.match(permissions, /geolocation=\(\)/, label);
  assert.doesNotMatch(permissions, /publickey-credentials/, `${label}: passkeys must keep their default allowlist`);
}

test('customer proxy serves React deep links, refuses bare API paths, caches assets, and preserves edge/WS contracts', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'intafaced-customer-proxy-'));
  const api = createServer((req, res) => {
    let body = '';
    req.on('data', (data) => {
      body += data;
    });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.setHeader('set-cookie', 'session=opaque; HttpOnly; SameSite=Lax; Path=/');
      res.end(
        JSON.stringify({
          path: req.url,
          method: req.method,
          cookie: req.headers.cookie,
          authorization: req.headers.authorization,
          origin: req.headers.origin,
          body,
        }),
      );
    });
  });
  const sockets = new Set();
  let upgrade;
  const ws = createServer((req, res) => {
    res.end('not upgraded');
  });
  ws.on('upgrade', (req, socket) => {
    upgrade = { path: req.url, cookie: req.headers.cookie, connection: req.headers.connection, upgrade: req.headers.upgrade };
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const accept = createHash('sha1')
      .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.write(Buffer.from([0x81, 0x05, ...Buffer.from('hello')]));
  });
  let nginx;
  try {
    const apiPort = await listen(api),
      wsPort = await listen(ws);
    const portReservation = createServer();
    const port = await listen(portReservation);
    await stop(portReservation);
    installSnippets(join(temp, 'snippets'));
    const source = readFileSync(join(customer, 'nginx.conf'), 'utf8')
      .replace('listen 80;', `listen 127.0.0.1:${port};`)
      .replace('listen [::]:80;', '')
      .replace('/usr/share/nginx/html', join(customer, 'dist'))
      .replaceAll('/etc/nginx/snippets/', `${join(temp, 'snippets')}/`)
      .replaceAll('svc-edge:4000', `127.0.0.1:${apiPort}`)
      .replaceAll('svc-ws:4014', `127.0.0.1:${wsPort}`);
    const config = join(temp, 'nginx.conf');
    writeFileSync(
      config,
      `daemon off;\npid ${temp}/nginx.pid;\nerror_log ${temp}/error.log;\nevents {}\nhttp { access_log off; types { text/html html; application/javascript js; text/css css; }\n${source}\n}`,
    );
    const syntax = spawnSync(binary, ['-t', '-p', temp, '-c', config], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr || syntax.error?.message || 'NGINX_BINARY must point to a real Nginx executable');
    nginx = spawn(binary, ['-p', temp, '-c', config], { stdio: 'ignore' });
    const origin = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        await fetch(origin);
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.ok(ready, 'Nginx started');
    const index = readFileSync(join(customer, 'dist/index.html'), 'utf8');
    for (const path of ['/', '/index.html', '/bank/transfers?status=pending', '/portfolio/BTC/repeat-buy', '/person/security']) {
      const response = await fetch(origin + path);
      assert.equal(response.status, 200, path);
      assert.equal(await response.text(), index, path);
      assert.equal(response.headers.get('cache-control'), 'no-store', path);
      assertSecurityHeaders(response, path);
    }
    // The developer docs' files sit in a /developers/ folder; the folder never answers the /developers rooms themselves.
    for (const path of ['/developers', '/developers/', '/developers/reference', '/developers/errors/auth']) {
      const response = await fetch(origin + path, { redirect: 'manual' });
      assert.equal(response.status, 200, path);
      assert.equal(await response.text(), index, path);
      assertSecurityHeaders(response, path);
    }
    for (const [path, type] of [
      ['/developers/llms.txt', /^text\/plain/],
      ['/developers/reference.md', /^text\/markdown/],
      ['/developers/openapi.json', /^application\/json/],
    ]) {
      const file = await fetch(origin + path);
      assert.equal(file.status, 200, path);
      assert.match(file.headers.get('content-type'), type, path);
      assert.notEqual(await file.text(), index, path);
      assertSecurityHeaders(file, path);
    }
    assert.equal((await fetch(origin + '/developers/no-such-page.md')).status, 404);
    assert.equal((await fetch(origin + '/api')).status, 404);
    assert.equal((await fetch(origin + '/ws')).status, 404);
    const asset = /src="(\/assets\/[^"\s]+\.js)"/.exec(index)[1];
    const chunk = await fetch(origin + asset);
    assert.equal(chunk.status, 200);
    assert.match(chunk.headers.get('content-type'), /javascript/);
    assert.equal(chunk.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assertSecurityHeaders(chunk, asset);
    const missing = await fetch(origin + '/assets/missing-chunk.js');
    assert.equal(missing.status, 404);
    assert.notEqual(await missing.text(), index);
    assert.equal(missing.headers.get('cache-control'), null);
    assertSecurityHeaders(missing, '/assets/missing-chunk.js (404)');
    const descriptor = await fetch(origin + '/customer-deployment.json');
    assert.equal(descriptor.headers.get('cache-control'), 'no-store');
    assertSecurityHeaders(descriptor, '/customer-deployment.json');
    assert.equal((await descriptor.json()).product, 'intafaced-customer');
    for (const [feature, library] of [
      ['trade', 'lightweight-charts'],
      ['more', 'livekit-client'],
    ]) {
      for (const kind of ['LICENSE', 'NOTICE']) {
        const filename = `${kind}.${library}`;
        const response = await fetch(origin + `/licenses/${filename}`);
        assert.equal(response.status, 200, filename);
        assert.equal(await response.text(), readFileSync(join(customer, 'src/features', feature, 'vendor', filename), 'utf8'));
      }
    }
    const edge = await fetch(origin + '/api/bank/transfers?limit=20', {
      method: 'POST',
      headers: { cookie: 'session=opaque', authorization: 'Bearer opaque', origin, 'content-type': 'application/json' },
      body: '{"reference":"public-contract-test"}',
    });
    assert.equal(edge.headers.get('cache-control'), 'no-store');
    // /api/ answers belong to svc-edge (its own documents set their framing headers), so nginx adds only HSTS there.
    assert.equal(edge.headers.get('strict-transport-security'), 'max-age=86400');
    assert.equal(edge.headers.get('x-frame-options'), null);
    assert.equal(edge.headers.get('content-security-policy'), null);
    assert.match(edge.headers.get('set-cookie'), /HttpOnly/);
    assert.deepEqual(await edge.json(), {
      path: '/api/bank/transfers?limit=20',
      method: 'POST',
      cookie: 'session=opaque',
      authorization: 'Bearer opaque',
      origin,
      body: '{"reference":"public-contract-test"}',
    });
    const handshake = await new Promise((resolve, reject) => {
      const client = request(origin + '/ws/stream?market=BTC-USD', {
        headers: {
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-version': '13',
          'sec-websocket-key': Buffer.from('the sample nonce').toString('base64'),
          cookie: 'session=opaque',
        },
      });
      client.on('error', reject);
      client.on('response', (res) => reject(new Error(`upgrade returned ${res.statusCode}`)));
      client.on('upgrade', (res, socket, head) => {
        const finish = (data) => {
          resolve({ status: res.statusCode, data });
          socket.destroy();
        };
        if (head.length) finish(head);
        else socket.once('data', finish);
        socket.on('error', reject);
      });
      client.end();
    });
    assert.equal(handshake.status, 101);
    assert.deepEqual(handshake.data, Buffer.from([0x81, 0x05, ...Buffer.from('hello')]));
    assert.deepEqual(upgrade, { path: '/stream?market=BTC-USD', cookie: 'session=opaque', connection: 'upgrade', upgrade: 'websocket' });
    if (process.env.CUTOVER_BROWSER_SMOKE === '1') {
      const { chromium } = await import('@playwright/test');
      const browser = await chromium.launch({ headless: true });
      try {
        for (const width of [1440, 390, 320]) {
          const page = await browser.newPage({ viewport: { width, height: 900 } });
          const errors = [];
          page.on('pageerror', (error) => errors.push(error.message));
          for (const path of ['/', '/login', '/bank/transfers', '/portfolio/BTC/repeat-buy', '/trade/convert']) {
            await page.goto(origin + path);
            await page.locator('#root > *').first().waitFor();
            assert.ok((await page.locator('body').innerText()).length > 20, `${width}px ${path} has React content`);
            assert.ok(
              await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
              `${width}px ${path} has no horizontal overflow`,
            );
          }
          assert.deepEqual(errors, [], `${width}px has no browser exceptions`);
          await page.close();
        }
      } finally {
        await browser.close();
      }
    }
  } finally {
    if (nginx) {
      nginx.kill('SIGTERM');
      await new Promise((resolve) => nginx.once('close', resolve));
    }
    for (const socket of sockets) socket.destroy();
    await Promise.all([stop(api), stop(ws)]);
    rmSync(temp, { recursive: true, force: true });
  }
});
