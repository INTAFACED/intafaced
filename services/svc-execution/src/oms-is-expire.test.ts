import { describe, expect, it } from 'vitest';
import { InMemoryApprovedAlgoParentStore } from './oms-start.js';
import { expireImplementationShortfallParent } from './oms-is-expire.js';

function seedWithResidual(parentClientOrderId: string) {
  const parentStore = new InMemoryApprovedAlgoParentStore();
  parentStore.seed({
    parentClientOrderId,
    kind: 'twap',
    status: 'running',
    startedAt: '2026-08-31T12:00:00.000Z',
    schedule: { durationMs: 60_000, sliceIntervalMs: 10_000, slicesPlanned: 6, participationBps: null },
    residual: { remaining: '10' },
  });
  return parentStore;
}

const RETAINED_EXPIRE_AT = '2026-08-31T18:00:00.000Z';

describe('expireImplementationShortfallParent', () => {
  it('refuses missing parentClientOrderId', () => {
    expect(expireImplementationShortfallParent({ status: 'running', expireAt: RETAINED_EXPIRE_AT })).toMatchObject({
      ok: false,
      reason: 'missing_parent',
    });
    expect(
      expireImplementationShortfallParent({
        parentClientOrderId: '   ',
        status: 'running',
        expireAt: RETAINED_EXPIRE_AT,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
  });

  it('refuses kind twap with not_live', () => {
    expect(
      expireImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        kind: 'twap',
        status: 'running',
        expireAt: RETAINED_EXPIRE_AT,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
  });

  it('refuses status expired with already_expired', () => {
    expect(
      expireImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        kind: 'implementation_shortfall',
        status: 'expired',
        expireAt: RETAINED_EXPIRE_AT,
      }),
    ).toMatchObject({ ok: false, reason: 'already_expired' });
  });

  it('refuses status stopped with already_stopped', () => {
    expect(
      expireImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        kind: 'implementation_shortfall',
        status: 'stopped',
        expireAt: RETAINED_EXPIRE_AT,
      }),
    ).toMatchObject({ ok: false, reason: 'already_stopped' });
  });

  it('refuses omitted / blank / whitespace / invalid expireAt with missing_expire_at', () => {
    const base = {
      parentClientOrderId: 'p-is',
      kind: 'implementation_shortfall',
      status: 'running',
    };
    expect(expireImplementationShortfallParent(base)).toMatchObject({
      ok: false,
      reason: 'missing_expire_at',
    });
    expect(expireImplementationShortfallParent({ ...base, expireAt: null })).toMatchObject({
      ok: false,
      reason: 'missing_expire_at',
    });
    expect(expireImplementationShortfallParent({ ...base, expireAt: '' })).toMatchObject({
      ok: false,
      reason: 'missing_expire_at',
    });
    expect(expireImplementationShortfallParent({ ...base, expireAt: '   ' })).toMatchObject({
      ok: false,
      reason: 'missing_expire_at',
    });
    expect(expireImplementationShortfallParent({ ...base, expireAt: 'not-a-date' })).toMatchObject({
      ok: false,
      reason: 'missing_expire_at',
    });
  });

  it('refuses invented clock: durationMs + now passed, expireAt omitted, still missing_expire_at', () => {
    const now = new Date('2026-08-31T12:00:00.000Z');
    const result = expireImplementationShortfallParent({
      parentClientOrderId: 'p-is',
      kind: 'implementation_shortfall',
      status: 'running',
      now,
      durationMs: 60_000,
    } as {
      parentClientOrderId: string;
      kind: string;
      status: string;
      now: Date;
      durationMs: number;
    });
    expect(result).toMatchObject({ ok: false, reason: 'missing_expire_at' });
    expect(result).not.toHaveProperty('expireAt');
    expect((result as { expireAt?: string }).expireAt).not.toBe(now.toISOString());
  });

  it("happy running IS with retained expireAt: expired true, residual.remaining still '10'", () => {
    const parentStore = seedWithResidual('p-is');
    const result = expireImplementationShortfallParent({
      parentClientOrderId: 'p-is',
      kind: 'implementation_shortfall',
      status: 'running',
      expireAt: RETAINED_EXPIRE_AT,
      parentStore,
    });
    expect(result).toEqual({
      ok: true,
      expired: true,
      parent: { parentClientOrderId: 'p-is', kind: 'implementation_shortfall' },
      status: 'expired',
      expireAt: RETAINED_EXPIRE_AT,
      residual: { remaining: '10' },
    });
    expect(parentStore.get('p-is')?.residual).toEqual({ remaining: '10' });
    expect(parentStore.get('p-is')?.residual?.released).toBeUndefined();
    expect(result).not.toHaveProperty('canceled');
    expect(result).not.toHaveProperty('flatten');
  });

  it('without parentStore: residual.remaining null (not invented)', () => {
    const result = expireImplementationShortfallParent({
      parentClientOrderId: 'p-is',
      kind: 'implementation_shortfall',
      status: 'running',
      expireAt: RETAINED_EXPIRE_AT,
    });
    expect(result).toEqual({
      ok: true,
      expired: true,
      parent: { parentClientOrderId: 'p-is', kind: 'implementation_shortfall' },
      status: 'expired',
      expireAt: RETAINED_EXPIRE_AT,
      residual: { remaining: null },
    });
  });

  it("residual is unchanged after expire (parentStore.get remaining still '10')", () => {
    const parentStore = seedWithResidual('p-is');
    const before = parentStore.get('p-is')?.residual;
    const result = expireImplementationShortfallParent({
      parentClientOrderId: 'p-is',
      kind: 'implementation_shortfall',
      status: 'running',
      expireAt: RETAINED_EXPIRE_AT,
      parentStore,
    });
    expect(result.ok).toBe(true);
    expect(parentStore.get('p-is')?.residual).toEqual(before);
    expect(parentStore.get('p-is')?.residual).toEqual({ remaining: '10' });
  });
});
