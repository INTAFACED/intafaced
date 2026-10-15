import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { composeGuards, NOOP_GUARDS, PAY_GUARD_NAMES, PayGuardRefusal, type PartialPayGuards } from './guards.js';
import { buildPayGuards } from './registry.js';

const sql = {} as Sql;
const payment = { tx: sql, kind: 'payment.create' as const, paymentId: 'p', merchantId: 'm', payload: {} };

describe('guard seams: defaults', () => {
  it('every named hook exists on the no-op set and resolves without effect', async () => {
    expect(Object.keys(NOOP_GUARDS).sort()).toEqual([...PAY_GUARD_NAMES].sort());
    await expect(NOOP_GUARDS.beforePaymentAdmit(payment)).resolves.toBeUndefined();
    await expect(NOOP_GUARDS.beforeSettlementRun({ sql, phase: 'prepare' })).resolves.toBeUndefined();
    await expect(
      NOOP_GUARDS.beforeConversion({ sql, merchantId: 'm', settlementId: 's', fromAsset: 'USD', toAsset: 'USDT', fromAmount: 1n }),
    ).resolves.toBeUndefined();
  });

  it('the registry with no stream implementations behaves as no-ops (nothing refuses today)', async () => {
    const guards = buildPayGuards({ sql });
    for (const name of PAY_GUARD_NAMES) expect(typeof guards[name]).toBe('function');
    await expect(guards.beforePaymentAdmit(payment)).resolves.toBeUndefined();
    await expect(
      guards.beforePayoutAdmit({
        tx: sql,
        settlementId: 's',
        merchantId: 'm',
        assetId: 'USDT',
        amount: 1n,
        railId: 'crypto-native',
        destination: { kind: 'crypto', ref: '0x0' },
        attempt: 0,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('composeGuards', () => {
  it('runs implementations in order and stops at the first refusal', async () => {
    const order: string[] = [];
    const a: PartialPayGuards = {
      beforePaymentAdmit: async () => {
        order.push('a');
      },
    };
    const b: PartialPayGuards = {
      beforePaymentAdmit: async () => {
        order.push('b');
        throw new PayGuardRefusal('pay.guard_halted', 'unavailable');
      },
    };
    const c: PartialPayGuards = {
      beforePaymentAdmit: async () => {
        order.push('c');
      },
    };
    await expect(composeGuards(a, b, c).beforePaymentAdmit(payment)).rejects.toMatchObject({
      code: 'pay.guard_halted',
      kind: 'unavailable',
    });
    expect(order).toEqual(['a', 'b']);
  });

  it('a hook one part does not implement stays a no-op for that part', async () => {
    const only = vi.fn(async () => undefined);
    const guards = composeGuards({ beforeSettlementRun: only }, {});
    await guards.beforePaymentAdmit(payment);
    await guards.beforeSettlementRun({ sql, phase: 'post' });
    expect(only).toHaveBeenCalledTimes(1);
  });

  it('fails closed: anything other than PayGuardRefusal becomes pay.guard_unavailable with no internal message', async () => {
    for (const thrown of [
      new Error('relation "pay.halts" does not exist'),
      Object.assign(new Error('x'), { code: 'pay.merchant_inactive' }),
      'boom',
    ]) {
      const guards = composeGuards({
        beforePayoutExecute: async () => {
          throw thrown;
        },
      });
      const error = await guards
        .beforePayoutExecute({
          sql,
          settlementId: 's',
          merchantId: 'm',
          assetId: 'USDT',
          amount: 1n,
          railId: 'crypto-native',
          destination: { kind: 'crypto', ref: '0x0' },
          attempt: 0,
        })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(PayGuardRefusal);
      expect(error).toMatchObject({ code: 'pay.guard_unavailable', kind: 'unavailable', message: 'pay.guard_unavailable' });
      expect(JSON.stringify(error)).not.toContain('pay.halts');
    }
  });

  it('a retryable Postgres error passes through untouched so the transaction can retry', async () => {
    for (const code of ['40001', '40P01']) {
      const pg = Object.assign(new Error('could not serialize access'), { code });
      const guards = composeGuards({
        beforeSettlementRun: async () => {
          throw pg;
        },
      });
      await expect(guards.beforeSettlementRun({ sql, phase: 'prepare' })).rejects.toBe(pg);
    }
  });
});
