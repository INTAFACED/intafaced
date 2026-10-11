import { describe, expect, it } from 'vitest';
import { expirePaperIcebergParent } from './oms-paper-iceberg-expire.js';

const PAPER_ON = { enabled: true } as const;
const PAPER_OFF = { enabled: false } as const;
const EXPIRE_AT = '2026-08-31T18:00:00.000Z';
const NOW = new Date('2026-08-31T17:00:00.000Z');

describe('expirePaperIcebergParent', () => {
  it('refuses missing / whitespace parentClientOrderId', () => {
    expect(
      expirePaperIcebergParent({
        status: 'paper',
        expireAt: EXPIRE_AT,
        remaining: '10',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
    expect(
      expirePaperIcebergParent({
        parentClientOrderId: '   ',
        status: 'paper',
        expireAt: EXPIRE_AT,
        remaining: '10',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
  });

  it('paper unwired / paper_off refuse even with status paper + expireAt', () => {
    expect(
      expirePaperIcebergParent({
        parentClientOrderId: 'p-ice',
        status: 'paper',
        expireAt: EXPIRE_AT,
        remaining: '10',
      }),
    ).toMatchObject({ ok: false, reason: 'paper_gate_unwired' });
    expect(
      expirePaperIcebergParent({
        parentClientOrderId: 'p-ice',
        status: 'paper',
        expireAt: EXPIRE_AT,
        remaining: '10',
        paper: PAPER_OFF,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_off' });
  });

  it('refuses kind twap with not_live', () => {
    expect(
      expirePaperIcebergParent({
        parentClientOrderId: 'p-ice',
        kind: 'twap',
        status: 'paper',
        expireAt: EXPIRE_AT,
        remaining: '10',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
  });

  it('refuses status expired with already_expired', () => {
    expect(
      expirePaperIcebergParent({
        parentClientOrderId: 'p-ice',
        status: 'expired',
        expireAt: EXPIRE_AT,
        remaining: '10',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'already_expired' });
  });

  it('refuses status stopped with already_stopped', () => {
    expect(
      expirePaperIcebergParent({
        parentClientOrderId: 'p-ice',
        status: 'stopped',
        expireAt: EXPIRE_AT,
        remaining: '10',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'already_stopped' });
  });

  it('refuses status running with not_live (do not invent paper expire over live)', () => {
    expect(
      expirePaperIcebergParent({
        parentClientOrderId: 'p-ice',
        status: 'running',
        expireAt: EXPIRE_AT,
        remaining: '10',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
  });

  it('refuses omitted expireAt / blank / invalid with missing_expire_at even when now is passed', () => {
    expect(
      expirePaperIcebergParent({
        parentClientOrderId: 'p-ice',
        status: 'paper',
        remaining: '10',
        paper: PAPER_ON,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_expire_at' });
    expect(
      expirePaperIcebergParent({
        parentClientOrderId: 'p-ice',
        status: 'paper',
        expireAt: '   ',
        remaining: '10',
        paper: PAPER_ON,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_expire_at' });
    expect(
      expirePaperIcebergParent({
        parentClientOrderId: 'p-ice',
        status: 'paper',
        expireAt: 'not-a-timestamp',
        remaining: '10',
        paper: PAPER_ON,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_expire_at' });
  });

  it('refuses not_due when now is still before the retained expireAt', () => {
    const result = expirePaperIcebergParent({
      parentClientOrderId: 'p-ice',
      status: 'paper',
      expireAt: EXPIRE_AT,
      remaining: '10',
      paper: PAPER_ON,
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, reason: 'not_due' });
    expect(result).not.toMatchObject({ status: 'expired' });
  });

  it('refuses missing_clock when now is omitted, not a Date, or an invalid Date', () => {
    const paperParent = {
      parentClientOrderId: 'p-ice',
      status: 'paper',
      expireAt: EXPIRE_AT,
      remaining: '10',
      paper: PAPER_ON,
    };
    expect(expirePaperIcebergParent(paperParent)).toMatchObject({
      ok: false,
      reason: 'missing_clock',
    });
    expect(
      expirePaperIcebergParent({
        ...paperParent,
        now: '2026-08-31T18:00:00.000Z' as unknown as Date,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_clock' });
    expect(
      expirePaperIcebergParent({
        ...paperParent,
        now: new Date(Number.NaN),
      }),
    ).toMatchObject({ ok: false, reason: 'missing_clock' });
  });

  it("happy: status paper + expireAt + remaining '10' + paper on at expireAt", () => {
    const expired = expirePaperIcebergParent({
      parentClientOrderId: 'p-ice',
      status: 'paper',
      expireAt: EXPIRE_AT,
      remaining: '10',
      paper: PAPER_ON,
      now: new Date(EXPIRE_AT),
    });
    expect(expired).toEqual({
      ok: true,
      expired: true,
      paper: true,
      parent: { parentClientOrderId: 'p-ice', kind: 'iceberg' },
      status: 'expired',
      expireAt: EXPIRE_AT,
      residual: { remaining: '10' },
    });
  });

  it('expires when now is after the retained expireAt and echoes residual', () => {
    const expired = expirePaperIcebergParent({
      parentClientOrderId: 'p-ice',
      status: 'paper',
      expireAt: EXPIRE_AT,
      remaining: '10',
      paper: PAPER_ON,
      now: new Date('2026-08-31T19:00:00.000Z'),
    });
    expect(expired).toEqual({
      ok: true,
      expired: true,
      paper: true,
      parent: { parentClientOrderId: 'p-ice', kind: 'iceberg' },
      status: 'expired',
      expireAt: EXPIRE_AT,
      residual: { remaining: '10' },
    });
  });

  it('without remaining: residual.remaining null (not invented)', () => {
    const expired = expirePaperIcebergParent({
      parentClientOrderId: 'p-ice',
      status: 'paper',
      expireAt: EXPIRE_AT,
      paper: PAPER_ON,
      now: new Date(EXPIRE_AT),
    });
    expect(expired).toMatchObject({
      ok: true,
      expired: true,
      paper: true,
      status: 'expired',
      expireAt: EXPIRE_AT,
      residual: { remaining: null },
    });
  });
});
