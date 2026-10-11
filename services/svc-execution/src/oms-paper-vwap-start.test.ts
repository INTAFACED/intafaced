import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { startPaperVwapParent } from './oms-paper-vwap-start.js';

const OP = '33333333-3333-4333-8333-333333333333';
const PAPER_ON = { enabled: true } as const;
const PAPER_OFF = { enabled: false } as const;
const VOLUME = '1000';

describe('startPaperVwapParent', () => {
  it('refuses missing / whitespace parentClientOrderId', () => {
    expect(
      startPaperVwapParent({
        approved: true,
        status: 'paper',
        targetVolume: VOLUME,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
    expect(
      startPaperVwapParent({
        parentClientOrderId: '   ',
        approved: true,
        status: 'paper',
        targetVolume: VOLUME,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
  });

  it("paper unwired / paper_off refuse even with approved paper + targetVolume '1000'", () => {
    expect(
      startPaperVwapParent({
        parentClientOrderId: 'p-vwap',
        approved: true,
        status: 'paper',
        targetVolume: VOLUME,
        operatorId: OP,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_gate_unwired' });
    expect(
      startPaperVwapParent({
        parentClientOrderId: 'p-vwap',
        approved: true,
        status: 'paper',
        targetVolume: VOLUME,
        operatorId: OP,
        paper: PAPER_OFF,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_off' });
  });

  it('refuses kind twap with not_live', () => {
    expect(
      startPaperVwapParent({
        parentClientOrderId: 'p-vwap',
        kind: 'twap',
        approved: true,
        status: 'paper',
        targetVolume: VOLUME,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
  });

  it('refuses status running with already_started', () => {
    expect(
      startPaperVwapParent({
        parentClientOrderId: 'p-vwap',
        approved: true,
        status: 'running',
        targetVolume: VOLUME,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'already_started' });
  });

  it("refuses padded status 'running ' with already_started and does not return ok", () => {
    const started = startPaperVwapParent({
      parentClientOrderId: 'p-vwap',
      approved: true,
      status: 'running ',
      targetVolume: VOLUME,
      operatorId: OP,
      paper: PAPER_ON,
    });
    expect(started).toMatchObject({ ok: false, reason: 'already_started' });
    expect(started.ok).toBe(false);
    expect(started).not.toMatchObject({ ok: true, started: true, status: 'paper' });
  });

  it('refuses stopped, expired, and halted with not_approved even when approved is true', () => {
    for (const status of ['stopped', 'expired', 'halted'] as const) {
      const started = startPaperVwapParent({
        parentClientOrderId: 'p-vwap',
        approved: true,
        status,
        targetVolume: VOLUME,
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
      const started = startPaperVwapParent({
        parentClientOrderId: 'p-vwap',
        approved: true,
        status,
        targetVolume: VOLUME,
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
      startPaperVwapParent({
        parentClientOrderId: 'p-vwap',
        approved: false,
        targetVolume: VOLUME,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_approved' });
  });

  it('refuses missing / whitespace operator', () => {
    expect(
      startPaperVwapParent({
        parentClientOrderId: 'p-vwap',
        approved: true,
        status: 'paper',
        targetVolume: VOLUME,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_operator' });
    expect(
      startPaperVwapParent({
        parentClientOrderId: 'p-vwap',
        approved: true,
        status: 'paper',
        targetVolume: VOLUME,
        operatorId: '   ',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_operator' });
  });

  it('refuses omitted / blank / 0 targetVolume with missing_target_volume', () => {
    expect(
      startPaperVwapParent({
        parentClientOrderId: 'p-vwap',
        approved: true,
        status: 'paper',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_target_volume' });
    expect(
      startPaperVwapParent({
        parentClientOrderId: 'p-vwap',
        approved: true,
        status: 'paper',
        targetVolume: '',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_target_volume' });
    expect(
      startPaperVwapParent({
        parentClientOrderId: 'p-vwap',
        approved: true,
        status: 'paper',
        targetVolume: '0',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_target_volume' });
  });

  it("happy: status paper + targetVolume '1000' + operator + paper on", () => {
    const started = startPaperVwapParent({
      parentClientOrderId: 'p-vwap',
      status: 'paper',
      targetVolume: VOLUME,
      operatorId: OP,
      paper: PAPER_ON,
    });
    expect(started).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-vwap',
      kind: 'vwap',
      status: 'paper',
      targetVolume: formatAmount(parseAmount(VOLUME)),
    });
    expect(started).not.toMatchObject({ status: 'running' });
  });

  it("happy: approved true + status paper + targetVolume '1000' + operator + paper on", () => {
    expect(
      startPaperVwapParent({
        parentClientOrderId: 'p-vwap',
        approved: true,
        status: 'paper',
        targetVolume: VOLUME,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-vwap',
      kind: 'vwap',
      status: 'paper',
      targetVolume: formatAmount(parseAmount(VOLUME)),
    });
  });

  it("happy: approved true + status approved + targetVolume '1000' + operator + paper on", () => {
    expect(
      startPaperVwapParent({
        parentClientOrderId: 'p-vwap',
        approved: true,
        status: 'approved',
        targetVolume: VOLUME,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-vwap',
      kind: 'vwap',
      status: 'paper',
      targetVolume: formatAmount(parseAmount(VOLUME)),
    });
  });

  it("happy: approved true + targetVolume '1000' + operator + paper on (status omitted)", () => {
    expect(
      startPaperVwapParent({
        parentClientOrderId: 'p-vwap',
        approved: true,
        targetVolume: VOLUME,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-vwap',
      kind: 'vwap',
      status: 'paper',
      targetVolume: formatAmount(parseAmount(VOLUME)),
    });
  });
});
