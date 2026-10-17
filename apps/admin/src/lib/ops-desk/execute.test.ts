import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeskRequest } from '@/lib/desk/approval-packet';
import { opsExecute, readAmbassadorAnswer, readVetAnswer } from './execute';

const FOUNDER = '11111111-1111-4111-8111-111111111111';
const VENDOR = '5a3b9c10-1111-4222-8333-444455556666';
const USER = '9f8e7d6c-1111-4222-8333-444455556666';
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
const ids = { approvalId: 'appr_1', operationId: 'op_1' };
const ok = (data: unknown) => Response.json({ result: { data } });
const err = (status: number, message: string, code?: string) =>
  Response.json(
    { error: { message, code: -32603, data: { code: 'X', httpStatus: status, ...(code ? { cause: { code } } : {}) } } },
    { status },
  );
const vet = (decision: 'approved' | 'rejected' | 'suspended'): DeskRequest => ({
  kind: 'market.vendor.vet',
  vendorId: VENDOR,
  decision,
  reason: 'documents checked against the application',
});
const vendor = (status: string, id = VENDOR) => ({ id, status });

afterEach(() => vi.unstubAllGlobals());

describe('market vendor decision', () => {
  it('sends the decision, reason and both approval ids as the founder, to the vet procedure', async () => {
    const fn = vi.fn(async (_u: string, _i?: RequestInit) =>
      ok({ changed: true, vendor: vendor('approved'), event: null, confirmOperatorId: 'x' }),
    );
    vi.stubGlobal('fetch', fn);
    const reply = await opsExecute(ctx)(vet('approved'), ids);
    expect(reply).toMatchObject({ ok: true });
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://edge:4000/api/market/trpc/vet');
    expect(JSON.parse(String(init!.body))).toEqual({
      vendorId: VENDOR,
      decision: 'approved',
      reason: 'documents checked against the application',
      approvalId: 'appr_1',
      operationId: 'op_1',
    });
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
  });
  it('counts as done only when the returned vendor is in the state asked for', async () => {
    for (const body of [
      { changed: true, vendor: vendor('rejected') },
      { changed: true, vendor: vendor('approved', USER) },
    ]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ok(body)),
      );
      const reply = await opsExecute(ctx)(vet('approved'), ids);
      expect(reply).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });
    }
  });
  it('an answer in an unknown shape is an unknown outcome, not success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ vendor: 'approved' })),
    );
    expect(await opsExecute(ctx)(vet('approved'), ids)).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });
  });
  it('a founder session without the operator scope gets a plain refusal that changes nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => err(403, 'Missing scope market:ops')),
    );
    const reply = await opsExecute(ctx)(vet('approved'), ids);
    expect(reply).toMatchObject({ ok: false, refusal: { changed: 'no' } });
    if (!reply.ok) expect(reply.refusal.body).toContain('market:ops');
  });
  it('an approval the second founder has not given is the typed refusal, nothing changed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => err(412, 'identity refused [action_approval.not_approved]')),
    );
    const reply = await opsExecute(ctx)(vet('approved'), ids);
    expect(reply).toMatchObject({ ok: false, refusal: { code: 'action_approval.not_approved', changed: 'no' } });
  });
  it('a dropped connection on a write is "outcome unknown"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('socket hang up'))),
    );
    expect(await opsExecute(ctx)(vet('suspended'), ids)).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });
  });
  it('says so when the vendor was already in that state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ changed: false, vendor: vendor('approved') })),
    );
    const reply = await opsExecute(ctx)(vet('approved'), ids);
    expect(reply.ok && reply.detail).toContain('nothing changed');
  });
});

describe('academy ambassador freeze and unfreeze', () => {
  const freeze: DeskRequest = { kind: 'academy.ambassador.freeze', userId: USER, reason: 'conduct complaint under review' };
  const unfreeze: DeskRequest = { kind: 'academy.ambassador.unfreeze', userId: USER };
  it('freeze sends the reason and ids and needs the record to say frozen', async () => {
    const fn = vi.fn(async (_u: string, _i?: RequestInit) => ok({ userId: USER, status: 'frozen', confirmOperatorId: 'x' }));
    vi.stubGlobal('fetch', fn);
    expect(await opsExecute(ctx)(freeze, ids)).toMatchObject({ ok: true });
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://edge:4000/api/academy/trpc/freezeAmbassador');
    expect(JSON.parse(String(init!.body))).toEqual({ userId: USER, reason: 'conduct complaint under review', ...ids });
  });
  it('unfreeze sends no reason and needs the record to say active', async () => {
    const fn = vi.fn(async (_u: string, _i?: RequestInit) => ok({ userId: USER, status: 'active' }));
    vi.stubGlobal('fetch', fn);
    expect(await opsExecute(ctx)(unfreeze, ids)).toMatchObject({ ok: true });
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://edge:4000/api/academy/trpc/unfreezeAmbassador');
    expect(JSON.parse(String(init!.body))).toEqual({ userId: USER, ...ids });
  });
  it('a record in the wrong state is unknown, not success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ userId: USER, status: 'active' })),
    );
    expect(await opsExecute(ctx)(freeze, ids)).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });
  });
  it('a missing operator scope is explained and changes nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => err(403, 'Missing scope admin:write')),
    );
    expect(await opsExecute(ctx)(unfreeze, ids)).toMatchObject({ ok: false, refusal: { changed: 'no' } });
  });
});

describe('request kinds this executor does not own', () => {
  it('refuses a ledger request without sending anything', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    expect(await opsExecute(ctx)({ kind: 'ledger.unfreeze', version: 'v' }, ids)).toMatchObject({ ok: false, refusal: { changed: 'no' } });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('answer readers', () => {
  it('read only the fields they need, strictly', () => {
    expect(readVetAnswer({ changed: false, vendor: { id: VENDOR, status: 'approved' } })).toEqual({
      changed: false,
      vendorId: VENDOR,
      status: 'approved',
    });
    expect(readVetAnswer({ changed: 'no', vendor: {} })).toBeNull();
    expect(readAmbassadorAnswer({ userId: USER, status: 'frozen' })).toEqual({ userId: USER, status: 'frozen' });
    expect(readAmbassadorAnswer({ userId: 1, status: 'frozen' })).toBeNull();
  });
});
