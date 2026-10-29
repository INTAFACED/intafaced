import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { opsAlertDetailSchema } from '@intafaced/contracts/ops-reconciliation-alerts';
import { POST } from './route';

const gate = vi.hoisted(() => ({ session: vi.fn<() => Promise<unknown>>() }));
vi.mock('@/lib/admin-bff-gate', () => ({ adminBffSession: gate.session }));

const FOUNDER = '11111111-1111-4111-8111-111111111111';
const ALERT = '22222222-2222-4222-8222-222222222222';
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
const T = '2026-10-29T12:00:00.000Z';
const detail = opsAlertDetailSchema.parse({
  source: { status: 'ok', readAt: T },
  alert: {
    id: ALERT,
    kind: 'reconciliation',
    state: 'acknowledged',
    controlId: '33333333-3333-4333-8333-333333333333',
    assetId: 'USDC',
    periodStart: T,
    periodEnd: T,
    severity: { status: 'set', value: 'critical' },
    occurrences: 1,
    firstSeen: T,
    lastSeen: T,
    evidence: {
      run: {
        id: '44444444-4444-4444-8444-444444444444',
        status: 'FAIL',
        asOf: T,
        readAt: T,
        sources: { ledger: { asOf: T }, outside: { asOf: 'unset' }, parity: { asOf: 'unset' } },
        outsideSide: 'unset',
        periodStart: T,
        periodEnd: T,
      },
      finishedAt: T,
      asset: { assetId: 'USDC', observed: '5', expected: '0', difference: '5', tolerance: '0' },
    },
    acknowledged: { by: FOUNDER, at: T, note: 'looking' },
    snooze: null,
    notices: {
      sent: 1,
      lastSentAt: T,
      repeat: { status: 'unset', code: 'ops.alert_repeat_unset' },
      outside: { email: 'vendor.email', push: 'vendor.push' },
    },
    version: 2,
  },
  timeline: [],
  snoozes: [],
});
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

const original = process.env.ADMIN_MODULES;
beforeEach(() => {
  gate.session.mockResolvedValue(ctx);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  gate.session.mockReset();
  if (original === undefined) delete process.env.ADMIN_MODULES;
  else process.env.ADMIN_MODULES = original;
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
});
