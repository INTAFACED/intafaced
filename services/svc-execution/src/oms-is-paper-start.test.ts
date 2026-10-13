import { describe, expect, it } from 'vitest';
import { startPaperImplementationShortfallParent } from './oms-is-paper-start.js';

const OP = '33333333-3333-4333-8333-333333333333';
const PAPER_ON = { enabled: true } as const;
const PAPER_OFF = { enabled: false } as const;

describe('startPaperImplementationShortfallParent', () => {
  it('refuses missing / whitespace parentClientOrderId', () => {
    expect(
      startPaperImplementationShortfallParent({
        approved: true,
        status: 'paper',
        arrivalPrice: '100',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
    expect(
      startPaperImplementationShortfallParent({
        parentClientOrderId: '   ',
        approved: true,
        status: 'paper',
        arrivalPrice: '100',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
  });

  it("paper unwired / paper_off refuse even with approved paper + arrival '100'", () => {
    expect(
      startPaperImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        approved: true,
        status: 'paper',
        arrivalPrice: '100',
        operatorId: OP,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_gate_unwired' });
    expect(
      startPaperImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        approved: true,
        status: 'paper',
        arrivalPrice: '100',
        operatorId: OP,
        paper: PAPER_OFF,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_off' });
  });

  it('refuses status running with already_started', () => {
    expect(
      startPaperImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        approved: true,
        status: 'running',
        arrivalPrice: '100',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'already_started' });
  });

  it('refuses omitted status and approved:false with not_approved', () => {
    expect(
      startPaperImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        approved: false,
        arrivalPrice: '100',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_approved' });
  });

  it('refuses approved true when status is expired, stopped, or any other non-start status', () => {
    for (const status of ['expired', 'stopped', 'filled']) {
      const result = startPaperImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        approved: true,
        status,
        arrivalPrice: '100.5',
        operatorId: OP,
        paper: PAPER_ON,
      });
      expect(result).toEqual({
        ok: false,
        reason: 'not_approved',
        detail: 'parent p-is is not an approved paper parent',
      });
      expect(result).not.toMatchObject({ started: true, status: 'paper' });
    }
  });

  it('refuses missing / whitespace operator', () => {
    expect(
      startPaperImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        approved: true,
        status: 'paper',
        arrivalPrice: '100',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_operator' });
    expect(
      startPaperImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        approved: true,
        status: 'paper',
        arrivalPrice: '100',
        operatorId: '   ',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_operator' });
  });

  it('refuses omitted / blank / invalid arrival with missing_schedule', () => {
    expect(
      startPaperImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        approved: true,
        status: 'paper',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_schedule' });
    expect(
      startPaperImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        approved: true,
        status: 'paper',
        arrivalPrice: null,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_schedule' });
    expect(
      startPaperImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        approved: true,
        status: 'paper',
        arrivalPrice: '',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_schedule' });
    expect(
      startPaperImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        approved: true,
        status: 'paper',
        arrivalPrice: '   ',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_schedule' });
    expect(
      startPaperImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        approved: true,
        status: 'paper',
        arrivalPrice: 'nope',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_schedule' });
    expect(
      startPaperImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        approved: true,
        status: 'paper',
        arrivalPrice: '0',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_schedule' });
  });

  it("happy: status paper + arrival '100.5' + operator + paper on", () => {
    const started = startPaperImplementationShortfallParent({
      parentClientOrderId: 'p-is',
      status: 'paper',
      arrivalPrice: '100.5',
      operatorId: OP,
      paper: PAPER_ON,
    });
    expect(started).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-is',
      kind: 'implementation_shortfall',
      status: 'paper',
      arrivalPrice: '100.5',
    });
    expect(started).not.toMatchObject({ status: 'running' });
  });

  it("happy: approved true + arrival '100.5' + operator + paper on (status omitted)", () => {
    expect(
      startPaperImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        approved: true,
        arrivalPrice: '100.5',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-is',
      kind: 'implementation_shortfall',
      status: 'paper',
      arrivalPrice: '100.5',
    });
  });

  it("happy: approved true + status paper or approved + arrival '100.5' starts as paper", () => {
    for (const status of ['paper', 'approved'] as const) {
      expect(
        startPaperImplementationShortfallParent({
          parentClientOrderId: 'p-is',
          approved: true,
          status,
          arrivalPrice: '100.5',
          operatorId: OP,
          paper: PAPER_ON,
        }),
      ).toEqual({
        ok: true,
        started: true,
        paper: true,
        parentClientOrderId: 'p-is',
        kind: 'implementation_shortfall',
        status: 'paper',
        arrivalPrice: '100.5',
      });
    }
  });
});
