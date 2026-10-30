import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FOUNDER, founderCtx, treasuryToken } from '@/lib/recon-alerts/fixtures.test-util';
import { POST } from './route';

const gate = vi.hoisted(() => ({ session: vi.fn<() => Promise<unknown>>() }));
vi.mock('@/lib/admin-bff-gate', () => ({ adminBffGate: vi.fn(async () => null), adminBffSession: gate.session }));

const OTHER = '88888888-8888-4888-8888-888888888888';
const post = (body: unknown) =>
  POST(
    new Request('http://admin.example/api/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
const ok = (data: unknown) => Response.json({ result: { data } });

const original = { ...process.env };
beforeEach(() => {
  process.env.EDGE_URL = 'http://isolated-edge:4000';
  process.env.ADMIN_TREASURY_TOKEN = treasuryToken(FOUNDER);
  gate.session.mockResolvedValue(founderCtx);
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...original };
  gate.session.mockReset();
});

describe('restore start and step', () => {
  it('starts a run on the treasury credential under the run key', async () => {
    const fn = vi.fn(async (_u: string, _i?: RequestInit) => ok({ restoreNo: 'R-1' }));
    vi.stubGlobal('fetch', fn);
    const res = await post({ action: 'start', restoreNo: 'R-1', cutOff: '2026-10-30T12:00:00.000Z' });
    expect(res.status).toBe(200);
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://isolated-edge:4000/api/ops/trpc/restore.start');
    expect((init!.headers as Record<string, string>).authorization).toBe(`Bearer ${process.env.ADMIN_TREASURY_TOKEN}`);
    expect(JSON.parse(String(init!.body))).toMatchObject({ restoreNo: 'R-1', cutOff: '2026-10-30T12:00:00.000Z' });
  });

  it('records a step on the treasury credential', async () => {
    const fn = vi.fn(async (_u: string, _i?: RequestInit) => ok({ step: 'validate' }));
    vi.stubGlobal('fetch', fn);
    expect((await post({ action: 'step', restoreNo: 'R-1', step: 'validate' })).status).toBe(200);
    expect(fn.mock.calls[0]![0]).toBe('http://isolated-edge:4000/api/ops/trpc/restore.step');
  });

  it('sends nothing while the treasury credential is another founder’s', async () => {
    process.env.ADMIN_TREASURY_TOKEN = treasuryToken(OTHER);
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    const res = await post({ action: 'step', restoreNo: 'R-1', step: 'validate' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, code: 'admin.treasury_holder_mismatch' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('sends nothing while the console holds no treasury credential', async () => {
    delete process.env.ADMIN_TREASURY_TOKEN;
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    const res = await post({ action: 'start', restoreNo: 'R-1', cutOff: '2026-10-30T12:00:00.000Z' });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, code: 'admin.ledger_unconfigured' });
    expect(fn).not.toHaveBeenCalled();
  });
});
