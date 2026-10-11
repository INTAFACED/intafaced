import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { releaseExpiredPaperIcebergResidual } from './oms-paper-iceberg-release-residual.js';

const PAPER_ON = { enabled: true } as const;
const PAPER_OFF = { enabled: false } as const;
const RETAINED_REMAINING = '1.25';

describe('releaseExpiredPaperIcebergResidual', () => {
  it('refuses missing parentClientOrderId', () => {
    expect(
      releaseExpiredPaperIcebergResidual({
        status: 'expired',
        remaining: RETAINED_REMAINING,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
    expect(
      releaseExpiredPaperIcebergResidual({
        parentClientOrderId: '   ',
        status: 'expired',
        remaining: RETAINED_REMAINING,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
  });

  it("paper unwired / paper_off refuse even with status expired + remaining '1.25'", () => {
    expect(
      releaseExpiredPaperIcebergResidual({
        parentClientOrderId: 'p-ice',
        kind: 'iceberg',
        status: 'expired',
        remaining: RETAINED_REMAINING,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_gate_unwired' });
    expect(
      releaseExpiredPaperIcebergResidual({
        parentClientOrderId: 'p-ice',
        kind: 'iceberg',
        status: 'expired',
        remaining: RETAINED_REMAINING,
        paper: PAPER_OFF,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_off' });
  });

  it('refuses kind twap with not_live', () => {
    expect(
      releaseExpiredPaperIcebergResidual({
        parentClientOrderId: 'p-ice',
        kind: 'twap',
        status: 'expired',
        remaining: RETAINED_REMAINING,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
  });

  it("refuses status paper / running / omitted with not_expired even when remaining is '1.25'", () => {
    const base = {
      parentClientOrderId: 'p-ice',
      kind: 'iceberg',
      remaining: RETAINED_REMAINING,
      paper: PAPER_ON,
    };
    expect(releaseExpiredPaperIcebergResidual({ ...base, status: 'paper' })).toMatchObject({
      ok: false,
      reason: 'not_expired',
    });
    expect(releaseExpiredPaperIcebergResidual({ ...base, status: 'running' })).toMatchObject({
      ok: false,
      reason: 'not_expired',
    });
    expect(releaseExpiredPaperIcebergResidual(base)).toMatchObject({
      ok: false,
      reason: 'not_expired',
    });
  });

  it('refuses residualReleased true with already_released', () => {
    expect(
      releaseExpiredPaperIcebergResidual({
        parentClientOrderId: 'p-ice',
        kind: 'iceberg',
        status: 'expired',
        remaining: RETAINED_REMAINING,
        residualReleased: true,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'already_released' });
  });

  it('refuses omitted / null / whitespace remaining with missing_residual', () => {
    const base = {
      parentClientOrderId: 'p-ice',
      kind: 'iceberg',
      status: 'expired',
      paper: PAPER_ON,
    };
    expect(releaseExpiredPaperIcebergResidual(base)).toMatchObject({
      ok: false,
      reason: 'missing_residual',
    });
    expect(releaseExpiredPaperIcebergResidual({ ...base, remaining: null })).toMatchObject({
      ok: false,
      reason: 'missing_residual',
    });
    expect(releaseExpiredPaperIcebergResidual({ ...base, remaining: '' })).toMatchObject({
      ok: false,
      reason: 'missing_residual',
    });
    expect(releaseExpiredPaperIcebergResidual({ ...base, remaining: '   ' })).toMatchObject({
      ok: false,
      reason: 'missing_residual',
    });
  });

  it("refuses invalid remaining 'not-an-amount' with missing_residual", () => {
    expect(
      releaseExpiredPaperIcebergResidual({
        parentClientOrderId: 'p-ice',
        kind: 'iceberg',
        status: 'expired',
        remaining: 'not-an-amount',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_residual' });
  });

  it.each(['0', '0.0', '-1', '-1.25'])('refuses remaining %j with missing_residual and does not release', (remaining) => {
    const result = releaseExpiredPaperIcebergResidual({
      parentClientOrderId: 'p-ice',
      kind: 'iceberg',
      status: 'expired',
      remaining,
      paper: PAPER_ON,
    });
    expect(result).toMatchObject({ ok: false, reason: 'missing_residual' });
    expect(result).not.toMatchObject({ released: true });
  });

  it("happy expired paper remaining '1.25' + paper on: released through ledger-client", () => {
    const result = releaseExpiredPaperIcebergResidual({
      parentClientOrderId: 'p-ice',
      kind: 'iceberg',
      status: 'expired',
      remaining: RETAINED_REMAINING,
      paper: PAPER_ON,
    });
    expect(result).toEqual({
      ok: true,
      released: true,
      paper: true,
      parent: { parentClientOrderId: 'p-ice', kind: 'iceberg' },
      status: 'expired',
      residual: {
        remaining: formatAmount(parseAmount(RETAINED_REMAINING)),
        released: true,
      },
    });
  });
});
