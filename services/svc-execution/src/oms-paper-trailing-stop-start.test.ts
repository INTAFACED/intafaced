import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { startPaperTrailingStopParent } from './oms-paper-trailing-stop-start.js';

const OP = '33333333-3333-4333-8333-333333333333';
const PAPER_ON = { enabled: true } as const;
const PAPER_OFF = { enabled: false } as const;
const TRAIL = '0.05';

describe('startPaperTrailingStopParent', () => {
  it('refuses missing / whitespace parentClientOrderId', () => {
    expect(
      startPaperTrailingStopParent({
        approved: true,
        status: 'paper',
        trailOffset: TRAIL,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
    expect(
      startPaperTrailingStopParent({
        parentClientOrderId: '   ',
        approved: true,
        status: 'paper',
        trailOffset: TRAIL,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
  });

  it("paper unwired / paper_off refuse even with approved paper + trailOffset '0.05'", () => {
    expect(
      startPaperTrailingStopParent({
        parentClientOrderId: 'p-trail',
        approved: true,
        status: 'paper',
        trailOffset: TRAIL,
        operatorId: OP,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_gate_unwired' });
    expect(
      startPaperTrailingStopParent({
        parentClientOrderId: 'p-trail',
        approved: true,
        status: 'paper',
        trailOffset: TRAIL,
        operatorId: OP,
        paper: PAPER_OFF,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_off' });
  });

  it('refuses kind twap with not_live', () => {
    expect(
      startPaperTrailingStopParent({
        parentClientOrderId: 'p-trail',
        kind: 'twap',
        approved: true,
        status: 'paper',
        trailOffset: TRAIL,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
  });

  it('refuses status running with already_started', () => {
    expect(
      startPaperTrailingStopParent({
        parentClientOrderId: 'p-trail',
        approved: true,
        status: 'running',
        trailOffset: TRAIL,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'already_started' });
  });

  it("refuses padded status 'running ' with already_started and does not return ok", () => {
    const started = startPaperTrailingStopParent({
      parentClientOrderId: 'p-trail',
      approved: true,
      status: 'running ',
      trailOffset: TRAIL,
      operatorId: OP,
      paper: PAPER_ON,
    });
    expect(started).toMatchObject({ ok: false, reason: 'already_started' });
    expect(started.ok).toBe(false);
    expect(started).not.toMatchObject({ ok: true, started: true, status: 'paper' });
  });

  it('refuses stopped, expired, and halted with not_approved even when approved is true', () => {
    for (const status of ['stopped', 'expired', 'halted'] as const) {
      const started = startPaperTrailingStopParent({
        parentClientOrderId: 'p-trail',
        approved: true,
        status,
        trailOffset: TRAIL,
        operatorId: OP,
        paper: PAPER_ON,
      });
      expect(started).toMatchObject({ ok: false, reason: 'not_approved' });
      expect(started.ok).toBe(false);
      expect(started).not.toMatchObject({ ok: true, started: true, status: 'paper' });
    }
  });

  it('refuses blank and whitespace-only status with not_approved even when approved is true and does not start', () => {
    for (const status of ['', '   '] as const) {
      const started = startPaperTrailingStopParent({
        parentClientOrderId: 'p-trail',
        approved: true,
        status,
        trailOffset: TRAIL,
        operatorId: OP,
        paper: PAPER_ON,
      });
      expect(started).toMatchObject({ ok: false, reason: 'not_approved' });
      expect(started.ok).toBe(false);
      expect(started).not.toMatchObject({ ok: true, started: true, status: 'paper' });
    }
  });

  it('refuses omitted status and approved:false with not_approved', () => {
    expect(
      startPaperTrailingStopParent({
        parentClientOrderId: 'p-trail',
        approved: false,
        trailOffset: TRAIL,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_approved' });
  });

  it('refuses missing / whitespace operator', () => {
    expect(
      startPaperTrailingStopParent({
        parentClientOrderId: 'p-trail',
        approved: true,
        status: 'paper',
        trailOffset: TRAIL,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_operator' });
    expect(
      startPaperTrailingStopParent({
        parentClientOrderId: 'p-trail',
        approved: true,
        status: 'paper',
        trailOffset: TRAIL,
        operatorId: '   ',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_operator' });
  });

  it('refuses omitted / blank / invalid trailOffset with missing_trail', () => {
    expect(
      startPaperTrailingStopParent({
        parentClientOrderId: 'p-trail',
        approved: true,
        status: 'paper',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_trail' });
    expect(
      startPaperTrailingStopParent({
        parentClientOrderId: 'p-trail',
        approved: true,
        status: 'paper',
        trailOffset: '',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_trail' });
    expect(
      startPaperTrailingStopParent({
        parentClientOrderId: 'p-trail',
        approved: true,
        status: 'paper',
        trailOffset: 'not-an-amount',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_trail' });
  });

  it("happy: status paper + trailOffset '0.05' + operator + paper on", () => {
    const started = startPaperTrailingStopParent({
      parentClientOrderId: 'p-trail',
      status: 'paper',
      trailOffset: TRAIL,
      operatorId: OP,
      paper: PAPER_ON,
    });
    expect(started).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-trail',
      kind: 'trailing-stop',
      status: 'paper',
      trailOffset: formatAmount(parseAmount(TRAIL)),
    });
    expect(started).not.toMatchObject({ status: 'running' });
  });

  it("happy: approved true + status paper + trailOffset '0.05' + operator + paper on", () => {
    expect(
      startPaperTrailingStopParent({
        parentClientOrderId: 'p-trail',
        approved: true,
        status: 'paper',
        trailOffset: TRAIL,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-trail',
      kind: 'trailing-stop',
      status: 'paper',
      trailOffset: formatAmount(parseAmount(TRAIL)),
    });
  });

  it("happy: approved true + status approved + trailOffset '0.05' + operator + paper on", () => {
    expect(
      startPaperTrailingStopParent({
        parentClientOrderId: 'p-trail',
        approved: true,
        status: 'approved',
        trailOffset: TRAIL,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-trail',
      kind: 'trailing-stop',
      status: 'paper',
      trailOffset: formatAmount(parseAmount(TRAIL)),
    });
  });

  it("happy: approved true + trailOffset '0.05' + operator + paper on (status omitted)", () => {
    expect(
      startPaperTrailingStopParent({
        parentClientOrderId: 'p-trail',
        approved: true,
        trailOffset: TRAIL,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-trail',
      kind: 'trailing-stop',
      status: 'paper',
      trailOffset: formatAmount(parseAmount(TRAIL)),
    });
  });
});
