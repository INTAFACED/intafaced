import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { startPaperScaleOutParent } from './oms-paper-scale-out-start.js';

const OP = '33333333-3333-4333-8333-333333333333';
const PAPER_ON = { enabled: true } as const;
const PAPER_OFF = { enabled: false } as const;
const CHILD = '100';

describe('startPaperScaleOutParent', () => {
  it('refuses missing / whitespace parentClientOrderId', () => {
    expect(
      startPaperScaleOutParent({
        approved: true,
        status: 'paper',
        childSize: CHILD,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
    expect(
      startPaperScaleOutParent({
        parentClientOrderId: '   ',
        approved: true,
        status: 'paper',
        childSize: CHILD,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
  });

  it("paper unwired / paper_off refuse even with approved paper + childSize '100'", () => {
    expect(
      startPaperScaleOutParent({
        parentClientOrderId: 'p-sout',
        approved: true,
        status: 'paper',
        childSize: CHILD,
        operatorId: OP,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_gate_unwired' });
    expect(
      startPaperScaleOutParent({
        parentClientOrderId: 'p-sout',
        approved: true,
        status: 'paper',
        childSize: CHILD,
        operatorId: OP,
        paper: PAPER_OFF,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_off' });
  });

  it('refuses kind twap / scale-in with not_live', () => {
    expect(
      startPaperScaleOutParent({
        parentClientOrderId: 'p-sout',
        kind: 'twap',
        approved: true,
        status: 'paper',
        childSize: CHILD,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
    expect(
      startPaperScaleOutParent({
        parentClientOrderId: 'p-sout',
        kind: 'scale-in',
        approved: true,
        status: 'paper',
        childSize: CHILD,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
  });

  it('refuses status running with already_started', () => {
    expect(
      startPaperScaleOutParent({
        parentClientOrderId: 'p-sout',
        approved: true,
        status: 'running',
        childSize: CHILD,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'already_started' });
  });

  it("refuses padded status 'running ' with already_started and does not start", () => {
    const started = startPaperScaleOutParent({
      parentClientOrderId: 'p-sout',
      approved: true,
      status: 'running ',
      childSize: CHILD,
      operatorId: OP,
      paper: PAPER_ON,
    });
    expect(started).toMatchObject({ ok: false, reason: 'already_started' });
    expect(started).not.toMatchObject({ started: true });
  });

  it('refuses stopped, expired, and halted with not_approved even when approved is true', () => {
    for (const status of ['stopped', 'expired', 'halted'] as const) {
      const started = startPaperScaleOutParent({
        parentClientOrderId: 'p-sout',
        approved: true,
        status,
        childSize: CHILD,
        operatorId: OP,
        paper: PAPER_ON,
      });
      expect(started).toMatchObject({ ok: false, reason: 'not_approved' });
      expect(started).not.toMatchObject({ started: true });
    }
  });

  it('refuses blank and whitespace-only status with not_approved even when approved is true and does not start', () => {
    for (const status of ['', '   '] as const) {
      const started = startPaperScaleOutParent({
        parentClientOrderId: 'p-sout',
        approved: true,
        status,
        childSize: CHILD,
        operatorId: OP,
        paper: PAPER_ON,
      });
      expect(started).toMatchObject({ ok: false, reason: 'not_approved' });
      expect(started).not.toMatchObject({ started: true });
    }
  });

  it('refuses omitted status and approved:false with not_approved', () => {
    expect(
      startPaperScaleOutParent({
        parentClientOrderId: 'p-sout',
        approved: false,
        childSize: CHILD,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_approved' });
  });

  it('refuses missing / whitespace operator', () => {
    expect(
      startPaperScaleOutParent({
        parentClientOrderId: 'p-sout',
        approved: true,
        status: 'paper',
        childSize: CHILD,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_operator' });
    expect(
      startPaperScaleOutParent({
        parentClientOrderId: 'p-sout',
        approved: true,
        status: 'paper',
        childSize: CHILD,
        operatorId: '   ',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_operator' });
  });

  it("refuses omitted / blank / 0 / invalid childSize with missing_child_size even when amount is '1000'", () => {
    expect(
      startPaperScaleOutParent({
        parentClientOrderId: 'p-sout',
        approved: true,
        status: 'paper',
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_child_size' });
    expect(
      startPaperScaleOutParent({
        parentClientOrderId: 'p-sout',
        approved: true,
        status: 'paper',
        childSize: '',
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_child_size' });
    expect(
      startPaperScaleOutParent({
        parentClientOrderId: 'p-sout',
        approved: true,
        status: 'paper',
        childSize: '0',
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_child_size' });
    expect(
      startPaperScaleOutParent({
        parentClientOrderId: 'p-sout',
        approved: true,
        status: 'paper',
        childSize: 'not-an-amount',
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_child_size' });
  });

  it("happy: status paper + childSize '100' + operator + paper on — status stays paper", () => {
    const started = startPaperScaleOutParent({
      parentClientOrderId: 'p-sout',
      status: 'paper',
      childSize: CHILD,
      operatorId: OP,
      paper: PAPER_ON,
    });
    expect(started).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-sout',
      kind: 'scale-out',
      status: 'paper',
      childSize: formatAmount(parseAmount(CHILD)),
    });
    expect(started).not.toMatchObject({ status: 'running' });
    expect(started).not.toHaveProperty('matching');
  });

  it("happy: approved true + childSize '100' + operator + paper on (status omitted) — not invented from amount", () => {
    const started = startPaperScaleOutParent({
      parentClientOrderId: 'p-sout',
      approved: true,
      childSize: CHILD,
      amount: '1000',
      operatorId: OP,
      paper: PAPER_ON,
    });
    expect(started).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-sout',
      kind: 'scale-out',
      status: 'paper',
      childSize: formatAmount(parseAmount(CHILD)),
    });
    expect(started).not.toMatchObject({ childSize: '1000' });
  });

  it("happy: approved true + status approved + childSize '100' starts paper", () => {
    const started = startPaperScaleOutParent({
      parentClientOrderId: 'p-sout',
      approved: true,
      status: 'approved',
      childSize: CHILD,
      operatorId: OP,
      paper: PAPER_ON,
    });
    expect(started).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-sout',
      kind: 'scale-out',
      status: 'paper',
      childSize: formatAmount(parseAmount(CHILD)),
    });
  });
});
