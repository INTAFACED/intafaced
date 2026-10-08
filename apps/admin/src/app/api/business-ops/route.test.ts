import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';

const gated = (path: string) =>
  new Request(`http://desk.test/api/business-ops${path}`, { headers: { 'x-intafaced-admin-bff': 'test-proxy-gate' } });
const reply = (data: unknown) => Response.json({ result: { data } });

describe('Business operations BFF authority and projection', () => {
  beforeEach(() => {
    vi.stubEnv('ADMIN_BFF_SHARED_SECRET', 'test-proxy-gate');
    vi.stubEnv('EDGE_URL', 'http://edge.test');
    vi.stubEnv('ADMIN_OPERATOR_TOKEN', 'general-admin-must-not-be-used');
    vi.stubEnv('ADMIN_OPS_READ_TOKEN', '');
    vi.stubEnv('ADMIN_OPS_WRITE_TOKEN', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('general admin and customer credentials cannot grant Ops reads', async () => {
    const response = await GET(gated('?view=contacts&limit=50'));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, code: 'admin.ops_read_unconfigured' });
    const denied = await GET(
      new Request('http://desk.test/api/business-ops?view=contacts&limit=50', { headers: { authorization: 'Bearer customer-token' } }),
    );
    expect(denied.status).toBe(401);
  });

  it('reads the scoped contact projection with an explicit limit and no extra private fields', async () => {
    vi.stubEnv('ADMIN_OPS_READ_TOKEN', 'test-ops-reader');
    let requested: URL | undefined;
    let headers: Headers | undefined;
    vi.stubGlobal('fetch', async (url: URL, opts: RequestInit) => {
      requested = new URL(url);
      headers = new Headers(opts.headers);
      return reply({
        contacts: [{ id: 'contact-test', displayName: 'Test contact', email: null, source: 'local', privateKey: 'must-be-discarded' }],
        identity: { status: 'absent', code: 'ops.identity_unwired' },
        support: { status: 'absent' },
        debugToken: 'must-be-discarded',
      });
    });
    const response = await GET(gated('?view=contacts&limit=50'));
    expect(response.status).toBe(200);
    expect(requested?.pathname).toBe('/api/ops/trpc/contacts');
    expect(JSON.parse(requested!.searchParams.get('input')!)).toEqual({ limit: 50 });
    expect(headers?.get('authorization')).toBe('Bearer test-ops-reader');
    expect(headers?.get('x-intafaced-admin-bff')).toBeNull();
    expect(await response.json()).toEqual({
      ok: true,
      status: 200,
      data: {
        contacts: [{ id: 'contact-test', displayName: 'Test contact', email: null, source: 'local' }],
        identity: { status: 'absent', code: 'ops.identity_unwired' },
        support: { status: 'absent' },
      },
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('malformed monetary data is refused instead of becoming an empty or numeric projection', async () => {
    vi.stubEnv('ADMIN_OPS_READ_TOKEN', 'test-ops-reader');
    vi.stubGlobal('fetch', async () => reply({ raises: [{ id: 'raise-test', name: 'Test raise', targetAmount: 1.5 }] }));
    const response = await GET(gated('?view=fundraising&limit=50'));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ ok: false, code: 'admin.ops_invalid_response' });
  });

  it('refuses an incomplete custody policy projection instead of presenting it as authoritative', async () => {
    vi.stubEnv('ADMIN_OPS_READ_TOKEN', 'test-ops-reader');
    vi.stubGlobal('fetch', async () => reply({ wrap: { status: 'unset' }, freeze: { status: 'frozen' }, tiers: [], approvals: [] }));
    const response = await GET(gated('?view=custody&limit=50'));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ ok: false, code: 'admin.ops_invalid_response' });
  });

  it('Ops writes require their own credential, acknowledgement and exact operation confirmation', async () => {
    const request = () =>
      new Request('http://desk.test/api/business-ops', {
        method: 'POST',
        headers: { 'x-intafaced-admin-bff': 'test-proxy-gate', 'content-type': 'application/json' },
        body: JSON.stringify({
          operation: 'projects.create',
          input: { title: 'Test project' },
          acknowledged: true,
          confirmation: 'CREATE projects.create',
        }),
      });
    expect((await POST(request())).status).toBe(503);
    vi.stubEnv('ADMIN_OPS_WRITE_TOKEN', 'test-ops-writer');
    const unconfirmed = new Request('http://desk.test/api/business-ops', {
      method: 'POST',
      headers: { 'x-intafaced-admin-bff': 'test-proxy-gate' },
      body: JSON.stringify({ operation: 'projects.create', input: { title: 'Test project' } }),
    });
    expect((await POST(unconfirmed)).status).toBe(400);
    let auth: string | null = null;
    vi.stubGlobal('fetch', async (_url: URL, opts: RequestInit) => {
      auth = new Headers(opts.headers).get('authorization');
      return Response.json({ error: { message: 'forbidden', data: { code: 'FORBIDDEN' } } }, { status: 403 });
    });
    const denied = await POST(request());
    expect(denied.status).toBe(403);
    expect(auth).toBe('Bearer test-ops-writer');
    expect(await denied.json()).toMatchObject({ ok: false, code: 'admin.ops_forbidden', uncertain: false });
  });

  it('rejects cross-origin writes and unsupported key or payroll fields before any upstream call', async () => {
    const crossOrigin = new Request('http://desk.test/api/business-ops', {
      method: 'POST',
      headers: { 'x-intafaced-admin-bff': 'test-proxy-gate', origin: 'http://elsewhere.test' },
      body: '{}',
    });
    expect((await POST(crossOrigin)).status).toBe(403);
    vi.stubEnv('ADMIN_OPS_WRITE_TOKEN', 'test-ops-writer');
    const forbiddenFields = new Request('http://desk.test/api/business-ops', {
      method: 'POST',
      headers: { 'x-intafaced-admin-bff': 'test-proxy-gate' },
      body: JSON.stringify({
        operation: 'createTeamMember',
        input: { handle: 'Test handle', role: 'Directory label', salary: '100.000000000000000001' },
        acknowledged: true,
        confirmation: 'CREATE createTeamMember',
      }),
    });
    const response = await POST(forbiddenFields);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'admin.ops_invalid_input' });
  });

  it('keeps exact amount metadata on the wire and marks a malformed create reply unresolved', async () => {
    vi.stubEnv('ADMIN_OPS_WRITE_TOKEN', 'test-ops-writer');
    let body: unknown;
    vi.stubGlobal('fetch', async (_url: URL, opts: RequestInit) => {
      body = JSON.parse(opts.body as string);
      return reply({ id: 'test-raise', name: 'Test raise', targetAmount: 1 });
    });
    const request = new Request('http://desk.test/api/business-ops', {
      method: 'POST',
      headers: { 'x-intafaced-admin-bff': 'test-proxy-gate' },
      body: JSON.stringify({
        operation: 'fundraising.create',
        input: { name: 'Test raise', milestoneLabels: [], targetAmount: '9007199254740993.000000000000000001' },
        acknowledged: true,
        confirmation: 'CREATE fundraising.create',
      }),
    });
    const response = await POST(request);
    expect(body).toEqual({ name: 'Test raise', milestoneLabels: [], targetAmount: '9007199254740993.000000000000000001' });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ ok: false, code: 'admin.ops_invalid_response', uncertain: true });
  });
});
