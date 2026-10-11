import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { startPaperSniperParent } from './oms-paper-sniper-start.js';

const OP = '33333333-3333-4333-8333-333333333333';
const PAPER_ON = { enabled: true } as const;
const PAPER_OFF = { enabled: false } as const;
const TRIGGER = '100';

describe('startPaperSniperParent', () => {
  it('refuses missing / whitespace parentClientOrderId', () => {
    expect(
      startPaperSniperParent({
        approved: true,
        status: 'paper',
        triggerPrice: TRIGGER,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
    expect(
      startPaperSniperParent({
        parentClientOrderId: '   ',
        approved: true,
        status: 'paper',
        triggerPrice: TRIGGER,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
  });

  it("paper unwired / paper_off refuse even with approved paper + triggerPrice '100'", () => {
    expect(
      startPaperSniperParent({
        parentClientOrderId: 'p-snip',
        approved: true,
        status: 'paper',
        triggerPrice: TRIGGER,
        operatorId: OP,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_gate_unwired' });
    expect(
      startPaperSniperParent({
        parentClientOrderId: 'p-snip',
        approved: true,
        status: 'paper',
        triggerPrice: TRIGGER,
        operatorId: OP,
        paper: PAPER_OFF,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_off' });
  });

  it('refuses kind twap with not_live', () => {
    expect(
      startPaperSniperParent({
        parentClientOrderId: 'p-snip',
        kind: 'twap',
        approved: true,
        status: 'paper',
        triggerPrice: TRIGGER,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
  });

  it('refuses status running with already_started', () => {
    expect(
      startPaperSniperParent({
        parentClientOrderId: 'p-snip',
        approved: true,
        status: 'running',
        triggerPrice: TRIGGER,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'already_started' });
  });

  it("refuses padded status 'running ' with already_started and does not start", () => {
    const started = startPaperSniperParent({
      parentClientOrderId: 'p-snip',
      approved: true,
      status: 'running ',
      triggerPrice: TRIGGER,
      operatorId: OP,
      paper: PAPER_ON,
    });
    expect(started).toMatchObject({ ok: false, reason: 'already_started' });
    expect(started).not.toMatchObject({ started: true });
  });

  it('refuses stopped, expired, and halted with not_approved even when approved is true', () => {
    for (const status of ['stopped', 'expired', 'halted'] as const) {
      const started = startPaperSniperParent({
        parentClientOrderId: 'p-snip',
        approved: true,
        status,
        triggerPrice: TRIGGER,
        operatorId: OP,
        paper: PAPER_ON,
      });
      expect(started).toMatchObject({ ok: false, reason: 'not_approved' });
      expect(started).not.toMatchObject({ started: true });
    }
  });

  it('refuses blank and whitespace-only status with not_approved even when approved is true and does not start', () => {
    for (const status of ['', '   '] as const) {
      const started = startPaperSniperParent({
        parentClientOrderId: 'p-snip',
        approved: true,
        status,
        triggerPrice: TRIGGER,
        operatorId: OP,
        paper: PAPER_ON,
      });
      expect(started).toMatchObject({ ok: false, reason: 'not_approved' });
      expect(started).not.toMatchObject({ started: true });
    }
  });

  it('refuses approved false with not_approved even when status is paper or approved', () => {
    for (const status of ['paper', 'approved'] as const) {
      const started = startPaperSniperParent({
        parentClientOrderId: 'p-snip',
        approved: false,
        status,
        triggerPrice: TRIGGER,
        operatorId: OP,
        paper: PAPER_ON,
      });
      expect(started).toMatchObject({ ok: false, reason: 'not_approved' });
      expect(started).not.toMatchObject({ started: true });
    }
  });

  it('refuses omitted status and approved:false with not_approved', () => {
    expect(
      startPaperSniperParent({
        parentClientOrderId: 'p-snip',
        approved: false,
        triggerPrice: TRIGGER,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_approved' });
  });

  it('refuses missing / whitespace operator', () => {
    expect(
      startPaperSniperParent({
        parentClientOrderId: 'p-snip',
        approved: true,
        status: 'paper',
        triggerPrice: TRIGGER,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_operator' });
    expect(
      startPaperSniperParent({
        parentClientOrderId: 'p-snip',
        approved: true,
        status: 'paper',
        triggerPrice: TRIGGER,
        operatorId: '   ',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_operator' });
  });

  it('refuses omitted / blank / invalid triggerPrice with missing_trigger', () => {
    expect(
      startPaperSniperParent({
        parentClientOrderId: 'p-snip',
        approved: true,
        status: 'paper',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_trigger' });
    expect(
      startPaperSniperParent({
        parentClientOrderId: 'p-snip',
        approved: true,
        status: 'paper',
        triggerPrice: '',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_trigger' });
    expect(
      startPaperSniperParent({
        parentClientOrderId: 'p-snip',
        approved: true,
        status: 'paper',
        triggerPrice: 'not-an-amount',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_trigger' });
  });

  it("happy: status paper + triggerPrice '100' + operator + paper on", () => {
    const started = startPaperSniperParent({
      parentClientOrderId: 'p-snip',
      status: 'paper',
      triggerPrice: TRIGGER,
      operatorId: OP,
      paper: PAPER_ON,
    });
    expect(started).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-snip',
      kind: 'sniper',
      status: 'paper',
      triggerPrice: formatAmount(parseAmount(TRIGGER)),
    });
    expect(started).not.toMatchObject({ status: 'running' });
    expect(started).not.toHaveProperty('matching');
  });

  it("happy: approved true + triggerPrice '100' + operator + paper on (status omitted)", () => {
    expect(
      startPaperSniperParent({
        parentClientOrderId: 'p-snip',
        approved: true,
        triggerPrice: TRIGGER,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-snip',
      kind: 'sniper',
      status: 'paper',
      triggerPrice: formatAmount(parseAmount(TRIGGER)),
    });
  });

  it("happy: approved true + status paper + triggerPrice '100' starts paper", () => {
    expect(
      startPaperSniperParent({
        parentClientOrderId: 'p-snip',
        approved: true,
        status: 'paper',
        triggerPrice: TRIGGER,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-snip',
      kind: 'sniper',
      status: 'paper',
      triggerPrice: formatAmount(parseAmount(TRIGGER)),
    });
  });

  it("happy: approved true + status approved + triggerPrice '100' starts paper", () => {
    expect(
      startPaperSniperParent({
        parentClientOrderId: 'p-snip',
        approved: true,
        status: 'approved',
        triggerPrice: TRIGGER,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-snip',
      kind: 'sniper',
      status: 'paper',
      triggerPrice: formatAmount(parseAmount(TRIGGER)),
    });
  });

  it("happy: status approved + triggerPrice '100' starts when approved is omitted", () => {
    expect(
      startPaperSniperParent({
        parentClientOrderId: 'p-snip',
        status: 'approved',
        triggerPrice: TRIGGER,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-snip',
      kind: 'sniper',
      status: 'paper',
      triggerPrice: formatAmount(parseAmount(TRIGGER)),
    });
  });
});
