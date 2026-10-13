import { describe, expect, it } from 'vitest';
import { expirePaperImplementationShortfallParent } from './oms-is-paper-expire.js';

const PAPER_ON = { enabled: true } as const;
const PAPER_OFF = { enabled: false } as const;
const EXPIRE_AT = '2026-08-31T18:00:00.000Z';
const NOW = new Date('2026-08-31T17:00:00.000Z');

describe('expirePaperImplementationShortfallParent', () => {
  it('refuses missing / whitespace parentClientOrderId', () => {
    expect(
      expirePaperImplementationShortfallParent({
        status: 'paper',
        expireAt: EXPIRE_AT,
        remaining: '10',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
    expect(
      expirePaperImplementationShortfallParent({
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
      expirePaperImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        status: 'paper',
        expireAt: EXPIRE_AT,
        remaining: '10',
      }),
    ).toMatchObject({ ok: false, reason: 'paper_gate_unwired' });
    expect(
      expirePaperImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        status: 'paper',
        expireAt: EXPIRE_AT,
        remaining: '10',
        paper: PAPER_OFF,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_off' });
  });

  it('refuses kind twap with not_live', () => {
    expect(
      expirePaperImplementationShortfallParent({
        parentClientOrderId: 'p-is',
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
      expirePaperImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        status: 'expired',
        expireAt: EXPIRE_AT,
        remaining: '10',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'already_expired' });
  });

  it('refuses status stopped with already_stopped', () => {
    expect(
      expirePaperImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        status: 'stopped',
        expireAt: EXPIRE_AT,
        remaining: '10',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'already_stopped' });
  });

  it('refuses status running with not_live (do not invent paper expire over live)', () => {
    expect(
      expirePaperImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        status: 'running',
        expireAt: EXPIRE_AT,
        remaining: '10',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
  });

  it('refuses omitted expireAt / blank / invalid with missing_expire_at even when now is passed', () => {
    expect(
      expirePaperImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        status: 'paper',
        remaining: '10',
        paper: PAPER_ON,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_expire_at' });
    expect(
      expirePaperImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        status: 'paper',
        expireAt: '   ',
        remaining: '10',
        paper: PAPER_ON,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_expire_at' });
    expect(
      expirePaperImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        status: 'paper',
        expireAt: 'not-a-timestamp',
        remaining: '10',
        paper: PAPER_ON,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_expire_at' });
  });

  it('keeps a future expireAt unexpired and expires when now is at or after expireAt', () => {
    const atDeadline = new Date(EXPIRE_AT);
    const afterDeadline = new Date('2026-08-31T19:00:00.000Z');

    expect(
      expirePaperImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        status: 'paper',
        expireAt: EXPIRE_AT,
        remaining: '10',
        paper: PAPER_ON,
        now: atDeadline,
      }),
    ).toEqual({
      ok: true,
      expired: true,
      paper: true,
      parent: { parentClientOrderId: 'p-is', kind: 'implementation_shortfall' },
      status: 'expired',
      expireAt: EXPIRE_AT,
      residual: { remaining: '10' },
    });

    expect(
      expirePaperImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        status: 'paper',
        expireAt: EXPIRE_AT,
        remaining: '10',
        paper: PAPER_ON,
        now: afterDeadline,
      }),
    ).toMatchObject({
      ok: true,
      status: 'expired',
      expireAt: EXPIRE_AT,
      residual: { remaining: '10' },
    });

    const early = expirePaperImplementationShortfallParent({
      parentClientOrderId: 'p-is',
      status: 'paper',
      expireAt: EXPIRE_AT,
      remaining: '10',
      paper: PAPER_ON,
      now: NOW,
    });
    expect(early).toMatchObject({ ok: false, reason: 'not_due' });
    expect(early).not.toHaveProperty('status', 'expired');
  });

  it('refuses when now is omitted', () => {
    const refused = expirePaperImplementationShortfallParent({
      parentClientOrderId: 'p-is',
      status: 'paper',
      expireAt: EXPIRE_AT,
      remaining: '10',
      paper: PAPER_ON,
    });
    expect(refused).toMatchObject({ ok: false, reason: 'missing_clock' });
    expect(refused).not.toHaveProperty('status', 'expired');
  });

  it("happy: status paper + expireAt + remaining '10' + paper on", () => {
    const expired = expirePaperImplementationShortfallParent({
      parentClientOrderId: 'p-is',
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
      parent: { parentClientOrderId: 'p-is', kind: 'implementation_shortfall' },
      status: 'expired',
      expireAt: EXPIRE_AT,
      residual: { remaining: '10' },
    });
  });

  it('without remaining: residual.remaining null (not invented)', () => {
    const expired = expirePaperImplementationShortfallParent({
      parentClientOrderId: 'p-is',
      status: 'paper',
      expireAt: EXPIRE_AT,
      paper: PAPER_ON,
      now: new Date('2026-08-31T18:00:00.001Z'),
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
