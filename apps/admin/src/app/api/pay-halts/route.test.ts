import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';

const gate = vi.hoisted(() => ({ session: vi.fn<() => Promise<unknown>>() }));
vi.mock('@/lib/admin-bff-gate', () => ({ adminBffSession: gate.session }));

const FOUNDER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const M = '33333333-3333-4333-8333-333333333333';
const REQ = '55555555-5555-4555-8555-555555555555';
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
const state = (over: Record<string, unknown> = {}) => ({
  scope: 'payout',
  target: { level: 'global' },
  halted: false,
  reason: null,
  source: null,
  actorUserId: null,
  version: '0',
  changedAt: null,
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
    new Request('http://admin.example/api/pay-halts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
const get = () => GET(new Request('http://admin.example/api/pay-halts'));
const halt = {
  action: 'halt',
  requestId: REQ,
  scope: 'payout',
  target: { level: 'global' },
  reason: 'rail incident, stop sends',
  expectedVersion: '0',
  confirm: 'HALT payout',
};

beforeEach(() => {
  gate.session.mockResolvedValue(ctx);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  gate.session.mockReset();
});

describe('GET reads each part on its own', () => {
  it('returns the halts with an as-of time, as the founder', async () => {
    const fn = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes('operatorStatus'))
        return ok({
          readable: true,
          autoTrip: { enabled: false, consecutiveFailures: null },
          states: [state({ halted: true, reason: 'x', version: '3' })],
        });
      if (url.includes('pendingClears')) return ok({ proposals: [], nextCursor: null });
      return ok([]);
    });
    vi.stubGlobal('fetch', fn);
    const res = await get();
    const json = await res.json();
    expect(json.status).toMatchObject({ kind: 'ok', data: { readable: true } });
    expect(json.pending).toMatchObject({ kind: 'ok' });
    expect(Number.isFinite(Date.parse(json.asOf))).toBe(true);
    for (const call of fn.mock.calls)
      expect((call[1]!.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
  });
  it('one failing part is a failure on its own and never "nothing is halted"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('operatorStatus')) return trpcErr(503, 'pay.halt_store_unavailable', 'pay.halt_store_unavailable');
        if (url.includes('pendingClears')) return ok({ proposals: [], nextCursor: null });
        return ok([]);
      }),
    );
    const json = await (await get()).json();
    expect(json.status).toMatchObject({ kind: 'failed', code: 'pay.halt_store_unavailable' });
    expect(json.status.message).toContain('Treat every operation as halted');
    expect(json.status).not.toHaveProperty('data');
    expect(json.pending.kind).toBe('ok');
  });
  it('a procedure svc-pay has not switched on is named, not hidden', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ error: { message: 'No procedure found', data: { code: 'NOT_FOUND', httpStatus: 404 } } }, { status: 404 }),
      ),
    );
    const json = await (await get()).json();
    expect(json.status).toMatchObject({ kind: 'failed', notBuilt: true });
  });
  it('a refused founder is reported as forbidden, not as down', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(403, 'operator.denied')),
    );
    const json = await (await get()).json();
    expect(json.status).toMatchObject({ kind: 'failed', forbidden: true });
  });
  it('a refused session returns the gate response before the network', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    gate.session.mockResolvedValueOnce(Response.json({ code: 'admin.session_required' }, { status: 401 }));
    expect((await get()).status).toBe(401);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('POST refuses before it sends anything', () => {
  const never = () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    return fn;
  };
  it('a refused session returns before the network', async () => {
    const fn = never();
    gate.session.mockResolvedValueOnce(Response.json({ code: 'admin.session_csrf' }, { status: 403 }));
    expect((await post(halt)).status).toBe(403);
    expect(fn).not.toHaveBeenCalled();
  });
  it('rejects a wrong phrase, a short reason, a user halt on intake, an unknown action and extra fields', async () => {
    const fn = never();
    for (const body of [
      { ...halt, confirm: 'HALT intake' },
      { ...halt, confirm: '' },
      { ...halt, action: 'clear', confirm: 'HALT payout' },
      { ...halt, reason: 'short' },
      { ...halt, scope: 'intake', target: { level: 'user', userId: M }, confirm: 'HALT intake' },
      { ...halt, action: 'delete' },
      { ...halt, requestId: 'not-a-uuid' },
      { ...halt, expectedVersion: 'abc' },
      { ...halt, target: { level: 'global', extra: true } },
    ]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('POST runs the halt and the two-founder clear', () => {
  it('a halt goes to payHalts.set as the founder, halted:true, with the request id and version', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) =>
      ok({ requestId: REQ, outcome: 'changed', state: state({ halted: true, version: '1', reason: halt.reason }) }),
    );
    vi.stubGlobal('fetch', fn);
    const res = await post(halt);
    expect(await res.json()).toMatchObject({ ok: true, outcome: 'changed', action: 'halt', state: { halted: true, version: '1' } });
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://edge:4000/api/pay/trpc/payHalts.set');
    expect(JSON.parse(init!.body as string)).toEqual({
      requestId: REQ,
      scope: 'payout',
      target: { level: 'global' },
      halted: true,
      reason: 'rail incident, stop sends',
      expectedVersion: '0',
    });
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
  });
  it('a first clear answers pending_confirmation and is NOT reported as applied', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ requestId: REQ, outcome: 'pending_confirmation', state: state({ halted: true, version: '1' }) })),
    );
    const res = await post({ ...halt, action: 'clear', confirm: 'CLEAR payout', expectedVersion: '1' });
    expect(await res.json()).toMatchObject({ ok: true, outcome: 'pending_confirmation', state: { halted: true } });
  });
  it('the second founder confirms with the SAME request id, and halted:false', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) =>
      ok({ requestId: REQ, outcome: 'changed', state: state({ halted: false, version: '2' }) }),
    );
    vi.stubGlobal('fetch', fn);
    const res = await post({ ...halt, action: 'confirm_clear', confirm: 'CLEAR payout', expectedVersion: '1' });
    expect(await res.json()).toMatchObject({ ok: true, outcome: 'changed', action: 'confirm_clear' });
    expect(JSON.parse(fn.mock.calls[0]![1]!.body as string)).toMatchObject({ requestId: REQ, halted: false, expectedVersion: '1' });
  });
  it('a conflict is reported as an outcome, not as success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ requestId: REQ, outcome: 'conflict', state: state({ halted: true, version: '5' }) })),
    );
    expect(await (await post(halt)).json()).toMatchObject({ ok: true, outcome: 'conflict' });
  });
  it('svc-pay’s typed refusals are explained and changed nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(404, 'pay.halt_target_not_found', 'pay.halt_target_not_found')),
    );
    const res = await post({ ...halt, scope: 'intake', target: { level: 'merchant', merchantId: M }, confirm: 'HALT intake' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, refusal: { code: 'pay.halt_target_not_found', changed: 'no' } });
  });
  it('a dropped connection on a halt is "not known", and says repeating the same request is safe', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('socket hang up');
      }),
    );
    const res = await post(halt);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });
  });
  it('an unreadable answer from svc-pay is not reported as success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ nope: true })),
    );
    expect(await (await post(halt)).json()).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });
  });
  it('writes an audit line naming the founder, the action and the outcome, without the reason', async () => {
    const warn = vi.mocked(console.warn);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ requestId: REQ, outcome: 'changed', state: state({ halted: true }) })),
    );
    await post(halt);
    const line = String(warn.mock.calls.at(-1)?.[0]);
    expect(JSON.parse(line)).toMatchObject({
      audit: 'admin.pay_halt',
      founder: FOUNDER,
      action: 'halt',
      scope: 'payout',
      requestId: REQ,
      outcome: 'changed',
    });
    expect(line).not.toContain(halt.reason);
    expect(line).not.toContain(OTHER);
  });
});
