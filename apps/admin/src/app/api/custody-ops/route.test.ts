import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';

const gate = vi.hoisted(() => ({ session: vi.fn<() => Promise<unknown>>() }));
vi.mock('@/lib/admin-bff-gate', () => ({ adminBffSession: gate.session }));

const FOUNDER = '11111111-1111-4111-8111-111111111111';
const TASK = '33333333-3333-4333-8333-333333333333';
const HASH = 'abcdef0123456789'.repeat(4);
const ctx = {
  session: {
    userId: FOUNDER,
    accessToken: 'founder-access-token',
    refreshToken: 'r',
    expiresAt: '2030-01-01T00:00:00.000Z',
    issuedAt: '2026-01-01T00:00:00.000Z',
    csrf: 'c'.repeat(43),
  },
  config: { origin: 'https://admin.example', edgeUrl: 'http://edge:4000', key: Buffer.alloc(32, 1) },
};
const task = (over: Record<string, unknown> = {}) => ({
  id: TASK,
  clientRef: 'r',
  kind: 'config',
  scope: 'policy',
  title: 'Publish policy',
  payload: { rule: 'two approvers' },
  payloadHash: HASH,
  initiator: '22222222-2222-4222-8222-222222222222',
  requiredApprovals: 2,
  approvalCount: 1,
  approvedByMe: true,
  status: 'pending',
  failureCode: null,
  expiresAt: '2026-10-21T00:00:00.000Z',
  createdAt: '2026-10-20T00:00:00.000Z',
  decidedAt: null,
  executedAt: null,
  ...over,
});
const ok = (data: unknown) => Response.json({ result: { data } });
const trpcErr = (status: number, message: string, cause?: string) =>
  Response.json(
    { error: { message, code: -32603, data: { code: 'X', httpStatus: status, ...(cause ? { cause: { code: cause } } : {}) } } },
    { status },
  );
const post = (body: unknown) =>
  POST(
    new Request('http://admin.example/api/custody-ops', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
const approve = { action: 'approve', taskId: TASK, payloadHash: HASH, confirm: 'APPROVE abcdef01' };

beforeEach(() => {
  gate.session.mockResolvedValue(ctx);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  gate.session.mockReset();
});

describe('GET', () => {
  it('reads waiting tasks, recent tasks and approvers as the founder, each part on its own', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('approvers.pending')
        ? ok([task()])
        : url.includes('tasks.list')
          ? trpcErr(502, 'down')
          : ok([{ userId: FOUNDER, label: 'Ops', role: 'founder', active: true, setBy: 'owner', setAt: '2026-10-20T00:00:00.000Z' }]),
    );
    vi.stubGlobal('fetch', fetchMock);
    const body = await (await GET(new Request('http://admin.example/api/custody-ops'))).json();
    expect(body.pending).toMatchObject({ kind: 'ok' });
    expect(body.pending.data[0].id).toBe(TASK);
    expect(body.recent).toMatchObject({ kind: 'failed' });
    expect(body.approvers.data[0].label).toBe('Ops');
    for (const [, init] of fetchMock.mock.calls as unknown as [string, RequestInit][])
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
    expect(typeof body.asOf).toBe('string');
  });

  it('reads one task with its timeline, and refuses a malformed id before calling the service', async () => {
    const fetchMock = vi.fn(async () => ok({ ...task(), timeline: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const good = await GET(new Request(`http://admin.example/api/custody-ops?taskId=${TASK}`));
    expect((await good.json()).task.id).toBe(TASK);
    fetchMock.mockClear();
    const bad = await GET(new Request('http://admin.example/api/custody-ops?taskId=nope'));
    expect(bad.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers a data row the contract does not accept as a failed read, never as an empty list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok([{ id: 'not-a-task' }])),
    );
    const body = await (await GET(new Request('http://admin.example/api/custody-ops'))).json();
    expect(body.pending).toMatchObject({ kind: 'failed' });
  });
});

describe('POST', () => {
  it('sends an approval naming the fingerprint, as the founder, after the phrase matches', async () => {
    const fetchMock = vi.fn(async () => ok(task({ approvalCount: 2, status: 'approved' })));
    vi.stubGlobal('fetch', fetchMock);
    const res = await post(approve);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, action: 'approve' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/api/pay/trpc/founderAdmin.custody.tasks.approve');
    expect(JSON.parse(init.body as string)).toEqual({ taskId: TASK, payloadHash: HASH });
  });

  it('sends a cancel with only the task id', async () => {
    const fetchMock = vi.fn(async () => ok(task({ status: 'canceled' })));
    vi.stubGlobal('fetch', fetchMock);
    expect((await post({ action: 'cancel', taskId: TASK, confirm: 'CANCEL' })).status).toBe(200);
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ taskId: TASK });
  });

  it('refuses a wrong phrase, a phrase for another fingerprint, a bad id and an unknown action before calling the service', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    for (const body of [
      { ...approve, confirm: 'APPROVE' },
      { ...approve, confirm: 'APPROVE 00000000' },
      { ...approve, taskId: 'x' },
      { ...approve, action: 'execute' },
      { action: 'approve', taskId: TASK, confirm: 'APPROVE ' },
    ])
      expect((await post(body)).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says what a refusal means in words, and that nothing changed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(403, 'no', 'custody_approval.initiator_cannot_decide')),
    );
    const res = await post(approve);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.refusal).toMatchObject({ code: 'custody_approval.initiator_cannot_decide', changed: 'no' });
    expect(body.refusal.title).toContain('different approver');
  });

  it('says the outcome is unknown when svc-pay did not answer, never that it failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('socket');
      }),
    );
    const res = await post(approve);
    expect(res.status).toBe(502);
    expect((await res.json()).refusal.changed).toBe('unknown');
  });
});
