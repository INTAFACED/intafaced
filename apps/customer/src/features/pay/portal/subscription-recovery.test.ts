import { expect, it, vi } from 'vitest';
import { createPayMutationGuard, type BusinessPayApi } from '../pay-api';
import { checkSubscriptionCreateOriginal, checkSubscriptionOriginal, createSubscriptionWithRecovery } from './subscription-recovery';

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
it('checks the bounded list for the original mandate and leaves other mandate locks alone', async () => {
  const f = await fixture(`subscription-create:${row.mandateId}`, JSON.stringify({ path: row.path, after, existingIds: [] }));
  const otherKey = 'TEST-user:subscription-create:other';
  await f.guard.run(otherKey, async () => uncertain);
  f.query.mockResolvedValue({ ok: true, data: [row, { ...row, id: 'OTHER', mandateId: 'other' }] });
  const result = await checkSubscriptionCreateOriginal(f.pay, row.mandateId, () => true);
  expect(result).toEqual({ ok: true, data: row });
  expect(f.query).toHaveBeenCalledWith('subscription.list', { merchantId: row.merchantId, limit: 200 }, expect.anything());
  expect(f.guard.status(f.key)).toBeNull();
  expect(f.guard.status(otherKey)).toBe('uncertain');
});
it.each(
  [
    [],
    [{ ...row, createdAt: '2026-10-15T00:00:00.000Z' }],
    [{ ...row, mandateId: 'other' }],
    [{ ...row, path: 'other' }],
    [row, { ...row, id: 'AMBIGUOUS' }],
  ].map((rows) => ({ rows })),
)('retains the create lock without a unique matching new schedule: $rows', async ({ rows }) => {
  const f = await fixture(`subscription-create:${row.mandateId}`, JSON.stringify({ path: row.path, after, existingIds: [] }));
  f.query.mockResolvedValue({ ok: true, data: rows });
  expect((await checkSubscriptionCreateOriginal(f.pay, row.mandateId, () => true)).ok).toBe(false);
  expect(f.guard.status(f.key)).toBe('uncertain');
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
  const legacy = await fixture(`subscription-create:${row.mandateId}`);
  legacy.query.mockResolvedValue({ ok: true, data: [row] });
  expect((await checkSubscriptionCreateOriginal(legacy.pay, row.mandateId, () => true)).ok).toBe(false);
  expect(legacy.guard.status(legacy.key)).toBe('uncertain');
});
it('keeps the lock when a browser ten minutes slow sees an existing schedule on the same mandate and path', async () => {
  const f = await fixture(
    `subscription-create:${row.mandateId}`,
    JSON.stringify({ path: row.path, after: '2026-10-15T23:50:00.000Z', existingIds: [row.id] }),
  );
  f.query.mockResolvedValue({ ok: true, data: [{ ...row, createdAt: '2026-10-15T23:55:00.000Z' }] });
  expect((await checkSubscriptionCreateOriginal(f.pay, row.mandateId, () => true)).ok).toBe(false);
  expect(f.guard.status(f.key)).toBe('uncertain');
});
it('captures existing mandate ids before sending and recovers only a unique new id despite clock skew', async () => {
  vi.useFakeTimers();
  vi.setSystemTime('2026-10-15T23:50:00.000Z');
  try {
    const mandateId = '77777777-7777-4777-8777-777777777777';
    const guard = createPayMutationGuard();
    const existing = { ...row, mandateId, createdAt: '2026-10-15T23:55:00.000Z' };
    const query = vi.fn().mockResolvedValue({ ok: true, data: [existing, { ...row, id: 'OTHER', mandateId: 'other' }] });
    const send = vi.fn(async () => uncertain);
    const mutate = vi.fn((_procedure, _input, _schema, _scope, operation, reference) =>
      guard.run(`TEST-user:${operation}`, send, reference),
    );
    const pay = { authority: { userId: 'TEST-user', merchantId: row.merchantId }, guard, query, mutate } as unknown as BusinessPayApi;
    expect((await createSubscriptionWithRecovery(pay, mandateId, row.path)).ok).toBe(false);
    expect(query).toHaveBeenCalledWith('subscription.list', { merchantId: row.merchantId, limit: 200 }, expect.anything());
    expect(query.mock.invocationCallOrder[0]).toBeLessThan(mutate.mock.invocationCallOrder[0]!);
    expect(mutate).toHaveBeenCalledWith(
      'subscription.create',
      { mandateId, path: row.path },
      expect.anything(),
      'pay:write',
      `subscription-create:${mandateId}`,
      JSON.stringify({ path: row.path, after: '2026-10-15T23:50:00.000Z', existingIds: [row.id] }),
    );
    const key = `TEST-user:subscription-create:${mandateId}`;
    expect(guard.status(key)).toBe('uncertain');
    expect((await createSubscriptionWithRecovery(pay, mandateId, row.path)).ok).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await checkSubscriptionCreateOriginal(pay, mandateId, () => true)).ok).toBe(false);
    expect(guard.status(key)).toBe('uncertain');
    const newRow = { ...existing, id: 'NEW', createdAt: after };
    query.mockResolvedValue({ ok: true, data: [existing, newRow] });
    expect(await checkSubscriptionCreateOriginal(pay, mandateId, () => true)).toEqual({ ok: true, data: newRow });
    expect(guard.status(key)).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
it('never sends a create when the attempt-time snapshot fails or input is invalid', async () => {
  const f = await fixture('unused');
  const mutate = vi.fn();
  const pay = { ...f.pay, mutate } as BusinessPayApi;
  f.query.mockResolvedValue(uncertain);
  const mandateId = '77777777-7777-4777-8777-777777777777';
  expect(await createSubscriptionWithRecovery(pay, mandateId, row.path)).toEqual(uncertain);
  expect((await createSubscriptionWithRecovery(pay, '', row.path)).ok).toBe(false);
  expect(mutate).not.toHaveBeenCalled();
  expect(f.query).toHaveBeenCalledTimes(1);
});
it('keeps a legacy timestamp-only proof locked', async () => {
  const f = await fixture(`subscription-create:${row.mandateId}`, JSON.stringify({ path: row.path, after }));
  f.query.mockResolvedValue({ ok: true, data: [row] });
  expect((await checkSubscriptionCreateOriginal(f.pay, row.mandateId, () => true)).ok).toBe(false);
  expect(f.guard.status(f.key)).toBe('uncertain');
});
