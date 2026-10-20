import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../shared/api';
import { submitCreate } from './alerts-actions';
import { readAlertQuota, type AlertIntent } from './notify-api';

const trpc = (data: unknown, status = 200) => new Response(JSON.stringify({ result: { data } }), { status });
const trpcError = (status: number, message: string, code: string) =>
  new Response(JSON.stringify({ error: { message, code: -32600, data: { code } } }), { status });
const client = (fetch: typeof globalThis.fetch) => createApiClient({ fetch, token: () => 'tok' });
const intent: AlertIntent = { marketId: 'market-btc', direction: 'above', targetPrice: '65000.50' };

describe('alert quota', () => {
  it('reads how many are held and the cap, with no input', async () => {
    const fetch = vi.fn(async () => trpc({ kind: 'price', used: 3, max: 10 }));
    const result = await readAlertQuota(client(fetch));
    expect(result).toEqual({ ok: true, data: { kind: 'price', used: 3, max: 10 } });
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe('/api/notify/trpc/notify.alertQuota');
  });
  it('reads a cap that is not set as null, never as a number', async () => {
    const result = await readAlertQuota(client(async () => trpc({ kind: 'price', used: 0, max: null })));
    expect(result.ok && result.data.max).toBeNull();
  });
  it('refuses an answer in an unknown shape', async () => {
    expect((await readAlertQuota(client(async () => trpc({ kind: 'price', used: -1, max: 10 })))).ok).toBe(false);
    expect((await readAlertQuota(client(async () => trpc({ kind: 'price', used: 1, max: 0 })))).ok).toBe(false);
  });
  it('names a create refused for a cap that is not set, and one at the cap', async () => {
    const create = (response: Response) =>
      submitCreate(
        client(async () => response),
        intent,
        'user-1',
      );
    expect(await create(trpcError(412, 'notify.alert_quota_unset: the owner has not set it', 'PRECONDITION_FAILED'))).toEqual({
      kind: 'refused',
      refusal: 'quotaOff',
    });
    expect(await create(trpcError(412, 'alert.quota_reached: a person may hold 10 open price alerts', 'PRECONDITION_FAILED'))).toEqual({
      kind: 'refused',
      refusal: 'quotaReached',
    });
  });
});
