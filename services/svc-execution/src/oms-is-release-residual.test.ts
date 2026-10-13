import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { releaseExpiredImplementationShortfallResidual } from './oms-is-release-residual.js';

const RETAINED_REMAINING = '1.25';

describe('releaseExpiredImplementationShortfallResidual', () => {
  it('refuses missing parentClientOrderId', () => {
    expect(
      releaseExpiredImplementationShortfallResidual({
        status: 'expired',
        remaining: RETAINED_REMAINING,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
    expect(
      releaseExpiredImplementationShortfallResidual({
        parentClientOrderId: '   ',
        status: 'expired',
        remaining: RETAINED_REMAINING,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
  });

  it('refuses kind twap with not_live', () => {
    expect(
      releaseExpiredImplementationShortfallResidual({
        parentClientOrderId: 'p-is',
        kind: 'twap',
        status: 'expired',
        remaining: RETAINED_REMAINING,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
  });

  it("refuses status running / approved / omitted with not_expired even when remaining is '1.25'", () => {
    const base = {
      parentClientOrderId: 'p-is',
      kind: 'implementation_shortfall',
      remaining: RETAINED_REMAINING,
    };
    expect(releaseExpiredImplementationShortfallResidual({ ...base, status: 'running' })).toMatchObject({
      ok: false,
      reason: 'not_expired',
    });
    expect(releaseExpiredImplementationShortfallResidual({ ...base, status: 'approved' })).toMatchObject({
      ok: false,
      reason: 'not_expired',
    });
    expect(releaseExpiredImplementationShortfallResidual(base)).toMatchObject({
      ok: false,
      reason: 'not_expired',
    });
  });

  it('refuses residualReleased true with already_released', () => {
    expect(
      releaseExpiredImplementationShortfallResidual({
        parentClientOrderId: 'p-is',
        kind: 'implementation_shortfall',
        status: 'expired',
        remaining: RETAINED_REMAINING,
        residualReleased: true,
      }),
    ).toMatchObject({ ok: false, reason: 'already_released' });
  });

  it('refuses omitted / null / whitespace remaining with missing_residual', () => {
    const base = {
      parentClientOrderId: 'p-is',
      kind: 'implementation_shortfall',
      status: 'expired',
    };
    expect(releaseExpiredImplementationShortfallResidual(base)).toMatchObject({
      ok: false,
      reason: 'missing_residual',
    });
    expect(releaseExpiredImplementationShortfallResidual({ ...base, remaining: null })).toMatchObject({
      ok: false,
      reason: 'missing_residual',
    });
    expect(releaseExpiredImplementationShortfallResidual({ ...base, remaining: '' })).toMatchObject({
      ok: false,
      reason: 'missing_residual',
    });
    expect(releaseExpiredImplementationShortfallResidual({ ...base, remaining: '   ' })).toMatchObject({
      ok: false,
      reason: 'missing_residual',
    });
  });

  it("refuses invalid remaining 'not-an-amount' with missing_residual", () => {
    expect(
      releaseExpiredImplementationShortfallResidual({
        parentClientOrderId: 'p-is',
        kind: 'implementation_shortfall',
        status: 'expired',
        remaining: 'not-an-amount',
      }),
    ).toMatchObject({ ok: false, reason: 'missing_residual' });
  });

  it('refuses invented amount: durationMs 60000 + no remaining still missing_residual', () => {
    const result = releaseExpiredImplementationShortfallResidual({
      parentClientOrderId: 'p-is',
      kind: 'implementation_shortfall',
      status: 'expired',
      durationMs: 60_000,
    } as {
      parentClientOrderId: string;
      kind: string;
      status: string;
      durationMs: number;
    });
    expect(result).toMatchObject({ ok: false, reason: 'missing_residual' });
    expect(result).not.toHaveProperty('residual');
    expect((result as { residual?: { remaining?: string } }).residual?.remaining).toBeUndefined();
  });

  it("happy expired IS remaining '1.25': released through ledger-client", () => {
    const result = releaseExpiredImplementationShortfallResidual({
      parentClientOrderId: 'p-is',
      kind: 'implementation_shortfall',
      status: 'expired',
      remaining: RETAINED_REMAINING,
    });
    expect(result).toEqual({
      ok: true,
      released: true,
      parent: { parentClientOrderId: 'p-is', kind: 'implementation_shortfall' },
      status: 'expired',
      residual: {
        remaining: formatAmount(parseAmount(RETAINED_REMAINING)),
        released: true,
      },
    });
  });
});
