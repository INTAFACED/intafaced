import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route.js';

vi.mock('@/lib/admin-bff-gate', () => ({ adminBffGate: vi.fn(async () => null) }));
vi.mock('@/lib/founder-session', () => ({
  adminSessionConfig: vi.fn(() => ({ origin: 'http://admin.local', edgeUrl: process.env.EDGE_URL?.trim() ?? '', key: Buffer.alloc(32) })),
  openFounderSession: vi.fn((cookie: string | null) => {
    if (!cookie) {
      const error = new Error('admin.session_required') as Error & { code: string; status: number };
      error.code = 'admin.session_required';
      error.status = 401;
      throw error;
    }
    return { accessToken: 'founder-session-access-token' };
  }),
}));

/**
 * BFF gate + not-wired contract for /api/operator-tools.
 */

const ORIGINAL = { ...process.env };
const AUTH_HEADERS = {};
const FOUNDER_COOKIE = '__Host-intafaced-admin=sealed-test-session';

function request(method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  return new Request('http://admin.local/api/operator-tools', {
    method,
    headers: { cookie: FOUNDER_COOKIE, ...headers, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  });
}

beforeEach(() => {
  for (const key of ['EDGE_URL', 'ADMIN_OPERATOR_TOKEN', 'ADMIN_TREASURY_TOKEN']) {
    delete process.env[key];
  }
  vi.restoreAllMocks();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe('GET /api/operator-tools', () => {
  it('lists tools with not-wired when env is missing', async () => {
    const res = await GET(request('GET', undefined, AUTH_HEADERS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools.length).toBeGreaterThan(5);
    expect(body.tools.every((t: { wire: string }) => t.wire === 'not-wired')).toBe(true);
    expect(body.residual.reconcile).toMatch(/simulated/i);
  });
});

describe('POST /api/operator-tools', () => {
  it('returns 503 not-wired without calling the network', async () => {
    const fetchMock = vi.fn(() => {
      throw new Error('must not fetch');
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await POST(request('POST', { toolId: 'identity.kyc.pending', input: {} }, AUTH_HEADERS));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.delivered).toBe(false);
    expect(body.data.wire).toBe('not-wired');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown toolId', async () => {
    process.env.EDGE_URL = 'http://edge:4000';
    process.env.ADMIN_OPERATOR_TOKEN = 'tok';
    const res = await POST(request('POST', { toolId: 'does.not.exist', input: {} }, AUTH_HEADERS));
    expect(res.status).toBe(404);
  });

  it('refuses a missing founder cookie before exposing the tools surface', async () => {
    await expect(GET(new Request('http://admin.local/api/operator-tools'))).rejects.toMatchObject({
      code: 'admin.session_required',
      status: 401,
    });
  });

  it('forwards the actual founder access token to the edge, never a configured shared token', async () => {
    process.env.EDGE_URL = 'http://edge:4000';
    process.env.ADMIN_OPERATOR_TOKEN = 'old-shared-token';
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain('http://edge:4000/api/identity/trpc/kyc.pending');
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer founder-session-access-token');
      expect((init?.headers as Record<string, string>).authorization).not.toContain('old-shared-token');
      return new Response(JSON.stringify({ result: { data: { json: [] } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = await POST(request('POST', { toolId: 'identity.kyc.pending', input: { limit: '25' } }));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect((await res.json()).data).toEqual([]);
  });
});
