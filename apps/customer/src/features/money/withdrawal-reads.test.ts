import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../shared/api';
import { parseAmount } from '../../shared/money';
import { createWithdrawalReads, requestedWithdrawal } from './withdrawal-reads';

const owner = '11111111-1111-4111-8111-111111111111';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const original = {
  id,
  userId: owner,
  assetId: 'USDT',
  amount: '0.000000000000000001',
  rail: 'isolated',
  destination: { kind: 'bank', ref: 'private-original' },
  clientRef: 'original-client',
  railRef: null,
  attempts: 1,
  failureCode: null,
  status: 'held',
  createdAt: '2026-10-10T09:20:00Z',
};
const wire = (data: unknown) => new Response(JSON.stringify({ result: { data } }));

describe('owned withdrawal network boundary', () => {
  it('admits only one UUID query parameter, preserving a canonical original', () => {
    expect(requestedWithdrawal('')).toEqual({ ok: true, id: null });
    expect(requestedWithdrawal('?withdrawalId=' + id.toUpperCase())).toEqual({ ok: true, id });
    for (const search of ['?withdrawalId=', '?withdrawalId=123', '?withdrawalId=' + id + '&withdrawalId=' + id, '?withdrawalId=%20' + id])
      expect(requestedWithdrawal(search)).toEqual({ ok: false });
  });
  it('sends explicit bounded GETs and parses exact money through the actual ledger client without write admission', async () => {
    const requests: { url: string; method?: string }[] = [];
    const api = createApiClient({
      canWrite: () => false,
      fetch: async (url, opts) => {
        requests.push({ url: String(url), method: opts?.method });
        return wire([original]);
      },
    });
    const reads = createWithdrawalReads(api, owner, () => true);
    for (const limit of [50, 100, 150, 200]) {
      const result = await reads.mine(limit);
      expect(result.ok).toBe(true);
      if (result.ok) expect(parseAmount(result.data[0]!.amount)).toBe(1n);
    }
    expect(requests.map((request) => JSON.parse(new URL(request.url, 'http://isolated').searchParams.get('input')!))).toEqual(
      [50, 100, 150, 200].map((limit) => ({ limit })),
    );
    expect(requests.every((request) => request.method === 'GET')).toBe(true);
  });
  it.each([0, 201, 1.5, Number.NaN])('refuses invalid limit %s before dispatch', async (limit) => {
    const fetcher = vi.fn();
    expect(await createWithdrawalReads(createApiClient({ fetch: fetcher }), owner, () => true).mine(limit)).toMatchObject({
      ok: false,
      code: 'withdrawal.window_invalid',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    { userId: other },
    { amount: 1 },
    { amount: '-1' },
    { amount: '1.0000000000000000001' },
    { status: 'delivered' },
    { destination: { kind: 'bank' } },
    { attempts: 0.5 },
    { createdAt: 'yesterday' },
  ])('refuses owner or malformed list records', async (change) => {
    const api = createApiClient({ fetch: async () => wire([{ ...original, ...change }]) });
    expect(await createWithdrawalReads(api, owner, () => true).mine(50)).toMatchObject({ ok: false, reason: 'invalid_response' });
  });
  it('refuses duplicate originals ignoring UUID case and over-returned windows', async () => {
    const data = [original, { ...original, id: id.toUpperCase() }];
    expect(await createWithdrawalReads(createApiClient({ fetch: async () => wire(data) }), owner, () => true).mine(50)).toMatchObject({
      ok: false,
      code: 'withdrawal.window_invalid',
    });
    expect(await createWithdrawalReads(createApiClient({ fetch: async () => wire(data) }), owner, () => true).mine(1)).toMatchObject({
      ok: false,
      code: 'withdrawal.window_invalid',
    });
  });
  it('reads only the validated original, refuses another original and retries the same ID', async () => {
    const ids: string[] = [];
    let responseId = other;
    const api = createApiClient({
      fetch: async (url) => {
        ids.push(JSON.parse(new URL(String(url), 'http://isolated').searchParams.get('input')!).withdrawalId);
        return wire({ ...original, id: responseId });
      },
    });
    const reads = createWithdrawalReads(api, owner, () => true);
    expect(await reads.get('bad')).toMatchObject({ ok: false, code: 'withdrawal.input_invalid' });
    expect(await reads.get(id)).toMatchObject({ ok: false, code: 'withdrawal.owner_or_original_invalid' });
    responseId = id;
    expect(await reads.get(id)).toMatchObject({ ok: true, data: { id } });
    expect(ids).toEqual([id, id]);
  });
  it('distinguishes a named missing original from an unmounted 404, forbidden and unauthorized', async () => {
    for (const [status, code, reason] of [
      [404, 'pay.withdrawal_not_found', 'error'],
      [404, 'NOT_FOUND', 'not_mounted'],
      [403, 'FORBIDDEN', 'forbidden'],
      [401, 'UNAUTHORIZED', 'unauthorized'],
    ] as const) {
      const api = createApiClient({
        fetch: async () => new Response(JSON.stringify({ error: { message: 'opaque', data: { intafacedCode: code } } }), { status }),
      });
      expect(await createWithdrawalReads(api, owner, () => true).get(id)).toMatchObject({ ok: false, reason, status, code });
    }
  });
  it('refuses signed-out, aborted and departed reads before dispatch', async () => {
    const fetcher = vi.fn();
    const api = createApiClient({ fetch: fetcher });
    expect(await createWithdrawalReads(api, null, () => true).get(id)).toMatchObject({ ok: false, reason: 'unauthorized' });
    expect(await createWithdrawalReads(api, owner, () => false).get(id)).toMatchObject({ ok: false, reason: 'aborted' });
    expect(await createWithdrawalReads(api, owner, () => true).mine(50, AbortSignal.abort())).toMatchObject({
      ok: false,
      reason: 'aborted',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects a late body after departure despite an unchanged original response', async () => {
    let current = true;
    let release!: () => void;
    const body = new Promise<string>((resolve) => {
      release = () => resolve(JSON.stringify({ result: { data: original } }));
    });
    const api = createApiClient({ fetch: async () => ({ ok: true, status: 200, text: () => body }) as Response });
    const pending = createWithdrawalReads(api, owner, () => current).get(id);
    await Promise.resolve();
    current = false;
    release();
    expect(await pending).toMatchObject({ ok: false, reason: 'aborted' });
  });
});

describe('cancel a withdrawal (W-withdraw-07)', () => {
  const canceled = { ...original, status: 'failed', failureCode: 'withdrawal.canceled', customerStatus: 'canceled', cancellable: false };
  it('posts the one id to withdrawal.cancel and reads whether a hold went back', async () => {
    const requests: { url: string; method?: string; body?: unknown }[] = [];
    const api = createApiClient({
      canWrite: () => true,
      fetch: async (url, opts) => {
        requests.push({ url: String(url), method: opts?.method, body: opts?.body });
        return wire({ ...canceled, holdReleased: true });
      },
    });
    const result = await createWithdrawalReads(api, owner, () => true).cancel(id.toUpperCase());
    expect(result).toMatchObject({ ok: true, data: { customerStatus: 'canceled', holdReleased: true } });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toContain('withdrawal.cancel');
    expect(requests[0]!.method).toBe('POST');
    expect(JSON.parse(String(requests[0]!.body))).toEqual({ withdrawalId: id });
  });
  it("refuses an answer about another account's withdrawal, and a bad id before dispatch", async () => {
    const api = createApiClient({ canWrite: () => true, fetch: async () => wire({ ...canceled, userId: other, holdReleased: false }) });
    expect(await createWithdrawalReads(api, owner, () => true).cancel(id)).toMatchObject({
      ok: false,
      code: 'withdrawal.owner_or_original_invalid',
    });
    const fetcher = vi.fn();
    expect(await createWithdrawalReads(createApiClient({ fetch: fetcher }), owner, () => true).cancel('nope')).toMatchObject({
      ok: false,
      code: 'withdrawal.input_invalid',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('keeps the old record readable without the customer status, and reads the new fields when present', async () => {
    const api = createApiClient({ fetch: async () => wire({ ...original, customerStatus: 'dispatching', cancellable: false }) });
    expect(await createWithdrawalReads(api, owner, () => true).get(id)).toMatchObject({
      ok: true,
      data: { customerStatus: 'dispatching', cancellable: false },
    });
    const old = createApiClient({ fetch: async () => wire(original) });
    const read = await createWithdrawalReads(old, owner, () => true).get(id);
    expect(read.ok && read.data.customerStatus).toBeUndefined();
  });
});
