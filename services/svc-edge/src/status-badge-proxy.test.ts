import type { ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootEdge, stopEdge } from './edge-boot.testkit.js';
import { STATUS_BADGE_PATH, statusBadgeHeaders } from './status-badge-proxy.js';

/**
 * The status badge through the edge (J-support-public-07 step 9). svc-notify sets the
 * badge's cache life and content policy; the edge kept only its content type. The
 * second half boots the real entrypoint against a NOTIFY_URL stub, so a later hook
 * that rewrites the header would fail here.
 */

const CSP = "default-src 'none'; style-src 'unsafe-inline'";
const headersOf = (h: Record<string, string>) => ({ get: (name: string) => h[name] ?? null });

describe('which answers carry the badge headers', () => {
  it('passes cache-control and the content policy on the badge path only', () => {
    expect(STATUS_BADGE_PATH).toBe('/api/notify/status/badge.svg');
    const upstream = headersOf({
      'cache-control': 'public, max-age=120',
      'content-security-policy': CSP,
      'set-cookie': 'a=b',
      server: 'x',
    });
    expect(statusBadgeHeaders('/api/notify/status/badge.svg', upstream)).toEqual({
      'cache-control': 'public, max-age=120',
      'content-security-policy': CSP,
    });
    expect(statusBadgeHeaders('/api/notify/status/badge.svg', headersOf({ 'cache-control': 'no-cache, max-age=0' }))).toEqual({
      'cache-control': 'no-cache, max-age=0',
    });
    expect(statusBadgeHeaders('/api/notify/status/badge.svg', headersOf({}))).toEqual({});
  });

  it('keeps every other /api/ path to the headers it had', () => {
    const upstream = headersOf({ 'cache-control': 'public, max-age=120', 'content-security-policy': CSP });
    for (const path of [
      '/api/notify/trpc/statusPage.badge',
      '/api/notify/status/badge.svg/x',
      '/api/notify/status/badge.svgx',
      '/api/notify/status/BADGE.svg',
      '/api/notify/status/badge.svg/',
      '/api/notify/status',
      '/api/status/badge.svg',
      '/api/trade/trpc/orders.list',
      '/api/identity/trpc/auth.refresh',
      '/api/pay/checkout',
    ]) {
      expect(statusBadgeHeaders(path, upstream), path).toEqual({});
    }
  });
});

let child: ChildProcess | null = null;
let stub: Server | null = null;
let edgeBase = '';

beforeAll(async () => {
  // svc-notify's badge and one tRPC read, as far as the edge can tell; both set cache-control.
  stub = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.method === 'GET' && req.url?.startsWith('/status/badge.svg')) {
        res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=120', 'content-security-policy': CSP });
        res.end('<svg xmlns="http://www.w3.org/2000/svg"><title>Trading: operational</title></svg>');
      } else {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=120', 'content-security-policy': CSP });
        res.end('{"result":{"data":{}}}');
      }
    });
  });
  await new Promise<void>((resolve) => stub!.listen(0, '127.0.0.1', () => resolve()));
  const notifyOrigin = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;

  const edge = await bootEdge({
    ...process.env,
    APP_ENV: 'test',
    NODE_ENV: 'test',
    SERVICE_NAME: 'svc-edge',
    OTEL_ENABLED: 'false',
    JWT_ACCESS_SECRET: 'test-only-signing-secret-at-least-32-characters-long',
    EDGE_PRINCIPAL_SECRET: 'test-only-edge-principal-secret-at-least-32-chars',
    EDGE_RATE_LIMIT_MAX: '300',
    EDGE_RATE_LIMIT_WINDOW_MS: '60000',
    EDGE_BODY_LIMIT_BYTES: '1048576',
    INTAFACED_SANCTIONS_REGIONS: 'AA:test-fixture-not-a-real-list',
    EDGE_KILL_STATE_PATH: '',
    NOTIFY_URL: notifyOrigin,
  });
  child = edge.child;
  edgeBase = edge.base;
}, 90_000);

afterAll(async () => {
  await stopEdge(child);
  child = null;
  await new Promise<void>((resolve) => (stub ? stub.close(() => resolve()) : resolve()));
  stub = null;
});

describe('the status badge through the real edge', () => {
  it("serves the badge with svc-notify's cache life and content policy", async () => {
    const res = await fetch(`${edgeBase}/api/notify/status/badge.svg?component=trading`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    expect(res.headers.get('cache-control')).toBe('public, max-age=120');
    expect(res.headers.get('content-security-policy')).toBe(CSP);
    expect(await res.text()).toContain('Trading: operational');
  });

  it('leaves another notify path without the upstream cache-control', async () => {
    const res = await fetch(`${edgeBase}/api/notify/trpc/statusPage.summary`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).not.toBe('public, max-age=120');
    expect(res.headers.get('content-security-policy')).not.toBe(CSP);
  });
});
