import { describe, expect, it } from 'vitest';
import { startPaperTwapParent } from './oms-paper-twap-start.js';

const OP = '33333333-3333-4333-8333-333333333333';
const PAPER_ON = { enabled: true } as const;
const PAPER_OFF = { enabled: false } as const;

describe('startPaperTwapParent', () => {
  it('refuses missing / whitespace parentClientOrderId', () => {
    expect(
      startPaperTwapParent({
        approved: true,
        status: 'paper',
        durationMs: 60_000,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
    expect(
      startPaperTwapParent({
        parentClientOrderId: '   ',
        approved: true,
        status: 'paper',
        durationMs: 60_000,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
  });

  it('paper unwired / paper_off refuse even with approved paper + durationMs 60_000', () => {
    expect(
      startPaperTwapParent({
        parentClientOrderId: 'p-twap',
        approved: true,
        status: 'paper',
        durationMs: 60_000,
        operatorId: OP,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_gate_unwired' });
    expect(
      startPaperTwapParent({
        parentClientOrderId: 'p-twap',
        approved: true,
        status: 'paper',
        durationMs: 60_000,
        operatorId: OP,
        paper: PAPER_OFF,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_off' });
  });

  it('refuses kind vwap with not_live', () => {
    expect(
      startPaperTwapParent({
        parentClientOrderId: 'p-twap',
        kind: 'vwap',
        approved: true,
        status: 'paper',
        durationMs: 60_000,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
  });

  it('refuses status running with already_started', () => {
    expect(
      startPaperTwapParent({
        parentClientOrderId: 'p-twap',
        approved: true,
        status: 'running',
        durationMs: 60_000,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'already_started' });
  });

  it("refuses padded status 'running ' with already_started and does not return ok", () => {
    const started = startPaperTwapParent({
      parentClientOrderId: 'p-twap',
      approved: true,
      status: 'running ',
      durationMs: 60_000,
      operatorId: OP,
      paper: PAPER_ON,
    });
    expect(started).toMatchObject({ ok: false, reason: 'already_started' });
    expect(started.ok).toBe(false);
    expect(started).not.toMatchObject({ ok: true, started: true, status: 'paper' });
  });

  it('refuses stopped, expired, and halted with not_approved even when approved is true', () => {
    for (const status of ['stopped', 'expired', 'halted'] as const) {
      const started = startPaperTwapParent({
        parentClientOrderId: 'p-twap',
        approved: true,
        status,
        durationMs: 60_000,
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
      const started = startPaperTwapParent({
        parentClientOrderId: 'p-twap',
        approved: true,
        status,
        durationMs: 60_000,
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
      startPaperTwapParent({
        parentClientOrderId: 'p-twap',
        approved: false,
        durationMs: 60_000,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_approved' });
  });

  it('refuses missing / whitespace operator', () => {
    expect(
      startPaperTwapParent({
        parentClientOrderId: 'p-twap',
        approved: true,
        status: 'paper',
        durationMs: 60_000,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_operator' });
    expect(
      startPaperTwapParent({
        parentClientOrderId: 'p-twap',
        approved: true,
        status: 'paper',
        durationMs: 60_000,
        operatorId: '   ',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_operator' });
  });

  it('refuses omitted / 0 / 1.5 durationMs with missing_schedule', () => {
    expect(
      startPaperTwapParent({
        parentClientOrderId: 'p-twap',
        approved: true,
        status: 'paper',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_schedule' });
    expect(
      startPaperTwapParent({
        parentClientOrderId: 'p-twap',
        approved: true,
        status: 'paper',
        durationMs: 0,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_schedule' });
    expect(
      startPaperTwapParent({
        parentClientOrderId: 'p-twap',
        approved: true,
        status: 'paper',
        durationMs: 1.5,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_schedule' });
  });

  it('happy: status paper + durationMs 60_000 + operator + paper on', () => {
    const started = startPaperTwapParent({
      parentClientOrderId: 'p-twap',
      status: 'paper',
      durationMs: 60_000,
      operatorId: OP,
      paper: PAPER_ON,
    });
    expect(started).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-twap',
      kind: 'twap',
      status: 'paper',
      durationMs: 60000,
    });
    expect(started).not.toMatchObject({ status: 'running' });
  });

  it('happy: approved true + status paper + durationMs 60_000 + operator + paper on', () => {
    expect(
      startPaperTwapParent({
        parentClientOrderId: 'p-twap',
        approved: true,
        status: 'paper',
        durationMs: 60_000,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-twap',
      kind: 'twap',
      status: 'paper',
      durationMs: 60000,
    });
  });

  it('happy: approved true + status approved + durationMs 60_000 + operator + paper on', () => {
    expect(
      startPaperTwapParent({
        parentClientOrderId: 'p-twap',
        approved: true,
        status: 'approved',
        durationMs: 60_000,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-twap',
      kind: 'twap',
      status: 'paper',
      durationMs: 60000,
    });
  });

  it('happy: approved true + durationMs 60_000 + operator + paper on (status omitted)', () => {
    expect(
      startPaperTwapParent({
        parentClientOrderId: 'p-twap',
        approved: true,
        durationMs: 60_000,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-twap',
      kind: 'twap',
      status: 'paper',
      durationMs: 60000,
    });
  });
});
