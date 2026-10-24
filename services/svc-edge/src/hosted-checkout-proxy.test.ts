import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostedCheckoutHeaders, hostedCheckoutLocation, isHostedCheckoutPath, upstreamRedirectMode } from './hosted-checkout-proxy.js';

/**
 * The hosted checkout through the edge (J-merchant-04 step 4). svc-pay answers
 * "Continue" with a 303 to the session page and sends its own security headers;
 * the edge used to refuse the redirect (a 502 for every payer) and drop the
 * headers. The second half boots the real entrypoint against a PAY_URL stub.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = join(HERE, 'index.ts');

const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const headersOf = (h: Record<string, string>) => ({ get: (name: string) => h[name] ?? null });

describe('which answers are hosted checkout pages', () => {
  it('matches the link and session pages only, never the tRPC procedures', () => {
    for (const path of ['/api/pay/checkout', '/api/pay/checkout/session', '/api/pay/checkout/session/cs_x', '/api/pay/pay/link/pl_x']) {
      expect(isHostedCheckoutPath(path), path).toBe(true);
      expect(upstreamRedirectMode(path)).toBe('manual');
    }
    for (const path of ['/api/pay/trpc/checkout.open', '/api/pay/checkoutx', '/api/identity/checkout', '/api/pay', '/api/pay/pay/linkx']) {
      expect(isHostedCheckoutPath(path), path).toBe(false);
      expect(upstreamRedirectMode(path)).toBe('error');
    }
  });

  it('passes the security headers on checkout pages only', () => {
    const upstream = headersOf({ 'content-security-policy': CSP, 'referrer-policy': 'no-referrer', 'set-cookie': 'a=b', server: 'x' });
    expect(hostedCheckoutHeaders('/api/pay/checkout', upstream)).toEqual({
      'content-security-policy': CSP,
      'referrer-policy': 'no-referrer',
    });
    expect(hostedCheckoutHeaders('/api/pay/trpc/merchant.get', upstream)).toEqual({});
  });

  it('passes only a 303 from a checkout path to a session page of this checkout', () => {
    const to = (location: string) => headersOf({ location });
    expect(hostedCheckoutLocation(303, to('/api/pay/checkout/session/cs_abc-1'))).toBe('/api/pay/checkout/session/cs_abc-1');
    for (const location of [
      'https://elsewhere.example/api/pay/checkout/session/cs_abc',
      '//elsewhere.example/api/pay/checkout/session/cs_abc',
      '/api/pay/checkout/session/../../identity',
      '/api/pay/checkout/session/cs_abc?next=https://elsewhere.example',
      '/api/identity/trpc/auth.logout',
      '/api/pay/checkout/session/',
      '',
    ]) {
      expect(hostedCheckoutLocation(303, to(location)), location).toBeNull();
    }
    expect(hostedCheckoutLocation(302, to('/api/pay/checkout/session/cs_abc'))).toBeNull();
    expect(hostedCheckoutLocation(303, headersOf({}))).toBeNull();
  });
});

let child: ChildProcess | null = null;
let stub: Server | null = null;
let edgeBase = '';
let nextStatus = 303;
let nextLocation = '/api/pay/checkout/session/cs_ok';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  // svc-pay's checkout routes, as far as the edge can tell.
  stub = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const security = {
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-frame-options': 'DENY',
        'content-security-policy': CSP,
      };
      if (req.method === 'POST' && req.url === '/checkout/session') {
        res.writeHead(nextStatus, { ...security, location: nextLocation });
        res.end();
      } else if (req.method === 'GET' && req.url === '/trpc/merchant.get') {
        res.writeHead(304, { etag: '"v1"' });
        res.end();
      } else if (req.method === 'POST' && req.url === '/trpc/checkout.open') {
        res.writeHead(303, { location: '/api/pay/checkout/session/cs_ok' });
        res.end();
      } else {
        res.writeHead(200, { ...security, 'content-type': 'text/html; charset=utf-8' });
        res.end('<p>Payment request</p>');
      }
    });
  });
  await new Promise<void>((resolve) => stub!.listen(0, '127.0.0.1', () => resolve()));
  const payOrigin = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;

  const port = await freePort();
  edgeBase = `http://127.0.0.1:${port}`;
  let output = '';
  child = spawn(process.execPath, ['--import', 'tsx', ENTRYPOINT], {
    cwd: join(HERE, '..'),
    env: {
      ...process.env,
      APP_ENV: 'test',
      NODE_ENV: 'test',
      SERVICE_NAME: 'svc-edge',
      HTTP_HOST: '127.0.0.1',
      HTTP_PORT: String(port),
      LOG_LEVEL: 'fatal',
      OTEL_ENABLED: 'false',
      JWT_ACCESS_SECRET: 'test-only-signing-secret-at-least-32-characters-long',
      EDGE_PRINCIPAL_SECRET: 'test-only-edge-principal-secret-at-least-32-chars',
      EDGE_RATE_LIMIT_MAX: '300',
      EDGE_RATE_LIMIT_WINDOW_MS: '60000',
      EDGE_BODY_LIMIT_BYTES: '1048576',
      INTAFACED_SANCTIONS_REGIONS: 'AA:test-fixture-not-a-real-list',
      EDGE_KILL_STATE_PATH: '',
      PAY_URL: payOrigin,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d: Buffer) => void (output += d.toString()));
  child.stderr?.on('data', (d: Buffer) => void (output += d.toString()));

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`svc-edge exited with ${child.exitCode}:\n${output}`);
    try {
      if ((await fetch(`${edgeBase}/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`svc-edge never became reachable:\n${output}`);
}, 90_000);

afterAll(async () => {
  child?.kill();
  child = null;
  await new Promise<void>((resolve) => (stub ? stub.close(() => resolve()) : resolve()));
  stub = null;
});

const post = (path: string, body = 'token=pl_x&geoCountry=DE') =>
  fetch(`${edgeBase}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

describe('the hosted checkout through the real edge', () => {
  it('serves the link page with its own security headers', async () => {
    const res = await fetch(`${edgeBase}/api/pay/checkout?token=pl_x`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe(CSP);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toContain('Payment request');
  });

  it('passes the 303 after Continue to the session page', async () => {
    nextLocation = '/api/pay/checkout/session/cs_ok';
    const res = await post('/api/pay/checkout/session');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/api/pay/checkout/session/cs_ok');
  });

  it('refuses a redirect anywhere else, and any redirect off the checkout pages', async () => {
    nextLocation = 'https://elsewhere.example/phish';
    const offHost = await post('/api/pay/checkout/session');
    expect(offHost.status).toBe(502);
    expect(offHost.headers.get('location')).toBeNull();

    nextStatus = 302;
    nextLocation = '/api/pay/checkout/session/cs_ok';
    const otherStatus = await post('/api/pay/checkout/session');
    expect(otherStatus.status).toBe(502);
    expect(otherStatus.headers.get('location')).toBeNull();
    nextStatus = 303;

    const trpc = await post('/api/pay/trpc/checkout.open');
    expect(trpc.status).toBe(502);
    expect(trpc.headers.get('location')).toBeNull();
  });

  it('leaves every other route as it was: a 304 still passes', async () => {
    const res = await fetch(`${edgeBase}/api/pay/trpc/merchant.get`, { headers: { 'if-none-match': '"v1"' } });
    expect(res.status).toBe(304);
  });
});
