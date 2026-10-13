import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { capAgainstParentRemaining } from './oms-parent-cap.js';
import type { ApprovedAlgoParent } from './oms-start.js';

function parent(remaining?: string | null): ApprovedAlgoParent {
  return {
    parentClientOrderId: 'parent-twap',
    kind: 'twap',
    status: 'running',
    startedAt: null,
    schedule: {
      durationMs: 60_000,
      sliceIntervalMs: 10_000,
      slicesPlanned: 6,
      participationBps: null,
    },
    ...(remaining === undefined ? {} : { residual: remaining === null ? null : { remaining } }),
  };
}

describe('capAgainstParentRemaining', () => {
  it('refuses a child quantity of zero or below and does not return nextRemaining', () => {
    const zero = capAgainstParentRemaining(parent('1.5'), parseAmount('0'), 'slice');
    expect(zero).toMatchObject({ ok: false, reason: 'non_positive_qty' });
    expect(zero).not.toHaveProperty('nextRemaining');

    const negative = capAgainstParentRemaining(parent('1'), parseAmount('-0.5'), 'slice');
    expect(negative).toMatchObject({ ok: false, reason: 'non_positive_qty' });
    expect(negative).not.toHaveProperty('nextRemaining');
  });

  it('returns remaining minus a positive child quantity as a decimal string', () => {
    const result = capAgainstParentRemaining(parent('1.5'), parseAmount('0.25'), 'slice');
    expect(result).toEqual({ ok: true, nextRemaining: '1.25' });
  });

  it('refuses a missing residual.remaining and does not invent a leftover', () => {
    const omitted = capAgainstParentRemaining(parent(), parseAmount('0.25'), 'slice');
    expect(omitted).toMatchObject({ ok: false, reason: 'missing_residual' });
    expect(omitted).not.toHaveProperty('nextRemaining');

    const blank = capAgainstParentRemaining(parent('   '), parseAmount('0.25'), 'slice');
    expect(blank).toMatchObject({ ok: false, reason: 'missing_residual' });
    expect(blank).not.toHaveProperty('nextRemaining');
  });

  it('refuses a negative residual.remaining and does not invent a leftover', () => {
    const result = capAgainstParentRemaining(parent('-1'), parseAmount('0.25'), 'slice');
    expect(result).toMatchObject({ ok: false, reason: 'missing_residual' });
    expect(result).not.toHaveProperty('nextRemaining');
  });
});
