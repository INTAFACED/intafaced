import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { startPaperScaleInParent } from './oms-paper-scale-in-start.js';

const OP = '33333333-3333-4333-8333-333333333333';
const PAPER_ON = { enabled: true } as const;
const PAPER_OFF = { enabled: false } as const;
const CHILD = '100';

describe('startPaperScaleInParent', () => {
  it('refuses missing / whitespace parentClientOrderId', () => {
    expect(
      startPaperScaleInParent({
        approved: true,
        status: 'paper',
        childSize: CHILD,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
    expect(
      startPaperScaleInParent({
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
      startPaperScaleInParent({
        parentClientOrderId: 'p-scale',
        approved: true,
        status: 'paper',
        childSize: CHILD,
        operatorId: OP,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_gate_unwired' });
    expect(
      startPaperScaleInParent({
        parentClientOrderId: 'p-scale',
        approved: true,
        status: 'paper',
        childSize: CHILD,
        operatorId: OP,
        paper: PAPER_OFF,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_off' });
  });

  it('refuses kind twap with not_live', () => {
    expect(
      startPaperScaleInParent({
        parentClientOrderId: 'p-scale',
        kind: 'twap',
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
      startPaperScaleInParent({
        parentClientOrderId: 'p-scale',
        approved: true,
        status: 'running',
        childSize: CHILD,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'already_started' });
  });

  it("refuses padded status 'running ' with already_started and does not start", () => {
    const result = startPaperScaleInParent({
      parentClientOrderId: 'p-scale',
      approved: true,
      status: 'running ',
      childSize: CHILD,
      operatorId: OP,
      paper: PAPER_ON,
    });
    expect(result).toMatchObject({ ok: false, reason: 'already_started' });
    expect(result).not.toMatchObject({ started: true });
  });

  it('refuses stopped and expired with not_approved even when approved is true', () => {
    for (const status of ['stopped', 'expired'] as const) {
      const result = startPaperScaleInParent({
        parentClientOrderId: 'p-scale',
        approved: true,
        status,
        childSize: CHILD,
        operatorId: OP,
        paper: PAPER_ON,
      });
      expect(result).toMatchObject({ ok: false, reason: 'not_approved' });
      expect(result).not.toMatchObject({ started: true });
    }
  });

  it('refuses omitted status and approved:false with not_approved', () => {
    expect(
      startPaperScaleInParent({
        parentClientOrderId: 'p-scale',
        approved: false,
        childSize: CHILD,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_approved' });
  });

  it("refuses approved false with status 'paper' — not_approved and does not start", () => {
    const result = startPaperScaleInParent({
      parentClientOrderId: 'p-scale',
      approved: false,
      status: 'paper',
      childSize: CHILD,
      operatorId: OP,
      paper: PAPER_ON,
    });
    expect(result).toMatchObject({ ok: false, reason: 'not_approved' });
    expect(result).not.toMatchObject({ started: true });
  });

  it("refuses approved false with status 'approved' — not_approved and does not start", () => {
    const result = startPaperScaleInParent({
      parentClientOrderId: 'p-scale',
      approved: false,
      status: 'approved',
      childSize: CHILD,
      operatorId: OP,
      paper: PAPER_ON,
    });
    expect(result).toMatchObject({ ok: false, reason: 'not_approved' });
    expect(result).not.toMatchObject({ started: true });
  });

  it('refuses missing / whitespace operator', () => {
    expect(
      startPaperScaleInParent({
        parentClientOrderId: 'p-scale',
        approved: true,
        status: 'paper',
        childSize: CHILD,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_operator' });
    expect(
      startPaperScaleInParent({
        parentClientOrderId: 'p-scale',
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
      startPaperScaleInParent({
        parentClientOrderId: 'p-scale',
        approved: true,
        status: 'paper',
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_child_size' });
    expect(
      startPaperScaleInParent({
        parentClientOrderId: 'p-scale',
        approved: true,
        status: 'paper',
        childSize: '',
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_child_size' });
    expect(
      startPaperScaleInParent({
        parentClientOrderId: 'p-scale',
        approved: true,
        status: 'paper',
        childSize: '0',
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_child_size' });
    expect(
      startPaperScaleInParent({
        parentClientOrderId: 'p-scale',
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
    const started = startPaperScaleInParent({
      parentClientOrderId: 'p-scale',
      status: 'paper',
      childSize: CHILD,
      operatorId: OP,
      paper: PAPER_ON,
    });
    expect(started).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-scale',
      kind: 'scale-in',
      status: 'paper',
      childSize: formatAmount(parseAmount(CHILD)),
    });
    expect(started).not.toMatchObject({ status: 'running' });
    expect(started).not.toHaveProperty('matching');
  });

  it("happy: approved true + status paper + childSize '100' + operator + paper on", () => {
    expect(
      startPaperScaleInParent({
        parentClientOrderId: 'p-scale',
        approved: true,
        status: 'paper',
        childSize: CHILD,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-scale',
      kind: 'scale-in',
      status: 'paper',
      childSize: formatAmount(parseAmount(CHILD)),
    });
  });

  it("happy: approved true + status approved + childSize '100' + operator + paper on", () => {
    expect(
      startPaperScaleInParent({
        parentClientOrderId: 'p-scale',
        approved: true,
        status: 'approved',
        childSize: CHILD,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-scale',
      kind: 'scale-in',
      status: 'paper',
      childSize: formatAmount(parseAmount(CHILD)),
    });
  });

  it("happy: status approved + childSize '100' + operator + paper on (approved omitted)", () => {
    expect(
      startPaperScaleInParent({
        parentClientOrderId: 'p-scale',
        status: 'approved',
        childSize: CHILD,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-scale',
      kind: 'scale-in',
      status: 'paper',
      childSize: formatAmount(parseAmount(CHILD)),
    });
  });

  it("happy: approved true + childSize '100' + operator + paper on (status omitted) — not invented from amount", () => {
    const started = startPaperScaleInParent({
      parentClientOrderId: 'p-scale',
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
      parentClientOrderId: 'p-scale',
      kind: 'scale-in',
      status: 'paper',
      childSize: formatAmount(parseAmount(CHILD)),
    });
    expect(started).not.toMatchObject({ childSize: '1000' });
  });
});
