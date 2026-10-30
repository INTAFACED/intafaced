import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALERT, FOUNDER, alertDetail, founderCtx as ctx, treasuryToken } from '@/lib/recon-alerts/fixtures.test-util';
import { POST } from './route';

const gate = vi.hoisted(() => ({ session: vi.fn<() => Promise<unknown>>() }));
vi.mock('@/lib/admin-bff-gate', () => ({ adminBffSession: gate.session }));

const detail = alertDetail();
const post = (body: unknown) =>
  new Request('http://admin.example/api/ledger-reconciliation/alerts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const refusal = (status: number, code: string) =>
  Response.json(
    { error: { message: `${code} — refused`, code: -32603, data: { code: 'CONFLICT', httpStatus: status, cause: { code } } } },
    { status },
  );

const original = { ...process.env };
beforeEach(() => {
  gate.session.mockResolvedValue(ctx);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  gate.session.mockReset();
  process.env = { ...original };
});

describe('POST /api/ledger-reconciliation/alerts', () => {
  it('acknowledges as the founder with a business key naming the move, alert, version and founder', async () => {
    const calls: Array<{ url: string; body: unknown; auth: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).authorization! });
        return Response.json({ result: { data: detail } });
      }),
    );
    const res = await POST(post({ action: 'acknowledge', alertId: ALERT.toUpperCase(), version: 1, note: 'looking' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, alert: detail.alert });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/api/ops/trpc/alerts.acknowledge');
    expect(calls[0]!.auth).toBe('Bearer founder-access-token');
    expect(calls[0]!.body).toEqual({ alertId: ALERT, note: 'looking', idempotencyKey: `alert:acknowledge:${ALERT}:v1:${FOUNDER}` });
  });

  it('passes svc-ops refusals through with their exact code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => refusal(409, 'ops.alert_state_illegal')),
    );
    const res = await POST(post({ action: 'acknowledge', alertId: ALERT, version: 1, note: 'mine' }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('ops.alert_state_illegal');
    expect(body.detail).toBe('ops.alert_state_illegal — refused');
    expect(body.ok).toBe(false);
  });

  it('snoozes with a normalised end and unsnoozes with its own key', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return Response.json({ result: { data: detail } });
      }),
    );
    expect(
      (await POST(post({ action: 'snooze', alertId: ALERT, version: 2, endsAt: '2026-10-30T12:00:00Z', reason: ' night ' }))).status,
    ).toBe(200);
    expect((await POST(post({ action: 'unsnooze', alertId: ALERT, version: 3 }))).status).toBe(200);
    // A time with no offset is UTC, as the form's label says.
    expect((await POST(post({ action: 'snooze', alertId: ALERT, version: 4, endsAt: '2026-10-30T12:00:00' }))).status).toBe(200);
    expect(bodies).toEqual([
      { alertId: ALERT, endsAt: '2026-10-30T12:00:00.000Z', reason: 'night', idempotencyKey: `alert:snooze:${ALERT}:v2:${FOUNDER}` },
      { alertId: ALERT, idempotencyKey: `alert:unsnooze:${ALERT}:v3:${FOUNDER}` },
      { alertId: ALERT, endsAt: '2026-10-30T12:00:00.000Z', idempotencyKey: `alert:snooze:${ALERT}:v4:${FOUNDER}` },
    ]);
  });

  it('refuses a request this console never sends without calling svc-ops', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    for (const body of [
      { action: 'delete', alertId: ALERT, version: 1 },
      { action: 'acknowledge', alertId: 'not-a-uuid', version: 1, note: 'x' },
      { action: 'acknowledge', alertId: ALERT, version: 0, note: 'x' },
      { action: 'snooze', alertId: ALERT, version: 1, endsAt: 'tomorrow' },
    ]) {
      const res = await POST(post(body));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('admin.alert_input');
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reports a lost reply as unknown, never as failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 502 })),
    );
    const res = await POST(post({ action: 'unsnooze', alertId: ALERT, version: 1 }));
    expect(res.status).toBe(503);
    expect((await res.json()).unknown).toBe(true);
  });

  it('answers the gate refusal without calling svc-ops', async () => {
    gate.session.mockResolvedValue(new Response('no', { status: 401 }));
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect((await POST(post({ action: 'unsnooze', alertId: ALERT, version: 1 }))).status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });

  describe('resolve as fixed', () => {
    const TX1 = '55555555-5555-4555-8555-555555555555';
    const TX2 = '66666666-6666-4666-8666-666666666666';
    beforeEach(() => {
      process.env.EDGE_URL = 'http://isolated-edge:4000';
      process.env.ADMIN_TREASURY_TOKEN = treasuryToken(FOUNDER);
    });

    it('goes on the treasury transport with the ids once each and a key naming the move, alert, version and founder', async () => {
      const resolved = alertDetail({
        state: 'resolved',
        resolved: {
          resolution: 'fixed',
          by: FOUNDER,
          at: '2026-10-29T12:05:00.000Z',
          correctiveTxIds: [TX1, TX2],
          passingRunId: null,
          note: 'reversed',
        },
        version: 3,
      });
      const calls: Array<{ url: string; body: unknown; auth: string }> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit) => {
          calls.push({ url, body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).authorization! });
          return Response.json({ result: { data: resolved } });
        }),
      );
      const res = await POST(
        post({ action: 'resolve', alertId: ALERT, version: 2, txIds: `${TX1.toUpperCase()}, ${TX2}\n${TX1}`, note: ' reversed ' }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, alert: resolved.alert });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe('http://isolated-edge:4000/api/ops/trpc/alerts.resolve');
      expect(calls[0]!.auth).toBe(`Bearer ${treasuryToken(FOUNDER)}`);
      expect(calls[0]!.body).toEqual({
        alertId: ALERT,
        correctiveTxIds: [TX1, TX2],
        note: 'reversed',
        idempotencyKey: `alert:resolve:${ALERT}:v2:${FOUNDER}`,
      });
    });

    it('a retry of the same press sends the same key, so svc-ops answers what it stored', async () => {
      const bodies: Array<{ idempotencyKey: string }> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init: RequestInit) => {
          bodies.push(JSON.parse(String(init.body)));
          return bodies.length === 1 ? new Response('lost', { status: 502 }) : Response.json({ result: { data: detail } });
        }),
      );
      const first = await POST(post({ action: 'resolve', alertId: ALERT, version: 2, txIds: TX1 }));
      expect(first.status).toBe(503);
      expect((await first.json()).unknown).toBe(true);
      expect((await POST(post({ action: 'resolve', alertId: ALERT, version: 2, txIds: TX1 }))).status).toBe(200);
      expect(bodies[0]!.idempotencyKey).toBe(bodies[1]!.idempotencyKey);
    });

    it('passes the ledger check refusal through with its code and svc-ops naming the missing id', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json(
            {
              error: {
                message: `ops.resolve_transaction_not_found: ${TX2}`,
                code: -32603,
                data: { code: 'PRECONDITION_FAILED', httpStatus: 412, cause: { code: 'ops.resolve_transaction_not_found' } },
              },
            },
            { status: 412 },
          ),
        ),
      );
      const res = await POST(post({ action: 'resolve', alertId: ALERT, version: 2, txIds: TX2 }));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body).toMatchObject({ ok: false, code: 'ops.resolve_transaction_not_found' });
      expect(body.detail).toContain(TX2);
      expect(body.message).toContain('never booked');
    });

    it('sends nothing while the treasury credential belongs to another founder', async () => {
      process.env.ADMIN_TREASURY_TOKEN = treasuryToken('99999999-9999-4999-8999-999999999999');
      const fetcher = vi.fn();
      vi.stubGlobal('fetch', fetcher);
      const res = await POST(post({ action: 'resolve', alertId: ALERT, version: 2, txIds: TX1 }));
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('admin.treasury_holder_mismatch');
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('refuses no ids, a non-id or more than twenty without calling svc-ops', async () => {
      const fetcher = vi.fn();
      vi.stubGlobal('fetch', fetcher);
      const many = Array.from({ length: 21 }, (_, i) => `55555555-5555-4555-8555-${String(i).padStart(12, '0')}`).join(',');
      for (const txIds of ['', ' , ', 'not-a-transaction', many, undefined]) {
        const res = await POST(post({ action: 'resolve', alertId: ALERT, version: 2, txIds }));
        expect(res.status).toBe(400);
        expect((await res.json()).code).toBe('admin.alert_input');
      }
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('an answer for another alert is unknown, never a success', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ result: { data: alertDetail({ id: '77777777-7777-4777-8777-777777777777' }) } })),
      );
      const res = await POST(post({ action: 'resolve', alertId: ALERT, version: 2, txIds: TX1 }));
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ ok: false, unknown: true });
    });
  });
});
