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
  const f = await fixture(
    `subscription-create:${row.mandateId}`,
    JSON.stringify({ path: row.path, cutoff: '2026-10-15T23:55:00.000Z', cutoffId: 'EXISTING' }),
  );
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
  const f = await fixture(
    `subscription-create:${row.mandateId}`,
    JSON.stringify({ path: row.path, cutoff: '2026-10-15T23:55:00.000Z', cutoffId: 'EXISTING' }),
  );
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
    JSON.stringify({ path: row.path, cutoff: '2026-10-15T23:55:00.000Z', cutoffId: row.id }),
  );
  f.query.mockResolvedValue({ ok: true, data: [{ ...row, createdAt: '2026-10-15T23:55:00.000Z' }] });
  expect((await checkSubscriptionCreateOriginal(f.pay, row.mandateId, () => true)).ok).toBe(false);
  expect(f.guard.status(f.key)).toBe('uncertain');
});
it.each(['2026-10-15T23:50:00.000Z', '2026-10-16T00:10:00.000Z'])(
  'admits create with five UUID subscriptions and recovers using server time with browser clock %s',
  async (browserTime) => {
    vi.useFakeTimers();
    vi.setSystemTime(browserTime);
    try {
      const mandateId = '77777777-7777-4777-8777-777777777777';
      const guard = createPayMutationGuard();
      // Labelled test data: real UUID shapes exercise the journal's 200-character bound.
      const existingRows = [1, 2, 3, 4, 5].map((n) => ({
        ...row,
        id: `11111111-1111-4111-8111-11111111111${n}`,
        mandateId,
        createdAt: `2026-10-15T23:5${n}:00.000Z`,
      }));
      const existing = existingRows[4]!;
      const snapshot = [
        existingRows[2]!,
        existing,
        existingRows[0]!,
        existingRows[3]!,
        existingRows[1]!,
        { ...row, id: 'OTHER', mandateId: 'other', createdAt: after },
      ];
      const query = vi.fn().mockResolvedValue({ ok: true, data: snapshot });
      const send = vi.fn(async () => uncertain);
      const mutate = vi.fn((_procedure, _input, _schema, _scope, operation, reference) =>
        guard.run(`TEST-user:${operation}`, send, reference),
      );
      const pay = { authority: { userId: 'TEST-user', merchantId: row.merchantId }, guard, query, mutate } as unknown as BusinessPayApi;
      expect((await createSubscriptionWithRecovery(pay, mandateId, row.path)).ok).toBe(false);
      expect(send).toHaveBeenCalledTimes(1);
      expect(mutate.mock.calls[0]![5].length).toBeLessThanOrEqual(200);
      expect(query).toHaveBeenCalledWith('subscription.list', { merchantId: row.merchantId, limit: 200 }, expect.anything());
      expect(query.mock.invocationCallOrder[0]).toBeLessThan(mutate.mock.invocationCallOrder[0]!);
      expect(mutate).toHaveBeenCalledWith(
        'subscription.create',
        { mandateId, path: row.path },
        expect.anything(),
        'pay:write',
        `subscription-create:${mandateId}`,
        JSON.stringify({ path: row.path, cutoff: existing.createdAt, cutoffId: existing.id }),
      );
      const key = `TEST-user:subscription-create:${mandateId}`;
      expect(guard.status(key)).toBe('uncertain');
      expect((await createSubscriptionWithRecovery(pay, mandateId, row.path)).ok).toBe(false);
      expect(send).toHaveBeenCalledTimes(1);
      expect((await checkSubscriptionCreateOriginal(pay, mandateId, () => true)).ok).toBe(false);
      expect(guard.status(key)).toBe('uncertain');
      const newRow = { ...existing, id: '22222222-2222-4222-8222-222222222222', createdAt: after };
      query.mockResolvedValue({ ok: true, data: [...snapshot, newRow] });
      expect(await checkSubscriptionCreateOriginal(pay, mandateId, () => true)).toEqual({ ok: true, data: newRow });
      expect(guard.status(key)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  },
);
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

it.each([null, after])('recovers a unique match with cutoff %s, including a distinct id at the same timestamp', async (cutoff) => {
  const f = await fixture(
    `subscription-create:${row.mandateId}`,
    JSON.stringify({ path: row.path, cutoff, cutoffId: cutoff === null ? null : 'EXISTING' }),
  );
  f.query.mockResolvedValue({ ok: true, data: [row, { ...row, id: 'EXISTING' }] });
  if (cutoff === null) f.query.mockResolvedValue({ ok: true, data: [row] });
  expect(await checkSubscriptionCreateOriginal(f.pay, row.mandateId, () => true)).toEqual({ ok: true, data: row });
  expect(f.guard.status(f.key)).toBeNull();
});
it('records null cutoff and cutoffId when this mandate has no subscriptions', async () => {
  const f = await fixture('unused');
  f.query.mockResolvedValue({ ok: true, data: [{ ...row, mandateId: 'other' }] });
  const mutate = vi.fn().mockResolvedValue(uncertain);
  const pay = { ...f.pay, mutate } as BusinessPayApi;
  const mandateId = '77777777-7777-4777-8777-777777777777';
  await createSubscriptionWithRecovery(pay, mandateId, row.path);
  expect(mutate).toHaveBeenCalledWith(
    'subscription.create',
    { mandateId, path: row.path },
    expect.anything(),
    'pay:write',
    `subscription-create:${mandateId}`,
    JSON.stringify({ path: row.path, cutoff: null, cutoffId: null }),
  );
});
