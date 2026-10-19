import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeskRequest } from '@/lib/desk/approval-packet';
import { opsExecute, readAmbassadorAnswer, readCardStatusAnswer, readTakedownAnswer, readResidencyAnswer, readVetAnswer } from './execute';

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

describe('academy appoint ambassador', () => {
  const appoint: DeskRequest = { kind: 'academy.ambassador.appoint', userId: USER };
  it('sends the person and both approval ids as the founder, and needs the record to say active', async () => {
    const fn = vi.fn(async (_u: string, _i?: RequestInit) => ok({ userId: USER, status: 'active', confirmOperatorId: 'x' }));
    vi.stubGlobal('fetch', fn);
    expect(await opsExecute(ctx)(appoint, ids)).toMatchObject({ ok: true });
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://edge:4000/api/academy/trpc/appointAmbassador');
    expect(JSON.parse(String(init!.body))).toEqual({ userId: USER, ...ids });
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
  });
  it('a record for someone else, or in another status, is unknown, never success', async () => {
    for (const body of [
      { userId: USER, status: 'frozen' },
      { userId: FOUNDER, status: 'active' },
    ]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ok(body)),
      );
      expect(await opsExecute(ctx)(appoint, ids)).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });
    }
  });
  it('a 403 says the console session lacks the permission, in the plain pattern, and changes nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => err(403, 'Missing scope admin:write')),
    );
    const reply = await opsExecute(ctx)(appoint, ids);
    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.refusal.title).toBe('Your console session does not have Academy operator permission');
    expect(reply.refusal.body).toContain('admin:write');
    expect(reply.refusal.changed).toBe('no');
  });
  it('already an ambassador is the service’s own refusal in words, nothing changed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => err(409, `User ${USER} is already an active ambassador`, 'academy.ambassador_already_active')),
    );
    const reply = await opsExecute(ctx)(appoint, ids);
    expect(reply).toMatchObject({ ok: false, refusal: { changed: 'no' } });
    if (!reply.ok) expect(reply.refusal.body).toContain('already an active ambassador');
  });
  it('a second factor that is missing is shown as a refusal, never as success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => err(401, 'mfa required')),
    );
    expect(await opsExecute(ctx)(appoint, ids)).toMatchObject({ ok: false, refusal: { changed: 'no' } });
  });
  it('a dropped connection is "outcome unknown"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('socket hang up'))),
    );
    expect(await opsExecute(ctx)(appoint, ids)).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });
  });
});

describe('academy residency decision', () => {
  const APPLICATION = '5a3b9c10-1111-4222-8333-444455556666';
  const decide = (decision: 'accepted' | 'rejected'): DeskRequest => ({ kind: 'academy.residency.decide', id: APPLICATION, decision });
  it('sends the application, the decision and both approval ids, and needs the record to carry that decision', async () => {
    const fn = vi.fn(async (_u: string, _i?: RequestInit) => ok({ id: APPLICATION, status: 'accepted', confirmOperatorId: 'x' }));
    vi.stubGlobal('fetch', fn);
    expect(await opsExecute(ctx)(decide('accepted'), ids)).toMatchObject({ ok: true });
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://edge:4000/api/academy/trpc/decideResidency');
    expect(JSON.parse(String(init!.body))).toEqual({ id: APPLICATION, decision: 'accepted', ...ids });
  });
  it('rejected is sent as rejected; an answer that says the opposite is unknown, not success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ id: APPLICATION, status: 'accepted' })),
    );
    expect(await opsExecute(ctx)(decide('rejected'), ids)).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ id: APPLICATION, status: 'rejected' })),
    );
    expect(await opsExecute(ctx)(decide('rejected'), ids)).toMatchObject({ ok: true });
  });
  it('an answer for a different application, or in an unknown shape, is unknown', async () => {
    for (const body of [{ id: USER, status: 'accepted' }, { id: APPLICATION }, 'accepted']) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ok(body)),
      );
      expect(await opsExecute(ctx)(decide('accepted'), ids)).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });
    }
  });
  it('a 403 is the plain permission sentence and an unapproved request is the typed refusal; both change nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => err(403, 'Missing scope admin:write')),
    );
    const refused = await opsExecute(ctx)(decide('accepted'), ids);
    expect(refused).toMatchObject({
      ok: false,
      refusal: { title: 'Your console session does not have Academy operator permission', changed: 'no' },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => err(412, 'identity refused [action_approval.not_approved]')),
    );
    expect(await opsExecute(ctx)(decide('accepted'), ids)).toMatchObject({
      ok: false,
      refusal: { code: 'action_approval.not_approved', changed: 'no' },
    });
  });
});

describe('the market 403 uses the same plain pattern', () => {
  it('names the market operator permission', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => err(403, 'Missing scope market:ops')),
    );
    const reply = await opsExecute(ctx)(vet('approved'), ids);
    if (reply.ok) throw new Error('refusal expected');
    expect(reply.refusal.title).toBe('Your console session does not have market operator permission');
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
    expect(readResidencyAnswer({ id: VENDOR, status: 'accepted', decisionNote: null })).toEqual({ id: VENDOR, status: 'accepted' });
    expect(readResidencyAnswer({ id: VENDOR })).toBeNull();
    expect(readResidencyAnswer(null)).toBeNull();
  });
});

describe('operator card freeze', () => {
  const CARD = '9f8e7d6c-1111-4222-8333-444455556666';
  const freeze: DeskRequest = { kind: 'bank.card.status', cardId: CARD, status: 'frozen', reason: 'owner reported the card stolen' };
  it('sends the card, status, reason, both approval ids and a replay key to ops.setCardStatus as the founder', async () => {
    const fn = vi.fn(async (_u: string, _i?: RequestInit) => ok({ cardId: CARD, status: 'frozen', frozenBy: 'operator' }));
    vi.stubGlobal('fetch', fn);
    const reply = await opsExecute(ctx)(freeze, ids);
    expect(reply).toMatchObject({ ok: true, detail: expect.stringContaining('frozen by an operator') });
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://edge:4000/api/bank/trpc/ops.setCardStatus');
    expect(JSON.parse(String(init!.body))).toEqual({
      cardId: CARD,
      status: 'frozen',
      reason: 'owner reported the card stolen',
      ...ids,
      clientRequestId: 'op_1',
    });
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
  });
  it('running the same approved request twice sends the same replay key, so the service cannot act twice', async () => {
    const fn = vi.fn(async (_u: string, _i?: RequestInit) => ok({ cardId: CARD, status: 'frozen', frozenBy: 'operator' }));
    vi.stubGlobal('fetch', fn);
    await opsExecute(ctx)(freeze, ids);
    await opsExecute(ctx)(freeze, ids);
    const keys = fn.mock.calls.map(([, init]) => (JSON.parse(String(init!.body)) as { clientRequestId: string }).clientRequestId);
    expect(keys[0]).toBe(keys[1]);
  });
  it('counts as done only when the returned card is the one asked for in the state asked for', async () => {
    for (const body of [
      { cardId: CARD, status: 'active', frozenBy: null },
      { cardId: VENDOR, status: 'frozen', frozenBy: 'operator' },
    ]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ok(body)),
      );
      expect(await opsExecute(ctx)(freeze, ids)).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });
    }
  });
  it('a session without the treasury permission is told what it lacks and nothing changed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => err(403, 'Missing scope admin:treasury')),
    );
    const reply = await opsExecute(ctx)(freeze, ids);
    expect(reply).toMatchObject({
      ok: false,
      refusal: { title: 'Your console session does not have bank treasury permission', changed: 'no' },
    });
    if (!reply.ok) expect(reply.refusal.body).toContain('admin:treasury');
  });
  it('reads only an exact answer', () => {
    expect(readCardStatusAnswer({ cardId: CARD, status: 'frozen', frozenBy: 'operator' })).toEqual({
      cardId: CARD,
      status: 'frozen',
      frozenBy: 'operator',
    });
    expect(readCardStatusAnswer({ cardId: CARD, status: 'active', frozenBy: null })).toMatchObject({ frozenBy: null });
    expect(readCardStatusAnswer({ cardId: CARD, status: 'active' })).toBeNull();
    expect(readCardStatusAnswer({ cardId: 1, status: 'active', frozenBy: null })).toBeNull();
  });
});

describe('listing takedown', () => {
  const LISTING = '5a3b9c10-1111-4222-8333-444455556666';
  const takedown: DeskRequest = { kind: 'market.listing.takedown', listingId: LISTING, reason: 'sells a forbidden product' };
  it('sends the listing, the reason as typed, both approval ids and a replay key to ops.takedownListing', async () => {
    const fn = vi.fn(async (_u: string, _i?: RequestInit) =>
      ok({ listingId: LISTING, status: 'taken_down', reason: 'x', actorId: USER, takenDownAt: '2026-10-18T01:00:00.000Z' }),
    );
    vi.stubGlobal('fetch', fn);
    expect(await opsExecute(ctx)(takedown, ids)).toMatchObject({ ok: true });
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://edge:4000/api/market/trpc/ops.takedownListing');
    expect(JSON.parse(String(init!.body))).toEqual({
      listingId: LISTING,
      reason: 'sells a forbidden product',
      ...ids,
      clientRequestId: 'op_1',
    });
  });
  it('needs the returned listing to be this one and taken down', async () => {
    for (const body of [
      { listingId: LISTING, status: 'active' },
      { listingId: USER, status: 'taken_down' },
    ]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ok(body)),
      );
      expect(await opsExecute(ctx)(takedown, ids)).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });
    }
    expect(readTakedownAnswer({ listingId: LISTING })).toBeNull();
  });
  it('an approval for another listing is refused in words and the listing is left as it was', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => err(412, 'market.takedown_approval_mismatch', 'market.takedown_approval_mismatch')),
    );
    expect(await opsExecute(ctx)(takedown, ids)).toMatchObject({
      ok: false,
      refusal: { title: 'That approval is for a different takedown', code: 'market.takedown_approval_mismatch', changed: 'no' },
    });
  });
  it('a dropped connection is unknown, and the same key makes running it again safe', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('socket hang up'))),
    );
    expect(await opsExecute(ctx)(takedown, ids)).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });
  });
});
