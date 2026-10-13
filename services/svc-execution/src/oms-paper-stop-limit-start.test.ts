import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { startPaperStopLimitParent } from './oms-paper-stop-limit-start.js';

const OP = '33333333-3333-4333-8333-333333333333';
const PAPER_ON = { enabled: true } as const;
const PAPER_OFF = { enabled: false } as const;
const STOP = '100';
const LIMIT = '99';

describe('startPaperStopLimitParent', () => {
  it('refuses missing / whitespace parentClientOrderId', () => {
    expect(
      startPaperStopLimitParent({
        approved: true,
        status: 'paper',
        stopPrice: STOP,
        limitPrice: LIMIT,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
    expect(
      startPaperStopLimitParent({
        parentClientOrderId: '   ',
        approved: true,
        status: 'paper',
        stopPrice: STOP,
        limitPrice: LIMIT,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
  });

  it('paper unwired / paper_off refuse even with approved paper + both prices', () => {
    expect(
      startPaperStopLimitParent({
        parentClientOrderId: 'p-stpl',
        approved: true,
        status: 'paper',
        stopPrice: STOP,
        limitPrice: LIMIT,
        operatorId: OP,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_gate_unwired' });
    expect(
      startPaperStopLimitParent({
        parentClientOrderId: 'p-stpl',
        approved: true,
        status: 'paper',
        stopPrice: STOP,
        limitPrice: LIMIT,
        operatorId: OP,
        paper: PAPER_OFF,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_off' });
  });

  it('refuses kind twap with not_live', () => {
    expect(
      startPaperStopLimitParent({
        parentClientOrderId: 'p-stpl',
        kind: 'twap',
        approved: true,
        status: 'paper',
        stopPrice: STOP,
        limitPrice: LIMIT,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
  });

  it('refuses status running with already_started', () => {
    expect(
      startPaperStopLimitParent({
        parentClientOrderId: 'p-stpl',
        approved: true,
        status: 'running',
        stopPrice: STOP,
        limitPrice: LIMIT,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'already_started' });
  });

  it("refuses padded status 'running ' with already_started and does not start", () => {
    const started = startPaperStopLimitParent({
      parentClientOrderId: 'p-stpl',
      approved: true,
      status: 'running ',
      stopPrice: STOP,
      limitPrice: LIMIT,
      operatorId: OP,
      paper: PAPER_ON,
    });
    expect(started).toMatchObject({ ok: false, reason: 'already_started' });
    expect(started).not.toMatchObject({ started: true });
  });

  it('refuses stopped, expired, and halted with not_approved even when approved is true', () => {
    for (const status of ['stopped', 'expired', 'halted'] as const) {
      const started = startPaperStopLimitParent({
        parentClientOrderId: 'p-stpl',
        approved: true,
        status,
        stopPrice: STOP,
        limitPrice: LIMIT,
        operatorId: OP,
        paper: PAPER_ON,
      });
      expect(started).toMatchObject({ ok: false, reason: 'not_approved' });
      expect(started).not.toMatchObject({ started: true });
    }
  });

  it('refuses blank and whitespace-only status with not_approved even when approved is true and does not start', () => {
    for (const status of ['', '   '] as const) {
      const started = startPaperStopLimitParent({
        parentClientOrderId: 'p-stpl',
        approved: true,
        status,
        stopPrice: STOP,
        limitPrice: LIMIT,
        operatorId: OP,
        paper: PAPER_ON,
      });
      expect(started).toMatchObject({ ok: false, reason: 'not_approved' });
      expect(started).not.toMatchObject({ started: true });
    }
  });

  it('refuses omitted status and approved:false with not_approved', () => {
    expect(
      startPaperStopLimitParent({
        parentClientOrderId: 'p-stpl',
        approved: false,
        stopPrice: STOP,
        limitPrice: LIMIT,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_approved' });
  });

  it('refuses missing / whitespace operator', () => {
    expect(
      startPaperStopLimitParent({
        parentClientOrderId: 'p-stpl',
        approved: true,
        status: 'paper',
        stopPrice: STOP,
        limitPrice: LIMIT,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_operator' });
    expect(
      startPaperStopLimitParent({
        parentClientOrderId: 'p-stpl',
        approved: true,
        status: 'paper',
        stopPrice: STOP,
        limitPrice: LIMIT,
        operatorId: '   ',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_operator' });
  });

  it('refuses omitted / blank / invalid stopPrice with missing_stop even when limit and amount are present', () => {
    expect(
      startPaperStopLimitParent({
        parentClientOrderId: 'p-stpl',
        approved: true,
        status: 'paper',
        limitPrice: LIMIT,
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_stop' });
    expect(
      startPaperStopLimitParent({
        parentClientOrderId: 'p-stpl',
        approved: true,
        status: 'paper',
        stopPrice: '',
        limitPrice: LIMIT,
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_stop' });
    expect(
      startPaperStopLimitParent({
        parentClientOrderId: 'p-stpl',
        approved: true,
        status: 'paper',
        stopPrice: 'not-an-amount',
        limitPrice: LIMIT,
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_stop' });
  });

  it('refuses omitted / blank / invalid limitPrice with missing_limit even when stop and amount are present', () => {
    expect(
      startPaperStopLimitParent({
        parentClientOrderId: 'p-stpl',
        approved: true,
        status: 'paper',
        stopPrice: STOP,
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_limit' });
    expect(
      startPaperStopLimitParent({
        parentClientOrderId: 'p-stpl',
        approved: true,
        status: 'paper',
        stopPrice: STOP,
        limitPrice: '',
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_limit' });
    expect(
      startPaperStopLimitParent({
        parentClientOrderId: 'p-stpl',
        approved: true,
        status: 'paper',
        stopPrice: STOP,
        limitPrice: 'not-an-amount',
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_limit' });
  });

  it("happy: status paper + stopPrice '100' + limitPrice '99' + operator + paper on — status stays paper", () => {
    const started = startPaperStopLimitParent({
      parentClientOrderId: 'p-stpl',
      status: 'paper',
      stopPrice: STOP,
      limitPrice: LIMIT,
      operatorId: OP,
      paper: PAPER_ON,
    });
    expect(started).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-stpl',
      kind: 'stop-limit',
      status: 'paper',
      stopPrice: formatAmount(parseAmount(STOP)),
      limitPrice: formatAmount(parseAmount(LIMIT)),
    });
    expect(started).not.toMatchObject({ status: 'running' });
    expect(started).not.toHaveProperty('matching');
  });

  it('happy: approved true + status paper + both prices starts paper', () => {
    expect(
      startPaperStopLimitParent({
        parentClientOrderId: 'p-stpl',
        approved: true,
        status: 'paper',
        stopPrice: STOP,
        limitPrice: LIMIT,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-stpl',
      kind: 'stop-limit',
      status: 'paper',
      stopPrice: formatAmount(parseAmount(STOP)),
      limitPrice: formatAmount(parseAmount(LIMIT)),
    });
  });

  it('happy: approved true + status approved + both prices starts paper', () => {
    expect(
      startPaperStopLimitParent({
        parentClientOrderId: 'p-stpl',
        approved: true,
        status: 'approved',
        stopPrice: STOP,
        limitPrice: LIMIT,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-stpl',
      kind: 'stop-limit',
      status: 'paper',
      stopPrice: formatAmount(parseAmount(STOP)),
      limitPrice: formatAmount(parseAmount(LIMIT)),
    });
  });

  it('happy: approved true + both prices + operator + paper on (status omitted) — not invented from amount', () => {
    const started = startPaperStopLimitParent({
      parentClientOrderId: 'p-stpl',
      approved: true,
      stopPrice: STOP,
      limitPrice: LIMIT,
      amount: '1000',
      operatorId: OP,
      paper: PAPER_ON,
    });
    expect(started).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-stpl',
      kind: 'stop-limit',
      status: 'paper',
      stopPrice: formatAmount(parseAmount(STOP)),
      limitPrice: formatAmount(parseAmount(LIMIT)),
    });
    expect(started).not.toMatchObject({ stopPrice: '1000' });
    expect(started).not.toMatchObject({ limitPrice: '1000' });
  });
});
