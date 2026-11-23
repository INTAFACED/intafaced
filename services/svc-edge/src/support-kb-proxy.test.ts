import type { ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootEdge, stopEdge } from './edge-boot.testkit.js';

/**
 * Class N — edge `/api/support` KB doors forward svc-support public wire (#2078).
 *
 * The proxy in `index.ts` is `response.text()` with no JSON reshape. That is
 * transparent today; it is not sealed unless a test would fail if the door
 * dropped `revision` / `published` or invented unpublished rows. This file
 * boots the real entrypoint against a SUPPORT_URL stub that already omits
 * unpublished (the store stays in svc-support — the edge must not grow a catalog).
 */

interface PublicKbArticle {
  id: string;
  titleKey: string;
  bodyKey: string;
  revision?: number;
  published?: boolean;
}

const PUBLISHED: PublicKbArticle = {
  id: 'kb-account-access',
  titleKey: 'support.kb.account_access.title',
  bodyKey: 'support.kb.account_access.body',
  revision: 4,
  published: true,
};

/** Present in the stub store only — public list/search/get never return it. */
const UNPUBLISHED_ID = 'kb-draft-internal';

function envelope(data: unknown): string {
  return JSON.stringify({ result: { data } });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function readJsonInput(req: IncomingMessage, url: URL, body: string): Record<string, unknown> {
  const raw = url.searchParams.get('input') ?? (body || undefined);
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  const wrapped = asRecord(parsed);
  return 'json' in wrapped ? asRecord(wrapped.json) : wrapped;
}

function procedureName(pathname: string): string {
  const rest = pathname.startsWith('/trpc/') ? pathname.slice('/trpc/'.length) : pathname.replace(/^\//, '');
  return rest.split('?')[0] ?? '';
}

function handleSupportKb(req: IncomingMessage, res: ServerResponse, body: string): void {
  const url = new URL(req.url ?? '/', 'http://support.stub');
  const proc = procedureName(url.pathname);
  const input = readJsonInput(req, url, body);

  let data: unknown;
  if (proc === 'listKb') {
    data = [PUBLISHED];
  } else if (proc === 'searchKb') {
    const q = String(input.q ?? '').toLowerCase();
    data = !q || PUBLISHED.id.includes(q) || PUBLISHED.titleKey.includes(q) ? [PUBLISHED] : [];
  } else if (proc === 'getKb') {
    const id = String(input.id ?? '');
    data = id === PUBLISHED.id ? PUBLISHED : null;
  } else {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unknown procedure' }));
    return;
  }

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(envelope(data));
}

async function listenStub(): Promise<{ origin: string; server: Server }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      handleSupportKb(req, res, Buffer.concat(chunks).toString('utf8'));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, server };
}

function trpcData<T>(body: unknown): T {
  const o = body as { result?: { data?: T } };
  if (!o.result || !('data' in o.result)) {
    throw new Error(`not a tRPC result envelope: ${JSON.stringify(body)}`);
  }
  return o.result.data as T;
}

function assertPublicWire(article: PublicKbArticle): void {
  expect(article.revision).toBe(PUBLISHED.revision);
  expect(article.published).toBe(true);
  expect(article.id).toBe(PUBLISHED.id);
}

let child: ChildProcess | null = null;
let stub: Server | null = null;
let edgeBase = '';

beforeAll(async () => {
  const stubbed = await listenStub();
  stub = stubbed.server;

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
    SUPPORT_URL: stubbed.origin,
  });
  child = edge.child;
  edgeBase = edge.base;
}, 90_000);

afterAll(async () => {
  await stopEdge(child);
  child = null;
  await new Promise<void>((resolve) => {
    if (!stub) return resolve();
    stub.close(() => resolve());
  });
  stub = null;
});

describe('edge /api/support KB proxy — revision and published passthrough', () => {
  it('listKb keeps revision + published and does not invent unpublished rows', async () => {
    const res = await fetch(`${edgeBase}/api/support/trpc/listKb`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(`"revision":${PUBLISHED.revision}`);
    expect(text).toContain('"published":true');
    expect(text).not.toContain(UNPUBLISHED_ID);

    const rows = trpcData<PublicKbArticle[]>(JSON.parse(text));
    expect(rows).toHaveLength(1);
    assertPublicWire(rows[0]!);
    expect(rows.some((a) => a.published === false)).toBe(false);
  });

  it('searchKb forwards the same public wire and still omits unpublished', async () => {
    const foundRes = await fetch(
      `${edgeBase}/api/support/trpc/searchKb?input=${encodeURIComponent(JSON.stringify({ json: { q: 'account' } }))}`,
    );
    expect(foundRes.status).toBe(200);
    const foundText = await foundRes.text();
    expect(foundText).toContain(`"revision":${PUBLISHED.revision}`);
    expect(foundText).toContain('"published":true');
    const found = trpcData<PublicKbArticle[]>(JSON.parse(foundText));
    expect(found).toHaveLength(1);
    assertPublicWire(found[0]!);

    const draftRes = await fetch(
      `${edgeBase}/api/support/trpc/searchKb?input=${encodeURIComponent(JSON.stringify({ json: { q: 'draft' } }))}`,
    );
    const draft = trpcData<PublicKbArticle[]>(JSON.parse(await draftRes.text()));
    expect(draft).toEqual([]);
    expect(JSON.stringify(draft)).not.toContain(UNPUBLISHED_ID);
  });

  it('getKb keeps revision + published; unpublished/missing stay null', async () => {
    const oneRes = await fetch(
      `${edgeBase}/api/support/trpc/getKb?input=${encodeURIComponent(JSON.stringify({ json: { id: PUBLISHED.id } }))}`,
    );
    expect(oneRes.status).toBe(200);
    const oneText = await oneRes.text();
    expect(oneText).toContain(`"revision":${PUBLISHED.revision}`);
    expect(oneText).toContain('"published":true');
    assertPublicWire(trpcData<PublicKbArticle>(JSON.parse(oneText)));

    const unpublishedRes = await fetch(
      `${edgeBase}/api/support/trpc/getKb?input=${encodeURIComponent(JSON.stringify({ json: { id: UNPUBLISHED_ID } }))}`,
    );
    expect(unpublishedRes.status).toBe(200);
    expect(trpcData<PublicKbArticle | null>(JSON.parse(await unpublishedRes.text()))).toBeNull();
  });
});
