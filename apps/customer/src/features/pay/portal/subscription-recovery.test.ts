import { expect, it, vi } from 'vitest';
import { createApiClient } from '../../../shared/api';
import { createBusinessPayApi, createPayMutationGuard, type BusinessPayApi } from '../pay-api';
import { checkSubscriptionOriginal, createSubscriptionWithRecovery, replaySubscriptionCreate } from './subscription-recovery';

const after = '2026-10-16T00:00:00.000Z';
const row = {
  id: 'TEST-subscription',
  mandateId: 'TEST-mandate',
  merchantId: 'TEST-merchant',
  path: 'crypto_invoice',
  createdAt: after,
  status: 'paused',
};
const uncertain = { ok: false as const, reason: 'uncertain' as const, code: 'pay.operation_unresolved', message: 'TEST timeout' };
const mandateId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
async function fixture(operation: string, reference?: string) {
  const guard = createPayMutationGuard();
  const key = `TEST-user:${operation}`;
  await guard.run(key, async () => uncertain, reference);
  const query = vi.fn().mockResolvedValue({ ok: true, data: row });
  const pay = { authority: { userId: 'TEST-user', merchantId: 'TEST-merchant' }, guard, query } as unknown as BusinessPayApi;
  return { pay, guard, key, query };
}
it.each(['paused', 'active', 'cancelled'])('clears a subscription lock only after the recorded %s outcome is read', async (status) => {
  const f = await fixture(`subscription:${row.id}`, status);
  f.query.mockResolvedValueOnce({ ok: true, data: { ...row, status: status === 'active' ? 'paused' : 'active' } });
  expect((await checkSubscriptionOriginal(f.pay, row.id, () => true)).ok).toBe(false);
  expect(f.guard.status(f.key)).toBe('uncertain');
  f.query.mockResolvedValueOnce({ ok: true, data: { ...row, status } });
  expect((await checkSubscriptionOriginal(f.pay, row.id, () => true)).ok).toBe(true);
  expect(f.query).toHaveBeenCalledWith('subscription.get', { subscriptionId: row.id }, expect.anything());
  expect(f.guard.status(f.key)).toBeNull();
});
it('keeps locks on failed reads, missing original proof, mismatched ids, or a departed view', async () => {
  const f = await fixture(`subscription:${row.id}`, 'paused');
  for (const data of [uncertain, { ok: true, data: { ...row, id: 'other' } }]) {
    f.query.mockResolvedValueOnce(data);
    expect((await checkSubscriptionOriginal(f.pay, row.id, () => true)).ok).toBe(false);
    expect(f.guard.status(f.key)).toBe('uncertain');
  }
  expect((await checkSubscriptionOriginal(f.pay, row.id, () => false)).ok).toBe(false);
  expect(f.guard.status(f.key)).toBe('uncertain');
});
it('admits create on the per-mandate lock and does not write a cutoff into the journal reference', async () => {
  const mutate = vi.fn().mockResolvedValue(uncertain);
  const query = vi.fn();
  const pay = { authority: { userId: 'TEST-user', merchantId: row.merchantId }, query, mutate } as unknown as BusinessPayApi;
  expect((await createSubscriptionWithRecovery(pay, mandateId, row.path)).ok).toBe(false);
  expect(query).not.toHaveBeenCalled();
  expect(mutate).toHaveBeenCalledTimes(1);
  expect(mutate.mock.calls[0]).toHaveLength(5);
  expect(mutate).toHaveBeenCalledWith(
    'subscription.create',
    { mandateId, path: row.path },
    expect.anything(),
    'pay:write',
    `subscription-create:${mandateId}`,
  );
  expect((await createSubscriptionWithRecovery(pay, mandateId, row.path)).ok).toBe(false);
  expect(mutate).toHaveBeenCalledTimes(2);
});
it('never sends a create when the input is invalid', async () => {
  const mutate = vi.fn();
  const pay = { mutate } as unknown as BusinessPayApi;
  expect((await createSubscriptionWithRecovery(pay, '', row.path)).ok).toBe(false);
  expect((await createSubscriptionWithRecovery(pay, mandateId, 'wire')).ok).toBe(false);
  expect(mutate).not.toHaveBeenCalled();
});
it('does not replay a create when the path is blank or the view has left', async () => {
  const mutate = vi.fn();
  const pay = { mutate } as unknown as BusinessPayApi;
  expect((await replaySubscriptionCreate(pay, mandateId, '', () => true)).ok).toBe(false);
  expect((await replaySubscriptionCreate(pay, mandateId, row.path, () => false)).ok).toBe(false);
  expect(mutate).not.toHaveBeenCalled();
});
it('replays the stored attempt id and leaves that id as the journal reference', async () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const merchantId = '33333333-3333-4333-8333-333333333333';
  const subscriptionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const created = {
    id: subscriptionId,
    mandateId,
    merchantId,
    customerId: 'cust-replay',
    nextRunAt: after,
    status: 'active' as const,
    cancelledAt: null,
    path: row.path,
    createdAt: after,
    anchorAt: null,
    anchorOccurrence: 0,
    pausedAt: null,
    resumedAt: null,
    stalledAt: null,
    stallReason: null,
  };
  const creates: Array<{ idempotencyKey?: string; mandateId?: string; path?: string }> = [];
  const stored = new Map<string, typeof created>();
  const api = createApiClient({
    fetch: async (url, options) => {
      const href = String(url);
      if (href.includes('merchant.me')) {
        return new Response(
          JSON.stringify({
            result: {
              data: {
                id: merchantId,
                userId,
                mode: 'gateway',
                status: 'active',
                kybStatus: 'approved',
                kybRef: 'verified',
                feeBps: null,
              },
            },
          }),
        );
      }
      if (!href.includes('subscription.create')) throw new Error(href);
      const body = JSON.parse(String(options?.body)) as { idempotencyKey?: string; mandateId?: string; path?: string };
      creates.push(body);
      const key = body.idempotencyKey ?? '';
      const prior = stored.get(key);
      if (!prior) {
        stored.set(key, created);
        throw new Error('socket hang up');
      }
      return new Response(JSON.stringify({ result: { data: prior } }));
    },
  });
  const pay = createBusinessPayApi(
    api,
    userId,
    {
      verified: true,
      companyId: 'verified-company',
      companyName: 'Company fixture',
      merchantId,
      userId,
      scopes: ['pay:read', 'pay:write'],
    },
    createPayMutationGuard(),
  );
  const lockId = `${userId}:subscription-create:${mandateId}`;
  const lost = await createSubscriptionWithRecovery(pay, mandateId, row.path);
  expect(lost).toMatchObject({ ok: false, reason: 'uncertain' });
  const attemptId = pay.guard.reference(lockId);
  expect(attemptId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  expect(creates[0]).toMatchObject({ mandateId, path: row.path, idempotencyKey: `${lockId}:${attemptId}` });
  expect(pay.guard.status(lockId)).toBe('uncertain');

  const blank = await replaySubscriptionCreate(pay, mandateId, '', () => true);
  expect(blank).toMatchObject({ ok: false, reason: 'uncertain' });
  expect(creates).toHaveLength(1);
  expect(pay.guard.reference(lockId)).toBe(attemptId);

  const departed = await replaySubscriptionCreate(pay, mandateId, row.path, () => false);
  expect(departed).toMatchObject({ ok: false, reason: 'aborted' });
  expect(creates).toHaveLength(1);

  const replayed = await replaySubscriptionCreate(pay, mandateId, row.path, () => true);
  expect(replayed).toEqual({ ok: true, data: created });
  expect(creates[1]?.idempotencyKey).toBe(`${lockId}:${attemptId}`);
  expect(stored.size).toBe(1);
  expect(pay.guard.status(lockId)).toBeNull();
  expect(pay.guard.reference(lockId)).toBeNull();
});
