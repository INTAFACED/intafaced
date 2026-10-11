import { describe, expect, it } from 'vitest';
import { startPaperPovParent } from './oms-paper-pov-start.js';

const OP = '33333333-3333-4333-8333-333333333333';
const PAPER_ON = { enabled: true } as const;
const PAPER_OFF = { enabled: false } as const;

describe('startPaperPovParent', () => {
  it('refuses missing / whitespace parentClientOrderId', () => {
    expect(
      startPaperPovParent({
        approved: true,
        status: 'paper',
        maxParticipationBps: 1000,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
    expect(
      startPaperPovParent({
        parentClientOrderId: '   ',
        approved: true,
        status: 'paper',
        maxParticipationBps: 1000,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
  });

  it('paper unwired / paper_off refuse even with approved paper + maxParticipationBps 1000', () => {
    expect(
      startPaperPovParent({
        parentClientOrderId: 'p-pov',
        approved: true,
        status: 'paper',
        maxParticipationBps: 1000,
        operatorId: OP,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_gate_unwired' });
    expect(
      startPaperPovParent({
        parentClientOrderId: 'p-pov',
        approved: true,
        status: 'paper',
        maxParticipationBps: 1000,
        operatorId: OP,
        paper: PAPER_OFF,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_off' });
  });

  it('refuses kind twap with not_live', () => {
    expect(
      startPaperPovParent({
        parentClientOrderId: 'p-pov',
        kind: 'twap',
        approved: true,
        status: 'paper',
        maxParticipationBps: 1000,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
  });

  it('refuses status running with already_started', () => {
    expect(
      startPaperPovParent({
        parentClientOrderId: 'p-pov',
        approved: true,
        status: 'running',
        maxParticipationBps: 1000,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'already_started' });
  });

  it("refuses padded status 'running ' with already_started and does not start", () => {
    const started = startPaperPovParent({
      parentClientOrderId: 'p-pov',
      approved: true,
      status: 'running ',
      maxParticipationBps: 1000,
      operatorId: OP,
      paper: PAPER_ON,
    });
    expect(started).toMatchObject({ ok: false, reason: 'already_started' });
    expect(started).not.toMatchObject({ started: true });
  });

  it('refuses stopped, expired, and halted with not_approved even when approved is true', () => {
    for (const status of ['stopped', 'expired', 'halted'] as const) {
      const started = startPaperPovParent({
        parentClientOrderId: 'p-pov',
        approved: true,
        status,
        maxParticipationBps: 1000,
        operatorId: OP,
        paper: PAPER_ON,
      });
      expect(started).toMatchObject({ ok: false, reason: 'not_approved' });
      expect(started).not.toMatchObject({ started: true });
    }
  });

  it('refuses blank and whitespace-only status with not_approved even when approved is true and does not start', () => {
    for (const status of ['', '   '] as const) {
      const started = startPaperPovParent({
        parentClientOrderId: 'p-pov',
        approved: true,
        status,
        maxParticipationBps: 1000,
        operatorId: OP,
        paper: PAPER_ON,
      });
      expect(started).toMatchObject({ ok: false, reason: 'not_approved' });
      expect(started).not.toMatchObject({ started: true });
    }
  });

  it('refuses omitted status and approved:false with not_approved', () => {
    expect(
      startPaperPovParent({
        parentClientOrderId: 'p-pov',
        approved: false,
        maxParticipationBps: 1000,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_approved' });
  });

  it('refuses missing / whitespace operator', () => {
    expect(
      startPaperPovParent({
        parentClientOrderId: 'p-pov',
        approved: true,
        status: 'paper',
        maxParticipationBps: 1000,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_operator' });
    expect(
      startPaperPovParent({
        parentClientOrderId: 'p-pov',
        approved: true,
        status: 'paper',
        maxParticipationBps: 1000,
        operatorId: '   ',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_operator' });
  });

  it('refuses omitted / 1.5 / -1 maxParticipationBps with missing_max_participation', () => {
    expect(
      startPaperPovParent({
        parentClientOrderId: 'p-pov',
        approved: true,
        status: 'paper',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_max_participation' });
    expect(
      startPaperPovParent({
        parentClientOrderId: 'p-pov',
        approved: true,
        status: 'paper',
        maxParticipationBps: 1.5,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_max_participation' });
    expect(
      startPaperPovParent({
        parentClientOrderId: 'p-pov',
        approved: true,
        status: 'paper',
        maxParticipationBps: -1,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_max_participation' });
  });

  it('happy: status paper + maxParticipationBps 1000 + operator + paper on', () => {
    const started = startPaperPovParent({
      parentClientOrderId: 'p-pov',
      status: 'paper',
      maxParticipationBps: 1000,
      operatorId: OP,
      paper: PAPER_ON,
    });
    expect(started).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-pov',
      kind: 'pov',
      status: 'paper',
      maxParticipationBps: 1000,
    });
    expect(started).not.toMatchObject({ status: 'running' });
  });

  it('happy: approved true + maxParticipationBps 0 + operator + paper on (status omitted)', () => {
    expect(
      startPaperPovParent({
        parentClientOrderId: 'p-pov',
        approved: true,
        maxParticipationBps: 0,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-pov',
      kind: 'pov',
      status: 'paper',
      maxParticipationBps: 0,
    });
  });

  it('happy: approved true + status paper + maxParticipationBps 1000 starts paper', () => {
    expect(
      startPaperPovParent({
        parentClientOrderId: 'p-pov',
        approved: true,
        status: 'paper',
        maxParticipationBps: 1000,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-pov',
      kind: 'pov',
      status: 'paper',
      maxParticipationBps: 1000,
    });
  });

  it('happy: approved true + status approved + maxParticipationBps 1000 starts paper', () => {
    expect(
      startPaperPovParent({
        parentClientOrderId: 'p-pov',
        approved: true,
        status: 'approved',
        maxParticipationBps: 1000,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-pov',
      kind: 'pov',
      status: 'paper',
      maxParticipationBps: 1000,
    });
  });
});
